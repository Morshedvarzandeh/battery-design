#![cfg(feature = "sundials-ida")]

mod event_restart_support;

use battery_design_core::dae::{
    DaeResidualSystem, DAE_ALGEBRAIC_ID, DAE_DIFFERENTIAL_ID, DAE_RESIDUAL_CONTRACT_VERSION,
};
use battery_design_core::equations::BlockId;
use battery_design_dae_native::{
    IdaAbsoluteTolerance, IdaDenseBackend, IdaError, IdaEventPolicy, IdaInitialConditionPolicy,
    IdaSettings, IdaSolveResult, MAX_EVENT_RESTARTS, NATIVE_IDA_BACKEND_CONTRACT,
    NATIVE_IDA_BACKEND_ID, NATIVE_IDA_RESULT_CONTRACT,
};
use event_restart_support::{
    core_settings, event_integrator_graph, next_positive_f64, previous_positive_f64,
    step_events_graph, two_event_integrator_graph_at,
};

const STATE_ABSOLUTE_TOLERANCE: f64 = 1.0e-7;
const STATE_RELATIVE_TOLERANCE: f64 = 2.0e-8;

fn dense_settings(
    initial_time_s: f64,
    output_times_s: Vec<f64>,
    event_policy: IdaEventPolicy,
) -> IdaSettings {
    IdaSettings {
        initial_time_s,
        output_times_s,
        relative_tolerance: 1.0e-8,
        absolute_tolerance: IdaAbsoluteTolerance::Scalar(1.0e-10),
        max_order: 5,
        max_steps: 10_000,
        max_dense_dimension: 4,
        suppress_algebraic_error: true,
        initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
        event_policy,
    }
}

fn solve(system: &DaeResidualSystem<'_>, settings: &IdaSettings) -> IdaSolveResult {
    IdaDenseBackend::new()
        .expect("pinned native IDA backend")
        .initialize_session(system, settings)
        .expect("registered dense IDA session")
        .solve_requested_grid()
        .expect("dense requested-grid solve")
}

fn value(result: &IdaSolveResult, row: usize, block: BlockId) -> f64 {
    let column = result
        .outputs()
        .iter()
        .position(|output| output.block_id == block)
        .expect("fixture block is present in stable output metadata");
    result.row(row).expect("requested result row")[column]
}

fn assert_near(actual: f64, expected: f64) {
    let tolerance = STATE_ABSOLUTE_TOLERANCE + STATE_RELATIVE_TOLERANCE * expected.abs();
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual:.16e} differs from {expected:.16e} by {:.3e}, tolerance {tolerance:.3e}",
        (actual - expected).abs(),
    );
}

fn assert_closed_accounting(result: &IdaSolveResult) {
    let stats = result.stats();
    let requested = u64::try_from(result.output_times_s().len()).unwrap();
    assert_eq!(stats.one_step_calls(), stats.internal_steps());
    assert_eq!(
        stats.interpolated_output_rows()
            + stats.step_endpoint_output_rows()
            + stats.event_equality_output_rows(),
        requested
    );
    assert_eq!(
        stats.endpoint_state_captures(),
        stats.event_restarts() + stats.step_endpoint_output_rows()
    );
    assert_eq!(
        stats.terminal_state_time_s(),
        *result.output_times_s().last().unwrap()
    );
}

#[test]
fn dense_default_reject_preserves_fail_closed_scheduled_event_behavior() {
    let graph = step_events_graph(&[0.5]);
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let settings = dense_settings(0.0, vec![0.75], IdaEventPolicy::Reject);
    let backend = IdaDenseBackend::new().unwrap();

    let error = backend.initialize_session(&system, &settings).unwrap_err();

    assert_eq!(error, IdaError::UnsupportedEvents { count: 1 });
}

