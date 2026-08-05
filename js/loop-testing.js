// loop-testing.js — calculation-focused Software-in-the-Loop execution and
// Hardware-in-the-Loop test contracts.
//
// SIL executes a supplied software adapter against versioned test vectors and
// independent numeric limits. HIL here is deliberately a contract and
// evidence evaluator: without target hardware, measured cycle times and I/O
// observations it can never claim that a hardware test passed.
//
// Pure data and math; no DOM and no hardware access.

export const SIL_SCHEMA = 'battery-design/sil-test-plan@1';
export const HIL_SCHEMA = 'battery-design/hil-test-contract@1';

const finite = (value) => Number.isFinite(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function assertText(name, value) {
  if (!String(value || '').trim()) throw new RangeError(`${name} is required.`);
  return String(value).trim();
}

function outputAtPath(output, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], output);
}

export function createSilTestPlan(options = {}) {
  const modelId = assertText('Model id', options.modelId);
  const modelVersion = assertText('Model version', options.modelVersion);
  const graphChecksum = assertText('Graph checksum', options.graphChecksum);
  const solver = assertText('Solver', options.solver);
  if (!Array.isArray(options.cases) || !options.cases.length) throw new RangeError('At least one SIL test case is required.');
  const ids = new Set();
  const cases = options.cases.map((item) => {
    const id = assertText('Test id', item.id);
    if (ids.has(id)) throw new RangeError(`Duplicate SIL test id: ${id}`);
    ids.add(id);
    const outputPath = assertText('Expected output path', item.expected?.outputPath);
    const unit = assertText('Expected output unit', item.expected?.unit);
    const min = item.expected?.min;
    const max = item.expected?.max;
    if (!finite(min) || !finite(max) || min > max) throw new RangeError(`${id} needs finite ordered output limits.`);
    return {
      id, purpose: assertText('Test purpose', item.purpose),
      inputs: clone(item.inputs || {}),
      runOptions: clone(item.runOptions || {}),
      expected: { outputPath, unit, min, max },
      repeat: item.repeat !== false,
    };
  });
  return Object.freeze({
    schema: SIL_SCHEMA, modelId, modelVersion, graphChecksum, solver,
    deterministicSeed: Number.isInteger(options.deterministicSeed) ? options.deterministicSeed : 1,
    cases: Object.freeze(cases),
    requiredCalculationTests: Object.freeze([
      'independent expected-value or accepted-range oracle',
      'repeatability on the identical model, inputs, solver and seed',
      'lower and upper operating boundaries',
      'invalid-input and fault response',
      'step-size/tolerance convergence for continuous models',
      'unit, energy/charge conservation and event-timing checks where applicable',
    ]),
  });
}

/** Execute the versioned software model adapter and evaluate every oracle. */
export function runSoftwareInLoop(plan, adapter) {
  if (plan?.schema !== SIL_SCHEMA) throw new TypeError(`Expected ${SIL_SCHEMA}.`);
  if (typeof adapter !== 'function') throw new TypeError('SIL requires a callable software-model adapter.');
  const cases = plan.cases.map((testCase) => {
    const request = {
      modelId: plan.modelId, modelVersion: plan.modelVersion,
      graphChecksum: plan.graphChecksum, solver: plan.solver,
      deterministicSeed: plan.deterministicSeed,
      inputs: clone(testCase.inputs), runOptions: clone(testCase.runOptions),
    };
    try {
      const first = adapter(clone(request));
      const value = outputAtPath(first?.outputs, testCase.expected.outputPath);
      const unit = first?.units?.[testCase.expected.outputPath];
      const identityOk = first?.graphChecksum === plan.graphChecksum
        && first?.modelVersion === plan.modelVersion && first?.solver === plan.solver;
      const rangeOk = finite(value) && value >= testCase.expected.min && value <= testCase.expected.max;
      const unitOk = unit === testCase.expected.unit;
      let repeatOk = true;
      if (testCase.repeat) {
        const second = adapter(clone(request));
        repeatOk = JSON.stringify(first) === JSON.stringify(second);
      }
      const pass = identityOk && rangeOk && unitOk && repeatOk;
      return {
        id: testCase.id, purpose: testCase.purpose, status: pass ? 'pass' : 'fail',
        actual: value, actualUnit: unit ?? null, expected: testCase.expected,
        checks: { identity: identityOk, range: rangeOk, unit: unitOk, repeatability: repeatOk },
      };
    } catch (error) {
      return { id: testCase.id, purpose: testCase.purpose, status: 'fail', error: error.message };
    }
  });
  return {
    schema: SIL_SCHEMA, kind: 'software-in-the-loop',
    status: cases.every((item) => item.status === 'pass') ? 'pass' : 'fail',
    modelId: plan.modelId, modelVersion: plan.modelVersion,
    graphChecksum: plan.graphChecksum, solver: plan.solver, cases,
  };
}

