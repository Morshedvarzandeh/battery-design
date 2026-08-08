import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const rustTestNames = (source) => [...source.matchAll(
  /^\s*#\[test\]\s*\n\s*fn\s+([a-z0-9_]+)\s*\(/gmu,
)].map((match) => match[1]);

const ITERATION_3_KLU_INTERNAL_SEAMS = Object.freeze([
  'sparse_pattern_requires_every_structural_diagonal_before_native_allocation',
  'sparse_callback_restores_columns_rows_and_values_after_every_zero',
  'sparse_callback_rejects_dense_matrix_type_before_any_slice',
  'sparse_callback_rejects_matrix_vector_alias_before_any_slice',
  'singular_klu_solve_exposes_public_last_linear_flag_evidence',
  'last_linear_getter_failure_never_masks_original_klu_stage_and_flag',
]);

const ITERATION_4_KLU_INTERNAL_SEAMS = Object.freeze([
  'sparse_event_marker_bounds_work_and_writes_at_exact_and_overshoot_times',
  'klu_restart_solves_multiple_segments_without_dense_fallback',
  'klu_terminal_stop_blocks_an_inactive_event_one_ulp_after_final',
  'active_event_klu_failure_preserves_one_context_and_last_flag_evidence',
  'klu_callback_budget_persists_across_event_reinit_and_right_side_calc_ic',
  'klu_validation_applies_initial_time_and_event_preflight_before_allocation',
]);

const ITERATION_4_PROXY_BASELINE_SHA = '032638ba3ee2b7d6cd2ec730b529a63a96ca3ffb';
const ITERATION_4_PROXY_SOURCE_COUNTS = Object.freeze({
  'rust-core/src/dae.rs': 1,
  'rust-core/tests/dae_contract.rs': 29,
  'rust-core/tests/dae_allocation.rs': 1,
  'rust-dae-native/src/native.rs': 73,
  'rust-dae-native/tests/feature_off.rs': 1,
  'rust-dae-native/tests/backend_identity.rs': 2,
  'rust-dae-native/tests/solve_reference.rs': 11,
  'rust-dae-native/tests/klu_feature_off.rs': 4,
  'rust-dae-native/tests/klu_backend_identity.rs': 25,
  'rust-dae-native/tests/klu_solve_reference.rs': 19,
});
const ITERATION_4_PROXY_NAME_FILTER = /(event|restart|reinit|stop_time|consistent|initial_condition|right_continu|correction)/u;
const ITERATION_4_PROXY_POPULATION_SHA256 = 'a9382670c4667d1316f2fd5177c8cf522c697eaf70eab9fb16c7d29e5dddd894';
const ITERATION_4_PROXY_MATCHES_SHA256 = '6911df8109acfc06f2a8004d8f52b8468926229fc4f80f2f55bb758ffc501bbc';

