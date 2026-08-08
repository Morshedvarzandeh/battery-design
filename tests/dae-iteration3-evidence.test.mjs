import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const rustTestNames = (source) => [...source.matchAll(
  /^\s*#\[test\]\s*\n\s*fn\s+([a-z0-9_]+)\s*\(/gmu,
)].map((match) => match[1]);
const rustTestCount = (source) => rustTestNames(source).length;

const KLU_TEST_FILES = Object.freeze({
  'rust-dae-native/tests/klu_feature_off.rs': 4,
  'rust-dae-native/tests/klu_backend_identity.rs': 25,
  'rust-dae-native/tests/klu_solve_reference.rs': 19,
});

const KLU_INTERNAL_SEAMS = Object.freeze([
  'sparse_pattern_requires_every_structural_diagonal_before_native_allocation',
  'sparse_callback_restores_columns_rows_and_values_after_every_zero',
  'sparse_callback_rejects_dense_matrix_type_before_any_slice',
  'sparse_callback_rejects_matrix_vector_alias_before_any_slice',
  'singular_klu_solve_exposes_public_last_linear_flag_evidence',
  'last_linear_getter_failure_never_masks_original_klu_stage_and_flag',
]);

const ITERATION_3_PROXY_BASELINE_SHA = '9f4a43421de34efd067d38a070a0f2c4b9a859dc';
const ITERATION_3_PROXY_SOURCE_COUNTS = Object.freeze({
  'rust-dae-native/src/native.rs': 67,
  'rust-dae-native/tests/feature_off.rs': 1,
  'rust-dae-native/tests/backend_identity.rs': 2,
  'rust-dae-native/tests/solve_reference.rs': 11,
});
const ITERATION_3_PROXY_NAME_FILTER = /(csc|jacobian|matrix|sparse|linear_solver|resource|construction|drop|backend)/u;

