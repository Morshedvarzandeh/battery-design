import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALIBRATION_IMPORT_MAPPING_FORMAT,
  CALIBRATION_IMPORT_MAPPING_SCHEMA,
  CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION,
  CalibrationImportMappingValidationError,
  CalibrationSourceImportError,
  MAX_CALIBRATION_SOURCE_BYTES,
  MAX_CALIBRATION_SOURCE_COLUMNS,
  importCalibrationDataset,
  materializeCalibrationImportMapping,
  readCalibrationImportMapping,
  validateCalibrationImportMapping,
} from '../js/calibration-import.js';
import { semanticDigest } from '../js/ontology.js';

function mappingPayload(overrides = {}) {
  const base = {
    adapter: 'delimited-columns',
    delimiter: ',',
    dataset: { id: 'solver-run-0042', kind: 'synthetic', purpose: 'calibration' },
    source: {
      tool: 'External high-fidelity solver', toolVersion: '2026.1',
      model: 'governed-cell-model', runId: 'run-0042', generatedAt: '2026-08-07T10:30:00Z',
    },
    binding: {
      cellId: 'cell-001', seriesCells: 96, parallelCells: 4,
      startSoC: 0.9, ambientC: 25, moduleCount: 8,
    },
    columns: { time: 'time', current: 'current', voltage: 'voltage', temperature: 'temperature' },
    units: { time: 's', current: 'A', voltage: 'V', temperature: 'degC' },
    sourceCurrentPositive: 'discharge',
    sourceVoltageLocation: 'pack-terminal',
    sourceTemperatureLocation: 'cell-core',
    timeToleranceS: 1e-9,
    segments: null,
  };
  return {
    ...base,
    ...overrides,
    dataset: { ...base.dataset, ...overrides.dataset },
    source: { ...base.source, ...overrides.source },
    binding: { ...base.binding, ...overrides.binding },
    columns: { ...base.columns, ...overrides.columns },
    units: { ...base.units, ...overrides.units },
  };
}

function mapping(overrides = {}) {
  return materializeCalibrationImportMapping(mappingPayload(overrides));
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('import mappings are closed, checksummed, schema-published and deeply immutable', () => {
  const callerPayload = mappingPayload();
  const value = materializeCalibrationImportMapping(callerPayload);
  callerPayload.columns.time = 'caller-mutated';
  assert.equal(value.columns.time, 'time', 'materialization does not retain caller-owned objects');
  assert.equal(value.format, CALIBRATION_IMPORT_MAPPING_FORMAT);
  assert.equal(value.schemaVersion, CALIBRATION_IMPORT_MAPPING_SCHEMA_VERSION);
  assert.deepEqual(validateCalibrationImportMapping(value), []);
  assert.equal(value.checksum, semanticDigest(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'checksum'),
  )));
  assert.equal(CALIBRATION_IMPORT_MAPPING_SCHEMA.additionalProperties, false);
  assert.equal(CALIBRATION_IMPORT_MAPPING_SCHEMA.properties.columns.additionalProperties, false);
  assert.equal(CALIBRATION_IMPORT_MAPPING_SCHEMA.properties.units.additionalProperties, false);
  assertDeepFrozen(value);
  assertDeepFrozen(CALIBRATION_IMPORT_MAPPING_SCHEMA);
  assert.throws(() => value.columns.time = 'other', TypeError);

  assert.throws(() => materializeCalibrationImportMapping({
    ...mappingPayload(), aliases: { timestamp: 'time' },
  }), (error) => {
    assert.ok(error instanceof CalibrationImportMappingValidationError);
    assert.match(error.message, /aliases.*not allowed/);
    return true;
  });

  const tampered = structuredClone(value);
  tampered.columns.time = 'timestamp';
  assert.throws(() => readCalibrationImportMapping(tampered), /checksum.*canonical mapping content/);
});

