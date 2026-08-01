// btms.js — the battery thermal management SYSTEM: not just the cold plate
// the pack touches, but the loop behind it (pump, radiator, chiller /
// refrigerant heat exchanger, valves, heater) and the BTMS control unit
// that runs it. The control hierarchy gains a third member: the BMS
// protects, the BTMS ECU moves heat, the supervisor (EMS/VCU) decides —
// they exchange temperatures, limits and requests over the same bus.
//
// HONESTY: loop selection has no single sourced crossover (like BMS
// topology), so it is a scale rule plus an override; coolant flow uses the
// first-order sizing from the pack brief §6.3 (ṁ = Q/(c_p·ΔT)) with
// stated water-glycol properties; chiller/compressor power uses a stated
// COP estimate. The refrigerant side (compressor, condenser) is owned by
// the HIGHER system — the vehicle's AC loop or the plant's HVAC — and the
// battery couples into it at the chiller plate heat exchanger.

export const LOOP_TYPES = [
  {
    id: 'passive-air',
    name: 'Passive air (natural convection)',
    when: 'Milliwatt–watt heat loads: wearables, small portable packs. No moving parts, no control unit.',
    components: [],
    activeControl: false,
  },
  {
    id: 'forced-air',
    name: 'Forced air (fans + ducting)',
    when: 'Tens to a few hundred watts with benign ambient: e-bikes, power stations, early EVs (Leaf class).',
    components: [
      'Fan(s) with tach/PWM control',
      'Inlet filter + ducting through the pack',
      'Air temperature sensors (inlet/outlet)',
    ],
    activeControl: true,
  },
  {
    id: 'liquid',
    name: 'Liquid loop (water-glycol, radiator)',
    when: 'Hundreds of watts to kilowatts, ambient below the target cell temperature: the mainstream EV/ESS loop.',
    components: [
      'Electric coolant pump (automotive class, PWM/LIN controlled)',
      'Cold plate / ribbon in the pack (the component picked on the Components tab)',
      'Radiator + fan (rejects to ambient)',
      '3-way valve (radiator / bypass, ± heater branch)',
      'Expansion tank + level sensor',
      'Coolant temperature sensors (pack in/out)',
      'PTC or film heater branch for cold-weather charging',
    ],
    activeControl: true,
  },
  {
    id: 'liquid-chiller',
    name: 'Liquid loop + refrigerant chiller',
    when: 'Kilowatt heat with hot ambient or fast-charge duty: the loop must cool BELOW ambient, so a refrigerant heat exchanger (chiller) couples the battery loop to the higher system\'s AC/HVAC circuit.',
    components: [
      'Everything in the liquid loop, plus:',
      'Chiller plate heat exchanger (coolant ↔ refrigerant)',
      'Electronic expansion valve on the refrigerant side',
      'Compressor + condenser — OWNED BY THE HIGHER SYSTEM (vehicle AC / plant HVAC); the battery interfaces at the chiller',
      'Refrigerant pressure/temperature sensors at the chiller',
    ],
    activeControl: true,
  },
];

export function loopById(id) {
  return LOOP_TYPES.find((l) => l.id === id) || null;
}

// Water-glycol 50/50 class properties for the first-order flow sizing.
export const COOLANT = { cpKJperKgK: 3.6, rhoKgPerL: 1.07, dTdesignK: 5 };
export const CHILLER_COP = 2.5; // battery-chiller class estimate — stated, not sourced

// ---------------------------------------------------------------------------
// buildThermalSystem — the Thermal tab's model for the CURRENT design.
// heatContW: pack heat at continuous load (from the engineering analysis).
// ambientC: [lo, hi] design window (the climate/season picker fills it).
// cooling: the selected cooling component (components.js record, may be null).
// cell: for the charge-temperature floor (heater decision).
// override: 'auto' | loop id — like BMS topology, the choice is an input.
// ---------------------------------------------------------------------------
// Applications cooled by their own motion: the airflow is free (prop wash,
// riding wind) — there are no fans, no ducting hardware and no BTMS ECU,
// even though the heat is genuinely carried away by air.
const RAM_AIR_APPS = new Set(['drone', 'ebike', 'escooter']);

