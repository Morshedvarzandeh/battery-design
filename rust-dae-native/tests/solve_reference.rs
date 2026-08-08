#![cfg(feature = "sundials-ida")]

use battery_design_core::dae::{DaeResidualSystem, DAE_RESIDUAL_CONTRACT_VERSION};
use battery_design_core::equations::{
    Block, BlockId, BlockKind, CompiledGraph, EquationGraph, IntegrationMethod, Quantity,
    SolverSettings,
};
use battery_design_dae_native::{
    IdaAbsoluteTolerance, IdaDenseBackend, IdaEventPolicy, IdaInitialConditionPolicy, IdaSettings,
    IdaSolveResult, MAX_DENSE_DIMENSION, NATIVE_IDA_BACKEND_CONTRACT, NATIVE_IDA_BACKEND_ID,
    NATIVE_IDA_RESULT_CONTRACT, PINNED_SUNDIALS_VERSION,
};

fn core_settings() -> SolverSettings {
    SolverSettings {
        end_s: 0.0,
        ..SolverSettings::default()
    }
}

fn ida_settings(output_times_s: Vec<f64>) -> IdaSettings {
    IdaSettings {
        initial_time_s: 0.0,
        output_times_s,
        relative_tolerance: 1.0e-8,
        absolute_tolerance: IdaAbsoluteTolerance::Scalar(1.0e-10),
        max_order: 5,
        max_steps: 250_000,
        max_dense_dimension: MAX_DENSE_DIMENSION,
        suppress_algebraic_error: true,
        initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
        event_policy: IdaEventPolicy::Reject,
    }
}

fn solve(system: &DaeResidualSystem<'_>, settings: &IdaSettings) -> IdaSolveResult {
    let backend = IdaDenseBackend::new().expect("pinned native IDA backend");
    backend
        .initialize_session(system, settings)
        .expect("registered IDA session")
        .solve_requested_grid()
        .expect("requested-grid solve")
}

fn value(result: &IdaSolveResult, requested_index: usize, block_id: BlockId) -> f64 {
    let column = result
        .outputs()
        .iter()
        .position(|output| output.block_id == block_id)
        .expect("block is present in stable output metadata");
    result.row(requested_index).expect("requested row")[column]
}

fn assert_near(actual: f64, expected: f64, absolute: f64, relative: f64) {
    let tolerance = absolute + relative * expected.abs();
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual:.16e} differs from {expected:.16e} by {:.3e}, tolerance {tolerance:.3e}",
        (actual - expected).abs(),
    );
}

/// `x' = (1 - x)` with `x(0) = 0`, so `x(t) = 1 - exp(-t)`.
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
            "exponential state",
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

/// A semi-explicit index-1 system with one differential and two algebraic rows:
/// `x' = 8`, `source = 4`, and `observed = 3*x`.
fn affine_index_one_graph() -> (CompiledGraph, BlockId, BlockId, BlockId) {
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

/// Robertson's stiff kinetics in semi-explicit index-1 form:
///
/// `y1' = -0.04*y1 + 1e4*y2*y3`
/// `y2' =  0.04*y1 - 1e4*y2*y3 - 3e7*y2^2`
/// `0   = y3 - (1 - y1 - y2)`
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
    let minus_point_zero_four_y1 = graph
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
    let minus_ten_thousand_y2_y3 = graph
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
    let minus_thirty_million_y2_squared = graph
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
    graph.connect(y1, minus_point_zero_four_y1, 0).unwrap();
    graph.connect(y2, ten_thousand_y2_y3, 0).unwrap();
    graph.connect(y3, ten_thousand_y2_y3, 1).unwrap();
    graph.connect(minus_point_zero_four_y1, f1, 0).unwrap();
    graph.connect(ten_thousand_y2_y3, f1, 1).unwrap();
    graph.connect(y1, point_zero_four_y1, 0).unwrap();
    graph.connect(y2, minus_ten_thousand_y2_y3, 0).unwrap();
    graph.connect(y3, minus_ten_thousand_y2_y3, 1).unwrap();
    graph
        .connect(y2, minus_thirty_million_y2_squared, 0)
        .unwrap();
    graph
        .connect(y2, minus_thirty_million_y2_squared, 1)
        .unwrap();
    graph.connect(point_zero_four_y1, f2, 0).unwrap();
    graph.connect(minus_ten_thousand_y2_y3, f2, 1).unwrap();
    graph
        .connect(minus_thirty_million_y2_squared, f2, 2)
        .unwrap();

    RobertsonGraph {
        graph: graph.compile().unwrap(),
        y1,
        y2,
        y3,
    }
}

