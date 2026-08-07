import test from 'node:test';
import assert from 'node:assert/strict';

import { materializeCalibrationDataset } from '../js/calibration-dataset.js';
import { cellById } from '../js/cells.js';
import {
  ECM_TUNING_ACCEPTANCE_POLICY,
  ECM_TUNING_GATE_POLICY,
  ECM_TUNING_GROUP_CONTRACT_CHECKSUM,
  ECM_TUNING_GROUPS,
  ECM_TUNING_PLAN_FORMAT,
  ECM_TUNING_STRATEGY,
  planEcmTuning,
} from '../js/ecm-tuning.js';
import { semanticDigest } from '../js/ontology.js';
import { ocvCell } from '../js/sim1d.js';

const CELL = cellById('samsung-inr21700-50e');

const acceptance = (overrides = {}) => ({
  maxVoltageRmseMvPerCell: 10,
  maxVoltageMaxAbsMvPerCell: 25,
  maxTemperatureRmseC: null,
  maxTemperatureMaxAbsC: null,
  minValidationDatasets: 1,
  minIncludedSamplesPerDataset: 100,
  requiredModes: ['dynamic'],
  requireNoHoldoutRegression: true,
  requireNoFittedParameterAtBound: true,
  ...overrides,
});

function pulseProtocol(amplitudeA = 5) {
  return [
    ...Array(650).fill(0),
    ...Array(900).fill(amplitudeA),
    ...Array(650).fill(0),
    ...Array(900).fill(-amplitudeA),
    ...Array(650).fill(0),
  ];
}

function dataset({
  id,
  purpose = 'calibration',
  startSoC = 0.5,
  ambientC = 25,
  currentA = pulseProtocol(),
  temperatureLocation = 'cell-average',
  withTemperature = true,
  voltageOffsetV = 0,
  rawKey = id,
  runId = id,
  toolVersion = '1.0.0',
  model = 'P2D-fixture',
  segments = null,
  samplePeriodS = 1,
} = {}) {
  const baseVoltage = ocvCell(CELL, startSoC);
  const voltageV = currentA.map((current, index) => (
    baseVoltage - current * 0.004 + voltageOffsetV * (index === 0 ? 0 : 1)
  ));
  const temperatureC = withTemperature ? currentA.map(() => ambientC) : null;
  return materializeCalibrationDataset({
    id,
    kind: 'synthetic',
    purpose,
    source: {
      tool: 'Synthetic solver fixture', toolVersion, model, runId,
      generatedAt: null, mediaType: 'application/json',
      rawSha256: semanticDigest(`raw:${rawKey}`),
    },
    binding: {
      cellId: CELL.id, seriesCells: 1, parallelCells: 1,
      startSoC, ambientC, moduleCount: 1,
      initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'canonical-json', adapterVersion: '1.0.0',
      mappingChecksum: semanticDigest(`mapping:${id}`),
      sourceUnits: {
        time: 's', current: 'A', voltage: 'V',
        temperature: withTemperature ? 'degC' : null,
      },
      sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal',
      sourceTemperatureLocation: withTemperature ? temperatureLocation : null,
      sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: samplePeriodS,
      sourceResetTimeS: 0, timeHandling: 'validated-uniform',
      originalSampleCount: currentA.length,
    },
    samplePeriodS,
    signals: { currentA, voltageV, temperatureC },
    segments: segments || [{
      id: 'complete', startIndex: 0, endIndexExclusive: currentA.length,
      mode: 'dynamic', include: true,
    }],
    conventions: {
      timeBasis: 'uniform-sample-period', timeOrigin: 'trial-reset',
      firstSampleOffsetS: samplePeriodS, sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold', currentPositive: 'discharge',
      currentScope: 'pack', voltageLocation: 'pack-terminal',
      temperatureLocation: withTemperature ? temperatureLocation : null,
    },
  });
}

function completeTrials() {
  const calibrationDatasets = [
    dataset({ id: 'soc-mid-temp-ref', startSoC: 0.5, ambientC: 25 }),
    dataset({ id: 'soc-upper-temp-ref', startSoC: 0.75, ambientC: 25 }),
    dataset({ id: 'soc-extreme-temp-ref', startSoC: 0.95, ambientC: 25 }),
    dataset({ id: 'temp-cold-soc-mid', startSoC: 0.5, ambientC: 5 }),
    dataset({ id: 'temp-hot-soc-mid', startSoC: 0.5, ambientC: 45 }),
  ];
  const validationDatasets = [dataset({
    id: 'independent-holdout', purpose: 'validation', startSoC: 0.9,
    ambientC: 15, currentA: pulseProtocol(4.5), voltageOffsetV: 0.003,
  })];
  return { calibrationDatasets, validationDatasets };
}

