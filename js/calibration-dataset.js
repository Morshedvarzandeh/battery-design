// calibration-dataset.js — canonical, immutable traces for model calibration.
//
// Vendor exports vary in column names, units, polarity and sample timing.  The
// optimizer must never guess those semantics.  Import adapters therefore
// normalize raw files into this closed contract before js/sim2.js sees them.
// One dataset represents one state-reset trial. A later joint fit can consume
// a bounded array of these trials without changing this on-disk format.
// Keep this module browser-safe: it is shared by the browser, local API, CLI
// and future MCP inspection surfaces and performs no I/O.

import { semanticDigest } from './ontology.js';

export const CALIBRATION_DATASET_FORMAT = 'battery-design/calibration-dataset@1';
export const CALIBRATION_DATASET_SCHEMA_VERSION = '1.0.0';
export const MAX_CALIBRATION_DATASET_SAMPLES = 250_000;

export const CALIBRATION_DATASET_KINDS = Object.freeze(['synthetic', 'measured']);
export const CALIBRATION_DATASET_PURPOSES = Object.freeze(['calibration', 'validation']);
export const CALIBRATION_SEGMENT_MODES = Object.freeze([
  'charge', 'discharge', 'dynamic', 'pulse', 'rest', 'thermal-soak', 'other',
]);
export const CALIBRATION_TEMPERATURE_LOCATIONS = Object.freeze([
  'cell-average',
  'cell-core',
  'cell-surface',
  'coolant-outlet',
  'module-maximum',
]);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const nullableString = { type: ['string', 'null'], minLength: 1, maxLength: 256 };
const finiteSeriesSchema = {
  type: 'array', minItems: 3, maxItems: MAX_CALIBRATION_DATASET_SAMPLES,
  items: { type: 'number' },
};
const currentSeriesSchema = {
  ...finiteSeriesSchema, items: { type: 'number', minimum: -10_000_000, maximum: 10_000_000 },
};
const voltageSeriesSchema = {
  ...finiteSeriesSchema, items: { type: 'number', minimum: 0, maximum: 10_000_000 },
};
const temperatureSeriesSchema = {
  ...finiteSeriesSchema, items: { type: 'number', minimum: -100, maximum: 1_000 },
};

