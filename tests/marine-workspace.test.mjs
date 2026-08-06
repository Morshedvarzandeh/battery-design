// Vessel Twin — paired success and refusal tests for both NTNU vessel models.
//
// The marine release gate is intentionally denser than the original
// first-order duty tests. Every customer-visible capability gets a normal
// case and an evidence/boundary case so a complete-looking 3D vessel cannot
// quietly become a complete-physics claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { near } from './helpers.mjs';
import {
  VESSEL_MODELS, defaultVesselModel, marineInputsForVessel, vesselModelById,
} from '../js/vessels.js';
import {
  MARINE_MISSION_LIMITS,
  MARINE_SEA_STATES,
  marineDuty,
  validateMarineMission,
} from '../js/marine.js';
import {
  TWINSHIP_COMPONENTS, TWINSHIP_CONNECTIONS, TWINSHIP_TOPOLOGY_BOUNDARY, assessVoyageReplay,
  replayDatasetSha256, twinReadiness, twinShipArchitecture,
} from '../js/marine-workspace.js';
import { maturityFromChecks } from '../js/ontology.js';

const milli = () => vesselModelById('ntnu-milliampere1');
const gunnerus = () => vesselModelById('ntnu-gunnerus');

const sample = (tS, overrides = {}) => ({
  tS,
  actualSpeedKn: 5,
  predictedSpeedKn: 5,
  actualCourseDeg: 20,
  predictedCourseDeg: 20,
  actualPowerW: 1000,
  predictedPowerW: 1000,
  ...overrides,
});

const NOW_MS = Date.parse('2026-08-06T12:00:00Z');
const SHA = Object.freeze({
  model: 'a'.repeat(64), calibration: 'b'.repeat(64),
  validation: 'c'.repeat(64), asset: 'e'.repeat(64),
});
const representativeSamples = () => Array.from({ length: 12 }, (_, index) => sample(index * 10));

function withReplay(evidence, replaySamples, replayOptions = {}) {
  return {
    ...evidence,
    replaySamples,
    replayOptions,
    replayEvidence: {
      ...evidence.replayEvidence,
      datasetSha256: replayDatasetSha256(replaySamples),
    },
  };
}

function governedEvidence(overrides = {}) {
  const replaySamples = representativeSamples();
  const base = {
    vesselId: 'ntnu-gunnerus',
    powerBasis: 'dc-bus-trace',
    assetEvidence: {
      assetId: 'rv-gunnerus-physical-01', vesselId: 'ntnu-gunnerus',
      evidenceId: 'asset-registry-record-42', revision: 'rev-3',
      issuedAt: '2026-07-01T09:00:00Z', sha256: SHA.asset,
    },
    modelEvidence: {
      artifactId: 'gunnerus-powerplant-fmu', version: '4.2.0',
      vesselId: 'ntnu-gunnerus', assetId: 'rv-gunnerus-physical-01', sha256: SHA.model,
    },
    calibrationEvidence: {
      trialId: 'calibration-trial-001', vesselId: 'ntnu-gunnerus',
      assetId: 'rv-gunnerus-physical-01', datasetSha256: SHA.calibration,
      modelArtifactSha256: SHA.model, completedAt: '2026-07-10T10:00:00Z',
    },
    validationEvidence: {
      trialId: 'validation-trial-002', vesselId: 'ntnu-gunnerus',
      assetId: 'rv-gunnerus-physical-01', datasetSha256: SHA.validation,
      modelArtifactSha256: SHA.model, completedAt: '2026-07-15T10:00:00Z',
      result: 'pass',
      metrics: { speedRmsKn: 0.12, courseRmsDeg: 1.8, powerRmsFraction: 0.04 },
      limits: { speedRmsKn: 0.5, courseRmsDeg: 10, powerRmsFraction: 0.15 },
    },
    replayEvidence: {
      replayId: 'operational-replay-2026-08-05', vesselId: 'ntnu-gunnerus',
      assetId: 'rv-gunnerus-physical-01', datasetSha256: replayDatasetSha256(replaySamples),
      modelArtifactSha256: SHA.model, recordedAt: '2026-08-05T10:00:00Z',
      maxAgeDays: 7, minSamples: 10, minDurationS: 60,
    },
    replaySamples,
  };
  return { ...base, ...overrides };
}

test('Vessel Twin contains exactly the two requested NTNU vessel models', () => {
  assert.deepEqual(VESSEL_MODELS.map((v) => v.id), ['ntnu-milliampere1', 'ntnu-gunnerus']);
});

