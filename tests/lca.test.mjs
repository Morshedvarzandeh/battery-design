// Life-cycle assessment — and the honesty that has to come with it.
//
// A footprint quoted to four figures with no error bar is the most misleading
// number a tool can produce, so most of these tests are about what the module
// REFUSES to do: invent an assembly figure, collapse a range to a midpoint, or
// compare an electric vehicle's energy against a grid factor.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  lifeCycle, basisFor, DISPLACEMENT_BASIS, RECOVERY,
} from '../js/lca.js';
import { buildTopology } from '../js/topology.js';
import { CO2_MFG_PER_KWH } from '../js/report.js';
import { designFromSpec } from '../js/api.js';
import { cellById } from '../js/cells.js';

function run(application = 'ev', over = {}) {
  const d = designFromSpec({ application, ...(over.spec || {}) });
  const cell = cellById(d.cell.id);
  const topology = buildTopology({
    summary: d.pack, partition: d.architecture.partition, cellForm: cell.form,
  });
  return {
    d, cell,
    lca: lifeCycle({
      pack: d.pack, cell, topology, application, gridGPerKWh: 440, ...(over.lca || {}),
    }),
  };
}

test('the cells are the answer, and the module says so out loud', () => {
  const { lca, d, cell } = run('ev', { spec: { energyWh: 60000 } });
  const cells = lca.phases.find((p) => p.id === 'cells');
  // The figure is the chemistry factor times the capacity, not a new model.
  near(cells.kgCO2e, (d.pack.energyWh / 1000) * CO2_MFG_PER_KWH[cell.chemistry], 1,
    'cell footprint is the published factor times the capacity');
  ok(cells.shareOfMaterials > 0.9, `the cells are ${(cells.shareOfMaterials * 100).toFixed(0)}% of the build`);
  const conductors = lca.phases.find((p) => p.id === 'conductors');
  ok(conductors.shareOfMaterials < 0.05, 'and every conductor together is under 5%');
  // That is the finding worth having, because it redirects effort.
  const f = lca.findings.find((x) => /cells are/.test(x.title));
  ok(f && /conductor optimisation does not/.test(f.detail),
    'and it says plainly that optimising busbars will not move the footprint');
});

test('every phase carries how well it is known, because they differ enormously', () => {
  const { lca } = run();
  for (const p of lca.phases) {
    ok(p.quality?.label && p.quality.why, `${p.id} states its data quality and why`);
    ok(p.basis, `${p.id} says where its number came from`);
  }
  const labels = lca.phases.map((p) => p.quality.label);
  ok(new Set(labels).size > 2, 'and they are genuinely different, not one label repeated');
  ok(labels.includes('unknown'), 'including one that admits to knowing nothing');
});

test('pack assembly is not estimated, and the total says so', () => {
  const { lca } = run();
  const asm = lca.phases.find((p) => p.id === 'assembly');
  ok(asm.kgCO2e === null, 'assembly has no number');
  ok(/depends on your factory/i.test(asm.basis), 'and says why not');
  ok(lca.totals.unknownPhases.includes('Pack assembly'),
    'the totals name what was left out rather than quietly excluding it');
  // A plausible invented figure would be indistinguishable from the grounded
  // ones, which is exactly the failure mode being avoided.
  ok(/not.*number|inventing/i.test(lca.assumptions.join(' ')),
    'and the assumptions explain why inventing one would be worse');
});

test('a range is carried, not collapsed to a comfortable midpoint', () => {
  const { lca } = run();
  const t = lca.totals;
  ok(t.gateLowKg < t.cradleToGateKg && t.cradleToGateKg < t.gateHighKg,
    'the build figure sits inside its own spread');
  ok(t.gateHighKg / t.gateLowKg > 2, 'and the spread is wide, because the underlying factors are');
  ok(t.lowKg < t.totalKg && t.totalKg < t.highKg, 'the whole-life figure likewise');
  for (const p of lca.phases.filter((x) => x.kgCO2e != null && x.id !== 'losses')) {
    ok(p.lowKg <= p.kgCO2e && p.kgCO2e <= p.highKg, `${p.id} has a coherent range`);
  }
});

