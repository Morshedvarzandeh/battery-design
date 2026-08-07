import type {
  CalibrationDataset,
  CalibrationDatasetKind,
  CalibrationDatasetPurpose,
  CalibrationSegmentMode,
  CalibrationTemperatureLocation,
} from '../types/core.js';

export type CalibrationImportAdapter = 'canonical-json' | 'delimited-columns';
export type CalibrationImportDelimiter = ',' | ';' | '\t';
export type CalibrationTimeUnit = 's' | 'ms' | 'min';
export type CalibrationCurrentUnit = 'A' | 'mA' | 'kA';
export type CalibrationVoltageUnit = 'V' | 'mV' | 'kV';
export type CalibrationTemperatureUnit = 'degC' | 'K' | 'degF';

export interface CalibrationImportSegment {
  id: string;
  startIndex: number;
  endIndexExclusive: number;
  mode: CalibrationSegmentMode;
  include: boolean;
}

export interface CalibrationImportMappingPayload {
  adapter: CalibrationImportAdapter;
  delimiter: CalibrationImportDelimiter | null;
  dataset: {
    id: string;
    kind: CalibrationDatasetKind;
    purpose: CalibrationDatasetPurpose;
  };
  source: {
    tool: string;
    toolVersion: string | null;
    model: string | null;
    runId: string | null;
    generatedAt: string | null;
  };
  binding: {
    cellId: string | null;
    seriesCells: number;
    parallelCells: number;
    startSoC: number;
    ambientC: number;
    moduleCount: number;
    initialState: 'rested-equilibrium-at-ambient';
  };
  columns: {
    time: string;
    current: string;
    voltage: string;
    temperature: string | null;
  };
  units: {
    time: CalibrationTimeUnit;
    current: CalibrationCurrentUnit;
    voltage: CalibrationVoltageUnit;
    temperature: CalibrationTemperatureUnit | null;
  };
  sourceCurrentPositive: 'charge' | 'discharge';
  sourceCurrentScope: 'cell' | 'pack';
  sourceVoltageLocation: 'cell-terminal' | 'pack-terminal';
  sourceTemperatureLocation: CalibrationTemperatureLocation | null;
  sourceSampleAlignment: 'end-of-step';
  sourceFirstSampleTimeS: number;
  timeToleranceS: number;
  segments: readonly CalibrationImportSegment[] | null;
}

export interface CalibrationImportMapping extends CalibrationImportMappingPayload {
  format: 'battery-design/calibration-import-mapping@1';
  schemaVersion: '1.0.0';
  checksum: string;
}

export interface CalibrationImportMappingValidationIssue {
  path: string;
  code: string;
  message: string;
}

export const CALIBRATION_IMPORT_MAPPING_FORMAT: 'battery-design/calibration-import-mapping@1';
export const CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION: '1.0.0';
export const CALIBRATION_IMPORT_ADAPTER_VERSION: '1.0.0';
export const MAX_CALIBRATION_SOURCE_BYTES: number;
export const MAX_CALIBRATION_SOURCE_COLUMNS: 512;
export const CALIBRATION_IMPORT_ADAPTERS: readonly CalibrationImportAdapter[];
export const CALIBRATION_IMPORT_DELIMITERS: readonly CalibrationImportDelimiter[];
export const CALIBRATION_TIME_UNITS: readonly CalibrationTimeUnit[];
export const CALIBRATION_CURRENT_UNITS: readonly CalibrationCurrentUnit[];
export const CALIBRATION_VOLTAGE_UNITS: readonly CalibrationVoltageUnit[];
export const CALIBRATION_TEMPERATURE_UNITS: readonly CalibrationTemperatureUnit[];
export const CALIBRATION_IMPORT_MAPPING_SCHEMA: Readonly<Record<string, unknown>>;

export class CalibrationImportMappingValidationError extends TypeError {
  readonly errors: readonly CalibrationImportMappingValidationIssue[];
}

export class CalibrationSourceImportError extends TypeError {}

export function validateCalibrationImportMapping(
  value: unknown,
): readonly CalibrationImportMappingValidationIssue[];

export function materializeCalibrationImportMapping(
  payload: CalibrationImportMappingPayload,
): Readonly<CalibrationImportMapping>;

export function readCalibrationImportMapping(
  value: unknown,
): Readonly<CalibrationImportMapping>;

export function importCalibrationDataset(
  sourceText: string,
  mapping: CalibrationImportMapping,
): Readonly<CalibrationDataset>;
