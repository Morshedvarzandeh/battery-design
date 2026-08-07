// ecm-tuning-executor.js — bounded execution of a governed ECM tuning plan.
//
// The planner owns experiment selection and budget allocation.  This module
// re-materializes that plan from the supplied canonical trials, preflights all
// simulator work before the first simulation, checks numerical sensitivity,
// runs only the selected calibration stages, and scores the fixed validation
// trials at their original sample rate.  Validation observations never enter
// a candidate objective.

import {
  calibrationDatasetIdentities,
  preprocessCalibrationDataset,
  readCalibrationDataset,
} from './calibration-dataset.js';
import { planEcmTuning } from './ecm-tuning.js';
import { semanticDigest } from './ontology.js';
import {
  boundAwareAdmissibleAxisStep,
  CALIBRATION_MINIMUM_NORMALIZED_AXIS_STEP,
  calibrateDatasetsConstrained,
  ECM_RC_MINIMUM_TIME_CONSTANT_RATIO,
  estimateSim2Work,
  ORDERED_RC_CANDIDATE_POLICY,
  PARAM_BY_ID,
  PARAM_SPEC,
  simulate,
} from './sim2.js';

export const ECM_TUNING_RESULT_FORMAT = 'battery-design/ecm-tuning-result@1';

const executionPolicyBody = {
  id: 'battery-design/ecm-tuning-execution',
  version: '1.0.0',
  optimizer: 'sim2-constrained-nelder-mead',
  candidatePolicy: ORDERED_RC_CANDIDATE_POLICY,
  calibrationGrid: 'versioned-deterministic-preprocessing',
  validationGrid: 'original-full-rate-included-segments',
  sensitivity: {
    method: 'forward-or-backward-finite-difference-prediction-jacobian-with-deterministic-pivoted-mgs',
    normalizedParameterStep: 1e-3,
    minimumUsableNormalizedParameterStep: CALIBRATION_MINIMUM_NORMALIZED_AXIS_STEP,
    minimumColumnRmsMvPerCell: 0.01,
    relativePivotRankTolerance: 1e-3,
    maximumAbsoluteColumnCorrelation: 0.995,
  },
  numericalAcceptanceTolerance: 1e-9,
  workAccounting: 'exact-simulator-temporal-and-module-weighted-steps-with-preflight-before-first-simulation',
  adoption: 'caller-predeclared-plan-acceptance-only',
  traceRetention: 'checksums-and-scalar-diagnostics-only',
};

const deepFreeze = (value, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const withChecksum = (value) => ({ ...value, checksum: semanticDigest(value) });

export const ECM_TUNING_EXECUTION_POLICY = deepFreeze({
  ...executionPolicyBody,
  checksum: semanticDigest(executionPolicyBody),
});

const INPUT_KEYS = new Set(['plan', 'cell', 'calibrationDatasets', 'validationDatasets']);
const SIM2_PER_RUN_WORK_LIMIT = 100_000_000;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function safeAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} exceeds the safe integer range.`);
  return value;
}

function safeMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} exceeds the safe integer range.`);
  return value;
}

function asList(value, label) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) throw new RangeError(`${label} must not be empty.`);
  return values.map((dataset) => readCalibrationDataset(dataset));
}

function includedRawIndices(dataset) {
  const indices = [];
  for (const segment of dataset.segments) {
    if (!segment.include) continue;
    for (let index = segment.startIndex; index < segment.endIndexExclusive; index++) indices.push(index);
  }
  return indices;
}

function assertPlanChecksum(plan) {
  if (plan.format !== 'battery-design/ecm-tuning-plan@1') {
    throw new TypeError('plan must be a battery-design/ecm-tuning-plan@1 artifact.');
  }
  const body = { ...plan };
  delete body.checksum;
  if (semanticDigest(body) !== plan.checksum) {
    throw new TypeError('plan.checksum does not match the supplied plan content.');
  }
}

function rebuildPlan(plan, cell, calibrationDatasets, validationDatasets) {
  const rebuilt = planEcmTuning({
    cell,
    calibrationDatasets,
    validationDatasets,
    params: plan.initialParams,
    groups: plan.request.requestedGroups,
    maxEvaluations: plan.request.maxEvaluations,
    maxIntegrationSteps: plan.request.maxIntegrationSteps,
    maxModuleWeightedIntegrationSteps: plan.request.maxModuleWeightedIntegrationSteps,
    maxSamplesPerDataset: plan.request.maxSamplesPerDataset,
    acceptance: plan.acceptance,
  });
  if (rebuilt.checksum !== plan.checksum) {
    throw new TypeError('The supplied cell or canonical trials do not reproduce plan.checksum; execution refuses a stale or substituted plan.');
  }
  return rebuilt;
}

function trialContentChecksum(dataset) {
  return calibrationDatasetIdentities(dataset).trialContentChecksum;
}

function workFor(cell, dataset, params, measured) {
  const work = estimateSim2Work({
    cell,
    s: dataset.binding.seriesCells,
    p: dataset.binding.parallelCells,
    nModules: dataset.binding.moduleCount,
    params,
    profile: { dtS: measured.dtS, i: measured.i },
  });
  if (work.integrationStepCount > SIM2_PER_RUN_WORK_LIMIT
    || work.thermalNodeUpdateCount > SIM2_PER_RUN_WORK_LIMIT) {
    throw new RangeError(`Dataset "${dataset.id}" exceeds the simulator's per-run work limit before execution.`);
  }
  return work;
}

function prepareTrials(cell, datasets, params, maxSamplesPerDataset) {
  return datasets.map((dataset) => {
    const prepared = preprocessCalibrationDataset(dataset, maxSamplesPerDataset);
    const rawMeasured = { dtS: dataset.samplePeriodS, i: dataset.signals.currentA };
    return {
      dataset,
      trialContentChecksum: trialContentChecksum(dataset),
      prepared,
      rawIndices: includedRawIndices(dataset),
      preparedWork: workFor(cell, dataset, params, prepared.measured),
      rawWork: workFor(cell, dataset, params, rawMeasured),
    };
  }).sort((left, right) => left.trialContentChecksum.localeCompare(right.trialContentChecksum)
    || left.dataset.checksum.localeCompare(right.dataset.checksum));
}

function sumTrialWork(trials, field) {
  let temporal = 0;
  let moduleWeighted = 0;
  for (const trial of trials) {
    temporal = safeAdd(temporal, trial[field].integrationStepCount, 'ECM tuning temporal work');
    moduleWeighted = safeAdd(moduleWeighted, trial[field].thermalNodeUpdateCount,
      'ECM tuning module-weighted work');
  }
  return { temporal, moduleWeighted };
}

