use battery_design_core::dae::{
    DaeBuffer, DaeError, DaeInput, DaeResidualSystem, DaeVariableKind, DAE_ALGEBRAIC_ID,
    DAE_DIFFERENTIAL_ID, DAE_RESIDUAL_CONTRACT_VERSION,
};
use battery_design_core::equations::{
    Block, BlockKind, CompiledGraph, EquationError, EquationGraph, Quantity, SolverSettings,
};

fn settings() -> SolverSettings {
    SolverSettings {
        end_s: 0.0,
        ..SolverSettings::default()
    }
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-11 * (1.0 + expected.abs()),
        "{actual} != {expected}"
    );
}

fn lower(graph: &CompiledGraph) -> DaeResidualSystem<'_> {
    DaeResidualSystem::lower(graph, 0.0, &settings()).unwrap()
}

fn dense_jacobian(system: &DaeResidualSystem<'_>, values: &[f64]) -> Vec<Vec<f64>> {
    let n = system.variables().len();
    let mut dense = vec![vec![0.0; n]; n];
    let pattern = system.csc_pattern();
    let mut value_index = 0;
    for column in 0..n {
        for pattern_index in
            pattern.column_pointers()[column]..pattern.column_pointers()[column + 1]
        {
            dense[pattern.row_indices()[pattern_index]][column] = values[value_index];
            value_index += 1;
        }
    }
    assert_eq!(value_index, values.len());
    dense
}

fn constant_integrator_gain_graph() -> (CompiledGraph, usize, usize, usize) {
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
    (graph.compile().unwrap(), source, state, observed)
}

fn algebraic_chain(variable_count: usize) -> CompiledGraph {
    assert!(variable_count > 0);
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

fn assert_exact_chain_csc(variable_count: usize) {
    let graph = algebraic_chain(variable_count);
    let first = lower(&graph);
    let second = lower(&graph);
    let first_pattern = first.csc_pattern();
    let second_pattern = second.csc_pattern();
    let expected_nonzeros = 2 * variable_count - 1;

    assert_eq!(first.variables().len(), variable_count);
    assert_eq!(first_pattern.column_pointers().len(), variable_count + 1);
    assert_eq!(first_pattern.nonzero_count(), expected_nonzeros);
    assert_eq!(
        first.buffer_requirements().jacobian_values,
        expected_nonzeros
    );
    assert_eq!(first_pattern, second_pattern);

    for column in 0..variable_count {
        let start = first_pattern.column_pointers()[column];
        let end = first_pattern.column_pointers()[column + 1];
        assert_eq!(start, 2 * column);
        if column + 1 < variable_count {
            assert_eq!(end, start + 2);
            assert_eq!(
                &first_pattern.row_indices()[start..end],
                &[column, column + 1]
            );
        } else {
            assert_eq!(end, start + 1);
            assert_eq!(&first_pattern.row_indices()[start..end], &[column]);
        }
    }
}

#[test]
fn lowering_classifies_state_first_without_changing_output_order() {
    let (graph, source, state, observed) = constant_integrator_gain_graph();
    let system = lower(&graph);

    assert_eq!(system.contract_version(), DAE_RESIDUAL_CONTRACT_VERSION);
    assert_eq!(system.contract_version(), "battery-design/dae-residual@1");
    assert_eq!(system.variables().len(), 3);
    assert_eq!(system.variables()[0].block_id, state);
    assert_eq!(system.variables()[0].kind, DaeVariableKind::Differential);
    assert_eq!(system.variables()[1].block_id, source);
    assert_eq!(system.variables()[1].kind, DaeVariableKind::Algebraic);
    assert_eq!(system.variables()[2].block_id, observed);
    assert_eq!(system.variables()[2].kind, DaeVariableKind::Algebraic);

    assert_eq!(system.outputs()[source].variable_index, 1);
    assert_eq!(system.outputs()[state].variable_index, 0);
    assert_eq!(system.outputs()[observed].variable_index, 2);
    assert_eq!(system.outputs()[state].name, "state");
    assert_eq!(system.outputs()[state].quantity, Quantity::Dimensionless);

    let requirements = system.buffer_requirements();
    assert_eq!(requirements.y, 3);
    assert_eq!(requirements.yp, 3);
    assert_eq!(requirements.id_vector, 3);
    assert_eq!(requirements.residual, 3);
    assert_eq!(requirements.outputs, 3);
}

#[test]
fn initialization_time_accessor_preserves_the_exact_finite_input() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let negative_zero = DaeResidualSystem::lower(&graph, -0.0, &settings()).unwrap();
    assert_eq!(
        negative_zero.initialization_time_s().to_bits(),
        (-0.0_f64).to_bits()
    );

    let nonzero = DaeResidualSystem::lower(&graph, 0.25, &settings()).unwrap();
    assert_eq!(nonzero.initialization_time_s(), 0.25);
}