// Frozen from every Cargo test function in the ten sources above at the
// pinned merged Iteration 3 SHA. This is a historical denominator, not a live
// source count, so later Iteration 4 tests cannot silently move it.
const ITERATION_4_PROXY_POPULATION = Object.freeze([
  'actual_solve_preserves_the_limit_jacobian_error',
  'affine_index_one_reference_preserves_algebraic_relations_at_every_row',
  'affine_index_one_smoke_preserves_every_algebraic_relation',
  'aliased_mutable_callback_outputs_are_rejected_before_rust_slices_exist',
  'analytic_csc_matches_combined_residual_directional_differences',
  'analytic_dense_jacobian_matches_combined_finite_differences',
  'analytic_exponential_error_converges_across_three_tolerance_levels',
  'analytic_exponential_uses_the_exact_grid_and_stable_block_order',
  'applied_dimension_limit_reports_actual_and_both_ceilings',
  'applied_known_csc_byte_limit_is_exact_and_excludes_factor_fill',
  'applied_nonzero_limit_reports_exact_pattern_count',
  'applied_result_value_limit_uses_exact_grid_times_output_product',
  'backend_owned_sparse_ceilings_are_exact_and_nonzero',
  'both_limit_kinks_fail_closed_before_jacobian_writes',
  'calc_ic_jacobian_panic_is_contained_and_precedes_native_flag',
  'calc_ic_residual_panic_is_contained_and_precedes_native_flag',
  'calc_ic_returns_the_first_exact_jacobian_callback_error',
  'callback_jacobian_evaluation_ceiling_fails_with_typed_error_first',
  'caller_buffer_dae_success_paths_allocate_zero_times',
  'configured_jacobian_entry_projection_must_fit_applied_limit',
  'constants_gains_and_sums_have_auditable_algebraic_residuals',
  'consuming_solve_drops_native_resources_before_returning_owned_result',
  'contract_grid_allows_near_initial_interpolation_but_correction_rejects_it',
  'corrected_algebraic_and_derivative_initial_conditions_then_solve',
  'corrected_initial_conditions_work_with_sparse_linear_solver',
  'correction_policy_updates_algebraic_y_and_differential_yp',
  'correction_work_is_snapshotted_out_of_published_solve_deltas',
  'coupled_solvable_algebraic_loop_lowers_with_a_small_initial_residual',
  'csc_pattern_and_values_are_replay_deterministic',
  'default_build_reports_unavailable_without_falling_back',
  'dense_grid_is_interpolated_after_the_last_allowed_step',
  'dense_jacobian_scatter_is_column_major_for_a_nonsymmetric_system',
  'diagnostic_codes_cover_all_public_error_categories',
  'dimension_above_hard_ceiling_is_rejected_before_native_allocation',
  'dimension_one_constructs_and_releases_every_resource',
  'dimension_setting_cannot_exceed_backend_ceiling',
  'dimension_two_constructs_and_releases_every_resource',
  'duplicate_csc_dependencies_retain_the_lowered_accumulated_derivative',
  'duplicate_product_sources_accumulate_chain_rule_terms',
  'duplicate_sum_sources_accumulate_in_one_csc_entry',
  'event_and_initial_buffers_reject_short_and_long_slices_without_writes',
  'every_callback_buffer_rejects_short_and_long_lengths_atomically',
  'every_non_success_solve_flag_preserves_exact_stage_and_flag',
  'every_other_settings_category_is_validated_before_native_allocation',
  'every_partial_construction_path_releases_all_prior_resources',
  'exact_global_step_budget_passes_without_an_off_by_one_step',
  'exponential_smoke_matches_the_closed_form',
  'failed_consuming_solve_balances_every_native_resource',
  'feature_on_backend_reports_the_exact_dense_serial_identity',
  'first_callback_error_is_never_replaced_by_a_later_failure',
  'first_order_rows_use_yp_minus_the_physical_rate',
  'fresh_klu_contexts_have_identical_public_evidence',
  'full_drop_order_releases_dependents_before_their_dependencies',
  'hard_ceiling_dimension_constructs_and_releases_every_resource',
  'id_vector_is_explicit_and_copy_is_atomic_on_both_length_errors',
  'ida_and_rust_core_dormand_prince_agree_on_the_same_ode_graph',
  'ida_roundoff_last_invalid_and_first_native_valid_distances_are_governed',
  'identity_binds_all_three_pinned_versions',
  'identity_binds_serial_csc_klu_colamd_surface',
  'identity_is_disjoint_from_dense_contract_and_backend',
  'inconsistent_algebraic_loop_fails_during_initialization',
  'initial_step_time_advance_rejects_500_ulps_and_accepts_501',
  'initialized_session_drop_releases_ida_before_pinned_callback_state',
  'integrator_initial_conditions_satisfy_the_residual_contract',
  'interpolation_guard_rejects_7_8_extrapolation_before_ffi',
  'interpolation_guard_rejects_replaying_the_previous_step_endpoint',
  'invalid_maximum_steps_are_rejected_before_native_allocation',
  'jacobian_callback_panic_is_contained_and_latched',
  'jacobian_evaluation_setting_cannot_exceed_backend_ceiling',
  'jacobian_panic_during_actual_solve_precedes_native_flag',
  'jacobian_validation_and_overflow_are_atomic',
  'klu_backend_has_no_dense_fallback_identity',
  'klu_construction_fails_closed_without_its_feature',
  'klu_identity_cannot_be_confused_with_dense_identity',
  'known_csc_accounting_is_available_without_native_code',
  'known_csc_accounting_rejects_integer_overflow',
  'known_csc_byte_setting_cannot_exceed_backend_ceiling',
  'last_linear_getter_failure_never_masks_original_klu_stage_and_flag',
  'limit_jacobian_has_defined_inside_and_outside_policies',
  'limit_kink_preserves_the_exact_underlying_dae_error',
  'lowered_exponential_passes_complete_sparse_admission',
  'lowering_classifies_state_first_without_changing_output_order',
  'many_requested_outputs_cannot_reset_the_global_step_budget',
  'maximum_order_five_uses_higher_order_and_fewer_steps_than_order_one',
  'maximum_order_one_and_five_are_both_registered_successfully',
  'maximum_order_one_is_honored_by_sparse_session',
  'maximum_order_six_is_rejected_before_native_allocation',
  'maximum_order_zero_is_rejected_before_native_allocation',
  'maximum_step_endpoints_are_registered_without_narrowing',
  'measured_csc_builder_has_exact_linear_work_and_four_bounded_allocations',
  'native_context_can_be_destroyed_and_recreated_without_shared_state',
  'native_error_flags_are_never_collapsed_or_treated_as_success',
  'negative_native_statistics_never_wrap_to_large_unsigned_values',
  'nonfinite_lowering_inputs_and_initial_rates_are_rejected',
  'nonfinite_native_y_is_rejected_before_result_row_commit',
  'nonfinite_native_yp_is_rejected_before_result_row_commit',
  'nonincreasing_output_grid_is_rejected_before_sparse_session_allocation',
  'nonzero_but_unusable_initial_step_is_rejected_before_native_allocation',
  'nonzero_setting_cannot_exceed_backend_ceiling',
  'null_and_wrong_sized_dense_matrices_fail_before_scatter',
  'null_native_handles_preserve_the_exact_construction_stage',
  'null_user_data_fails_unrecoverably_without_dereferencing_it',
  'null_vector_views_map_to_the_exact_residual_callback_input',
  'one_below_exact_global_step_budget_fails_before_an_extra_step',
  'one_thousand_variable_chain_has_exact_sorted_unique_csc_and_known_bytes',
  'one_thousand_variable_sparse_session_initializes_and_drops',
  'outputs_restore_block_order_and_validate_before_writing',
  'overflowing_output_distance_is_rejected_before_native_allocation',
  'pinned_klu_backend_initializes_with_sparse_identity',
  'pinned_user_data_address_survives_moving_the_session_owner',
  'public_last_linear_flag_is_success_without_exposing_klu_structs',
  'registration_order_distinguishes_contract_and_correction_policies',
  'repeated_fresh_sessions_are_bitwise_deterministic_including_stats',
  'repeated_fresh_sparse_sessions_are_bitwise_deterministic',
  'repeated_full_construction_and_drop_stays_balanced',
  'repeated_initialize_drop_cycles_preserve_sparse_lifecycle',
  'repeated_sparse_jacobian_setups_prove_full_csc_restoration',
  'repeated_successful_callbacks_allocate_zero_times',
  'requested_grid_solves_the_analytic_exponential_in_block_order',
  'residual_callback_evaluates_the_analytic_contract',
  'residual_callback_panic_is_contained_and_latched',
  'residual_overflow_is_reported_before_any_destination_write',
  'residual_panic_during_actual_solve_precedes_native_flag',
  'residual_validation_never_partially_overwrites_the_destination',
  'result_binds_backend_result_and_residual_contract_identities',
  'result_binds_sparse_backend_result_and_residual_contracts',
  'result_rows_are_closed_exact_time_major_views',
  'result_rows_are_exact_private_shape_views_with_closed_bounds',
  'result_value_ceiling_is_the_checked_product_of_public_grid_bounds',
  'result_value_setting_cannot_exceed_independent_backend_ceiling',
  'robertson_stiff_index_one_matches_independent_scipy_radau_reference',
  'robertson_stiff_smoke_matches_independent_radau_fixture',
  'scalar_and_uniform_vector_tolerances_are_numerically_identical',
  'scalar_and_uniform_vector_tolerances_have_identical_results_and_work',
  'scalar_tolerance_session_registers_contract_vectors_and_id_vector',
  'scheduled_events_are_rejected_before_session_native_allocation',
  'scheduled_events_are_sorted_and_exactly_deduplicated',
  'scheduled_events_remain_an_explicit_sparse_backend_error',
  'self_coupled_state_rows_accumulate_dy_and_dyp_terms',
  'short_correction_vectors_fail_before_native_allocation',
  'short_vector_tolerance_is_rejected_before_sparse_session_allocation',
  'signed_zero_event_times_share_one_equivalent_restart',
  'signed_zero_initial_time_is_not_rejected_as_native_time_drift',
  'singular_correction_preserves_calc_ic_stage_and_cleans_up',
  'singular_klu_solve_exposes_public_last_linear_flag_evidence',
  'singular_self_loop_is_neutrally_lowered_without_index_one_claim',
  'sparse_callback_rejects_dense_matrix_type_before_any_slice',
  'sparse_callback_rejects_matrix_vector_alias_before_any_slice',
  'sparse_callback_restores_columns_rows_and_values_after_every_zero',
  'sparse_pattern_requires_every_structural_diagonal_before_native_allocation',
  'step_residual_is_right_continuous_at_its_event',
  'ten_thousand_variable_chain_has_exact_linear_csc_pattern',
  'ten_thousand_variable_chain_has_exact_sorted_unique_csc_and_known_bytes',
  'thermal_rate_residual_and_jacobian_preserve_physical_signs',
  'thousand_variable_chain_has_exact_linear_csc_pattern',
  'tighter_sparse_tolerances_reduce_closed_form_error',
  'underflow_scale_output_is_rejected_before_native_allocation',
  'vector_tolerance_session_registers_each_exact_component',
  'wrong_vector_length_is_latched_without_reading_the_native_data',
  'zero_applied_dimension_is_rejected',
  'zero_applied_nonzero_limit_is_rejected',
  'zero_dimension_is_rejected_before_any_native_resource_allocation',
  'zero_jacobian_entry_work_limit_is_rejected',
  'zero_jacobian_evaluation_limit_is_rejected',
  'zero_known_csc_byte_limit_is_rejected',
  'zero_result_value_limit_is_rejected',
]);