#[test]
fn dense_restart_result_binds_v2_contracts_backend_and_requested_policy() {
    let fixture = event_integrator_graph(0.5);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let policy = IdaEventPolicy::Restart { max_restarts: 1 };
    let settings = dense_settings(0.0, vec![0.5, 0.75], policy);
    let backend = IdaDenseBackend::new().unwrap();
    let identity = backend.identity();

    let result = backend
        .initialize_session(&system, &settings)
        .unwrap()
        .solve_requested_grid()
        .unwrap();

    assert_eq!(identity.backend_id, NATIVE_IDA_BACKEND_ID);
    assert_eq!(identity.contract, NATIVE_IDA_BACKEND_CONTRACT);
    assert_eq!(identity.matrix, "SUNMATRIX_DENSE");
    assert_eq!(identity.linear_solver, "SUNLINSOL_DENSE");
    assert!(!identity.sparse);
    assert_eq!(result.backend_identity(), identity);
    assert_eq!(result.result_contract(), NATIVE_IDA_RESULT_CONTRACT);
    assert_eq!(result.residual_contract(), DAE_RESIDUAL_CONTRACT_VERSION);
    assert_eq!(result.configured_event_policy(), policy);
    assert_eq!(result.configured_max_order(), settings.max_order);
    assert_eq!(result.configured_max_steps(), settings.max_steps);
    assert_eq!(value(&result, 0, fixture.source), 2.0);
    assert_near(value(&result, 0, fixture.state), 0.5);
    assert_eq!(value(&result, 1, fixture.source), 2.0);
    assert_near(value(&result, 1, fixture.state), 1.0);
    assert_eq!(result.stats().event_restarts(), 1);
    assert_eq!(result.stats().event_equality_output_rows(), 1);
    assert_eq!(result.stats().last_linear_solver_flag(), 0);
    assert_closed_accounting(&result);
}

#[test]
fn dense_active_distinct_event_count_governs_restart_admission() {
    let graph = step_events_graph(&[0.25, 0.25, 0.5, 2.0]);
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    assert_eq!(
        system
            .events()
            .iter()
            .map(|event| event.time_s)
            .collect::<Vec<_>>(),
        vec![0.25, 0.5, 2.0]
    );

    let limited = dense_settings(0.0, vec![1.0], IdaEventPolicy::Restart { max_restarts: 1 });
    assert_eq!(
        limited.validate_for(&system),
        Err(IdaError::EventRestartLimit {
            active: 2,
            maximum: 1,
        })
    );

    let admitted = dense_settings(0.0, vec![1.0], IdaEventPolicy::Restart { max_restarts: 2 });
    assert_eq!(admitted.validate_for(&system), Ok(()));
}

#[test]
fn dense_restart_maximum_above_backend_ceiling_is_rejected() {
    let graph = step_events_graph(&[0.5]);
    let system = DaeResidualSystem::lower(&graph, 0.0, &core_settings()).unwrap();
    let at_ceiling = dense_settings(
        0.0,
        vec![0.75],
        IdaEventPolicy::Restart {
            max_restarts: MAX_EVENT_RESTARTS,
        },
    );
    assert_eq!(at_ceiling.validate_for(&system), Ok(()));

    let above_ceiling = dense_settings(
        0.0,
        vec![0.75],
        IdaEventPolicy::Restart {
            max_restarts: MAX_EVENT_RESTARTS + 1,
        },
    );
    assert_eq!(
        above_ceiling.validate_for(&system),
        Err(IdaError::InvalidSetting {
            code: "ida.events.max_restarts.out_of_range",
            field: "event_policy.max_restarts",
        })
    );
}

#[test]
fn dense_initial_time_mismatch_is_rejected_while_signed_zero_matches() {
    let fixture = event_integrator_graph(0.25);
    let system = DaeResidualSystem::lower(&fixture.graph, -0.0, &core_settings()).unwrap();
    let matching = dense_settings(0.0, vec![0.5], IdaEventPolicy::Restart { max_restarts: 1 });

    let result = solve(&system, &matching);
    assert_eq!(value(&result, 0, fixture.source), 2.0);
    assert_near(value(&result, 0, fixture.state), 0.75);
    assert_eq!(result.stats().event_restarts(), 1);
    assert_closed_accounting(&result);

    let mismatched = dense_settings(
        0.125,
        vec![0.5],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );
    assert_eq!(
        mismatched.validate_for(&system),
        Err(IdaError::InitializationTimeMismatch {
            system_time_s: -0.0,
            requested_time_s: 0.125,
        })
    );
}

#[test]
fn dense_single_event_grid_matches_left_equality_and_right_analytic_values() {
    let event_time_s = 0.5;
    let immediately_before = previous_positive_f64(event_time_s);
    let fixture = event_integrator_graph(event_time_s);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let settings = dense_settings(
        0.0,
        vec![immediately_before, event_time_s, 0.75],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );

    let result = solve(&system, &settings);

    for (row, (source, state)) in [(1.0, immediately_before), (2.0, 0.5), (2.0, 1.0)]
        .into_iter()
        .enumerate()
    {
        assert_eq!(value(&result, row, fixture.source), source);
        assert_near(value(&result, row, fixture.state), state);
    }
    assert_eq!(result.stats().event_restarts(), 1);
    assert_eq!(result.stats().event_equality_output_rows(), 1);
    assert_closed_accounting(&result);
}

