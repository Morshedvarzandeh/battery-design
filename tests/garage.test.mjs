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
  // simply making the pack BIGGER deepens a safety failure. Twenty more cells
  // in parallel puts 62 neighbours behind an internal short instead of 42.
  // The design ALREADY failed that check, so this is not a new failure — and
  // that is precisely why it is easy to miss. A configurator would have shown
  // the extra range and stopped; so would a naive set-difference of the
  // findings, since the check reads "fail" on both sides.
  ok(c.findings.stillFailing.length > 0,
    'a failure that was already there and moved is surfaced, not netted out to nothing');
  ok(c.findings.stillFailing.some((f) => /internal cell short/i.test(f.title)),
    'and it is the internal short — 42 neighbours became 62');
  ok(c.findings.stillFailing.every((f) => f.was && f.was !== f.detail),
    'both readings are kept, so the customer can see which way it moved');
  ok(/already had moved with this change/.test(c.caveat),
    'the caveat says so rather than letting the extra range stand alone');
  ok(c.findings.brokeIt.length === 0,
    'and it is NOT reported as a new break, because the design was already failing that check');

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

test('fitting a part off the hardware shelf actually changes the design', () => {
  // The bug this exists to prevent: applySwap wrote the choice to a spec key
  // named "component:cooling" that designFromSpec never read, so all eight
  // cooling systems reported "no measurable change". A shelf of parts that
  // do nothing is worse than no shelf — it looks live and is not.
  const spec = { application: 'ev', energyWh: 60000 };
  const next = applySwap(spec, { part: 'component:cooling', value: 'bottom-cold-plate' });
  ok(next.components?.cooling === 'bottom-cold-plate', 'the swap lands where the engine reads it');
  ok(next['component:cooling'] === undefined, 'and not in a key nothing looks at');

  const base = designFromSpec(spec);
  const after = designFromSpec(next);
  ok(after.spec.resolved.components.cooling === 'bottom-cold-plate', 'the engine fitted what was asked');
  const c = compare(base, after, { label: 'cold plate' });
  ok(c.changes.length > 0, 'and the numbers moved');
  // Specifically: a cold plate is 8 kg/m2 of aluminium and 10 mm of height.
  ok(after.pack.massKg > base.pack.massKg, 'a cold plate weighs something');
  ok(after.pack.dims.z > base.pack.dims.z, 'and takes space out of the envelope, before the box is sized');
});

test('every option on every hardware shelf either changes something or says why not', () => {
  // Swept rather than sampled, because the failure was silent and uniform:
  // one dead spec key killed all six categories at once.
  const spec = { application: 'ev', energyWh: 60000 };
  const base = designFromSpec(spec);
  let moved = 0, refused = 0;
  for (const part of partsBin('ev').filter((x) => x.id.startsWith('component:'))) {
    for (const opt of part.options) {
      const d = designFromSpec(applySwap(spec, { part: part.id, value: opt.value }));
      const c = compare(base, d, { label: opt.label });
      const fittedId = d.spec.resolved.components[part.category];
      if (fittedId === opt.value) {
        // Fitted as asked. It may legitimately change nothing measurable —
        // a vent has no mass model — but it must be recorded as fitted.
        moved += c.changes.length > 0 ? 1 : 0;
      } else {
        ok(c.notFitted.length > 0,
          `${opt.value}: was not fitted, and the garage says so rather than reporting "no change"`);
        refused += 1;
      }
    }
  }
  ok(moved >= 10, `${moved} options measurably change the design — the shelf is live, not decorative`);
  ok(refused > 0, 'and parts that do not suit this pack are refused out loud');
});

test('a part the customer names is fitted, even when the tool would not have chosen it', () => {
  // The substitution rule cuts one way only. Defaults may be corrected;
  // an explicit request never is, because the customer would read the
  // answer as the design they asked for.
  const watch = designFromSpec({ application: 'wearable' });
  ok(watch.spec.resolved.components.cooling === 'passive-air',
    'a wearable is not given a pumped cold plate by default');
  ok(watch.warnings.some((w) => /pumped coolant loop/.test(w)),
    'and the substitution states the rule that fired, not a guess at it');

  const forced = designFromSpec({ application: 'wearable', components: { cooling: 'bottom-cold-plate' } });
  ok(forced.spec.resolved.components.cooling === 'bottom-cold-plate',
    'but asking for it explicitly fits it');
  ok(forced.pack.massKg > watch.pack.massKg, 'and the customer pays for it in mass');
});
