// circular.js — what a battery is worth, at each stage of its life, in each place.
//
// A pack does not have a price. It has a price HERE, at THIS point in its
// life, to SOMEONE — and the three move independently. The same 60 kWh pack
// pulled from a crashed car is worth several thousand euros to a second-life
// integrator two hundred kilometres away, roughly its scrap metal to a
// recycler on another continent, and a disposal LIABILITY to whoever ends up
// holding it if neither will take it. Quoting one number would be the least
// useful thing this module could do.
//
// So it is a graph. Stages are nodes, and moving between them is an edge that
// costs something, takes time, loses some of what you had, and is sometimes
// simply not allowed. Where the value goes is usually the surprise: for most
// packs the answer is that testing and transport eat it, and the module is
// built to make that visible rather than to produce a headline figure.
//
// THREE THINGS THIS REFUSES TO DO, all of which are how this subject is
// usually got wrong:
//
//   IT DOES NOT QUOTE A MARKET PRICE AS FACT. Battery, metal and black-mass
//   prices move by tens of percent within a year. Every money figure here is
//   a class-typical planning input with a stated date, overridable, and
//   registered as an assumption. A tool that returns "$4,180" for a used pack
//   is lying about how well that is known.
//
//   IT DOES NOT TREAT REGULATION AS A COST LINE. In the EU, a route is often
//   not expensive — it is closed, or it is compulsory. Those are gates, and a
//   gate that has been averaged into a price is a gate nobody sees.
//
//   IT DOES NOT ASSUME THE PACK CAN GET THERE. A spent lithium battery is
//   dangerous goods; a damaged or defective one is dangerous goods under much
//   harder packing rules. Transport is frequently the term that decides the
//   answer, and it is the one most models leave out.
//
// Pure data and math. No DOM, no network, no imports beyond the tool's own
// vocabulary.

import { appClassOf } from './markets.js';

// ---------------------------------------------------------------------------
// Stages — where a battery can be in its life
// ---------------------------------------------------------------------------
//
// `value` describes how worth is established at that stage, not what it is:
// the number depends on the place and the pack, and is computed, never stored.
export const STAGES = {
  new: {
    id: 'new', name: 'New', order: 0,
    what: 'Built and sold. The only stage with a published price, and the one every other stage is measured against.',
    valueBasis: 'pack-price',
  },
  'in-service': {
    id: 'in-service', name: 'In service', order: 1,
    what: 'Doing the job it was bought for, and losing capacity while it does. Worth what it would cost to replace, less what has been used up.',
    valueBasis: 'replacement-less-wear',
  },
  'first-life-eol': {
    id: 'first-life-eol', name: 'Retired from first life', order: 2,
    what: 'Off the machine. Usually around 70–80% state of health for a vehicle pack — retired because the range got short, not because the cells stopped working. Worth nothing definite yet, because nobody has measured it.',
    valueBasis: 'unpriced-until-assessed',
  },
  assessed: {
    id: 'assessed', name: 'Tested and graded', order: 3,
    what: 'State of health measured, history known, safety checked. This step costs real money and creates no material value — it converts an unknown into something someone will pay for.',
    valueBasis: 'graded',
  },
  reused: {
    id: 'reused', name: 'Reused as-is', order: 4,
    what: 'Same job, new owner or new host machine. The highest-value outcome because nothing is taken apart, and the rarest, because it needs a buyer who wants exactly this pack.',
    valueBasis: 'used-pack',
  },
  repurposed: {
    id: 'repurposed', name: 'Repurposed (second life)', order: 4,
    what: 'A gentler job than the first one — most often stationary storage, where mass does not matter and the duty is mild. Value is set by what the storage is worth, not by what the pack cost.',
    valueBasis: 'storage-service',
  },
  remanufactured: {
    id: 'remanufactured', name: 'Remanufactured', order: 4,
    what: 'Opened to module or cell level, the weak parts replaced, rebuilt to a specification. Labour-heavy, and the only route that can return a pack to near its original duty.',
    valueBasis: 'refurbished-pack',
  },
  'black-mass': {
    id: 'black-mass', name: 'Black mass', order: 5,
    what: 'Discharged, dismantled and shredded; the electrode powder separated from casings and foils. A traded commodity priced on its nickel, cobalt and lithium content.',
    valueBasis: 'contained-metal',
  },
  'recovered-material': {
    id: 'recovered-material', name: 'Recovered material', order: 6,
    what: 'Refined back to salts or metals that a cell maker can buy. The end of the loop, and the point the recycled-content rules are written about.',
    valueBasis: 'refined-metal',
  },
  disposed: {
    id: 'disposed', name: 'Disposed', order: 7,
    what: 'Landfill or incineration. Not an outcome with a value — an outcome with a bill, and in several places an illegal one.',
    valueBasis: 'liability',
  },
};