export function buildThermalSystem({ heatContW, ambientC, cooling, cell, override, appId }) {
  const heat = Math.max(0, heatContW ?? 0);
  const [lo, hi] = ambientC || [0, 40];
  const notes = [];

  // Floor from the selected cooling hardware: a pumped plate or between-row
  // ribbon IS a liquid loop; a fan component IS forced air.
  const hwFloor = cooling?.needsPump ? 'liquid'
    : /air|fan/i.test(cooling?.kind || '') && cooling?.htcWm2K?.[1] > 15 ? 'forced-air'
      : null;

  // Scale rule (no sourced crossover exists — override is first-class):
  let auto = heat <= 40 ? 'passive-air'
    : heat <= 400 ? 'forced-air'
      : 'liquid';
  // Cooling below ambient is impossible with a radiator alone: hot climates
  // or kW-class heat push the loop onto the higher system's refrigerant.
  if ((hi >= 35 && heat > 800) || heat > 4000) auto = 'liquid-chiller';
  const order = ['passive-air', 'forced-air', 'liquid', 'liquid-chiller'];
  if (hwFloor && order.indexOf(hwFloor) > order.indexOf(auto)) auto = hwFloor;

  let loopId = override && override !== 'auto' ? override : auto;
  if (override && override !== 'auto' && order.indexOf(override) < order.indexOf(hwFloor ?? 'passive-air')) {
    notes.push(`The selected cooling hardware (${cooling?.name}) implies at least a ${hwFloor} system — the override is shown, but the hardware disagrees.`);
  }
  const loop = loopById(loopId) || LOOP_TYPES[0];
  const ramAir = loopId === 'forced-air' && RAM_AIR_APPS.has(appId);
  if (ramAir) {
    notes.push('This application is cooled by its own motion (ram air / prop wash) — the heat is real and air carries it, but there are no fans, no ducting and no thermal control unit to buy.');
  }

  // First-order coolant flow (brief §6.3): ṁ = Q/(c_p·ΔT), shown only for
  // liquid loops. L/min = kW / (cp · ρ · ΔT) · 60.
  const flowLpm = (loopId === 'liquid' || loopId === 'liquid-chiller') && heat > 0
    ? (heat / 1000 / (COOLANT.cpKJperKgK * COOLANT.rhoKgPerL * COOLANT.dTdesignK)) * 60
    : null;
  // Chiller duty and the compressor power it costs the higher system.
  const chillerKW = loopId === 'liquid-chiller' ? heat / 1000 : null;
  const compressorKW = chillerKW != null ? chillerKW / CHILLER_COP : null;

  // Heating is part of thermal management too: charging below the cell's
  // floor needs a heater branch (or a charge inhibit and patience).
  const chargeFloorC = cell?.tempChargeC?.[0] ?? 0;
  const heaterNeeded = lo < chargeFloorC;
  if (heaterNeeded) {
    notes.push(`Design ambient reaches ${lo} °C but charging is rated from ${chargeFloorC} °C — the loop needs a heater branch (PTC/film) or a charge inhibit with preconditioning time.`);
  }

  // The BTMS control unit exists only for ACTIVE systems — ram-air
  // applications have nothing to control.
  const control = loop.activeControl && !ramAir ? {
    name: 'BTMS ECU (thermal control unit)',
    drives: loopId === 'forced-air'
      ? ['fan speed (PWM)']
      : [
        'coolant pump speed',
        '3-way valve position (radiator / bypass / heater)',
        ...(loopId === 'liquid-chiller' ? ['chiller request to the higher system (compressor duty)'] : []),
        ...(heaterNeeded ? ['heater branch power'] : []),
      ],
    inputs: 'cell/coolant temperature sensors from the BMS, ambient, and the supervisor\'s mission demand (fast-charge preconditioning, cabin/plant priorities)',
    note: 'Third control unit in the hierarchy: the BMS protects, the BTMS moves heat, the supervisor decides — all on the same bus.',
  } : null;

  notes.push('Flow and chiller figures are first-order sizing (ṁ = Q/(c_p·ΔT) with 50/50 water-glycol, ΔT 5 K; chiller COP ~2.5 stated estimate) — for architecture and budgeting, not a substitute for a thermal simulation.');
  if (loopId === 'liquid-chiller') {
    notes.push('The compressor and condenser belong to the HIGHER system (vehicle AC loop / plant HVAC) — the battery couples into it at the chiller plate, and the compressor power is a load on that system\'s budget.');
  }

  // The suggested parts, per SIDE, using the customer's OWN cold-plate
  // selection (bottom vs side vs between-row) so the naming never drifts
  // between the Components tab and the loop — same words, same part.
  const PLACEMENT = { bottom: 'bottom cold plate', side: 'side cold plates', between: 'between-row cooling ribbon' };
  const plateShort = cooling?.viz && PLACEMENT[cooling.viz] ? PLACEMENT[cooling.viz] : 'cold plate / ribbon';
  const isLiquid = loopId === 'liquid' || loopId === 'liquid-chiller';
  const coolantSide = isLiquid ? [
    cooling?.viz && PLACEMENT[cooling.viz]
      ? `${PLACEMENT[cooling.viz].charAt(0).toUpperCase() + PLACEMENT[cooling.viz].slice(1)} — your selection: ${cooling.name}`
      : 'Cold plate — pick bottom / side / between-row on the Components tab',
    'Electric coolant pump (PWM/LIN controlled)',
    '3-way control valve (radiator / bypass / heater routing)',
    'Radiator + fan (rejects to ambient)',
    'Expansion tank + level sensor',
    ...(heaterNeeded ? ['PTC/film heater branch (cold-weather charging)'] : []),
  ] : null;
  const refrigerantSide = loopId === 'liquid-chiller' ? [
    'Chiller plate heat exchanger (coolant ↔ refrigerant interface)',
    'Electronic expansion valve (EXV) on the refrigerant side',
    'Compressor + condenser — OWNED BY THE HIGHER SYSTEM (vehicle AC / plant HVAC)',
  ] : null;
  const airSide = loopId === 'forced-air' ? (ramAir ? [
    'No loop hardware — ram air / prop wash provides the airflow; thermal mass rides through hover and stops',
  ] : [
    'Fan(s) with PWM control and tach feedback',
    'Inlet filter + ducting through the pack',
  ]) : null;

  return {
    loopId, loop, auto, ramAir, overridden: !!(override && override !== 'auto'),
    heatContW: heat, ambientC: [lo, hi],
    flowLpm, chillerKW, compressorKW,
    coolant: COOLANT, chillerCOP: CHILLER_COP,
    heaterNeeded, chargeFloorC,
    plateShort, coolantSide, refrigerantSide, airSide,
    control, notes,
  };
}
