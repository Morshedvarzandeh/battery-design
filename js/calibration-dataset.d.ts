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

export function verifyCalibrationDataset(
  value: unknown,
  options: { expectedChecksum: string },
): Readonly<CalibrationDataset>;
