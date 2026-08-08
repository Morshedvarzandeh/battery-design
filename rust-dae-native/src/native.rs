use crate::{
    BackendIdentity, CallbackKind, IdaAbsoluteTolerance, IdaError, IdaInitialConditionPolicy,
    IdaSessionSettings, IdaSettings, IdaSolveResult, IdaSolverStats, NativeStage, NativeStatistic,
    NativeValue, NativeView, NativeViewActual, NATIVE_IDA_RESULT_CONTRACT, PINNED_BACKEND_IDENTITY,
    PINNED_SUNDIALS_VERSION,
};
#[cfg(feature = "sundials-ida-klu")]
use crate::{
    IdaKluSettings, IdaLinearFlagEvidence, NATIVE_IDA_KLU_RESULT_CONTRACT,
    PINNED_KLU_BACKEND_IDENTITY,
};
use battery_design_core::dae::{DaeOutput, DaeResidualSystem};
use std::ffi::{c_int, c_long, c_void};
use std::fmt;
use std::marker::PhantomPinned;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::Pin;
use std::ptr::{self, NonNull};
use std::rc::Rc;
use std::slice;

const VERSION_LABEL_CAPACITY: usize = 64;
#[allow(dead_code)]
const CALLBACK_SUCCESS: c_int = 0;
#[allow(dead_code)]
const CALLBACK_UNRECOVERABLE: c_int = -1;

/// Owned SUNDIALS context. The `Rc` marker deliberately keeps a context on the
/// thread where it was created until a later qualification explicitly widens
/// that contract.
pub(crate) struct SunContext {
    raw: crate::ffi::SUNContext,
    _thread_bound: std::marker::PhantomData<Rc<()>>,
}

impl fmt::Debug for SunContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SunContext").finish_non_exhaustive()
    }
}

impl SunContext {
    fn create() -> Result<Self, IdaError> {
        let mut raw = ptr::null_mut();
        // No Rust function pointer is supplied here, so there is no unwind path
        // from C back into Rust in this lifecycle-only iteration.
        let flag = unsafe { crate::ffi::SUNContext_Create(0, &mut raw) };
        require_success(flag, NativeStage::ContextCreate)?;
        let raw = require_handle(raw, NativeStage::ContextCreate)?;
        Ok(Self {
            raw: raw.as_ptr(),
            _thread_bound: std::marker::PhantomData,
        })
    }

    fn as_raw(&self) -> crate::ffi::SUNContext {
        self.raw
    }
}

impl Drop for SunContext {
    fn drop(&mut self) {
        if self.raw.is_null() {
            return;
        }
        // Destructors cannot report failures. SUNContext_Free nulls the handle;
        // all construction failures before this point are handled by RAII.
        let _ = unsafe { crate::ffi::SUNContext_Free(&mut self.raw) };
        self.raw = ptr::null_mut();
    }
}

pub(crate) fn initialize() -> Result<SunContext, IdaError> {
    let context = SunContext::create()?;
    require_exact_runtime_version()?;
    // Identity is not exposed from a header/version-only probe. Construct and
    // destroy the smallest complete native stack so backend construction also
    // proves the linked IDA, serial NVector, dense matrix, and dense linear
    // solver symbols are usable.
    let identity_probe = prepare_resources(&context, 1)?;
    drop(identity_probe);
    Ok(context)
}

#[cfg(feature = "sundials-ida-klu")]
pub(crate) fn initialize_klu() -> Result<SunContext, IdaError> {
    let context = SunContext::create()?;
    require_exact_runtime_version()?;
    // Prove the complete sparse symbol surface and fixed COLAMD ordering at
    // construction time, independently of any user graph.
    let identity_probe = prepare_sparse_resources(&context, 1, &[0, 1], &[0])?;
    drop(identity_probe);
    Ok(context)
}

fn require_exact_runtime_version() -> Result<(), IdaError> {
    let mut major: c_int = 0;
    let mut minor: c_int = 0;
    let mut patch: c_int = 0;
    let mut label = [0_i8; VERSION_LABEL_CAPACITY];
    let flag = unsafe {
        crate::ffi::SUNDIALSGetVersionNumber(
            &mut major,
            &mut minor,
            &mut patch,
            label.as_mut_ptr(),
            VERSION_LABEL_CAPACITY as c_int,
        )
    };
    require_success(flag, NativeStage::RuntimeVersionProbe)?;

    let label_end =
        label
            .iter()
            .position(|byte| *byte == 0)
            .ok_or(IdaError::InvalidRuntimeVersionLabel {
                stage: NativeStage::RuntimeVersionProbe,
            })?;
    let label_bytes = label[..label_end]
        .iter()
        .map(|byte| *byte as u8)
        .collect::<Vec<_>>();
    let label =
        String::from_utf8(label_bytes).map_err(|_| IdaError::InvalidRuntimeVersionLabel {
            stage: NativeStage::RuntimeVersionProbe,
        })?;
    let actual = if label.is_empty() {
        format!("{major}.{minor}.{patch}")
    } else {
        format!("{major}.{minor}.{patch}-{label}")
    };
    if actual != PINNED_SUNDIALS_VERSION {
        return Err(IdaError::RuntimeVersionMismatch {
            stage: NativeStage::RuntimeVersionProbe,
            expected: PINNED_SUNDIALS_VERSION,
            actual,
        });
    }
    Ok(())
}

fn require_success(flag: c_int, stage: NativeStage) -> Result<(), IdaError> {
    if flag == 0 {
        Ok(())
    } else {
        Err(IdaError::NativeCall { stage, flag })
    }
}

fn record_registration(_stage: NativeStage) {
    #[cfg(test)]
    allocation_audit::record_registration(_stage);
}

fn require_handle<T>(raw: *mut T, stage: NativeStage) -> Result<NonNull<T>, IdaError> {
    NonNull::new(raw).ok_or(IdaError::NullNativeHandle { stage })
}

#[derive(Clone, Copy)]
enum FailureInjection {
    None,
    #[cfg(test)]
    NullAt(NativeStage),
}

impl FailureInjection {
    fn is_null_at(self, _stage: NativeStage) -> bool {
        match self {
            Self::None => false,
            #[cfg(test)]
            Self::NullAt(injected) => injected == _stage,
        }
    }
}

struct SerialVector<'context> {
    raw: NonNull<crate::ffi::NVectorOpaque>,
    dimension: usize,
    _context: std::marker::PhantomData<&'context SunContext>,
}

impl<'context> SerialVector<'context> {
    fn create(
        context: &'context SunContext,
        dimension: crate::ffi::SunIndex,
        stage: NativeStage,
    ) -> Result<Self, IdaError> {
        let rust_dimension = usize::try_from(dimension).map_err(|_| IdaError::WorkOverflow)?;
        let raw = unsafe { crate::ffi::N_VNew_Serial(dimension, context.as_raw()) };
        let raw = require_handle(raw, stage)?;
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::Vector);
        Ok(Self {
            raw,
            dimension: rust_dimension,
            _context: std::marker::PhantomData,
        })
    }

    fn as_raw(&self) -> crate::ffi::NVector {
        self.raw.as_ptr()
    }

    fn copy_from_slice(
        &self,
        values: &[f64],
        field: &'static str,
        stage: NativeStage,
    ) -> Result<(), IdaError> {
        if values.len() != self.dimension {
            return Err(IdaError::VectorLength {
                field,
                expected: self.dimension,
                actual: values.len(),
            });
        }
        let destination = unsafe { crate::ffi::N_VGetArrayPointer(self.as_raw()) };
        let destination = NonNull::new(destination).ok_or(IdaError::NullNativeHandle { stage })?;
        unsafe {
            ptr::copy_nonoverlapping(values.as_ptr(), destination.as_ptr(), self.dimension);
        }
        Ok(())
    }

    fn fill(&self, value: f64, stage: NativeStage) -> Result<(), IdaError> {
        let destination = unsafe { crate::ffi::N_VGetArrayPointer(self.as_raw()) };
        let destination = NonNull::new(destination).ok_or(IdaError::NullNativeHandle { stage })?;
        unsafe { slice::from_raw_parts_mut(destination.as_ptr(), self.dimension) }.fill(value);
        Ok(())
    }

    fn copy_to_slice(
        &self,
        values: &mut [f64],
        field: &'static str,
        stage: NativeStage,
    ) -> Result<(), IdaError> {
        if values.len() != self.dimension {
            return Err(IdaError::VectorLength {
                field,
                expected: self.dimension,
                actual: values.len(),
            });
        }
        let source = unsafe { crate::ffi::N_VGetArrayPointer(self.as_raw()) };
        let source = NonNull::new(source).ok_or(IdaError::NullNativeHandle { stage })?;
        unsafe {
            ptr::copy_nonoverlapping(source.as_ptr(), values.as_mut_ptr(), self.dimension);
        }
        Ok(())
    }

    #[cfg(test)]
    fn values(&self, stage: NativeStage) -> Result<Vec<f64>, IdaError> {
        let data = unsafe { crate::ffi::N_VGetArrayPointer(self.as_raw()) };
        let data = NonNull::new(data).ok_or(IdaError::NullNativeHandle { stage })?;
        Ok(unsafe { slice::from_raw_parts(data.as_ptr(), self.dimension) }.to_vec())
    }
}

impl Drop for SerialVector<'_> {
    fn drop(&mut self) {
        unsafe { crate::ffi::N_VDestroy(self.raw.as_ptr()) };
        #[cfg(test)]
        allocation_audit::record_free(allocation_audit::ResourceKind::Vector);
    }
}

struct DenseMatrix<'context> {
    raw: NonNull<crate::ffi::SUNMatrixOpaque>,
    _context: std::marker::PhantomData<&'context SunContext>,
}

impl<'context> DenseMatrix<'context> {
    fn create(
        context: &'context SunContext,
        dimension: crate::ffi::SunIndex,
    ) -> Result<Self, IdaError> {
        let raw = unsafe { crate::ffi::SUNDenseMatrix(dimension, dimension, context.as_raw()) };
        let raw = require_handle(raw, NativeStage::DenseMatrixCreate)?;
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::Matrix);
        Ok(Self {
            raw,
            _context: std::marker::PhantomData,
        })
    }

    fn as_raw(&self) -> crate::ffi::SUNMatrix {
        self.raw.as_ptr()
    }
}

impl Drop for DenseMatrix<'_> {
    fn drop(&mut self) {
        unsafe { crate::ffi::SUNMatDestroy(self.raw.as_ptr()) };
        #[cfg(test)]
        allocation_audit::record_free(allocation_audit::ResourceKind::Matrix);
    }
}

#[cfg(feature = "sundials-ida-klu")]
const SUN_CSC_MATRIX: c_int = 0;
#[cfg(feature = "sundials-ida-klu")]
const SUNMATRIX_SPARSE_ID: c_int = 4;
#[cfg(feature = "sundials-ida-klu")]
const KLU_ORDERING_COLAMD: c_int = 1;

#[cfg(feature = "sundials-ida-klu")]
struct SparseMatrix<'context> {
    raw: NonNull<crate::ffi::SUNMatrixOpaque>,
    dimension: usize,
    nonzeros: usize,
    _context: std::marker::PhantomData<&'context SunContext>,
}

#[cfg(feature = "sundials-ida-klu")]
impl<'context> SparseMatrix<'context> {
    fn create(
        context: &'context SunContext,
        dimension: crate::ffi::SunIndex,
        nonzeros: crate::ffi::SunIndex,
    ) -> Result<Self, IdaError> {
        let raw = unsafe {
            crate::ffi::SUNSparseMatrix(
                dimension,
                dimension,
                nonzeros,
                SUN_CSC_MATRIX,
                context.as_raw(),
            )
        };
        let raw = require_handle(raw, NativeStage::SparseMatrixCreate)?;
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::Matrix);
        Ok(Self {
            raw,
            dimension: usize::try_from(dimension).map_err(|_| IdaError::WorkOverflow)?,
            nonzeros: usize::try_from(nonzeros).map_err(|_| IdaError::WorkOverflow)?,
            _context: std::marker::PhantomData,
        })
    }

    fn as_raw(&self) -> crate::ffi::SUNMatrix {
        self.raw.as_ptr()
    }

    fn restore_pattern(
        &self,
        column_pointers: &[usize],
        row_indices: &[usize],
    ) -> Result<(), IdaError> {
        crate::validate_csc_pattern(self.dimension, column_pointers, row_indices)?;
        if row_indices.len() != self.nonzeros {
            return Err(IdaError::InvalidCscPattern {
                code: "ida.klu.csc.native_nonzero_mismatch",
            });
        }
        let native_rows = unsafe { crate::ffi::SUNSparseMatrix_IndexValues(self.as_raw()) };
        let native_columns = unsafe { crate::ffi::SUNSparseMatrix_IndexPointers(self.as_raw()) };
        let native_rows = NonNull::new(native_rows).ok_or(IdaError::NullNativeHandle {
            stage: NativeStage::SparseMatrixCreate,
        })?;
        let native_columns = NonNull::new(native_columns).ok_or(IdaError::NullNativeHandle {
            stage: NativeStage::SparseMatrixCreate,
        })?;
        for (destination, &source) in
            unsafe { slice::from_raw_parts_mut(native_rows.as_ptr(), self.nonzeros) }
                .iter_mut()
                .zip(row_indices)
        {
            *destination =
                crate::ffi::SunIndex::try_from(source).map_err(|_| IdaError::WorkOverflow)?;
        }
        for (destination, &source) in
            unsafe { slice::from_raw_parts_mut(native_columns.as_ptr(), self.dimension + 1) }
                .iter_mut()
                .zip(column_pointers)
        {
            *destination =
                crate::ffi::SunIndex::try_from(source).map_err(|_| IdaError::WorkOverflow)?;
        }
        Ok(())
    }
}

#[cfg(feature = "sundials-ida-klu")]
impl Drop for SparseMatrix<'_> {
    fn drop(&mut self) {
        unsafe { crate::ffi::SUNMatDestroy(self.raw.as_ptr()) };
        #[cfg(test)]
        allocation_audit::record_free(allocation_audit::ResourceKind::Matrix);
    }
}

enum Matrix<'context> {
    Dense(DenseMatrix<'context>),
    #[cfg(feature = "sundials-ida-klu")]
    Sparse(SparseMatrix<'context>),
}

impl Matrix<'_> {
    fn as_raw(&self) -> crate::ffi::SUNMatrix {
        match self {
            Self::Dense(matrix) => matrix.as_raw(),
            #[cfg(feature = "sundials-ida-klu")]
            Self::Sparse(matrix) => matrix.as_raw(),
        }
    }

    #[cfg(feature = "sundials-ida-klu")]
    fn is_sparse(&self) -> bool {
        match self {
            Self::Dense(_) => false,
            #[cfg(feature = "sundials-ida-klu")]
            Self::Sparse(_) => true,
        }
    }
}

struct DenseLinearSolver<'context> {
    raw: NonNull<crate::ffi::SUNLinearSolverOpaque>,
    _context: std::marker::PhantomData<&'context SunContext>,
}

impl<'context> DenseLinearSolver<'context> {
    fn create(
        context: &'context SunContext,
        template: &SerialVector<'context>,
        matrix: &DenseMatrix<'context>,
    ) -> Result<Self, IdaError> {
        let raw = unsafe {
            crate::ffi::SUNLinSol_Dense(template.as_raw(), matrix.as_raw(), context.as_raw())
        };
        let raw = require_handle(raw, NativeStage::DenseLinearSolverCreate)?;
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::LinearSolver);
        Ok(Self {
            raw,
            _context: std::marker::PhantomData,
        })
    }

    fn as_raw(&self) -> crate::ffi::SUNLinearSolver {
        self.raw.as_ptr()
    }
}

impl Drop for DenseLinearSolver<'_> {
    fn drop(&mut self) {
        let _ = unsafe { crate::ffi::SUNLinSolFree(self.raw.as_ptr()) };
        #[cfg(test)]
        allocation_audit::record_free(allocation_audit::ResourceKind::LinearSolver);
    }
}

#[cfg(feature = "sundials-ida-klu")]
struct KluLinearSolver<'context> {
    raw: NonNull<crate::ffi::SUNLinearSolverOpaque>,
    _context: std::marker::PhantomData<&'context SunContext>,
}

#[cfg(feature = "sundials-ida-klu")]
impl<'context> KluLinearSolver<'context> {
    fn create(
        context: &'context SunContext,
        template: &SerialVector<'context>,
        matrix: &SparseMatrix<'context>,
    ) -> Result<Self, IdaError> {
        let raw = unsafe {
            crate::ffi::SUNLinSol_KLU(template.as_raw(), matrix.as_raw(), context.as_raw())
        };
        let raw = require_handle(raw, NativeStage::KluLinearSolverCreate)?;
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::LinearSolver);
        let solver = Self {
            raw,
            _context: std::marker::PhantomData,
        };
        let flag =
            unsafe { crate::ffi::SUNLinSol_KLUSetOrdering(solver.as_raw(), KLU_ORDERING_COLAMD) };
        require_success(flag, NativeStage::KluSetOrdering)?;
        Ok(solver)
    }

    fn as_raw(&self) -> crate::ffi::SUNLinearSolver {
        self.raw.as_ptr()
    }
}

#[cfg(feature = "sundials-ida-klu")]
impl Drop for KluLinearSolver<'_> {
    fn drop(&mut self) {
        let _ = unsafe { crate::ffi::SUNLinSolFree(self.raw.as_ptr()) };
        #[cfg(test)]
        allocation_audit::record_free(allocation_audit::ResourceKind::LinearSolver);
    }
}

enum LinearSolver<'context> {
    Dense(DenseLinearSolver<'context>),
    #[cfg(feature = "sundials-ida-klu")]
    Klu(KluLinearSolver<'context>),
}

impl LinearSolver<'_> {
    fn as_raw(&self) -> crate::ffi::SUNLinearSolver {
        match self {
            Self::Dense(solver) => solver.as_raw(),
            #[cfg(feature = "sundials-ida-klu")]
            Self::Klu(solver) => solver.as_raw(),
        }
    }
}

struct IdaMemory<'context> {
    raw: NonNull<std::ffi::c_void>,
    _context: std::marker::PhantomData<&'context SunContext>,
}

impl<'context> IdaMemory<'context> {
    fn create(context: &'context SunContext) -> Result<Self, IdaError> {
        let raw = unsafe { crate::ffi::IDACreate(context.as_raw()) };
        let raw = require_handle(raw, NativeStage::IdaMemoryCreate)?;
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::IdaMemory);
        Ok(Self {
            raw,
            _context: std::marker::PhantomData,
        })
    }

    fn as_raw(&self) -> crate::ffi::IdaMemory {
        self.raw.as_ptr()
    }
}

impl Drop for IdaMemory<'_> {
    fn drop(&mut self) {
        let mut raw = self.raw.as_ptr();
        unsafe { crate::ffi::IDAFree(&mut raw) };
        #[cfg(test)]
        allocation_audit::record_free(allocation_audit::ResourceKind::IdaMemory);
    }
}

/// Native objects required before IDA initialization. Field declaration order
/// is also destruction order: IDA memory, linear solver, matrix, then vectors.
pub(crate) struct NativeResources<'context> {
    _ida_memory: IdaMemory<'context>,
    _linear_solver: LinearSolver<'context>,
    _matrix: Matrix<'context>,
    _absolute_tolerance: SerialVector<'context>,
    _id: SerialVector<'context>,
    _yp: SerialVector<'context>,
    _y: SerialVector<'context>,
    dimension: usize,
}

impl fmt::Debug for NativeResources<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeResources")
            .field("dimension", &self.dimension)
            .finish_non_exhaustive()
    }
}

impl NativeResources<'_> {
    #[cfg(test)]
    fn dimension(&self) -> usize {
        self.dimension
    }

    fn y_raw(&self) -> crate::ffi::NVector {
        self._y.as_raw()
    }

    fn yp_raw(&self) -> crate::ffi::NVector {
        self._yp.as_raw()
    }

    #[cfg(test)]
    fn residual_raw(&self) -> crate::ffi::NVector {
        self._absolute_tolerance.as_raw()
    }

    fn matrix_raw(&self) -> crate::ffi::SUNMatrix {
        self._matrix.as_raw()
    }

    #[cfg(feature = "sundials-ida-klu")]
    fn is_sparse(&self) -> bool {
        self._matrix.is_sparse()
    }

    fn id_raw(&self) -> crate::ffi::NVector {
        self._id.as_raw()
    }

    fn absolute_tolerance_raw(&self) -> crate::ffi::NVector {
        self._absolute_tolerance.as_raw()
    }

    fn linear_solver_raw(&self) -> crate::ffi::SUNLinearSolver {
        self._linear_solver.as_raw()
    }

    fn ida_memory_raw(&self) -> crate::ffi::IdaMemory {
        self._ida_memory.as_raw()
    }
}

pub(crate) fn prepare_resources(
    context: &SunContext,
    dimension: usize,
) -> Result<NativeResources<'_>, IdaError> {
    prepare_resources_with(context, dimension, FailureInjection::None)
}

