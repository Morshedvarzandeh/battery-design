// Architecture — the module hierarchy + electrical architecture layer:
// divisor-enumeration partition (cell-to-pack first-class), BMS topology and
// counts, precharge math, contactor/fuse rules, isolation-as-argument, and
// the closest-possible framing in maxFill (never a silent dead end).
import { test } from 'node:test';
import { ok, near, throws } from './helpers.mjs';
import { CELLS, cellById } from '../js/cells.js';
import {
  divisors, modulePartition, systemPlan, voltageClass, bmsArchitecture,
  prechargeDesign, contactorsAndFuse, isolationRequirement, dcdcConverter,
  packResistanceModel, buildArchitecture, DAISY_NODE_LIMIT,
  commsForApp, weldingForCell,
  assessBmsTopology, BMS_TOPOLOGIES, assessEmsArchitecture, emsArchitectureFor,
} from '../js/architecture.js';
import { maxFill } from '../js/optimizer.js';

const cyl = cellById('samsung-inr21700-50e');

test('divisors: the brief §4.2 enumeration', () => {
  ok(cyl, 'reference cell exists');
  ok(JSON.stringify(divisors(96)) === JSON.stringify([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 96]),
    'divisors(96) matches the brief §4.2 set');
  ok(JSON.stringify(divisors(97)) === JSON.stringify([1, 97]), 'divisors of a prime');
});

test('module partition: S_mod always divides S, bookkeeping exact', () => {
  // S_mod must always DIVIDE S — divisor enumeration, not free choice.
  for (const s of [13, 24, 96, 97, 108, 220]) {
    const part = modulePartition(s, 4, cyl);
    ok(s % part.sMod === 0, `sMod ${part.sMod} divides S=${s}`);
    ok(4 % part.pMod === 0, `pMod divides P for S=${s}`);
    ok(part.nModules === (s / part.sMod) * (4 / part.pMod), `nModules formula S=${s}`);
    ok(part.senseWiresPerModule === part.sMod + 1, `sense wires = sMod+1 for S=${s}`);
  }
  // Sanity anchor: 96S with 24-channel AFEs -> 4 modules of 24S (the Tesla
  // Model 3 architecture).
  const m3 = modulePartition(96, 46, cyl, { channelsPerIc: 24 });
  ok(m3.sMod === 24 && m3.nModules === 4, `96S @24ch -> 4x24S (got ${m3.nModules}x${m3.sMod}S)`);
  // 96S with 16-channel AFEs -> 6 modules of 16S.
  const p16 = modulePartition(96, 2, cyl, { channelsPerIc: 16 });
  ok(p16.sMod === 16 && p16.nModules === 6 && !p16.virtual, '96S @16ch -> 6x16S');
  // Cell-to-pack is FIRST-CLASS: a string one AFE can sense stays one
  // virtual group, no physical module tier.
  const ctp = modulePartition(13, 4, cyl, { channelsPerIc: 16 });
  ok(ctp.virtual && ctp.nModules === 1 && ctp.sMod === 13, '13S collapses to cell-to-pack');
  // Prime S beyond one AFE: honest virtual grouping plus a divisor hint,
  // never an invented partition.
  const prime = modulePartition(97, 1, cyl, { channelsPerIc: 16 });
  ok(prime.virtual && prime.nModules === 1, 'prime 97S stays one virtual group');
  ok(prime.notes.some((n) => n.includes('no even split')), 'prime S carries the divisor hint');
  // Module energy/mass bookkeeping.
  const part = modulePartition(96, 2, cyl, { channelsPerIc: 16 });
  near(part.moduleEnergyWh, 16 * 2 * cyl.nominalV * cyl.capacityAh, 1e-6, 'module energy');
  near(part.moduleMassCellsKg, (16 * 2 * cyl.massG) / 1000, 1e-9, 'module cells mass');
  ok(part.lvModule === (16 * cyl.vMax <= 60), 'LV-module flag from vMax');
});

