// helpers.mjs — the one shared assertion vocabulary for every suite.
// Built on node:assert so a failed check THROWS and the node:test runner
// reports it under the name of the test it belongs to. Suites import
// these instead of each redefining its own counter — one place, one style.
import assert from 'node:assert/strict';

// Truthiness with a readable message.
export const ok = (cond, msg) => assert.ok(cond, msg);

// Deep equality (objects, arrays, primitives).
export const eq = (actual, expected, msg) => assert.deepStrictEqual(actual, expected, msg);

// Numeric closeness with the values in the failure message.
export const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);

// The call must throw — for the honest-failure contracts.
export const throws = (fn, msg) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert.ok(threw, `${msg} (no error thrown)`);
};