function stageTrials(plan, preparedCalibration) {
  const byChecksum = new Map(preparedCalibration.map((trial) => [trial.trialContentChecksum, trial]));
  return plan.stages.map((stage) => {
    const trials = stage.calibrationTrialContentChecksums.map((checksum) => {
      const trial = byChecksum.get(checksum);
      if (!trial) throw new TypeError(`Stage "${stage.id}" references unavailable calibration trial ${checksum}.`);
      return trial;
    });
    const work = sumTrialWork(trials, 'preparedWork');
    const sensitivityProbeEvaluations = stage.sensitivityProbeEvaluations ?? stage.fit.length + 1;
    const minimumEvaluationReservation = stage.minimumEvaluationReservation
      ?? sensitivityProbeEvaluations + stage.initialSimplexEvaluations;
    if (sensitivityProbeEvaluations !== stage.fit.length + 1
      || stage.initialSimplexEvaluations !== stage.fit.length + 1
      || minimumEvaluationReservation !== sensitivityProbeEvaluations + stage.initialSimplexEvaluations) {
      throw new TypeError(`Stage "${stage.id}" has an incompatible sensitivity/simplex reservation.`);
    }
    return {
      stage,
      trials,
      work,
      sensitivityProbeEvaluations,
      minimumEvaluationReservation,
    };
  });
}

function preflight(plan, calibration, validation, stages) {
  const calibrationMetricWork = sumTrialWork(calibration, 'preparedWork');
  const validationMetricWork = sumTrialWork(validation, 'rawWork');
  const overhead = {
    temporal: safeAdd(
      safeMultiply(2, calibrationMetricWork.temporal, 'calibration metric temporal work'),
      safeMultiply(2, validationMetricWork.temporal, 'validation metric temporal work'),
      'fixed scoring temporal work',
    ),
    moduleWeighted: safeAdd(
      safeMultiply(2, calibrationMetricWork.moduleWeighted, 'calibration metric module work'),
      safeMultiply(2, validationMetricWork.moduleWeighted, 'validation metric module work'),
      'fixed scoring module-weighted work',
    ),
  };

  const allocations = stages.map((entry) => {
    const sensitivityTemporal = safeMultiply(entry.sensitivityProbeEvaluations,
      entry.work.temporal, `${entry.stage.id} sensitivity temporal work`);
    const sensitivityModule = safeMultiply(entry.sensitivityProbeEvaluations,
      entry.work.moduleWeighted, `${entry.stage.id} sensitivity module work`);
    const localTemporal = entry.stage.integrationStepBudget - sensitivityTemporal;
    const localModule = entry.stage.moduleWeightedIntegrationStepBudget - sensitivityModule;
    const localEvaluation = entry.stage.evaluationBudget - entry.sensitivityProbeEvaluations;
    const optimizerEvaluationCeiling = Math.min(
      localEvaluation,
      Math.floor(localTemporal / entry.work.temporal),
      Math.floor(localModule / entry.work.moduleWeighted),
    );
    if (optimizerEvaluationCeiling < entry.stage.initialSimplexEvaluations) {
      throw new RangeError(`ECM tuning preflight failed before simulation: stage "${entry.stage.id}" cannot fund its sensitivity probes and ${entry.stage.initialSimplexEvaluations}-proposal optimizer simplex inside all three local ceilings.`);
    }
    return {
      ...entry,
      sensitivityTemporal,
      sensitivityModule,
      optimizerEvaluationCeiling,
      optimizerEvaluationBudget: optimizerEvaluationCeiling,
    };
  });

  let projectedEvaluations = 0;
  let projectedTemporal = overhead.temporal;
  let projectedModule = overhead.moduleWeighted;
  for (const allocation of allocations) {
    projectedEvaluations = safeAdd(projectedEvaluations,
      allocation.sensitivityProbeEvaluations + allocation.optimizerEvaluationBudget,
      'projected ECM tuning evaluations');
    projectedTemporal = safeAdd(projectedTemporal,
      safeMultiply(allocation.sensitivityProbeEvaluations + allocation.optimizerEvaluationBudget,
        allocation.work.temporal, `${allocation.stage.id} projected temporal work`),
      'projected ECM tuning temporal work');
    projectedModule = safeAdd(projectedModule,
      safeMultiply(allocation.sensitivityProbeEvaluations + allocation.optimizerEvaluationBudget,
        allocation.work.moduleWeighted, `${allocation.stage.id} projected module work`),
      'projected ECM tuning module-weighted work');
  }

  // The planner allocates the complete temporal ceilings among stages. Fixed
  // before/after scoring therefore shrinks optional optimizer proposals. Trim
  // early group-stage extras first, preserving every mandatory simplex and the
  // joint refinement allocation as long as the exact work ceilings allow.
  for (const allocation of allocations) {
    const excessEvaluations = Math.max(0, projectedEvaluations - plan.budgets.maxEvaluations);
    const excessTemporal = Math.max(0, projectedTemporal - plan.budgets.maxIntegrationSteps);
    const excessModule = Math.max(0,
      projectedModule - plan.budgets.maxModuleWeightedIntegrationSteps);
    if (!excessEvaluations && !excessTemporal && !excessModule) break;
    const removable = allocation.optimizerEvaluationBudget - allocation.stage.initialSimplexEvaluations;
    if (removable <= 0) continue;
    const requiredRemoval = Math.max(
      excessEvaluations,
      Math.ceil(excessTemporal / allocation.work.temporal),
      Math.ceil(excessModule / allocation.work.moduleWeighted),
    );
    const removed = Math.min(removable, requiredRemoval);
    allocation.optimizerEvaluationBudget -= removed;
    projectedEvaluations -= removed;
    projectedTemporal -= removed * allocation.work.temporal;
    projectedModule -= removed * allocation.work.moduleWeighted;
  }

  if (projectedEvaluations > plan.budgets.maxEvaluations
    || projectedTemporal > plan.budgets.maxIntegrationSteps
    || projectedModule > plan.budgets.maxModuleWeightedIntegrationSteps) {
    throw new RangeError('ECM tuning preflight failed before simulation: fixed full-rate validation, prepared calibration metrics, sensitivity probes and every mandatory optimizer simplex do not fit the cumulative plan ceilings.');
  }

  return deepFreeze({
    status: 'pass',
    performedBeforeFirstSimulation: true,
    fixedScoringWork: {
      calibrationPasses: 2,
      validationPasses: 2,
      temporalIntegrationSteps: overhead.temporal,
      moduleWeightedIntegrationSteps: overhead.moduleWeighted,
    },
    projectedCeilings: {
      candidateEvaluations: projectedEvaluations,
      temporalIntegrationSteps: projectedTemporal,
      moduleWeightedIntegrationSteps: projectedModule,
    },
    limits: {
      candidateEvaluations: plan.budgets.maxEvaluations,
      temporalIntegrationSteps: plan.budgets.maxIntegrationSteps,
      moduleWeightedIntegrationSteps: plan.budgets.maxModuleWeightedIntegrationSteps,
    },
    stages: allocations.map((allocation) => ({
      id: allocation.stage.id,
      sensitivityProbeEvaluations: allocation.sensitivityProbeEvaluations,
      optimizerEvaluationBudget: allocation.optimizerEvaluationBudget,
      optimizerInitialSimplexEvaluations: allocation.stage.initialSimplexEvaluations,
      workPerCandidate: allocation.work.temporal,
      moduleWeightedWorkPerCandidate: allocation.work.moduleWeighted,
      plannedEvaluationCeiling: allocation.stage.evaluationBudget,
      plannedTemporalCeiling: allocation.stage.integrationStepBudget,
      plannedModuleWeightedCeiling: allocation.stage.moduleWeightedIntegrationStepBudget,
    })),
    _allocations: allocations,
  });
}

