// garage.js — swap a part, feel the difference, understand why.
//
// The tool answers one design at a time. That is the right shape for a report
// and the wrong shape for the way people actually learn a machine, which is
// by changing one thing and seeing what moved. A racing game gets this right
// and an engineering tool usually does not: you fit the bigger turbo, the
// numbers change, and you understand the trade in about four seconds.
//
// What a game gets WRONG, and what this must not copy, is that the number only
// ever goes up. Fit the bigger part, go faster, no argument. That is a toy,
// and an engineer can smell it immediately.
//
// So every swap here reports three things, and the third is the one that makes
// it engineering:
//
//   WHAT IT BOUGHT   more range, more power, less mass
//   WHAT IT COST     money, weight, volume, charge time — there is always one
//   WHAT IT BROKE    the findings that appeared. Fitting a denser cell can
//                    take the pack outside its temperature window, and a
//                    slider that hides that has lied to you.
//
// That third category is why this reads the audit rather than only the
// headline numbers. A swap that improves every number and introduces a safety
// failure is not an improvement, and the tool already knows it — it just had
// no way to say "that change did this".
//
// Nothing here computes physics. It calls designFromSpec twice and compares,
// so the garage can never disagree with the report: they are the same answer.
//
// Pure data + math, no DOM.

import { CELLS, cellById } from './cells.js';
import { needed } from './knowledge.js';
import { TERRAINS, terrainIds } from './terrain.js';
import { DRIVING_MODES } from './vehicle.js';
import { COMPONENTS, componentsFor } from './components.js';

// Which way is better. Some of these are obvious and some are not — a heavier
// pack is worse, but more mass is exactly what a marine keel wants — so the
// direction is declared rather than guessed from the sign.
const BETTER = { up: 'up', down: 'down', neutral: 'neutral' };

// What the customer actually feels, in the order they feel it. Deliberately
// not every field the design produces: a garage that lists ninety numbers is
// a spreadsheet, and the whole point is that four seconds is enough.
export const METRICS = [
  { id: 'rangeKm', label: 'Range', unit: 'km', better: BETTER.up, group: 'what it does', get: (d) => (typeof d.vehicle?.range === 'number' ? d.vehicle.range : d.vehicle?.range?.km) ?? null },
  { id: 'whPerKm', label: 'Consumption', unit: 'Wh/km', better: BETTER.down, group: 'what it does', get: (d) => d.vehicle?.drive?.whPerKm ?? null },
  { id: 'energyWh', label: 'Energy', unit: 'Wh', better: BETTER.up, group: 'what it does', get: (d) => d.pack?.energyWh ?? null },
  { id: 'contPowerW', label: 'Continuous power', unit: 'W', better: BETTER.up, group: 'what it does', get: (d) => d.pack?.maxContPowerW ?? null },

  { id: 'massKg', label: 'Pack mass', unit: 'kg', better: BETTER.down, group: 'what it costs', get: (d) => d.pack?.massKg ?? null },
  { id: 'volumeL', label: 'Volume', unit: 'L', better: BETTER.down, group: 'what it costs', get: (d) => d.pack?.volumeL ?? null },
  { id: 'upfrontUSD', label: 'Upfront cost', unit: 'USD', better: BETTER.down, group: 'what it costs', get: (d) => d.cost?.upfrontUSD ?? null },
  { id: 'usdPerKWhDelivered', label: 'Cost per kWh delivered', unit: 'USD/kWh', better: BETTER.down, group: 'what it costs', get: (d) => d.cost?.usdPerKWhDelivered ?? null },

  { id: 'whPerKg', label: 'Energy density', unit: 'Wh/kg', better: BETTER.up, group: 'how good it is', get: (d) => d.pack?.whPerKg ?? null },
  { id: 'cellCount', label: 'Cell count', unit: 'cells', better: BETTER.down, group: 'how good it is', get: (d) => d.pack?.cellCount ?? null },
];

/**
 * The parts bin: what this machine lets you change.
 *
 * Filtered by the knowledge graph, so a boat is never offered a set of tyres
 * and a wearable is never offered a driving mode. The graph already decides
 * what each application needs; the garage reads it rather than inventing a
 * second opinion.
 */
