import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALIBRATION_DATASET_FORMAT,
  CALIBRATION_DATASET_SCHEMA,
  CALIBRATION_DATASET_SCHEMA_VERSION,
  CALIBRATION_PREPROCESSING_POLICY,
  CalibrationDatasetValidationError,
  MAX_CALIBRATION_DATASET_SAMPLES,
  calibrationDatasetIdentities,
  materializeCalibrationDataset,
  preprocessCalibrationDataset,
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
      initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'delimited-columns', adapterVersion: '1.0.0', mappingChecksum: 'b'.repeat(64),
      sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: 'degC' },
      sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal', sourceTemperatureLocation: 'cell-core',
      sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: 0,
      sourceResetTimeS: -0.1, timeHandling: 'validated-uniform',
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
      timeBasis: 'uniform-sample-period', timeOrigin: 'trial-reset',
      firstSampleOffsetS: 0.1, sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold', currentPositive: 'discharge', currentScope: 'pack',
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
  assert.equal(dataset.conventions.timeOrigin, 'trial-reset');
  assert.equal(dataset.conventions.firstSampleOffsetS, dataset.samplePeriodS);
  assert.equal(dataset.conventions.currentScope, 'pack');
  assert.equal(dataset.conventions.currentHold, 'zero-order-hold');

  assert.throws(() => materializeCalibrationDataset(payload({
    segments: [
      { id: 'rest', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: true },
      { id: 'gap', startIndex: 2, endIndexExclusive: 4, mode: 'dynamic', include: true },
    ],
  })), /startIndex.*ordered full coverage/);

  assert.throws(() => materializeCalibrationDataset(payload({
    binding: { ...payload().binding, initialState: 'unknown' },
  })), /initialState.*rested-equilibrium-at-ambient/);
  assert.throws(() => materializeCalibrationDataset(payload({
    conventions: { ...payload().conventions, firstSampleOffsetS: 0.2 },
  })), /firstSampleOffsetS.*must equal samplePeriodS/);
});

test('calibration and validation datasets remain explicitly distinct', () => {
  const calibration = materializeCalibrationDataset(payload());
  const validation = materializeCalibrationDataset(payload({
    id: 'relabeled-validation-copy',
    purpose: 'validation',
    source: {
      ...payload().source,
      tool: 'Relabeled export',
      runId: 'renamed-run',
      rawSha256: 'e'.repeat(64),
    },
  }));
  const calibrationIdentities = calibrationDatasetIdentities(calibration);
  const validationIdentities = calibrationDatasetIdentities(validation);
  assert.equal(calibration.purpose, 'calibration');
  assert.equal(validation.purpose, 'validation');
  assert.notEqual(calibration.checksum, validation.checksum);
  assert.deepEqual(validationIdentities, calibrationIdentities,
    'relabeling the same trace cannot create independent observation or trial content');
  assertDeepFrozen(calibrationIdentities);
});

test('observation and trial-content identities separate numeric evidence from binding', () => {
  const first = materializeCalibrationDataset(payload());
  const rebound = materializeCalibrationDataset(payload({
    id: 'same-observations-different-binding',
    purpose: 'validation',
    source: { ...payload().source, rawSha256: 'c'.repeat(64), runId: 'run-0043' },
    binding: {
      ...payload().binding,
      seriesCells: 48,
      parallelCells: 8,
      startSoC: 0.7,
      ambientC: 10,
      moduleCount: 4,
    },
  }));
  const firstIdentities = calibrationDatasetIdentities(first);
  const reboundIdentities = calibrationDatasetIdentities(rebound);

  assert.equal(reboundIdentities.observationChecksum, firstIdentities.observationChecksum,
    'identical sample timing, signals and conventions retain one observation identity');
  assert.notEqual(reboundIdentities.trialContentChecksum, firstIdentities.trialContentChecksum,
    'binding and initial-condition context remain part of trial content');
  assertDeepFrozen(reboundIdentities);
});

test('segment selection changes trial content without changing the observation identity', () => {
  const first = materializeCalibrationDataset(payload());
  const reselection = materializeCalibrationDataset(payload({
    id: 'same-observations-new-segment-selection',
    purpose: 'validation',
    source: { ...payload().source, rawSha256: 'f'.repeat(64), runId: 'run-0045' },
    segments: [
      { id: 'warm-up', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: false },
      { id: 'held-out-pulse', startIndex: 1, endIndexExclusive: 4, mode: 'pulse', include: true },
    ],
  }));
  const firstIdentities = calibrationDatasetIdentities(first);
  const reselectionIdentities = calibrationDatasetIdentities(reselection);

  assert.equal(reselectionIdentities.observationChecksum, firstIdentities.observationChecksum);
  assert.notEqual(reselectionIdentities.trialContentChecksum, firstIdentities.trialContentChecksum,
    'segment ids, modes and include decisions are governed trial content');
});