#[test]
fn analytic_exponential_uses_the_exact_grid_and_stable_block_order() {
    let (graph, target, state) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let requested = vec![0.05, 0.2, 0.75, 1.5, 3.0];
    let result = solve(&system, &ida_settings(requested.clone()));

    assert_eq!(result.output_times_s(), requested);
    assert_eq!(
        result
            .outputs()
            .iter()
            .map(|output| output.block_id)
            .collect::<Vec<_>>(),
        (0..result.outputs().len()).collect::<Vec<_>>()
    );
    assert_eq!(result.outputs()[target].name, "target");
    assert_eq!(result.outputs()[state].name, "exponential state");

    for (requested_index, time_s) in requested.iter().copied().enumerate() {
        assert_near(value(&result, requested_index, target), 1.0, 2.0e-10, 0.0);
        assert_near(
            value(&result, requested_index, state),
            1.0 - (-time_s).exp(),
            3.0e-8,
            3.0e-8,
        );
    }
}

#[test]
fn analytic_exponential_error_converges_across_three_tolerance_levels() {
    let (graph, _, state) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let requested = vec![0.13, 0.47, 1.1, 2.3, 4.0];
    let tolerance_levels = [(1.0e-2, 1.0e-4), (1.0e-5, 1.0e-7), (1.0e-8, 1.0e-10)];

    // This is an accuracy study against the independent closed form
    // x(t) = 1 - exp(-t), not against stored output from this IDA adapter.
    // The tolerance pairs are deliberately separated by three decades so the
    // convergence signal remains larger than floating-point and interpolation
    // noise while still exercising IDA's real adaptive error controller.
    let mut maximum_errors = Vec::with_capacity(tolerance_levels.len());
    for (relative_tolerance, absolute_tolerance) in tolerance_levels {
        let mut settings = ida_settings(requested.clone());
        settings.relative_tolerance = relative_tolerance;
        settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(absolute_tolerance);
        let result = solve(&system, &settings);
        let maximum_error = requested
            .iter()
            .copied()
            .enumerate()
            .map(|(requested_index, time_s)| {
                let expected = 1.0 - (-time_s).exp();
                (value(&result, requested_index, state) - expected).abs()
            })
            .fold(0.0_f64, f64::max);
        maximum_errors.push(maximum_error);
    }

    assert!(
        maximum_errors[0] > maximum_errors[1] && maximum_errors[1] > maximum_errors[2],
        "expected monotone loose/medium/tight convergence, got {maximum_errors:?}"
    );
    assert!(
        maximum_errors[1] <= maximum_errors[0] * 0.1,
        "medium error did not improve loose error by at least 10x: {maximum_errors:?}"
    );
    assert!(
        maximum_errors[2] <= maximum_errors[1] * 0.1,
        "tight error did not improve medium error by at least 10x: {maximum_errors:?}"
    );
    assert!(
        maximum_errors[2] <= 5.0e-8,
        "tight solve exceeded its analytical error envelope: {maximum_errors:?}"
    );
}

#[test]
fn ida_and_rust_core_dormand_prince_agree_on_the_same_ode_graph() {
    let (graph, _, state) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let requested = vec![0.2, 0.75, 1.6, 3.0, 4.0];
    let mut ida = ida_settings(requested.clone());
    ida.relative_tolerance = 1.0e-9;
    ida.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
    let ida_result = solve(&system, &ida);

    // Provenance: `CompiledGraph::simulate` is rust-core's pre-existing,
    // independently implemented explicit Dormand-Prince 5(4) solver. It does
    // not call this crate, IDA, or the DAE residual adapter. Each run ends at
    // the exact comparison time, avoiding interpolation between its adaptive
    // trace points. Both solvers are also checked against the analytical
    // solution, so agreement cannot validate one solver by self-reference.
    const CROSS_SOLVER_ABSOLUTE_TOLERANCE: f64 = 1.0e-8;
    for (requested_index, time_s) in requested.iter().copied().enumerate() {
        let core_result = graph
            .simulate(SolverSettings {
                method: IntegrationMethod::DormandPrince45,
                start_s: 0.0,
                end_s: time_s,
                initial_step_s: 0.05,
                min_step_s: 1.0e-12,
                max_step_s: 0.2,
                relative_tolerance: 1.0e-10,
                absolute_tolerance: 1.0e-12,
                max_steps: 100_000,
                ..SolverSettings::default()
            })
            .expect("independent rust-core Dormand-Prince solve");
        assert_eq!(
            core_result.solver.selected,
            IntegrationMethod::DormandPrince45
        );
        assert_eq!(
            core_result.points.last().expect("final trace point").time_s,
            time_s
        );

        let ida_value = value(&ida_result, requested_index, state);
        let core_value = core_result.last_value(state).expect("state output");
        let analytical_value = 1.0 - (-time_s).exp();
        assert_near(ida_value, analytical_value, 1.0e-8, 0.0);
        assert_near(core_value, analytical_value, 1.0e-10, 0.0);
        assert_near(ida_value, core_value, CROSS_SOLVER_ABSOLUTE_TOLERANCE, 0.0);
    }
}