test('quoted semicolon CSV, BOM and CRLF normalize every source row exactly', () => {
  const source = [
    '\uFEFF"time;raw";"cell ""I""";cell_mV;temp_K;notes',
    '0;0;3700;298.15;"first;row"',
    '100;1000;3650;298.25;"embedded\r\nline"',
    '200;-2000;3600;298.35;plain',
    '300;0;3690;298.45;last',
  ].join('\r\n');
  const importMap = mapping({
    delimiter: ';',
    columns: { time: 'time;raw', current: 'cell "I"', voltage: 'cell_mV', temperature: 'temp_K' },
    units: { time: 'ms', current: 'mA', voltage: 'mV', temperature: 'K' },
    sourceCurrentPositive: 'charge',
    sourceVoltageLocation: 'cell-terminal',
    timeToleranceS: 1e-12,
  });
  const dataset = importCalibrationDataset(source, importMap);

  assert.equal(dataset.source.rawSha256, semanticDigest(source));
  assert.equal(dataset.normalization.mappingChecksum, importMap.checksum);
  assert.equal(dataset.source.mediaType, 'text/csv');
  assert.ok(Math.abs(dataset.samplePeriodS - 0.1) < 1e-15);
  assert.deepEqual(dataset.signals.currentA, [0, -1, 2, 0]);
  [355.2, 350.4, 345.6, 354.24].forEach((expected, index) => {
    assert.ok(Math.abs(dataset.signals.voltageV[index] - expected) < 1e-12);
  });
  assert.ok(Math.abs(dataset.signals.temperatureC[0] - 25) < 1e-12);
  assert.ok(Math.abs(dataset.signals.temperatureC[3] - 25.3) < 1e-12);
  assert.deepEqual(dataset.segments, [
    { id: 'full', startIndex: 0, endIndexExclusive: 4, mode: 'dynamic', include: true },
  ]);
  assert.equal(dataset.conventions.sampleAlignment, 'end-of-step');
  assert.equal(dataset.conventions.currentPositive, 'discharge');
  assert.equal(dataset.conventions.voltageLocation, 'pack-terminal');
  assertDeepFrozen(dataset);
});

test('canonical JSON uses exact named arrays and allowlisted unit conversions', () => {
  const cases = [
    {
      units: { time: 's', current: 'A', voltage: 'V', temperature: 'degC' },
      source: { clock: [0, 1, 2], amps: [0, 2, -1], volts: [400, 399, 398], thermal: [25, 26, 27] },
      expected: { period: 1, current: [0, 2, -1], voltage: [400, 399, 398], temperature: [25, 26, 27] },
    },
    {
      units: { time: 'ms', current: 'mA', voltage: 'mV', temperature: 'K' },
      source: { clock: [0, 100, 200], amps: [0, 2000, -1000], volts: [400000, 399000, 398000], thermal: [298.15, 299.15, 300.15] },
      expected: { period: 0.1, current: [0, 2, -1], voltage: [400, 399, 398], temperature: [25, 26, 27] },
    },
    {
      units: { time: 'min', current: 'kA', voltage: 'kV', temperature: 'degF' },
      source: { clock: [0, 1 / 60, 2 / 60], amps: [0, 0.002, -0.001], volts: [0.4, 0.399, 0.398], thermal: [77, 78.8, 80.6] },
      expected: { period: 1, current: [0, 2, -1], voltage: [400, 399, 398], temperature: [25, 26, 27] },
    },
  ];

  for (const [index, item] of cases.entries()) {
    const importMap = mapping({
      adapter: 'canonical-json', delimiter: null,
      dataset: { id: `json-units-${index}` },
      columns: { time: 'clock', current: 'amps', voltage: 'volts', temperature: 'thermal' },
      units: item.units,
      timeToleranceS: 1e-12,
    });
    const dataset = importCalibrationDataset(JSON.stringify({
      ...item.source, solverPrivateState: ['ignored', 'but', 'custodied'],
    }), importMap);
    assert.ok(Math.abs(dataset.samplePeriodS - item.expected.period) < 1e-12);
    assert.deepEqual(dataset.signals.currentA, item.expected.current);
    assert.deepEqual(dataset.signals.voltageV, item.expected.voltage);
    item.expected.temperature.forEach((expected, sampleIndex) => {
      assert.ok(Math.abs(dataset.signals.temperatureC[sampleIndex] - expected) < 1e-10);
    });
    assert.equal(dataset.source.mediaType, 'application/json');
    assert.equal(dataset.conventions.temperatureLocation, 'cell-core');
  }
});

test('cell voltage scaling, charge polarity and absent temperature are explicit', () => {
  const importMap = mapping({
    adapter: 'canonical-json', delimiter: null,
    columns: { time: 't', current: 'i', voltage: 'cell_v', temperature: null },
    units: { time: 's', current: 'A', voltage: 'V', temperature: null },
    sourceCurrentPositive: 'charge',
    sourceVoltageLocation: 'cell-terminal',
    sourceTemperatureLocation: null,
    binding: { seriesCells: 4 },
  });
  const dataset = importCalibrationDataset(JSON.stringify({
    t: [0, 1, 2], i: [0, 3, -2], cell_v: [3.7, 3.6, 3.5], temperature_guess: [99, 99, 99],
  }), importMap);
  assert.deepEqual(dataset.signals.currentA, [0, -3, 2]);
  assert.deepEqual(dataset.signals.voltageV, [14.8, 14.4, 14]);
  assert.equal(dataset.signals.temperatureC, null);
  assert.equal(dataset.conventions.temperatureLocation, null);
  assert.equal(dataset.normalization.sourceUnits.temperature, null);
});