test('an unknown vessel id is refused by lookup and falls back only through the explicit default helper', () => {
  assert.equal(vesselModelById('not-a-vessel'), null);
  assert.equal(defaultVesselModel().id, 'ntnu-milliampere1');
  assert.equal(marineInputsForVessel('not-a-vessel').vesselId, defaultVesselModel().id);
});

test('milliAmpere1 carries its published dimensions and electric propulsion facts', () => {
  const v = milli();
  assert.deepEqual(v.dimensionsM, {
    length: 5, beam: 2.8, draught: 0.2, airDraught: 3.3,
    zMin: -0.2, zMax: 3.3, height: 3.5,
  });
  assert.equal(v.published.propulsionUnits, 2);
  assert.equal(v.published.propulsionUnitW, 2000);
  assert.equal(v.published.installedEnergyWh, 24000);
});

test('milliAmpere1 labels its lithium pack as a replacement study rather than as-built hardware', () => {
  assert.match(milli().boundary, /lead-acid VRLA/i);
  assert.match(milli().boundary, /replacement study/i);
});

test('R/V Gunnerus carries its published dimensions and diesel-electric plant facts', () => {
  const v = gunnerus();
  assert.equal(v.dimensionsM.length, 36.25);
  assert.equal(v.dimensionsM.beam, 9.9);
  assert.equal(v.dimensionsM.draught, 2.7);
  assert.equal(v.dimensionsM.mouldedDepth, 4.2);
  assert.equal(v.dimensionsM.mastHeight, 14.85);
  assert.equal(v.dimensionsM.antennaHeight, 19.7);
  assert.equal(v.dimensionsM.zMin, -2.7);
  assert.equal(v.dimensionsM.zMax, 19.7);
  assert.equal(v.dimensionsM.height, 22.4);
  assert.equal(v.published.propulsionUnits, 2);
  assert.equal(v.published.propulsionUnitW, 500000);
  assert.equal(v.published.generatorUnits, 3);
  assert.equal(v.published.generatorUnitW, 450000);
  assert.equal(v.published.waterlineLengthM, 24.9);
});

test('Gunnerus source differences are versioned instead of silently merged', () => {
  const reconciliation = gunnerus().evidence.sourceReconciliation;
  assert.equal(reconciliation.status, 'conflicting-published-values');
  assert.match(reconciliation.selectedBasis, /current NTNU technical sheet/i);
  assert.deepEqual(reconciliation.differences, [
    { field: 'waterlineLengthM', selectedValue: 24.9, alternateValue: 29.9, unit: 'm' },
    { field: 'deadweightKg', selectedValue: 72000, alternateValue: 165000, unit: 'kg' },
  ]);
  assert.match(reconciliation.releaseRequirement, /vessel owner.*as-built/i);
});

test('R/V Gunnerus never presents the battery scenario as a published retrofit', () => {
  assert.match(gunnerus().boundary, /did not publish a production battery retrofit/i);
  assert.match(gunnerus().boundary, /design scenario/i);
});

test('both massing models use an explicit waterline datum and stay inside its sourced envelope', () => {
  for (const vessel of VESSEL_MODELS) {
    const { beam, length } = vessel.dimensionsM;
    const datum = vessel.model.datum;
    assert.equal(datum.id, 'design-waterline-z0', `${vessel.name}: named datum`);
    assert.equal(datum.waterlineZM, 0, `${vessel.name}: waterline is z=0`);
    assert.equal(datum.baselineZM, -vessel.dimensionsM.draught, `${vessel.name}: baseline follows draught`);
    assert.equal(datum.zMinM, vessel.dimensionsM.zMin, `${vessel.name}: lower envelope`);
    assert.equal(datum.zMaxM, vessel.dimensionsM.zMax, `${vessel.name}: upper envelope`);
    near(datum.verticalExtentM, datum.zMaxM - datum.zMinM, 1e-12, `${vessel.name}: vertical extent`);
    assert.equal(vessel.model.kind, 'engineering-massing');
    assert.match(vessel.model.boundary, /not CAD/i);
    assert.ok(vessel.model.primitives.length >= 10, `${vessel.name} has a complete low-detail model`);
    let touchesLowerEnvelope = false;
    let touchesUpperEnvelope = false;
    for (const part of vessel.model.primitives) {
      assert.ok(Math.abs(part.atM.x) + part.sizeM.x / 2 <= beam / 2 + 1e-9, `${part.name}: beam`);
      assert.ok(Math.abs(part.atM.y) + part.sizeM.y / 2 <= length / 2 + 1e-9, `${part.name}: length`);
      const low = part.atM.z - part.sizeM.z / 2;
      const high = part.atM.z + part.sizeM.z / 2;
      assert.ok(low >= datum.zMinM - 1e-9, `${part.name}: not below baseline envelope`);
      assert.ok(high <= datum.zMaxM + 1e-9, `${part.name}: not above sourced top reference`);
      if (Math.abs(low - datum.zMinM) <= 1e-9) touchesLowerEnvelope = true;
      if (Math.abs(high - datum.zMaxM) <= 1e-9) touchesUpperEnvelope = true;
    }
    assert.equal(touchesLowerEnvelope, true, `${vessel.name}: underwater model reaches published draught`);
    assert.equal(touchesUpperEnvelope, true, `${vessel.name}: model reaches sourced top reference`);
  }
});