const ITERATION_4_PROXY_MATCHES = Object.freeze([
  'contract_grid_allows_near_initial_interpolation_but_correction_rejects_it',
  'corrected_algebraic_and_derivative_initial_conditions_then_solve',
  'corrected_initial_conditions_work_with_sparse_linear_solver',
  'correction_policy_updates_algebraic_y_and_differential_yp',
  'correction_work_is_snapshotted_out_of_published_solve_deltas',
  'event_and_initial_buffers_reject_short_and_long_slices_without_writes',
  'inconsistent_algebraic_loop_fails_during_initialization',
  'integrator_initial_conditions_satisfy_the_residual_contract',
  'registration_order_distinguishes_contract_and_correction_policies',
  'scheduled_events_are_rejected_before_session_native_allocation',
  'scheduled_events_are_sorted_and_exactly_deduplicated',
  'scheduled_events_remain_an_explicit_sparse_backend_error',
  'short_correction_vectors_fail_before_native_allocation',
  'signed_zero_event_times_share_one_equivalent_restart',
  'singular_correction_preserves_calc_ic_stage_and_cleans_up',
  'step_residual_is_right_continuous_at_its_event',
]);

const DENSE_EVENT_RESTART_CAMPAIGN = Object.freeze([
  'dense_default_reject_preserves_fail_closed_scheduled_event_behavior',
  'dense_restart_result_binds_v2_contracts_backend_and_requested_policy',
  'dense_active_distinct_event_count_governs_restart_admission',
  'dense_restart_maximum_above_backend_ceiling_is_rejected',
  'dense_initial_time_mismatch_is_rejected_while_signed_zero_matches',
  'dense_single_event_grid_matches_left_equality_and_right_analytic_values',
  'dense_simultaneous_step_sources_share_one_restart_and_right_correction',
  'dense_two_distinct_events_restart_in_order_and_match_piecewise_integral',
  'dense_event_at_final_horizon_is_inclusive_and_publishes_terminal_equality',
  'dense_event_at_initial_time_is_exclusive_and_needs_no_restart',
  'dense_event_one_ulp_after_final_is_inactive_and_cannot_contaminate_output',
  'dense_nonzero_initial_time_restart_matches_piecewise_integral',
  'dense_signed_zero_event_and_output_share_numeric_equality',
  'dense_corrected_initial_conditions_remain_consistent_across_restart',
  'dense_event_segment_and_correction_targets_fail_preflight_when_unrepresentable',
  'dense_output_row_and_endpoint_custody_counters_close_exactly',
  'dense_global_step_budget_is_cumulative_across_event_segments',
  'dense_repeated_restart_sessions_are_bitwise_deterministic_including_stats',
]);