// ---------------------------------------------------------------------------
// Places — the "where", which changes almost everything
// ---------------------------------------------------------------------------
//
// The place ids match the tool's existing market vocabulary rather than
// introducing a second one, so a design's chosen market carries through here
// without translation.
//
// `labourIndex` and `logisticsIndex` are RELATIVE multipliers around 1.0, not
// wages or freight rates. Relative is defensible from published cost-of-doing-
// business comparisons; absolute would be a fabricated number with a currency
// symbol in front of it, which reads as authority it has not earned.
export const PLACES = {
  eu: {
    id: 'eu', name: 'European Union',
    labourIndex: 1.0, logisticsIndex: 1.0,
    what: 'The most regulated place to own a used battery, and the most structured. Producers must take them back, recyclers must hit recovery rates, and from 2027 the pack carries a passport that says what is in it.',
    regime: 'eu-battery-regulation',
  },
  us: {
    id: 'us', name: 'United States',
    labourIndex: 1.15, logisticsIndex: 0.9,
    what: 'No single federal battery regulation; a patchwork of state rules over a federal hazardous-waste floor. Second life is commercially driven rather than mandated, and interstate transport is the practical constraint.',
    regime: 'us-state-patchwork',
  },
  cn: {
    id: 'cn', name: 'China',
    labourIndex: 0.45, logisticsIndex: 0.75,
    what: 'The largest installed recycling and repurposing capacity, a traceability platform for EV batteries, and low enough labour cost that manual disassembly — which is what remanufacturing actually needs — is viable at scale.',
    regime: 'cn-traceability',
  },
  intl: {
    id: 'intl', name: 'Elsewhere / cross-border',
    labourIndex: 0.7, logisticsIndex: 1.6,
    what: 'Everywhere without dedicated infrastructure. The pack usually has to leave to be processed, and moving a spent lithium battery across a border is the expensive, slow and legally fussy part.',
    regime: 'basel-and-local',
  },
};