test('system plan: the clear limit for big applications', () => {
  const plan = systemPlan(1_000_000, 120_000); // 1 MWh target, 120 kWh pack
  ok(plan.racks === 9, `1 MWh / 120 kWh -> 9 racks (got ${plan.racks})`);
  ok(plan.totalWh >= 1_000_000, 'racks cover the target');
  const one = systemPlan(50_000, 120_000);
  ok(one.racks === 1, 'target under one pack -> 1 rack');
  ok(systemPlan(null, 120_000) === null && systemPlan(1000, 0) === null, 'null-safe');
});

test('voltage classes: the 60 V DC boundary is exact', () => {
  ok(voltageClass(48).id === 'lv', '48 V is LV');
  ok(voltageClass(60).id === 'lv' && voltageClass(60.1).id !== 'lv', '60 V DC boundary exact');
  ok(voltageClass(400).id === 'hv-400', '400 V class');
  ok(voltageClass(800).id === 'hv-800', '800 V class');
  ok(voltageClass(1200).id === 'hv-1000+', 'beyond automotive classes flagged');
  ok(voltageClass(450).note.includes('semiconductor'), 'classes stated as semiconductor classes');
});

test('BMS architecture: topology suggestion, AFE counts, honest notes', () => {
  const part = modulePartition(96, 2, cyl, { channelsPerIc: 16 });
  const bms = bmsArchitecture({ s: 96, cellCount: 192, partition: part, topology: 'auto', channelsPerIc: 16 });
  ok(bms.topology === 'master-slave', 'several modules -> master/slave suggested');
  ok(bms.afeTotal === 6, `AFE count 96/16 (got ${bms.afeTotal})`);
  ok(bms.notes.some((n) => n.includes('no quantitative crossover')), 'auto rule admits there is no sourced crossover');
  const ctp = modulePartition(13, 4, cyl, { channelsPerIc: 16 });
  const bmsC = bmsArchitecture({ s: 13, cellCount: 52, partition: ctp, topology: 'auto', channelsPerIc: 16 });
  ok(bmsC.topology === 'centralized', 'one group -> centralized suggested');
  ok(bmsC.tempSensors === Math.ceil(52 / 6), 'temp sensor count from ratio');
  ok(bmsC.tempSensorsObservability === Math.ceil(52 / 3), 'observability-optimal 1:3 reported');
  // Daisy-chain node limit surfaces as a note, not silence.
  const bigPart = { sMod: 2, pMod: 1, nModules: 150, senseWiresPerModule: 3, senseWiresTotal: 450 };
  const big = bmsArchitecture({ s: 300, cellCount: 300, partition: bigPart, topology: 'master-slave', channelsPerIc: 2 });
  ok(big.daisyNodes > DAISY_NODE_LIMIT && big.notes.some((n) => n.includes('chain limit')),
    'over-limit daisy chain warns');
  // Explicit topology is honored.
  const w = bmsArchitecture({ s: 96, cellCount: 192, partition: part, topology: 'wireless', channelsPerIc: 16 });
  ok(w.topology === 'wireless' && w.notes.some((n) => n.includes('latency')), 'wireless honesty note');
});