fn prepare_resources_with(
    context: &SunContext,
    dimension: usize,
    injection: FailureInjection,
) -> Result<NativeResources<'_>, IdaError> {
    validate_resource_dimension(dimension)?;
    let dimension =
        crate::ffi::SunIndex::try_from(dimension).map_err(|_| IdaError::WorkOverflow)?;

    if injection.is_null_at(NativeStage::YVectorCreate) {
        return Err(IdaError::NullNativeHandle {
            stage: NativeStage::YVectorCreate,
        });
    }
    let y = SerialVector::create(context, dimension, NativeStage::YVectorCreate)?;

    if injection.is_null_at(NativeStage::YpVectorCreate) {
        return Err(IdaError::NullNativeHandle {
            stage: NativeStage::YpVectorCreate,
        });
    }
    let yp = SerialVector::create(context, dimension, NativeStage::YpVectorCreate)?;

    if injection.is_null_at(NativeStage::IdVectorCreate) {
        return Err(IdaError::NullNativeHandle {
            stage: NativeStage::IdVectorCreate,
        });
    }
    let id = SerialVector::create(context, dimension, NativeStage::IdVectorCreate)?;

    if injection.is_null_at(NativeStage::AbsoluteToleranceVectorCreate) {
        return Err(IdaError::NullNativeHandle {
            stage: NativeStage::AbsoluteToleranceVectorCreate,
        });
    }
    let absolute_tolerance = SerialVector::create(
        context,
        dimension,
        NativeStage::AbsoluteToleranceVectorCreate,
    )?;

    if injection.is_null_at(NativeStage::DenseMatrixCreate) {
        return Err(IdaError::NullNativeHandle {
            stage: NativeStage::DenseMatrixCreate,
        });
    }
    let matrix = DenseMatrix::create(context, dimension)?;

    if injection.is_null_at(NativeStage::DenseLinearSolverCreate) {
        return Err(IdaError::NullNativeHandle {
            stage: NativeStage::DenseLinearSolverCreate,
        });
    }
    let linear_solver = DenseLinearSolver::create(context, &y, &matrix)?;

    if injection.is_null_at(NativeStage::IdaMemoryCreate) {
        return Err(IdaError::NullNativeHandle {
            stage: NativeStage::IdaMemoryCreate,
        });
    }
    let ida_memory = IdaMemory::create(context)?;

    Ok(NativeResources {
        _ida_memory: ida_memory,
        _linear_solver: LinearSolver::Dense(linear_solver),
        _matrix: Matrix::Dense(matrix),
        _absolute_tolerance: absolute_tolerance,
        _id: id,
        _yp: yp,
        _y: y,
        dimension: dimension as usize,
    })
}

#[cfg(feature = "sundials-ida-klu")]
fn prepare_sparse_resources<'context>(
    context: &'context SunContext,
    dimension: usize,
    column_pointers: &[usize],
    row_indices: &[usize],
) -> Result<NativeResources<'context>, IdaError> {
    crate::validate_csc_pattern(dimension, column_pointers, row_indices)?;
    if dimension > crate::MAX_KLU_DIMENSION {
        return Err(IdaError::KluDimensionLimit {
            actual: dimension,
            applied_maximum: crate::MAX_KLU_DIMENSION,
            backend_maximum: crate::MAX_KLU_DIMENSION,
        });
    }
    if row_indices.len() > crate::MAX_KLU_NONZEROS {
        return Err(IdaError::KluNonzeroLimit {
            actual: row_indices.len(),
            applied_maximum: crate::MAX_KLU_NONZEROS,
            backend_maximum: crate::MAX_KLU_NONZEROS,
        });
    }
    let native_dimension =
        crate::ffi::SunIndex::try_from(dimension).map_err(|_| IdaError::WorkOverflow)?;
    let native_nonzeros =
        crate::ffi::SunIndex::try_from(row_indices.len()).map_err(|_| IdaError::WorkOverflow)?;

    let y = SerialVector::create(context, native_dimension, NativeStage::YVectorCreate)?;
    let yp = SerialVector::create(context, native_dimension, NativeStage::YpVectorCreate)?;
    let id = SerialVector::create(context, native_dimension, NativeStage::IdVectorCreate)?;
    let absolute_tolerance = SerialVector::create(
        context,
        native_dimension,
        NativeStage::AbsoluteToleranceVectorCreate,
    )?;
    let matrix = SparseMatrix::create(context, native_dimension, native_nonzeros)?;
    matrix.restore_pattern(column_pointers, row_indices)?;
    let linear_solver = KluLinearSolver::create(context, &y, &matrix)?;
    let ida_memory = IdaMemory::create(context)?;

    Ok(NativeResources {
        _ida_memory: ida_memory,
        _linear_solver: LinearSolver::Klu(linear_solver),
        _matrix: Matrix::Sparse(matrix),
        _absolute_tolerance: absolute_tolerance,
        _id: id,
        _yp: yp,
        _y: y,
        dimension,
    })
}

fn validate_resource_dimension(dimension: usize) -> Result<(), IdaError> {
    if dimension == 0 {
        return Err(IdaError::InvalidSetting {
            code: "ida.dimension.empty",
            field: "dimension",
        });
    }
    if dimension > crate::MAX_DENSE_DIMENSION {
        return Err(IdaError::DenseDimensionLimit {
            actual: dimension,
            applied_maximum: crate::MAX_DENSE_DIMENSION,
            backend_maximum: crate::MAX_DENSE_DIMENSION,
        });
    }
    dimension
        .checked_mul(dimension)
        .ok_or(IdaError::WorkOverflow)?;
    Ok(())
}

fn try_zeroed_f64(length: usize, field: &'static str) -> Result<Vec<f64>, IdaError> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(length)
        .map_err(|_| IdaError::AllocationFailed {
            field,
            requested: length,
        })?;
    values.resize(length, 0.0);
    Ok(values)
}

fn try_clone_f64(values: &[f64], field: &'static str) -> Result<Vec<f64>, IdaError> {
    let mut copy = Vec::new();
    copy.try_reserve_exact(values.len())
        .map_err(|_| IdaError::AllocationFailed {
            field,
            requested: values.len(),
        })?;
    copy.extend_from_slice(values);
    Ok(copy)
}

fn try_clone_outputs(outputs: &[DaeOutput]) -> Result<Vec<DaeOutput>, IdaError> {
    let mut copy = Vec::new();
    copy.try_reserve_exact(outputs.len())
        .map_err(|_| IdaError::AllocationFailed {
            field: "output descriptors",
            requested: outputs.len(),
        })?;
    for output in outputs {
        let mut name = String::new();
        name.try_reserve_exact(output.name.len())
            .map_err(|_| IdaError::AllocationFailed {
                field: "output descriptor name bytes",
                requested: output.name.len(),
            })?;
        name.push_str(&output.name);
        copy.push(DaeOutput {
            index: output.index,
            block_id: output.block_id,
            variable_index: output.variable_index,
            name,
            quantity: output.quantity,
        });
    }
    Ok(copy)
}

/// Borrowed, preallocated state passed through IDA's opaque `user_data`
/// pointer. The state and lowered graph must outlive every synchronous callback
/// that receives the pointer.
#[allow(dead_code)]
pub(crate) struct CallbackState<'system, 'graph> {
    system: &'system DaeResidualSystem<'graph>,
    jacobian_values: Vec<f64>,
    first_error: Option<IdaError>,
    #[cfg(feature = "sundials-ida-klu")]
    sparse_work: Option<SparseCallbackWork>,
    _pinned: PhantomPinned,
    #[cfg(test)]
    panic_residual: bool,
    #[cfg(test)]
    panic_jacobian: bool,
}

#[cfg(feature = "sundials-ida-klu")]
#[derive(Clone, Copy, Debug)]
struct SparseCallbackWork {
    evaluations: u64,
    entry_work: u64,
    maximum_evaluations: u64,
    maximum_entry_work: u64,
}

#[allow(dead_code)]
impl<'system, 'graph> CallbackState<'system, 'graph> {
    pub(crate) fn new(system: &'system DaeResidualSystem<'graph>) -> Result<Self, IdaError> {
        validate_resource_dimension(system.variables().len())?;
        let state = Self {
            system,
            jacobian_values: try_zeroed_f64(
                system.csc_pattern().nonzero_count(),
                "callback Jacobian scratch",
            )?,
            first_error: None,
            #[cfg(feature = "sundials-ida-klu")]
            sparse_work: None,
            _pinned: PhantomPinned,
            #[cfg(test)]
            panic_residual: false,
            #[cfg(test)]
            panic_jacobian: false,
        };
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::CallbackState);
        Ok(state)
    }

    #[cfg(feature = "sundials-ida-klu")]
    fn new_sparse(
        system: &'system DaeResidualSystem<'graph>,
        maximum_evaluations: u64,
        maximum_entry_work: u64,
    ) -> Result<Self, IdaError> {
        let dimension = system.variables().len();
        crate::validate_csc_pattern(
            dimension,
            system.csc_pattern().column_pointers(),
            system.csc_pattern().row_indices(),
        )?;
        let state = Self {
            system,
            jacobian_values: try_zeroed_f64(
                system.csc_pattern().nonzero_count(),
                "callback Jacobian scratch",
            )?,
            first_error: None,
            sparse_work: Some(SparseCallbackWork {
                evaluations: 0,
                entry_work: 0,
                maximum_evaluations,
                maximum_entry_work,
            }),
            _pinned: PhantomPinned,
            #[cfg(test)]
            panic_residual: false,
            #[cfg(test)]
            panic_jacobian: false,
        };
        #[cfg(test)]
        allocation_audit::record_allocation(allocation_audit::ResourceKind::CallbackState);
        Ok(state)
    }

    #[cfg(feature = "sundials-ida-klu")]
    fn begin_sparse_jacobian(&mut self) -> Result<(), IdaError> {
        let nonzeros =
            u64::try_from(self.jacobian_values.len()).map_err(|_| IdaError::WorkOverflow)?;
        let work = self
            .sparse_work
            .as_mut()
            .ok_or(IdaError::InvalidCscPattern {
                code: "ida.klu.callback.mode",
            })?;
        let attempted_evaluations = work
            .evaluations
            .checked_add(1)
            .ok_or(IdaError::WorkOverflow)?;
        if attempted_evaluations > work.maximum_evaluations {
            return Err(IdaError::KluJacobianEvaluationLimit {
                attempted: attempted_evaluations,
                maximum: work.maximum_evaluations,
            });
        }
        let attempted_entry_work = work
            .entry_work
            .checked_add(nonzeros)
            .ok_or(IdaError::WorkOverflow)?;
        if attempted_entry_work > work.maximum_entry_work {
            return Err(IdaError::KluJacobianEntryWorkLimit {
                attempted: attempted_entry_work,
                maximum: work.maximum_entry_work,
            });
        }
        work.evaluations = attempted_evaluations;
        work.entry_work = attempted_entry_work;
        Ok(())
    }

    pub(crate) fn first_error(&self) -> Option<&IdaError> {
        self.first_error.as_ref()
    }

    fn latch(&mut self, error: IdaError) {
        if self.first_error.is_none() {
            self.first_error = Some(error);
        }
    }

    #[cfg(test)]
    fn inject_panic(&mut self, callback: CallbackKind) {
        match callback {
            CallbackKind::Residual => self.panic_residual = true,
            CallbackKind::Jacobian => self.panic_jacobian = true,
        }
    }

    fn panic_if_injected(&self, _callback: CallbackKind) {
        #[cfg(test)]
        match _callback {
            CallbackKind::Residual if self.panic_residual => {
                panic!("injected residual callback panic")
            }
            CallbackKind::Jacobian if self.panic_jacobian => {
                panic!("injected Jacobian callback panic")
            }
            _ => {}
        }
    }
}

impl Drop for CallbackState<'_, '_> {
    fn drop(&mut self) {
        #[cfg(test)]
        allocation_audit::record_free(allocation_audit::ResourceKind::CallbackState);
    }
}

const IDA_YA_YDP_INIT: c_int = 1;
const IDA_SUCCESS: c_int = 0;
const IDA_TOO_MUCH_WORK: c_int = -1;
#[cfg(feature = "sundials-ida-klu")]
const IDA_LSETUP_FAIL: c_int = -6;
#[cfg(feature = "sundials-ida-klu")]
const IDA_LSOLVE_FAIL: c_int = -7;
const IDA_ONE_STEP: c_int = 2;
const INTERVAL_ROUNDOFF_MULTIPLIER: f64 = 64.0;
type NativeLongGetter = unsafe extern "C" fn(crate::ffi::IdaMemory, *mut c_long) -> c_int;
type NativeIntGetter = unsafe extern "C" fn(crate::ffi::IdaMemory, *mut c_int) -> c_int;
type NativeRealGetter = unsafe extern "C" fn(crate::ffi::IdaMemory, *mut f64) -> c_int;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum SolveInjection {
    #[default]
    None,
    NonFiniteY {
        requested_index: usize,
    },
    NonFiniteYp {
        requested_index: usize,
    },
    NativeFlag(c_int),
}

#[derive(Clone, Copy, Debug)]
struct CounterSnapshot {
    internal_steps: u64,
    residual_evaluations: u64,
    linear_solver_setups: u64,
    error_test_failures: u64,
    nonlinear_iterations: u64,
    nonlinear_convergence_failures: u64,
    jacobian_evaluations: u64,
    linear_residual_evaluations: u64,
    linear_iterations: u64,
    linear_convergence_failures: u64,
}

#[derive(Clone, Copy, Debug)]
struct CounterDelta {
    internal_steps: u64,
    residual_evaluations: u64,
    linear_solver_setups: u64,
    error_test_failures: u64,
    nonlinear_iterations: u64,
    nonlinear_convergence_failures: u64,
    jacobian_evaluations: u64,
    linear_residual_evaluations: u64,
    linear_iterations: u64,
    linear_convergence_failures: u64,
}

impl CounterSnapshot {
    fn checked_delta(self, baseline: Self) -> Result<CounterDelta, IdaError> {
        fn delta(statistic: NativeStatistic, before: u64, after: u64) -> Result<u64, IdaError> {
            after
                .checked_sub(before)
                .ok_or(IdaError::StatisticCounterInvariant {
                    statistic,
                    before,
                    after,
                })
        }

        Ok(CounterDelta {
            internal_steps: delta(
                NativeStatistic::InternalSteps,
                baseline.internal_steps,
                self.internal_steps,
            )?,
            residual_evaluations: delta(
                NativeStatistic::ResidualEvaluations,
                baseline.residual_evaluations,
                self.residual_evaluations,
            )?,
            linear_solver_setups: delta(
                NativeStatistic::LinearSolverSetups,
                baseline.linear_solver_setups,
                self.linear_solver_setups,
            )?,
            error_test_failures: delta(
                NativeStatistic::ErrorTestFailures,
                baseline.error_test_failures,
                self.error_test_failures,
            )?,
            nonlinear_iterations: delta(
                NativeStatistic::NonlinearIterations,
                baseline.nonlinear_iterations,
                self.nonlinear_iterations,
            )?,
            nonlinear_convergence_failures: delta(
                NativeStatistic::NonlinearConvergenceFailures,
                baseline.nonlinear_convergence_failures,
                self.nonlinear_convergence_failures,
            )?,
            jacobian_evaluations: delta(
                NativeStatistic::JacobianEvaluations,
                baseline.jacobian_evaluations,
                self.jacobian_evaluations,
            )?,
            linear_residual_evaluations: delta(
                NativeStatistic::LinearResidualEvaluations,
                baseline.linear_residual_evaluations,
                self.linear_residual_evaluations,
            )?,
            linear_iterations: delta(
                NativeStatistic::LinearIterations,
                baseline.linear_iterations,
                self.linear_iterations,
            )?,
            linear_convergence_failures: delta(
                NativeStatistic::LinearConvergenceFailures,
                baseline.linear_convergence_failures,
                self.linear_convergence_failures,
            )?,
        })
    }
}

/// A fully initialized and registered IDA session which has not advanced
/// time. Field order is a safety invariant: the complete native resource
/// stack (whose first member is IDA memory) is destroyed before the callback
/// state referenced by IDA's `user_data` pointer.
pub struct IdaSession<'context, 'system, 'graph> {
    resources: NativeResources<'context>,
    callback_state: Pin<Box<CallbackState<'system, 'graph>>>,
    initial_time_s: f64,
    corrected_initial_conditions: bool,
    configured_max_order: u8,
    configured_max_steps: u64,
    result_contract: &'static str,
    backend_identity: BackendIdentity,
    output_times_s: Vec<f64>,
    outputs: Vec<DaeOutput>,
    result_values: Vec<f64>,
    y_scratch: Vec<f64>,
    yp_scratch: Vec<f64>,
    output_scratch: Vec<f64>,
    #[cfg(test)]
    solve_injection: SolveInjection,
    #[cfg(test)]
    last_linear_flag_injection: Option<(c_int, c_long)>,
}

impl fmt::Debug for IdaSession<'_, '_, '_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IdaSession")
            .field("dimension", &self.resources.dimension)
            .field("initial_time_s", &self.initial_time_s)
            .field(
                "corrected_initial_conditions",
                &self.corrected_initial_conditions,
            )
            .field("configured_max_order", &self.configured_max_order)
            .field("configured_max_steps", &self.configured_max_steps)
            .field("requested_outputs", &self.output_times_s.len())
            .finish_non_exhaustive()
    }
}

impl<'context, 'system, 'graph> IdaSession<'context, 'system, 'graph> {
    pub fn dimension(&self) -> usize {
        self.resources.dimension
    }

    pub fn initial_time_s(&self) -> f64 {
        self.initial_time_s
    }

    pub fn corrected_initial_conditions(&self) -> bool {
        self.corrected_initial_conditions
    }

    fn callback_user_data(&mut self) -> *mut c_void {
        // Pinning makes this address stable for the remainder of the session.
        // IDA never receives a pointer until after this Pin<Box<_>> exists.
        let state = unsafe { self.callback_state.as_mut().get_unchecked_mut() };
        (state as *mut CallbackState<'system, 'graph>).cast()
    }

    fn require_registered_call(&self, flag: c_int, stage: NativeStage) -> Result<(), IdaError> {
        if let Some(error) = self.callback_state.as_ref().get_ref().first_error() {
            return Err(error.clone());
        }
        if flag == IDA_SUCCESS {
            return Ok(());
        }
        if stage == NativeStage::IdaCalcIc {
            return Err(self.native_solve_failure(stage, flag));
        }
        require_success(flag, stage)
    }

    fn register(&mut self, settings: &IdaSessionSettings<'_>) -> Result<(), IdaError> {
        let memory = self.resources.ida_memory_raw();
        record_registration(NativeStage::IdaInit);
        let flag = unsafe {
            crate::ffi::IDAInit(
                memory,
                residual_callback,
                settings.initial_time_s,
                self.resources.y_raw(),
                self.resources.yp_raw(),
            )
        };
        self.require_registered_call(flag, NativeStage::IdaInit)?;

        let user_data = self.callback_user_data();
        record_registration(NativeStage::IdaSetUserData);
        let flag = unsafe { crate::ffi::IDASetUserData(memory, user_data) };
        self.require_registered_call(flag, NativeStage::IdaSetUserData)?;

        let flag = match &settings.absolute_tolerance {
            IdaAbsoluteTolerance::Scalar(absolute_tolerance) => unsafe {
                record_registration(NativeStage::IdaScalarTolerances);
                crate::ffi::IDASStolerances(
                    memory,
                    settings.relative_tolerance,
                    *absolute_tolerance,
                )
            },
            IdaAbsoluteTolerance::Vector(_) => unsafe {
                record_registration(NativeStage::IdaVectorTolerances);
                crate::ffi::IDASVtolerances(
                    memory,
                    settings.relative_tolerance,
                    self.resources.absolute_tolerance_raw(),
                )
            },
        };
        let tolerance_stage = match &settings.absolute_tolerance {
            IdaAbsoluteTolerance::Scalar(_) => NativeStage::IdaScalarTolerances,
            IdaAbsoluteTolerance::Vector(_) => NativeStage::IdaVectorTolerances,
        };
        self.require_registered_call(flag, tolerance_stage)?;

        record_registration(NativeStage::IdaSetId);
        let flag = unsafe { crate::ffi::IDASetId(memory, self.resources.id_raw()) };
        self.require_registered_call(flag, NativeStage::IdaSetId)?;

        let suppress = if settings.suppress_algebraic_error {
            1
        } else {
            0
        };
        record_registration(NativeStage::IdaSetSuppressAlg);
        let flag = unsafe { crate::ffi::IDASetSuppressAlg(memory, suppress) };
        self.require_registered_call(flag, NativeStage::IdaSetSuppressAlg)?;

        record_registration(NativeStage::IdaSetMaxOrd);
        let flag = unsafe { crate::ffi::IDASetMaxOrd(memory, c_int::from(settings.max_order)) };
        self.require_registered_call(flag, NativeStage::IdaSetMaxOrd)?;

        let maximum_steps =
            c_long::try_from(settings.max_steps).map_err(|_| IdaError::WorkOverflow)?;
        record_registration(NativeStage::IdaSetMaxNumSteps);
        let flag = unsafe { crate::ffi::IDASetMaxNumSteps(memory, maximum_steps) };
        self.require_registered_call(flag, NativeStage::IdaSetMaxNumSteps)?;

        record_registration(NativeStage::IdaSetLinearSolver);
        let flag = unsafe {
            crate::ffi::IDASetLinearSolver(
                memory,
                self.resources.linear_solver_raw(),
                self.resources.matrix_raw(),
            )
        };
        self.require_registered_call(flag, NativeStage::IdaSetLinearSolver)?;

        record_registration(NativeStage::IdaSetJacFn);
        let jacobian = {
            #[cfg(feature = "sundials-ida-klu")]
            {
                if self.resources.is_sparse() {
                    sparse_jacobian_callback
                } else {
                    jacobian_callback
                }
            }
            #[cfg(not(feature = "sundials-ida-klu"))]
            {
                jacobian_callback
            }
        };
        let flag = unsafe { crate::ffi::IDASetJacFn(memory, jacobian) };
        self.require_registered_call(flag, NativeStage::IdaSetJacFn)?;

        if matches!(
            settings.initial_conditions,
            IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative { .. }
        ) {
            record_registration(NativeStage::IdaCalcIc);
            let flag = unsafe {
                crate::ffi::IDACalcIC(memory, IDA_YA_YDP_INIT, settings.output_times_s[0])
            };
            self.require_registered_call(flag, NativeStage::IdaCalcIc)?;
            record_registration(NativeStage::IdaGetConsistentIc);
            let flag = unsafe {
                crate::ffi::IDAGetConsistentIC(
                    memory,
                    self.resources.y_raw(),
                    self.resources.yp_raw(),
                )
            };
            self.require_registered_call(flag, NativeStage::IdaGetConsistentIc)?;
            self.corrected_initial_conditions = true;
        }
        Ok(())
    }

