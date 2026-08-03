// vehicle.js — the machine around the pack. Until now the tool sized a pack
// against a NORMALIZED load shape scaled by a power number the customer typed.
// That hides the thing every vehicle engineer actually argues about: mass.
//
// Here the demand is DERIVED instead of typed. The customer gives the vehicle
// (mass, payload, frontal area, drag, rolling resistance) and a driving mode,
// a speed trace supplies v(t), and textbook road load turns it into watts:
//
//   F = Crr·m·g·cos θ  +  ½·ρ·Cd·A·v²  +  m·g·sin θ  +  m·(1+ε)·a
//   P_wheel = F·v ;  P_battery = P_wheel/η + P_aux   (regen when P_wheel < 0)
//
// Two consequences make this worth the code:
//  · The pack's OWN mass is part of m. A heavier pack costs range, so the
//    mass spiral is visible in the result instead of assumed away.
//  · Wh/km and range fall out — the numbers a customer decides on — and they
//    move when the vehicle changes, which a typed peak-power number never did.
//
// Honesty on scope:
//  · Speed traces are class-representative. The EV trace follows the PUBLIC
//    WLTP Class 3 structure (four phases, their durations and peak speeds);
//    the second-by-second homologation trace is not reproduced (§8).
//  · Driving-mode factors are class estimates, exposed as inputs (§8).
//  · Regen is capped by the drive hardware, and the pack's own charge
//    acceptance may cap it lower still — the caller can pass that limit.
//  · An AGV's lifting work is hydraulic, not road load; it is named, not faked.
//
// Pure data + math, no DOM.

export const G = 9.80665;            // m/s²
export const AIR_DENSITY_KGM3 = 1.225; // dry air, 15 °C, sea level

// ---------------------------------------------------------------------------
// The vehicle. curbKg EXCLUDES the traction pack — the tool adds the pack it
// designed, so mass is never double-counted and never wished away.
// ---------------------------------------------------------------------------
export const VEHICLE_DEFAULTS = {
  ev: {
    label: 'Light electric vehicle', curbKg: 1250, payloadKg: 150,
    cd: 0.29, frontalAreaM2: 2.2, crr: 0.010, driveEff: 0.90,
    regenFrac: 0.60, auxW: 500, rotatingMass: 0.05,
    note: 'C-segment class values. Auxiliaries are the 12 V loads plus mild climate use; winter HVAC can triple that.',
  },
  ebus: {
    label: 'City bus', curbKg: 11000, payloadKg: 4000,
    cd: 0.60, frontalAreaM2: 7.5, crr: 0.008, driveEff: 0.90,
    regenFrac: 0.55, auxW: 6000, rotatingMass: 0.07,
    note: 'A 12 m city bus. The 6 kW auxiliary is HVAC-dominated — on a stop-start route it rivals traction, which is why depot charging is planned around winter, not summer.',
  },
  ebike: {
    label: 'E-bike + rider', curbKg: 25, payloadKg: 80,
    cd: 1.00, frontalAreaM2: 0.50, crr: 0.006, driveEff: 0.85,
    regenFrac: 0, auxW: 5, rotatingMass: 0.02,
    note: 'Upright rider. Regen is zero: almost no e-bike has it, and pretending otherwise flatters the range.',
  },
  escooter: {
    label: 'E-scooter + rider', curbKg: 15, payloadKg: 80,
    cd: 1.10, frontalAreaM2: 0.60, crr: 0.012, driveEff: 0.85,
    regenFrac: 0.15, auxW: 5, rotatingMass: 0.02,
    note: 'Standing rider, small wheels on city surfaces — rolling resistance is high for the mass.',
  },
  robot: {
    label: 'AGV / lift truck', curbKg: 2500, payloadKg: 1500,
    cd: 1.10, frontalAreaM2: 2.0, crr: 0.015, driveEff: 0.85,
    regenFrac: 0.35, auxW: 300, rotatingMass: 0.06,
    note: 'Indoor duty: aerodynamic drag is negligible at these speeds, mass and rolling resistance are everything. Hydraulic LIFTING work is separate from road load and is not included here.',
  },
};

export function vehicleDefaultsFor(appId) {
  const v = VEHICLE_DEFAULTS[appId];
  return v ? { ...v } : null;
}

