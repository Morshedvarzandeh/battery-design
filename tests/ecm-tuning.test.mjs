import test from 'node:test';
import assert from 'node:assert/strict';

import { materializeCalibrationDataset } from '../js/calibration-dataset.js';
import { cellById } from '../js/cells.js';
import {
  ECM_TUNING_EXECUTION_POLICY,
  ECM_TUNING_RESULT_FORMAT,
  executeEcmTuning,
} from '../js/ecm-tuning-executor.js';
import { planEcmTuning } from '../js/ecm-tuning.js';
import { semanticDigest } from '../js/ontology.js';
import { defaultParams, simulate } from '../js/sim2.js';

const CELL = cellById('samsung-inr21700-50e');

const acceptance = (overrides = {}) => ({
  maxVoltageRmseMvPerCell: 100,
  maxVoltageMaxAbsMvPerCell: 200,
  maxTemperatureRmseC: null,
  maxTemperatureMaxAbsC: null,
  minValidationDatasets: 1,
  minIncludedSamplesPerDataset: 20,
  requiredModes: ['dynamic'],
  requireNoHoldoutRegression: true,
  requireNoFittedParameterAtBound: true,
  ...overrides,
});

function protocol(amplitudeA = 8) {
  return [
    ...Array(10).fill(0),
    ...Array(12).fill(amplitudeA),
    ...Array(10).fill(0),
    ...Array(12).fill(-amplitudeA),
    ...Array(10).fill(0),
    ...Array(12).fill(amplitudeA * 0.7),
    ...Array(10).fill(0),
  ];
}

function governedDataset({
  id,
  purpose,
  currentA,
  truth,
  startSoC = 0.6,
  ambientC = 25,
  moduleCount = 1,
  temperatureLocation = null,
  voltageTransform = (value) => value,
  temperatureTransform = (value) => value,
  segments = null,
  samplePeriodS = 1,
} = {}) {
  const simulated = simulate({
    cell: CELL,
    s: 1,
    p: 1,
    nModules: moduleCount,
    params: truth,
    profile: { dtS: samplePeriodS, i: currentA },
    startSoC,
    ambientC,
  });
  const withTemperature = temperatureLocation !== null;
  return materializeCalibrationDataset({
    id,
    kind: 'synthetic',
    purpose,
    source: {
      tool: 'ECM executor test solver', toolVersion: '1.0.0', model: 'sim2-truth', runId: id,
      generatedAt: null, mediaType: 'application/json',
      rawSha256: semanticDigest(`raw:${id}`),
    },
    binding: {
      cellId: CELL.id, seriesCells: 1, parallelCells: 1,
      startSoC, ambientC, moduleCount,
      initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'canonical-json', adapterVersion: '1.0.0',
      mappingChecksum: semanticDigest(`mapping:${id}`),
      sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: withTemperature ? 'degC' : null },
      sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal', sourceTemperatureLocation: temperatureLocation,
      sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: samplePeriodS,
      sourceResetTimeS: 0, timeHandling: 'validated-uniform',
      originalSampleCount: currentA.length,
    },
    samplePeriodS,
    signals: {
      currentA,
      voltageV: simulated.series.v.map(voltageTransform),
      temperatureC: withTemperature ? simulated.series.tMax.map(temperatureTransform) : null,
    },
    segments: segments ?? [{
      id: 'complete', startIndex: 0, endIndexExclusive: currentA.length,
      mode: 'dynamic', include: true,
    }],
    conventions: {
      timeBasis: 'uniform-sample-period', timeOrigin: 'trial-reset',
      firstSampleOffsetS: samplePeriodS, sampleAlignment: 'end-of-step', currentHold: 'zero-order-hold',
      currentPositive: 'discharge', currentScope: 'pack', voltageLocation: 'pack-terminal',
      temperatureLocation,
    },
  });
}

