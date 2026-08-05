import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { profileStatsKernel } from '../js/profile-kernel.js';
import {
  acceleratedProfileStats,
  initializeWasmCore,
  resetWasmCoreForTest,
  WASM_PROFILE_THRESHOLD,
  wasmCoreReady,
} from '../js/wasm-core.js';

const WASM = new URL('../wasm/battery_design_core.wasm', import.meta.url);
const cases = [
  { profile: { dtS: 10, p: [1, 0, 1, 0] }, scaleW: 100 },
  { profile: { dtS: 0.25, p: [0.8, -0.4, 0.2, -1, 0.6] }, scaleW: 275_000 },
  { profile: { dtS: 60, p: Array.from({ length: 257 }, (_, i) => Math.sin(i / 17)) }, scaleW: 43_210 },
];

test('the Rust boundary has an exact JavaScript fallback', () => {
  resetWasmCoreForTest();
  assert.equal(wasmCoreReady(), false);
  for (const { profile, scaleW } of cases) {
    assert.deepEqual(acceleratedProfileStats(profile, scaleW), profileStatsKernel(profile, scaleW));
  }
});

test('WebAssembly starts only when transfer overhead is repaid', () => {
  assert.equal(WASM_PROFILE_THRESHOLD, 256);
  assert.ok(cases[0].profile.p.length < WASM_PROFILE_THRESHOLD);
  assert.ok(cases[2].profile.p.length >= WASM_PROFILE_THRESHOLD);
});

test('Rust/Wasm profile results match JavaScript', { skip: !existsSync(WASM) }, async () => {
  resetWasmCoreForTest();
  assert.equal(await initializeWasmCore({ bytes: readFileSync(WASM) }), true);
  assert.equal(wasmCoreReady(), true);
  for (const { profile, scaleW } of cases) {
    const expected = profileStatsKernel(profile, scaleW);
    const actual = acceleratedProfileStats(profile, scaleW);
    for (const key of Object.keys(expected)) {
      if (expected[key] == null) assert.equal(actual[key], expected[key], key);
      else assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} != ${expected[key]}`);
    }
  }
});