test('precharge: tau, resistor, energy, sequence order', () => {
  const pre = prechargeDesign({ vPackMaxV: 400, linkCapUF: 500, closeGapV: 10, targetTimeS: 0.5, prechargesPerHour: 4 });
  // tau = t / ln(V/gap); R = tau/C; E = 0.5*C*V^2.
  const tau = 0.5 / Math.log(400 / 10);
  near(pre.tauS, tau, 1e-9, 'tau from close-in time');
  near(pre.rOhm, tau / 500e-6, 1e-6, 'R = tau/C');
  near(pre.energyPerEventJ, 0.5 * 500e-6 * 400 * 400, 1e-9, 'E = 0.5*C*V^2');
  near(pre.avgPowerDuringEventW, pre.energyPerEventJ / 0.5, 1e-9, 'P_avg = E/t');
  near(pre.continuousDissipationW, (pre.energyPerEventJ * 4) / 3600, 1e-9, 'repetition-rate dissipation');
  // V(t) at the stated time really lands within the gap.
  const vAtT = 400 * (1 - Math.exp(-0.5 / pre.tauS));
  ok(400 - vAtT <= pre.closeGapV + 1e-6, 'link within the gap at close time');
  // Sequence order per §5.5: main negative first, main positive only after
  // the wait, precharge opened last.
  const seq = pre.sequence.join(' | ');
  ok(seq.indexOf('NEGATIVE') < seq.indexOf('precharge contactor') &&
    seq.indexOf('Wait') < seq.indexOf('POSITIVE'), 'closing sequence order');
  ok(prechargeDesign({ vPackMaxV: 8 }) === null, 'no precharge below the gap voltage');
});

test('contactors, fuse, isolation, DC-DC, pack resistance', () => {
  const k = contactorsAndFuse({ contA: 200, vMaxV: 400 });
  ok(k.fuse.ratingA === 400, 'fuse = 2x continuous');
  ok(k.massEachG === 350, 'contactor mass 150 g + 1 g/A');
  ok(k.mains === 2 && k.precharge === 1, 'two mains + one precharge');
  ok(k.lvNote === null, 'no LV note on an HV pack');
  ok(contactorsAndFuse({ contA: 100, vMaxV: 48 }).lvNote != null, 'LV packs get the solid-state note');

  // Isolation: the standard is an explicit argument. 400 V -> 200 kOhm at
  // 500 Ohm/V, 40 kOhm at 100 Ohm/V DC — never averaged.
  near(isolationRequirement(400, 'ece-r100').floorKOhm, 200, 1e-9, 'ECE R100 floor');
  near(isolationRequirement(400, 'iso-6469-dc').floorKOhm, 40, 1e-9, 'ISO 6469-3 DC floor');
  near(isolationRequirement(800, 'ece-r100').floorKOhm, 400, 1e-9, '800 V floor');
  throws(() => isolationRequirement(400), 'missing standard throws instead of defaulting silently');

  const d = dcdcConverter({ vMin: 300, vMax: 403, lvBusV: 12 });
  ok(d.sizingNote.includes('no default'), 'aux budget honesty when unstated');
  ok(d.chargingNote === null, 'no 800V charging note for a 400V pack');
  ok(dcdcConverter({ vMin: 600, vMax: 900 }).chargingNote != null, '800V-class charging trade-off attached');

  const r = packResistanceModel({ s: 96, p: 2, cellDcirMOhm: 20, interconnectMOhm: 20, contA: 100 });
  near(r.cellsMOhm, (96 * 20) / 2, 1e-9, 'R_pack cells term S*R/P');
  near(r.totalMOhm, 980, 1e-9, 'interconnect added');
  near(r.droopVAtCont, 98, 1e-9, 'droop I*R');
  ok(packResistanceModel({ s: 10, p: 1, cellDcirMOhm: null }).totalMOhm === null, 'null DCIR stays null');
});

test('orchestrator: every section present, LV boundary respected', () => {
  const summary = {
    cellCount: 192, nominalV: 96 * cyl.nominalV, vMax: 96 * cyl.vMax, vMin: 96 * cyl.vMin,
    energyWh: 192 * cyl.nominalV * cyl.capacityAh, maxContCurrentA: 2 * cyl.maxContDischargeA,
  };
  const A = buildArchitecture({
    cell: cyl, s: 96, p: 2, summary,
    options: { isolationStandard: 'ece-r100', targetEnergyWh: 1_000_000 },
  });
  ok(A.partition && A.bms && A.precharge && A.contactors && A.isolation && A.dcdc && A.resistance,
    'orchestrator returns every section');
  ok(A.isolation.floorKOhm > 0, 'HV pack gets an isolation floor');
  ok(A.system.racks > 1, 'MWh target reports the rack count');
  // LV pack: no isolation section (that is the point of the 60 V boundary).
  const lvSummary = { cellCount: 52, nominalV: 13 * cyl.nominalV, vMax: 13 * cyl.vMax, vMin: 13 * cyl.vMin, energyWh: 900, maxContCurrentA: 39.2 };
  const lv = buildArchitecture({ cell: cyl, s: 13, p: 4, summary: lvSummary, options: {} });
  ok(lv.isolation === null, 'LV pack skips the isolation floor');
  ok(lv.voltageClass.id === 'lv', 'LV class detected');
});