    fn first_callback_error(&self) -> Option<IdaError> {
        self.callback_state
            .as_ref()
            .get_ref()
            .first_error()
            .cloned()
    }

    fn read_counter(
        &self,
        getter: NativeLongGetter,
        stage: NativeStage,
        statistic: NativeStatistic,
    ) -> Result<u64, IdaError> {
        let mut value: c_long = -1;
        let flag = unsafe { getter(self.resources.ida_memory_raw(), &mut value) };
        self.require_registered_call(flag, stage)?;
        checked_native_counter(value, stage, statistic)
    }

    fn read_order(
        &self,
        getter: NativeIntGetter,
        stage: NativeStage,
        statistic: NativeStatistic,
    ) -> Result<u8, IdaError> {
        let mut value: c_int = -1;
        let flag = unsafe { getter(self.resources.ida_memory_raw(), &mut value) };
        self.require_registered_call(flag, stage)?;
        let order = u8::try_from(value).map_err(|_| IdaError::InvalidNativeStatistic {
            stage,
            statistic,
            value: i64::from(value),
        })?;
        if order == 0 || order > self.configured_max_order {
            return Err(IdaError::InvalidNativeStatistic {
                stage,
                statistic,
                value: i64::from(value),
            });
        }
        Ok(order)
    }

    fn read_real(
        &self,
        getter: NativeRealGetter,
        stage: NativeStage,
        field: NativeValue,
    ) -> Result<f64, IdaError> {
        let mut value = f64::NAN;
        let flag = unsafe { getter(self.resources.ida_memory_raw(), &mut value) };
        self.require_registered_call(flag, stage)?;
        require_finite_native(value, stage, field, None, None)?;
        Ok(value)
    }

    fn read_last_linear_solver_flag(&self) -> Result<i64, IdaError> {
        let (flag, value) = self.query_last_linear_solver_flag();
        self.require_registered_call(flag, NativeStage::IdaGetLastLinFlag)?;
        Ok(value as i64)
    }

    fn query_last_linear_solver_flag(&self) -> (c_int, c_long) {
        #[cfg(test)]
        if let Some(injected) = self.last_linear_flag_injection {
            return injected;
        }
        let mut value: c_long = 0;
        let flag =
            unsafe { crate::ffi::IDAGetLastLinFlag(self.resources.ida_memory_raw(), &mut value) };
        (flag, value)
    }

    fn native_solve_failure(&self, stage: NativeStage, ida_flag: c_int) -> IdaError {
        #[cfg(feature = "sundials-ida-klu")]
        if self.resources.is_sparse() && matches!(ida_flag, IDA_LSETUP_FAIL | IDA_LSOLVE_FAIL) {
            let (getter_flag, value) = self.query_last_linear_solver_flag();
            let last_linear_flag = if getter_flag == 0 {
                IdaLinearFlagEvidence::Available(value as i64)
            } else {
                IdaLinearFlagEvidence::Unavailable { getter_flag }
            };
            return IdaError::KluLinearSolverFailure {
                stage,
                ida_flag,
                last_linear_flag,
            };
        }
        IdaError::NativeCall {
            stage,
            flag: ida_flag,
        }
    }

    fn counter_snapshot(&self) -> Result<CounterSnapshot, IdaError> {
        Ok(CounterSnapshot {
            internal_steps: self.read_counter(
                crate::ffi::IDAGetNumSteps,
                NativeStage::IdaGetNumSteps,
                NativeStatistic::InternalSteps,
            )?,
            residual_evaluations: self.read_counter(
                crate::ffi::IDAGetNumResEvals,
                NativeStage::IdaGetNumResEvals,
                NativeStatistic::ResidualEvaluations,
            )?,
            linear_solver_setups: self.read_counter(
                crate::ffi::IDAGetNumLinSolvSetups,
                NativeStage::IdaGetNumLinSolvSetups,
                NativeStatistic::LinearSolverSetups,
            )?,
            error_test_failures: self.read_counter(
                crate::ffi::IDAGetNumErrTestFails,
                NativeStage::IdaGetNumErrTestFails,
                NativeStatistic::ErrorTestFailures,
            )?,
            nonlinear_iterations: self.read_counter(
                crate::ffi::IDAGetNumNonlinSolvIters,
                NativeStage::IdaGetNumNonlinSolvIters,
                NativeStatistic::NonlinearIterations,
            )?,
            nonlinear_convergence_failures: self.read_counter(
                crate::ffi::IDAGetNumNonlinSolvConvFails,
                NativeStage::IdaGetNumNonlinSolvConvFails,
                NativeStatistic::NonlinearConvergenceFailures,
            )?,
            jacobian_evaluations: self.read_counter(
                crate::ffi::IDAGetNumJacEvals,
                NativeStage::IdaGetNumJacEvals,
                NativeStatistic::JacobianEvaluations,
            )?,
            linear_residual_evaluations: self.read_counter(
                crate::ffi::IDAGetNumLinResEvals,
                NativeStage::IdaGetNumLinResEvals,
                NativeStatistic::LinearResidualEvaluations,
            )?,
            linear_iterations: self.read_counter(
                crate::ffi::IDAGetNumLinIters,
                NativeStage::IdaGetNumLinIters,
                NativeStatistic::LinearIterations,
            )?,
            linear_convergence_failures: self.read_counter(
                crate::ffi::IDAGetNumLinConvFails,
                NativeStage::IdaGetNumLinConvFails,
                NativeStatistic::LinearConvergenceFailures,
            )?,
        })
    }

    fn interpolate_requested_row(
        &mut self,
        requested_index: usize,
        previous_time_s: f64,
        current_time_s: f64,
    ) -> Result<(), IdaError> {
        let requested_time_s = self.output_times_s[requested_index];
        // SUNDIALS 7.8 checks the lower dense-output bound but not t <= tn.
        // Enforce both logical bounds before either IDAGetDky call.
        require_interpolation_bounds(requested_time_s, previous_time_s, current_time_s)?;

        let flag = unsafe {
            crate::ffi::IDAGetDky(
                self.resources.ida_memory_raw(),
                requested_time_s,
                0,
                self.resources.y_raw(),
            )
        };
        self.require_registered_call(flag, NativeStage::IdaGetDkyY)?;
        let flag = unsafe {
            crate::ffi::IDAGetDky(
                self.resources.ida_memory_raw(),
                requested_time_s,
                1,
                self.resources.yp_raw(),
            )
        };
        self.require_registered_call(flag, NativeStage::IdaGetDkyYp)?;

        self.resources._y.copy_to_slice(
            &mut self.y_scratch,
            "result y scratch",
            NativeStage::IdaGetDkyY,
        )?;
        self.resources._yp.copy_to_slice(
            &mut self.yp_scratch,
            "result yp scratch",
            NativeStage::IdaGetDkyYp,
        )?;

        #[cfg(test)]
        match self.solve_injection {
            SolveInjection::NonFiniteY {
                requested_index: injected,
            } if injected == requested_index => self.y_scratch[0] = f64::NAN,
            SolveInjection::NonFiniteYp {
                requested_index: injected,
            } if injected == requested_index => self.yp_scratch[0] = f64::INFINITY,
            _ => {}
        }

        require_finite_slice(
            &self.y_scratch,
            NativeStage::IdaGetDkyY,
            NativeValue::Y,
            requested_index,
        )?;
        require_finite_slice(
            &self.yp_scratch,
            NativeStage::IdaGetDkyYp,
            NativeValue::Yp,
            requested_index,
        )?;

        let system = self.callback_state.as_ref().get_ref().system;
        system
            .outputs_into(&self.y_scratch, &mut self.output_scratch)
            .map_err(|source| IdaError::ResultEvaluation {
                requested_index,
                requested_time_s,
                source,
            })?;
        require_finite_slice(
            &self.output_scratch,
            NativeStage::IdaGetDkyY,
            NativeValue::Output,
            requested_index,
        )?;

        let width = self.outputs.len();
        let start = requested_index
            .checked_mul(width)
            .ok_or(IdaError::WorkOverflow)?;
        let end = start.checked_add(width).ok_or(IdaError::WorkOverflow)?;
        self.result_values[start..end].copy_from_slice(&self.output_scratch);
        Ok(())
    }

    /// Consume this initialized session and execute its validated requested
    /// output grid exactly once. IDA advances only through `IDA_ONE_STEP`;
    /// internal step endpoints are never exposed as result rows.
    pub fn solve_requested_grid(mut self) -> Result<IdaSolveResult, IdaError> {
        let baseline = self.counter_snapshot()?;
        if baseline.internal_steps != 0 {
            return Err(IdaError::StepCounterInvariant {
                before: 0,
                after: baseline.internal_steps,
                maximum: self.configured_max_steps,
            });
        }

        let mut completed_steps = baseline.internal_steps;
        let mut previous_time_s = self.read_real(
            crate::ffi::IDAGetCurrentTime,
            NativeStage::IdaGetCurrentTime,
            NativeValue::CurrentTime,
        )?;
        if previous_time_s != self.initial_time_s {
            return Err(IdaError::UnexpectedNativeTime {
                stage: NativeStage::IdaGetCurrentTime,
                expected: self.initial_time_s,
                actual: previous_time_s,
            });
        }

        let final_requested_time_s = *self
            .output_times_s
            .last()
            .expect("validated output grid is nonempty");
        let mut requested_index = 0usize;
        let mut maximum_order_used = 0u8;
        let mut one_step_calls = 0u64;
        let mut output_rows_at_step_limit = 0u64;

        while requested_index < self.output_times_s.len() {
            let queried_steps = self.read_counter(
                crate::ffi::IDAGetNumSteps,
                NativeStage::IdaGetNumSteps,
                NativeStatistic::InternalSteps,
            )?;
            if queried_steps != completed_steps || queried_steps > self.configured_max_steps {
                return Err(IdaError::StepCounterInvariant {
                    before: completed_steps,
                    after: queried_steps,
                    maximum: self.configured_max_steps,
                });
            }
            let queried_time_s = self.read_real(
                crate::ffi::IDAGetCurrentTime,
                NativeStage::IdaGetCurrentTime,
                NativeValue::CurrentTime,
            )?;
            if queried_time_s != previous_time_s {
                return Err(IdaError::UnexpectedNativeTime {
                    stage: NativeStage::IdaGetCurrentTime,
                    expected: previous_time_s,
                    actual: queried_time_s,
                });
            }

            if completed_steps == self.configured_max_steps {
                return Err(IdaError::GlobalStepLimit {
                    maximum: self.configured_max_steps,
                    consumed: completed_steps,
                    requested_time_s: self.output_times_s[requested_index],
                    current_internal_time_s: previous_time_s,
                    native_flag: None,
                });
            }
            let remaining = self.configured_max_steps - completed_steps;
            let remaining = c_long::try_from(remaining).map_err(|_| IdaError::WorkOverflow)?;
            record_registration(NativeStage::IdaSetMaxNumSteps);
            let flag = unsafe {
                crate::ffi::IDASetMaxNumSteps(self.resources.ida_memory_raw(), remaining)
            };
            self.require_registered_call(flag, NativeStage::IdaSetMaxNumSteps)?;

            let mut returned_time_s = f64::NAN;
            #[cfg(test)]
            let injected_flag = match self.solve_injection {
                SolveInjection::NativeFlag(flag) => Some(flag),
                _ => None,
            };
            #[cfg(not(test))]
            let injected_flag: Option<c_int> = None;
            let flag = if let Some(flag) = injected_flag {
                flag
            } else {
                unsafe {
                    crate::ffi::IDASolve(
                        self.resources.ida_memory_raw(),
                        final_requested_time_s,
                        &mut returned_time_s,
                        self.resources.y_raw(),
                        self.resources.yp_raw(),
                        IDA_ONE_STEP,
                    )
                }
            };
            if let Some(error) = self.first_callback_error() {
                return Err(error);
            }
            if flag != IDA_SUCCESS {
                if flag == IDA_TOO_MUCH_WORK {
                    let consumed = self.read_counter(
                        crate::ffi::IDAGetNumSteps,
                        NativeStage::IdaGetNumSteps,
                        NativeStatistic::InternalSteps,
                    )?;
                    let current_internal_time_s = self.read_real(
                        crate::ffi::IDAGetCurrentTime,
                        NativeStage::IdaGetCurrentTime,
                        NativeValue::CurrentTime,
                    )?;
                    return Err(IdaError::GlobalStepLimit {
                        maximum: self.configured_max_steps,
                        consumed,
                        requested_time_s: self.output_times_s[requested_index],
                        current_internal_time_s,
                        native_flag: Some(flag),
                    });
                }
                return Err(self.native_solve_failure(NativeStage::IdaSolveStep, flag));
            }
            one_step_calls = one_step_calls
                .checked_add(1)
                .ok_or(IdaError::WorkOverflow)?;

            require_finite_native(
                returned_time_s,
                NativeStage::IdaSolveStep,
                NativeValue::ReturnedTime,
                None,
                None,
            )?;
            let steps_after = self.read_counter(
                crate::ffi::IDAGetNumSteps,
                NativeStage::IdaGetNumSteps,
                NativeStatistic::InternalSteps,
            )?;
            let current_time_s = self.read_real(
                crate::ffi::IDAGetCurrentTime,
                NativeStage::IdaGetCurrentTime,
                NativeValue::CurrentTime,
            )?;
            if returned_time_s.to_bits() != current_time_s.to_bits() {
                return Err(IdaError::UnexpectedNativeTime {
                    stage: NativeStage::IdaSolveStep,
                    expected: current_time_s,
                    actual: returned_time_s,
                });
            }
            let last_step_s = self.read_real(
                crate::ffi::IDAGetLastStep,
                NativeStage::IdaGetLastStep,
                NativeValue::LastStep,
            )?;
            let last_order = self.read_order(
                crate::ffi::IDAGetLastOrder,
                NativeStage::IdaGetLastOrder,
                NativeStatistic::LastOrder,
            )?;
            maximum_order_used = maximum_order_used.max(last_order);

            let computed_interval_start_s = current_time_s - last_step_s;
            require_finite_native(
                computed_interval_start_s,
                NativeStage::IdaGetLastStep,
                NativeValue::InterpolationIntervalStart,
                None,
                None,
            )?;
            let interval_tolerance = INTERVAL_ROUNDOFF_MULTIPLIER
                * f64::EPSILON
                * (1.0 + previous_time_s.abs() + current_time_s.abs());
            if steps_after != completed_steps + 1
                || steps_after > self.configured_max_steps
                || current_time_s <= previous_time_s
                || last_step_s <= 0.0
                || (computed_interval_start_s - previous_time_s).abs() > interval_tolerance
            {
                return Err(IdaError::InvalidNativeProgress {
                    steps_before: completed_steps,
                    steps_after,
                    previous_time_s,
                    current_time_s,
                    last_step_s,
                    computed_interval_start_s,
                });
            }

            while requested_index < self.output_times_s.len()
                && self.output_times_s[requested_index] <= current_time_s
            {
                self.interpolate_requested_row(requested_index, previous_time_s, current_time_s)?;
                if steps_after == self.configured_max_steps {
                    output_rows_at_step_limit = output_rows_at_step_limit
                        .checked_add(1)
                        .ok_or(IdaError::WorkOverflow)?;
                }
                requested_index += 1;
            }

            completed_steps = steps_after;
            previous_time_s = current_time_s;
        }

        let final_snapshot = self.counter_snapshot()?;
        let delta = final_snapshot.checked_delta(baseline)?;
        if delta.internal_steps != one_step_calls
            || final_snapshot.internal_steps > self.configured_max_steps
        {
            return Err(IdaError::StepCounterInvariant {
                before: one_step_calls,
                after: delta.internal_steps,
                maximum: self.configured_max_steps,
            });
        }
        let last_order = self.read_order(
            crate::ffi::IDAGetLastOrder,
            NativeStage::IdaGetLastOrder,
            NativeStatistic::LastOrder,
        )?;
        let current_order = self.read_order(
            crate::ffi::IDAGetCurrentOrder,
            NativeStage::IdaGetCurrentOrder,
            NativeStatistic::CurrentOrder,
        )?;
        let actual_initial_step_s = self.read_real(
            crate::ffi::IDAGetActualInitStep,
            NativeStage::IdaGetActualInitStep,
            NativeValue::ActualInitialStep,
        )?;
        let last_step_s = self.read_real(
            crate::ffi::IDAGetLastStep,
            NativeStage::IdaGetLastStep,
            NativeValue::LastStep,
        )?;
        let current_step_s = self.read_real(
            crate::ffi::IDAGetCurrentStep,
            NativeStage::IdaGetCurrentStep,
            NativeValue::CurrentStep,
        )?;
        let current_internal_time_s = self.read_real(
            crate::ffi::IDAGetCurrentTime,
            NativeStage::IdaGetCurrentTime,
            NativeValue::CurrentTime,
        )?;
        let last_linear_solver_flag = self.read_last_linear_solver_flag()?;
        for (stage, field, value) in [
            (
                NativeStage::IdaGetActualInitStep,
                NativeValue::ActualInitialStep,
                actual_initial_step_s,
            ),
            (
                NativeStage::IdaGetLastStep,
                NativeValue::LastStep,
                last_step_s,
            ),
            (
                NativeStage::IdaGetCurrentStep,
                NativeValue::CurrentStep,
                current_step_s,
            ),
        ] {
            if value <= 0.0 {
                return Err(IdaError::InvalidNativeValue {
                    stage,
                    field,
                    requested_index: None,
                    component_index: None,
                    value,
                });
            }
        }
        if current_internal_time_s != previous_time_s {
            return Err(IdaError::UnexpectedNativeTime {
                stage: NativeStage::IdaGetCurrentTime,
                expected: previous_time_s,
                actual: current_internal_time_s,
            });
        }

        let output_times_s = std::mem::take(&mut self.output_times_s);
        let outputs = std::mem::take(&mut self.outputs);
        let values_time_major = std::mem::take(&mut self.result_values);
        let residual_contract = self
            .callback_state
            .as_ref()
            .get_ref()
            .system
            .contract_version();
        Ok(IdaSolveResult {
            result_contract: self.result_contract,
            backend_identity: self.backend_identity,
            residual_contract,
            configured_max_order: self.configured_max_order,
            configured_max_steps: self.configured_max_steps,
            output_times_s,
            outputs,
            values_time_major,
            stats: IdaSolverStats {
                internal_steps: delta.internal_steps,
                residual_evaluations: delta.residual_evaluations,
                linear_solver_setups: delta.linear_solver_setups,
                error_test_failures: delta.error_test_failures,
                nonlinear_iterations: delta.nonlinear_iterations,
                nonlinear_convergence_failures: delta.nonlinear_convergence_failures,
                jacobian_evaluations: delta.jacobian_evaluations,
                linear_residual_evaluations: delta.linear_residual_evaluations,
                linear_iterations: delta.linear_iterations,
                linear_convergence_failures: delta.linear_convergence_failures,
                last_order,
                current_order,
                maximum_order_used,
                actual_initial_step_s,
                last_step_s,
                current_step_s,
                current_internal_time_s,
                one_step_calls,
                interpolated_output_rows: u64::try_from(requested_index)
                    .map_err(|_| IdaError::WorkOverflow)?,
                output_rows_at_step_limit,
                last_linear_solver_flag,
            },
        })
    }

    #[cfg(test)]
    fn initial_y_values(&self) -> Result<Vec<f64>, IdaError> {
        self.resources._y.values(NativeStage::InitialYWrite)
    }

    #[cfg(test)]
    fn initial_yp_values(&self) -> Result<Vec<f64>, IdaError> {
        self.resources._yp.values(NativeStage::InitialYpWrite)
    }

    #[cfg(test)]
    fn id_values(&self) -> Result<Vec<f64>, IdaError> {
        self.resources._id.values(NativeStage::IdVectorWrite)
    }

    #[cfg(test)]
    fn absolute_tolerance_values(&self) -> Result<Vec<f64>, IdaError> {
        self.resources
            ._absolute_tolerance
            .values(NativeStage::AbsoluteToleranceVectorWrite)
    }

    #[cfg(test)]
    fn callback_address(&self) -> *mut c_void {
        let state = self.callback_state.as_ref().get_ref();
        (state as *const CallbackState<'system, 'graph>)
            .cast_mut()
            .cast()
    }

