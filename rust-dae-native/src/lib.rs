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
pub const NATIVE_IDA_BACKEND_CONTRACT: &str = "battery-design/native-ida-dense@2";
pub const NATIVE_IDA_RESULT_CONTRACT: &str = "battery-design/native-ida-dense-result@2";
pub const NATIVE_IDA_BACKEND_ID: &str = "sundials-ida-dense";
pub const PINNED_SUNDIALS_VERSION: &str = "7.8.0";
pub const REQUIRED_FEATURE: &str = "sundials-ida";

/// Versioned public contract for the sparse IDA/KLU backend. This identity is
/// deliberately separate from the dense `@2` contract: selecting it never
/// falls back to the dense linear solver.
pub const NATIVE_IDA_KLU_BACKEND_CONTRACT: &str = "battery-design/native-ida-klu@2";
pub const NATIVE_IDA_KLU_RESULT_CONTRACT: &str = "battery-design/native-ida-klu-result@2";
pub const NATIVE_IDA_KLU_BACKEND_ID: &str = "sundials-ida-klu";
pub const PINNED_SUITESPARSE_VERSION: &str = "7.7.0";
pub const PINNED_KLU_VERSION: &str = "2.3.3";
pub const REQUIRED_KLU_FEATURE: &str = "sundials-ida-klu";

/// Backend-owned safety ceilings. A caller may request a smaller ceiling but
/// cannot increase these values.
pub const MAX_DENSE_DIMENSION: usize = 256;
pub const MAX_OUTPUT_POINTS: usize = 100_000;
pub const MAX_INTERNAL_STEPS: u64 = 10_000_000;
pub const MAX_RESULT_VALUES: usize = MAX_OUTPUT_POINTS * MAX_DENSE_DIMENSION;
pub const MAX_EVENT_RESTARTS: usize = 10_000;

/// Sparse-backend admission ceilings. These cover request-owned/native CSC
/// storage and callback work only. KLU's symbolic/numeric factor fill is
/// input-dependent and is intentionally not represented as bounded here.
pub const MAX_KLU_DIMENSION: usize = 10_000;
pub const MAX_KLU_NONZEROS: usize = 1_000_000;
pub const MAX_KLU_KNOWN_CSC_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_KLU_JACOBIAN_EVALUATIONS: u64 = 1_000_000;
pub const MAX_KLU_JACOBIAN_ENTRY_WORK: u64 = 10_000_000_000;
pub const MAX_KLU_RESULT_VALUES: usize = 25_600_000;

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

#[cfg(feature = "sundials-ida-klu")]
const PINNED_KLU_BACKEND_IDENTITY: BackendIdentity = BackendIdentity {
    backend_id: NATIVE_IDA_KLU_BACKEND_ID,
    contract: NATIVE_IDA_KLU_BACKEND_CONTRACT,
    provider: "SUNDIALS + SuiteSparse",
    solver: "IDA",
    version: "SUNDIALS 7.8.0 + SuiteSparse 7.7.0 + KLU 2.3.3",
    vector: "NVECTOR_SERIAL",
    matrix: "SUNMATRIX_SPARSE_CSC",
    linear_solver: "SUNLINSOL_KLU_COLAMD",
    precision: "double",
    index_bits: 64,
    sparse: true,
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

/// Policy for graph-scheduled time discontinuities. Reject remains the
/// default and preserves the pre-`@2` fail-closed behavior. Restart opts into
/// exact stop/reinitialize/correct cycles under an explicit request cap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IdaEventPolicy {
    #[default]
    Reject,
    Restart {
        max_restarts: usize,
    },
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
    pub event_policy: IdaEventPolicy,
}

