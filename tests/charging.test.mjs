// Charging — the AC side, round one: the per-application charging
// architecture (an OBC is not bolted onto everything), hand-checked
// charge-time math with the CC-CV taper and the named bottleneck, the AC
// interface per market, strategies, mission charge segments in the
// simulation, and the knowledge-graph gating that keeps gadgets away from
// charger classes.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import {
  OBC_CLASSES, OBC_EFFICIENCY, obcById, acInterfaceFor, chargingArchitectureFor,
  CHARGE_STRATEGIES, strategiesFor, chargeTime, buildChargingPlan,
  evaluateMarineShoreConnection, MARINE_SHORE_POWER_TOLERANCE,
  CV_KNEE_SOC, CV_TAPER,
} from '../js/charging.js';
import { simulateMission } from '../js/sim1d.js';
import { needed } from '../js/knowledge.js';
import { PRESETS } from '../js/presets.js';

const acShoreContract = () => ({
  mode: 'ac',
  voltageV: 400,
  phases: 3,
  frequencyHz: 50,
  powerFactor: 0.9,
  ratedPowerKW: 11,
  ratedCurrentA: 11000 / (Math.sqrt(3) * 400 * 0.9),
  efficiency: 0.94,
  outputVoltageMinV: 20,
  outputVoltageMaxV: 32,
  connector: { id: 'ntnu-shore-ac-01', name: 'NTNU project shore inlet 01' },
  earthing: { declared: true, scheme: 'Project drawing E-04 declared earthing scheme' },
  isolation: { declared: true, method: 'Project drawing E-04 declared galvanic isolation' },
  interlock: { declared: true, description: 'Project PLC connection-permissive loop' },
  emergencyDisconnect: { declared: true, description: 'Project emergency disconnect chain' },
  evidence: {
    kind: 'project', source: 'NTNU vessel electrical drawing E-04', revision: 'Rev C', date: '2024-02-29',
  },
});

const dcShoreContract = () => ({
  mode: 'dc',
  voltageV: 500,
  ratedPowerKW: 50,
  ratedCurrentA: 100,
  efficiency: 1,
  outputVoltageMinV: 24,
  outputVoltageMaxV: 24,
  connector: { id: 'supplier-dc-inlet-7', name: 'Supplier vessel DC inlet 7' },
  earthing: { declared: true, scheme: 'Supplier-declared DC earthing arrangement' },
  isolation: { declared: true, method: 'Supplier-declared isolated DC converter' },
  interlock: { declared: true, description: 'Supplier plug-presence and voltage permissive' },
  emergencyDisconnect: { declared: true, description: 'Supplier emergency isolation input' },
  evidence: {
    kind: 'supplier', source: 'Supplier equipment data sheet DS-7', revision: 'Rev 1', date: '2000-02-29',
  },
});

function copy(value) {
  return structuredClone(value);
}

function removePath(value, path) {
  const parts = path.split('.');
  const leaf = parts.pop();
  let cursor = value;
  for (const part of parts) cursor = cursor[part];
  delete cursor[leaf];
  return value;
}

function setPath(value, path, replacement) {
  const parts = path.split('.');
  const leaf = parts.pop();
  let cursor = value;
  for (const part of parts) cursor = cursor[part];
  cursor[leaf] = replacement;
  return value;
}

function onlyFiniteNumbers(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(onlyFiniteNumbers);
  if (value && typeof value === 'object') return Object.values(value).every(onlyFiniteNumbers);
  return true;
}

test('the charging architecture follows the application — no OBC bolted onto everything', () => {
  ok(chargingArchitectureFor('ev').kind === 'obc', 'EV carries a real on-board charger');
  ok(chargingArchitectureFor('rv').kind === 'obc', 'RV: shore-power inverter/charger');
  ok(chargingArchitectureFor('marine').kind === 'shore', 'a vessel gets a marine shore-connection contract, not an EV OBC');
  ok(chargingArchitectureFor('ebike').kind === 'external', 'e-bike: the charger is an external brick');
  ok(chargingArchitectureFor('wearable').kind === 'host', 'wearable: the host device owns charging');
  ok(chargingArchitectureFor('solar-ess').kind === 'pcs', 'storage: the PCS IS the AC side, no "OBC"');
  ok(chargingArchitectureFor('robovac').kind === 'dock', 'robot vacuum: the dock converts AC to DC');
  ok(/pantograph|depot/i.test(chargingArchitectureFor('ebus').note), 'e-bus honesty: DC depot/pantograph, OBC optional');
  // Every preset resolves to SOME architecture with a real note.
  for (const pr of PRESETS) {
    const a = chargingArchitectureFor(pr.id);
    ok(['obc', 'shore', 'external', 'pcs', 'dock', 'host'].includes(a.kind) && a.note.length > 20,
      `${pr.id}: charging architecture stated (${a.kind})`);
  }
});