test('recycling is a credit and never a cost', () => {
  const { lca } = run();
  const eol = lca.phases.find((p) => p.id === 'eol');
  ok(eol.kgCO2e < 0, 'recovery subtracts from the footprint');
  ok(eol.lowKg <= eol.highKg, 'its range is ordered like every other');
  ok(Math.abs(eol.kgCO2e) < lca.totals.cradleToGateKg,
    'but it never returns more than was spent building the pack');
  ok(/only if the pack reaches a recycler/i.test(lca.assumptions.join(' ')),
    'and it is conditional on the pack actually being recycled');
  for (const [id, r] of Object.entries(RECOVERY)) {
    ok(r.low >= 0 && r.high <= 1 && r.low <= r.high, `${id} recovery is a sane fraction`);
    ok(r.what, `${id} says what it means`);
  }
});

test('an EV is compared against fuel, storage against two hours of grid', () => {
  // The correction that matters most: "avoided emissions" against a grid
  // factor is the wrong question for a car and the wrong SIGN for storage.
  ok(basisFor('ev').id === 'fuel', 'a road vehicle displaces fuel');
  ok(basisFor('ebike').id === 'fuel', 'so does light mobility');
  ok(basisFor('solar-ess').id === 'shifting', 'stationary storage shifts rather than generates');
  ok(basisFor('drone').id === 'grid', 'a portable machine really does draw from the grid');

  const ev = run('ev').lca;
  ok(ev.basis.id === 'fuel', 'the EV study picks the fuel basis');
  const warn = ev.findings.find((f) => /Compare the delivered energy/.test(f.title));
  ok(warn.severity === 'warn', 'and warns, because the tool elsewhere uses a grid factor');
  ok(/wrong comparison for this machine/i.test(warn.detail),
    'saying explicitly that the existing payback figure is the wrong comparison here');

  const ess = run('solar-ess').lca;
  ok(/net emitter/i.test(ess.basis.what),
    'and storage is told it can be a net emitter, which is the part people miss');

  // Where the grid basis IS right, there is nothing to warn about.
  ok(run('drone').lca.findings.find((f) => /Compare the delivered/.test(f.title)).severity === 'info',
    'a grid-drawing machine gets an note, not a warning');
  for (const [id, b] of Object.entries(DISPLACEMENT_BASIS)) {
    ok(b.name && b.what && b.needs, `${id} says what it is, why, and what it needs from you`);
  }
});

test('round-trip losses are counted, which the payback model never did', () => {
  const { lca } = run();
  const loss = lca.phases.find((p) => p.id === 'losses');
  ok(loss.kgCO2e > 0, 'energy lost to inefficiency is a real emission');
  // A worse round trip costs more, monotonically.
  const worse = run('ev', { lca: { roundTripEff: 0.8 } }).lca.phases.find((p) => p.id === 'losses');
  ok(worse.kgCO2e > loss.kgCO2e, 'a less efficient pack loses more');
  // And it is charged at the charging grid, not the displaced one.
  const clean = run('ev', { lca: { chargeGPerKWh: 50 } }).lca.phases.find((p) => p.id === 'losses');
  ok(clean.kgCO2e < loss.kgCO2e, 'charging from a clean grid makes the losses cheaper');
});

test('it never quotes a per-kWh figure it cannot compute', () => {
  const { lca } = run();
  ok(lca.totals.gPerKWhDelivered > 0, 'with a cycle life there is a delivered figure');
  ok(lca.totals.kgPerKWhCapacity > 30 && lca.totals.kgPerKWhCapacity < 200,
    `and the build figure lands in the published band (${lca.totals.kgPerKWhCapacity.toFixed(0)} kg/kWh)`);

  // Strip the cycle life and the delivered figure must vanish, not default.
  const noLife = lifeCycle({
    pack: { energyWh: 60000, enclosureKg: 10 },
    cell: { chemistry: 'NMC', cycleLife: null }, application: 'ev', gridGPerKWh: 440,
  });
  ok(noLife.totals.gPerKWhDelivered === null, 'without a cycle life there is no per-kWh-delivered figure');
  ok(noLife.findings.some((f) => /No cycle life/.test(f.title)), 'and that is a finding, not a silent null');
  ok(/no delivered energy/i.test(noLife.headline), 'the headline says so too');
});

test('it is a screening estimate and never claims to be a declaration', () => {
  const { lca } = run();
  const all = lca.assumptions.join(' ');
  ok(/SCREENING/.test(all), 'the first assumption is that this is a screening estimate');
  ok(/14040|14044/.test(all) && /Battery Regulation/i.test(all),
    'and it names the standards a real declaration answers to');
  ok(/not enough to (put on a document|declare)/i.test(all), 'saying plainly what it may not be used for');
  ok(/Transport, capital equipment/.test(all), 'and what is outside the boundary entirely');
  ok(lifeCycle({ pack: null, cell: null }) === null, 'no pack, no answer');
});
