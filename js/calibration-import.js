// calibration-import.js — strict, vendor-neutral calibration trace ingestion.
//
// A mapping is a governed statement of source semantics, never a bag of
// aliases. The importer resolves only the exact column names in that mapping;
// unselected vendor columns are allowed but remain covered by the raw-source
// digest. It converts every selected sample without dropping or resampling rows,
// then delegates final closed-shape/checksum enforcement to calibration-dataset.js.
// Keep this module dependency-free and browser-safe; callers own file I/O.

import {
  CALIBRATION_DATASET_KINDS,
  CALIBRATION_DATASET_PURPOSES,
  CALIBRATION_SEGMENT_MODES,
  CALIBRATION_TEMPERATURE_LOCATIONS,
  MAX_CALIBRATION_DATASET_SAMPLES,
  materializeCalibrationDataset,
} from './calibration-dataset.js';
import { semanticDigest } from './ontology.js';

export const CALIBRATION_IMPORT_MAPPING_FORMAT = 'battery-design/calibration-import-mapping@1';
export const CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION = '1.0.0';
export const CALIBRATION_IMPORT_ADAPTER_VERSION = '1.0.0';
export const MAX_CALIBRATION_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_CALIBRATION_SOURCE_COLUMNS = 512;

export const CALIBRATION_IMPORT_ADAPTERS = Object.freeze([
  'canonical-json', 'delimited-columns',
]);
export const CALIBRATION_IMPORT_DELIMITERS = Object.freeze([',', ';', '\t']);
export const CALIBRATION_TIME_UNITS = Object.freeze(['s', 'ms', 'min']);
export const CALIBRATION_CURRENT_UNITS = Object.freeze(['A', 'mA', 'kA']);
export const CALIBRATION_VOLTAGE_UNITS = Object.freeze(['V', 'mV', 'kV']);
export const CALIBRATION_TEMPERATURE_UNITS = Object.freeze(['degC', 'K', 'degF']);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const nullableString = { type: ['string', 'null'], minLength: 1, maxLength: 256 };
const columnName = { type: 'string', minLength: 1, maxLength: 128 };
const nullableColumnName = { anyOf: [columnName, { type: 'null' }] };

// Published for external mapping editors. Runtime validation below enforces
// the same closed shape plus adapter pairings, distinct column names, segment
// continuity and checksum identity.
export const CALIBRATION_IMPORT_MAPPING_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://morshedvarzandeh.github.io/battery-design/calibration-import-mapping/1.0.0',
  title: 'battery-design calibration source mapping',
  type: 'object',
  additionalProperties: false,
  required: [
    'format', 'schemaVersion', 'adapter', 'delimiter', 'dataset', 'source',
    'binding', 'columns', 'units', 'sourceCurrentPositive',
    'sourceVoltageLocation', 'sourceTemperatureLocation', 'timeToleranceS',
    'segments', 'checksum',
  ],
  properties: {
    format: { const: CALIBRATION_IMPORT_MAPPING_FORMAT },
    schemaVersion: { const: CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION },
    adapter: { type: 'string', enum: CALIBRATION_IMPORT_ADAPTERS },
    delimiter: { type: ['string', 'null'], enum: [...CALIBRATION_IMPORT_DELIMITERS, null] },
    dataset: {
      type: 'object', additionalProperties: false,
      required: ['id', 'kind', 'purpose'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
        kind: { type: 'string', enum: CALIBRATION_DATASET_KINDS },
        purpose: { type: 'string', enum: CALIBRATION_DATASET_PURPOSES },
      },
    },
    source: {
      type: 'object', additionalProperties: false,
      required: ['tool', 'toolVersion', 'model', 'runId', 'generatedAt'],
      properties: {
        tool: { type: 'string', minLength: 1, maxLength: 128 },
        toolVersion: nullableString,
        model: nullableString,
        runId: nullableString,
        generatedAt: {
          type: ['string', 'null'], format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$',
        },
      },
    },
    binding: {
      type: 'object', additionalProperties: false,
      required: ['cellId', 'seriesCells', 'parallelCells', 'startSoC', 'ambientC', 'moduleCount'],
      properties: {
        cellId: nullableString,
        seriesCells: { type: 'integer', minimum: 1, maximum: 100_000 },
        parallelCells: { type: 'integer', minimum: 1, maximum: 100_000 },
        startSoC: { type: 'number', minimum: 0, maximum: 1 },
        ambientC: { type: 'number', minimum: -100, maximum: 200 },
        moduleCount: { type: 'integer', minimum: 1, maximum: 10_000 },
      },
    },
    columns: {
      type: 'object', additionalProperties: false,
      required: ['time', 'current', 'voltage', 'temperature'],
      properties: {
        time: columnName, current: columnName, voltage: columnName,
        temperature: nullableColumnName,
      },
    },
    units: {
      type: 'object', additionalProperties: false,
      required: ['time', 'current', 'voltage', 'temperature'],
      properties: {
        time: { type: 'string', enum: CALIBRATION_TIME_UNITS },
        current: { type: 'string', enum: CALIBRATION_CURRENT_UNITS },
        voltage: { type: 'string', enum: CALIBRATION_VOLTAGE_UNITS },
        temperature: { type: ['string', 'null'], enum: [...CALIBRATION_TEMPERATURE_UNITS, null] },
      },
    },
    sourceCurrentPositive: { type: 'string', enum: ['charge', 'discharge'] },
    sourceVoltageLocation: { type: 'string', enum: ['cell-terminal', 'pack-terminal'] },
    sourceTemperatureLocation: {
      type: ['string', 'null'], enum: [...CALIBRATION_TEMPERATURE_LOCATIONS, null],
    },
    timeToleranceS: { type: 'number', minimum: 0, maximum: 60 },
    segments: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array', minItems: 1, maxItems: 10_000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'startIndex', 'endIndexExclusive', 'mode', 'include'],
            properties: {
              id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
              startIndex: { type: 'integer', minimum: 0 },
              endIndexExclusive: { type: 'integer', minimum: 1 },
              mode: { type: 'string', enum: CALIBRATION_SEGMENT_MODES },
              include: { type: 'boolean' },
            },
          },
        },
      ],
    },
    checksum: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
});