// Published for external tooling. Runtime validation below enforces the same
// closed shape plus the cross-field rules JSON Schema cannot express compactly
// (equal signal lengths, checksum identity, and temperature/location pairing).
export const CALIBRATION_DATASET_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://morshedvarzandeh.github.io/battery-design/calibration-dataset/1.0.0',
  title: 'battery-design single-trial calibration dataset',
  type: 'object',
  additionalProperties: false,
  required: [
    'format', 'schemaVersion', 'id', 'kind', 'purpose', 'source', 'binding',
    'normalization', 'samplePeriodS', 'signals', 'segments', 'conventions', 'checksum',
  ],
  properties: {
    format: { const: CALIBRATION_DATASET_FORMAT },
    schemaVersion: { const: CALIBRATION_DATASET_SCHEMA_VERSION },
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    kind: { type: 'string', enum: CALIBRATION_DATASET_KINDS },
    purpose: { type: 'string', enum: CALIBRATION_DATASET_PURPOSES },
    source: {
      type: 'object', additionalProperties: false,
      required: ['tool', 'toolVersion', 'model', 'runId', 'generatedAt', 'mediaType', 'rawSha256'],
      properties: {
        tool: { type: 'string', minLength: 1, maxLength: 128 },
        toolVersion: nullableString,
        model: nullableString,
        runId: nullableString,
        generatedAt: {
          type: ['string', 'null'], format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$',
        },
        mediaType: { type: 'string', minLength: 3, maxLength: 128 },
        rawSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      },
    },
    binding: {
      type: 'object', additionalProperties: false,
      required: [
        'cellId', 'seriesCells', 'parallelCells', 'startSoC', 'ambientC',
        'moduleCount', 'initialState',
      ],
      properties: {
        cellId: nullableString,
        seriesCells: { type: 'integer', minimum: 1, maximum: 100_000 },
        parallelCells: { type: 'integer', minimum: 1, maximum: 100_000 },
        startSoC: { type: 'number', minimum: 0, maximum: 1 },
        ambientC: { type: 'number', minimum: -100, maximum: 200 },
        moduleCount: { type: 'integer', minimum: 1, maximum: 10_000 },
        initialState: { const: 'rested-equilibrium-at-ambient' },
      },
    },
    normalization: {
      type: 'object', additionalProperties: false,
      required: [
        'format', 'adapter', 'adapterVersion', 'mappingChecksum', 'sourceUnits',
        'sourceCurrentPositive', 'sourceCurrentScope', 'sourceVoltageLocation',
        'sourceTemperatureLocation', 'sourceSampleAlignment',
        'sourceFirstSampleTimeS', 'sourceResetTimeS', 'timeHandling',
        'originalSampleCount',
      ],
      properties: {
        format: { const: 'battery-design/calibration-normalization@1' },
        adapter: { type: 'string', enum: ['canonical-json', 'delimited-columns'] },
        adapterVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
        mappingChecksum: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        sourceUnits: {
          type: 'object', additionalProperties: false,
          required: ['time', 'current', 'voltage', 'temperature'],
          properties: {
            time: { type: 'string', minLength: 1, maxLength: 32 },
            current: { type: 'string', minLength: 1, maxLength: 32 },
            voltage: { type: 'string', minLength: 1, maxLength: 32 },
            temperature: { type: ['string', 'null'], minLength: 1, maxLength: 32 },
          },
        },
        sourceCurrentPositive: { type: 'string', enum: ['charge', 'discharge'] },
        sourceCurrentScope: { type: 'string', enum: ['cell', 'pack'] },
        sourceVoltageLocation: { type: 'string', enum: ['cell-terminal', 'pack-terminal'] },
        sourceTemperatureLocation: {
          type: ['string', 'null'], enum: [...CALIBRATION_TEMPERATURE_LOCATIONS, null],
        },
        sourceSampleAlignment: { const: 'end-of-step' },
        sourceFirstSampleTimeS: { type: 'number', minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 },
        sourceResetTimeS: { type: 'number', minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 },
        timeHandling: { const: 'validated-uniform' },
        originalSampleCount: {
          type: 'integer', minimum: 3, maximum: MAX_CALIBRATION_DATASET_SAMPLES,
        },
      },
    },
    samplePeriodS: { type: 'number', exclusiveMinimum: 0, maximum: 3_600 },
    signals: {
      type: 'object', additionalProperties: false,
      required: ['currentA', 'voltageV', 'temperatureC'],
      properties: {
        currentA: currentSeriesSchema,
        voltageV: voltageSeriesSchema,
        temperatureC: { anyOf: [temperatureSeriesSchema, { type: 'null' }] },
      },
    },
    segments: {
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
    conventions: {
      type: 'object', additionalProperties: false,
      required: [
        'timeBasis', 'timeOrigin', 'firstSampleOffsetS', 'sampleAlignment',
        'currentHold', 'currentPositive', 'currentScope', 'voltageLocation',
        'temperatureLocation',
      ],
      properties: {
        timeBasis: { const: 'uniform-sample-period' },
        timeOrigin: { const: 'trial-reset' },
        firstSampleOffsetS: { type: 'number', exclusiveMinimum: 0, maximum: 3_600 },
        sampleAlignment: { const: 'end-of-step' },
        currentHold: { const: 'zero-order-hold' },
        currentPositive: { const: 'discharge' },
        currentScope: { const: 'pack' },
        voltageLocation: { const: 'pack-terminal' },
        temperatureLocation: {
          type: ['string', 'null'], enum: [...CALIBRATION_TEMPERATURE_LOCATIONS, null],
        },
      },
    },
    checksum: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
});