// ---------------------------------------------------------------------------
// Driving modes. Same vehicle, same route, different driver — and the pack
// feels all of it. Factors are class estimates, stated as such (§8).
// ---------------------------------------------------------------------------
export const DRIVING_MODES = [
  {
    id: 'eco', name: 'Eco', speedScale: 0.94, accelScale: 0.80, regenScale: 1.25, auxScale: 0.80,
    what: 'Gentler acceleration, slightly lower cruise, stronger recovery, restrained climate control.',
  },
  {
    id: 'normal', name: 'Normal', speedScale: 1.00, accelScale: 1.00, regenScale: 1.00, auxScale: 1.00,
    what: 'The baseline the trace was written for.',
  },
  {
    id: 'sport', name: 'Sport', speedScale: 1.06, accelScale: 1.40, regenScale: 0.85, auxScale: 1.00,
    what: 'Harder acceleration and higher cruise, with coasting preferred over recovery — the demanding case for peak current and heat.',
  },
];

export function drivingModeById(id) {
  return DRIVING_MODES.find((m) => m.id === id) || DRIVING_MODES[1];
}

// ---------------------------------------------------------------------------
// Speed traces, in km/h. Built from ramps, cruises and stops so the shape is
// inspectable rather than a wall of numbers.
// ---------------------------------------------------------------------------
const hold = (v, seconds, dtS) => Array(Math.max(1, Math.round(seconds / dtS))).fill(v);
const ramp = (from, to, seconds, dtS) => {
  const n = Math.max(1, Math.round(seconds / dtS));
  return Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
};
// One urban "pull away, run, stop, wait" event.
const stopGo = (peak, accelS, cruiseS, brakeS, idleS, dtS) => [
  ...ramp(0, peak, accelS, dtS), ...hold(peak, cruiseS, dtS),
  ...ramp(peak, 0, brakeS, dtS), ...hold(0, idleS, dtS),
];

// The four WLTP Class 3 phases, built separately so each one can be checked
// against its PUBLISHED aggregates (duration, distance, peak speed) — the
// facts that are public, as opposed to the homologation trace, which is not.
export const WLTP3_PHASES = [
  {
    id: 'low', name: 'Low (urban)', durationS: 589, distanceKm: 3.095, peakKmh: 56.5,
    v: [
      ...stopGo(20, 12, 30, 10, 30, 5), ...stopGo(32, 18, 40, 14, 20, 5),
      ...stopGo(25, 14, 30, 12, 18, 5), ...stopGo(45, 22, 45, 18, 25, 5),
      ...stopGo(56, 28, 40, 20, 30, 5), ...stopGo(30, 16, 35, 12, 50, 5),
    ],
  },
  {
    id: 'medium', name: 'Medium (suburban)', durationS: 433, distanceKm: 4.756, peakKmh: 76.6,
    v: [
      ...ramp(0, 60, 25, 5), ...hold(60, 45, 5), ...ramp(60, 76, 15, 5),
      ...hold(76, 45, 5), ...ramp(76, 35, 20, 5), ...hold(35, 35, 5),
      ...ramp(35, 70, 20, 5), ...hold(70, 40, 5), ...ramp(70, 0, 25, 5),
      ...hold(0, 45, 5), ...ramp(0, 45, 20, 5), ...hold(45, 43, 5),
      ...ramp(45, 0, 20, 5), ...hold(0, 35, 5),
    ],
  },
  {
    id: 'high', name: 'High (rural)', durationS: 455, distanceKm: 7.158, peakKmh: 97.4,
    v: [
      ...ramp(0, 70, 30, 5), ...hold(70, 50, 5), ...ramp(70, 50, 15, 5),
      ...hold(50, 40, 5), ...ramp(50, 85, 25, 5), ...hold(85, 45, 5),
      ...ramp(85, 97, 15, 5), ...hold(97, 35, 5), ...ramp(97, 40, 25, 5),
      ...hold(40, 30, 5), ...ramp(40, 0, 20, 5), ...hold(0, 35, 5),
      ...ramp(0, 60, 25, 5), ...hold(60, 40, 5), ...ramp(60, 0, 25, 5),
    ],
  },
  {
    id: 'xhigh', name: 'Extra-High (motorway)', durationS: 323, distanceKm: 8.254, peakKmh: 131.3,
    v: [
      ...ramp(0, 100, 35, 5), ...hold(100, 60, 5), ...ramp(100, 131, 25, 5),
      ...hold(131, 70, 5), ...ramp(131, 100, 20, 5), ...hold(100, 45, 5),
      ...ramp(100, 0, 40, 5), ...hold(0, 28, 5),
    ],
  },
];

