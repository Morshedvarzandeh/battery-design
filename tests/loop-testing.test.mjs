import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIL_SCHEMA,
  LEGACY_HIL_SCHEMA,
  LEGACY_SIL_SCHEMA,
  HIL_RESULT_SCHEMA,
  MAX_HIL_TIMING_SAMPLES,
  SIL_SCHEMA,
  SIL_RESULT_SCHEMA,
  createHilTestContract,
  createSilTestPlan,
  evaluateHilEvidence,
  migrateLegacyHilTestContract,
  migrateLegacySilTestPlan,
  runSoftwareInLoop,
  verifyHilTestContract,
  verifySilTestPlan,
} from '../js/loop-testing.js';

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

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
  modelId: request.modelId, graphChecksum: request.graphChecksum,
  modelVersion: request.modelVersion, solver: request.solver,
  outputs: { energyJ: request.inputs.powerW * request.inputs.durationS }, units: { energyJ: 'J' },
});

test('SIL executes a versioned calculation and checks identity, units, range and repeatability', () => {
  const result = runSoftwareInLoop(plan, adapter);
  assert.equal(result.schema, SIL_RESULT_SCHEMA);
  assert.equal(result.status, 'pass');
  assert.equal(result.planChecksum, plan.checksum);
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assertDeepFrozen(result);
  assert.equal(runSoftwareInLoop(plan, adapter).checksum, result.checksum);
  assert.deepEqual(result.cases[0].checks, {
    identity: true, range: true, unit: true, repeatability: true,
  });
  const wrongUnit = runSoftwareInLoop(plan, (request) => ({ ...adapter(request), units: { energyJ: 'Wh' } }));
  assert.equal(wrongUnit.status, 'fail');
  assert.equal(wrongUnit.cases[0].checks.unit, false);
});

test('SIL repeatability is semantic across key order and detects changed values', () => {
  let orderedCall = 0;
  const reordered = runSoftwareInLoop(plan, (request) => {
    orderedCall += 1;
    if (orderedCall % 2) {
      return {
        modelId: request.modelId, modelVersion: request.modelVersion,
        graphChecksum: request.graphChecksum, solver: request.solver,
        outputs: { energyJ: 1000 }, units: { energyJ: 'J' },
      };
    }
    return {
      units: { energyJ: 'J' }, outputs: { energyJ: 1000 }, solver: request.solver,
      graphChecksum: request.graphChecksum, modelVersion: request.modelVersion, modelId: request.modelId,
    };
  });
  assert.equal(reordered.status, 'pass');
  assert.equal(reordered.cases[0].checks.repeatability, true);

  let changedCall = 0;
  const changed = runSoftwareInLoop(plan, (request) => ({
    modelId: request.modelId, modelVersion: request.modelVersion,
    graphChecksum: request.graphChecksum, solver: request.solver,
    outputs: { energyJ: changedCall++ ? 1000.5 : 1000 }, units: { energyJ: 'J' },
  }));
  assert.equal(changed.status, 'fail');
  assert.equal(changed.cases[0].checks.range, true);
  assert.equal(changed.cases[0].checks.repeatability, false);
});