const KLU_EVENT_RESTART_CAMPAIGN = Object.freeze([
  'klu_default_reject_preserves_fail_closed_scheduled_event_behavior',
  'klu_restart_result_binds_v2_contracts_backend_and_requested_policy',
  'klu_active_distinct_event_count_governs_restart_admission',
  'klu_restart_maximum_above_backend_ceiling_is_rejected',
  'klu_initial_time_mismatch_is_rejected_while_signed_zero_matches',
  'klu_single_event_grid_matches_left_equality_and_right_analytic_values',
  'klu_simultaneous_step_sources_share_one_restart_and_right_correction',
  'klu_two_distinct_events_restart_in_order_and_match_piecewise_integral',
  'klu_event_at_final_horizon_is_inclusive_and_publishes_terminal_equality',
  'klu_event_at_initial_time_is_exclusive_and_needs_no_restart',
  'klu_event_one_ulp_after_final_is_inactive_and_cannot_contaminate_output',
  'klu_nonzero_initial_time_restart_matches_piecewise_integral',
  'klu_signed_zero_event_and_output_share_numeric_equality',
  'klu_corrected_initial_conditions_remain_consistent_across_restart',
  'klu_event_segment_and_correction_targets_fail_preflight_when_unrepresentable',
  'klu_output_row_and_endpoint_custody_counters_close_exactly',
  'klu_global_step_budget_is_cumulative_across_event_segments',
  'klu_repeated_restart_sessions_are_bitwise_deterministic_including_stats',
]);
const KLU_EVENT_RESTART_CAMPAIGN_SHA256 = 'eae4c45f238f748df95e49a0dc19645d588b2ac86c46f6c5eda0dfb08af8b175';