const ROOT_KEYS = Object.freeze([
  'format', 'schemaVersion', 'adapter', 'delimiter', 'dataset', 'source',
  'binding', 'columns', 'units', 'sourceCurrentPositive',
  'sourceVoltageLocation', 'sourceTemperatureLocation', 'timeToleranceS',
  'segments', 'checksum',
]);
const PAYLOAD_KEYS = Object.freeze(ROOT_KEYS.filter((key) => !['format', 'schemaVersion', 'checksum'].includes(key)));
const DATASET_KEYS = Object.freeze(['id', 'kind', 'purpose']);
const SOURCE_KEYS = Object.freeze(['tool', 'toolVersion', 'model', 'runId', 'generatedAt']);
const BINDING_KEYS = Object.freeze(['cellId', 'seriesCells', 'parallelCells', 'startSoC', 'ambientC', 'moduleCount']);
const COLUMN_KEYS = Object.freeze(['time', 'current', 'voltage', 'temperature']);
const UNIT_KEYS = Object.freeze(['time', 'current', 'voltage', 'temperature']);
const SEGMENT_KEYS = Object.freeze(['id', 'startIndex', 'endIndexExclusive', 'mode', 'include']);

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const STRICT_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , zone, , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
  ].map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function issue(path, code, message) {
  return { path, code, message };
}

function exactKeys(value, keys, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue(path, 'type', 'must be an object'));
    return false;
  }
  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(issue(`${path}.${key}`, 'required', 'is required'));
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) errors.push(issue(`${path}.${key}`, 'additionalProperties', 'is not allowed'));
  }
  return true;
}

function stringOrNull(value, path, errors) {
  if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 256)) {
    errors.push(issue(path, 'type', 'must be null or a non-empty string up to 256 characters'));
  }
}

function finiteInRange(value, min, max, path, errors, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    errors.push(issue(path, 'range', `must be ${integer ? 'an integer ' : ''}from ${min} to ${max}`));
  }
}