test('charge-time math, hand-checked: CC phase, CV tail, and the named bottleneck', () => {
  // 60 kWh pack on an 11 kW OBC at 93%: 20→80% is pure CC.
  // t = 36 kWh / 10.23 kW = 3.519 h.
  const t = chargeTime({ energyWh: 60000, socFrom: 0.2, socTo: 0.8, sourceKW: 11, efficiency: OBC_EFFICIENCY });
  near(t.hours, 36 / (11 * OBC_EFFICIENCY), 1e-9, '20→80% = E / (P·η), no CV inside the knee');
  ok(t.cvHours === 0, 'no CV below the knee');
  // 10→100%: CC covers 10→80 (42 kWh), CV covers 80→100 (12 kWh at taper).
  const tf = chargeTime({ energyWh: 60000, socFrom: 0.1, socTo: 1.0, sourceKW: 11, efficiency: OBC_EFFICIENCY });
  near(tf.ccHours, 42 / (11 * OBC_EFFICIENCY), 1e-9, 'CC portion');
  near(tf.cvHours, 12 / (11 * OBC_EFFICIENCY * CV_TAPER), 1e-9, 'CV tail at the taper factor');
  ok(tf.hours > tf.ccHours, 'the last 20% costs disproportionate time — the CV story');
  // The bottleneck is NAMED: a pack that only accepts 5 kW beats a 22 kW OBC.
  const lim = chargeTime({ energyWh: 60000, socFrom: 0.2, socTo: 0.8, sourceKW: 22, efficiency: OBC_EFFICIENCY, packChargeKW: 5 });
  ok(lim.limitedBy === 'pack' && /bottleneck/.test(lim.note), 'pack-limited case named');
  near(lim.hours, 36 / 5, 1e-9, 'time follows the pack limit, not the charger');
  const lim2 = chargeTime({ energyWh: 60000, socFrom: 0.2, socTo: 0.8, sourceKW: 3.6, efficiency: OBC_EFFICIENCY, packChargeKW: 30 });
  ok(lim2.limitedBy === 'source', 'charger-limited case named');
  ok(chargeTime({ energyWh: 0, sourceKW: 11 }) === null, 'null-safe');
  ok(CV_KNEE_SOC === 0.8, 'knee documented at 80%');
});

test('AC interface follows the target market', () => {
  ok(/Type 2/.test(acInterfaceFor('eu').connector) && /62196/.test(acInterfaceFor('eu').connector), 'EU: Type 2 / IEC 62196');
  ok(/J1772|NACS/.test(acInterfaceFor('us').connector), 'US: J1772 / NACS');
  ok(/GB\/T 20234/.test(acInterfaceFor('cn').connector), 'China: GB/T 20234');
  ok(/27930/.test(acInterfaceFor('cn').comms), 'China: GB/T 27930 comms');
  ok(acInterfaceFor('nowhere').connector.length > 0, 'unknown market falls back honestly');
});

test('strategies belong to the applications that really use them', () => {
  for (const st of CHARGE_STRATEGIES) {
    ok(st.pros?.length >= 2 && st.cons?.length >= 1 && st.appIds.length >= 1, `${st.id}: complete entry`);
  }
  const ebus = strategiesFor('ebus');
  ok(ebus.some((x) => x.id === 'depot-overnight') && ebus.some((x) => x.id === 'opportunity'),
    'e-bus gets the depot-vs-opportunity decision');
  ok(ebus.find((x) => x.id === 'opportunity').cons.some((c) => /C-rate|cycle/i.test(c)),
    'opportunity charging carries its cycle/thermal cost');
  ok(strategiesFor('ev').some((x) => x.id === 'public-dc'), 'EV gets DC fast charging');
  ok(strategiesFor('solar-ess').some((x) => x.id === 'tariff-window'), 'storage charges by dispatch');
  ok(!strategiesFor('wearable').some((x) => x.id === 'opportunity'), 'no pantographs on a wristwatch');
});