function assertCandidateConstraint(params, label) {
  const ratio = params.rc2TauS / params.rc1TauS;
  if (!Number.isFinite(ratio) || ratio < ECM_RC_MINIMUM_TIME_CONSTANT_RATIO) {
    throw new RangeError(`${label} violates the ordered RC time-constant constraint.`);
  }
  return ratio;
}

function simulatePreparedTrial(cell, trial, params) {
  assertCandidateConstraint(params, 'An ECM tuning simulation candidate');
  const result = simulate({
    cell,
    s: trial.dataset.binding.seriesCells,
    p: trial.dataset.binding.parallelCells,
    nModules: trial.dataset.binding.moduleCount,
    params,
    profile: { dtS: trial.prepared.measured.dtS, i: trial.prepared.measured.i },
    startSoC: trial.dataset.binding.startSoC,
    ambientC: trial.dataset.binding.ambientC,
  });
  if (!result) throw new Error(`Prepared trial "${trial.dataset.id}" unexpectedly failed to simulate.`);
  if (result.paramNotes.length) {
    throw new Error(`Prepared trial "${trial.dataset.id}" required forbidden simulator parameter repair.`);
  }
  return result;
}

function simulateRawTrial(cell, trial, params) {
  assertCandidateConstraint(params, 'An ECM tuning validation candidate');
  const result = simulate({
    cell,
    s: trial.dataset.binding.seriesCells,
    p: trial.dataset.binding.parallelCells,
    nModules: trial.dataset.binding.moduleCount,
    params,
    profile: { dtS: trial.dataset.samplePeriodS, i: trial.dataset.signals.currentA },
    startSoC: trial.dataset.binding.startSoC,
    ambientC: trial.dataset.binding.ambientC,
  });
  if (!result) throw new Error(`Full-rate validation trial "${trial.dataset.id}" unexpectedly failed to simulate.`);
  if (result.paramNotes.length) {
    throw new Error(`Full-rate validation trial "${trial.dataset.id}" required forbidden simulator parameter repair.`);
  }
  return result;
}

function emptyAggregate() {
  return { sumSquares: 0, sum: 0, count: 0, maxAbs: 0 };
}

function addErrors(aggregate, predicted, observed, indices, scale) {
  for (const index of indices) {
    const error = (predicted[index] - observed[index]) * scale;
    if (!Number.isFinite(error)) throw new RangeError(`Non-finite ECM tuning score at sample ${index}.`);
    aggregate.sumSquares += error * error;
    aggregate.sum += error;
    aggregate.count++;
    aggregate.maxAbs = Math.max(aggregate.maxAbs, Math.abs(error));
  }
}

function metric(aggregate, unit) {
  if (!aggregate.count) return null;
  return {
    sampleCount: aggregate.count,
    rmse: Math.sqrt(aggregate.sumSquares / aggregate.count),
    maxAbs: aggregate.maxAbs,
    meanBias: aggregate.sum / aggregate.count,
    unit,
  };
}

function scoreTrials(cell, trials, params, grid) {
  const pooledVoltage = emptyAggregate();
  const pooledTemperature = emptyAggregate();
  const perTrial = [];
  let temporalIntegrationSteps = 0;
  let moduleWeightedIntegrationSteps = 0;
  for (const trial of trials) {
    const prepared = grid === 'prepared';
    const result = prepared
      ? simulatePreparedTrial(cell, trial, params)
      : simulateRawTrial(cell, trial, params);
    const indices = prepared ? trial.prepared.selectedIndices : trial.rawIndices;
    const observedVoltage = prepared ? trial.prepared.measured.v : trial.dataset.signals.voltageV;
    const voltage = emptyAggregate();
    addErrors(voltage, result.series.v, observedVoltage, indices,
      1_000 / trial.dataset.binding.seriesCells);
    for (const key of ['sumSquares', 'sum', 'count']) pooledVoltage[key] += voltage[key];
    pooledVoltage.maxAbs = Math.max(pooledVoltage.maxAbs, voltage.maxAbs);

    let temperature = null;
    const observedTemperature = prepared
      ? trial.prepared.observedTemperatureC
      : trial.dataset.signals.temperatureC;
    if (observedTemperature !== null
      && trial.dataset.conventions.temperatureLocation === 'module-maximum') {
      const aggregate = emptyAggregate();
      addErrors(aggregate, result.series.tMax, observedTemperature, indices, 1);
      for (const key of ['sumSquares', 'sum', 'count']) pooledTemperature[key] += aggregate[key];
      pooledTemperature.maxAbs = Math.max(pooledTemperature.maxAbs, aggregate.maxAbs);
      temperature = metric(aggregate, 'degC');
    }
    const segments = [];
    if (!prepared) {
      for (const segment of trial.dataset.segments) {
        if (!segment.include) continue;
        const segmentIndices = [];
        for (let index = segment.startIndex; index < segment.endIndexExclusive; index++) {
          segmentIndices.push(index);
        }
        const segmentVoltage = emptyAggregate();
        addErrors(segmentVoltage, result.series.v, observedVoltage, segmentIndices,
          1_000 / trial.dataset.binding.seriesCells);
        let segmentTemperature = null;
        if (observedTemperature !== null
          && trial.dataset.conventions.temperatureLocation === 'module-maximum') {
          const aggregate = emptyAggregate();
          addErrors(aggregate, result.series.tMax, observedTemperature, segmentIndices, 1);
          segmentTemperature = metric(aggregate, 'degC');
        }
        segments.push({
          segmentId: segment.id,
          mode: segment.mode,
          sampleCount: segmentIndices.length,
          voltage: metric(segmentVoltage, 'mV-per-cell'),
          temperature: segmentTemperature,
        });
      }
    }
    perTrial.push({
      id: trial.dataset.id,
      datasetChecksum: trial.dataset.checksum,
      trialContentChecksum: trial.trialContentChecksum,
      sampleGrid: prepared ? 'prepared-optimizer-grid' : 'original-full-rate',
      voltage: metric(voltage, 'mV-per-cell'),
      temperature,
      segments,
    });
    const work = prepared ? trial.preparedWork : trial.rawWork;
    temporalIntegrationSteps = safeAdd(temporalIntegrationSteps,
      work.integrationStepCount, 'scoring temporal work');
    moduleWeightedIntegrationSteps = safeAdd(moduleWeightedIntegrationSteps,
      work.thermalNodeUpdateCount, 'scoring module-weighted work');
  }
  const evidence = {
      sampleGrid: grid === 'prepared' ? 'prepared-optimizer-grid' : 'original-full-rate',
      perTrial,
      pooled: {
        voltage: metric(pooledVoltage, 'mV-per-cell'),
        temperature: metric(pooledTemperature, 'degC'),
      },
    };
  return {
    evidence: { ...evidence, checksum: semanticDigest(evidence) },
    work: { temporalIntegrationSteps, moduleWeightedIntegrationSteps },
  };
}

