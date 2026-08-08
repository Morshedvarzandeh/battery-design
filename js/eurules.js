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

const ARTICLE_7_SOURCE =
  'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02023R1542-20250731';
const ARTICLE_7_RELATIONSHIPS_SOURCE =
  'https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32023R1542';
const DUE_DILIGENCE_AMENDMENT_SOURCE =
  'https://eur-lex.europa.eu/eli/reg/2025/1561/oj/eng';
const EV_METHODOLOGY_DRAFT_SOURCE =
  'https://eur-lex.europa.eu/legal-content/EN/PIN/?uri=intcom%3AAres%282024%293131389';
const DECLARATION_FORMAT_DRAFT_SOURCE =
  'https://eur-lex.europa.eu/legal-content/EN/PIN/?uri=intcom%3AAres%282024%293131449';

const dependentAct = (id, role, initiativeUrl = null) => Object.freeze({
  id,
  role,
  actStatus: 'not-adopted',
  entryIntoForceDate: null,
  legalBasisUrl: ARTICLE_7_SOURCE,
  statusEvidenceUrl: ARTICLE_7_RELATIONSHIPS_SOURCE,
  statusBasis: 'official-register review found no adopted act listed',
  ...(initiativeUrl ? { initiativeUrl } : {}),
  checkedAt: '2026-08-08',
});

// A draft or an adoption deadline is not an entry-into-force date. These
// records intentionally fail closed until an adopted act and its exact ELI
// are recorded. The Article 7 resolver below never substitutes a nominal or
// Commission adoption deadline for a missing dependent-act date.
export const EU_DEPENDENT_ACTS = Object.freeze({
  'art7-1-ev-methodology': dependentAct(
    'art7-1-ev-methodology', 'EV carbon-footprint calculation and verification methodology',
    EV_METHODOLOGY_DRAFT_SOURCE,
  ),
  'art7-1-ev-declaration-format': dependentAct(
    'art7-1-ev-declaration-format', 'EV carbon-footprint declaration format',
    DECLARATION_FORMAT_DRAFT_SOURCE,
  ),
  'art7-1-industrial-methodology': dependentAct(
    'art7-1-industrial-methodology', 'industrial-battery carbon-footprint calculation and verification methodology',
  ),
  'art7-1-industrial-declaration-format': dependentAct(
    'art7-1-industrial-declaration-format', 'industrial-battery carbon-footprint declaration format',
    DECLARATION_FORMAT_DRAFT_SOURCE,
  ),
  'art7-2-ev-performance-classes': dependentAct(
    'art7-2-ev-performance-classes', 'EV carbon-footprint performance classes',
  ),
  'art7-2-ev-label-format': dependentAct(
    'art7-2-ev-label-format', 'EV performance-class label and declaration format',
  ),
  'art7-2-industrial-performance-classes': dependentAct(
    'art7-2-industrial-performance-classes', 'industrial-battery carbon-footprint performance classes',
  ),
  'art7-2-industrial-label-format': dependentAct(
    'art7-2-industrial-label-format', 'industrial-battery performance-class label and declaration format',
  ),
  'art7-3-ev-threshold': dependentAct(
    'art7-3-ev-threshold', 'EV maximum life-cycle carbon-footprint threshold',
  ),
  'art7-3-industrial-threshold': dependentAct(
    'art7-3-industrial-threshold', 'industrial-battery maximum life-cycle carbon-footprint threshold',
  ),
});

const milestone = ({ dependencies = [], ...value }) => Object.freeze({
  ...value,
  dependencies: Object.freeze(dependencies.map((dependency) => Object.freeze({ ...dependency }))),
  source: Object.freeze({ ...value.source }),
});