function cloneJson(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} must be JSON-compatible.`);
  if (seen.has(value)) throw new TypeError(`${path} must not contain a cycle.`);
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((entry, index) => cloneJson(entry, `${path}[${index}]`, seen))
    : (() => {
      if (!isPlainObject(value)) throw new TypeError(`${path} must contain only plain JSON objects.`);
      return Object.fromEntries(Object.keys(value).sort().map((key) => [
        key, cloneJson(value[key], `${path}.${key}`, seen),
      ]));
    })();
  seen.delete(value);
  return result;
}

function checksumPayload(mapping) {
  return Object.fromEntries(ROOT_KEYS.filter((key) => key !== 'checksum').map((key) => [key, mapping[key]]));
}

export function validateCalibrationImportMapping(value) {
  const errors = [];
  if (!exactKeys(value, ROOT_KEYS, '$', errors)) return deepFreeze(errors);

  if (value.format !== CALIBRATION_IMPORT_MAPPING_FORMAT) errors.push(issue('$.format', 'const', `must equal ${CALIBRATION_IMPORT_MAPPING_FORMAT}`));
  if (value.schemaVersion !== CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION) errors.push(issue('$.schemaVersion', 'const', `must equal ${CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION}`));
  if (!CALIBRATION_IMPORT_ADAPTERS.includes(value.adapter)) errors.push(issue('$.adapter', 'enum', `must be one of: ${CALIBRATION_IMPORT_ADAPTERS.join(', ')}`));
  if (value.adapter === 'canonical-json' && value.delimiter !== null) errors.push(issue('$.delimiter', 'pairing', 'must be null for canonical-json'));
  if (value.adapter === 'delimited-columns' && !CALIBRATION_IMPORT_DELIMITERS.includes(value.delimiter)) errors.push(issue('$.delimiter', 'pairing', 'must be comma, semicolon or tab for delimited-columns'));

  if (exactKeys(value.dataset, DATASET_KEYS, '$.dataset', errors)) {
    if (typeof value.dataset.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.dataset.id)) errors.push(issue('$.dataset.id', 'pattern', 'must be a portable 1–128 character dataset id'));
    if (!CALIBRATION_DATASET_KINDS.includes(value.dataset.kind)) errors.push(issue('$.dataset.kind', 'enum', `must be one of: ${CALIBRATION_DATASET_KINDS.join(', ')}`));
    if (!CALIBRATION_DATASET_PURPOSES.includes(value.dataset.purpose)) errors.push(issue('$.dataset.purpose', 'enum', `must be one of: ${CALIBRATION_DATASET_PURPOSES.join(', ')}`));
  }

  if (exactKeys(value.source, SOURCE_KEYS, '$.source', errors)) {
    if (typeof value.source.tool !== 'string' || !value.source.tool.trim() || value.source.tool.length > 128) errors.push(issue('$.source.tool', 'length', 'must be a non-empty string up to 128 characters'));
    for (const key of ['toolVersion', 'model', 'runId']) stringOrNull(value.source[key], `$.source.${key}`, errors);
    if (value.source.generatedAt !== null && !validIsoInstant(value.source.generatedAt)) errors.push(issue('$.source.generatedAt', 'format', 'must be null or an ISO 8601 timestamp with a timezone'));
  }

  if (exactKeys(value.binding, BINDING_KEYS, '$.binding', errors)) {
    stringOrNull(value.binding.cellId, '$.binding.cellId', errors);
    finiteInRange(value.binding.seriesCells, 1, 100_000, '$.binding.seriesCells', errors, true);
    finiteInRange(value.binding.parallelCells, 1, 100_000, '$.binding.parallelCells', errors, true);
    finiteInRange(value.binding.startSoC, 0, 1, '$.binding.startSoC', errors);
    finiteInRange(value.binding.ambientC, -100, 200, '$.binding.ambientC', errors);
    finiteInRange(value.binding.moduleCount, 1, 10_000, '$.binding.moduleCount', errors, true);
  }

  if (exactKeys(value.columns, COLUMN_KEYS, '$.columns', errors)) {
    const selected = [];
    for (const key of ['time', 'current', 'voltage']) {
      const name = value.columns[key];
      if (typeof name !== 'string' || !name.length || name.length > 128 || /[\r\n\0]/.test(name)) errors.push(issue(`$.columns.${key}`, 'columnName', 'must be an exact non-empty column name up to 128 characters without line breaks'));
      else selected.push([key, name]);
    }
    const temperature = value.columns.temperature;
    if (temperature !== null && (typeof temperature !== 'string' || !temperature.length || temperature.length > 128 || /[\r\n\0]/.test(temperature))) errors.push(issue('$.columns.temperature', 'columnName', 'must be null or an exact column name up to 128 characters without line breaks'));
    else if (temperature !== null) selected.push(['temperature', temperature]);
    const owners = new Map();
    for (const [key, name] of selected) {
      if (owners.has(name)) errors.push(issue(`$.columns.${key}`, 'unique', `must not reuse the ${owners.get(name)} column name ${JSON.stringify(name)}`));
      else owners.set(name, key);
    }
  }

  if (exactKeys(value.units, UNIT_KEYS, '$.units', errors)) {
    if (!CALIBRATION_TIME_UNITS.includes(value.units.time)) errors.push(issue('$.units.time', 'enum', `must be one of: ${CALIBRATION_TIME_UNITS.join(', ')}`));
    if (!CALIBRATION_CURRENT_UNITS.includes(value.units.current)) errors.push(issue('$.units.current', 'enum', `must be one of: ${CALIBRATION_CURRENT_UNITS.join(', ')}`));
    if (!CALIBRATION_VOLTAGE_UNITS.includes(value.units.voltage)) errors.push(issue('$.units.voltage', 'enum', `must be one of: ${CALIBRATION_VOLTAGE_UNITS.join(', ')}`));
    if (value.units.temperature !== null && !CALIBRATION_TEMPERATURE_UNITS.includes(value.units.temperature)) errors.push(issue('$.units.temperature', 'enum', `must be null or one of: ${CALIBRATION_TEMPERATURE_UNITS.join(', ')}`));
  }

  if (!['charge', 'discharge'].includes(value.sourceCurrentPositive)) errors.push(issue('$.sourceCurrentPositive', 'enum', 'must be charge or discharge'));
  if (!['cell-terminal', 'pack-terminal'].includes(value.sourceVoltageLocation)) errors.push(issue('$.sourceVoltageLocation', 'enum', 'must be cell-terminal or pack-terminal'));
  if (value.sourceTemperatureLocation !== null && !CALIBRATION_TEMPERATURE_LOCATIONS.includes(value.sourceTemperatureLocation)) errors.push(issue('$.sourceTemperatureLocation', 'enum', 'must be null or an allowlisted temperature location'));
  const hasTemperature = value.columns?.temperature !== null;
  if (hasTemperature !== (value.units?.temperature !== null) || hasTemperature !== (value.sourceTemperatureLocation !== null)) errors.push(issue('$.columns.temperature', 'pairing', 'temperature column, unit and location must all be present or all be null'));
  finiteInRange(value.timeToleranceS, 0, 60, '$.timeToleranceS', errors);

  if (value.segments !== null) {
    if (!Array.isArray(value.segments) || !value.segments.length || value.segments.length > 10_000) {
      errors.push(issue('$.segments', 'length', 'must be null or contain 1 to 10,000 exact segments'));
    } else {
      let cursor = 0;
      const ids = new Set();
      for (let index = 0; index < value.segments.length; index += 1) {
        const segment = value.segments[index];
        const path = `$.segments[${index}]`;
        if (!exactKeys(segment, SEGMENT_KEYS, path, errors)) continue;
        if (typeof segment.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(segment.id)) errors.push(issue(`${path}.id`, 'pattern', 'must be a portable segment id'));
        if (ids.has(segment.id)) errors.push(issue(`${path}.id`, 'unique', 'must not duplicate another segment id'));
        ids.add(segment.id);
        if (!Number.isInteger(segment.startIndex) || segment.startIndex !== cursor) errors.push(issue(`${path}.startIndex`, 'coverage', `must equal ${cursor} for ordered full coverage`));
        if (!Number.isInteger(segment.endIndexExclusive) || segment.endIndexExclusive <= segment.startIndex) errors.push(issue(`${path}.endIndexExclusive`, 'range', 'must be an integer after startIndex'));
        if (!CALIBRATION_SEGMENT_MODES.includes(segment.mode)) errors.push(issue(`${path}.mode`, 'enum', `must be one of: ${CALIBRATION_SEGMENT_MODES.join(', ')}`));
        if (typeof segment.include !== 'boolean') errors.push(issue(`${path}.include`, 'type', 'must be boolean'));
        if (Number.isInteger(segment.endIndexExclusive)) cursor = segment.endIndexExclusive;
      }
      if (!value.segments.some((segment) => segment?.include === true)) errors.push(issue('$.segments', 'selection', 'must include at least one segment'));
    }
  }

  if (typeof value.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(value.checksum)) errors.push(issue('$.checksum', 'pattern', 'must be a lowercase SHA-256 digest'));
  else if (semanticDigest(checksumPayload(value)) !== value.checksum) errors.push(issue('$.checksum', 'identity', 'does not match the canonical mapping content'));
  return deepFreeze(errors);
}

export class CalibrationImportMappingValidationError extends TypeError {
  constructor(errors) {
    super(`Calibration import mapping is invalid: ${errors.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
    this.name = 'CalibrationImportMappingValidationError';
    this.errors = errors;
  }
}

