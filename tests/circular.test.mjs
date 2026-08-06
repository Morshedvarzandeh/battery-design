// The circular economy — what a battery is worth, where, and when.
//
// This module is unusually easy to make dishonest, because everything it
// touches is a number somebody would like to be bigger. So most of these
// tests are about what it refuses to claim: no point estimates, no averaging
// a legal prohibition into a price, no pretending a route that loses money is
// a route that cannot be taken.
//
// The one thing it must get RIGHT rather than merely honest is the ordering:
// which routes exist, which are closed, and where the value drains away. Get
// that wrong and it argues against second life on the strength of a bug,
// which is worse than saying nothing.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  STAGES, PLACES, GATES, TRANSITIONS, PRICE_ANCHOR,
  gatesFor, valueAt, routesFrom, chainFrom, contextFor,
} from '../js/circular.js';
import { designFromSpec } from '../js/api.js';

const EU60 = { stage: 'first-life-eol', energyKWh: 60, placeId: 'eu', sohPct: 78 };

test('the graph is complete and every edge lands somewhere real', () => {
  for (const [id, s] of Object.entries(STAGES)) {
    ok(s.id === id && s.name && s.what && s.valueBasis, `${id} is fully described`);
    ok(Number.isInteger(s.order), `${id} has a place in the life`);
  }
  for (const t of TRANSITIONS) {
    ok(STAGES[t.from], `${t.id}: "from" is a real stage`);
    ok(STAGES[t.to], `${t.id}: "to" is a real stage`);
    ok(t.what && t.costNote, `${t.id}: says what it is and what the cost is for`);
    ok(t.costPerKWh >= 0 && t.days >= 0, `${t.id}: has a cost and a duration`);
    ok(t.keepsFraction >= 0 && t.keepsFraction <= 1, `${t.id}: cannot create energy`);
    ok(STAGES[t.to].order >= STAGES[t.from].order, `${t.id}: does not run life backwards`);
  }
  // A stage nobody can reach and nobody leaves is decoration.
  for (const id of Object.keys(STAGES)) {
    if (id === 'new') continue;
    ok(TRANSITIONS.some((t) => t.to === id) || TRANSITIONS.some((t) => t.from === id),
      `${id} is connected to the rest of the graph`);
  }
});

test('every gate cites the instrument it comes from', () => {
  // The whole value of the regulatory half of this module is that a customer
  // can go and read the rule rather than trusting this file. A gate without a
  // source is an opinion wearing a uniform.
  for (const [id, g] of Object.entries(GATES)) {
    ok(g.id === id, `${id}: id matches its key`);
    ok(g.source && g.source.length > 12, `${id}: names its instrument`);
    ok(['obligation', 'constraint', 'prohibition'].includes(g.kind), `${id}: is one of the three kinds`);
    ok(g.places.every((p) => PLACES[p]), `${id}: applies to real places`);
    ok(g.appliesTo.every((s) => STAGES[s]), `${id}: applies to real stages`);
    if (g.from) ok(/^\d{4}-\d{2}-\d{2}$/.test(g.from), `${id}: a start date is a date`);
  }
});

test('a rule that has not started yet does not apply yet', () => {
  // The battery passport lands in February 2027. A pack being designed today
  // is subject to it and a decision taken in 2025 was not, and getting that
  // backwards is wrong in a way that costs someone a compliance programme.
  const before = gatesFor('repurposed', 'eu', { on: '2025-06-01' }).map((g) => g.id);
  const after = gatesFor('repurposed', 'eu', { on: '2027-06-01' }).map((g) => g.id);
  ok(!before.includes('eu-battery-passport'), 'not in force in 2025');
  ok(after.includes('eu-battery-passport'), 'in force in 2027');
  ok(GATES['eu-battery-passport'].from === '2027-02-18', 'and the date is the one in the regulation');
  ok(GATES['eu-battery-passport'].ontologyRuleId === 'bd:rule/eu-battery-passport',
    'the lifecycle gate projects the canonical ontology rule instead of owning another date');
  // With no date given, everything on the books is shown — the safe default
  // for someone asking "what will apply to this".
  ok(gatesFor('repurposed', 'eu').map((g) => g.id).includes('eu-battery-passport'), 'undated asks show it');
});

