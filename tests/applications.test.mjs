// Every application, end to end.
//
// There are sixteen presets and until now nothing walked all of them. Each
// suite tested a module against one or two machines it happened to suit, so a
// preset could be added — or a module changed — and only fail for the one
// application nobody tried. A wearable and a bus share almost no numbers, and
// the places things break are the extremes: the 6 Wh pack and the 250 kWh one.
//
// This is deliberately breadth rather than depth. It does not check that the
// e-bus answer is RIGHT, which the module suites do. It checks that every
// machine gets a complete, self-consistent, non-absurd answer — and that the
// tool's own opinions about which machine needs what are honoured all the way
// through, not just in the graph that declares them.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { designFromSpec } from '../js/api.js';
import { PRESETS } from '../js/presets.js';
import { appClassOf } from '../js/markets.js';
import { needed } from '../js/knowledge.js';
import { addonsFor } from '../js/addons.js';
import { partsBin, solveFor, compare } from '../js/garage.js';
import { buildTopology } from '../js/topology.js';
import { wiringStudy } from '../js/wiring.js';
import { lifeCycle } from '../js/lca.js';
import { swapPlan } from '../js/swap.js';
import { cellById } from '../js/cells.js';

const designs = new Map();
const designOf = (id) => {
  if (!designs.has(id)) designs.set(id, designFromSpec({ application: id }));
  return designs.get(id);
};

test('every application produces a complete design', () => {
  ok(PRESETS.length >= 16, `${PRESETS.length} applications`);
  for (const p of PRESETS) {
    const d = designOf(p.id);
    ok(d, `${p.id}: designs at all`);
    ok(d.pack?.cellCount > 0, `${p.id}: has cells`);
    ok(d.pack.s > 0 && d.pack.p > 0, `${p.id}: has a real S/P`);
    ok(d.pack.energyWh > 0 && d.pack.massKg > 0, `${p.id}: has energy and mass`);
    ok(d.cell?.name, `${p.id}: chose a cell`);
    ok(Array.isArray(d.findings), `${p.id}: was audited`);
    ok(d.checklist?.items?.length > 0, `${p.id}: got a release checklist`);
  }
});

test('the numbers are self-consistent for every machine', () => {
  for (const p of PRESETS) {
    const d = designOf(p.id);
    const { pack, cell } = d;
    const c = cellById(cell.id);
    // Cells multiply out.
    ok(pack.cellCount === pack.s * pack.p, `${p.id}: cell count is S x P`);
    // Energy is roughly the cells' energy — allow for how the engine rounds
    // and derates, but not for it being a different pack.
    const cellsWh = pack.cellCount * c.nominalV * c.capacityAh;
    ok(Math.abs(pack.energyWh - cellsWh) / cellsWh < 0.02, `${p.id}: energy matches the cells in it`);
    // The pack cannot weigh less than its cells.
    ok(pack.massKg >= pack.massCellsKg, `${p.id}: mass includes more than the cells`);
    // A tiny pack legitimately carries proportionally more: the enclosure
    // follows the square-cube law, so a 6 g cell stack needs a 20 g case.
    // Scaling the bound by size is the honest check — a fixed multiple would
    // either pass everything or fail every wearable.
    const overheadLimit = pack.massCellsKg < 0.1 ? 6 : pack.massCellsKg < 5 ? 3 : 2;
    ok(pack.massKg < pack.massCellsKg * overheadLimit,
      `${p.id}: overhead is ${(pack.massKg / pack.massCellsKg).toFixed(1)}x cells, under the ${overheadLimit}x expected at this size`);
    // Voltage follows series count.
    ok(Math.abs(pack.nominalV - pack.s * c.nominalV) < 0.5, `${p.id}: voltage is S x cell voltage`);
    ok(pack.vMin < pack.nominalV && pack.nominalV < pack.vMax, `${p.id}: the voltage window brackets nominal`);
    // Density is physically possible — no chemistry beats ~350 Wh/kg at pack level.
    ok(pack.whPerKg > 20 && pack.whPerKg < 350, `${p.id}: ${pack.whPerKg.toFixed(0)} Wh/kg is a real number`);
  }
});

test('the scale of each machine is believable for what it is', () => {
  // The extremes are where things break, so they are named rather than left
  // to a generic range: a wearable and an e-bus share no numbers at all.
  const kWh = (id) => designOf(id).pack.energyWh / 1000;
  ok(kWh('wearable') < 0.1, `a wearable is well under 100 Wh (${(kWh('wearable') * 1000).toFixed(0)} Wh)`);
  ok(kWh('ebike') > 0.2 && kWh('ebike') < 2, `an e-bike is a few hundred Wh (${kWh('ebike').toFixed(2)} kWh)`);
  ok(kWh('ev') > 10, `an EV is tens of kWh (${kWh('ev').toFixed(0)} kWh)`);
  ok(kWh('ebus') > kWh('ev'), 'a bus is bigger than a car');
  ok(designOf('wearable').pack.massKg < 1, 'a wearable pack is under a kilogram');
  ok(designOf('ebus').pack.massKg > 100, 'a bus pack is over a hundred');
  // And the ordering holds across the whole set rather than just the pair.
  ok(kWh('drone') < kWh('escooter'), 'a drone carries less than a scooter');
  ok(kWh('powertool') < kWh('powerstation'), 'a tool pack is smaller than a power station');
});