test('closest-possible framing in maxFill: never a silent dead end', () => {
  const env = { x: 300, y: 200, z: 90 };
  const base = { spacingMm: 1, wallMm: 2, layerGapMm: 2, coolingSpace: { bottom: 0, side: 0, rowGap: 0 } };
  // An unreachable energy target must NOT empty the results — the tool
  // presents the most possible solution with the shortfall stated.
  const req = { vRange: [36, 52], energyWh: 50_000, weights: { energy: 5, cost: 3, mass: 2 } };
  const res = maxFill(CELLS, env, req, base, 12);
  ok(res.length > 0, 'unreachable target still returns closest-possible candidates');
  for (const r of res) {
    ok(r.meetsEnergy === false, `${r.cell.id} flagged as below target`);
    ok(r.energyCoverage != null && r.energyCoverage < 1, `${r.cell.id} coverage < 1`);
    ok(r.targetEnergyWh === 50_000, 'target carried on the candidate');
  }
  // With no target, nothing is flagged and ranking is by score.
  const free = maxFill(CELLS, env, { vRange: [36, 52], weights: { energy: 5, cost: 3, mass: 2 } }, base, 12);
  ok(free.every((r) => r.meetsEnergy === true && r.energyCoverage === null), 'no target -> no flags');
  for (let i = 1; i < free.length; i++) ok(free[i - 1].score >= free[i].score, 'no target -> sorted by score');
  // With a reachable target, designs that meet it rank ahead of those that don't.
  const reachable = maxFill(CELLS, env, { vRange: [36, 52], energyWh: 500, weights: { energy: 5, cost: 3, mass: 2 } }, base, 12);
  const firstMiss = reachable.findIndex((r) => !r.meetsEnergy);
  const lastMeet = reachable.map((r) => r.meetsEnergy).lastIndexOf(true);
  ok(firstMiss === -1 || firstMiss > lastMeet, 'meets-target candidates rank first');
});

test('communication standards per application', () => {
  ok(/CAN/.test(commsForApp('ev').primary) && /UDS|14229/.test(commsForApp('ev').primary),
    'automotive: CAN + UDS diagnostics');
  ok(commsForApp('ev').alternates.some((a) => /J1939/.test(a)), 'heavy trucks: J1939 named for the EV family');
  ok(/CANopen/.test(commsForApp('robot').primary), 'AGV: CANopen primary');
  ok(commsForApp('robot').alternates.some((a) => /J1939/.test(a)), 'lift trucks inherit the J1939 bus');
  ok(/Modbus/.test(commsForApp('solar-ess').primary), 'stationary storage: Modbus/SunSpec');
  ok(/NMEA/.test(commsForApp('marine').primary), 'marine: NMEA 2000');
  ok(commsForApp('does-not-exist').primary.length > 0, 'unknown app falls back honestly');
});

test('welding / joining per cell format', () => {
  ok(/Resistance spot/i.test(weldingForCell({ form: 'cylindrical' }).primary), 'cylindrical: resistance spot weld');
  ok(/Laser/i.test(weldingForCell({ form: 'prismatic' }).primary), 'prismatic: laser weld to terminal');
  ok(/Ultrasonic/i.test(weldingForCell({ form: 'pouch' }).primary), 'pouch: ultrasonic tab weld');
  ok(weldingForCell({ form: 'cylindrical' }).alternates.some((a) => /wire bond/i.test(a)),
    'cylindrical lists the wire-bond (per-cell fuse) route');
  ok(weldingForCell({ form: 'unknown' }) === null, 'unknown form returns null, not a guess');
});

