// loop-testing.js — calculation-focused Software-in-the-Loop execution and
// Hardware-in-the-Loop test contracts.
//
// SIL executes a supplied software adapter against versioned test vectors and
// independent numeric limits. HIL here is deliberately a contract and
// evidence evaluator: without target hardware, measured cycle times and I/O
// observations it can never claim that a hardware test passed.
//
// Pure data and math; no DOM and no hardware access.

import { semanticDigest } from './ontology.js';

export const LEGACY_SIL_SCHEMA = 'battery-design/sil-test-plan@1';
export const LEGACY_HIL_SCHEMA = 'battery-design/hil-test-contract@1';
export const SIL_SCHEMA = 'battery-design/sil-test-plan@2';
export const HIL_SCHEMA = 'battery-design/hil-test-contract@2';
export const SIL_RESULT_SCHEMA = 'battery-design/sil-test-result@1';
export const MAX_HIL_TIMING_SAMPLES = 1_000_000;

const REQUIRED_CALCULATION_TESTS = Object.freeze([
  'independent expected-value or accepted-range oracle',
  'repeatability on the identical model, inputs, solver and seed',
  'lower and upper operating boundaries',
  'invalid-input and fault response',
  'step-size/tolerance convergence for continuous models',
  'unit, energy/charge conservation and event-timing checks where applicable',
]);

const finite = (value) => Number.isFinite(value);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function plainObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function exactKeys(name, value, allowed, required = allowed) {
  plainObject(name, value);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new TypeError(`${name} does not accept: ${unknown.sort().join(', ')}.`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`${name} requires: ${missing.join(', ')}.`);
}

function denseArray(name, value, minimumLength = 0) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  if (value.length < minimumLength) {
    const count = minimumLength === 1 ? 'one' : String(minimumLength);
    throw new RangeError(`${name} requires at least ${count} item${minimumLength === 1 ? '' : 's'}.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${name} must not contain sparse array slots.`);
  }
  return value;
}

function cloneJson(value, path = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!finite(value)) throw new TypeError(`${path} must contain only finite JSON numbers.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== 'object') throw new TypeError(`${path} must contain only JSON values.`);
  if (seen.has(value)) throw new TypeError(`${path} must not contain a cycle.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      denseArray(path, value);
      return value.map((item, index) => cloneJson(item, `${path}/${index}`, seen));
    }
    plainObject(path, value);
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, cloneJson(value[key], `${path}/${key}`, seen)]));
  } finally {
    seen.delete(value);
  }
}

const clone = (value) => cloneJson(value);

function expectedChecksum(options, name) {
  exactKeys(name, options, ['expectedChecksum'], []);
  if (options.expectedChecksum == null) return null;
  return assertText('Expected checksum', options.expectedChecksum);
}

function checkedSnapshot(body) {
  return deepFreeze({ ...body, checksum: semanticDigest(body) });
}

function requiredHilCycleCount(samplePeriodUs, durationS) {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(durationS));
  if (!match) throw new RangeError('HIL duration cannot be represented as a decimal timing contract.');
  const [, whole, fraction = '', exponentText = '0'] = match;
  const significant = BigInt(`${whole}${fraction}`);
  const microsecondExponent = Number(exponentText) - fraction.length + 6;
  let numerator = significant;
  let denominator = BigInt(samplePeriodUs);
  if (microsecondExponent >= 0) numerator *= 10n ** BigInt(microsecondExponent);
  else denominator *= 10n ** BigInt(-microsecondExponent);
  const count = (numerator + denominator - 1n) / denominator;
  if (count < 1n || count > BigInt(MAX_HIL_TIMING_SAMPLES)) {
    throw new RangeError(`HIL timing evidence requires between 1 and ${MAX_HIL_TIMING_SAMPLES} cycles.`);
  }
  return Number(count);
}

function assertText(name, value) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  if (!value.trim()) throw new RangeError(`${name} is required.`);
  return value.trim();
}

