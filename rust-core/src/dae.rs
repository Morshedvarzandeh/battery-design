//! Dependency-free lowering of compiled equation graphs to a DAE residual contract.
//!
//! This module is a backend boundary, not a high-order solver. It presents a
//! compiled graph as a residual system for a future native DAE backend without
//! changing graph transport v1 or the current WebAssembly ABI. Lowering does
//! not prove that an algebraic system is regular or index 1; backend admission
//! and qualification remain separate, explicit gates.

use crate::equations::{
    BlockId, BlockKind, CompiledGraph, EquationError, Quantity, SolverSettings,
};
use std::fmt;

/// Version of the native DAE lowering contract. This is intentionally
/// independent from graph transport and from any future backend version.
pub const DAE_RESIDUAL_CONTRACT_VERSION: &str = "battery-design/dae-residual@2";

/// Numeric identifiers used by IDA-style backends.
pub const DAE_DIFFERENTIAL_ID: f64 = 1.0;
pub const DAE_ALGEBRAIC_ID: f64 = 0.0;

/// Classification required by implicit DAE backends such as IDA.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaeVariableKind {
    Differential,
    Algebraic,
}

/// One DAE variable and residual row. DAE indices are stable for a compiled
/// graph: differential states first, then algebraic variables, preserving the
/// compiled order within each category.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaeVariable {
    pub index: usize,
    pub block_id: BlockId,
    pub name: String,
    pub quantity: Quantity,
    pub kind: DaeVariableKind,
}

/// One externally observable block output. Output indices remain in BlockId
/// order even though the corresponding DAE variables are state-first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaeOutput {
    pub index: usize,
    pub block_id: BlockId,
    pub variable_index: usize,
    pub name: String,
    pub quantity: Quantity,
}

/// A scheduled time discontinuity. Step-source evaluation is right-continuous:
/// at exactly `time_s`, the source's `after` value is active.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DaeEvent {
    pub index: usize,
    pub time_s: f64,
}

/// Deterministic compressed-sparse-column structure. Entries are ordered by
/// increasing column and then increasing row. The matching values returned by
/// [`DaeResidualSystem::jacobian_values_into`] are
/// `dF/dy + cj * dF/dyp`, which is the convention expected by IDA-style
/// implicit backends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaeCscPattern {
    column_pointers: Vec<usize>,
    row_indices: Vec<usize>,
}

impl DaeCscPattern {
    pub fn column_pointers(&self) -> &[usize] {
        &self.column_pointers
    }

    pub fn row_indices(&self) -> &[usize] {
        &self.row_indices
    }

    pub fn nonzero_count(&self) -> usize {
        self.row_indices.len()
    }
}

/// Exact lengths accepted by the allocation-free evaluation methods.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DaeBufferRequirements {
    pub y: usize,
    pub yp: usize,
    pub id_vector: usize,
    pub residual: usize,
    pub jacobian_values: usize,
    pub outputs: usize,
    pub event_times: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaeBuffer {
    Y,
    Yp,
    IdVector,
    Residual,
    JacobianValues,
    Outputs,
    InitialY,
    InitialYp,
    EventTimes,
}

impl fmt::Display for DaeBuffer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Y => "y",
            Self::Yp => "yp",
            Self::IdVector => "ID vector",
            Self::Residual => "residual",
            Self::JacobianValues => "jacobian values",
            Self::Outputs => "outputs",
            Self::InitialY => "initial y",
            Self::InitialYp => "initial yp",
            Self::EventTimes => "event times",
        };
        f.write_str(name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaeInput {
    InitializationTime,
    Time,
    Cj,
    Y,
    Yp,
}

impl fmt::Display for DaeInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::InitializationTime => "initialization time",
            Self::Time => "time",
            Self::Cj => "cj",
            Self::Y => "y",
            Self::Yp => "yp",
        };
        f.write_str(name)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DaeError {
    Initialization(EquationError),
    InvalidEventIndex {
        event_index: usize,
        event_count: usize,
    },
    BufferLength {
        buffer: DaeBuffer,
        expected: usize,
        actual: usize,
    },
    NonFiniteInput {
        input: DaeInput,
        index: Option<usize>,
    },
    NonFiniteResidual {
        row: usize,
        block_id: BlockId,
        time_s: f64,
    },
    NonFiniteJacobian {
        row: usize,
        column: usize,
        block_id: BlockId,
        time_s: f64,
    },
    /// The derivative of a Limit block is not unique at a clamp boundary.
    /// The contract fails closed instead of silently choosing a backend-
    /// dependent derivative.
    NonsmoothJacobian {
        row: usize,
        block_id: BlockId,
        time_s: f64,
        input_value: f64,
        boundary: f64,
    },
}