#[test]
fn id_vector_is_explicit_and_copy_is_atomic_on_both_length_errors() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let system = lower(&graph);
    assert_eq!(
        system.id_vector(),
        &[DAE_DIFFERENTIAL_ID, DAE_ALGEBRAIC_ID, DAE_ALGEBRAIC_ID]
    );

    let mut exact = [9.0; 3];
    system.id_vector_into(&mut exact).unwrap();
    assert_eq!(exact, [1.0, 0.0, 0.0]);

    let mut short = [9.0; 2];
    assert!(matches!(
        system.id_vector_into(&mut short),
        Err(DaeError::BufferLength {
            buffer: DaeBuffer::IdVector,
            expected: 3,
            actual: 2
        })
    ));
    assert_eq!(short, [9.0; 2]);

    let mut long = [8.0; 4];
    assert!(system.id_vector_into(&mut long).is_err());
    assert_eq!(long, [8.0; 4]);
}

#[test]
fn integrator_initial_conditions_satisfy_the_residual_contract() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let system = lower(&graph);
    assert_eq!(system.initial_y(), &[2.0, 4.0, 6.0]);
    assert_eq!(system.initial_yp(), &[8.0, 0.0, 0.0]);

    let mut residual = [7.0; 3];
    system
        .residual_into(0.0, system.initial_y(), system.initial_yp(), &mut residual)
        .unwrap();
    assert_eq!(residual, [0.0; 3]);

    let mut changed_yp = system.initial_yp().to_vec();
    changed_yp[0] = 10.0;
    system
        .residual_into(0.0, system.initial_y(), &changed_yp, &mut residual)
        .unwrap();
    assert_eq!(residual[0], 2.0);
}

#[test]
fn first_order_rows_use_yp_minus_the_physical_rate() {
    let mut graph = EquationGraph::new();
    let command = graph
        .add_block(Block::new(
            "command",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 10.0 },
        ))
        .unwrap();
    let response = graph
        .add_block(Block::new(
            "response",
            Quantity::Dimensionless,
            BlockKind::FirstOrder {
                tau_s: 2.0,
                initial: 4.0,
            },
        ))
        .unwrap();
    graph.connect(command, response, 0).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    assert_eq!(system.initial_y(), &[4.0, 10.0]);
    assert_eq!(system.initial_yp(), &[3.0, 0.0]);

    let mut residual = [0.0; 2];
    system
        .residual_into(5.0, &[6.0, 14.0], &[5.0, 0.0], &mut residual)
        .unwrap();
    assert_eq!(residual, [1.0, 4.0]);
}

#[test]
fn constants_gains_and_sums_have_auditable_algebraic_residuals() {
    let mut graph = EquationGraph::new();
    let a = graph
        .add_block(Block::new(
            "a",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 2.0 },
        ))
        .unwrap();
    let gain = graph
        .add_block(Block::new(
            "gain",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: -3.0,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let sum = graph
        .add_block(Block::new(
            "sum",
            Quantity::Dimensionless,
            BlockKind::Sum { inputs: 2 },
        ))
        .unwrap();
    graph.connect(a, gain, 0).unwrap();
    graph.connect(a, sum, 0).unwrap();
    graph.connect(gain, sum, 1).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);

    let mut residual = [0.0; 3];
    system
        .residual_into(0.0, &[3.0, -8.0, -4.0], &[0.0; 3], &mut residual)
        .unwrap();
    assert_eq!(residual, [1.0, 1.0, 1.0]);
}

#[test]
fn duplicate_sum_sources_accumulate_in_one_csc_entry() {
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
    let system = lower(&graph);

    assert_eq!(system.csc_pattern().column_pointers(), &[0, 2, 3]);
    assert_eq!(system.csc_pattern().row_indices(), &[0, 1, 1]);
    let mut values = vec![0.0; system.csc_pattern().nonzero_count()];
    system
        .jacobian_values_into(0.0, 2.0, &[4.0, 8.0], &[0.0; 2], &mut values)
        .unwrap();
    assert_eq!(values, [1.0, -2.0, 1.0]);
}

