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

import { evaluateRuleApplicability, ruleDefinition } from './ontology-rules.js';

const EU_BATTERY_PASSPORT_RULE = ruleDefinition('eu-battery-passport');
export const EU_BATTERY_PASSPORT_RULE_ID = EU_BATTERY_PASSPORT_RULE.id;
export const EU_BATTERY_PASSPORT_EFFECTIVE_DATE = EU_BATTERY_PASSPORT_RULE.when
  .find((condition) => condition.fact === 'evaluation.date'
    && condition.operator === 'onOrAfter')?.value;
if (!EU_BATTERY_PASSPORT_EFFECTIVE_DATE) {
  throw new Error('The canonical eu-battery-passport ontology rule needs an effective date.');
}

export const EU_DISCLAIMER =
  'Guidance distilled from Regulation (EU) 2023/1542 milestones — not legal advice. '
  + 'Verify dates and applicability against the Official Journal text and your notified body.';

export const EU_TIMELINE = [
  { date: '2025-02', what: 'Carbon footprint declaration mandatory for EV batteries, third-party verified.' },
  { date: '2025-12', what: 'Recycling efficiency ≥65% by mass (overall, a separate metric from per-material recovery).' },
  { date: '2026-02', what: 'Carbon footprint declaration extends to rechargeable industrial batteries.' },
  { date: '2026-08', what: 'Carbon-footprint performance-class labelling begins.' },
  { date: '2027-02', what: 'Battery passport mandatory from 18 February for LMT batteries, EV batteries and industrial batteries >2 kWh: carbon footprint, responsible sourcing, composition, recycled content, state of health and durability. The Regulation requires accessible, current data; it does not prescribe UDS.' },
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

// These product identities are already explicit in the UI, so mapping them
// to EV and LMT does not invent a category. Every other application must
// declare its category: energy alone cannot distinguish portable,
// industrial, SLI and other batteries.
const EV_APPS = new Set(['ev', 'ebus']);
const LMT_APPS = new Set(['ebike', 'escooter']);

export function batteryCategoryForApplication(application, declaredCategory) {
  if (declaredCategory) return declaredCategory;
  if (EV_APPS.has(application)) return 'ev';
  if (LMT_APPS.has(application)) return 'lmt';
  return null;
}

export function euChecks({
  energyWh, application, chemistry, commsPrimary,
  batteryCategory = null, evaluationDate = EU_BATTERY_PASSPORT_EFFECTIVE_DATE,
}) {
  const out = [];
  const push = (severity, title, detail, ontologyRuleId = null) =>
    out.push({
      severity, title, detail, ref: 'Regulation (EU) 2023/1542', category: 'eu',
      ...(ontologyRuleId ? { ontologyRuleId } : {}),
    });
  const kWh = (energyWh ?? 0) / 1000;
  const category = batteryCategoryForApplication(application, batteryCategory);
  const passportRule = EU_BATTERY_PASSPORT_RULE;
  const passportEvaluation = evaluateRuleApplicability('eu-battery-passport', {
    evaluation: { date: evaluationDate },
    battery: {
      ...(category ? { category } : {}),
      energyWh: { value: energyWh ?? 0, unit: 'Wh' },
    },
  });
  const passportApplies = passportEvaluation.applies && passportEvaluation.criteria.length > 0;

  if (passportApplies) {
    push('warn', 'Battery passport applies (from 18 February 2027)',
      `${category === 'ev' ? 'EV battery' : category === 'lmt' ? 'Light-means-of-transport battery' : `Declared industrial battery over 2 kWh (${kWh.toFixed(1)} kWh)`} — the passport must carry the applicable identity, carbon-footprint, sourcing, composition, recycled-content, state-of-health and durability information.`,
      passportRule.id);
    const udsReady = /UDS|ISO 14229/i.test(commsPrimary || '');
    push('info', 'Accessible current SoH data is required; UDS is only one implementation option',
      udsReady
        ? 'The selected communication stack includes UDS (ISO 14229), which can implement the access path. The Regulation does not mandate UDS, and naming it does not by itself prove Article 14/77 data, access-control, update or interoperability requirements.'
        : `No UDS stack is declared, and none is legally required. Select and document a suitable interface such as ${passportRule.implementationOptions.filter((option) => option !== 'uds').join(' or ')}; verify the Article 14/77 data and access controls.`,
      passportRule.id);
  } else if (passportEvaluation.missingFactOutcome === 'review' || !category) {
    push('warn', 'Battery passport applicability needs a declared battery category',
      `The application “${application || 'custom'}” is not unambiguously an EV or LMT battery. Do not infer “industrial” from ${kWh.toFixed(1)} kWh alone; declare the Regulation (EU) 2023/1542 category, then evaluate its criteria.`,
      passportRule.id);
  } else if (!passportEvaluation.applies) {
    push('info', 'Battery passport date gate not yet active for this assessment',
      `The assessment date ${evaluationDate} is before 18 February 2027. Keep the category and interface decision in the release plan.`,
      passportRule.id);
  } else {
    push('info', 'Battery passport does not apply to the declared category and energy at this gate',
      `Declared category “${category}” at ${kWh.toFixed(1)} kWh does not match the ontology rule's EV, LMT or >2 kWh industrial criterion. Re-evaluate if the category or energy changes.`,
      passportRule.id);
  }

  push(category === 'ev' || category === 'industrial' || !category ? 'warn' : 'info', 'Carbon footprint declaration',
    category === 'ev'
      ? 'Mandatory for EV batteries since Feb 2025 (third-party verified); binding maximum thresholds follow Feb 2028.'
      : category === 'industrial'
        ? 'Rechargeable industrial batteries need the verified declaration from Feb 2026; binding thresholds Feb 2028.'
        : category
          ? `The declared “${category}” category does not use the industrial/EV statement shown for other categories; verify its applicable carbon-footprint provisions directly.`
          : 'Battery category is unresolved, so the software cannot select the EV or industrial declaration track.');
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
