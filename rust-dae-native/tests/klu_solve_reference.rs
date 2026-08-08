#![cfg(feature = "sundials-ida-klu")]

use battery_design_core::dae::{DaeResidualSystem, DAE_RESIDUAL_CONTRACT_VERSION};
use battery_design_core::equations::{
    Block, BlockId, BlockKind, CompiledGraph, EquationGraph, Quantity, SolverSettings,
};
use battery_design_dae_native::{
    IdaAbsoluteTolerance, IdaError, IdaInitialConditionPolicy, IdaKluBackend, IdaKluSettings,
    IdaSolveResult, MAX_KLU_DIMENSION, MAX_KLU_JACOBIAN_ENTRY_WORK, MAX_KLU_KNOWN_CSC_BYTES,
    MAX_KLU_NONZEROS, MAX_KLU_RESULT_VALUES, NATIVE_IDA_KLU_BACKEND_CONTRACT,
    NATIVE_IDA_KLU_BACKEND_ID, NATIVE_IDA_KLU_RESULT_CONTRACT, PINNED_KLU_VERSION,
    PINNED_SUITESPARSE_VERSION, PINNED_SUNDIALS_VERSION,
};

fn core_settings() -> SolverSettings {
    SolverSettings {
        end_s: 0.0,
        ..SolverSettings::default()
    }
}

fn klu_settings(output_times_s: Vec<f64>) -> IdaKluSettings {
    IdaKluSettings {
        initial_time_s: 0.0,
        output_times_s,
        relative_tolerance: 1.0e-8,
        absolute_tolerance: IdaAbsoluteTolerance::Scalar(1.0e-10),
        max_order: 5,
        max_steps: 1_000_000,
        max_dimension: MAX_KLU_DIMENSION,
        max_nonzeros: MAX_KLU_NONZEROS,
        max_known_csc_bytes: MAX_KLU_KNOWN_CSC_BYTES,
        max_jacobian_evaluations: 100_000,
        max_jacobian_entry_work: MAX_KLU_JACOBIAN_ENTRY_WORK,
        max_result_values: MAX_KLU_RESULT_VALUES,
        suppress_algebraic_error: true,
        initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
    }
}

fn solve(system: &DaeResidualSystem<'_>, settings: &IdaKluSettings) -> IdaSolveResult {
    IdaKluBackend::new()
        .expect("pinned IDA/KLU backend")
        .initialize_session(system, settings)
        .expect("registered sparse IDA session")
        .solve_requested_grid()
        .expect("sparse requested-grid solve")
}

fn value(result: &IdaSolveResult, row: usize, block: BlockId) -> f64 {
    let column = result
        .outputs()
        .iter()
        .position(|output| output.block_id == block)
        .unwrap();
    result.row(row).unwrap()[column]
}

fn assert_near(actual: f64, expected: f64, absolute: f64, relative: f64) {
    let tolerance = absolute + relative * expected.abs();
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual:.16e} differs from {expected:.16e} by {:.3e}, tolerance {tolerance:.3e}",
        (actual - expected).abs(),
    );
}

fn exponential_graph() -> (CompiledGraph, BlockId, BlockId) {
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
            "state",
            Quantity::Dimensionless,
            BlockKind::FirstOrder {
                tau_s: 1.0,
                initial: 0.0,
            },
        ))
        .unwrap();
    graph.connect(target, state, 0).unwrap();
    (graph.compile().unwrap(), target, state)
}