export class CalibrationSourceImportError extends TypeError {
  constructor(message) {
    super(`Calibration source is invalid: ${message}`);
    this.name = 'CalibrationSourceImportError';
  }
}

export function materializeCalibrationImportMapping(payload) {
  const inputErrors = [];
  if (!exactKeys(payload, PAYLOAD_KEYS, '$', inputErrors)) throw new CalibrationImportMappingValidationError(deepFreeze(inputErrors));
  const cloned = cloneJson(payload);
  const withoutChecksum = {
    format: CALIBRATION_IMPORT_MAPPING_FORMAT,
    schemaVersion: CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION,
    ...cloned,
  };
  const mapping = { ...withoutChecksum, checksum: semanticDigest(withoutChecksum) };
  const errors = validateCalibrationImportMapping(mapping);
  if (errors.length) throw new CalibrationImportMappingValidationError(errors);
  return deepFreeze(mapping);
}

export function readCalibrationImportMapping(value) {
  const errors = validateCalibrationImportMapping(value);
  if (errors.length) throw new CalibrationImportMappingValidationError(errors);
  return deepFreeze(cloneJson(value));
}

function sourceFailure(message) {
  throw new CalibrationSourceImportError(message);
}

function sourceByteLength(sourceText) {
  return new TextEncoder().encode(sourceText).byteLength;
}

