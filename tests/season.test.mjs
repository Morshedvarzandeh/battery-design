// Seasons & rules — the climate/season ambient bands, the per-season
// system-temperature outlook, the EU 2023/1542 layer, and the customer-set
// DoD in the cost model.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { CLIMATES, SEASONS, climateById, climateSpan, seasonalOutlook } from '../js/seasons.js';
import {
  EU_DEPENDENT_ACTS,
  EU_LEGAL_MILESTONES,
  EU_TIMELINE,
  euChecks,
  resolveEuMilestone,
} from '../js/eurules.js';
import { costModel, TCO_DOD } from '../js/optimizer.js';

test('climate data contract: bands ordered, spans cover, winter is coldest', () => {
  for (const cl of CLIMATES) {
    for (const s of SEASONS) {
      const band = cl.seasons[s];
      ok(Array.isArray(band) && band[0] < band[1], `${cl.id}/${s} band lo<hi`);
    }
    const span = climateSpan(cl);
    ok(span[0] === Math.min(...SEASONS.map((s) => cl.seasons[s][0])) &&
      span[1] === Math.max(...SEASONS.map((s) => cl.seasons[s][1])),
      `${cl.id} all-year span covers every season`);
    // Winter must actually be the coldest and summer the hottest — the whole
    // point of the seasonal view.
    ok(cl.seasons.winter[0] <= cl.seasons.summer[0] && cl.seasons.winter[1] <= cl.seasons.summer[1],
      `${cl.id} winter colder than summer`);
  }
  ok(climateById('temperate') && climateById('nope') === null, 'climate lookup');
});

test('seasonal outlook: winter charging flagged, indoor passes, no NaN', () => {
  const cell = cellById('samsung-inr21700-50e'); // charge window starts at 0 °C
  const cold = seasonalOutlook(climateById('cold'), cell, 5);
  const winter = cold.find((r) => r.season === 'winter');
  ok(winter.severity !== 'pass', 'cold-climate winter is never a silent pass');
  ok(winter.flags.some((f) => /heater|charge inhibit/.test(f)), 'sub-zero charging flagged');
  ok(winter.systemHiC === cold.find((r) => r.season === 'winter').ambientC[1] + 5,
    'system temp = ambient high + rise');
  const indoor = seasonalOutlook(climateById('indoor'), cell, 2);
  ok(indoor.every((r) => r.severity === 'pass'), 'conditioned indoor climate passes year-round');
  const hot = seasonalOutlook(climateById('hot'), cell, 15);
  const summer = hot.find((r) => r.season === 'summer');
  ok(summer.severity !== 'pass', 'hot summer + heat rise near the rating is flagged');
  // Null rise stays honest (no NaN).
  ok(seasonalOutlook(climateById('temperate'), cell, null).every((r) => isFinite(r.systemHiC)),
    'null heat rise handled');
});

