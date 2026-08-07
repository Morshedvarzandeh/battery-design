// ecm-tuning.js — deterministic planning for staged ECM parameter tuning.
//
// This module deliberately does not optimize.  It validates whole governed
// trials, detects holdout leakage, measures whether the requested experiment
// covers the prerequisites for each supported electrical parameter group, and
// allocates bounded ceilings before a future executor evaluates one candidate.
// Coverage is not identifiability: the executor must still pass a normalized
// sensitivity/Jacobian rank and correlation check before activating any fit.

import {
  CALIBRATION_PREPROCESSING_POLICY,
  calibrationDatasetIdentities,
  preprocessCalibrationDataset,
  readCalibrationDataset,
} from './calibration-dataset.js';
import {
  defaultParams,
  MAX_CALIBRATION_DATASETS,
  MAX_PREPROCESSED_SAMPLES_PER_DATASET,
  PARAM_BY_ID,
  PARAM_SPEC,
} from './sim2.js';
import { ocvCell } from './sim1d.js';
import { semanticDigest } from './ontology.js';

export const ECM_TUNING_PLAN_FORMAT = 'battery-design/ecm-tuning-plan@1';

const deepFreeze = (value, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const strategyBody = {
  id: 'battery-design/staged-ecm-arrhenius',
  version: '1.0.0',
  optimizerExecution: 'not-in-plan',
  modelOrder: 'two-rc-with-evidence-based-slow-branch-eligibility',
  stageOrder: ['ohmic', 'fast-rc', 'slow-rc', 'soc-dependence', 'arrhenius', 'hysteresis', 'joint-refinement'],
};
export const ECM_TUNING_STRATEGY = deepFreeze({
  ...strategyBody,
  checksum: semanticDigest(strategyBody),
});

const acceptanceBody = {
  id: 'battery-design/ecm-tuning-acceptance',
  version: '1.0.0',
  calibrationRule: 'the executed candidate must strictly improve its calibration objective',
  validationRule: 'a separate whole-trial validation set is mandatory and must not worsen beyond the executor numerical tolerance',
  excitationRule: 'every executed parameter group must pass its versioned planning gates',
  constraintRule: 'no fitted parameter may finish accidentally at a declared bound',
  workRule: 'stage allocations are ceilings; before its first candidate the executor must preflight exact temporal and module-weighted work inside both ceilings',
  adoptionWithoutValidation: 'rejected',
  rawTraceEvidence: 'checksums and scalar diagnostics only',
};
export const ECM_TUNING_ACCEPTANCE_POLICY = deepFreeze({
  ...acceptanceBody,
  checksum: semanticDigest(acceptanceBody),
});

const gatePolicyBody = {
  id: 'battery-design/ecm-tuning-excitation-gates',
  version: '1.0.0',
  restCurrentCRateMax: 0.02,
  minimumStepCRate: 0.2,
  minimumOhmicEdges: 3,
  maximumOcvResidualVPerCell: 0.005,
  maximumFastSampleTauFraction: 0.2,
  minimumFastPulseTauMultiples: 3,
  minimumFastRestTauMultiples: 3,
  maximumSlowSampleTauFraction: 0.1,
  minimumSlowPulseTauMultiples: 3,
  minimumSlowRestTauMultiples: 3,
  minimumRcTimeConstantSeparationRatio: 3,
  minimumSocBasisBins: 3,
  minimumSocBasisSpan: 0.5,
  maximumMidSocBasis: 0.04,
  minimumExtremeSocBasis: 0.5,
  minimumAmbientPoints: 3,
  minimumAmbientSpanK: 20,
  referenceTemperatureToleranceK: 2,
  requiredArrheniusTemperatureLocation: 'cell-average',
  maximumIsothermalDepartureK: 2,
  minimumHysteresisSocOverlap: 0.2,
  minimumHysteresisStateExcursion: 0.05,
};
export const ECM_TUNING_GATE_POLICY = deepFreeze({
  ...gatePolicyBody,
  checksum: semanticDigest(gatePolicyBody),
});

export const ECM_TUNING_GROUPS = deepFreeze([
  {
    id: 'ohmic', parameters: ['r0Ref'], requiredForCore: true,
    description: 'Reference-temperature instantaneous series resistance.',
  },
  {
    id: 'fast-rc', parameters: ['rc1R', 'rc1TauS'], requiredForCore: true,
    description: 'Fast polarization amplitude and time constant.',
  },
  {
    id: 'slow-rc', parameters: ['rc2R', 'rc2TauS'], requiredForCore: false,
    description: 'Slow polarization amplitude and time constant.',
  },
  {
    id: 'soc-dependence', parameters: ['r0SocRise'], requiredForCore: false,
    description: 'The model\'s symmetric resistance rise away from mid-SoC.',
  },
  {
    id: 'arrhenius', parameters: ['r0EaJ'], requiredForCore: false,
    description: 'The one shared activation energy used by R0 and both RC resistances.',
  },
  {
    id: 'hysteresis', parameters: ['hystV'], requiredForCore: false,
    description: 'Hysteresis amplitude; the model time constant remains fixed.',
  },
]);
export const ECM_TUNING_GROUP_CONTRACT_CHECKSUM = semanticDigest(ECM_TUNING_GROUPS);

const GROUP_BY_ID = new Map(ECM_TUNING_GROUPS.map((group) => [group.id, group]));
const GROUP_ORDER = new Map(ECM_TUNING_GROUPS.map((group, index) => [group.id, index]));
const INPUT_KEYS = new Set([
  'cell', 'calibrationDatasets', 'validationDatasets', 'params', 'groups',
  'maxEvaluations', 'maxIntegrationSteps', 'maxModuleWeightedIntegrationSteps',
  'maxSamplesPerDataset', 'acceptance',
]);
const ACCEPTANCE_KEYS = Object.freeze([
  'maxVoltageRmseMvPerCell', 'maxVoltageMaxAbsMvPerCell',
  'maxTemperatureRmseC', 'maxTemperatureMaxAbsC',
  'minValidationDatasets', 'minIncludedSamplesPerDataset', 'requiredModes',
  'requireNoHoldoutRegression', 'requireNoFittedParameterAtBound',
]);
const SEGMENT_MODE_ORDER = Object.freeze(['charge', 'discharge', 'dynamic', 'pulse', 'rest', 'thermal-soak', 'other']);
const SEGMENT_MODES = new Set(SEGMENT_MODE_ORDER);
const DEFAULT_MAX_EVALUATIONS = 2_000;
const DEFAULT_MAX_INTEGRATION_STEPS = 100_000_000;
const DEFAULT_MAX_MODULE_WEIGHTED_INTEGRATION_STEPS = 100_000_000;
const DEFAULT_MAX_SAMPLES = 5_000;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function finiteInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || !(value > 0)) throw new RangeError(`${label} must be a finite number greater than zero.`);
  return value;
}