test('SIL adapter responses are closed JSON and must echo the complete model identity', () => {
  const missingModel = runSoftwareInLoop(plan, (request) => {
    const value = adapter(request);
    delete value.modelId;
    return value;
  });
  assert.equal(missingModel.status, 'fail');
  assert.match(missingModel.cases[0].error, /requires: modelId/i);

  const wrongModel = runSoftwareInLoop(plan, (request) => ({ ...adapter(request), modelId: 'other' }));
  assert.equal(wrongModel.status, 'fail');
  assert.equal(wrongModel.cases[0].checks.identity, false);

  const extra = runSoftwareInLoop(plan, (request) => ({ ...adapter(request), privateTrace: [1, 2, 3] }));
  assert.equal(extra.status, 'fail');
  assert.match(extra.cases[0].error, /does not accept: privateTrace/i);

  const nonJson = runSoftwareInLoop(plan, (request) => ({
    ...adapter(request), outputs: { energyJ: 1000, callback: () => 1 },
  }));
  assert.equal(nonJson.status, 'fail');
  assert.match(nonJson.cases[0].error, /only JSON values/i);

  const unrepresentableThrow = runSoftwareInLoop(plan, () => {
    throw Object.create(null);
  });
  assert.equal(unrepresentableThrow.status, 'fail');
  assert.match(unrepresentableThrow.cases[0].error, /unrepresentable thrown value/i);
  assert.match(unrepresentableThrow.checksum, /^[a-f0-9]{64}$/);
  assertDeepFrozen(unrepresentableThrow);
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

test('SIL plans are deterministic content-addressed snapshots and clone caller data', () => {
  const source = { powerW: 100, nested: { durationS: 10 } };
  const first = createSilTestPlan({
    modelId: 'energy-balance', modelVersion: '1.2.3', graphChecksum: 'fnv1a32:12345678',
    solver: 'dormand-prince-45', deterministicSeed: 7,
    cases: [{
      id: 'constant-power-energy', purpose: 'Check E = P·t.', inputs: source,
      expected: { outputPath: 'energyJ', unit: 'J', min: 999, max: 1001 },
    }],
  });
  source.nested.durationS = 99;
  const second = createSilTestPlan({
    modelId: 'energy-balance', modelVersion: '1.2.3', graphChecksum: 'fnv1a32:12345678',
    solver: 'dormand-prince-45', deterministicSeed: 7,
    cases: [{
      id: 'constant-power-energy', purpose: 'Check E = P·t.',
      inputs: { nested: { durationS: 10 }, powerW: 100 },
      expected: { outputPath: 'energyJ', unit: 'J', min: 999, max: 1001 },
    }],
  });
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.cases[0].inputs.nested.durationS, 10);
  assertDeepFrozen(first);
});

test('SIL verification rejects nested mutation, missing fields and unknown fields', () => {
  const mutated = structuredClone(plan);
  mutated.cases[0].expected.max = 2000;
  assert.throws(() => verifySilTestPlan(mutated), /checksum mismatch/i);

  const missing = structuredClone(plan);
  delete missing.solver;
  assert.throws(() => verifySilTestPlan(missing), /requires: solver/i);

  const extra = structuredClone(plan);
  extra.cases[0].oracleSource = 'self-generated';
  assert.throws(() => verifySilTestPlan(extra), /does not accept: oracleSource/i);
  assert.throws(() => runSoftwareInLoop({ schema: plan.schema, cases: [] }, adapter), /requires:/i);
});

test('SIL trusted checksum distinguishes identity from producer authentication', () => {
  const changed = createSilTestPlan({
    modelId: plan.modelId, modelVersion: plan.modelVersion, graphChecksum: plan.graphChecksum,
    solver: plan.solver, deterministicSeed: plan.deterministicSeed,
    cases: [{
      id: 'constant-power-energy', purpose: 'A different accepted requirement.',
      inputs: { powerW: 100, durationS: 10 },
      expected: { outputPath: 'energyJ', unit: 'J', min: 990, max: 1010 },
    }],
  });
  assert.notEqual(changed.checksum, plan.checksum);
  assert.equal(verifySilTestPlan(changed).checksum, changed.checksum,
    'a self-checksum establishes the changed document identity');
  assert.throws(
    () => verifySilTestPlan(changed, { expectedChecksum: plan.checksum }),
    /trusted expected checksum/i,
  );
  assert.throws(() => verifySilTestPlan(plan, { expectedCheksum: plan.checksum }), /does not accept/i);
});

test('SIL creation fails closed on option typos, invalid seeds and non-JSON inputs', () => {
  const base = {
    modelId: 'm', modelVersion: '1', graphChecksum: 'c', solver: 's',
    cases: [{ id: 'x', purpose: 'p', expected: { outputPath: 'x', unit: 'V', min: 0, max: 1 } }],
  };
  assert.throws(() => createSilTestPlan({ ...base, slver: 'typo' }), /does not accept: slver/i);
  assert.throws(() => createSilTestPlan({ ...base, modelId: 1 }), /model id must be a string/i);
  assert.throws(() => createSilTestPlan({ ...base, deterministicSeed: 1.2 }), /safe integer/i);
  assert.throws(() => createSilTestPlan({
    ...base, cases: [{ ...base.cases[0], inputs: { value: Number.NaN } }],
  }), /finite JSON numbers/i);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => createSilTestPlan({
    ...base, cases: [{ ...base.cases[0], inputs: cyclic }],
  }), /must not contain a cycle/i);
});

