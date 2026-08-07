import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALIBRATION_DATASET_FORMAT,
  CALIBRATION_DATASET_SCHEMA,
  CALIBRATION_DATASET_SCHEMA_VERSION,
  CalibrationDatasetValidationError,
  MAX_CALIBRATION_DATASET_SAMPLES,
  materializeCalibrationDataset,
  readCalibrationDataset,
  validateCalibrationDataset,
  verifyCalibrationDataset,
} from '../js/calibration-dataset.js';
import { semanticDigest } from '../js/ontology.js';

function payload(overrides = {}) {
  return {
    id: 'synthetic-solver-run-0042',
    kind: 'synthetic',
    purpose: 'calibration',
    source: {
      tool: 'High-fidelity synthetic solver', toolVersion: null, model: 'P2D reference cell', runId: 'run-0042',
      generatedAt: '2026-08-07T10:30:00Z', mediaType: 'text/csv', rawSha256: 'a'.repeat(64),
    },
    binding: {
      cellId: 'samsung-inr21700-50e', seriesCells: 96, parallelCells: 4,
      startSoC: 0.9, ambientC: 25, moduleCount: 8,
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'delimited-columns', adapterVersion: '1.0.0', mappingChecksum: 'b'.repeat(64),
      sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: 'degC' },
      sourceCurrentPositive: 'discharge', sourceVoltageLocation: 'pack-terminal',
      sourceTemperatureLocation: 'cell-core', timeHandling: 'validated-uniform',
      originalSampleCount: 4,
    },
    samplePeriodS: 0.1,
    signals: {
      currentA: [0, 40, 40, 0], voltageV: [403, 392, 390, 400],
      temperatureC: [25, 25.1, 25.3, 25.4],
    },
    segments: [
      { id: 'rest', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: true },
      { id: 'pulse', startIndex: 1, endIndexExclusive: 4, mode: 'dynamic', include: true },
    ],
    conventions: {
      timeBasis: 'uniform-sample-period', sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold', currentPositive: 'discharge',
      voltageLocation: 'pack-terminal', temperatureLocation: 'cell-core',
    },
    ...overrides,
  };
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('canonical calibration dataset is versioned, checksummed and deeply immutable', () => {
  const dataset = materializeCalibrationDataset(payload());
  assert.equal(dataset.format, CALIBRATION_DATASET_FORMAT);
  assert.equal(dataset.schemaVersion, CALIBRATION_DATASET_SCHEMA_VERSION);
  assert.deepEqual(validateCalibrationDataset(dataset), []);
  assert.equal(dataset.checksum, semanticDigest(Object.fromEntries(
    Object.entries(dataset).filter(([key]) => key !== 'checksum'),
  )));
  assertDeepFrozen(dataset);
  assert.throws(() => dataset.signals.currentA.push(1), TypeError);

  const verified = verifyCalibrationDataset(structuredClone(dataset), { expectedChecksum: dataset.checksum });
  assert.notEqual(verified, dataset);
  assert.deepEqual(verified, dataset);
  assertDeepFrozen(verified);
});

test('contract is closed and exposes the complete runtime schema', () => {
  assert.equal(CALIBRATION_DATASET_SCHEMA.additionalProperties, false);
  assert.equal(CALIBRATION_DATASET_SCHEMA.properties.source.additionalProperties, false);
  assert.equal(CALIBRATION_DATASET_SCHEMA.properties.binding.additionalProperties, false);
  assert.equal(CALIBRATION_DATASET_SCHEMA.properties.signals.additionalProperties, false);
  assert.equal(CALIBRATION_DATASET_SCHEMA.properties.signals.properties.currentA.maxItems, MAX_CALIBRATION_DATASET_SAMPLES);
  assertDeepFrozen(CALIBRATION_DATASET_SCHEMA);

  assert.throws(() => materializeCalibrationDataset({ ...payload(), samplPeriodS: 1 }), (error) => {
    assert.ok(error instanceof CalibrationDatasetValidationError);
    assert.match(error.message, /samplPeriodS.*not allowed/);
    return true;
  });
});

test('signal lengths, finite values, bounds and temperature meaning fail closed', () => {
  assert.throws(() => materializeCalibrationDataset(payload({
    signals: { currentA: [1, 2, 3], voltageV: [4, 5, 6, 7], temperatureC: null },
    conventions: { ...payload().conventions, temperatureLocation: null },
  })), /voltageV.*3 samples/);

  assert.throws(() => materializeCalibrationDataset(payload({
    signals: { ...payload().signals, currentA: [0, Number.NaN, 2, 3] },
  })), /finite JSON numbers/);

  assert.throws(() => materializeCalibrationDataset(payload({
    signals: { ...payload().signals, temperatureC: null },
  })), /temperatureLocation.*must be null/);

  assert.throws(() => materializeCalibrationDataset(payload({
    binding: { ...payload().binding, startSoC: 1.1 },
  })), /startSoC.*0 to 1/);
});

test('content changes alter identity, closed shape and trusted custody fail closed', () => {
  const first = materializeCalibrationDataset(payload());
  const second = materializeCalibrationDataset(payload({
    signals: { ...payload().signals, voltageV: [403, 392, 389.9, 400] },
  }));
  assert.notEqual(first.checksum, second.checksum);

  const tampered = structuredClone(first);
  tampered.binding.parallelCells = 5;
  assert.throws(() => readCalibrationDataset(tampered), /checksum.*canonical dataset content/);

  const reidentified = structuredClone(first);
  reidentified.binding.parallelCells = 5;
  const reidentifiedBody = { ...reidentified };
  delete reidentifiedBody.checksum;
  reidentified.checksum = semanticDigest(reidentifiedBody);
  assert.notEqual(reidentified.checksum, first.checksum, 'a coordinated allowed edit is a new identity, not authenticated content');
  assert.equal(readCalibrationDataset(reidentified).binding.parallelCells, 5);
  assert.throws(() => verifyCalibrationDataset(reidentified, { expectedChecksum: first.checksum }), /trusted expected checksum/);

  const extra = structuredClone(first);
  extra.source.privateSolverState = 'must not cross the boundary';
  const body = { ...extra };
  delete body.checksum;
  extra.checksum = semanticDigest(body);
  assert.throws(() => readCalibrationDataset(extra), /privateSolverState.*not allowed/);
  assert.throws(() => verifyCalibrationDataset(first, { expectedSha: first.checksum }), /does not accept option/);
  assert.throws(() => verifyCalibrationDataset(first), /requires one options object/);
});

test('sample phase and ordered segments are explicit and negative zero is canonicalized', () => {
  const dataset = materializeCalibrationDataset(payload({
    signals: { ...payload().signals, currentA: [-0, 40, 40, 0] },
  }));
  assert.equal(Object.is(dataset.signals.currentA[0], -0), false);
  assert.equal(dataset.conventions.sampleAlignment, 'end-of-step');
  assert.equal(dataset.conventions.currentHold, 'zero-order-hold');

  assert.throws(() => materializeCalibrationDataset(payload({
    segments: [
      { id: 'rest', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: true },
      { id: 'gap', startIndex: 2, endIndexExclusive: 4, mode: 'dynamic', include: true },
    ],
  })), /startIndex.*ordered full coverage/);
});

test('calibration and validation datasets remain explicitly distinct', () => {
  const calibration = materializeCalibrationDataset(payload());
  const validation = materializeCalibrationDataset(payload({ purpose: 'validation' }));
  assert.equal(calibration.purpose, 'calibration');
  assert.equal(validation.purpose, 'validation');
  assert.notEqual(calibration.checksum, validation.checksum);
});
