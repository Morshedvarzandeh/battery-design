import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHilTestContract,
  createSilTestPlan,
  evaluateHilEvidence,
  runSoftwareInLoop,
} from '../js/loop-testing.js';

const plan = createSilTestPlan({
  modelId: 'energy-balance', modelVersion: '1.2.3', graphChecksum: 'fnv1a32:12345678',
  solver: 'dormand-prince-45', deterministicSeed: 7,
  cases: [{
    id: 'constant-power-energy', purpose: 'Check E = P·t against the analytical result.',
    inputs: { powerW: 100, durationS: 10 },
    expected: { outputPath: 'energyJ', unit: 'J', min: 999.999, max: 1000.001 },
  }],
});

const adapter = (request) => ({
  graphChecksum: request.graphChecksum, modelVersion: request.modelVersion, solver: request.solver,
  outputs: { energyJ: request.inputs.powerW * request.inputs.durationS }, units: { energyJ: 'J' },
});

test('SIL executes a versioned calculation and checks identity, units, range and repeatability', () => {
  const result = runSoftwareInLoop(plan, adapter);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.cases[0].checks, {
    identity: true, range: true, unit: true, repeatability: true,
  });
  const wrongUnit = runSoftwareInLoop(plan, (request) => ({ ...adapter(request), units: { energyJ: 'Wh' } }));
  assert.equal(wrongUnit.status, 'fail');
  assert.equal(wrongUnit.cases[0].checks.unit, false);
});

test('SIL refuses self-empty plans and duplicate or unordered oracles', () => {
  assert.throws(() => createSilTestPlan({
    modelId: 'm', modelVersion: '1', graphChecksum: 'c', solver: 's', cases: [],
  }), /at least one/i);
  assert.throws(() => createSilTestPlan({
    modelId: 'm', modelVersion: '1', graphChecksum: 'c', solver: 's',
    cases: [{ id: 'bad', purpose: 'bad', expected: { outputPath: 'x', unit: 'V', min: 2, max: 1 } }],
  }), /ordered/i);
});

const contract = createHilTestContract({
  targetId: 'rt-target-1', modelId: 'bms-controller', modelVersion: '4.0.0',
  graphChecksum: 'fnv1a32:abcdef12', samplePeriodUs: 1000, durationS: 30,
  inputs: [{ id: 'pack-v', quantity: 'voltage', unit: 'V', min: 0, max: 1000 }],
  outputs: [{ id: 'contactor', quantity: 'boolean', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
  overrun: { maxConsecutive: 0, action: 'Open contactor.' },
});

test('HIL stays unproven without hardware and passes only complete measured evidence', () => {
  assert.equal(evaluateHilEvidence(contract).status, 'unproven');
  const evidence = {
    targetId: contract.targetId, modelVersion: contract.modelVersion,
    graphChecksum: contract.graphChecksum, cycleTimesUs: [720, 840, 910],
    io: { 'pack-v': 'pass', contactor: 'pass' },
    faults: Object.fromEntries(contract.requiredFaults.map((fault) => [fault, 'pass'])),
    safeState: { contactor: 0 }, maxConsecutiveOverruns: 0,
  };
  const pass = evaluateHilEvidence(contract, evidence);
  assert.equal(pass.status, 'pass');
  assert.equal(pass.maxCycleTimeUs, 910);
  assert.equal(evaluateHilEvidence(contract, { ...evidence, cycleTimesUs: [1200] }).status, 'fail');
});

test('HIL rejects unsafe output states and non-integer timing contracts', () => {
  assert.throws(() => createHilTestContract({
    targetId: 't', modelId: 'm', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1.5, durationS: 1,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 2 }],
    overrun: { action: 'safe' },
  }), /positive integer/i);
  assert.throws(() => createHilTestContract({
    targetId: 't', modelId: 'm', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1000, durationS: 1,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 2 }],
    overrun: { action: 'safe' },
  }), /safe value/i);
});