fn affine_graph() -> (CompiledGraph, BlockId, BlockId, BlockId) {
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

struct RobertsonGraph {
    graph: CompiledGraph,
    y1: BlockId,
    y2: BlockId,
    y3: BlockId,
}

fn robertson_graph() -> RobertsonGraph {
    let mut graph = EquationGraph::new();
    let y1 = graph
        .add_block(Block::new(
            "y1",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 1.0,
                rate: Quantity::Dimensionless,
                gain: 1.0,
            },
        ))
        .unwrap();
    let y2 = graph
        .add_block(Block::new(
            "y2",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 0.0,
                rate: Quantity::Dimensionless,
                gain: 1.0,
            },
        ))
        .unwrap();
    let one = graph
        .add_block(Block::new(
            "one",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let minus_y1 = graph
        .add_block(Block::new(
            "minus y1",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: -1.0,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let minus_y2 = graph
        .add_block(Block::new(
            "minus y2",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: -1.0,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let y3 = graph
        .add_block(Block::new(
            "y3",
            Quantity::Dimensionless,
            BlockKind::Sum { inputs: 3 },
        ))
        .unwrap();
    let negative_point_zero_four_y1 = graph
        .add_block(Block::new(
            "-0.04 y1",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: -0.04,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let ten_thousand_y2_y3 = graph
        .add_block(Block::new(
            "1e4 y2 y3",
            Quantity::Dimensionless,
            BlockKind::Product {
                scale: 1.0e4,
                left: Quantity::Dimensionless,
                right: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let f1 = graph
        .add_block(Block::new(
            "f1",
            Quantity::Dimensionless,
            BlockKind::Sum { inputs: 2 },
        ))
        .unwrap();
    let point_zero_four_y1 = graph
        .add_block(Block::new(
            "0.04 y1",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: 0.04,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let negative_ten_thousand_y2_y3 = graph
        .add_block(Block::new(
            "-1e4 y2 y3",
            Quantity::Dimensionless,
            BlockKind::Product {
                scale: -1.0e4,
                left: Quantity::Dimensionless,
                right: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let negative_thirty_million_y2_squared = graph
        .add_block(Block::new(
            "-3e7 y2 squared",
            Quantity::Dimensionless,
            BlockKind::Product {
                scale: -3.0e7,
                left: Quantity::Dimensionless,
                right: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    let f2 = graph
        .add_block(Block::new(
            "f2",
            Quantity::Dimensionless,
            BlockKind::Sum { inputs: 3 },
        ))
        .unwrap();

    graph.connect(f1, y1, 0).unwrap();
    graph.connect(f2, y2, 0).unwrap();
    graph.connect(y1, minus_y1, 0).unwrap();
    graph.connect(y2, minus_y2, 0).unwrap();
    graph.connect(one, y3, 0).unwrap();
    graph.connect(minus_y1, y3, 1).unwrap();
    graph.connect(minus_y2, y3, 2).unwrap();
    graph.connect(y1, negative_point_zero_four_y1, 0).unwrap();
    graph.connect(y2, ten_thousand_y2_y3, 0).unwrap();
    graph.connect(y3, ten_thousand_y2_y3, 1).unwrap();
    graph.connect(negative_point_zero_four_y1, f1, 0).unwrap();
    graph.connect(ten_thousand_y2_y3, f1, 1).unwrap();
    graph.connect(y1, point_zero_four_y1, 0).unwrap();
    graph.connect(y2, negative_ten_thousand_y2_y3, 0).unwrap();
    graph.connect(y3, negative_ten_thousand_y2_y3, 1).unwrap();
    graph
        .connect(y2, negative_thirty_million_y2_squared, 0)
        .unwrap();
    graph
        .connect(y2, negative_thirty_million_y2_squared, 1)
        .unwrap();
    graph.connect(point_zero_four_y1, f2, 0).unwrap();
    graph.connect(negative_ten_thousand_y2_y3, f2, 1).unwrap();
    graph
        .connect(negative_thirty_million_y2_squared, f2, 2)
        .unwrap();

    RobertsonGraph {
        graph: graph.compile().unwrap(),
        y1,
        y2,
        y3,
    }
}

fn algebraic_chain_graph(dimension: usize) -> CompiledGraph {
    let mut graph = EquationGraph::new();
    let mut previous = graph
        .add_block(Block::new(
            "chain 0",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    for index in 1..dimension {
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
fn klu_backend_has_no_dense_fallback_identity() {
    let identity = IdaKluBackend::new().unwrap().identity();
    assert_eq!(identity.backend_id, NATIVE_IDA_KLU_BACKEND_ID);
    assert_eq!(identity.linear_solver, "SUNLINSOL_KLU_COLAMD");
    assert!(identity.sparse);
}

#[test]
fn exponential_smoke_matches_the_closed_form() {
    let (graph, _, state) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let times = vec![0.1, 0.5, 1.0, 2.0, 4.0];
    let result = solve(&system, &klu_settings(times.clone()));
    for (row, time) in times.into_iter().enumerate() {
        assert_near(
            value(&result, row, state),
            1.0 - (-time).exp(),
            5.0e-8,
            5.0e-8,
        );
    }
}

#[test]
fn affine_index_one_smoke_preserves_every_algebraic_relation() {
    let (graph, source, state, observed) = affine_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let times = vec![0.01, 0.25, 1.0, 2.0];
    let result = solve(&system, &klu_settings(times.clone()));
    for (row, time) in times.into_iter().enumerate() {
        let state_value = value(&result, row, state);
        assert_near(value(&result, row, source), 4.0, 2.0e-9, 0.0);
        assert_near(state_value, 2.0 + 8.0 * time, 5.0e-8, 2.0e-9);
        assert_near(
            value(&result, row, observed),
            3.0 * state_value,
            5.0e-8,
            2.0e-9,
        );
    }
}

#[test]
fn robertson_stiff_smoke_matches_independent_radau_fixture() {
    const TIMES: [f64; 3] = [0.4, 4.0, 40.0];
    const EXPECTED: [[f64; 3]; 3] = [
        [0.985172113860991, 3.38639537897492e-5, 0.014794022185221],
        [0.905518678584278, 2.24047568756037e-5, 0.0944589166588479],
        [0.715827068719909, 9.18553476457835e-6, 0.284163745745328],
    ];
    let RobertsonGraph { graph, y1, y2, y3 } = robertson_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut settings = klu_settings(TIMES.to_vec());
    settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
    let result = solve(&system, &settings);
    for (row, expected) in EXPECTED.into_iter().enumerate() {
        let actual = [
            value(&result, row, y1),
            value(&result, row, y2),
            value(&result, row, y3),
        ];
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert_near(actual, expected, 1.0e-7, 2.0e-7);
        }
    }
}

#[test]
fn repeated_sparse_jacobian_setups_prove_full_csc_restoration() {
    let RobertsonGraph { graph, .. } = robertson_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let result = solve(&system, &klu_settings(vec![0.4, 4.0, 40.0]));
    assert!(result.stats().jacobian_evaluations() > 1);
    assert!(result.stats().linear_solver_setups() > 1);
}

#[test]
fn result_binds_sparse_backend_result_and_residual_contracts() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let result = solve(&system, &klu_settings(vec![0.5]));
    assert_eq!(result.result_contract(), NATIVE_IDA_KLU_RESULT_CONTRACT);
    assert_eq!(
        result.backend_identity().contract,
        NATIVE_IDA_KLU_BACKEND_CONTRACT
    );
    for expected in [
        PINNED_SUNDIALS_VERSION,
        PINNED_SUITESPARSE_VERSION,
        PINNED_KLU_VERSION,
    ] {
        assert!(result.backend_identity().version.contains(expected));
    }
    assert_eq!(result.residual_contract(), DAE_RESIDUAL_CONTRACT_VERSION);
}

#[test]
fn public_last_linear_flag_is_success_without_exposing_klu_structs() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let result = solve(&system, &klu_settings(vec![0.5, 1.0]));
    assert_eq!(result.stats().last_linear_solver_flag(), 0);
}

#[test]
fn repeated_fresh_sparse_sessions_are_bitwise_deterministic() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let settings = klu_settings(vec![0.1, 0.5, 1.0, 2.0]);
    assert_eq!(solve(&system, &settings), solve(&system, &settings));
}

#[test]
fn scalar_and_uniform_vector_tolerances_are_numerically_identical() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut scalar = klu_settings(vec![0.1, 0.5, 1.0]);
    scalar.absolute_tolerance = IdaAbsoluteTolerance::Scalar(2.0e-10);
    let mut vector = scalar.clone();
    vector.absolute_tolerance = IdaAbsoluteTolerance::Vector(vec![2.0e-10; 2]);
    assert_eq!(solve(&system, &scalar), solve(&system, &vector));
}

#[test]
fn corrected_initial_conditions_work_with_sparse_linear_solver() {
    let (graph, source, state, observed) = affine_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut settings = klu_settings(vec![0.25]);
    settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
        y: vec![9.0, -10.0, 99.0],
        yp: vec![-7.0, 42.0, 23.0],
    };
    let result = solve(&system, &settings);
    assert_near(value(&result, 0, source), 4.0, 2.0e-9, 0.0);
    assert_near(value(&result, 0, state), 11.0, 5.0e-8, 0.0);
    assert_near(value(&result, 0, observed), 33.0, 8.0e-8, 0.0);
}

#[test]
fn result_rows_are_closed_exact_time_major_views() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let result = solve(&system, &klu_settings(vec![0.1, 0.5, 1.0]));
    let width = result.outputs().len();
    assert_eq!(result.values_time_major().len(), 3 * width);
    assert_eq!(
        result.row(2),
        Some(&result.values_time_major()[2 * width..3 * width])
    );
    assert_eq!(result.row(3), None);
    assert_eq!(result.row(usize::MAX), None);
}

#[test]
fn maximum_order_one_is_honored_by_sparse_session() {
    let (graph, _, state) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut settings = klu_settings(vec![0.25, 1.0, 2.0]);
    settings.max_order = 1;
    settings.relative_tolerance = 1.0e-6;
    let result = solve(&system, &settings);
    assert_eq!(result.stats().maximum_order_used(), 1);
    assert_near(
        value(&result, 2, state),
        1.0 - (-2.0_f64).exp(),
        3.0e-4,
        3.0e-4,
    );
}

#[test]
fn tighter_sparse_tolerances_reduce_closed_form_error() {
    let (graph, _, state) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut loose = klu_settings(vec![0.7, 2.0, 4.0]);
    loose.relative_tolerance = 1.0e-3;
    loose.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-5);
    let mut tight = loose.clone();
    tight.relative_tolerance = 1.0e-9;
    tight.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
    let loose = solve(&system, &loose);
    let tight = solve(&system, &tight);
    let expected = 1.0 - (-4.0_f64).exp();
    assert!(
        (value(&tight, 2, state) - expected).abs() < (value(&loose, 2, state) - expected).abs()
    );
}

#[test]
fn callback_jacobian_evaluation_ceiling_fails_with_typed_error_first() {
    let RobertsonGraph { graph, .. } = robertson_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut settings = klu_settings(vec![40.0]);
    settings.max_jacobian_evaluations = 1;
    settings.max_jacobian_entry_work = system.csc_pattern().nonzero_count() as u64;
    let error = IdaKluBackend::new()
        .unwrap()
        .initialize_session(&system, &settings)
        .unwrap()
        .solve_requested_grid()
        .unwrap_err();
    assert_eq!(
        error,
        IdaError::KluJacobianEvaluationLimit {
            attempted: 2,
            maximum: 1,
        }
    );
}

#[test]
fn nonincreasing_output_grid_is_rejected_before_sparse_session_allocation() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let settings = klu_settings(vec![0.5, 0.5]);
    let error = IdaKluBackend::new()
        .unwrap()
        .initialize_session(&system, &settings)
        .unwrap_err();
    assert_eq!(error.code(), "ida.output_times.not_strictly_increasing");
}

#[test]
fn short_vector_tolerance_is_rejected_before_sparse_session_allocation() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut settings = klu_settings(vec![0.5]);
    settings.absolute_tolerance = IdaAbsoluteTolerance::Vector(vec![1.0e-10]);
    assert_eq!(
        IdaKluBackend::new()
            .unwrap()
            .initialize_session(&system, &settings)
            .unwrap_err(),
        IdaError::VectorLength {
            field: "absolute_tolerance",
            expected: 2,
            actual: 1,
        }
    );
}

#[test]
fn scheduled_events_remain_an_explicit_sparse_backend_error() {
    let mut graph = EquationGraph::new();
    graph
        .add_block(Block::new(
            "step",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 0.0,
                after: 1.0,
                at_s: 0.25,
            },
        ))
        .unwrap();
    let graph = graph.compile().unwrap();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    assert_eq!(
        IdaKluBackend::new()
            .unwrap()
            .initialize_session(&system, &klu_settings(vec![0.5]))
            .unwrap_err(),
        IdaError::UnsupportedEvents { count: 1 }
    );
}

#[test]
fn repeated_initialize_drop_cycles_preserve_sparse_lifecycle() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let backend = IdaKluBackend::new().unwrap();
    for _ in 0..32 {
        let session = backend
            .initialize_session(&system, &klu_settings(vec![0.1]))
            .unwrap();
        assert_eq!(session.dimension(), 2);
        drop(session);
    }
}

#[test]
fn one_thousand_variable_sparse_session_initializes_and_drops() {
    let graph = algebraic_chain_graph(1_000);
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let backend = IdaKluBackend::new().unwrap();
    let session = backend
        .initialize_session(&system, &klu_settings(vec![0.01]))
        .unwrap();
    assert_eq!(session.dimension(), 1_000);
    assert_eq!(system.csc_pattern().nonzero_count(), 1_999);
    drop(session);
}