#[test]
fn duplicate_product_sources_accumulate_chain_rule_terms() {
    let mut graph = EquationGraph::new();
    let source = graph
        .add_block(Block::new(
            "source",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 4.0 },
        ))
        .unwrap();
    let square = graph
        .add_block(Block::new(
            "scaled square",
            Quantity::Dimensionless,
            BlockKind::Product {
                scale: 3.0,
                left: Quantity::Dimensionless,
                right: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    graph.connect(source, square, 0).unwrap();
    graph.connect(source, square, 1).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let mut residual = [0.0; 2];
    system
        .residual_into(0.0, &[4.0, 49.0], &[0.0; 2], &mut residual)
        .unwrap();
    assert_eq!(residual, [0.0, 1.0]);

    let mut values = vec![0.0; system.csc_pattern().nonzero_count()];
    system
        .jacobian_values_into(0.0, 1.0, &[4.0, 48.0], &[0.0; 2], &mut values)
        .unwrap();
    assert_eq!(values, [1.0, -24.0, 1.0]);
}

#[test]
fn limit_jacobian_has_defined_inside_and_outside_policies() {
    let mut graph = EquationGraph::new();
    let source = graph
        .add_block(Block::new(
            "source",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 0.5 },
        ))
        .unwrap();
    let limited = graph
        .add_block(Block::new(
            "limited",
            Quantity::Dimensionless,
            BlockKind::Limit { min: 0.0, max: 1.0 },
        ))
        .unwrap();
    graph.connect(source, limited, 0).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let mut values = vec![0.0; system.csc_pattern().nonzero_count()];

    system
        .jacobian_values_into(0.0, 7.0, &[0.5, 0.5], &[0.0; 2], &mut values)
        .unwrap();
    assert_eq!(values, [1.0, -1.0, 1.0]);
    system
        .jacobian_values_into(0.0, 7.0, &[-2.0, 0.0], &[0.0; 2], &mut values)
        .unwrap();
    assert_eq!(values, [1.0, 0.0, 1.0]);
    system
        .jacobian_values_into(0.0, 7.0, &[2.0, 1.0], &[0.0; 2], &mut values)
        .unwrap();
    assert_eq!(values, [1.0, 0.0, 1.0]);
}

#[test]
fn both_limit_kinks_fail_closed_before_jacobian_writes() {
    let mut graph = EquationGraph::new();
    let source = graph
        .add_block(Block::new(
            "source",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 0.5 },
        ))
        .unwrap();
    let limited = graph
        .add_block(Block::new(
            "limited",
            Quantity::Dimensionless,
            BlockKind::Limit { min: 0.0, max: 1.0 },
        ))
        .unwrap();
    graph.connect(source, limited, 0).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let mut values = vec![91.0; system.csc_pattern().nonzero_count()];

    for (input, boundary) in [(0.0, 0.0), (1.0, 1.0)] {
        let error = system
            .jacobian_values_into(3.0, 2.0, &[input, input], &[0.0; 2], &mut values)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::NonsmoothJacobian {
                input_value,
                boundary: reported,
                ..
            } if input_value == input && reported == boundary
        ));
        assert_eq!(error.code(), "dae.nonsmooth_jacobian");
        assert_eq!(values, vec![91.0; values.len()]);
    }
}

#[test]
fn thermal_rate_residual_and_jacobian_preserve_physical_signs() {
    let mut graph = EquationGraph::new();
    let heat = graph
        .add_block(Block::new(
            "heat",
            Quantity::HeatFlowW,
            BlockKind::Constant { value: 10.0 },
        ))
        .unwrap();
    let temperature = graph
        .add_block(Block::new(
            "temperature",
            Quantity::TemperatureK,
            BlockKind::Constant { value: 310.0 },
        ))
        .unwrap();
    let ambient = graph
        .add_block(Block::new(
            "ambient",
            Quantity::TemperatureK,
            BlockKind::Constant { value: 300.0 },
        ))
        .unwrap();
    let rate = graph
        .add_block(Block::new(
            "rate",
            Quantity::TemperatureRateKPerSecond,
            BlockKind::ThermalRate {
                heat_capacity_j_per_k: 100.0,
                conductance_w_per_k: 2.0,
            },
        ))
        .unwrap();
    graph.connect(heat, rate, 0).unwrap();
    graph.connect(temperature, rate, 1).unwrap();
    graph.connect(ambient, rate, 2).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let y = [10.0, 310.0, 300.0, 0.5];
    let mut residual = [0.0; 4];
    system
        .residual_into(0.0, &y, &[0.0; 4], &mut residual)
        .unwrap();
    near(residual[3], 0.6);

    let mut values = vec![0.0; system.csc_pattern().nonzero_count()];
    system
        .jacobian_values_into(0.0, 1.0, &y, &[0.0; 4], &mut values)
        .unwrap();
    let dense = dense_jacobian(&system, &values);
    near(dense[3][0], -0.01);
    near(dense[3][1], 0.02);
    near(dense[3][2], -0.02);
    near(dense[3][3], 1.0);
}

#[test]
fn csc_pattern_and_values_are_replay_deterministic() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let system = lower(&graph);
    assert_eq!(system.csc_pattern().column_pointers(), &[0, 2, 4, 5]);
    assert_eq!(system.csc_pattern().row_indices(), &[0, 2, 0, 1, 2]);

    let mut first = vec![0.0; system.csc_pattern().nonzero_count()];
    let mut second = vec![99.0; first.len()];
    system
        .jacobian_values_into(
            0.0,
            5.0,
            system.initial_y(),
            system.initial_yp(),
            &mut first,
        )
        .unwrap();
    system
        .jacobian_values_into(
            0.0,
            5.0,
            system.initial_y(),
            system.initial_yp(),
            &mut second,
        )
        .unwrap();
    assert_eq!(first, [5.0, -3.0, -2.0, 1.0, 1.0]);
    assert_eq!(first, second);
}

#[test]
fn thousand_variable_chain_has_exact_linear_csc_pattern() {
    assert_exact_chain_csc(1_000);
}

#[test]
fn ten_thousand_variable_chain_has_exact_linear_csc_pattern() {
    assert_exact_chain_csc(10_000);
}

