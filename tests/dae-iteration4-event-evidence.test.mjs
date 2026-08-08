import test from 'node:test';
import assert from 'node:assert/strict';
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

test('current KLU workflow accounting matches the expanded event unit matrix', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.equal(
    (workflow.match(/Exercise exactly 154 native dense and KLU cases in (?:debug|release)/gu) ?? []).length,
    2,
  );
  assert.equal((workflow.match(/'97 1'/gu) ?? []).length, 2);
  assert.equal((workflow.match(/-eq 154/gu) ?? []).length, 2);
  assert.equal((workflow.match(/-eq 8$/gmu) ?? []).length, 2);
  assert.doesNotMatch(workflow, /Exercise exactly 130 native dense and KLU|'73 1'|-eq 130/u);
});

test('current guide reports live event evidence without moving historical campaigns', () => {
  const guide = read('docs/EQUATION_SOLVER.md').replace(/\s+/gu, ' ');
  assert.match(guide, /85 embedded unit cases[\s\S]*KLU matrix contains 97[\s\S]*12-case difference[\s\S]*six historical Iteration 3[\s\S]*six new event\/restart seams/i);
  assert.match(guide, /reported separately[\s\S]*historical 48 manifest-listed KLU campaign[\s\S]*separately planned Iteration 4 manifest campaigns[\s\S]*do not change either frozen multiplier denominator/i);
});
