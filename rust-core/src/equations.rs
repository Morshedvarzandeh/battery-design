//! Typed block graphs and the first authoritative equation-solver backend.
//!
//! This module deliberately starts with a small, auditable numerical surface:
//! signal blocks, continuous states, finite-dimensional algebraic loops,
//! deterministic time events and adaptive Dormand-Prince integration.  It is
//! not an FMI master or a substitute for a large sparse DAE package yet.  The
//! public types are the stable boundary those backends can implement later.

use std::fmt;

pub type BlockId = usize;

/// The built-in implicit path uses dense finite-difference Jacobians. Larger
/// models must use a future validated sparse backend rather than fail slowly.
pub const DENSE_IMPLICIT_STATE_LIMIT: usize = 64;

/// Quantities carried by ports.  Connections require an exact match; implicit
/// unit conversion is intentionally forbidden at this layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quantity {
    Dimensionless,
    Fraction,
    FractionPerSecond,
    VoltageV,
    CurrentA,
    PowerW,
    EnergyJ,
    TemperatureK,
    TemperatureRateKPerSecond,
    HeatFlowW,
    SpeedRadPerSecond,
    TorqueNm,
}

#[derive(Clone, Copy, Debug)]
pub enum BlockKind {
    Constant {
        value: f64,
    },
    StepSource {
        before: f64,
        after: f64,
        at_s: f64,
    },
    Gain {
        gain: f64,
        input: Quantity,
    },
    Sum {
        inputs: usize,
    },
    Product {
        scale: f64,
        left: Quantity,
        right: Quantity,
    },
    Limit {
        min: f64,
        max: f64,
    },
    /// `dx/dt = gain * input`.  The rate quantity is explicit so an energy
    /// state can accept power while a temperature state accepts K/s.
    Integrator {
        initial: f64,
        rate: Quantity,
        gain: f64,
    },
    /// `dx/dt = (input - x) / tau_s`.
    FirstOrder {
        tau_s: f64,
        initial: f64,
    },
    /// Lumped thermal balance:
    /// `dT/dt = (heat - conductance * (T - ambient)) / capacity`.
    ThermalRate {
        heat_capacity_j_per_k: f64,
        conductance_w_per_k: f64,
    },
}

impl BlockKind {
    fn input_count(&self) -> usize {
        match self {
            Self::Constant { .. } | Self::StepSource { .. } => 0,
            Self::Gain { .. }
            | Self::Limit { .. }
            | Self::Integrator { .. }
            | Self::FirstOrder { .. } => 1,
            Self::Product { .. } => 2,
            Self::Sum { inputs } => *inputs,
            Self::ThermalRate { .. } => 3,
        }
    }

    fn input_quantity(&self, output: Quantity, port: usize) -> Option<Quantity> {
        match self {
            Self::Constant { .. } | Self::StepSource { .. } => None,
            Self::Gain { input, .. } if port == 0 => Some(*input),
            Self::Sum { inputs } if port < *inputs => Some(output),
            Self::Product { left, .. } if port == 0 => Some(*left),
            Self::Product { right, .. } if port == 1 => Some(*right),
            Self::Limit { .. } if port == 0 => Some(output),
            Self::Integrator { rate, .. } if port == 0 => Some(*rate),
            Self::FirstOrder { .. } if port == 0 => Some(output),
            Self::ThermalRate { .. } if port == 0 => Some(Quantity::HeatFlowW),
            Self::ThermalRate { .. } if port == 1 || port == 2 => {
                Some(Quantity::TemperatureK)
            }
            _ => None,
        }
    }

    fn is_stateful(&self) -> bool {
        matches!(self, Self::Integrator { .. } | Self::FirstOrder { .. })
    }

