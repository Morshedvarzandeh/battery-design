// V2X — the AC side, round two: feeding power back. The mode table (V2L,
// V2H, V2G, V2V), the wear floor that anchors the V2G economics to numbers
// the tool already trusts, applicability per application (stationary storage
// is NOT "V2X" — feeding the grid is its day job), the knowledge-graph
// gating, the report rows, and the citations for the standards named.
import { test } from 'node:test';
import { readFileSync } from 'fs';
import { ok, near } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { costModel } from '../js/optimizer.js';
import { co2Model } from '../js/report.js';
import { V2X_MODES, wearFloorUsdPerKWh, assessV2xMode, v2xPlan } from '../js/v2x.js';
import { buildChargingPlan } from '../js/charging.js';
import { buildReportHTML } from '../js/report.js';
import { needed, stepsFor } from '../js/knowledge.js';
import { TRAINING_TRACKS } from '../js/training.js';

test('the mode table is complete and honest', () => {
  ok(V2X_MODES.length === 4, 'four modes: V2L, V2H, V2G, V2V');
  const ids = V2X_MODES.map((m) => m.id);
  ok(new Set(ids).size === 4 && ['v2l', 'v2h', 'v2g', 'v2v'].every((x) => ids.includes(x)), 'ids unique and expected');
  for (const m of V2X_MODES) {
    ok(m.what.length > 40 && m.needs.length >= 1 && m.appIds.length >= 1, `${m.id}: what/needs/apps stated`);
  }
  ok(V2X_MODES.find((m) => m.id === 'v2g').appIds.includes('ebus'),
    'e-bus fleets get V2G — depot packs are real grid assets');
  ok(!V2X_MODES.find((m) => m.id === 'v2l').appIds.includes('ebus'),
    'but nobody runs a campsite off a transit bus');
});

test('the wear floor IS the cost model\'s $/kWh delivered — one truth, hand-checked', () => {
  // 100 cells at $4, 2000 cycles, 1 kWh pack, 80% DoD:
  // $400 / (2000 × 1 kWh × 0.8) = $0.25/kWh.
  const cellA = { priceUSD: 4, cycleLife: 2000 };
  near(wearFloorUsdPerKWh({ cell: cellA, cellCount: 100, energyWh: 1000, dod: 0.8 }), 0.25, 1e-12, 'hand-checked');
  // And it must equal costModel's usdPerKWhDelivered exactly — the report's
  // value metric and the V2G floor are the same number, not two rival ones.
  const c = cellById('eve-lf280k');
  const n = 16, energyWh = n * c.nominalV * c.capacityAh;
  const floor = wearFloorUsdPerKWh({ cell: c, cellCount: n, energyWh, dod: 0.8 });
  near(floor, costModel(c, n, energyWh, { dod: 0.8 }).usdPerKWhDelivered, 1e-12,
    'identical to the TCO metric');
  // Null-safe: no price or no cycle life → no floor, never NaN.
  ok(wearFloorUsdPerKWh({ cell: { priceUSD: null, cycleLife: 2000 }, cellCount: 10, energyWh: 500 }) === null, 'no price → null');
  ok(wearFloorUsdPerKWh({ cell: { priceUSD: 4, cycleLife: null }, cellCount: 10, energyWh: 500 }) === null, 'no cycle life → null');
  ok(wearFloorUsdPerKWh({ cell: cellA, cellCount: 0, energyWh: 500 }) === null, 'no cells → null');
});

test('verdicts use the standard vocabulary and name the reasons', () => {
  const by = Object.fromEntries(V2X_MODES.map((m) => [m.id, m]));
  ok(assessV2xMode(by.v2l).verdict === 'workable', 'V2L: an inverter output, nothing more');
  ok(assessV2xMode(by.v2h).verdict === 'workable-with-costs', 'V2H: established but the installation costs are real');
  const g = assessV2xMode(by.v2g, { wearFloor: 0.31 });
  ok(g.verdict === 'workable-with-costs', 'V2G: the standards exist, the economics decide');
  ok(/\$0\.31\/kWh/.test(g.why) && /wear/i.test(g.why), 'the wear floor is named with its value');
  ok(/conservative ceiling/i.test(g.why), 'nameplate-vs-shallow-cycling honesty stated');
  const gNo = assessV2xMode(by.v2g, { wearFloor: null });
  ok(/unknown/.test(gNo.why), 'missing data stated, not papered over');
  const v = assessV2xMode(by.v2v);
  ok(v.verdict === 'unproven' && /V2L|portable DC/i.test(v.why),
    'V2V: unproven, with the practical route named — same vocabulary as wireless BMS');
});