export const SPEED_TRACES = [
  {
    id: 'wltp3-class', name: 'WLTP Class 3 structure (Low / Medium / High / Extra-High)',
    appIds: ['ev'], dtS: 5,
    note: 'Follows the four published WLTP Class 3 phases — their durations, distances and peak speeds — with a synthesized second-by-second trace. Representative, not the homologation data.',
    phases: WLTP3_PHASES,
    v: WLTP3_PHASES.flatMap((ph) => ph.v),
  },
  {
    id: 'bus-route', name: 'City bus route (stop to stop)',
    appIds: ['ebus'], dtS: 5,
    note: 'Eight stops with dwell time, then one longer inter-district run. The dwell matters: auxiliaries keep drawing while the bus stands.',
    v: [
      ...stopGo(40, 15, 20, 12, 25, 5), ...stopGo(35, 12, 15, 10, 20, 5),
      ...stopGo(45, 18, 30, 14, 30, 5), ...stopGo(30, 12, 12, 10, 35, 5),
      ...stopGo(42, 16, 25, 12, 25, 5), ...stopGo(38, 14, 18, 11, 40, 5),
      ...ramp(0, 60, 30, 5), ...hold(60, 120, 5), ...ramp(60, 0, 25, 5), ...hold(0, 30, 5),
      ...stopGo(40, 15, 20, 12, 30, 5), ...stopGo(35, 13, 16, 11, 45, 5),
    ],
  },
  {
    id: 'urban-lmt', name: 'Urban ride (lights, junctions, a climb)',
    appIds: ['ebike', 'escooter'], dtS: 5,
    note: 'City riding: repeated pull-aways from lights, a sustained cruise, and one climb held at low speed against gradient.',
    v: [
      ...stopGo(20, 10, 40, 8, 20, 5), ...stopGo(24, 12, 60, 8, 15, 5),
      ...hold(22, 120, 5), ...stopGo(18, 8, 30, 6, 25, 5),
      ...hold(14, 90, 5), // the climb — slow and steady
      ...stopGo(25, 12, 80, 10, 20, 5), ...ramp(0, 20, 10, 5), ...hold(20, 60, 5), ...ramp(20, 0, 8, 5),
    ],
  },
  {
    id: 'agv-shuttle', name: 'Warehouse shuttle (load, run, unload)',
    appIds: ['robot'], dtS: 5,
    note: 'Slow runs between pick and drop with standing time. Drive energy only — the hydraulic lift cycle is a separate load the customer adds as auxiliary power.',
    v: [
      ...stopGo(8, 6, 45, 5, 30, 5), ...stopGo(8, 6, 60, 5, 40, 5),
      ...stopGo(6, 5, 30, 4, 25, 5), ...stopGo(8, 6, 75, 5, 35, 5),
      ...stopGo(7, 5, 40, 5, 50, 5),
    ],
  },
];

export function traceById(id) {
  return SPEED_TRACES.find((t) => t.id === id) || null;
}
export function tracesForApp(appId) {
  return SPEED_TRACES.filter((t) => t.appIds.includes(appId));
}
export function traceForApp(appId) {
  return tracesForApp(appId)[0] || null;
}

// ---------------------------------------------------------------------------
// Mass: what the wheels actually carry. The pack the tool designed is part
// of it — that is the whole point.
// ---------------------------------------------------------------------------
export function totalMassKg({ vehicle, packMassKg = 0 }) {
  return (vehicle.curbKg || 0) + (vehicle.payloadKg || 0) + (packMassKg || 0);
}

// Instantaneous road load, with the force split kept so the customer can see
// WHERE the energy goes rather than being handed one number.
export function roadLoadN({ vMs, aMs2 = 0, massKg, vehicle, gradePct = 0 }) {
  const theta = Math.atan(gradePct / 100);
  const roll = vehicle.crr * massKg * G * Math.cos(theta) * (vMs > 0.1 ? 1 : 0);
  const aero = 0.5 * AIR_DENSITY_KGM3 * vehicle.cd * vehicle.frontalAreaM2 * vMs * vMs;
  const grade = massKg * G * Math.sin(theta);
  const inertia = massKg * (1 + (vehicle.rotatingMass || 0)) * aMs2;
  return { roll, aero, grade, inertia, total: roll + aero + grade + inertia };
}

