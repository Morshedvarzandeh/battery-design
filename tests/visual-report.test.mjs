import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { designFromSpec, layoutForDesign } from '../js/api.js';
import { cellById } from '../js/cells.js';
import { buildThermalSystem } from '../js/btms.js';
import { buildScene } from '../js/scene3d.js';
import { simulate, defaultParams } from '../js/sim2.js';
import { simulateMission } from '../js/sim1d.js';
import {
  VISUAL_REPORT_SCHEMA,
  buildVisualReportHTML,
  buildVisualReportModel,
  validateVisualReportModel,
  visualReportFilename,
} from '../js/visual-report.js';

function reportFixture({ simulation = 'sim2', thermal = true, application = 'ev' } = {}) {
  const design = designFromSpec({
    application,
    cell: 'lg-inr18650-mj1',
    s: 110,
    p: 43,
    components: { cooling: 'bottom-cold-plate' },
  });
  const layout = layoutForDesign(design);
  const engineCell = cellById('lg-inr18650-mj1');
  const sim2 = simulation === 'sim2' ? simulate({
    cell: engineCell,
    s: design.pack.s,
    p: design.pack.p,
    params: defaultParams(engineCell),
    profile: { dtS: 5, i: Array.from({ length: 48 }, (_, index) => 70 + 30 * Math.sin(index / 5)) },
    nModules: 10,
    ambientC: 40,
    startSoC: 0.9,
  }) : null;
  const sim1 = simulation === 'sim1' ? simulateMission({
    cell: engineCell,
    s: design.pack.s,
    p: design.pack.p,
    profile: { dtS: 5, p: Array.from({ length: 48 }, (_, index) => 0.45 + 0.2 * Math.sin(index / 5)) },
    scaleW: 42_000,
    startSoC: 0.9,
    ambientC: 40,
    uaWK: 3,
  }) : null;
  const semanticBinding = {
    cellId: design.spec.resolved.cell,
    series: design.spec.resolved.s,
    parallel: design.spec.resolved.p,
    cellCount: design.pack.cellCount,
    nominalVoltageV: design.pack.nominalV,
    nominalEnergyWh: design.pack.energyWh,
    preliminaryMassKg: design.pack.massKg,
    outerDimensionsMm: design.pack.dims,
    layout: design.spec.resolved.layout,
  };
  return {
    date: '2026-08-06',
    application: design.application.id,
    cell: design.cell,
    summary: design.pack,
    massWithComponentsKg: design.analysis.totals.packMassWithComponentsKg,
    bayLabel: 'declared example box',
    findings: design.findings,
    thermal: thermal ? design.thermal : null,
    sim: sim1 || sim2,
    semantics: design.semantics,
    semanticBinding,
    scene: buildScene({ design, layout, showHost: true }),
  };
}

test('visual report preserves exact topology, nominal basis and semantic identity', () => {
  const report = reportFixture();
  const model = buildVisualReportModel(report);
  assert.equal(model.schema, VISUAL_REPORT_SCHEMA);
  assert.deepEqual(model.pack.topology, { series: 110, parallel: 43, cellCount: 4730 });
  assert.equal(model.pack.nominalVoltageV, 399.85);
  assert.equal(model.pack.nominalEnergyKWh, 60.177);
  assert.equal(model.pack.preliminaryMassKg, 294.1);
  assert.equal(model.integrity.rootId, report.semantics.rootId);
  assert.equal(model.integrity.checksum, report.semantics.ontology.checksum);
  assert.equal(model.integrity.authoritative, false, 'an unsigned checksum is not release authority');
  assert.ok(model.durationS < 60, 'the animated report remains sub-minute');
  assert.deepEqual(validateVisualReportModel(model), { valid: true, errors: [] });
});

test('application and thermal visuals come from the reusable versioned asset library', () => {
  const model = buildVisualReportModel(reportFixture());
  for (const asset of [model.application.asset, model.thermalAsset]) {
    assert.ok(asset.assetId && asset.version && asset.geometryDigest);
    assert.match(asset.version, /^\d+\.\d+\.\d+/);
    assert.match(asset.geometryDigest, /^fnv1a32:[0-9a-f]{8}$/);
    assert.equal(asset.licence.spdx, 'MIT');
    assert.equal(asset.visualStyle, 'flat-technical');
    assert.deepEqual(asset.effects, { castShadows: false, decorativeWake: false });
  }
  assert.equal(model.application.asset.assetId, 'host/car');
  assert.equal(model.thermalAsset.assetId, 'thermal/liquid-cold-plate-chiller');
  assert.ok(model.thermal.hardware.some((item) => /pump/i.test(item)));
  assert.ok(model.thermal.hardware.some((item) => /chiller/i.test(item)));
});

test('the visual report is self-contained and does not turn screening into proof', () => {
  const report = reportFixture();
  const html = buildVisualReportHTML(report);
  assert.match(html, /VISUAL DECISION REPORT/);
  assert.match(html, /kWh NOMINAL/);
  assert.match(html, /preliminary; review exclusions/);
  assert.match(html, /screened layout, not production CAD/);
  assert.match(html, /Equivalent-circuit \+ lumped-thermal mission screen/);
  assert.match(html, /First-order flow and chiller sizing/);
  assert.ok(html.includes(report.semantics.rootId));
  assert.ok(html.includes(report.semantics.ontology.checksum));
  assert.doesNotMatch(html, /THERMAL DESIGN VERIFIED|FLOW VERIFIED|BUILDABLE CONCEPT|REAL MISSION/i);
  assert.doesNotMatch(html, /undefined|NaN/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/i, 'the downloaded report has no external runtime dependency');
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(inlineScripts.length >= 2, 'model and runtime scripts are embedded');
  assert.doesNotThrow(() => new Function(inlineScripts.at(-1)), 'the standalone report runtime parses');
  assert.equal(visualReportFilename(report), 'pack-visual-lg-inr18650-mj1-110s43p.html');
});