impl DaeError {
    /// Stable machine-readable diagnostic. Callers must not parse Display text.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Initialization(_) => "dae.initialization",
            Self::InvalidEventIndex { .. } => "dae.invalid_event_index",
            Self::BufferLength { .. } => "dae.buffer_length",
            Self::NonFiniteInput { .. } => "dae.non_finite_input",
            Self::NonFiniteResidual { .. } => "dae.non_finite_residual",
            Self::NonFiniteJacobian { .. } => "dae.non_finite_jacobian",
            Self::NonsmoothJacobian { .. } => "dae.nonsmooth_jacobian",
        }
    }
}

impl fmt::Display for DaeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Initialization(error) => write!(f, "DAE initialization failed: {error}"),
            Self::InvalidEventIndex {
                event_index,
                event_count,
            } => write!(
                f,
                "DAE event index {event_index} is outside the event table containing {event_count} entries"
            ),
            Self::BufferLength {
                buffer,
                expected,
                actual,
            } => write!(
                f,
                "{buffer} buffer must contain exactly {expected} values; received {actual}"
            ),
            Self::NonFiniteInput { input, index } => match index {
                Some(index) => write!(f, "{input}[{index}] is not finite"),
                None => write!(f, "{input} is not finite"),
            },
            Self::NonFiniteResidual {
                row,
                block_id,
                time_s,
            } => write!(
                f,
                "DAE residual row {row} for block {block_id} is not finite at t={time_s}"
            ),
            Self::NonFiniteJacobian {
                row,
                column,
                block_id,
                time_s,
            } => write!(
                f,
                "DAE Jacobian entry ({row}, {column}) for block {block_id} is not finite at t={time_s}"
            ),
            Self::NonsmoothJacobian {
                row,
                block_id,
                time_s,
                input_value,
                boundary,
            } => write!(
                f,
                "Limit block {block_id} in row {row} is at the nonsmooth boundary {boundary} (input {input_value}) at t={time_s}"
            ),
        }
    }
}

impl std::error::Error for DaeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Initialization(error) => Some(error),
            _ => None,
        }
    }
}

impl From<EquationError> for DaeError {
    fn from(value: EquationError) -> Self {
        Self::Initialization(value)
    }
}

/// A lowered residual contract over an immutable compiled graph.
///
/// Lowering and consistent initialization may allocate. CSC construction uses
/// work and storage linear in the variable and compiled-input counts plus the
/// resulting nonzeros. After lowering, `residual_into`,
/// `residual_event_left_limit_into`, `jacobian_values_into`, `outputs_into`,
/// and the buffer-copy methods allocate no heap memory on their success paths.
#[derive(Clone, Debug)]
pub struct DaeResidualSystem<'graph> {
    graph: &'graph CompiledGraph,
    initialization_time_s: f64,
    variables: Vec<DaeVariable>,
    outputs: Vec<DaeOutput>,
    events: Vec<DaeEvent>,
    block_to_variable: Vec<usize>,
    pattern: DaeCscPattern,
    id_vector: Vec<f64>,
    initial_y: Vec<f64>,
    initial_yp: Vec<f64>,
}

