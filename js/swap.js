// swap.js — fixed, swappable, or hot-swappable, as a policy rather than a preset.
//
// The question that prompted this was whether swappable batteries need their
// own applications. They do not, and building it that way would have been the
// expensive mistake: swappability is an ATTRIBUTE of a design, not a kind of
// machine. An e-bike, a forklift, a scooter and a grid cabinet can each be
// fixed or swappable, and a preset per variant would double the picker to
// express one boolean.
//
// So it is a policy that cuts across every application, exactly like the
// feed-back policy — and like that one, choosing it changes four things at
// once, in places the customer would not think to look:
//
//   THE MASS BECOMES A REQUIREMENT. A fixed pack can weigh whatever the
//   machine can carry. A hand-swapped one has to be liftable by a person,
//   repeatedly, by someone who is not being careful. That is a hard ceiling
//   the tool already knows how to apply, and it decides the whole design.
//
//   THE CONNECTOR BECOMES A WEAR ITEM. A fixed pack's connector mates once,
//   in a factory. A swapped one mates every cycle for the life of the fleet.
//   Mating-cycle ratings are finite and rarely checked, and a connector worn
//   past its rating is a resistive joint carrying the full pack current.
//
//   YOU BUY MORE PACKS THAN MACHINES. Swapping only works if a charged pack
//   is waiting, which means the fleet holds spares. That ratio multiplies the
//   capital cost of the single most expensive part of the machine, and it is
//   the number that decides whether swapping pays at all.
//
//   THE PACK HAS TO SURVIVE BEING ALONE. Off the machine it has no host BMS,
//   no host disconnect and no host enclosure. It is handled, dropped, stacked
//   and sometimes shipped. Everything the machine was providing, it now needs
//   for itself.
//
// Pure math, no DOM.

import { appClassOf } from './markets.js';

// The single-person lifting ceiling, from the NIOSH revised lifting equation
// the standards module already cites. 23 kg is the recommended limit under
// IDEAL conditions — level, close to the body, no twisting — and a battery
// bay is rarely ideal, so the practical figure for repeated swapping is well
// under it.
export const LIFT_LIMIT_KG = 23;
export const REPEATED_LIFT_KG = 16;

export const POLICIES = {
  fixed: {
    id: 'fixed', name: 'Fixed', swappable: false,
    what: 'The pack is installed once and serviced in place. Everything else here is a cost you do not pay.',
  },
  swappable: {
    id: 'swappable', name: 'Swappable', swappable: true, live: false,
    what: 'The pack comes out when the machine is off. The common case: e-bike batteries, tool packs, forklift trays, scooter cabinets.',
  },
  'hot-swappable': {
    id: 'hot-swappable', name: 'Hot-swappable', swappable: true, live: true,
    what: 'The pack comes out while the machine is running, which means the machine never stops — and the disconnect happens under load, which is a much harder electrical problem.',
  },
};

// How the pack is moved. This is not a detail: it is the fork in the road,
// because the moment a human cannot lift it you are buying infrastructure.
export const HANDLING = {
  hand: {
    id: 'hand', name: 'By hand', phrase: 'by hand', maxKg: REPEATED_LIFT_KG,
    what: 'One person, repeatedly, in a hurry. The limit is not what someone CAN lift once but what they will lift twenty times a day without injury.',
  },
  'two-person': {
    id: 'two-person', name: 'Two people', phrase: 'by two people', maxKg: 40,
    what: 'Workable and disliked. It needs two people available at the same moment, which in practice means it happens less often than the design assumed.',
  },
  trolley: {
    id: 'trolley', name: 'Trolley or cart', phrase: 'on a trolley', maxKg: 250,
    what: 'A wheeled aid and a level floor. Cheap infrastructure, but it constrains where swapping can happen.',
  },
  machine: {
    id: 'machine', name: 'Automated station', phrase: 'by an automated station', maxKg: 1000,
    what: 'A robot does it. This is what EV battery swapping means, and the station costs far more than the packs it handles.',
  },
};

// What a swappable pack has to carry that a fixed one does not.
export const SWAP_PARTS = [
  { id: 'connector', name: 'High-current blind-mate connector', why: 'Aligns and mates without being looked at, thousands of times, carrying full pack current.', live: false },
  { id: 'latch', name: 'Latch and lock', why: 'Holds the pack against vibration and shock, and stops it being removed by anyone who should not.', live: false },
  { id: 'handle', name: 'Handle or grip', why: 'Decides whether the mass figure above is achievable in practice or only on paper.', live: false },
  { id: 'guides', name: 'Guide rails and alignment features', why: 'A blind-mate connector needs the pack to arrive in the right place. Without guides the connector does the aligning, and wears out doing it.', live: false },
  { id: 'standalone-bms', name: 'Standalone-safe BMS', why: 'Off the machine the pack protects itself: over-discharge lockout, self-monitoring, and a state of charge it can report without a host.', live: false },
  { id: 'pack-fuse', name: 'Pack-side fuse and disconnect', why: 'The machine\'s protection is not there when the pack is out. It needs its own.', live: false },
  { id: 'ingress', name: 'Exposed-contact ingress protection', why: 'Contacts that live outside the machine meet rain, dust and fingers. IP rating and touch-safety are now the pack\'s problem.', live: false },
  { id: 'soc-display', name: 'State-of-charge indicator', why: 'Someone has to know which pack on the shelf is charged, without plugging it into anything.', live: false },
  { id: 'precharge', name: 'Load-break or precharge on the pack side', why: 'Breaking a live DC current arcs, and an arc welds contacts and eats the connector. Hot-swap needs the current broken safely before the contacts part.', live: true },
  { id: 'ride-through', name: 'Machine-side ride-through', why: 'For the machine to keep running through the swap, something else has to carry the load — a second pack, a capacitor bank, or a supply that overlaps.', live: true },
];