function acceptanceThresholds(value) {
  object(value, 'acceptance');
  const unsupported = Object.keys(value).filter((key) => !ACCEPTANCE_KEYS.includes(key));
  const missing = ACCEPTANCE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unsupported.length) throw new TypeError(`acceptance contains unsupported field(s): ${unsupported.join(', ')}.`);
  if (missing.length) throw new TypeError(`acceptance is missing required field(s): ${missing.join(', ')}.`);
  const maxVoltageRmseMvPerCell = positiveFinite(value.maxVoltageRmseMvPerCell, 'acceptance.maxVoltageRmseMvPerCell');
  const maxVoltageMaxAbsMvPerCell = positiveFinite(value.maxVoltageMaxAbsMvPerCell, 'acceptance.maxVoltageMaxAbsMvPerCell');
  const temperaturePair = [value.maxTemperatureRmseC, value.maxTemperatureMaxAbsC];
  if ((temperaturePair[0] === null) !== (temperaturePair[1] === null)) {
    throw new TypeError('acceptance.maxTemperatureRmseC and maxTemperatureMaxAbsC must both be null or both be finite positive limits.');
  }
  const maxTemperatureRmseC = temperaturePair[0] === null
    ? null : positiveFinite(temperaturePair[0], 'acceptance.maxTemperatureRmseC');
  const maxTemperatureMaxAbsC = temperaturePair[1] === null
    ? null : positiveFinite(temperaturePair[1], 'acceptance.maxTemperatureMaxAbsC');
  const minValidationDatasets = finiteInteger(value.minValidationDatasets,
    'acceptance.minValidationDatasets', 1, MAX_CALIBRATION_DATASETS);
  const minIncludedSamplesPerDataset = finiteInteger(value.minIncludedSamplesPerDataset,
    'acceptance.minIncludedSamplesPerDataset', 3, 250_000);
  if (!Array.isArray(value.requiredModes) || value.requiredModes.length < 1
    || value.requiredModes.length > SEGMENT_MODES.size) {
    throw new RangeError(`acceptance.requiredModes must contain 1 to ${SEGMENT_MODES.size} unique segment modes.`);
  }
  const seen = new Set();
  for (let index = 0; index < value.requiredModes.length; index++) {
    const mode = value.requiredModes[index];
    if (typeof mode !== 'string' || !SEGMENT_MODES.has(mode)) {
      throw new TypeError(`acceptance.requiredModes[${index}] is not a canonical calibration segment mode.`);
    }
    if (seen.has(mode)) throw new TypeError(`acceptance.requiredModes contains duplicate mode "${mode}".`);
    seen.add(mode);
  }
  const requiredModes = SEGMENT_MODE_ORDER.filter((mode) => seen.has(mode));
  for (const key of ['requireNoHoldoutRegression', 'requireNoFittedParameterAtBound']) {
    if (typeof value[key] !== 'boolean') throw new TypeError(`acceptance.${key} must be boolean.`);
    if (value[key] !== true) {
      throw new RangeError(`acceptance.${key} must be true in ${ECM_TUNING_PLAN_FORMAT}; automatic tuning cannot disable this safety invariant.`);
    }
  }
  return {
    maxVoltageRmseMvPerCell,
    maxVoltageMaxAbsMvPerCell,
    maxTemperatureRmseC,
    maxTemperatureMaxAbsC,
    minValidationDatasets,
    minIncludedSamplesPerDataset,
    requiredModes,
    requireNoHoldoutRegression: value.requireNoHoldoutRegression,
    requireNoFittedParameterAtBound: value.requireNoFittedParameterAtBound,
  };
}

function normalizeGroups(value) {
  if (value === undefined || value === 'auto') return { mode: 'auto', ids: ECM_TUNING_GROUPS.map(({ id }) => id) };
  if (!Array.isArray(value) || value.length < 1 || value.length > ECM_TUNING_GROUPS.length) {
    throw new RangeError(`groups must equal "auto" or contain 1 to ${ECM_TUNING_GROUPS.length} group ids.`);
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const id = value[index];
    if (typeof id !== 'string' || !GROUP_BY_ID.has(id)) {
      throw new TypeError(`groups[${index}] must be one of: ${ECM_TUNING_GROUPS.map(({ id: groupId }) => groupId).join(', ')}.`);
    }
    if (seen.has(id)) throw new TypeError(`groups contains duplicate group "${id}".`);
    seen.add(id);
  }
  return { mode: 'explicit', ids: [...seen].sort((a, b) => GROUP_ORDER.get(a) - GROUP_ORDER.get(b)) };
}

function completeParams(cell, overrides) {
  if (overrides !== null && overrides !== undefined) object(overrides, 'params');
  const supplied = overrides || {};
  const unknown = Object.keys(supplied).filter((key) => !Object.hasOwn(PARAM_BY_ID, key));
  if (unknown.length) throw new TypeError(`Unknown ECM tuning parameter override(s): ${unknown.join(', ')}.`);
  const params = { ...defaultParams(cell), ...supplied };
  for (const spec of PARAM_SPEC) {
    const value = params[spec.id];
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
      throw new RangeError(`params.${spec.id} must be finite and from ${spec.min} to ${spec.max}; the tuning plan never repairs or clamps it.`);
    }
  }
  return params;
}

function asDatasetList(value, label, purpose, { allowEmpty = false } = {}) {
  const inputs = value === undefined && allowEmpty ? [] : (Array.isArray(value) ? value : [value]);
  if ((!allowEmpty && inputs.length < 1) || inputs.length > MAX_CALIBRATION_DATASETS) {
    throw new RangeError(`${label} must contain ${allowEmpty ? '0' : '1'} to ${MAX_CALIBRATION_DATASETS} canonical datasets.`);
  }
  return inputs.map((input) => {
    const dataset = readCalibrationDataset(input);
    if (dataset.purpose !== purpose) {
      throw new TypeError(`Dataset "${dataset.id}" has purpose "${dataset.purpose}"; ${label} require purpose "${purpose}".`);
    }
    return dataset;
  });
}

function selectedMask(length, selectedIndices) {
  const mask = new Array(length).fill(false);
  for (const index of selectedIndices) mask[index] = true;
  return mask;
}

function representedPreparedModes(dataset, prepared) {
  const modes = new Set();
  const factor = prepared.preprocessing.factor;
  let segmentIndex = 0;
  for (const block of prepared.selectedIndices) {
    const start = block * factor;
    const end = start + factor;
    while (dataset.segments[segmentIndex]?.endIndexExclusive <= start) segmentIndex++;
    let cursor = segmentIndex;
    let position = start;
    let blockMode = null;
    let consistent = true;
    while (position < end) {
      const segment = dataset.segments[cursor];
      if (!segment || segment.startIndex > position || !segment.include) {
        consistent = false;
        break;
      }
      if (blockMode === null) blockMode = segment.mode;
      else if (blockMode !== segment.mode) consistent = false;
      position = Math.min(end, segment.endIndexExclusive);
      if (position >= segment.endIndexExclusive) cursor++;
    }
    if (consistent && position === end && blockMode !== null) modes.add(blockMode);
  }
  return SEGMENT_MODE_ORDER.filter((mode) => modes.has(mode));
}

function longestRuns(currentA, included, pulseThresholdA, restThresholdA, dtS) {
  let pulse = 0, rest = 0, currentPulse = 0, currentRest = 0;
  for (let index = 0; index < currentA.length; index++) {
    if (!included[index]) {
      // Excluded warm-up/history still drives the later model state, but it is
      // not scored evidence. Never join excitation windows across that gap.
      currentPulse = 0;
      currentRest = 0;
      continue;
    }
    const current = currentA[index];
    if (Math.abs(current) >= pulseThresholdA) {
      currentPulse++;
      currentRest = 0;
    } else if (Math.abs(current) <= restThresholdA) {
      currentRest++;
      currentPulse = 0;
    } else {
      currentPulse = 0;
      currentRest = 0;
    }
    pulse = Math.max(pulse, currentPulse);
    rest = Math.max(rest, currentRest);
  }
  return { maximumPulseS: pulse * dtS, maximumRestS: rest * dtS };
}

