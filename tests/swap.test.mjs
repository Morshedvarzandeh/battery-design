// Swappable packs — a policy, not a kind of machine.
//
// The question behind this module was whether swappable batteries need their
// own applications. They do not: swappability is an attribute, and a preset
// per swappable variant would double the picker to express one boolean. These
// tests hold that shape, and the four things choosing it actually changes.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import {
  POLICIES, HANDLING, SWAP_PARTS, LIFT_LIMIT_KG, REPEATED_LIFT_KG,
  fleetRatio, connectorLife, swapPlan,
} from '../js/swap.js';
import { PRESETS } from '../js/presets.js';
import { designFromSpec } from '../js/api.js';

const packOf = (application) => designFromSpec({ application }).pack;

test('it is a policy across every application, not an application of its own', () => {
  // The check that keeps the picker from doubling: no preset exists to
  // express swappability, because it is an axis rather than a machine.
  ok(!PRESETS.some((p) => /swap/i.test(p.id) || /swap/i.test(p.name)),
    'no preset encodes swappability — it would be a second axis in the wrong place');
  // And the same pack answers to every policy.
  const pack = packOf('ebike');
  for (const id of Object.keys(POLICIES)) {
    const r = swapPlan({ policy: id, pack, application: 'ebike' });
    ok(r && r.policy.id === id, `${id} applies to the same design`);
  }
  for (const [id, p] of Object.entries(POLICIES)) {
    ok(p.name && p.what && typeof p.swappable === 'boolean', `${id} is a complete policy`);
  }
});

test('fixed pays none of the swap costs, and says so', () => {
  const r = swapPlan({ policy: 'fixed', pack: packOf('ebike') });
  ok(r.verdict === 'workable' && !r.swappable, 'a fixed pack passes trivially');
  ok(r.parts.length === 0, 'and carries none of the extra parts');
  ok(r.findings.length === 0, 'with nothing to warn about');
  ok(r.assumptions.some((a) => /service/i.test(a)),
    'though it still says a fixed pack has to come out for service one day');
});

test('mass stops being an outcome and becomes a requirement', () => {
  // A 2.4 kg e-bike pack is hand-swappable; a 269 kg EV pack is not, and the
  // handling method is chosen from the mass rather than assumed.
  const light = swapPlan({ policy: 'swappable', pack: packOf('ebike'), application: 'ebike' });
  ok(light.handling.id === 'hand', 'a light pack is carried by hand');
  ok(light.liftable, 'and is within the limit');

  const heavy = swapPlan({ policy: 'swappable', pack: packOf('ev'), application: 'ev' });
  ok(heavy.handling.id === 'machine', 'a 269 kg pack needs a station, not a person');
  ok(/automated station/i.test(heavy.headline), 'and the headline says so readably');

  // Forcing a method the mass cannot support is a hard failure with a way out.
  const forced = swapPlan({ policy: 'swappable', pack: packOf('ev'), handling: 'hand' });
  ok(!forced.liftable && forced.verdict === 'not-workable', 'hand-swapping an EV pack is refused');
  const f = forced.findings.find((x) => x.severity === 'fail');
  ok(/split the pack/i.test(f.detail), 'and the fix — smaller swappable units — is named');

  // The repeated-handling figure is deliberately below the single-lift one.
  ok(REPEATED_LIFT_KG < LIFT_LIMIT_KG, 'repeated swapping is capped below the single-lift recommendation');
  ok(HANDLING.hand.maxKg === REPEATED_LIFT_KG, 'and that is the number hand-swapping uses');
  for (const [id, h] of Object.entries(HANDLING)) {
    ok(h.maxKg > 0 && h.name && h.phrase && h.what, `${id} is a complete handling method`);
  }
});

test('the connector is a wear item, and this is the check nobody runs', () => {
  // Two swaps a day for ten years is 7,300 matings against a 5,000 rating.
  const worn = connectorLife({ swapsPerDay: 2, years: 10, ratedCycles: 5000 });
  ok(!worn.ok, '7,300 matings exceeds a 5,000-cycle connector');
  ok(worn.yearsUntilWorn < 10, `it wears out after ${worn.yearsUntilWorn.toFixed(1)} years`);
  ok(/resistive joint/i.test(worn.why), 'and the answer says what a worn power contact becomes');

  const fine = connectorLife({ swapsPerDay: 1, years: 5, ratedCycles: 10000 });
  ok(fine.ok && fine.verdict === 'workable', 'a gentler duty on a better connector passes');

  // Far past the rating is a refusal, not a warning.
  ok(connectorLife({ swapsPerDay: 6, years: 10, ratedCycles: 5000 }).verdict === 'not-workable',
    'three times the rating is refused outright');
  // A fixed pack never raises it.
  ok(swapPlan({ policy: 'fixed', pack: packOf('ebike') }).connector === null,
    'a fixed pack has no mating-cycle problem');
});