// Frozen from every Cargo test function in the four sources above at the
// pinned merged Iteration 2 SHA. Keeping the population here makes the
// denominator reproducible without requiring Git history at test runtime.
const ITERATION_3_PROXY_POPULATION = Object.freeze([
  'actual_solve_preserves_the_limit_jacobian_error',
  'affine_index_one_reference_preserves_algebraic_relations_at_every_row',
  'aliased_mutable_callback_outputs_are_rejected_before_rust_slices_exist',
  'analytic_dense_jacobian_matches_combined_finite_differences',
  'analytic_exponential_error_converges_across_three_tolerance_levels',
  'analytic_exponential_uses_the_exact_grid_and_stable_block_order',
  'calc_ic_jacobian_panic_is_contained_and_precedes_native_flag',
  'calc_ic_residual_panic_is_contained_and_precedes_native_flag',
  'calc_ic_returns_the_first_exact_jacobian_callback_error',
  'consuming_solve_drops_native_resources_before_returning_owned_result',
  'contract_grid_allows_near_initial_interpolation_but_correction_rejects_it',
  'corrected_algebraic_and_derivative_initial_conditions_then_solve',
  'correction_policy_updates_algebraic_y_and_differential_yp',
  'correction_work_is_snapshotted_out_of_published_solve_deltas',
  'default_build_reports_unavailable_without_falling_back',
  'dense_grid_is_interpolated_after_the_last_allowed_step',
  'dense_jacobian_scatter_is_column_major_for_a_nonsymmetric_system',
  'dimension_above_hard_ceiling_is_rejected_before_native_allocation',
  'dimension_one_constructs_and_releases_every_resource',
  'dimension_two_constructs_and_releases_every_resource',
  'duplicate_csc_dependencies_retain_the_lowered_accumulated_derivative',
  'every_non_success_solve_flag_preserves_exact_stage_and_flag',
  'every_other_settings_category_is_validated_before_native_allocation',
  'every_partial_construction_path_releases_all_prior_resources',
  'exact_global_step_budget_passes_without_an_off_by_one_step',
  'failed_consuming_solve_balances_every_native_resource',
  'feature_on_backend_reports_the_exact_dense_serial_identity',
  'first_callback_error_is_never_replaced_by_a_later_failure',
  'full_drop_order_releases_dependents_before_their_dependencies',
  'hard_ceiling_dimension_constructs_and_releases_every_resource',
  'ida_and_rust_core_dormand_prince_agree_on_the_same_ode_graph',
  'ida_roundoff_last_invalid_and_first_native_valid_distances_are_governed',
  'initial_step_time_advance_rejects_500_ulps_and_accepts_501',
  'initialized_session_drop_releases_ida_before_pinned_callback_state',
  'interpolation_guard_rejects_7_8_extrapolation_before_ffi',
  'interpolation_guard_rejects_replaying_the_previous_step_endpoint',
  'invalid_maximum_steps_are_rejected_before_native_allocation',
  'jacobian_callback_panic_is_contained_and_latched',
  'jacobian_panic_during_actual_solve_precedes_native_flag',
  'limit_kink_preserves_the_exact_underlying_dae_error',
  'many_requested_outputs_cannot_reset_the_global_step_budget',
  'maximum_order_five_uses_higher_order_and_fewer_steps_than_order_one',
  'maximum_order_one_and_five_are_both_registered_successfully',
  'maximum_order_six_is_rejected_before_native_allocation',
  'maximum_order_zero_is_rejected_before_native_allocation',
  'maximum_step_endpoints_are_registered_without_narrowing',
  'native_context_can_be_destroyed_and_recreated_without_shared_state',
  'native_error_flags_are_never_collapsed_or_treated_as_success',
  'negative_native_statistics_never_wrap_to_large_unsigned_values',
  'nonfinite_native_y_is_rejected_before_result_row_commit',
  'nonfinite_native_yp_is_rejected_before_result_row_commit',
  'nonzero_but_unusable_initial_step_is_rejected_before_native_allocation',
  'null_and_wrong_sized_dense_matrices_fail_before_scatter',
  'null_native_handles_preserve_the_exact_construction_stage',
  'null_user_data_fails_unrecoverably_without_dereferencing_it',
  'null_vector_views_map_to_the_exact_residual_callback_input',
  'one_below_exact_global_step_budget_fails_before_an_extra_step',
  'overflowing_output_distance_is_rejected_before_native_allocation',
  'pinned_user_data_address_survives_moving_the_session_owner',
  'registration_order_distinguishes_contract_and_correction_policies',
  'repeated_fresh_sessions_are_bitwise_deterministic_including_stats',
  'repeated_full_construction_and_drop_stays_balanced',
  'repeated_successful_callbacks_allocate_zero_times',
  'requested_grid_solves_the_analytic_exponential_in_block_order',
  'residual_callback_evaluates_the_analytic_contract',
  'residual_callback_panic_is_contained_and_latched',
  'residual_panic_during_actual_solve_precedes_native_flag',
  'result_binds_backend_result_and_residual_contract_identities',
  'result_rows_are_exact_private_shape_views_with_closed_bounds',
  'result_value_ceiling_is_the_checked_product_of_public_grid_bounds',
  'robertson_stiff_index_one_matches_independent_scipy_radau_reference',
  'scalar_and_uniform_vector_tolerances_have_identical_results_and_work',
  'scalar_tolerance_session_registers_contract_vectors_and_id_vector',
  'scheduled_events_are_rejected_before_session_native_allocation',
  'short_correction_vectors_fail_before_native_allocation',
  'signed_zero_initial_time_is_not_rejected_as_native_time_drift',
  'singular_correction_preserves_calc_ic_stage_and_cleans_up',
  'underflow_scale_output_is_rejected_before_native_allocation',
  'vector_tolerance_session_registers_each_exact_component',
  'wrong_vector_length_is_latched_without_reading_the_native_data',
  'zero_dimension_is_rejected_before_any_native_resource_allocation',
]);

const ITERATION_3_PROXY_MATCHES = Object.freeze([
  'actual_solve_preserves_the_limit_jacobian_error',
  'analytic_dense_jacobian_matches_combined_finite_differences',
  'calc_ic_jacobian_panic_is_contained_and_precedes_native_flag',
  'calc_ic_returns_the_first_exact_jacobian_callback_error',
  'consuming_solve_drops_native_resources_before_returning_owned_result',
  'dense_jacobian_scatter_is_column_major_for_a_nonsymmetric_system',
  'dimension_one_constructs_and_releases_every_resource',
  'dimension_two_constructs_and_releases_every_resource',
  'duplicate_csc_dependencies_retain_the_lowered_accumulated_derivative',
  'every_partial_construction_path_releases_all_prior_resources',
  'failed_consuming_solve_balances_every_native_resource',
  'feature_on_backend_reports_the_exact_dense_serial_identity',
  'full_drop_order_releases_dependents_before_their_dependencies',
  'hard_ceiling_dimension_constructs_and_releases_every_resource',
  'initialized_session_drop_releases_ida_before_pinned_callback_state',
  'jacobian_callback_panic_is_contained_and_latched',
  'jacobian_panic_during_actual_solve_precedes_native_flag',
  'null_native_handles_preserve_the_exact_construction_stage',
  'repeated_full_construction_and_drop_stays_balanced',
  'result_binds_backend_result_and_residual_contract_identities',
  'zero_dimension_is_rejected_before_any_native_resource_allocation',
]);