/**
 * How many packs per machine.
 *
 * Swapping needs a charged pack waiting. How many spares depends on how long
 * charging takes against how long a pack lasts in service: if a pack runs for
 * four hours and takes two to charge, one spare covers it. The ratio is the
 * multiplier on the most expensive part of the machine, so it is computed
 * rather than assumed.
 */
export function fleetRatio({ runHours = null, chargeHours = null, minimumSpare = 1, machines = 1 }) {
  if (!(runHours > 0) || !(chargeHours > 0)) {
    return {
      ratio: null, packsPerMachine: null, spares: null,
      why: 'Needs how long a pack lasts in service and how long it takes to charge. Without both, the fleet size — and therefore whether swapping pays — cannot be answered.',
    };
  }
  // Packs on the charger per pack in service. The spare count is a property
  // of the FLEET, not of each machine — twelve robots sharing a charging
  // shelf do not each need their own spare, and treating them as if they do
  // doubles the capital cost of the most expensive part of the machine.
  const inCharge = chargeHours / runHours;
  const spares = Math.max(minimumSpare, Math.ceil(machines * inCharge));
  const total = machines + spares;
  const perMachine = total / machines;
  return {
    ratio: perMachine, packsPerMachine: perMachine, spares, total,
    why: `A pack runs ${runHours} h and takes ${chargeHours} h to charge, so ${inCharge.toFixed(1)} packs sit on the charger for every one in service. `
      + `Across ${machines} machine${machines === 1 ? '' : 's'} that is ${spares} spare${spares === 1 ? '' : 's'} — ${total} packs in total, `
      + `${perMachine.toFixed(1)} per machine. Sharing the spares across a bigger fleet is what makes swapping affordable.`,
  };
}

/**
 * Does the connector survive the fleet's life?
 *
 * This is the check nobody runs. A power connector is rated for a mating
 * count, and a swappable pack burns through them at a rate the datasheet
 * author never imagined.
 */
export function connectorLife({ swapsPerDay = 2, years = 10, ratedCycles = 5000 }) {
  const cycles = swapsPerDay * 365 * years;
  const ok = cycles <= ratedCycles;
  return {
    cyclesNeeded: cycles, ratedCycles, ok,
    yearsUntilWorn: swapsPerDay > 0 ? ratedCycles / (swapsPerDay * 365) : null,
    verdict: ok ? 'workable' : cycles <= ratedCycles * 2 ? 'workable-with-costs' : 'not-workable',
    why: ok
      ? `${cycles.toLocaleString()} mating cycles over ${years} years, inside the ${ratedCycles.toLocaleString()} the connector is rated for.`
      : `${cycles.toLocaleString()} mating cycles over ${years} years against a ${ratedCycles.toLocaleString()}-cycle rating — the connector wears out after about `
        + `${(ratedCycles / (swapsPerDay * 365)).toFixed(1)} years. A worn power contact is a resistive joint carrying the full pack current, which heats, which wears it faster. `
        + `Specify a higher-cycle connector, or plan to replace it as a service item rather than discovering it as a failure.`,
  };
}

/**
 * The whole swap policy for a design.
 */