function input(overrides = {}) {
  return {
    cell: CELL,
    ...completeTrials(),
    acceptance: acceptance(),
    maxEvaluations: 53,
    maxIntegrationSteps: 101,
    maxModuleWeightedIntegrationSteps: 113,
    maxSamplesPerDataset: 5_000,
    ...overrides,
  };
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('the complete matched experiment produces a deeply frozen six-group plan without executing an optimizer', () => {
  const plan = planEcmTuning(input());
  assert.equal(plan.format, ECM_TUNING_PLAN_FORMAT);
  assert.equal(plan.strategy, ECM_TUNING_STRATEGY);
  assert.equal(plan.acceptancePolicy, ECM_TUNING_ACCEPTANCE_POLICY);
  assert.equal(plan.gatePolicy, ECM_TUNING_GATE_POLICY);
  const gateBody = { ...ECM_TUNING_GATE_POLICY };
  delete gateBody.checksum;
  assert.equal(ECM_TUNING_GATE_POLICY.checksum, semanticDigest(gateBody));
  assert.equal(plan.groupContractChecksum, ECM_TUNING_GROUP_CONTRACT_CHECKSUM);
  assert.equal(ECM_TUNING_GROUP_CONTRACT_CHECKSUM, semanticDigest(ECM_TUNING_GROUPS));
  assert.equal(plan.request.cellChecksum, plan.cellChecksum);
  assert.equal(plan.request.gatePolicyChecksum, ECM_TUNING_GATE_POLICY.checksum);
  assert.equal(plan.request.groupContractChecksum, ECM_TUNING_GROUP_CONTRACT_CHECKSUM);
  assert.equal(plan.request.preprocessingPolicyChecksum, plan.preprocessingPolicy.checksum);
  assert.deepEqual(plan.readiness.activeGroups, ECM_TUNING_GROUPS.map(({ id }) => id));
  assert.equal(plan.readiness.optimizerExecution, 'not-started');
  assert.equal(plan.readiness.structuralPlanReady, true);
  assert.equal(plan.readiness.executionReady, false);
  assert.equal(plan.readiness.workPreflight, 'required-before-first-candidate');
  assert.match(plan.readiness.preprocessing, /maxPreprocessedSamplesPerDataset/);
  assert.equal(plan.readiness.numericalSensitivity, 'required-before-fit-activation');
  assert.equal(plan.readiness.identifiabilityClaim, 'not-established-by-this-plan');
  assert.match(plan.readiness.holdoutIndependenceClaim, /not-established/);
  assert.equal(plan.candidateConstraints.rcTimeConstantOrdering.minimumRatio, 3);
  assert.match(plan.candidateConstraints.rcTimeConstantOrdering.enforcement, /every-stage-candidate/);
  assert.equal(plan.stages.length, 7);
  assert.deepEqual(plan.stages.at(-1).fit, [
    'r0Ref', 'rc1R', 'rc1TauS', 'rc2R', 'rc2TauS',
    'r0SocRise', 'r0EaJ', 'hystV',
  ]);
  assert.equal(plan.stages.at(-1).initialSimplexEvaluations, 9);
  assert.equal(plan.stages.at(-1).sensitivityProbeEvaluations, 9);
  assert.equal(plan.stages.at(-1).minimumEvaluationReservation, 18);
  assert.ok(plan.groups.every(({ status, gates }) => status === 'active'
    && gates.every(({ status: gateStatus }) => gateStatus === 'pass')));
  const cold = plan.trials.calibration.find(({ id }) => id === 'temp-cold-soc-mid');
  const hot = plan.trials.calibration.find(({ id }) => id === 'temp-hot-soc-mid');
  assert.equal(cold.scoredElectricalObservationChecksum, hot.scoredElectricalObservationChecksum,
    'controlled temperature matrices may reuse the same scored electrical protocol inside training');
  assertDeepFrozen(plan);
  assert.throws(() => { plan.stages[0].fit.push('r0EaJ'); }, TypeError);
  assert.doesNotMatch(JSON.stringify(plan), /"(?:signals|currentA|voltageV|temperatureC)"\s*:/,
    'planning evidence identifies whole trials without echoing source traces');
});

test('plan identity is deterministic, order independent and binds caller acceptance plus every custody identity', () => {
  const firstInput = input();
  const first = planEcmTuning(firstInput);
  const permuted = planEcmTuning({
    ...firstInput,
    calibrationDatasets: [...firstInput.calibrationDatasets].reverse(),
  });
  assert.deepEqual(permuted, first, 'canonical trial identities remove caller list-order drift');
  assert.equal(first.requestChecksum, semanticDigest(first.request));
  const body = { ...first };
  delete body.checksum;
  assert.equal(first.checksum, semanticDigest(body));
  assert.equal(first.acceptanceChecksum, semanticDigest(first.acceptance));
  assert.equal(first.request.calibrationIdentities.length, firstInput.calibrationDatasets.length);
  for (const identity of [...first.request.calibrationIdentities, ...first.request.validationIdentities]) {
    assert.deepEqual(Object.keys(identity), [
      'datasetChecksum', 'observationChecksum', 'trialContentChecksum',
      'electricalHistoryChecksum', 'scoredElectricalObservationChecksum',
      'preparedElectricalObservationChecksum',
      'rawSha256', 'sourceIdentityChecksum',
    ]);
  }

  const thresholdChanged = planEcmTuning(input({ acceptance: acceptance({ maxVoltageRmseMvPerCell: 9 }) }));
  assert.notEqual(thresholdChanged.acceptanceChecksum, first.acceptanceChecksum);
  assert.notEqual(thresholdChanged.requestChecksum, first.requestChecksum);

  const changedTrials = completeTrials();
  changedTrials.calibrationDatasets[0] = dataset({
    id: 'soc-mid-temp-ref', startSoC: 0.5, ambientC: 25,
    runId: 'different-source-run', rawKey: 'different-source-bytes',
  });
  const custodyChanged = planEcmTuning(input(changedTrials));
  const originalPhysical = first.trials.calibration.find(({ id }) => id === 'soc-mid-temp-ref');
  const changedPhysical = custodyChanged.trials.calibration.find(({ id }) => id === 'soc-mid-temp-ref');
  assert.equal(changedPhysical.trialContentChecksum, originalPhysical.trialContentChecksum,
    'purpose-neutral physical trial identity intentionally excludes custody metadata');
  assert.notEqual(changedPhysical.rawSha256, originalPhysical.rawSha256);
  assert.notEqual(changedPhysical.sourceIdentityChecksum, originalPhysical.sourceIdentityChecksum);
  assert.notEqual(custodyChanged.requestChecksum, first.requestChecksum,
    'source custody is part of request identity even though it does not alter model observations');
});

test('evaluation and integration budgets are exact deterministic partitions with every initial simplex reserved', () => {
  const plan = planEcmTuning(input());
  assert.equal(plan.budgets.allocatedEvaluations, 53);
  assert.equal(plan.stages.reduce((sum, stage) => sum + stage.evaluationBudget, 0), 53);
  assert.deepEqual(plan.stages.map(({ evaluationBudget }) => evaluationBudget),
    [4, 7, 7, 4, 5, 4, 22]);
  assert.equal(plan.budgets.reservedSensitivityProbeEvaluations, 23);
  assert.equal(plan.budgets.reservedInitialSimplexEvaluations, 23);
  assert.equal(plan.budgets.reservedPreflightEvaluations, 46);
  assert.ok(plan.stages.every((stage) => stage.evaluationBudget >= stage.minimumEvaluationReservation));
  assert.equal(plan.budgets.allocatedIntegrationSteps, 101);
  assert.equal(plan.stages.reduce((sum, stage) => sum + stage.integrationStepBudget, 0), 101);
  assert.deepEqual(plan.stages.map(({ integrationStepBudget }) => integrationStepBudget),
    [8, 14, 13, 8, 10, 8, 40]);
  assert.equal(plan.budgets.allocatedModuleWeightedIntegrationSteps, 113);
  assert.equal(plan.stages.reduce((sum, stage) => sum + stage.moduleWeightedIntegrationStepBudget, 0), 113);
  assert.deepEqual(plan.stages.map(({ moduleWeightedIntegrationStepBudget }) => (
    moduleWeightedIntegrationStepBudget
  )), [9, 15, 15, 9, 11, 9, 45]);
  assert.match(plan.budgets.allocationPolicy, /allocated ceilings.*preflight exact temporal and module-weighted work/);
  assert.equal(plan.readiness.executionReady, false,
    'partitioned ceilings are not proof that one optimizer candidate fits');
  assert.throws(() => planEcmTuning(input({ maxEvaluations: 45 })), /cannot fund the 46 units/);
  assert.throws(() => planEcmTuning(input({ maxIntegrationSteps: 6 })), /cannot fund the 7 units/);
  assert.throws(() => planEcmTuning(input({ maxModuleWeightedIntegrationSteps: 6 })), /cannot fund the 7 units/);

  const maximumSafe = planEcmTuning(input({
    maxIntegrationSteps: Number.MAX_SAFE_INTEGER - 42,
    maxModuleWeightedIntegrationSteps: Number.MAX_SAFE_INTEGER,
  }));
  assert.equal(maximumSafe.stages.reduce((sum, stage) => sum + stage.integrationStepBudget, 0),
    Number.MAX_SAFE_INTEGER - 42);
  assert.equal(maximumSafe.stages.reduce((sum, stage) => (
    sum + stage.moduleWeightedIntegrationStepBudget
  ), 0), Number.MAX_SAFE_INTEGER);
  assert.ok(maximumSafe.stages.every((stage) => (
    Number.isSafeInteger(stage.integrationStepBudget)
    && Number.isSafeInteger(stage.moduleWeightedIntegrationStepBudget)
  )));

  const formerOverflow = planEcmTuning(input({
    groups: ['ohmic'],
    maxEvaluations: 203_337,
    maxIntegrationSteps: 9_007_199_178_284_526,
    maxModuleWeightedIntegrationSteps: 9_007_199_178_284_526,
  }));
  assert.equal(formerOverflow.stages.reduce((sum, stage) => (
    sum + stage.integrationStepBudget
  ), 0), 9_007_199_178_284_526);
  assert.equal(formerOverflow.stages.reduce((sum, stage) => (
    sum + stage.moduleWeightedIntegrationStepBudget
  ), 0), 9_007_199_178_284_526);

  const preprocessed = planEcmTuning(input({
    maxSamplesPerDataset: 100,
    acceptance: acceptance({ minIncludedSamplesPerDataset: 90 }),
  }));
  assert.equal(preprocessed.request.maxSamplesPerDataset, 100);
  assert.equal(preprocessed.budgets.maxPreprocessedSamplesPerDataset, 100);
  assert.ok(preprocessed.trials.calibration.every(({ samples }) => samples > 100),
    'the limit governs deterministic preprocessing rather than rejecting valid raw trials');
});

test('automatic selection skips only unsupported groups and records stable exact gate reasons', () => {
  const calibrationDatasets = [dataset({ id: 'one-condition' })];
  const validationDatasets = [dataset({
    id: 'one-condition-holdout', purpose: 'validation', currentA: pulseProtocol(4.5),
    startSoC: 0.55, voltageOffsetV: 0.002,
  })];
  const options = input({ calibrationDatasets, validationDatasets, groups: 'auto' });
  const first = planEcmTuning(options);
  const second = planEcmTuning(options);
  assert.deepEqual(second, first);
  assert.deepEqual(first.readiness.activeGroups, ['ohmic', 'fast-rc', 'slow-rc', 'hysteresis']);
  assert.deepEqual(first.readiness.skippedGroups.map(({ id }) => id), ['soc-dependence', 'arrhenius']);
  assert.match(first.readiness.skippedGroups[0].reasons.join(' '), /three distinguishable symmetric SoC-basis levels/);
  assert.match(first.readiness.skippedGroups[1].reasons.join(' '), /three near-isothermal cell-average trials/);
});

test('explicitly requested groups fail closed when their excitation gate or common OCV prerequisite fails', () => {
  const oneCalibration = [dataset({ id: 'explicit-arrhenius-one-temperature' })];
  const holdout = [dataset({
    id: 'explicit-arrhenius-holdout', purpose: 'validation', currentA: pulseProtocol(4.5),
    voltageOffsetV: 0.002,
  })];
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: oneCalibration, validationDatasets: holdout, groups: ['arrhenius'],
  })), /Explicit ECM tuning group.*arrhenius.*three near-isothermal/);

  const badOcv = completeTrials();
  // Offset sample zero explicitly: the fixture normally protects it so valid
  // traces retain the exact rested OCV baseline.
  badOcv.calibrationDatasets[0] = (() => {
    const original = dataset({ id: 'bad-ocv-only-trial' });
    const payload = structuredClone(original);
    delete payload.format;
    delete payload.schemaVersion;
    delete payload.checksum;
    payload.signals.voltageV[0] += 0.1;
    payload.source.rawSha256 = semanticDigest('bad-ocv-raw');
    payload.source.runId = 'bad-ocv-run';
    return materializeCalibrationDataset(payload);
  })();
  badOcv.calibrationDatasets = [badOcv.calibrationDatasets[0]];
  assert.throws(() => planEcmTuning(input({
    ...badOcv, groups: ['fast-rc'],
  })), /Explicit ECM tuning group.*fixed catalog OCV/);
});