    #[cfg(test)]
    fn native_user_data(&self) -> Result<*mut c_void, IdaError> {
        let mut user_data = ptr::null_mut();
        let flag =
            unsafe { crate::ffi::IDAGetUserData(self.resources.ida_memory_raw(), &mut user_data) };
        self.require_registered_call(flag, NativeStage::IdaGetUserData)?;
        Ok(user_data)
    }

    #[cfg(test)]
    fn inject_solve_callback_panic(&mut self, callback: CallbackKind) {
        let state = unsafe { self.callback_state.as_mut().get_unchecked_mut() };
        state.inject_panic(callback);
    }

    #[cfg(test)]
    fn inject_nonfinite_y(&mut self, requested_index: usize) {
        self.solve_injection = SolveInjection::NonFiniteY { requested_index };
    }

    #[cfg(test)]
    fn inject_nonfinite_yp(&mut self, requested_index: usize) {
        self.solve_injection = SolveInjection::NonFiniteYp { requested_index };
    }

    #[cfg(test)]
    fn inject_native_solve_flag(&mut self, flag: c_int) {
        self.solve_injection = SolveInjection::NativeFlag(flag);
    }

    #[cfg(all(test, feature = "sundials-ida-klu"))]
    fn inject_last_linear_flag_getter(&mut self, getter_flag: c_int, value: c_long) {
        self.last_linear_flag_injection = Some((getter_flag, value));
    }
}

pub(crate) fn initialize_session<'context, 'system, 'graph>(
    context: &'context SunContext,
    system: &'system DaeResidualSystem<'graph>,
    settings: &IdaSettings,
) -> Result<IdaSession<'context, 'system, 'graph>, IdaError> {
    initialize_session_with_callback_panic(context, system, settings, None)
}

#[derive(Clone, Copy)]
enum SessionBackend {
    Dense,
    #[cfg(feature = "sundials-ida-klu")]
    Klu {
        maximum_jacobian_evaluations: u64,
        maximum_jacobian_entry_work: u64,
    },
}

fn initialize_session_with_callback_panic<'context, 'system, 'graph>(
    context: &'context SunContext,
    system: &'system DaeResidualSystem<'graph>,
    settings: &IdaSettings,
    _panic_callback: Option<CallbackKind>,
) -> Result<IdaSession<'context, 'system, 'graph>, IdaError> {
    // This is the admission boundary. No request-specific SUNDIALS object is
    // created until dimensions, tolerances, work, times, ICs, and events have
    // all passed the pure-Rust contract validation.
    settings.validate_for(system)?;
    let settings_view = IdaSessionSettings::from(settings);
    initialize_session_common(
        context,
        system,
        settings_view,
        SessionBackend::Dense,
        _panic_callback,
    )
}

#[cfg(feature = "sundials-ida-klu")]
pub(crate) fn initialize_klu_session<'context, 'system, 'graph>(
    context: &'context SunContext,
    system: &'system DaeResidualSystem<'graph>,
    settings: &IdaKluSettings,
) -> Result<IdaSession<'context, 'system, 'graph>, IdaError> {
    // The full sparse admission contract is pure Rust and precedes all
    // request-specific SUNDIALS and KLU allocation.
    settings.validate_for(system)?;
    initialize_session_common(
        context,
        system,
        IdaSessionSettings::from(settings),
        SessionBackend::Klu {
            maximum_jacobian_evaluations: settings.max_jacobian_evaluations,
            maximum_jacobian_entry_work: settings.max_jacobian_entry_work,
        },
        None,
    )
}

fn initialize_session_common<'context, 'system, 'graph>(
    context: &'context SunContext,
    system: &'system DaeResidualSystem<'graph>,
    settings_view: IdaSessionSettings<'_>,
    backend: SessionBackend,
    _panic_callback: Option<CallbackKind>,
) -> Result<IdaSession<'context, 'system, 'graph>, IdaError> {
    let output_times_s = try_clone_f64(settings_view.output_times_s, "requested output times")?;
    let outputs = try_clone_outputs(system.outputs())?;
    let result_length = output_times_s
        .len()
        .checked_mul(outputs.len())
        .ok_or(IdaError::WorkOverflow)?;
    let result_values = try_zeroed_f64(result_length, "result values")?;
    let y_scratch = try_zeroed_f64(system.variables().len(), "result y scratch")?;
    let yp_scratch = try_zeroed_f64(system.variables().len(), "result yp scratch")?;
    let output_scratch = try_zeroed_f64(outputs.len(), "result output scratch")?;

    let (initial_y, initial_yp) = match settings_view.initial_conditions {
        IdaInitialConditionPolicy::ContractConsistent => (system.initial_y(), system.initial_yp()),
        IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative { y, yp } => {
            (y.as_slice(), yp.as_slice())
        }
    };

    let callback_state = match backend {
        SessionBackend::Dense => CallbackState::new(system)?,
        #[cfg(feature = "sundials-ida-klu")]
        SessionBackend::Klu {
            maximum_jacobian_evaluations,
            maximum_jacobian_entry_work,
        } => CallbackState::new_sparse(
            system,
            maximum_jacobian_evaluations,
            maximum_jacobian_entry_work,
        )?,
    };
    #[cfg(test)]
    let callback_state = {
        let mut callback_state = callback_state;
        if let Some(callback) = _panic_callback {
            callback_state.inject_panic(callback);
        }
        callback_state
    };
    let callback_state = Box::pin(callback_state);

    let resources = match backend {
        SessionBackend::Dense => prepare_resources(context, system.variables().len())?,
        #[cfg(feature = "sundials-ida-klu")]
        SessionBackend::Klu { .. } => prepare_sparse_resources(
            context,
            system.variables().len(),
            system.csc_pattern().column_pointers(),
            system.csc_pattern().row_indices(),
        )?,
    };
    resources._y.copy_from_slice(
        initial_y,
        "initial_conditions.y",
        NativeStage::InitialYWrite,
    )?;
    resources._yp.copy_from_slice(
        initial_yp,
        "initial_conditions.yp",
        NativeStage::InitialYpWrite,
    )?;
    resources._id.copy_from_slice(
        system.id_vector(),
        "system.id_vector",
        NativeStage::IdVectorWrite,
    )?;
    match settings_view.absolute_tolerance {
        IdaAbsoluteTolerance::Scalar(value) => resources
            ._absolute_tolerance
            .fill(*value, NativeStage::AbsoluteToleranceVectorWrite)?,
        IdaAbsoluteTolerance::Vector(values) => resources._absolute_tolerance.copy_from_slice(
            values,
            "absolute_tolerance",
            NativeStage::AbsoluteToleranceVectorWrite,
        )?,
    }

    let mut session = IdaSession {
        resources,
        callback_state,
        initial_time_s: settings_view.initial_time_s,
        corrected_initial_conditions: false,
        configured_max_order: settings_view.max_order,
        configured_max_steps: settings_view.max_steps,
        result_contract: match backend {
            SessionBackend::Dense => NATIVE_IDA_RESULT_CONTRACT,
            #[cfg(feature = "sundials-ida-klu")]
            SessionBackend::Klu { .. } => NATIVE_IDA_KLU_RESULT_CONTRACT,
        },
        backend_identity: match backend {
            SessionBackend::Dense => PINNED_BACKEND_IDENTITY,
            #[cfg(feature = "sundials-ida-klu")]
            SessionBackend::Klu { .. } => PINNED_KLU_BACKEND_IDENTITY,
        },
        output_times_s,
        outputs,
        result_values,
        y_scratch,
        yp_scratch,
        output_scratch,
        #[cfg(test)]
        solve_injection: SolveInjection::None,
        #[cfg(test)]
        last_linear_flag_injection: None,
    };
    // If any registration step fails, dropping this aggregate preserves the
    // field-order invariant: IDA memory is freed before its pinned user data.
    session.register(&settings_view)?;
    Ok(session)
}

#[allow(dead_code)]
enum CallbackExecution {
    Success,
    Failed,
}

#[allow(dead_code)]
fn invoke_callback(
    user_data: *mut c_void,
    callback: CallbackKind,
    action: impl FnOnce(&mut CallbackState<'static, 'static>) -> Result<(), IdaError>,
) -> c_int {
    if user_data.is_null() {
        return CALLBACK_UNRECOVERABLE;
    }

    // Lifetimes are erased only for the duration of this synchronous call.
    // The caller owns a valid CallbackState and guarantees it outlives C's use
    // of user_data. The thread-bound backend forbids concurrent cross-thread
    // access to the same state.
    let state_pointer = user_data.cast::<CallbackState<'static, 'static>>();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let state = unsafe { &mut *state_pointer };
        if state.first_error.is_some() {
            return CallbackExecution::Failed;
        }
        state.panic_if_injected(callback);
        match action(state) {
            Ok(()) => CallbackExecution::Success,
            Err(error) => {
                state.latch(error);
                CallbackExecution::Failed
            }
        }
    }));

    match outcome {
        Ok(CallbackExecution::Success) => CALLBACK_SUCCESS,
        Ok(CallbackExecution::Failed) => CALLBACK_UNRECOVERABLE,
        Err(_) => {
            // Latching is separately contained so even an unexpected panic in
            // error bookkeeping cannot unwind into C.
            let _ = catch_unwind(AssertUnwindSafe(|| {
                let state = unsafe { &mut *state_pointer };
                state.latch(IdaError::CallbackPanic { callback });
            }));
            CALLBACK_UNRECOVERABLE
        }
    }
}

#[allow(dead_code)]
pub(crate) unsafe extern "C" fn residual_callback(
    time: f64,
    y: crate::ffi::NVector,
    yp: crate::ffi::NVector,
    residual: crate::ffi::NVector,
    user_data: *mut c_void,
) -> c_int {
    invoke_callback(user_data, CallbackKind::Residual, |state| {
        let dimension = state.system.variables().len();
        // Validate every raw view and all mutable alias boundaries before
        // constructing any Rust references.
        let y_data =
            unsafe { checked_vector_data(y, dimension, CallbackKind::Residual, NativeView::Y)? };
        let yp_data =
            unsafe { checked_vector_data(yp, dimension, CallbackKind::Residual, NativeView::Yp)? };
        let residual_data = unsafe {
            checked_vector_data(
                residual,
                dimension,
                CallbackKind::Residual,
                NativeView::Residual,
            )?
        };
        require_disjoint_mutable(
            residual_data,
            dimension,
            NativeView::Residual,
            y_data,
            dimension,
            NativeView::Y,
            CallbackKind::Residual,
            dimension,
        )?;
        require_disjoint_mutable(
            residual_data,
            dimension,
            NativeView::Residual,
            yp_data,
            dimension,
            NativeView::Yp,
            CallbackKind::Residual,
            dimension,
        )?;
        let y = unsafe { slice::from_raw_parts(y_data, dimension) };
        let yp = unsafe { slice::from_raw_parts(yp_data, dimension) };
        let residual = unsafe { slice::from_raw_parts_mut(residual_data, dimension) };
        state
            .system
            .residual_into(time, y, yp, residual)
            .map_err(|source| IdaError::Callback {
                callback: CallbackKind::Residual,
                source,
            })
    })
}

#[allow(dead_code)]
pub(crate) unsafe extern "C" fn jacobian_callback(
    time: f64,
    cj: f64,
    y: crate::ffi::NVector,
    yp: crate::ffi::NVector,
    residual: crate::ffi::NVector,
    jacobian: crate::ffi::SUNMatrix,
    user_data: *mut c_void,
    _temporary_1: crate::ffi::NVector,
    _temporary_2: crate::ffi::NVector,
    _temporary_3: crate::ffi::NVector,
) -> c_int {
    invoke_callback(user_data, CallbackKind::Jacobian, |state| {
        let dimension = state.system.variables().len();
        let y_data =
            unsafe { checked_vector_data(y, dimension, CallbackKind::Jacobian, NativeView::Y)? };
        let yp_data =
            unsafe { checked_vector_data(yp, dimension, CallbackKind::Jacobian, NativeView::Yp)? };
        let residual_data = unsafe {
            checked_vector_data(
                residual,
                dimension,
                CallbackKind::Jacobian,
                NativeView::Residual,
            )?
        };
        let (dense_data, dense_length) = unsafe { checked_dense_matrix_data(jacobian, dimension)? };
        for (other_data, other_view) in [
            (y_data, NativeView::Y),
            (yp_data, NativeView::Yp),
            (residual_data, NativeView::Residual),
        ] {
            require_disjoint_mutable(
                dense_data,
                dense_length,
                NativeView::DenseJacobian,
                other_data,
                dimension,
                other_view,
                CallbackKind::Jacobian,
                dimension,
            )?;
        }
        let y = unsafe { slice::from_raw_parts(y_data, dimension) };
        let yp = unsafe { slice::from_raw_parts(yp_data, dimension) };
        let _residual = unsafe { slice::from_raw_parts(residual_data, dimension) };
        let dense = unsafe { slice::from_raw_parts_mut(dense_data, dense_length) };

        state
            .system
            .jacobian_values_into(time, cj, y, yp, &mut state.jacobian_values)
            .map_err(|source| IdaError::Callback {
                callback: CallbackKind::Jacobian,
                source,
            })?;

        dense.fill(0.0);
        let pattern = state.system.csc_pattern();
        let mut value_index = 0;
        for column in 0..dimension {
            for pattern_index in
                pattern.column_pointers()[column]..pattern.column_pointers()[column + 1]
            {
                let row = pattern.row_indices()[pattern_index];
                dense[column * dimension + row] = state.jacobian_values[value_index];
                value_index += 1;
            }
        }
        debug_assert_eq!(value_index, state.jacobian_values.len());
        Ok(())
    })
}

#[cfg(feature = "sundials-ida-klu")]
#[allow(dead_code)]
pub(crate) unsafe extern "C" fn sparse_jacobian_callback(
    time: f64,
    cj: f64,
    y: crate::ffi::NVector,
    yp: crate::ffi::NVector,
    residual: crate::ffi::NVector,
    jacobian: crate::ffi::SUNMatrix,
    user_data: *mut c_void,
    _temporary_1: crate::ffi::NVector,
    _temporary_2: crate::ffi::NVector,
    _temporary_3: crate::ffi::NVector,
) -> c_int {
    invoke_callback(user_data, CallbackKind::Jacobian, |state| {
        let dimension = state.system.variables().len();
        let nonzeros = state.system.csc_pattern().nonzero_count();
        // Validate every shape, pointer, byte range, and alias boundary before
        // constructing a single Rust slice from native storage.
        let y_data =
            unsafe { checked_vector_data(y, dimension, CallbackKind::Jacobian, NativeView::Y)? };
        let yp_data =
            unsafe { checked_vector_data(yp, dimension, CallbackKind::Jacobian, NativeView::Yp)? };
        let residual_data = unsafe {
            checked_vector_data(
                residual,
                dimension,
                CallbackKind::Jacobian,
                NativeView::Residual,
            )?
        };
        let sparse = unsafe { checked_sparse_matrix_data(jacobian, dimension, nonzeros)? };

        for (matrix_data, matrix_length, matrix_view) in [
            (
                sparse.data.cast::<u8>(),
                nonzeros
                    .checked_mul(std::mem::size_of::<f64>())
                    .ok_or(IdaError::WorkOverflow)?,
                NativeView::SparseJacobianData,
            ),
            (
                sparse.row_indices.cast::<u8>(),
                nonzeros
                    .checked_mul(std::mem::size_of::<crate::ffi::SunIndex>())
                    .ok_or(IdaError::WorkOverflow)?,
                NativeView::SparseJacobianRowIndices,
            ),
            (
                sparse.column_pointers.cast::<u8>(),
                dimension
                    .checked_add(1)
                    .and_then(|length| {
                        length.checked_mul(std::mem::size_of::<crate::ffi::SunIndex>())
                    })
                    .ok_or(IdaError::WorkOverflow)?,
                NativeView::SparseJacobianColumnPointers,
            ),
        ] {
            for (other_data, other_length, other_view) in [
                (
                    y_data.cast::<u8>(),
                    dimension * std::mem::size_of::<f64>(),
                    NativeView::Y,
                ),
                (
                    yp_data.cast::<u8>(),
                    dimension * std::mem::size_of::<f64>(),
                    NativeView::Yp,
                ),
                (
                    residual_data.cast::<u8>(),
                    dimension * std::mem::size_of::<f64>(),
                    NativeView::Residual,
                ),
            ] {
                require_disjoint_bytes(
                    matrix_data,
                    matrix_length,
                    matrix_view,
                    other_data,
                    other_length,
                    other_view,
                    CallbackKind::Jacobian,
                    dimension,
                )?;
            }
        }
        for (left_data, left_length, left_view, right_data, right_length, right_view) in [
            (
                sparse.data.cast::<u8>(),
                nonzeros * std::mem::size_of::<f64>(),
                NativeView::SparseJacobianData,
                sparse.row_indices.cast::<u8>(),
                nonzeros * std::mem::size_of::<crate::ffi::SunIndex>(),
                NativeView::SparseJacobianRowIndices,
            ),
            (
                sparse.data.cast::<u8>(),
                nonzeros * std::mem::size_of::<f64>(),
                NativeView::SparseJacobianData,
                sparse.column_pointers.cast::<u8>(),
                (dimension + 1) * std::mem::size_of::<crate::ffi::SunIndex>(),
                NativeView::SparseJacobianColumnPointers,
            ),
            (
                sparse.row_indices.cast::<u8>(),
                nonzeros * std::mem::size_of::<crate::ffi::SunIndex>(),
                NativeView::SparseJacobianRowIndices,
                sparse.column_pointers.cast::<u8>(),
                (dimension + 1) * std::mem::size_of::<crate::ffi::SunIndex>(),
                NativeView::SparseJacobianColumnPointers,
            ),
        ] {
            require_disjoint_bytes(
                left_data,
                left_length,
                left_view,
                right_data,
                right_length,
                right_view,
                CallbackKind::Jacobian,
                dimension,
            )?;
        }

        let y = unsafe { slice::from_raw_parts(y_data, dimension) };
        let yp = unsafe { slice::from_raw_parts(yp_data, dimension) };
        let _residual = unsafe { slice::from_raw_parts(residual_data, dimension) };
        let data = unsafe { slice::from_raw_parts_mut(sparse.data, nonzeros) };
        let row_indices = unsafe { slice::from_raw_parts_mut(sparse.row_indices, nonzeros) };
        let column_pointers =
            unsafe { slice::from_raw_parts_mut(sparse.column_pointers, dimension + 1) };

        state.begin_sparse_jacobian()?;
        let pattern = state.system.csc_pattern();
        for (destination, &source) in column_pointers.iter_mut().zip(pattern.column_pointers()) {
            *destination =
                crate::ffi::SunIndex::try_from(source).map_err(|_| IdaError::WorkOverflow)?;
        }
        for (destination, &source) in row_indices.iter_mut().zip(pattern.row_indices()) {
            *destination =
                crate::ffi::SunIndex::try_from(source).map_err(|_| IdaError::WorkOverflow)?;
        }
        state
            .system
            .jacobian_values_into(time, cj, y, yp, &mut state.jacobian_values)
            .map_err(|source| IdaError::Callback {
                callback: CallbackKind::Jacobian,
                source,
            })?;
        data.copy_from_slice(&state.jacobian_values);
        Ok(())
    })
}

const _: crate::ffi::IdaResidualFn = residual_callback;
const _: crate::ffi::IdaJacobianFn = jacobian_callback;
#[cfg(feature = "sundials-ida-klu")]
const _: crate::ffi::IdaJacobianFn = sparse_jacobian_callback;

#[cfg(feature = "sundials-ida-klu")]
struct SparseMatrixData {
    data: *mut f64,
    row_indices: *mut crate::ffi::SunIndex,
    column_pointers: *mut crate::ffi::SunIndex,
}

#[cfg(feature = "sundials-ida-klu")]
unsafe fn checked_sparse_matrix_data(
    matrix: crate::ffi::SUNMatrix,
    expected_dimension: usize,
    expected_nonzeros: usize,
) -> Result<SparseMatrixData, IdaError> {
    if matrix.is_null() {
        return Err(invalid_view(
            CallbackKind::Jacobian,
            NativeView::SparseJacobianData,
            expected_dimension,
            NativeViewActual::Null,
        ));
    }
    let matrix_type = unsafe { crate::ffi::SUNMatGetID(matrix) };
    if matrix_type != SUNMATRIX_SPARSE_ID {
        return Err(invalid_view(
            CallbackKind::Jacobian,
            NativeView::SparseJacobianData,
            expected_dimension,
            NativeViewActual::MatrixType(matrix_type),
        ));
    }
    let rows = unsafe { crate::ffi::SUNSparseMatrix_Rows(matrix) };
    let columns = unsafe { crate::ffi::SUNSparseMatrix_Columns(matrix) };
    let nonzeros = unsafe { crate::ffi::SUNSparseMatrix_NNZ(matrix) };
    let index_pointers = unsafe { crate::ffi::SUNSparseMatrix_NP(matrix) };
    let sparse_type = unsafe { crate::ffi::SUNSparseMatrix_SparseType(matrix) };
    if usize::try_from(rows).ok() != Some(expected_dimension)
        || usize::try_from(columns).ok() != Some(expected_dimension)
        || usize::try_from(nonzeros).ok() != Some(expected_nonzeros)
        || usize::try_from(index_pointers).ok() != Some(expected_dimension)
        || sparse_type != SUN_CSC_MATRIX
    {
        return Err(invalid_view(
            CallbackKind::Jacobian,
            NativeView::SparseJacobianData,
            expected_dimension,
            NativeViewActual::SparseMatrix {
                rows,
                columns,
                nonzeros,
                index_pointers,
                sparse_type,
            },
        ));
    }
    let data = unsafe { crate::ffi::SUNSparseMatrix_Data(matrix) };
    let row_indices = unsafe { crate::ffi::SUNSparseMatrix_IndexValues(matrix) };
    let column_pointers = unsafe { crate::ffi::SUNSparseMatrix_IndexPointers(matrix) };
    for (is_null, view) in [
        (data.is_null(), NativeView::SparseJacobianData),
        (row_indices.is_null(), NativeView::SparseJacobianRowIndices),
        (
            column_pointers.is_null(),
            NativeView::SparseJacobianColumnPointers,
        ),
    ] {
        if !is_null {
            continue;
        }
        return Err(invalid_view(
            CallbackKind::Jacobian,
            view,
            expected_dimension,
            NativeViewActual::Null,
        ));
    }
    Ok(SparseMatrixData {
        data,
        row_indices,
        column_pointers,
    })
}

