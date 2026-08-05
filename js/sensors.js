// sensors.js — the sensor plan for a design, organized the way sensor
// budgets are actually written: by LEVEL — cell, module, system, and the
// cooling loop. Integration is the rule here too: a sensor a system does
// not need is NOT listed with a dash, it is omitted entirely — a wearable
// shows no coolant sensors, a drone no thermal-runaway detector, an
// air-cooled pack no flow meter. Class names only; no supplier noise.
//
// Pure function over the design's existing models (partition/BMS from
// architecture.js, loop from btms.js, selected components, chemistry).

import { CHEMISTRIES } from './cells.js';

// System-level thermal-runaway detection is warranted by SCALE and
// CHEMISTRY, not by habit: GB 38031 demands a 5-minute occupant warning
// (EVs), UL 9540A data drives ESS siting — both need the pack to NOTICE a
// venting cell (gas/pressure/aerosol). A wearable or a power tool has
// nothing to instrument at system level.
function runawaySensorWarranted({ energyWh, chemistry, vMaxV }) {
  if ((energyWh ?? 0) < 2000 && (vMaxV ?? 0) <= 60) return null;
  const risk = CHEMISTRIES[chemistry]?.thermalRisk ?? 'medium';
  return {
    name: 'Thermal-runaway / vent-gas detection',
    count: 1,
    note: `${risk === 'high' ? 'Strongly recommended' : 'Recommended'} at this scale: gas (H2/CO/VOC) + pressure-spike sensing in the pack headspace — GB 38031 demands a 5-minute warning in EVs, UL 9540A data drives ESS siting.${risk === 'low' ? ' LFP-class chemistry vents less violently but still vents.' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// buildSensorPlan — everything the harness and connectors must carry.
//   cell, s, p, summary   — the design
//   partition, bms        — from buildArchitecture (levels + counts)
//   therm                 — from buildThermalSystem (loop sensors)
//   selection             — selected components (CCS detection on the busbar)
// Returns { groups: [{ level, sensors: [{name, count, note}] }], notes }.
// Groups a design does not need are absent, not empty.
// ---------------------------------------------------------------------------
export function buildSensorPlan({ cell, s, p, summary, partition, bms, therm, selection, conditionMonitoring = null }) {
  const groups = [];
  const notes = [];
  const hv = (summary?.vMax ?? 0) > 60;
  const ccs = /cell-contact-system/.test(selection?.busbar?.kind || '');

  // --- cell level -----------------------------------------------------------
  const cellSensors = [
    {
      name: 'Cell voltage sense taps',
      count: bms ? bms.senseWiresTotal : s + 1,
      note: ccs
        ? 'Carried by the selected cell contact system (CCS) — the sense lines are welded into its foil, no separate harness.'
        : 'Discrete sense harness or flex-PCB to every series group; route with the busbars, fuse each tap.',
    },
    {
      name: 'Cell temperature sensors (NTC)',
      count: bms?.tempSensors ?? Math.max(1, Math.ceil((s * p) / 6)),
      note: bms
        ? `1 per ${bms.cellsPerTempSensor} cells (input on the Analysis tab); observability-optimal is 1 per 3 (${bms.tempSensorsObservability}) — production spans 1:3 to 1:73.`
        : 'On the hottest cells: center of the pack and next to the terminals.',
    },
  ];
  groups.push({ level: 'Cell level', sensors: cellSensors });

  // --- module level (only when a physical module tier exists) ---------------
  if (partition && !partition.virtual && partition.nModules > 1) {
    groups.push({
      level: 'Module level',
      sensors: [
        {
          name: 'Slave AFE per module (measures its own cells)',
          count: partition.nModules * (bms?.afePerModule ?? 1),
          note: `${bms?.afePerModule ?? 1} AFE IC(s) per module; ${partition.senseWiresPerModule} sense wires each — the module connector must carry them.`,
        },
        {
          name: 'Module temperature (min. one per module)',
          count: partition.nModules,
          note: 'The per-cell NTC budget above must place at least one sensor in every module — an uninstrumented module is invisible.',
        },
      ],
    });
  }

  // --- system / pack level --------------------------------------------------
  const sys = [
    {
      name: 'Pack current sensor',
      count: 1,
      note: 'Shunt (precise, dissipates) or Hall (isolated, drifts) — SoC counting quality starts here; better than 1% class.',
    },
    {
      name: hv ? 'Pack voltage — both sides of the contactors' : 'Pack voltage',
      count: hv ? 2 : 1,
      note: hv
        ? 'Measuring link AND pack side proves the contactors actually opened/closed (weld detection) and drives the precharge close-within-10 V decision.'
        : 'One measurement point suffices below the 60 V boundary.',
    },
  ];
  if (hv) {
    sys.push({
      name: 'Isolation monitor',
      count: 1,
      note: 'Continuous Ω/V supervision against the floor on the Analysis tab; mandatory territory above 60 V DC.',
    });
    sys.push({
      name: 'HVIL (high-voltage interlock loop)',
      count: 1,
      note: 'A low-voltage loop through every HV connector and cover — opens, and the contactors drop.',
    });
  }
  const runaway = runawaySensorWarranted({
    energyWh: summary?.energyWh, chemistry: cell?.chemistry, vMaxV: summary?.vMax,
  });
  if (runaway) sys.push(runaway);
  groups.push({ level: 'System level', sensors: sys });

  // --- cooling loop (absent entirely for passive and ram-air systems: no
  // hardware means nothing to instrument) -----------------------------------
  if (therm && therm.loopId !== 'passive-air' && !therm.ramAir) {
    const loop = [];
    if (therm.loopId === 'forced-air') {
      loop.push({ name: 'Air temperature in/out', count: 2, note: 'Across the pack — the ΔT is the health signal for the airflow path.' });
      loop.push({ name: 'Fan tach feedback', count: 1, note: 'A stalled fan with no tach is discovered by the cells.' });
    } else {
      loop.push({ name: 'Coolant temperature in/out', count: 2, note: 'Pack inlet and outlet — the ΔT against the designed 5 K is the loop\'s health signal.' });
      loop.push({ name: 'Coolant flow (sensor or pump feedback)', count: 1, note: 'Confirms the L/min the sizing assumed actually flows; pump speed alone misses a blocked line.' });
      loop.push({ name: 'Coolant level / leak detection', count: 1, note: 'Expansion-tank level switch; leak sensing inside the pack where coolant runs between live parts.' });
      if (therm.loopId === 'liquid-chiller') {
        loop.push({ name: 'Refrigerant pressure + temperature at the chiller', count: 2, note: 'The interface point to the higher system\'s AC/HVAC circuit — its health is visible here.' });
      }
      if (therm.heaterNeeded) {
        loop.push({ name: 'Heater branch temperature', count: 1, note: 'Overtemperature guard on the PTC/film heater used for cold-weather charging.' });
      }
    }
    groups.push({ level: 'Cooling loop (read by the BTMS ECU)', sensors: loop });
  }

  notes.push('Only the sensors THIS design needs are listed — absent groups mean the system genuinely has nothing to instrument there, not an omission.');
  notes.push('Counts feed the connector pin-out and harness budget; sensor class names only — pick suppliers at sourcing, not here.');
  return { groups, notes, conditionMonitoring };
}