impl<'graph> DaeResidualSystem<'graph> {
    /// Lower a compiled graph and calculate consistent initial `y` and `yp`.
    /// Algebraic initialization uses the existing validated graph evaluator;
    /// no new solver or backend is selected here.
    pub fn lower(
        graph: &'graph CompiledGraph,
        initialization_time_s: f64,
        settings: &SolverSettings,
    ) -> Result<Self, DaeError> {
        if !initialization_time_s.is_finite() {
            return Err(DaeError::NonFiniteInput {
                input: DaeInput::InitializationTime,
                index: None,
            });
        }

        let blocks = graph.dae_blocks();
        let state_blocks = graph.dae_state_blocks();
        let algebraic_blocks = graph.dae_algebraic_blocks();
        let mut block_to_variable = vec![usize::MAX; blocks.len()];
        let mut variables = Vec::with_capacity(blocks.len());

        for (&block_id, kind) in state_blocks
            .iter()
            .zip(std::iter::repeat(DaeVariableKind::Differential))
            .chain(
                algebraic_blocks
                    .iter()
                    .zip(std::iter::repeat(DaeVariableKind::Algebraic)),
            )
        {
            let index = variables.len();
            let block = &blocks[block_id];
            block_to_variable[block_id] = index;
            variables.push(DaeVariable {
                index,
                block_id,
                name: block.name.clone(),
                quantity: block.output,
                kind,
            });
        }

        debug_assert!(block_to_variable.iter().all(|index| *index != usize::MAX));
        let outputs = blocks
            .iter()
            .enumerate()
            .map(|(block_id, block)| DaeOutput {
                index: block_id,
                block_id,
                variable_index: block_to_variable[block_id],
                name: block.name.clone(),
                quantity: block.output,
            })
            .collect::<Vec<_>>();
        let events = graph
            .dae_event_times_s()
            .iter()
            .copied()
            .enumerate()
            .map(|(index, time_s)| DaeEvent { index, time_s })
            .collect::<Vec<_>>();
        let pattern = build_csc_pattern(graph, &variables, &block_to_variable);
        let id_vector = variables
            .iter()
            .map(|variable| match variable.kind {
                DaeVariableKind::Differential => DAE_DIFFERENTIAL_ID,
                DaeVariableKind::Algebraic => DAE_ALGEBRAIC_ID,
            })
            .collect::<Vec<_>>();

        let state = graph.initial_state();
        let block_outputs = graph.evaluate(initialization_time_s, &state, settings)?;
        let mut initial_y = vec![0.0; variables.len()];
        for variable in &variables {
            let value = block_outputs[variable.block_id];
            if !value.is_finite() {
                return Err(DaeError::NonFiniteInput {
                    input: DaeInput::Y,
                    index: Some(variable.index),
                });
            }
            initial_y[variable.index] = value;
        }

        let mut initial_yp = vec![0.0; variables.len()];
        for variable in &variables {
            if variable.kind == DaeVariableKind::Differential {
                let value =
                    state_derivative(graph, variable.block_id, &initial_y, &block_to_variable);
                if !value.is_finite() {
                    return Err(DaeError::NonFiniteInput {
                        input: DaeInput::Yp,
                        index: Some(variable.index),
                    });
                }
                initial_yp[variable.index] = value;
            }
        }

        Ok(Self {
            graph,
            initialization_time_s,
            variables,
            outputs,
            events,
            block_to_variable,
            pattern,
            id_vector,
            initial_y,
            initial_yp,
        })
    }