export function partsBin(applicationId, { cellLimit = 8 } = {}) {
  const parts = [];

  // The cell is the biggest lever there is, so it leads. Only cells that can
  // answer the whole question — a price AND a cycle life — because a swap
  // that turns the economics null is not a comparison, it is a hole.
  const usable = CELLS.filter((c) => c.priceUSD != null && c.cycleLife != null);
  parts.push({
    id: 'cell', label: 'Cell', kind: 'choice',
    what: 'The single biggest lever. Chemistry sets the energy density, the cycle life and most of the cost — everything else here is a smaller adjustment on top of it.',
    options: usable.slice(0, cellLimit).map((c) => ({
      value: c.id,
      label: `${c.name} — ${c.chemistry} ${c.capacityAh} Ah`,
      hint: `${(c.nominalV * c.capacityAh).toFixed(1)} Wh, ${c.massG} g, ${c.cycleLife} cycles`,
    })),
  });

  parts.push({
    id: 'p', label: 'Cells in parallel', kind: 'number',
    what: 'More parallel is more energy and more mass, in almost exact proportion. The interesting part is what it does to everything else: current per cell falls, so the pack runs cooler and lives longer.',
    min: 1, max: 200, step: 1,
  });
  parts.push({
    id: 's', label: 'Cells in series', kind: 'number',
    what: 'Voltage. Higher means less current for the same power, which means thinner conductors and less heat — and above 60 V DC it means isolation monitoring, HVIL and a different rulebook.',
    min: 1, max: 200, step: 1,
  });

  // Road-only parts, gated by the graph rather than by a list of application
  // ids that would drift the moment a new machine is added.
  if (needed(applicationId, 'terrain')) {
    parts.push({
      id: 'terrain', label: 'Surface', kind: 'choice',
      what: 'What the wheels are on. Off the road this is the largest single term in the whole energy budget — sand is fifteen times the rolling resistance of tarmac.',
      options: terrainIds().map((t) => ({ value: t, label: TERRAINS[t].name, hint: `Crr ${TERRAINS[t].crr}` })),
    });
  }
  if (needed(applicationId, 'vehicle-dynamics')) {
    parts.push({
      id: 'driveMode', label: 'How it is driven', kind: 'choice',
      what: 'The driver is a component. Eco and Sport are the same machine asking for different things, and the gap between them is usually bigger than a cell change.',
      options: (DRIVING_MODES || []).map((m) => ({ value: m.id, label: m.name, hint: m.what || '' })),
    });
    parts.push({
      id: 'mass', label: 'Vehicle mass', kind: 'number',
      what: 'What the pack has to carry, before it carries itself. Every kilogram is paid for on every hill and every acceleration.',
      min: 5, max: 20000, step: 10, unit: 'kg',
    });
    parts.push({
      id: 'gradePct', label: 'Gradient', kind: 'number',
      what: 'The hill. A climb is paid for in full and only part of it comes back down the other side.',
      min: -15, max: 15, step: 0.5, unit: '%',
    });
  }
  // The hardware shelf. These are the 44 real parts the components database
  // already carries — nine busbars, eight cooling systems, six housings —
  // with their suppliers and their data quality attached. A garage invents
  // nothing: it fits what is on the shelf, and the shelf is the same one the
  // components tab sells from.
  const HARDWARE = [
    ['cooling', 'Cooling system', 'Where the heat goes. The gap between passive convection and a cold plate is the difference between a pack that derates on a hot day and one that does not — and it is the most expensive decision on this list.'],
    ['busbar', 'Busbar / interconnect', 'What carries the current between cells. Nickel welds to steel cans and conducts badly; copper conducts well and will not weld to them. Almost every pack is a compromise between those two facts.'],
    ['housing', 'Enclosure', 'What holds it together and what it weighs. Also the crash structure, the ingress barrier and usually the bonding path, whether or not anyone designed it as one.'],
    ['tim', 'Thermal interface', 'The layer between the cells and whatever removes their heat. Thin, unglamorous, and it decides whether the cooling system you paid for actually reaches the cells.'],
    ['spacer', 'Cell holder / spacer', 'What positions the cells and keeps them apart. Sets the spacing that the runaway study cares about, and the airflow that the cooling depends on.'],
    ['vent', 'Vent path', 'Where the gas goes when a cell lets go. Not optional — the only question is whether it was designed or improvised.'],
  ];
  for (const [cat, label, what] of HARDWARE) {
    const list = COMPONENTS[cat] || [];
    if (!list.length) continue;
    parts.push({
      id: `component:${cat}`, label, kind: 'choice', category: cat,
      what,
      options: list.map((c) => ({
        value: c.id, label: c.name,
        hint: [c.material, c.dataQuality].filter(Boolean).join(' · ') || c.kind || '',
      })),
    });
  }

  return parts;
}

