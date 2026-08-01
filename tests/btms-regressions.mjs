// Regressions for the thermal management SYSTEM layer: loop selection,
// first-order coolant flow (ṁ = Q/(c_p·ΔT)), chiller coupling to the
// higher system, the heater decision, and the BTMS control unit that only
// exists for active systems.
import { cellById } from '../js/cells.js';
import { buildThermalSystem, loopById, LOOP_TYPES, COOLANT, CHILLER_COP } from '../js/btms.js';
import { supervisorForApp } from '../js/architecture.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`);

const cell = cellById('samsung-inr21700-50e'); // charge floor 0 °C

// --- loop selection scale rule ----------------------------------------------
{
  ok(buildThermalSystem({ heatContW: 5, ambientC: [10, 30], cell }).loopId === 'passive-air',
    'watt-class heat -> passive air');
  ok(buildThermalSystem({ heatContW: 200, ambientC: [10, 30], cell }).loopId === 'forced-air',
    'hundreds of watts -> forced air');
  ok(buildThermalSystem({ heatContW: 1500, ambientC: [0, 25], cell }).loopId === 'liquid',
    'kW heat, mild ambient -> liquid radiator loop');
  ok(buildThermalSystem({ heatContW: 1500, ambientC: [10, 40], cell }).loopId === 'liquid-chiller',
    'kW heat + hot ambient -> chiller (cannot cool below ambient with a radiator)');
  ok(buildThermalSystem({ heatContW: 6000, ambientC: [0, 25], cell }).loopId === 'liquid-chiller',
    'many kW -> chiller regardless of climate');
}

// --- the selected hardware floors the loop ----------------------------------
{
  const pumped = { name: 'Bottom cold plate', needsPump: true, kind: 'cold-plate', htcWm2K: [400, 1200] };
  const T = buildThermalSystem({ heatContW: 100, ambientC: [10, 30], cooling: pumped, cell });
  ok(T.loopId === 'liquid', 'a pumped plate IS a liquid loop even at low heat');
  const over = buildThermalSystem({ heatContW: 100, ambientC: [10, 30], cooling: pumped, cell, override: 'forced-air' });
  ok(over.loopId === 'forced-air' && over.notes.some((n) => /hardware disagrees/.test(n)),
    'override below the hardware floor is shown but called out');
}

// --- first-order flow math (brief §6.3) -------------------------------------
{
  const T = buildThermalSystem({ heatContW: 3600, ambientC: [0, 25], cell });
  // 3.6 kW / (3.6 kJ/kgK · 1.07 kg/L · 5 K) · 60 s ≈ 11.2 L/min
  near(T.flowLpm, (3.6 / (COOLANT.cpKJperKgK * COOLANT.rhoKgPerL * COOLANT.dTdesignK)) * 60, 1e-9,
    'flow = Q/(c_p·ρ·ΔT)');
  ok(T.flowLpm > 11 && T.flowLpm < 12, `flow lands ~11.2 L/min (got ${T.flowLpm.toFixed(1)})`);
  ok(buildThermalSystem({ heatContW: 200, ambientC: [10, 30], cell }).flowLpm === null,
    'no coolant flow for air systems');
}

// --- chiller couples to the HIGHER system -----------------------------------
{
  const T = buildThermalSystem({ heatContW: 5000, ambientC: [10, 40], cell });
  near(T.compressorKW, 5 / CHILLER_COP, 1e-9, 'compressor = chiller duty / COP');
  ok(T.loop.components.some((c) => /OWNED BY THE HIGHER SYSTEM/.test(c)),
    'compressor/condenser named as higher-system property');
  ok(T.control.drives.some((d) => /chiller request/.test(d)), 'BTMS requests chiller duty from above');
  ok(T.notes.some((n) => /higher system/i.test(n)), 'higher-system note present');
}

// --- heater decision from the climate window --------------------------------
{
  ok(buildThermalSystem({ heatContW: 1000, ambientC: [-10, 25], cell }).heaterNeeded,
    'sub-zero design ambient -> heater branch required');
  ok(!buildThermalSystem({ heatContW: 1000, ambientC: [5, 25], cell }).heaterNeeded,
    'ambient above the charge floor -> no heater');
  const T = buildThermalSystem({ heatContW: 1000, ambientC: [-10, 25], cell });
  ok(T.control.drives.some((d) => /heater/.test(d)), 'heater branch driven by the BTMS');
}

// --- the BTMS control unit exists only for active systems -------------------
{
  ok(buildThermalSystem({ heatContW: 5, ambientC: [10, 30], cell }).control === null,
    'passive air has no control unit');
  const T = buildThermalSystem({ heatContW: 1500, ambientC: [0, 25], cell });
  ok(/BTMS/.test(T.control.name), 'active loop gets the BTMS ECU');
  ok(/BMS protects.*BTMS moves heat.*supervisor decides/.test(T.control.note),
    'the three-unit hierarchy is stated');
  // And the hierarchy's top exists for every application (spot check).
  ok(/EMS/.test(supervisorForApp('solar-ess').name), 'the supervisor above the BTMS is real');
}

// --- data sanity ------------------------------------------------------------
ok(LOOP_TYPES.length === 4 && LOOP_TYPES.every((l) => l.id && l.name && l.when), 'loop table complete');
ok(loopById('liquid') && loopById('nope') === null, 'loop lookup');

console.log(fails === 0 ? 'BTMS REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