// Current modeled scope: EV batteries and rechargeable industrial batteries
// >2 kWh except those with exclusively external storage. The industrial track
// is selected only when that storage-mode fact is explicit; the canonical
// DesignSpec does not carry it yet and therefore remains review-only. LMT and
// exclusively-external-storage tracks are follow-on work rather than being
// silently forced through the earlier industrial dates.
export const EU_LEGAL_MILESTONES = Object.freeze({
  'carbon-declaration-ev': milestone({
    id: 'carbon-declaration-ev', topic: 'carbon-footprint', stage: 'declaration',
    scope: 'electric vehicle batteries', ruleKind: 'max-nominal-and-act-lags',
    nominalDate: '2025-02-18', adoptionDeadline: '2024-02-18',
    dependencies: [
      { actId: 'art7-1-ev-methodology', lagCalendarMonths: 12 },
      { actId: 'art7-1-ev-declaration-format', lagCalendarMonths: 12 },
    ],
    source: { article: 'Article 7(1)', eli: ARTICLE_7_SOURCE },
  }),
  'carbon-declaration-industrial': milestone({
    id: 'carbon-declaration-industrial', topic: 'carbon-footprint', stage: 'declaration',
    scope: 'rechargeable industrial batteries >2 kWh except those with exclusively external storage',
    ruleKind: 'max-nominal-and-act-lags', nominalDate: '2026-02-18',
    adoptionDeadline: '2025-02-18',
    adoptionDeadlineScope: 'rechargeable industrial batteries except those with external storage',
    dependencies: [
      { actId: 'art7-1-industrial-methodology', lagCalendarMonths: 18 },
      { actId: 'art7-1-industrial-declaration-format', lagCalendarMonths: 18 },
    ],
    source: { article: 'Article 7(1)', eli: ARTICLE_7_SOURCE },
  }),
  'carbon-performance-class-ev': milestone({
    id: 'carbon-performance-class-ev', topic: 'carbon-footprint', stage: 'performance-class',
    scope: 'electric vehicle batteries', ruleKind: 'max-nominal-and-act-lags',
    nominalDate: '2026-08-18', adoptionDeadline: '2025-02-18',
    dependencies: [
      { actId: 'art7-2-ev-performance-classes', lagCalendarMonths: 18 },
      { actId: 'art7-2-ev-label-format', lagCalendarMonths: 18 },
    ],
    source: { article: 'Article 7(2)', eli: ARTICLE_7_SOURCE },
  }),
  'carbon-performance-class-industrial': milestone({
    id: 'carbon-performance-class-industrial', topic: 'carbon-footprint', stage: 'performance-class',
    scope: 'rechargeable industrial batteries >2 kWh except those with exclusively external storage',
    ruleKind: 'max-nominal-and-act-lags', nominalDate: '2027-08-18',
    adoptionDeadline: '2026-08-18',
    adoptionDeadlineScope: 'rechargeable industrial batteries except those with exclusively external storage',
    dependencies: [
      { actId: 'art7-2-industrial-performance-classes', lagCalendarMonths: 18 },
      { actId: 'art7-2-industrial-label-format', lagCalendarMonths: 18 },
    ],
    source: { article: 'Article 7(2)', eli: ARTICLE_7_SOURCE },
  }),
  'carbon-threshold-ev': milestone({
    id: 'carbon-threshold-ev', topic: 'carbon-footprint', stage: 'maximum-threshold',
    scope: 'electric vehicle batteries', ruleKind: 'max-nominal-and-act-lags',
    nominalDate: '2028-02-18', adoptionDeadline: '2026-08-18',
    dependencies: [{ actId: 'art7-3-ev-threshold', lagCalendarMonths: 18 }],
    source: { article: 'Article 7(3)', eli: ARTICLE_7_SOURCE },
  }),
  'carbon-threshold-industrial': milestone({
    id: 'carbon-threshold-industrial', topic: 'carbon-footprint', stage: 'maximum-threshold',
    scope: 'rechargeable industrial batteries >2 kWh except those with exclusively external storage',
    ruleKind: 'max-nominal-and-act-lags', nominalDate: '2029-02-18',
    adoptionDeadline: '2028-02-18',
    adoptionDeadlineScope: 'rechargeable industrial batteries except those with external storage',
    dependencies: [{ actId: 'art7-3-industrial-threshold', lagCalendarMonths: 18 }],
    source: { article: 'Article 7(3)', eli: ARTICLE_7_SOURCE },
  }),
  'battery-due-diligence-2025': milestone({
    id: 'battery-due-diligence-2025', topic: 'due-diligence', stage: 'operator-obligations',
    scope: 'economic-operator scope in Article 47', ruleKind: 'fixed', nominalDate: '2025-08-18',
    supersededBy: 'battery-due-diligence',
    source: { article: 'former Article 48(1)', eli: DUE_DILIGENCE_AMENDMENT_SOURCE },
  }),
  'battery-due-diligence-guidance-2025': milestone({
    id: 'battery-due-diligence-guidance-2025', topic: 'due-diligence', stage: 'Commission-guidance-deadline',
    scope: 'Commission guidance; not a condition precedent to operator obligations',
    ruleKind: 'fixed', nominalDate: '2025-02-18',
    supersededBy: 'battery-due-diligence-guidance',
    source: { article: 'former Article 48(5)', eli: DUE_DILIGENCE_AMENDMENT_SOURCE },
  }),
  'battery-due-diligence-guidance': milestone({
    id: 'battery-due-diligence-guidance', topic: 'due-diligence', stage: 'Commission-guidance-deadline',
    scope: 'Commission guidance; not a condition precedent to operator obligations',
    ruleKind: 'fixed', nominalDate: '2026-07-26',
    source: { article: 'Article 48(5), as amended by Regulation (EU) 2025/1561', eli: DUE_DILIGENCE_AMENDMENT_SOURCE },
  }),
  'battery-due-diligence': milestone({
    id: 'battery-due-diligence', topic: 'due-diligence', stage: 'operator-obligations',
    scope: 'economic-operator scope in Article 47', ruleKind: 'fixed', nominalDate: '2027-08-18',
    source: { article: 'Article 48(1), as amended by Regulation (EU) 2025/1561', eli: DUE_DILIGENCE_AMENDMENT_SOURCE },
  }),
});

