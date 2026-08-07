import type {
  AdvancedModelParams,
  AdvancedSimulationInput,
  AdvancedSimulationResult,
  BatteryCell,
  CalibrationDataset,
} from '../types/core.js';

export const R_GAS: number;
export const T0_K: number;
export const SIM2_SUPPORTED_INITIAL_STATE: 'rested-equilibrium-at-ambient';
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
export interface Sim2InitialStateAssumption {
  kind: typeof SIM2_SUPPORTED_INITIAL_STATE;
  datasetId: string | null;
  rcPolarizationV: readonly [0, 0];
  hysteresisState: 0;
  thermalNodes: {
    count: number;
    temperatureC: number;
  };
}
export interface Sim2SimulationResult extends AdvancedSimulationResult {
  initialStateAssumptions: readonly Sim2InitialStateAssumption[];
}
export interface Sim2WorkEstimate {
  profileSamples: number;
  nModules: number;
  electricalSubstepsPerSample: number;
  thermalSubstepsPerElectricalStep: number;
  temporalStepsPerSample: number;
  integrationStepCount: number;
  thermalNodeUpdateCount: number;
  electricalStepS: number;
  thermalStepS: number;
  cthModuleJK: number;
  maximumThermalStepS: number;
}
export function estimateSim2Work(input: AdvancedSimulationInput): Readonly<Sim2WorkEstimate>;
export function simulate(input: AdvancedSimulationInput): Sim2SimulationResult | null;
export function agingEstimate(input: Record<string, unknown>): Record<string, unknown>;
export function rmse(a: readonly number[], b: readonly number[]): number;

export const MAX_CALIBRATION_DATASETS: 8;
export const DEFAULT_MAX_SAMPLES_PER_DATASET: 5000;
export const MAX_PREPROCESSED_SAMPLES_PER_DATASET: 20000;
export const ECM_RC_MINIMUM_TIME_CONSTANT_RATIO: 3;
export const ORDERED_RC_CANDIDATE_POLICY: 'ordered-rc-v1';
export const CALIBRATION_MINIMUM_NORMALIZED_AXIS_STEP: 1e-8;
export interface BoundAwareAdmissibleAxisStep {
  readonly value: number;
  readonly direction: 'increase' | 'decrease';
  readonly delta: number;
  readonly normalizedDelta: number;
}
export function boundAwareAdmissibleAxisStep(input: {
  value: number;
  lower: number;
  upper: number;
  nominalNormalizedStep: number;
  minimumNormalizedStep?: number;
  admissible?: ((candidate: number) => boolean) | null;
}): BoundAwareAdmissibleAxisStep | null;
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

export interface ConstrainedCalibrationDatasetInput extends CalibrationDatasetInput {
  candidatePolicy: typeof ORDERED_RC_CANDIDATE_POLICY;
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
  nodeWorkPerEvaluation: number;
  thermalNodeUpdateCount: number;
  terminationReason: CalibrationTerminationReason;
  maxEvaluations: number;
  maxIntegrationSteps: number;
  voltageSampleCount: number;
  temperatureSampleCount: number;
  datasetChecksums: string[];
  checksumSemantics: string | null;
  preprocessing: CalibrationPreprocessingEvidence[];
  notes: string[];
  initialStateAssumptions: readonly Sim2InitialStateAssumption[];
  note: string;
}

export interface ConstrainedCalibrationResult extends CalibrationResult {
  candidateConstraintEvidence: {
    policy: typeof ORDERED_RC_CANDIDATE_POLICY;
    minimumRcTimeConstantRatio: typeof ECM_RC_MINIMUM_TIME_CONSTANT_RATIO;
    proposalCount: number;
    cacheHitCount: number;
    rejectedCandidateCount: number;
    minimumProposedRcTimeConstantRatio: number;
    finalRcTimeConstantRatio: number;
  };
}

export function calibrate(input: CalibrationInput): CalibrationResult;
export function calibrateDatasets(input: CalibrationDatasetInput): CalibrationResult;
export function calibrateDatasetsConstrained(
  input: ConstrainedCalibrationDatasetInput,
): ConstrainedCalibrationResult;