test('value is always a range, never a number', () => {
  // A point estimate for a used battery is a fiction, and the single most
  // misleading thing this module could return.
  for (const stage of Object.keys(STAGES)) {
    const v = valueAt({ stage, energyKWh: 60, placeId: 'eu', sohPct: 78 });
    ok(v, `${stage}: values`);
    ok(v.lowUSD != null && v.highUSD != null, `${stage}: both ends given`);
    ok(v.highUSD >= v.lowUSD, `${stage}: the range is the right way round`);
    ok(v.basis && v.why, `${stage}: says on what basis`);
  }
});

test('state of health scales what is sold as capacity, and not what is sold as metal', () => {
  // The reason a worn-out pack is worth nearly as much to a recycler as a good
  // one — a tired cell holds exactly the same nickel and lithium atoms. It is
  // also why recycling wins by default, which is the finding this module
  // exists to make visible.
  const good = valueAt({ stage: 'repurposed', energyKWh: 60, sohPct: 90 });
  const worn = valueAt({ stage: 'repurposed', energyKWh: 60, sohPct: 60 });
  ok(worn.highUSD < good.highUSD, 'a worn pack is worth less for its capacity');
  ok(good.scaledByHealth && worn.scaledByHealth, 'and says that is why');

  const bmGood = valueAt({ stage: 'black-mass', energyKWh: 60, sohPct: 90 });
  const bmWorn = valueAt({ stage: 'black-mass', energyKWh: 60, sohPct: 60 });
  near(bmWorn.highUSD, bmGood.highUSD, 1e-9, 'black mass does not care how tired the cell is');
  ok(!bmGood.scaledByHealth && /same metal/.test(bmGood.why), 'and explains itself');
});

test('a prohibition closes a route instead of making it expensive', () => {
  // Landfilling waste batteries is banned in the EU. Averaging that into a
  // gate fee would produce a disposal route that merely looks unattractive,
  // and someone would take it.
  const eu = routesFrom(EU60);
  const dispose = eu.routes.find((r) => r.to === 'disposed');
  ok(dispose && !dispose.open, 'disposal is closed in the EU');
  ok(dispose.verdict === 'not-workable', 'and the verdict says so');
  ok(dispose.blockers.some((b) => b.kind === 'not-allowed' && /prohibited/i.test(b.why)),
    'because it is prohibited, not because it is dear');
  ok(dispose.blockers[0].source, 'and the prohibition cites its article');

  const us = routesFrom({ ...EU60, placeId: 'us' });
  ok(us.routes.find((r) => r.to === 'disposed').open, 'the same route is open elsewhere — place is the variable');
});

test('"unproven" means it could not be valued, not that it loses money', () => {
  // Disposal was landing in "unproven" because its net is negative, which read
  // as "we cannot tell" about the one route whose economics are certain: it
  // works, it returns nothing, and you pay.
  const us = routesFrom({ ...EU60, placeId: 'us' });
  const dispose = us.routes.find((r) => r.to === 'disposed');
  ok(dispose.netHighUSD < 0, 'disposal reliably costs money');
  ok(dispose.verdict === 'workable-with-costs', 'which is a cost, not an unknown');
  for (const r of [...routesFrom(EU60).routes, ...us.routes]) {
    if (r.verdict === 'unproven') ok(r.value == null, `${r.id}: unproven only when it could not be valued`);
  }
});

test('the place changes the answer, which is the point of having one', () => {
  const eu = routesFrom(EU60);
  const cn = routesFrom({ ...EU60, placeId: 'cn' });
  const assessEU = eu.routes.find((r) => r.to === 'assessed');
  const assessCN = cn.routes.find((r) => r.to === 'assessed');
  ok(assessCN.costUSD < assessEU.costUSD,
    'grading a pack is labour, so it costs less where labour costs less');
  ok(assessCN.netHighUSD > assessEU.netHighUSD, 'and the same pack is worth more to work on there');
  // Not a token difference: the labour index is the term that decides whether
  // anyone opens the pack at all.
  ok(assessEU.costUSD / assessCN.costUSD > 1.5, 'and the gap is large enough to change the decision');
});