test('customer-set stack count (BESS / ship / bus scale)', () => {
  const summary = {
    cellCount: 192, nominalV: 96 * cyl.nominalV, vMax: 96 * cyl.vMax, vMin: 96 * cyl.vMin,
    energyWh: 192 * cyl.nominalV * cyl.capacityAh, maxContCurrentA: 2 * cyl.maxContDischargeA,
  };
  const A = buildArchitecture({
    cell: cyl, s: 96, p: 2, summary,
    options: { isolationStandard: 'ece-r100', targetEnergyWh: 50_000, racksOverride: 8 },
  });
  ok(A.system.overridden === true && A.system.racks === 8, 'explicit stack count wins over auto');
  ok(Math.abs(A.system.totalWh - 8 * summary.energyWh) < 1e-6, 'total = racks × pack energy');
  ok(Math.abs(A.system.coveragePct - (A.system.totalWh / 50_000) * 100) < 1e-9,
    'coverage reported against the target when the stacks fall short');
  const plenty = buildArchitecture({
    cell: cyl, s: 96, p: 2, summary,
    options: { isolationStandard: 'ece-r100', targetEnergyWh: 50_000, racksOverride: 20 },
  });
  ok(plenty.system.coveragePct === 100, 'coverage capped at 100% when the stacks exceed the target');
  const auto = buildArchitecture({
    cell: cyl, s: 96, p: 2, summary,
    options: { isolationStandard: 'ece-r100', targetEnergyWh: 50_000 },
  });
  ok(!auto.system.overridden && auto.system.racks === Math.ceil(50_000 / summary.energyWh),
    'no override -> auto rack count from the target');
  ok(A.comms && A.welding, 'orchestrator carries comms and welding sections');
});

test('choice assessments: pros/cons + design-context verdicts', () => {
  // Every option carries pros AND cons — no free lunches in the table.
  for (const t of BMS_TOPOLOGIES) {
    ok(t.pros?.length >= 2 && t.cons?.length >= 2, `${t.id}: pros and cons stated`);
  }
  // The sourced hard limit: >62 daisy nodes as ONE chain is not buildable —
  // a FAIL verdict with the fix, not a footnote.
  const broken = assessBmsTopology({ topology: 'master-slave', s: 300, afeTotal: 80, nModules: 40 });
  ok(broken.verdict === 'not-workable', '>62-node chain: not workable');
  ok(/split into 2 parallel chains/.test(broken.why), 'the fix is named (split chains)');
  const fine = assessBmsTopology({ topology: 'master-slave', s: 96, afeTotal: 6, nModules: 6 });
  ok(fine.verdict === 'workable', 'in-limit chain: workable');
  ok(assessBmsTopology({ topology: 'wireless', s: 96, afeTotal: 6, nModules: 6 }).verdict === 'unproven',
    'wireless: unproven (no sourced data)');
  const central = assessBmsTopology({ topology: 'centralized', s: 96, afeTotal: 6, nModules: 6 });
  ok(central.verdict === 'workable-with-costs' && /harness/.test(central.why),
    'centralized across modules: workable with the harness cost named');
  // EMS: override marked with its costs, suggestion clean.
  ok(assessEmsArchitecture(emsArchitectureFor('solar-ess', 8)).verdict === 'suggested', 'EMS auto: suggested');
  const emsOv = assessEmsArchitecture(emsArchitectureFor('solar-ess', 8, 'centralized'));
  ok(emsOv.verdict === 'workable-with-costs' && emsOv.cons.length >= 2, 'EMS override: costs carried');
});