function fixture({
  initialR0 = defaultParams(CELL).r0Ref,
  truthR0 = defaultParams(CELL).r0Ref * 1.35,
  validationVoltageTransform,
  validationTemperature = false,
  validationSegments = null,
  moduleCount = 1,
  maxEvaluations = 24,
  maxIntegrationSteps = 20_000,
  maxModuleWeightedIntegrationSteps = 20_000,
  acceptanceOverrides = {},
} = {}) {
  const initial = { ...defaultParams(CELL), r0Ref: initialR0 };
  const truth = { ...initial, r0Ref: truthR0 };
  const calibrationDatasets = [governedDataset({
    id: 'executor-calibration', purpose: 'calibration', currentA: protocol(8), truth,
    moduleCount,
  })];
  const validationDatasets = [governedDataset({
    id: 'executor-validation', purpose: 'validation', currentA: protocol(7.3), truth,
    startSoC: 0.65, moduleCount,
    temperatureLocation: validationTemperature ? 'module-maximum' : null,
    voltageTransform: validationVoltageTransform,
    segments: validationSegments,
  })];
  const plan = planEcmTuning({
    cell: CELL,
    calibrationDatasets,
    validationDatasets,
    params: initial,
    groups: ['ohmic'],
    maxEvaluations,
    maxIntegrationSteps,
    maxModuleWeightedIntegrationSteps,
    maxSamplesPerDataset: 5_000,
    acceptance: acceptance({
      ...(validationTemperature
        ? { maxTemperatureRmseC: 5, maxTemperatureMaxAbsC: 10 }
        : {}),
      ...acceptanceOverrides,
    }),
  });
  return { plan, cell: CELL, calibrationDatasets, validationDatasets };
}

function relaxationProtocol(amplitudeA = 8) {
  return [
    ...Array(650).fill(0),
    ...Array(900).fill(amplitudeA),
    ...Array(650).fill(0),
    ...Array(900).fill(-amplitudeA),
    ...Array(650).fill(0),
  ];
}

function rcFixture({
  groups = ['fast-rc', 'slow-rc'],
  initialOverrides = {},
  truthOverrides = {},
  samplePeriodS = 1,
} = {}) {
  const initial = { ...defaultParams(CELL), ...initialOverrides };
  const truth = {
    ...initial,
    rc1R: defaultParams(CELL).rc1R * 1.25,
    rc1TauS: 12,
    rc2R: defaultParams(CELL).rc2R * 1.3,
    rc2TauS: 260,
    ...truthOverrides,
  };
  const calibrationDatasets = [governedDataset({
    id: 'executor-rc-calibration', purpose: 'calibration',
    currentA: relaxationProtocol(8), truth, startSoC: 0.62, samplePeriodS,
  })];
  const validationDatasets = [governedDataset({
    id: 'executor-rc-validation', purpose: 'validation',
    currentA: relaxationProtocol(7.1), truth, startSoC: 0.68, samplePeriodS,
  })];
  const plan = planEcmTuning({
    cell: CELL,
    calibrationDatasets,
    validationDatasets,
    params: initial,
    groups,
    maxEvaluations: groups.length > 1 ? 70 : 30,
    maxIntegrationSteps: 2_000_000,
    maxModuleWeightedIntegrationSteps: 2_000_000,
    maxSamplesPerDataset: 5_000,
    acceptance: acceptance({ minIncludedSamplesPerDataset: 100 }),
  });
  return { plan, cell: CELL, calibrationDatasets, validationDatasets };
}