test('SIL content identity rejects sparse arrays before adapters can observe a checksum alias', () => {
  const caseWith = (samples) => ({
    modelId: 'array-observer', modelVersion: '1', graphChecksum: 'c', solver: 'exact',
    cases: [{
      id: 'array-slot', purpose: 'Distinguish a present null from an absent array slot.',
      inputs: { samples }, expected: { outputPath: 'present', unit: '0/1', min: 1, max: 1 },
    }],
  });
  assert.throws(() => createSilTestPlan({
    modelId: 'array-observer', modelVersion: '1', graphChecksum: 'c', solver: 'exact',
    cases: new Array(1),
  }), /test cases must not contain sparse array slots/i);
  assert.throws(() => createSilTestPlan(caseWith(new Array(1))), /sparse array slots/i);

  const explicitNull = createSilTestPlan(caseWith([null]));
  const observed = runSoftwareInLoop(explicitNull, (request) => ({
    modelId: request.modelId, graphChecksum: request.graphChecksum,
    modelVersion: request.modelVersion, solver: request.solver,
    outputs: { present: Object.hasOwn(request.inputs.samples, 0) ? 1 : 0 },
    units: { present: '0/1' },
  }));
  assert.equal(observed.status, 'pass');
  assert.equal(observed.cases[0].actual, 1);
});

test('SIL output oracles read own properties only and reject prototype-path segments', () => {
  assert.throws(() => createSilTestPlan({
    modelId: 'prototype-output', modelVersion: '1', graphChecksum: 'c', solver: 'exact',
    cases: [{
      id: 'inherited', purpose: 'No inherited value may satisfy an output oracle.',
      expected: { outputPath: 'constructor.length', unit: 'count', min: 1, max: 1 },
    }],
  }), /own-property segments/i);

  const inherited = runSoftwareInLoop(plan, (request) => ({
    modelId: request.modelId, graphChecksum: request.graphChecksum,
    modelVersion: request.modelVersion, solver: request.solver,
    outputs: Object.create({ energyJ: 1000 }),
    units: Object.create({ energyJ: 'J' }),
  }));
  assert.equal(inherited.status, 'fail');
  assert.match(inherited.cases[0].error, /must be a plain object/i);
});