test('waterline-relative geometry includes underwater propulsion without claiming hull CAD', () => {
  for (const vessel of VESSEL_MODELS) {
    const underwater = vessel.model.primitives.filter((part) => part.atM.z < 0);
    assert.ok(underwater.some((part) => ['hull', 'thruster', 'azipod'].includes(part.role)),
      `${vessel.name}: an underwater named system is visible`);
    assert.match(vessel.model.datum.basis, /display datum, not a surveyed keel or hull-offset definition/i);
    assert.doesNotMatch(vessel.description, /CAD model/i);
  }
});

test('both models visibly include hull, deck/superstructure and propulsion hardware', () => {
  for (const vessel of VESSEL_MODELS) {
    const roles = new Set(vessel.model.primitives.map((part) => part.role));
    assert.ok(roles.has('hull'), `${vessel.name}: hull`);
    assert.ok(roles.has('deck'), `${vessel.name}: deck`);
    assert.ok(roles.has('thruster') || roles.has('azipod'), `${vessel.name}: propulsion`);
  }
});

test('vessel mission defaults are copied and can be overridden without mutating the catalog', () => {
  const first = marineInputsForVessel('ntnu-milliampere1', { durationH: 2 });
  const second = marineInputsForVessel('ntnu-milliampere1');
  assert.equal(first.durationH, 2);
  assert.equal(second.durationH, 6);
  assert.equal(milli().missionDefaults.durationH, 6);
});

test('milliAmpere1 reproduces the published two-by-2 kW design point', () => {
  const duty = marineDuty({
    ...marineInputsForVessel('ntnu-milliampere1'),
    payloadKg: 0, serviceSpeedKn: 5, headCurrentKn: 0, headwindKn: 0,
    hotelW: 0, seaState: 'calm', durationH: 1,
  });
  near(duty.continuousW, 4000, 1e-9, 'published design-point propulsion');
});

test('milliAmpere1 adverse current raises speed through water and propulsion demand', () => {
  const base = marineDuty({ vesselId: 'ntnu-milliampere1', headCurrentKn: 0, headwindKn: 0, seaState: 'calm' });
  const adverse = marineDuty({ vesselId: 'ntnu-milliampere1', headCurrentKn: 1, headwindKn: 0, seaState: 'calm' });
  assert.ok(adverse.metrics.speedWaterKn > base.metrics.speedWaterKn);
  assert.ok(adverse.metrics.propulsionW > base.metrics.propulsionW);
});

test('milliAmpere1 payload correction moves demand monotonically when reference mass is known', () => {
  const light = marineDuty({ vesselId: 'ntnu-milliampere1', payloadKg: 0 });
  const loaded = marineDuty({ vesselId: 'ntnu-milliampere1', payloadKg: 450 });
  assert.equal(loaded.metrics.massCorrectionApplied, true);
  assert.ok(loaded.metrics.massFactor > light.metrics.massFactor);
  assert.ok(loaded.continuousW > light.continuousW);
});

test('Gunnerus does not silently substitute published deadweight for vessel mass', () => {
  const duty = marineDuty({ vesselId: 'ntnu-gunnerus', payloadKg: 50000 });
  assert.equal(duty.metrics.massCorrectionApplied, false);
  assert.equal(duty.metrics.totalMassKg, null);
  assert.equal(duty.metrics.massFactor, 1);
  assert.match(duty.assumptions.join(' '), /deadweight is not silently substituted/i);
});

test('marine mission energy is exactly the integral of the emitted absolute trace', () => {
  const duty = marineDuty({ vesselId: 'ntnu-milliampere1', durationH: 1.013 });
  const integrated = duty.profile.p.reduce((sum, value) => (
    sum + value * duty.scaleW * duty.profile.dtS / 3600
  ), 0);
  near(duty.energyWh, integrated, 1e-9, 'trace integral');
  near(duty.profile.p.length * duty.profile.dtS / 3600, duty.inputs.durationH, 1e-12,
    'the emitted trace covers the exact requested non-minute duration');
});