test('each machine is offered only what its own physics needs', () => {
  // Filtering must actually bite somewhere, or the graph is decorative.
  const counts = PRESETS.map((p) => addonsFor(p.id).length);
  ok(Math.min(...counts) < Math.max(...counts),
    `the catalogue is filtered: ${Math.min(...counts)} to ${Math.max(...counts)} add-ons depending on the machine`);
  for (const p of PRESETS) {
    const offered = addonsFor(p.id).map((a) => a.id);
    ok(offered.includes('pack') && offered.includes('audit'), `${p.id}: always gets the core`);
    // Deliberately NOT "every machine sees fewer than all": an EV genuinely
    // does need the whole catalogue, and asserting otherwise would force a
    // fake exclusion. What must hold is that filtering happens somewhere.

    // The domain separation, checked per application rather than by example.
    const moves = ['route-road', 'terrain', 'hull-resistance', 'flight-weather', 'legged-gait']
      .filter((c) => needed(p.id, c));
    if (appClassOf(p.id) === 'marine') {
      ok(moves.includes('hull-resistance'), `${p.id}: gets hull resistance`);
      ok(!moves.includes('route-road') && !moves.includes('terrain'), `${p.id}: gets no road physics`);
    }
    if (['stationary'].includes(appClassOf(p.id))) {
      ok(moves.length === 0, `${p.id}: does not travel, so gets no travel physics`);
    }
    // The parts bin follows the same rules as the add-on list.
    const parts = partsBin(p.id).map((x) => x.id);
    ok(parts.includes('cell'), `${p.id}: can always change its cells`);
    if (!needed(p.id, 'vehicle-dynamics')) {
      ok(!parts.includes('driveMode'), `${p.id}: is not offered a driving mode it has no use for`);
    }
  }
});

test('the desktop studies run on every machine without special-casing', () => {
  for (const p of PRESETS) {
    const d = designOf(p.id);
    const cell = cellById(d.cell.id);
    const topo = buildTopology({ summary: d.pack, partition: d.architecture?.partition, cellForm: cell.form });
    ok(topo?.edges?.length > 0, `${p.id}: has a connection graph`);

    const w = wiringStudy({ topology: topo, packV: d.pack.nominalV, maxTempC: cell.tempDischargeC?.[1] ?? 90 });
    ok(w && w.totals.runsChecked > 0, `${p.id}: every conductor is checked`);
    ok(['workable', 'workable-with-costs', 'not-workable'].includes(w.verdict), `${p.id}: house verdict`);

    const l = lifeCycle({ pack: d.pack, cell, topology: topo, application: p.id, gridGPerKWh: 440 });
    ok(l?.totals.cradleToGateKg > 0, `${p.id}: has a footprint`);
    ok(l.basis?.id, `${p.id}: and a stated basis for comparing its energy`);

    const s = swapPlan({ policy: 'swappable', pack: d.pack, application: p.id });
    ok(s?.handling?.id, `${p.id}: swap handling is decided from the mass`);
  }
});

test('sizing for a job converges, or says it could not', () => {
  // The co-design loop, across everything that travels. The pack carries its
  // own weight, so this is a loop rather than a division — and where it
  // cannot reach the target it has to say so rather than return the nearest
  // thing and let it read as the answer.
  const travellers = PRESETS.filter((p) => needed(p.id, 'route-road'));
  ok(travellers.length >= 4, 'several machines travel by road');
  for (const p of travellers) {
    const base = designOf(p.id);
    const targetKm = Math.max(20, Math.round((base.vehicle?.range ?? 100) * 0.9));
    const s = solveFor({ spec: { application: p.id }, build: designFromSpec, target: { rangeKm: targetKm } });
    ok(s, `${p.id}: solves`);
    ok(s.passes >= 1 && s.passes <= 12, `${p.id}: settles in a sane number of passes`);
    ok(typeof s.meetsTarget === 'boolean', `${p.id}: says plainly whether it reached the target`);
    if (s.meetsTarget === false) {
      ok(s.shortfall && /short/.test(s.shortfall), `${p.id}: a miss is explained, not hidden`);
    }
    // Mass feedback must be real: more energy must cost more mass.
    if (s.trail.length > 1) {
      const first = s.trail[0], last = s.trail[s.trail.length - 1];
      if (last.energyWh > first.energyWh) {
        ok(last.packMassKg >= first.packMassKg, `${p.id}: more energy weighs more, which is the whole reason it loops`);
      }
    }
  }
});

test('a design compared with itself reports nothing, for every machine', () => {
  // The cheapest possible regression check on the comparison engine: if any
  // metric is unstable — a random tiebreak, a timestamp, a float that does
  // not round-trip — this catches it on all sixteen at once.
  for (const p of PRESETS) {
    const a = designFromSpec({ application: p.id });
    const b = designFromSpec({ application: p.id });
    const c = compare(a, b, { label: 'nothing' });
    ok(c.changes.length === 0, `${p.id}: the same spec twice produces the same design`);
    ok(c.verdict === 'no-change', `${p.id}: and the verdict says so`);
  }
});