function predictionVector(cell, trials, params) {
  const vector = [];
  let temporalIntegrationSteps = 0;
  let moduleWeightedIntegrationSteps = 0;
  for (const trial of trials) {
    const result = simulatePreparedTrial(cell, trial, params);
    const scale = 1_000 / trial.dataset.binding.seriesCells;
    for (const index of trial.prepared.selectedIndices) vector.push(result.series.v[index] * scale);
    temporalIntegrationSteps = safeAdd(temporalIntegrationSteps,
      trial.preparedWork.integrationStepCount, 'sensitivity temporal work');
    moduleWeightedIntegrationSteps = safeAdd(moduleWeightedIntegrationSteps,
      trial.preparedWork.thermalNodeUpdateCount, 'sensitivity module-weighted work');
  }
  return { vector, temporalIntegrationSteps, moduleWeightedIntegrationSteps };
}

function sensitivityCandidate(params, name) {
  const spec = PARAM_BY_ID[name];
  if (!spec) throw new TypeError(`Unknown sensitivity parameter "${name}".`);
  const selected = boundAwareAdmissibleAxisStep({
    value: params[name],
    lower: spec.min,
    upper: spec.max,
    nominalNormalizedStep: ECM_TUNING_EXECUTION_POLICY.sensitivity.normalizedParameterStep,
    minimumNormalizedStep:
      ECM_TUNING_EXECUTION_POLICY.sensitivity.minimumUsableNormalizedParameterStep,
    admissible: (candidateValue) => {
      const candidate = { ...params, [name]: candidateValue };
      return candidate.rc2TauS / candidate.rc1TauS >= ECM_RC_MINIMUM_TIME_CONSTANT_RATIO;
    },
  });
  if (selected === null) return null;
  return {
    params: { ...params, [name]: selected.value },
    direction: selected.direction,
    normalizedDelta: selected.normalizedDelta,
    absoluteParameterDelta: selected.delta,
  };
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index] * right[index];
  return sum;
}

function sensitivityGate(cell, trials, params, fit) {
  const baseline = predictionVector(cell, trials, params);
  const columns = [];
  let probeEvaluations = 1;
  let temporalIntegrationSteps = baseline.temporalIntegrationSteps;
  let moduleWeightedIntegrationSteps = baseline.moduleWeightedIntegrationSteps;
  for (const name of fit) {
    const probe = sensitivityCandidate(params, name);
    if (probe === null) {
      columns.push({
        name,
        values: baseline.vector.map(() => 0),
        norm: 0,
        rms: 0,
        direction: null,
        normalizedDelta: null,
        absoluteParameterDelta: null,
        probeStatus: 'unavailable',
      });
      continue;
    }
    const prediction = predictionVector(cell, trials, probe.params);
    probeEvaluations++;
    temporalIntegrationSteps = safeAdd(temporalIntegrationSteps,
      prediction.temporalIntegrationSteps, 'sensitivity temporal work');
    moduleWeightedIntegrationSteps = safeAdd(moduleWeightedIntegrationSteps,
      prediction.moduleWeightedIntegrationSteps, 'sensitivity module-weighted work');
    const values = prediction.vector.map((value, index) => (
      (value - baseline.vector[index]) / probe.normalizedDelta
    ));
    const norm = Math.sqrt(dot(values, values));
    const rms = values.length ? norm / Math.sqrt(values.length) : 0;
    columns.push({
      name,
      values,
      norm,
      rms,
      direction: probe.direction,
      normalizedDelta: probe.normalizedDelta,
      absoluteParameterDelta: probe.absoluteParameterDelta,
      probeStatus: 'evaluated',
    });
  }

  let maximumAbsoluteCorrelation = 0;
  let maximumCorrelationPair = null;
  for (let left = 0; left < columns.length; left++) {
    for (let right = left + 1; right < columns.length; right++) {
      const denominator = columns[left].norm * columns[right].norm;
      const correlation = denominator > 0
        ? Math.abs(dot(columns[left].values, columns[right].values) / denominator) : 1;
      if (correlation > maximumAbsoluteCorrelation) {
        maximumAbsoluteCorrelation = correlation;
        maximumCorrelationPair = [columns[left].name, columns[right].name];
      }
    }
  }

  // Deterministic column-pivoted modified Gram-Schmidt.  Pivoting avoids an
  // accidental fit-array order deciding the rank of a nearly correlated
  // matrix; lexical parameter id is the exact tie-breaker.
  const orthonormal = [];
  const pivotOrder = [];
  const remaining = columns.map((column) => ({
    name: column.name,
    vector: column.norm > 0
      ? column.values.map((value) => value / column.norm)
      : column.values.map(() => 0),
  }));
  while (remaining.length) {
    const candidates = remaining.map((candidate, index) => {
      const residual = [...candidate.vector];
      for (const basis of orthonormal) {
        const projection = dot(residual, basis);
        for (let row = 0; row < residual.length; row++) residual[row] -= projection * basis[row];
      }
      return { ...candidate, index, residual, residualNorm: Math.sqrt(dot(residual, residual)) };
    }).sort((left, right) => right.residualNorm - left.residualNorm
      || left.name.localeCompare(right.name));
    const pivot = candidates[0];
    remaining.splice(pivot.index, 1);
    pivotOrder.push(pivot.name);
    if (pivot.residualNorm > ECM_TUNING_EXECUTION_POLICY.sensitivity.relativePivotRankTolerance) {
      orthonormal.push(pivot.residual.map((value) => value / pivot.residualNorm));
    }
  }
  const minimumColumnRms = columns.length ? Math.min(...columns.map(({ rms }) => rms)) : 0;
  const finite = columns.every(({ norm, rms }) => Number.isFinite(norm) && Number.isFinite(rms));
  const rankPass = orthonormal.length === fit.length;
  const magnitudePass = minimumColumnRms
    >= ECM_TUNING_EXECUTION_POLICY.sensitivity.minimumColumnRmsMvPerCell;
  const correlationPass = columns.length < 2 || maximumAbsoluteCorrelation
    <= ECM_TUNING_EXECUTION_POLICY.sensitivity.maximumAbsoluteColumnCorrelation;
  const pass = finite && rankPass && magnitudePass && correlationPass;
  return {
    evidence: {
      status: pass ? 'pass' : 'fail',
      method: ECM_TUNING_EXECUTION_POLICY.sensitivity.method,
      predictionSampleCount: baseline.vector.length,
      probeEvaluations,
      reservedProbeEvaluations: fit.length + 1,
      parameterCount: fit.length,
      numericalRank: orthonormal.length,
      requiredRank: fit.length,
      minimumColumnRmsMvPerCell: minimumColumnRms,
      minimumAllowedColumnRmsMvPerCell:
        ECM_TUNING_EXECUTION_POLICY.sensitivity.minimumColumnRmsMvPerCell,
      maximumAbsoluteColumnCorrelation: maximumAbsoluteCorrelation,
      maximumAllowedAbsoluteColumnCorrelation:
        ECM_TUNING_EXECUTION_POLICY.sensitivity.maximumAbsoluteColumnCorrelation,
      maximumCorrelationPair,
      pivotOrder,
      columns: columns.map(({
        name, rms, direction, normalizedDelta, absoluteParameterDelta, probeStatus,
      }) => ({
        parameter: name,
        rmsMvPerCell: rms,
        direction,
        normalizedDelta,
        absoluteParameterDelta,
        probeStatus,
      })),
      detail: pass
        ? 'The normalized finite-difference prediction Jacobian has finite nonzero columns, full numerical rank and no prohibited near-perfect pair correlation.'
        : 'The normalized finite-difference prediction Jacobian failed magnitude, rank or correlation requirements; this stage was not activated.',
    },
    work: { temporalIntegrationSteps, moduleWeightedIntegrationSteps },
  };
}