test('the spare is a property of the fleet, not of each machine', () => {
  // The bug this pins: charging one spare PER MACHINE doubles the capital
  // cost of the most expensive part of the machine.
  const one = fleetRatio({ runHours: 8, chargeHours: 2, machines: 1 });
  const many = fleetRatio({ runHours: 8, chargeHours: 2, machines: 12 });
  ok(one.total === 2, 'one machine needs one spare');
  ok(many.total === 15, `twelve machines need three spares, not twelve (${many.total})`);
  ok(many.ratio < one.ratio, 'so the ratio improves with fleet size');
  ok(/Sharing the spares/i.test(many.why), 'and it says that sharing spares is what makes swapping affordable');

  // Faster charging takes packs off the shelf.
  const slow = fleetRatio({ runHours: 4, chargeHours: 4, machines: 10 });
  const fast = fleetRatio({ runHours: 4, chargeHours: 1, machines: 10 });
  ok(fast.total < slow.total, 'halving the charge time shrinks the fleet');

  // Unanswerable rather than guessed.
  const unknown = fleetRatio({});
  ok(unknown.ratio === null && /cannot be answered/i.test(unknown.why),
    'without run and charge hours the economics are stated as unanswered');
});

test('hot-swap adds the parts that breaking DC under load demands', () => {
  const pack = packOf('robot');
  const cold = swapPlan({ policy: 'swappable', pack });
  const hot = swapPlan({ policy: 'hot-swappable', pack });
  ok(hot.parts.length > cold.parts.length, 'hot-swap needs more than cold');
  const ids = hot.parts.map((p) => p.id);
  ok(ids.includes('precharge') && ids.includes('ride-through'),
    'specifically a load-break path and something to carry the load across the gap');
  ok(!cold.parts.some((p) => p.live), 'and a cold swap carries neither');
  ok(hot.findings.some((f) => /DC under load/i.test(f.title)), 'with the arc problem raised explicitly');
  const arc = hot.findings.find((f) => /DC under load/i.test(f.title));
  ok(/does not self-extinguish/i.test(arc.detail), 'naming why DC is harder than AC');
  for (const p of SWAP_PARTS) {
    ok(p.name && p.why && typeof p.live === 'boolean', `${p.id} is a complete part`);
  }
});

test('a pack off the machine is its own system, and that is always said', () => {
  for (const app of ['ebike', 'robot', 'escooter']) {
    const r = swapPlan({ policy: 'swappable', pack: packOf(app), application: app });
    const alone = r.findings.find((f) => /its own system/i.test(f.title));
    ok(alone, `${app}: the standalone case is raised`);
    ok(/No host BMS/i.test(alone.detail), 'naming what the machine was providing');
    ok(r.parts.some((p) => p.id === 'standalone-bms') && r.parts.some((p) => p.id === 'pack-fuse'),
      'and the parts that replace it are in the list');
  }
});

test('it states what it does not cost, and the approval question it cannot answer', () => {
  const r = swapPlan({ policy: 'swappable', pack: packOf('ev'), application: 'ev' });
  ok(r.assumptions.some((a) => /not costed here/i.test(a)),
    'swap infrastructure is excluded, and says so');
  ok(r.assumptions.some((a) => /type-approval/i.test(a)),
    'and a road vehicle is told its removable pack is a different approval case');
  ok(!swapPlan({ policy: 'swappable', pack: packOf('ebike'), application: 'ebike' })
    .assumptions.some((a) => /type-approval/i.test(a)),
    'while an e-bike is not told something that does not apply to it');
  ok(swapPlan({ policy: 'swappable', pack: null }) === null, 'no pack, no plan');
  ok(['workable', 'workable-with-costs', 'not-workable'].includes(r.verdict), 'house vocabulary');
});
