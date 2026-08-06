import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designFromSpec } from '../js/api.js';

const runner = new URL('../desktop/bd.mjs', import.meta.url);
const runJson = (...args) => JSON.parse(execFileSync(process.execPath, [runner.pathname, ...args, '--json'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}));

const governedShoreConnection = () => ({
  mode: 'ac', voltageV: 400, phases: 3, frequencyHz: 50, powerFactor: 0.9,
  ratedPowerKW: 100, ratedCurrentA: 100000 / (Math.sqrt(3) * 400 * 0.9), efficiency: 0.95,
  outputVoltageMinV: 400, outputVoltageMaxV: 1000,
  connector: { id: 'desktop-marine-inlet-01', name: 'Desktop project marine inlet 01' },
  earthing: { declared: true, scheme: 'Project drawing E-04 earthing scheme' },
  isolation: { declared: true, method: 'Project-declared isolated conversion equipment' },
  interlock: { declared: true, description: 'Project PLC connection permissive' },
  emergencyDisconnect: { declared: true, description: 'Project emergency disconnect chain' },
  evidence: { kind: 'project', source: 'Project drawing E-04', revision: 'Rev C', date: '2026-07-01' },
});

test('desktop Vessel Twin catalog lists exactly the same two NTNU vessels', () => {
  const vessels = runJson('vessels');
  assert.deepEqual(vessels.map((vessel) => vessel.id), ['ntnu-milliampere1', 'ntnu-gunnerus']);
  assert.ok(vessels.every((vessel) => vessel.evidence?.url && vessel.boundary));
  assert.deepEqual(vessels.map((vessel) => vessel.policyId),
    ['marine-full-electric', 'marine-load-levelling']);
});

test('desktop runner routes marine flags into the selected vessel voyage', () => {
  const design = runJson(
    'design', '--app', 'marine', '--vessel', 'ntnu-gunnerus',
    '--service-kn', '8', '--duration-h', '2', '--current-kn', '1',
    '--wind-kn', '12', '--sea', 'moderate', '--hotel-w', '25000',
  );
  assert.equal(design.marine.vessel.id, 'ntnu-gunnerus');
  assert.equal(design.marine.inputs.serviceSpeedKn, 8);
  assert.equal(design.marine.inputs.durationH, 2);
  assert.equal(design.marine.inputs.headCurrentKn, 1);
  assert.equal(design.marine.inputs.headwindKn, 12);
  assert.equal(design.marine.inputs.seaState, 'moderate');
  assert.equal(design.marine.inputs.hotelW, 25000);
  assert.equal(design.spec.resolved.sizing.policyId, 'marine-load-levelling');
  assert.ok(design.simulation.stats.peakW > 100000);

  const headless = designFromSpec({
    application: 'marine',
    marine: {
      vesselId: 'ntnu-gunnerus', serviceSpeedKn: 8, durationH: 2,
      headCurrentKn: 1, headwindKn: 12, seaState: 'moderate', hotelW: 25000,
    },
  });
  assert.deepEqual({
    energyWh: design.pack.energyWh, s: design.pack.s, p: design.pack.p,
    policyId: design.spec.resolved.sizing.policyId,
    profileId: design.spec.resolved.sizing.profileId,
    traceIdentity: design.spec.resolved.sizing.traceIdentity,
  }, {
    energyWh: headless.pack.energyWh, s: headless.pack.s, p: headless.pack.p,
    policyId: headless.spec.resolved.sizing.policyId,
    profileId: headless.spec.resolved.sizing.profileId,
    traceIdentity: headless.spec.resolved.sizing.traceIdentity,
  }, 'desktop CLI and direct API resolve the identical marine pack and trace');
});

test('desktop marine payload changes the voyage and does not leak into road vehicle inputs', () => {
  const light = runJson('design', '--app', 'marine', '--vessel', 'ntnu-milliampere1', '--payload', '0');
  const loaded = runJson('design', '--app', 'marine', '--vessel', 'ntnu-milliampere1', '--payload', '450');
  assert.ok(loaded.marine.continuousW > light.marine.continuousW);
  assert.equal(loaded.vehicle, null);
  assert.equal(loaded.marine.inputs.payloadKg, 450);
});

test('desktop unknown vessel id is corrected visibly rather than producing a third model', () => {
  const design = runJson('design', '--app', 'marine', '--vessel', 'invented-boat');
  assert.equal(design.marine.vessel.id, 'ntnu-milliampere1');
  assert.ok(design.warnings.some((warning) => /Unknown vesselId/.test(warning)));
});