#[test]
fn dense_simultaneous_step_sources_share_one_restart_and_right_correction() {
    let fixture = two_event_integrator_graph_at(0.5, 0.5);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    assert_eq!(system.events().len(), 1);
    let settings = dense_settings(
        0.0,
        vec![0.5, 0.75],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );

    let result = solve(&system, &settings);

    for row in 0..2 {
        assert_eq!(value(&result, row, fixture.first), 2.0);
        assert_eq!(value(&result, row, fixture.second), 1.0);
        assert_eq!(value(&result, row, fixture.sum), 3.0);
    }
    assert_near(value(&result, 0, fixture.state), 0.5);
    assert_near(value(&result, 1, fixture.state), 1.25);
    assert_eq!(result.stats().event_restarts(), 1);
    assert_eq!(result.stats().event_equality_output_rows(), 1);
    assert_closed_accounting(&result);
}

#[test]
fn dense_two_distinct_events_restart_in_order_and_match_piecewise_integral() {
    let fixture = two_event_integrator_graph_at(0.3, 0.6);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    assert_eq!(
        system
            .events()
            .iter()
            .map(|event| event.time_s)
            .collect::<Vec<_>>(),
        vec![0.3, 0.6]
    );
    let settings = dense_settings(
        0.0,
        vec![0.3, 0.6, 0.9],
        IdaEventPolicy::Restart { max_restarts: 2 },
    );

    let result = solve(&system, &settings);

    for (row, (first, second, sum, state)) in [
        (2.0, 0.0, 2.0, 0.3),
        (2.0, 1.0, 3.0, 0.9),
        (2.0, 1.0, 3.0, 1.8),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(value(&result, row, fixture.first), first);
        assert_eq!(value(&result, row, fixture.second), second);
        assert_eq!(value(&result, row, fixture.sum), sum);
        assert_near(value(&result, row, fixture.state), state);
    }
    assert_eq!(result.stats().event_restarts(), 2);
    assert_eq!(result.stats().event_equality_output_rows(), 2);
    assert_closed_accounting(&result);
}

#[test]
fn dense_event_at_final_horizon_is_inclusive_and_publishes_terminal_equality() {
    let fixture = event_integrator_graph(0.5);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let mut settings = dense_settings(
        0.0,
        vec![0.25, 0.5],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );

    let reference = solve(&system, &settings);
    let required_steps = reference.stats().internal_steps();
    assert!(required_steps > 0);
    settings.max_steps = required_steps;
    let exact = solve(&system, &settings);

    for (row, (source, state)) in [(1.0, 0.25), (2.0, 0.5)].into_iter().enumerate() {
        assert_eq!(value(&reference, row, fixture.source), source);
        assert_near(value(&reference, row, fixture.state), state);
        assert_eq!(value(&exact, row, fixture.source), source);
        assert_near(value(&exact, row, fixture.state), state);
    }
    assert_eq!(exact.stats().internal_steps(), required_steps);
    assert_eq!(exact.stats().one_step_calls(), required_steps);
    assert_eq!(exact.stats().event_restarts(), 1);
    assert_eq!(exact.stats().event_equality_output_rows(), 1);
    assert_eq!(exact.stats().output_rows_at_step_limit(), 1);
    assert!(exact.stats().last_order() > 0);
    assert!(exact.stats().last_accepted_step_current_order() > 0);
    assert!(exact.stats().last_step_s() > 0.0);
    assert!(exact.stats().last_accepted_step_next_step_s() > 0.0);
    assert_eq!(
        exact.stats().current_order(),
        exact.stats().last_accepted_step_current_order()
    );
    assert_eq!(
        exact.stats().current_step_s(),
        exact.stats().last_accepted_step_next_step_s()
    );
    assert_eq!(exact.stats().current_internal_time_s(), 0.5);
    assert_eq!(exact.stats().terminal_state_time_s(), 0.5);
    assert_closed_accounting(&exact);
}