function trialMetrics(dataset, prepared, cell, params) {
  const capacityAh = cell.capacityAh * dataset.binding.parallelCells;
  if (!(capacityAh > 0) || !Number.isFinite(capacityAh)) {
    throw new RangeError(`Cell "${cell.id}" must provide finite positive capacityAh for ECM excitation planning.`);
  }
  const currentA = prepared.measured.i;
  const voltageV = prepared.measured.v;
  const dtS = prepared.measured.dtS;
  const stepThresholdA = ECM_TUNING_GATE_POLICY.minimumStepCRate * capacityAh;
  const restThresholdA = ECM_TUNING_GATE_POLICY.restCurrentCRateMax * capacityAh;
  let previousIncluded = 0, previousWasIncluded = true;
  let qualifyingEdges = 0, maximumCurrentCRate = 0;
  let soc = dataset.binding.startSoC;
  const mask = selectedMask(currentA.length, prepared.selectedIndices);
  let includedSocBasisMin = Infinity, includedSocBasisMax = -Infinity;
  let excitedSocBasisMin = Infinity, excitedSocBasisMax = -Infinity;
  let excitedSocBasisSum = 0, excitedSocBasisCount = 0;
  let firstExcitedSocBasis = null;
  let chargeMinSoc = Infinity, chargeMaxSoc = -Infinity;
  let dischargeMinSoc = Infinity, dischargeMaxSoc = -Infinity;
  let hysteresisState = 0;
  let minimumScoredHysteresisState = Infinity;
  let maximumScoredHysteresisState = -Infinity;
  for (let index = 0; index < currentA.length; index++) {
    const current = currentA[index];
    if (mask[index]) {
      if (previousWasIncluded && Math.abs(current - previousIncluded) >= stepThresholdA) qualifyingEdges++;
      previousIncluded = current;
      previousWasIncluded = true;
      maximumCurrentCRate = Math.max(maximumCurrentCRate, Math.abs(current) / capacityAh);
    } else {
      previousWasIncluded = false;
    }
    const deltaAh = current * dtS / 3600;
    soc -= (current >= 0 ? deltaAh : deltaAh * params.coulombEff) / capacityAh;
    soc = Math.max(0, Math.min(1, soc));
    if (current > 0) hysteresisState = Math.max(-1, hysteresisState - dtS / 600);
    else if (current < 0) hysteresisState = Math.min(1, hysteresisState + dtS / 600);
    if (mask[index]) {
      const basis = 4 * (soc - 0.5) ** 2;
      includedSocBasisMin = Math.min(includedSocBasisMin, basis);
      includedSocBasisMax = Math.max(includedSocBasisMax, basis);
      if (Math.abs(current) >= stepThresholdA) {
        if (firstExcitedSocBasis === null) firstExcitedSocBasis = basis;
        excitedSocBasisMin = Math.min(excitedSocBasisMin, basis);
        excitedSocBasisMax = Math.max(excitedSocBasisMax, basis);
        excitedSocBasisSum += basis;
        excitedSocBasisCount++;
      }
      minimumScoredHysteresisState = Math.min(minimumScoredHysteresisState, hysteresisState);
      maximumScoredHysteresisState = Math.max(maximumScoredHysteresisState, hysteresisState);
    }
    if (mask[index] && current <= -stepThresholdA) {
      chargeMinSoc = Math.min(chargeMinSoc, soc);
      chargeMaxSoc = Math.max(chargeMaxSoc, soc);
    } else if (mask[index] && current >= stepThresholdA) {
      dischargeMinSoc = Math.min(dischargeMinSoc, soc);
      dischargeMaxSoc = Math.max(dischargeMaxSoc, soc);
    }
  }
  const { maximumPulseS, maximumRestS } = longestRuns(
    currentA, mask, stepThresholdA, restThresholdA, dtS,
  );
  const firstRested = mask[0] && Math.abs(currentA[0]) <= restThresholdA;
  const ocvResidualVPerCell = firstRested
    ? Math.abs(voltageV[0] / dataset.binding.seriesCells
      - ocvCell(cell, dataset.binding.startSoC))
    : null;
  const temperature = dataset.signals.temperatureC;
  const maximumTemperatureDepartureK = Array.isArray(temperature)
    ? temperature.reduce((maximum, value) => Math.max(maximum, Math.abs(value - dataset.binding.ambientC)), 0)
    : null;
  return {
    qualifyingEdges,
    maximumCurrentCRate,
    maximumPulseS,
    maximumRestS,
    includedSocBasisMin,
    includedSocBasisMax,
    excitedSocBasisMin: Number.isFinite(excitedSocBasisMin) ? excitedSocBasisMin : null,
    excitedSocBasisMax: Number.isFinite(excitedSocBasisMax) ? excitedSocBasisMax : null,
    meanExcitedSocBasis: excitedSocBasisCount > 0
      ? excitedSocBasisSum / excitedSocBasisCount : null,
    firstExcitedSocBasis,
    excitedSocSampleCount: excitedSocBasisCount,
    ocvResidualVPerCell,
    restedOcvBaselinePass: ocvResidualVPerCell !== null
      && ocvResidualVPerCell <= ECM_TUNING_GATE_POLICY.maximumOcvResidualVPerCell,
    hasCharge: Number.isFinite(chargeMinSoc),
    hasDischarge: Number.isFinite(dischargeMinSoc),
    chargeSocRange: Number.isFinite(chargeMinSoc) ? [chargeMinSoc, chargeMaxSoc] : null,
    dischargeSocRange: Number.isFinite(dischargeMinSoc) ? [dischargeMinSoc, dischargeMaxSoc] : null,
    scoredHysteresisStateRange: Number.isFinite(minimumScoredHysteresisState)
      ? [minimumScoredHysteresisState, maximumScoredHysteresisState] : null,
    maximumTemperatureDepartureK,
  };
}

function protocolDigest(dataset, prepared, varyingField) {
  const binding = {
    cellId: dataset.binding.cellId,
    seriesCells: dataset.binding.seriesCells,
    parallelCells: dataset.binding.parallelCells,
    moduleCount: dataset.binding.moduleCount,
    initialState: dataset.binding.initialState,
  };
  if (varyingField !== 'startSoC') binding.startSoC = dataset.binding.startSoC;
  if (varyingField !== 'ambientC') binding.ambientC = dataset.binding.ambientC;
  return semanticDigest({
    domain: `battery-design/ecm-tuning-protocol/${varyingField}/1`,
    binding,
    preprocessingPolicyChecksum: CALIBRATION_PREPROCESSING_POLICY.checksum,
    samplePeriodS: prepared.measured.dtS,
    currentA: prepared.measured.i,
    selectedIndices: prepared.selectedIndices,
    currentHold: dataset.conventions.currentHold,
    sampleAlignment: dataset.conventions.sampleAlignment,
  });
}

function preparedElectricalObservationChecksum(prepared) {
  return semanticDigest({
    format: 'battery-design/ecm-tuning-prepared-electrical-observation@1',
    preprocessingPolicyChecksum: CALIBRATION_PREPROCESSING_POLICY.checksum,
    samplePeriodS: prepared.measured.dtS,
    currentHistoryA: prepared.measured.i,
    selectedIndices: prepared.selectedIndices,
    scoredVoltageV: prepared.selectedIndices.map((index) => prepared.measured.v[index]),
  });
}