/** Turn a swap into a spec the engine understands. */
export function applySwap(spec, { part, value }) {
  const next = { ...spec };
  if (part === 'mass') next.vehicle = { ...(spec.vehicle || {}), curbKg: value };
  else if (part === 'terrain') next.terrain = value;             // read by the caller's vehicle build
  else next[part] = value;
  return next;
}

const pct = (before, after) => (before ? ((after - before) / Math.abs(before)) * 100 : null);

/**
 * What changed, and whether it was worth it.
 *
 * Findings are diffed as well as numbers, because that is the difference
 * between a garage and a slider. A swap that improves every figure and
 * introduces a safety failure is not an improvement, and only the findings
 * know that.
 */
export function compare(before, after, { label = 'this change' } = {}) {
  if (!before || !after) return null;

  const changes = METRICS.map((m) => {
    const b = m.get(before), a = m.get(after);
    if (b == null || a == null) return null;
    const delta = a - b;
    if (Math.abs(delta) < Math.abs(b) * 1e-6) return null;         // unchanged
    const improved = m.better === 'neutral' ? null
      : m.better === 'up' ? delta > 0 : delta < 0;
    return { ...m, before: b, after: a, delta, pct: pct(b, a), improved };
  }).filter(Boolean);

  // The findings each design produced, keyed so they can be set-differenced.
  const key = (f) => `${f.severity}|${f.title}`;
  const bMap = new Map((before.findings || []).map((f) => [key(f), f]));
  const aMap = new Map((after.findings || []).map((f) => [key(f), f]));
  const appeared = [...aMap.values()].filter((f) => !bMap.has(key(f)));
  const resolved = [...bMap.values()].filter((f) => !aMap.has(key(f)));
  const brokeIt = appeared.filter((f) => f.severity === 'fail');
  const fixedIt = resolved.filter((f) => f.severity === 'fail');

  const bought = changes.filter((c) => c.improved === true);
  const cost = changes.filter((c) => c.improved === false);

  // The verdict is deliberately not a score. A number would invite optimising
  // it, and the whole point is that the customer weighs the trade themselves —
  // they know whether mass or money matters more on their machine, and the
  // tool does not.
  const verdict = brokeIt.length ? 'broke-something'
    : !changes.length ? 'no-change'
      : cost.length === 0 ? 'free-win'
        : bought.length === 0 ? 'pure-cost' : 'trade';

  const one = (c) => `${c.label.toLowerCase()} ${c.delta > 0 ? '+' : ''}${c.delta.toFixed(c.unit === 'cells' ? 0 : 1)} ${c.unit}`;

  // A swap the engine could not honour — an unknown cell, a clamped S/P —
  // produces a design that is not the one asked for. Without this the garage
  // compares a design against itself and reports "changed nothing", which
  // reads as "that part makes no difference" rather than "that part was
  // never fitted".
  const notFitted = (after.warnings || []).filter((w) => !(before.warnings || []).includes(w));

  return {
    label, verdict, changes, bought, cost, notFitted,
    findings: { appeared, resolved, brokeIt, fixedIt },
    headline: notFitted.length
      ? `${label} was not fitted as asked — ${notFitted[0]}`
      : verdict === 'broke-something'
      ? `${label} breaks something: ${brokeIt[0].title.toLowerCase()}. Whatever it bought, this has to be answered first.`
      : verdict === 'no-change' ? `${label} changed nothing measurable.`
        : verdict === 'free-win' ? `${label} is free: ${bought.slice(0, 2).map(one).join(', ')}, and nothing got worse.`
          : verdict === 'pure-cost' ? `${label} costs ${cost.slice(0, 2).map(one).join(', ')} and buys nothing measurable here.`
            : `${label}: ${bought.slice(0, 2).map(one).join(', ')} — paid for with ${cost.slice(0, 2).map(one).join(', ')}.`,
    // The sentence that keeps it honest. A free win almost always means the
    // cost is real but not on this list.
    caveat: verdict === 'free-win'
      ? 'Nothing on this list got worse, which usually means the cost is somewhere it does not measure — availability, tooling, a supplier who will not quote one reel. Check before believing it.'
      : fixedIt.length ? `It also cleared ${fixedIt.length} failure${fixedIt.length === 1 ? '' : 's'} the previous design had.` : null,
  };
}