test('the orchestrated plan: OBC auto-choice and honest per-class output', () => {
  const c = cellById('samsung-inr21700-50e'); // rated charge 2.45 A on 4.9 Ah = 0.5C
  const ev = buildChargingPlan({ appId: 'ev', marketId: 'eu', energyWh: 60000, vNomV: 350, cell: c });
  ok(ev.obc != null, 'EV auto-selects an OBC');
  near(ev.chargeC, 0.5, 1e-9, 'charge C-rate derived from the datasheet current');
  near(ev.packChargeKW, 30, 1e-6, 'pack acceptance = C × energy');
  // 30 kW acceptance: even 22 kW AC is below it → auto lands on the largest class.
  ok(ev.obc.id === 'obc-22k', `auto lands on the largest class for a 60 kWh/0.5C pack (got ${ev.obc.id})`);
  ok(ev.t2080 && ev.t2080.limitedBy === 'source', 'and says the charger is the bottleneck');
  const small = buildChargingPlan({ appId: 'ev', marketId: 'eu', energyWh: 8000, vNomV: 350, cell: { ...c, maxContChargeA: 0.98 } });
  ok(small.obc.acKW * OBC_EFFICIENCY >= small.packChargeKW, 'auto: smallest non-bottleneck class');
  const forced = buildChargingPlan({ appId: 'ev', marketId: 'eu', energyWh: 60000, vNomV: 350, cell: c, obcOverride: 'obc-3k6' });
  ok(forced.obc.id === 'obc-3k6' && forced.t2080.hours > ev.t2080.hours, 'override honored, time follows');
  const ess = buildChargingPlan({ appId: 'solar-ess', marketId: 'eu', energyWh: 30000, vNomV: 48, cell: c });
  ok(ess.obc === null && ess.arch.kind === 'pcs', 'storage never gets an OBC — the PCS framing instead');
  const brick = buildChargingPlan({ appId: 'ebike', marketId: 'eu', energyWh: 500, vNomV: 36, cell: c });
  ok(brick.obc === null && brick.arch.kind === 'external', 'e-bike: external brick, nothing to select');
});

test('marine shore charging never invents an automotive plug, OBC or turnaround time', () => {
  const c = cellById('catl-302ah-lfp');
  const plan = buildChargingPlan({
    appId: 'marine', marketId: 'eu', energyWh: 24000, vNomV: 24, cell: c,
  });
  ok(plan.arch.kind === 'shore' && plan.obc === null, 'no automotive OBC is selected');
  ok(!/Type 2|J1772|CCS Combo/.test(`${plan.iface.connector} ${plan.iface.dcConnector}`),
    'no road connector is shown under a marine label');
  ok(/supplier, port and class evidence required/i.test(plan.iface.connector),
    'the missing interface evidence is named');
  ok(plan.t2080 === null && plan.t10100 === null,
    'source-free cell acceptance is not misreported as a shore turnaround time');
  ok(plan.shoreConnection.status === 'review'
    && plan.shoreConnection.diagnostics.some((item) => item.code === 'MARINE_SHORE_CONNECTION_REQUIRED'),
  'missing governed shore equipment is an explicit review result');
  ok(plan.packChargeKW > 0, 'cell charge acceptance remains available as a pack constraint');
});