function trialRecords(datasets, cell, params, maxSamplesPerDataset) {
  return datasets.map((dataset) => {
    for (const key of ['tool', 'toolVersion', 'model', 'runId']) {
      if (typeof dataset.source[key] !== 'string' || !dataset.source[key].trim()) {
        throw new TypeError(`Dataset "${dataset.id}" source.${key} must be a non-null, non-empty string for governed ECM tuning source-run identity.`);
      }
    }
    const identities = calibrationDatasetIdentities(dataset);
    const prepared = preprocessCalibrationDataset(dataset, maxSamplesPerDataset);
    return {
      dataset,
      prepared,
      record: {
        id: dataset.id,
        purpose: dataset.purpose,
        datasetChecksum: dataset.checksum,
        observationChecksum: identities.observationChecksum,
        trialContentChecksum: identities.trialContentChecksum,
        electricalHistoryChecksum: identities.electricalHistoryChecksum,
        scoredElectricalObservationChecksum: identities.scoredElectricalObservationChecksum,
        preparedElectricalObservationChecksum: preparedElectricalObservationChecksum(prepared),
        rawSha256: dataset.source.rawSha256,
        sourceIdentityChecksum: semanticDigest({
          domain: 'battery-design/ecm-tuning-source-run/1',
          tool: dataset.source.tool,
          toolVersion: dataset.source.toolVersion,
          model: dataset.source.model,
          runId: dataset.source.runId,
        }),
        samples: dataset.signals.currentA.length,
        samplePeriodS: dataset.samplePeriodS,
        preprocessing: {
          policyChecksum: prepared.policyChecksum,
          method: prepared.preprocessing.method,
          factor: prepared.preprocessing.factor,
          usedSamples: prepared.preprocessing.usedSamples,
          usedSamplePeriodS: prepared.preprocessing.usedSamplePeriodS,
          usedIncludedSamples: prepared.preprocessing.usedIncludedSamples,
          mixedBoundaryBlocks: prepared.preprocessing.mixedBoundaryBlocks,
          droppedTailSamples: prepared.preprocessing.droppedTailSamples,
          representedModes: representedPreparedModes(dataset, prepared),
        },
        binding: { ...dataset.binding },
        protocolChecksums: {
          varyingStartSoC: protocolDigest(dataset, prepared, 'startSoC'),
          varyingAmbientC: protocolDigest(dataset, prepared, 'ambientC'),
        },
        metrics: trialMetrics(dataset, prepared, cell, params),
      },
    };
  }).sort((left, right) => left.record.trialContentChecksum.localeCompare(right.record.trialContentChecksum)
    || left.record.datasetChecksum.localeCompare(right.record.datasetChecksum));
}

function rejectDuplicates(records, label) {
  for (const key of [
    'datasetChecksum', 'observationChecksum', 'trialContentChecksum',
    'rawSha256', 'sourceIdentityChecksum',
  ]) {
    const seen = new Set();
    for (const { record } of records) {
      if (record[key] === null) continue;
      if (seen.has(record[key])) throw new TypeError(`${label} duplicate ${key} ${record[key]}.`);
      seen.add(record[key]);
    }
  }
  for (const key of [
    'scoredElectricalObservationChecksum', 'preparedElectricalObservationChecksum',
  ]) {
    const scoredByCondition = new Map();
    for (const entry of records) {
      const checksum = entry.record[key];
      const prior = scoredByCondition.get(checksum) ?? [];
      for (const other of prior) {
        if (other.dataset.binding.startSoC === entry.dataset.binding.startSoC
          && other.dataset.binding.ambientC === entry.dataset.binding.ambientC) {
          throw new TypeError(`${label} duplicate ${key} ${checksum} at the same startSoC and ambientC; changing only unscored or preprocessing-discarded evidence does not create another electrical trial.`);
        }
      }
      prior.push(entry);
      scoredByCondition.set(checksum, prior);
    }
  }
}

function assertCompatible(records, cell, reference = null) {
  const expected = reference || records[0]?.dataset.binding;
  for (const { dataset } of records) {
    if (dataset.binding.cellId !== cell.id) {
      throw new TypeError(`Dataset "${dataset.id}" is bound to cell "${dataset.binding.cellId}" rather than "${cell.id}".`);
    }
    for (const key of ['cellId', 'seriesCells', 'parallelCells', 'moduleCount']) {
      if (dataset.binding[key] !== expected[key]) {
        throw new TypeError(`Dataset "${dataset.id}" has incompatible binding.${key}; ECM tuning requires one cell/S/P/module topology.`);
      }
    }
  }
  return expected;
}

function assertAcceptanceCoverage(records, label, acceptance) {
  const modes = new Set();
  for (const { dataset, record } of records) {
    const includedSamples = record.preprocessing.usedIncludedSamples;
    if (includedSamples < acceptance.minIncludedSamplesPerDataset) {
      throw new RangeError(`Dataset "${dataset.id}" has ${includedSamples.toLocaleString()} preprocessed included samples; acceptance requires at least ${acceptance.minIncludedSamplesPerDataset.toLocaleString()} per whole trial.`);
    }
    for (const mode of record.preprocessing.representedModes) modes.add(mode);
  }
  const missing = acceptance.requiredModes.filter((mode) => !modes.has(mode));
  if (missing.length) throw new TypeError(`${label} do not cover acceptance.requiredModes: ${missing.join(', ')}.`);
}

function assertValidationTemperatureEvidence(validation, acceptance) {
  if (acceptance.maxTemperatureRmseC === null) return;
  if (!validation.some(({ dataset }) => (
    Array.isArray(dataset.signals.temperatureC)
      && dataset.conventions.temperatureLocation === 'module-maximum'
  ))) {
    throw new TypeError('At least one validation dataset must carry module-maximum temperature because the acceptance policy declares temperature RMSE and maximum-absolute limits. Other validation trials may carry cell-average temperature solely for Arrhenius observability.');
  }
}

function rejectCrossSetLeakage(calibration, validation) {
  for (const key of [
    'observationChecksum', 'trialContentChecksum', 'scoredElectricalObservationChecksum',
    'preparedElectricalObservationChecksum',
    'rawSha256', 'sourceIdentityChecksum',
  ]) {
    const calibrationValues = new Set(calibration.map(({ record }) => record[key]).filter((value) => value !== null));
    for (const { record } of validation) {
      if (record[key] !== null && calibrationValues.has(record[key])) {
        throw new TypeError(`Validation dataset "${record.id}" reuses calibration ${key}; changing purpose, provenance, binding or segment selection does not create an exact-disjoint caller-declared holdout.`);
      }
    }
  }
}

