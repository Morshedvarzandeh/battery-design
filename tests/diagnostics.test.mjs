import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batteryDiagnosticPlan, conditionMonitoringPlan, buildEngineeringDiagnostics,
} from '../js/diagnostics.js';
import { designFromSpec } from '../js/api.js';

test('battery diagnostics require measurements in an identifiable order', () => {
  const empty = batteryDiagnosticPlan({ chemistry: 'LFP' });
  assert.equal(empty.next.id, 'ocv');
  assert.match(empty.modelBoundary, /equivalent-circuit/i);
  assert.ok(empty.stages[0].parameters.includes('charge/discharge hysteresis'));

  const partlyMeasured = batteryDiagnosticPlan({
    measurements: { rest: true, pulse: true },
  });
  assert.equal(partlyMeasured.next.id, 'relaxation');
  assert.equal(partlyMeasured.status, 'measurement-needed');
});

test('condition monitoring follows knowledge-graph applicability', () => {
  assert.equal(conditionMonitoringPlan({ appId: 'home-storage' }).applicable, false);
  const bus = conditionMonitoringPlan({ appId: 'ebus' });
  assert.equal(bus.applicable, true);
  assert.equal(bus.status, 'collect-baseline');
  assert.equal(bus.detector, null);
});

test('simple anomaly detection comes before a neural model', () => {
  const small = conditionMonitoringPlan({
    appId: 'ebus', baselineWindows: 200, operatingModes: ['empty', 'full'],
  });
  assert.equal(small.detector, 'Mahalanobis distance');
  assert.match(small.autoencoder, /not recommended/i);

  const broad = conditionMonitoringPlan({
    appId: 'drone', baselineWindows: 6000, operatingModes: ['hover', 'climb', 'cruise'],
  });
  assert.match(broad.autoencoder, /may be evaluated/i);
  assert.match(broad.limitation, /not identify root cause/i);
});

test('combined diagnostics remain structured API data', () => {
  const result = buildEngineeringDiagnostics({
    appId: 'marine', chemistry: 'LFP', measurements: { rest: true },
  });
  assert.equal(result.batteryModel.next.id, 'ohmic');
  assert.equal(result.conditionMonitoring.applicable, true);
});

test('headless designs expose diagnostics without changing the sizing path', () => {
  const design = designFromSpec({
    application: 'ebus',
    diagnostics: { rest: true, pulse: true },
    conditionMonitoring: { baselineWindows: 150, operatingModes: ['empty', 'full'] },
  });
  assert.equal(design.diagnostics.batteryModel.next.id, 'relaxation');
  assert.equal(design.diagnostics.conditionMonitoring.detector, 'Mahalanobis distance');
  assert.equal(design.sensors.conditionMonitoring.status, 'baseline-ready');
});