    fn initial_state(&self) -> Option<f64> {
        match self {
            Self::Integrator { initial, .. } | Self::FirstOrder { initial, .. } => Some(*initial),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Block {
    pub name: String,
    pub output: Quantity,
    pub kind: BlockKind,
}

impl Block {
    pub fn new(name: impl Into<String>, output: Quantity, kind: BlockKind) -> Self {
        Self {
            name: name.into(),
            output,
            kind,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Connection {
    pub from: BlockId,
    pub to: BlockId,
    pub to_port: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EquationError {
    EmptyGraph,
    DuplicateBlockName(String),
    UnknownBlock(BlockId),
    InvalidPort {
        block: String,
        port: usize,
    },
    DuplicateConnection {
        block: String,
        port: usize,
    },
    MissingInput {
        block: String,
        port: usize,
    },
    QuantityMismatch {
        from: String,
        from_quantity: Quantity,
        to: String,
        expected: Quantity,
    },
    InvalidParameter {
        block: String,
        parameter: &'static str,
    },
    InvalidSettings(&'static str),
    StateSize {
        expected: usize,
        actual: usize,
    },
    NonFiniteValue {
        block: String,
        time_s: f64,
    },
    SingularAlgebraicSystem {
        time_s: f64,
    },
    AlgebraicNonConvergence {
        time_s: f64,
        residual: f64,
    },
    ImplicitNonConvergence {
        time_s: f64,
        residual: f64,
    },
    ImplicitStateLimit {
        states: usize,
        maximum: usize,
    },
    StepUnderflow {
        time_s: f64,
    },
    MaxStepsExceeded,
}

impl fmt::Display for EquationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyGraph => write!(f, "an equation graph must contain at least one block"),
            Self::DuplicateBlockName(name) => write!(f, "duplicate block name: {name}"),
            Self::UnknownBlock(id) => write!(f, "unknown block id: {id}"),
            Self::InvalidPort { block, port } => write!(f, "{block} has no input port {port}"),
            Self::DuplicateConnection { block, port } => {
                write!(f, "{block} input port {port} is connected more than once")
            }
            Self::MissingInput { block, port } => {
                write!(f, "{block} input port {port} is not connected")
            }
            Self::QuantityMismatch {
                from,
                from_quantity,
                to,
                expected,
            } => write!(
                f,
                "{from} carries {from_quantity:?}, but {to} requires {expected:?}"
            ),
            Self::InvalidParameter { block, parameter } => {
                write!(f, "{block} has an invalid {parameter}")
            }
            Self::InvalidSettings(name) => write!(f, "invalid solver setting: {name}"),
            Self::StateSize { expected, actual } => {
                write!(f, "expected {expected} states, received {actual}")
            }
            Self::NonFiniteValue { block, time_s } => {
                write!(f, "{block} produced a non-finite value at t={time_s}")
            }
            Self::SingularAlgebraicSystem { time_s } => {
                write!(f, "the algebraic system is singular at t={time_s}")
            }
            Self::AlgebraicNonConvergence { time_s, residual } => write!(
                f,
                "the algebraic system did not converge at t={time_s}; residual={residual}"
            ),
            Self::ImplicitNonConvergence { time_s, residual } => write!(
                f,
                "the implicit state solve did not converge at t={time_s}; residual={residual}"
            ),
            Self::ImplicitStateLimit { states, maximum } => write!(
                f,
                "the dense implicit backend supports at most {maximum} states; model has {states}"
            ),
            Self::StepUnderflow { time_s } => {
                write!(f, "adaptive integration reached its minimum step at t={time_s}")
            }
            Self::MaxStepsExceeded => write!(f, "the solver exceeded its step limit"),
        }
    }
}

impl std::error::Error for EquationError {}

impl EquationError {
    /// Stable machine-readable code for UI, API and AI-assisted diagnostics.
    /// Callers must branch on this code rather than parse the Display text.
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyGraph => "graph.empty",
            Self::DuplicateBlockName(_) => "graph.duplicate_block_name",
            Self::UnknownBlock(_) => "graph.unknown_block",
            Self::InvalidPort { .. } => "connection.invalid_port",
            Self::DuplicateConnection { .. } => "connection.duplicate_input",
            Self::MissingInput { .. } => "connection.missing_input",
            Self::QuantityMismatch { .. } => "connection.quantity_mismatch",
            Self::InvalidParameter { .. } => "block.invalid_parameter",
            Self::InvalidSettings(_) => "solver.invalid_settings",
            Self::StateSize { .. } => "solver.state_size",
            Self::NonFiniteValue { .. } => "solver.non_finite_value",
            Self::SingularAlgebraicSystem { .. } => "solver.singular_algebraic_loop",
            Self::AlgebraicNonConvergence { .. } => "solver.algebraic_non_convergence",
            Self::ImplicitNonConvergence { .. } => "solver.implicit_non_convergence",
            Self::ImplicitStateLimit { .. } => "solver.implicit_state_limit",
            Self::StepUnderflow { .. } => "solver.step_underflow",
            Self::MaxStepsExceeded => "solver.max_steps_exceeded",
        }
    }

    /// Conservative next action suitable for a guided error panel. These are
    /// explanations, not automatic mutations: a human still approves changes.
    pub fn suggested_action(&self) -> &'static str {
        match self {
            Self::EmptyGraph => "Add an approved source or component block before simulation.",
            Self::DuplicateBlockName(_) => "Give every block a unique, descriptive name.",
            Self::UnknownBlock(_) => "Reconnect the wire to a block that exists in this model version.",
            Self::InvalidPort { .. } => "Choose an available input port on the destination block.",
            Self::DuplicateConnection { .. } => "Keep one wire on this input or insert an approved Sum block.",
            Self::MissingInput { .. } => "Connect the required input or explicitly remove the unused block.",
            Self::QuantityMismatch { .. } => "Use a compatible port or insert an explicit, unit-reviewed conversion block.",
            Self::InvalidParameter { .. } => "Restore the parameter to its sourced operating range and validate again.",
            Self::InvalidSettings(_) => "Restore the validated solver preset before running again.",
            Self::StateSize { .. } => "Reinitialize the simulation from the current compiled model version.",
            Self::NonFiniteValue { .. } => "Inspect the named block for invalid data, division by zero or an exceeded operating range.",
            Self::SingularAlgebraicSystem { .. } => "Inspect the highlighted feedback loop for redundant equations or a missing physical constraint.",
            Self::AlgebraicNonConvergence { .. } => "Review discontinuities and feedback-loop initialization; do not loosen tolerances silently.",
            Self::ImplicitNonConvergence { .. } => "Review state initialization and discontinuities, then retry with a smaller validated initial step.",
            Self::ImplicitStateLimit { .. } => "Partition the model or use a validated sparse implicit backend; do not force this dense solver.",
            Self::StepUnderflow { .. } => "Inspect the event or fastest state at this time before changing the minimum step.",
            Self::MaxStepsExceeded => "Inspect stiffness, repeated events and the requested duration before increasing the step limit.",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct EquationGraph {
    blocks: Vec<Block>,
    connections: Vec<Connection>,
}

impl EquationGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_block(&mut self, block: Block) -> Result<BlockId, EquationError> {
        if self.blocks.iter().any(|existing| existing.name == block.name) {
            return Err(EquationError::DuplicateBlockName(block.name));
        }
        validate_block(&block)?;
        let id = self.blocks.len();
        self.blocks.push(block);
        Ok(id)
    }

    pub fn connect(
        &mut self,
        from: BlockId,
        to: BlockId,
        to_port: usize,
    ) -> Result<(), EquationError> {
        let source = self
            .blocks
            .get(from)
            .ok_or(EquationError::UnknownBlock(from))?;
        let target = self.blocks.get(to).ok_or(EquationError::UnknownBlock(to))?;
        let expected = target
            .kind
            .input_quantity(target.output, to_port)
            .ok_or_else(|| EquationError::InvalidPort {
                block: target.name.clone(),
                port: to_port,
            })?;
        if source.output != expected {
            return Err(EquationError::QuantityMismatch {
                from: source.name.clone(),
                from_quantity: source.output,
                to: target.name.clone(),
                expected,
            });
        }
        self.connections.push(Connection { from, to, to_port });
        Ok(())
    }

    pub fn compile(self) -> Result<CompiledGraph, EquationError> {
        if self.blocks.is_empty() {
            return Err(EquationError::EmptyGraph);
        }

        let mut inputs = self
            .blocks
            .iter()
            .map(|block| vec![None; block.kind.input_count()])
            .collect::<Vec<_>>();
        for connection in &self.connections {
            let target = self
                .blocks
                .get(connection.to)
                .ok_or(EquationError::UnknownBlock(connection.to))?;
            let slot = inputs[connection.to]
                .get_mut(connection.to_port)
                .ok_or_else(|| EquationError::InvalidPort {
                    block: target.name.clone(),
                    port: connection.to_port,
                })?;
            if slot.replace(connection.from).is_some() {
                return Err(EquationError::DuplicateConnection {
                    block: target.name.clone(),
                    port: connection.to_port,
                });
            }
        }
        for (block_id, block_inputs) in inputs.iter().enumerate() {
            for (port, source) in block_inputs.iter().enumerate() {
                if source.is_none() {
                    return Err(EquationError::MissingInput {
                        block: self.blocks[block_id].name.clone(),
                        port,
                    });
                }
            }
        }

        let state_blocks = self
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(id, block)| block.kind.is_stateful().then_some(id))
            .collect::<Vec<_>>();
        let algebraic_blocks = self
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(id, block)| (!block.kind.is_stateful()).then_some(id))
            .collect::<Vec<_>>();
        let algebraic_order = topological_algebraic_order(
            &self.blocks,
            &inputs,
            &algebraic_blocks,
        );
        let has_algebraic_loop = algebraic_order.is_none();
        let mut event_times_s = self
            .blocks
            .iter()
            .filter_map(|block| match block.kind {
                BlockKind::StepSource { at_s, .. } => Some(at_s),
                _ => None,
            })
            .collect::<Vec<_>>();
        event_times_s.sort_by(|a, b| a.total_cmp(b));
        event_times_s.dedup_by(|a, b| (*a - *b).abs() <= 1e-12);

        Ok(CompiledGraph {
            blocks: self.blocks,
            connections: self.connections,
            inputs,
            state_blocks,
            algebraic_blocks,
            algebraic_order,
            has_algebraic_loop,
            event_times_s,
        })
    }
}

fn validate_block(block: &Block) -> Result<(), EquationError> {
    if block.name.trim().is_empty() {
        return Err(EquationError::InvalidParameter {
            block: block.name.clone(),
            parameter: "name",
        });
    }
    let invalid = |parameter| EquationError::InvalidParameter {
        block: block.name.clone(),
        parameter,
    };
    match block.kind {
        BlockKind::Constant { value } if !value.is_finite() => return Err(invalid("value")),
        BlockKind::StepSource {
            before,
            after,
            at_s,
        } if !before.is_finite() || !after.is_finite() || !at_s.is_finite() => {
            return Err(invalid("step source"));
        }
        BlockKind::Gain { gain, .. } if !gain.is_finite() => return Err(invalid("gain")),
        BlockKind::Sum { inputs } if inputs == 0 => return Err(invalid("input count")),
        BlockKind::Product { scale, .. } if !scale.is_finite() => {
            return Err(invalid("scale"));
        }
        BlockKind::Limit { min, max }
            if !min.is_finite() || !max.is_finite() || min > max =>
        {
            return Err(invalid("limits"));
        }
        BlockKind::Integrator { initial, gain, .. }
            if !initial.is_finite() || !gain.is_finite() =>
        {
            return Err(invalid("integrator"));
        }
        BlockKind::FirstOrder { tau_s, initial }
            if !tau_s.is_finite() || tau_s <= 0.0 || !initial.is_finite() =>
        {
            return Err(invalid("first-order state"));
        }
        BlockKind::ThermalRate {
            heat_capacity_j_per_k,
            conductance_w_per_k,
        } if !heat_capacity_j_per_k.is_finite()
            || heat_capacity_j_per_k <= 0.0
            || !conductance_w_per_k.is_finite()
            || conductance_w_per_k < 0.0 =>
        {
            return Err(invalid("thermal coefficients"));
        }
        _ => {}
    }
    if matches!(block.kind, BlockKind::ThermalRate { .. })
        && block.output != Quantity::TemperatureRateKPerSecond
    {
        return Err(invalid("thermal-rate output quantity"));
    }
    Ok(())
}

fn topological_algebraic_order(
    blocks: &[Block],
    inputs: &[Vec<Option<BlockId>>],
    algebraic_blocks: &[BlockId],
) -> Option<Vec<BlockId>> {
    let mut indegree = vec![0_usize; blocks.len()];
    let mut outgoing = vec![Vec::<BlockId>::new(); blocks.len()];
    for &target in algebraic_blocks {
        for &source in inputs[target].iter().flatten() {
            if !blocks[source].kind.is_stateful() {
                indegree[target] += 1;
                outgoing[source].push(target);
            }
        }
    }
    let mut ready = algebraic_blocks
        .iter()
        .copied()
        .filter(|id| indegree[*id] == 0)
        .collect::<Vec<_>>();
    ready.reverse();
    let mut order = Vec::with_capacity(algebraic_blocks.len());
    while let Some(source) = ready.pop() {
        order.push(source);
        for &target in &outgoing[source] {
            indegree[target] -= 1;
            if indegree[target] == 0 {
                ready.push(target);
            }
        }
    }
    (order.len() == algebraic_blocks.len()).then_some(order)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegrationMethod {
    /// Select from the compiled graph and requested time horizon, then record
    /// the decision in the result. Auto never changes tolerances.
    Auto,
    /// Adaptive Dormand-Prince 5(4), suited to non-stiff continuous models.
    DormandPrince45,
    /// Adaptive backward Euler with damped Newton state solves and step
    /// doubling. This is a robust first implicit path, not an IDA/BDF claim.
    BackwardEuler,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolverDecisionReason {
    UserSelected,
    NoContinuousStates,
    NonStiffTimeScales,
    SeparatedTimeScales,
    FastStateForRequestedHorizon,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SolverDecision {
    pub requested: IntegrationMethod,
    pub selected: IntegrationMethod,
    pub reason: SolverDecisionReason,
    pub fastest_time_constant_s: Option<f64>,
    pub slowest_time_constant_s: Option<f64>,
    pub time_scale_ratio: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SolverSettings {
    pub method: IntegrationMethod,
    pub start_s: f64,
    pub end_s: f64,
    pub initial_step_s: f64,
    pub min_step_s: f64,
    pub max_step_s: f64,
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_steps: usize,
    pub algebraic_tolerance: f64,
    pub algebraic_max_iterations: usize,
    pub implicit_tolerance: f64,
    pub implicit_max_iterations: usize,
}

impl Default for SolverSettings {
    fn default() -> Self {
        Self {
            method: IntegrationMethod::Auto,
            start_s: 0.0,
            end_s: 10.0,
            initial_step_s: 0.01,
            min_step_s: 1e-9,
            max_step_s: 0.25,
            relative_tolerance: 1e-6,
            absolute_tolerance: 1e-9,
            max_steps: 100_000,
            algebraic_tolerance: 1e-10,
            algebraic_max_iterations: 30,
            implicit_tolerance: 1e-10,
            implicit_max_iterations: 20,
        }
    }
}

impl SolverSettings {
    fn validate(&self) -> Result<(), EquationError> {
        for (name, value) in [
            ("start_s", self.start_s),
            ("end_s", self.end_s),
            ("initial_step_s", self.initial_step_s),
            ("min_step_s", self.min_step_s),
            ("max_step_s", self.max_step_s),
            ("relative_tolerance", self.relative_tolerance),
            ("absolute_tolerance", self.absolute_tolerance),
            ("algebraic_tolerance", self.algebraic_tolerance),
            ("implicit_tolerance", self.implicit_tolerance),
        ] {
            if !value.is_finite() {
                return Err(EquationError::InvalidSettings(name));
            }
        }
        if self.end_s < self.start_s {
            return Err(EquationError::InvalidSettings("end_s"));
        }
        if self.initial_step_s <= 0.0
            || self.min_step_s <= 0.0
            || self.max_step_s < self.min_step_s
            || self.relative_tolerance <= 0.0
            || self.absolute_tolerance <= 0.0
            || self.algebraic_tolerance <= 0.0
            || self.implicit_tolerance <= 0.0
            || self.max_steps == 0
            || self.algebraic_max_iterations == 0
            || self.implicit_max_iterations == 0
        {
            return Err(EquationError::InvalidSettings("non-positive limit"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphSummary {
    pub blocks: usize,
    pub connections: usize,
    pub states: usize,
    pub algebraic_variables: usize,
    pub events: usize,
    pub has_algebraic_loop: bool,
}

#[derive(Clone, Debug)]
pub struct TracePoint {
    pub time_s: f64,
    /// One value per block, in stable `BlockId` order.
    pub values: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct SimulationResult {
    pub points: Vec<TracePoint>,
    pub accepted_steps: usize,
    pub rejected_steps: usize,
    pub nonlinear_iterations: usize,
    pub solver: SolverDecision,
    pub summary: GraphSummary,
}

impl SimulationResult {
    pub fn last_value(&self, block: BlockId) -> Option<f64> {
        self.points.last()?.values.get(block).copied()
    }
}

#[derive(Clone, Debug)]
pub struct CompiledGraph {
    blocks: Vec<Block>,
    connections: Vec<Connection>,
    inputs: Vec<Vec<Option<BlockId>>>,
    state_blocks: Vec<BlockId>,
    algebraic_blocks: Vec<BlockId>,
    algebraic_order: Option<Vec<BlockId>>,
    has_algebraic_loop: bool,
    event_times_s: Vec<f64>,
}

impl CompiledGraph {
    pub fn summary(&self) -> GraphSummary {
        GraphSummary {
            blocks: self.blocks.len(),
            connections: self.connections.len(),
            states: self.state_blocks.len(),
            algebraic_variables: self.algebraic_blocks.len(),
            events: self.event_times_s.len(),
            has_algebraic_loop: self.has_algebraic_loop,
        }
    }

    pub fn block_id(&self, name: &str) -> Option<BlockId> {
        self.blocks.iter().position(|block| block.name == name)
    }

    pub fn block(&self, id: BlockId) -> Option<&Block> {
        self.blocks.get(id)
    }

    pub fn initial_state(&self) -> Vec<f64> {
        self.state_blocks
            .iter()
            .filter_map(|id| self.blocks[*id].kind.initial_state())
            .collect()
    }

    pub fn evaluate(
        &self,
        time_s: f64,
        state: &[f64],
        settings: &SolverSettings,
    ) -> Result<Vec<f64>, EquationError> {
        settings.validate()?;
        self.outputs_at(time_s, state, settings)
    }

    /// Recommend a method without mutating the user's settings. The complete
    /// decision is returned with every simulation for review and replay.
    pub fn recommend_solver(&self, settings: &SolverSettings) -> SolverDecision {
        let mut time_constants = self
            .state_blocks
            .iter()
            .filter_map(|block_id| match self.blocks[*block_id].kind {
                BlockKind::FirstOrder { tau_s, .. } => Some(tau_s),
                _ => None,
            })
            .collect::<Vec<_>>();
        time_constants.sort_by(|a, b| a.total_cmp(b));
        let fastest = time_constants.first().copied();
        let slowest = time_constants.last().copied();
        let ratio = fastest.zip(slowest).map(|(fast, slow)| slow / fast);

        if settings.method != IntegrationMethod::Auto {
            return SolverDecision {
                requested: settings.method,
                selected: settings.method,
                reason: SolverDecisionReason::UserSelected,
                fastest_time_constant_s: fastest,
                slowest_time_constant_s: slowest,
                time_scale_ratio: ratio,
            };
        }

        let horizon_s = (settings.end_s - settings.start_s).max(0.0);
        let (selected, reason) = if self.state_blocks.is_empty() {
            (
                IntegrationMethod::DormandPrince45,
                SolverDecisionReason::NoContinuousStates,
            )
        } else if ratio.is_some_and(|value| value >= 1_000.0) {
            (
                IntegrationMethod::BackwardEuler,
                SolverDecisionReason::SeparatedTimeScales,
            )
        } else if fastest.is_some_and(|tau_s| horizon_s / tau_s >= 10_000.0) {
            (
                IntegrationMethod::BackwardEuler,
                SolverDecisionReason::FastStateForRequestedHorizon,
            )
        } else {
            (
                IntegrationMethod::DormandPrince45,
                SolverDecisionReason::NonStiffTimeScales,
            )
        };
        SolverDecision {
            requested: IntegrationMethod::Auto,
            selected,
            reason,
            fastest_time_constant_s: fastest,
            slowest_time_constant_s: slowest,
            time_scale_ratio: ratio,
        }
    }

    pub fn simulate(&self, settings: SolverSettings) -> Result<SimulationResult, EquationError> {
        settings.validate()?;
        let summary = self.summary();
        let solver = self.recommend_solver(&settings);
        if solver.selected == IntegrationMethod::BackwardEuler
            && self.state_blocks.len() > DENSE_IMPLICIT_STATE_LIMIT
        {
            return Err(EquationError::ImplicitStateLimit {
                states: self.state_blocks.len(),
                maximum: DENSE_IMPLICIT_STATE_LIMIT,
            });
        }
        let mut state = self.initial_state();
        let mut time_s = settings.start_s;
        let mut points = vec![TracePoint {
            time_s,
            values: self.outputs_at(time_s, &state, &settings)?,
        }];

        if settings.end_s == settings.start_s {
            return Ok(SimulationResult {
                points,
                accepted_steps: 0,
                rejected_steps: 0,
                nonlinear_iterations: 0,
                solver,
                summary,
            });
        }

        if state.is_empty() {
            for &event_s in &self.event_times_s {
                if event_s > settings.start_s && event_s < settings.end_s {
                    points.push(TracePoint {
                        time_s: event_s,
                        values: self.outputs_at(event_s, &state, &settings)?,
                    });
                }
            }
            points.push(TracePoint {
                time_s: settings.end_s,
                values: self.outputs_at(settings.end_s, &state, &settings)?,
            });
            let accepted_steps = points.len() - 1;
            return Ok(SimulationResult {
                points,
                accepted_steps,
                rejected_steps: 0,
                nonlinear_iterations: 0,
                solver,
                summary,
            });
        }

        let mut step_s = settings
            .initial_step_s
            .clamp(settings.min_step_s, settings.max_step_s)
            .min(settings.end_s - settings.start_s);
        let mut accepted_steps = 0_usize;
        let mut rejected_steps = 0_usize;
        let mut nonlinear_iterations = 0_usize;
        let end_epsilon = 32.0 * f64::EPSILON * (1.0 + settings.end_s.abs());

        while time_s < settings.end_s - end_epsilon {
            if accepted_steps + rejected_steps >= settings.max_steps {
                return Err(EquationError::MaxStepsExceeded);
            }

            step_s = step_s.min(settings.end_s - time_s);
            if let Some(event_s) = self.event_times_s.iter().copied().find(|event_s| {
                *event_s > time_s + end_epsilon && *event_s < time_s + step_s - end_epsilon
            }) {
                step_s = event_s - time_s;
            }

            let step_end_s = time_s + step_s;
            // A time event is right-continuous to callers, but integration up
            // to the event must use the left-hand input.  Evaluate endpoint
            // stages an ulp before the event, then publish the post-event
            // algebraic outputs at the exact event time below.
            let ends_at_event = self.event_times_s.iter().any(|event_s| {
                (*event_s - step_end_s).abs()
                    <= 32.0 * f64::EPSILON * (1.0 + step_end_s.abs())
            });
            let stage_end_s = if ends_at_event {
                step_end_s
                    - (64.0 * f64::EPSILON * (1.0 + step_end_s.abs())).min(step_s * 0.5)
            } else {
                step_end_s
            };
            let attempted = match solver.selected {
                IntegrationMethod::DormandPrince45 | IntegrationMethod::Auto => self
                    .dormand_prince_step(time_s, &state, step_s, stage_end_s, &settings)?,
                IntegrationMethod::BackwardEuler => self.backward_euler_step(
                    time_s,
                    &state,
                    step_s,
                    stage_end_s,
                    &settings,
                )?,
            };
            nonlinear_iterations += attempted.nonlinear_iterations;
            if attempted.error_norm <= 1.0 {
                time_s += step_s;
                if (settings.end_s - time_s).abs() <= end_epsilon {
                    time_s = settings.end_s;
                }
                state = attempted.state;
                accepted_steps += 1;
                points.push(TracePoint {
                    time_s,
                    values: self.outputs_at(time_s, &state, &settings)?,
                });
                let factor = if attempted.error_norm == 0.0 {
                    5.0
                } else {
                    (0.9 * attempted.error_norm.powf(-1.0 / attempted.error_order))
                        .clamp(0.2, 5.0)
                };
                step_s = (step_s * factor).clamp(settings.min_step_s, settings.max_step_s);
            } else {
                rejected_steps += 1;
                if step_s <= settings.min_step_s {
                    return Err(EquationError::StepUnderflow { time_s });
                }
                let factor = (0.9
                    * attempted
                        .error_norm
                        .powf(-1.0 / attempted.error_order))
                .clamp(0.1, 0.5);
                let next_step = step_s * factor;
                if next_step < settings.min_step_s {
                    return Err(EquationError::StepUnderflow { time_s });
                }
                step_s = next_step;
            }
        }

        Ok(SimulationResult {
            points,
            accepted_steps,
            rejected_steps,
            nonlinear_iterations,
            solver,
            summary,
        })
    }

    fn dormand_prince_step(
        &self,
        time_s: f64,
        state: &[f64],
        step_s: f64,
        stage_end_s: f64,
        settings: &SolverSettings,
    ) -> Result<StepAttempt, EquationError> {
        let k1 = self.derivatives(time_s, state, settings)?;
        let y2 = combine(state, step_s, &[(&k1, 1.0 / 5.0)]);
        let k2 = self.derivatives(time_s + step_s * 1.0 / 5.0, &y2, settings)?;
        let y3 = combine(
            state,
            step_s,
            &[(&k1, 3.0 / 40.0), (&k2, 9.0 / 40.0)],
        );
        let k3 = self.derivatives(time_s + step_s * 3.0 / 10.0, &y3, settings)?;
        let y4 = combine(
            state,
            step_s,
            &[
                (&k1, 44.0 / 45.0),
                (&k2, -56.0 / 15.0),
                (&k3, 32.0 / 9.0),
            ],
        );
        let k4 = self.derivatives(time_s + step_s * 4.0 / 5.0, &y4, settings)?;
        let y5_stage = combine(
            state,
            step_s,
            &[
                (&k1, 19372.0 / 6561.0),
                (&k2, -25360.0 / 2187.0),
                (&k3, 64448.0 / 6561.0),
                (&k4, -212.0 / 729.0),
            ],
        );
        let k5 = self.derivatives(time_s + step_s * 8.0 / 9.0, &y5_stage, settings)?;
        let y6 = combine(
            state,
            step_s,
            &[
                (&k1, 9017.0 / 3168.0),
                (&k2, -355.0 / 33.0),
                (&k3, 46732.0 / 5247.0),
                (&k4, 49.0 / 176.0),
                (&k5, -5103.0 / 18656.0),
            ],
        );
        let k6 = self.derivatives(stage_end_s, &y6, settings)?;
        let fifth = combine(
            state,
            step_s,
            &[
                (&k1, 35.0 / 384.0),
                (&k3, 500.0 / 1113.0),
                (&k4, 125.0 / 192.0),
                (&k5, -2187.0 / 6784.0),
                (&k6, 11.0 / 84.0),
            ],
        );
        let k7 = self.derivatives(stage_end_s, &fifth, settings)?;
        let fourth = combine(
            state,
            step_s,
            &[
                (&k1, 5179.0 / 57600.0),
                (&k3, 7571.0 / 16695.0),
                (&k4, 393.0 / 640.0),
                (&k5, -92097.0 / 339200.0),
                (&k6, 187.0 / 2100.0),
                (&k7, 1.0 / 40.0),
            ],
        );
        let error_norm = fifth
            .iter()
            .zip(&fourth)
            .zip(state)
            .map(|((high, low), old)| {
                let scale = settings.absolute_tolerance
                    + settings.relative_tolerance * old.abs().max(high.abs());
                (high - low).abs() / scale
            })
            .fold(0.0_f64, f64::max);
        if !error_norm.is_finite() || fifth.iter().any(|value| !value.is_finite()) {
            return Err(EquationError::NonFiniteValue {
                block: "continuous state".to_string(),
                time_s,
            });
        }
        Ok(StepAttempt {
            state: fifth,
            error_norm,
            error_order: 5.0,
            nonlinear_iterations: 0,
        })
    }

    fn backward_euler_step(
        &self,
        time_s: f64,
        state: &[f64],
        step_s: f64,
        stage_end_s: f64,
        settings: &SolverSettings,
    ) -> Result<StepAttempt, EquationError> {
        let (coarse, coarse_iterations) = self.backward_euler_solve(
            time_s,
            stage_end_s,
            state,
            step_s,
            settings,
        )?;
        let half_step_s = step_s * 0.5;
        let midpoint_s = time_s + half_step_s;
        let (half, first_iterations) = self.backward_euler_solve(
            time_s,
            midpoint_s,
            state,
            half_step_s,
            settings,
        )?;
        let (fine, second_iterations) = self.backward_euler_solve(
            midpoint_s,
            stage_end_s,
            &half,
            half_step_s,
            settings,
        )?;
        let error_norm = fine
            .iter()
            .zip(&coarse)
            .zip(state)
            .map(|((high, low), old)| {
                let scale = settings.absolute_tolerance
                    + settings.relative_tolerance * old.abs().max(high.abs());
                (high - low).abs() / scale
            })
            .fold(0.0_f64, f64::max);
        if !error_norm.is_finite() || fine.iter().any(|value| !value.is_finite()) {
            return Err(EquationError::NonFiniteValue {
                block: "implicit continuous state".to_string(),
                time_s,
            });
        }
        Ok(StepAttempt {
            state: fine,
            error_norm,
            error_order: 2.0,
            nonlinear_iterations: coarse_iterations + first_iterations + second_iterations,
        })
    }

    fn backward_euler_solve(
        &self,
        start_s: f64,
        evaluation_s: f64,
        state: &[f64],
        step_s: f64,
        settings: &SolverSettings,
    ) -> Result<(Vec<f64>, usize), EquationError> {
        let initial_derivative = self.derivatives(start_s, state, settings)?;
        let mut guess = state
            .iter()
            .zip(&initial_derivative)
            .map(|(value, derivative)| value + step_s * derivative)
            .collect::<Vec<_>>();
        let residual_at = |candidate: &[f64]| -> Result<Vec<f64>, EquationError> {
            let derivative = self.derivatives(evaluation_s, candidate, settings)?;
            Ok(candidate
                .iter()
                .zip(state)
                .zip(derivative)
                .map(|((next, previous), rate)| next - previous - step_s * rate)
                .collect())
        };
        let mut residual = residual_at(&guess)?;

        for iteration in 0..settings.implicit_max_iterations {
            let norm = max_abs(&residual);
            if norm <= settings.implicit_tolerance {
                return Ok((guess, iteration));
            }
            let n = guess.len();
            let mut jacobian = vec![vec![0.0; n]; n];
            for column in 0..n {
                let mut perturbed = guess.clone();
                let delta = f64::EPSILON.sqrt() * (1.0 + guess[column].abs());
                perturbed[column] += delta;
                let shifted = residual_at(&perturbed)?;
                for row in 0..n {
                    jacobian[row][column] = (shifted[row] - residual[row]) / delta;
                }
            }
            let right_hand_side = residual.iter().map(|value| -value).collect::<Vec<_>>();
            let correction = solve_dense(jacobian, right_hand_side).ok_or(
                EquationError::ImplicitNonConvergence {
                    time_s: evaluation_s,
                    residual: norm,
                },
            )?;

            let mut accepted = None;
            let mut damping = 1.0;
            for _ in 0..10 {
                let candidate = guess
                    .iter()
                    .zip(&correction)
                    .map(|(value, delta)| value + damping * delta)
                    .collect::<Vec<_>>();
                let candidate_residual = residual_at(&candidate)?;
                if max_abs(&candidate_residual) < norm {
                    accepted = Some((candidate, candidate_residual));
                    break;
                }
                damping *= 0.5;
            }
            let Some((next_guess, next_residual)) = accepted else {
                return Err(EquationError::ImplicitNonConvergence {
                    time_s: evaluation_s,
                    residual: norm,
                });
            };
            guess = next_guess;
            residual = next_residual;
        }
        Err(EquationError::ImplicitNonConvergence {
            time_s: evaluation_s,
            residual: max_abs(&residual),
        })
    }

    fn derivatives(
        &self,
        time_s: f64,
        state: &[f64],
        settings: &SolverSettings,
    ) -> Result<Vec<f64>, EquationError> {
        let outputs = self.outputs_at(time_s, state, settings)?;
        let mut derivatives = Vec::with_capacity(self.state_blocks.len());
        for &block_id in &self.state_blocks {
            let block = &self.blocks[block_id];
            let input = |port: usize| outputs[self.inputs[block_id][port].expect("compiled input")];
            let value = match block.kind {
                BlockKind::Integrator { gain, .. } => gain * input(0),
                BlockKind::FirstOrder { tau_s, .. } => {
                    (input(0) - outputs[block_id]) / tau_s
                }
                _ => unreachable!("state list contains only continuous blocks"),
            };
            if !value.is_finite() {
                return Err(EquationError::NonFiniteValue {
                    block: block.name.clone(),
                    time_s,
                });
            }
            derivatives.push(value);
        }
        Ok(derivatives)
    }

    fn outputs_at(
        &self,
        time_s: f64,
        state: &[f64],
        settings: &SolverSettings,
    ) -> Result<Vec<f64>, EquationError> {
        if state.len() != self.state_blocks.len() {
            return Err(EquationError::StateSize {
                expected: self.state_blocks.len(),
                actual: state.len(),
            });
        }
        let mut outputs = vec![0.0; self.blocks.len()];
        for (state_index, block_id) in self.state_blocks.iter().copied().enumerate() {
            outputs[block_id] = state[state_index];
        }

        if let Some(order) = &self.algebraic_order {
            for &block_id in order {
                outputs[block_id] = self.algebraic_rhs(block_id, time_s, &outputs);
                if !outputs[block_id].is_finite() {
                    return Err(EquationError::NonFiniteValue {
                        block: self.blocks[block_id].name.clone(),
                        time_s,
                    });
                }
            }
            return Ok(outputs);
        }

        // A few Gauss-Seidel passes provide a useful Newton seed for benign
        // feedback loops without changing the authoritative residual solve.
        for _ in 0..6 {
            for &block_id in &self.algebraic_blocks {
                outputs[block_id] = self.algebraic_rhs(block_id, time_s, &outputs);
            }
        }
        let mut guess = self
            .algebraic_blocks
            .iter()
            .map(|id| outputs[*id])
            .collect::<Vec<_>>();
        let mut residual = self.algebraic_residual(time_s, state, &guess)?;

        for _ in 0..settings.algebraic_max_iterations {
            let norm = max_abs(&residual);
            if norm <= settings.algebraic_tolerance {
                for (index, block_id) in self.algebraic_blocks.iter().copied().enumerate() {
                    outputs[block_id] = guess[index];
                }
                return Ok(outputs);
            }
            let n = guess.len();
            let mut jacobian = vec![vec![0.0; n]; n];
            for column in 0..n {
                let mut perturbed = guess.clone();
                let delta = f64::EPSILON.sqrt() * (1.0 + guess[column].abs());
                perturbed[column] += delta;
                let shifted = self.algebraic_residual(time_s, state, &perturbed)?;
                for row in 0..n {
                    jacobian[row][column] = (shifted[row] - residual[row]) / delta;
                }
            }
            let right_hand_side = residual.iter().map(|value| -value).collect::<Vec<_>>();
            let correction = solve_dense(jacobian, right_hand_side)
                .ok_or(EquationError::SingularAlgebraicSystem { time_s })?;

            let mut accepted = None;
            let mut damping = 1.0;
            for _ in 0..10 {
                let candidate = guess
                    .iter()
                    .zip(&correction)
                    .map(|(value, delta)| value + damping * delta)
                    .collect::<Vec<_>>();
                let candidate_residual = self.algebraic_residual(time_s, state, &candidate)?;
                if max_abs(&candidate_residual) < norm {
                    accepted = Some((candidate, candidate_residual));
                    break;
                }
                damping *= 0.5;
            }
            let Some((next_guess, next_residual)) = accepted else {
                return Err(EquationError::AlgebraicNonConvergence {
                    time_s,
                    residual: norm,
                });
            };
            guess = next_guess;
            residual = next_residual;
        }
        Err(EquationError::AlgebraicNonConvergence {
            time_s,
            residual: max_abs(&residual),
        })
    }

    fn algebraic_residual(
        &self,
        time_s: f64,
        state: &[f64],
        guess: &[f64],
    ) -> Result<Vec<f64>, EquationError> {
        let mut outputs = vec![0.0; self.blocks.len()];
        for (state_index, block_id) in self.state_blocks.iter().copied().enumerate() {
            outputs[block_id] = state[state_index];
        }
        for (index, block_id) in self.algebraic_blocks.iter().copied().enumerate() {
            outputs[block_id] = guess[index];
        }
        let mut residual = Vec::with_capacity(self.algebraic_blocks.len());
        for (index, block_id) in self.algebraic_blocks.iter().copied().enumerate() {
            let rhs = self.algebraic_rhs(block_id, time_s, &outputs);
            let value = guess[index] - rhs;
            if !value.is_finite() {
                return Err(EquationError::NonFiniteValue {
                    block: self.blocks[block_id].name.clone(),
                    time_s,
                });
            }
            residual.push(value);
        }
        Ok(residual)
    }

    fn algebraic_rhs(&self, block_id: BlockId, time_s: f64, outputs: &[f64]) -> f64 {
        let block = &self.blocks[block_id];
        let input = |port: usize| outputs[self.inputs[block_id][port].expect("compiled input")];
        match block.kind {
            BlockKind::Constant { value } => value,
            BlockKind::StepSource {
                before,
                after,
                at_s,
            } => {
                if time_s < at_s {
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
            } => (input(0) - conductance_w_per_k * (input(1) - input(2)))
                / heat_capacity_j_per_k,
            BlockKind::Integrator { .. } | BlockKind::FirstOrder { .. } => {
                outputs[block_id]
            }
        }
    }
}

struct StepAttempt {
    state: Vec<f64>,
    error_norm: f64,
    error_order: f64,
    nonlinear_iterations: usize,
}

fn combine(base: &[f64], step_s: f64, terms: &[(&Vec<f64>, f64)]) -> Vec<f64> {
    (0..base.len())
        .map(|index| {
            base[index]
                + step_s
                    * terms
                        .iter()
                        .map(|(values, coefficient)| coefficient * values[index])
                        .sum::<f64>()
        })
        .collect()
}

fn max_abs(values: &[f64]) -> f64 {
    values.iter().map(|value| value.abs()).fold(0.0, f64::max)
}

fn solve_dense(mut matrix: Vec<Vec<f64>>, mut rhs: Vec<f64>) -> Option<Vec<f64>> {
    let n = rhs.len();
    for pivot in 0..n {
        let mut best = pivot;
        for row in (pivot + 1)..n {
            if matrix[row][pivot].abs() > matrix[best][pivot].abs() {
                best = row;
            }
        }
        if !matrix[best][pivot].is_finite() || matrix[best][pivot].abs() < 1e-14 {
            return None;
        }
        matrix.swap(pivot, best);
        rhs.swap(pivot, best);
        for row in (pivot + 1)..n {
            let factor = matrix[row][pivot] / matrix[pivot][pivot];
            matrix[row][pivot] = 0.0;
            for column in (pivot + 1)..n {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
            rhs[row] -= factor * rhs[pivot];
        }
    }
    let mut solution = vec![0.0; n];
    for row in (0..n).rev() {
        let tail = ((row + 1)..n)
            .map(|column| matrix[row][column] * solution[column])
            .sum::<f64>();
        solution[row] = (rhs[row] - tail) / matrix[row][row];
        if !solution[row].is_finite() {
            return None;
        }
    }
    Some(solution)
}

/// Parameters for a small but coupled electrical/thermal reference graph.
/// It is used as an executable example and as a regression benchmark.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ElectrothermalCellParameters {
    pub ocv_v: f64,
    pub resistance_ohm: f64,
    pub current_before_a: f64,
    pub current_after_a: f64,
    pub current_step_time_s: f64,
    pub initial_temperature_k: f64,
    pub ambient_temperature_k: f64,
    pub heat_capacity_j_per_k: f64,
    pub thermal_conductance_w_per_k: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElectrothermalCellOutputs {
    pub current: BlockId,
    pub terminal_voltage: BlockId,
    pub heat_generation: BlockId,
    pub temperature: BlockId,
}

pub fn electrothermal_cell_graph(
    parameters: ElectrothermalCellParameters,
) -> Result<(CompiledGraph, ElectrothermalCellOutputs), EquationError> {
    if !parameters.resistance_ohm.is_finite() || parameters.resistance_ohm < 0.0 {
        return Err(EquationError::InvalidParameter {
            block: "cell".to_string(),
            parameter: "resistance_ohm",
        });
    }
    let mut graph = EquationGraph::new();
    let current = graph.add_block(Block::new(
        "current",
        Quantity::CurrentA,
        BlockKind::StepSource {
            before: parameters.current_before_a,
            after: parameters.current_after_a,
            at_s: parameters.current_step_time_s,
        },
    ))?;
    let ocv = graph.add_block(Block::new(
        "open-circuit voltage",
        Quantity::VoltageV,
        BlockKind::Constant {
            value: parameters.ocv_v,
        },
    ))?;
    let voltage_drop = graph.add_block(Block::new(
        "ohmic voltage drop",
        Quantity::VoltageV,
        BlockKind::Gain {
            gain: -parameters.resistance_ohm,
            input: Quantity::CurrentA,
        },
    ))?;
    let terminal_voltage = graph.add_block(Block::new(
        "terminal voltage",
        Quantity::VoltageV,
        BlockKind::Sum { inputs: 2 },
    ))?;
    let heat_generation = graph.add_block(Block::new(
        "ohmic heat",
        Quantity::HeatFlowW,
        BlockKind::Product {
            scale: parameters.resistance_ohm,
            left: Quantity::CurrentA,
            right: Quantity::CurrentA,
        },
    ))?;
    let ambient = graph.add_block(Block::new(
        "ambient temperature",
        Quantity::TemperatureK,
        BlockKind::Constant {
            value: parameters.ambient_temperature_k,
        },
    ))?;
    let thermal_rate = graph.add_block(Block::new(
        "cell thermal balance",
        Quantity::TemperatureRateKPerSecond,
        BlockKind::ThermalRate {
            heat_capacity_j_per_k: parameters.heat_capacity_j_per_k,
            conductance_w_per_k: parameters.thermal_conductance_w_per_k,
        },
    ))?;
    let temperature = graph.add_block(Block::new(
        "cell temperature",
        Quantity::TemperatureK,
        BlockKind::Integrator {
            initial: parameters.initial_temperature_k,
            rate: Quantity::TemperatureRateKPerSecond,
            gain: 1.0,
        },
    ))?;

    graph.connect(current, voltage_drop, 0)?;
    graph.connect(ocv, terminal_voltage, 0)?;
    graph.connect(voltage_drop, terminal_voltage, 1)?;
    graph.connect(current, heat_generation, 0)?;
    graph.connect(current, heat_generation, 1)?;
    graph.connect(heat_generation, thermal_rate, 0)?;
    graph.connect(temperature, thermal_rate, 1)?;
    graph.connect(ambient, thermal_rate, 2)?;
    graph.connect(thermal_rate, temperature, 0)?;

    Ok((
        graph.compile()?,
        ElectrothermalCellOutputs {
            current,
            terminal_voltage,
            heat_generation,
            temperature,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected} within {tolerance}"
        );
    }

    #[test]
    fn rejects_quantity_mismatches_before_compilation() {
        let mut graph = EquationGraph::new();
        let voltage = graph
            .add_block(Block::new(
                "voltage",
                Quantity::VoltageV,
                BlockKind::Constant { value: 12.0 },
            ))
            .unwrap();
        let current_gain = graph
            .add_block(Block::new(
                "current gain",
                Quantity::CurrentA,
                BlockKind::Gain {
                    gain: 2.0,
                    input: Quantity::CurrentA,
                },
            ))
            .unwrap();
        assert!(matches!(
            graph.connect(voltage, current_gain, 0),
            Err(EquationError::QuantityMismatch { .. })
        ));
    }

    #[test]
    fn rejects_unconnected_inputs() {
        let mut graph = EquationGraph::new();
        graph
            .add_block(Block::new(
                "gain",
                Quantity::Dimensionless,
                BlockKind::Gain {
                    gain: 2.0,
                    input: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        assert!(matches!(
            graph.compile(),
            Err(EquationError::MissingInput { .. })
        ));
    }

    #[test]
    fn newton_solves_a_coupled_algebraic_loop() {
        let mut graph = EquationGraph::new();
        let one = graph
            .add_block(Block::new(
                "one",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 1.0 },
            ))
            .unwrap();
        let two = graph
            .add_block(Block::new(
                "two",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 2.0 },
            ))
            .unwrap();
        let half_b = graph
            .add_block(Block::new(
                "half b",
                Quantity::Dimensionless,
                BlockKind::Gain {
                    gain: 0.5,
                    input: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        let a = graph
            .add_block(Block::new(
                "a",
                Quantity::Dimensionless,
                BlockKind::Sum { inputs: 2 },
            ))
            .unwrap();
        let quarter_a = graph
            .add_block(Block::new(
                "quarter a",
                Quantity::Dimensionless,
                BlockKind::Gain {
                    gain: 0.25,
                    input: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        let b = graph
            .add_block(Block::new(
                "b",
                Quantity::Dimensionless,
                BlockKind::Sum { inputs: 2 },
            ))
            .unwrap();
        graph.connect(one, a, 0).unwrap();
        graph.connect(b, half_b, 0).unwrap();
        graph.connect(half_b, a, 1).unwrap();
        graph.connect(two, b, 0).unwrap();
        graph.connect(a, quarter_a, 0).unwrap();
        graph.connect(quarter_a, b, 1).unwrap();

        let compiled = graph.compile().unwrap();
        assert!(compiled.summary().has_algebraic_loop);
        let settings = SolverSettings {
            end_s: 0.0,
            ..SolverSettings::default()
        };
        let result = compiled.simulate(settings).unwrap();
        near(result.last_value(a).unwrap(), 16.0 / 7.0, 1e-9);
        near(result.last_value(b).unwrap(), 18.0 / 7.0, 1e-9);
    }

    #[test]
    fn adaptive_rk45_matches_a_stiffish_first_order_benchmark() {
        let mut graph = EquationGraph::new();
        let command = graph
            .add_block(Block::new(
                "command",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 1.0 },
            ))
            .unwrap();
        let response = graph
            .add_block(Block::new(
                "response",
                Quantity::Dimensionless,
                BlockKind::FirstOrder {
                    tau_s: 0.01,
                    initial: 0.0,
                },
            ))
            .unwrap();
        graph.connect(command, response, 0).unwrap();
        let compiled = graph.compile().unwrap();
        let result = compiled
            .simulate(SolverSettings {
                end_s: 0.1,
                initial_step_s: 0.1,
                max_step_s: 0.1,
                relative_tolerance: 1e-8,
                absolute_tolerance: 1e-10,
                ..SolverSettings::default()
            })
            .unwrap();
        near(
            result.last_value(response).unwrap(),
            1.0 - (-10.0_f64).exp(),
            2e-8,
        );
        assert!(result.rejected_steps > 0, "the oversized first step is rejected");
    }

    #[test]
    fn auto_selects_implicit_integration_for_separated_time_scales() {
        let mut graph = EquationGraph::new();
        let command = graph
            .add_block(Block::new(
                "command",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 1.0 },
            ))
            .unwrap();
        let fast = graph
            .add_block(Block::new(
                "fast response",
                Quantity::Dimensionless,
                BlockKind::FirstOrder {
                    tau_s: 1e-4,
                    initial: 0.0,
                },
            ))
            .unwrap();
        let slow = graph
            .add_block(Block::new(
                "slow response",
                Quantity::Dimensionless,
                BlockKind::FirstOrder {
                    tau_s: 1.0,
                    initial: 0.0,
                },
            ))
            .unwrap();
        graph.connect(command, fast, 0).unwrap();
        graph.connect(command, slow, 0).unwrap();
        let compiled = graph.compile().unwrap();
        let settings = SolverSettings {
            end_s: 1.0,
            initial_step_s: 1e-3,
            max_step_s: 0.05,
            relative_tolerance: 2e-4,
            absolute_tolerance: 1e-7,
            ..SolverSettings::default()
        };
        let decision = compiled.recommend_solver(&settings);
        assert_eq!(decision.selected, IntegrationMethod::BackwardEuler);
        assert_eq!(decision.reason, SolverDecisionReason::SeparatedTimeScales);
        assert_eq!(decision.time_scale_ratio, Some(10_000.0));

        let result = compiled.simulate(settings).unwrap();
        assert_eq!(result.solver, decision);
        assert!(result.nonlinear_iterations > 0);
        near(result.last_value(fast).unwrap(), 1.0, 2e-4);
        near(
            result.last_value(slow).unwrap(),
            1.0 - (-1.0_f64).exp(),
            8e-4,
        );
    }

    #[test]
    fn backward_euler_remains_stable_with_a_step_far_above_the_fast_time_constant() {
        let mut graph = EquationGraph::new();
        let command = graph
            .add_block(Block::new(
                "command",
                Quantity::Dimensionless,
                BlockKind::Constant { value: 1.0 },
            ))
            .unwrap();
        let response = graph
            .add_block(Block::new(
                "response",
                Quantity::Dimensionless,
                BlockKind::FirstOrder {
                    tau_s: 1e-4,
                    initial: 0.0,
                },
            ))
            .unwrap();
        graph.connect(command, response, 0).unwrap();
        let result = graph
            .compile()
            .unwrap()
            .simulate(SolverSettings {
                method: IntegrationMethod::BackwardEuler,
                end_s: 0.1,
                initial_step_s: 0.01,
                min_step_s: 0.01,
                max_step_s: 0.01,
                relative_tolerance: 2.0,
                absolute_tolerance: 1.0,
                ..SolverSettings::default()
            })
            .unwrap();
        assert_eq!(result.solver.reason, SolverDecisionReason::UserSelected);
        assert!(result
            .points
            .iter()
            .all(|point| point.values[response].is_finite()));
        let final_value = result.last_value(response).unwrap();
        assert!((0.0..=1.0).contains(&final_value));
        near(final_value, 1.0, 1e-8);
    }

    #[test]
    fn errors_expose_stable_codes_and_human_safe_next_actions() {
        let error = EquationError::QuantityMismatch {
            from: "battery voltage".to_string(),
            from_quantity: Quantity::VoltageV,
            to: "coolant inlet".to_string(),
            expected: Quantity::TemperatureK,
        };
        assert_eq!(error.code(), "connection.quantity_mismatch");
        assert!(error.suggested_action().contains("compatible port"));
        assert!(error.suggested_action().contains("unit-reviewed"));
    }

    #[test]
    fn an_integrator_conserves_accumulated_energy() {
        let mut graph = EquationGraph::new();
        let power = graph
            .add_block(Block::new(
                "power",
                Quantity::PowerW,
                BlockKind::Constant { value: 100.0 },
            ))
            .unwrap();
        let energy = graph
            .add_block(Block::new(
                "energy",
                Quantity::EnergyJ,
                BlockKind::Integrator {
                    initial: 0.0,
                    rate: Quantity::PowerW,
                    gain: 1.0,
                },
            ))
            .unwrap();
        graph.connect(power, energy, 0).unwrap();
        let result = graph
            .compile()
            .unwrap()
            .simulate(SolverSettings {
                end_s: 10.0,
                max_step_s: 1.0,
                ..SolverSettings::default()
            })
            .unwrap();
        near(result.last_value(energy).unwrap(), 1000.0, 1e-9);
    }

    #[test]
    fn electrothermal_graph_hits_the_event_and_analytical_limits() {
        let ambient = 298.15;
        let (graph, outputs) = electrothermal_cell_graph(ElectrothermalCellParameters {
            ocv_v: 4.0,
            resistance_ohm: 0.05,
            current_before_a: 0.0,
            current_after_a: 10.0,
            current_step_time_s: 1.0,
            initial_temperature_k: ambient,
            ambient_temperature_k: ambient,
            heat_capacity_j_per_k: 100.0,
            thermal_conductance_w_per_k: 2.0,
        })
        .unwrap();
        let result = graph
            .simulate(SolverSettings {
                end_s: 201.0,
                initial_step_s: 0.8,
                max_step_s: 5.0,
                relative_tolerance: 1e-8,
                absolute_tolerance: 1e-10,
                ..SolverSettings::default()
            })
            .unwrap();
        assert!(result
            .points
            .iter()
            .any(|point| (point.time_s - 1.0).abs() < 1e-12));
        near(result.last_value(outputs.current).unwrap(), 10.0, 1e-12);
        near(result.last_value(outputs.terminal_voltage).unwrap(), 3.5, 1e-12);
        near(result.last_value(outputs.heat_generation).unwrap(), 5.0, 1e-12);
        let steady_temperature = ambient + 5.0 / 2.0;
        let expected_temperature =
            steady_temperature + (ambient - steady_temperature) * (-200.0_f64 / 50.0).exp();
        near(
            result.last_value(outputs.temperature).unwrap(),
            expected_temperature,
            2e-6,
        );
    }
}