    pub fn contract_version(&self) -> &'static str {
        DAE_RESIDUAL_CONTRACT_VERSION
    }

    /// Exact finite time used to calculate the stored consistent initial
    /// conditions. IEEE-754 signed zero is preserved.
    pub fn initialization_time_s(&self) -> f64 {
        self.initialization_time_s
    }

    pub fn variables(&self) -> &[DaeVariable] {
        &self.variables
    }

    pub fn outputs(&self) -> &[DaeOutput] {
        &self.outputs
    }

    pub fn events(&self) -> &[DaeEvent] {
        &self.events
    }

    pub fn csc_pattern(&self) -> &DaeCscPattern {
        &self.pattern
    }

    /// Numeric state identifiers in DAE-variable order: 1 for differential
    /// variables and 0 for algebraic variables.
    pub fn id_vector(&self) -> &[f64] {
        &self.id_vector
    }

    pub fn initial_y(&self) -> &[f64] {
        &self.initial_y
    }

    pub fn initial_yp(&self) -> &[f64] {
        &self.initial_yp
    }

    pub fn buffer_requirements(&self) -> DaeBufferRequirements {
        let variables = self.variables.len();
        DaeBufferRequirements {
            y: variables,
            yp: variables,
            id_vector: variables,
            residual: variables,
            jacobian_values: self.pattern.nonzero_count(),
            outputs: self.outputs.len(),
            event_times: self.events.len(),
        }
    }

    pub fn id_vector_into(&self, ids: &mut [f64]) -> Result<(), DaeError> {
        require_len(DaeBuffer::IdVector, self.id_vector.len(), ids.len())?;
        ids.copy_from_slice(&self.id_vector);
        Ok(())
    }

    /// Copy both initial-condition vectors atomically with respect to contract
    /// errors: both lengths are checked before either destination is written.
    pub fn initial_conditions_into(&self, y: &mut [f64], yp: &mut [f64]) -> Result<(), DaeError> {
        require_len(DaeBuffer::InitialY, self.initial_y.len(), y.len())?;
        require_len(DaeBuffer::InitialYp, self.initial_yp.len(), yp.len())?;
        y.copy_from_slice(&self.initial_y);
        yp.copy_from_slice(&self.initial_yp);
        Ok(())
    }

    pub fn event_times_into(&self, event_times: &mut [f64]) -> Result<(), DaeError> {
        require_len(DaeBuffer::EventTimes, self.events.len(), event_times.len())?;
        for (destination, event) in event_times.iter_mut().zip(&self.events) {
            *destination = event.time_s;
        }
        Ok(())
    }

    /// Evaluate `F(t, y, yp)` into an exact-size caller-owned buffer.
    /// Differential rows use `yp - f(t, y)` and algebraic rows use
    /// `y - rhs(t, y)`. All validation is completed before any write.
    pub fn residual_into(
        &self,
        time_s: f64,
        y: &[f64],
        yp: &[f64],
        residual: &mut [f64],
    ) -> Result<(), DaeError> {
        self.residual_with_step_continuity_into(
            time_s,
            StepContinuity::RightContinuous,
            y,
            yp,
            residual,
        )
    }

    /// Evaluate the residual immediately to the left of one scheduled event.
    /// At the selected event time, every simultaneous [`BlockKind::StepSource`]
    /// uses its `before` value. Sources scheduled earlier use `after`, and
    /// sources scheduled later use `before`. The ordinary [`Self::residual_into`]
    /// method remains right-continuous at event equality.
    pub fn residual_event_left_limit_into(
        &self,
        event_index: usize,
        y: &[f64],
        yp: &[f64],
        residual: &mut [f64],
    ) -> Result<(), DaeError> {
        let event = self
            .events
            .get(event_index)
            .ok_or(DaeError::InvalidEventIndex {
                event_index,
                event_count: self.events.len(),
            })?;
        self.residual_with_step_continuity_into(
            event.time_s,
            StepContinuity::LeftLimitAtEvent(event.time_s),
            y,
            yp,
            residual,
        )
    }

    fn residual_with_step_continuity_into(
        &self,
        time_s: f64,
        step_continuity: StepContinuity,
        y: &[f64],
        yp: &[f64],
        residual: &mut [f64],
    ) -> Result<(), DaeError> {
        self.preflight_evaluation(time_s, y, yp)?;
        require_len(DaeBuffer::Residual, self.variables.len(), residual.len())?;

        for row in 0..self.variables.len() {
            let value = self.residual_row(row, time_s, step_continuity, y, yp);
            if !value.is_finite() {
                return Err(DaeError::NonFiniteResidual {
                    row,
                    block_id: self.variables[row].block_id,
                    time_s,
                });
            }
        }
        for (row, destination) in residual.iter_mut().enumerate() {
            *destination = self.residual_row(row, time_s, step_continuity, y, yp);
        }
        Ok(())
    }

    /// Fill values for `dF/dy + cj*dF/dyp` using [`Self::csc_pattern`].
    /// Limit derivatives are `-1` strictly inside and `0` strictly outside
    /// the clamp range; an exact clamp boundary fails closed as nonsmooth.
    pub fn jacobian_values_into(
        &self,
        time_s: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        values: &mut [f64],
    ) -> Result<(), DaeError> {
        self.preflight_evaluation(time_s, y, yp)?;
        if !cj.is_finite() {
            return Err(DaeError::NonFiniteInput {
                input: DaeInput::Cj,
                index: None,
            });
        }
        require_len(
            DaeBuffer::JacobianValues,
            self.pattern.nonzero_count(),
            values.len(),
        )?;
        self.preflight_limit_jacobians(time_s, y)?;

        let mut value_index = 0;
        for column in 0..self.variables.len() {
            for pattern_index in
                self.pattern.column_pointers[column]..self.pattern.column_pointers[column + 1]
            {
                let row = self.pattern.row_indices[pattern_index];
                let value = self.jacobian_entry(row, column, cj, y);
                if !value.is_finite() {
                    return Err(DaeError::NonFiniteJacobian {
                        row,
                        column,
                        block_id: self.variables[row].block_id,
                        time_s,
                    });
                }
                value_index += 1;
            }
        }
        debug_assert_eq!(value_index, values.len());

        let mut value_index = 0;
        for column in 0..self.variables.len() {
            for pattern_index in
                self.pattern.column_pointers[column]..self.pattern.column_pointers[column + 1]
            {
                let row = self.pattern.row_indices[pattern_index];
                values[value_index] = self.jacobian_entry(row, column, cj, y);
                value_index += 1;
            }
        }
        Ok(())
    }

    /// Copy DAE variables to stable BlockId output order. All input validation
    /// and length checks happen before any destination write.
    pub fn outputs_into(&self, y: &[f64], outputs: &mut [f64]) -> Result<(), DaeError> {
        require_len(DaeBuffer::Y, self.variables.len(), y.len())?;
        require_len(DaeBuffer::Outputs, self.outputs.len(), outputs.len())?;
        require_finite(DaeInput::Y, y)?;
        for output in &self.outputs {
            outputs[output.index] = y[output.variable_index];
        }
        Ok(())
    }

    fn preflight_evaluation(&self, time_s: f64, y: &[f64], yp: &[f64]) -> Result<(), DaeError> {
        require_len(DaeBuffer::Y, self.variables.len(), y.len())?;
        require_len(DaeBuffer::Yp, self.variables.len(), yp.len())?;
        if !time_s.is_finite() {
            return Err(DaeError::NonFiniteInput {
                input: DaeInput::Time,
                index: None,
            });
        }
        require_finite(DaeInput::Y, y)?;
        require_finite(DaeInput::Yp, yp)
    }

    fn residual_row(
        &self,
        row: usize,
        time_s: f64,
        step_continuity: StepContinuity,
        y: &[f64],
        yp: &[f64],
    ) -> f64 {
        let variable = &self.variables[row];
        let block = &self.graph.dae_blocks()[variable.block_id];
        let input = |port: usize| {
            let source = self.graph.dae_inputs()[variable.block_id][port]
                .expect("compiled inputs are complete");
            y[self.block_to_variable[source]]
        };
        match block.kind {
            BlockKind::Integrator { gain, .. } => yp[row] - gain * input(0),
            BlockKind::FirstOrder { tau_s, .. } => yp[row] - (input(0) - y[row]) / tau_s,
            _ => y[row] - algebraic_rhs(block.kind, time_s, step_continuity, &input),
        }
    }

    fn preflight_limit_jacobians(&self, time_s: f64, y: &[f64]) -> Result<(), DaeError> {
        for variable in &self.variables {
            let block = &self.graph.dae_blocks()[variable.block_id];
            if let BlockKind::Limit { min, max } = block.kind {
                let source = self.graph.dae_inputs()[variable.block_id][0]
                    .expect("compiled inputs are complete");
                let input_value = y[self.block_to_variable[source]];
                let boundary = if input_value == min {
                    Some(min)
                } else if input_value == max {
                    Some(max)
                } else {
                    None
                };
                if let Some(boundary) = boundary {
                    return Err(DaeError::NonsmoothJacobian {
                        row: variable.index,
                        block_id: variable.block_id,
                        time_s,
                        input_value,
                        boundary,
                    });
                }
            }
        }
        Ok(())
    }

    fn jacobian_entry(&self, row: usize, column: usize, cj: f64, y: &[f64]) -> f64 {
        let variable = &self.variables[row];
        let block_id = variable.block_id;
        let block = &self.graph.dae_blocks()[block_id];
        let inputs = &self.graph.dae_inputs()[block_id];
        let input_column = |port: usize| {
            self.block_to_variable[inputs[port].expect("compiled inputs are complete")]
        };
        let input_value = |port: usize| y[input_column(port)];

        let mut value = 0.0;
        if row == column {
            value += match block.kind {
                BlockKind::Integrator { .. } => cj,
                BlockKind::FirstOrder { tau_s, .. } => cj + 1.0 / tau_s,
                _ => 1.0,
            };
        }
        match block.kind {
            BlockKind::Constant { .. } | BlockKind::StepSource { .. } => {}
            BlockKind::Gain { gain, .. } => {
                if column == input_column(0) {
                    value -= gain;
                }
            }
            BlockKind::Sum { inputs: count } => {
                for port in 0..count {
                    if column == input_column(port) {
                        value -= 1.0;
                    }
                }
            }
            BlockKind::Product { scale, .. } => {
                if column == input_column(0) {
                    value -= scale * input_value(1);
                }
                if column == input_column(1) {
                    value -= scale * input_value(0);
                }
            }
            BlockKind::Limit { min, max } => {
                if column == input_column(0) {
                    let input = input_value(0);
                    if input > min && input < max {
                        value -= 1.0;
                    }
                }
            }
            BlockKind::ThermalRate {
                heat_capacity_j_per_k,
                conductance_w_per_k,
            } => {
                if column == input_column(0) {
                    value -= 1.0 / heat_capacity_j_per_k;
                }
                if column == input_column(1) {
                    value += conductance_w_per_k / heat_capacity_j_per_k;
                }
                if column == input_column(2) {
                    value -= conductance_w_per_k / heat_capacity_j_per_k;
                }
            }
            BlockKind::Integrator { gain, .. } => {
                if column == input_column(0) {
                    value -= gain;
                }
            }
            BlockKind::FirstOrder { tau_s, .. } => {
                if column == input_column(0) {
                    value -= 1.0 / tau_s;
                }
            }
        }
        value
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum StepContinuity {
    RightContinuous,
    LeftLimitAtEvent(f64),
}

fn require_len(buffer: DaeBuffer, expected: usize, actual: usize) -> Result<(), DaeError> {
    if actual != expected {
        return Err(DaeError::BufferLength {
            buffer,
            expected,
            actual,
        });
    }
    Ok(())
}

fn require_finite(input: DaeInput, values: &[f64]) -> Result<(), DaeError> {
    if let Some(index) = values.iter().position(|value| !value.is_finite()) {
        return Err(DaeError::NonFiniteInput {
            input,
            index: Some(index),
        });
    }
    Ok(())
}

fn build_csc_pattern(
    graph: &CompiledGraph,
    variables: &[DaeVariable],
    block_to_variable: &[usize],
) -> DaeCscPattern {
    build_csc_pattern_with_observer(graph, variables, block_to_variable, &mut IgnoreCscBuildWork)
}

trait CscBuildWorkObserver {
    #[inline]
    fn allocation(&mut self, _requested_elements: usize) {}

    #[inline]
    fn row_visit(&mut self) {}

    #[inline]
    fn dependency_candidate(&mut self) {}

    #[inline]
    fn unique_dependency(&mut self) {}

    #[inline]
    fn fill_writes(&mut self, _count: usize) {}
}

struct IgnoreCscBuildWork;

impl CscBuildWorkObserver for IgnoreCscBuildWork {}

fn for_each_unique_row_dependency(
    graph: &CompiledGraph,
    variable: &DaeVariable,
    block_to_variable: &[usize],
    seen_in_row: &mut [usize],
    observer: &mut impl CscBuildWorkObserver,
    mut visit: impl FnMut(usize),
) {
    let row = variable.index;
    observer.row_visit();
    let mut consider = |column: usize| {
        observer.dependency_candidate();
        if seen_in_row[column] != row {
            seen_in_row[column] = row;
            observer.unique_dependency();
            visit(column);
        }
    };

    // Every residual row has its own y/cj diagonal term. A source connected
    // to several ports is deliberately considered several times but admitted
    // once; jacobian_entry still accumulates every port's numeric derivative.
    consider(row);
    for source in graph.dae_inputs()[variable.block_id].iter().flatten() {
        consider(block_to_variable[*source]);
    }
}

fn build_csc_pattern_with_observer(
    graph: &CompiledGraph,
    variables: &[DaeVariable],
    block_to_variable: &[usize],
    observer: &mut impl CscBuildWorkObserver,
) -> DaeCscPattern {
    let variable_count = variables.len();

    // Pass one counts each structural (row, column) coordinate exactly once.
    // The row number is a generation marker, avoiding a clear or allocation
    // for every row even when several input ports share one source column.
    observer.allocation(variable_count);
    let mut column_counts = vec![0_usize; variable_count];
    observer.allocation(variable_count);
    let mut seen_in_row = vec![usize::MAX; variable_count];
    for variable in variables {
        for_each_unique_row_dependency(
            graph,
            variable,
            block_to_variable,
            &mut seen_in_row,
            observer,
            |column| column_counts[column] += 1,
        );
    }

    observer.allocation(variable_count + 1);
    let mut column_pointers = Vec::<usize>::with_capacity(variable_count + 1);
    column_pointers.push(0);
    for count in &column_counts {
        let next = column_pointers
            .last()
            .copied()
            .expect("CSC always has an initial pointer")
            .checked_add(*count)
            .expect("CSC nonzero count fits usize");
        column_pointers.push(next);
    }

    let nonzero_count = *column_pointers
        .last()
        .expect("CSC always has a terminal pointer");
    observer.allocation(nonzero_count);
    let mut row_indices = vec![0_usize; nonzero_count];

    // Reuse the count buffer as per-column write cursors. Processing rows in
    // increasing variable order makes each column strictly row-sorted without
    // a sort, and the same generation markers prevent duplicate coordinates.
    column_counts.copy_from_slice(&column_pointers[..variable_count]);
    seen_in_row.fill(usize::MAX);
    for variable in variables {
        for_each_unique_row_dependency(
            graph,
            variable,
            block_to_variable,
            &mut seen_in_row,
            observer,
            |column| {
                let destination = column_counts[column];
                row_indices[destination] = variable.index;
                column_counts[column] += 1;
            },
        );
    }
    observer.fill_writes(nonzero_count);

    debug_assert!(column_counts
        .iter()
        .zip(&column_pointers[1..])
        .all(|(cursor, end)| cursor == end));

    DaeCscPattern {
        column_pointers,
        row_indices,
    }
}

fn state_derivative(
    graph: &CompiledGraph,
    block_id: BlockId,
    y: &[f64],
    block_to_variable: &[usize],
) -> f64 {
    let block = &graph.dae_blocks()[block_id];
    let input = |port: usize| {
        let source = graph.dae_inputs()[block_id][port].expect("compiled inputs are complete");
        y[block_to_variable[source]]
    };
    match block.kind {
        BlockKind::Integrator { gain, .. } => gain * input(0),
        BlockKind::FirstOrder { tau_s, .. } => {
            let own = y[block_to_variable[block_id]];
            (input(0) - own) / tau_s
        }
        _ => unreachable!("compiled state list contains only continuous blocks"),
    }
}

fn algebraic_rhs(
    kind: BlockKind,
    time_s: f64,
    step_continuity: StepContinuity,
    input: &impl Fn(usize) -> f64,
) -> f64 {
    match kind {
        BlockKind::Constant { value } => value,
        BlockKind::StepSource {
            before,
            after,
            at_s,
        } => {
            let selected_event_left_limit = matches!(
                step_continuity,
                StepContinuity::LeftLimitAtEvent(event_time_s) if at_s == event_time_s
            );
            if time_s < at_s || selected_event_left_limit {
                before
            } else {
                after
            }
        }
        BlockKind::Gain { gain, .. } => gain * input(0),
        BlockKind::Sum { inputs } => (0..inputs).map(input).sum(),
        BlockKind::Product { scale, .. } => scale * input(0) * input(1),
        BlockKind::Limit { min, max } => input(0).clamp(min, max),
        BlockKind::ThermalRate {
            heat_capacity_j_per_k,
            conductance_w_per_k,
        } => (input(0) - conductance_w_per_k * (input(1) - input(2))) / heat_capacity_j_per_k,
        BlockKind::Integrator { .. } | BlockKind::FirstOrder { .. } => {
            unreachable!("stateful blocks have differential residual rows")
        }
    }
}

#[cfg(test)]
mod csc_build_tests {
    use super::*;
    use crate::equations::{Block, EquationGraph};

    #[derive(Default)]
    struct MeasuredCscBuildWork {
        allocation_requests: usize,
        requested_elements: usize,
        row_visits: usize,
        dependency_candidates: usize,
        unique_dependencies: usize,
        fill_writes: usize,
    }

    impl CscBuildWorkObserver for MeasuredCscBuildWork {
        fn allocation(&mut self, requested_elements: usize) {
            self.allocation_requests += 1;
            self.requested_elements += requested_elements;
        }

        fn row_visit(&mut self) {
            self.row_visits += 1;
        }

        fn dependency_candidate(&mut self) {
            self.dependency_candidates += 1;
        }

        fn unique_dependency(&mut self) {
            self.unique_dependencies += 1;
        }

        fn fill_writes(&mut self, count: usize) {
            self.fill_writes += count;
        }
    }

    fn algebraic_chain(variable_count: usize) -> CompiledGraph {
        let mut graph = EquationGraph::new();
        let mut previous = graph
            .add_block(Block::new(
                "chain 0",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 1.0 },
            ))
            .unwrap();
        for index in 1..variable_count {
            let current = graph
                .add_block(Block::new(
                    format!("chain {index}"),
                    Quantity::Dimensionless,
                    BlockKind::Gain {
                        gain: 1.0,
                        input: Quantity::Dimensionless,
                    },
                ))
                .unwrap();
            graph.connect(previous, current, 0).unwrap();
            previous = current;
        }
        graph.compile().unwrap()
    }

    #[test]
    fn measured_csc_builder_has_exact_linear_work_and_four_bounded_allocations() {
        for variable_count in [1_000, 10_000] {
            let graph = algebraic_chain(variable_count);
            let settings = SolverSettings {
                end_s: 0.0,
                ..SolverSettings::default()
            };
            let system = DaeResidualSystem::lower(&graph, 0.0, &settings).unwrap();
            let edge_count = variable_count - 1;
            let nonzero_count = 2 * variable_count - 1;
            let mut work = MeasuredCscBuildWork::default();
            let measured = build_csc_pattern_with_observer(
                &graph,
                &system.variables,
                &system.block_to_variable,
                &mut work,
            );

            assert_eq!(measured, system.pattern);
            assert_eq!(work.allocation_requests, 4);
            assert_eq!(
                work.requested_elements,
                3 * variable_count + 1 + nonzero_count
            );
            assert_eq!(work.row_visits, 2 * variable_count);
            assert_eq!(
                work.dependency_candidates,
                2 * (variable_count + edge_count)
            );
            assert_eq!(work.unique_dependencies, 2 * nonzero_count);
            assert_eq!(work.fill_writes, nonzero_count);
        }
    }
}