test('EU rules: timeline sound, applicability answers per design', () => {
  ok(EU_TIMELINE.length >= 10, 'timeline populated');
  ok([...EU_TIMELINE].every((e, i, a) => i === 0 || a[i - 1].date <= e.date), 'timeline sorted');
  // The two-metrics trap must be stated, not conflated.
  ok(EU_TIMELINE.some((e) => /Recycling efficiency/i.test(e.what)) &&
    EU_TIMELINE.some((e) => /Material recovery/i.test(e.what)), 'recovery and efficiency kept apart');

  const ev = euChecks({ energyWh: 60_000, application: 'ev', chemistry: 'NMC', commsPrimary: 'CAN FD + UDS (ISO 14229)' });
  ok(ev.some((f) => /passport/i.test(f.title) && f.severity === 'warn'), 'EV: passport applies');
  ok(ev.some((f) => /SoH/.test(f.title) && f.severity === 'info' && /does not mandate UDS/.test(f.detail)),
    'UDS is identified as an implementation option, never proof of Article 14/77 compliance');
  const noUds = euChecks({ energyWh: 60_000, application: 'ev', chemistry: 'NMC', commsPrimary: 'proprietary UART' });
  ok(noUds.some((f) => /SoH/.test(f.title) && f.severity === 'info' && /none is legally required/.test(f.detail)),
    'absence of UDS does not create a fictitious regulatory failure');

  const small = euChecks({ energyWh: 900, application: 'powertool', chemistry: 'NMC', commsPrimary: '' });
  ok(small.some((f) => /declared battery category/i.test(f.title) && f.severity === 'warn'),
    'non-EV/LMT application is reviewed rather than silently called industrial or portable');
  const essUnclassified = euChecks({ energyWh: 10_000, application: 'solar-ess', chemistry: 'LFP', commsPrimary: 'Modbus' });
  ok(essUnclassified.some((f) => /declared battery category/i.test(f.title)),
    'energy above 2 kWh alone does not infer the industrial category');
  const ess = euChecks({ energyWh: 10_000, application: 'solar-ess', chemistry: 'LFP', commsPrimary: 'Modbus', batteryCategory: 'industrial' });
  ok(ess.some((f) => /passport/i.test(f.title) && f.severity === 'warn'), 'industrial >2 kWh: passport applies');
  ok(ess.filter((f) => /passport|SoH/.test(f.title))
    .every((f) => f.ontologyRuleId === 'bd:rule/eu-battery-passport'),
  'passport findings carry canonical ontology lineage without mislabelling other EU rules');
  ok(ess.some((f) => /gate fee/i.test(f.detail)), 'LFP end-of-life gate fee stated');
  const nmc = euChecks({ energyWh: 10_000, application: 'solar-ess', chemistry: 'NMC', commsPrimary: '', batteryCategory: 'industrial' });
  ok(nmc.some((f) => /Ni and Co/.test(f.title)), 'nickel-cobalt chemistry: full recycled-content scope');

  const preGate = euChecks({ energyWh: 60_000, application: 'ev', chemistry: 'NMC', evaluationDate: '2026-08-06' });
  ok(preGate.some((f) => /date gate not yet active/i.test(f.title)),
    'ontology date condition can assess a pre-effective release without changing the rule');
});