test('the pulse/rest gate does not misclassify an uninformative middle-current plateau as rest', () => {
  const capacityA = CELL.capacityAh;
  const middle = [
    ...Array(100).fill(0),
    ...Array(1_000).fill(capacityA * 0.1),
    ...Array(100).fill(0),
  ];
  const calibrationDatasets = [dataset({ id: 'middle-current', currentA: middle })];
  const validationDatasets = [dataset({
    id: 'middle-current-holdout', purpose: 'validation', currentA: middle.map((value) => value * 0.9),
    voltageOffsetV: 0.002,
  })];
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets, validationDatasets, groups: ['fast-rc'],
  })), /fast-rc.*pulse\/rest windows/);
});

test('excitation gates evaluate the exact versioned preprocessed grid', () => {
  assert.throws(() => planEcmTuning(input({
    groups: ['fast-rc'],
    maxSamplesPerDataset: 8,
    acceptance: acceptance({ minIncludedSamplesPerDataset: 3 }),
  })), /fast-rc.*resolve rc1TauS/);
  const ordinary = planEcmTuning(input({ groups: ['fast-rc'], maxSamplesPerDataset: 5_000 }));
  assert.equal(ordinary.groups.find(({ id }) => id === 'fast-rc').status, 'active');
  assert.equal(ordinary.request.preprocessingPolicyChecksum, ordinary.preprocessingPolicy.checksum);
});

