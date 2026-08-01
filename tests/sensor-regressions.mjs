// Regressions for the sensor plan: levels, counts, and — the whole point —
// OMISSION. A wearable never lists coolant sensors, a drone never lists a
// runaway detector, a passive pack has no cooling group at all.
import { cellById } from '../js/cells.js';
import { buildSensorPlan } from '../js/sensors.js';
import { buildArchitecture } from '../js/architecture.js';
import { buildThermalSystem } from '../js/btms.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } };

const level = (plan, name) => plan.groups.find((g) => g.level.startsWith(name)) || null;
const sensor = (plan, re) => plan.groups.flatMap((g) => g.sensors).find((s) => re.test(s.name)) || null;

const mkSummary = (cell, s, p) => ({
  cellCount: s * p, nominalV: s * cell.nominalV, vMax: s * cell.vMax, vMin: s * cell.vMin,
  energyWh: s * p * cell.nominalV * cell.capacityAh, maxContCurrentA: p * cell.maxContDischargeA,
});

// --- wearable: 1S LiPo, passive, nothing that isn't there -------------------
{
  const c = cellById('lipo-602030-300mah');
  const summary = mkSummary(c, 1, 1);
  const arch = buildArchitecture({ cell: c, s: 1, p: 1, summary, options: { appId: 'wearable' } });
  const therm = buildThermalSystem({ heatContW: 0.1, ambientC: [10, 35], cell: c });
  const plan = buildSensorPlan({ cell: c, s: 1, p: 1, summary, partition: arch.partition, bms: arch.bms, therm, selection: {} });
  ok(level(plan, 'Cell level') != null, 'wearable: cell level exists');
  ok(level(plan, 'Module level') == null, 'wearable: NO module group (virtual)');
  ok(level(plan, 'Cooling loop') == null, 'wearable: NO cooling group (passive)');
  ok(sensor(plan, /runaway/i) == null, 'wearable: NO runaway detector');
  ok(sensor(plan, /Isolation|HVIL/i) == null, 'wearable: no HV supervision');
  ok(sensor(plan, /voltage sense/i).count === 2, '1S -> 2 sense taps');
}

// --- drone: smart battery, still no coolant / runaway rows ------------------
{
  const c = cellById('generic-nmc-pouch-10ah-hp');
  const summary = mkSummary(c, 6, 1); // 6S flight pack, ~222 Wh
  const arch = buildArchitecture({ cell: c, s: 6, p: 1, summary, options: { appId: 'drone' } });
  const therm = buildThermalSystem({ heatContW: 30, ambientC: [-10, 40], cell: c });
  const plan = buildSensorPlan({ cell: c, s: 6, p: 1, summary, partition: arch.partition, bms: arch.bms, therm, selection: {} });
  ok(level(plan, 'Cooling loop') == null, 'drone: no coolant sensors');
  ok(sensor(plan, /runaway/i) == null, 'drone: no runaway detector at 222 Wh');
  ok(sensor(plan, /Pack current/i) != null && sensor(plan, /temperature sensors/i) != null,
    'drone: per-cell V taps, NTCs, current — the smart-battery set');
}

// --- EV: the full instrumented pack -----------------------------------------
{
  const c = cellById('samsung-inr21700-50e');
  const summary = mkSummary(c, 96, 2);
  const arch = buildArchitecture({ cell: c, s: 96, p: 2, summary, options: { appId: 'ev', isolationStandard: 'ece-r100' } });
  // Ambient high kept below 35 °C so the auto rule stays on the radiator
  // loop — the chiller case is exercised separately below.
  const therm = buildThermalSystem({ heatContW: 1500, ambientC: [-10, 30], cell: c });
  const ccsSel = { busbar: { kind: 'cell-contact-system', name: 'CCS' } };
  const plan = buildSensorPlan({ cell: c, s: 96, p: 2, summary, partition: arch.partition, bms: arch.bms, therm, selection: ccsSel });
  ok(level(plan, 'Module level') != null, 'EV: module group exists');
  ok(sensor(plan, /both sides of the contactors/i)?.count === 2, 'EV: pack V both sides (weld detection)');
  ok(sensor(plan, /Isolation monitor/i) != null && sensor(plan, /HVIL/i) != null, 'EV: isolation + HVIL');
  ok(sensor(plan, /runaway/i) != null, 'EV scale: runaway/vent-gas detection warranted');
  ok(/cell contact system/i.test(sensor(plan, /voltage sense/i).note), 'CCS carries the sense lines — noted');
  const cool = level(plan, 'Cooling loop');
  ok(cool != null && cool.sensors.some((s) => /Coolant temperature/.test(s.name)), 'EV: coolant in/out sensors');
  ok(cool.sensors.some((s) => /Heater/.test(s.name)), 'sub-zero window: heater guard sensor');
  ok(!cool.sensors.some((s) => /Refrigerant/.test(s.name)), 'no chiller -> no refrigerant sensors');
}

// --- chiller loop adds the refrigerant interface ----------------------------
{
  const c = cellById('samsung-inr21700-50e');
  const summary = mkSummary(c, 96, 2);
  const arch = buildArchitecture({ cell: c, s: 96, p: 2, summary, options: { isolationStandard: 'ece-r100' } });
  const therm = buildThermalSystem({ heatContW: 5000, ambientC: [10, 40], cell: c });
  const plan = buildSensorPlan({ cell: c, s: 96, p: 2, summary, partition: arch.partition, bms: arch.bms, therm, selection: {} });
  ok(level(plan, 'Cooling loop').sensors.some((s) => /Refrigerant/.test(s.name)),
    'chiller loop: refrigerant P/T at the interface to the higher system');
  ok(/harness/i.test(sensor(plan, /voltage sense/i).note), 'no CCS selected -> discrete harness noted');
}

// --- large LFP ESS: runaway detection still recommended (gas) ---------------
{
  const c = cellById('eve-lf280k');
  const summary = mkSummary(c, 16, 2); // ~29 kWh, 48 V class
  const arch = buildArchitecture({ cell: c, s: 16, p: 2, summary, options: { appId: 'solar-ess' } });
  const therm = buildThermalSystem({ heatContW: 300, ambientC: [15, 30], cell: c });
  const plan = buildSensorPlan({ cell: c, s: 16, p: 2, summary, partition: arch.partition, bms: arch.bms, therm, selection: {} });
  const rw = sensor(plan, /runaway/i);
  ok(rw != null, 'multi-kWh ESS: vent-gas detection listed even for LFP');
  ok(/vents less violently but still vents/i.test(rw.note), 'LFP honesty in the note');
}

console.log(fails === 0 ? 'SENSOR REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
