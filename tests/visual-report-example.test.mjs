import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../reports/examples/visual-decision-report/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const data = JSON.parse(readFileSync(new URL(manifest.data, root), 'utf8'));

const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} ± ${tolerance}`);
};

test('encoded example identity, duration and frame contract are immutable', () => {
  const bytes = readFileSync(new URL(manifest.file, root));
  assert.equal(bytes.length, manifest.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.ok(manifest.durationS < 60);
  assert.equal(manifest.video.frames, manifest.durationS * manifest.video.fps);
  assert.equal(manifest.video.width, 1080);
  assert.equal(manifest.video.height, 1080);
  assert.equal(manifest.audio.musicOrigin.includes('no third-party music'), true);
});

test('example topology, nominal voltage, capacity and energy reproduce exactly', () => {
  const { series, parallel } = data.inputs.topology;
  const cell = data.cell;
  const metrics = data.pack.metrics;
  assert.equal(series * parallel, metrics.cellCount);
  close(series * cell.nominalV, metrics.nominalVoltageV, 0.005);
  close(parallel * cell.capacityAh, metrics.capacityAh, 0.005);
  close(series * parallel * cell.nominalV * cell.capacityAh / 1000, metrics.energyKWh, 0.0005);
  close(series * parallel * cell.nominalV * cell.minimumCapacityAh / 1000,
    metrics.minimumCapacityBasisEnergyKWh, 0.0005);
});

test('example dimensions and clearance reconcile to the declared bay on every axis', () => {
  const layout = data.pack.layout;
  for (const axis of ['x', 'y', 'z']) {
    close(layout.dimensionsMm[axis] + layout.clearanceMm[axis], layout.bayMm[axis], 0.11);
  }
  assert.equal(layout.cellDimensionBasis, 'LG MJ1 manufacturer maximum dimensions');
  assert.match(layout.selectionRule, /balanced footprint/i);
});

test('thermal end temperatures and live margins obey one identity', () => {
  const thermal = data.thermal;
  const limit = thermal.shared.cellDischargeLimitC;
  const baseline = thermal.baseline.results;
  const improved = thermal.improved.results;
  close(limit - baseline.endMaxTempC, baseline.endMarginToCellLimitC, 0.001);
  close(limit - improved.endMaxTempC, improved.endMarginToCellLimitC, 0.001);
  close(baseline.endMaxTempC - improved.endMaxTempC,
    thermal.comparison.endTemperatureReductionC, 0.011);
  assert.equal(baseline.cellLimitBreached, false);
  assert.equal(improved.cellLimitBreached, false);
  assert.equal(thermal.comparison.thresholdBreached, false);
  assert.match(thermal.modelBoundary.join(' '), /NOT 3-D/);
});

test('example data states the screening boundary and input provenance', () => {
  assert.equal(data.provenance.generator, 'reports/examples/visual-decision-report/generate-data.mjs');
  assert.ok(data.provenance.engineModules.every((module) => module.startsWith('js/')));
  assert.match(data.provenance.claimBoundary, /concept-screening/i);
  assert.match(data.inputs.mission.traceNote, /synthesized/i);
  assert.equal(data.inputs.bayMm.x, 1800);
  assert.equal(data.inputs.bayMm.y, 1400);
  assert.equal(data.inputs.bayMm.z, 150);
  assert.match(data.cell.specificationUrl, /^https:\/\//);
});

test('the audited dataset is reproducible from the committed engine generator', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('generate-data.mjs', root)), '--check'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"topology": "110S x 43P"/);
});
