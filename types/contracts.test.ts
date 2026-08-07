// Compile-only contract test. A breaking change in cells, the pack engine, or
// either simulation now fails `npm run typecheck` before it can reach users.

import { CELLS } from '../js/cells.js';
import { electrical, layoutPack, summarize } from '../js/pack-engine.js';
import { simulateMission } from '../js/sim1d.js';
import { defaultParams, simulate as simulateAdvanced } from '../js/sim2.js';
import { planEcmTuning } from '../js/ecm-tuning.js';
import type {
  EcmTuningAcceptanceThresholds,
  GovernedEcmTuningDataset,
} from '../js/ecm-tuning.js';
import type {
  AdvancedSimulationResult,
  BatteryCell,
  CalibrationDataset,
  MissionOutcome,
  PackSummary,
} from './core.js';

const cell: BatteryCell = CELLS[0]!;
const layout = layoutPack(cell, 16, 4, { arrangement: 'hex', orientation: 'upright' });
const pack: PackSummary = summarize(cell, 16, 4, layout);
const electricalResult = electrical(cell, 16, 4);

const mission: MissionOutcome = simulateMission({
  cell,
  s: 16,
  p: 4,
  profile: { dtS: 1, p: [0.2, 0.8, -0.1] },
  scaleW: 5_000,
});

const advanced: AdvancedSimulationResult | null = simulateAdvanced({
  cell,
  s: 16,
  p: 4,
  params: defaultParams(cell),
  profile: { dtS: 1, i: [5, 10, -2] },
});

declare const governedCalibration: GovernedEcmTuningDataset;
declare const governedValidation: GovernedEcmTuningDataset;
declare const ordinaryDataset: CalibrationDataset;
const tuningAcceptance: EcmTuningAcceptanceThresholds = {
  maxVoltageRmseMvPerCell: 10,
  maxVoltageMaxAbsMvPerCell: 25,
  maxTemperatureRmseC: null,
  maxTemperatureMaxAbsC: null,
  minValidationDatasets: 1,
  minIncludedSamplesPerDataset: 100,
  requiredModes: ['dynamic'],
  requireNoHoldoutRegression: true,
  requireNoFittedParameterAtBound: true,
};
const tuningPlan = planEcmTuning({
  cell,
  calibrationDatasets: governedCalibration,
  validationDatasets: governedValidation,
  acceptance: tuningAcceptance,
});
const tuningExecutionReady: false = tuningPlan.readiness.executionReady;

// @ts-expect-error Canonical datasets with nullable source tuples are not governed tuning inputs.
const incompleteTuningDataset: GovernedEcmTuningDataset = ordinaryDataset;
const unsafeTuningAcceptance: EcmTuningAcceptanceThresholds = {
  ...tuningAcceptance,
  // @ts-expect-error Automatic tuning never allows holdout-regression protection to be disabled.
  requireNoHoldoutRegression: false,
};
// @ts-expect-error Temperature acceptance limits must be both null or both numeric.
const mixedTemperatureAcceptance: EcmTuningAcceptanceThresholds = {
  ...tuningAcceptance,
  maxTemperatureRmseC: 1,
  maxTemperatureMaxAbsC: null,
};

void [
  pack, electricalResult, mission, advanced, tuningPlan, tuningExecutionReady,
  incompleteTuningDataset, unsafeTuningAcceptance, mixedTemperatureAcceptance,
];
