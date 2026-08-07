//! Optional native SUNDIALS/IDA backend boundary.
//!
//! The default build deliberately contains no SUNDIALS adapter. Callers must
//! receive [`IdaError::Unavailable`] instead of silently falling back to the
//! built-in Rust integrators while claiming IDA evidence.

use battery_design_core::dae::{DaeError, DaeOutput, DaeResidualSystem};
use std::fmt;

#[cfg(all(feature = "sundials-ida", panic = "abort"))]
compile_error!("feature `sundials-ida` requires panic=unwind");

#[cfg(feature = "sundials-ida")]
mod ffi;
#[cfg(feature = "sundials-ida")]
mod native;
#[cfg(feature = "sundials-ida")]
pub use native::IdaSession;

/// Versioned public contract for the native dense reference backend.
pub const NATIVE_IDA_BACKEND_CONTRACT: &str = "battery-design/native-ida-dense@1";
pub const NATIVE_IDA_RESULT_CONTRACT: &str = "battery-design/native-ida-dense-result@1";
pub const NATIVE_IDA_BACKEND_ID: &str = "sundials-ida-dense";
pub const PINNED_SUNDIALS_VERSION: &str = "7.8.0";
pub const REQUIRED_FEATURE: &str = "sundials-ida";

/// Backend-owned safety ceilings. A caller may request a smaller ceiling but
/// cannot increase these values.
pub const MAX_DENSE_DIMENSION: usize = 256;
pub const MAX_OUTPUT_POINTS: usize = 100_000;
pub const MAX_INTERNAL_STEPS: u64 = 10_000_000;
pub const MAX_RESULT_VALUES: usize = MAX_OUTPUT_POINTS * MAX_DENSE_DIMENSION;

const IDA_INITIAL_STEP_DISTANCE_FACTOR: f64 = 0.001;
const IDA_TIME_ROUNDOFF_FACTOR: f64 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackendIdentity {
    pub backend_id: &'static str,
    pub contract: &'static str,
    pub provider: &'static str,
    pub solver: &'static str,
    pub version: &'static str,
    pub vector: &'static str,
    pub matrix: &'static str,
    pub linear_solver: &'static str,
    pub precision: &'static str,
    pub index_bits: u8,
    pub sparse: bool,
}

#[cfg(feature = "sundials-ida")]
const PINNED_BACKEND_IDENTITY: BackendIdentity = BackendIdentity {
    backend_id: NATIVE_IDA_BACKEND_ID,
    contract: NATIVE_IDA_BACKEND_CONTRACT,
    provider: "SUNDIALS",
    solver: "IDA",
    version: PINNED_SUNDIALS_VERSION,
    vector: "NVECTOR_SERIAL",
    matrix: "SUNMATRIX_DENSE",
    linear_solver: "SUNLINSOL_DENSE",
    precision: "double",
    index_bits: 64,
    sparse: false,
};

