// Report — the CO2/report models and the private customer-cell logic.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { costModel } from '../js/optimizer.js';
import { co2Model, CO2_MFG_PER_KWH, buildReportHTML, buildWordDocument } from '../js/report.js';
import { normalizeCustomCell, validateCustomCell, buildMailto, OWNER_EMAIL } from '../js/mycells.js';
import { compareCells } from '../js/sim1d.js';

test('CO2 arithmetic on a ~14 kWh LFP ESS', () => {
  const lfp = cellById('eve-lf280k'); // 3.2V 280Ah, 6000 cycles class
  const energyWh = 16 * lfp.nominalV * lfp.capacityAh;
  const m = co2Model({ cell: lfp, energyWh, cyclesPerYear: 300, targetYears: 10, gridGPerKWh: 440 });
  ok(Math.abs(m.mfgKgPerPack - (energyWh / 1000) * CO2_MFG_PER_KWH.LFP) < 1e-6, 'mfg = kWh × factor');
  // payback: mfg / (perCycleKWh × g/1000)
  const perCycle = (energyWh * 0.8) / 1000;
  ok(Math.abs(m.paybackCycles - m.mfgKgPerPack / (perCycle * 0.44)) < 1e-6, 'payback cycles formula');
  ok(m.paybackYears > 0 && m.paybackYears < 2, `LFP on world grid pays back fast (${m.paybackYears.toFixed(2)} y)`);
  ok(m.paybackReached === true, 'payback reached within cycle life');
  ok(m.netKgOverTarget > 0, 'net reduction positive over 10y of daily-ish cycling');
  // Cleaner grid → later payback point.
  const clean = co2Model({ cell: lfp, energyWh, cyclesPerYear: 300, targetYears: 10, gridGPerKWh: 100 });
  ok(clean.paybackCycles > m.paybackCycles, 'cleaner displaced source → later CO2 payback');
});

test('payback can honestly fail: short cycle life on a clean grid', () => {
  const nmc = cellById('samsung-inr21700-50e'); // 500 cycles
  const m = co2Model({ cell: nmc, energyWh: 917, cyclesPerYear: 100, targetYears: 5, gridGPerKWh: 50 });
  ok(m.paybackReached === false, 'payback not reached flags honestly on clean grid + short life');
});

test('report document builds with full and sparse data', () => {
  const c = cellById('samsung-inr21700-50e');
  const summary = {
    s: 13, p: 4, cellCount: 52, nominalV: 46.8, vMin: 32.5, vMax: 54.6,
    capacityAh: 19.6, energyWh: 917, maxContCurrentA: 39, maxContPowerW: 1835,
    dims: { x: 169, y: 159, z: 82 }, massKg: 4.5, whPerKg: 206, whPerL: 416,
  };
  const R = {
    date: '2026-08-01', application: 'ebike', cell: c, summary,
    massWithComponentsKg: 4.7, bayLabel: 'box',
    cost: costModel(c, 52, 917, { cyclesPerYear: 250, targetYears: 5 }),
    co2: co2Model({ cell: c, energyWh: 917, cyclesPerYear: 250, targetYears: 5, gridGPerKWh: 440 }),
    gridLabel: 'World grid average',
    usage: { cyclesPerYear: 250, targetYears: 5 },
    selection: { busbar: { name: '0.15 mm nickel strip', suppliers: ['A'] }, cooling: null },
    findings: [
      { severity: 'warn', title: 'W', detail: 'd', category: 'thermal' },
      { severity: 'pass', title: 'P', detail: 'd', category: 'electrical' },
    ],
    disclaimer: 'test disclaimer',
  };
  const html = buildReportHTML(R);
  ok(html.includes('Battery pack design report') && html.includes('CO2 payback point')
    && html.includes('Total cost of ownership'), 'report sections present');
  ok(!/undefined|NaN/.test(html), 'no undefined/NaN leaks into the report');
  const doc = buildWordDocument(html, 'T');
  ok(doc.includes('urn:schemas-microsoft-com:office:word'), 'Word wrapper present');
  // Sparse: no price, no cycles, no usage.
  const c2 = { ...c, priceUSD: null, cycleLife: null };
  const R2 = {
    ...R, cell: c2, cost: costModel(c2, 52, 917, {}),
    co2: co2Model({ cell: c2, energyWh: 917, gridGPerKWh: 440 }), usage: {},
  };
  ok(!/undefined|NaN/.test(buildReportHTML(R2)), 'sparse report clean');

  // With compared cells: the report carries the same-mission comparison so
  // the value of different cells can be weighed side by side.
  const lfp = cellById('eve-lf280k');
  const cmp = compareCells({
    cells: [c, lfp], targetVNom: summary.nominalV, targetEnergyWh: summary.energyWh,
    profile: { dtS: 30, p: [0.4, 0.9, 0.2] }, scaleW: 1200, ambientC: 25, uaWK: 3, currentId: c.id,
  });
  for (const r of cmp.rows) r.cost = costModel(r.cell, r.s * r.p, r.energyWh, { cyclesPerYear: 250, targetYears: 5 });
  const R3 = { ...R, simCompare: cmp };
  const html3 = buildReportHTML(R3);
  ok(html3.includes('Cell comparison — same mission, same duty'), 'comparison section present');
  ok(html3.includes(lfp.name) && html3.includes('(this design)'), 'both cells named, current marked');
  ok(html3.includes('$/kWh delivered'), 'the value column is there');
  ok(!/undefined|NaN/.test(html3), 'comparison section clean');
});

test('customer cells: validation, normalization, and the private mail path', () => {
  const good = {
    manufacturer: 'Acme', model: 'X-100', form: 'cylindrical', chemistry: 'LFP',
    d: '26', h: '65', capacityAh: '3.0', massG: '85',
    nominalV: '3.2', vMax: '3.65', vMin: '2.5',
    maxContDischargeA: '10', maxContChargeA: '3', cycleLife: '2000', priceUSD: '4',
  };
  ok(validateCustomCell(good).length === 0, 'valid cell passes');
  const rec = normalizeCustomCell(good);
  ok(rec.id.startsWith('my-acme-x-100'), `id derived (${rec.id})`);
  ok(rec.dims.d === 26 && rec.capacityAh === 3 && rec.cycleLife === 2000, 'numeric coercion');
  ok(rec.dataQuality === 'estimate' && /never published/.test(rec.sourceNote), 'privacy note embedded');
  ok(validateCustomCell({ ...good, vMax: '3.0' }).length > 0, 'bad voltage ordering caught');
  ok(validateCustomCell({ ...good, massG: '5' }).length > 0, 'implausible Wh/kg caught');
  ok(validateCustomCell({ ...good, form: 'pouch', w: '100', t: '200', h: '150' }).length > 0, 't>w caught');
  const mailto = buildMailto(rec);
  ok(mailto.startsWith(`mailto:${OWNER_EMAIL}?subject=`), 'mailto addressed to owner');
  ok(decodeURIComponent(mailto).includes('"capacityAh": 3'), 'datasheet JSON in mail body');
});
