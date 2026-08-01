// eurules.js — the EU Battery Regulation (EU) 2023/1542, the densest rule
// set a pack design meets on the market: staged deadlines for carbon
// declarations, the battery passport, recycled content and recovery. This
// module carries the timeline and turns the CURRENT design (energy,
// application, chemistry) into "what applies to you" findings.
//
// HONESTY: engineering guidance distilled from the regulation's published
// milestones — not legal advice, and dates/thresholds should be verified
// against the Official Journal text before a compliance commitment. Two
// commonly-conflated metrics are kept strictly apart here: per-material
// RECOVERY targets (from waste) and overall RECYCLING EFFICIENCY (by mass)
// are different numbers with different deadlines.

export const EU_DISCLAIMER =
  'Guidance distilled from Regulation (EU) 2023/1542 milestones — not legal advice. '
  + 'Verify dates and applicability against the Official Journal text and your notified body.';

export const EU_TIMELINE = [
  { date: '2025-02', what: 'Carbon footprint declaration mandatory for EV batteries, third-party verified.' },
  { date: '2025-12', what: 'Recycling efficiency ≥65% by mass (overall, a separate metric from per-material recovery).' },
  { date: '2026-02', what: 'Carbon footprint declaration extends to rechargeable industrial batteries.' },
  { date: '2026-08', what: 'Carbon-footprint performance-class labelling begins.' },
  { date: '2027-02', what: 'Battery passport mandatory for industrial batteries >2 kWh and EV batteries: carbon footprint, responsible sourcing, composition, recycled content, state of health, durability. SoH must be LIVE-accessible over UDS (ISO 14229), not only a stored record.' },
  { date: '2027-12', what: 'Material recovery from waste batteries: Li 50%, Ni 90%, Co 90%, Cu 90%.' },
  { date: '2028-02', what: 'Binding maximum carbon-footprint thresholds take effect.' },
  { date: '2030-12', what: 'Recycling efficiency ≥70% by mass.' },
  { date: '2031-08', what: 'Recycled content minimums in NEW batteries: Li 6%, Ni 6%, Co 16%, Pb 85%.' },
  { date: '2031-12', what: 'Material recovery from waste: Li 80%, Ni 95%, Co 95%, Cu 95%.' },
  { date: '2036-08', what: 'Recycled content minimums rise: Li 12%, Ni 15%, Co 26%, Pb 85%.' },
];

// Which chemistries carry which regulated materials (for the recycled-
// content and recovery rows). All Li-ion carries Li; Ni/Co only in the
// nickel-based families.
const NICKEL_COBALT = new Set(['NMC', 'NCA', 'LCO']);

// Applications the regulation treats as EV vs industrial (stationary /
// industrial mobility). LMT (light means of transport: e-bikes, scooters)
// has its own passport track from Feb 2027 as well.
const EV_APPS = new Set(['ev', 'ebus']);
const LMT_APPS = new Set(['ebike', 'escooter']);

export function euChecks({ energyWh, application, chemistry, commsPrimary }) {
  const out = [];
  const push = (severity, title, detail) =>
    out.push({ severity, title, detail, ref: 'Regulation (EU) 2023/1542', category: 'eu' });
  const kWh = (energyWh ?? 0) / 1000;
  const isEV = EV_APPS.has(application);
  const isLMT = LMT_APPS.has(application);
  const industrialOver2 = !isEV && !isLMT && kWh > 2;

  if (isEV || industrialOver2 || isLMT) {
    push('warn', 'Battery passport applies (from Feb 2027)',
      `${isEV ? 'EV battery' : isLMT ? 'Light-means-of-transport battery' : `Industrial battery over 2 kWh (${kWh.toFixed(1)} kWh)`} — the passport must carry carbon footprint, sourcing, composition, recycled content, state of health and durability.`);
    const udsReady = /UDS|ISO 14229/i.test(commsPrimary || '');
    push(udsReady ? 'pass' : 'warn', 'Live SoH access is a design dependency, not paperwork',
      udsReady
        ? 'The selected communication stack already includes UDS (ISO 14229) — the passport\'s live SoH requirement is covered by design.'
        : 'SoH must be readable live over UDS (ISO 14229) — plan the diagnostic stack now; it cannot be retrofitted into a sealed BMS later.');
  } else {
    push('info', 'Battery passport below threshold',
      `At ${kWh.toFixed(1)} kWh and a non-EV application this pack sits under the >2 kWh industrial passport threshold — recheck if the product grows.`);
  }

  push(isEV ? 'warn' : 'info', 'Carbon footprint declaration',
    isEV
      ? 'Mandatory for EV batteries since Feb 2025 (third-party verified); binding maximum thresholds follow Feb 2028.'
      : 'Rechargeable industrial batteries need the verified declaration from Feb 2026; binding thresholds Feb 2028.');
  push('info', 'Material sourcing is a design parameter under the thresholds',
    'Aluminium alone (0.5–0.7 kg per kWh of pack) can swing the declared footprint several-fold between world-average, renewable-powered and high-recycled stock — pick the housing supplier with the Feb 2028 thresholds in view.');

  if (NICKEL_COBALT.has(chemistry)) {
    push('info', `Recycled content applies to Li, Ni and Co (${chemistry})`,
      'New batteries must contain minimum recycled Li 6% / Ni 6% / Co 16% from Aug 2031, rising to 12/15/26% in 2036 — secure recycled-content supply contracts early; nickel-cobalt scrap currently EARNS ~$2/kg at end of life.');
  } else if (chemistry === 'LFP' || chemistry === 'NAION') {
    push('info', `Recycled content applies mainly to Li (${chemistry})`,
      'No nickel or cobalt content: the 2031/2036 minimums bind on lithium only. Note LFP recycling currently carries a GATE FEE (~$1.50–2.00/kg paid by the holder) — budget end-of-life as a cost, not a credit.');
  }

  push('info', 'Recovery vs recycling efficiency — two different metrics',
    'Per-material RECOVERY from waste (Li 50% by 2027, 80% by 2031) and overall RECYCLING EFFICIENCY by mass (65% by 2025, 70% by 2030) are separate obligations with separate deadlines — public summaries often conflate them.');
  push('info', 'Second life before recycling',
    'Above ~70–75% state of health a pack has resale value (~$45–95 per usable kWh observed); the 4R order — repair, remanufacture, repurpose, recycle — retains value in that order.');
  return out;
}