test('marine mission distance and energy per nautical mile close arithmetically', () => {
  const duty = marineDuty({ vesselId: 'ntnu-milliampere1', serviceSpeedKn: 3, durationH: 4 });
  near(duty.distanceNm, 12, 1e-12, 'distance');
  near(duty.energyPerNmWh * duty.distanceNm, duty.energyWh, 1e-8, 'energy per nautical mile');
});

test('invalidly short mission duration is explicitly refused', () => {
  assert.throws(
    () => marineDuty({ vesselId: 'ntnu-milliampere1', durationH: -20 }),
    /durationH must be between/i,
  );
});

const VALID_MISSION_VALUES = Object.freeze({
  referenceMassKg: 1800,
  payloadKg: 450,
  designSpeedKn: 5,
  serviceSpeedKn: 3,
  headCurrentKn: 0,
  headwindKn: 5,
  propulsionAtDesignW: 4000,
  hotelW: 250,
  durationH: 6,
});

function assertFiniteMission(duty) {
  const values = [
    duty.scaleW, duty.energyWh, duty.peakW, duty.continuousW,
    duty.distanceNm, duty.energyPerNmWh, duty.profile.dtS,
    duty.metrics.speedGroundKn, duty.metrics.speedWaterKn,
    duty.metrics.propulsionW, duty.metrics.hotelW, duty.metrics.seaFactor,
    duty.metrics.windFactor, duty.metrics.massFactor,
    ...duty.profile.p,
  ];
  assert.ok(values.every(Number.isFinite), 'mission and trace outputs remain finite');
}

for (const [field, limits] of Object.entries(MARINE_MISSION_LIMITS)) {
  test(`marine mission ${field} accepts a representative valid value`, () => {
    const input = { vesselId: 'ntnu-milliampere1', [field]: VALID_MISSION_VALUES[field] };
    const resolved = validateMarineMission(input);
    assert.equal(resolved[field], VALID_MISSION_VALUES[field]);
    assert.notEqual(resolved, input, 'validation returns a new mission object');
    assert.equal(input[field], VALID_MISSION_VALUES[field], 'validation does not mutate input');
    assertFiniteMission(marineDuty(input));
  });

  test(`marine mission ${field} accepts both declared range boundaries`, () => {
    for (const value of [limits.min, limits.max]) {
      const duty = marineDuty({ vesselId: 'ntnu-milliampere1', [field]: value });
      assert.equal(duty.inputs[field], value);
      assertFiniteMission(duty);
    }
  });

  test(`marine mission ${field} refuses values outside its declared range`, () => {
    const span = limits.max - limits.min;
    for (const value of [limits.min - Math.max(1, span * 0.01), limits.max + Math.max(1, span * 0.01)]) {
      assert.throws(
        () => marineDuty({ vesselId: 'ntnu-milliampere1', [field]: value }),
        new RegExp(`${field} must be between`, 'i'),
      );
    }
  });

  test(`marine mission ${field} refuses non-finite and non-numeric values`, () => {
    for (const value of [NaN, Infinity, -Infinity, String(VALID_MISSION_VALUES[field])]) {
      assert.throws(
        () => marineDuty({ vesselId: 'ntnu-milliampere1', [field]: value }),
        new RegExp(`${field} must be a finite number`, 'i'),
      );
    }
  });
}

test('marine mission permits an explicit null reference mass to disable mass correction', () => {
  const duty = marineDuty({ vesselId: 'ntnu-gunnerus', referenceMassKg: null, payloadKg: 100_000 });
  assert.equal(duty.inputs.referenceMassKg, null);
  assert.equal(duty.metrics.massCorrectionApplied, false);
  assertFiniteMission(duty);
});

test('marine mission accepts every declared sea state and keeps outputs finite', () => {
  assert.deepEqual(MARINE_SEA_STATES, ['calm', 'moderate', 'rough']);
  for (const seaState of MARINE_SEA_STATES) {
    const duty = marineDuty({ vesselId: 'ntnu-milliampere1', seaState });
    assert.equal(duty.inputs.seaState, seaState);
    assertFiniteMission(duty);
  }
});

test('marine mission refuses unknown or non-string sea states', () => {
  for (const seaState of ['hurricane', 'Calm', '', null, 1, NaN]) {
    assert.throws(
      () => marineDuty({ vesselId: 'ntnu-milliampere1', seaState }),
      /seaState must be one of: calm, moderate, rough/i,
    );
  }
});

test('marine mission refuses non-object input instead of silently defaulting it', () => {
  for (const input of [null, [], 'mission', 3]) {
    assert.throws(() => validateMarineMission(input), /mission input must be an object/i);
  }
});