#[test]
fn dense_event_at_initial_time_is_exclusive_and_needs_no_restart() {
    let fixture = event_integrator_graph(0.0);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let settings = dense_settings(0.0, vec![0.5], IdaEventPolicy::Restart { max_restarts: 0 });

    let result = solve(&system, &settings);

    assert_eq!(value(&result, 0, fixture.source), 2.0);
    assert_near(value(&result, 0, fixture.state), 1.0);
    assert_eq!(result.stats().event_restarts(), 0);
    assert_eq!(result.stats().event_equality_output_rows(), 0);
    assert_eq!(result.stats().interpolated_output_rows(), 0);
    assert_eq!(result.stats().step_endpoint_output_rows(), 1);
    assert_eq!(result.stats().endpoint_state_captures(), 1);
    assert_closed_accounting(&result);
}

#[test]
fn dense_event_one_ulp_after_final_is_inactive_and_cannot_contaminate_output() {
    let final_time_s = 0.5;
    let inactive_event_time_s = next_positive_f64(final_time_s);

    let inactive_only = event_integrator_graph(inactive_event_time_s);
    let inactive_system =
        DaeResidualSystem::lower(&inactive_only.graph, 0.0, &core_settings()).unwrap();
    let inactive_settings = dense_settings(
        0.0,
        vec![final_time_s],
        IdaEventPolicy::Restart { max_restarts: 0 },
    );
    let inactive_result = solve(&inactive_system, &inactive_settings);
    assert_eq!(value(&inactive_result, 0, inactive_only.source), 1.0);
    assert_near(value(&inactive_result, 0, inactive_only.state), 0.5);
    assert_eq!(inactive_result.stats().event_restarts(), 0);
    assert_eq!(inactive_result.stats().event_equality_output_rows(), 0);
    assert_eq!(inactive_result.stats().interpolated_output_rows(), 0);
    assert_eq!(inactive_result.stats().step_endpoint_output_rows(), 1);
    assert_eq!(inactive_result.stats().endpoint_state_captures(), 1);
    assert_closed_accounting(&inactive_result);

    let mixed = two_event_integrator_graph_at(0.25, inactive_event_time_s);
    let mixed_system = DaeResidualSystem::lower(&mixed.graph, 0.0, &core_settings()).unwrap();
    let mixed_settings = dense_settings(
        0.0,
        vec![final_time_s],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );
    let mixed_result = solve(&mixed_system, &mixed_settings);
    assert_eq!(value(&mixed_result, 0, mixed.first), 2.0);
    assert_eq!(value(&mixed_result, 0, mixed.second), 0.0);
    assert_eq!(value(&mixed_result, 0, mixed.sum), 2.0);
    assert_near(value(&mixed_result, 0, mixed.state), 0.75);
    assert_eq!(mixed_result.stats().event_restarts(), 1);
    assert_eq!(mixed_result.stats().event_equality_output_rows(), 0);
    assert_eq!(mixed_result.stats().interpolated_output_rows(), 0);
    assert_eq!(mixed_result.stats().step_endpoint_output_rows(), 1);
    assert_eq!(mixed_result.stats().endpoint_state_captures(), 2);
    assert_closed_accounting(&mixed_result);
}

#[test]
fn dense_nonzero_initial_time_restart_matches_piecewise_integral() {
    let initial_time_s = 10.0;
    let event_time_s = 10.5;
    let immediately_before = previous_positive_f64(event_time_s);
    let fixture = event_integrator_graph(event_time_s);
    let system =
        DaeResidualSystem::lower(&fixture.graph, initial_time_s, &core_settings()).unwrap();
    let settings = dense_settings(
        initial_time_s,
        vec![immediately_before, event_time_s, 10.75],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );

    let result = solve(&system, &settings);

    for (row, (source, state)) in [
        (1.0, immediately_before - initial_time_s),
        (2.0, 0.5),
        (2.0, 1.0),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(value(&result, row, fixture.source), source);
        assert_near(value(&result, row, fixture.state), state);
    }
    assert_eq!(result.stats().event_restarts(), 1);
    assert_eq!(result.stats().event_equality_output_rows(), 1);
    assert_closed_accounting(&result);
}