/// Complete sparse IDA/KLU request. Every work ceiling is caller-visible and
/// may be reduced below, but never raised above, the backend-owned maximum.
#[derive(Clone, Debug, PartialEq)]
pub struct IdaKluSettings {
    pub initial_time_s: f64,
    pub output_times_s: Vec<f64>,
    pub relative_tolerance: f64,
    pub absolute_tolerance: IdaAbsoluteTolerance,
    pub max_order: u8,
    pub max_steps: u64,
    pub max_dimension: usize,
    pub max_nonzeros: usize,
    pub max_known_csc_bytes: usize,
    pub max_jacobian_evaluations: u64,
    pub max_jacobian_entry_work: u64,
    pub max_result_values: usize,
    pub suppress_algebraic_error: bool,
    pub initial_conditions: IdaInitialConditionPolicy,
    pub event_policy: IdaEventPolicy,
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
    step_endpoint_output_rows: u64,
    output_rows_at_step_limit: u64,
    event_restarts: u64,
    event_equality_output_rows: u64,
    endpoint_state_captures: u64,
    last_linear_solver_flag: i64,
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

    /// Compatibility alias for [`Self::last_accepted_step_current_order`].
    pub fn current_order(&self) -> u8 {
        self.current_order
    }

    /// Order reported immediately after the last accepted integration step.
    /// A terminal event restart may occur afterward without another step.
    pub fn last_accepted_step_current_order(&self) -> u8 {
        self.current_order
    }

    pub fn maximum_order_used(&self) -> u8 {
        self.maximum_order_used
    }

    /// Actual initial step of the first integration segment. Event restarts
    /// do not replace this first-segment evidence.
    pub fn actual_initial_step_s(&self) -> f64 {
        self.actual_initial_step_s
    }

    pub fn last_step_s(&self) -> f64 {
        self.last_step_s
    }

    /// Compatibility alias for [`Self::last_accepted_step_next_step_s`].
    pub fn current_step_s(&self) -> f64 {
        self.current_step_s
    }

    /// Next-step size reported immediately after the last accepted
    /// integration step, before any terminal event reinitialization.
    pub fn last_accepted_step_next_step_s(&self) -> f64 {
        self.current_step_s
    }

    /// Compatibility alias for [`Self::terminal_state_time_s`].
    pub fn current_internal_time_s(&self) -> f64 {
        self.current_internal_time_s
    }

    /// Time of the terminal state after any event correction. This can be
    /// later in lifecycle order than the saved last-accepted-step evidence.
    pub fn terminal_state_time_s(&self) -> f64 {
        self.current_internal_time_s
    }

    pub fn one_step_calls(&self) -> u64 {
        self.one_step_calls
    }

    pub fn interpolated_output_rows(&self) -> u64 {
        self.interpolated_output_rows
    }

    pub fn step_endpoint_output_rows(&self) -> u64 {
        self.step_endpoint_output_rows
    }

    pub fn output_rows_at_step_limit(&self) -> u64 {
        self.output_rows_at_step_limit
    }

    pub fn event_restarts(&self) -> u64 {
        self.event_restarts
    }

    pub fn event_equality_output_rows(&self) -> u64 {
        self.event_equality_output_rows
    }

    /// Number of O(dimension) y/yp endpoint custody copies. This is bounded
    /// by event stops plus accepted steps that exactly match a requested row.
    pub fn endpoint_state_captures(&self) -> u64 {
        self.endpoint_state_captures
    }