function execute(options = {}) {
  const prepared = fixture(options);
  return executeEcmTuning(prepared);
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('a one-group plan executes calibration-only stages and scores a fixed full-rate holdout', () => {
  const result = execute();
  assert.equal(result.format, ECM_TUNING_RESULT_FORMAT);
  assert.equal(result.readiness.optimizerExecution, 'completed');
  assert.equal(result.metrics.before.validation.sampleGrid, 'original-full-rate');
  assert.equal(result.metrics.after.validation.sampleGrid, 'original-full-rate');
  assert.equal(result.stages.length, 2);
  assert.ok(result.stages.every(({ status }) => status === 'completed'));
  assert.ok(result.candidateParams.r0Ref > result.initialParams.r0Ref);
  assert.equal(result.callerPolicyVerdict.accepted, true);
});

test('execution policy is versioned, content-addressed and declares conservative sensitivity thresholds', () => {
  const body = { ...ECM_TUNING_EXECUTION_POLICY };
  delete body.checksum;
  assert.equal(ECM_TUNING_EXECUTION_POLICY.checksum, semanticDigest(body));
  assert.equal(ECM_TUNING_EXECUTION_POLICY.sensitivity.normalizedParameterStep, 1e-3);
  assert.equal(ECM_TUNING_EXECUTION_POLICY.sensitivity.minimumUsableNormalizedParameterStep, 1e-8);
  assert.equal(ECM_TUNING_EXECUTION_POLICY.sensitivity.minimumColumnRmsMvPerCell, 0.01);
  assert.equal(ECM_TUNING_EXECUTION_POLICY.sensitivity.relativePivotRankTolerance, 1e-3);
  assert.equal(ECM_TUNING_EXECUTION_POLICY.sensitivity.maximumAbsoluteColumnCorrelation, 0.995);
});

test('result and nested stage, score, metrics and verdict artifacts have reproducible checksums', () => {
  const result = execute();
  const body = { ...result }; delete body.checksum;
  assert.equal(result.checksum, semanticDigest(body));
  for (const stage of result.stages) {
    const stageBody = { ...stage }; delete stageBody.checksum;
    assert.equal(stage.checksum, semanticDigest(stageBody));
  }
  for (const phase of [result.metrics.before, result.metrics.after]) {
    const phaseBody = { ...phase }; delete phaseBody.checksum;
    assert.equal(phase.checksum, semanticDigest(phaseBody));
    for (const score of [phase.calibration, phase.validation]) {
      const scoreBody = { ...score }; delete scoreBody.checksum;
      assert.equal(score.checksum, semanticDigest(scoreBody));
    }
  }
  const metricsBody = { ...result.metrics }; delete metricsBody.checksum;
  assert.equal(result.metrics.checksum, semanticDigest(metricsBody));
  const verdictBody = { ...result.callerPolicyVerdict }; delete verdictBody.checksum;
  assert.equal(result.callerPolicyVerdict.checksum, semanticDigest(verdictBody));
});

test('result is deeply frozen and contains no raw signal or residual arrays', () => {
  const result = execute();
  assertDeepFrozen(result);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /"(?:signals|currentA|voltageV|temperatureC|residuals|predictions)"\s*:/);
});

test('a tampered plan checksum is rejected before execution', () => {
  const input = fixture();
  assert.throws(() => executeEcmTuning({
    ...input,
    plan: { ...input.plan, cell: 'substituted-cell' },
  }), /plan\.checksum does not match/);
});

test('a valid but different canonical trial cannot be substituted for the planned evidence', () => {
  const input = fixture();
  const substituted = governedDataset({
    id: 'substituted-calibration', purpose: 'calibration', currentA: protocol(8.2),
    truth: { ...defaultParams(CELL), r0Ref: defaultParams(CELL).r0Ref * 1.35 },
  });
  assert.throws(() => executeEcmTuning({
    ...input, calibrationDatasets: [substituted],
  }), /do not reproduce plan\.checksum/);
});

test('a self-consistently rechecksummed forged executable plan is rejected by replay reconstruction', () => {
  const input = fixture();
  const forged = JSON.parse(JSON.stringify(input.plan));
  forged.stages[0].evaluationBudget += 1;
  delete forged.checksum;
  forged.checksum = semanticDigest(forged);
  assert.throws(() => executeEcmTuning({ ...input, plan: forged }),
    /do not reproduce plan\.checksum/);
});