/**
 * Try every option for one part and rank them.
 *
 * This is the garage wall: fit each part in turn and see the whole shelf at
 * once. `build` is the caller's design function so this module stays free of
 * the engine and cannot drift from it.
 */
export function tryAll({ spec, part, options, build, rankBy = 'rangeKm' }) {
  const base = build(spec);
  if (!base) return null;
  const metric = METRICS.find((m) => m.id === rankBy) || METRICS[0];
  const rows = options.map((opt) => {
    let design;
    try { design = build(applySwap(spec, { part, value: opt.value ?? opt })); } catch { return null; }
    if (!design) return null;
    const cmp = compare(base, design, { label: opt.label || String(opt.value ?? opt) });
    return { option: opt, design, comparison: cmp, value: metric.get(design) };
  }).filter(Boolean);

  const sorted = rows.slice().sort((a, b) => {
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return metric.better === 'down' ? a.value - b.value : b.value - a.value;
  });
  return {
    part, rankedBy: metric, base,
    rows: sorted,
    // Anything that breaks the design is called out separately rather than
    // ranked among the winners, because a top-of-the-list option with a
    // safety failure is exactly the trap this module exists to avoid.
    safe: sorted.filter((r) => r.comparison?.verdict !== 'broke-something'),
    broken: sorted.filter((r) => r.comparison?.verdict === 'broke-something'),
  };
}

// ---------------------------------------------------------------------------
// Co-design: hold the REQUIREMENT, not the configuration.
//
// Everything above compares like for like — same series, same parallel, one
// part changed. That is the honest answer to "what does this part do", and it
// is the wrong answer to the question people actually have, which is "what
// happens if I build my machine with this instead".
//
// Nobody wants the same pack with a different cell. They want the same JOB
// done with a different cell, and that means re-solving the configuration to
// meet the requirement rather than freezing it.
//
// For anything that moves, that re-solve is a LOOP, not a division. The pack
// carries its own weight: a heavier cell means a heavier pack, which means
// higher consumption, which means more energy is needed for the same range,
// which means a heavier pack again. Size it in one pass and the answer is
// wrong in a direction that always flatters — you compute the energy for the
// old mass and quietly under-build.
//
// So it iterates until the mass stops moving. That convergence is the whole
// point: it is the difference between a configurator and a design tool, and
// it is what "co-design" actually means once you take the word seriously —
// the domains settle against each other rather than one being solved first.
// ---------------------------------------------------------------------------

/**
 * Re-solve the pack so the machine still does its job.
 *
 * `target` is what must be held: a range in km for anything that travels, or
 * an energy in Wh for anything that does not. Returns the converged design
 * plus the trail, because a loop that reports only its answer is asking to be
 * trusted, and the trail is what makes it checkable.
 */
