// TCO — the cycle-based cost model: cost per delivered kWh, replacements
// over the target duty, and the cost-basis switch in max-fill.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { CELLS, cellById } from '../js/cells.js';
import { costModel, maxFill, TCO_DOD } from '../js/optimizer.js';

test('hand-checked arithmetic on the 50E (500 cycles, $5, 13S4P)', () => {
  const c = cellById('samsung-inr21700-50e');
  const n = 52, energyWh = n * c.nominalV * c.capacityAh;
  const cm = costModel(c, n, energyWh, { cyclesPerYear: 250, targetYears: 6 });
  ok(Math.abs(cm.upfrontUSD - 52 * c.priceUSD) < 1e-9, 'upfront = n × price');
  const expThroughput = (c.cycleLife * energyWh * TCO_DOD) / 1000;
  ok(Math.abs(cm.throughputKWh - expThroughput) < 1e-6, 'throughput = cycles × E × DoD');
  ok(Math.abs(cm.usdPerKWhDelivered - cm.upfrontUSD / expThroughput) < 1e-9, '$/kWh delivered');
  // 250 cy/y × 6 y = 1500 cycles over 500-cycle life → 3 packs.
  ok(cm.replacements === 3, `replacements (${cm.replacements}) = 3`);
  ok(Math.abs(cm.tcoUSD - cm.upfrontUSD * 3) < 1e-9, 'TCO = upfront × replacements');
  ok(Math.abs(cm.serviceYears - 2) < 1e-9, 'service life = cycleLife / cyclesPerYear');
});

test('cycle life flips the economics: LFP beats NMC per delivered kWh', () => {
  const nmc = cellById('samsung-inr21700-50e');
  const lfp = cellById('eve-lf280k');
  const cmN = costModel(nmc, 100, 100 * nmc.nominalV * nmc.capacityAh, {});
  const cmL = costModel(lfp, 2, 2 * lfp.nominalV * lfp.capacityAh, {});
  ok(cmN.usdPerKWhDelivered > cmL.usdPerKWhDelivered,
    `LFP delivered-kWh cost (${cmL.usdPerKWhDelivered?.toFixed(2)}) beats NMC (${cmN.usdPerKWhDelivered?.toFixed(2)})`);
});

test('null-safety: no price and no cycle life stay null, never NaN', () => {
  const c = { ...cellById('samsung-inr21700-50e'), priceUSD: null, cycleLife: null };
  const cm = costModel(c, 10, 176, { cyclesPerYear: 100, targetYears: 5 });
  ok(cm.upfrontUSD === null && cm.usdPerKWhDelivered === null && cm.tcoUSD === null, 'nulls stay null');
});

test('the cost basis changes the ranking under a hard duty', () => {
  // 365 cy/y × 10 y: TCO must favor long-life chemistry relative to upfront.
  const env = { x: 500, y: 300, z: 250 };
  const base = { spacingMm: 1, wallMm: 2, layerGapMm: 2, coolingSpace: { bottom: 0, side: 0, rowGap: 0 } };
  const mk = (costBasis) => maxFill(CELLS, env, {
    vRange: [24, 52], cyclesPerYear: 365, targetYears: 10, costBasis,
    weights: { energy: 0, cost: 10, mass: 0 },
  }, base, 12);
  const up = mk('upfront'), tc = mk('tco');
  ok(up.length && tc.length, 'both bases return candidates');
  ok(up.every((r) => r.costBasisUsed === 'upfront') && tc.every((r) => r.costBasisUsed === 'tco'),
    'basis recorded on candidates');
  const rank = (list, pred) => list.findIndex(pred);
  const isLongLife = (r) => ['LFP', 'LTO'].includes(r.cell.chemistry);
  const upLL = rank(up, isLongLife), tcLL = rank(tc, isLongLife);
  ok(tcLL >= 0 && (upLL < 0 || tcLL <= upLL),
    `long-life chemistry ranks no worse under TCO (upfront idx ${upLL}, tco idx ${tcLL})`);
  // Every TCO candidate with a price and cycle life carries the TCO fields.
  for (const r of tc) {
    if (r.costUSD != null && r.cell.cycleLife != null) {
      ok(r.tco.tcoUSD != null && r.tco.replacements >= 1, `${r.cell.id} carries TCO`);
    }
  }
});