const contract = createHilTestContract({
  targetId: 'rt-target-1', modelId: 'bms-controller', modelVersion: '4.0.0',
  graphChecksum: 'fnv1a32:abcdef12', samplePeriodUs: 1000, durationS: 0.003,
  inputs: [{ id: 'pack-v', quantity: 'voltage', unit: 'V', min: 0, max: 1000 }],
  outputs: [{ id: 'contactor', quantity: 'boolean', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
  overrun: { maxConsecutive: 0, action: 'Open contactor.' },
});

test('HIL stays unproven without hardware and passes only complete measured evidence', () => {
  const unproven = evaluateHilEvidence(contract);
  assert.equal(unproven.schema, HIL_RESULT_SCHEMA);
  assert.equal(unproven.status, 'unproven');
  assert.equal(unproven.contractSchema, HIL_SCHEMA);
  assert.equal(unproven.contractChecksum, contract.checksum);
  assert.equal(unproven.checks, null);
  assert.equal(unproven.maxCycleTimeUs, null);
  assert.match(unproven.checksum, /^[a-f0-9]{64}$/);
  assertDeepFrozen(unproven);
  assert.equal(evaluateHilEvidence(contract).checksum, unproven.checksum);
  assert.equal(unproven.requiredCycleCount, 3);
  assert.equal(unproven.observedCycleCount, 0);
  const evidence = {
    targetId: contract.targetId, modelId: contract.modelId, modelVersion: contract.modelVersion,
    graphChecksum: contract.graphChecksum, cycleTimesUs: [720, 840, 910],
    io: { 'pack-v': 'pass', contactor: 'pass' },
    faults: Object.fromEntries(contract.requiredFaults.map((fault) => [fault, 'pass'])),
    safeState: { contactor: 0 }, maxConsecutiveOverruns: 0,
  };
  const pass = evaluateHilEvidence(contract, evidence);
  assert.equal(pass.schema, HIL_RESULT_SCHEMA);
  assert.equal(pass.status, 'pass');
  assert.equal(pass.contractChecksum, contract.checksum);
  assert.equal(pass.targetId, contract.targetId);
  assert.match(pass.checksum, /^[a-f0-9]{64}$/);
  assertDeepFrozen(pass);
  assert.equal(evaluateHilEvidence(contract, structuredClone(evidence)).checksum, pass.checksum);
  assert.deepEqual(Object.keys(pass).sort(), Object.keys(unproven).sort());
  const sameSummaryDifferentTrace = evaluateHilEvidence(contract, {
    ...evidence, cycleTimesUs: [700, 850, 910],
  });
  assert.equal(sameSummaryDifferentTrace.checksum, pass.checksum);
  const missingModelId = structuredClone(evidence);
  delete missingModelId.modelId;
  assert.equal(evaluateHilEvidence(contract, missingModelId).checks.identity, false);
  assert.equal(evaluateHilEvidence(contract, { ...evidence, modelId: 'other-model' }).checks.identity, false);
  assert.equal(pass.maxCycleTimeUs, 910);
  assert.equal(pass.requiredCycleCount, 3);
  assert.equal(pass.observedCycleCount, 3);
  const partial = evaluateHilEvidence(contract, { ...evidence, cycleTimesUs: [720] });
  assert.equal(partial.status, 'fail');
  assert.equal(partial.checks.timing, false);
  assert.equal(partial.requiredCycleCount, 3);
  assert.equal(partial.observedCycleCount, 1);
  assert.equal(partial.maxCycleTimeUs, 720);
  assert.notEqual(partial.checksum, pass.checksum);
  assert.deepEqual(Object.keys(partial).sort(), Object.keys(pass).sort());
  assert.equal(evaluateHilEvidence(contract, { ...evidence, cycleTimesUs: [1200] }).status, 'fail');
  const negativeOverrun = evaluateHilEvidence(contract, { ...evidence, maxConsecutiveOverruns: -1 });
  assert.equal(negativeOverrun.status, 'fail');
  assert.equal(negativeOverrun.checks.overrun, false);
});

test('HIL timing scans large complete traces without spread overflow and caps impossible contracts', () => {
  const cycleCount = 200_000;
  const largeContract = createHilTestContract({
    targetId: 'fast-target', modelId: 'controller', modelVersion: '1', graphChecksum: 'sha256:model',
    samplePeriodUs: 1, durationS: cycleCount / 1_000_000,
    inputs: [{ id: 'input', quantity: 'voltage', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'safe', quantity: 'boolean', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
    overrun: { maxConsecutive: 0, action: 'safe' }, requiredFaults: ['fault'],
  });
  const result = evaluateHilEvidence(largeContract, {
    targetId: 'fast-target', modelId: 'controller', modelVersion: '1', graphChecksum: 'sha256:model',
    cycleTimesUs: Array(cycleCount).fill(0.5),
    io: { input: 'pass', safe: 'pass' }, faults: { fault: 'pass' },
    safeState: { safe: 0 }, maxConsecutiveOverruns: 0,
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.requiredCycleCount, cycleCount);
  assert.equal(result.observedCycleCount, cycleCount);
  assert.equal(result.maxCycleTimeUs, 0.5);

  assert.throws(() => createHilTestContract({
    targetId: 'too-long', modelId: 'controller', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1, durationS: (MAX_HIL_TIMING_SAMPLES + 1) / 1_000_000,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
    overrun: { action: 'safe' },
  }), /between 1 and 1000000 cycles/i);
});

test('HIL cycle derivation uses exact decimal boundaries and never hides a partial period', () => {
  const makeContract = (durationS) => createHilTestContract({
    targetId: 'boundary-target', modelId: 'controller', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1, durationS,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
    overrun: { action: 'safe' }, requiredFaults: ['fault'],
  });
  const exactBoundary = makeContract(0.000123);
  const exactResult = evaluateHilEvidence(exactBoundary, {
    targetId: 'boundary-target', modelId: 'controller', modelVersion: '1', graphChecksum: 'c',
    cycleTimesUs: Array(123).fill(0.5), io: { i: 'pass', o: 'pass' },
    faults: { fault: 'pass' }, safeState: { o: 0 }, maxConsecutiveOverruns: 0,
  });
  assert.equal(exactResult.requiredCycleCount, 123);
  assert.equal(exactResult.status, 'pass');

  const justAbove = evaluateHilEvidence(makeContract(0.000123000000001));
  assert.equal(justAbove.requiredCycleCount, 124);
  assert.equal(justAbove.status, 'unproven');

  assert.equal(evaluateHilEvidence(makeContract(Number.MIN_VALUE)).requiredCycleCount, 1);
  assert.throws(() => makeContract(1 + Number.EPSILON), /between 1 and 1000000 cycles/i);
});

test('HIL rejects unsafe output states and non-integer timing contracts', () => {
  assert.throws(() => createHilTestContract({
    targetId: 't', modelId: 'm', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1.5, durationS: 1,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 2 }],
    overrun: { action: 'safe' },
  }), /positive safe integer/i);
  assert.throws(() => createHilTestContract({
    targetId: 't', modelId: 'm', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: Number.MAX_SAFE_INTEGER + 1, durationS: 1,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
    overrun: { action: 'safe' },
  }), /positive safe integer/i);
  assert.throws(() => createHilTestContract({
    targetId: 't', modelId: 'm', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1000, durationS: 1,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 2 }],
    overrun: { action: 'safe' },
  }), /safe value/i);
});

test('HIL contracts are deterministic deeply frozen snapshots with unique faults', () => {
  const clone = createHilTestContract({
    targetId: 'rt-target-1', modelId: 'bms-controller', modelVersion: '4.0.0',
    graphChecksum: 'fnv1a32:abcdef12', samplePeriodUs: 1000, durationS: 0.003,
    inputs: [{ id: 'pack-v', quantity: 'voltage', unit: 'V', min: 0, max: 1000 }],
    outputs: [{ id: 'contactor', quantity: 'boolean', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
    overrun: { action: 'Open contactor.', maxConsecutive: 0 },
  });
  assert.equal(clone.checksum, contract.checksum);
  assertDeepFrozen(clone);
  assert.throws(() => createHilTestContract({
    targetId: 't', modelId: 'm', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1000, durationS: 1,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
    overrun: { action: 'safe' }, requiredFaults: ['sensor-open', 'sensor-open'],
  }), /faults must be unique/i);
  assert.throws(() => createHilTestContract({
    targetId: 't', modelId: 'm', modelVersion: '1', graphChecksum: 'c',
    samplePeriodUs: 1000, durationS: 1,
    inputs: [{ id: 'i', quantity: 'v', unit: 'V', min: 0, max: 1 }],
    outputs: [{ id: 'o', quantity: 'b', unit: '0/1', min: 0, max: 1, safeValue: 0 }],
    overrun: { action: 'safe' }, requiredFaults: new Array(1),
  }), /faults must not contain sparse array slots/i);
});

test('HIL verification rejects nested mutation, forged status and schema-only objects', () => {
  const mutated = structuredClone(contract);
  mutated.outputs[0].safeValue = 1;
  assert.throws(() => verifyHilTestContract(mutated), /checksum mismatch/i);

  const status = structuredClone(contract);
  status.status = 'hardware-pass';
  assert.throws(() => verifyHilTestContract(status), /status must remain/i);

  assert.throws(() => evaluateHilEvidence({ schema: contract.schema }), /requires:/i);
  const result = evaluateHilEvidence(contract);
  assert.equal(result.contractChecksum, contract.checksum);
});

test('HIL evidence requires own identity, I/O, fault and safe-state measurements', () => {
  const inheritedMaps = {
    targetId: contract.targetId,
    modelId: contract.modelId,
    modelVersion: contract.modelVersion,
    graphChecksum: contract.graphChecksum,
    cycleTimesUs: [800],
    io: Object.create({ 'pack-v': 'pass', contactor: 'pass' }),
    faults: Object.create(Object.fromEntries(contract.requiredFaults.map((fault) => [fault, 'pass']))),
    safeState: Object.create({ contactor: 0 }),
    maxConsecutiveOverruns: 0,
  };
  const rejectedMaps = evaluateHilEvidence(contract, inheritedMaps);
  assert.equal(rejectedMaps.status, 'fail');
  assert.deepEqual(
    { io: rejectedMaps.checks.io, faults: rejectedMaps.checks.faults, safeState: rejectedMaps.checks.safeState },
    { io: false, faults: false, safeState: false },
  );

  const inheritedEnvelope = Object.create(inheritedMaps);
  const rejectedIdentity = evaluateHilEvidence(contract, inheritedEnvelope);
  assert.equal(rejectedIdentity.status, 'fail');
  assert.equal(rejectedIdentity.checks.identity, false);
  assert.equal(rejectedIdentity.checks.timing, false);
  assert.equal(rejectedIdentity.checks.overrun, false);
});

test('HIL trusted checksum rejects a coordinated but differently identified contract', () => {
  const changed = createHilTestContract({
    targetId: contract.targetId, modelId: contract.modelId, modelVersion: contract.modelVersion,
    graphChecksum: contract.graphChecksum, samplePeriodUs: 2000, durationS: contract.durationS,
    inputs: contract.inputs, outputs: contract.outputs, overrun: contract.overrun,
    requiredFaults: contract.requiredFaults,
  });
  assert.notEqual(changed.checksum, contract.checksum);
  assert.equal(verifyHilTestContract(changed).checksum, changed.checksum);
  assert.throws(
    () => verifyHilTestContract(changed, { expectedChecksum: contract.checksum }),
    /trusted expected checksum/i,
  );
});

test('legacy @1 loop documents require explicit rematerialization into checksummed @2 snapshots', () => {
  const legacyPlan = structuredClone(plan);
  legacyPlan.schema = LEGACY_SIL_SCHEMA;
  delete legacyPlan.checksum;
  assert.throws(() => verifySilTestPlan(legacyPlan), /migrateLegacySilTestPlan/i);
  const migratedPlan = migrateLegacySilTestPlan(legacyPlan);
  assert.equal(migratedPlan.schema, SIL_SCHEMA);
  assert.match(migratedPlan.checksum, /^[a-f0-9]{64}$/);
  assert.equal(runSoftwareInLoop(migratedPlan, adapter).status, 'pass');

  const legacyContract = structuredClone(contract);
  legacyContract.schema = LEGACY_HIL_SCHEMA;
  delete legacyContract.checksum;
  assert.throws(() => verifyHilTestContract(legacyContract), /migrateLegacyHilTestContract/i);
  const migratedContract = migrateLegacyHilTestContract(legacyContract);
  assert.equal(migratedContract.schema, HIL_SCHEMA);
  assert.match(migratedContract.checksum, /^[a-f0-9]{64}$/);
  assert.equal(evaluateHilEvidence(migratedContract).status, 'unproven');
});
