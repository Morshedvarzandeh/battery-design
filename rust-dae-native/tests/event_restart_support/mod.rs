use battery_design_core::equations::{
    Block, BlockId, BlockKind, CompiledGraph, EquationGraph, Quantity, SolverSettings,
};

pub struct EventIntegratorFixture {
    pub graph: CompiledGraph,
    pub source: BlockId,
    pub state: BlockId,
}

pub struct TwoEventIntegratorFixture {
    pub graph: CompiledGraph,
    pub first: BlockId,
    pub second: BlockId,
    pub sum: BlockId,
    pub state: BlockId,
}

pub fn core_settings() -> SolverSettings {
    SolverSettings {
        end_s: 0.0,
        ..SolverSettings::default()
    }
}

/// `source` is 1 before `event_time_s` and 2 at and after it. The continuous
/// state starts at zero and integrates that source with unit gain.
pub fn event_integrator_graph(event_time_s: f64) -> EventIntegratorFixture {
    let mut graph = EquationGraph::new();
    let source = graph
        .add_block(Block::new(
            "scheduled rate",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 1.0,
                after: 2.0,
                at_s: event_time_s,
            },
        ))
        .unwrap();
    let state = graph
        .add_block(Block::new(
            "continuous state",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 0.0,
                rate: Quantity::Dimensionless,
                gain: 1.0,
            },
        ))
        .unwrap();
    graph.connect(source, state, 0).unwrap();
    EventIntegratorFixture {
        graph: graph.compile().unwrap(),
        source,
        state,
    }
}

/// The first source is 1 -> 2, the second is 0 -> 1, and their sum drives a
/// continuous unit-gain integrator starting at zero.
pub fn two_event_integrator_graph_at(
    first_event_time_s: f64,
    second_event_time_s: f64,
) -> TwoEventIntegratorFixture {
    let mut graph = EquationGraph::new();
    let first = graph
        .add_block(Block::new(
            "first scheduled rate",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 1.0,
                after: 2.0,
                at_s: first_event_time_s,
            },
        ))
        .unwrap();
    let second = graph
        .add_block(Block::new(
            "second scheduled rate",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 0.0,
                after: 1.0,
                at_s: second_event_time_s,
            },
        ))
        .unwrap();
    let sum = graph
        .add_block(Block::new(
            "combined rate",
            Quantity::Dimensionless,
            BlockKind::Sum { inputs: 2 },
        ))
        .unwrap();
    let state = graph
        .add_block(Block::new(
            "continuous state",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 0.0,
                rate: Quantity::Dimensionless,
                gain: 1.0,
            },
        ))
        .unwrap();
    graph.connect(first, sum, 0).unwrap();
    graph.connect(second, sum, 1).unwrap();
    graph.connect(sum, state, 0).unwrap();
    TwoEventIntegratorFixture {
        graph: graph.compile().unwrap(),
        first,
        second,
        sum,
        state,
    }
}

/// Independent 1 -> 2 StepSources used only to exercise exact event-table
/// sorting, deduplication, filtering, and preflight admission.
pub fn step_events_graph(event_times_s: &[f64]) -> CompiledGraph {
    let mut graph = EquationGraph::new();
    for (index, &at_s) in event_times_s.iter().enumerate() {
        graph
            .add_block(Block::new(
                format!("scheduled source {index}"),
                Quantity::Dimensionless,
                BlockKind::StepSource {
                    before: 1.0,
                    after: 2.0,
                    at_s,
                },
            ))
            .unwrap();
    }
    graph.compile().unwrap()
}

pub fn previous_positive_f64(value: f64) -> f64 {
    assert!(value.is_finite() && value > 0.0);
    f64::from_bits(value.to_bits() - 1)
}

pub fn next_positive_f64(value: f64) -> f64 {
    assert!(value.is_finite() && value > 0.0 && value < f64::MAX);
    f64::from_bits(value.to_bits() + 1)
}