test('unsupported execution input fields fail closed', () => {
  const input = fixture();
  assert.throws(() => executeEcmTuning({ ...input, maxIterations: 1 }), /unsupported field/);
});

test('preflight rejects insufficient temporal and module work before a simulation can start', () => {
  const input = fixture({ maxEvaluations: 8, maxIntegrationSteps: 2, maxModuleWeightedIntegrationSteps: 2 });
  assert.throws(() => executeEcmTuning(input), /preflight failed before simulation/);
});

test('cumulative counters never reset between sensitivity, stages and fixed scoring passes', () => {
  const result = execute();
  assert.equal(result.work.countersResetBetweenStages, false);
  assert.equal(result.work.candidateEvaluations,
    result.work.sensitivityProbeEvaluations + result.work.optimizerProposalEvaluations);
  assert.ok(result.work.temporalIntegrationSteps > 0);
  assert.ok(result.work.moduleWeightedIntegrationSteps > 0);
  assert.ok(result.work.temporalIntegrationSteps <= result.work.limits.temporalIntegrationSteps);
  assert.ok(result.work.moduleWeightedIntegrationSteps
    <= result.work.limits.moduleWeightedIntegrationSteps);
});

test('every sensitivity and simulated optimizer candidate retains ordered RC time constants', () => {
  const result = execute();
  assert.equal(result.candidateConstraintEvidence.everySimulatedCandidateEnforced, true);
  assert.ok(result.candidateConstraintEvidence.finalRcTimeConstantRatio >= 3);
  assert.ok(result.stages.every(({ status, optimizer }) => status !== 'completed'
    || optimizer.finalRcTimeConstantRatio >= 3));
});

test('caller-predeclared acceptance owns the verdict and adopted parameters', () => {
  const result = execute();
  assert.equal(result.callerPolicyVerdict.authority, 'caller-predeclared-plan-acceptance');
  assert.equal(result.callerPolicyVerdict.acceptanceChecksum, result.stages.length
    ? fixture().plan.acceptanceChecksum : null);
  if (result.callerPolicyVerdict.accepted) {
    assert.deepEqual(result.adoptedParams, result.candidateParams);
  } else {
    assert.deepEqual(result.adoptedParams, result.initialParams);
  }
});

test('rejected candidates never replace the initial adopted parameter set', () => {
  const result = execute({ acceptanceOverrides: { maxVoltageRmseMvPerCell: 0.000001 } });
  assert.equal(result.callerPolicyVerdict.accepted, false);
  assert.deepEqual(result.adoptedParams, result.initialParams);
  assert.equal(result.adoptedParamsChecksum, result.initialParamsChecksum);
});

test('full-rate validation exposes scalar per-trial and included-segment evidence', () => {
  const current = protocol(7.3);
  const segments = [
    { id: 'first', startIndex: 0, endIndexExclusive: 32, mode: 'dynamic', include: true },
    { id: 'excluded', startIndex: 32, endIndexExclusive: 44, mode: 'rest', include: false },
    { id: 'last', startIndex: 44, endIndexExclusive: current.length, mode: 'dynamic', include: true },
  ];
  const result = execute({ validationSegments: segments });
  const trial = result.metrics.after.validation.perTrial[0];
  assert.deepEqual(trial.segments.map(({ segmentId }) => segmentId), ['first', 'last']);
  assert.equal(trial.voltage.sampleCount, 64);
  assert.equal(trial.segments.reduce((sum, segment) => sum + segment.sampleCount, 0), 64);
});

test('module-maximum temperature metrics are optional and absent for cell-average or missing channels', () => {
  const result = execute();
  assert.equal(result.metrics.after.validation.pooled.temperature, null);
  assert.equal(result.metrics.after.validation.perTrial[0].temperature, null);
});