#[test]
fn dense_signed_zero_event_and_output_share_numeric_equality() {
    let fixture = event_integrator_graph(-0.0);
    let system = DaeResidualSystem::lower(&fixture.graph, -1.0, &core_settings()).unwrap();
    let settings = dense_settings(-1.0, vec![0.0], IdaEventPolicy::Restart { max_restarts: 1 });

    let result = solve(&system, &settings);

    assert_eq!(value(&result, 0, fixture.source), 2.0);
    assert_near(value(&result, 0, fixture.state), 1.0);
    assert_eq!(result.stats().event_restarts(), 1);
    assert_eq!(result.stats().event_equality_output_rows(), 1);
    assert_eq!(result.stats().terminal_state_time_s(), 0.0);
    assert_closed_accounting(&result);
}

#[test]
fn dense_corrected_initial_conditions_remain_consistent_across_restart() {
    let fixture = event_integrator_graph(0.5);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let mut y = system.initial_y().to_vec();
    let mut yp = system.initial_yp().to_vec();
    for (index, &id) in system.id_vector().iter().enumerate() {
        if id == DAE_ALGEBRAIC_ID {
            y[index] = -99.0;
        } else {
            assert_eq!(id, DAE_DIFFERENTIAL_ID);
            yp[index] = 99.0;
        }
    }
    let mut settings = dense_settings(
        0.0,
        vec![0.25, 0.5, 0.75],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );
    settings.initial_conditions =
        IdaInitialConditionPolicy::CorrectAlgebraicAndDerivative { y, yp };
    let backend = IdaDenseBackend::new().unwrap();
    let session = backend.initialize_session(&system, &settings).unwrap();
    assert!(session.corrected_initial_conditions());

    let result = session.solve_requested_grid().unwrap();

    for (row, (source, state)) in [(1.0, 0.25), (2.0, 0.5), (2.0, 1.0)]
        .into_iter()
        .enumerate()
    {
        assert_eq!(value(&result, row, fixture.source), source);
        assert_near(value(&result, row, fixture.state), state);
    }
    assert_eq!(result.stats().event_restarts(), 1);
    assert_eq!(result.stats().event_equality_output_rows(), 1);
    assert_closed_accounting(&result);
}

#[test]
fn dense_event_segment_and_correction_targets_fail_preflight_when_unrepresentable() {
    let initial_time_s = 1.0_f64;
    let too_close_event = next_positive_f64(initial_time_s);
    let too_close_graph = step_events_graph(&[too_close_event]);
    let too_close_system =
        DaeResidualSystem::lower(&too_close_graph, initial_time_s, &core_settings()).unwrap();
    let too_close_settings = dense_settings(
        initial_time_s,
        vec![2.0],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );
    assert_eq!(
        too_close_settings.validate_for(&too_close_system),
        Err(IdaError::InvalidEventSchedule {
            code: "ida.events.segment_too_close",
            event_index: 0,
            event_time_s: too_close_event,
        })
    );

    let event_time_s = 1.0_f64;
    let adjacent_event = next_positive_f64(event_time_s);
    let adjacent_graph = step_events_graph(&[event_time_s, adjacent_event]);
    let adjacent_system = DaeResidualSystem::lower(&adjacent_graph, 0.0, &core_settings()).unwrap();
    let adjacent_settings =
        dense_settings(0.0, vec![2.0], IdaEventPolicy::Restart { max_restarts: 2 });
    assert_eq!(
        adjacent_settings.validate_for(&adjacent_system),
        Err(IdaError::InvalidEventSchedule {
            code: "ida.events.correction_target_invalid",
            event_index: 0,
            event_time_s,
        })
    );

    let final_graph = step_events_graph(&[f64::MAX]);
    let final_system = DaeResidualSystem::lower(&final_graph, 0.0, &core_settings()).unwrap();
    let final_settings = dense_settings(
        0.0,
        vec![f64::MAX],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );
    assert_eq!(
        final_settings.validate_for(&final_system),
        Err(IdaError::InvalidEventSchedule {
            code: "ida.events.correction_target_invalid",
            event_index: 0,
            event_time_s: f64::MAX,
        })
    );

    let usable_event = f64::from_bits(initial_time_s.to_bits() + 501);
    let usable_graph = step_events_graph(&[usable_event]);
    let usable_system =
        DaeResidualSystem::lower(&usable_graph, initial_time_s, &core_settings()).unwrap();
    let usable_settings = dense_settings(
        initial_time_s,
        vec![2.0],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );
    assert_eq!(usable_settings.validate_for(&usable_system), Ok(()));
}