#[test]
fn repeated_fresh_sessions_are_bitwise_deterministic_including_stats() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let settings = ida_settings(vec![0.1, 0.4, 1.0, 2.0]);

    let first = solve(&system, &settings);
    let second = solve(&system, &settings);

    assert_eq!(first, second);
    assert_eq!(first.backend_identity(), second.backend_identity());
    assert_eq!(first.stats(), second.stats());
}

#[test]
fn maximum_order_five_uses_higher_order_and_fewer_steps_than_order_one() {
    let (graph, _, state) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let requested = vec![0.25, 0.5, 1.0, 2.0, 4.0];
    let mut order_one_settings = ida_settings(requested.clone());
    order_one_settings.relative_tolerance = 1.0e-6;
    order_one_settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-9);
    order_one_settings.max_order = 1;
    let mut order_five_settings = order_one_settings.clone();
    order_five_settings.max_order = 5;

    let order_one = solve(&system, &order_one_settings);
    let order_five = solve(&system, &order_five_settings);

    assert_eq!(order_one.stats().maximum_order_used(), 1);
    assert_eq!(order_one.stats().last_order(), 1);
    assert!(
        order_five.stats().maximum_order_used() > 1,
        "order-five solve never raised order: {:?}",
        order_five.stats()
    );
    assert!(order_five.stats().maximum_order_used() <= 5);
    assert!(
        order_five.stats().internal_steps() < order_one.stats().internal_steps(),
        "order 5 used {} steps; order 1 used {}",
        order_five.stats().internal_steps(),
        order_one.stats().internal_steps()
    );

    for (requested_index, time_s) in requested.iter().copied().enumerate() {
        let expected = 1.0 - (-time_s).exp();
        assert_near(
            value(&order_one, requested_index, state),
            expected,
            2.0e-4,
            2.0e-4,
        );
        assert_near(
            value(&order_five, requested_index, state),
            expected,
            2.0e-5,
            2.0e-5,
        );
    }
}

#[test]
fn scalar_and_uniform_vector_tolerances_have_identical_results_and_work() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut scalar_settings = ida_settings(vec![0.1, 0.3, 0.9, 2.0]);
    scalar_settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(2.0e-10);
    let mut vector_settings = scalar_settings.clone();
    vector_settings.absolute_tolerance =
        IdaAbsoluteTolerance::Vector(vec![2.0e-10; system.variables().len()]);

    let scalar = solve(&system, &scalar_settings);
    let vector = solve(&system, &vector_settings);

    assert_eq!(scalar.output_times_s(), vector.output_times_s());
    assert_eq!(scalar.outputs(), vector.outputs());
    assert_eq!(scalar.values_time_major(), vector.values_time_major());
    assert_eq!(scalar.stats(), vector.stats());
}

#[test]
fn corrected_algebraic_and_derivative_initial_conditions_then_solve() {
    let (graph, source, state, observed) = affine_index_one_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    assert_eq!(system.id_vector(), [1.0, 0.0, 0.0]);
    let mut settings = ida_settings(vec![0.25, 0.5, 1.0]);
    settings.initial_conditions = IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative {
        y: vec![9.0, -10.0, 99.0],
        yp: vec![-7.0, 42.0, 23.0],
    };

    let result = solve(&system, &settings);

    for (requested_index, time_s) in settings.output_times_s.iter().copied().enumerate() {
        let expected_state = 9.0 + 8.0 * time_s;
        assert_near(value(&result, requested_index, source), 4.0, 2.0e-9, 0.0);
        assert_near(
            value(&result, requested_index, state),
            expected_state,
            2.0e-8,
            2.0e-9,
        );
        assert_near(
            value(&result, requested_index, observed),
            3.0 * expected_state,
            5.0e-8,
            2.0e-9,
        );
    }
}

#[test]
fn result_rows_are_exact_private_shape_views_with_closed_bounds() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let settings = ida_settings(vec![0.125, 0.5, 2.0]);
    let result = solve(&system, &settings);
    let width = result.outputs().len();

    assert_eq!(
        result.values_time_major().len(),
        result.output_times_s().len() * width
    );
    for requested_index in 0..result.output_times_s().len() {
        let start = requested_index * width;
        assert_eq!(
            result.row(requested_index),
            Some(&result.values_time_major()[start..start + width])
        );
    }
    assert_eq!(result.row(result.output_times_s().len()), None);
    assert_eq!(result.row(usize::MAX), None);
}