function outputAtPath(output, path) {
  return path.split('.').reduce((value, key) => (
    value != null && (typeof value === 'object' || typeof value === 'function')
      && Object.hasOwn(value, key) ? value[key] : undefined
  ), output);
}

function ownValue(value, key) {
  return value != null && (typeof value === 'object' || typeof value === 'function')
    && Object.hasOwn(value, key) ? value[key] : undefined;
}

function assertOutputPath(value) {
  const path = assertText('Expected output path', value);
  const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
  const segments = path.split('.');
  if (segments.some((segment) => !segment || unsafe.has(segment))) {
    throw new RangeError('Expected output path must contain only non-empty own-property segments.');
  }
  return path;
}

function normalizeSilAdapterResult(value) {
  exactKeys('SIL adapter result', value, [
    'modelId', 'modelVersion', 'graphChecksum', 'solver', 'outputs', 'units',
  ]);
  return deepFreeze({
    modelId: assertText('Adapter model id', value.modelId),
    modelVersion: assertText('Adapter model version', value.modelVersion),
    graphChecksum: assertText('Adapter graph checksum', value.graphChecksum),
    solver: assertText('Adapter solver', value.solver),
    outputs: clone(plainObject('Adapter outputs', value.outputs)),
    units: clone(plainObject('Adapter units', value.units)),
  });
}

function silAdapterErrorMessage(error) {
  try {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
      return error.message;
    }
  } catch {
    // Continue to the guarded generic conversion.
  }
  try {
    const message = String(error);
    if (message) return message;
  } catch {
    // A thrown value is allowed to have no usable primitive representation.
  }
  return 'SIL adapter failed with an unrepresentable thrown value.';
}

export function createSilTestPlan(options = {}) {
  exactKeys('SIL plan options', options,
    ['modelId', 'modelVersion', 'graphChecksum', 'solver', 'deterministicSeed', 'cases'],
    ['modelId', 'modelVersion', 'graphChecksum', 'solver', 'cases']);
  const modelId = assertText('Model id', options.modelId);
  const modelVersion = assertText('Model version', options.modelVersion);
  const graphChecksum = assertText('Graph checksum', options.graphChecksum);
  const solver = assertText('Solver', options.solver);
  const deterministicSeed = Object.hasOwn(options, 'deterministicSeed') ? options.deterministicSeed : 1;
  if (!Number.isSafeInteger(deterministicSeed)) {
    throw new RangeError('Deterministic seed must be a safe integer.');
  }
  denseArray('SIL test cases', options.cases, 1);
  const ids = new Set();
  const cases = options.cases.map((item, index) => {
    exactKeys(`SIL case ${index}`, item,
      ['id', 'purpose', 'inputs', 'runOptions', 'expected', 'repeat'],
      ['id', 'purpose', 'expected']);
    const id = assertText('Test id', item.id);
    if (ids.has(id)) throw new RangeError(`Duplicate SIL test id: ${id}`);
    ids.add(id);
    exactKeys(`${id} expected output`, item.expected, ['outputPath', 'unit', 'min', 'max']);
    const outputPath = assertOutputPath(item.expected?.outputPath);
    const unit = assertText('Expected output unit', item.expected?.unit);
    const min = item.expected?.min;
    const max = item.expected?.max;
    if (!finite(min) || !finite(max) || min > max) throw new RangeError(`${id} needs finite ordered output limits.`);
    const inputs = Object.hasOwn(item, 'inputs') ? plainObject(`${id} inputs`, item.inputs) : {};
    const runOptions = Object.hasOwn(item, 'runOptions') ? plainObject(`${id} run options`, item.runOptions) : {};
    if (Object.hasOwn(item, 'repeat') && typeof item.repeat !== 'boolean') {
      throw new TypeError(`${id} repeat must be boolean.`);
    }
    return {
      id, purpose: assertText('Test purpose', item.purpose),
      inputs: clone(inputs),
      runOptions: clone(runOptions),
      expected: { outputPath, unit, min, max },
      repeat: item.repeat !== false,
    };
  });
  return checkedSnapshot({
    schema: SIL_SCHEMA, modelId, modelVersion, graphChecksum, solver,
    deterministicSeed, cases,
    requiredCalculationTests: REQUIRED_CALCULATION_TESTS,
  });
}