function normalizedChannels(channels, direction) {
  if (!Array.isArray(channels) || !channels.length) throw new RangeError(`At least one HIL ${direction} channel is required.`);
  const ids = new Set();
  return channels.map((item) => {
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
  const targetId = assertText('HIL target id', options.targetId);
  const modelId = assertText('Model id', options.modelId);
  const modelVersion = assertText('Model version', options.modelVersion);
  const graphChecksum = assertText('Graph checksum', options.graphChecksum);
  if (!Number.isInteger(options.samplePeriodUs) || options.samplePeriodUs <= 0) throw new RangeError('HIL sample period must be a positive integer in microseconds.');
  if (!finite(options.durationS) || options.durationS <= 0) throw new RangeError('HIL duration must be greater than zero.');
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
  const overrun = {
    maxConsecutive: options.overrun?.maxConsecutive ?? 0,
    action: assertText('Overrun action', options.overrun?.action),
  };
  if (!Number.isInteger(overrun.maxConsecutive) || overrun.maxConsecutive < 0) throw new RangeError('Maximum consecutive overruns must be a non-negative integer.');
  const requiredFaults = [...new Set(options.requiredFaults || [
    'sensor-open', 'sensor-short', 'sensor-stuck', 'out-of-range',
    'communication-timeout', 'target-overrun', 'power-cycle', 'emergency-safe-state',
  ])];
  return Object.freeze({
    schema: HIL_SCHEMA, targetId, modelId, modelVersion, graphChecksum,
    samplePeriodUs: options.samplePeriodUs, durationS: options.durationS,
    inputs: Object.freeze(inputs), outputs: Object.freeze(outputs), overrun: Object.freeze(overrun),
    requiredFaults: Object.freeze(requiredFaults),
    status: 'contract-ready-hardware-run-required',
  });
}

/** Evaluate evidence measured by a real HIL target; absence stays Unproven. */
export function evaluateHilEvidence(contract, evidence = null) {
  if (contract?.schema !== HIL_SCHEMA) throw new TypeError(`Expected ${HIL_SCHEMA}.`);
  if (!evidence) return {
    schema: HIL_SCHEMA, kind: 'hardware-in-the-loop', status: 'unproven',
    headline: 'HIL contract is ready; no target-hardware evidence has been supplied.',
  };
  const identity = evidence.targetId === contract.targetId
    && evidence.modelVersion === contract.modelVersion
    && evidence.graphChecksum === contract.graphChecksum;
  const cycleTimesUs = Array.isArray(evidence.cycleTimesUs) ? evidence.cycleTimesUs : [];
  const timing = cycleTimesUs.length > 0 && cycleTimesUs.every((value) => finite(value) && value > 0)
    && Math.max(...cycleTimesUs) <= contract.samplePeriodUs;
  const io = [...contract.inputs, ...contract.outputs].every((channel) => evidence.io?.[channel.id] === 'pass');
  const faults = contract.requiredFaults.every((fault) => evidence.faults?.[fault] === 'pass');
  const safeState = contract.outputs.every((channel) => evidence.safeState?.[channel.id] === channel.safeValue);
  const recordedOverruns = Number.isInteger(evidence.maxConsecutiveOverruns)
    ? evidence.maxConsecutiveOverruns : Infinity;
  const overrun = recordedOverruns <= contract.overrun.maxConsecutive;
  const checks = { identity, timing, io, faults, safeState, overrun };
  return {
    schema: HIL_SCHEMA, kind: 'hardware-in-the-loop',
    status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
    checks, maxCycleTimeUs: cycleTimesUs.length ? Math.max(...cycleTimesUs) : null,
    samplePeriodUs: contract.samplePeriodUs,
    headline: Object.values(checks).every(Boolean)
      ? 'Measured HIL evidence satisfies the declared contract.'
      : 'Measured HIL evidence does not satisfy the declared contract.',
  };
}