    /// Last SUNDIALS linear-solver flag, copied through IDA's stable public
    /// getter. No SuiteSparse or KLU implementation struct is exposed.
    pub fn last_linear_solver_flag(&self) -> i64 {
        self.last_linear_solver_flag
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdaSolveResult {
    result_contract: &'static str,
    backend_identity: BackendIdentity,
    residual_contract: &'static str,
    configured_max_order: u8,
    configured_max_steps: u64,
    configured_event_policy: IdaEventPolicy,
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

    pub fn configured_event_policy(&self) -> IdaEventPolicy {
        self.configured_event_policy
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
        if self.initial_time_s != system.initialization_time_s() {
            return Err(IdaError::InitializationTimeMismatch {
                system_time_s: system.initialization_time_s(),
                requested_time_s: self.initial_time_s,
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
        validate_event_policy(
            self.event_policy,
            system,
            self.initial_time_s,
            *self
                .output_times_s
                .last()
                .expect("the output grid was checked as nonempty"),
            &self.output_times_s,
        )?;
        Ok(())
    }
}

impl IdaKluSettings {
    /// Exact known CSC allocation represented by the admission contract:
    /// SUNDIALS values and row indices, SUNDIALS column pointers, and the
    /// Rust callback's value scratch. This excludes KLU factor fill memory.
    pub fn known_csc_bytes(dimension: usize, nonzeros: usize) -> Option<usize> {
        let entry_bytes = nonzeros.checked_mul(3 * std::mem::size_of::<u64>())?;
        let pointer_bytes = dimension
            .checked_add(1)?
            .checked_mul(std::mem::size_of::<u64>())?;
        entry_bytes.checked_add(pointer_bytes)
    }

    /// Validate the complete sparse request before any native allocation or
    /// callback. KLU ordering is fixed by the backend and is not configurable.
    pub fn validate_for(&self, system: &DaeResidualSystem<'_>) -> Result<(), IdaError> {
        let dimension = system.variables().len();
        if dimension == 0 {
            return Err(IdaError::InvalidSetting {
                code: "ida.dimension.empty",
                field: "system",
            });
        }
        if self.max_dimension == 0 || self.max_dimension > MAX_KLU_DIMENSION {
            return Err(IdaError::InvalidSetting {
                code: "ida.klu.max_dimension.out_of_range",
                field: "max_dimension",
            });
        }
        if dimension > self.max_dimension {
            return Err(IdaError::KluDimensionLimit {
                actual: dimension,
                applied_maximum: self.max_dimension,
                backend_maximum: MAX_KLU_DIMENSION,
            });
        }

        let pattern = system.csc_pattern();
        validate_csc_pattern(dimension, pattern.column_pointers(), pattern.row_indices())?;
        let nonzeros = pattern.nonzero_count();
        if self.max_nonzeros == 0 || self.max_nonzeros > MAX_KLU_NONZEROS {
            return Err(IdaError::InvalidSetting {
                code: "ida.klu.max_nonzeros.out_of_range",
                field: "max_nonzeros",
            });
        }
        if nonzeros > self.max_nonzeros {
            return Err(IdaError::KluNonzeroLimit {
                actual: nonzeros,
                applied_maximum: self.max_nonzeros,
                backend_maximum: MAX_KLU_NONZEROS,
            });
        }

        if self.max_known_csc_bytes == 0 || self.max_known_csc_bytes > MAX_KLU_KNOWN_CSC_BYTES {
            return Err(IdaError::InvalidSetting {
                code: "ida.klu.max_known_csc_bytes.out_of_range",
                field: "max_known_csc_bytes",
            });
        }
        let known_csc_bytes =
            Self::known_csc_bytes(dimension, nonzeros).ok_or(IdaError::WorkOverflow)?;
        if known_csc_bytes > self.max_known_csc_bytes {
            return Err(IdaError::KluKnownCscByteLimit {
                actual: known_csc_bytes,
                applied_maximum: self.max_known_csc_bytes,
                backend_maximum: MAX_KLU_KNOWN_CSC_BYTES,
            });
        }

        if self.max_jacobian_evaluations == 0
            || self.max_jacobian_evaluations > MAX_KLU_JACOBIAN_EVALUATIONS
        {
            return Err(IdaError::InvalidSetting {
                code: "ida.klu.max_jacobian_evaluations.out_of_range",
                field: "max_jacobian_evaluations",
            });
        }
        if self.max_jacobian_entry_work == 0
            || self.max_jacobian_entry_work > MAX_KLU_JACOBIAN_ENTRY_WORK
        {
            return Err(IdaError::InvalidSetting {
                code: "ida.klu.max_jacobian_entry_work.out_of_range",
                field: "max_jacobian_entry_work",
            });
        }
        let configured_entry_work = self
            .max_jacobian_evaluations
            .checked_mul(u64::try_from(nonzeros).map_err(|_| IdaError::WorkOverflow)?)
            .ok_or(IdaError::WorkOverflow)?;
        if configured_entry_work > self.max_jacobian_entry_work {
            return Err(IdaError::KluJacobianEntryWorkLimit {
                attempted: configured_entry_work,
                maximum: self.max_jacobian_entry_work,
            });
        }

        if self.max_result_values == 0 || self.max_result_values > MAX_KLU_RESULT_VALUES {
            return Err(IdaError::InvalidSetting {
                code: "ida.klu.max_result_values.out_of_range",
                field: "max_result_values",
            });
        }
        if !self.initial_time_s.is_finite() {
            return Err(IdaError::InvalidSetting {
                code: "ida.initial_time.non_finite",
                field: "initial_time_s",
            });
        }
        if self.initial_time_s != system.initialization_time_s() {
            return Err(IdaError::InitializationTimeMismatch {
                system_time_s: system.initialization_time_s(),
                requested_time_s: self.initial_time_s,
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
        if result_values > self.max_result_values {
            return Err(IdaError::ResultValueLimit {
                actual: result_values,
                maximum: self.max_result_values,
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
        validate_event_policy(
            self.event_policy,
            system,
            self.initial_time_s,
            *self
                .output_times_s
                .last()
                .expect("the output grid was checked as nonempty"),
            &self.output_times_s,
        )?;
        Ok(())
    }
}

fn validate_event_policy(
    policy: IdaEventPolicy,
    system: &DaeResidualSystem<'_>,
    initial_time_s: f64,
    final_time_s: f64,
    _output_times_s: &[f64],
) -> Result<(), IdaError> {
    match policy {
        IdaEventPolicy::Reject => {
            if system.events().is_empty() {
                Ok(())
            } else {
                Err(IdaError::UnsupportedEvents {
                    count: system.events().len(),
                })
            }
        }
        IdaEventPolicy::Restart { max_restarts } => {
            if max_restarts > MAX_EVENT_RESTARTS {
                return Err(IdaError::InvalidSetting {
                    code: "ida.events.max_restarts.out_of_range",
                    field: "event_policy.max_restarts",
                });
            }
            let active = system
                .events()
                .iter()
                .filter(|event| event.time_s > initial_time_s && event.time_s <= final_time_s)
                .count();
            if active > max_restarts {
                return Err(IdaError::EventRestartLimit {
                    active,
                    maximum: max_restarts,
                });
            }

            let mut previous_boundary_s = initial_time_s;
            let mut events = system
                .events()
                .iter()
                .filter(|event| event.time_s > initial_time_s && event.time_s <= final_time_s)
                .peekable();
            while let Some(event) = events.next() {
                validate_output_distance_from_initial(previous_boundary_s, event.time_s).map_err(
                    |_| IdaError::InvalidEventSchedule {
                        code: "ida.events.segment_too_close",
                        event_index: event.index,
                        event_time_s: event.time_s,
                    },
                )?;

                let correction_target_s = match events.peek() {
                    Some(next_event) => next_event.time_s,
                    None if event.time_s < final_time_s => final_time_s,
                    None => {
                        let span_s = event.time_s - previous_boundary_s;
                        event.time_s + span_s
                    }
                };
                validate_output_distance_from_initial(event.time_s, correction_target_s).map_err(
                    |_| IdaError::InvalidEventSchedule {
                        code: "ida.events.correction_target_invalid",
                        event_index: event.index,
                        event_time_s: event.time_s,
                    },
                )?;
                previous_boundary_s = event.time_s;
            }
            Ok(())
        }
    }
}

fn validate_csc_pattern(
    dimension: usize,
    column_pointers: &[usize],
    row_indices: &[usize],
) -> Result<(), IdaError> {
    if column_pointers.len() != dimension.checked_add(1).ok_or(IdaError::WorkOverflow)? {
        return Err(IdaError::InvalidCscPattern {
            code: "ida.klu.csc.column_pointer_length",
        });
    }
    if column_pointers.first().copied() != Some(0)
        || column_pointers.last().copied() != Some(row_indices.len())
    {
        return Err(IdaError::InvalidCscPattern {
            code: "ida.klu.csc.boundaries",
        });
    }
    for column in 0..dimension {
        let start = column_pointers[column];
        let end = column_pointers[column + 1];
        if start > end || end > row_indices.len() {
            return Err(IdaError::InvalidCscPattern {
                code: "ida.klu.csc.pointer_order",
            });
        }
        let mut previous = None;
        let mut has_diagonal = false;
        for &row in &row_indices[start..end] {
            if row >= dimension || previous.is_some_and(|value| row <= value) {
                return Err(IdaError::InvalidCscPattern {
                    code: "ida.klu.csc.row_order",
                });
            }
            has_diagonal |= row == column;
            previous = Some(row);
        }
        if !has_diagonal {
            return Err(IdaError::InvalidCscPattern {
                code: "ida.klu.csc.missing_diagonal",
            });
        }
    }
    Ok(())
}

#[cfg(feature = "sundials-ida")]
pub(crate) struct IdaSessionSettings<'a> {
    pub(crate) initial_time_s: f64,
    pub(crate) output_times_s: &'a [f64],
    pub(crate) relative_tolerance: f64,
    pub(crate) absolute_tolerance: &'a IdaAbsoluteTolerance,
    pub(crate) max_order: u8,
    pub(crate) max_steps: u64,
    pub(crate) suppress_algebraic_error: bool,
    pub(crate) initial_conditions: &'a IdaInitialConditionPolicy,
    pub(crate) event_policy: IdaEventPolicy,
}

#[cfg(feature = "sundials-ida")]
impl<'a> From<&'a IdaSettings> for IdaSessionSettings<'a> {
    fn from(settings: &'a IdaSettings) -> Self {
        Self {
            initial_time_s: settings.initial_time_s,
            output_times_s: &settings.output_times_s,
            relative_tolerance: settings.relative_tolerance,
            absolute_tolerance: &settings.absolute_tolerance,
            max_order: settings.max_order,
            max_steps: settings.max_steps,
            suppress_algebraic_error: settings.suppress_algebraic_error,
            initial_conditions: &settings.initial_conditions,
            event_policy: settings.event_policy,
        }
    }
}

#[cfg(feature = "sundials-ida-klu")]
impl<'a> From<&'a IdaKluSettings> for IdaSessionSettings<'a> {
    fn from(settings: &'a IdaKluSettings) -> Self {
        Self {
            initial_time_s: settings.initial_time_s,
            output_times_s: &settings.output_times_s,
            relative_tolerance: settings.relative_tolerance,
            absolute_tolerance: &settings.absolute_tolerance,
            max_order: settings.max_order,
            max_steps: settings.max_steps,
            suppress_algebraic_error: settings.suppress_algebraic_error,
            initial_conditions: &settings.initial_conditions,
            event_policy: settings.event_policy,
        }
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
    SparseMatrixCreate,
    KluLinearSolverCreate,
    KluSetOrdering,
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
    IdaSetMaxNumStepsIc,
    IdaSetMaxNumJacsIc,
    IdaSetMaxNumItersIc,
    IdaSetMaxBacksIc,
    IdaSetLinearSolver,
    IdaSetJacFn,
    IdaSetStopTime,
    IdaClearStopTime,
    IdaReInit,
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
    IdaGetLastLinFlag,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdaEventPhase {
    SetStopTime,
    SolveLeftSegment,
    ClearStopTime,
    Reinitialize,
    CorrectInitialConditions,
    GetConsistentInitialConditions,
    PublishEqualityOutput,
    FinalizeEvidence,
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
    SparseJacobianData,
    SparseJacobianRowIndices,
    SparseJacobianColumnPointers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeViewActual {
    Null,
    VectorLength(i64),
    MatrixDimensions {
        rows: i64,
        columns: i64,
    },
    MatrixType(i32),
    SparseMatrix {
        rows: i64,
        columns: i64,
        nonzeros: i64,
        index_pointers: i64,
        sparse_type: i32,
    },
    Aliases {
        with: NativeView,
    },
    AddressOverflow,
}

/// Diagnostic copied through IDA's public linear-solver getter after a KLU
/// setup/solve failure. Getter failure is evidence, never a replacement for
/// the original IDA stage and flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdaLinearFlagEvidence {
    Available(i64),
    Unavailable { getter_flag: i32 },
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
    InitializationTimeMismatch {
        system_time_s: f64,
        requested_time_s: f64,
    },
    DenseDimensionLimit {
        actual: usize,
        applied_maximum: usize,
        backend_maximum: usize,
    },
    KluDimensionLimit {
        actual: usize,
        applied_maximum: usize,
        backend_maximum: usize,
    },
    KluNonzeroLimit {
        actual: usize,
        applied_maximum: usize,
        backend_maximum: usize,
    },
    KluKnownCscByteLimit {
        actual: usize,
        applied_maximum: usize,
        backend_maximum: usize,
    },
    KluJacobianEvaluationLimit {
        attempted: u64,
        maximum: u64,
    },
    KluJacobianEntryWorkLimit {
        attempted: u64,
        maximum: u64,
    },
    InvalidCscPattern {
        code: &'static str,
    },
    WorkOverflow,
    UnsupportedEvents {
        count: usize,
    },
    InvalidEventSchedule {
        code: &'static str,
        event_index: usize,
        event_time_s: f64,
    },
    EventRestartLimit {
        active: usize,
        maximum: usize,
    },
    EventRestartFailure {
        event_index: usize,
        event_time_s: f64,
        phase: IdaEventPhase,
        source: Box<IdaError>,
    },
    EventDifferentialDiscontinuity {
        event_index: usize,
        event_time_s: f64,
        variable_index: usize,
        before: f64,
        after: f64,
    },
    ReinitCounterInvariant {
        event_index: usize,
        statistic: NativeStatistic,
        value: u64,
    },
    NativeCall {
        stage: NativeStage,
        flag: i32,
    },
    KluLinearSolverFailure {
        stage: NativeStage,
        ida_flag: i32,
        last_linear_flag: IdaLinearFlagEvidence,
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
    CallbackEventBoundary {
        callback: CallbackKind,
        event_index: usize,
        event_time_s: f64,
        callback_time_s: f64,
    },
    CallbackHorizonBoundary {
        callback: CallbackKind,
        final_time_s: f64,
        callback_time_s: f64,
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
    OutputRowCounterInvariant {
        requested: usize,
        interpolated: u64,
        step_endpoint: u64,
        event_equality: u64,
    },
    EndpointCaptureInvariant {
        captures: u64,
        event_restarts: u64,
        step_endpoint_rows: u64,
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
            Self::InitializationTimeMismatch { .. } => "ida.initial_time.system_mismatch",
            Self::DenseDimensionLimit { .. } => "ida.dense_dimension_limit",
            Self::KluDimensionLimit { .. } => "ida.klu.dimension_limit",
            Self::KluNonzeroLimit { .. } => "ida.klu.nonzero_limit",
            Self::KluKnownCscByteLimit { .. } => "ida.klu.known_csc_byte_limit",
            Self::KluJacobianEvaluationLimit { .. } => "ida.klu.jacobian_evaluation_limit",
            Self::KluJacobianEntryWorkLimit { .. } => "ida.klu.jacobian_entry_work_limit",
            Self::InvalidCscPattern { code } => code,
            Self::WorkOverflow => "ida.work_overflow",
            Self::UnsupportedEvents { .. } => "ida.events.unsupported",
            Self::InvalidEventSchedule { code, .. } => code,
            Self::EventRestartLimit { .. } => "ida.events.restart_limit",
            Self::EventRestartFailure { .. } => "ida.events.restart_failure",
            Self::EventDifferentialDiscontinuity { .. } => "ida.events.differential_discontinuity",
            Self::ReinitCounterInvariant { .. } => "ida.events.reinit_counter_invariant",
            Self::NativeCall { .. } => "ida.backend.native_call",
            Self::KluLinearSolverFailure { .. } => "ida.klu.linear_solver_failure",
            Self::NullNativeHandle { .. } => "ida.backend.null_handle",
            Self::InvalidRuntimeVersionLabel { .. } => "ida.backend.version_label",
            Self::RuntimeVersionMismatch { .. } => "ida.backend.version_mismatch",
            Self::NativePanic { .. } => "ida.backend.panic",
            Self::Callback { .. } => "ida.callback.error",
            Self::CallbackPanic { .. } => "ida.callback.panic",
            Self::InvalidNativeView { .. } => "ida.callback.invalid_native_view",
            Self::CallbackEventBoundary { .. } => "ida.callback.event_boundary",
            Self::CallbackHorizonBoundary { .. } => "ida.callback.horizon_boundary",
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
            Self::OutputRowCounterInvariant { .. } => "ida.result.row_counter_invariant",
            Self::EndpointCaptureInvariant { .. } => "ida.result.endpoint_capture_invariant",
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
            Self::InitializationTimeMismatch {
                system_time_s,
                requested_time_s,
            } => write!(
                f,
                "native IDA initial time {requested_time_s} does not match residual-system initialization time {system_time_s}"
            ),
            Self::DenseDimensionLimit {
                actual,
                applied_maximum,
                backend_maximum,
            } => write!(
                f,
                "dense IDA dimension {actual} exceeds applied limit {applied_maximum} (backend maximum {backend_maximum})"
            ),
            Self::KluDimensionLimit {
                actual,
                applied_maximum,
                backend_maximum,
            } => write!(
                f,
                "sparse IDA/KLU dimension {actual} exceeds applied limit {applied_maximum} (backend maximum {backend_maximum})"
            ),
            Self::KluNonzeroLimit {
                actual,
                applied_maximum,
                backend_maximum,
            } => write!(
                f,
                "sparse IDA/KLU pattern has {actual} nonzeros, exceeding applied limit {applied_maximum} (backend maximum {backend_maximum})"
            ),
            Self::KluKnownCscByteLimit {
                actual,
                applied_maximum,
                backend_maximum,
            } => write!(
                f,
                "sparse IDA/KLU known CSC storage requires {actual} bytes, exceeding applied limit {applied_maximum} (backend maximum {backend_maximum}); KLU factor fill is not included"
            ),
            Self::KluJacobianEvaluationLimit { attempted, maximum } => write!(
                f,
                "sparse IDA/KLU Jacobian evaluation {attempted} exceeds callback limit {maximum}"
            ),
            Self::KluJacobianEntryWorkLimit { attempted, maximum } => write!(
                f,
                "sparse IDA/KLU Jacobian entry work {attempted} exceeds callback limit {maximum}"
            ),
            Self::InvalidCscPattern { code } => {
                write!(f, "invalid sparse IDA/KLU CSC pattern ({code})")
            }
            Self::WorkOverflow => f.write_str("native IDA work estimate overflowed"),
            Self::UnsupportedEvents { count } => write!(
                f,
                "native IDA event policy rejects the {count} scheduled event(s) in this residual system"
            ),
            Self::InvalidEventSchedule {
                code,
                event_index,
                event_time_s,
            } => write!(
                f,
                "invalid native IDA event {event_index} at t={event_time_s} ({code})"
            ),
            Self::EventRestartLimit { active, maximum } => write!(
                f,
                "native IDA requires {active} active event restarts, exceeding the configured maximum {maximum}"
            ),
            Self::EventRestartFailure {
                event_index,
                event_time_s,
                phase,
                source,
            } => write!(
                f,
                "native IDA event {event_index} at t={event_time_s} failed during {phase:?}: {source}"
            ),
            Self::EventDifferentialDiscontinuity {
                event_index,
                event_time_s,
                variable_index,
                before,
                after,
            } => write!(
                f,
                "native IDA event {event_index} at t={event_time_s} changed differential y[{variable_index}] from {before} to {after}"
            ),
            Self::ReinitCounterInvariant {
                event_index,
                statistic,
                value,
            } => write!(
                f,
                "native IDA event {event_index} reinitialization left {statistic:?} counter at {value} instead of zero"
            ),
            Self::NativeCall { stage, flag } => {
                write!(f, "native IDA call failed at {stage:?} with flag {flag}")
            }
            Self::KluLinearSolverFailure {
                stage,
                ida_flag,
                last_linear_flag,
            } => write!(
                f,
                "native IDA/KLU linear setup or solve failed at {stage:?} with IDA flag {ida_flag} and last-linear evidence {last_linear_flag:?}"
            ),
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
            Self::CallbackEventBoundary {
                callback,
                event_index,
                event_time_s,
                callback_time_s,
            } => write!(
                f,
                "native IDA {callback:?} callback at t={callback_time_s} overshot active event {event_index} at t={event_time_s}"
            ),
            Self::CallbackHorizonBoundary {
                callback,
                final_time_s,
                callback_time_s,
            } => write!(
                f,
                "native IDA {callback:?} callback at t={callback_time_s} overshot requested final horizon t={final_time_s}"
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
                "requested t={requested_time_s} is outside the strict IDA interpolation interval ({interval_start_s}, {interval_end_s})"
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
            Self::OutputRowCounterInvariant {
                requested,
                interpolated,
                step_endpoint,
                event_equality,
            } => write!(
                f,
                "native IDA materialized {requested} rows but accounted for interpolation={interpolated}, step-endpoint={step_endpoint}, event-equality={event_equality}"
            ),
            Self::EndpointCaptureInvariant {
                captures,
                event_restarts,
                step_endpoint_rows,
            } => write!(
                f,
                "native IDA made {captures} endpoint custody copies for {event_restarts} event restarts and {step_endpoint_rows} direct step-endpoint rows"
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
            Self::EventRestartFailure { source, .. } => Some(source.as_ref()),
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

/// Sparse SUNDIALS/IDA backend using the pinned SuiteSparse KLU direct solver
/// with fixed COLAMD ordering. Construction and session creation fail closed;
/// there is no dense fallback path.
#[derive(Debug)]
pub struct IdaKluBackend {
    identity: BackendIdentity,
    #[cfg(feature = "sundials-ida-klu")]
    _context: native::SunContext,
}

impl IdaKluBackend {
    pub fn new() -> Result<Self, IdaError> {
        #[cfg(not(feature = "sundials-ida-klu"))]
        {
            Err(IdaError::Unavailable {
                backend: NATIVE_IDA_KLU_BACKEND_ID,
                required_feature: REQUIRED_KLU_FEATURE,
            })
        }

        #[cfg(feature = "sundials-ida-klu")]
        {
            match std::panic::catch_unwind(native::initialize_klu) {
                Ok(Ok(context)) => Ok(Self {
                    identity: PINNED_KLU_BACKEND_IDENTITY,
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

    #[cfg(feature = "sundials-ida-klu")]
    pub fn initialize_session<'backend, 'system, 'graph>(
        &'backend self,
        system: &'system DaeResidualSystem<'graph>,
        settings: &IdaKluSettings,
    ) -> Result<IdaSession<'backend, 'system, 'graph>, IdaError> {
        native::initialize_klu_session(&self._context, system, settings)
    }
}