/** Rematerialize the original shallow @1 document as a governed @2 snapshot. */
export function migrateLegacySilTestPlan(value) {
  exactKeys('Legacy SIL test plan', value, [
    'schema', 'modelId', 'modelVersion', 'graphChecksum', 'solver', 'deterministicSeed',
    'cases', 'requiredCalculationTests',
  ]);
  if (value.schema !== LEGACY_SIL_SCHEMA) throw new TypeError(`Expected ${LEGACY_SIL_SCHEMA}.`);
  denseArray('Legacy SIL required calculation tests', value.requiredCalculationTests);
  if (value.requiredCalculationTests.length !== REQUIRED_CALCULATION_TESTS.length
    || value.requiredCalculationTests.some((item, index) => item !== REQUIRED_CALCULATION_TESTS[index])) {
    throw new TypeError('Legacy SIL required calculation tests do not match the canonical contract.');
  }
  return createSilTestPlan({
    modelId: value.modelId,
    modelVersion: value.modelVersion,
    graphChecksum: value.graphChecksum,
    solver: value.solver,
    deterministicSeed: value.deterministicSeed,
    cases: value.cases,
  });
}

/** Validate an untrusted serialized plan and optionally bind it to a trusted digest. */
export function verifySilTestPlan(value, options = {}) {
  const trustedChecksum = expectedChecksum(options, 'SIL verification options');
  plainObject('SIL test plan', value);
  if (value.schema === LEGACY_SIL_SCHEMA) {
    throw new TypeError(`Legacy ${LEGACY_SIL_SCHEMA} must be rematerialized with migrateLegacySilTestPlan().`);
  }
  exactKeys('SIL test plan', value, [
    'schema', 'modelId', 'modelVersion', 'graphChecksum', 'solver', 'deterministicSeed',
    'cases', 'requiredCalculationTests', 'checksum',
  ]);
  if (value.schema !== SIL_SCHEMA) throw new TypeError(`Expected ${SIL_SCHEMA}.`);
  denseArray('SIL required calculation tests', value.requiredCalculationTests);
  if (value.requiredCalculationTests.length !== REQUIRED_CALCULATION_TESTS.length
    || value.requiredCalculationTests.some((item, index) => item !== REQUIRED_CALCULATION_TESTS[index])) {
    throw new TypeError('SIL required calculation tests do not match the canonical contract.');
  }
  const verified = createSilTestPlan({
    modelId: value.modelId,
    modelVersion: value.modelVersion,
    graphChecksum: value.graphChecksum,
    solver: value.solver,
    deterministicSeed: value.deterministicSeed,
    cases: value.cases,
  });
  if (value.checksum !== verified.checksum) throw new TypeError('SIL plan checksum mismatch.');
  if (trustedChecksum && trustedChecksum !== verified.checksum) {
    throw new TypeError('SIL plan does not match the trusted expected checksum.');
  }
  return verified;
}