#[test]
fn self_coupled_state_rows_accumulate_dy_and_dyp_terms() {
    let mut first_order_graph = EquationGraph::new();
    let response = first_order_graph
        .add_block(Block::new(
            "self response",
            Quantity::Dimensionless,
            BlockKind::FirstOrder {
                tau_s: 2.0,
                initial: 4.0,
            },
        ))
        .unwrap();
    first_order_graph.connect(response, response, 0).unwrap();
    let first_order_graph = first_order_graph.compile().unwrap();
    let first_order = lower(&first_order_graph);
    let mut value = [0.0];
    first_order
        .jacobian_values_into(0.0, 7.0, &[4.0], &[0.0], &mut value)
        .unwrap();
    assert_eq!(value, [7.0]);

    let mut integrator_graph = EquationGraph::new();
    let state = integrator_graph
        .add_block(Block::new(
            "self integrator",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 3.0,
                rate: Quantity::Dimensionless,
                gain: 2.0,
            },
        ))
        .unwrap();
    integrator_graph.connect(state, state, 0).unwrap();
    let integrator_graph = integrator_graph.compile().unwrap();
    let integrator = lower(&integrator_graph);
    integrator
        .jacobian_values_into(0.0, 7.0, &[3.0], &[6.0], &mut value)
        .unwrap();
    assert_eq!(value, [5.0]);
}