test('excluded pulse history cannot activate scored fast, slow or hysteresis groups', () => {
  const currentA = [
    ...Array(150).fill(0),
    ...Array(900).fill(5),
    ...Array(150).fill(0),
    ...Array(900).fill(-5),
    ...Array(150).fill(0),
  ];
  const segments = [
    { id: 'scored-rest-a', startIndex: 0, endIndexExclusive: 150, mode: 'dynamic', include: true },
    { id: 'excluded-discharge', startIndex: 150, endIndexExclusive: 1_050, mode: 'dynamic', include: false },
    { id: 'scored-rest-b', startIndex: 1_050, endIndexExclusive: 1_200, mode: 'dynamic', include: true },
    { id: 'excluded-charge', startIndex: 1_200, endIndexExclusive: 2_100, mode: 'dynamic', include: false },
    { id: 'scored-rest-c', startIndex: 2_100, endIndexExclusive: 2_250, mode: 'dynamic', include: true },
  ];
  const calibrationDatasets = [dataset({ id: 'excluded-pulses', currentA, segments })];
  const validationDatasets = [dataset({
    id: 'excluded-pulses-holdout', purpose: 'validation', currentA: pulseProtocol(4.5),
    voltageOffsetV: 0.002,
  })];
  for (const group of ['fast-rc', 'slow-rc', 'hysteresis']) {
    assert.throws(() => planEcmTuning(input({
      calibrationDatasets, validationDatasets, groups: [group],
    })), new RegExp(`${group}.*(?:pulse\\/rest|overlap)`));
  }
});