const namesSha256 = (names) => createHash('sha256')
  .update(`${names.join('\n')}\n`, 'utf8')
  .digest('hex');

test('Iteration 4 freezes the full 166-name event-restart proxy at merged Iteration 3', () => {
  assert.equal(ITERATION_4_PROXY_BASELINE_SHA, '032638ba3ee2b7d6cd2ec730b529a63a96ca3ffb');
  assert.deepEqual(ITERATION_4_PROXY_SOURCE_COUNTS, {
    'rust-core/src/dae.rs': 1,
    'rust-core/tests/dae_contract.rs': 29,
    'rust-core/tests/dae_allocation.rs': 1,
    'rust-dae-native/src/native.rs': 73,
    'rust-dae-native/tests/feature_off.rs': 1,
    'rust-dae-native/tests/backend_identity.rs': 2,
    'rust-dae-native/tests/solve_reference.rs': 11,
    'rust-dae-native/tests/klu_feature_off.rs': 4,
    'rust-dae-native/tests/klu_backend_identity.rs': 25,
    'rust-dae-native/tests/klu_solve_reference.rs': 19,
  });
  assert.equal(
    Object.values(ITERATION_4_PROXY_SOURCE_COUNTS).reduce((sum, count) => sum + count, 0),
    166,
  );
  assert.equal(ITERATION_4_PROXY_POPULATION.length, 166);
  assert.equal(new Set(ITERATION_4_PROXY_POPULATION).size, 166);
  assert.deepEqual(ITERATION_4_PROXY_POPULATION, [...ITERATION_4_PROXY_POPULATION].sort());
  assert.equal(namesSha256(ITERATION_4_PROXY_POPULATION), ITERATION_4_PROXY_POPULATION_SHA256);
  assert.equal(
    ITERATION_4_PROXY_NAME_FILTER.source,
    '(event|restart|reinit|stop_time|consistent|initial_condition|right_continu|correction)',
  );
  assert.equal(ITERATION_4_PROXY_NAME_FILTER.flags, 'u', 'the proxy filter is case-sensitive');
  assert.deepEqual(
    ITERATION_4_PROXY_POPULATION.filter((name) => ITERATION_4_PROXY_NAME_FILTER.test(name)),
    ITERATION_4_PROXY_MATCHES,
  );
  assert.equal(ITERATION_4_PROXY_MATCHES.length, 16);
  assert.equal(namesSha256(ITERATION_4_PROXY_MATCHES), ITERATION_4_PROXY_MATCHES_SHA256);

  const currentHistoricalPopulation = new Set(
    Object.keys(ITERATION_4_PROXY_SOURCE_COUNTS)
      .flatMap((path) => rustTestNames(read(path))),
  );
  for (const name of ITERATION_4_PROXY_POPULATION) {
    assert.ok(currentHistoricalPopulation.has(name), `retained Iteration 4 baseline case: ${name}`);
  }
});