test('a valid signal change alters both purpose-neutral identities deterministically', () => {
  const first = materializeCalibrationDataset(payload());
  const changed = materializeCalibrationDataset(payload({
    id: 'changed-observation',
    purpose: 'validation',
    source: { ...payload().source, rawSha256: 'd'.repeat(64), runId: 'run-0044' },
    signals: { ...payload().signals, voltageV: [403, 392, 389.9, 400] },
  }));
  const firstIdentities = calibrationDatasetIdentities(first);
  const changedIdentities = calibrationDatasetIdentities(changed);

  assert.notEqual(changedIdentities.observationChecksum, firstIdentities.observationChecksum);
  assert.notEqual(changedIdentities.trialContentChecksum, firstIdentities.trialContentChecksum);
  assert.deepEqual(calibrationDatasetIdentities(structuredClone(first)), firstIdentities,
    'serialized canonical content reproduces the exact same identities');
  assert.match(firstIdentities.observationChecksum, /^[0-9a-f]{64}$/);
  assert.match(firstIdentities.trialContentChecksum, /^[0-9a-f]{64}$/);
  assertDeepFrozen(firstIdentities);
});

test('scored electrical identity ignores temperature and excluded voltage evidence', () => {
  const segments = [
    { id: 'warm-up', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: false },
    { id: 'score', startIndex: 1, endIndexExclusive: 4, mode: 'dynamic', include: true },
  ];
  const first = materializeCalibrationDataset(payload({ segments }));
  const changedTemperature = materializeCalibrationDataset(payload({
    id: 'same-electrical-observations-new-temperature',
    purpose: 'validation',
    source: { ...payload().source, rawSha256: '6'.repeat(64), runId: 'run-new-temperature' },
    signals: { ...payload().signals, temperatureC: [25, 25.2, 25.6, 25.8] },
    segments,
  }));
  const withoutTemperature = materializeCalibrationDataset(payload({
    id: 'same-electrical-observations-no-temperature',
    purpose: 'validation',
    source: { ...payload().source, rawSha256: '1'.repeat(64), runId: 'run-no-temperature' },
    normalization: {
      ...payload().normalization,
      sourceUnits: { ...payload().normalization.sourceUnits, temperature: null },
      sourceTemperatureLocation: null,
    },
    signals: { ...payload().signals, temperatureC: null },
    segments,
    conventions: { ...payload().conventions, temperatureLocation: null },
  }));
  const changedExcludedVoltage = materializeCalibrationDataset(payload({
    id: 'same-scored-electrical-observations-new-warm-up-voltage',
    purpose: 'validation',
    source: { ...payload().source, rawSha256: '2'.repeat(64), runId: 'run-new-warm-up-voltage' },
    signals: { ...payload().signals, voltageV: [401, 392, 390, 400] },
    segments,
  }));
  const firstIdentities = calibrationDatasetIdentities(first);
  const changedTemperatureIdentities = calibrationDatasetIdentities(changedTemperature);
  const withoutTemperatureIdentities = calibrationDatasetIdentities(withoutTemperature);
  const changedExcludedVoltageIdentities = calibrationDatasetIdentities(changedExcludedVoltage);

  for (const identities of [
    changedTemperatureIdentities,
    withoutTemperatureIdentities,
    changedExcludedVoltageIdentities,
  ]) {
    assert.equal(identities.electricalHistoryChecksum, firstIdentities.electricalHistoryChecksum);
    assert.equal(identities.scoredElectricalObservationChecksum,
      firstIdentities.scoredElectricalObservationChecksum);
  }
  assert.notEqual(changedTemperatureIdentities.observationChecksum, firstIdentities.observationChecksum,
    'complete observation identity still records changed temperature evidence');
  assert.notEqual(withoutTemperatureIdentities.observationChecksum, firstIdentities.observationChecksum,
    'complete observation identity still records whether temperature evidence exists');
  assert.notEqual(changedExcludedVoltageIdentities.observationChecksum, firstIdentities.observationChecksum,
    'complete observation identity still records excluded voltage history');
});