export function swapPlan({
  policy = 'fixed', pack, application = null, handling = null,
  runHours = null, chargeHours = null, machines = 1,
  swapsPerDay = 2, years = 10, connectorRatedCycles = 5000,
}) {
  const pol = POLICIES[policy] || POLICIES.fixed;
  if (!pack) return null;
  const massKg = pack.massKg ?? null;

  if (!pol.swappable) {
    return {
      policy: pol, swappable: false, verdict: 'workable',
      parts: [], massKg, handling: null, fleet: null, connector: null,
      headline: 'Fixed: the pack is installed once and serviced in place. None of the swap costs apply.',
      findings: [],
      assumptions: ['A fixed pack still has to come out for service — leave access for it, or the first repair becomes a strip-down.'],
    };
  }

  // How it gets moved, chosen from the mass if not told.
  const chosen = handling
    ? HANDLING[handling] || HANDLING.hand
    : massKg == null ? HANDLING.hand
      : massKg <= REPEATED_LIFT_KG ? HANDLING.hand
        : massKg <= 40 ? HANDLING['two-person']
          : massKg <= 250 ? HANDLING.trolley : HANDLING.machine;
  const liftable = massKg != null && massKg <= chosen.maxKg;

  const parts = SWAP_PARTS.filter((p) => !p.live || pol.live);
  const fleet = fleetRatio({ runHours, chargeHours, machines });
  const connector = connectorLife({ swapsPerDay, years, ratedCycles: connectorRatedCycles });

  const findings = [];
  if (massKg != null && !liftable) {
    findings.push({
      severity: 'fail', category: 'mechanical',
      title: `${massKg.toFixed(1)} kg is past what ${chosen.name.toLowerCase()} handles`,
      detail: `${chosen.what} At ${massKg.toFixed(1)} kg against a ${chosen.maxKg} kg ceiling this does not work as designed. `
        + `Either split the pack into smaller swappable units — which multiplies the connectors and the latches but keeps the handling free — or accept the next handling method up and its infrastructure.`,
    });
  } else if (massKg != null && chosen.id === 'hand' && massKg > LIFT_LIMIT_KG * 0.6) {
    findings.push({
      severity: 'warn', category: 'mechanical',
      title: `${massKg.toFixed(1)} kg is liftable once and tiring twenty times`,
      detail: `The NIOSH single-lift recommendation is ${LIFT_LIMIT_KG} kg under ideal conditions — level, close to the body, no twisting. A battery bay is rarely ideal and a swap is rarely unhurried, `
        + `so ${REPEATED_LIFT_KG} kg is the figure worth designing to for repeated handling. This pack is above that.`,
    });
  }
  if (!connector.ok) {
    findings.push({
      severity: connector.verdict === 'not-workable' ? 'fail' : 'warn',
      category: 'electrical',
      title: 'The connector wears out before the fleet does',
      detail: connector.why,
    });
  }
  if (fleet.ratio == null) {
    findings.push({
      severity: 'warn', category: 'economics',
      title: 'The fleet ratio is unanswered, so the economics are too',
      detail: `${fleet.why} This is the number that decides whether swapping pays: it multiplies the cost of the most expensive part of the machine, and no other saving is large enough to hide it.`,
    });
  } else if (fleet.ratio > 1.5) {
    findings.push({
      severity: 'warn', category: 'economics',
      title: `You buy ${fleet.ratio.toFixed(1)} packs per machine`,
      detail: `${fleet.why} That multiplies the pack capital cost by ${fleet.ratio.toFixed(1)}× before a single machine moves. `
        + `Faster charging is what shrinks it — every hour off the charge time takes packs off the shelf.`,
    });
  }
  if (pol.live) {
    findings.push({
      severity: 'warn', category: 'safety',
      title: 'Hot-swap means breaking DC under load',
      detail: 'A DC arc does not self-extinguish the way an AC one does: it sustains, welds contacts and erodes the connector. The current has to be brought to zero before the contacts part — '
        + 'a pack-side load-break contactor, or a sequence the machine drives — and something has to carry the load across the gap.',
    });
  }
  // The part people forget: off the machine, the pack is on its own.
  findings.push({
    severity: 'info', category: 'safety',
    title: 'Off the machine the pack is its own system',
    detail: 'No host BMS, no host disconnect, no host enclosure. It is carried, stacked, dropped and sometimes shipped — and a pack with exposed contacts that a person handles is a different safety case from one bolted inside a machine. '
      + 'Everything the machine was providing is now the pack\'s to provide.',
  });

  const fails = findings.filter((f) => f.severity === 'fail').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  const verdict = fails ? 'not-workable' : warns ? 'workable-with-costs' : 'workable';

  return {
    policy: pol, swappable: true, verdict,
    massKg, handling: chosen, liftable, parts, fleet, connector,
    headline: `${pol.name}, moved ${chosen.phrase}${massKg != null ? ` at ${massKg.toFixed(1)} kg` : ''}. `
      + `${parts.length} parts the fixed version does not need`
      + (fleet.ratio != null ? `, and ${fleet.ratio.toFixed(1)} packs bought per machine.` : ', and a fleet ratio that is still unanswered.'),
    findings,
    assumptions: [
      `Single-person handling capped at ${REPEATED_LIFT_KG} kg for repeated swaps, against the NIOSH ${LIFT_LIMIT_KG} kg single-lift recommendation. That recommendation assumes ideal conditions; a battery bay is not one.`,
      `Connector rated at ${connectorRatedCycles.toLocaleString()} mating cycles — a class figure. Use the number from the connector you actually specify, because it is the whole check.`,
      'The fleet ratio assumes a pack is charged and returned to the shelf, not charged in place. Opportunity charging on the machine changes the arithmetic entirely.',
      'Swap infrastructure — chargers, shelving, the station itself for automated swapping — is not costed here. For automated EV swapping the station dominates everything else on this page.',
      ...(application && appClassOf(application) === 'vehicle'
        ? ['A road vehicle whose pack is removable is a different type-approval case from one whose pack is not. Confirm it with your approval authority before designing around it.']
        : []),
    ],
  };
}