test('matched SoC and temperature families with zero current cannot activate resistance parameters', () => {
  const zeroCurrent = Array(400).fill(0);
  const calibrationDatasets = [
    dataset({ id: 'zero-soc-mid', startSoC: 0.5, ambientC: 25, currentA: zeroCurrent }),
    dataset({ id: 'zero-soc-upper', startSoC: 0.75, ambientC: 25, currentA: zeroCurrent }),
    dataset({ id: 'zero-soc-extreme', startSoC: 0.95, ambientC: 25, currentA: zeroCurrent }),
    dataset({ id: 'zero-temp-cold', startSoC: 0.5, ambientC: 5, currentA: zeroCurrent }),
    dataset({ id: 'zero-temp-hot', startSoC: 0.5, ambientC: 45, currentA: zeroCurrent }),
  ];
  const validationDatasets = [dataset({
    id: 'zero-family-holdout', purpose: 'validation', startSoC: 0.6,
    ambientC: 15, currentA: pulseProtocol(4.5), voltageOffsetV: 0.002,
  })];
  for (const group of ['soc-dependence', 'arrhenius']) {
    assert.throws(() => planEcmTuning(input({
      calibrationDatasets, validationDatasets, groups: [group],
    })), new RegExp(`${group}.*resistance sensitivity.*zero-current`));
  }
});

test('slow RC coverage cannot activate permutation-symmetric branches without ordered separation', () => {
  assert.throws(() => planEcmTuning(input({
    groups: ['slow-rc'], params: { rc1TauS: 100, rc2TauS: 250 },
  })), /before any stage; the initial ratio is 2.5/);
  assert.throws(() => planEcmTuning(input({
    groups: ['ohmic'], params: { rc1TauS: 100, rc2TauS: 250 },
  })), /before any stage; the initial ratio is 2.5/,
  'an unrelated stage cannot claim readiness with an inadmissible unchanged RC model');
  const accepted = planEcmTuning(input({
    groups: ['slow-rc'], params: { rc1TauS: 70, rc2TauS: 210 },
  }));
  const separation = accepted.groups.find(({ id }) => id === 'slow-rc').gates
    .find(({ id }) => id === 'ordered-separated-rc-time-constants');
  assert.equal(separation.status, 'pass');
  assert.equal(separation.metrics.ratio, 3);
});

test('family selection prefers a smaller valid matrix over a larger invalid family', () => {
  const validSoc = [
    dataset({ id: 'valid-soc-mid', startSoC: 0.5 }),
    dataset({ id: 'valid-soc-upper', startSoC: 0.75 }),
    dataset({ id: 'valid-soc-extreme', startSoC: 0.95 }),
  ];
  const invalidSoc = [0.1, 0.3, 0.7, 0.9].map((startSoC, index) => dataset({
    id: `invalid-soc-${index}`, startSoC, currentA: Array(400).fill(0),
  }));
  const socPlan = planEcmTuning(input({
    calibrationDatasets: [...validSoc, ...invalidSoc], groups: ['soc-dependence'],
  }));
  assert.equal(socPlan.groups.find(({ id }) => id === 'soc-dependence')
    .calibrationTrialContentChecksums.length, 3);

  const validTemperature = [5, 25, 45].map((ambientC) => dataset({
    id: `valid-temp-${ambientC}`, ambientC,
  }));
  const invalidTemperature = [0, 10, 30, 50].map((ambientC) => dataset({
    id: `invalid-temp-${ambientC}`, ambientC, currentA: Array(400).fill(0),
  }));
  const temperaturePlan = planEcmTuning(input({
    calibrationDatasets: [...validTemperature, ...invalidTemperature],
    groups: ['arrhenius'],
  }));
  assert.equal(temperaturePlan.groups.find(({ id }) => id === 'arrhenius')
    .calibrationTrialContentChecksums.length, 3);
});

test('an unrelated bad-OCV trial does not block a valid group or enter its stage', () => {
  const valid = dataset({ id: 'valid-fast-family' });
  const payload = structuredClone(dataset({ id: 'irrelevant-bad-ocv', currentA: pulseProtocol(4) }));
  delete payload.format;
  delete payload.schemaVersion;
  delete payload.checksum;
  payload.signals.voltageV[0] += 0.1;
  payload.source.rawSha256 = semanticDigest('irrelevant-bad-ocv-raw');
  payload.source.runId = 'irrelevant-bad-ocv-run';
  const bad = materializeCalibrationDataset(payload);
  const plan = planEcmTuning(input({
    calibrationDatasets: [valid, bad], groups: ['fast-rc'],
  }));
  const group = plan.groups.find(({ id }) => id === 'fast-rc');
  assert.equal(group.status, 'active');
  assert.deepEqual(group.calibrationTrialContentChecksums, [
    plan.trials.calibration.find(({ id }) => id === valid.id).trialContentChecksum,
  ]);
});