test('desktop sim2 executes the resolved Gunnerus voyage trace instead of a static profile', () => {
  const args = [
    '--app', 'marine', '--vessel', 'ntnu-gunnerus',
    '--service-kn', '8', '--duration-h', '2', '--years', '0', '--cycles', '0',
  ];
  const design = runJson('design', ...args);
  const simulation = runJson('sim2', ...args);
  assert.equal(simulation.profile.durationS, 7200,
    'the two-hour voyage remains two hours at the advanced-model boundary');
  assert.equal(simulation.profile.profileId, design.spec.resolved.sizing.profileId);
  assert.equal(simulation.profile.policyId, design.spec.resolved.sizing.policyId);
  assert.deepEqual(simulation.profile.traceIdentity, design.spec.resolved.sizing.traceIdentity);
  assert.equal(simulation.profile.scaleW, design.spec.resolved.sizing.scaleW);
});

test('desktop CLI accepts a governed marine profile-trace file without echoing its samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-design-profile-'));
  try {
    const traceFile = join(dir, 'harbor-trace.json');
    const trace = {
      id: 'desktop-harbor-cycle', name: 'Desktop harbor cycle', revision: 'rev-4',
      dtS: 30, p: [0.25, 1, -0.5, 0.25], scaleW: 180000,
    };
    writeFileSync(traceFile, JSON.stringify(trace));
    const args = [
      '--app', 'marine', '--vessel', 'ntnu-gunnerus',
      '--profile-trace', traceFile, '--years', '0', '--cycles', '0',
    ];
    const design = runJson('design', ...args);
    const simulation = runJson('sim2', ...args);
    assert.equal(design.spec.resolved.sizing.profileId, trace.id);
    assert.equal(design.spec.resolved.sizing.policyId, null);
    assert.equal(design.spec.profileTrace, undefined);
    assert.equal(simulation.profile.durationS, trace.dtS * trace.p.length);
    assert.deepEqual(simulation.profile.traceIdentity, design.spec.resolved.sizing.traceIdentity);
    assert.equal(simulation.profile.scaleW, trace.scaleW);
    assert.doesNotMatch(JSON.stringify(design), /rev-4|\[0\.25,1,-0\.5,0\.25\]/,
      'portable CLI design output carries identity, not raw trace content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop CLI carries a governed marine shore-connection file into the shared design', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-design-shore-'));
  try {
    const connectionFile = join(dir, 'shore-connection.json');
    const shoreConnection = governedShoreConnection();
    writeFileSync(connectionFile, JSON.stringify(shoreConnection));
    const design = runJson(
      'design', '--app', 'marine', '--vessel', 'ntnu-gunnerus',
      '--s', '200', '--shore-connection', connectionFile,
    );
    assert.equal(design.charging.shoreConnection.status, 'pass');
    assert.ok(design.charging.t2080.hours > 0);
    assert.equal(design.charging.shoreConnection.normalized.connector.id, shoreConnection.connector.id);
    assert.equal(design.spec.marine.shoreConnection.evidence.revision, 'Rev C');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop accepts governed TwinShip JSON files without echoing identities or raw samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-design-twin-'));
  try {
    const evidenceFile = join(dir, 'evidence.json');
    const replayFile = join(dir, 'replay.json');
    writeFileSync(evidenceFile, JSON.stringify({
      powerBasis: 'dc-bus-trace',
      assetEvidence: {
        assetId: 'PRIVATE-DESKTOP-ASSET', vesselId: 'ntnu-gunnerus',
        evidenceId: 'PRIVATE-DESKTOP-ASSET-RECORD', revision: 'rev-1',
        issuedAt: new Date(Date.now() - 86400000).toISOString(), sha256: 'a'.repeat(64),
      },
    }));
    writeFileSync(replayFile, JSON.stringify({
      samples: [
        { tS: 0, actualSpeedKn: 8, predictedSpeedKn: 7.9, actualCourseDeg: 2, predictedCourseDeg: 2, actualPowerW: 500000, predictedPowerW: 495000 },
        { tS: 1, actualSpeedKn: 8.1, predictedSpeedKn: 8, actualCourseDeg: 3, predictedCourseDeg: 3, actualPowerW: 505000, predictedPowerW: 500000 },
      ],
      options: { speedKn: 0.5, courseDeg: 10, powerFraction: 0.15, consecutive: 2 },
    }));
    const design = runJson(
      'design', '--app', 'marine', '--vessel', 'ntnu-gunnerus',
      '--twin-evidence', evidenceFile, '--replay', replayFile,
    );
    assert.equal(design.twinShip.replay.samples, 2);
    assert.equal(design.twinShip.readiness.evidenceAccepted.asset, true);
    assert.equal(design.spec.marine.twinEvidence, undefined);
    assert.equal(design.spec.marine.replaySamples, undefined);
    const json = JSON.stringify(design);
    assert.doesNotMatch(json, /PRIVATE-DESKTOP-ASSET/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