// ---------------------------------------------------------------------------
// The regulatory gates
// ---------------------------------------------------------------------------
//
// These are not prices and must never be averaged into one. A gate is open,
// shut, or compulsory. Each carries its instrument so a customer can go and
// read the thing rather than trusting this file.
//
// Dates matter here more than anywhere else in the tool: several of these
// change on a known day, and an answer that ignores the date is wrong for
// half the packs being designed now.
export const GATES = {
  'eu-recycling-efficiency': {
    id: 'eu-recycling-efficiency', places: ['eu'], appliesTo: ['black-mass', 'recovered-material'],
    kind: 'obligation',
    what: 'A recycler taking lithium-based batteries must recover a minimum share of their mass — 65% by the end of 2025, rising to 70% by the end of 2030.',
    source: 'Regulation (EU) 2023/1542, Annex XII Part B',
  },
  'eu-material-recovery': {
    id: 'eu-material-recovery', places: ['eu'], appliesTo: ['recovered-material'],
    kind: 'obligation',
    what: 'Per-element recovery minimums: lithium 50% by end 2027 and 80% by end 2031; cobalt, copper, nickel and lead 90% by end 2027 and 95% by end 2031.',
    source: 'Regulation (EU) 2023/1542, Annex XII Part C',
  },
  'eu-battery-passport': {
    id: 'eu-battery-passport', places: ['eu'], appliesTo: ['new', 'reused', 'repurposed', 'remanufactured'],
    kind: 'obligation', from: '2027-02-18',
    what: 'From 18 February 2027 every LMT battery, industrial battery over 2 kWh and EV battery placed on the EU market must carry a digital battery passport. Repurposing makes you the one placing it on the market, so the obligation lands on the repurposer, not the original maker.',
    source: 'Regulation (EU) 2023/1542, Articles 77–78',
  },
  'eu-producer-responsibility': {
    id: 'eu-producer-responsibility', places: ['eu'], appliesTo: ['first-life-eol'],
    kind: 'obligation',
    what: 'Extended producer responsibility: whoever put the battery on the market finances its collection and treatment, and take-back must be free to the end user. It is why a spent EU pack has a route at all, and why that route is not the holder\'s bill.',
    source: 'Regulation (EU) 2023/1542, Articles 56–58',
  },
  'transport-dangerous-goods': {
    id: 'transport-dangerous-goods', places: ['eu', 'us', 'cn', 'intl'], appliesTo: ['first-life-eol', 'assessed', 'reused', 'repurposed'],
    kind: 'constraint',
    what: 'A lithium-ion battery in transport is UN 3480 (alone) or UN 3481 (in or with equipment), Class 9 dangerous goods. Packaging, labelling, documentation and a trained shipper are required for every movement.',
    source: 'UN Model Regulations; ADR/IMDG/IATA-DGR as adopted locally',
  },
  'transport-damaged-defective': {
    id: 'transport-damaged-defective', places: ['eu', 'us', 'cn', 'intl'], appliesTo: ['first-life-eol'],
    kind: 'constraint',
    what: 'A battery that is damaged, defective, or suspected of either — which includes anything out of a crashed vehicle — moves under special provisions P908/P911 (LP903/LP904): individually packed against short circuit, in non-combustible cushioning, and forbidden by air. This is several times the cost of a sound pack and is often the term that closes a route.',
    source: 'UN Model Regulations, Special Provisions 376/377; packing instructions P908, P911',
  },
  'basel-transboundary': {
    id: 'basel-transboundary', places: ['intl'], appliesTo: ['first-life-eol', 'black-mass'],
    kind: 'constraint',
    what: 'Waste batteries crossing a border are subject to the Basel Convention\'s prior-informed-consent procedure, which takes months and can be refused. Whether a used-but-working pack counts as waste is the whole argument, and it is decided by the receiving country.',
    source: 'Basel Convention, Annex VIII A1170 / Annex IX B1090',
  },
  'cn-traceability': {
    id: 'cn-traceability', places: ['cn'], appliesTo: ['in-service', 'first-life-eol', 'repurposed'],
    kind: 'obligation',
    what: 'EV batteries are tracked from manufacture through to recycling on a national traceability platform, with the vehicle maker accountable for the pack reaching a licensed processor.',
    source: 'MIIT interim measures on new-energy-vehicle power battery recycling (2018) and the national traceability platform',
  },
  'us-universal-waste': {
    id: 'us-universal-waste', places: ['us'], appliesTo: ['first-life-eol', 'disposed'],
    kind: 'constraint',
    what: 'Lithium batteries are federally regulated as hazardous or universal waste, with handling and storage duties on whoever holds them; several states go considerably further, and a few now mandate take-back.',
    source: '40 CFR Part 273 (universal waste); state EPR statutes',
  },
  'landfill-ban': {
    id: 'landfill-ban', places: ['eu'], appliesTo: ['disposed'],
    kind: 'prohibition',
    what: 'Landfilling or incinerating waste batteries is prohibited in the EU. Disposal is not the cheap fallback it looks like on a spreadsheet — it is not an available option.',
    source: 'Regulation (EU) 2023/1542, Article 61',
  },
};

