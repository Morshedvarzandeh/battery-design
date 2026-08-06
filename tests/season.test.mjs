// Seasons & rules — the climate/season ambient bands, the per-season
// system-temperature outlook, the EU 2023/1542 layer, and the customer-set
// DoD in the cost model.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { CLIMATES, SEASONS, climateById, climateSpan, seasonalOutlook } from '../js/seasons.js';
import { EU_TIMELINE, euChecks } from '../js/eurules.js';
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