function assertSourceText(sourceText) {
  if (typeof sourceText !== 'string') sourceFailure('must be a UTF-8 text string.');
  const bytes = sourceByteLength(sourceText);
  if (bytes === 0) sourceFailure('must not be empty.');
  if (bytes > MAX_CALIBRATION_SOURCE_BYTES) sourceFailure(`exceeds the ${MAX_CALIBRATION_SOURCE_BYTES}-byte limit.`);
}

function parseDelimitedRecords(sourceText, delimiter) {
  const text = sourceText.startsWith('\uFEFF') ? sourceText.slice(1) : sourceText;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let atFieldStart = true;
  let recordJustEnded = false;

  const finishField = () => {
    row.push(field);
    field = '';
    quoted = false;
    afterQuote = false;
    atFieldStart = true;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    if (rows.length > MAX_CALIBRATION_DATASET_SAMPLES + 1) sourceFailure(`contains more than ${MAX_CALIBRATION_DATASET_SAMPLES} data rows.`);
    row = [];
    recordJustEnded = true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    recordJustEnded = false;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote) {
      if (character === delimiter) {
        finishField();
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        finishRow();
      } else {
        sourceFailure(`has an unexpected character after a closing quote at character ${index + 1}.`);
      }
      continue;
    }
    if (atFieldStart && character === '"') {
      quoted = true;
      atFieldStart = false;
    } else if (character === '"') {
      sourceFailure(`has a quote inside an unquoted field at character ${index + 1}.`);
    } else if (character === delimiter) {
      finishField();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      field += character;
      atFieldStart = false;
    }
  }
  if (quoted) sourceFailure('ends inside a quoted field.');
  if (!recordJustEnded || row.length || field.length || afterQuote || !atFieldStart) finishRow();
  return rows;
}