test('declared module-maximum temperature is scored per trial, segment and pool', () => {
  const result = execute({ validationTemperature: true });
  const trial = result.metrics.after.validation.perTrial[0];
  assert.ok(result.metrics.after.validation.pooled.temperature.sampleCount > 0);
  assert.ok(trial.temperature.sampleCount > 0);
  assert.ok(trial.segments[0].temperature.sampleCount > 0);
});

test('sensitivity evidence records deterministic pivot order, full rank and physical units', () => {
  const result = execute();
  for (const stage of result.stages) {
    assert.equal(stage.sensitivity.status, 'pass');
    assert.deepEqual(stage.sensitivity.pivotOrder, ['r0Ref']);
    assert.equal(stage.sensitivity.numericalRank, 1);
    assert.equal(stage.sensitivity.columns[0].parameter, 'r0Ref');
    assert.ok(stage.sensitivity.columns[0].rmsMvPerCell >= 0.01);
  }
});

test('stage evidence counts proposals separately from unique simulations and cache hits', () => {
  const result = execute();
  for (const stage of result.stages) {
    assert.ok(stage.optimizer.proposalEvaluations >= stage.optimizer.uniqueEvaluations);
    assert.equal(stage.optimizer.proposalEvaluations,
      stage.optimizer.uniqueEvaluations + stage.optimizer.cacheHitProposals);
    assert.equal(stage.optimizer.simulatedEvaluations,
      stage.optimizer.uniqueEvaluations - stage.optimizer.rejectedConstraintProposals);
  }
});

test('validation dataset order is canonical and does not alter result identity', () => {
  const initial = defaultParams(CELL);
  const truth = { ...initial, r0Ref: initial.r0Ref * 1.35 };
  const calibrationDatasets = [
    governedDataset({
      id: 'order-calibration-a', purpose: 'calibration', currentA: protocol(8), truth,
      startSoC: 0.55,
    }),
    governedDataset({
      id: 'order-calibration-b', purpose: 'calibration', currentA: protocol(6.7), truth,
      startSoC: 0.72,
    }),
  ];
  const validationDatasets = [
    governedDataset({
      id: 'order-validation-a', purpose: 'validation', currentA: protocol(7.3), truth,
      startSoC: 0.6,
    }),
    governedDataset({
      id: 'order-validation-b', purpose: 'validation', currentA: protocol(5.9), truth,
      startSoC: 0.76,
    }),
  ];
  const plan = planEcmTuning({
    cell: CELL, calibrationDatasets, validationDatasets, params: initial, groups: ['ohmic'],
    maxEvaluations: 24, maxIntegrationSteps: 50_000,
    maxModuleWeightedIntegrationSteps: 50_000, maxSamplesPerDataset: 5_000,
    acceptance: acceptance(),
  });
  const input = { plan, cell: CELL, calibrationDatasets, validationDatasets };
  const first = executeEcmTuning(input);
  const second = executeEcmTuning({
    ...input,
    calibrationDatasets: [...input.calibrationDatasets].reverse(),
    validationDatasets: [...input.validationDatasets].reverse(),
  });
  assert.equal(first.request.calibrationTrialContentChecksums.length, 2);
  assert.equal(first.request.validationTrialContentChecksums.length, 2);
  assert.deepEqual(second, first);
});

test('before and after validation sample counts remain exactly full-rate and fixed', () => {
  const input = fixture();
  const result = executeEcmTuning(input);
  const expected = input.validationDatasets[0].signals.currentA.length;
  assert.equal(result.metrics.before.validation.pooled.voltage.sampleCount, expected);
  assert.equal(result.metrics.after.validation.pooled.voltage.sampleCount, expected);
  assert.equal(result.metrics.before.validation.perTrial[0].trialContentChecksum,
    result.metrics.after.validation.perTrial[0].trialContentChecksum);
});