test('the production sim1d result is normalized without losing duration, peak temperature or traces', () => {
  const report = reportFixture({ simulation: 'sim1' });
  const model = buildVisualReportModel(report);
  assert.equal(model.simulation.durationS, report.sim.durationS);
  assert.equal(model.simulation.hottestModeledNodeC, Math.round(report.sim.summary.maxT * 100) / 100);
  assert.equal(model.simulation.series.timeS.length, report.sim.trace.tS.length);
  assert.deepEqual(model.simulation.series.currentA.slice(0, 4), report.sim.trace.iA.slice(0, 4).map((value) => Math.round(value * 1000) / 1000));
  const html = buildVisualReportHTML(report);
  assert.match(html, /PACK CURRENT/);
  assert.match(html, new RegExp(`${report.sim.durationS}`));
});

test('each thermal loop renders only the hardware that was selected', () => {
  const base = reportFixture({ simulation: false });
  const cell = cellById('lg-inr18650-mj1');
  const thermalFor = (loopId, appId = 'ev') => buildThermalSystem({
    heatContW: 950,
    ambientC: [0, 40],
    cooling: { name: 'Bottom cold plate', kind: 'cold-plate', needsPump: true, viz: 'bottom' },
    cell,
    override: loopId,
    appId,
  });
  const radiator = buildVisualReportModel({ ...base, thermal: thermalFor('liquid') });
  assert.equal(radiator.thermalAsset.assetId, 'thermal/liquid-cold-plate-radiator');
  assert.equal(radiator.thermalAsset.primitives.some((primitive) => primitive.role === 'chiller'), false);
  const chilled = buildVisualReportModel({ ...base, thermal: thermalFor('liquid-chiller') });
  assert.equal(chilled.thermalAsset.assetId, 'thermal/liquid-cold-plate-chiller');
  assert.ok(chilled.thermalAsset.primitives.some((primitive) => primitive.role === 'chiller'));
  const forced = buildVisualReportModel({ ...base, thermal: thermalFor('forced-air') });
  assert.equal(forced.thermalAsset.assetId, 'thermal/forced-air-duct');
  const passive = buildVisualReportModel({ ...base, thermal: thermalFor('passive-air') });
  assert.equal(passive.thermalAsset, null);
  assert.match(buildVisualReportHTML({ ...base, thermal: thermalFor('passive-air') }), /No dedicated thermal-loop hardware/);
});

test('unavailable mission or thermal evidence removes the scene instead of inventing output', () => {
  const model = buildVisualReportModel(reportFixture({ simulation: false, thermal: false }));
  assert.equal(model.simulation, null);
  assert.equal(model.thermal, null);
  assert.equal(model.thermalAsset, null);
  assert.ok(!model.sceneIds.includes('mission'));
  assert.ok(!model.sceneIds.includes('thermal'));
  assert.deepEqual(model.sceneIds, ['application', 'sizing', 'decision', 'trace']);
  assert.equal(model.durationS, 28);
  const html = buildVisualReportHTML(reportFixture({ simulation: false, thermal: false }));
  assert.doesNotMatch(html, /data-scene="mission"|data-scene="thermal"/);
});

test('report presentation never invokes an engineering engine of its own', () => {
  const source = readFileSync(new URL('../js/visual-report.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/(?:pack-engine|optimizer|sim1d|sim2|btms|vehicle)\.js/);
  assert.match(source, /consumes the exact report snapshot/);
  assert.match(source, /never runs sizing/);
});

test('inconsistent topology is blocked before an attractive report can hide it', () => {
  const report = reportFixture();
  assert.throws(
    () => buildVisualReportModel({ ...report, summary: { ...report.summary, cellCount: 4729 } }),
    /Topology integrity failed/,
  );
});

test('a semantic snapshot for another layout cannot be attached to the report', () => {
  const report = reportFixture();
  assert.throws(
    () => buildVisualReportModel({
      ...report,
      semanticBinding: {
        ...report.semanticBinding,
        outerDimensionsMm: { ...report.semanticBinding.outerDimensionsMm, x: report.semanticBinding.outerDimensionsMm.x + 1 },
      },
    }),
    /does not match its semantic design binding: screened dimensions/,
  );
});

test('custom layout inputs are owned by the engine and reproduce exactly', () => {
  const design = designFromSpec({
    application: 'ev', cell: 'lg-inr18650-mj1', s: 110, p: 43,
    components: { cooling: 'bottom-cold-plate' },
    layout: {
      arrangement: 'grid', orientation: 'upright', spacingMm: 2.5,
      layerGapMm: 4, wallMm: 3, headroomMm: 12, underMm: 10,
      rowExtraMm: 0, nx: 55, nz: 2,
    },
  });
  const layout = layoutForDesign(design);
  assert.deepEqual(design.spec.resolved.layout, {
    arrangement: 'grid', orientation: 'upright', spacingMm: 2.5,
    layerGapMm: 4, wallMm: 3, headroomMm: 12, underMm: 10,
    rowExtraMm: 0, nx: 55, nz: 2, bay: null,
  });
  assert.deepEqual(design.pack.dims, layout.outer);
  assert.equal(layout.positions.length, 4730);
});