test('TwinShip architecture binds the selected vessel and all typed components', () => {
  const graph = twinShipArchitecture('ntnu-gunnerus');
  assert.equal(graph.vessel.id, 'ntnu-gunnerus');
  assert.equal(graph.components.length, TWINSHIP_COMPONENTS.length);
  assert.ok(graph.components.some((node) => node.id === 'battery-pack'));
  assert.ok(graph.components.some((node) => node.id === 'vessel-model'));
});

test('every TwinShip connection has real component endpoints', () => {
  const ids = new Set(TWINSHIP_COMPONENTS.map((node) => node.id));
  for (const edge of TWINSHIP_CONNECTIONS) {
    assert.ok(ids.has(edge.from), `${edge.from} exists`);
    assert.ok(ids.has(edge.to), `${edge.to} exists`);
    assert.ok(edge.signal, 'connection names its signal');
  }
});

test('the visible TwinShip topology is labelled as an 11-link abstraction of 48 published variables', () => {
  const architecture = twinShipArchitecture('ntnu-gunnerus');
  assert.equal(TWINSHIP_TOPOLOGY_BOUNDARY.logicalConnections, TWINSHIP_CONNECTIONS.length);
  assert.equal(TWINSHIP_TOPOLOGY_BOUNDARY.publishedVariableConnections, 48);
  assert.equal(architecture.topologyBoundary.kind, 'logical-family-abstraction');
  assert.match(architecture.topologyBoundary.note, /not a reproduction.*48 variable connections/i);
});

test('TwinShip component statuses do not claim missing hydrodynamic FMUs are shipped', () => {
  for (const id of ['speed-controller', 'heading-controller', 'thruster-drive', 'azimuth-thruster']) {
    const node = TWINSHIP_COMPONENTS.find((item) => item.id === id);
    assert.equal(node.implementation, 'external-model');
    assert.match(node.desktop, /FMU required/i);
  }
});

test('default Twin readiness remains a screening model', () => {
  const ready = twinReadiness();
  assert.equal(ready.maturity, 'screening');
  assert.equal(ready.maturityScheme, 'twinShip');
  assert.match(ready.statement, /Do not present/i);
});

test('Vessel Twin maturity uses the cumulative ontology ladder without skipped levels', () => {
  const checks = {};
  assert.equal(maturityFromChecks('twinShip', checks).id, 'screening');
  Object.assign(checks, { 'identified-vessel': true, 'power-basis': true });
  assert.equal(maturityFromChecks('twinShip', checks).id, 'vessel-model');
  Object.assign(checks, { 'asset-binding': true, 'model-version': true, 'calibration-trial': true });
  assert.equal(maturityFromChecks('twinShip', checks).id, 'calibrated');
  Object.assign(checks, { 'validation-trial': true, 'validation-result': true });
  assert.equal(maturityFromChecks('twinShip', checks).id, 'validated');

  // A clean-looking replay cannot skip identity, calibration or validation.
  const replayOnly = {
    'current-data': true, 'replay-content-address': true,
    'replay-representative': true, 'replay-mode-coverage': true,
    'replay-coherent': true,
  };
  assert.equal(maturityFromChecks('twinShip', replayOnly).id, 'screening');

  Object.assign(checks, replayOnly);
  assert.equal(maturityFromChecks('twinShip', checks).id, 'digital-twin');
});

test('identified vessel plus supplied power basis reaches vessel-model maturity only', () => {
  const ready = twinReadiness({ vesselId: 'ntnu-gunnerus', powerBasis: 'dc-bus-trace' });
  assert.equal(ready.maturity, 'vessel-model');
  assert.ok(ready.missing.includes('Governed calibration trial'));
});

