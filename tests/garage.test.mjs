// The garage — swap a part, see the trade, not a score.
//
// The failure mode this has to avoid is the one every configurator falls
// into: fit the bigger part, watch the number go up, feel clever. That is a
// toy, and an engineer spots it immediately. So these tests are mostly about
// what the garage REFUSES to do — hide a cost, hide a broken design, or rank
// something dangerous at the top because it scored well on one axis.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { METRICS, partsBin, applySwap, compare, tryAll } from '../js/garage.js';
import { designFromSpec } from '../js/api.js';
import { needed } from '../js/knowledge.js';
import { COMPONENTS } from '../js/components.js';

const EV = { application: 'ev', energyWh: 60000 };

test('the parts bin is filtered by the graph, not by a hardcoded list', () => {
  const ev = partsBin('ev').map((p) => p.id);
  const boat = partsBin('marine').map((p) => p.id);
  const watch = partsBin('wearable').map((p) => p.id);

  ok(ev.includes('terrain') && ev.includes('driveMode'), 'a car gets tyres and a driver');
  ok(!boat.includes('terrain'), 'a boat is never offered a set of tyres');
  ok(!boat.includes('driveMode') && !boat.includes('gradePct'), 'nor a driving mode or a hill');
  ok(!watch.includes('terrain') && !watch.includes('mass'), 'a wearable gets neither');
  // And the reason is an edge, not an if.
  ok(needed('ev', 'terrain') && !needed('marine', 'terrain'), 'the graph is what decides');

  // Everything gets the parts every pack has.
  for (const bin of [ev, boat, watch]) {
    ok(bin.includes('cell') && bin.includes('s') && bin.includes('p'), 'every machine can change its cells');
    ok(bin.includes('component:cooling'), 'and its cooling');
  }
});

test('the shelf is the real components database, not an invented list', () => {
  const bin = partsBin('ev');
  for (const [cat, list] of Object.entries(COMPONENTS)) {
    const part = bin.find((p) => p.id === `component:${cat}`);
    ok(part, `${cat} is fittable`);
    ok(part.options.length === list.length, `${cat}: all ${list.length} parts are on the shelf`);
    for (const o of part.options) {
      ok(list.some((c) => c.id === o.value), `${cat}: "${o.value}" is a real part id`);
      ok(o.label, `${cat}: every option is named`);
    }
    ok(part.what, `${cat}: says what the part is for`);
  }
});

test('every metric declares which way is better, because it is not obvious', () => {
  for (const m of METRICS) {
    ok(m.label && m.unit && m.group, `${m.id} is complete`);
    ok(['up', 'down', 'neutral'].includes(m.better), `${m.id} declares a direction`);
    ok(typeof m.get === 'function', `${m.id} can read a design`);
  }
  // The directions that matter: more range good, more mass bad, more cost bad.
  const dir = Object.fromEntries(METRICS.map((m) => [m.id, m.better]));
  ok(dir.rangeKm === 'up' && dir.energyWh === 'up', 'more range and energy are wins');
  ok(dir.massKg === 'down' && dir.upfrontUSD === 'down' && dir.whPerKm === 'down',
    'mass, money and consumption are costs');
  // The metrics actually read a real design rather than returning null.
  const d = designFromSpec(EV);
  const read = METRICS.filter((m) => m.get(d) != null);
  ok(read.length >= 8, `${read.length} of ${METRICS.length} metrics resolve on a real EV design`);
  ok(METRICS.find((m) => m.id === 'rangeKm').get(d) > 0,
    'range resolves — it is a number on the design, not an object, and reading it wrongly made it vanish');
});

test('a swap reports what it bought AND what it cost', () => {
  const base = designFromSpec(EV);
  const bigger = designFromSpec({ ...EV, p: base.pack.p + 20 });
  const c = compare(base, bigger, { label: 'more parallel' });
  ok(c.bought.length > 0, 'more cells buys something');
  ok(c.cost.length > 0, 'and costs something — a swap with no cost is a toy');
  // Worth stating plainly, because it is the whole argument for this module:
  // simply making the pack BIGGER introduces a safety failure. Twenty more
  // cells in parallel puts 62 neighbours behind an internal short instead of
  // 42. A configurator would have shown more range and stopped there.
  ok(c.findings.brokeIt.length > 0, 'and here it also breaks something, which a slider would never have said');
  ok(c.verdict === 'broke-something', 'so that outranks the trade');

  // A swap that does NOT break anything reports as a plain trade.
  const smaller = designFromSpec({ ...EV, p: Math.max(1, base.pack.p - 10) });
  const t = compare(base, smaller, { label: 'less parallel' });
  ok(t.bought.length > 0 && t.cost.length > 0, 'less parallel is also a trade');
  ok(t.verdict === 'trade' || t.verdict === 'broke-something', 'and is classified as one');
  if (t.verdict === 'trade') ok(/paid for with/.test(t.headline), 'the headline says what paid for it');
  // Every change carries both ends and a direction.
  for (const ch of c.changes) {
    ok(ch.before != null && ch.after != null, `${ch.id}: both values shown`);
    ok(ch.improved === true || ch.improved === false || ch.improved === null, `${ch.id}: a direction`);
    near(ch.delta, ch.after - ch.before, 1e-9, `${ch.id}: the delta is the difference`);
  }
});