const ROOT_KEYS = Object.freeze([
  'format', 'schemaVersion', 'id', 'kind', 'purpose', 'source', 'binding',
  'normalization', 'samplePeriodS', 'signals', 'segments', 'conventions', 'checksum',
]);
const PAYLOAD_KEYS = Object.freeze([
  'id', 'kind', 'purpose', 'source', 'binding', 'normalization', 'samplePeriodS',
  'signals', 'segments', 'conventions',
]);
const SOURCE_KEYS = Object.freeze([
  'tool', 'toolVersion', 'model', 'runId', 'generatedAt', 'mediaType', 'rawSha256',
]);
const BINDING_KEYS = Object.freeze([
  'cellId', 'seriesCells', 'parallelCells', 'startSoC', 'ambientC', 'moduleCount',
  'initialState',
]);
const SIGNAL_KEYS = Object.freeze(['currentA', 'voltageV', 'temperatureC']);
const CONVENTION_KEYS = Object.freeze([
  'timeBasis', 'timeOrigin', 'firstSampleOffsetS', 'sampleAlignment', 'currentHold',
  'currentPositive', 'currentScope', 'voltageLocation', 'temperatureLocation',
]);
const NORMALIZATION_KEYS = Object.freeze([
  'format', 'adapter', 'adapterVersion', 'mappingChecksum', 'sourceUnits',
  'sourceCurrentPositive', 'sourceCurrentScope', 'sourceVoltageLocation',
  'sourceTemperatureLocation', 'sourceSampleAlignment', 'sourceFirstSampleTimeS',
  'sourceResetTimeS', 'timeHandling', 'originalSampleCount',
]);
const SOURCE_UNIT_KEYS = Object.freeze(['time', 'current', 'voltage', 'temperature']);
const SEGMENT_KEYS = Object.freeze(['id', 'startIndex', 'endIndexExclusive', 'mode', 'include']);

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue(path, 'type', 'must be an object'));
    return false;
  }
  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(issue(`${path}.${key}`, 'required', 'is required'));
    }
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) errors.push(issue(`${path}.${key}`, 'additionalProperties', 'is not allowed'));
  }
  return true;
}

function stringOrNull(value, path, errors) {
  if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 256)) {
    errors.push(issue(path, 'type', 'must be null or a non-empty string'));
  }
}

function finiteInRange(value, min, max, path, errors, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    errors.push(issue(path, 'range', `must be ${integer ? 'an integer ' : ''}from ${min} to ${max}`));
  }
}