function parseIsoDate(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new TypeError(`${label} must be a YYYY-MM-DD date.`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`${label} must be a real calendar date.`);
  }
  return { year, month, day };
}

function addCalendarMonths(value, months) {
  const { year, month, day } = parseIsoDate(value, 'Dependent-act entryIntoForceDate');
  if (!Number.isInteger(months) || months < 0) {
    throw new TypeError('lagCalendarMonths must be a non-negative integer.');
  }
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = firstOfTarget.getUTCFullYear();
  const targetMonth = firstOfTarget.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
    .toISOString().slice(0, 10);
}

export function resolveEuMilestone(milestoneOrId, acts = EU_DEPENDENT_ACTS, evaluationDate = null) {
  const item = typeof milestoneOrId === 'string'
    ? EU_LEGAL_MILESTONES[milestoneOrId]
    : milestoneOrId;
  if (!item || typeof item !== 'object') throw new TypeError('Unknown EU legal milestone.');
  parseIsoDate(item.nominalDate, `${item.id || 'EU milestone'} nominalDate`);
  if (evaluationDate != null) parseIsoDate(evaluationDate, 'evaluationDate');

  if (item.supersededBy) {
    return Object.freeze({ ...item, status: 'superseded', effectiveDate: null, pendingActIds: Object.freeze([]) });
  }

  if (item.ruleKind === 'fixed') {
    return Object.freeze({
      ...item,
      status: evaluationDate != null && evaluationDate >= item.nominalDate ? 'effective' : 'scheduled',
      effectiveDate: item.nominalDate,
      pendingActIds: Object.freeze([]),
    });
  }
  if (item.ruleKind !== 'max-nominal-and-act-lags') {
    throw new TypeError(`Unsupported EU milestone ruleKind: ${item.ruleKind}`);
  }

  const dateBearingActStatuses = new Set(['adopted-not-in-force', 'in-force']);
  const pendingActIds = item.dependencies
    .filter(({ actId }) => {
      const act = acts?.[actId];
      return !act?.entryIntoForceDate || !dateBearingActStatuses.has(act.actStatus);
    })
    .map(({ actId }) => actId);
  if (pendingActIds.length) {
    return Object.freeze({
      ...item,
      status: 'dependent-act-pending',
      effectiveDate: null,
      pendingActIds: Object.freeze(pendingActIds),
    });
  }

  const delayedDates = item.dependencies.map(({ actId, lagCalendarMonths }) => (
    addCalendarMonths(acts[actId].entryIntoForceDate, lagCalendarMonths)
  ));
  const effectiveDate = [item.nominalDate, ...delayedDates].sort().at(-1);
  return Object.freeze({
    ...item,
    status: evaluationDate != null && evaluationDate >= effectiveDate ? 'effective' : 'scheduled',
    effectiveDate,
    pendingActIds: Object.freeze([]),
  });
}