/** Execute the versioned software model adapter and evaluate every oracle. */
export function runSoftwareInLoop(plan, adapter) {
  const verifiedPlan = verifySilTestPlan(plan);
  if (typeof adapter !== 'function') throw new TypeError('SIL requires a callable software-model adapter.');
  const cases = verifiedPlan.cases.map((testCase) => {
    const request = {
      modelId: verifiedPlan.modelId, modelVersion: verifiedPlan.modelVersion,
      graphChecksum: verifiedPlan.graphChecksum, solver: verifiedPlan.solver,
      deterministicSeed: verifiedPlan.deterministicSeed,
      inputs: clone(testCase.inputs), runOptions: clone(testCase.runOptions),
    };
    try {
      const first = normalizeSilAdapterResult(adapter(clone(request)));
      const value = outputAtPath(first.outputs, testCase.expected.outputPath);
      const unit = ownValue(first.units, testCase.expected.outputPath);
      const identityOk = first.modelId === verifiedPlan.modelId
        && first.graphChecksum === verifiedPlan.graphChecksum
        && first.modelVersion === verifiedPlan.modelVersion && first.solver === verifiedPlan.solver;
      const rangeOk = finite(value) && value >= testCase.expected.min && value <= testCase.expected.max;
      const unitOk = unit === testCase.expected.unit;
      let repeatOk = true;
      if (testCase.repeat) {
        const second = normalizeSilAdapterResult(adapter(clone(request)));
        repeatOk = semanticDigest(first) === semanticDigest(second);
      }
      const pass = identityOk && rangeOk && unitOk && repeatOk;
      return {
        id: testCase.id, purpose: testCase.purpose, status: pass ? 'pass' : 'fail',
        actual: value === undefined ? null : value,
        actualUnit: unit ?? null, expected: testCase.expected,
        checks: { identity: identityOk, range: rangeOk, unit: unitOk, repeatability: repeatOk },
      };
    } catch (error) {
      return {
        id: testCase.id, purpose: testCase.purpose, status: 'fail',
        error: silAdapterErrorMessage(error),
      };
    }
  });
  return checkedSnapshot({
    schema: SIL_RESULT_SCHEMA, kind: 'software-in-the-loop',
    status: cases.every((item) => item.status === 'pass') ? 'pass' : 'fail',
    planSchema: SIL_SCHEMA,
    planChecksum: verifiedPlan.checksum,
    modelId: verifiedPlan.modelId, modelVersion: verifiedPlan.modelVersion,
    graphChecksum: verifiedPlan.graphChecksum, solver: verifiedPlan.solver, cases,
  });
}

function normalizedChannels(channels, direction) {
  denseArray(`HIL ${direction} channels`, channels, 1);
  const ids = new Set();
  return channels.map((item, index) => {
    const keys = direction === 'output'
      ? ['id', 'quantity', 'unit', 'min', 'max', 'safeValue']
      : ['id', 'quantity', 'unit', 'min', 'max'];
    exactKeys(`HIL ${direction} channel ${index}`, item, keys);
    const id = assertText(`${direction} channel id`, item.id);
    if (ids.has(id)) throw new RangeError(`Duplicate HIL channel id: ${id}`);
    ids.add(id);
    return {
      id, quantity: assertText(`${id} quantity`, item.quantity),
      unit: assertText(`${id} unit`, item.unit),
      min: item.min, max: item.max,
      ...(direction === 'output' ? { safeValue: item.safeValue } : {}),
    };
  });
}