test('a complete project-evidenced AC shore contract unlocks source-and-pack-limited turnaround', () => {
  const shoreConnection = acShoreContract();
  const c = cellById('catl-302ah-lfp');
  const plan = buildChargingPlan({
    appId: 'marine', marketId: 'eu', energyWh: 24000, vNomV: 24, cell: c, shoreConnection,
  });
  ok(plan.shoreConnection.status === 'pass' && plan.shoreConnection.complete,
    `complete contract passes (${plan.shoreConnection.diagnostics.map((item) => item.code).join(', ')})`);
  near(plan.shoreConnection.calculated.currentDerivedPowerKW, 11, 1e-12,
    'three-phase voltage/current/power-factor rating reconciles to declared real power');
  near(plan.shoreConnection.calculated.ratedPowerErrorPct, 0, 1e-10, 'power/current error is explicit');
  near(plan.t2080.dcKW, Math.min(11 * 0.94, plan.packChargeKW), 1e-12,
    'turnaround uses the smaller of source-after-losses and pack acceptance');
  ok(plan.t2080.hours > 0 && plan.t10100.hours > plan.t2080.hours,
    'both CC and CC/CV turnaround results are finite and ordered');
  ok(plan.shoreConnection.normalized.connector.id === shoreConnection.connector.id
    && plan.shoreConnection.normalized.evidence.revision === 'Rev C',
  'connector and controlled evidence identity remain visible');
  ok(!/Type 2|J1772|CCS|NACS/.test(plan.shoreConnection.sourceLabel),
    'the calculation uses only the declared non-automotive connector identity');
  ok(onlyFiniteNumbers(plan), 'a valid marine charging plan contains no NaN or Infinity');
});

test('DC and inclusive equipment-voltage boundaries pass without inventing AC fields', () => {
  const result = evaluateMarineShoreConnection({
    shoreConnection: dcShoreContract(), vNomV: 24, packChargeKW: 12,
  });
  ok(result.status === 'pass', `complete supplier-evidenced DC contract passes (${result.diagnostics.map((item) => item.code).join(', ')})`);
  near(result.calculated.currentDerivedPowerKW, 50, 1e-12, 'DC power is V × I');
  ok(result.normalized.phases === null && result.normalized.frequencyHz === null
    && result.normalized.powerFactor === null, 'AC-only values stay absent in DC mode');
  ok(result.normalized.efficiency === 1, 'unit efficiency is an accepted upper boundary');
  ok(result.calculated.limitedBy === 'pack' && result.calculated.effectiveChargeKW === 12,
    'pack acceptance remains the active DC limit');
  ok(result.normalized.evidence.kind === 'supplier' && result.normalized.evidence.date === '2000-02-29',
    'supplier evidence and a real leap-day boundary remain traceable');
  ok(onlyFiniteNumbers(result), 'the DC result contains no NaN or Infinity');
});

test('one-phase AC, exact voltage-range endpoints and exact power-tolerance boundary pass', () => {
  const contract = acShoreContract();
  contract.voltageV = 230;
  contract.phases = 1;
  contract.frequencyHz = 50;
  contract.powerFactor = 1;
  contract.ratedPowerKW = 3.6;
  contract.ratedCurrentA = (3.6 * (1 + MARINE_SHORE_POWER_TOLERANCE) * 1000) / 230;
  contract.efficiency = Number.MIN_VALUE;
  contract.outputVoltageMinV = 24;
  contract.outputVoltageMaxV = 24;
  const result = evaluateMarineShoreConnection({ shoreConnection: contract, vNomV: 24, packChargeKW: 1 });
  ok(result.status === 'fail'
    && result.diagnostics.some((item) => item.code === 'MARINE_SHORE_CONVERSION_POWER_INVALID'),
  'a positive but underflowing efficiency is refused instead of emitting an infinite charge time');

  contract.efficiency = 1;
  const boundary = evaluateMarineShoreConnection({ shoreConnection: contract, vNomV: 24, packChargeKW: 1 });
  ok(boundary.status === 'pass', `exact 5% consistency and inclusive voltage boundaries pass (${boundary.diagnostics.map((item) => item.code).join(', ')})`);
  near(boundary.calculated.ratedPowerErrorPct, 5, 1e-10, 'the exact documented tolerance is inclusive');
  ok(onlyFiniteNumbers(boundary), 'boundary output remains finite');
});

const requiredShoreFields = [
  'mode', 'voltageV', 'phases', 'frequencyHz', 'powerFactor', 'ratedPowerKW', 'ratedCurrentA',
  'efficiency', 'outputVoltageMinV', 'outputVoltageMaxV', 'connector.id', 'connector.name',
  'earthing.declared', 'earthing.scheme', 'isolation.declared', 'isolation.method',
  'interlock.declared', 'interlock.description',
  'emergencyDisconnect.declared', 'emergencyDisconnect.description',
  'evidence.kind', 'evidence.source', 'evidence.revision', 'evidence.date',
];