// ---------------------------------------------------------------------------
// The edges — moving between stages, and what it costs
// ---------------------------------------------------------------------------
//
// Every cost is per kWh of ORIGINAL nameplate energy, because that is the
// number that survives all the way down the chain: capacity is exactly the
// thing that has been changing. All are 2024–2025 class-typical planning
// figures, listed in REFERENCES.md §8 as assumptions, and every one of them
// is meant to be replaced with a quote.
export const TRANSITIONS = [
  {
    id: 'retire', from: 'in-service', to: 'first-life-eol',
    what: 'Taken off the machine.',
    costPerKWh: 4, days: 1, keepsFraction: 1.0,
    costNote: 'Removal labour. Scales with the labour index of the place.',
    scalesWith: 'labour',
  },
  {
    id: 'assess', from: 'first-life-eol', to: 'assessed',
    what: 'Measure what is left: capacity, resistance, cell spread, and whether it is safe.',
    costPerKWh: 12, days: 3, keepsFraction: 1.0,
    costNote: 'The step that creates no material value and decides whether any of the others are possible. A full capacity test takes hours of cycling per pack; the spread between cheap screening and a defensible grade is most of this figure.',
    scalesWith: 'labour',
  },
  {
    id: 'resell', from: 'assessed', to: 'reused',
    what: 'Sold on as a working pack for the same kind of duty.',
    costPerKWh: 3, days: 30, keepsFraction: 1.0,
    costNote: 'Listing, warranty reserve and handling. The long pole is finding the buyer, not the work.',
    scalesWith: 'labour',
    needsSoHPct: 80,
  },
  {
    id: 'repurpose', from: 'assessed', to: 'repurposed',
    what: 'Rebuilt into a gentler application — almost always stationary storage.',
    costPerKWh: 35, days: 45, keepsFraction: 0.92,
    costNote: 'New enclosure, new BMS, new interconnect, integration and certification. The cells are free; everything around them is not, and this is where second-life projects usually discover their economics.',
    scalesWith: 'labour',
    needsSoHPct: 70,
  },
  {
    id: 'remanufacture', from: 'assessed', to: 'remanufactured',
    what: 'Opened up, weak modules replaced, rebuilt to specification.',
    costPerKWh: 60, days: 60, keepsFraction: 0.75,
    costNote: 'Manual disassembly of a pack designed never to be opened, plus replacement cells. Viable where labour is cheap and the pack was designed in modules; close to impossible on a structural pack with the cells glued in.',
    scalesWith: 'labour',
    needsSoHPct: 60,
  },
  {
    id: 'shred', from: 'assessed', to: 'black-mass',
    what: 'Discharged, dismantled, shredded and separated.',
    costPerKWh: 22, days: 14, keepsFraction: 1.0,
    costNote: 'Deep discharge, mechanical processing and the safety infrastructure around both. Gate fees vary enormously with local competition for feedstock.',
    scalesWith: 'labour',
  },
  {
    id: 'shred-direct', from: 'first-life-eol', to: 'black-mass',
    what: 'Straight to the shredder without grading.',
    costPerKWh: 22, days: 14, keepsFraction: 1.0,
    costNote: 'What actually happens to most packs today: assessment costs more than the recycler pays, so nobody assesses. Every second-life route starts by beating this default.',
    scalesWith: 'labour',
  },
  {
    id: 'refine', from: 'black-mass', to: 'recovered-material',
    what: 'Hydrometallurgical or pyrometallurgical refining back to salts and metals.',
    costPerKWh: 18, days: 30, keepsFraction: 1.0,
    costNote: 'Where the per-element recovery rates are set, and therefore where the EU targets bite.',
    scalesWith: 'labour',
  },
  {
    id: 'dispose', from: 'first-life-eol', to: 'disposed',
    what: 'Landfill or incineration.',
    costPerKWh: 8, days: 7, keepsFraction: 0,
    costNote: 'A bill, not a sale. Prohibited outright in the EU and constrained everywhere else.',
    scalesWith: 'labour',
  },
];

// ---------------------------------------------------------------------------
// The value at each stage
// ---------------------------------------------------------------------------
//
// Anchored on ONE published number — the pack price — with every other stage
// expressed as a fraction of it. Anchoring this way is deliberate: pack price
// is the single figure in this whole subject that is surveyed annually and
// widely quoted, so when it moves the rest of the model moves with it instead
// of going quietly stale.
export const PRICE_ANCHOR = {
  newPackUSDPerKWh: 115,
  asOf: '2024',
  source: 'BloombergNEF annual lithium-ion battery price survey, volume-weighted average pack price',
  note: 'A global volume-weighted average across chemistries and applications. A small pack in low volume can be several times this; a large LFP pack from a leading maker is below it. Override it with a real quote before anyone makes a decision on the answer.',
};