function grouped(records, key) {
  const result = new Map();
  for (const entry of records) {
    const digest = entry.record.protocolChecksums[key];
    if (!result.has(digest)) result.set(digest, []);
    result.get(digest).push(entry);
  }
  return [...result.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function bestFamily(families, analyze) {
  const candidates = families.map(([checksum, entries]) => ({
    checksum,
    entries,
    ...analyze(entries),
  }));
  const passing = candidates.filter(({ pass }) => pass);
  const pool = passing.length ? passing : candidates;
  return pool.sort((left, right) => right.score - left.score
    || left.checksum.localeCompare(right.checksum))[0] ?? null;
}

function gate(id, pass, detail, metrics = {}) {
  return { id, status: pass ? 'pass' : 'fail', detail, metrics };
}

function groupGates(records, params) {
  const policy = ECM_TUNING_GATE_POLICY;
  const validOcv = ({ record }) => record.metrics.restedOcvBaselinePass;
  const restedOcvGate = (entries) => {
    const rested = entries.filter(({ record }) => record.metrics.ocvResidualVPerCell !== null);
    const maximumResidual = rested.length
      ? Math.max(...rested.map(({ record }) => record.metrics.ocvResidualVPerCell)) : null;
    const pass = entries.length > 0
      && rested.length === entries.length
      && maximumResidual <= policy.maximumOcvResidualVPerCell;
    return gate('rested-ocv-baseline', pass,
      `Every calibration trial used by a tuning group must start with an included rested sample agreeing with the fixed catalog OCV within ${policy.maximumOcvResidualVPerCell} V per cell.`,
      {
        trialCount: entries.length,
        restedTrialCount: rested.length,
        maximumResidualVPerCell: maximumResidual,
        limitVPerCell: policy.maximumOcvResidualVPerCell,
      });
  };
  const resistancePass = (entries) => entries.length > 0 && entries.every(({ record }) => (
    record.metrics.qualifyingEdges >= policy.minimumOhmicEdges
      && record.metrics.maximumCurrentCRate >= policy.minimumStepCRate
  ));
  const familyResistanceGate = (entries) => gate(
    'matched-family-resistance-excitation',
    resistancePass(entries),
    `Every matched trial must contain at least ${policy.minimumOhmicEdges} included current edges and reach ${policy.minimumStepCRate}C so resistance sensitivity is not inferred from zero-current coverage alone.`,
    {
      familyTrialCount: entries.length,
      observedMinimumEdges: entries.length
        ? Math.min(...entries.map(({ record }) => record.metrics.qualifyingEdges)) : null,
      observedMinimumCurrentCRate: entries.length
        ? Math.min(...entries.map(({ record }) => record.metrics.maximumCurrentCRate)) : null,
      minimumEdgesPerTrial: policy.minimumOhmicEdges,
      minimumCurrentCRate: policy.minimumStepCRate,
    },
  );

  const ohmicEntries = records.filter((entry) => validOcv(entry)
    && entry.record.metrics.maximumCurrentCRate >= policy.minimumStepCRate);
  const totalEdges = ohmicEntries.reduce((sum, { record }) => (
    sum + record.metrics.qualifyingEdges
  ), 0);
  const ohmic = [
    restedOcvGate(ohmicEntries),
    gate('current-step-count', totalEdges >= policy.minimumOhmicEdges,
      `At least ${policy.minimumOhmicEdges} current edges of ${policy.minimumStepCRate}C or more are required.`,
      { qualifyingEdges: totalEdges, minimumEdges: policy.minimumOhmicEdges }),
  ];

  const fastEligible = records.filter(({ record: trial }) => validOcv({ record: trial })
    && trial.preprocessing.usedSamplePeriodS <= params.rc1TauS * policy.maximumFastSampleTauFraction
    && trial.metrics.qualifyingEdges >= policy.minimumOhmicEdges
    && trial.metrics.maximumPulseS >= params.rc1TauS * policy.minimumFastPulseTauMultiples
    && trial.metrics.maximumRestS >= params.rc1TauS * policy.minimumFastRestTauMultiples);
  const slowEligible = records.filter(({ record: trial }) => validOcv({ record: trial })
    && trial.preprocessing.usedSamplePeriodS <= params.rc2TauS * policy.maximumSlowSampleTauFraction
    && trial.metrics.qualifyingEdges >= policy.minimumOhmicEdges
    && trial.metrics.maximumPulseS >= params.rc2TauS * policy.minimumSlowPulseTauMultiples
    && trial.metrics.maximumRestS >= params.rc2TauS * policy.minimumSlowRestTauMultiples);

  const socFamily = bestFamily(grouped(records, 'varyingStartSoC'), (entries) => {
    const bases = [...new Set(entries
      .map(({ record }) => record.metrics.firstExcitedSocBasis)
      .filter(Number.isFinite)
      .map((value) => Number(value.toFixed(12))))].sort((left, right) => left - right);
    const span = bases.length ? bases.at(-1) - bases[0] : 0;
    const coverage = bases.length >= policy.minimumSocBasisBins
      && span >= policy.minimumSocBasisSpan
      && bases.some((value) => value <= policy.maximumMidSocBasis)
      && bases.some((value) => value >= policy.minimumExtremeSocBasis);
    const ocv = entries.length > 0 && entries.every(validOcv);
    const resistance = resistancePass(entries);
    return {
      pass: coverage && ocv && resistance,
      score: bases.length * 100 + entries.length,
      bases,
      span,
      coverage,
    };
  });

  const temperatureFamily = bestFamily(grouped(records, 'varyingAmbientC'), (entries) => {
    const ambientValues = [...new Set(entries.map(({ dataset }) => (
      dataset.binding.ambientC
    )))].sort((left, right) => left - right);
    const ambientSpanK = ambientValues.length ? ambientValues.at(-1) - ambientValues[0] : 0;
    const temperatureChannelsValid = entries.length > 0 && entries.every(({ dataset, record }) => (
      dataset.conventions.temperatureLocation === policy.requiredArrheniusTemperatureLocation
        && record.metrics.maximumTemperatureDepartureK <= policy.maximumIsothermalDepartureK
    ));
    const coverage = ambientValues.length >= policy.minimumAmbientPoints
      && ambientSpanK >= policy.minimumAmbientSpanK
      && ambientValues.some((value) => (
        Math.abs(value - params.tRefC) <= policy.referenceTemperatureToleranceK
      ))
      && temperatureChannelsValid;
    const ocv = entries.length > 0 && entries.every(validOcv);
    const resistance = resistancePass(entries);
    return {
      pass: coverage && ocv && resistance,
      score: ambientValues.length * 100 + entries.length,
      ambientValues,
      ambientSpanK,
      temperatureChannelsValid,
      coverage,
    };
  });

  let chargeMin = Infinity, chargeMax = -Infinity, dischargeMin = Infinity, dischargeMax = -Infinity;
  const hysteresisEntries = records.filter(validOcv);
  for (const { record: trial } of hysteresisEntries) {
    if (trial.metrics.chargeSocRange) {
      chargeMin = Math.min(chargeMin, trial.metrics.chargeSocRange[0]);
      chargeMax = Math.max(chargeMax, trial.metrics.chargeSocRange[1]);
    }
    if (trial.metrics.dischargeSocRange) {
      dischargeMin = Math.min(dischargeMin, trial.metrics.dischargeSocRange[0]);
      dischargeMax = Math.max(dischargeMax, trial.metrics.dischargeSocRange[1]);
    }
  }
  const hysteresisOverlap = Number.isFinite(chargeMin) && Number.isFinite(dischargeMin)
    ? Math.max(0, Math.min(chargeMax, dischargeMax) - Math.max(chargeMin, dischargeMin)) : 0;

  const withOcv = (entries, gates) => [restedOcvGate(entries), ...gates];
  const socEntries = socFamily?.entries ?? [];
  const temperatureEntries = temperatureFamily?.entries ?? [];
  return {
    'ohmic': { gates: ohmic, entries: ohmicEntries },
    'fast-rc': {
      gates: withOcv(fastEligible, [gate('fast-time-resolution-and-horizon', fastEligible.length > 0,
        `A whole trial must resolve rc1TauS at <=${policy.maximumFastSampleTauFraction} tau and contain pulse/rest windows of at least ${policy.minimumFastPulseTauMultiples}/${policy.minimumFastRestTauMultiples} tau.`,
        { eligibleTrialCount: fastEligible.length, referenceTauS: params.rc1TauS })]),
      entries: fastEligible,
    },
    'slow-rc': {
      gates: withOcv(slowEligible, [
        gate('slow-time-resolution-and-horizon', slowEligible.length > 0,
          `A whole trial must resolve rc2TauS at <=${policy.maximumSlowSampleTauFraction} tau and contain pulse/rest windows of at least ${policy.minimumSlowPulseTauMultiples}/${policy.minimumSlowRestTauMultiples} tau.`,
          { eligibleTrialCount: slowEligible.length, referenceTauS: params.rc2TauS }),
        gate('ordered-separated-rc-time-constants', params.rc2TauS / params.rc1TauS >= policy.minimumRcTimeConstantSeparationRatio,
          `The initial slow time constant must be at least ${policy.minimumRcTimeConstantSeparationRatio} times the fast time constant so the two permutation-symmetric branches are structurally distinguishable.`,
          { rc1TauS: params.rc1TauS, rc2TauS: params.rc2TauS, ratio: params.rc2TauS / params.rc1TauS, minimumRatio: policy.minimumRcTimeConstantSeparationRatio }),
      ]),
      entries: slowEligible,
    },
    'soc-dependence': {
      gates: withOcv(socEntries, [familyResistanceGate(socEntries), gate(
        'matched-soc-basis-coverage', socFamily?.coverage === true,
        'One exact preprocessed current/ambient protocol family must carry nonzero-current scored evidence at mid-SoC and an extreme across three distinguishable symmetric SoC-basis levels.',
        {
          protocolChecksum: socFamily?.checksum ?? null,
          distinctBasisCount: socFamily?.bases.length ?? 0,
          basisSpan: socFamily?.span ?? 0,
          basisValues: socFamily?.bases ?? [],
        },
      )]),
      entries: socFamily?.pass ? socEntries : [],
    },
    'arrhenius': {
      gates: withOcv(temperatureEntries, [familyResistanceGate(temperatureEntries), gate(
        'matched-isothermal-temperature-coverage', temperatureFamily?.coverage === true,
        'One exact preprocessed current/SoC protocol family must contain three near-isothermal cell-average trials spanning 20 K and the fixed reference temperature.',
        {
          protocolChecksum: temperatureFamily?.checksum ?? null,
          ambientValuesC: temperatureFamily?.ambientValues ?? [],
          ambientSpanK: temperatureFamily?.ambientSpanK ?? 0,
          temperatureChannelsValid: temperatureFamily?.temperatureChannelsValid ?? false,
          referenceTemperatureC: params.tRefC,
        },
      )]),
      entries: temperatureFamily?.pass ? temperatureEntries : [],
    },
    'hysteresis': {
      gates: withOcv(hysteresisEntries, [
        gate('bidirectional-soc-overlap', hysteresisOverlap >= policy.minimumHysteresisSocOverlap,
          `Charge and discharge excitation must overlap across at least ${policy.minimumHysteresisSocOverlap} SoC.`,
          { overlap: hysteresisOverlap, minimumOverlap: policy.minimumHysteresisSocOverlap }),
        gate('bidirectional-hysteresis-state-excursion', hysteresisEntries.some(({ record }) => (
          record.metrics.scoredHysteresisStateRange?.[0] <= -policy.minimumHysteresisStateExcursion
        )) && hysteresisEntries.some(({ record }) => (
          record.metrics.scoredHysteresisStateRange?.[1] >= policy.minimumHysteresisStateExcursion
        )),
        `Scored charge and discharge evidence must drive the fixed 600 s hysteresis state at least ±${policy.minimumHysteresisStateExcursion}; current signs without nonzero duration cannot observe hystV.`,
        {
          minimumExcursion: policy.minimumHysteresisStateExcursion,
          scoredStateRanges: hysteresisEntries.map(({ record }) => record.metrics.scoredHysteresisStateRange),
        }),
      ]),
      entries: hysteresisOverlap >= policy.minimumHysteresisSocOverlap
        && hysteresisEntries.some(({ record }) => (
          record.metrics.scoredHysteresisStateRange?.[0] <= -policy.minimumHysteresisStateExcursion
        )) && hysteresisEntries.some(({ record }) => (
          record.metrics.scoredHysteresisStateRange?.[1] >= policy.minimumHysteresisStateExcursion
        ))
        ? hysteresisEntries : [],
    },
  };
}

function assertValidationExcitation(validation, activeGroups, params) {
  const policy = ECM_TUNING_GATE_POLICY;
  for (const { record } of validation) {
    if (!record.metrics.restedOcvBaselinePass) {
      throw new RangeError(`Validation dataset "${record.id}" lacks the governed rested OCV baseline required to evaluate fitted electrical parameters.`);
    }
    if (record.metrics.qualifyingEdges < policy.minimumOhmicEdges
      || record.metrics.maximumCurrentCRate < policy.minimumStepCRate) {
      throw new RangeError(`Validation dataset "${record.id}" must contain at least ${policy.minimumOhmicEdges} preprocessed current edges and reach ${policy.minimumStepCRate}C; a zero-current or weak holdout cannot observe fitted electrical parameters.`);
    }
  }
  const active = new Set(activeGroups.map(({ id }) => id));
  if (active.has('fast-rc') && !validation.some(({ record }) => (
    record.preprocessing.usedSamplePeriodS <= params.rc1TauS * policy.maximumFastSampleTauFraction
      && record.metrics.maximumPulseS >= params.rc1TauS * policy.minimumFastPulseTauMultiples
      && record.metrics.maximumRestS >= params.rc1TauS * policy.minimumFastRestTauMultiples
  ))) {
    throw new RangeError('Validation datasets do not resolve the active fast-rc group after deterministic preprocessing.');
  }
  if (active.has('slow-rc') && !validation.some(({ record }) => (
    record.preprocessing.usedSamplePeriodS <= params.rc2TauS * policy.maximumSlowSampleTauFraction
      && record.metrics.maximumPulseS >= params.rc2TauS * policy.minimumSlowPulseTauMultiples
      && record.metrics.maximumRestS >= params.rc2TauS * policy.minimumSlowRestTauMultiples
  ))) {
    throw new RangeError('Validation datasets do not resolve the active slow-rc group after deterministic preprocessing.');
  }
  if (active.has('soc-dependence') && !validation.some(({ record }) => (
    record.metrics.excitedSocBasisMax >= policy.minimumExtremeSocBasis
  ))) {
    throw new RangeError(`Validation datasets do not contain included nonzero-current evidence at an off-mid SoC basis of at least ${policy.minimumExtremeSocBasis}; a mid-SoC holdout cannot observe the active soc-dependence group.`);
  }
  if (active.has('arrhenius') && !validation.some(({ dataset, record }) => (
    dataset.conventions.temperatureLocation === policy.requiredArrheniusTemperatureLocation
      && record.metrics.maximumTemperatureDepartureK <= policy.maximumIsothermalDepartureK
      && Math.abs(dataset.binding.ambientC - params.tRefC) > policy.referenceTemperatureToleranceK
  ))) {
    throw new RangeError('Validation datasets do not contain an independent near-isothermal cell-average temperature condition that can observe the active Arrhenius group.');
  }
  if (active.has('hysteresis')) {
    let chargeMin = Infinity, chargeMax = -Infinity;
    let dischargeMin = Infinity, dischargeMax = -Infinity;
    for (const { record } of validation) {
      if (record.metrics.chargeSocRange) {
        chargeMin = Math.min(chargeMin, record.metrics.chargeSocRange[0]);
        chargeMax = Math.max(chargeMax, record.metrics.chargeSocRange[1]);
      }
      if (record.metrics.dischargeSocRange) {
        dischargeMin = Math.min(dischargeMin, record.metrics.dischargeSocRange[0]);
        dischargeMax = Math.max(dischargeMax, record.metrics.dischargeSocRange[1]);
      }
    }
    const overlap = Number.isFinite(chargeMin) && Number.isFinite(dischargeMin)
      ? Math.max(0, Math.min(chargeMax, dischargeMax) - Math.max(chargeMin, dischargeMin)) : 0;
    if (overlap < policy.minimumHysteresisSocOverlap) {
      throw new RangeError(`Validation datasets provide ${overlap} charge/discharge SoC overlap; the active hysteresis group requires at least ${policy.minimumHysteresisSocOverlap}.`);
    }
    const hasNegativeExcursion = validation.some(({ record }) => (
      record.metrics.scoredHysteresisStateRange?.[0] <= -policy.minimumHysteresisStateExcursion
    ));
    const hasPositiveExcursion = validation.some(({ record }) => (
      record.metrics.scoredHysteresisStateRange?.[1] >= policy.minimumHysteresisStateExcursion
    ));
    if (!hasNegativeExcursion || !hasPositiveExcursion) {
      throw new RangeError(`Validation datasets do not drive the fixed 600 s hysteresis state through both ±${policy.minimumHysteresisStateExcursion}; current signs without nonzero duration cannot observe the active hysteresis group.`);
    }
  }
}

function allocate(total, stages, minimum, weight) {
  const minima = stages.map(minimum);
  const required = minima.reduce((sum, value) => sum + value, 0);
  if (total < required) {
    throw new RangeError(`The ECM tuning budget ${total.toLocaleString()} cannot fund the ${required.toLocaleString()} units reserved before execution.`);
  }
  const remaining = BigInt(total - required);
  const weights = stages.map(weight);
  const weightSum = BigInt(weights.reduce((sum, value) => sum + value, 0));
  const shares = weights.map((value) => {
    const numerator = remaining * BigInt(value);
    return { whole: numerator / weightSum, fraction: numerator % weightSum };
  });
  const result = minima.map((value, index) => Number(BigInt(value) + shares[index].whole));
  const remainder = total - result.reduce((sum, value) => sum + value, 0);
  const priority = stages.map((stage, index) => ({
    index,
    fraction: shares[index].fraction,
    id: stage.id,
  })).sort((left, right) => (
    left.fraction === right.fraction
      ? left.id.localeCompare(right.id)
      : left.fraction > right.fraction ? -1 : 1
  ));
  for (let index = 0; index < remainder; index++) result[priority[index].index]++;
  return result;
}

/**
 * Build an immutable, content-addressed plan.  No simulation objective or
 * optimizer candidate is evaluated by this function.
 */
export function planEcmTuning(input) {
  object(input, 'ECM tuning input');
  const unsupported = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unsupported.length) throw new TypeError(`ECM tuning input contains unsupported field(s): ${unsupported.join(', ')}.`);
  const cell = object(input.cell, 'cell');
  if (typeof cell.id !== 'string' || !cell.id) throw new TypeError('cell.id must be a non-empty string.');
  // Acceptance is caller-owned and has no guessed defaults. Hash the closed
  // policy before inspecting trial metrics so result-based threshold selection
  // cannot masquerade as a predeclared validation decision.
  const acceptance = acceptanceThresholds(input.acceptance);
  const acceptanceChecksum = semanticDigest(acceptance);
  const requested = normalizeGroups(input.groups);
  const params = completeParams(cell, input.params ?? null);
  const initialRcSeparation = params.rc2TauS / params.rc1TauS;
  if (initialRcSeparation < ECM_TUNING_GATE_POLICY.minimumRcTimeConstantSeparationRatio) {
    throw new RangeError(`ECM tuning requires params.rc2TauS to be at least ${ECM_TUNING_GATE_POLICY.minimumRcTimeConstantSeparationRatio} times params.rc1TauS before any stage; the initial ratio is ${initialRcSeparation}.`);
  }
  const maxEvaluations = finiteInteger(input.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS, 'maxEvaluations', 2, 1_000_000);
  const maxIntegrationSteps = finiteInteger(input.maxIntegrationSteps ?? DEFAULT_MAX_INTEGRATION_STEPS, 'maxIntegrationSteps', 1, Number.MAX_SAFE_INTEGER);
  const maxModuleWeightedIntegrationSteps = finiteInteger(
    input.maxModuleWeightedIntegrationSteps ?? DEFAULT_MAX_MODULE_WEIGHTED_INTEGRATION_STEPS,
    'maxModuleWeightedIntegrationSteps', 1, Number.MAX_SAFE_INTEGER,
  );
  const maxSamplesPerDataset = finiteInteger(input.maxSamplesPerDataset ?? DEFAULT_MAX_SAMPLES,
    'maxSamplesPerDataset', 8, MAX_PREPROCESSED_SAMPLES_PER_DATASET);

  const calibration = trialRecords(asDatasetList(
    input.calibrationDatasets, 'calibrationDatasets', 'calibration',
  ), cell, params, maxSamplesPerDataset);
  const validation = trialRecords(asDatasetList(
    input.validationDatasets, 'validationDatasets', 'validation', { allowEmpty: true },
  ), cell, params, maxSamplesPerDataset);
  rejectDuplicates(calibration, 'calibrationDatasets');
  rejectDuplicates(validation, 'validationDatasets');
  if (validation.length < acceptance.minValidationDatasets) {
    throw new RangeError(`validationDatasets contains ${validation.length} whole trials; acceptance requires at least ${acceptance.minValidationDatasets}.`);
  }
  const binding = assertCompatible(calibration, cell);
  assertCompatible(validation, cell, binding);
  assertAcceptanceCoverage(calibration, 'calibrationDatasets', acceptance);
  assertAcceptanceCoverage(validation, 'validationDatasets', acceptance);
  assertValidationTemperatureEvidence(validation, acceptance);
  rejectCrossSetLeakage(calibration, validation);

  const diagnostics = groupGates(calibration, params);
  const groups = ECM_TUNING_GROUPS.map((spec) => {
    const selected = requested.ids.includes(spec.id);
    const diagnostic = diagnostics[spec.id];
    const passed = diagnostic.gates.every(({ status }) => status === 'pass');
    const status = !selected ? 'not-requested' : passed ? 'active'
      : requested.mode === 'auto' ? 'skipped' : 'blocked';
    const reasons = status === 'active' || status === 'not-requested' ? []
      : diagnostic.gates.filter(({ status: gateStatus }) => gateStatus === 'fail').map(({ detail }) => detail);
    return {
      ...spec,
      requested: selected,
      status,
      gates: diagnostic.gates,
      reasons,
      qualification: passed ? 'protocol-coverage-only; numerical-sensitivity-pending' : 'not-qualified',
      calibrationTrialContentChecksums: passed
        ? diagnostic.entries.map(({ record }) => record.trialContentChecksum).sort() : [],
    };
  });
  const active = groups.filter(({ status }) => status === 'active');
  const explicitlyBlocked = groups.filter(({ status }) => status === 'blocked');
  if (explicitlyBlocked.length) {
    throw new RangeError(`Explicit ECM tuning group(s) failed excitation gates: ${explicitlyBlocked.map(({ id, reasons }) => `${id} (${reasons.join(' ')})`).join('; ')}`);
  }
  if (!active.length) {
    throw new RangeError('No requested ECM parameter group passes its excitation gates; no optimizer stage can be planned.');
  }
  assertValidationExcitation(validation, active, params);

  const stages = active.map((group) => ({
    id: group.id,
    kind: 'group',
    groups: [group.id],
    fit: [...group.parameters],
    calibrationTrialContentChecksums: [...group.calibrationTrialContentChecksums],
  }));
  const jointFit = active.flatMap(({ parameters }) => parameters);
  const jointCalibrationChecksums = [...new Set(active.flatMap((group) => (
    group.calibrationTrialContentChecksums
  )))].sort();
  stages.push({
    id: 'joint-refinement', kind: 'joint', groups: active.map(({ id }) => id),
    fit: jointFit,
    calibrationTrialContentChecksums: jointCalibrationChecksums,
  });
  const evaluationAllocations = allocate(
    maxEvaluations, stages,
    (stage) => stage.fit.length + 1,
    (stage) => (stage.fit.length + 1) * (stage.kind === 'joint' ? 2 : 1),
  );
  const integrationAllocations = allocate(
    maxIntegrationSteps, stages,
    () => 1,
    (_, index) => evaluationAllocations[index],
  );
  const moduleWeightedIntegrationAllocations = allocate(
    maxModuleWeightedIntegrationSteps, stages,
    () => 1,
    (_, index) => evaluationAllocations[index],
  );
  const plannedStages = stages.map((stage, index) => ({
    ...stage,
    initialSimplexEvaluations: stage.fit.length + 1,
    evaluationBudget: evaluationAllocations[index],
    integrationStepBudget: integrationAllocations[index],
    moduleWeightedIntegrationStepBudget: moduleWeightedIntegrationAllocations[index],
  }));

  const initialParamsChecksum = semanticDigest(params);
  const cellChecksum = semanticDigest(cell);
  const identityProjection = (entries) => entries.map(({ record }) => ({
    datasetChecksum: record.datasetChecksum,
    observationChecksum: record.observationChecksum,
    trialContentChecksum: record.trialContentChecksum,
    electricalHistoryChecksum: record.electricalHistoryChecksum,
    scoredElectricalObservationChecksum: record.scoredElectricalObservationChecksum,
    preparedElectricalObservationChecksum: record.preparedElectricalObservationChecksum,
    rawSha256: record.rawSha256,
    sourceIdentityChecksum: record.sourceIdentityChecksum,
  }));
  const request = {
    strategyChecksum: ECM_TUNING_STRATEGY.checksum,
    acceptancePolicyChecksum: ECM_TUNING_ACCEPTANCE_POLICY.checksum,
    acceptanceChecksum,
    gatePolicyChecksum: ECM_TUNING_GATE_POLICY.checksum,
    groupContractChecksum: ECM_TUNING_GROUP_CONTRACT_CHECKSUM,
    preprocessingPolicyChecksum: CALIBRATION_PREPROCESSING_POLICY.checksum,
    cell: cell.id,
    cellChecksum,
    initialParamsChecksum,
    requestedGroups: requested.mode === 'auto' ? 'auto' : requested.ids,
    calibrationIdentities: identityProjection(calibration),
    validationIdentities: identityProjection(validation),
    maxEvaluations,
    maxIntegrationSteps,
    maxModuleWeightedIntegrationSteps,
    maxSamplesPerDataset,
  };
  const plan = {
    format: ECM_TUNING_PLAN_FORMAT,
    strategy: ECM_TUNING_STRATEGY,
    acceptancePolicy: ECM_TUNING_ACCEPTANCE_POLICY,
    acceptance,
    acceptanceChecksum,
    gatePolicy: ECM_TUNING_GATE_POLICY,
    preprocessingPolicy: CALIBRATION_PREPROCESSING_POLICY,
    groupContractChecksum: ECM_TUNING_GROUP_CONTRACT_CHECKSUM,
    request,
    requestChecksum: semanticDigest(request),
    cell: cell.id,
    cellChecksum,
    topology: {
      seriesCells: binding.seriesCells,
      parallelCells: binding.parallelCells,
      moduleCount: binding.moduleCount,
    },
    initialParams: params,
    initialParamsChecksum,
    candidateConstraints: {
      rcTimeConstantOrdering: {
        rule: 'rc2TauS-must-remain-at-least-minimumRatio-times-rc1TauS',
        minimumRatio: ECM_TUNING_GATE_POLICY.minimumRcTimeConstantSeparationRatio,
        enforcement: 'required-for-every-stage-candidate-and-final-adoption',
      },
    },
    trials: {
      calibration: calibration.map(({ record }) => record),
      validation: validation.map(({ record }) => record),
      splitPolicy: 'whole-trial-only',
      leakagePolicy: 'reject-shared-observation-trial-content-raw-or-preprocessed-scored-electrical-raw-source-or-declared-source-run-identity',
      independenceLimit: 'exact duplicate guards only; statistical independence and producer custody are caller-declared, not established by this plan',
    },
    groups,
    stages: plannedStages,
    budgets: {
      maxEvaluations,
      allocatedEvaluations: evaluationAllocations.reduce((sum, value) => sum + value, 0),
      reservedInitialSimplexEvaluations: plannedStages.reduce((sum, stage) => sum + stage.initialSimplexEvaluations, 0),
      maxIntegrationSteps,
      allocatedIntegrationSteps: integrationAllocations.reduce((sum, value) => sum + value, 0),
      maxModuleWeightedIntegrationSteps,
      allocatedModuleWeightedIntegrationSteps: moduleWeightedIntegrationAllocations.reduce((sum, value) => sum + value, 0),
      maxPreprocessedSamplesPerDataset: maxSamplesPerDataset,
      allocationPolicy: 'allocated ceilings: minimum-simplex then proportional dimension; joint weight 2; largest remainder by stage id; executor must preflight exact temporal and module-weighted work before its first candidate',
    },
    readiness: {
      optimizerExecution: 'not-started',
      structuralPlanReady: true,
      executionReady: false,
      workPreflight: 'required-before-first-candidate',
      preprocessing: 'executor-must-deterministically-limit-each-dataset-to-maxPreprocessedSamplesPerDataset',
      coverageQualification: 'protocol-gates-passed-for-planned-groups',
      numericalSensitivity: 'required-before-fit-activation',
      candidateConstraintEnforcement: 'required-during-every-stage-and-final-adoption',
      identifiabilityClaim: 'not-established-by-this-plan',
      holdoutIndependenceClaim: 'not-established; exact-disjoint caller declarations only',
      acceptanceEligibility: 'pending-executor-preflight-and-fixed-parameter-holdout-evaluation',
      activeGroups: active.map(({ id }) => id),
      skippedGroups: groups.filter(({ status }) => status === 'skipped').map(({ id, reasons }) => ({ id, reasons })),
      blockedGroups: groups.filter(({ status }) => status === 'blocked').map(({ id, reasons }) => ({ id, reasons })),
    },
  };
  return deepFreeze({ ...plan, checksum: semanticDigest(plan) });
}