test('flat arbitrary ids and a parseable timestamp can never become governed evidence', () => {
  const ready = twinReadiness({
    vesselId: 'ntnu-gunnerus', powerBasis: 'dc-bus-trace',
    calibrationTrialId: 'anything', validationTrialId: 'anything-else',
    assetId: 'anything', modelVersion: 'anything', dataTimestamp: '1999-01-01',
  }, { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'vessel-model');
  assert.ok(ready.missing.includes('Vessel-bound physical asset evidence'));
  assert.ok(ready.missing.includes('Versioned, content-addressed model artifact'));
});

test('calibration without an independent validation trial cannot be called validated', () => {
  const evidence = governedEvidence();
  const ready = twinReadiness({
    ...evidence,
    validationEvidence: {
      ...evidence.validationEvidence,
      trialId: evidence.calibrationEvidence.trialId,
      datasetSha256: evidence.calibrationEvidence.datasetSha256,
    },
  }, { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'calibrated');
  assert.ok(ready.missing.includes('Independent validation trial'));
});

test('a separate validation trial reaches validated maturity without claiming a live twin', () => {
  const evidence = governedEvidence();
  const ready = twinReadiness({
    ...evidence, replayEvidence: undefined, replaySamples: undefined,
  }, { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'validated');
  assert.ok(ready.missing.includes('Representative vessel replay evidence'));
  assert.match(ready.statement, /Do not present/i);
});

test('all governed identity, validation and replay evidence is required for digital-twin maturity', () => {
  const ready = twinReadiness(governedEvidence(), { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'digital-twin');
  assert.equal(ready.missing.length, 0);
  assert.equal(ready.replay.representative, true);
  assert.equal(ready.replay.coherent, true);
  assert.equal(ready.evidence.model.sha256, SHA.model);
  assert.match(ready.statement, /class or safety approval remains separate/i);
});

test('a malformed data timestamp blocks digital-twin maturity', () => {
  const evidence = governedEvidence();
  for (const recordedAt of ['not-a-date', '2026-02-30T10:00:00Z']) {
    const ready = twinReadiness({
      ...evidence,
      replayEvidence: { ...evidence.replayEvidence, recordedAt },
    }, { nowMs: NOW_MS });
    assert.equal(ready.maturity, 'validated', recordedAt);
    assert.ok(ready.missing.includes('Current replay/live data'), recordedAt);
  }
});

test('stale and future replay timestamps are refused explicitly', () => {
  for (const recordedAt of ['2026-07-01T10:00:00Z', '2026-08-07T10:00:00Z']) {
    const evidence = governedEvidence();
    const ready = twinReadiness({
      ...evidence,
      replayEvidence: { ...evidence.replayEvidence, recordedAt, maxAgeDays: 7 },
    }, { nowMs: NOW_MS });
    assert.equal(ready.maturity, 'validated', recordedAt);
    assert.ok(ready.missing.includes('Current replay/live data'), recordedAt);
  }
});

test('asset, model and trials must all bind to the selected vessel and physical asset', () => {
  const evidence = governedEvidence();
  const wrongAsset = twinReadiness({
    ...evidence,
    assetEvidence: { ...evidence.assetEvidence, vesselId: 'ntnu-milliampere1' },
  }, { nowMs: NOW_MS });
  assert.equal(wrongAsset.maturity, 'vessel-model');
  assert.ok(wrongAsset.missing.includes('Vessel-bound physical asset evidence'));

  const wrongModel = twinReadiness({
    ...evidence,
    validationEvidence: { ...evidence.validationEvidence, modelArtifactSha256: 'f'.repeat(64) },
  }, { nowMs: NOW_MS });
  assert.equal(wrongModel.maturity, 'calibrated');
  assert.ok(wrongModel.missing.includes('Independent validation trial'));
});

test('a declared pass cannot override validation metrics outside their limits', () => {
  const evidence = governedEvidence();
  const ready = twinReadiness({
    ...evidence,
    validationEvidence: {
      ...evidence.validationEvidence,
      metrics: { ...evidence.validationEvidence.metrics, powerRmsFraction: 0.3 },
    },
  }, { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'calibrated');
  assert.ok(ready.missing.includes('Validation metrics within declared limits'));
});

test('an unproven or alarmed replay cannot coexist with digital-twin maturity', () => {
  const evidence = governedEvidence();
  const unproven = twinReadiness({
    ...evidence, replaySamples: undefined,
  }, { nowMs: NOW_MS });
  assert.equal(unproven.maturity, 'validated');
  assert.equal(unproven.replay.coherent, false);

  const alarmedSamples = representativeSamples().map((entry, index) => (
    index >= 2 ? { ...entry, actualSpeedKn: 8 } : entry
  ));
  const alarmed = twinReadiness(withReplay(evidence, alarmedSamples, { consecutive: 2 }), { nowMs: NOW_MS });
  assert.equal(alarmed.replay.status, 'review');
  assert.equal(alarmed.maturity, 'validated');
});

test('a caller-authored clean replay result is ignored at the public trust boundary', () => {
  const evidence = governedEvidence();
  const ready = twinReadiness({
    ...evidence,
    replaySamples: [sample(0)],
    replayResult: assessVoyageReplay(evidence.replaySamples),
  }, { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'validated');
  assert.equal(ready.replay.status, 'unproven');
  assert.equal(ready.replay.coherent, false);
  assert.equal(ready.replay.datasetDigestVerified, false);
  assert.ok(ready.missing.includes('Replay within governed residual thresholds'));
});

test('the declared replay SHA-256 must match the canonical raw sample dataset', () => {
  const evidence = governedEvidence();
  const expectedCanonical = JSON.stringify({
    format: 'battery-design/voyage-replay-dataset@1',
    samples: evidence.replaySamples.map((entry) => [
      entry.tS,
      entry.actualSpeedKn, entry.predictedSpeedKn,
      entry.actualCourseDeg, entry.predictedCourseDeg,
      entry.actualPowerW, entry.predictedPowerW,
      null,
    ]),
  });
  assert.equal(
    replayDatasetSha256(evidence.replaySamples),
    createHash('sha256').update(expectedCanonical).digest('hex'),
    'browser-safe hashing implements real SHA-256 over the documented canonical tuple',
  );

  const alteredSamples = evidence.replaySamples.map((entry, index) => (
    index === 5 ? { ...entry, actualPowerW: entry.actualPowerW + 1 } : entry
  ));
  const ready = twinReadiness({ ...evidence, replaySamples: alteredSamples }, { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'validated');
  assert.equal(ready.replay.datasetDigestVerified, false);
  assert.ok(ready.missing.includes('Replay digest bound to raw samples'));
});

test('representative replay must be separately content-addressed from both governed trials', () => {
  const evidence = governedEvidence();
  for (const datasetSha256 of [
    evidence.calibrationEvidence.datasetSha256,
    evidence.validationEvidence.datasetSha256,
  ]) {
    const ready = twinReadiness({
      ...evidence,
      replayEvidence: { ...evidence.replayEvidence, datasetSha256 },
    }, { nowMs: NOW_MS });
    assert.equal(ready.maturity, 'validated');
    assert.ok(ready.missing.includes('Representative vessel replay evidence'));
  }
});

test('two convenient samples are not representative vessel evidence', () => {
  const evidence = governedEvidence();
  const ready = twinReadiness(withReplay(evidence, [sample(0), sample(10)]), { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'validated');
  assert.ok(ready.missing.includes('Representative vessel replay evidence'));
});

test('impossible physical replay values are rejected before residual evaluation', () => {
  for (const overrides of [
    { actualSpeedKn: -0.1 }, { predictedSpeedKn: 100.1 },
    { actualCourseDeg: -1 }, { predictedCourseDeg: 360 },
    { actualPowerW: 100_000_001 }, { predictedPowerW: -100_000_001 },
  ]) {
    const replay = assessVoyageReplay([sample(0), sample(10, overrides)]);
    assert.equal(replay.status, 'invalid', JSON.stringify(overrides));
    assert.ok(replay.diagnostics.some((item) => item.code === 'replay.physical_range'));
  }
});

test('exposed operating modes need repeat samples and positive same-mode duration', () => {
  const evidence = governedEvidence();
  const covered = evidence.replaySamples.map((entry, index) => ({
    ...entry,
    operatingMode: index < 6 ? 'transit' : 'station-keeping',
  }));
  const ready = twinReadiness(withReplay(evidence, covered), { nowMs: NOW_MS });
  assert.equal(ready.maturity, 'digital-twin');
  assert.deepEqual(ready.replay.operatingModes.map((mode) => mode.id), ['station-keeping', 'transit']);
  assert.ok(ready.replay.operatingModes.every((mode) => mode.samples >= 2 && mode.durationS > 0));

  const sparse = covered.map((entry, index) => ({
    ...entry,
    operatingMode: index === covered.length - 1 ? 'harbor' : 'transit',
  }));
  const refused = twinReadiness(withReplay(evidence, sparse), { nowMs: NOW_MS });
  assert.equal(refused.maturity, 'validated');
  assert.ok(refused.missing.includes('Representative operating-mode coverage'));
});

test('a partially populated operating-mode channel is invalid raw replay', () => {
  const samples = representativeSamples().map((entry, index) => (
    index === 0 ? { ...entry, operatingMode: 'transit' } : entry
  ));
  const evidence = governedEvidence();
  const ready = twinReadiness(withReplay(evidence, samples), { nowMs: NOW_MS });
  assert.equal(ready.replay.status, 'invalid');
  assert.equal(ready.maturity, 'validated');
  assert.ok(ready.missing.includes('Representative operating-mode coverage'));
});

test('voyage replay requires at least two aligned samples', () => {
  const replay = assessVoyageReplay([sample(0)]);
  assert.equal(replay.status, 'unproven');
  assert.equal(replay.diagnostics[0].code, 'replay.samples_required');
});

test('voyage replay rejects duplicate or decreasing timestamps', () => {
  const replay = assessVoyageReplay([sample(0), sample(0), sample(-1)]);
  assert.equal(replay.status, 'invalid');
  assert.ok(replay.diagnostics.some((item) => item.code === 'replay.time_not_increasing'));
});

test('voyage replay rejects non-finite measured or predicted values', () => {
  const replay = assessVoyageReplay([sample(0), sample(1, { actualPowerW: Number.NaN })]);
  assert.equal(replay.status, 'invalid');
  assert.ok(replay.diagnostics.some((item) => item.code === 'replay.invalid_sample'));
});

test('voyage replay rejects malformed samples without throwing', () => {
  const replay = assessVoyageReplay([sample(0), null, sample(2)]);
  assert.equal(replay.status, 'invalid');
  assert.ok(replay.diagnostics.some((item) => item.code === 'replay.invalid_sample'));
});

test('threshold strings and non-finite values are refused rather than coerced to a pass', () => {
  const samples = [sample(0), sample(1), sample(2)];
  for (const options of [
    { speedKn: 'not-a-number' },
    { courseDeg: Number.POSITIVE_INFINITY },
    { powerFraction: Number.NaN },
    { consecutive: '3' },
    { consecutive: 50 },
    'not-an-options-object',
  ]) {
    const replay = assessVoyageReplay(samples, options);
    assert.equal(replay.status, 'invalid', JSON.stringify(options));
    assert.equal(replay.diagnostics[0].code, 'replay.invalid_thresholds');
    assert.match(replay.diagnostics[0].detail, /not coerced/i);
  }
});

test('unsupported permissive threshold ranges are refused', () => {
  const samples = [sample(0), sample(1), sample(2)];
  for (const options of [
    { speedKn: 11 }, { courseDeg: 181 }, { powerFraction: 1.01 },
    { speedKn: 0 }, { courseDeg: -1 }, { powerFraction: -0.1 },
  ]) assert.equal(assessVoyageReplay(samples, options).status, 'invalid');
});

test('course residual uses circular angle distance across north', () => {
  const replay = assessVoyageReplay([
    sample(0, { actualCourseDeg: 359, predictedCourseDeg: 1 }),
    sample(1, { actualCourseDeg: 1, predictedCourseDeg: 359 }),
  ]);
  assert.equal(replay.status, 'within-declared-thresholds');
  near(replay.rows[0].courseDeg, -2, 1e-12, '359 vs 1');
  near(replay.rows[1].courseDeg, 2, 1e-12, '1 vs 359');
});

test('voyage replay integrates measured and predicted power with the trapezoid rule', () => {
  const replay = assessVoyageReplay([
    sample(0, { actualPowerW: 0, predictedPowerW: 0 }),
    sample(1800, { actualPowerW: 2000, predictedPowerW: 1000 }),
    sample(3600, { actualPowerW: 0, predictedPowerW: 0 }),
  ]);
  near(replay.energy.actualWh, 1000, 1e-9, 'actual energy');
  near(replay.energy.predictedWh, 500, 1e-9, 'predicted energy');
});

test('a single residual excursion does not become a sustained alarm', () => {
  const replay = assessVoyageReplay([
    sample(0), sample(1, { actualSpeedKn: 8 }), sample(2), sample(3),
  ], { consecutive: 2 });
  assert.equal(replay.status, 'within-declared-thresholds');
  assert.equal(replay.alarms.length, 0);
});

test('consecutive speed residuals produce a deterministic early-warning alarm', () => {
  const replay = assessVoyageReplay([
    sample(0), sample(1, { actualSpeedKn: 8 }), sample(2, { actualSpeedKn: 8 }), sample(3),
  ], { consecutive: 2 });
  assert.equal(replay.status, 'review');
  assert.ok(replay.alarms.some((alarm) => alarm.code === 'replay.speed_residual_sustained'));
});

test('perfectly matched replay remains within declared thresholds', () => {
  const replay = assessVoyageReplay([sample(0), sample(1), sample(2), sample(3)]);
  assert.equal(replay.status, 'within-declared-thresholds');
  assert.equal(replay.residuals.speedKn.rms, 0);
  assert.equal(replay.residuals.courseDeg.rms, 0);
  assert.equal(replay.residuals.powerW.rms, 0);
});

test('replay residuals explicitly stop short of diagnosing a failed component', () => {
  const replay = assessVoyageReplay([
    sample(0), sample(1, { actualPowerW: 2000 }), sample(2, { actualPowerW: 2000 }), sample(3, { actualPowerW: 2000 }),
  ]);
  assert.match(replay.limitation, /not fault isolation/i);
  assert.match(replay.alarms[0].detail, /does not diagnose a component/i);
});