test('applicability follows the application — storage is not "V2X"', () => {
  const c = cellById('eve-lf280k');
  const ev = v2xPlan({ appId: 'ev', cell: c, cellCount: 100, energyWh: 60000, dod: 0.8 });
  ok(ev.applicable && ev.modes.length === 4, 'EV: all four modes assessed');
  ok(ev.modes.every((m) => m.assessment?.verdict), 'every mode carries a verdict');
  ok(ev.wearFloor > 0 && /Wear floor \$/.test(ev.wearNote), 'wear floor computed and explained');
  const ebus = v2xPlan({ appId: 'ebus', cell: c, cellCount: 500, energyWh: 300000 });
  ok(ebus.applicable && ebus.modes.length === 1 && ebus.modes[0].id === 'v2g',
    'e-bus: V2G only — no home backup from a transit depot');
  const ess = v2xPlan({ appId: 'solar-ess', cell: c, cellCount: 16, energyWh: 14336 });
  ok(!ess.applicable && /PCS/.test(ess.why) && /normal duty/i.test(ess.why),
    'storage: already grid storage through the PCS — said, not mode-listed');
  const ups = v2xPlan({ appId: 'ups', cell: c, cellCount: 16, energyWh: 14336 });
  ok(!ups.applicable && /PCS/.test(ups.why), 'UPS: same framing');
  const w = v2xPlan({ appId: 'wearable', cell: c, cellCount: 1, energyWh: 1 });
  ok(!w.applicable && w.modes.length === 0, 'a watch does not back-feed the grid');
  // No price data → the plan still stands, the note says the ledger is open.
  const noPrice = v2xPlan({ appId: 'ev', cell: { ...c, priceUSD: null }, cellCount: 100, energyWh: 60000 });
  ok(noPrice.applicable && noPrice.wearFloor === null && /cannot be priced/.test(noPrice.wearNote),
    'missing data → honest note, not a fake number');
});

test('the knowledge graph gates V2X to vehicles with a bidirectional port', () => {
  ok(needed('ev', 'v2x') && needed('ebus', 'v2x'), 'EV and e-bus get the concept');
  for (const app of ['wearable', 'solar-ess', 'ups', 'ebike', 'powerstation', 'robovac']) {
    ok(!needed(app, 'v2x'), `${app}: never meets V2X in training`);
  }
  const evSteps = stepsFor(TRAINING_TRACKS.advanced, 'ev');
  ok(evSteps.some((s) => s.concept === 'v2x'), 'EV training includes "Feeding power back"');
  ok(!stepsFor(TRAINING_TRACKS.advanced, 'wearable').some((s) => s.concept === 'v2x'),
    'wearable training omits it entirely');
});

test('the report carries the V2X verdicts and the wear floor', () => {
  const c = cellById('samsung-inr21700-50e');
  const base = {
    date: '2026-08-03', application: 'ev', cell: c,
    summary: {
      s: 96, p: 4, cellCount: 384, nominalV: 345.6, vMin: 240, vMax: 403.2,
      capacityAh: 19.6, energyWh: 6774, maxContCurrentA: 39, maxContPowerW: 13478,
      dims: { x: 500, y: 400, z: 100 }, massKg: 33, whPerKg: 205, whPerL: 339,
    },
    bayLabel: 'box',
    cost: costModel(c, 384, 6774, { cyclesPerYear: 250, targetYears: 8, dod: 0.8 }),
    co2: co2Model({ cell: c, energyWh: 6774, cyclesPerYear: 250, targetYears: 8, gridGPerKWh: 440 }),
    gridLabel: 'World grid average',
    usage: { cyclesPerYear: 250, targetYears: 8 },
    selection: {}, findings: [], disclaimer: 'test',
  };
  const charging = buildChargingPlan({ appId: 'ev', marketId: 'eu', energyWh: 6774, vNomV: 345.6, cell: c });
  const v2x = v2xPlan({ appId: 'ev', cell: c, cellCount: 384, energyWh: 6774, dod: 0.8 });
  const html = buildReportHTML({ ...base, charging, v2x });
  ok(/V2G/.test(html) && /V2L/.test(html), 'modes named in the charging section');
  ok(/workable-with-costs/.test(html), 'verdicts printed');
  ok(/Wear floor \$/.test(html), 'the wear floor reaches the customer document');
  ok(!/undefined|NaN/.test(html), 'no leaks');
  // Storage: the PCS framing rides in the notes line instead of mode rows.
  const cs = cellById('eve-lf280k');
  const essCharging = buildChargingPlan({ appId: 'solar-ess', marketId: 'eu', energyWh: 14336, vNomV: 51.2, cell: cs });
  const essV2x = v2xPlan({ appId: 'solar-ess', cell: cs, cellCount: 16, energyWh: 14336 });
  const essHtml = buildReportHTML({ ...base, application: 'solar-ess', cell: cs, charging: essCharging, v2x: essV2x });
  ok(/normal duty/.test(essHtml) && !/V2L/.test(essHtml), 'storage: the one honest line, no mode table');
  ok(!/undefined|NaN/.test(essHtml), 'clean');
});

test('the standards V2X names to a customer are cited in REFERENCES.md', () => {
  const refs = readFileSync(new URL('../REFERENCES.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  for (const code of ['ISO 15118-20', 'CHAdeMO', 'IEEE 1547', 'UL 1741', 'UL 9741']) {
    ok(refs.includes(code), `${code} cited`);
  }
  ok(/wear floor/i.test(refs) && /nameplate/i.test(refs),
    '§8 owns the nameplate-cycle-life caveat behind the wear floor');
});