#[test]
fn dense_output_row_and_endpoint_custody_counters_close_exactly() {
    let event_time_s = 0.5;
    let immediately_before = previous_positive_f64(event_time_s);
    let fixture = event_integrator_graph(event_time_s);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let settings = dense_settings(
        0.0,
        vec![immediately_before, event_time_s, 0.75],
        IdaEventPolicy::Restart { max_restarts: 1 },
    );

    let result = solve(&system, &settings);

    assert_eq!(result.stats().interpolated_output_rows(), 1);
    assert_eq!(result.stats().event_equality_output_rows(), 1);
    assert_eq!(result.stats().step_endpoint_output_rows(), 1);
    assert_eq!(result.stats().event_restarts(), 1);
    assert_eq!(result.stats().endpoint_state_captures(), 2);
    assert_closed_accounting(&result);
}

#[test]
fn dense_global_step_budget_is_cumulative_across_event_segments() {
    let fixture = two_event_integrator_graph_at(0.3, 0.6);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let mut settings = dense_settings(
        0.0,
        vec![0.3, 0.6, 2.0],
        IdaEventPolicy::Restart { max_restarts: 2 },
    );

    let reference = solve(&system, &settings);
    let required_steps = reference.stats().internal_steps();
    assert!(required_steps > 1);

    settings.max_steps = required_steps;
    let exact = solve(&system, &settings);
    assert_eq!(exact.values_time_major(), reference.values_time_major());
    assert_eq!(exact.stats().internal_steps(), required_steps);
    assert_eq!(exact.stats().one_step_calls(), required_steps);
    assert_eq!(exact.stats().event_restarts(), 2);
    assert_eq!(exact.stats().event_equality_output_rows(), 2);
    assert_eq!(exact.stats().output_rows_at_step_limit(), 1);
    assert_near(value(&exact, 0, fixture.state), 0.3);
    assert_near(value(&exact, 1, fixture.state), 0.9);
    assert_near(value(&exact, 2, fixture.state), 5.1);
    assert_closed_accounting(&exact);

    let cap = required_steps - 1;
    settings.max_steps = cap;
    let error = IdaDenseBackend::new()
        .unwrap()
        .initialize_session(&system, &settings)
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
            assert_eq!(requested_time_s, 2.0);
            assert!(current_internal_time_s < requested_time_s);
            assert_eq!(native_flag, None);
        }
        other => panic!("unexpected cumulative global-cap error: {other:?}"),
    }
}

#[test]
fn dense_repeated_restart_sessions_are_bitwise_deterministic_including_stats() {
    let fixture = two_event_integrator_graph_at(0.3, 0.6);
    let system = DaeResidualSystem::lower(&fixture.graph, 0.0, &core_settings()).unwrap();
    let settings = dense_settings(
        0.0,
        vec![0.3, 0.6, 0.9],
        IdaEventPolicy::Restart { max_restarts: 2 },
    );

    let first = solve(&system, &settings);
    for (row, expected) in [0.3, 0.9, 1.8].into_iter().enumerate() {
        assert_near(value(&first, row, fixture.state), expected);
    }
    assert_eq!(value(&first, 0, fixture.first), 2.0);
    assert_eq!(value(&first, 0, fixture.second), 0.0);
    assert_eq!(value(&first, 1, fixture.first), 2.0);
    assert_eq!(value(&first, 1, fixture.second), 1.0);
    assert_closed_accounting(&first);

    let second = solve(&system, &settings);
    assert_eq!(first, second);
    assert_eq!(first.stats(), second.stats());
    assert_eq!(
        first
            .output_times_s()
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        second
            .output_times_s()
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        first
            .values_time_major()
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        second
            .values_time_major()
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>()
    );
    for (first_value, second_value) in [
        (
            first.stats().actual_initial_step_s(),
            second.stats().actual_initial_step_s(),
        ),
        (first.stats().last_step_s(), second.stats().last_step_s()),
        (
            first.stats().last_accepted_step_next_step_s(),
            second.stats().last_accepted_step_next_step_s(),
        ),
        (
            first.stats().current_step_s(),
            second.stats().current_step_s(),
        ),
        (
            first.stats().current_internal_time_s(),
            second.stats().current_internal_time_s(),
        ),
        (
            first.stats().terminal_state_time_s(),
            second.stats().terminal_state_time_s(),
        ),
    ] {
        assert_eq!(first_value.to_bits(), second_value.to_bits());
    }
}