test('dense and KLU event-restart campaigns own exactly 18 manifest-listed cases each', () => {
  const manifest = read('rust-dae-native/Cargo.toml');
  const denseCampaignNames = rustTestNames(read('rust-dae-native/tests/dense_event_restart_campaign.rs'));
  const kluCampaignNames = rustTestNames(read('rust-dae-native/tests/klu_event_restart_campaign.rs'));

  assert.match(
    manifest,
    /\[\[test\]\]\s*name = "dense_event_restart_campaign"\s*path = "tests\/dense_event_restart_campaign\.rs"\s*required-features = \["sundials-ida"\]/u,
  );
  assert.match(
    manifest,
    /\[\[test\]\]\s*name = "klu_event_restart_campaign"\s*path = "tests\/klu_event_restart_campaign\.rs"\s*required-features = \["sundials-ida-klu"\]/u,
  );
  assert.equal(denseCampaignNames.length, 18);
  assert.equal(new Set(denseCampaignNames).size, 18);
  assert.deepEqual([...denseCampaignNames].sort(), [...DENSE_EVENT_RESTART_CAMPAIGN].sort());
  assert.equal(kluCampaignNames.length, 18);
  assert.equal(new Set(kluCampaignNames).size, 18);
  assert.deepEqual([...kluCampaignNames].sort(), [...KLU_EVENT_RESTART_CAMPAIGN].sort());
  assert.equal(
    namesSha256([...kluCampaignNames].sort()),
    KLU_EVENT_RESTART_CAMPAIGN_SHA256,
  );

  const frozenEventRestartProxy = ITERATION_4_PROXY_MATCHES.length;
  const combinedCampaignCases = denseCampaignNames.length + kluCampaignNames.length;
  assert.equal(frozenEventRestartProxy, 16);
  assert.equal(DENSE_EVENT_RESTART_CAMPAIGN.length, 18);
  assert.ok(DENSE_EVENT_RESTART_CAMPAIGN.length < 2 * frozenEventRestartProxy);
  assert.equal((DENSE_EVENT_RESTART_CAMPAIGN.length / frozenEventRestartProxy).toFixed(3), '1.125');
  assert.equal(combinedCampaignCases, 36);
  assert.ok(combinedCampaignCases >= 2 * frozenEventRestartProxy);
  assert.equal((combinedCampaignCases / frozenEventRestartProxy).toFixed(2), '2.25');
});