test('holdout construction rejects purpose relabels, raw-source reuse and declared source-run reuse', () => {
  const calibrationTrial = dataset({ id: 'leakage-calibration' });
  const relabelled = dataset({
    id: 'leakage-relabelled', purpose: 'validation', rawKey: 'different-raw',
    runId: 'different-run',
  });
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [calibrationTrial], validationDatasets: [relabelled],
  })), /reuses calibration observationChecksum/);

  const reusedRaw = dataset({
    id: 'leakage-raw', purpose: 'validation', currentA: pulseProtocol(4.5),
    voltageOffsetV: 0.002, rawKey: 'leakage-calibration', runId: 'new-run',
  });
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [calibrationTrial], validationDatasets: [reusedRaw],
  })), /reuses calibration rawSha256/);

  const reusedRun = dataset({
    id: 'leakage-run', purpose: 'validation', currentA: pulseProtocol(4.5),
    voltageOffsetV: 0.002, rawKey: 'new-raw', runId: 'leakage-calibration',
  });
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [calibrationTrial], validationDatasets: [reusedRun],
  })), /reuses calibration sourceIdentityChecksum/);
});

test('holdout leakage cannot be hidden by changing only temperature evidence', () => {
  const calibrationTrial = dataset({ id: 'electrical-leakage-calibration' });
  const payload = structuredClone(calibrationTrial);
  delete payload.format;
  delete payload.schemaVersion;
  delete payload.checksum;
  payload.id = 'electrical-leakage-holdout';
  payload.purpose = 'validation';
  payload.source.rawSha256 = semanticDigest('electrical-leakage-other-raw');
  payload.source.runId = 'electrical-leakage-other-run';
  payload.signals.temperatureC = payload.signals.temperatureC.map((value) => value + 1);
  const temperatureChanged = materializeCalibrationDataset(payload);
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [calibrationTrial],
    validationDatasets: [temperatureChanged],
  })), /reuses calibration scoredElectricalObservationChecksum/);
});

test('holdout leakage is checked after deterministic preprocessing as well as on raw evidence', () => {
  const currentA = [0, 0, 5, 5, 0, 0, -5, -5, 0, 0, 5, 5, 0, 0, -5, -5];
  const calibrationTrial = dataset({ id: 'prepared-leak-calibration', currentA, withTemperature: false });
  const payload = structuredClone(calibrationTrial);
  delete payload.format;
  delete payload.schemaVersion;
  delete payload.checksum;
  payload.id = 'prepared-leak-holdout';
  payload.purpose = 'validation';
  payload.source.rawSha256 = semanticDigest('prepared-leak-other-raw');
  payload.source.runId = 'prepared-leak-other-run';
  payload.signals.currentA = payload.signals.currentA.map((value, index) => (
    value + (index % 2 === 0 ? 1 : -1)
  ));
  const samePreparedEvidence = materializeCalibrationDataset(payload);
  assert.notEqual(calibrationTrial.checksum, samePreparedEvidence.checksum);
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [calibrationTrial],
    validationDatasets: [samePreparedEvidence],
    groups: ['ohmic'],
    maxSamplesPerDataset: 8,
    acceptance: acceptance({ minIncludedSamplesPerDataset: 3 }),
  })), /reuses calibration preparedElectricalObservationChecksum/);
});

test('duplicates inside either partition are rejected using purpose-neutral physical identities', () => {
  const first = dataset({ id: 'inside-duplicate-first' });
  const duplicateObservation = dataset({
    id: 'inside-duplicate-second', rawKey: 'other-raw', runId: 'other-run',
  });
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [first, duplicateObservation],
  })), /calibrationDatasets duplicate observationChecksum/);

  const payload = structuredClone(first);
  delete payload.format;
  delete payload.schemaVersion;
  delete payload.checksum;
  payload.id = 'same-condition-unscored-change';
  payload.source.rawSha256 = semanticDigest('same-condition-other-raw');
  payload.source.runId = 'same-condition-other-run';
  payload.signals.temperatureC = payload.signals.temperatureC.map((value) => value + 1);
  const unscoredChange = materializeCalibrationDataset(payload);
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [first, unscoredChange],
  })), /duplicate scoredElectricalObservationChecksum.*same startSoC and ambientC/);
});