test('Iteration 3 has exactly 48 manifest-listed KLU cases against its frozen 21-case proxy', () => {
  const manifest = read('rust-dae-native/Cargo.toml');
  let actual = 0;
  for (const [path, expected] of Object.entries(KLU_TEST_FILES)) {
    const name = path.match(/\/([^/]+)\.rs$/u)?.[1];
    assert.ok(name);
    assert.match(
      manifest,
      new RegExp(`\\[\\[test\\]\\][\\s\\S]*?name = "${name}"[\\s\\S]*?path = "tests/${name}\\.rs"`, 'u'),
      `${name} must remain an explicit Cargo test target`,
    );
    const count = rustTestCount(read(path));
    assert.equal(count, expected, path);
    actual += count;
  }

  assert.equal(ITERATION_3_PROXY_BASELINE_SHA, '9f4a43421de34efd067d38a070a0f2c4b9a859dc');
  assert.deepEqual(ITERATION_3_PROXY_SOURCE_COUNTS, {
    'rust-dae-native/src/native.rs': 67,
    'rust-dae-native/tests/feature_off.rs': 1,
    'rust-dae-native/tests/backend_identity.rs': 2,
    'rust-dae-native/tests/solve_reference.rs': 11,
  });
  assert.equal(
    Object.values(ITERATION_3_PROXY_SOURCE_COUNTS).reduce((sum, count) => sum + count, 0),
    81,
  );
  assert.equal(ITERATION_3_PROXY_POPULATION.length, 81);
  assert.equal(new Set(ITERATION_3_PROXY_POPULATION).size, 81);
  assert.deepEqual(ITERATION_3_PROXY_POPULATION, [...ITERATION_3_PROXY_POPULATION].sort());
  assert.equal(ITERATION_3_PROXY_NAME_FILTER.source, '(csc|jacobian|matrix|sparse|linear_solver|resource|construction|drop|backend)');
  assert.equal(ITERATION_3_PROXY_NAME_FILTER.flags, 'u', 'the proxy filter is case-sensitive');
  assert.deepEqual(
    ITERATION_3_PROXY_POPULATION.filter((name) => ITERATION_3_PROXY_NAME_FILTER.test(name)),
    ITERATION_3_PROXY_MATCHES,
  );
  assert.equal(ITERATION_3_PROXY_MATCHES.length, 21);

  const frozenSparseReadinessProxy = ITERATION_3_PROXY_MATCHES.length;
  const acceptanceFloor = 2 * frozenSparseReadinessProxy;
  assert.equal(actual, 48);
  assert.equal(acceptanceFloor, 42);
  assert.ok(actual >= acceptanceFloor);
  assert.equal((actual / frozenSparseReadinessProxy).toFixed(2), '2.29');
});

test('six historical Iteration 3 seams and the frozen 81 names remain present', () => {
  const native = read('rust-dae-native/src/native.rs');
  const featureGatedNames = [...native.matchAll(
    /^\s*#\[cfg\(feature = "sundials-ida-klu"\)\]\s*\n\s*#\[test\]\s*\n\s*fn\s+([a-z0-9_]+)\s*\(/gmu,
  )].map((match) => match[1]);
  for (const name of KLU_INTERNAL_SEAMS) {
    assert.ok(featureGatedNames.includes(name), name);
    assert.match(
      native,
      new RegExp(`#\\[cfg\\(feature = "sundials-ida-klu"\\)\\]\\s*#\\[test\\]\\s*fn ${name}\\(`, 'u'),
      name,
    );
  }

  const currentHistoricalPopulation = new Set([
    ...rustTestNames(native),
    ...rustTestNames(read('rust-dae-native/tests/feature_off.rs')),
    ...rustTestNames(read('rust-dae-native/tests/backend_identity.rs')),
    ...rustTestNames(read('rust-dae-native/tests/solve_reference.rs')),
  ]);
  for (const name of ITERATION_3_PROXY_POPULATION) {
    assert.ok(currentHistoricalPopulation.has(name), `retained Iteration 2/3 case: ${name}`);
  }
});