test('a swap that breaks the design is called broken, whatever it bought', () => {
  // The trap: an option that wins on the headline metric and introduces a
  // safety failure. A configurator ranks it first. This must not.
  const base = designFromSpec(EV);
  const lfp = designFromSpec({ ...EV, cell: 'catl-302ah-lfp' });
  const c = compare(base, lfp, { label: 'big LFP prismatic' });
  ok(c.findings.brokeIt.length > 0, 'this swap introduces failures');
  ok(c.verdict === 'broke-something', 'and the verdict says so');
  ok(/breaks something/.test(c.headline), 'the headline leads with it');
  ok(/has to be answered first/.test(c.headline), 'and says it outranks whatever was gained');
  // It still reports what was fixed, because that is real too.
  ok(c.findings.fixedIt.length > 0, 'while crediting the failures it cleared');
});

test('the wall ranks the safe options and quarantines the broken ones', () => {
  const bin = partsBin('ev');
  const cellPart = bin.find((p) => p.id === 'cell');
  const wall = tryAll({ spec: EV, part: 'cell', options: cellPart.options, build: designFromSpec, rankBy: 'rangeKm' });
  ok(wall.rows.length === cellPart.options.length, 'every option on the shelf is tried');
  ok(wall.safe.length + wall.broken.length === wall.rows.length, 'each one lands in exactly one bucket');
  ok(wall.broken.length > 0, 'and on this design most of them break it');
  // The important one: nothing broken appears among the ranked winners, even
  // though a broken option has the best range on this pack.
  ok(wall.safe.every((r) => r.comparison.verdict !== 'broke-something'),
    'no broken option is ranked as safe');
  const bestBroken = Math.max(...wall.broken.map((r) => r.value ?? 0));
  const bestSafe = Math.max(...wall.safe.map((r) => r.value ?? 0));
  ok(bestBroken > bestSafe,
    'a broken option genuinely does out-score the safe ones here — which is exactly why it is quarantined rather than ranked');
  // Ranking is by the requested metric, in the right direction.
  for (let i = 1; i < wall.safe.length; i++) {
    ok((wall.safe[i].value ?? -Infinity) <= (wall.safe[i - 1].value ?? Infinity), 'ranked best-first');
  }
});

test('a swap the engine could not honour says so instead of "no change"', () => {
  // Without this the garage compares a design against itself and reports
  // "changed nothing", which reads as "that part makes no difference" rather
  // than "that part was never fitted".
  const base = designFromSpec(EV);
  const bogus = designFromSpec({ ...EV, cell: 'no-such-cell-anywhere' });
  const c = compare(base, bogus, { label: 'a cell that does not exist' });
  ok(c.notFitted.length > 0, 'the unhonoured swap is detected');
  ok(/was not fitted as asked/.test(c.headline), 'and the headline leads with that');
  ok(/Unknown cell/.test(c.headline), 'naming what actually happened');
});

test('a free win is treated with suspicion, because there usually is a cost', () => {
  const base = designFromSpec(EV);
  const same = designFromSpec(EV);
  const c = compare(base, same, { label: 'nothing' });
  ok(c.verdict === 'no-change' && c.changes.length === 0, 'an identical design changed nothing');
  // The caveat exists so a free win is never taken at face value.
  const fake = compare(
    { pack: { massKg: 100, energyWh: 1000 }, findings: [] },
    { pack: { massKg: 90, energyWh: 1100 }, findings: [] },
    { label: 'lighter and bigger' },
  );
  ok(fake.verdict === 'free-win', 'better on every axis reads as a free win');
  ok(/somewhere it does not measure/.test(fake.caveat),
    'and the caveat says the cost is probably off this list rather than absent');
  ok(compare(null, base) === null && compare(base, null) === null, 'null-safe');
});
