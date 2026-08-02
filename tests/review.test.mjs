// Review fixes — regressions for findings from the adversarial review rounds.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { CELLS, cellById } from '../js/cells.js';
import { layoutPack, gridDims, summarize } from '../js/pack-engine.js';
import { optimizeSpace, suggestDesigns } from '../js/optimizer.js';
import { runChecks } from '../js/standards.js';

const c = cellById('samsung-inr21700-50e');

test('empty-layer guard: no phantom layers anywhere', () => {
  ok(gridDims(c, 5, 2, 4, 'grid', 1, 2, 'upright') === null, 'gridDims N=5 nz=4 rejected');
  ok(gridDims(c, 13, 3, 6, 'grid', 1, 2, 'upright') === null, 'gridDims N=13 nz=6 rejected');
  // layoutPack degrades nz instead of nulling
  const L1 = layoutPack(c, 5, 1, { nz: 4, spacingMm: 1 });
  ok(L1 && L1.positions.length === 5, 'layoutPack N=5 nz=4 degrades');
  const usedLayers = new Set(L1.positions.map((p) => p.layer)).size;
  ok(usedLayers === L1.nz, `no empty layers: ${usedLayers} used == nz ${L1.nz}`);
  // optimizeSpace candidates never include phantom layers
  for (const cd of optimizeSpace(c, 13, 1, {}, null, 8)) {
    ok((cd.nz - 1) * Math.ceil(13 / cd.nz) < 13, `candidate nz=${cd.nz} has no empty layer`);
  }
});

test('fitsRotated flag stays honest', () => {
  const target = { x: 60, y: 400, z: 90 }; // narrow in x, long in y
  const cands = optimizeSpace(c, 13, 1, {}, target, 8);
  for (const cd of cands.filter((x) => x.fits)) {
    const direct = cd.outer.x <= target.x && cd.outer.y <= target.y && cd.outer.z <= target.z;
    const rot = cd.outer.y <= target.x && cd.outer.x <= target.y && cd.outer.z <= target.z;
    ok(direct || rot, 'fit claim valid');
    ok(cd.fitsRotated === (!direct && rot), `fitsRotated flag correct (direct=${direct} rot=${rot} flag=${cd.fitsRotated})`);
  }
});

test('standards checks: hot-charge warning and transport wording', () => {
  const L = layoutPack(c, 13, 4, {});
  const S = summarize(c, 13, 4, L);
  const ctx = {
    cell: c, s: 13, p: 4,
    pack: {
      nominalV: S.nominalV, vMax: S.vMax, vMin: S.vMin, capacityAh: S.capacityAh,
      energyWh: S.energyWh, massKg: S.massKg, cellCount: S.cellCount,
      maxContCurrentA: S.maxContCurrentA, maxContPowerW: S.maxContPowerW,
      dcirMOhm: S.dcirMOhm, dims: S.dims, volumeL: S.volumeL,
    },
    layout: { spacingMm: 1, arrangement: 'hex', wallMm: 2 },
    usage: { application: 'ebike', contPowerW: 500, peakPowerW: 1200, chargeRateC: 0.5, envTempC: [10, 55] },
  };
  const findings = runChecks(ctx);
  ok(findings.some((f) => f.id === 'hot-charge' && f.severity === 'warn'), 'hot-charge warn emitted for 55C env');
  ok(!findings.some((f) => f.id === 'cold-charge' && f.severity === 'pass'), 'no false "within window" pass when hot');
  // cool env still passes
  ctx.usage.envTempC = [5, 30];
  const f2 = runChecks(ctx);
  ok(f2.some((f) => f.id === 'cold-charge' && f.severity === 'pass'), 'within-window pass for 5..30C');
  ok(!f2.some((f) => f.id === 'hot-charge'), 'no hot-charge for 5..30C');
  // Transport wording updated.
  const texts = f2.map((f) => f.detail + f.ref).join(' ');
  ok(/Section IB/.test(texts), 'PI 965 Section IB wording present');
  ok(!/simplified Section II \/ SP 188 route/.test(texts), 'old Section II cell wording gone');
});

// Continuous power must be deliverable at the BOTTOM of the voltage window,
// not just at nominal. Sizing at nominal under-sizes by vNom/vMin — about
// 1.44x on NMC — and produced top-ranked designs that overload in the last
// third of the discharge while reporting healthy headroom.
test('suggested designs hold continuous power at vMin', () => {
  const cases = [
    { vRange: [44, 52], energyWh: 500, contPowerW: 1500, peakPowerW: 3000, preferredChemistries: [] },
    { vRange: [22, 30], energyWh: 200, contPowerW: 2000, peakPowerW: 4000, preferredChemistries: [] },
    { vRange: [70, 90], energyWh: 1000, contPowerW: 8000, peakPowerW: 16000, preferredChemistries: [] },
    { vRange: [11, 14], energyWh: 150, contPowerW: 1200, peakPowerW: 2400, preferredChemistries: [] },
  ];
  for (const req of cases) {
    for (const cand of suggestDesigns(req, CELLS, 4)) {
      const S = cand.summary;
      const needA = req.contPowerW / S.vMin;
      ok(needA <= S.maxContCurrentA + 1e-9,
        `${cand.cell.id} ${cand.s}S${cand.p}P holds ${req.contPowerW} W at vMin `
        + `(needs ${needA.toFixed(0)} A, rated ${S.maxContCurrentA.toFixed(0)} A)`);
    }
  }
});
