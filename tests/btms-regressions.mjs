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

// --- suggested parts per side, named from the customer's own selection ------
{
  const bottomPlate = { name: 'Aluminium bottom cold plate (brazed channels)', needsPump: true, kind: 'cold-plate', viz: 'bottom', htcWm2K: [400, 1200] };
  const T = buildThermalSystem({ heatContW: 1500, ambientC: [0, 25], cooling: bottomPlate, cell });
  ok(T.coolantSide[0].includes('Bottom cold plate') && T.coolantSide[0].includes(bottomPlate.name),
    'coolant side leads with the customer\'s own plate, named verbatim');
  ok(T.coolantSide.some((x) => /pump/i.test(x)) && T.coolantSide.some((x) => /control valve/i.test(x)),
    'pump and control valve suggested');
  ok(T.refrigerantSide === null && T.airSide === null, 'radiator loop: no refrigerant/air side listed');
  ok(T.plateShort === 'bottom cold plate', 'diagram label matches the placement');
  const sidePlate = { ...bottomPlate, name: 'Side cold plates', viz: 'side' };
  ok(buildThermalSystem({ heatContW: 1500, ambientC: [0, 25], cooling: sidePlate, cell }).plateShort === 'side cold plates',
    'side plates named as side plates');
  const chill = buildThermalSystem({ heatContW: 5000, ambientC: [10, 40], cooling: bottomPlate, cell });
  ok(chill.refrigerantSide.some((x) => /expansion valve/i.test(x)) &&
     chill.refrigerantSide.some((x) => /HIGHER SYSTEM/.test(x)),
    'refrigerant side: EXV + higher-system compressor');
  const air = buildThermalSystem({ heatContW: 200, ambientC: [10, 30], cell });
  ok(air.airSide?.length > 0 && air.coolantSide === null, 'forced air: air side only');
}

// --- ram-air applications: real heat, free airflow, nothing to buy ----------
{
  const T = buildThermalSystem({ heatContW: 150, ambientC: [-10, 40], cell, appId: 'drone' });
  ok(T.loopId === 'forced-air' && T.ramAir === true, 'drone at 150 W: air-cooled by prop wash');
  ok(T.control === null, 'ram air: no BTMS ECU');
  ok(T.airSide.some((x) => /prop wash/.test(x)), 'ram-air hardware honesty (nothing to buy)');
  ok(buildThermalSystem({ heatContW: 150, ambientC: [-10, 40], cell, appId: 'ups' }).ramAir === false,
    'stationary systems never get the ram-air shortcut');
  ok(buildThermalSystem({ heatContW: 5000, ambientC: [10, 40], cell, appId: 'drone' }).ramAir === false,
    'kW-class heat escalates past ram air even for a drone');
}

// --- choice assessments: physics-backed verdicts ----------------------------
{
  for (const l of LOOP_TYPES) ok(l.pros?.length >= 2 && l.cons?.length >= 2, `${l.id}: pros and cons stated`);
  // Passive air under real heat: NOT workable, with the physical reason.
  const p = buildThermalSystem({ heatContW: 1500, ambientC: [0, 25], cell, override: 'passive-air' });
  ok(p.assessment.verdict === 'not-workable' && /beyond what/.test(p.assessment.why),
    'passive air at 1.5 kW: not workable, reason stated');
  // Radiator loop where the design must cool below ambient: NOT workable.
  const r = buildThermalSystem({ heatContW: 2000, ambientC: [10, 42], cell, override: 'liquid' });
  ok(r.assessment.verdict === 'not-workable' && /BELOW ambient/.test(r.assessment.why),
    'radiator-only in a hot climate: not workable — cannot cool below ambient');
  // Over-provisioning is legitimate, with its costs.
  const o = buildThermalSystem({ heatContW: 100, ambientC: [10, 25], cell, override: 'liquid-chiller' });
  ok(o.assessment.verdict === 'workable-with-costs', 'chiller for 100 W: workable, costs listed');
  // Auto matches -> suggested.
  ok(buildThermalSystem({ heatContW: 1500, ambientC: [0, 25], cell }).assessment.verdict === 'suggested',
    'auto choice: suggested');
}

// --- data sanity ------------------------------------------------------------
ok(LOOP_TYPES.length === 4 && LOOP_TYPES.every((l) => l.id && l.name && l.when), 'loop table complete');
ok(loopById('liquid') && loopById('nope') === null, 'loop lookup');

console.log(fails === 0 ? 'BTMS REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