export const EU_TIMELINE = Object.freeze([
  Object.freeze({ date: '2025-02', what: 'EV carbon-footprint declaration nominal floor (18 February). The effective date is unresolved until both Article 7(1) dependent acts have entered into force, then uses the latest date.' }),
  Object.freeze({ date: '2025-12', what: 'Recycling efficiency ≥65% by mass (overall, a separate metric from per-material recovery).' }),
  Object.freeze({ date: '2026-02', what: 'Rechargeable industrial-battery declaration nominal floor (18 February; >2 kWh, excluding exclusively external storage). The effective date remains dependent-act pending.' }),
  Object.freeze({ date: '2026-07', what: 'Amended Commission deadline for battery due-diligence guidance: 26 July. This supporting-guidance deadline is not a condition precedent to the Article 48(1) operator date.' }),
  Object.freeze({ date: '2026-08', what: 'EV carbon-footprint performance-class nominal floor (18 August), not an unconditional start date; both Article 7(2) acts are still required.' }),
  Object.freeze({ date: '2027-02', what: 'Battery passport mandatory from 18 February for LMT batteries, EV batteries and industrial batteries >2 kWh: carbon footprint, responsible sourcing, composition, recycled content, state of health and durability. The Regulation requires accessible, current data; it does not prescribe UDS.' }),
  Object.freeze({ date: '2027-08', what: 'Rechargeable industrial-battery performance-class nominal floor (18 August; >2 kWh, excluding exclusively external storage), subject to both Article 7(2) dependent acts.' }),
  Object.freeze({ date: '2027-08', what: 'Battery due-diligence obligations use the amended fixed date of 18 August, subject to Article 47 operator scope; the former 2025 date is superseded.' }),
  Object.freeze({ date: '2027-12', what: 'Material recovery from waste batteries: Li 50%, Ni 90%, Co 90%, Cu 90%.' }),
  Object.freeze({ date: '2028-02', what: 'EV maximum carbon-footprint threshold nominal floor (18 February); the actual date is the later of that floor or 18 months after the threshold act enters into force.' }),
  Object.freeze({ date: '2029-02', what: 'Rechargeable industrial-battery maximum carbon-footprint threshold nominal floor (18 February; >2 kWh, excluding exclusively external storage), with the same dependent-act rule.' }),
  Object.freeze({ date: '2030-12', what: 'Recycling efficiency ≥70% by mass.' }),
  Object.freeze({ date: '2031-08', what: 'Recycled content minimums in NEW batteries: Li 6%, Ni 6%, Co 16%, Pb 85%.' }),
  Object.freeze({ date: '2031-12', what: 'Material recovery from waste: Li 80%, Ni 95%, Co 95%, Cu 95%.' }),
  Object.freeze({ date: '2036-08', what: 'Recycled content minimums rise: Li 12%, Ni 15%, Co 26%, Pb 85%.' }),
]);

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