test('no aliases are guessed and duplicate or missing delimited headers fail closed', () => {
  const importMap = mapping();
  assert.throws(() => importCalibrationDataset(
    'timestamp,current,voltage,temperature\n0,1,400,25\n1,1,399,25\n2,1,398,25', importMap,
  ), /missing the exact time column "time"/);
  assert.throws(() => importCalibrationDataset(
    'time,current,voltage,time\n0,1,400,25\n1,1,399,25\n2,1,398,25', importMap,
  ), /header "time" is duplicated/);
  assert.throws(() => importCalibrationDataset(
    'time,,voltage,temperature\n0,1,400,25\n1,1,399,25\n2,1,398,25', importMap,
  ), /header column 2 is empty/);
  assert.throws(() => importCalibrationDataset(
    'time,current,voltage,temperature\n0,1,400,25\n1,1,399,25\n2,1,398,25\n',
    mapping({ columns: { time: ' time ' } }),
  ), /missing the exact time column " time "/);
});

test('malformed rows and non-decimal numeric tokens are rejected without row loss', () => {
  const importMap = mapping();
  const malformed = [
    ['time,current,voltage,temperature\n0,1,400,25\n1,1,399\n2,1,398,25', /row 3 has 3 columns; expected exactly 4/],
    ['time,current,voltage,temperature\n0,1,400,25\n1,1,399,25,extra\n2,1,398,25', /row 3 has 5 columns; expected exactly 4/],
    ['time,current,voltage,temperature\n0,1,400,25\n\n2,1,398,25', /row 3 has 1 columns; expected exactly 4/],
    ['time,current,voltage,temperature\n0,1,400,25\n1, 1,399,25\n2,1,398,25', /strict decimal number/],
    ['time,current,voltage,temperature\n0,1,400,25\n1,NaN,399,25\n2,1,398,25', /strict decimal number/],
    ['time,current,voltage,temperature\n0,1,400,25\n1,0x10,399,25\n2,1,398,25', /strict decimal number/],
    ['time,current,voltage,temperature\n0,1,400,25\n1,1e999,399,25\n2,1,398,25', /must be finite/],
    ['time,current,voltage,temperature\n0,1,400,25\n1,"1"x,399,25\n2,1,398,25', /unexpected character after a closing quote/],
    ['time,current,voltage,temperature\n0,1,400,25\n1,"1,399,25\n2,1,398,25', /ends inside a quoted field/],
  ];
  for (const [source, expected] of malformed) {
    assert.throws(() => importCalibrationDataset(source, importMap), (error) => {
      assert.ok(error instanceof CalibrationSourceImportError);
      assert.match(error.message, expected);
      return true;
    });
  }
});

test('every timestamp delta is increasing and uniform within the explicit tolerance', () => {
  const csv = (times) => [
    'time,current,voltage,temperature',
    ...times.map((time) => `${time},1,400,25`),
  ].join('\n');

  assert.throws(() => importCalibrationDataset(csv([0, 1, 1, 2]), mapping()), /strictly greater/);
  assert.throws(() => importCalibrationDataset(csv([0, 1, 2.02, 3.02]), mapping({ timeToleranceS: 0.001 })), /time delta 1.*beyond the explicit/);
  assert.throws(() => importCalibrationDataset(csv([0, 1, 2]), mapping({ timeToleranceS: 0.11 })), /exceeds 10%/);

  const accepted = importCalibrationDataset(csv([0, 1.0005, 2]), mapping({ timeToleranceS: 0.001 }));
  assert.equal(accepted.signals.currentA.length, 3, 'all source rows survive exact normalization');
  assert.equal(accepted.normalization.originalSampleCount, 3);
  assert.equal(accepted.samplePeriodS, 1);
  assert.equal(accepted.conventions.sampleAlignment, 'end-of-step');
});

test('exact mapped segments are optional and must cover the source once', () => {
  const source = 'time,current,voltage,temperature\n0,0,400,25\n1,2,398,25\n2,2,397,26\n3,0,400,26';
  const mapped = mapping({ segments: [
    { id: 'rest', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: false },
    { id: 'pulse', startIndex: 1, endIndexExclusive: 4, mode: 'pulse', include: true },
  ] });
  assert.deepEqual(importCalibrationDataset(source, mapped).segments, mapped.segments);

  const short = mapping({ segments: [
    { id: 'selected', startIndex: 0, endIndexExclusive: 3, mode: 'dynamic', include: true },
  ] });
  assert.throws(() => importCalibrationDataset(source, short), /segments.*cover all 4 signal samples/);
});

