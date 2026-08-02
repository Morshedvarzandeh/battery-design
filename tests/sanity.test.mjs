// Sanity — the data contracts and core engine math everything else stands on.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { CELLS, CHEMISTRIES, cellById, cellEnergyWh, cellVolumeL } from '../js/cells.js';
import { electrical, layoutPack, summarize } from '../js/pack-engine.js';
import { optimizeSpace, suggestDesigns } from '../js/optimizer.js';

test('cell library: every entry keeps the data contract', () => {
  ok(CELLS.length >= 14, `cell count ${CELLS.length} >= 14`);
  const ids = new Set();
  for (const c of CELLS) {
    ok(!ids.has(c.id), `dup id ${c.id}`); ids.add(c.id);
    ok(CHEMISTRIES[c.chemistry], `${c.id} chemistry ${c.chemistry} known`);
    ok(['cylindrical', 'prismatic', 'pouch'].includes(c.form), `${c.id} form`);
    if (c.form === 'cylindrical') ok(c.dims.d > 0 && c.dims.h > 0, `${c.id} dims d/h`);
    else {
      ok(c.dims.w > 0 && c.dims.t > 0 && c.dims.h > 0, `${c.id} dims w/t/h`);
      ok(c.dims.t <= c.dims.w, `${c.id} t<=w (${c.dims.t} vs ${c.dims.w})`);
    }
    ok(c.vMin < c.nominalV && c.nominalV < c.vMax, `${c.id} voltage ordering`);
    ok(c.massG > 0 && c.capacityAh > 0, `${c.id} mass/capacity`);
    ok(c.maxContDischargeA > 0 && c.maxContChargeA > 0, `${c.id} currents`);
    ok(Array.isArray(c.tempDischargeC) && Array.isArray(c.tempChargeC), `${c.id} temps`);
    // density sanity: cell-level Wh/kg between 30 and 350
    const whkg = cellEnergyWh(c) / (c.massG / 1000);
    ok(whkg > 30 && whkg < 350, `${c.id} Wh/kg plausible (${whkg.toFixed(0)})`);
    // volumetric: Wh/L between 50 and 900
    const whl = cellEnergyWh(c) / cellVolumeL(c);
    ok(whl > 50 && whl < 900, `${c.id} Wh/L plausible (${whl.toFixed(0)})`);
  }
});

test('engine math on the 50E: electrical, layout, no overlaps, honest fit flags', () => {
  const c50 = cellById('samsung-inr21700-50e');
  ok(c50, '50E present');
  const e = electrical(c50, 13, 4);
  ok(Math.abs(e.nominalV - 13 * c50.nominalV) < 1e-9, 'nominalV');
  ok(Math.abs(e.capacityAh - 4 * c50.capacityAh) < 1e-9, 'capacityAh');
  ok(Math.abs(e.energyWh - 52 * c50.nominalV * c50.capacityAh) < 1e-6, 'energyWh');
  const L = layoutPack(c50, 13, 4, { arrangement: 'hex', spacingMm: 1, wallMm: 2 });
  ok(L.positions.length === 52, `52 positions (${L.positions.length})`);
  ok(L.packingEfficiency > 0.4 && L.packingEfficiency < 0.92, `packing eff ${L.packingEfficiency.toFixed(2)}`);
  const sIdx = new Set(L.positions.map((p) => p.sIndex));
  ok(sIdx.size === 13, `13 series groups (${sIdx.size})`);
  for (let i = 0; i < 13; i++) ok(L.positions.filter((p) => p.sIndex === i).length === 4, `group ${i} has 4`);
  // no overlapping cells: min pairwise distance >= pitch - eps in same layer
  let minD = 1e9;
  for (let i = 0; i < L.positions.length; i++) for (let j = i + 1; j < L.positions.length; j++) {
    const a = L.positions[i], b = L.positions[j];
    if (a.layer !== b.layer) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    minD = Math.min(minD, d);
  }
  ok(minD >= c50.dims.d - 1e-6, `no overlap: min center dist ${minD.toFixed(2)} >= d ${c50.dims.d}`);
  // all cells inside inner box
  for (const q of L.positions) {
    ok(Math.abs(q.x) <= L.inner.x / 2 - c50.dims.d / 2 + 1e-6, `x inside (${q.x.toFixed(1)} vs ${(L.inner.x / 2).toFixed(1)})`);
    ok(Math.abs(q.y) <= L.inner.y / 2 - c50.dims.d / 2 + 1e-6, 'y inside');
  }
  const S = summarize(c50, 13, 4, L);
  ok(S.whPerKg > 100 && S.whPerKg < 260, `pack Wh/kg ${S.whPerKg?.toFixed(0)}`);

  // optimizeSpace: fits flag honest
  const target = { x: 160, y: 160, z: 90 };
  const cands = optimizeSpace(c50, 13, 4, {}, target, 6);
  ok(cands.length > 0, 'space candidates exist');
  for (const cd of cands.filter((x) => x.fits)) {
    const fitsDirect = cd.outer.x <= target.x && cd.outer.y <= target.y && cd.outer.z <= target.z;
    const fitsRot = cd.outer.y <= target.x && cd.outer.x <= target.y && cd.outer.z <= target.z;
    ok(fitsDirect || fitsRot, `candidate really fits ${JSON.stringify(cd.outer)}`);
  }
});

test('prismatic cells lay out too', () => {
  const catl = CELLS.find((c) => c.form === 'prismatic');
  ok(catl, 'a prismatic cell exists');
  const L = layoutPack(catl, 4, 1, { spacingMm: 2 });
  ok(L && L.positions.length === 4, 'prismatic 4S1P layout');
});

test('suggestDesigns: e-bike request yields designs near the window', () => {
  const req = {
    vRange: [36, 52], energyWh: 500, contPowerW: 500, peakPowerW: 1200,
    chargeRateC: 0.5, maxMassKg: 4, maxDimsMm: null, envTempC: [0, 40],
    preferredChemistries: ['NMC', 'NCA', 'LFP'], cyclesPerYear: 250, targetYears: 5,
  };
  const sug = suggestDesigns(req, CELLS);
  ok(sug.length > 0, `suggestions returned (${sug.length})`);
  const top = sug[0];
  ok(top.summary.energyWh >= 450, `top energy ${top.summary.energyWh.toFixed(0)} >= ~500`);
  ok(top.summary.nominalV >= 30 && top.summary.nominalV <= 60, `top V ${top.summary.nominalV.toFixed(1)} near window`);
});