test('current embedded event matrix separates dense and KLU-only seams exactly', () => {
  const native = read('rust-dae-native/src/native.rs');
  const allNames = rustTestNames(native);
  const kluNames = [...native.matchAll(
    /^\s*#\[cfg\(feature = "sundials-ida-klu"\)\]\s*\n\s*#\[test\]\s*\n\s*fn\s+([a-z0-9_]+)\s*\(/gmu,
  )].map((match) => match[1]);

  assert.equal(allNames.length, 97);
  assert.equal(allNames.length - kluNames.length, 85);
  assert.deepEqual(
    [...kluNames].sort(),
    [...ITERATION_3_KLU_INTERNAL_SEAMS, ...ITERATION_4_KLU_INTERNAL_SEAMS].sort(),
  );
});

test('current KLU workflow accounts for both manifests without moving embedded counts', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.equal(
    (workflow.match(/Exercise exactly 190 native dense and KLU cases in (?:debug|release)/gu) ?? []).length,
    2,
  );
  assert.equal((workflow.match(/'97 1'/gu) ?? []).length, 2);
  assert.equal((workflow.match(/'18 2'/gu) ?? []).length, 2);
  assert.equal(
    (workflow.match(/for expectation in '0 3' '2 1' '11 1' '18 2' '19 1' '25 1' '97 1'; do/gu) ?? []).length,
    2,
  );
  assert.equal((workflow.match(/-eq 190/gu) ?? []).length, 2);
  assert.equal((workflow.match(/-eq 10$/gmu) ?? []).length, 2);
  assert.doesNotMatch(workflow, /Exercise exactly (?:130|154|172) native dense and KLU|'73 1'|'18 1'|-eq (?:130|154|172)$/mu);
});

test('current guide reports live event evidence without moving historical campaigns', () => {
  const guide = read('docs/EQUATION_SOLVER.md').replace(/\s+/gu, ' ');
  assert.match(guide, /85 embedded unit cases[\s\S]*KLU matrix contains 97[\s\S]*12-case difference[\s\S]*six historical Iteration 3[\s\S]*six new event\/restart seams/i);
  assert.match(guide, /merged Iteration 3 SHA[\s\S]*032638ba3ee2b7d6cd2ec730b529a63a96ca3ffb[\s\S]*166 unique names[\s\S]*16-name denominator[\s\S]*a9382670c4667d1316f2fd5177c8cf522c697eaf70eab9fb16c7d29e5dddd894[\s\S]*6911df8109acfc06f2a8004d8f52b8468926229fc4f80f2f55bb758ffc501bbc/i);
  assert.match(guide, /18-case dense event\/restart manifest campaign[\s\S]*18-case KLU event\/restart manifest campaign[\s\S]*partial[\s\S]*18 \/ 16 = 1\.125[\s\S]*combined 36-case[\s\S]*36 \/ 16 = 2\.25 times[\s\S]*frozen test-function-count proxy[\s\S]*18 mirrored scenario pairs[\s\S]*not 36 unique behaviors[\s\S]*not evidence that the global test suite doubled/i);
  assert.match(guide, /dense-only checkpoint[\s\S]*172 cases in nine[\s\S]*current 190 cases in ten[\s\S]*historical 154-case, eight-block incident/i);
  assert.match(guide, /historical 48 manifest-listed KLU campaign[\s\S]*frozen 81-name Iteration 3 population[\s\S]*remain unchanged/i);
});