function delimitedColumns(sourceText, mapping) {
  const rows = parseDelimitedRecords(sourceText, mapping.delimiter);
  if (!rows.length) sourceFailure('does not contain a header row.');
  const headers = rows[0];
  if (!headers.length || headers.length > MAX_CALIBRATION_SOURCE_COLUMNS) sourceFailure(`header must contain 1 to ${MAX_CALIBRATION_SOURCE_COLUMNS} columns.`);
  const headerIndex = new Map();
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!header.length) sourceFailure(`header column ${index + 1} is empty.`);
    if (header.length > 128 || /[\r\n\0]/.test(header)) sourceFailure(`header ${JSON.stringify(header)} is not a portable column name.`);
    if (headerIndex.has(header)) sourceFailure(`header ${JSON.stringify(header)} is duplicated.`);
    headerIndex.set(header, index);
  }
  const selectedIndexes = {};
  for (const key of COLUMN_KEYS) {
    const name = mapping.columns[key];
    if (name === null) continue;
    if (!headerIndex.has(name)) sourceFailure(`is missing the exact ${key} column ${JSON.stringify(name)}.`);
    selectedIndexes[key] = headerIndex.get(name);
  }
  const dataRows = rows.slice(1);
  if (dataRows.length < 3) sourceFailure('must contain at least 3 data rows.');
  if (dataRows.length > MAX_CALIBRATION_DATASET_SAMPLES) sourceFailure(`contains more than ${MAX_CALIBRATION_DATASET_SAMPLES} data rows.`);
  const columns = Object.fromEntries(Object.keys(selectedIndexes).map((key) => [key, []]));
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const sourceRow = dataRows[rowIndex];
    if (sourceRow.length !== headers.length) sourceFailure(`row ${rowIndex + 2} has ${sourceRow.length} columns; expected exactly ${headers.length}.`);
    for (const [key, columnIndex] of Object.entries(selectedIndexes)) {
      const token = sourceRow[columnIndex];
      if (!STRICT_NUMBER.test(token)) sourceFailure(`row ${rowIndex + 2}, column ${JSON.stringify(mapping.columns[key])} must be a strict decimal number.`);
      const number = Number(token);
      if (!Number.isFinite(number)) sourceFailure(`row ${rowIndex + 2}, column ${JSON.stringify(mapping.columns[key])} must be finite.`);
      columns[key].push(number);
    }
  }
  return columns;
}