test('full-rate holdout scoring keeps every raw included sample when planning preprocessing downsamples it', () => {
  const initial = defaultParams(CELL);
  const truth = { ...initial, r0Ref: initial.r0Ref * 1.35 };
  const longCurrent = [];
  for (let repeat = 0; repeat < 100; repeat++) longCurrent.push(...protocol(7.3));
  const calibrationDatasets = [governedDataset({
    id: 'downsample-calibration', purpose: 'calibration', currentA: protocol(8), truth,
  })];
  const validationDatasets = [governedDataset({
    id: 'downsample-validation', purpose: 'validation', currentA: longCurrent, truth,
    startSoC: 0.65,
  })];
  const plan = planEcmTuning({
    cell: CELL, calibrationDatasets, validationDatasets, params: initial, groups: ['ohmic'],
    maxEvaluations: 24, maxIntegrationSteps: 100_000,
    maxModuleWeightedIntegrationSteps: 100_000, maxSamplesPerDataset: 5_000,
    acceptance: acceptance(),
  });
  assert.ok(plan.trials.validation[0].preprocessing.factor > 1);
  assert.ok(plan.trials.validation[0].preprocessing.usedSamples < longCurrent.length);
  const result = executeEcmTuning({ plan, cell: CELL, calibrationDatasets, validationDatasets });
  assert.equal(result.metrics.before.validation.pooled.voltage.sampleCount, longCurrent.length);
  assert.equal(result.metrics.after.validation.pooled.voltage.sampleCount, longCurrent.length);
  assert.equal(result.metrics.after.validation.perTrial[0].segments[0].sampleCount,
    longCurrent.length);
});

test('validation never appears in any optimizer stage trial checksum list', () => {
  const input = fixture();
  const result = executeEcmTuning(input);
  const holdout = result.request.validationTrialContentChecksums[0];
  assert.ok(result.stages.every((stage) => !stage.calibrationTrialContentChecksums.includes(holdout)));
  assert.match(result.readiness.validationRole, /never-an-optimizer-input/);
});

test('per-trial and per-segment voltage limits are explicit caller-policy checks', () => {
  const result = execute();
  const ids = new Set(result.callerPolicyVerdict.checks.map(({ id }) => id));
  assert.ok(ids.has('validation-every-trial-voltage-rmse-limit'));
  assert.ok(ids.has('validation-every-trial-voltage-maximum-limit'));
  assert.ok(ids.has('validation-every-segment-voltage-rmse-limit'));
  assert.ok(ids.has('validation-every-segment-voltage-maximum-limit'));
  assert.ok(ids.has('validation-no-trial-voltage-regression'));
  assert.ok(ids.has('validation-no-segment-voltage-regression'));
});

test('execution request binds the plan, policy, cell and both fixed partitions', () => {
  const result = execute();
  assert.equal(result.request.planChecksum, result.planChecksum);
  assert.equal(result.request.executionPolicyChecksum, ECM_TUNING_EXECUTION_POLICY.checksum);
  assert.equal(result.request.cellChecksum, result.cellChecksum);
  assert.equal(result.request.calibrationTrialContentChecksums.length, 1);
  assert.equal(result.request.validationTrialContentChecksums.length, 1);
  assert.equal(result.requestChecksum, semanticDigest(result.request));
});

test('preflight reserves two prepared calibration and two original-rate validation passes', () => {
  const result = execute();
  assert.equal(result.workPreflight.performedBeforeFirstSimulation, true);
  assert.equal(result.workPreflight.fixedScoringWork.calibrationPasses, 2);
  assert.equal(result.workPreflight.fixedScoringWork.validationPasses, 2);
  assert.ok(result.workPreflight.projectedCeilings.temporalIntegrationSteps
    <= result.workPreflight.limits.temporalIntegrationSteps);
});