function finiteSeries(value, path, errors, min, max) {
  if (!Array.isArray(value)) {
    errors.push(issue(path, 'type', 'must be an array'));
    return null;
  }
  if (value.length < 3 || value.length > MAX_CALIBRATION_DATASET_SAMPLES) {
    errors.push(issue(path, 'length', `must contain 3 to ${MAX_CALIBRATION_DATASET_SAMPLES.toLocaleString()} samples`));
  }
  for (let index = 0; index < value.length; index += 1) {
    const sample = value[index];
    if (!Number.isFinite(sample) || sample < min || sample > max) {
      errors.push(issue(`${path}[${index}]`, 'range', `must be a finite number from ${min} to ${max}`));
      if (errors.length > 100) break;
    }
  }
  return value.length;
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

function checksumPayload(dataset) {
  return Object.fromEntries(ROOT_KEYS.filter((key) => key !== 'checksum').map((key) => [key, dataset[key]]));
}

/** Validate a materialized dataset without modifying caller-owned data. */
export function validateCalibrationDataset(value) {
  const errors = [];
  if (!exactKeys(value, ROOT_KEYS, '$', errors)) return deepFreeze(errors);

  if (value.format !== CALIBRATION_DATASET_FORMAT) errors.push(issue('$.format', 'const', `must equal ${CALIBRATION_DATASET_FORMAT}`));
  if (value.schemaVersion !== CALIBRATION_DATASET_SCHEMA_VERSION) errors.push(issue('$.schemaVersion', 'const', `must equal ${CALIBRATION_DATASET_SCHEMA_VERSION}`));
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id)) {
    errors.push(issue('$.id', 'pattern', 'must be a portable 1–128 character dataset id'));
  }
  if (!CALIBRATION_DATASET_KINDS.includes(value.kind)) errors.push(issue('$.kind', 'enum', `must be one of: ${CALIBRATION_DATASET_KINDS.join(', ')}`));
  if (!CALIBRATION_DATASET_PURPOSES.includes(value.purpose)) errors.push(issue('$.purpose', 'enum', `must be one of: ${CALIBRATION_DATASET_PURPOSES.join(', ')}`));

  if (exactKeys(value.source, SOURCE_KEYS, '$.source', errors)) {
    if (typeof value.source.tool !== 'string' || !value.source.tool.trim() || value.source.tool.length > 128) {
      errors.push(issue('$.source.tool', 'length', 'must be a non-empty string up to 128 characters'));
    }
    for (const key of ['toolVersion', 'model', 'runId']) stringOrNull(value.source[key], `$.source.${key}`, errors);
    if (value.source.generatedAt !== null && !validIsoInstant(value.source.generatedAt)) errors.push(issue('$.source.generatedAt', 'format', 'must be null or an ISO 8601 timestamp with a timezone'));
    if (typeof value.source.mediaType !== 'string' || !/^[^\s/]+\/[^\s/]+$/.test(value.source.mediaType) || value.source.mediaType.length > 128) {
      errors.push(issue('$.source.mediaType', 'format', 'must be a portable media type such as text/csv'));
    }
    if (typeof value.source.rawSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.source.rawSha256)) {
      errors.push(issue('$.source.rawSha256', 'pattern', 'must be a lowercase SHA-256 digest'));
    }
  }

  if (exactKeys(value.binding, BINDING_KEYS, '$.binding', errors)) {
    stringOrNull(value.binding.cellId, '$.binding.cellId', errors);
    finiteInRange(value.binding.seriesCells, 1, 100_000, '$.binding.seriesCells', errors, true);
    finiteInRange(value.binding.parallelCells, 1, 100_000, '$.binding.parallelCells', errors, true);
    finiteInRange(value.binding.startSoC, 0, 1, '$.binding.startSoC', errors);
    finiteInRange(value.binding.ambientC, -100, 200, '$.binding.ambientC', errors);
    finiteInRange(value.binding.moduleCount, 1, 10_000, '$.binding.moduleCount', errors, true);
    if (value.binding.initialState !== 'rested-equilibrium-at-ambient') {
      errors.push(issue('$.binding.initialState', 'const', 'must equal rested-equilibrium-at-ambient; non-rested initial RC, hysteresis or thermal states are not supported'));
    }
  }

  if (exactKeys(value.normalization, NORMALIZATION_KEYS, '$.normalization', errors)) {
    if (value.normalization.format !== 'battery-design/calibration-normalization@1') errors.push(issue('$.normalization.format', 'const', 'must equal battery-design/calibration-normalization@1'));
    if (!['canonical-json', 'delimited-columns'].includes(value.normalization.adapter)) errors.push(issue('$.normalization.adapter', 'enum', 'must be canonical-json or delimited-columns'));
    if (typeof value.normalization.adapterVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.normalization.adapterVersion)) errors.push(issue('$.normalization.adapterVersion', 'pattern', 'must be a semantic numeric version'));
    if (typeof value.normalization.mappingChecksum !== 'string' || !/^[0-9a-f]{64}$/.test(value.normalization.mappingChecksum)) errors.push(issue('$.normalization.mappingChecksum', 'pattern', 'must be a lowercase SHA-256 digest'));
    if (exactKeys(value.normalization.sourceUnits, SOURCE_UNIT_KEYS, '$.normalization.sourceUnits', errors)) {
      for (const key of ['time', 'current', 'voltage']) {
        const unit = value.normalization.sourceUnits[key];
        if (typeof unit !== 'string' || !unit.trim() || unit.length > 32) errors.push(issue(`$.normalization.sourceUnits.${key}`, 'type', 'must be a non-empty unit string'));
      }
      const temperatureUnit = value.normalization.sourceUnits.temperature;
      if (temperatureUnit !== null && (typeof temperatureUnit !== 'string' || !temperatureUnit.trim() || temperatureUnit.length > 32)) errors.push(issue('$.normalization.sourceUnits.temperature', 'type', 'must be null or a non-empty unit string'));
    }
    if (!['charge', 'discharge'].includes(value.normalization.sourceCurrentPositive)) errors.push(issue('$.normalization.sourceCurrentPositive', 'enum', 'must be charge or discharge'));
    if (!['cell', 'pack'].includes(value.normalization.sourceCurrentScope)) errors.push(issue('$.normalization.sourceCurrentScope', 'enum', 'must be cell or pack'));
    if (!['cell-terminal', 'pack-terminal'].includes(value.normalization.sourceVoltageLocation)) errors.push(issue('$.normalization.sourceVoltageLocation', 'enum', 'must be cell-terminal or pack-terminal'));
    const sourceTemperatureLocation = value.normalization.sourceTemperatureLocation;
    if (sourceTemperatureLocation !== null && !CALIBRATION_TEMPERATURE_LOCATIONS.includes(sourceTemperatureLocation)) errors.push(issue('$.normalization.sourceTemperatureLocation', 'enum', 'must identify the source temperature location'));
    if (value.normalization.sourceSampleAlignment !== 'end-of-step') errors.push(issue('$.normalization.sourceSampleAlignment', 'const', 'must equal end-of-step; unknown or start-of-step source phase must be normalized explicitly before import'));
    finiteInRange(value.normalization.sourceFirstSampleTimeS, -1_000_000_000_000, 1_000_000_000_000, '$.normalization.sourceFirstSampleTimeS', errors);
    finiteInRange(value.normalization.sourceResetTimeS, -1_000_000_000_000, 1_000_000_000_000, '$.normalization.sourceResetTimeS', errors);
    if (value.normalization.timeHandling !== 'validated-uniform') errors.push(issue('$.normalization.timeHandling', 'const', 'must equal validated-uniform'));
    finiteInRange(value.normalization.originalSampleCount, 3, MAX_CALIBRATION_DATASET_SAMPLES, '$.normalization.originalSampleCount', errors, true);
  }

  finiteInRange(value.samplePeriodS, Number.MIN_VALUE, 3_600, '$.samplePeriodS', errors);

  let currentLength = null, voltageLength = null, temperatureLength = null;
  if (exactKeys(value.signals, SIGNAL_KEYS, '$.signals', errors)) {
    currentLength = finiteSeries(value.signals.currentA, '$.signals.currentA', errors, -10_000_000, 10_000_000);
    voltageLength = finiteSeries(value.signals.voltageV, '$.signals.voltageV', errors, 0, 10_000_000);
    if (value.signals.temperatureC !== null) {
      temperatureLength = finiteSeries(value.signals.temperatureC, '$.signals.temperatureC', errors, -100, 1_000);
    }
    if (currentLength != null && voltageLength != null && currentLength !== voltageLength) {
      errors.push(issue('$.signals.voltageV', 'length', `must contain ${currentLength} samples to match currentA`));
    }
    if (currentLength != null && temperatureLength != null && currentLength !== temperatureLength) {
      errors.push(issue('$.signals.temperatureC', 'length', `must contain ${currentLength} samples to match currentA`));
    }
    if (currentLength != null && value.normalization?.originalSampleCount !== currentLength) {
      errors.push(issue('$.normalization.originalSampleCount', 'identity', `must equal the ${currentLength} canonical samples because @1 permits no implicit resampling or row loss`));
    }
  }

  if (!Array.isArray(value.segments) || !value.segments.length || value.segments.length > 10_000) {
    errors.push(issue('$.segments', 'length', 'must contain 1 to 10,000 segments'));
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
      if (!Number.isInteger(segment.endIndexExclusive) || segment.endIndexExclusive <= segment.startIndex || (currentLength != null && segment.endIndexExclusive > currentLength)) errors.push(issue(`${path}.endIndexExclusive`, 'range', 'must be after startIndex and within the signal length'));
      if (!CALIBRATION_SEGMENT_MODES.includes(segment.mode)) errors.push(issue(`${path}.mode`, 'enum', `must be one of: ${CALIBRATION_SEGMENT_MODES.join(', ')}`));
      if (typeof segment.include !== 'boolean') errors.push(issue(`${path}.include`, 'type', 'must be boolean'));
      if (Number.isInteger(segment.endIndexExclusive)) cursor = segment.endIndexExclusive;
    }
    if (currentLength != null && cursor !== currentLength) errors.push(issue('$.segments', 'coverage', `must cover all ${currentLength} signal samples exactly once`));
    if (!value.segments.some((segment) => segment?.include === true)) errors.push(issue('$.segments', 'selection', 'must include at least one segment for this dataset purpose'));
  }

  if (exactKeys(value.conventions, CONVENTION_KEYS, '$.conventions', errors)) {
    if (value.conventions.timeBasis !== 'uniform-sample-period') errors.push(issue('$.conventions.timeBasis', 'const', 'must equal uniform-sample-period'));
    if (value.conventions.timeOrigin !== 'trial-reset') errors.push(issue('$.conventions.timeOrigin', 'const', 'must equal trial-reset'));
    finiteInRange(value.conventions.firstSampleOffsetS, Number.MIN_VALUE, 3_600, '$.conventions.firstSampleOffsetS', errors);
    if (value.conventions.sampleAlignment !== 'end-of-step') errors.push(issue('$.conventions.sampleAlignment', 'const', 'must equal end-of-step'));
    if (value.conventions.currentHold !== 'zero-order-hold') errors.push(issue('$.conventions.currentHold', 'const', 'must equal zero-order-hold'));
    if (value.conventions.currentPositive !== 'discharge') errors.push(issue('$.conventions.currentPositive', 'const', 'must equal discharge'));
    if (value.conventions.currentScope !== 'pack') errors.push(issue('$.conventions.currentScope', 'const', 'must equal pack'));
    if (value.conventions.voltageLocation !== 'pack-terminal') errors.push(issue('$.conventions.voltageLocation', 'const', 'must equal pack-terminal'));
    const location = value.conventions.temperatureLocation;
    if (location !== null && !CALIBRATION_TEMPERATURE_LOCATIONS.includes(location)) {
      errors.push(issue('$.conventions.temperatureLocation', 'enum', `must be null or one of: ${CALIBRATION_TEMPERATURE_LOCATIONS.join(', ')}`));
    }
    if (value.signals?.temperatureC === null && location !== null) {
      errors.push(issue('$.conventions.temperatureLocation', 'pairing', 'must be null when temperatureC is null'));
    }
    if (Array.isArray(value.signals?.temperatureC) && location === null) {
      errors.push(issue('$.conventions.temperatureLocation', 'pairing', 'must identify the temperature signal location'));
    }
    const sourceUnits = value.normalization?.sourceUnits;
    const sourceLocation = value.normalization?.sourceTemperatureLocation;
    if (value.signals?.temperatureC === null && (sourceUnits?.temperature !== null || sourceLocation !== null)) {
      errors.push(issue('$.normalization.sourceTemperatureLocation', 'pairing', 'source temperature unit and location must both be null when no temperature signal is present'));
    }
    if (Array.isArray(value.signals?.temperatureC)
      && (sourceUnits?.temperature == null || sourceLocation !== location)) {
      errors.push(issue('$.normalization.sourceTemperatureLocation', 'pairing', 'source temperature unit/location must describe the canonical temperature channel without changing its physical location'));
    }
  }

  if (Number.isFinite(value.samplePeriodS)) {
    const offset = value.conventions?.firstSampleOffsetS;
    const first = value.normalization?.sourceFirstSampleTimeS;
    const reset = value.normalization?.sourceResetTimeS;
    const tolerance = Math.max(1e-12, Math.abs(value.samplePeriodS) * 1e-12);
    if (Number.isFinite(offset) && Math.abs(offset - value.samplePeriodS) > tolerance) {
      errors.push(issue('$.conventions.firstSampleOffsetS', 'identity', 'must equal samplePeriodS so sample zero is the first end-of-step observation after trial reset'));
    }
    if (Number.isFinite(first) && Number.isFinite(reset)
      && Math.abs((first - reset) - value.samplePeriodS) > tolerance) {
      errors.push(issue('$.normalization.sourceResetTimeS', 'identity', 'must be exactly one sample period before sourceFirstSampleTimeS'));
    }
  }

  if (typeof value.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(value.checksum)) {
    errors.push(issue('$.checksum', 'pattern', 'must be a lowercase SHA-256 digest'));
  } else if (semanticDigest(checksumPayload(value)) !== value.checksum) {
    errors.push(issue('$.checksum', 'identity', 'does not match the canonical dataset content'));
  }
  return deepFreeze(errors);
}