#[test]
fn singular_self_loop_is_neutrally_lowered_without_index_one_claim() {
    let mut graph = EquationGraph::new();
    let loop_block = graph
        .add_block(Block::new(
            "non-unique loop",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: 1.0,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    graph.connect(loop_block, loop_block, 0).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    assert_eq!(system.contract_version(), "battery-design/dae-residual@1");
    assert_eq!(system.id_vector(), &[DAE_ALGEBRAIC_ID]);

    let mut residual = [8.0];
    system
        .residual_into(0.0, &[123.0], &[0.0], &mut residual)
        .unwrap();
    assert_eq!(residual, [0.0]);
    let mut jacobian = [8.0];
    system
        .jacobian_values_into(0.0, 9.0, &[123.0], &[0.0], &mut jacobian)
        .unwrap();
    assert_eq!(jacobian, [0.0]);
}

#[test]
fn coupled_solvable_algebraic_loop_lowers_with_a_small_initial_residual() {
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
    let graph = graph.compile().unwrap();
    let system = lower(&graph);

    assert!((system.initial_y()[a] - 16.0 / 7.0).abs() < 1e-9);
    assert!((system.initial_y()[b] - 18.0 / 7.0).abs() < 1e-9);
    let mut residual = vec![99.0; system.buffer_requirements().residual];
    system
        .residual_into(0.0, system.initial_y(), system.initial_yp(), &mut residual)
        .unwrap();
    assert!(
        residual.iter().all(|value| value.abs() <= 1e-10),
        "initial algebraic residual is {residual:?}"
    );
}

#[test]
fn inconsistent_algebraic_loop_fails_during_initialization() {
    let mut graph = EquationGraph::new();
    let one = graph
        .add_block(Block::new(
            "one",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let impossible = graph
        .add_block(Block::new(
            "x equals one plus x",
            Quantity::Dimensionless,
            BlockKind::Sum { inputs: 2 },
        ))
        .unwrap();
    graph.connect(one, impossible, 0).unwrap();
    graph.connect(impossible, impossible, 1).unwrap();
    let graph = graph.compile().unwrap();
    let error = DaeResidualSystem::lower(&graph, 0.0, &settings()).unwrap_err();
    assert!(matches!(
        error,
        DaeError::Initialization(EquationError::SingularAlgebraicSystem { .. })
            | DaeError::Initialization(EquationError::AlgebraicNonConvergence { .. })
    ));
    assert_eq!(error.code(), "dae.initialization");
}

#[test]
fn scheduled_events_are_sorted_and_exactly_deduplicated() {
    let mut graph = EquationGraph::new();
    for (name, time) in [
        ("late", 2.0),
        ("first", 1.0),
        ("near but distinct", 1.0 + 5e-13),
        ("exact duplicate", 1.0),
    ] {
        graph
            .add_block(Block::new(
                name,
                Quantity::Dimensionless,
                BlockKind::StepSource {
                    before: 0.0,
                    after: 1.0,
                    at_s: time,
                },
            ))
            .unwrap();
    }
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    assert_eq!(system.events().len(), 3);
    assert_eq!(system.events()[0].time_s, 1.0);
    assert_eq!(system.events()[1].time_s, 1.0 + 5e-13);
    assert_eq!(system.events()[2].time_s, 2.0);
    assert!(system
        .events()
        .windows(2)
        .all(|pair| pair[0].time_s < pair[1].time_s));
}

#[test]
fn signed_zero_event_times_share_one_equivalent_restart() {
    let mut graph = EquationGraph::new();
    for (name, time) in [("negative zero", -0.0), ("positive zero", 0.0)] {
        graph
            .add_block(Block::new(
                name,
                Quantity::Dimensionless,
                BlockKind::StepSource {
                    before: -1.0,
                    after: 1.0,
                    at_s: time,
                },
            ))
            .unwrap();
    }
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    assert_eq!(system.events().len(), 1);
    assert_eq!(system.events()[0].time_s, 0.0);

    let mut residual = [9.0; 2];
    system
        .residual_into(-0.0, &[1.0, 1.0], &[0.0; 2], &mut residual)
        .unwrap();
    assert_eq!(residual, [0.0; 2]);

    system
        .residual_event_left_limit_into(0, &[1.0, 1.0], &[0.0; 2], &mut residual)
        .unwrap();
    assert_eq!(residual, [2.0; 2]);
}

#[test]
fn step_residual_is_right_continuous_at_its_event() {
    let mut graph = EquationGraph::new();
    graph
        .add_block(Block::new(
            "step",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 2.0,
                after: 9.0,
                at_s: 1.0,
            },
        ))
        .unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let mut residual = [0.0];

    system
        .residual_into(
            f64::from_bits(1.0_f64.to_bits() - 1),
            &[9.0],
            &[0.0],
            &mut residual,
        )
        .unwrap();
    assert_eq!(residual, [7.0]);
    system
        .residual_into(1.0, &[9.0], &[0.0], &mut residual)
        .unwrap();
    assert_eq!(residual, [0.0]);
    system
        .residual_into(
            f64::from_bits(1.0_f64.to_bits() + 1),
            &[9.0],
            &[0.0],
            &mut residual,
        )
        .unwrap();
    assert_eq!(residual, [0.0]);
}

#[test]
fn event_left_limit_selects_only_the_exact_simultaneous_step_group() {
    let selected_time = 1.0_f64;
    let near_later_time = f64::from_bits(selected_time.to_bits() + 1);
    let mut graph = EquationGraph::new();
    for (name, before, after, at_s) in [
        ("earlier", 10.0, 11.0, 0.5),
        ("selected a", 20.0, 21.0, selected_time),
        ("selected b", 30.0, 31.0, selected_time),
        ("near but distinct", 40.0, 41.0, near_later_time),
        ("later", 50.0, 51.0, 2.0),
    ] {
        graph
            .add_block(Block::new(
                name,
                Quantity::Dimensionless,
                BlockKind::StepSource {
                    before,
                    after,
                    at_s,
                },
            ))
            .unwrap();
    }
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    assert_eq!(
        system
            .events()
            .iter()
            .map(|event| event.time_s)
            .collect::<Vec<_>>(),
        vec![0.5, selected_time, near_later_time, 2.0]
    );

    let y = [0.0; 5];
    let yp = [0.0; 5];
    let mut residual = [99.0; 5];
    system
        .residual_into(selected_time, &y, &yp, &mut residual)
        .unwrap();
    assert_eq!(residual, [-11.0, -21.0, -31.0, -40.0, -50.0]);

    system
        .residual_event_left_limit_into(1, &y, &yp, &mut residual)
        .unwrap();
    assert_eq!(residual, [-11.0, -20.0, -30.0, -40.0, -50.0]);

    system
        .residual_event_left_limit_into(2, &y, &yp, &mut residual)
        .unwrap();
    assert_eq!(residual, [-11.0, -21.0, -31.0, -40.0, -50.0]);
}

#[test]
fn event_left_limit_rejects_invalid_index_and_inputs_without_writes() {
    let mut graph = EquationGraph::new();
    graph
        .add_block(Block::new(
            "step",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 2.0,
                after: 9.0,
                at_s: 1.0,
            },
        ))
        .unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);

    let mut residual = [77.0];
    for event_index in [1, usize::MAX] {
        let error = system
            .residual_event_left_limit_into(
                event_index,
                &[f64::NAN],
                &[f64::INFINITY],
                &mut residual,
            )
            .unwrap_err();
        assert_eq!(
            error,
            DaeError::InvalidEventIndex {
                event_index,
                event_count: 1,
            }
        );
        assert_eq!(error.code(), "dae.invalid_event_index");
        assert_eq!(residual, [77.0]);
    }

    for y in [&[][..], &[1.0, 2.0][..]] {
        let error = system
            .residual_event_left_limit_into(0, y, &[0.0], &mut residual)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::Y,
                expected: 1,
                actual,
            } if actual == y.len()
        ));
        assert_eq!(residual, [77.0]);
    }

    for yp in [&[][..], &[0.0, 0.0][..]] {
        let error = system
            .residual_event_left_limit_into(0, &[1.0], yp, &mut residual)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::Yp,
                expected: 1,
                actual,
            } if actual == yp.len()
        ));
        assert_eq!(residual, [77.0]);
    }

    for actual in [0, 2] {
        let mut wrong_residual = vec![66.0; actual];
        let error = system
            .residual_event_left_limit_into(0, &[1.0], &[0.0], &mut wrong_residual)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::Residual,
                expected: 1,
                actual: reported,
            } if reported == actual
        ));
        assert_eq!(wrong_residual, vec![66.0; actual]);
    }

    for (y, yp, expected_input) in [
        ([f64::NAN], [0.0], DaeInput::Y),
        ([1.0], [f64::NEG_INFINITY], DaeInput::Yp),
    ] {
        let error = system
            .residual_event_left_limit_into(0, &y, &yp, &mut residual)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::NonFiniteInput {
                input,
                index: Some(0),
            } if input == expected_input
        ));
        assert_eq!(residual, [77.0]);
    }

    let mut no_event_graph = EquationGraph::new();
    no_event_graph
        .add_block(Block::new(
            "constant",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let no_event_graph = no_event_graph.compile().unwrap();
    let no_event_system = lower(&no_event_graph);
    let error = no_event_system
        .residual_event_left_limit_into(0, &[1.0], &[0.0], &mut residual)
        .unwrap_err();
    assert_eq!(
        error,
        DaeError::InvalidEventIndex {
            event_index: 0,
            event_count: 0,
        }
    );
    assert_eq!(residual, [77.0]);
}

#[test]
fn event_left_limit_overflow_is_atomic() {
    let mut graph = EquationGraph::new();
    graph
        .add_block(Block::new(
            "overflowing left limit",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: -f64::MAX,
                after: 0.0,
                at_s: 1.0,
            },
        ))
        .unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let mut residual = [55.0];
    let error = system
        .residual_event_left_limit_into(0, &[f64::MAX], &[0.0], &mut residual)
        .unwrap_err();
    assert!(matches!(
        error,
        DaeError::NonFiniteResidual {
            row: 0,
            block_id: 0,
            time_s: 1.0,
        }
    ));
    assert_eq!(residual, [55.0]);
}