#[allow(dead_code)]
unsafe fn checked_vector_data(
    vector: crate::ffi::NVector,
    expected: usize,
    callback: CallbackKind,
    view: NativeView,
) -> Result<*mut f64, IdaError> {
    if vector.is_null() {
        return Err(invalid_view(
            callback,
            view,
            expected,
            NativeViewActual::Null,
        ));
    }
    let actual = unsafe { crate::ffi::N_VGetLength_Serial(vector) };
    if actual < 0 || usize::try_from(actual).ok() != Some(expected) {
        return Err(invalid_view(
            callback,
            view,
            expected,
            NativeViewActual::VectorLength(actual),
        ));
    }
    let data = unsafe { crate::ffi::N_VGetArrayPointer(vector) };
    if data.is_null() {
        return Err(invalid_view(
            callback,
            view,
            expected,
            NativeViewActual::Null,
        ));
    }
    Ok(data)
}

#[allow(dead_code)]
unsafe fn checked_dense_matrix_data(
    matrix: crate::ffi::SUNMatrix,
    expected: usize,
) -> Result<(*mut f64, usize), IdaError> {
    if matrix.is_null() {
        return Err(invalid_view(
            CallbackKind::Jacobian,
            NativeView::DenseJacobian,
            expected,
            NativeViewActual::Null,
        ));
    }
    let rows = unsafe { crate::ffi::SUNDenseMatrix_Rows(matrix) };
    let columns = unsafe { crate::ffi::SUNDenseMatrix_Columns(matrix) };
    if rows < 0
        || columns < 0
        || usize::try_from(rows).ok() != Some(expected)
        || usize::try_from(columns).ok() != Some(expected)
    {
        return Err(invalid_view(
            CallbackKind::Jacobian,
            NativeView::DenseJacobian,
            expected,
            NativeViewActual::MatrixDimensions { rows, columns },
        ));
    }
    let length = expected
        .checked_mul(expected)
        .ok_or(IdaError::WorkOverflow)?;
    let data = unsafe { crate::ffi::SUNDenseMatrix_Data(matrix) };
    if data.is_null() {
        return Err(invalid_view(
            CallbackKind::Jacobian,
            NativeView::DenseJacobian,
            expected,
            NativeViewActual::Null,
        ));
    }
    Ok((data, length))
}

#[allow(dead_code)]
fn require_disjoint_mutable(
    mutable_data: *mut f64,
    mutable_length: usize,
    mutable_view: NativeView,
    other_data: *mut f64,
    other_length: usize,
    other_view: NativeView,
    callback: CallbackKind,
    expected_dimension: usize,
) -> Result<(), IdaError> {
    let mutable_bytes = mutable_length
        .checked_mul(std::mem::size_of::<f64>())
        .ok_or(IdaError::WorkOverflow)?;
    let other_bytes = other_length
        .checked_mul(std::mem::size_of::<f64>())
        .ok_or(IdaError::WorkOverflow)?;
    require_disjoint_bytes(
        mutable_data.cast(),
        mutable_bytes,
        mutable_view,
        other_data.cast(),
        other_bytes,
        other_view,
        callback,
        expected_dimension,
    )
}

fn require_disjoint_bytes(
    mutable_data: *mut u8,
    mutable_bytes: usize,
    mutable_view: NativeView,
    other_data: *mut u8,
    other_bytes: usize,
    other_view: NativeView,
    callback: CallbackKind,
    expected_dimension: usize,
) -> Result<(), IdaError> {
    let mutable_range = address_range(mutable_data, mutable_bytes).ok_or_else(|| {
        invalid_view(
            callback,
            mutable_view,
            expected_dimension,
            NativeViewActual::AddressOverflow,
        )
    })?;
    let other_range = address_range(other_data, other_bytes).ok_or_else(|| {
        invalid_view(
            callback,
            other_view,
            expected_dimension,
            NativeViewActual::AddressOverflow,
        )
    })?;
    if mutable_range.0 < other_range.1 && other_range.0 < mutable_range.1 {
        return Err(invalid_view(
            callback,
            mutable_view,
            expected_dimension,
            NativeViewActual::Aliases { with: other_view },
        ));
    }
    Ok(())
}

fn address_range(data: *mut u8, bytes: usize) -> Option<(usize, usize)> {
    let start = data as usize;
    let end = start.checked_add(bytes)?;
    Some((start, end))
}

fn require_finite_native(
    value: f64,
    stage: NativeStage,
    field: NativeValue,
    requested_index: Option<usize>,
    component_index: Option<usize>,
) -> Result<(), IdaError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(IdaError::InvalidNativeValue {
            stage,
            field,
            requested_index,
            component_index,
            value,
        })
    }
}

fn checked_native_counter(
    value: c_long,
    stage: NativeStage,
    statistic: NativeStatistic,
) -> Result<u64, IdaError> {
    u64::try_from(value).map_err(|_| IdaError::InvalidNativeStatistic {
        stage,
        statistic,
        value: value as i64,
    })
}

fn require_finite_slice(
    values: &[f64],
    stage: NativeStage,
    field: NativeValue,
    requested_index: usize,
) -> Result<(), IdaError> {
    for (index, value) in values.iter().copied().enumerate() {
        require_finite_native(value, stage, field, Some(requested_index), Some(index))?;
    }
    Ok(())
}

fn require_interpolation_bounds(
    requested_time_s: f64,
    previous_time_s: f64,
    current_time_s: f64,
) -> Result<(), IdaError> {
    if requested_time_s <= previous_time_s || requested_time_s > current_time_s {
        Err(IdaError::InterpolationIntervalMiss {
            requested_time_s,
            interval_start_s: previous_time_s,
            interval_end_s: current_time_s,
        })
    } else {
        Ok(())
    }
}

#[allow(dead_code)]
fn invalid_view(
    callback: CallbackKind,
    view: NativeView,
    expected: usize,
    actual: NativeViewActual,
) -> IdaError {
    IdaError::InvalidNativeView {
        callback,
        view,
        expected,
        actual,
    }
}