function atBound(value, spec) {
  const tolerance = Math.max(
    (spec.max - spec.min) * 1e-8,
    Number.EPSILON * Math.max(1, Math.abs(spec.min), Math.abs(spec.max)) * 8,
  );
  return Math.abs(value - spec.min) <= tolerance || Math.abs(spec.max - value) <= tolerance;
}

function maximumMetric(entries, channel, field) {
  let maximum = -Infinity;
  for (const entry of entries) {
    const value = entry[channel]?.[field];
    if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }
  return Number.isFinite(maximum) ? maximum : null;
}

function validationSegments(score) {
  return score.perTrial.flatMap((trial) => trial.segments.map((segment) => ({
    ...segment,
    key: `${trial.trialContentChecksum}:${segment.segmentId}`,
  })));
}

function noRegression(afterEntries, beforeEntries, channel, tolerance, key) {
  const beforeByKey = new Map(beforeEntries.map((entry) => [key(entry), entry]));
  return afterEntries.every((entry) => {
    const prior = beforeByKey.get(key(entry));
    return prior && entry[channel] !== null && prior[channel] !== null
      && entry[channel].rmse <= prior[channel].rmse + tolerance
      && entry[channel].maxAbs <= prior[channel].maxAbs + tolerance;
  });
}

function acceptanceVerdict(plan, before, after, finalParams, fittedNames, completed) {
  const tolerance = ECM_TUNING_EXECUTION_POLICY.numericalAcceptanceTolerance;
  const checks = [];
  const check = (id, pass, observed, limit, detail) => checks.push({
    id, status: pass ? 'pass' : 'fail', observed, limit, detail,
  });
  const calibrationBefore = before.calibration.pooled.voltage.rmse;
  const calibrationAfter = after.calibration.pooled.voltage.rmse;
  check('execution-completed', completed, completed, true,
    'Every planned stage must complete before automatic adoption.');
  check('calibration-objective-strictly-improved', calibrationAfter < calibrationBefore - tolerance,
    calibrationAfter, calibrationBefore,
    'The pooled prepared-grid calibration voltage RMSE must strictly improve beyond numerical tolerance.');
  const validationBefore = before.validation.pooled.voltage;
  const validationAfter = after.validation.pooled.voltage;
  check('validation-voltage-rmse-limit',
    validationAfter.rmse <= plan.acceptance.maxVoltageRmseMvPerCell,
    validationAfter.rmse, plan.acceptance.maxVoltageRmseMvPerCell,
    'The full-rate pooled validation voltage RMSE must satisfy the caller-predeclared limit.');
  check('validation-voltage-maximum-limit',
    validationAfter.maxAbs <= plan.acceptance.maxVoltageMaxAbsMvPerCell,
    validationAfter.maxAbs, plan.acceptance.maxVoltageMaxAbsMvPerCell,
    'The full-rate validation maximum absolute voltage error must satisfy the caller-predeclared limit.');
  const validationTrialsBefore = before.validation.perTrial;
  const validationTrialsAfter = after.validation.perTrial;
  const validationSegmentsBefore = validationSegments(before.validation);
  const validationSegmentsAfter = validationSegments(after.validation);
  const worstTrialVoltageRmse = maximumMetric(validationTrialsAfter, 'voltage', 'rmse');
  const worstTrialVoltageMaxAbs = maximumMetric(validationTrialsAfter, 'voltage', 'maxAbs');
  const worstSegmentVoltageRmse = maximumMetric(validationSegmentsAfter, 'voltage', 'rmse');
  const worstSegmentVoltageMaxAbs = maximumMetric(validationSegmentsAfter, 'voltage', 'maxAbs');
  check('validation-every-trial-voltage-rmse-limit',
    worstTrialVoltageRmse <= plan.acceptance.maxVoltageRmseMvPerCell,
    worstTrialVoltageRmse, plan.acceptance.maxVoltageRmseMvPerCell,
    'The worst whole validation trial must satisfy the caller voltage RMSE limit.');
  check('validation-every-trial-voltage-maximum-limit',
    worstTrialVoltageMaxAbs <= plan.acceptance.maxVoltageMaxAbsMvPerCell,
    worstTrialVoltageMaxAbs, plan.acceptance.maxVoltageMaxAbsMvPerCell,
    'The worst whole validation trial must satisfy the caller maximum absolute voltage limit.');
  check('validation-every-segment-voltage-rmse-limit',
    worstSegmentVoltageRmse <= plan.acceptance.maxVoltageRmseMvPerCell,
    worstSegmentVoltageRmse, plan.acceptance.maxVoltageRmseMvPerCell,
    'The worst included validation segment must satisfy the caller voltage RMSE limit.');
  check('validation-every-segment-voltage-maximum-limit',
    worstSegmentVoltageMaxAbs <= plan.acceptance.maxVoltageMaxAbsMvPerCell,
    worstSegmentVoltageMaxAbs, plan.acceptance.maxVoltageMaxAbsMvPerCell,
    'The worst included validation segment must satisfy the caller maximum absolute voltage limit.');
  check('validation-no-voltage-regression',
    validationAfter.rmse <= validationBefore.rmse + tolerance
      && validationAfter.maxAbs <= validationBefore.maxAbs + tolerance,
    { rmse: validationAfter.rmse, maxAbs: validationAfter.maxAbs },
    { rmse: validationBefore.rmse + tolerance, maxAbs: validationBefore.maxAbs + tolerance },
    'Neither pooled RMSE nor maximum absolute full-rate validation voltage error may regress.');
  check('validation-no-trial-voltage-regression', noRegression(
    validationTrialsAfter, validationTrialsBefore, 'voltage', tolerance,
    (trial) => trial.trialContentChecksum,
  ), worstTrialVoltageRmse, 'each-before-trial-plus-tolerance',
  'No whole validation trial may hide a voltage regression behind a better pooled score.');
  check('validation-no-segment-voltage-regression', noRegression(
    validationSegmentsAfter, validationSegmentsBefore, 'voltage', tolerance,
    (segment) => segment.key,
  ), worstSegmentVoltageRmse, 'each-before-segment-plus-tolerance',
  'No included validation segment may hide a voltage regression behind a better trial or pooled score.');

  if (plan.acceptance.maxTemperatureRmseC !== null) {
    const temperatureBefore = before.validation.pooled.temperature;
    const temperatureAfter = after.validation.pooled.temperature;
    check('validation-temperature-evidence', temperatureAfter !== null,
      temperatureAfter === null ? 0 : temperatureAfter.sampleCount, 1,
      'A module-maximum validation channel must be scored when temperature limits are declared.');
    if (temperatureAfter !== null) {
      check('validation-temperature-rmse-limit',
        temperatureAfter.rmse <= plan.acceptance.maxTemperatureRmseC,
        temperatureAfter.rmse, plan.acceptance.maxTemperatureRmseC,
        'The full-rate pooled validation module-maximum temperature RMSE must satisfy the caller limit.');
      check('validation-temperature-maximum-limit',
        temperatureAfter.maxAbs <= plan.acceptance.maxTemperatureMaxAbsC,
        temperatureAfter.maxAbs, plan.acceptance.maxTemperatureMaxAbsC,
        'The full-rate validation maximum absolute module-temperature error must satisfy the caller limit.');
      const temperatureTrialsBefore = validationTrialsBefore.filter(({ temperature }) => temperature !== null);
      const temperatureTrialsAfter = validationTrialsAfter.filter(({ temperature }) => temperature !== null);
      const temperatureSegmentsBefore = validationSegmentsBefore.filter(({ temperature }) => temperature !== null);
      const temperatureSegmentsAfter = validationSegmentsAfter.filter(({ temperature }) => temperature !== null);
      const worstTrialTemperatureRmse = maximumMetric(temperatureTrialsAfter, 'temperature', 'rmse');
      const worstTrialTemperatureMaxAbs = maximumMetric(temperatureTrialsAfter, 'temperature', 'maxAbs');
      const worstSegmentTemperatureRmse = maximumMetric(temperatureSegmentsAfter, 'temperature', 'rmse');
      const worstSegmentTemperatureMaxAbs = maximumMetric(temperatureSegmentsAfter, 'temperature', 'maxAbs');
      check('validation-every-eligible-trial-temperature-rmse-limit',
        worstTrialTemperatureRmse <= plan.acceptance.maxTemperatureRmseC,
        worstTrialTemperatureRmse, plan.acceptance.maxTemperatureRmseC,
        'The worst validation trial with module-maximum temperature must satisfy the caller RMSE limit.');
      check('validation-every-eligible-trial-temperature-maximum-limit',
        worstTrialTemperatureMaxAbs <= plan.acceptance.maxTemperatureMaxAbsC,
        worstTrialTemperatureMaxAbs, plan.acceptance.maxTemperatureMaxAbsC,
        'The worst validation trial with module-maximum temperature must satisfy the caller maximum limit.');
      check('validation-every-eligible-segment-temperature-rmse-limit',
        worstSegmentTemperatureRmse <= plan.acceptance.maxTemperatureRmseC,
        worstSegmentTemperatureRmse, plan.acceptance.maxTemperatureRmseC,
        'The worst included module-maximum validation segment must satisfy the caller RMSE limit.');
      check('validation-every-eligible-segment-temperature-maximum-limit',
        worstSegmentTemperatureMaxAbs <= plan.acceptance.maxTemperatureMaxAbsC,
        worstSegmentTemperatureMaxAbs, plan.acceptance.maxTemperatureMaxAbsC,
        'The worst included module-maximum validation segment must satisfy the caller maximum limit.');
      check('validation-no-temperature-regression', temperatureBefore !== null
        && temperatureAfter.rmse <= temperatureBefore.rmse + tolerance
        && temperatureAfter.maxAbs <= temperatureBefore.maxAbs + tolerance,
      temperatureAfter === null ? null : { rmse: temperatureAfter.rmse, maxAbs: temperatureAfter.maxAbs },
      temperatureBefore === null ? null
        : { rmse: temperatureBefore.rmse + tolerance, maxAbs: temperatureBefore.maxAbs + tolerance },
      'Declared validation temperature metrics may not regress.');
      check('validation-no-trial-temperature-regression', noRegression(
        temperatureTrialsAfter, temperatureTrialsBefore, 'temperature', tolerance,
        (trial) => trial.trialContentChecksum,
      ), worstTrialTemperatureRmse, 'each-before-trial-plus-tolerance',
      'No eligible module-maximum validation trial may hide a temperature regression.');
      check('validation-no-segment-temperature-regression', noRegression(
        temperatureSegmentsAfter, temperatureSegmentsBefore, 'temperature', tolerance,
        (segment) => segment.key,
      ), worstSegmentTemperatureRmse, 'each-before-segment-plus-tolerance',
      'No eligible module-maximum validation segment may hide a temperature regression.');
    }
  }

  const boundParameters = [...fittedNames].filter((name) => atBound(finalParams[name], PARAM_BY_ID[name]));
  check('no-fitted-parameter-at-bound', boundParameters.length === 0,
    boundParameters, [], 'No automatically fitted parameter may finish at a declared model bound.');
  const ratio = finalParams.rc2TauS / finalParams.rc1TauS;
  check('ordered-rc-final-candidate', ratio >= ECM_RC_MINIMUM_TIME_CONSTANT_RATIO,
    ratio, ECM_RC_MINIMUM_TIME_CONSTANT_RATIO,
    'The final candidate must retain the plan-wide RC time-constant ordering.');
  const accepted = checks.every(({ status }) => status === 'pass');
  const verdict = {
    status: accepted ? 'accepted' : 'rejected',
    accepted,
    authority: 'caller-predeclared-plan-acceptance',
    acceptanceChecksum: plan.acceptanceChecksum,
    numericalTolerance: tolerance,
    checks,
  };
  return { ...verdict, checksum: semanticDigest(verdict) };
}