for (const field of requiredShoreFields) {
  test(`marine shore contract keeps ${field} incomplete and suppresses charge time when missing`, () => {
    const shoreConnection = removePath(copy(acShoreContract()), field);
    const plan = buildChargingPlan({
      appId: 'marine', marketId: 'eu', energyWh: 24000, vNomV: 24,
      cell: cellById('catl-302ah-lfp'), shoreConnection,
    });
    ok(plan.shoreConnection.status === 'review',
      `${field}: incomplete evidence remains review, not pass/fail by accident (${plan.shoreConnection.diagnostics.map((item) => item.code).join(', ')})`);
    ok(plan.shoreConnection.diagnostics.some((item) => item.field === field),
      `${field}: a field-specific diagnostic is exposed`);
    ok(plan.t2080 === null && plan.t10100 === null, `${field}: no turnaround is emitted`);
    ok(onlyFiniteNumbers(plan.shoreConnection), `${field}: refusal result contains no NaN or Infinity`);
  });
}

const invalidShoreFields = [
  ['mode', 'automotive'],
  ['voltageV', Infinity],
  ['phases', 2],
  ['frequencyHz', 0],
  ['powerFactor', 1.01],
  ['ratedPowerKW', 0],
  ['ratedCurrentA', NaN],
  ['efficiency', 1.01],
  ['outputVoltageMinV', -1],
  ['outputVoltageMaxV', Infinity],
  ['connector.id', 'CCS-Combo-2'],
  ['connector.name', 'Type 2 automotive inlet'],
  ['earthing.declared', false],
  ['isolation.declared', false],
  ['interlock.declared', false],
  ['emergencyDisconnect.declared', false],
  ['evidence.kind', 'uncontrolled-web-page'],
  ['evidence.date', '2023-02-29'],
];

for (const [field, invalid] of invalidShoreFields) {
  test(`marine shore contract fails ${field}=${String(invalid)} without non-finite output`, () => {
    const shoreConnection = setPath(copy(acShoreContract()), field, invalid);
    const plan = buildChargingPlan({
      appId: 'marine', marketId: 'eu', energyWh: 24000, vNomV: 24,
      cell: cellById('catl-302ah-lfp'), shoreConnection,
    });
    ok(plan.shoreConnection.status === 'fail',
      `${field}: invalid data fails (${plan.shoreConnection.diagnostics.map((item) => item.code).join(', ')})`);
    ok(plan.t2080 === null && plan.t10100 === null, `${field}: invalid data cannot unlock turnaround`);
    ok(onlyFiniteNumbers(plan.shoreConnection), `${field}: NaN/Infinity is normalized away`);
  });
}

test('power mismatch, reversed voltage range, out-of-range pack and DC/AC field mixing are explicit failures', () => {
  const mismatch = acShoreContract();
  mismatch.ratedCurrentA *= 1.051;
  const reversed = acShoreContract();
  reversed.outputVoltageMinV = 33;
  const dcWithAcFields = { ...dcShoreContract(), phases: 3, frequencyHz: 50, powerFactor: 1 };
  const cases = [
    [mismatch, 24, 'MARINE_SHORE_POWER_CURRENT_MISMATCH'],
    [reversed, 24, 'MARINE_SHORE_OUTPUT_RANGE_INVALID'],
    [acShoreContract(), 48, 'MARINE_SHORE_PACK_VOLTAGE_INCOMPATIBLE'],
    [dcWithAcFields, 24, 'MARINE_SHORE_DC_AC_FIELDS_INCOMPATIBLE'],
  ];
  for (const [shoreConnection, vNomV, code] of cases) {
    const result = evaluateMarineShoreConnection({ shoreConnection, vNomV, packChargeKW: 12 });
    ok(result.status === 'fail' && result.diagnostics.some((item) => item.code === code), `${code}: explicit fail diagnostic`);
    ok(result.calculated.shoreToPackKW === null && result.calculated.effectiveChargeKW === null,
      `${code}: incompatible hardware has no available charge power`);
    ok(onlyFiniteNumbers(result), `${code}: result remains finite`);
  }
});

test('missing pack acceptance keeps an otherwise complete shore contract under review', () => {
  const result = evaluateMarineShoreConnection({ shoreConnection: acShoreContract(), vNomV: 24, packChargeKW: null });
  ok(result.status === 'review'
    && result.diagnostics.some((item) => item.code === 'MARINE_SHORE_PACK_ACCEPTANCE_REQUIRED'),
  'cell-derived pack acceptance is mandatory');
  ok(result.calculated.effectiveChargeKW === null, 'no source-only result is promoted as pack turnaround');
});