#[cfg(test)]
mod allocation_audit {
    use crate::NativeStage;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum ResourceKind {
        Vector,
        Matrix,
        LinearSolver,
        IdaMemory,
        CallbackState,
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub(super) struct Snapshot {
        pub vectors_allocated: usize,
        pub vectors_freed: usize,
        pub matrices_allocated: usize,
        pub matrices_freed: usize,
        pub linear_solvers_allocated: usize,
        pub linear_solvers_freed: usize,
        pub ida_memories_allocated: usize,
        pub ida_memories_freed: usize,
        pub callback_states_allocated: usize,
        pub callback_states_freed: usize,
    }

    static VECTORS_ALLOCATED: AtomicUsize = AtomicUsize::new(0);
    static VECTORS_FREED: AtomicUsize = AtomicUsize::new(0);
    static MATRICES_ALLOCATED: AtomicUsize = AtomicUsize::new(0);
    static MATRICES_FREED: AtomicUsize = AtomicUsize::new(0);
    static LINEAR_SOLVERS_ALLOCATED: AtomicUsize = AtomicUsize::new(0);
    static LINEAR_SOLVERS_FREED: AtomicUsize = AtomicUsize::new(0);
    static IDA_MEMORIES_ALLOCATED: AtomicUsize = AtomicUsize::new(0);
    static IDA_MEMORIES_FREED: AtomicUsize = AtomicUsize::new(0);
    static CALLBACK_STATES_ALLOCATED: AtomicUsize = AtomicUsize::new(0);
    static CALLBACK_STATES_FREED: AtomicUsize = AtomicUsize::new(0);
    static DROP_EVENTS: std::sync::Mutex<Vec<ResourceKind>> = std::sync::Mutex::new(Vec::new());
    static REGISTRATION_EVENTS: std::sync::Mutex<Vec<NativeStage>> =
        std::sync::Mutex::new(Vec::new());

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    pub(super) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn record_allocation(kind: ResourceKind) {
        let counter = match kind {
            ResourceKind::Vector => &VECTORS_ALLOCATED,
            ResourceKind::Matrix => &MATRICES_ALLOCATED,
            ResourceKind::LinearSolver => &LINEAR_SOLVERS_ALLOCATED,
            ResourceKind::IdaMemory => &IDA_MEMORIES_ALLOCATED,
            ResourceKind::CallbackState => &CALLBACK_STATES_ALLOCATED,
        };
        counter.fetch_add(1, Ordering::SeqCst);
    }

    pub(super) fn record_free(kind: ResourceKind) {
        let counter = match kind {
            ResourceKind::Vector => &VECTORS_FREED,
            ResourceKind::Matrix => &MATRICES_FREED,
            ResourceKind::LinearSolver => &LINEAR_SOLVERS_FREED,
            ResourceKind::IdaMemory => &IDA_MEMORIES_FREED,
            ResourceKind::CallbackState => &CALLBACK_STATES_FREED,
        };
        counter.fetch_add(1, Ordering::SeqCst);
        DROP_EVENTS.lock().unwrap().push(kind);
    }

    pub(super) fn record_registration(stage: NativeStage) {
        REGISTRATION_EVENTS.lock().unwrap().push(stage);
    }

    pub(super) fn reset() {
        for counter in [
            &VECTORS_ALLOCATED,
            &VECTORS_FREED,
            &MATRICES_ALLOCATED,
            &MATRICES_FREED,
            &LINEAR_SOLVERS_ALLOCATED,
            &LINEAR_SOLVERS_FREED,
            &IDA_MEMORIES_ALLOCATED,
            &IDA_MEMORIES_FREED,
            &CALLBACK_STATES_ALLOCATED,
            &CALLBACK_STATES_FREED,
        ] {
            counter.store(0, Ordering::SeqCst);
        }
        DROP_EVENTS.lock().unwrap().clear();
        REGISTRATION_EVENTS.lock().unwrap().clear();
    }

    pub(super) fn snapshot() -> Snapshot {
        Snapshot {
            vectors_allocated: VECTORS_ALLOCATED.load(Ordering::SeqCst),
            vectors_freed: VECTORS_FREED.load(Ordering::SeqCst),
            matrices_allocated: MATRICES_ALLOCATED.load(Ordering::SeqCst),
            matrices_freed: MATRICES_FREED.load(Ordering::SeqCst),
            linear_solvers_allocated: LINEAR_SOLVERS_ALLOCATED.load(Ordering::SeqCst),
            linear_solvers_freed: LINEAR_SOLVERS_FREED.load(Ordering::SeqCst),
            ida_memories_allocated: IDA_MEMORIES_ALLOCATED.load(Ordering::SeqCst),
            ida_memories_freed: IDA_MEMORIES_FREED.load(Ordering::SeqCst),
            callback_states_allocated: CALLBACK_STATES_ALLOCATED.load(Ordering::SeqCst),
            callback_states_freed: CALLBACK_STATES_FREED.load(Ordering::SeqCst),
        }
    }

    pub(super) fn drop_events() -> Vec<ResourceKind> {
        DROP_EVENTS.lock().unwrap().clone()
    }

    pub(super) fn registration_events() -> Vec<NativeStage> {
        REGISTRATION_EVENTS.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        IdaAbsoluteTolerance, IdaDenseBackend, IdaError, IdaInitialConditionPolicy, IdaSettings,
        NativeStage, MAX_DENSE_DIMENSION, MAX_INTERNAL_STEPS,
    };
    #[cfg(feature = "sundials-ida-klu")]
    use crate::{
        IdaKluBackend, IdaKluSettings, IdaLinearFlagEvidence, MAX_KLU_DIMENSION,
        MAX_KLU_JACOBIAN_ENTRY_WORK, MAX_KLU_KNOWN_CSC_BYTES, MAX_KLU_NONZEROS,
        MAX_KLU_RESULT_VALUES,
    };
    use battery_design_core::dae::DaeError;
    use battery_design_core::equations::{
        Block, BlockKind, CompiledGraph, EquationGraph, Quantity, SolverSettings,
    };
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    struct ThreadTrackingAllocator;

    thread_local! {
        static TRACK_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
        static CALLBACK_ALLOCATION_COUNT: Cell<usize> = const { Cell::new(0) };
    }

    fn record_callback_allocation() {
        if TRACK_ALLOCATIONS
            .try_with(|tracking| tracking.get())
            .unwrap_or(false)
        {
            CALLBACK_ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
        }
    }

    unsafe impl GlobalAlloc for ThreadTrackingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record_callback_allocation();
            unsafe { System.alloc(layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            record_callback_allocation();
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) }
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            record_callback_allocation();
            unsafe { System.realloc(pointer, layout, size) }
        }
    }

    #[global_allocator]
    static CALLBACK_ALLOCATOR: ThreadTrackingAllocator = ThreadTrackingAllocator;

    fn count_callback_allocations(action: impl FnOnce()) -> usize {
        TRACK_ALLOCATIONS.with(|tracking| tracking.set(false));
        CALLBACK_ALLOCATION_COUNT.with(|count| count.set(0));
        TRACK_ALLOCATIONS.with(|tracking| tracking.set(true));
        action();
        TRACK_ALLOCATIONS.with(|tracking| tracking.set(false));
        CALLBACK_ALLOCATION_COUNT.with(Cell::get)
    }

    fn solver_settings() -> SolverSettings {
        SolverSettings {
            end_s: 0.0,
            ..SolverSettings::default()
        }
    }

    fn integrator_graph() -> CompiledGraph {
        let mut graph = EquationGraph::new();
        let source = graph
            .add_block(Block::new(
                "source",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 4.0 },
            ))
            .unwrap();
        let state = graph
            .add_block(Block::new(
                "state",
                Quantity::Dimensionless,
                BlockKind::Integrator {
                    initial: 2.0,
                    rate: Quantity::Dimensionless,
                    gain: 2.0,
                },
            ))
            .unwrap();
        let observed = graph
            .add_block(Block::new(
                "observed",
                Quantity::Dimensionless,
                BlockKind::Gain {
                    gain: 3.0,
                    input: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        graph.connect(source, state, 0).unwrap();
        graph.connect(state, observed, 0).unwrap();
        graph.compile().unwrap()
    }

    fn product_integrator_graph() -> CompiledGraph {
        let mut graph = EquationGraph::new();
        let left = graph
            .add_block(Block::new(
                "left",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 2.0 },
            ))
            .unwrap();
        let right = graph
            .add_block(Block::new(
                "right",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 3.0 },
            ))
            .unwrap();
        let product = graph
            .add_block(Block::new(
                "product",
                Quantity::Dimensionless,
                BlockKind::Product {
                    scale: 4.0,
                    left: Quantity::Dimensionless,
                    right: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        let state = graph
            .add_block(Block::new(
                "state",
                Quantity::Dimensionless,
                BlockKind::Integrator {
                    initial: 1.0,
                    rate: Quantity::Dimensionless,
                    gain: 2.0,
                },
            ))
            .unwrap();
        graph.connect(left, product, 0).unwrap();
        graph.connect(right, product, 1).unwrap();
        graph.connect(product, state, 0).unwrap();
        graph.compile().unwrap()
    }

    fn exponential_graph() -> CompiledGraph {
        let mut graph = EquationGraph::new();
        let target = graph
            .add_block(Block::new(
                "target",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 1.0 },
            ))
            .unwrap();
        let state = graph
            .add_block(Block::new(
                "exponential state",
                Quantity::Dimensionless,
                BlockKind::FirstOrder {
                    tau_s: 1.0,
                    initial: 0.0,
                },
            ))
            .unwrap();
        graph.connect(target, state, 0).unwrap();
        graph.compile().unwrap()
    }

    fn ida_settings() -> IdaSettings {
        IdaSettings {
            initial_time_s: 0.0,
            output_times_s: vec![0.25, 0.5],
            relative_tolerance: 1.0e-6,
            absolute_tolerance: IdaAbsoluteTolerance::Scalar(1.0e-9),
            max_order: 5,
            max_steps: 10_000,
            max_dense_dimension: MAX_DENSE_DIMENSION,
            suppress_algebraic_error: true,
            initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
        }
    }

    #[cfg(feature = "sundials-ida-klu")]
    fn klu_settings() -> IdaKluSettings {
        IdaKluSettings {
            initial_time_s: 0.0,
            output_times_s: vec![0.25],
            relative_tolerance: 1.0e-6,
            absolute_tolerance: IdaAbsoluteTolerance::Scalar(1.0e-9),
            max_order: 5,
            max_steps: 10_000,
            max_dimension: MAX_KLU_DIMENSION,
            max_nonzeros: MAX_KLU_NONZEROS,
            max_known_csc_bytes: MAX_KLU_KNOWN_CSC_BYTES,
            max_jacobian_evaluations: 10_000,
            max_jacobian_entry_work: MAX_KLU_JACOBIAN_ENTRY_WORK,
            max_result_values: MAX_KLU_RESULT_VALUES,
            suppress_algebraic_error: true,
            initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
        }
    }

    fn event_graph() -> CompiledGraph {
        let mut graph = EquationGraph::new();
        graph
            .add_block(Block::new(
                "scheduled source",
                Quantity::Dimensionless,
                BlockKind::StepSource {
                    before: 1.0,
                    after: 2.0,
                    at_s: 0.125,
                },
            ))
            .unwrap();
        graph.compile().unwrap()
    }

    fn limit_kink_integrator_graph() -> CompiledGraph {
        let mut graph = EquationGraph::new();
        let source = graph
            .add_block(Block::new(
                "zero",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 0.0 },
            ))
            .unwrap();
        let limit = graph
            .add_block(Block::new(
                "limit",
                Quantity::Dimensionless,
                BlockKind::Limit { min: 0.0, max: 1.0 },
            ))
            .unwrap();
        let state = graph
            .add_block(Block::new(
                "state",
                Quantity::Dimensionless,
                BlockKind::Integrator {
                    initial: 0.0,
                    rate: Quantity::Dimensionless,
                    gain: 1.0,
                },
            ))
            .unwrap();
        graph.connect(source, limit, 0).unwrap();
        graph.connect(limit, state, 0).unwrap();
        graph.compile().unwrap()
    }

    fn singular_correction_graph() -> CompiledGraph {
        let mut graph = EquationGraph::new();
        let source = graph
            .add_block(Block::new(
                "one",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 1.0 },
            ))
            .unwrap();
        let state = graph
            .add_block(Block::new(
                "state",
                Quantity::Dimensionless,
                BlockKind::Integrator {
                    initial: 0.0,
                    rate: Quantity::Dimensionless,
                    gain: 1.0,
                },
            ))
            .unwrap();
        let square = graph
            .add_block(Block::new(
                "self square",
                Quantity::Dimensionless,
                BlockKind::Product {
                    scale: 1.0,
                    left: Quantity::Dimensionless,
                    right: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        graph.connect(source, state, 0).unwrap();
        graph.connect(square, square, 0).unwrap();
        graph.connect(square, square, 1).unwrap();
        graph.compile().unwrap()
    }

    #[cfg(feature = "sundials-ida-klu")]
    fn structurally_present_but_numerically_singular_graph() -> CompiledGraph {
        let mut graph = EquationGraph::new();
        let identity = graph
            .add_block(Block::new(
                "singular self identity",
                Quantity::Dimensionless,
                BlockKind::Gain {
                    gain: 1.0,
                    input: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        graph.connect(identity, identity, 0).unwrap();
        graph.compile().unwrap()
    }

    unsafe fn write_vector(vector: crate::ffi::NVector, values: &[f64]) {
        let length = unsafe { crate::ffi::N_VGetLength_Serial(vector) };
        assert_eq!(usize::try_from(length).unwrap(), values.len());
        let data = unsafe { crate::ffi::N_VGetArrayPointer(vector) };
        assert!(!data.is_null());
        unsafe { slice::from_raw_parts_mut(data, values.len()) }.copy_from_slice(values);
    }

    unsafe fn read_vector(vector: crate::ffi::NVector, length: usize) -> Vec<f64> {
        let data = unsafe { crate::ffi::N_VGetArrayPointer(vector) };
        assert!(!data.is_null());
        unsafe { slice::from_raw_parts(data, length) }.to_vec()
    }

    unsafe fn read_matrix(matrix: crate::ffi::SUNMatrix, dimension: usize) -> Vec<f64> {
        let data = unsafe { crate::ffi::SUNDenseMatrix_Data(matrix) };
        assert!(!data.is_null());
        unsafe { slice::from_raw_parts(data, dimension * dimension) }.to_vec()
    }

    fn user_data(state: &mut CallbackState<'_, '_>) -> *mut c_void {
        (state as *mut CallbackState<'_, '_>).cast()
    }

    struct NativeVectorGuard(crate::ffi::NVector);

    impl Drop for NativeVectorGuard {
        fn drop(&mut self) {
            unsafe { crate::ffi::N_VDestroy(self.0) };
        }
    }

    unsafe fn call_residual(
        resources: &NativeResources<'_>,
        state: &mut CallbackState<'_, '_>,
        time: f64,
    ) -> c_int {
        unsafe {
            residual_callback(
                time,
                resources.y_raw(),
                resources.yp_raw(),
                resources.residual_raw(),
                user_data(state),
            )
        }
    }

    unsafe fn call_jacobian(
        resources: &NativeResources<'_>,
        state: &mut CallbackState<'_, '_>,
        time: f64,
        cj: f64,
    ) -> c_int {
        unsafe {
            jacobian_callback(
                time,
                cj,
                resources.y_raw(),
                resources.yp_raw(),
                resources.residual_raw(),
                resources.matrix_raw(),
                user_data(state),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        }
    }

    #[cfg(feature = "sundials-ida-klu")]
    unsafe fn call_sparse_jacobian(
        resources: &NativeResources<'_>,
        state: &mut CallbackState<'_, '_>,
        time: f64,
        cj: f64,
        y: crate::ffi::NVector,
    ) -> c_int {
        unsafe {
            sparse_jacobian_callback(
                time,
                cj,
                y,
                resources.yp_raw(),
                resources.residual_raw(),
                resources.matrix_raw(),
                user_data(state),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        }
    }

    #[test]
    fn residual_callback_evaluates_the_analytic_contract() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();
        unsafe {
            write_vector(resources.y_raw(), &[3.0, 5.0, 8.0]);
            write_vector(resources.yp_raw(), &[11.0, 0.0, 0.0]);
        }
        let mut state = CallbackState::new(&system).unwrap();

        assert_eq!(unsafe { call_residual(&resources, &mut state, 0.0) }, 0);
        assert_eq!(
            unsafe { read_vector(resources.residual_raw(), 3) },
            [1.0, 1.0, -1.0]
        );
        assert_eq!(state.first_error(), None);
    }

    #[test]
    fn dense_jacobian_scatter_is_column_major_for_a_nonsymmetric_system() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();
        unsafe {
            write_vector(resources.y_raw(), &[3.0, 5.0, 8.0]);
            write_vector(resources.yp_raw(), &[11.0, 0.0, 0.0]);
        }
        let mut state = CallbackState::new(&system).unwrap();

        assert_eq!(
            unsafe { call_jacobian(&resources, &mut state, 0.0, 7.0) },
            0
        );
        assert_eq!(
            unsafe { read_matrix(resources.matrix_raw(), 3) },
            // Columns of [[7, -2, 0], [0, 1, 0], [-3, 0, 1]].
            [7.0, 0.0, -3.0, -2.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        );
    }

    #[test]
    fn duplicate_csc_dependencies_retain_the_lowered_accumulated_derivative() {
        let _guard = allocation_audit::test_lock();
        let mut graph = EquationGraph::new();
        let source = graph
            .add_block(Block::new(
                "source",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 4.0 },
            ))
            .unwrap();
        let sum = graph
            .add_block(Block::new(
                "twice",
                Quantity::Dimensionless,
                BlockKind::Sum { inputs: 2 },
            ))
            .unwrap();
        graph.connect(source, sum, 0).unwrap();
        graph.connect(source, sum, 1).unwrap();
        let graph = graph.compile().unwrap();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(2).unwrap();
        unsafe {
            write_vector(resources.y_raw(), &[4.0, 8.0]);
            write_vector(resources.yp_raw(), &[0.0, 0.0]);
        }
        let mut state = CallbackState::new(&system).unwrap();

        assert_eq!(
            unsafe { call_jacobian(&resources, &mut state, 0.0, 2.0) },
            0
        );
        assert_eq!(
            unsafe { read_matrix(resources.matrix_raw(), 2) },
            [1.0, -2.0, 0.0, 1.0]
        );
    }

    #[cfg(feature = "sundials-ida-klu")]
    #[test]
    fn sparse_pattern_requires_every_structural_diagonal_before_native_allocation() {
        assert_eq!(
            crate::validate_csc_pattern(2, &[0, 1, 2], &[0, 0]),
            Err(IdaError::InvalidCscPattern {
                code: "ida.klu.csc.missing_diagonal",
            })
        );
    }

    #[cfg(feature = "sundials-ida-klu")]
    #[test]
    fn sparse_callback_restores_columns_rows_and_values_after_every_zero() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaKluBackend::new().unwrap();
        let pattern = system.csc_pattern();
        let resources = prepare_sparse_resources(
            &backend._context,
            system.variables().len(),
            pattern.column_pointers(),
            pattern.row_indices(),
        )
        .unwrap();
        unsafe {
            write_vector(resources.y_raw(), system.initial_y());
            write_vector(resources.yp_raw(), system.initial_yp());
        }
        let nonzeros = pattern.nonzero_count();
        let mut state =
            CallbackState::new_sparse(&system, 2, 2 * u64::try_from(nonzeros).unwrap()).unwrap();
        let mut expected_values = vec![0.0; nonzeros];
        system
            .jacobian_values_into(
                0.0,
                1.25,
                system.initial_y(),
                system.initial_yp(),
                &mut expected_values,
            )
            .unwrap();

        for _ in 0..2 {
            let data = unsafe { crate::ffi::SUNSparseMatrix_Data(resources.matrix_raw()) };
            let rows = unsafe { crate::ffi::SUNSparseMatrix_IndexValues(resources.matrix_raw()) };
            let columns =
                unsafe { crate::ffi::SUNSparseMatrix_IndexPointers(resources.matrix_raw()) };
            unsafe { slice::from_raw_parts_mut(data, nonzeros) }.fill(0.0);
            unsafe { slice::from_raw_parts_mut(rows, nonzeros) }.fill(0);
            unsafe { slice::from_raw_parts_mut(columns, system.variables().len() + 1) }.fill(0);

            assert_eq!(
                unsafe {
                    call_sparse_jacobian(&resources, &mut state, 0.0, 1.25, resources.y_raw())
                },
                CALLBACK_SUCCESS
            );
            assert_eq!(
                unsafe { slice::from_raw_parts(data, nonzeros) },
                expected_values
            );
            assert_eq!(
                unsafe { slice::from_raw_parts(rows, nonzeros) },
                pattern
                    .row_indices()
                    .iter()
                    .map(|&value| value as i64)
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                unsafe { slice::from_raw_parts(columns, system.variables().len() + 1) },
                pattern
                    .column_pointers()
                    .iter()
                    .map(|&value| value as i64)
                    .collect::<Vec<_>>()
            );
        }
        assert_eq!(state.first_error(), None);
    }

    #[cfg(feature = "sundials-ida-klu")]
    #[test]
    fn sparse_callback_rejects_dense_matrix_type_before_any_slice() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(2).unwrap();
        unsafe {
            write_vector(resources.y_raw(), system.initial_y());
            write_vector(resources.yp_raw(), system.initial_yp());
        }
        let mut state = CallbackState::new_sparse(&system, 1, 16).unwrap();
        let flag = unsafe {
            sparse_jacobian_callback(
                0.0,
                1.0,
                resources.y_raw(),
                resources.yp_raw(),
                resources.residual_raw(),
                resources.matrix_raw(),
                user_data(&mut state),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        assert_eq!(flag, CALLBACK_UNRECOVERABLE);
        assert_eq!(
            state.first_error(),
            Some(&IdaError::InvalidNativeView {
                callback: CallbackKind::Jacobian,
                view: NativeView::SparseJacobianData,
                expected: 2,
                actual: NativeViewActual::MatrixType(0),
            })
        );
    }

    #[cfg(feature = "sundials-ida-klu")]
    #[test]
    fn sparse_callback_rejects_matrix_vector_alias_before_any_slice() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaKluBackend::new().unwrap();
        let pattern = system.csc_pattern();
        let resources = prepare_sparse_resources(
            &backend._context,
            system.variables().len(),
            pattern.column_pointers(),
            pattern.row_indices(),
        )
        .unwrap();
        let data = unsafe { crate::ffi::SUNSparseMatrix_Data(resources.matrix_raw()) };
        let alias = unsafe {
            crate::ffi::N_VMake_Serial(
                system.variables().len() as i64,
                data,
                backend._context.as_raw(),
            )
        };
        let alias = NativeVectorGuard(alias);
        let mut state = CallbackState::new_sparse(&system, 1, 16).unwrap();

        let flag = unsafe { call_sparse_jacobian(&resources, &mut state, 0.0, 1.0, alias.0) };
        assert_eq!(flag, CALLBACK_UNRECOVERABLE);
        assert_eq!(
            state.first_error(),
            Some(&IdaError::InvalidNativeView {
                callback: CallbackKind::Jacobian,
                view: NativeView::SparseJacobianData,
                expected: 2,
                actual: NativeViewActual::Aliases {
                    with: NativeView::Y,
                },
            })
        );
    }

    #[test]
    fn analytic_dense_jacobian_matches_combined_finite_differences() {
        let _guard = allocation_audit::test_lock();
        let graph = product_integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let dimension = system.variables().len();
        assert_eq!(dimension, 4);
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(dimension).unwrap();
        let base_y = [1.0, 2.5, 3.5, 35.0];
        let base_yp = [70.0, 0.0, 0.0, 0.0];
        unsafe {
            write_vector(resources.y_raw(), &base_y);
            write_vector(resources.yp_raw(), &base_yp);
        }
        let mut state = CallbackState::new(&system).unwrap();
        let cj = 1.7;

        assert_eq!(unsafe { call_residual(&resources, &mut state, 0.0) }, 0);
        let base_residual = unsafe { read_vector(resources.residual_raw(), dimension) };
        assert_eq!(unsafe { call_jacobian(&resources, &mut state, 0.0, cj) }, 0);
        let analytic = unsafe { read_matrix(resources.matrix_raw(), dimension) };

        let epsilon = 1.0e-7;
        for column in 0..dimension {
            let mut perturbed_y = base_y;
            let mut perturbed_yp = base_yp;
            perturbed_y[column] += epsilon;
            perturbed_yp[column] += cj * epsilon;
            unsafe {
                write_vector(resources.y_raw(), &perturbed_y);
                write_vector(resources.yp_raw(), &perturbed_yp);
            }
            assert_eq!(unsafe { call_residual(&resources, &mut state, 0.0) }, 0);
            let perturbed = unsafe { read_vector(resources.residual_raw(), dimension) };
            for row in 0..dimension {
                let finite_difference = (perturbed[row] - base_residual[row]) / epsilon;
                let exact = analytic[column * dimension + row];
                assert!(
                    (finite_difference - exact).abs() <= 2.0e-7 * (1.0 + exact.abs()),
                    "row {row}, column {column}: finite {finite_difference}, analytic {exact}"
                );
            }
        }
        assert_eq!(state.first_error(), None);
    }

    #[test]
    fn null_vector_views_map_to_the_exact_residual_callback_input() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();

        for view in [NativeView::Y, NativeView::Yp, NativeView::Residual] {
            let mut state = CallbackState::new(&system).unwrap();
            let (y, yp, residual) = match view {
                NativeView::Y => (
                    ptr::null_mut(),
                    resources.yp_raw(),
                    resources.residual_raw(),
                ),
                NativeView::Yp => (resources.y_raw(), ptr::null_mut(), resources.residual_raw()),
                NativeView::Residual => (resources.y_raw(), resources.yp_raw(), ptr::null_mut()),
                NativeView::DenseJacobian
                | NativeView::SparseJacobianData
                | NativeView::SparseJacobianRowIndices
                | NativeView::SparseJacobianColumnPointers => unreachable!(),
            };
            let flag = unsafe { residual_callback(0.0, y, yp, residual, user_data(&mut state)) };
            assert_eq!(flag, CALLBACK_UNRECOVERABLE, "{view:?}");
            assert_eq!(
                state.first_error(),
                Some(&IdaError::InvalidNativeView {
                    callback: CallbackKind::Residual,
                    view,
                    expected: 3,
                    actual: NativeViewActual::Null,
                }),
                "{view:?}"
            );
        }
    }

    #[test]
    fn wrong_vector_length_is_latched_without_reading_the_native_data() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let expected = backend.prepare_resources(3).unwrap();
        let short = backend.prepare_resources(2).unwrap();
        let mut state = CallbackState::new(&system).unwrap();

        let flag = unsafe {
            residual_callback(
                0.0,
                short.y_raw(),
                expected.yp_raw(),
                expected.residual_raw(),
                user_data(&mut state),
            )
        };
        assert_eq!(flag, CALLBACK_UNRECOVERABLE);
        assert_eq!(
            state.first_error(),
            Some(&IdaError::InvalidNativeView {
                callback: CallbackKind::Residual,
                view: NativeView::Y,
                expected: 3,
                actual: NativeViewActual::VectorLength(2),
            })
        );
    }

    #[test]
    fn null_and_wrong_sized_dense_matrices_fail_before_scatter() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let expected = backend.prepare_resources(3).unwrap();
        let small = backend.prepare_resources(2).unwrap();

        let mut null_state = CallbackState::new(&system).unwrap();
        let null_flag = unsafe {
            jacobian_callback(
                0.0,
                1.0,
                expected.y_raw(),
                expected.yp_raw(),
                expected.residual_raw(),
                ptr::null_mut(),
                user_data(&mut null_state),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        assert_eq!(null_flag, CALLBACK_UNRECOVERABLE);
        assert_eq!(
            null_state.first_error(),
            Some(&IdaError::InvalidNativeView {
                callback: CallbackKind::Jacobian,
                view: NativeView::DenseJacobian,
                expected: 3,
                actual: NativeViewActual::Null,
            })
        );

        let mut small_state = CallbackState::new(&system).unwrap();
        let small_flag = unsafe {
            jacobian_callback(
                0.0,
                1.0,
                expected.y_raw(),
                expected.yp_raw(),
                expected.residual_raw(),
                small.matrix_raw(),
                user_data(&mut small_state),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        assert_eq!(small_flag, CALLBACK_UNRECOVERABLE);
        assert_eq!(
            small_state.first_error(),
            Some(&IdaError::InvalidNativeView {
                callback: CallbackKind::Jacobian,
                view: NativeView::DenseJacobian,
                expected: 3,
                actual: NativeViewActual::MatrixDimensions {
                    rows: 2,
                    columns: 2,
                },
            })
        );
    }

    #[test]
    fn aliased_mutable_callback_outputs_are_rejected_before_rust_slices_exist() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();

        let mut residual_state = CallbackState::new(&system).unwrap();
        let residual_flag = unsafe {
            residual_callback(
                0.0,
                resources.y_raw(),
                resources.yp_raw(),
                resources.y_raw(),
                user_data(&mut residual_state),
            )
        };
        assert_eq!(residual_flag, CALLBACK_UNRECOVERABLE);
        assert_eq!(
            residual_state.first_error(),
            Some(&IdaError::InvalidNativeView {
                callback: CallbackKind::Residual,
                view: NativeView::Residual,
                expected: 3,
                actual: NativeViewActual::Aliases {
                    with: NativeView::Y,
                },
            })
        );

        // N_VMake_Serial creates a vector header over caller-owned data. Point
        // it at the dense matrix solely to exercise the hostile overlap seam;
        // N_VDestroy releases the header but not the matrix-owned backing.
        let matrix_data = unsafe { crate::ffi::SUNDenseMatrix_Data(resources.matrix_raw()) };
        assert!(!matrix_data.is_null());
        let alias_y =
            unsafe { crate::ffi::N_VMake_Serial(3, matrix_data, backend._context.as_raw()) };
        assert!(!alias_y.is_null());
        let alias_y = NativeVectorGuard(alias_y);
        let mut jacobian_state = CallbackState::new(&system).unwrap();
        let jacobian_flag = unsafe {
            jacobian_callback(
                0.0,
                1.0,
                alias_y.0,
                resources.yp_raw(),
                resources.residual_raw(),
                resources.matrix_raw(),
                user_data(&mut jacobian_state),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        assert_eq!(jacobian_flag, CALLBACK_UNRECOVERABLE);
        assert_eq!(
            jacobian_state.first_error(),
            Some(&IdaError::InvalidNativeView {
                callback: CallbackKind::Jacobian,
                view: NativeView::DenseJacobian,
                expected: 3,
                actual: NativeViewActual::Aliases {
                    with: NativeView::Y,
                },
            })
        );
    }

    #[test]
    fn limit_kink_preserves_the_exact_underlying_dae_error() {
        let _guard = allocation_audit::test_lock();
        let mut graph = EquationGraph::new();
        let source = graph
            .add_block(Block::new(
                "source",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 0.0 },
            ))
            .unwrap();
        let limit = graph
            .add_block(Block::new(
                "limit",
                Quantity::Dimensionless,
                BlockKind::Limit { min: 0.0, max: 1.0 },
            ))
            .unwrap();
        graph.connect(source, limit, 0).unwrap();
        let graph = graph.compile().unwrap();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(2).unwrap();
        unsafe {
            write_vector(resources.y_raw(), &[0.0, 0.0]);
            write_vector(resources.yp_raw(), &[0.0, 0.0]);
        }
        let mut state = CallbackState::new(&system).unwrap();

        assert_eq!(
            unsafe { call_jacobian(&resources, &mut state, 0.0, 1.0) },
            CALLBACK_UNRECOVERABLE
        );
        match state.first_error() {
            Some(IdaError::Callback {
                callback: CallbackKind::Jacobian,
                source:
                    DaeError::NonsmoothJacobian {
                        row,
                        block_id,
                        time_s,
                        input_value,
                        boundary,
                    },
            }) => {
                assert_eq!((*row, *block_id), (1, limit));
                assert_eq!((*time_s, *input_value, *boundary), (0.0, 0.0, 0.0));
            }
            other => panic!("unexpected callback error: {other:?}"),
        }
    }

    #[test]
    fn first_callback_error_is_never_replaced_by_a_later_failure() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();
        let mut state = CallbackState::new(&system).unwrap();

        assert_eq!(
            unsafe {
                residual_callback(
                    0.0,
                    ptr::null_mut(),
                    resources.yp_raw(),
                    resources.residual_raw(),
                    user_data(&mut state),
                )
            },
            CALLBACK_UNRECOVERABLE
        );
        let first = state.first_error().cloned().unwrap();
        state.inject_panic(CallbackKind::Residual);
        assert_eq!(
            unsafe { call_residual(&resources, &mut state, f64::NAN) },
            CALLBACK_UNRECOVERABLE
        );
        assert_eq!(state.first_error(), Some(&first));
    }

    #[test]
    fn residual_callback_panic_is_contained_and_latched() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();
        let mut state = CallbackState::new(&system).unwrap();
        state.inject_panic(CallbackKind::Residual);

        assert_eq!(
            unsafe { call_residual(&resources, &mut state, 0.0) },
            CALLBACK_UNRECOVERABLE
        );
        assert_eq!(
            state.first_error(),
            Some(&IdaError::CallbackPanic {
                callback: CallbackKind::Residual,
            })
        );
    }

    #[test]
    fn jacobian_callback_panic_is_contained_and_latched() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();
        let mut state = CallbackState::new(&system).unwrap();
        state.inject_panic(CallbackKind::Jacobian);

        assert_eq!(
            unsafe { call_jacobian(&resources, &mut state, 0.0, 1.0) },
            CALLBACK_UNRECOVERABLE
        );
        assert_eq!(
            state.first_error(),
            Some(&IdaError::CallbackPanic {
                callback: CallbackKind::Jacobian,
            })
        );
    }

    #[test]
    fn null_user_data_fails_unrecoverably_without_dereferencing_it() {
        let _guard = allocation_audit::test_lock();
        assert_eq!(
            unsafe {
                residual_callback(
                    0.0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            CALLBACK_UNRECOVERABLE
        );
        assert_eq!(
            unsafe {
                jacobian_callback(
                    0.0,
                    1.0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            CALLBACK_UNRECOVERABLE
        );
    }

    #[test]
    fn repeated_successful_callbacks_allocate_zero_times() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let resources = backend.prepare_resources(3).unwrap();
        unsafe {
            write_vector(resources.y_raw(), &[3.0, 5.0, 8.0]);
            write_vector(resources.yp_raw(), &[11.0, 0.0, 0.0]);
        }
        let mut state = CallbackState::new(&system).unwrap();
        let mut status = 0;

        let allocations = count_callback_allocations(|| {
            for _ in 0..128 {
                status |= unsafe { call_residual(&resources, &mut state, 0.0) };
                status |= unsafe { call_jacobian(&resources, &mut state, 0.0, 7.0) };
            }
        });
        assert_eq!(status, CALLBACK_SUCCESS);
        assert_eq!(allocations, 0, "successful native callbacks allocated");
        assert_eq!(state.first_error(), None);
    }

    #[test]
    fn requested_grid_solves_the_analytic_exponential_in_block_order() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.output_times_s = vec![0.1, 0.25, 0.5, 1.0];
        settings.relative_tolerance = 1.0e-9;
        settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
        settings.max_steps = 100_000;

        let result = backend
            .initialize_session(&system, &settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap();

        assert_eq!(result.result_contract(), crate::NATIVE_IDA_RESULT_CONTRACT);
        assert_eq!(result.backend_identity(), backend.identity());
        assert_eq!(result.residual_contract(), system.contract_version());
        assert_eq!(result.output_times_s(), settings.output_times_s);
        assert_eq!(
            result
                .outputs()
                .iter()
                .map(|output| output.name.as_str())
                .collect::<Vec<_>>(),
            ["target", "exponential state"]
        );
        for (requested_index, time_s) in settings.output_times_s.iter().copied().enumerate() {
            let row = result.row(requested_index).unwrap();
            assert_eq!(row[0], 1.0);
            let expected = 1.0 - (-time_s).exp();
            assert!(
                (row[1] - expected).abs() <= 2.0e-8,
                "t={time_s}: native {}, analytic {expected}",
                row[1]
            );
        }
        assert_eq!(result.row(settings.output_times_s.len()), None);
        assert_eq!(
            result.values_time_major().len(),
            settings.output_times_s.len() * system.outputs().len()
        );
        assert!(result.stats().internal_steps() > 0);
        assert_eq!(
            result.stats().internal_steps(),
            result.stats().one_step_calls()
        );
        assert_eq!(
            result.stats().interpolated_output_rows(),
            settings.output_times_s.len() as u64
        );
    }

    #[test]
    fn exact_global_step_budget_passes_without_an_off_by_one_step() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut reference_settings = ida_settings();
        reference_settings.output_times_s = vec![1.0];
        reference_settings.relative_tolerance = 1.0e-9;
        reference_settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
        reference_settings.max_steps = 100_000;
        let reference = backend
            .initialize_session(&system, &reference_settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap();
        let exact_budget = reference.stats().internal_steps();
        assert!(exact_budget > 1);

        let mut exact_settings = reference_settings.clone();
        exact_settings.max_steps = exact_budget;
        let exact = backend
            .initialize_session(&system, &exact_settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap();

        assert_eq!(exact.stats().internal_steps(), exact_budget);
        assert_eq!(exact.stats().one_step_calls(), exact_budget);
        assert_eq!(exact.stats().output_rows_at_step_limit(), 1);
        assert_eq!(exact.row(0), reference.row(0));
    }

    #[test]
    fn one_below_exact_global_step_budget_fails_before_an_extra_step() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut reference_settings = ida_settings();
        reference_settings.output_times_s = vec![1.0];
        reference_settings.relative_tolerance = 1.0e-9;
        reference_settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
        reference_settings.max_steps = 100_000;
        let required = backend
            .initialize_session(&system, &reference_settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap()
            .stats()
            .internal_steps();
        assert!(required > 1);
        let cap = required - 1;
        let mut limited = reference_settings;
        limited.max_steps = cap;

        let error = backend
            .initialize_session(&system, &limited)
            .unwrap()
            .solve_requested_grid()
            .unwrap_err();

        match error {
            IdaError::GlobalStepLimit {
                maximum,
                consumed,
                requested_time_s,
                current_internal_time_s,
                native_flag,
            } => {
                assert_eq!((maximum, consumed), (cap, cap));
                assert_eq!(requested_time_s, 1.0);
                assert!(current_internal_time_s < requested_time_s);
                assert_eq!(native_flag, None);
            }
            other => panic!("unexpected global-cap error: {other:?}"),
        }
    }

    #[test]
    fn many_requested_outputs_cannot_reset_the_global_step_budget() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut reference_settings = ida_settings();
        reference_settings.output_times_s = vec![1.0];
        reference_settings.relative_tolerance = 1.0e-9;
        reference_settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
        reference_settings.max_steps = 100_000;
        let required = backend
            .initialize_session(&system, &reference_settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap()
            .stats()
            .internal_steps();
        let cap = required - 1;
        let mut many = reference_settings;
        many.output_times_s = (1..=128).map(|index| index as f64 / 128.0).collect();
        many.max_steps = cap;

        let error = backend
            .initialize_session(&system, &many)
            .unwrap()
            .solve_requested_grid()
            .unwrap_err();

        assert!(matches!(
            error,
            IdaError::GlobalStepLimit {
                maximum,
                consumed,
                native_flag: None,
                ..
            } if maximum == cap && consumed == cap
        ));
    }

    #[test]
    fn dense_grid_is_interpolated_after_the_last_allowed_step() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let dense_grid = (0..64)
            .map(|index| 0.1 + index as f64 * 1.0e-12)
            .collect::<Vec<_>>();
        let mut reference_settings = ida_settings();
        reference_settings.output_times_s = dense_grid.clone();
        reference_settings.relative_tolerance = 1.0e-9;
        reference_settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
        reference_settings.max_steps = 100_000;
        let required = backend
            .initialize_session(&system, &reference_settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap()
            .stats()
            .internal_steps();
        let mut exact_settings = reference_settings;
        exact_settings.max_steps = required;

        let exact = backend
            .initialize_session(&system, &exact_settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap();

        assert_eq!(exact.output_times_s(), dense_grid);
        assert_eq!(exact.stats().internal_steps(), required);
        assert!(
            exact.stats().output_rows_at_step_limit() > 1,
            "last allowed step should cover multiple dense-grid rows: {:?}",
            exact.stats()
        );
    }

    #[test]
    fn interpolation_guard_rejects_7_8_extrapolation_before_ffi() {
        let error = require_interpolation_bounds(1.000_001, 0.75, 1.0).unwrap_err();
        assert_eq!(
            error,
            IdaError::InterpolationIntervalMiss {
                requested_time_s: 1.000_001,
                interval_start_s: 0.75,
                interval_end_s: 1.0,
            }
        );
        assert_eq!(require_interpolation_bounds(1.0, 0.75, 1.0), Ok(()));
    }

    #[test]
    fn interpolation_guard_rejects_replaying_the_previous_step_endpoint() {
        for requested_time_s in [0.5, 0.49] {
            assert_eq!(
                require_interpolation_bounds(requested_time_s, 0.5, 0.75).unwrap_err(),
                IdaError::InterpolationIntervalMiss {
                    requested_time_s,
                    interval_start_s: 0.5,
                    interval_end_s: 0.75,
                }
            );
        }
    }

    #[test]
    fn signed_zero_initial_time_is_not_rejected_as_native_time_drift() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, -0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.initial_time_s = -0.0;
        settings.output_times_s = vec![0.01];

        let result = backend
            .initialize_session(&system, &settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap();

        assert_eq!(result.output_times_s(), [0.01]);
        assert!(result.stats().current_internal_time_s() >= 0.01);
    }

    #[test]
    fn underflow_scale_output_is_rejected_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        let mut settings = ida_settings();
        settings.output_times_s = vec![f64::from_bits(1)];

        let error = backend.initialize_session(&system, &settings).unwrap_err();

        assert_eq!(
            error,
            IdaError::InvalidSetting {
                code: "ida.output_times.too_close_to_initial_time",
                field: "output_times_s",
            }
        );
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn ida_roundoff_last_invalid_and_first_native_valid_distances_are_governed() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let initial_time_s = 1.0_f64;
        let system = DaeResidualSystem::lower(&graph, initial_time_s, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        for invalid_ulp_offset in [1_u64, 4] {
            let output_time_s = f64::from_bits(initial_time_s.to_bits() + invalid_ulp_offset);
            let distance_s = output_time_s - initial_time_s;
            let native_roundoff_distance_s =
                2.0 * f64::EPSILON * (initial_time_s.abs() + output_time_s.abs());
            assert!(distance_s < native_roundoff_distance_s);

            let mut settings = ida_settings();
            settings.initial_time_s = initial_time_s;
            settings.output_times_s = vec![output_time_s];
            allocation_audit::reset();
            assert_eq!(
                backend.initialize_session(&system, &settings).unwrap_err(),
                IdaError::InvalidSetting {
                    code: "ida.output_times.too_close_to_initial_time",
                    field: "output_times_s",
                }
            );
            assert_eq!(allocation_audit::snapshot(), Default::default());
        }

        let first_valid_output_s = f64::from_bits(initial_time_s.to_bits() + 5);
        let first_valid_distance_s = first_valid_output_s - initial_time_s;
        let first_valid_roundoff_distance_s =
            2.0 * f64::EPSILON * (initial_time_s.abs() + first_valid_output_s.abs());
        assert!(first_valid_distance_s >= first_valid_roundoff_distance_s);
        assert!((0.001 * first_valid_distance_s).recip().is_finite());
        assert_eq!(
            initial_time_s + 0.001 * first_valid_distance_s,
            initial_time_s
        );
    }

    #[test]
    fn initial_step_time_advance_rejects_500_ulps_and_accepts_501() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let initial_time_s = 1.0_f64;
        let system = DaeResidualSystem::lower(&graph, initial_time_s, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        let last_invalid_output_s = f64::from_bits(initial_time_s.to_bits() + 500);
        let last_invalid_step_s = 0.001 * (last_invalid_output_s - initial_time_s);
        assert!(last_invalid_step_s.recip().is_finite());
        assert_eq!(initial_time_s + last_invalid_step_s, initial_time_s);
        let mut last_invalid = ida_settings();
        last_invalid.initial_time_s = initial_time_s;
        last_invalid.output_times_s = vec![last_invalid_output_s];
        allocation_audit::reset();
        assert_eq!(
            backend
                .initialize_session(&system, &last_invalid)
                .unwrap_err(),
            IdaError::InvalidSetting {
                code: "ida.output_times.too_close_to_initial_time",
                field: "output_times_s",
            }
        );
        assert_eq!(allocation_audit::snapshot(), Default::default());

        let first_valid_output_s = f64::from_bits(initial_time_s.to_bits() + 501);
        let first_valid_step_s = 0.001 * (first_valid_output_s - initial_time_s);
        assert!(initial_time_s + first_valid_step_s > initial_time_s);
        let mut first_valid = ida_settings();
        first_valid.initial_time_s = initial_time_s;
        first_valid.output_times_s = vec![first_valid_output_s];
        let result = backend
            .initialize_session(&system, &first_valid)
            .unwrap()
            .solve_requested_grid()
            .unwrap();
        assert_eq!(result.output_times_s(), [first_valid_output_s]);
        assert!(result.stats().internal_steps() > 0);
        assert!(result.stats().internal_steps() <= first_valid.max_steps);
    }

    #[test]
    fn nonzero_but_unusable_initial_step_is_rejected_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.output_times_s = vec![1.0e-307];
        let scaled_distance_s = 0.001 * settings.output_times_s[0];
        assert!(scaled_distance_s > 0.0);
        assert!(!scaled_distance_s.recip().is_finite());

        allocation_audit::reset();
        assert_eq!(
            backend.initialize_session(&system, &settings).unwrap_err(),
            IdaError::InvalidSetting {
                code: "ida.output_times.too_close_to_initial_time",
                field: "output_times_s",
            }
        );
        assert_eq!(allocation_audit::snapshot(), Default::default());

        settings.output_times_s = vec![1.0e-305];
        assert!((0.001 * settings.output_times_s[0]).recip().is_finite());
        settings.validate_for(&system).unwrap();
    }

    #[test]
    fn contract_grid_allows_near_initial_interpolation_but_correction_rejects_it() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let initial_time_s = 1.0_f64;
        let system = DaeResidualSystem::lower(&graph, initial_time_s, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let near_initial_time_s = f64::from_bits(initial_time_s.to_bits() + 1);
        let mut settings = ida_settings();
        settings.initial_time_s = initial_time_s;
        settings.output_times_s = vec![near_initial_time_s, 1.25];

        let result = backend
            .initialize_session(&system, &settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap();
        assert_eq!(result.output_times_s(), [near_initial_time_s, 1.25]);
        assert_eq!(result.row(0).unwrap().len(), system.outputs().len());

        settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: system.initial_y().to_vec(),
            yp: system.initial_yp().to_vec(),
        };
        allocation_audit::reset();
        assert_eq!(
            backend.initialize_session(&system, &settings).unwrap_err(),
            IdaError::InvalidSetting {
                code: "ida.output_times.too_close_to_initial_time",
                field: "output_times_s",
            }
        );
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn overflowing_output_distance_is_rejected_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let initial_time_s = -f64::MAX;
        let system = DaeResidualSystem::lower(&graph, initial_time_s, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        let mut settings = ida_settings();
        settings.initial_time_s = initial_time_s;
        settings.output_times_s = vec![f64::MAX];

        assert_eq!(
            backend.initialize_session(&system, &settings).unwrap_err(),
            IdaError::InvalidSetting {
                code: "ida.output_times.distance_non_finite",
                field: "output_times_s",
            }
        );
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn result_value_ceiling_is_the_checked_product_of_public_grid_bounds() {
        assert_eq!(
            crate::MAX_OUTPUT_POINTS
                .checked_mul(crate::MAX_DENSE_DIMENSION)
                .unwrap(),
            crate::MAX_RESULT_VALUES
        );
        assert_eq!(crate::MAX_RESULT_VALUES, 25_600_000);
    }

    #[test]
    fn actual_solve_preserves_the_limit_jacobian_error() {
        let _guard = allocation_audit::test_lock();
        let graph = limit_kink_integrator_graph();
        let limit = graph.block_id("limit").unwrap();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.output_times_s = vec![0.1];

        let error = backend
            .initialize_session(&system, &settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap_err();

        assert!(matches!(
            error,
            IdaError::Callback {
                callback: CallbackKind::Jacobian,
                source: DaeError::NonsmoothJacobian { block_id, .. },
            } if block_id == limit
        ));
    }

    #[test]
    fn residual_panic_during_actual_solve_precedes_native_flag() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        session.inject_solve_callback_panic(CallbackKind::Residual);

        let error = session.solve_requested_grid().unwrap_err();

        assert_eq!(
            error,
            IdaError::CallbackPanic {
                callback: CallbackKind::Residual,
            }
        );
    }

    #[test]
    fn jacobian_panic_during_actual_solve_precedes_native_flag() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        session.inject_solve_callback_panic(CallbackKind::Jacobian);

        let error = session.solve_requested_grid().unwrap_err();

        assert_eq!(
            error,
            IdaError::CallbackPanic {
                callback: CallbackKind::Jacobian,
            }
        );
    }

    #[test]
    fn every_non_success_solve_flag_preserves_exact_stage_and_flag() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        for (label, flag) in [
            ("tstop", 1),
            ("root", 2),
            ("warning", 99),
            ("illegal input", -22),
        ] {
            let mut session = backend
                .initialize_session(&system, &ida_settings())
                .unwrap();
            session.inject_native_solve_flag(flag);
            let error = session.solve_requested_grid().unwrap_err();
            assert_eq!(
                error,
                IdaError::NativeCall {
                    stage: NativeStage::IdaSolveStep,
                    flag,
                },
                "{label}"
            );
        }
    }

    #[test]
    fn nonfinite_native_y_is_rejected_before_result_row_commit() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        session.inject_nonfinite_y(0);

        let error = session.solve_requested_grid().unwrap_err();

        assert!(matches!(
            error,
            IdaError::InvalidNativeValue {
                stage: NativeStage::IdaGetDkyY,
                field: NativeValue::Y,
                requested_index: Some(0),
                component_index: Some(0),
                value,
            } if value.is_nan()
        ));
    }

    #[test]
    fn nonfinite_native_yp_is_rejected_before_result_row_commit() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        session.inject_nonfinite_yp(0);

        let error = session.solve_requested_grid().unwrap_err();

        assert_eq!(
            error,
            IdaError::InvalidNativeValue {
                stage: NativeStage::IdaGetDkyYp,
                field: NativeValue::Yp,
                requested_index: Some(0),
                component_index: Some(0),
                value: f64::INFINITY,
            }
        );
    }

    #[test]
    fn negative_native_statistics_never_wrap_to_large_unsigned_values() {
        for (stage, statistic) in [
            (NativeStage::IdaGetNumSteps, NativeStatistic::InternalSteps),
            (
                NativeStage::IdaGetNumResEvals,
                NativeStatistic::ResidualEvaluations,
            ),
            (
                NativeStage::IdaGetNumJacEvals,
                NativeStatistic::JacobianEvaluations,
            ),
            (
                NativeStage::IdaGetNumLinIters,
                NativeStatistic::LinearIterations,
            ),
        ] {
            assert_eq!(
                checked_native_counter(-1, stage, statistic),
                Err(IdaError::InvalidNativeStatistic {
                    stage,
                    statistic,
                    value: -1,
                })
            );
        }
    }

    #[test]
    fn correction_work_is_snapshotted_out_of_published_solve_deltas() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut corrected_settings = ida_settings();
        corrected_settings.output_times_s = vec![0.25];
        corrected_settings.initial_conditions =
            IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
                y: vec![2.0, -10.0, 99.0],
                yp: vec![-7.0, 42.0, 23.0],
            };
        let corrected_session = backend
            .initialize_session(&system, &corrected_settings)
            .unwrap();
        let correction_baseline = corrected_session.counter_snapshot().unwrap();
        assert!(correction_baseline.residual_evaluations > 0);
        assert!(correction_baseline.nonlinear_iterations > 0);
        assert_eq!(correction_baseline.internal_steps, 0);
        let corrected = corrected_session.solve_requested_grid().unwrap();

        let mut contract_settings = corrected_settings;
        contract_settings.initial_conditions = IdaInitialConditionPolicy::ContractConsistent;
        let contract = backend
            .initialize_session(&system, &contract_settings)
            .unwrap()
            .solve_requested_grid()
            .unwrap();

        const COMPONENT_TOLERANCES: [f64; 3] = [1.0e-12, 1.0e-12, 1.0e-12];
        assert_eq!(
            corrected.values_time_major().len(),
            COMPONENT_TOLERANCES.len()
        );
        assert_eq!(
            contract.values_time_major().len(),
            COMPONENT_TOLERANCES.len()
        );
        for (component_index, ((corrected_value, contract_value), tolerance)) in corrected
            .values_time_major()
            .iter()
            .zip(contract.values_time_major())
            .zip(COMPONENT_TOLERANCES)
            .enumerate()
        {
            let difference = (corrected_value - contract_value).abs();
            assert!(
                difference <= tolerance,
                "component {component_index}: corrected={corrected_value}, contract={contract_value}, difference={difference}, tolerance={tolerance}"
            );
        }
        assert_eq!(corrected.stats(), contract.stats());
    }

    #[test]
    fn failed_consuming_solve_balances_every_native_resource() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        let mut session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        session.inject_native_solve_flag(-22);

        let error = session.solve_requested_grid().unwrap_err();

        assert_eq!(
            error,
            IdaError::NativeCall {
                stage: NativeStage::IdaSolveStep,
                flag: -22,
            }
        );
        assert_balanced(allocation_audit::snapshot(), "consumed solve failure");
    }

    #[test]
    fn consuming_solve_drops_native_resources_before_returning_owned_result() {
        use allocation_audit::ResourceKind::{
            CallbackState, IdaMemory, LinearSolver, Matrix, Vector,
        };

        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        let session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();

        let result = session.solve_requested_grid().unwrap();

        assert!(!result.values_time_major().is_empty());
        let snapshot = allocation_audit::snapshot();
        assert_balanced(snapshot, "consumed solve success");
        assert_eq!(
            allocation_audit::drop_events(),
            [
                IdaMemory,
                LinearSolver,
                Matrix,
                Vector,
                Vector,
                Vector,
                Vector,
                CallbackState,
            ]
        );
    }

    #[test]
    fn scalar_tolerance_session_registers_contract_vectors_and_id_vector() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let settings = ida_settings();

        let session = backend.initialize_session(&system, &settings).unwrap();

        assert_eq!(session.dimension(), 3);
        assert_eq!(session.initial_time_s(), 0.0);
        assert!(!session.corrected_initial_conditions());
        assert_eq!(session.initial_y_values().unwrap(), system.initial_y());
        assert_eq!(session.initial_yp_values().unwrap(), system.initial_yp());
        assert_eq!(session.id_values().unwrap(), [1.0, 0.0, 0.0]);
        assert_eq!(session.absolute_tolerance_values().unwrap(), [1.0e-9; 3]);
    }

    #[test]
    fn vector_tolerance_session_registers_each_exact_component() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.relative_tolerance = 2.0e-5;
        settings.absolute_tolerance = IdaAbsoluteTolerance::Vector(vec![1.0e-8, 2.0e-8, 3.0e-8]);

        let session = backend.initialize_session(&system, &settings).unwrap();

        assert_eq!(
            session.absolute_tolerance_values().unwrap(),
            [1.0e-8, 2.0e-8, 3.0e-8]
        );
        assert_eq!(session.id_values().unwrap(), system.id_vector());
    }

    #[test]
    fn maximum_order_one_and_five_are_both_registered_successfully() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        for maximum_order in [1, 5] {
            let mut settings = ida_settings();
            settings.max_order = maximum_order;
            let session = backend
                .initialize_session(&system, &settings)
                .unwrap_or_else(|error| panic!("order {maximum_order}: {error}"));
            assert_eq!(session.dimension(), 3, "order {maximum_order}");
        }
    }

    #[test]
    fn maximum_order_zero_is_rejected_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.max_order = 0;
        allocation_audit::reset();

        let error = backend.initialize_session(&system, &settings).unwrap_err();

        assert_eq!(error.code(), "ida.max_order.out_of_range");
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn maximum_order_six_is_rejected_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.max_order = 6;
        allocation_audit::reset();

        let error = backend.initialize_session(&system, &settings).unwrap_err();

        assert_eq!(error.code(), "ida.max_order.out_of_range");
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn maximum_step_endpoints_are_registered_without_narrowing() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        for maximum_steps in [1, MAX_INTERNAL_STEPS] {
            let mut settings = ida_settings();
            settings.max_steps = maximum_steps;
            let session = backend
                .initialize_session(&system, &settings)
                .unwrap_or_else(|error| panic!("max steps {maximum_steps}: {error}"));
            assert_eq!(session.dimension(), 3, "max steps {maximum_steps}");
        }
    }

    #[test]
    fn invalid_maximum_steps_are_rejected_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        for maximum_steps in [0, MAX_INTERNAL_STEPS + 1] {
            let mut settings = ida_settings();
            settings.max_steps = maximum_steps;
            allocation_audit::reset();
            let error = backend.initialize_session(&system, &settings).unwrap_err();
            assert_eq!(error.code(), "ida.max_steps.out_of_range");
            assert_eq!(allocation_audit::snapshot(), Default::default());
        }
    }

    #[test]
    fn every_other_settings_category_is_validated_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        let mut cases = Vec::new();

        let mut initial_time = ida_settings();
        initial_time.initial_time_s = f64::NAN;
        cases.push((
            "non-finite initial time",
            initial_time,
            "ida.initial_time.non_finite",
        ));

        let mut relative_zero = ida_settings();
        relative_zero.relative_tolerance = 0.0;
        cases.push((
            "zero relative tolerance",
            relative_zero,
            "ida.relative_tolerance.out_of_range",
        ));

        let mut relative_nan = ida_settings();
        relative_nan.relative_tolerance = f64::NAN;
        cases.push((
            "non-finite relative tolerance",
            relative_nan,
            "ida.relative_tolerance.out_of_range",
        ));

        let mut scalar_zero = ida_settings();
        scalar_zero.absolute_tolerance = IdaAbsoluteTolerance::Scalar(0.0);
        cases.push((
            "zero scalar absolute tolerance",
            scalar_zero,
            "ida.absolute_tolerance.out_of_range",
        ));

        let mut scalar_infinite = ida_settings();
        scalar_infinite.absolute_tolerance = IdaAbsoluteTolerance::Scalar(f64::INFINITY);
        cases.push((
            "non-finite scalar absolute tolerance",
            scalar_infinite,
            "ida.absolute_tolerance.out_of_range",
        ));

        let mut vector_short = ida_settings();
        vector_short.absolute_tolerance = IdaAbsoluteTolerance::Vector(vec![1.0e-9; 2]);
        cases.push((
            "short vector absolute tolerance",
            vector_short,
            "ida.vector_length",
        ));

        let mut vector_negative = ida_settings();
        vector_negative.absolute_tolerance =
            IdaAbsoluteTolerance::Vector(vec![1.0e-9, -1.0e-9, 1.0e-9]);
        cases.push((
            "negative vector absolute tolerance",
            vector_negative,
            "ida.absolute_tolerance.out_of_range",
        ));

        let mut zero_dense_cap = ida_settings();
        zero_dense_cap.max_dense_dimension = 0;
        cases.push((
            "zero caller dense cap",
            zero_dense_cap,
            "ida.max_dense_dimension.out_of_range",
        ));

        let mut excessive_dense_cap = ida_settings();
        excessive_dense_cap.max_dense_dimension = MAX_DENSE_DIMENSION + 1;
        cases.push((
            "caller cap above backend ceiling",
            excessive_dense_cap,
            "ida.max_dense_dimension.out_of_range",
        ));

        let mut restrictive_dense_cap = ida_settings();
        restrictive_dense_cap.max_dense_dimension = 2;
        cases.push((
            "system above caller dense cap",
            restrictive_dense_cap,
            "ida.dense_dimension_limit",
        ));

        let mut empty_outputs = ida_settings();
        empty_outputs.output_times_s.clear();
        cases.push(("empty output grid", empty_outputs, "ida.output_times.count"));

        let mut non_increasing_outputs = ida_settings();
        non_increasing_outputs.output_times_s = vec![0.25, 0.25];
        cases.push((
            "non-increasing output grid",
            non_increasing_outputs,
            "ida.output_times.not_strictly_increasing",
        ));

        let mut early_output = ida_settings();
        early_output.output_times_s = vec![0.0];
        cases.push((
            "output at initial time",
            early_output,
            "ida.output_times.not_strictly_increasing",
        ));

        let mut short_yp = ida_settings();
        short_yp.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: vec![0.0; 3],
            yp: vec![0.0; 2],
        };
        cases.push(("short correction yp", short_yp, "ida.vector_length"));

        let mut non_finite_y = ida_settings();
        non_finite_y.initial_conditions =
            IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
                y: vec![0.0, f64::NAN, 0.0],
                yp: vec![0.0; 3],
            };
        cases.push((
            "non-finite correction y",
            non_finite_y,
            "ida.initial_conditions.non_finite",
        ));

        for (label, settings, expected_code) in cases {
            allocation_audit::reset();
            let error = backend.initialize_session(&system, &settings).unwrap_err();
            assert_eq!(error.code(), expected_code, "{label}: error mapping");
            assert_eq!(
                allocation_audit::snapshot(),
                Default::default(),
                "{label}: native allocation"
            );
            assert!(
                allocation_audit::registration_events().is_empty(),
                "{label}: native registration"
            );
        }
    }

    #[test]
    fn pinned_user_data_address_survives_moving_the_session_owner() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        let expected = session.callback_address();
        assert_eq!(session.native_user_data().unwrap(), expected);

        let moved_owner = ("moved", session);

        assert_eq!(moved_owner.1.callback_address(), expected);
        assert_eq!(moved_owner.1.native_user_data().unwrap(), expected);
    }

    #[test]
    fn registration_order_distinguishes_contract_and_correction_policies() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();

        allocation_audit::reset();
        let contract_session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        assert!(!contract_session.corrected_initial_conditions());
        assert_eq!(
            allocation_audit::registration_events(),
            [
                NativeStage::IdaInit,
                NativeStage::IdaSetUserData,
                NativeStage::IdaScalarTolerances,
                NativeStage::IdaSetId,
                NativeStage::IdaSetSuppressAlg,
                NativeStage::IdaSetMaxOrd,
                NativeStage::IdaSetMaxNumSteps,
                NativeStage::IdaSetLinearSolver,
                NativeStage::IdaSetJacFn,
            ]
        );
        drop(contract_session);

        let mut correction_settings = ida_settings();
        correction_settings.absolute_tolerance = IdaAbsoluteTolerance::Vector(vec![1.0e-9; 3]);
        correction_settings.initial_conditions =
            IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
                y: vec![9.0, -10.0, 99.0],
                yp: vec![-7.0, 42.0, 23.0],
            };
        allocation_audit::reset();
        let correction_session = backend
            .initialize_session(&system, &correction_settings)
            .unwrap();
        assert!(correction_session.corrected_initial_conditions());
        assert_eq!(
            allocation_audit::registration_events(),
            [
                NativeStage::IdaInit,
                NativeStage::IdaSetUserData,
                NativeStage::IdaVectorTolerances,
                NativeStage::IdaSetId,
                NativeStage::IdaSetSuppressAlg,
                NativeStage::IdaSetMaxOrd,
                NativeStage::IdaSetMaxNumSteps,
                NativeStage::IdaSetLinearSolver,
                NativeStage::IdaSetJacFn,
                NativeStage::IdaCalcIc,
                NativeStage::IdaGetConsistentIc,
            ]
        );
    }

    #[test]
    fn correction_policy_updates_algebraic_y_and_differential_yp() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: vec![9.0, -10.0, 99.0],
            yp: vec![-7.0, 42.0, 23.0],
        };

        let session = backend.initialize_session(&system, &settings).unwrap();
        let y = session.initial_y_values().unwrap();
        let yp = session.initial_yp_values().unwrap();

        assert!(session.corrected_initial_conditions());
        assert!((y[0] - 9.0).abs() <= 1.0e-12);
        assert!((y[1] - 4.0).abs() <= 1.0e-8);
        assert!((y[2] - 27.0).abs() <= 1.0e-8);
        assert!((yp[0] - 8.0).abs() <= 1.0e-8);
        let mut residual = vec![0.0; 3];
        system
            .residual_into(settings.initial_time_s, &y, &yp, &mut residual)
            .unwrap();
        assert!(
            residual.iter().all(|value| value.abs() <= 1.0e-8),
            "corrected residual: {residual:?}"
        );
    }

    #[test]
    fn short_correction_vectors_fail_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: vec![1.0, 2.0],
            yp: vec![0.0; 3],
        };
        allocation_audit::reset();

        let error = backend.initialize_session(&system, &settings).unwrap_err();

        assert_eq!(
            error,
            IdaError::VectorLength {
                field: "initial_conditions.y",
                expected: 3,
                actual: 2,
            }
        );
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn singular_correction_preserves_calc_ic_stage_and_cleans_up() {
        use allocation_audit::ResourceKind::{
            CallbackState, IdaMemory, LinearSolver, Matrix, Vector,
        };

        let _guard = allocation_audit::test_lock();
        let graph = singular_correction_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        assert_eq!(system.id_vector(), [1.0, 0.0, 0.0]);
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: vec![0.0, 1.0, 0.5],
            yp: vec![1.0, 0.0, 0.0],
        };
        allocation_audit::reset();

        let error = backend.initialize_session(&system, &settings).unwrap_err();

        assert!(
            matches!(
                error,
                IdaError::NativeCall {
                    stage: NativeStage::IdaCalcIc,
                    flag
                } if flag < 0
            ),
            "unexpected singular correction error: {error:?}"
        );
        let snapshot = allocation_audit::snapshot();
        assert_eq!(snapshot.callback_states_allocated, 1);
        assert_balanced(snapshot, "singular correction failure");
        assert_eq!(
            allocation_audit::drop_events(),
            [
                IdaMemory,
                LinearSolver,
                Matrix,
                Vector,
                Vector,
                Vector,
                Vector,
                CallbackState,
            ]
        );
    }

    #[test]
    fn calc_ic_returns_the_first_exact_jacobian_callback_error() {
        let _guard = allocation_audit::test_lock();
        let graph = limit_kink_integrator_graph();
        let limit = graph.block_id("limit").unwrap();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: vec![0.0, 0.0, 1.0],
            yp: vec![0.0, 0.0, 0.0],
        };

        let error = backend.initialize_session(&system, &settings).unwrap_err();

        match error {
            IdaError::Callback {
                callback: CallbackKind::Jacobian,
                source:
                    DaeError::NonsmoothJacobian {
                        block_id,
                        input_value,
                        boundary,
                        ..
                    },
            } => {
                assert_eq!(block_id, limit);
                assert_eq!((input_value, boundary), (0.0, 0.0));
            }
            other => panic!("unexpected callback mapping: {other:?}"),
        }
    }

    #[test]
    fn calc_ic_residual_panic_is_contained_and_precedes_native_flag() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: vec![9.0, -10.0, 99.0],
            yp: vec![-7.0, 42.0, 23.0],
        };
        allocation_audit::reset();

        let error = initialize_session_with_callback_panic(
            &backend._context,
            &system,
            &settings,
            Some(CallbackKind::Residual),
        )
        .unwrap_err();

        assert_eq!(
            error,
            IdaError::CallbackPanic {
                callback: CallbackKind::Residual,
            }
        );
        assert_balanced(
            allocation_audit::snapshot(),
            "CalcIC residual panic failure",
        );
    }

    #[test]
    fn calc_ic_jacobian_panic_is_contained_and_precedes_native_flag() {
        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        let mut settings = ida_settings();
        settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
            y: vec![9.0, -10.0, 99.0],
            yp: vec![-7.0, 42.0, 23.0],
        };
        allocation_audit::reset();

        let error = initialize_session_with_callback_panic(
            &backend._context,
            &system,
            &settings,
            Some(CallbackKind::Jacobian),
        )
        .unwrap_err();

        assert_eq!(
            error,
            IdaError::CallbackPanic {
                callback: CallbackKind::Jacobian,
            }
        );
        assert_balanced(
            allocation_audit::snapshot(),
            "CalcIC Jacobian panic failure",
        );
    }

    #[test]
    fn scheduled_events_are_rejected_before_session_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let graph = event_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        assert_eq!(system.events().len(), 1);
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();

        let error = backend
            .initialize_session(&system, &ida_settings())
            .unwrap_err();

        assert_eq!(error, IdaError::UnsupportedEvents { count: 1 });
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn initialized_session_drop_releases_ida_before_pinned_callback_state() {
        use allocation_audit::ResourceKind::{
            CallbackState, IdaMemory, LinearSolver, Matrix, Vector,
        };

        let _guard = allocation_audit::test_lock();
        let graph = integrator_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        let session = backend
            .initialize_session(&system, &ida_settings())
            .unwrap();
        drop(session);

        let snapshot = allocation_audit::snapshot();
        assert_balanced(snapshot, "initialized session");
        assert_eq!(
            allocation_audit::drop_events(),
            [
                IdaMemory,
                LinearSolver,
                Matrix,
                Vector,
                Vector,
                Vector,
                Vector,
                CallbackState,
            ]
        );
    }

    fn assert_balanced(snapshot: allocation_audit::Snapshot, label: &str) {
        assert_eq!(
            snapshot.vectors_allocated, snapshot.vectors_freed,
            "{label}: vector lifecycle"
        );
        assert_eq!(
            snapshot.matrices_allocated, snapshot.matrices_freed,
            "{label}: matrix lifecycle"
        );
        assert_eq!(
            snapshot.linear_solvers_allocated, snapshot.linear_solvers_freed,
            "{label}: linear-solver lifecycle"
        );
        assert_eq!(
            snapshot.ida_memories_allocated, snapshot.ida_memories_freed,
            "{label}: IDA-memory lifecycle"
        );
        assert_eq!(
            snapshot.callback_states_allocated, snapshot.callback_states_freed,
            "{label}: callback-state lifecycle"
        );
    }

    fn construct_and_drop(dimension: usize) -> allocation_audit::Snapshot {
        let backend = IdaDenseBackend::new().expect("exact backend identity");
        allocation_audit::reset();
        let resources = backend
            .prepare_resources(dimension)
            .expect("native resources");
        assert_eq!(resources.dimension(), dimension);
        drop(resources);
        drop(backend);
        allocation_audit::snapshot()
    }

    #[test]
    fn dimension_one_constructs_and_releases_every_resource() {
        let _guard = allocation_audit::test_lock();
        let snapshot = construct_and_drop(1);
        assert_eq!(snapshot.vectors_allocated, 4);
        assert_eq!(snapshot.matrices_allocated, 1);
        assert_eq!(snapshot.linear_solvers_allocated, 1);
        assert_eq!(snapshot.ida_memories_allocated, 1);
        assert_balanced(snapshot, "dimension 1");
    }

    #[test]
    fn dimension_two_constructs_and_releases_every_resource() {
        let _guard = allocation_audit::test_lock();
        let snapshot = construct_and_drop(2);
        assert_eq!(snapshot.vectors_allocated, 4);
        assert_balanced(snapshot, "dimension 2");
    }

    #[test]
    fn hard_ceiling_dimension_constructs_and_releases_every_resource() {
        let _guard = allocation_audit::test_lock();
        let snapshot = construct_and_drop(MAX_DENSE_DIMENSION);
        assert_eq!(snapshot.matrices_allocated, 1);
        assert_balanced(snapshot, "dimension 256");
    }

    #[test]
    fn zero_dimension_is_rejected_before_any_native_resource_allocation() {
        let _guard = allocation_audit::test_lock();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        let error = backend.prepare_resources(0).unwrap_err();
        assert_eq!(error.code(), "ida.dimension.empty");
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn dimension_above_hard_ceiling_is_rejected_before_native_allocation() {
        let _guard = allocation_audit::test_lock();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        let error = backend
            .prepare_resources(MAX_DENSE_DIMENSION + 1)
            .unwrap_err();
        assert_eq!(error.code(), "ida.dense_dimension_limit");
        assert_eq!(allocation_audit::snapshot(), Default::default());
    }

    #[test]
    fn repeated_full_construction_and_drop_stays_balanced() {
        let _guard = allocation_audit::test_lock();
        let backend = IdaDenseBackend::new().unwrap();
        allocation_audit::reset();
        for dimension in [1, 2, 17, 64, 256].iter().copied().cycle().take(25) {
            let resources = backend.prepare_resources(dimension).unwrap();
            drop(resources);
        }
        let snapshot = allocation_audit::snapshot();
        assert_eq!(snapshot.vectors_allocated, 100);
        assert_eq!(snapshot.matrices_allocated, 25);
        assert_balanced(snapshot, "25 full constructions");
    }

    #[test]
    fn full_drop_order_releases_dependents_before_their_dependencies() {
        use allocation_audit::ResourceKind::{IdaMemory, LinearSolver, Matrix, Vector};

        let _guard = allocation_audit::test_lock();
        let snapshot = construct_and_drop(4);
        assert_balanced(snapshot, "drop order");
        assert_eq!(
            allocation_audit::drop_events(),
            [
                IdaMemory,
                LinearSolver,
                Matrix,
                Vector,
                Vector,
                Vector,
                Vector
            ]
        );
    }

    #[test]
    fn every_partial_construction_path_releases_all_prior_resources() {
        let _guard = allocation_audit::test_lock();
        let stages = [
            ("y", NativeStage::YVectorCreate),
            ("yp", NativeStage::YpVectorCreate),
            ("id", NativeStage::IdVectorCreate),
            (
                "absolute tolerance",
                NativeStage::AbsoluteToleranceVectorCreate,
            ),
            ("dense matrix", NativeStage::DenseMatrixCreate),
            ("dense linear solver", NativeStage::DenseLinearSolverCreate),
            ("IDA memory", NativeStage::IdaMemoryCreate),
        ];
        let context = initialize().unwrap();
        for (label, stage) in stages {
            for repetition in 0..4 {
                allocation_audit::reset();
                let error = prepare_resources_with(&context, 8, FailureInjection::NullAt(stage))
                    .unwrap_err();
                assert_eq!(
                    error,
                    IdaError::NullNativeHandle { stage },
                    "{label}, repetition {repetition}: mapping"
                );
                assert_balanced(
                    allocation_audit::snapshot(),
                    &format!("{label}, repetition {repetition}"),
                );
            }
        }
    }

    #[test]
    fn null_native_handles_preserve_the_exact_construction_stage() {
        for stage in [
            NativeStage::YVectorCreate,
            NativeStage::YpVectorCreate,
            NativeStage::IdVectorCreate,
            NativeStage::AbsoluteToleranceVectorCreate,
            NativeStage::DenseMatrixCreate,
            NativeStage::DenseLinearSolverCreate,
            NativeStage::IdaMemoryCreate,
        ] {
            let error = require_handle::<u8>(ptr::null_mut(), stage).unwrap_err();
            assert_eq!(error, IdaError::NullNativeHandle { stage }, "{stage:?}");
            assert_eq!(error.code(), "ida.backend.null_handle", "{stage:?}");
        }
    }

    #[cfg(feature = "sundials-ida-klu")]
    #[test]
    fn singular_klu_solve_exposes_public_last_linear_flag_evidence() {
        let _guard = allocation_audit::test_lock();
        let graph = structurally_present_but_numerically_singular_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        assert_eq!(system.csc_pattern().column_pointers(), [0, 1]);
        assert_eq!(system.csc_pattern().row_indices(), [0]);
        let backend = IdaKluBackend::new().unwrap();
        let error = backend
            .initialize_session(&system, &klu_settings())
            .unwrap()
            .solve_requested_grid()
            .unwrap_err();
        assert!(
            matches!(
                error,
                IdaError::KluLinearSolverFailure {
                    stage: NativeStage::IdaSolveStep,
                    ida_flag: IDA_LSETUP_FAIL | IDA_LSOLVE_FAIL,
                    last_linear_flag: IdaLinearFlagEvidence::Available(_),
                }
            ),
            "unexpected singular KLU error: {error:?}"
        );
    }

    #[cfg(feature = "sundials-ida-klu")]
    #[test]
    fn last_linear_getter_failure_never_masks_original_klu_stage_and_flag() {
        let _guard = allocation_audit::test_lock();
        let graph = exponential_graph();
        let system = DaeResidualSystem::lower(&graph, 0.0, &solver_settings()).unwrap();
        let backend = IdaKluBackend::new().unwrap();
        let mut session = backend
            .initialize_session(&system, &klu_settings())
            .unwrap();
        session.inject_native_solve_flag(IDA_LSOLVE_FAIL);
        session.inject_last_linear_flag_getter(-901, 777);

        assert_eq!(
            session.solve_requested_grid().unwrap_err(),
            IdaError::KluLinearSolverFailure {
                stage: NativeStage::IdaSolveStep,
                ida_flag: IDA_LSOLVE_FAIL,
                last_linear_flag: IdaLinearFlagEvidence::Unavailable { getter_flag: -901 },
            }
        );
    }

    #[test]
    fn native_error_flags_are_never_collapsed_or_treated_as_success() {
        for (stage, flag) in [
            (NativeStage::ContextCreate, -1),
            (NativeStage::RuntimeVersionProbe, -17),
            (NativeStage::DenseLinearSolverCreate, 99),
        ] {
            let error = require_success(flag, stage).unwrap_err();
            assert_eq!(error, IdaError::NativeCall { stage, flag });
            assert_eq!(error.code(), "ida.backend.native_call");
        }
        assert_eq!(require_success(0, NativeStage::ContextCreate), Ok(()));
    }
}
