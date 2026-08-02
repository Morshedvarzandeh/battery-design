// Max fill — the space-first multi-objective flow: cells packed into a fixed
// envelope after component space is reserved, scored on energy / cost / mass
// with Pareto flagging.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { CELLS } from '../js/cells.js';
import { layoutPack } from '../js/pack-engine.js';
import { maxFill } from '../js/optimizer.js';

const env = { x: 300, y: 200, z: 90 };
const req = { vRange: [36, 52], weights: { energy: 5, cost: 3, mass: 2 } };
const base = { spacingMm: 1, wallMm: 2, layerGapMm: 2, coolingSpace: { bottom: 0, side: 0, rowGap: 0 } };
const results = maxFill(CELLS, env, req, base, 12);

test('every candidate is complete, in-window, and actually fits', () => {
  ok(results.length > 0, 'candidates exist');
  for (const r of results) {
    ok(r.n === r.s * r.p && r.n <= r.nMax, `${r.cell.id} n=s*p<=nMax`);
    ok(r.utilization > 0 && r.utilization <= 1, `${r.cell.id} utilization sane`);
    ok(r.nominalV >= req.vRange[0] - 1e-9 && r.nominalV <= req.vRange[1] + 1e-9,
      `${r.cell.id} ${r.nominalV}V inside window`);
    ok(typeof r.score === 'number' && r.score >= 0 && r.score <= 100, `${r.cell.id} score in range`);
    ok(typeof r.pareto === 'boolean', `${r.cell.id} pareto flagged`);
    // The applied layout must actually fit the envelope.
    const L = layoutPack(r.cell, r.s, r.p, r.opts);
    ok(L, `${r.cell.id} layout builds`);
    if (L) {
      ok(L.outer.x <= env.x + 1e-6 && L.outer.y <= env.y + 1e-6 && L.outer.z <= env.z + 1e-6,
        `${r.cell.id} layout ${L.outer.x.toFixed(0)}x${L.outer.y.toFixed(0)}x${L.outer.z.toFixed(0)} fits env`);
    }
  }
});

test('ranking is sorted and the Pareto front is real', () => {
  for (let i = 1; i < results.length; i++) ok(results[i - 1].score >= results[i].score, 'sorted by score');
  ok(results.some((r) => r.pareto), 'a Pareto-optimal candidate exists');
  // A candidate beaten on all three axes must be dominated.
  const best = results.find((r) => r.pareto);
  const worse = results.find((r) => r !== best &&
    r.energyWh <= best.energyWh && (r.costUSD ?? Infinity) >= (best.costUSD ?? Infinity) &&
    r.massKg >= best.massKg &&
    (r.energyWh < best.energyWh || r.massKg > best.massKg));
  if (worse) ok(!worse.pareto, `strictly dominated candidate ${worse.cell.id} not marked Pareto`);
});

test('weights steer the ranking', () => {
  const byCost = maxFill(CELLS, env, { ...req, weights: { energy: 0, cost: 10, mass: 0 } }, base, 12)
    .filter((r) => r.costUSD != null);
  for (let i = 1; i < byCost.length; i++) {
    ok(byCost[i - 1].costUSD <= byCost[i].costUSD + 1e-9, 'pure cost weight sorts by cost');
  }
  const byEnergy = maxFill(CELLS, env, { ...req, weights: { energy: 10, cost: 0, mass: 0 } }, base, 12);
  for (let i = 1; i < byEnergy.length; i++) {
    ok(byEnergy[i - 1].energyWh >= byEnergy[i].energyWh - 1e-9, 'pure energy weight sorts by energy');
  }
});

test('reserved component space never increases packed energy', () => {
  // A 10mm bottom plate in a tight-Z envelope must never fit more cells.
  const tight = { x: 300, y: 200, z: 84 };
  const noPlate = maxFill(CELLS, tight, req, base, 1)[0];
  const withPlate = maxFill(CELLS, tight, req,
    { ...base, coolingSpace: { bottom: 10, side: 0, rowGap: 0 } }, 1)[0];
  ok(!withPlate || !noPlate || withPlate.energyWh <= noPlate.energyWh + 1e-9,
    'reserved plate space never increases packed energy');
});

test('a bigger envelope never packs less energy', () => {
  const small = maxFill(CELLS, { x: 200, y: 150, z: 90 }, req, base, 1)[0];
  const big = maxFill(CELLS, { x: 400, y: 300, z: 90 }, req, base, 1)[0];
  ok(!small || (big && big.energyWh >= small.energyWh - 1e-9), 'monotonic in envelope size');
});