export function createHilTestContract(options = {}) {
  exactKeys('HIL contract options', options, [
    'targetId', 'modelId', 'modelVersion', 'graphChecksum', 'samplePeriodUs',
    'durationS', 'inputs', 'outputs', 'overrun', 'requiredFaults',
  ], [
    'targetId', 'modelId', 'modelVersion', 'graphChecksum', 'samplePeriodUs',
    'durationS', 'inputs', 'outputs', 'overrun',
  ]);
  const targetId = assertText('HIL target id', options.targetId);
  const modelId = assertText('Model id', options.modelId);
  const modelVersion = assertText('Model version', options.modelVersion);
  const graphChecksum = assertText('Graph checksum', options.graphChecksum);
  if (!Number.isSafeInteger(options.samplePeriodUs) || options.samplePeriodUs <= 0) throw new RangeError('HIL sample period must be a positive safe integer in microseconds.');
  if (!finite(options.durationS) || options.durationS <= 0) throw new RangeError('HIL duration must be greater than zero.');
  requiredHilCycleCount(options.samplePeriodUs, options.durationS);
  const inputs = normalizedChannels(options.inputs, 'input');
  const outputs = normalizedChannels(options.outputs, 'output');
  const allIds = [...inputs, ...outputs].map((channel) => channel.id);
  if (new Set(allIds).size !== allIds.length) throw new RangeError('HIL channel ids must be unique across inputs and outputs.');
  for (const channel of [...inputs, ...outputs]) {
    if (!finite(channel.min) || !finite(channel.max) || channel.min > channel.max) throw new RangeError(`${channel.id} needs finite ordered channel limits.`);
  }
  for (const output of outputs) {
    if (!finite(output.safeValue) || output.safeValue < output.min || output.safeValue > output.max) {
      throw new RangeError(`${output.id} safe value must be inside its declared limits.`);
    }
  }
  exactKeys('HIL overrun contract', options.overrun, ['maxConsecutive', 'action'], ['action']);
  const overrun = {
    maxConsecutive: options.overrun?.maxConsecutive ?? 0,
    action: assertText('Overrun action', options.overrun?.action),
  };
  if (!Number.isSafeInteger(overrun.maxConsecutive) || overrun.maxConsecutive < 0) throw new RangeError('Maximum consecutive overruns must be a non-negative safe integer.');
  const faultSource = Object.hasOwn(options, 'requiredFaults') ? options.requiredFaults : [
    'sensor-open', 'sensor-short', 'sensor-stuck', 'out-of-range',
    'communication-timeout', 'target-overrun', 'power-cycle', 'emergency-safe-state',
  ];
  denseArray('Required HIL faults', faultSource, 1);
  const requiredFaults = faultSource.map((fault) => assertText('Required HIL fault', fault));
  if (new Set(requiredFaults).size !== requiredFaults.length) {
    throw new RangeError('Required HIL faults must be unique.');
  }
  return checkedSnapshot({
    schema: HIL_SCHEMA, targetId, modelId, modelVersion, graphChecksum,
    samplePeriodUs: options.samplePeriodUs, durationS: options.durationS,
    inputs, outputs, overrun, requiredFaults,
    status: 'contract-ready-hardware-run-required',
  });
}

/** Rematerialize the original shallow @1 document as a governed @2 snapshot. */
export function migrateLegacyHilTestContract(value) {
  exactKeys('Legacy HIL test contract', value, [
    'schema', 'targetId', 'modelId', 'modelVersion', 'graphChecksum', 'samplePeriodUs',
    'durationS', 'inputs', 'outputs', 'overrun', 'requiredFaults', 'status',
  ]);
  if (value.schema !== LEGACY_HIL_SCHEMA) throw new TypeError(`Expected ${LEGACY_HIL_SCHEMA}.`);
  if (value.status !== 'contract-ready-hardware-run-required') {
    throw new TypeError('Legacy HIL contract status must remain contract-ready-hardware-run-required.');
  }
  return createHilTestContract({
    targetId: value.targetId,
    modelId: value.modelId,
    modelVersion: value.modelVersion,
    graphChecksum: value.graphChecksum,
    samplePeriodUs: value.samplePeriodUs,
    durationS: value.durationS,
    inputs: value.inputs,
    outputs: value.outputs,
    overrun: value.overrun,
    requiredFaults: value.requiredFaults,
  });
}

/** Validate an untrusted serialized contract and optionally bind a trusted digest. */
export function verifyHilTestContract(value, options = {}) {
  const trustedChecksum = expectedChecksum(options, 'HIL verification options');
  plainObject('HIL test contract', value);
  if (value.schema === LEGACY_HIL_SCHEMA) {
    throw new TypeError(`Legacy ${LEGACY_HIL_SCHEMA} must be rematerialized with migrateLegacyHilTestContract().`);
  }
  exactKeys('HIL test contract', value, [
    'schema', 'targetId', 'modelId', 'modelVersion', 'graphChecksum', 'samplePeriodUs',
    'durationS', 'inputs', 'outputs', 'overrun', 'requiredFaults', 'status', 'checksum',
  ]);
  if (value.schema !== HIL_SCHEMA) throw new TypeError(`Expected ${HIL_SCHEMA}.`);
  if (value.status !== 'contract-ready-hardware-run-required') {
    throw new TypeError('HIL contract status must remain contract-ready-hardware-run-required.');
  }
  const verified = createHilTestContract({
    targetId: value.targetId,
    modelId: value.modelId,
    modelVersion: value.modelVersion,
    graphChecksum: value.graphChecksum,
    samplePeriodUs: value.samplePeriodUs,
    durationS: value.durationS,
    inputs: value.inputs,
    outputs: value.outputs,
    overrun: value.overrun,
    requiredFaults: value.requiredFaults,
  });
  if (value.checksum !== verified.checksum) throw new TypeError('HIL contract checksum mismatch.');
  if (trustedChecksum && trustedChecksum !== verified.checksum) {
    throw new TypeError('HIL contract does not match the trusted expected checksum.');
  }
  return verified;
}