// Fractions of new-pack price. Wide ranges because they ARE wide — a narrow
// range here would be the most dishonest thing in the file.
const VALUE_FRACTION = {
  new: [1.0, 1.0],
  'in-service': [0.45, 0.85],
  'first-life-eol': [0.0, 0.0],          // genuinely unpriced until assessed
  assessed: [0.10, 0.30],
  reused: [0.35, 0.60],
  repurposed: [0.25, 0.45],
  remanufactured: [0.45, 0.70],
  'black-mass': [0.06, 0.18],
  'recovered-material': [0.10, 0.25],
  disposed: [0, 0],
};

const clampSoH = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);
const round = (v, dp = 0) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/** Every gate that applies to a stage in a place, with why. */
export function gatesFor(stage, placeId, { on = null } = {}) {
  return Object.values(GATES).filter((g) => {
    if (!g.places.includes(placeId)) return false;
    if (!g.appliesTo.includes(stage)) return false;
    // A rule with a start date does not apply to a decision made before it.
    if (g.from && on && on < g.from) return false;
    return true;
  });
}

/**
 * What a pack is worth at a stage, in a place.
 *
 * Returns a RANGE, always. A point estimate for a used battery is a fiction
 * and the single most misleading thing this module could return.
 */
export function valueAt({ stage, energyKWh, placeId = 'eu', sohPct = null, anchorUSDPerKWh = null }) {
  const s = STAGES[stage];
  // Zero energy is an ANSWER, not a failure to answer. Disposal keeps none of
  // it, and rejecting that as unvaluable made the one route with certain
  // economics — it works, it returns nothing, you pay — report as "we cannot
  // tell". Only nonsense input returns null.
  if (!s || !Number.isFinite(energyKWh) || energyKWh < 0) return null;
  const anchor = anchorUSDPerKWh ?? PRICE_ANCHOR.newPackUSDPerKWh;
  const [lo, hi] = VALUE_FRACTION[stage] || [0, 0];
  const soh = clampSoH(sohPct);

  // Health scales what is left, where health is what is being sold. It does
  // NOT scale the material stages: a shredder is buying nickel and lithium
  // atoms, and a tired cell has exactly as many of those as a fresh one. This
  // is the reason a worn-out pack is worth almost as much to a recycler as a
  // good one, and it is why recycling wins by default.
  const healthScaled = ['in-service', 'assessed', 'reused', 'repurposed', 'remanufactured'].includes(stage);
  const k = healthScaled && soh != null ? soh / 100 : 1;

  return {
    stage: s.id, stageName: s.name, place: placeId,
    lowUSD: round(anchor * energyKWh * lo * k),
    highUSD: round(anchor * energyKWh * hi * k),
    basis: s.valueBasis,
    anchorUSDPerKWh: anchor,
    scaledByHealth: healthScaled && soh != null,
    why: healthScaled
      ? 'What is being sold here is usable capacity, so state of health scales it directly.'
      : 'What is being sold here is contained material, which does not care how tired the cell is — a worn cell holds the same metal as a fresh one.',
  };
}

/**
 * Every route out of a stage, priced, gated and ranked.
 *
 * The output is deliberately not a recommendation. It is the set of things
 * that can be done with this pack, in this place, with what each is worth and
 * what stands in the way — because which one is right depends on who is asking
 * and what they already own, and this module does not know either.
 */