#[test]
fn event_and_initial_buffers_reject_short_and_long_slices_without_writes() {
    let mut graph = EquationGraph::new();
    let step = graph
        .add_block(Block::new(
            "step",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 1.0,
                after: 2.0,
                at_s: 3.0,
            },
        ))
        .unwrap();
    let state = graph
        .add_block(Block::new(
            "state",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 4.0,
                rate: Quantity::Dimensionless,
                gain: 1.0,
            },
        ))
        .unwrap();
    graph.connect(step, state, 0).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);

    let mut no_events = [];
    assert!(system.event_times_into(&mut no_events).is_err());
    let mut too_many_events = [77.0; 2];
    assert!(system.event_times_into(&mut too_many_events).is_err());
    assert_eq!(too_many_events, [77.0; 2]);

    let mut initial_y = [66.0; 2];
    let mut short_yp = [55.0; 1];
    assert!(system
        .initial_conditions_into(&mut initial_y, &mut short_yp)
        .is_err());
    assert_eq!(initial_y, [66.0; 2]);
    assert_eq!(short_yp, [55.0; 1]);

    let mut short_y = [44.0; 1];
    let mut initial_yp = [33.0; 2];
    assert!(system
        .initial_conditions_into(&mut short_y, &mut initial_yp)
        .is_err());
    assert_eq!(short_y, [44.0; 1]);
    assert_eq!(initial_yp, [33.0; 2]);
}

#[test]
fn residual_validation_never_partially_overwrites_the_destination() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let system = lower(&graph);
    let mut destination = [42.0; 3];

    let error = system
        .residual_into(
            f64::NAN,
            system.initial_y(),
            system.initial_yp(),
            &mut destination,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        DaeError::NonFiniteInput {
            input: DaeInput::Time,
            index: None
        }
    ));
    assert_eq!(destination, [42.0; 3]);

    let mut bad_y = system.initial_y().to_vec();
    bad_y[2] = f64::INFINITY;
    let error = system
        .residual_into(0.0, &bad_y, system.initial_yp(), &mut destination)
        .unwrap_err();
    assert!(matches!(
        error,
        DaeError::NonFiniteInput {
            input: DaeInput::Y,
            index: Some(2)
        }
    ));
    assert_eq!(destination, [42.0; 3]);

    let mut too_short = [17.0; 2];
    assert!(system
        .residual_into(0.0, system.initial_y(), system.initial_yp(), &mut too_short)
        .is_err());
    assert_eq!(too_short, [17.0; 2]);
}

#[test]
fn every_callback_buffer_rejects_short_and_long_lengths_atomically() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let system = lower(&graph);

    for actual in [2, 4] {
        let mut residual = vec![11.0; actual];
        let error = system
            .residual_into(0.0, system.initial_y(), system.initial_yp(), &mut residual)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::Residual,
                expected: 3,
                actual: reported
            } if reported == actual
        ));
        assert_eq!(residual, vec![11.0; actual]);
    }

    let jacobian_length = system.csc_pattern().nonzero_count();
    for actual in [jacobian_length - 1, jacobian_length + 1] {
        let mut jacobian = vec![12.0; actual];
        let error = system
            .jacobian_values_into(
                0.0,
                2.0,
                system.initial_y(),
                system.initial_yp(),
                &mut jacobian,
            )
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::JacobianValues,
                expected,
                actual: reported
            } if expected == jacobian_length && reported == actual
        ));
        assert_eq!(jacobian, vec![12.0; actual]);
    }

    for actual in [2, 4] {
        let mut outputs = vec![13.0; actual];
        let error = system
            .outputs_into(system.initial_y(), &mut outputs)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::Outputs,
                expected: 3,
                actual: reported
            } if reported == actual
        ));
        assert_eq!(outputs, vec![13.0; actual]);
    }

    for actual in [2, 4] {
        let wrong_y = vec![0.0; actual];
        let mut residual = [14.0; 3];
        let error = system
            .residual_into(0.0, &wrong_y, system.initial_yp(), &mut residual)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::Y,
                expected: 3,
                actual: reported
            } if reported == actual
        ));
        assert_eq!(residual, [14.0; 3]);

        let wrong_yp = vec![0.0; actual];
        let error = system
            .residual_into(0.0, system.initial_y(), &wrong_yp, &mut residual)
            .unwrap_err();
        assert!(matches!(
            error,
            DaeError::BufferLength {
                buffer: DaeBuffer::Yp,
                expected: 3,
                actual: reported
            } if reported == actual
        ));
        assert_eq!(residual, [14.0; 3]);
    }

    let mut long_initial_y = [15.0; 4];
    let mut exact_initial_yp = [16.0; 3];
    assert!(system
        .initial_conditions_into(&mut long_initial_y, &mut exact_initial_yp)
        .is_err());
    assert_eq!(long_initial_y, [15.0; 4]);
    assert_eq!(exact_initial_yp, [16.0; 3]);

    let mut exact_initial_y = [17.0; 3];
    let mut long_initial_yp = [18.0; 4];
    assert!(system
        .initial_conditions_into(&mut exact_initial_y, &mut long_initial_yp)
        .is_err());
    assert_eq!(exact_initial_y, [17.0; 3]);
    assert_eq!(long_initial_yp, [18.0; 4]);
}