/** Evaluate evidence measured by a real HIL target; absence stays Unproven. */
export function evaluateHilEvidence(contract, evidence = null) {
  const verifiedContract = verifyHilTestContract(contract);
  const requiredCycleCount = requiredHilCycleCount(
    verifiedContract.samplePeriodUs,
    verifiedContract.durationS,
  );
  if (!evidence) return {
    schema: HIL_SCHEMA, kind: 'hardware-in-the-loop', status: 'unproven',
    contractChecksum: verifiedContract.checksum,
    requiredCycleCount, observedCycleCount: 0,
    headline: 'HIL contract is ready; no target-hardware evidence has been supplied.',
  };
  const identity = ownValue(evidence, 'targetId') === verifiedContract.targetId
    && ownValue(evidence, 'modelVersion') === verifiedContract.modelVersion
    && ownValue(evidence, 'graphChecksum') === verifiedContract.graphChecksum;
  const suppliedCycleTimes = ownValue(evidence, 'cycleTimesUs');
  const cycleTimesUs = Array.isArray(suppliedCycleTimes) ? suppliedCycleTimes : [];
  const withinTimingLimit = cycleTimesUs.length <= MAX_HIL_TIMING_SAMPLES;
  const coverageOk = cycleTimesUs.length >= requiredCycleCount && withinTimingLimit;
  let valuesOk = cycleTimesUs.length > 0 && withinTimingLimit;
  let deadlineOk = true;
  let maxCycleTimeUs = null;
  for (let index = 0; index < cycleTimesUs.length && withinTimingLimit; index += 1) {
    if (!Object.hasOwn(cycleTimesUs, index)) {
      valuesOk = false;
      continue;
    }
    const value = cycleTimesUs[index];
    if (!finite(value) || value <= 0) {
      valuesOk = false;
      continue;
    }
    maxCycleTimeUs = maxCycleTimeUs === null ? value : Math.max(maxCycleTimeUs, value);
    if (value > verifiedContract.samplePeriodUs) deadlineOk = false;
  }
  const timing = coverageOk && valuesOk && deadlineOk;
  const io = [...verifiedContract.inputs, ...verifiedContract.outputs]
    .every((channel) => ownValue(ownValue(evidence, 'io'), channel.id) === 'pass');
  const faults = verifiedContract.requiredFaults
    .every((fault) => ownValue(ownValue(evidence, 'faults'), fault) === 'pass');
  const safeState = verifiedContract.outputs
    .every((channel) => ownValue(ownValue(evidence, 'safeState'), channel.id) === channel.safeValue);
  const suppliedOverruns = ownValue(evidence, 'maxConsecutiveOverruns');
  const recordedOverruns = Number.isSafeInteger(suppliedOverruns) && suppliedOverruns >= 0
    ? suppliedOverruns : Infinity;
  const overrun = recordedOverruns <= verifiedContract.overrun.maxConsecutive;
  const checks = { identity, timing, io, faults, safeState, overrun };
  return {
    schema: HIL_SCHEMA, kind: 'hardware-in-the-loop',
    status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
    contractChecksum: verifiedContract.checksum,
    checks, maxCycleTimeUs,
    requiredCycleCount,
    observedCycleCount: cycleTimesUs.length,
    samplePeriodUs: verifiedContract.samplePeriodUs,
    headline: Object.values(checks).every(Boolean)
      ? 'Measured HIL evidence satisfies the declared contract.'
      : 'Measured HIL evidence does not satisfy the declared contract.',
  };
}
