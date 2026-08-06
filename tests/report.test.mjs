// Report — the CO2/report models and the private customer-cell logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { costModel } from '../js/optimizer.js';
import { designFromSpec } from '../js/api.js';
import {
  co2Model, CO2_MFG_PER_KWH, buildReportHTML, buildWordDocument, semanticTraceForReport,
} from '../js/report.js';
import { normalizeCustomCell, validateCustomCell, buildMailto, OWNER_EMAIL } from '../js/mycells.js';
import { compareCells } from '../js/sim1d.js';
import { semanticDigest } from '../js/ontology.js';

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
  const legacyTrace = semanticTraceForReport(R);
  assert.equal(legacyTrace.authority.kind, 'legacy-reconstructed-fallback');
  ok(html.includes('Legacy reconstructed fallback')
    && /not the authoritative design graph and cannot support release/i.test(html),
  'an old report without the engine snapshot is visibly labelled as a non-authoritative fallback');
  const suppliedSemantics = {
    ontology: { version: 'snapshot-7', checksum: 'snapshot-checksum-only' },
    rootId: 'https://example.test/design/snapshot-7',
    profile: 'supplied-report-profile', conforms: false,
    counts: { nodes: 7, edges: 9, modelRuns: 2 },
    feasibility: 'review', evidenceMaturity: 'provisional',
    unresolvedEvidence: [{ id: 'req:one', label: 'Supplied evidence boundary' }],
    issues: [{ code: 'SUPPLIED_TEST_ISSUE' }],
    graph: {
      rootId: 'https://example.test/design/snapshot-7',
      checksum: 'snapshot-checksum-only',
    },
  };
  const semanticHtml = buildReportHTML({ ...R, semantics: suppliedSemantics });
  ok(semanticHtml.includes('snapshot-7') && semanticHtml.includes('snapshot-checksum-only')
    && semanticHtml.includes('supplied-report-profile') && semanticHtml.includes('Supplied evidence boundary'),
  'the report renders the supplied semantic snapshot exactly rather than deriving a replacement');
  ok(semanticHtml.includes('Supplied snapshot — integrity not proven')
    && !semanticHtml.includes('Authoritative engine snapshot'),
  'matching claimed strings alone cannot make an incomplete, nonconforming graph authoritative');
  ok(/INVALID.*RELEASE BLOCKED/.test(semanticHtml),
    'semantic nonconformance is visible and release-blocking in the customer report');
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

  const R4 = {
    ...R,
    electricalProtection: {
      precharge: {
        status: 'review', resistanceOhm: 50,
        nominal: { peakCurrentA: 8, peakPowerW: 3200, targetV: 390, timeToTargetS: 1.5 },
        corners: [{ timeToTargetS: 1.4 }, { timeToTargetS: 1.6 }],
        required: { voltageV: 480, pulseEnergyJ: 576, pulsePowerW: 3840 },
      },
      shunt: {
        status: 'review', reference: { part: 'SFP200MOD' }, resistanceUOhm: 18,
        continuousA: 600, electrical: { continuousDropMV: 10.8, continuousLossW: 6.48 },
        accuracy: { atContinuous: { absoluteA: 6.1, percent: 1.02 } },
        thermal: { calculated: true, maxTempC: 105 },
      },
      fast: {
        status: 'review', conservativeThresholdA: 1200, crossingS: 0.001,
        interruptS: 0.006, currentAtInterruptA: 4200, inductiveEnergyJ: 18,
      },
    },
  };
  const html4 = buildReportHTML(R4);
  ok(html4.includes('HV startup, current shunt') && html4.includes('Fast interruption simulation'),
    'electrical calculator results reach the customer report');

  const R5 = {
    ...R,
    application: 'marine',
    marine: {
      vessel: {
        id: 'ntnu-gunnerus', name: 'NTNU R/V Gunnerus', segment: 'research-vessel',
        boundary: 'TwinShip did not publish a production battery retrofit; this is a governed design scenario.',
      },
      inputs: { vesselId: 'ntnu-gunnerus', durationH: 1, seaState: 'calm' },
      distanceNm: 10, energyWh: 650000, continuousW: 640000, peakW: 780000,
      energyPerNmWh: 65000, maturity: 'screening',
      policyId: 'marine-load-levelling',
      metrics: { speedGroundKn: 10, speedWaterKn: 10 },
      assumptions: ['First-order displacement-hull screening.'],
    },
    twinShip: {
      architecture: {
        components: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}` })),
        connections: Array.from({ length: 11 }, (_, i) => ({ id: `e${i}` })),
        reference: { statement: 'Architecture reference and research demonstrator; not a certified battery model.' },
      },
      readiness: {
        label: 'Screening model', maturity: 'screening',
        missing: ['Measured or supplied vessel power basis', 'Governed calibration trial'],
        statement: 'Do not present this result as a live or validated vessel digital twin.',
      },
      replay: {
        status: 'unproven',
        diagnostics: [{ detail: 'At least two aligned samples are required.' }],
        limitation: 'Residuals are early-warning evidence, not fault isolation.',
      },
    },
  };
  const html5 = buildReportHTML(R5);
  ok(html5.includes('Marine vessel, voyage &amp; TwinShip evidence')
    && html5.includes('NTNU R/V Gunnerus') && html5.includes('650 kWh')
    && html5.includes('marine-load-levelling'),
  'a distinct marine section carries vessel identity and voyage duty');
  ok(html5.includes('Screening model (screening)') && html5.includes('At least two aligned samples are required'),
    'missing twin and replay evidence stays visible');
  ok(/not fault isolation/.test(html5) && /neither result is class approval/.test(html5)
    && /not a certified battery model/.test(html5),
  'the report cannot turn the TwinShip research architecture into certification or diagnosis');
  ok(!/undefined|NaN/.test(html5), 'marine evidence section has no undefined or NaN leaks');

  const html6 = buildReportHTML({
    ...R5,
    twinShip: {
      ...R5.twinShip,
      readiness: {
        label: 'Digital twin', maturity: 'digital-twin', missing: [],
        assetId: 'SECRET-PHYSICAL-ASSET',
        calibrationTrialId: 'SECRET-CALIBRATION-TRIAL',
        statement: 'The declared evidence satisfies the governed software contract.',
      },
    },
  });
  ok(/raw trial and physical-asset identifiers are intentionally omitted/.test(html6),
    'a satisfied readiness contract explains why its identities are absent');
  ok(!/Missing evidence:\s*none/i.test(html6)
    && !/SECRET-PHYSICAL-ASSET|SECRET-CALIBRATION-TRIAL/.test(html6),
  'the report neither claims missing none nor echoes private identifiers');
});

test('report verifies graph integrity without treating an unsigned digest as authority', () => {
  const design = designFromSpec({ application: 'marine', marine: { vesselId: 'ntnu-gunnerus' } });
  const report = {
    date: '2026-08-06', application: design.application.id,
    cell: design.cell, summary: design.pack, cost: design.cost, co2: design.co2,
    gridLabel: 'World grid average', usage: { cyclesPerYear: 250, targetYears: 8 },
    selection: {}, findings: design.findings, semantics: design.semantics,
    marine: design.marine, twinShip: design.twinShip, disclaimer: 'Screening only.',
  };
  const trace = semanticTraceForReport(report);
  assert.equal(trace.authority.kind, 'self-consistent-origin-unverified');
  assert.equal(trace.authority.authoritative, false);
  assert.equal(trace.semantics.rootId, design.semantics.rootId);
  assert.equal(trace.semantics.rootId, design.semantics.graph.rootId);
  assert.equal(trace.semantics.ontology.checksum, design.semantics.ontology.checksum);
  assert.equal(trace.semantics.ontology.checksum, design.semantics.graph.checksum);

  const html = buildReportHTML(report);
  assert.ok(html.includes(design.semantics.rootId), 'the exact API design root reaches the report');
  assert.ok(html.includes(design.semantics.ontology.checksum), 'the exact API checksum reaches the report');
  assert.match(html, /Self-consistent semantic snapshot — origin unverified/);
  assert.match(html, /RELEASE BLOCKED|NOT RELEASE-AUTHORITATIVE/);

  const mismatched = JSON.parse(JSON.stringify(design.semantics));
  mismatched.rootId = `${mismatched.rootId}-different`;
  const rejected = semanticTraceForReport({ ...report, semantics: mismatched });
  assert.equal(rejected.authority.kind, 'supplied-snapshot-integrity-failure');
  assert.equal(rejected.authority.authoritative, false);
  const rejectedHtml = buildReportHTML({ ...report, semantics: mismatched });
  assert.match(rejectedHtml, /Supplied snapshot — integrity not proven/);
  assert.match(rejectedHtml, /root id does not match the graph/);
  assert.match(rejectedHtml, /RELEASE BLOCKED|NOT RELEASE-AUTHORITATIVE/);

  const checksumMismatch = JSON.parse(JSON.stringify(design.semantics));
  checksumMismatch.ontology.checksum = `${checksumMismatch.ontology.checksum}-different`;
  const rejectedChecksum = semanticTraceForReport({ ...report, semantics: checksumMismatch });
  assert.equal(rejectedChecksum.authority.kind, 'supplied-snapshot-integrity-failure');
  assert.match(rejectedChecksum.authority.detail, /checksum does not match the graph/);

  const forgedContent = JSON.parse(JSON.stringify(design.semantics));
  forgedContent.graph.nodes[0].label = 'forged result';
  const rejectedContent = semanticTraceForReport({ ...report, semantics: forgedContent });
  assert.equal(rejectedContent.authority.kind, 'supplied-snapshot-integrity-failure');
  assert.match(rejectedContent.authority.detail, /node and relation content/);

  const nonconforming = JSON.parse(JSON.stringify(design.semantics));
  nonconforming.graph.edges[0].type = 'bd:notARealRelation';
  const attackerChecksum = semanticDigest({
    nodes: nonconforming.graph.nodes, edges: nonconforming.graph.edges,
  });
  nonconforming.graph.checksum = attackerChecksum;
  nonconforming.ontology.checksum = attackerChecksum;
  const rejectedShape = semanticTraceForReport({ ...report, semantics: nonconforming });
  assert.equal(rejectedShape.authority.kind, 'supplied-snapshot-integrity-failure');
  assert.match(rejectedShape.authority.detail, /does not conform/);

  const recomputedForgery = JSON.parse(JSON.stringify(design.semantics));
  const quantity = recomputedForgery.graph.nodes.find((node) =>
    node.types?.includes('bd:QuantityValue'));
  quantity.properties.numericValue = 999999;
  const forgedChecksum = semanticDigest({
    nodes: recomputedForgery.graph.nodes, edges: recomputedForgery.graph.edges,
  });
  recomputedForgery.graph.checksum = forgedChecksum;
  recomputedForgery.ontology.checksum = forgedChecksum;
  const selfConsistentForgery = semanticTraceForReport({ ...report, semantics: recomputedForgery });
  assert.equal(selfConsistentForgery.authority.kind, 'self-consistent-origin-unverified');
  assert.equal(selfConsistentForgery.authority.authoritative, false,
    'a caller can recompute a public digest, so self-consistency never proves producer authenticity');

  const incomplete = semanticTraceForReport({ ...report, semantics: { counts: {} } });
  assert.equal(incomplete.authority.kind, 'supplied-snapshot-integrity-failure',
    'an incomplete supplied claim cannot be disguised as a legacy reconstruction');
  assert.match(incomplete.authority.detail, /graph payload is missing/);

  const emptyIdentity = semanticTraceForReport({ ...report, semantics: { counts: {}, graph: {} } });
  assert.equal(emptyIdentity.authority.kind, 'supplied-snapshot-integrity-failure');
  assert.match(emptyIdentity.authority.detail, /snapshot root id is missing/);
  assert.match(emptyIdentity.authority.detail, /graph checksum is missing/);
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