test('the governed sparse source/build truth suite executes exactly 80/80 cases', () => {
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test',
    'tests/suitesparse-source-lock.test.mjs',
    'tests/sundials-klu-native-build.test.mjs',
  ], {
    cwd: ROOT,
    env: childEnvironment,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /(?:#|ℹ) tests 80/u);
  assert.match(result.stdout, /(?:#|ℹ) pass 80/u);
  assert.match(result.stdout, /(?:#|ℹ) fail 0/u);
});

test('the 28-case tamper inventory and the qualified scale boundary remain exact', () => {
  const attacks = read('tools/test-native-dae-klu-build.mjs');
  const inventory = attacks.match(/const attacks = \[([\s\S]*?)\n\];/u)?.[1];
  assert.ok(inventory, 'closed attack inventory');
  assert.equal((inventory.match(/\bslug:/gu) ?? []).length, 28);

  const identity = read('rust-dae-native/tests/klu_backend_identity.rs');
  const solve = read('rust-dae-native/tests/klu_solve_reference.rs');
  assert.match(identity, /fn ten_thousand_variable_chain_has_exact_sorted_unique_csc_and_known_bytes\(\)/u);
  assert.match(solve, /fn one_thousand_variable_sparse_session_initializes_and_drops\(\)/u);
  assert.doesNotMatch(solve, /fn ten_thousand_variable_[^(]*(?:solve|session|factor)/u);
});

test('Iteration 3 documentation preserves evidence accounting and the non-product boundary', () => {
  const guide = read('docs/EQUATION_SOLVER.md').replace(/\s+/gu, ' ');
  assert.match(guide, /Iteration 3 native sparse reference boundary/u);
  assert.match(guide, /battery-design\/native-ida-klu@1[\s\S]*SUNDIALS\/IDA 7\.8\.0[\s\S]*SuiteSparse 7\.7\.0[\s\S]*KLU 2\.3\.3/u);
  assert.match(guide, /21-name denominator[\s\S]*acceptance floor is 42[\s\S]*exactly 48 manifest-listed KLU cases[\s\S]*four feature-off[\s\S]*25 identity\/admission\/scaling[\s\S]*19 solve\/failure\/lifecycle[\s\S]*2\.29 times/u);
  assert.match(guide, /9f4a43421de34efd067d38a070a0f2c4b9a859dc[\s\S]*rust-dae-native\/src\/native\.rs` \(67\)[\s\S]*rust-dae-native\/tests\/feature_off\.rs` \(1\)[\s\S]*rust-dae-native\/tests\/backend_identity\.rs` \(2\)[\s\S]*rust-dae-native\/tests\/solve_reference\.rs` \(11\)[\s\S]*81 unique names[\s\S]*case-sensitive regular expression[\s\S]*\(csc\|jacobian\|matrix\|sparse\|linear_solver\|resource\|construction\|drop\|backend\)[\s\S]*21-name denominator frozen verbatim/u);
  assert.match(guide, /Six additional KLU-only internal[\s\S]*reported separately[\s\S]*not[\s\S]*global test suite doubled/u);
  assert.match(guide, /80\/80[\s\S]*28\/28[\s\S]*81-case dense native campaign[\s\S]*retained unchanged/u);
  assert.match(guide, /10,000-variable chain is lowered and admitted[\s\S]*largest real native session[\s\S]*1,000-variable chain/u);
  assert.match(guide, /known-storage figure[\s\S]*excludes input-dependent KLU symbolic and numeric factor fill[\s\S]*not a bound on total process memory/u);
  assert.match(guide, /Rust 1\.77\.2[\s\S]*warnings denied[\s\S]*debug and release/u);
  assert.match(guide, /LGPL-2\.1-or-later[\s\S]*not legal approval[\s\S]*product distribution plan remain unresolved/u);
  assert.doesNotMatch(guide, /Iterations 3[–-]5 remain unimplemented/u);
});