test('EU Article 7 gates fail closed until every dependent act has an entry-into-force date', () => {
  const cases = [
    {
      id: 'carbon-declaration-ev',
      entries: [['art7-1-ev-methodology', '2024-01-18'], ['art7-1-ev-declaration-format', '2025-03-18']],
      expected: '2026-03-18',
    },
    {
      id: 'carbon-declaration-industrial',
      entries: [['art7-1-industrial-methodology', '2025-01-18'], ['art7-1-industrial-declaration-format', '2025-03-18']],
      expected: '2026-09-18',
    },
    {
      id: 'carbon-performance-class-ev',
      entries: [['art7-2-ev-performance-classes', '2025-01-18'], ['art7-2-ev-label-format', '2025-04-18']],
      expected: '2026-10-18',
    },
    {
      id: 'carbon-performance-class-industrial',
      entries: [['art7-2-industrial-performance-classes', '2026-01-18'], ['art7-2-industrial-label-format', '2026-04-18']],
      expected: '2027-10-18',
    },
    {
      id: 'carbon-threshold-ev',
      entries: [['art7-3-ev-threshold', '2026-10-18']],
      expected: '2028-04-18',
    },
    {
      id: 'carbon-threshold-industrial',
      entries: [['art7-3-industrial-threshold', '2028-03-18']],
      expected: '2029-09-18',
    },
  ];

  for (const item of cases) {
    const pending = resolveEuMilestone(item.id, EU_DEPENDENT_ACTS, '2040-01-01');
    ok(pending.status === 'dependent-act-pending' && pending.effectiveDate === null,
      `${item.id}: a passed nominal floor never replaces missing act evidence`);
    ok(pending.pendingActIds.length === item.entries.length, `${item.id}: every missing act is named`);
    ok(Object.isFrozen(pending) && Object.isFrozen(pending.pendingActIds), `${item.id}: evidence is immutable`);

    const acts = Object.fromEntries(item.entries.map(([id, entryIntoForceDate]) => [
      id, { actStatus: 'in-force', entryIntoForceDate },
    ]));
    const scheduled = resolveEuMilestone(item.id, acts, '2020-01-01');
    ok(scheduled.effectiveDate === item.expected && scheduled.status === 'scheduled',
      `${item.id}: latest nominal-or-lagged date resolves exactly`);
    ok(resolveEuMilestone(item.id, acts, item.expected).status === 'effective',
      `${item.id}: gate becomes effective on its resolved date`);

    const earlyActs = Object.fromEntries(item.entries.map(([id]) => [
      id, { actStatus: 'in-force', entryIntoForceDate: '2020-01-18' },
    ]));
    ok(resolveEuMilestone(item.id, earlyActs, '2040-01-01').effectiveDate
      === EU_LEGAL_MILESTONES[item.id].nominalDate,
    `${item.id}: nominal floor wins when every lagged date is earlier`);
  }

  const draftWithDate = {
    ...EU_DEPENDENT_ACTS,
    'art7-1-ev-methodology': { actStatus: 'not-adopted', entryIntoForceDate: '2024-01-18' },
    'art7-1-ev-declaration-format': { actStatus: 'not-adopted', entryIntoForceDate: '2024-01-18' },
  };
  ok(resolveEuMilestone('carbon-declaration-ev', draftWithDate, '2030-01-01').effectiveDate === null,
    'a draft carrying a date cannot masquerade as an adopted or in-force act');

  for (const act of Object.values(EU_DEPENDENT_ACTS)) {
    ok(act.legalBasisUrl.includes('02023R1542') && act.statusEvidenceUrl.includes('32023R1542')
      && act.checkedAt === '2026-08-08',
    `${act.id}: legal dependency and time-sensitive status evidence stay separate`);
  }
  ok(EU_LEGAL_MILESTONES['carbon-declaration-industrial'].adoptionDeadlineScope
    === 'rechargeable industrial batteries except those with external storage',
  'Article 7(1) adoption-deadline scope preserves “external storage” wording');
  ok(EU_LEGAL_MILESTONES['carbon-performance-class-industrial'].adoptionDeadlineScope
    === 'rechargeable industrial batteries except those with exclusively external storage',
  'Article 7(2) adoption-deadline scope preserves “exclusively external storage” wording');
});