#[test]
fn residual_overflow_is_reported_before_any_destination_write() {
    let mut graph = EquationGraph::new();
    let left = graph
        .add_block(Block::new(
            "left",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let right = graph
        .add_block(Block::new(
            "right",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let product = graph
        .add_block(Block::new(
            "overflow product",
            Quantity::Dimensionless,
            BlockKind::Product {
                scale: f64::MAX,
                left: Quantity::Dimensionless,
                right: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    graph.connect(left, product, 0).unwrap();
    graph.connect(right, product, 1).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let mut residual = [23.0; 3];
    let error = system
        .residual_into(0.0, &[2.0, 2.0, 0.0], &[0.0; 3], &mut residual)
        .unwrap_err();
    assert!(matches!(error, DaeError::NonFiniteResidual { row: 2, .. }));
    assert_eq!(error.code(), "dae.non_finite_residual");
    assert_eq!(residual, [23.0; 3]);
}

#[test]
fn jacobian_validation_and_overflow_are_atomic() {
    let mut graph = EquationGraph::new();
    let left = graph
        .add_block(Block::new(
            "left",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let right = graph
        .add_block(Block::new(
            "right",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let product = graph
        .add_block(Block::new(
            "overflow derivative",
            Quantity::Dimensionless,
            BlockKind::Product {
                scale: f64::MAX,
                left: Quantity::Dimensionless,
                right: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    graph.connect(left, product, 0).unwrap();
    graph.connect(right, product, 1).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let mut values = vec![71.0; system.csc_pattern().nonzero_count()];

    let error = system
        .jacobian_values_into(0.0, 1.0, &[2.0, 2.0, 0.0], &[0.0; 3], &mut values)
        .unwrap_err();
    assert!(matches!(error, DaeError::NonFiniteJacobian { row: 2, .. }));
    assert_eq!(values, vec![71.0; values.len()]);

    let error = system
        .jacobian_values_into(0.0, f64::INFINITY, &[1.0; 3], &[0.0; 3], &mut values)
        .unwrap_err();
    assert!(matches!(
        error,
        DaeError::NonFiniteInput {
            input: DaeInput::Cj,
            ..
        }
    ));
    assert_eq!(values, vec![71.0; values.len()]);
}

#[test]
fn outputs_restore_block_order_and_validate_before_writing() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let system = lower(&graph);
    let mut outputs = [0.0; 3];
    system
        .outputs_into(&[20.0, 40.0, 60.0], &mut outputs)
        .unwrap();
    assert_eq!(outputs, [40.0, 20.0, 60.0]);

    let mut sentinel = [19.0; 3];
    assert!(system
        .outputs_into(&[1.0, f64::NAN, 3.0], &mut sentinel)
        .is_err());
    assert_eq!(sentinel, [19.0; 3]);
    let mut short = [18.0; 2];
    assert!(system.outputs_into(&[1.0, 2.0, 3.0], &mut short).is_err());
    assert_eq!(short, [18.0; 2]);
}

#[test]
fn nonfinite_lowering_inputs_and_initial_rates_are_rejected() {
    let (graph, _, _, _) = constant_integrator_gain_graph();
    let error = DaeResidualSystem::lower(&graph, f64::NAN, &settings()).unwrap_err();
    assert!(matches!(
        error,
        DaeError::NonFiniteInput {
            input: DaeInput::InitializationTime,
            index: None
        }
    ));

    let mut overflow_graph = EquationGraph::new();
    let source = overflow_graph
        .add_block(Block::new(
            "huge source",
            Quantity::Dimensionless,
            BlockKind::Constant { value: f64::MAX },
        ))
        .unwrap();
    let state = overflow_graph
        .add_block(Block::new(
            "overflow rate",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 0.0,
                rate: Quantity::Dimensionless,
                gain: 2.0,
            },
        ))
        .unwrap();
    overflow_graph.connect(source, state, 0).unwrap();
    let overflow_graph = overflow_graph.compile().unwrap();
    let error = DaeResidualSystem::lower(&overflow_graph, 0.0, &settings()).unwrap_err();
    assert!(matches!(
        error,
        DaeError::NonFiniteInput {
            input: DaeInput::Yp,
            index: Some(0)
        }
    ));
}

#[test]
fn analytic_csc_matches_combined_residual_directional_differences() {
    let mut graph = EquationGraph::new();
    let command = graph
        .add_block(Block::new(
            "command",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 2.0 },
        ))
        .unwrap();
    let state = graph
        .add_block(Block::new(
            "state",
            Quantity::Dimensionless,
            BlockKind::FirstOrder {
                tau_s: 0.5,
                initial: 3.0,
            },
        ))
        .unwrap();
    let product = graph
        .add_block(Block::new(
            "product",
            Quantity::Dimensionless,
            BlockKind::Product {
                scale: 0.25,
                left: Quantity::Dimensionless,
                right: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    graph.connect(command, state, 0).unwrap();
    graph.connect(state, product, 0).unwrap();
    graph.connect(command, product, 1).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let y = [3.0, 2.0, 1.5];
    let yp = [-2.0, 0.0, 0.0];
    let cj = 4.0;
    let mut values = vec![0.0; system.csc_pattern().nonzero_count()];
    system
        .jacobian_values_into(0.0, cj, &y, &yp, &mut values)
        .unwrap();
    let analytic = dense_jacobian(&system, &values);

    let h = 1e-6;
    for column in 0..y.len() {
        let mut y_plus = y;
        let mut y_minus = y;
        let mut yp_plus = yp;
        let mut yp_minus = yp;
        y_plus[column] += h;
        y_minus[column] -= h;
        yp_plus[column] += cj * h;
        yp_minus[column] -= cj * h;
        let mut plus = [0.0; 3];
        let mut minus = [0.0; 3];
        system
            .residual_into(0.0, &y_plus, &yp_plus, &mut plus)
            .unwrap();
        system
            .residual_into(0.0, &y_minus, &yp_minus, &mut minus)
            .unwrap();
        for row in 0..y.len() {
            let finite_difference = (plus[row] - minus[row]) / (2.0 * h);
            assert!(
                (finite_difference - analytic[row][column]).abs() < 2e-9,
                "entry ({row}, {column}): finite difference {finite_difference}, analytic {}",
                analytic[row][column]
            );
        }
    }
}

#[test]
fn analytic_csc_matches_event_left_residual_at_step_equality() {
    let mut graph = EquationGraph::new();
    let command = graph
        .add_block(Block::new(
            "command",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 2.0,
                after: 5.0,
                at_s: 1.0,
            },
        ))
        .unwrap();
    let state = graph
        .add_block(Block::new(
            "state",
            Quantity::Dimensionless,
            BlockKind::FirstOrder {
                tau_s: 0.5,
                initial: 3.0,
            },
        ))
        .unwrap();
    let output = graph
        .add_block(Block::new(
            "output",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: 2.0,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    graph.connect(command, state, 0).unwrap();
    graph.connect(state, output, 0).unwrap();
    let graph = graph.compile().unwrap();
    let system = lower(&graph);
    let y = [3.0, 2.0, 6.0];
    let yp = [0.5, 0.0, 0.0];
    let cj = 4.0;
    let mut values = vec![0.0; system.csc_pattern().nonzero_count()];
    system
        .jacobian_values_into(1.0, cj, &y, &yp, &mut values)
        .unwrap();
    let analytic = dense_jacobian(&system, &values);

    let h = 1e-6;
    for column in 0..y.len() {
        let mut y_plus = y;
        let mut y_minus = y;
        let mut yp_plus = yp;
        let mut yp_minus = yp;
        y_plus[column] += h;
        y_minus[column] -= h;
        yp_plus[column] += cj * h;
        yp_minus[column] -= cj * h;
        let mut plus = [0.0; 3];
        let mut minus = [0.0; 3];
        system
            .residual_event_left_limit_into(0, &y_plus, &yp_plus, &mut plus)
            .unwrap();
        system
            .residual_event_left_limit_into(0, &y_minus, &yp_minus, &mut minus)
            .unwrap();
        for row in 0..y.len() {
            let finite_difference = (plus[row] - minus[row]) / (2.0 * h);
            assert!(
                (finite_difference - analytic[row][column]).abs() < 2e-9,
                "entry ({row}, {column}): finite difference {finite_difference}, analytic {}",
                analytic[row][column]
            );
        }
    }
}

#[test]
fn diagnostic_codes_cover_all_public_error_categories() {
    let equation = DaeError::Initialization(EquationError::EmptyGraph);
    let event_index = DaeError::InvalidEventIndex {
        event_index: 2,
        event_count: 1,
    };
    let buffer = DaeError::BufferLength {
        buffer: DaeBuffer::Y,
        expected: 1,
        actual: 2,
    };
    let input = DaeError::NonFiniteInput {
        input: DaeInput::Y,
        index: Some(0),
    };
    let residual = DaeError::NonFiniteResidual {
        row: 0,
        block_id: 0,
        time_s: 0.0,
    };
    let jacobian = DaeError::NonFiniteJacobian {
        row: 0,
        column: 0,
        block_id: 0,
        time_s: 0.0,
    };
    let nonsmooth = DaeError::NonsmoothJacobian {
        row: 0,
        block_id: 0,
        time_s: 0.0,
        input_value: 1.0,
        boundary: 1.0,
    };
    assert_eq!(equation.code(), "dae.initialization");
    assert_eq!(event_index.code(), "dae.invalid_event_index");
    assert_eq!(buffer.code(), "dae.buffer_length");
    assert_eq!(input.code(), "dae.non_finite_input");
    assert_eq!(residual.code(), "dae.non_finite_residual");
    assert_eq!(jacobian.code(), "dae.non_finite_jacobian");
    assert_eq!(nonsmooth.code(), "dae.nonsmooth_jacobian");
}