test('acceptance is closed, caller supplied before metrics, and requires real whole-trial holdout coverage', () => {
  const valid = input();
  assert.throws(() => planEcmTuning({ ...valid, acceptance: undefined }), /acceptance must be an object/);
  assert.throws(() => planEcmTuning({
    ...valid, acceptance: { ...valid.acceptance, typoLimit: 1 },
  }), /unsupported field.*typoLimit/);
  const missing = { ...valid.acceptance };
  delete missing.maxVoltageRmseMvPerCell;
  assert.throws(() => planEcmTuning({ ...valid, acceptance: missing }), /missing required field.*maxVoltageRmseMvPerCell/);
  assert.throws(() => planEcmTuning({
    ...valid, acceptance: acceptance({ maxTemperatureRmseC: 1 }),
  }), /must both be null or both be finite/);
  assert.throws(() => planEcmTuning({
    ...valid, validationDatasets: [],
  }), /requires at least 1/);
  assert.throws(() => planEcmTuning({
    ...valid, acceptance: acceptance({ minValidationDatasets: 2 }),
  }), /acceptance requires at least 2/);
  assert.throws(() => planEcmTuning({
    ...valid, acceptance: acceptance({ requiredModes: ['pulse'] }),
  }), /do not cover acceptance.requiredModes: pulse/);
  assert.throws(() => planEcmTuning({
    ...valid, acceptance: acceptance({ minIncludedSamplesPerDataset: 10_000 }),
  }), /preprocessed included samples.*acceptance requires at least 10,000 per whole trial/);
  assert.throws(() => planEcmTuning({
    ...valid, groups: ['ohmic'], maxSamplesPerDataset: 100,
  }), /has 98 preprocessed included samples; acceptance requires at least 100/);

  const currentA = [
    ...Array(100).fill(0), ...Array(50).fill(5), ...Array(50).fill(0),
    ...Array(50).fill(-5), ...Array(150).fill(0),
  ];
  const oneSampleMode = dataset({
    id: 'raw-only-pulse-mode', currentA,
    segments: [
      { id: 'before', startIndex: 0, endIndexExclusive: 100, mode: 'dynamic', include: true },
      { id: 'single-pulse-label', startIndex: 100, endIndexExclusive: 101, mode: 'pulse', include: true },
      { id: 'after', startIndex: 101, endIndexExclusive: currentA.length, mode: 'dynamic', include: true },
    ],
  });
  assert.throws(() => planEcmTuning({
    ...valid,
    calibrationDatasets: [oneSampleMode],
    groups: ['ohmic'],
    maxSamplesPerDataset: 8,
    acceptance: acceptance({
      minIncludedSamplesPerDataset: 3,
      requiredModes: ['pulse'],
    }),
  }), /do not cover acceptance.requiredModes: pulse/);
  assert.throws(() => planEcmTuning({
    ...valid, acceptance: acceptance({ requireNoHoldoutRegression: false }),
  }), /requireNoHoldoutRegression must be true/);
  assert.throws(() => planEcmTuning({
    ...valid, acceptance: acceptance({ requireNoFittedParameterAtBound: false }),
  }), /requireNoFittedParameterAtBound must be true/);
});

test('temperature acceptance and Arrhenius observability use explicit compatible validation-channel roles', () => {
  const valid = input();
  assert.throws(() => planEcmTuning({
    ...valid,
    groups: ['ohmic'],
    acceptance: acceptance({ maxTemperatureRmseC: 1, maxTemperatureMaxAbsC: 2 }),
  }), /At least one validation dataset must carry module-maximum temperature/);
  const validationDatasets = [valid.validationDatasets[0], dataset({
    id: 'thermal-holdout', purpose: 'validation', startSoC: 0.8,
    ambientC: 35, currentA: pulseProtocol(4.2), voltageOffsetV: 0.004,
    temperatureLocation: 'module-maximum',
  })];
  assert.doesNotThrow(() => planEcmTuning({
    ...valid,
    validationDatasets,
    groups: ['arrhenius'],
    acceptance: acceptance({ maxTemperatureRmseC: 1, maxTemperatureMaxAbsC: 2 }),
  }));
});

test('every holdout trial must electrically observe the active fitted groups', () => {
  const zeroCurrentHoldout = dataset({
    id: 'zero-current-holdout', purpose: 'validation', currentA: Array(400).fill(0),
    voltageOffsetV: 0.002,
  });
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [dataset({ id: 'observable-ohmic-training' })],
    validationDatasets: [zeroCurrentHoldout],
    groups: ['ohmic'],
  })), /zero-current or weak holdout cannot observe/);
});

test('SoC-dependent resistance requires an off-mid validation basis on the scored grid', () => {
  const tinyProtocol = [
    ...Array(100).fill(0), ...Array(50).fill(4.5), ...Array(50).fill(0),
    ...Array(50).fill(-4.5), ...Array(50).fill(0), ...Array(50).fill(4.5),
    ...Array(50).fill(0),
  ];
  const midOnly = dataset({
    id: 'mid-soc-tiny-time-holdout', purpose: 'validation', startSoC: 0.5,
    currentA: tinyProtocol, samplePeriodS: Number.MIN_VALUE, voltageOffsetV: 0.003,
  });
  assert.throws(() => planEcmTuning(input({
    validationDatasets: [midOnly], groups: ['soc-dependence'],
  })), /mid-SoC holdout cannot observe the active soc-dependence group/);
  assert.doesNotThrow(() => planEcmTuning(input({ groups: ['soc-dependence'] })),
    'the governed extreme-SoC holdout carries nonzero scored sensitivity');
});