#[test]
fn result_binds_backend_result_and_residual_contract_identities() {
    let (graph, _, _) = exponential_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let settings = ida_settings(vec![0.5, 1.0]);
    let backend = IdaDenseBackend::new().unwrap();
    let backend_identity = backend.identity();
    let result = backend
        .initialize_session(&system, &settings)
        .unwrap()
        .solve_requested_grid()
        .unwrap();

    assert_eq!(result.result_contract(), NATIVE_IDA_RESULT_CONTRACT);
    assert_eq!(result.backend_identity(), backend_identity);
    assert_eq!(result.residual_contract(), system.contract_version());
    assert_eq!(result.residual_contract(), DAE_RESIDUAL_CONTRACT_VERSION);
    assert_eq!(result.configured_max_order(), settings.max_order);
    assert_eq!(result.configured_max_steps(), settings.max_steps);
    assert_eq!(backend_identity.backend_id, NATIVE_IDA_BACKEND_ID);
    assert_eq!(backend_identity.contract, NATIVE_IDA_BACKEND_CONTRACT);
    assert_eq!(backend_identity.version, PINNED_SUNDIALS_VERSION);
    assert_eq!(backend_identity.solver, "IDA");
    assert_eq!(backend_identity.vector, "NVECTOR_SERIAL");
    assert_eq!(backend_identity.matrix, "SUNMATRIX_DENSE");
    assert_eq!(backend_identity.linear_solver, "SUNLINSOL_DENSE");
    assert!(!backend_identity.sparse);
}

#[test]
fn affine_index_one_reference_preserves_algebraic_relations_at_every_row() {
    let (graph, source, state, observed) = affine_index_one_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let requested = vec![0.01, 0.1, 0.75, 2.0];
    let result = solve(&system, &ida_settings(requested.clone()));

    for (requested_index, time_s) in requested.iter().copied().enumerate() {
        let source_value = value(&result, requested_index, source);
        let state_value = value(&result, requested_index, state);
        let observed_value = value(&result, requested_index, observed);
        assert_near(source_value, 4.0, 2.0e-9, 0.0);
        assert_near(state_value, 2.0 + 8.0 * time_s, 3.0e-8, 2.0e-9);
        assert_near(observed_value, 3.0 * state_value, 3.0e-8, 2.0e-9);
    }
}

#[test]
fn robertson_stiff_index_one_matches_independent_scipy_radau_reference() {
    const SCIPY_1_17_RADAU_TIMES_S: [f64; 3] = [0.4, 4.0, 40.0];
    const SCIPY_1_17_RADAU_VALUES: [[f64; 3]; 3] = [
        [0.985172113860991, 3.38639537897492e-5, 0.014794022185221],
        [0.905518678584278, 2.24047568756037e-5, 0.0944589166588479],
        [0.715827068719909, 9.18553476457835e-6, 0.284163745745328],
    ];
    const SCIPY_COMPARISON_ABSOLUTE_TOLERANCE: f64 = 1.0e-7;
    const SCIPY_COMPARISON_RELATIVE_TOLERANCE: f64 = 2.0e-7;

    // Independent external provenance: these fixtures were regenerated with
    // SciPy 1.17.0 `scipy.integrate.solve_ivp(method="Radau", rtol=1e-12,
    // atol=1e-14, t_eval=[0.4, 4, 40])` on the equivalent all-differential
    // Robertson ODE, y3' = 3e7*y2^2, from y(0) = [1, 0, 0]. The reference run
    // reported success=true, nfev=11076, njev=4, and nlu=116. Solver API:
    // https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html
    let RobertsonGraph { graph, y1, y2, y3 } = robertson_graph();
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let mut settings = ida_settings(SCIPY_1_17_RADAU_TIMES_S.to_vec());
    settings.relative_tolerance = 1.0e-8;
    settings.absolute_tolerance = IdaAbsoluteTolerance::Scalar(1.0e-11);
    settings.max_steps = 1_000_000;
    let result = solve(&system, &settings);

    for (requested_index, expected) in SCIPY_1_17_RADAU_VALUES.into_iter().enumerate() {
        let actual = [
            value(&result, requested_index, y1),
            value(&result, requested_index, y2),
            value(&result, requested_index, y3),
        ];
        for (component, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
            assert_near(
                actual,
                expected,
                SCIPY_COMPARISON_ABSOLUTE_TOLERANCE,
                SCIPY_COMPARISON_RELATIVE_TOLERANCE,
            );
            assert!(
                actual >= 0.0,
                "row {requested_index}, component {component}"
            );
        }
        assert_near(actual.iter().sum::<f64>(), 1.0, 1.0e-8, 1.0e-8);
    }
    assert!(result.stats().maximum_order_used() > 1);
    assert_eq!(
        result.stats().internal_steps(),
        result.stats().one_step_calls()
    );
}