function canonicalJsonColumns(sourceText, mapping) {
  const text = sourceText.startsWith('\uFEFF') ? sourceText.slice(1) : sourceText;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    sourceFailure(`is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!isPlainObject(parsed)) sourceFailure('canonical JSON must be one object containing the mapped exact-name column arrays.');
  if (Object.keys(parsed).length > MAX_CALIBRATION_SOURCE_COLUMNS) sourceFailure(`canonical JSON contains more than ${MAX_CALIBRATION_SOURCE_COLUMNS} columns.`);
  const columns = {};
  let sampleCount = null;
  for (const key of COLUMN_KEYS) {
    const name = mapping.columns[key];
    if (name === null) continue;
    if (!Object.prototype.hasOwnProperty.call(parsed, name)) sourceFailure(`is missing the exact ${key} column ${JSON.stringify(name)}.`);
    const values = parsed[name];
    if (!Array.isArray(values)) sourceFailure(`column ${JSON.stringify(name)} must be an array.`);
    if (sampleCount === null) sampleCount = values.length;
    else if (values.length !== sampleCount) sourceFailure(`column ${JSON.stringify(name)} has ${values.length} samples; expected exactly ${sampleCount}.`);
    const copied = values.map((value, index) => {
      if (!Number.isFinite(value)) sourceFailure(`column ${JSON.stringify(name)} sample ${index + 1} must be a finite JSON number.`);
      return value;
    });
    columns[key] = copied;
  }
  if (sampleCount < 3) sourceFailure('must contain at least 3 samples per selected column.');
  if (sampleCount > MAX_CALIBRATION_DATASET_SAMPLES) sourceFailure(`contains more than ${MAX_CALIBRATION_DATASET_SAMPLES} samples per selected column.`);
  return columns;
}

const TIME_FACTORS = Object.freeze({ s: 1, ms: 1e-3, min: 60 });
const CURRENT_FACTORS = Object.freeze({ A: 1, mA: 1e-3, kA: 1e3 });
const VOLTAGE_FACTORS = Object.freeze({ V: 1, mV: 1e-3, kV: 1e3 });

function convertSeries(values, convert, name) {
  return values.map((value, index) => {
    const converted = convert(value);
    if (!Number.isFinite(converted)) sourceFailure(`${name} sample ${index + 1} is outside the finite conversion range.`);
    return Object.is(converted, -0) ? 0 : converted;
  });
}

function validateTimeSeries(values, unit, toleranceS) {
  const seconds = convertSeries(values, (value) => value * TIME_FACTORS[unit], 'time');
  const deltas = [];
  for (let index = 1; index < seconds.length; index += 1) {
    const delta = seconds[index] - seconds[index - 1];
    if (!Number.isFinite(delta) || delta <= 0) sourceFailure(`time sample ${index + 1} must be strictly greater than sample ${index}.`);
    deltas.push(delta);
  }
  const samplePeriodS = (seconds[seconds.length - 1] - seconds[0]) / (seconds.length - 1);
  if (!Number.isFinite(samplePeriodS) || samplePeriodS <= 0 || samplePeriodS > 3_600) sourceFailure('mean sample period must be greater than 0 and no more than 3,600 seconds.');
  if (toleranceS > samplePeriodS * 0.1) sourceFailure(`mapping timeToleranceS ${toleranceS} exceeds 10% of the ${samplePeriodS}-second mean sample period.`);
  for (let index = 0; index < deltas.length; index += 1) {
    const error = Math.abs(deltas[index] - samplePeriodS);
    if (error > toleranceS) sourceFailure(`time delta ${index + 1} (${deltas[index]} s) differs from the mean ${samplePeriodS} s by ${error} s, beyond the explicit ${toleranceS} s tolerance.`);
  }
  return samplePeriodS;
}

function convertTemperature(value, unit) {
  if (unit === 'degC') return value;
  if (unit === 'K') return value - 273.15;
  return (value - 32) * (5 / 9);
}

function mediaTypeFor(mapping) {
  if (mapping.adapter === 'canonical-json') return 'application/json';
  return mapping.delimiter === '\t' ? 'text/tab-separated-values' : 'text/csv';
}

/** Normalize one complete source text into the immutable canonical dataset. */
export function importCalibrationDataset(sourceText, mappingValue) {
  assertSourceText(sourceText);
  const mapping = readCalibrationImportMapping(mappingValue);
  const rawColumns = mapping.adapter === 'canonical-json'
    ? canonicalJsonColumns(sourceText, mapping)
    : delimitedColumns(sourceText, mapping);
  const samplePeriodS = validateTimeSeries(rawColumns.time, mapping.units.time, mapping.timeToleranceS);
  const currentSign = mapping.sourceCurrentPositive === 'discharge' ? 1 : -1;
  const currentA = convertSeries(rawColumns.current,
    (value) => value * CURRENT_FACTORS[mapping.units.current] * currentSign, 'current');
  const voltageScale = mapping.sourceVoltageLocation === 'cell-terminal' ? mapping.binding.seriesCells : 1;
  const voltageV = convertSeries(rawColumns.voltage,
    (value) => value * VOLTAGE_FACTORS[mapping.units.voltage] * voltageScale, 'voltage');
  const temperatureC = mapping.columns.temperature === null ? null : convertSeries(
    rawColumns.temperature,
    (value) => convertTemperature(value, mapping.units.temperature),
    'temperature',
  );
  const sampleCount = currentA.length;
  const segments = mapping.segments === null ? [{
    id: 'full', startIndex: 0, endIndexExclusive: sampleCount,
    mode: 'dynamic', include: true,
  }] : mapping.segments;

  return materializeCalibrationDataset({
    id: mapping.dataset.id,
    kind: mapping.dataset.kind,
    purpose: mapping.dataset.purpose,
    source: {
      ...mapping.source,
      mediaType: mediaTypeFor(mapping),
      rawSha256: semanticDigest(sourceText),
    },
    binding: mapping.binding,
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: mapping.adapter,
      adapterVersion: CALIBRATION_IMPORT_ADAPTER_VERSION,
      mappingChecksum: mapping.checksum,
      sourceUnits: mapping.units,
      sourceCurrentPositive: mapping.sourceCurrentPositive,
      sourceVoltageLocation: mapping.sourceVoltageLocation,
      sourceTemperatureLocation: mapping.sourceTemperatureLocation,
      timeHandling: 'validated-uniform',
      originalSampleCount: sampleCount,
    },
    samplePeriodS,
    signals: { currentA, voltageV, temperatureC },
    segments,
    conventions: {
      timeBasis: 'uniform-sample-period',
      sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold',
      currentPositive: 'discharge',
      voltageLocation: 'pack-terminal',
      temperatureLocation: mapping.sourceTemperatureLocation,
    },
  });
}