// The second argument is a governed registry seam for legal-data updates and
// deterministic tests. DesignSpec/API callers cannot supply or override it.
export function euChecks({
  energyWh, application, chemistry, commsPrimary,
  batteryCategory = null, evaluationDate = EU_BATTERY_PASSPORT_EFFECTIVE_DATE,
  industrialStorageMode = null,
}, actRegistry = EU_DEPENDENT_ACTS) {
  const out = [];
  const push = (
    severity, title, detail, ontologyRuleId = null,
    ref = 'Regulation (EU) 2023/1542',
  ) =>
    out.push({
      severity, title, detail, ref, category: 'eu',
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

  const carbonTrack = category === 'ev'
    ? 'ev'
    : category === 'industrial' && kWh > 2 && industrialStorageMode === 'not-exclusively-external'
      ? 'industrial'
      : null;
  if (carbonTrack) {
    const declaration = resolveEuMilestone(`carbon-declaration-${carbonTrack}`, actRegistry, evaluationDate);
    const performanceClass = resolveEuMilestone(`carbon-performance-class-${carbonTrack}`, actRegistry, evaluationDate);
    const threshold = resolveEuMilestone(`carbon-threshold-${carbonTrack}`, actRegistry, evaluationDate);
    const trackName = carbonTrack === 'ev'
      ? 'EV batteries'
      : 'rechargeable industrial batteries >2 kWh except those with exclusively external storage';
    if (declaration.status === 'dependent-act-pending') {
      push('warn', 'Carbon footprint declaration — dependent acts pending',
        `For ${trackName}, ${declaration.nominalDate} is only the Article 7(1) nominal floor. The effective date is the latest of that floor and the required delay after both dependent acts enter into force; ${declaration.pendingActIds.length} required act records still lack a verified entry-into-force date, so this tool does not claim that the declaration is effective.`);
    } else {
      push(declaration.status === 'effective' ? 'warn' : 'info',
        declaration.status === 'effective'
          ? 'Carbon footprint declaration applies'
          : 'Carbon footprint declaration is scheduled',
        `For ${trackName}, the resolved Article 7(1) effective date is ${declaration.effectiveDate}; assessment date ${evaluationDate}.`);
    }
    if (performanceClass.status === 'dependent-act-pending') {
      push('info', 'Carbon-footprint performance class — dependent acts pending',
        `The nominal performance-class floor for ${trackName} is ${performanceClass.nominalDate}, not an unconditional start date. Article 7(2) uses the latest of that floor and 18 months after both required acts enter into force.`);
    } else {
      push(performanceClass.status === 'effective' ? 'warn' : 'info',
        performanceClass.status === 'effective'
          ? 'Carbon-footprint performance class applies'
          : 'Carbon-footprint performance class is scheduled',
        `For ${trackName}, the resolved Article 7(2) effective date is ${performanceClass.effectiveDate}; assessment date ${evaluationDate}.`);
    }
    if (threshold.status === 'dependent-act-pending') {
      push('info', 'Maximum carbon-footprint threshold — dependent act pending',
        `The nominal threshold floor for ${trackName} is ${threshold.nominalDate}, not an unconditional start date. Article 7(3) uses the later of that floor or 18 months after the threshold delegated act enters into force.`);
    } else {
      push(threshold.status === 'effective' ? 'warn' : 'info',
        threshold.status === 'effective'
          ? 'Maximum carbon-footprint threshold applies'
          : 'Maximum carbon-footprint threshold is scheduled',
        `For ${trackName}, the resolved Article 7(3) effective date is ${threshold.effectiveDate}; assessment date ${evaluationDate}.`);
    }
  } else {
    push(!category ? 'warn' : 'info', 'Carbon footprint declaration track needs review',
      category === 'industrial' && kWh > 2 && industrialStorageMode == null
        ? `The declared industrial battery is ${kWh.toFixed(1)} kWh, but the design does not state whether storage is exclusively external. Declare that fact before selecting the non-external or exclusively-external Article 7 track.`
        : category
        ? `The declared “${category}” category at ${kWh.toFixed(1)} kWh is outside the current executable EV/non-external-industrial-over-2-kWh Article 7 tracks. Verify its category-specific nominal date and dependent acts directly.`
        : 'Battery category is unresolved, so the software cannot select an Article 7 carbon-footprint track.');
  }
  push('info', 'Material sourcing is a design parameter under the thresholds',
    'Aluminium alone (0.5–0.7 kg per kWh of pack) can swing the declared footprint several-fold between world-average, renewable-powered and high-recycled stock. Qualify the housing supplier against the resolved Article 7 track; neither the EV 2028-02-18 nor industrial 2029-02-18 nominal threshold floor is an unconditional effective date.');

  const dueDiligence = resolveEuMilestone('battery-due-diligence', actRegistry, evaluationDate);
  push('info', 'Battery due-diligence timing needs company-scope review',
    `The amended fixed Article 48(1) date ${dueDiligence.effectiveDate} is ${dueDiligence.status === 'effective' ? 'effective at' : 'after'} this assessment date (${evaluationDate}). Pack-design inputs cannot determine Article 47 operator scope. Company-level review must cover turnover and consolidated-group thresholds plus product history: preparation for re-use, preparation for repurposing, repurposing or remanufacturing is excluded only where the battery had already been placed on the market or put into service before that operation.`,
    null, 'Regulation (EU) 2023/1542, as amended by Regulation (EU) 2025/1561');

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
