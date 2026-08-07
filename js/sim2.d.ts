import type {
  AdvancedModelParams,
  AdvancedSimulationInput,
  AdvancedSimulationResult,
  BatteryCell,
  CalibrationDataset,
} from '../types/core.js';

export const R_GAS: number;
export const T0_K: number;
export const PARAM_SPEC: readonly {
  id: keyof AdvancedModelParams;
  group: string;
  label: string;
  unit: string;
  def: number | null;
  min: number;
  max: number;
  why: string;
  source: string;
}[];
export const PARAM_BY_ID: Partial<Record<keyof AdvancedModelParams, (typeof PARAM_SPEC)[number]>>;
export function defaultParams(cell?: BatteryCell | null): AdvancedModelParams;
export function validateParams(params: Partial<AdvancedModelParams>): {
  params: AdvancedModelParams;
  notes: string[];
};
export function simulate(input: AdvancedSimulationInput): AdvancedSimulationResult | null;
export function agingEstimate(input: Record<string, unknown>): Record<string, unknown>;
export function rmse(a: readonly number[], b: readonly number[]): number;

export const MAX_CALIBRATION_DATASETS: 8;
export const DEFAULT_MAX_SAMPLES_PER_DATASET: 5000;
export const MAX_PREPROCESSED_SAMPLES_PER_DATASET: 20000;
export const CALIBRATION_FIT_ELIGIBLE: readonly (keyof AdvancedModelParams)[];

export interface CalibrationMeasuredSeries {
  dtS: number;
  i: number[];
  v: number[];
  t?: number[];
}

export interface CalibrationLimits {
  params?: Partial<AdvancedModelParams> | null;
  fit?: (keyof AdvancedModelParams)[];
  maxIter?: number;
  weightTemp?: number;
  maxEvaluations?: number;
  maxIntegrationSteps?: number;
}

export interface CalibrationInput extends CalibrationLimits {
  cell: BatteryCell;
  s: number;
  p: number;
  measured: CalibrationMeasuredSeries;
  startSoC?: number;
  ambientC?: number;
  nModules?: number;
}

export interface CalibrationDatasetInput extends CalibrationLimits {
  cell: BatteryCell;
  datasets: CalibrationDataset | readonly CalibrationDataset[];
  maxSamplesPerDataset?: number;
}

export type CalibrationTerminationReason =
  | 'converged'
  | 'max-iterations'
  | 'max-evaluations'
  | 'max-integration-steps';

export interface CalibrationPreprocessingEvidence {
  datasetId: string;
  checksum: string;
  rawSha256: string;
  sourceTool: string;
  sourceRunId: string | null;
  binding: CalibrationDataset['binding'];
  method: 'none' | 'block-mean-current-end-sample';
  factor: number;
  originalSamples: number;
  usedSamples: number;
  originalSamplePeriodS: number;
  usedSamplePeriodS: number;
  channelLengths: {
    current: number;
    voltage: number;
    temperature: number;
  };
  originalIncludedSamples: number;
  representedIncludedSamples: number;
  unrepresentedIncludedSamples: number;
  mixedBoundaryBlocks: number;
  usedIncludedSamples: number;
  droppedTailSamples: number;
}

export interface CalibrationResult {
  params: AdvancedModelParams;
  fitted: Partial<Record<keyof AdvancedModelParams, {
    from: number;
    to: number;
    changedPct: number | null;
    unit: string;
    atBound: boolean;
  }>>;
  rmseBefore: number;
  rmseAfter: number;
  voltageRmseBefore: number;
  voltageRmseAfter: number;
  temperatureRmseBefore: number | null;
  temperatureRmseAfter: number | null;
  improvementPct: number;
  iterations: number;
  evaluationCount: number;
  integrationStepCount: number;
  workPerEvaluation: number;
  terminationReason: CalibrationTerminationReason;
  maxEvaluations: number;
  maxIntegrationSteps: number;
  voltageSampleCount: number;
  temperatureSampleCount: number;
  datasetChecksums: string[];
  checksumSemantics: string | null;
  preprocessing: CalibrationPreprocessingEvidence[];
  notes: string[];
  note: string;
}

export function calibrate(input: CalibrationInput): CalibrationResult;
export function calibrateDatasets(input: CalibrationDatasetInput): CalibrationResult;