export function routesFrom({
  stage = 'first-life-eol', energyKWh, placeId = 'eu',
  sohPct = null, damaged = false, transportKm = 0,
  anchorUSDPerKWh = null, on = null,
} = {}) {
  const place = PLACES[placeId] || PLACES.eu;
  if (!STAGES[stage] || !(energyKWh > 0)) return null;
  const soh = clampSoH(sohPct);

  const routes = TRANSITIONS.filter((t) => t.from === stage).map((t) => {
    const labour = t.scalesWith === 'labour' ? place.labourIndex : 1;
    const stepUSD = t.costPerKWh * energyKWh * labour;

    // Transport, which most models leave out and which frequently decides the
    // answer. A damaged or defective pack moves under P908/P911 — individually
    // packed, non-combustible cushioning, no air freight — and that is not a
    // small premium on a normal shipment, it is a different shipment.
    const perKWhPerKm = damaged ? 0.010 : 0.0025;
    const transportUSD = transportKm > 0
      ? transportKm * energyKWh * perKWhPerKm * place.logisticsIndex : 0;

    const costUSD = stepUSD + transportUSD;
    const value = valueAt({
      stage: t.to, energyKWh: energyKWh * (t.keepsFraction ?? 1),
      placeId, sohPct: soh, anchorUSDPerKWh,
    });

    // Blockers, in the two flavours that matter. A prohibition closes the
    // route; a health floor means this pack in particular cannot take it.
    const blockers = [];
    const gates = gatesFor(t.to, place.id, { on });
    for (const g of gates) {
      if (g.kind === 'prohibition') blockers.push({ kind: 'not-allowed', gate: g.id, why: g.what, source: g.source });
    }
    if (t.needsSoHPct != null && soh != null && soh < t.needsSoHPct) {
      blockers.push({
        kind: 'too-worn', gate: null,
        why: `This route wants at least ${t.needsSoHPct}% state of health and the pack is at ${soh}%.`,
        source: 'route threshold — a planning figure, see REFERENCES §8',
      });
    }
    if (damaged && ['reused', 'repurposed'].includes(t.to)) {
      blockers.push({
        kind: 'not-allowed', gate: 'transport-damaged-defective',
        why: 'A pack that is damaged or suspected defective cannot be put back into service without a safety case that this tool cannot make for you.',
        source: GATES['transport-damaged-defective'].source,
      });
    }

    const netLow = (value?.lowUSD ?? 0) - costUSD;
    const netHigh = (value?.highUSD ?? 0) - costUSD;

    return {
      id: t.id, to: t.to, toName: STAGES[t.to].name, what: t.what,
      costUSD: round(costUSD), stepUSD: round(stepUSD), transportUSD: round(transportUSD),
      costNote: t.costNote, days: t.days,
      value, netLowUSD: round(netLow), netHighUSD: round(netHigh),
      obligations: gates.filter((g) => g.kind === 'obligation'),
      constraints: gates.filter((g) => g.kind === 'constraint'),
      blockers,
      open: blockers.length === 0,
      // House vocabulary, and never "infeasible". A route that loses money is
      // not impossible — it is one somebody has to want for a reason other
      // than the money, which is frequently the case and is exactly the
      // conversation worth having.
      //
      // "Unproven" means the tool could not value it, and nothing else.
      // Disposal was landing there because its net is negative, which read as
      // "we cannot tell" about the one route whose economics are certain: it
      // works, it returns nothing, and you pay. That is workable-with-costs.
      verdict: blockers.length ? 'not-workable'
        : value == null ? 'unproven'
          : netLow > 0 ? 'workable' : 'workable-with-costs',
    };
  });

  const open = routes.filter((r) => r.open);
  const best = open.slice().sort((a, b) => b.netHighUSD - a.netHighUSD)[0] || null;

  return {
    from: stage, fromName: STAGES[stage].name,
    place: { id: place.id, name: place.name, what: place.what },
    energyKWh, sohPct: soh, damaged, transportKm,
    routes, open, closed: routes.filter((r) => !r.open),
    best,
    // The sentence a person actually reads. It leads with where the value
    // went, because that is nearly always the finding.
    headline: headlineFor(routes, open, best, energyKWh),
    assumptions: [
      `Anchored on a new-pack price of $${anchorUSDPerKWh ?? PRICE_ANCHOR.newPackUSDPerKWh}/kWh (${PRICE_ANCHOR.asOf}, ${PRICE_ANCHOR.source}). Every other figure is a fraction of it, so replacing this one moves the whole answer.`,
      `Costs are per kWh of ORIGINAL nameplate energy, scaled by ${place.name}'s relative labour index of ${place.labourIndex}. Relative, not absolute: a wage figure with a currency symbol would claim precision this does not have.`,
      transportKm > 0
        ? `Transport of ${transportKm} km at ${damaged ? 'damaged/defective' : 'sound-pack'} dangerous-goods rates. The damaged rate is about four times the sound one because P908/P911 is a different shipment, not a surcharge.`
        : 'No transport included. Add the distance to the processor — for a low-value route it is often the term that decides the answer.',
      'Every money figure is a class-typical planning input registered in REFERENCES.md §8, not a quote. Battery and metal prices move tens of percent within a year.',
    ],
  };
}