test('the final verdict checks strict calibration improvement, holdout regression and bound safety', () => {
  const result = execute();
  const ids = new Set(result.callerPolicyVerdict.checks.map(({ id }) => id));
  assert.ok(ids.has('calibration-objective-strictly-improved'));
  assert.ok(ids.has('validation-no-voltage-regression'));
  assert.ok(ids.has('no-fitted-parameter-at-bound'));
  assert.ok(ids.has('ordered-rc-final-candidate'));
});

test('a short bad validation segment cannot hide inside a passing pooled and whole-trial RMSE', () => {
  const current = protocol(7.3);
  const result = execute({
    validationVoltageTransform: (value, index) => index === current.length - 1 ? value + 0.1 : value,
    validationSegments: [
      { id: 'long-good', startIndex: 0, endIndexExclusive: current.length - 1, mode: 'dynamic', include: true },
      { id: 'short-bad', startIndex: current.length - 1, endIndexExclusive: current.length, mode: 'dynamic', include: true },
    ],
    acceptanceOverrides: {
      maxVoltageRmseMvPerCell: 20,
      maxVoltageMaxAbsMvPerCell: 200,
    },
  });
  const validation = result.metrics.after.validation;
  assert.ok(validation.pooled.voltage.rmse < 20);
  assert.ok(validation.perTrial[0].voltage.rmse < 20);
  assert.ok(validation.perTrial[0].segments.find(({ segmentId }) => segmentId === 'short-bad')
    .voltage.rmse > 20);
  assert.equal(result.callerPolicyVerdict.checks.find(({ id }) => (
    id === 'validation-every-segment-voltage-rmse-limit'
  )).status, 'fail');
  assert.equal(result.callerPolicyVerdict.accepted, false);
});

test('changed holdout observations alter evidence identity but never optimizer parameters', () => {
  const ordinary = fixture();
  const shifted = fixture({
    validationVoltageTransform: (value, index) => index === 0 ? value : value + 0.04,
  });
  const ordinaryResult = executeEcmTuning(ordinary);
  const shiftedResult = executeEcmTuning(shifted);
  assert.deepEqual(shiftedResult.candidateParams, ordinaryResult.candidateParams);
  assert.notEqual(shiftedResult.planChecksum, ordinaryResult.planChecksum);
  assert.notEqual(shiftedResult.metrics.checksum, ordinaryResult.metrics.checksum);
  assert.ok(ordinaryResult.stages.every((stage, index) => (
    stage.paramsAfterChecksum === shiftedResult.stages[index].paramsAfterChecksum
  )));
});

test('executed temporal and module-weighted totals equal fixed scoring, sensitivity and optimizer work', () => {
  const result = execute();
  let temporal = result.workPreflight.fixedScoringWork.temporalIntegrationSteps;
  let moduleWeighted = result.workPreflight.fixedScoringWork.moduleWeightedIntegrationSteps;
  for (let index = 0; index < result.stages.length; index++) {
    const stage = result.stages[index];
    const planned = result.workPreflight.stages[index];
    temporal += planned.sensitivityProbeEvaluations * planned.workPerCandidate;
    moduleWeighted += planned.sensitivityProbeEvaluations
      * planned.moduleWeightedWorkPerCandidate;
    if (stage.status === 'completed') {
      temporal += stage.optimizer.temporalIntegrationSteps;
      moduleWeighted += stage.optimizer.moduleWeightedIntegrationSteps;
    }
  }
  assert.equal(result.work.temporalIntegrationSteps, temporal);
  assert.equal(result.work.moduleWeightedIntegrationSteps, moduleWeighted);
  assert.ok(Number.isSafeInteger(result.work.temporalIntegrationSteps));
  assert.ok(Number.isSafeInteger(result.work.moduleWeightedIntegrationSteps));
});