test('a damaged pack cannot be put back into service, and costs more to move', () => {
  // Anything out of a crashed vehicle is damaged-or-suspected-defective, which
  // is P908/P911: individually packed, non-combustible cushioning, no air
  // freight. It is a different shipment, not a surcharge.
  const sound = routesFrom({ ...EU60, transportKm: 300 });
  const hurt = routesFrom({ ...EU60, transportKm: 300, damaged: true });
  const bm = (r) => r.routes.find((x) => x.to === 'black-mass');
  ok(bm(hurt).transportUSD > bm(sound).transportUSD * 2, 'moving it costs multiples, not percent');
  const reuseFromAssessed = routesFrom({ ...EU60, stage: 'assessed', damaged: true })
    .routes.find((r) => r.to === 'reused');
  ok(!reuseFromAssessed.open, 'and it cannot go back into service');
  ok(reuseFromAssessed.blockers.some((b) => /safety case/.test(b.why)),
    'the reason names what is missing rather than just refusing');
});

test('a route too demanding for this pack says which threshold it missed', () => {
  const tired = routesFrom({ ...EU60, stage: 'assessed', sohPct: 55 });
  const reuse = tired.routes.find((r) => r.to === 'reused');
  ok(!reuse.open, 'a 55% pack is not resold as a working pack');
  const b = reuse.blockers.find((x) => x.kind === 'too-worn');
  ok(b && /80%/.test(b.why) && /55%/.test(b.why), 'and the blocker names both numbers');
  ok(/REFERENCES/.test(b.source), 'while admitting the threshold is a planning figure');
});

test('transport is paid once, not on every hop', () => {
  // Charging it per step made a four-stage chain carry four freight bills for
  // a pack that moved once, which turned every long route negative and would
  // have argued against second life on an accounting error.
  const near0 = chainFrom({ ...EU60, transportKm: 0 });
  const far = chainFrom({ ...EU60, transportKm: 400 });
  const oneLeg = 400 * 60 * 0.0025 * PLACES.eu.logisticsIndex;
  const extra = far.totalCostUSD - near0.totalCostUSD;
  ok(far.steps.length > 1, 'the chain has several steps to get this wrong across');
  near(extra, oneLeg, 1, `one freight bill (${Math.round(oneLeg)}), not ${far.steps.length}`);
});

test('the chain shows where the value went, without inventing an ending', () => {
  const ch = chainFrom(EU60);
  ok(ch.steps.length > 0, 'it goes somewhere');
  ok(ch.totalCostUSD > 0 && ch.days > 0, 'and both cost and time accumulate');
  ok(STAGES[ch.endStage], 'ending at a real stage');
  // No cycles: the same stage twice would be a bug presented as a business model.
  const visited = ch.steps.map((s) => s.from);
  ok(new Set(visited).size === visited.length, 'no stage is visited twice');
  // Energy only ever decreases along a chain.
  for (const s of ch.steps) {
    const t = TRANSITIONS.find((x) => x.id === s.route.id);
    ok(t.keepsFraction <= 1, `${s.route.id}: does not make energy on the way`);
  }
});

test('every answer states what it assumed, including that the prices are not quotes', () => {
  const r = routesFrom(EU60);
  ok(r.assumptions.length >= 4, 'the assumptions travel with the answer');
  ok(r.assumptions.some((a) => a.includes(String(PRICE_ANCHOR.newPackUSDPerKWh))),
    'the anchor price is stated, so replacing it is obviously the first thing to do');
  ok(r.assumptions.some((a) => /REFERENCES/.test(a) && /not a quote/.test(a)),
    'and it says plainly that these are planning inputs rather than prices');
  ok(PRICE_ANCHOR.asOf && PRICE_ANCHOR.source, 'the anchor itself is dated and sourced');
  // The house language rule: market answers never say feasible or infeasible.
  const words = JSON.stringify(r);
  ok(!/infeasible/i.test(words), 'never "infeasible"');
  ok(!/\bnot feasible\b/i.test(words), 'nor "not feasible"');
});

test('the context comes from the design, so nothing is asked twice', () => {
  const ev = contextFor(designFromSpec({ application: 'ev', energyWh: 60000, market: 'us' }));
  ok(ev.placeId === 'us', 'the market the design already chose is the place');
  near(ev.energyKWh, designFromSpec({ application: 'ev', energyWh: 60000 }).pack.energyWh / 1000, 1e-6, 'and its energy');
  ok(ev.isSecondLifeHost === false, 'a car is not a second-life destination');
  ok(contextFor(designFromSpec({ application: 'solar-ess' })).isSecondLifeHost === true,
    'a stationary machine is — worth saying while someone is designing one');
  ok(contextFor(null) == null || contextFor({}).placeId, 'and it does not throw on nothing');
});
