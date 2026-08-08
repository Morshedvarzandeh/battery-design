//! Narrow raw declarations for the exact SUNDIALS 7.8.0 serial IDA boundary.
//! Sparse/KLU symbols are compiled only behind the closed KLU feature.

#![allow(dead_code)]

use std::ffi::{c_char, c_int, c_long, c_void};

pub(crate) enum SUNContextOpaque {}
pub(crate) type SUNContext = *mut SUNContextOpaque;
pub(crate) enum NVectorOpaque {}
pub(crate) type NVector = *mut NVectorOpaque;
pub(crate) enum SUNMatrixOpaque {}
pub(crate) type SUNMatrix = *mut SUNMatrixOpaque;
pub(crate) enum SUNLinearSolverOpaque {}
pub(crate) type SUNLinearSolver = *mut SUNLinearSolverOpaque;
pub(crate) type IdaMemory = *mut c_void;
pub(crate) type SunIndex = i64;
pub(crate) type IdaResidualFn = unsafe extern "C" fn(
    time: f64,
    y: NVector,
    yp: NVector,
    residual: NVector,
    user_data: *mut c_void,
) -> c_int;
pub(crate) type IdaJacobianFn = unsafe extern "C" fn(
    time: f64,
    cj: f64,
    y: NVector,
    yp: NVector,
    residual: NVector,
    jacobian: SUNMatrix,
    user_data: *mut c_void,
    temporary_1: NVector,
    temporary_2: NVector,
    temporary_3: NVector,
) -> c_int;

