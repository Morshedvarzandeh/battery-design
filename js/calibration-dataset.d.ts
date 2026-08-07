import type {
  CalibrationDataset,
  CalibrationDatasetKind,
  CalibrationDatasetPayload,
  CalibrationDatasetPurpose,
  CalibrationDatasetValidationIssue,
  CalibrationSegmentMode,
  CalibrationTemperatureLocation,
} from '../types/core.js';

export const CALIBRATION_DATASET_FORMAT: 'battery-design/calibration-dataset@1';
export const CALIBRATION_DATASET_SCHEMA_VERSION: '1.0.0';
export const MAX_CALIBRATION_DATASET_SAMPLES: 250000;
export const MAX_CALIBRATION_PREPROCESSED_SAMPLES: 20000;
export const CALIBRATION_PREPROCESSING_POLICY: Readonly<{
  format: 'battery-design/calibration-preprocessing-policy@1';
  version: '1.0.0';
  checksum: string;
  readonly [key: string]: string;
}>;
export const CALIBRATION_DATASET_KINDS: readonly CalibrationDatasetKind[];
export const CALIBRATION_DATASET_PURPOSES: readonly CalibrationDatasetPurpose[];
export const CALIBRATION_SEGMENT_MODES: readonly CalibrationSegmentMode[];
export const CALIBRATION_TEMPERATURE_LOCATIONS: readonly CalibrationTemperatureLocation[];
export const CALIBRATION_DATASET_SCHEMA: Readonly<Record<string, unknown>>;

export class CalibrationDatasetValidationError extends TypeError {
  readonly errors: readonly CalibrationDatasetValidationIssue[];
}

export function validateCalibrationDataset(
  value: unknown,
): readonly CalibrationDatasetValidationIssue[];

export function materializeCalibrationDataset(
  payload: CalibrationDatasetPayload,
): Readonly<CalibrationDataset>;

export function readCalibrationDataset(value: unknown): Readonly<CalibrationDataset>;

export interface CalibrationPreprocessingEvidence {
  readonly datasetId: string;
  readonly checksum: string;
  readonly rawSha256: string;
  readonly sourceTool: string;
  readonly sourceRunId: string | null;
  readonly binding: Readonly<CalibrationDataset['binding']>;
  readonly method: 'none' | 'block-mean-current-end-sample';
  readonly factor: number;
  readonly originalSamples: number;
  readonly usedSamples: number;
  readonly originalSamplePeriodS: number;
  readonly usedSamplePeriodS: number;
  readonly channelLengths: Readonly<{ current: number; voltage: number; temperature: number }>;
  readonly originalIncludedSamples: number;
  readonly representedIncludedSamples: number;
  readonly unrepresentedIncludedSamples: number;
  readonly mixedBoundaryBlocks: number;
  readonly usedIncludedSamples: number;
  readonly droppedTailSamples: number;
}

export interface PreprocessedCalibrationDataset {
  readonly policyChecksum: string;
  readonly measured: Readonly<{
    dtS: number;
    i: readonly number[];
    v: readonly number[];
    t: readonly number[] | null;
  }>;
  readonly observedTemperatureC: readonly number[] | null;
  readonly selectedIndices: readonly number[];
  readonly preprocessing: Readonly<CalibrationPreprocessingEvidence>;
}

export function preprocessCalibrationDataset(
  value: unknown,
  maxSamplesPerDataset: number,
): Readonly<PreprocessedCalibrationDataset>;

export interface CalibrationDatasetIdentities {
  readonly observationChecksum: string;
  readonly trialContentChecksum: string;
  readonly electricalHistoryChecksum: string;
  readonly scoredElectricalObservationChecksum: string;
}

export function calibrationDatasetIdentities(
  value: unknown,
): Readonly<CalibrationDatasetIdentities>;

export function verifyCalibrationDataset(
  value: unknown,
  options: { expectedChecksum: string },
): Readonly<CalibrationDataset>;