function headlineFor(routes, open, best, energyKWh) {
  if (!routes.length) return 'Nothing leads out of this stage in the model.';
  if (!open.length) {
    return `Every route out of here is closed for this pack: ${routes[0].blockers[0]?.why ?? 'see the blockers.'}`;
  }
  if (!best) return 'Routes are open but none could be valued.';
  const profitable = open.filter((r) => r.netHighUSD > 0);
  if (!profitable.length) {
    return `No route pays for itself on these figures — the closest is ${best.toName.toLowerCase()}, `
      + `about $${Math.abs(best.netHighUSD)} short at the optimistic end. That is the ordinary outcome for a small pack, `
      + 'and it is why extended producer responsibility exists: somebody has to fund the gap.';
  }
  const secondBest = profitable[1];
  const lead = `${best.toName} is the most valuable route open, at $${best.netLowUSD} to $${best.netHighUSD} net of $${best.costUSD} of work`;
  if (secondBest) {
    return `${lead} — against $${secondBest.netHighUSD} for ${secondBest.toName.toLowerCase()}. `
      + `On a ${energyKWh} kWh pack the gap between them is what a second-life business is made of.`;
  }
  // "Pays for itself" is only true when the pessimistic end is also positive.
  // Saying it of a route that spans zero would turn a coin-flip into a
  // recommendation, which is exactly the overclaim this file exists to avoid.
  return best.netLowUSD > 0
    ? `${lead}. It is the only route here that pays for itself.`
    : `${lead}. It is the only route with any upside, but the range crosses zero — `
      + 'whether it pays depends on numbers this model does not have, so get a quote before committing.';
}

/**
 * The whole chain from a stage to the end, following the best-valued route at
 * each step. Shows where value drains away rather than where it ends up.
 */
export function chainFrom(opts = {}) {
  const steps = [];
  const seen = new Set();
  let stage = opts.stage || 'first-life-eol';
  let energyKWh = opts.energyKWh;
  for (let i = 0; i < 8; i++) {
    if (seen.has(stage)) break;                       // a cycle is a bug, not a business model
    seen.add(stage);
    // Transport is paid ONCE, on the way to the processor — not again on every
    // hop. Charging it per step made a four-stage chain carry four freight
    // bills for a pack that moved once, which quietly turned every long-route
    // outcome negative and would have argued against second life on the
    // strength of an accounting error.
    const r = routesFrom({ ...opts, stage, energyKWh, transportKm: i === 0 ? opts.transportKm : 0 });
    if (!r?.best) break;
    steps.push({ from: stage, route: r.best, headline: r.headline });
    stage = r.best.to;
    const t = TRANSITIONS.find((x) => x.id === r.best.id);
    energyKWh *= t?.keepsFraction ?? 1;
    if (['recovered-material', 'disposed', 'reused'].includes(stage)) break;
  }
  const spent = steps.reduce((a, s) => a + s.route.costUSD, 0);
  const end = steps[steps.length - 1]?.route?.value ?? null;
  return {
    steps, endStage: stage,
    totalCostUSD: round(spent),
    endValueLowUSD: end?.lowUSD ?? null, endValueHighUSD: end?.highUSD ?? null,
    days: steps.reduce((a, s) => a + (s.route.days || 0), 0),
  };
}

/**
 * Which stage a design is at, and which place, from what the tool already
 * knows — so the circular view does not become a form the customer fills in
 * twice.
 */
export function contextFor(design) {
  const market = design?.spec?.resolved?.market || 'eu';
  const app = design?.spec?.resolved?.application;
  return {
    placeId: PLACES[market] ? market : 'intl',
    // A stationary machine's pack IS a second-life destination, which is worth
    // saying out loud when the customer is designing one.
    isSecondLifeHost: appClassOf(app) === 'stationary',
    energyKWh: design?.pack?.energyWh != null ? design.pack.energyWh / 1000 : null,
  };
}