test('EU amended due-diligence date and carbon findings retain legal boundaries', () => {
  const superseded = resolveEuMilestone('battery-due-diligence-2025', EU_DEPENDENT_ACTS, '2030-01-01');
  ok(superseded.status === 'superseded' && superseded.effectiveDate === null
    && superseded.supersededBy === 'battery-due-diligence',
  'former 2025 due-diligence date cannot become current');
  ok(resolveEuMilestone('battery-due-diligence', EU_DEPENDENT_ACTS, '2027-08-17').status === 'scheduled',
    'amended due-diligence gate is inactive the day before');
  ok(resolveEuMilestone('battery-due-diligence', EU_DEPENDENT_ACTS, '2027-08-18').status === 'effective',
    'amended due-diligence gate is effective on 18 August 2027');
  const oldGuidance = resolveEuMilestone(
    'battery-due-diligence-guidance-2025', EU_DEPENDENT_ACTS, '2030-01-01',
  );
  ok(oldGuidance.status === 'superseded'
    && oldGuidance.supersededBy === 'battery-due-diligence-guidance',
  'former 2025 Commission-guidance deadline is retained only as superseded history');
  ok(resolveEuMilestone('battery-due-diligence-guidance', EU_DEPENDENT_ACTS, '2026-07-26').status === 'effective',
    'amended Commission-guidance deadline resolves separately from operator obligations');

  const ev = euChecks({
    energyWh: 60_000, application: 'ev', chemistry: 'NMC', evaluationDate: '2030-01-01',
  });
  ok(ev.some((finding) => /dependent acts pending/i.test(finding.title)
    && /only the Article 7\(1\) nominal floor/.test(finding.detail)),
  'EV finding does not turn the passed 2025 nominal floor into an effective date');
  ok(!ev.some((finding) => /mandatory.*since.*2025/i.test(`${finding.title} ${finding.detail}`)),
    'stale unconditional EV declaration wording is absent');

  ok(EU_LEGAL_MILESTONES['carbon-threshold-industrial'].nominalDate === '2029-02-18',
    'industrial threshold uses its own Article 7(3) nominal floor, not the EV date');
  ok(EU_TIMELINE.some(({ what }) => /former 2025 date is superseded/i.test(what)),
    'human timeline exposes the amended due-diligence date');
  ok(EU_TIMELINE.some(({ date, what }) => date === '2027-08'
    && /industrial-battery performance-class nominal floor/i.test(what)),
  'human timeline includes the modeled industrial performance-class floor');
  const dueFinding = ev.find((finding) => /due-diligence timing/i.test(finding.title));
  ok(/preparation for re-use.*preparation for repurposing.*repurposing.*remanufacturing/.test(dueFinding.detail)
    && /already been placed on the market or put into service before/.test(dueFinding.detail),
  'Article 47 product-history review preserves all four operations and the prior-market condition');

  const smallIndustrial = euChecks({
    energyWh: 2_000, application: 'custom', batteryCategory: 'industrial',
    chemistry: 'LFP', evaluationDate: '2030-01-01',
  });
  ok(smallIndustrial.some((finding) => /track needs review/i.test(finding.title)
    && /2\.0 kWh/.test(finding.detail)),
  'industrial batteries at 2 kWh are not forced into the >2 kWh Article 7 track');

  const unknownStorage = euChecks({
    energyWh: 10_000, application: 'custom', batteryCategory: 'industrial',
    chemistry: 'LFP', evaluationDate: '2030-01-01',
  });
  ok(unknownStorage.some((finding) => /track needs review/i.test(finding.title)
    && /does not state whether storage is exclusively external/i.test(finding.detail)),
  'industrial >2 kWh remains review-only until storage mode is explicit');

  const resolvedIndustrialActs = {
    'art7-1-industrial-methodology': { actStatus: 'in-force', entryIntoForceDate: '2025-01-18' },
    'art7-1-industrial-declaration-format': { actStatus: 'in-force', entryIntoForceDate: '2025-03-18' },
    'art7-2-industrial-performance-classes': { actStatus: 'in-force', entryIntoForceDate: '2026-01-18' },
    'art7-2-industrial-label-format': { actStatus: 'in-force', entryIntoForceDate: '2026-04-18' },
    'art7-3-industrial-threshold': { actStatus: 'in-force', entryIntoForceDate: '2028-03-18' },
  };
  const resolvedIndustrial = euChecks({
    energyWh: 10_000, application: 'custom', batteryCategory: 'industrial',
    industrialStorageMode: 'not-exclusively-external',
    chemistry: 'LFP', evaluationDate: '2035-01-01',
  }, resolvedIndustrialActs);
  for (const title of [
    'Carbon footprint declaration applies',
    'Carbon-footprint performance class applies',
    'Maximum carbon-footprint threshold applies',
  ]) {
    ok(resolvedIndustrial.some((finding) => finding.title === title),
      `resolved industrial output retains “${title}”`);
  }
});

test('customer-set DoD drives the cost model', () => {
  const c = cellById('samsung-inr21700-50e');
  const E = 1000;
  const base = costModel(c, 52, E, { cyclesPerYear: 250, targetYears: 6 });
  const half = costModel(c, 52, E, { cyclesPerYear: 250, targetYears: 6, dod: 0.5 });
  ok(Math.abs(base.throughputKWh - (c.cycleLife * E * TCO_DOD) / 1000) < 1e-9, 'default DoD unchanged');
  ok(Math.abs(half.throughputKWh - (c.cycleLife * E * 0.5) / 1000) < 1e-9, 'customer DoD drives throughput');
  ok(half.usdPerKWhDelivered > base.usdPerKWhDelivered, 'shallower cycling costs more per delivered kWh');
  const bad = costModel(c, 52, E, { dod: 7 }); // nonsense input falls back
  ok(Math.abs(bad.throughputKWh - base.throughputKWh) < 1e-9, 'invalid DoD falls back to default');
});