// ---------------------------------------------------------------------------
// The whole drive: a speed trace + a vehicle + a mode -> watts at the battery,
// the energy ledger, and a normalized profile the existing simulation and
// profile machinery consume unchanged.
// ---------------------------------------------------------------------------
export function driveCyclePower({
  trace, vehicle, mode = 'normal', packMassKg = 0, gradePct = 0, regenCapW = null,
}) {
  if (!trace?.v?.length || !vehicle) return null;
  const M = drivingModeById(mode);
  const dtS = trace.dtS;
  const massKg = totalMassKg({ vehicle, packMassKg });
  const auxW = (vehicle.auxW || 0) * M.auxScale;
  const regenFrac = Math.min(0.9, (vehicle.regenFrac || 0) * M.regenScale);
  const eff = vehicle.driveEff || 0.9;

  // The mode reshapes the trace: cruise speeds scale, and the accelerations
  // are stretched by driving the speed changes harder (a sharper ramp).
  const vKmh = trace.v.map((v) => v * M.speedScale);
  const vMs = vKmh.map((v) => v / 3.6);

  const w = [];
  const bucket = { rolling: 0, aero: 0, grade: 0, accel: 0, aux: 0, recovered: 0 };
  let distanceM = 0;
  for (let i = 0; i < vMs.length; i++) {
    const v = vMs[i];
    const vNext = vMs[i + 1] != null ? vMs[i + 1] : vMs[i];
    const aRaw = (vNext - v) / dtS;
    // Sport accelerates harder, eco gentler — the same speed change, reached
    // with a different pedal. Braking is left alone: physics, not preference.
    const a = aRaw > 0 ? aRaw * M.accelScale : aRaw;
    const F = roadLoadN({ vMs: v, aMs2: a, massKg, vehicle, gradePct });
    const pWheel = F.total * v;
    let pBatt;
    if (pWheel > 0) {
      pBatt = pWheel / eff + auxW;
      bucket.rolling += (F.roll * v / eff) * dtS;
      bucket.aero += (F.aero * v / eff) * dtS;
      bucket.grade += (F.grade * v / eff) * dtS;
      bucket.accel += (F.inertia * v / eff) * dtS;
    } else {
      // Braking: only the recovered fraction reaches the pack, and only up to
      // what the hardware accepts. The rest is heat in the friction brakes.
      let regenW = pWheel * eff * regenFrac;
      const cap = regenCapW != null ? -Math.abs(regenCapW) : -Infinity;
      if (regenW < cap) regenW = cap;
      pBatt = regenW + auxW;
      bucket.recovered += regenW * dtS;
    }
    bucket.aux += auxW * dtS;
    w.push(pBatt);
    distanceM += v * dtS;
  }

  const totalJ = w.reduce((s, x) => s + x * dtS, 0);
  const energyWh = totalJ / 3600;
  const distanceKm = distanceM / 1000;
  const durationS = vMs.length * dtS;
  const peakW = Math.max(...w);
  const minW = Math.min(...w);
  const rmsW = Math.sqrt(w.reduce((s, x) => s + x * x, 0) / w.length);
  const scaleW = Math.max(1, peakW);
  const toWh = (j) => j / 3600;

  return {
    dtS, w, peakW, minW, rmsW, meanW: totalJ / durationS,
    massKg, distanceKm, durationS, energyWh,
    whPerKm: distanceKm > 0 ? energyWh / distanceKm : null,
    avgSpeedKmh: (distanceKm / durationS) * 3600,
    mode: M, auxW, regenFrac,
    breakdown: {
      rolling: toWh(bucket.rolling), aero: toWh(bucket.aero), grade: toWh(bucket.grade),
      accel: toWh(bucket.accel), aux: toWh(bucket.aux), recovered: toWh(bucket.recovered),
    },
    // A normalized profile, exactly the shape the rest of the tool speaks.
    profile: {
      id: 'vehicle', name: `Derived from your vehicle — ${trace.name}`,
      dtS, p: w.map((x) => x / scaleW), note: trace.note, derived: true,
    },
    scaleW,
  };
}

// Range from the pack the customer actually designed.
export function rangeKm({ energyWh, dod = 0.8, whPerKm }) {
  if (!(energyWh > 0) || !(whPerKm > 0)) return null;
  return (energyWh * dod) / whPerKm;
}

// How much of the vehicle is the pack, and does that deserve a word? A pack
// that is a fifth of the vehicle is carrying itself a long way.
export function massShare({ vehicle, packMassKg }) {
  const total = totalMassKg({ vehicle, packMassKg });
  const share = total > 0 ? packMassKg / total : 0;
  return {
    share, totalKg: total,
    note: share >= 0.15
      ? `The pack is ${Math.round(share * 100)}% of the moving mass — a heavier pack buys energy but spends part of it carrying itself. Compare the range, not the kWh.`
      : null,
  };
}

// The same vehicle across all three modes — the comparison a customer wants
// before choosing a battery size.
export function modeComparison({ trace, vehicle, packMassKg, gradePct, energyWh, dod = 0.8, regenCapW = null }) {
  return DRIVING_MODES.map((m) => {
    const r = driveCyclePower({ trace, vehicle, mode: m.id, packMassKg, gradePct, regenCapW });
    return r ? {
      mode: m, whPerKm: r.whPerKm, peakW: r.peakW,
      rangeKm: rangeKm({ energyWh, dod, whPerKm: r.whPerKm }),
    } : null;
  }).filter(Boolean);
}