test('hysteresis selection and holdout require finite bidirectional state excursion, not current signs alone', () => {
  const tinyProtocol = [
    ...Array(100).fill(0), ...Array(50).fill(4.5), ...Array(50).fill(0),
    ...Array(50).fill(-4.5), ...Array(50).fill(0), ...Array(50).fill(4.5),
    ...Array(50).fill(0),
  ];
  const tiny = (id, purpose, startSoC, voltageOffsetV = 0) => dataset({
    id, purpose, startSoC, currentA: tinyProtocol,
    samplePeriodS: Number.MIN_VALUE, voltageOffsetV,
  });
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [
      tiny('tiny-hysteresis-low-training', 'calibration', 0.3),
      tiny('tiny-hysteresis-high-training', 'calibration', 0.7, 0.001),
    ],
    groups: ['hysteresis'],
  })), /hysteresis.*fixed 600 s hysteresis state/);
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets: [dataset({ id: 'observable-hysteresis-training' })],
    validationDatasets: [
      tiny('tiny-hysteresis-low-holdout', 'validation', 0.3, 0.002),
      tiny('tiny-hysteresis-high-holdout', 'validation', 0.7, 0.003),
    ],
    groups: ['hysteresis'],
  })), /Validation datasets do not drive the fixed 600 s hysteresis state/);
});

test('SoC coverage is co-located with included nonzero-current evidence', () => {
  const scored = [
    ...Array(100).fill(0),
    ...Array(200).fill(5),
    ...Array(100).fill(0),
    ...Array(200).fill(-5),
    ...Array(100).fill(0),
  ];
  const currentA = [0, ...Array(1_000).fill(20), ...scored];
  const segments = [
    { id: 'rested-ocv', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: true },
    { id: 'excluded-depletion', startIndex: 1, endIndexExclusive: 1_001, mode: 'dynamic', include: false },
    { id: 'scored-current', startIndex: 1_001, endIndexExclusive: currentA.length, mode: 'dynamic', include: true },
  ];
  const calibrationDatasets = [0.5, 0.75, 0.95].map((startSoC, index) => dataset({
    id: `clipped-soc-${index}`, startSoC, currentA, segments,
  }));
  assert.throws(() => planEcmTuning(input({
    calibrationDatasets, groups: ['soc-dependence'],
  })), /soc-dependence.*three distinguishable symmetric SoC-basis levels/);
});

test('the maximum canonical sample count plans without spread-argument overflow', () => {
  const currentA = [
    ...Array(50_000).fill(0),
    ...Array(50_000).fill(5),
    ...Array(50_000).fill(0),
    ...Array(50_000).fill(-5),
    ...Array(50_000).fill(0),
  ];
  const calibrationTrial = dataset({
    id: 'maximum-sample-training', currentA, withTemperature: false,
  });
  const plan = planEcmTuning(input({
    calibrationDatasets: [calibrationTrial], groups: ['ohmic'],
  }));
  assert.equal(plan.trials.calibration[0].samples, 250_000);
  assert.equal(plan.trials.calibration[0].preprocessing.usedSamples, 5_000);
});

test('input boundaries reject unknown keys, group typos, duplicates, topology drift and parameter repair', () => {
  const valid = input();
  assert.throws(() => planEcmTuning({ ...valid, fit: ['r0Ref'] }), /unsupported field.*fit/);
  assert.throws(() => planEcmTuning({ ...valid, groups: ['not-a-group'] }), /groups\[0\].*one of/);
  assert.throws(() => planEcmTuning({ ...valid, groups: ['ohmic', 'ohmic'] }), /duplicate group/);
  assert.throws(() => planEcmTuning({ ...valid, params: { r0Ref: -1 } }), /never repairs or clamps/);
  assert.throws(() => planEcmTuning({ ...valid, params: { constructor: 1 } }),
    /Unknown ECM tuning parameter override.*constructor/);
  const wrongTopology = structuredClone(valid.validationDatasets[0]);
  const payload = { ...wrongTopology };
  delete payload.format;
  delete payload.schemaVersion;
  delete payload.checksum;
  payload.binding.seriesCells = 2;
  payload.source.rawSha256 = semanticDigest('wrong-topology-raw');
  payload.source.runId = 'wrong-topology-run';
  const rebound = materializeCalibrationDataset(payload);
  assert.throws(() => planEcmTuning({ ...valid, validationDatasets: [rebound] }),
    /incompatible binding.seriesCells/);

  const incompleteSource = structuredClone(valid.validationDatasets[0]);
  delete incompleteSource.format;
  delete incompleteSource.schemaVersion;
  delete incompleteSource.checksum;
  incompleteSource.source.toolVersion = null;
  incompleteSource.source.rawSha256 = semanticDigest('incomplete-source-raw');
  incompleteSource.source.runId = 'incomplete-source-run';
  const missingSourceTuple = materializeCalibrationDataset(incompleteSource);
  assert.throws(() => planEcmTuning({ ...valid, validationDatasets: [missingSourceTuple] }),
    /source.toolVersion must be a non-null, non-empty string/);
});