export class CalibrationDatasetValidationError extends TypeError {
  constructor(errors) {
    super(`Calibration dataset is invalid: ${errors.map(({ path, message }) => `${path} ${message}`).join('; ')}`);
    this.name = 'CalibrationDatasetValidationError';
    this.errors = errors;
  }
}

/** Build a canonical dataset from an exact payload and add its content id. */
export function materializeCalibrationDataset(payload) {
  const inputErrors = [];
  if (!exactKeys(payload, PAYLOAD_KEYS, '$', inputErrors)) throw new CalibrationDatasetValidationError(deepFreeze(inputErrors));
  const cloned = cloneJson(payload);
  const withoutChecksum = {
    format: CALIBRATION_DATASET_FORMAT,
    schemaVersion: CALIBRATION_DATASET_SCHEMA_VERSION,
    ...cloned,
  };
  const dataset = { ...withoutChecksum, checksum: semanticDigest(withoutChecksum) };
  const errors = validateCalibrationDataset(dataset);
  if (errors.length) throw new CalibrationDatasetValidationError(errors);
  return deepFreeze(dataset);
}

/** Read self-consistent serialized content without claiming external trust. */
export function readCalibrationDataset(value) {
  const errors = validateCalibrationDataset(value);
  if (errors.length) throw new CalibrationDatasetValidationError(errors);
  return deepFreeze(cloneJson(value));
}

/** Verify serialized content against an independently trusted expected digest. */
export function verifyCalibrationDataset(value, options) {
  if (!isPlainObject(options)) throw new TypeError('Calibration dataset verification requires one options object with expectedChecksum.');
  const unsupported = Object.keys(options).filter((key) => key !== 'expectedChecksum');
  if (unsupported.length) throw new TypeError(`Calibration dataset verification does not accept option(s): ${unsupported.join(', ')}.`);
  const expectedChecksum = options.expectedChecksum;
  if (typeof expectedChecksum !== 'string' || !/^[0-9a-f]{64}$/.test(expectedChecksum)) throw new TypeError('expectedChecksum must be a lowercase SHA-256 digest.');
  const dataset = readCalibrationDataset(value);
  if (dataset.checksum !== expectedChecksum) throw new CalibrationDatasetValidationError(deepFreeze([
    issue('$.checksum', 'trustedIdentity', `does not match trusted expected checksum ${expectedChecksum}`),
  ]));
  return dataset;
}