function publicPreflight(preflightResult) {
  const { _allocations, ...result } = preflightResult;
  return withChecksum(result);
}

/** Execute one immutable, exact-identity ECM tuning plan. */
export function executeEcmTuning(input) {
  object(input, 'ECM tuning execution input');
  const unsupported = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unsupported.length) throw new TypeError(`ECM tuning execution input contains unsupported field(s): ${unsupported.join(', ')}.`);
  const planInput = object(input.plan, 'plan');
  const cell = object(input.cell, 'cell');
  assertPlanChecksum(planInput);
  const calibrationDatasets = asList(input.calibrationDatasets, 'calibrationDatasets');
  const validationDatasets = asList(input.validationDatasets, 'validationDatasets');
  const plan = rebuildPlan(planInput, cell, calibrationDatasets, validationDatasets);
  const calibration = prepareTrials(cell, calibrationDatasets, plan.initialParams,
    plan.budgets.maxPreprocessedSamplesPerDataset);
  const validation = prepareTrials(cell, validationDatasets, plan.initialParams,
    plan.budgets.maxPreprocessedSamplesPerDataset);
  const stages = stageTrials(plan, calibration);
  const workPreflight = preflight(plan, calibration, validation, stages);
  const allocations = workPreflight._allocations;

  let temporalIntegrationSteps = 0;
  let moduleWeightedIntegrationSteps = 0;
  let sensitivityProbeEvaluations = 0;
  let optimizerProposalEvaluations = 0;
  let rejectedOptimizerProposals = 0;
  let optimizerCacheHits = 0;
  let minimumProposedRcTimeConstantRatio = Infinity;
  let currentParams = { ...plan.initialParams };
  const initialRatio = assertCandidateConstraint(currentParams, 'The planned initial parameters');

  const calibrationBefore = scoreTrials(cell, calibration, currentParams, 'prepared');
  const validationBefore = scoreTrials(cell, validation, currentParams, 'raw');
  temporalIntegrationSteps = safeAdd(temporalIntegrationSteps,
    calibrationBefore.work.temporalIntegrationSteps + validationBefore.work.temporalIntegrationSteps,
    'executed temporal work');
  moduleWeightedIntegrationSteps = safeAdd(moduleWeightedIntegrationSteps,
    calibrationBefore.work.moduleWeightedIntegrationSteps
      + validationBefore.work.moduleWeightedIntegrationSteps,
    'executed module-weighted work');

  const stageEvidence = [];
  let completed = true;
  for (let stageIndex = 0; stageIndex < allocations.length; stageIndex++) {
    const allocation = allocations[stageIndex];
    if (!completed) {
      stageEvidence.push(withChecksum({
        id: allocation.stage.id,
        status: 'not-run-after-sensitivity-failure',
        fit: [...allocation.stage.fit],
        calibrationTrialContentChecksums: [...allocation.stage.calibrationTrialContentChecksums],
      }));
      continue;
    }
    const paramsBefore = { ...currentParams };
    const sensitivity = sensitivityGate(cell, allocation.trials, currentParams,
      allocation.stage.fit);
    sensitivityProbeEvaluations = safeAdd(sensitivityProbeEvaluations,
      sensitivity.evidence.probeEvaluations, 'executed sensitivity evaluations');
    temporalIntegrationSteps = safeAdd(temporalIntegrationSteps,
      sensitivity.work.temporalIntegrationSteps, 'executed temporal work');
    moduleWeightedIntegrationSteps = safeAdd(moduleWeightedIntegrationSteps,
      sensitivity.work.moduleWeightedIntegrationSteps, 'executed module-weighted work');
    if (sensitivity.evidence.status !== 'pass') {
      completed = false;
      stageEvidence.push(withChecksum({
        id: allocation.stage.id,
        status: 'blocked-sensitivity',
        kind: allocation.stage.kind,
        groups: [...allocation.stage.groups],
        fit: [...allocation.stage.fit],
        calibrationTrialContentChecksums: [...allocation.stage.calibrationTrialContentChecksums],
        paramsBeforeChecksum: semanticDigest(paramsBefore),
        paramsAfterChecksum: semanticDigest(paramsBefore),
        sensitivity: sensitivity.evidence,
        optimizer: null,
      }));
      continue;
    }

    const maximumOptimizerTemporalWork = safeMultiply(allocation.optimizerEvaluationBudget,
      allocation.work.temporal, `${allocation.stage.id} optimizer temporal ceiling`);
    const optimized = calibrateDatasetsConstrained({
      cell,
      datasets: allocation.trials.map(({ dataset }) => dataset),
      params: currentParams,
      fit: allocation.stage.fit,
      maxIter: 100_000,
      weightTemp: 0,
      maxEvaluations: allocation.optimizerEvaluationBudget,
      maxIntegrationSteps: maximumOptimizerTemporalWork,
      maxSamplesPerDataset: plan.budgets.maxPreprocessedSamplesPerDataset,
      candidatePolicy: ORDERED_RC_CANDIDATE_POLICY,
    });
    if (optimized.workPerEvaluation !== allocation.work.temporal
      || optimized.nodeWorkPerEvaluation !== allocation.work.moduleWeighted) {
      throw new Error(`Stage "${allocation.stage.id}" simulator work drifted after the zero-simulation preflight.`);
    }
    const finalRatio = assertCandidateConstraint(optimized.params,
      `Stage "${allocation.stage.id}" final candidate`);
    currentParams = { ...optimized.params };
    optimizerProposalEvaluations = safeAdd(optimizerProposalEvaluations,
      optimized.candidateConstraintEvidence.proposalCount, 'executed optimizer proposals');
    rejectedOptimizerProposals = safeAdd(rejectedOptimizerProposals,
      optimized.candidateConstraintEvidence.rejectedCandidateCount,
      'rejected optimizer proposals');
    optimizerCacheHits = safeAdd(optimizerCacheHits,
      optimized.candidateConstraintEvidence.cacheHitCount, 'optimizer cache hits');
    minimumProposedRcTimeConstantRatio = Math.min(minimumProposedRcTimeConstantRatio,
      optimized.candidateConstraintEvidence.minimumProposedRcTimeConstantRatio);
    temporalIntegrationSteps = safeAdd(temporalIntegrationSteps,
      optimized.integrationStepCount, 'executed temporal work');
    moduleWeightedIntegrationSteps = safeAdd(moduleWeightedIntegrationSteps,
      optimized.thermalNodeUpdateCount, 'executed module-weighted work');
    stageEvidence.push(withChecksum({
      id: allocation.stage.id,
      status: 'completed',
      kind: allocation.stage.kind,
      groups: [...allocation.stage.groups],
      fit: [...allocation.stage.fit],
      calibrationTrialContentChecksums: [...allocation.stage.calibrationTrialContentChecksums],
      paramsBeforeChecksum: semanticDigest(paramsBefore),
      paramsAfterChecksum: semanticDigest(currentParams),
      sensitivity: sensitivity.evidence,
      optimizer: {
        terminationReason: optimized.terminationReason,
        iterations: optimized.iterations,
        proposalEvaluations: optimized.candidateConstraintEvidence.proposalCount,
        uniqueEvaluations: optimized.evaluationCount,
        simulatedEvaluations: optimized.evaluationCount
          - optimized.candidateConstraintEvidence.rejectedCandidateCount,
        cacheHitProposals: optimized.candidateConstraintEvidence.cacheHitCount,
        rejectedConstraintProposals: optimized.candidateConstraintEvidence.rejectedCandidateCount,
        evaluationBudget: allocation.optimizerEvaluationBudget,
        temporalIntegrationSteps: optimized.integrationStepCount,
        moduleWeightedIntegrationSteps: optimized.thermalNodeUpdateCount,
        workPerSimulatedCandidate: optimized.workPerEvaluation,
        moduleWeightedWorkPerSimulatedCandidate: optimized.nodeWorkPerEvaluation,
        voltageRmseBeforeV: optimized.voltageRmseBefore,
        voltageRmseAfterV: optimized.voltageRmseAfter,
        improvementPct: optimized.improvementPct,
        finalRcTimeConstantRatio: finalRatio,
        minimumProposedRcTimeConstantRatio:
          optimized.candidateConstraintEvidence.minimumProposedRcTimeConstantRatio,
        candidatePolicy: optimized.candidateConstraintEvidence.policy,
      },
    }));
  }

  const finalRatio = assertCandidateConstraint(currentParams, 'The final ECM tuning candidate');
  const calibrationAfter = scoreTrials(cell, calibration, currentParams, 'prepared');
  const validationAfter = scoreTrials(cell, validation, currentParams, 'raw');
  temporalIntegrationSteps = safeAdd(temporalIntegrationSteps,
    calibrationAfter.work.temporalIntegrationSteps + validationAfter.work.temporalIntegrationSteps,
    'executed temporal work');
  moduleWeightedIntegrationSteps = safeAdd(moduleWeightedIntegrationSteps,
    calibrationAfter.work.moduleWeightedIntegrationSteps
      + validationAfter.work.moduleWeightedIntegrationSteps,
    'executed module-weighted work');

  const candidateEvaluations = safeAdd(sensitivityProbeEvaluations,
    optimizerProposalEvaluations, 'executed candidate evaluations');
  if (candidateEvaluations > plan.budgets.maxEvaluations
    || temporalIntegrationSteps > plan.budgets.maxIntegrationSteps
    || moduleWeightedIntegrationSteps > plan.budgets.maxModuleWeightedIntegrationSteps) {
    throw new Error('ECM tuning executed work exceeded a preflighted cumulative ceiling.');
  }
  const fittedNames = new Set(plan.stages.flatMap(({ fit }) => fit));
  const before = withChecksum({
    calibration: calibrationBefore.evidence,
    validation: validationBefore.evidence,
  });
  const after = withChecksum({
    calibration: calibrationAfter.evidence,
    validation: validationAfter.evidence,
  });
  const metrics = withChecksum({ before, after });
  const callerPolicyVerdict = acceptanceVerdict(plan, before, after,
    currentParams, fittedNames, completed);
  const initialParamsChecksum = semanticDigest(plan.initialParams);
  const candidateParamsChecksum = semanticDigest(currentParams);
  const adoptedParams = callerPolicyVerdict.accepted ? currentParams : plan.initialParams;
  const adoptedParamsChecksum = callerPolicyVerdict.accepted
    ? candidateParamsChecksum : initialParamsChecksum;
  const request = {
    planChecksum: plan.checksum,
    executionPolicyChecksum: ECM_TUNING_EXECUTION_POLICY.checksum,
    cellChecksum: plan.cellChecksum,
    calibrationTrialContentChecksums: calibration.map(({ trialContentChecksum: checksum }) => checksum),
    validationTrialContentChecksums: validation.map(({ trialContentChecksum: checksum }) => checksum),
  };
  const result = {
    format: ECM_TUNING_RESULT_FORMAT,
    executionPolicy: ECM_TUNING_EXECUTION_POLICY,
    request,
    requestChecksum: semanticDigest(request),
    planChecksum: plan.checksum,
    cell: plan.cell,
    cellChecksum: plan.cellChecksum,
    initialParams: { ...plan.initialParams },
    initialParamsChecksum,
    candidateParams: { ...currentParams },
    candidateParamsChecksum,
    adoptedParams: { ...adoptedParams },
    adoptedParamsChecksum,
    candidateConstraintEvidence: {
      policy: ORDERED_RC_CANDIDATE_POLICY,
      minimumRcTimeConstantRatio: ECM_RC_MINIMUM_TIME_CONSTANT_RATIO,
      initialRcTimeConstantRatio: initialRatio,
      finalRcTimeConstantRatio: finalRatio,
      minimumProposedRcTimeConstantRatio: Number.isFinite(minimumProposedRcTimeConstantRatio)
        ? minimumProposedRcTimeConstantRatio : initialRatio,
      rejectedOptimizerProposals,
      optimizerCacheHits,
      everySimulatedCandidateEnforced: true,
    },
    workPreflight: publicPreflight(workPreflight),
    work: {
      candidateEvaluations,
      sensitivityProbeEvaluations,
      optimizerProposalEvaluations,
      rejectedOptimizerProposals,
      optimizerCacheHits,
      temporalIntegrationSteps,
      moduleWeightedIntegrationSteps,
      limits: {
        candidateEvaluations: plan.budgets.maxEvaluations,
        temporalIntegrationSteps: plan.budgets.maxIntegrationSteps,
        moduleWeightedIntegrationSteps: plan.budgets.maxModuleWeightedIntegrationSteps,
      },
      countersResetBetweenStages: false,
    },
    stages: stageEvidence,
    metrics,
    callerPolicyVerdict,
    readiness: {
      optimizerExecution: completed ? 'completed' : 'blocked-by-sensitivity',
      validationRole: 'fixed-full-rate-score-only-never-an-optimizer-input',
      numericalSensitivity: completed ? 'passed-for-every-stage' : 'failed-closed',
      adoption: callerPolicyVerdict.accepted ? 'accepted' : 'rejected',
      holdoutIndependenceClaim: plan.trials.independenceLimit,
    },
  };
  return deepFreeze({ ...result, checksum: semanticDigest(result) });
}