test('source and mapping changes each alter governed dataset identity', () => {
  const firstSource = 'time,current,voltage,temperature,note\n0,0,400,25,A\n1,1,399,25,A\n2,0,400,25,A';
  const secondSource = firstSource.replaceAll(',A', ',B');
  const firstMap = mapping();
  const changedMap = mapping({ source: { runId: 'run-0043' } });
  const first = importCalibrationDataset(firstSource, firstMap);
  const sourceChanged = importCalibrationDataset(secondSource, firstMap);
  const mappingChanged = importCalibrationDataset(firstSource, changedMap);

  assert.deepEqual(sourceChanged.signals, first.signals, 'an unselected vendor column does not change physical values');
  assert.notEqual(sourceChanged.source.rawSha256, first.source.rawSha256);
  assert.notEqual(sourceChanged.checksum, first.checksum);
  assert.notEqual(changedMap.checksum, firstMap.checksum);
  assert.notEqual(mappingChanged.checksum, first.checksum);
});

test('raw UTF-8 custody includes BOM and line-ending bytes, not only selected values', () => {
  const lf = 'time,current,voltage,temperature\n0,0,400,25\n1,1,399,25\n2,0,400,25';
  const crlf = lf.replaceAll('\n', '\r\n');
  const bomCrlf = `\uFEFF${crlf}`;
  const importMap = mapping();
  const datasets = [lf, crlf, bomCrlf].map((source) => importCalibrationDataset(source, importMap));

  datasets.forEach((dataset, index) => {
    assert.equal(dataset.source.rawSha256, semanticDigest([lf, crlf, bomCrlf][index]));
    assert.deepEqual(dataset.signals, datasets[0].signals);
  });
  assert.equal(new Set(datasets.map((dataset) => dataset.source.rawSha256)).size, 3);
  assert.equal(new Set(datasets.map((dataset) => dataset.checksum)).size, 3);
});

test('canonical JSON fails closed on missing, nonnumeric and unequal columns', () => {
  const importMap = mapping({ adapter: 'canonical-json', delimiter: null });
  assert.throws(() => importCalibrationDataset(JSON.stringify({
    current: [1, 2, 3], voltage: [4, 5, 6], temperature: [25, 25, 25],
  }), importMap), /missing the exact time column/);
  assert.throws(() => importCalibrationDataset(JSON.stringify({
    time: [0, 1, 2], current: [1, '2', 3], voltage: [4, 5, 6], temperature: [25, 25, 25],
  }), importMap), /sample 2 must be a finite JSON number/);
  assert.throws(() => importCalibrationDataset(JSON.stringify({
    time: [0, 1, 2], current: [1, 2], voltage: [4, 5, 6], temperature: [25, 25, 25],
  }), importMap), /has 2 samples; expected exactly 3/);
  assert.throws(() => importCalibrationDataset('[1,2,3]', importMap), /must be one object/);
});

test('adapter pairing, selected channels and source bounds fail closed', () => {
  assert.throws(() => mapping({ adapter: 'canonical-json', delimiter: ',' }), /delimiter.*must be null/);
  assert.throws(() => mapping({ adapter: 'delimited-columns', delimiter: null }), /delimiter.*comma, semicolon or tab/);
  assert.throws(() => mapping({ columns: { current: 'time' } }), /must not reuse the time column name/);
  assert.throws(() => mapping({ columns: { temperature: null } }), /temperature column, unit and location.*all be present or all be null/);
  assert.throws(() => mapping({ units: { current: 'amps' } }), /units.current.*must be one of/);
  assert.throws(() => importCalibrationDataset('x'.repeat(MAX_CALIBRATION_SOURCE_BYTES + 1), mapping()), /byte limit/);

  const tooManyColumns = Object.fromEntries(Array.from(
    { length: MAX_CALIBRATION_SOURCE_COLUMNS + 1 }, (_, index) => [`column-${index}`, [0, 1, 2]],
  ));
  assert.throws(() => importCalibrationDataset(JSON.stringify(tooManyColumns), mapping({
    adapter: 'canonical-json', delimiter: null,
  })), /more than 512 columns/);

  const overSampleCap = Array.from({ length: 250_001 }, (_, index) => index);
  assert.throws(() => importCalibrationDataset(JSON.stringify({
    time: overSampleCap,
    current: overSampleCap,
    voltage: overSampleCap,
    temperature: overSampleCap,
  }), mapping({ adapter: 'canonical-json', delimiter: null })), /more than 250000 samples/);
});

test('tab delimiter is exact and produces the standard tabular media type', () => {
  const source = 'time\tcurrent\tvoltage\ttemperature\r\n0\t0\t400\t25\r\n1\t1\t399\t25\r\n2\t0\t400\t25\r\n';
  const dataset = importCalibrationDataset(source, mapping({ delimiter: '\t' }));
  assert.equal(dataset.source.mediaType, 'text/tab-separated-values');
  assert.deepEqual(dataset.signals.currentA, [0, 1, 0]);
});