test('fast, slow and four-parameter joint stages execute end to end with pivoted sensitivity evidence', () => {
  const result = executeEcmTuning(rcFixture());
  assert.deepEqual(result.stages.map(({ id }) => id), ['fast-rc', 'slow-rc', 'joint-refinement']);
  assert.ok(result.stages.every(({ status }) => status === 'completed'));
  assert.deepEqual(result.stages.map(({ sensitivity }) => sensitivity.parameterCount), [2, 2, 4]);
  assert.deepEqual(result.stages.map(({ sensitivity }) => sensitivity.numericalRank), [2, 2, 4]);
  const joint = result.stages.at(-1);
  assert.equal(joint.sensitivity.maximumAbsoluteColumnCorrelation <= 0.995, true);
  assert.equal(joint.optimizer.candidatePolicy, 'ordered-rc-v1');
  assert.ok(joint.optimizer.finalRcTimeConstantRatio >= 3);
  assert.ok(Number.isFinite(joint.optimizer.minimumProposedRcTimeConstantRatio));
});

test('a structurally covered but numerically insensitive fast-RC stage fails closed without optimizer adoption', () => {
  const input = rcFixture({
    groups: ['fast-rc'],
    initialOverrides: { rc1R: 0 },
  });
  const result = executeEcmTuning(input);
  assert.equal(result.stages[0].status, 'blocked-sensitivity');
  assert.equal(result.stages[0].sensitivity.status, 'fail');
  assert.ok(result.stages[0].sensitivity.minimumColumnRmsMvPerCell < 0.01);
  assert.equal(result.stages[0].sensitivity.parameterCount, 2);
  assert.equal(result.stages[0].sensitivity.maximumAbsoluteColumnCorrelation, 1);
  assert.ok(result.stages[0].sensitivity.numericalRank < 2);
  assert.equal(result.stages[0].optimizer, null);
  assert.equal(result.stages[1].status, 'not-run-after-sensitivity-failure');
  assert.equal(result.work.optimizerProposalEvaluations, 0);
  assert.equal(result.readiness.optimizerExecution, 'blocked-by-sensitivity');
  assert.equal(result.callerPolicyVerdict.accepted, false);
  assert.deepEqual(result.adoptedParams, result.initialParams);
  assert.equal(result.metrics.before.validation.pooled.voltage.sampleCount,
    result.metrics.after.validation.pooled.voltage.sampleCount);
});

test('a one-ULP upper-bound sliver never replaces the full nominal inward sensitivity probe', () => {
  const result = execute({
    initialR0: 500 - 2 ** -44,
    truthR0: 300,
    acceptanceOverrides: {
      maxVoltageRmseMvPerCell: 1_000,
      maxVoltageMaxAbsMvPerCell: 2_000,
    },
  });
  const column = result.stages[0].sensitivity.columns[0];
  assert.equal(column.parameter, 'r0Ref');
  assert.equal(column.direction, 'decrease');
  assert.equal(column.probeStatus, 'evaluated');
  assert.ok(Math.abs(column.normalizedDelta + 1e-3) < 1e-15);
  assert.ok(Math.abs(column.absoluteParameterDelta) > 0.49);
  assert.equal(result.stages[0].sensitivity.status, 'pass');
});

test('a coupled lower-bound RC corner uses a governed shrunken probe and constrained simplex', () => {
  const result = executeEcmTuning(rcFixture({
    groups: ['fast-rc'],
    initialOverrides: { rc1TauS: 0.1, rc2TauS: 1 },
    truthOverrides: { rc1TauS: 0.2, rc2TauS: 1 },
    samplePeriodS: 0.01,
  }));
  const fast = result.stages[0];
  const tau = fast.sensitivity.columns.find(({ parameter }) => parameter === 'rc1TauS');
  assert.equal(tau.direction, 'increase');
  assert.equal(tau.probeStatus, 'evaluated');
  assert.ok(tau.normalizedDelta >= 1e-8);
  assert.ok(tau.normalizedDelta < 1e-3);
  assert.equal(fast.sensitivity.status, 'pass');
  assert.equal(fast.status, 'completed');
  assert.ok(fast.optimizer.finalRcTimeConstantRatio >= 3);
});