extern "C" {
    pub(crate) fn SUNContext_Create(comm: c_int, context: *mut SUNContext) -> c_int;
    pub(crate) fn SUNContext_Free(context: *mut SUNContext) -> c_int;
    pub(crate) fn SUNDIALSGetVersionNumber(
        major: *mut c_int,
        minor: *mut c_int,
        patch: *mut c_int,
        label: *mut c_char,
        label_length: c_int,
    ) -> c_int;

    pub(crate) fn N_VNew_Serial(length: SunIndex, context: SUNContext) -> NVector;
    pub(crate) fn N_VMake_Serial(length: SunIndex, data: *mut f64, context: SUNContext) -> NVector;
    pub(crate) fn N_VDestroy(vector: NVector);
    pub(crate) fn N_VGetLength_Serial(vector: NVector) -> SunIndex;
    pub(crate) fn N_VGetArrayPointer(vector: NVector) -> *mut f64;

    pub(crate) fn SUNDenseMatrix(
        rows: SunIndex,
        columns: SunIndex,
        context: SUNContext,
    ) -> SUNMatrix;
    pub(crate) fn SUNMatDestroy(matrix: SUNMatrix);
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNMatGetID(matrix: SUNMatrix) -> c_int;
    pub(crate) fn SUNDenseMatrix_Rows(matrix: SUNMatrix) -> SunIndex;
    pub(crate) fn SUNDenseMatrix_Columns(matrix: SUNMatrix) -> SunIndex;
    pub(crate) fn SUNDenseMatrix_Data(matrix: SUNMatrix) -> *mut f64;

    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix(
        rows: SunIndex,
        columns: SunIndex,
        nonzeros: SunIndex,
        sparse_type: c_int,
        context: SUNContext,
    ) -> SUNMatrix;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_Rows(matrix: SUNMatrix) -> SunIndex;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_Columns(matrix: SUNMatrix) -> SunIndex;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_NNZ(matrix: SUNMatrix) -> SunIndex;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_NP(matrix: SUNMatrix) -> SunIndex;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_SparseType(matrix: SUNMatrix) -> c_int;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_Data(matrix: SUNMatrix) -> *mut f64;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_IndexValues(matrix: SUNMatrix) -> *mut SunIndex;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNSparseMatrix_IndexPointers(matrix: SUNMatrix) -> *mut SunIndex;

    pub(crate) fn SUNLinSol_Dense(
        template_vector: NVector,
        matrix: SUNMatrix,
        context: SUNContext,
    ) -> SUNLinearSolver;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNLinSol_KLU(
        template_vector: NVector,
        matrix: SUNMatrix,
        context: SUNContext,
    ) -> SUNLinearSolver;
    #[cfg(feature = "sundials-ida-klu")]
    pub(crate) fn SUNLinSol_KLUSetOrdering(
        linear_solver: SUNLinearSolver,
        ordering_choice: c_int,
    ) -> c_int;
    pub(crate) fn SUNLinSolFree(linear_solver: SUNLinearSolver) -> c_int;

    pub(crate) fn IDACreate(context: SUNContext) -> IdaMemory;
    pub(crate) fn IDAFree(memory: *mut IdaMemory);
    pub(crate) fn IDAInit(
        memory: IdaMemory,
        residual: IdaResidualFn,
        initial_time: f64,
        initial_y: NVector,
        initial_yp: NVector,
    ) -> c_int;
    pub(crate) fn IDAReInit(
        memory: IdaMemory,
        initial_time: f64,
        initial_y: NVector,
        initial_yp: NVector,
    ) -> c_int;
    pub(crate) fn IDASetUserData(memory: IdaMemory, user_data: *mut c_void) -> c_int;
    pub(crate) fn IDASStolerances(
        memory: IdaMemory,
        relative_tolerance: f64,
        absolute_tolerance: f64,
    ) -> c_int;
    pub(crate) fn IDASVtolerances(
        memory: IdaMemory,
        relative_tolerance: f64,
        absolute_tolerance: NVector,
    ) -> c_int;
    pub(crate) fn IDASetId(memory: IdaMemory, id: NVector) -> c_int;
    pub(crate) fn IDASetSuppressAlg(memory: IdaMemory, suppress: c_int) -> c_int;
    pub(crate) fn IDASetMaxOrd(memory: IdaMemory, maximum_order: c_int) -> c_int;
    pub(crate) fn IDASetMaxNumSteps(memory: IdaMemory, maximum_steps: c_long) -> c_int;
    pub(crate) fn IDASetMaxNumStepsIC(memory: IdaMemory, maximum_steps: c_int) -> c_int;
    pub(crate) fn IDASetMaxNumJacsIC(memory: IdaMemory, maximum_jacobians: c_int) -> c_int;
    pub(crate) fn IDASetMaxNumItersIC(memory: IdaMemory, maximum_iterations: c_int) -> c_int;
    pub(crate) fn IDASetMaxBacksIC(memory: IdaMemory, maximum_backtracks: c_int) -> c_int;
    pub(crate) fn IDASetStopTime(memory: IdaMemory, stop_time: f64) -> c_int;
    pub(crate) fn IDAClearStopTime(memory: IdaMemory) -> c_int;
    pub(crate) fn IDASetLinearSolver(
        memory: IdaMemory,
        linear_solver: SUNLinearSolver,
        matrix: SUNMatrix,
    ) -> c_int;
    pub(crate) fn IDASetJacFn(memory: IdaMemory, jacobian: IdaJacobianFn) -> c_int;
    pub(crate) fn IDACalcIC(
        memory: IdaMemory,
        initial_condition_option: c_int,
        first_output_time: f64,
    ) -> c_int;
    pub(crate) fn IDAGetConsistentIC(
        memory: IdaMemory,
        corrected_y: NVector,
        corrected_yp: NVector,
    ) -> c_int;
    pub(crate) fn IDAGetUserData(memory: IdaMemory, user_data: *mut *mut c_void) -> c_int;
    pub(crate) fn IDASolve(
        memory: IdaMemory,
        target_time: f64,
        returned_time: *mut f64,
        y: NVector,
        yp: NVector,
        task: c_int,
    ) -> c_int;
    pub(crate) fn IDAGetDky(
        memory: IdaMemory,
        time: f64,
        derivative_order: c_int,
        output: NVector,
    ) -> c_int;
    pub(crate) fn IDAGetNumSteps(memory: IdaMemory, steps: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumResEvals(memory: IdaMemory, evaluations: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumLinSolvSetups(memory: IdaMemory, setups: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumErrTestFails(memory: IdaMemory, failures: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumNonlinSolvIters(memory: IdaMemory, iterations: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumNonlinSolvConvFails(memory: IdaMemory, failures: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumJacEvals(memory: IdaMemory, evaluations: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumLinResEvals(memory: IdaMemory, evaluations: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumLinIters(memory: IdaMemory, iterations: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumLinConvFails(memory: IdaMemory, failures: *mut c_long) -> c_int;
    pub(crate) fn IDAGetLastOrder(memory: IdaMemory, order: *mut c_int) -> c_int;
    pub(crate) fn IDAGetCurrentOrder(memory: IdaMemory, order: *mut c_int) -> c_int;
    pub(crate) fn IDAGetActualInitStep(memory: IdaMemory, step: *mut f64) -> c_int;
    pub(crate) fn IDAGetLastStep(memory: IdaMemory, step: *mut f64) -> c_int;
    pub(crate) fn IDAGetCurrentStep(memory: IdaMemory, step: *mut f64) -> c_int;
    pub(crate) fn IDAGetCurrentTime(memory: IdaMemory, time: *mut f64) -> c_int;
    pub(crate) fn IDAGetLastLinFlag(memory: IdaMemory, flag: *mut c_long) -> c_int;
}