test('a shore contract argument cannot change road charging behavior', () => {
  const args = {
    appId: 'ev', marketId: 'eu', energyWh: 60000, vNomV: 350,
    cell: cellById('samsung-inr21700-50e'), obcOverride: 'obc-11k',
  };
  const road = buildChargingPlan(args);
  const roadWithMarineData = buildChargingPlan({ ...args, shoreConnection: acShoreContract() });
  ok(JSON.stringify(roadWithMarineData) === JSON.stringify(road),
    'marine-only contract is ignored byte-for-byte on the existing road path');
  ok(!Object.prototype.hasOwnProperty.call(road, 'shoreConnection'),
    'road output shape remains unchanged');
});

test('mission charge segments: top-ups and base charging change the outcome', () => {
  const CELL = {
    name: 't', chemistry: 'NMC', vMin: 3.0, vMax: 4.2, capacityAh: 30,
    dcirMOhm: 10, massG: 200, tempChargeC: [0, 45], tempDischargeC: [-20, 60],
  };
  const drain = { dtS: 60, p: Array.from({ length: 30 }, () => 0.8) }; // heavy half-hour
  const base = { cell: CELL, s: 10, p: 1, profile: drain, scaleW: 2000, passes: 2, ambientC: 25, resistanceMOhm: 100 };
  const none = simulateMission({ ...base });
  const topup = simulateMission({ ...base, charge: { mode: 'topup', powerW: 15000, minutes: 20 } });
  const atBase = simulateMission({ ...base, charge: { mode: 'base', powerW: 15000, minutes: 120 } });
  ok(topup.summary.minSoC > none.summary.minSoC, 'top-ups keep the minimum SoC higher');
  ok(atBase.summary.endSoC > none.summary.endSoC, 'base charge refills at the end');
  ok(topup.summary.chargedWh > 0 && atBase.summary.chargedWh > 0, 'commanded charge is booked separately');
  ok(atBase.summary.chargeMode === 'base', 'mode recorded');
  // A commanded charge that fills the pack is completion, not "regen lost".
  const overfill = simulateMission({ ...base, passes: 1, startSoC: 0.9, scaleW: 100, charge: { mode: 'base', powerW: 20000, minutes: 240 } });
  ok(overfill.summary.endSoC >= 0.999, 'charges to full');
  ok(!overfill.findings.some((f) => /regen lost/.test(f.title)), 'no lost-regen warning for a finished charge');
  // Winter depot charge without a heater is refused — the physics carries over.
  const cold = simulateMission({ ...base, passes: 1, ambientC: -10, uaWK: 50, thermalMassJK: 5000, startSoC: 0.5, charge: { mode: 'base', powerW: 15000, minutes: 60 } });
  ok(cold.summary.chargeRefusedWh > 0 && cold.findings.some((f) => /Charging inhibited/.test(f.title)),
    'sub-zero base charge inhibited without the heater branch');
});

test('the knowledge graph keeps charger classes away from gadgets', () => {
  ok(needed('ev', 'ac-side') && needed('rv', 'ac-side') && needed('solar-ess', 'ac-side'),
    'vehicles, RVs and storage get the AC-side concept');
  ok(needed('powerstation', 'ac-side'), 'power stations too — they truly carry a charger');
  ok(!needed('wearable', 'ac-side') && !needed('powertool', 'ac-side') && !needed('robovac', 'ac-side'),
    'gadgets and docked robots never meet OBC classes in training');
  ok(needed('ebus', 'charging-strategy') && needed('robot', 'charging-strategy'),
    'fleets get the strategy decision');
  ok(!needed('wearable', 'charging-strategy'), 'a watch has no charging strategy to choose');
});

test('OBC table sanity', () => {
  ok(OBC_CLASSES.length === 4 && OBC_CLASSES.every((o) => o.acKW > 0 && o.phases >= 1 && o.when),
    'OBC classes complete');
  ok(obcById('obc-11k').phases === 3 && obcById('nope') === null, 'lookup');
  ok(OBC_EFFICIENCY > 0.85 && OBC_EFFICIENCY < 1, 'efficiency is a stated class estimate');
});