#[derive(Clone, Debug, PartialEq)]
pub enum IdaAbsoluteTolerance {
    Scalar(f64),
    Vector(Vec<f64>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum IdaInitialConditionPolicy {
    /// Use the consistent values published by `DaeResidualSystem` without
    /// asking IDA to correct them.
    ContractConsistent,
    /// Supply exact-length guesses and ask IDA to correct algebraic `y` and
    /// differential `yp` according to the residual system's numeric ID vector.
    CorrectAlgebraicAndDerivative { y: Vec<f64>, yp: Vec<f64> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdaSettings {
    pub initial_time_s: f64,
    pub output_times_s: Vec<f64>,
    pub relative_tolerance: f64,
    pub absolute_tolerance: IdaAbsoluteTolerance,
    pub max_order: u8,
    pub max_steps: u64,
    pub max_dense_dimension: usize,
    pub suppress_algebraic_error: bool,
    pub initial_conditions: IdaInitialConditionPolicy,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdaSolverStats {
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
    last_order: u8,
    current_order: u8,
    maximum_order_used: u8,
    actual_initial_step_s: f64,
    last_step_s: f64,
    current_step_s: f64,
    current_internal_time_s: f64,
    one_step_calls: u64,
    interpolated_output_rows: u64,
    output_rows_at_step_limit: u64,
}

impl IdaSolverStats {
    pub fn internal_steps(&self) -> u64 {
        self.internal_steps
    }

    pub fn residual_evaluations(&self) -> u64 {
        self.residual_evaluations
    }

    pub fn linear_solver_setups(&self) -> u64 {
        self.linear_solver_setups
    }

    pub fn error_test_failures(&self) -> u64 {
        self.error_test_failures
    }

    pub fn nonlinear_iterations(&self) -> u64 {
        self.nonlinear_iterations
    }

    pub fn nonlinear_convergence_failures(&self) -> u64 {
        self.nonlinear_convergence_failures
    }

    pub fn jacobian_evaluations(&self) -> u64 {
        self.jacobian_evaluations
    }

    pub fn linear_residual_evaluations(&self) -> u64 {
        self.linear_residual_evaluations
    }

    pub fn linear_iterations(&self) -> u64 {
        self.linear_iterations
    }

    pub fn linear_convergence_failures(&self) -> u64 {
        self.linear_convergence_failures
    }

    pub fn last_order(&self) -> u8 {
        self.last_order
    }

    pub fn current_order(&self) -> u8 {
        self.current_order
    }

    pub fn maximum_order_used(&self) -> u8 {
        self.maximum_order_used
    }

    pub fn actual_initial_step_s(&self) -> f64 {
        self.actual_initial_step_s
    }

    pub fn last_step_s(&self) -> f64 {
        self.last_step_s
    }

    pub fn current_step_s(&self) -> f64 {
        self.current_step_s
    }

    pub fn current_internal_time_s(&self) -> f64 {
        self.current_internal_time_s
    }

    pub fn one_step_calls(&self) -> u64 {
        self.one_step_calls
    }

    pub fn interpolated_output_rows(&self) -> u64 {
        self.interpolated_output_rows
    }

    pub fn output_rows_at_step_limit(&self) -> u64 {
        self.output_rows_at_step_limit
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdaSolveResult {
    result_contract: &'static str,
    backend_identity: BackendIdentity,
    residual_contract: &'static str,
    configured_max_order: u8,
    configured_max_steps: u64,
    output_times_s: Vec<f64>,
    outputs: Vec<DaeOutput>,
    values_time_major: Vec<f64>,
    stats: IdaSolverStats,
}

impl IdaSolveResult {
    pub fn result_contract(&self) -> &'static str {
        self.result_contract
    }

    pub fn backend_identity(&self) -> BackendIdentity {
        self.backend_identity
    }

    pub fn residual_contract(&self) -> &'static str {
        self.residual_contract
    }

    pub fn configured_max_order(&self) -> u8 {
        self.configured_max_order
    }

    pub fn configured_max_steps(&self) -> u64 {
        self.configured_max_steps
    }

    pub fn output_times_s(&self) -> &[f64] {
        &self.output_times_s
    }

    pub fn outputs(&self) -> &[DaeOutput] {
        &self.outputs
    }

    /// Flat time-major values. Each row contains `outputs().len()` entries.
    pub fn values_time_major(&self) -> &[f64] {
        &self.values_time_major
    }

    pub fn row(&self, requested_index: usize) -> Option<&[f64]> {
        let width = self.outputs.len();
        let start = requested_index.checked_mul(width)?;
        let end = start.checked_add(width)?;
        self.values_time_major.get(start..end)
    }

    pub fn stats(&self) -> &IdaSolverStats {
        &self.stats
    }
}

impl IdaSettings {
    /// Validate the complete request before any native allocation or callback.
    pub fn validate_for(&self, system: &DaeResidualSystem<'_>) -> Result<(), IdaError> {
        let dimension = system.variables().len();
        if dimension == 0 {
            return Err(IdaError::InvalidSetting {
                code: "ida.dimension.empty",
                field: "system",
            });
        }
        if self.max_dense_dimension == 0 || self.max_dense_dimension > MAX_DENSE_DIMENSION {
            return Err(IdaError::InvalidSetting {
                code: "ida.max_dense_dimension.out_of_range",
                field: "max_dense_dimension",
            });
        }
        if dimension > self.max_dense_dimension {
            return Err(IdaError::DenseDimensionLimit {
                actual: dimension,
                applied_maximum: self.max_dense_dimension,
                backend_maximum: MAX_DENSE_DIMENSION,
            });
        }
        dimension
            .checked_mul(dimension)
            .ok_or(IdaError::WorkOverflow)?;

        if !self.initial_time_s.is_finite() {
            return Err(IdaError::InvalidSetting {
                code: "ida.initial_time.non_finite",
                field: "initial_time_s",
            });
        }
        if !self.relative_tolerance.is_finite() || self.relative_tolerance <= 0.0 {
            return Err(IdaError::InvalidSetting {
                code: "ida.relative_tolerance.out_of_range",
                field: "relative_tolerance",
            });
        }
        match &self.absolute_tolerance {
            IdaAbsoluteTolerance::Scalar(value) => {
                if !value.is_finite() || *value <= 0.0 {
                    return Err(IdaError::InvalidSetting {
                        code: "ida.absolute_tolerance.out_of_range",
                        field: "absolute_tolerance",
                    });
                }
            }
            IdaAbsoluteTolerance::Vector(values) => {
                if values.len() != dimension {
                    return Err(IdaError::VectorLength {
                        field: "absolute_tolerance",
                        expected: dimension,
                        actual: values.len(),
                    });
                }
                if values
                    .iter()
                    .any(|value| !value.is_finite() || *value <= 0.0)
                {
                    return Err(IdaError::InvalidSetting {
                        code: "ida.absolute_tolerance.out_of_range",
                        field: "absolute_tolerance",
                    });
                }
            }
        }
        if !(1..=5).contains(&self.max_order) {
            return Err(IdaError::InvalidSetting {
                code: "ida.max_order.out_of_range",
                field: "max_order",
            });
        }
        if self.max_steps == 0 || self.max_steps > MAX_INTERNAL_STEPS {
            return Err(IdaError::InvalidSetting {
                code: "ida.max_steps.out_of_range",
                field: "max_steps",
            });
        }
        if self.output_times_s.is_empty() || self.output_times_s.len() > MAX_OUTPUT_POINTS {
            return Err(IdaError::InvalidSetting {
                code: "ida.output_times.count",
                field: "output_times_s",
            });
        }
        let result_values = self
            .output_times_s
            .len()
            .checked_mul(system.outputs().len())
            .ok_or(IdaError::WorkOverflow)?;
        if result_values > MAX_RESULT_VALUES {
            return Err(IdaError::ResultValueLimit {
                actual: result_values,
                maximum: MAX_RESULT_VALUES,
            });
        }
        let mut previous = self.initial_time_s;
        for value in &self.output_times_s {
            if !value.is_finite() || *value <= previous {
                return Err(IdaError::InvalidSetting {
                    code: "ida.output_times.not_strictly_increasing",
                    field: "output_times_s",
                });
            }
            previous = *value;
        }
        // IDASolve receives only the final grid time as its initial `tout`.
        // Earlier rows are materialized through dense interpolation and must
        // not be rejected merely for being close to t0.
        validate_output_distance_from_initial(
            self.initial_time_s,
            *self
                .output_times_s
                .last()
                .expect("the output grid was checked as nonempty"),
        )?;
        match &self.initial_conditions {
            IdaInitialConditionPolicy::ContractConsistent => {}
            IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative { y, yp } => {
                // IDACalcIC independently receives the first output time as
                // `tout1`, so the correction policy must preflight that span
                // as well as IDASolve's final target.
                validate_output_distance_from_initial(self.initial_time_s, self.output_times_s[0])?;
                for (field, values) in [("initial_conditions.y", y), ("initial_conditions.yp", yp)]
                {
                    if values.len() != dimension {
                        return Err(IdaError::VectorLength {
                            field,
                            expected: dimension,
                            actual: values.len(),
                        });
                    }
                    if values.iter().any(|value| !value.is_finite()) {
                        return Err(IdaError::InvalidSetting {
                            code: "ida.initial_conditions.non_finite",
                            field,
                        });
                    }
                }
            }
        }
        if !system.events().is_empty() {
            return Err(IdaError::UnsupportedEvents {
                count: system.events().len(),
            });
        }
        Ok(())
    }
}

fn validate_output_distance_from_initial(
    initial_time_s: f64,
    output_time_s: f64,
) -> Result<(), IdaError> {
    let distance_s = output_time_s - initial_time_s;
    if !distance_s.is_finite() || distance_s <= 0.0 {
        return Err(IdaError::InvalidSetting {
            code: "ida.output_times.distance_non_finite",
            field: "output_times_s",
        });
    }

    // SUNDIALS 7.8.0 rejects a first target closer than two unit roundoffs,
    // and its initial-step estimator scales the target distance by 0.001
    // before forming 1/h and adding h to t0. Mirror those gates before
    // entering native code, including a finite reciprocal and a representable
    // forward time advance. Equality passes IDASolve's strict roundoff
    // subcheck, but it must still pass the reciprocal and representable-time
    // gates below.
    let roundoff_distance_s =
        IDA_TIME_ROUNDOFF_FACTOR * f64::EPSILON * (initial_time_s.abs() + output_time_s.abs());
    let initial_step_distance_s = IDA_INITIAL_STEP_DISTANCE_FACTOR * distance_s;
    let initial_step_time_s = initial_time_s + initial_step_distance_s;
    if initial_step_distance_s == 0.0
        || !initial_step_distance_s.recip().is_finite()
        || !initial_step_time_s.is_finite()
        || initial_step_time_s <= initial_time_s
        || distance_s < roundoff_distance_s
    {
        return Err(IdaError::InvalidSetting {
            code: "ida.output_times.too_close_to_initial_time",
            field: "output_times_s",
        });
    }

    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeStage {
    ContextCreate,
    RuntimeVersionProbe,
    RuntimeInitialization,
    YVectorCreate,
    YpVectorCreate,
    IdVectorCreate,
    AbsoluteToleranceVectorCreate,
    DenseMatrixCreate,
    DenseLinearSolverCreate,
    IdaMemoryCreate,
    InitialYWrite,
    InitialYpWrite,
    IdVectorWrite,
    AbsoluteToleranceVectorWrite,
    IdaInit,
    IdaSetUserData,
    IdaScalarTolerances,
    IdaVectorTolerances,
    IdaSetId,
    IdaSetSuppressAlg,
    IdaSetMaxOrd,
    IdaSetMaxNumSteps,
    IdaSetLinearSolver,
    IdaSetJacFn,
    IdaCalcIc,
    IdaGetConsistentIc,
    IdaGetUserData,
    IdaSolveStep,
    IdaGetDkyY,
    IdaGetDkyYp,
    IdaGetNumSteps,
    IdaGetNumResEvals,
    IdaGetNumLinSolvSetups,
    IdaGetNumErrTestFails,
    IdaGetNumNonlinSolvIters,
    IdaGetNumNonlinSolvConvFails,
    IdaGetNumJacEvals,
    IdaGetNumLinResEvals,
    IdaGetNumLinIters,
    IdaGetNumLinConvFails,
    IdaGetLastOrder,
    IdaGetCurrentOrder,
    IdaGetActualInitStep,
    IdaGetLastStep,
    IdaGetCurrentStep,
    IdaGetCurrentTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeStatistic {
    InternalSteps,
    ResidualEvaluations,
    LinearSolverSetups,
    ErrorTestFailures,
    NonlinearIterations,
    NonlinearConvergenceFailures,
    JacobianEvaluations,
    LinearResidualEvaluations,
    LinearIterations,
    LinearConvergenceFailures,
    LastOrder,
    CurrentOrder,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeValue {
    ReturnedTime,
    CurrentTime,
    InterpolationIntervalStart,
    ActualInitialStep,
    LastStep,
    CurrentStep,
    Y,
    Yp,
    Output,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallbackKind {
    Residual,
    Jacobian,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeView {
    Y,
    Yp,
    Residual,
    DenseJacobian,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeViewActual {
    Null,
    VectorLength(i64),
    MatrixDimensions { rows: i64, columns: i64 },
    Aliases { with: NativeView },
    AddressOverflow,
}

#[derive(Clone, Debug, PartialEq)]
pub enum IdaError {
    Unavailable {
        backend: &'static str,
        required_feature: &'static str,
    },
    InvalidSetting {
        code: &'static str,
        field: &'static str,
    },
    VectorLength {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
    DenseDimensionLimit {
        actual: usize,
        applied_maximum: usize,
        backend_maximum: usize,
    },
    WorkOverflow,
    UnsupportedEvents {
        count: usize,
    },
    NativeCall {
        stage: NativeStage,
        flag: i32,
    },
    NullNativeHandle {
        stage: NativeStage,
    },
    InvalidRuntimeVersionLabel {
        stage: NativeStage,
    },
    RuntimeVersionMismatch {
        stage: NativeStage,
        expected: &'static str,
        actual: String,
    },
    NativePanic {
        stage: NativeStage,
    },
    Callback {
        callback: CallbackKind,
        source: DaeError,
    },
    CallbackPanic {
        callback: CallbackKind,
    },
    InvalidNativeView {
        callback: CallbackKind,
        view: NativeView,
        expected: usize,
        actual: NativeViewActual,
    },
    GlobalStepLimit {
        maximum: u64,
        consumed: u64,
        requested_time_s: f64,
        current_internal_time_s: f64,
        native_flag: Option<i32>,
    },
    InvalidNativeStatistic {
        stage: NativeStage,
        statistic: NativeStatistic,
        value: i64,
    },
    InvalidNativeValue {
        stage: NativeStage,
        field: NativeValue,
        requested_index: Option<usize>,
        component_index: Option<usize>,
        value: f64,
    },
    UnexpectedNativeTime {
        stage: NativeStage,
        expected: f64,
        actual: f64,
    },
    StepCounterInvariant {
        before: u64,
        after: u64,
        maximum: u64,
    },
    StatisticCounterInvariant {
        statistic: NativeStatistic,
        before: u64,
        after: u64,
    },
    InterpolationIntervalMiss {
        requested_time_s: f64,
        interval_start_s: f64,
        interval_end_s: f64,
    },
    InvalidNativeProgress {
        steps_before: u64,
        steps_after: u64,
        previous_time_s: f64,
        current_time_s: f64,
        last_step_s: f64,
        computed_interval_start_s: f64,
    },
    ResultEvaluation {
        requested_index: usize,
        requested_time_s: f64,
        source: DaeError,
    },
    ResultValueLimit {
        actual: usize,
        maximum: usize,
    },
    AllocationFailed {
        field: &'static str,
        requested: usize,
    },
}

impl IdaError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable { .. } => "ida.backend.unavailable",
            Self::InvalidSetting { code, .. } => code,
            Self::VectorLength { .. } => "ida.vector_length",
            Self::DenseDimensionLimit { .. } => "ida.dense_dimension_limit",
            Self::WorkOverflow => "ida.work_overflow",
            Self::UnsupportedEvents { .. } => "ida.events.unsupported",
            Self::NativeCall { .. } => "ida.backend.native_call",
            Self::NullNativeHandle { .. } => "ida.backend.null_handle",
            Self::InvalidRuntimeVersionLabel { .. } => "ida.backend.version_label",
            Self::RuntimeVersionMismatch { .. } => "ida.backend.version_mismatch",
            Self::NativePanic { .. } => "ida.backend.panic",
            Self::Callback { .. } => "ida.callback.error",
            Self::CallbackPanic { .. } => "ida.callback.panic",
            Self::InvalidNativeView { .. } => "ida.callback.invalid_native_view",
            Self::GlobalStepLimit { .. } => "ida.work.global_step_limit",
            Self::InvalidNativeStatistic { .. } => "ida.backend.invalid_statistic",
            Self::InvalidNativeValue { .. } => "ida.backend.invalid_value",
            Self::UnexpectedNativeTime { .. } => "ida.backend.unexpected_time",
            Self::StepCounterInvariant { .. } => "ida.backend.step_counter_invariant",
            Self::StatisticCounterInvariant { .. } => "ida.backend.statistic_counter_invariant",
            Self::InterpolationIntervalMiss { .. } => "ida.backend.interpolation_interval",
            Self::InvalidNativeProgress { .. } => "ida.backend.invalid_progress",
            Self::ResultEvaluation { .. } => "ida.result.evaluation",
            Self::ResultValueLimit { .. } => "ida.result.value_limit",
            Self::AllocationFailed { .. } => "ida.allocation.failed",
        }
    }
}

impl fmt::Display for IdaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable {
                backend,
                required_feature,
            } => write!(
                f,
                "native backend {backend} is unavailable; rebuild this sibling crate with feature {required_feature}"
            ),
            Self::InvalidSetting { code, field } => {
                write!(f, "invalid IDA setting {field} ({code})")
            }
            Self::VectorLength {
                field,
                expected,
                actual,
            } => write!(
                f,
                "{field} must contain exactly {expected} values; received {actual}"
            ),
            Self::DenseDimensionLimit {
                actual,
                applied_maximum,
                backend_maximum,
            } => write!(
                f,
                "dense IDA dimension {actual} exceeds applied limit {applied_maximum} (backend maximum {backend_maximum})"
            ),
            Self::WorkOverflow => f.write_str("dense IDA work estimate overflowed"),
            Self::UnsupportedEvents { count } => write!(
                f,
                "native IDA Iteration 2 does not support the {count} scheduled event(s) in this residual system"
            ),
            Self::NativeCall { stage, flag } => {
                write!(f, "native IDA call failed at {stage:?} with flag {flag}")
            }
            Self::NullNativeHandle { stage } => {
                write!(f, "native IDA returned a null handle at {stage:?}")
            }
            Self::InvalidRuntimeVersionLabel { stage } => {
                write!(f, "native IDA returned an invalid version label at {stage:?}")
            }
            Self::RuntimeVersionMismatch {
                stage,
                expected,
                actual,
            } => write!(
                f,
                "native SUNDIALS runtime version mismatch at {stage:?}: expected {expected}, received {actual}"
            ),
            Self::NativePanic { stage } => {
                write!(f, "Rust panic contained while initializing native IDA at {stage:?}")
            }
            Self::Callback { callback, source } => {
                write!(f, "native IDA {callback:?} callback failed: {source}")
            }
            Self::CallbackPanic { callback } => {
                write!(f, "Rust panic contained in native IDA {callback:?} callback")
            }
            Self::InvalidNativeView {
                callback,
                view,
                expected,
                actual,
            } => write!(
                f,
                "native IDA {callback:?} callback received invalid {view:?} view: expected dimension {expected}, received {actual:?}"
            ),
            Self::GlobalStepLimit {
                maximum,
                consumed,
                requested_time_s,
                current_internal_time_s,
                native_flag,
            } => write!(
                f,
                "global IDA internal-step limit {maximum} was exhausted after {consumed} steps before requested t={requested_time_s} (internal t={current_internal_time_s}, native flag {native_flag:?})"
            ),
            Self::InvalidNativeStatistic {
                stage,
                statistic,
                value,
            } => write!(
                f,
                "native IDA returned invalid {statistic:?} statistic {value} at {stage:?}"
            ),
            Self::InvalidNativeValue {
                stage,
                field,
                requested_index,
                component_index,
                value,
            } => write!(
                f,
                "native IDA returned invalid {field:?} value {value} at {stage:?} (requested row {requested_index:?}, component {component_index:?})"
            ),
            Self::UnexpectedNativeTime {
                stage,
                expected,
                actual,
            } => write!(
                f,
                "native IDA returned time {actual} at {stage:?}; expected {expected}"
            ),
            Self::StepCounterInvariant {
                before,
                after,
                maximum,
            } => write!(
                f,
                "native IDA step counter violated the cumulative bound: before {before}, after {after}, maximum {maximum}"
            ),
            Self::StatisticCounterInvariant {
                statistic,
                before,
                after,
            } => write!(
                f,
                "native IDA {statistic:?} counter decreased from {before} to {after}"
            ),
            Self::InterpolationIntervalMiss {
                requested_time_s,
                interval_start_s,
                interval_end_s,
            } => write!(
                f,
                "requested t={requested_time_s} is outside the exact IDA interpolation interval [{interval_start_s}, {interval_end_s}]"
            ),
            Self::InvalidNativeProgress {
                steps_before,
                steps_after,
                previous_time_s,
                current_time_s,
                last_step_s,
                computed_interval_start_s,
            } => write!(
                f,
                "native IDA made invalid progress from step/time ({steps_before}, {previous_time_s}) to ({steps_after}, {current_time_s}); last step {last_step_s} implies interval start {computed_interval_start_s}"
            ),
            Self::ResultEvaluation {
                requested_index,
                requested_time_s,
                source,
            } => write!(
                f,
                "failed to map native IDA state for requested row {requested_index} at t={requested_time_s}: {source}"
            ),
            Self::ResultValueLimit { actual, maximum } => write!(
                f,
                "native IDA result requires {actual} values, exceeding backend limit {maximum}"
            ),
            Self::AllocationFailed { field, requested } => write!(
                f,
                "could not reserve {requested} elements for native IDA {field}"
            ),
        }
    }
}

impl std::error::Error for IdaError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Callback { source, .. } | Self::ResultEvaluation { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// A handle exists only when the exact optional native backend is compiled and
/// passes its runtime identity check. The default build always fails closed.
#[derive(Debug)]
pub struct IdaDenseBackend {
    identity: BackendIdentity,
    #[cfg(feature = "sundials-ida")]
    _context: native::SunContext,
}

impl IdaDenseBackend {
    pub fn new() -> Result<Self, IdaError> {
        #[cfg(not(feature = "sundials-ida"))]
        {
            Err(IdaError::Unavailable {
                backend: NATIVE_IDA_BACKEND_ID,
                required_feature: REQUIRED_FEATURE,
            })
        }

        #[cfg(feature = "sundials-ida")]
        {
            match std::panic::catch_unwind(native::initialize) {
                Ok(Ok(context)) => Ok(Self {
                    identity: PINNED_BACKEND_IDENTITY,
                    _context: context,
                }),
                Ok(Err(error)) => Err(error),
                Err(_) => Err(IdaError::NativePanic {
                    stage: NativeStage::RuntimeInitialization,
                }),
            }
        }
    }

    pub fn identity(&self) -> BackendIdentity {
        self.identity
    }

    /// Construct and fully register an IDA session without advancing time.
    /// The complete request is validated before request-specific native
    /// resources are allocated. Scheduled events remain an explicit error.
    #[cfg(feature = "sundials-ida")]
    pub fn initialize_session<'backend, 'system, 'graph>(
        &'backend self,
        system: &'system DaeResidualSystem<'graph>,
        settings: &IdaSettings,
    ) -> Result<IdaSession<'backend, 'system, 'graph>, IdaError> {
        native::initialize_session(&self._context, system, settings)
    }

    #[cfg(feature = "sundials-ida")]
    #[allow(dead_code)]
    pub(crate) fn prepare_resources(
        &self,
        dimension: usize,
    ) -> Result<native::NativeResources<'_>, IdaError> {
        native::prepare_resources(&self._context, dimension)
    }
}