export function solveFor({ spec, build, target, maxPasses = 12, tolerance = 0.005 }) {
  if (!target?.rangeKm && !target?.energyWh) return null;
  // The seed matters. Without an explicit energy the first pass builds the
  // preset's own default, and recording that pass as "energy: null" leaves a
  // trail whose first entry cannot be compared with anything — the loop still
  // converges, but its own record of how it got there starts with a hole.
  let energyWh = target.energyWh ?? spec.energyWh ?? null;
  if (energyWh == null) {
    const seed = build(spec);
    energyWh = seed?.pack?.energyWh ?? null;
    if (energyWh == null) return null;
  }
  const trail = [];
  let design = null, converged = false;

  for (let pass = 0; pass < maxPasses; pass++) {
    design = build({ ...spec, energyWh });
    if (!design) return null;
    if (target.energyWh) { converged = true; trail.push({ pass, energyWh, note: 'energy is the requirement, so one pass settles it' }); break; }

    const whPerKm = design.vehicle?.drive?.whPerKm;
    const dod = design.spec?.dod ?? 0.8;
    if (!(whPerKm > 0)) {
      // No road model — the requirement cannot be a range, and saying so
      // beats returning a number that looks like an answer.
      //
      // The shape matters as much as the message: an early return that omits
      // `passes`, `meetsTarget` and the rest hands the caller an object that
      // looks like the others and answers `undefined` to every question about
      // it. Same fields, honest values.
      return {
        design, converged: false, trail, passes: trail.length,
        achieved: null, wanted: target.rangeKm, missPct: null, meetsTarget: null,
        shortfall: null,
        why: 'This machine has no road-load model, so a range target cannot be solved — it does not travel in a way the tool models. Give an energy target instead.',
      };
    }
    // The energy this range needs AT THE MASS THIS PASS PRODUCED.
    const needWh = (target.rangeKm * whPerKm) / dod;
    const drift = Math.abs(needWh - energyWh) / needWh;
    trail.push({
      pass, energyWh, whPerKm, packMassKg: design.pack?.massKg,
      neededWh: needWh, driftPct: drift * 100,
    });
    if (drift < tolerance) { converged = true; break; }
    // Damped, because the mass feedback can oscillate on light machines where
    // the pack is a large share of the total.
    energyWh = energyWh + (needWh - energyWh) * 0.7;
  }

  // Did it actually GET there? The loop converges on the energy it asked for,
  // and the engine builds the nearest thing an integer series/parallel count
  // can express — which for a 150 Ah blade cell is a coarse grid. Reporting
  // convergence without checking the achieved figure is how a design that
  // misses the target by 12% gets presented as the answer.
  const achievedKm = typeof design.vehicle?.range === 'number' ? design.vehicle.range : design.vehicle?.range?.km;
  const achieved = target.rangeKm ? achievedKm : design.pack?.energyWh;
  const wanted = target.rangeKm ?? target.energyWh;
  const missBy = achieved != null && wanted ? (achieved - wanted) / wanted : null;
  const meetsTarget = missBy != null ? missBy >= -0.02 : null;

  return {
    design, converged, trail,
    passes: trail.length,
    achieved, wanted, missPct: missBy != null ? missBy * 100 : null, meetsTarget,
    shortfall: meetsTarget === false
      ? `This design reaches ${achieved.toFixed(0)}${target.rangeKm ? ' km' : ' Wh'} against a ${wanted}${target.rangeKm ? ' km' : ' Wh'} target — ${Math.abs(missBy * 100).toFixed(0)}% short. `
        + 'Series and parallel counts are whole numbers, so a large-format cell can only be built in coarse steps and the nearest one lands under. Either accept the shortfall, change the cell, or accept the next step up in pack size.'
      : null,
    why: converged
      ? `Settled in ${trail.length} pass${trail.length === 1 ? '' : 'es'}. The pack carries its own weight, so sizing it is a loop rather than a division — a single pass computes the energy for the OLD mass and under-builds.`
      : `Did not settle in ${maxPasses} passes. The pack is a large enough share of the machine that adding energy adds nearly as much consumption, which is itself the finding: this design is close to the point where a bigger battery stops buying range.`,
  };
}

/**
 * The co-design comparison: same job, different part.
 *
 * Reports both answers on purpose. The like-for-like delta is what the part
 * does; the re-solved delta is what the DECISION does, and they can point
 * opposite ways — a denser cell that looks lighter at fixed configuration can
 * end up heavier once the pack is resized to restore the range it lost
 * elsewhere.
 */
export function codesign({ spec, build, swap, target, label = 'this change' }) {
  const before = solveFor({ spec, build, target });
  const after = solveFor({ spec: applySwap(spec, swap), build, target });
  if (!before?.design || !after?.design) return null;

  const naive = compare(build(spec), build(applySwap(spec, swap)), { label });
  const resolved = compare(before.design, after.design, { label });

  // Which numbers reverse once the machine is re-solved. This is the whole
  // reason to show both, so it is computed rather than left to be noticed.
  const flipped = (resolved?.changes || []).filter((r) => {
    const n = naive?.changes?.find((x) => x.id === r.id);
    return n && Math.sign(n.delta) !== Math.sign(r.delta);
  });

  return {
    label, target,
    beforeSolve: before, afterSolve: after,
    naive, resolved, flipped,
    headline: `${label}, with the machine re-solved to the same ${target.rangeKm ? `${target.rangeKm} km` : `${target.energyWh} Wh`}: ${resolved?.headline || 'no measurable change'}`,
    note: flipped.length
      ? `${flipped.length} figure${flipped.length === 1 ? '' : 's'} reverse once the pack is resized for the job — ${flipped.map((f) => f.label.toLowerCase()).join(', ')}. Comparing at a fixed configuration would have pointed the other way.`
      : 'Holding the requirement rather than the configuration did not reverse anything here, so the like-for-like comparison was already telling the truth.',
  };
}