test('scored electrical identity binds included observations and all current state history', () => {
  const segments = [
    { id: 'warm-up', startIndex: 0, endIndexExclusive: 1, mode: 'rest', include: false },
    { id: 'score', startIndex: 1, endIndexExclusive: 4, mode: 'dynamic', include: true },
  ];
  const first = materializeCalibrationDataset(payload({ segments }));
  const changedIncludedVoltage = materializeCalibrationDataset(payload({
    id: 'changed-included-voltage',
    source: { ...payload().source, rawSha256: '3'.repeat(64), runId: 'run-included-voltage' },
    signals: { ...payload().signals, voltageV: [403, 391.9, 390, 400] },
    segments,
  }));
  const changedIncludedCurrent = materializeCalibrationDataset(payload({
    id: 'changed-included-current',
    source: { ...payload().source, rawSha256: '4'.repeat(64), runId: 'run-included-current' },
    signals: { ...payload().signals, currentA: [0, 41, 40, 0] },
    segments,
  }));
  const changedExcludedCurrent = materializeCalibrationDataset(payload({
    id: 'changed-warm-up-current',
    source: { ...payload().source, rawSha256: '5'.repeat(64), runId: 'run-warm-up-current' },
    signals: { ...payload().signals, currentA: [1, 40, 40, 0] },
    segments,
  }));
  const firstIdentities = calibrationDatasetIdentities(first);
  const includedVoltageIdentities = calibrationDatasetIdentities(changedIncludedVoltage);
  const includedCurrentIdentities = calibrationDatasetIdentities(changedIncludedCurrent);
  const excludedCurrentIdentities = calibrationDatasetIdentities(changedExcludedCurrent);

  assert.equal(includedVoltageIdentities.electricalHistoryChecksum,
    firstIdentities.electricalHistoryChecksum,
    'voltage is an observation rather than electrical state-driving history');
  assert.notEqual(includedVoltageIdentities.scoredElectricalObservationChecksum,
    firstIdentities.scoredElectricalObservationChecksum);
  for (const identities of [includedCurrentIdentities, excludedCurrentIdentities]) {
    assert.notEqual(identities.electricalHistoryChecksum, firstIdentities.electricalHistoryChecksum);
    assert.notEqual(identities.scoredElectricalObservationChecksum,
      firstIdentities.scoredElectricalObservationChecksum,
      'even excluded current changes the state arriving at later scored samples');
  }
  assert.deepEqual(Object.keys(firstIdentities), [
    'observationChecksum', 'trialContentChecksum', 'electricalHistoryChecksum',
    'scoredElectricalObservationChecksum',
  ]);
  assert.deepEqual(calibrationDatasetIdentities(structuredClone(first)), firstIdentities);
  assert.match(firstIdentities.electricalHistoryChecksum, /^[0-9a-f]{64}$/);
  assert.match(firstIdentities.scoredElectricalObservationChecksum, /^[0-9a-f]{64}$/);
  assertDeepFrozen(firstIdentities);
});

test('the versioned preprocessing policy is deterministic, aligned and deeply immutable', () => {
  const currentA = [0, 0, 4, 6, 0, 0, -6, -4, 0, 0, 2, 4, 0, 0, -4, -2];
  const source = materializeCalibrationDataset(payload({
    normalization: { ...payload().normalization, originalSampleCount: currentA.length },
    signals: {
      currentA,
      voltageV: currentA.map((current) => 400 - current),
      temperatureC: currentA.map((_, index) => 25 + index / 10),
    },
    segments: [{
      id: 'all', startIndex: 0, endIndexExclusive: currentA.length,
      mode: 'dynamic', include: true,
    }],
  }));
  const prepared = preprocessCalibrationDataset(source, 8);
  assert.equal(prepared.policyChecksum, CALIBRATION_PREPROCESSING_POLICY.checksum);
  const policyBody = { ...CALIBRATION_PREPROCESSING_POLICY };
  delete policyBody.checksum;
  assert.equal(CALIBRATION_PREPROCESSING_POLICY.checksum, semanticDigest(policyBody));
  assert.deepEqual(prepared.measured.i, [0, 5, 0, -5, 0, 3, 0, -3]);
  assert.deepEqual(prepared.measured.v, [400, 394, 400, 404, 400, 396, 400, 402]);
  assert.equal(prepared.measured.dtS, 0.2);
  assert.equal(prepared.preprocessing.factor, 2);
  assert.deepEqual(preprocessCalibrationDataset(structuredClone(source), 8), prepared);
  assertDeepFrozen(prepared);
  assert.throws(() => { prepared.measured.i[0] = 99; }, TypeError);
  assert.throws(() => preprocessCalibrationDataset(source, 7), /safe integer from 8/);
});
