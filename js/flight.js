// flight.js — multirotor mission physics for sizing.
//
// Payload, air density and wind belong ahead of the battery profile. The
// generated profile uses momentum-theory hover power and explicit mission
// phases so a manager can choose a job while an engineer can inspect the
// assumptions. It is not an airworthiness or flight-control model.

const G = 9.80665;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const FLIGHT_DEFAULTS = {
  emptyMassKg: 6,
  payloadKg: 1.5,
  rotorCount: 6,
  rotorDiameterM: 0.53,
  flightMinutes: 25,
  cruiseSpeedMps: 10,
  headwindMps: 3,
  altitudeM: 100,
  temperatureC: 15,
  propulsiveEfficiency: 0.72,
  auxiliaryW: 80,
  hoverFraction: 0.45,
};

export function airDensity({ altitudeM = 0, temperatureC = 15 } = {}) {
  // ISA pressure decay with an explicit temperature correction. Adequate for
  // sizing sensitivity below typical small-UAV operating altitudes.
  const rhoIsa = 1.225 * Math.exp(-Math.max(-500, altitudeM) / 8500);
  return rhoIsa * (288.15 / (273.15 + temperatureC));
}

export function flightDuty(input = {}) {
  const x = { ...FLIGHT_DEFAULTS, ...input };
  const massKg = Math.max(0.1, x.emptyMassKg + Math.max(0, x.payloadKg));
  const rho = airDensity(x);
  const diskAreaM2 = Math.max(0.01, x.rotorCount * Math.PI * (x.rotorDiameterM / 2) ** 2);
  const idealHoverW = (massKg * G) ** 1.5 / Math.sqrt(2 * rho * diskAreaM2);
  const hoverW = idealHoverW / clamp(x.propulsiveEfficiency, 0.3, 0.95) + Math.max(0, x.auxiliaryW);
  const airspeedMps = Math.max(0, x.cruiseSpeedMps + Math.max(0, x.headwindMps));
  // Multirotor forward-flight power has a shallow minimum before parasite
  // drag dominates. This bounded factor captures the trend without claiming
  // an airframe-specific drag polar.
  const cruiseFactor = clamp(0.82 + 0.0026 * airspeedMps ** 2, 0.78, 1.55);
  const cruiseW = hoverW * cruiseFactor;
  const peakW = Math.max(hoverW * 1.35, cruiseW * 1.18);
  const dtS = 5;
  const n = Math.max(12, Math.round(Math.max(1, x.flightMinutes) * 60 / dtS));
  const hoverFraction = clamp(x.hoverFraction, 0.05, 0.9);
  const absoluteW = Array.from({ length: n }, (_, i) => {
    const q = i / Math.max(1, n - 1);
    if (q < 0.04) return peakW;              // take-off/climb
    if (q > 0.94) return hoverW * 1.10;      // approach/landing
    const phase = (q - 0.04) / 0.90;
    const hover = (phase % 1) < hoverFraction;
    const base = hover ? hoverW : cruiseW;
    return base * (1 + 0.035 * Math.sin(i * 0.51));
  });
  const scaleW = Math.max(...absoluteW, 1);
  const p = absoluteW.map((w) => w / scaleW);
  const energyWh = absoluteW.reduce((s, w) => s + (w * dtS) / 3600, 0);

  return {
    profile: {
      id: 'flight-physics', name: 'Multirotor mission from payload and weather',
      family: 'flight-duty', kind: 'physics-output', dtS, p,
      note: 'Generated from take-off mass, rotor disk area, mission time, hover share, altitude, temperature and headwind. First-order multirotor sizing; validate with measured aircraft power logs.',
    },
    scaleW, energyWh, peakW, continuousW: Math.max(hoverW, cruiseW), inputs: x,
    metrics: { massKg, rhoKgM3: rho, diskAreaM2, hoverW, cruiseW, airspeedMps },
    assumptions: [
      'Hover power uses ideal momentum theory divided by an explicit propulsive efficiency.',
      'Headwind increases cruise airspeed; the forward-flight factor is a bounded class estimate, not a drag polar.',
      'Battery mass feedback requires iterating this mission after a candidate pack is selected.',
    ],
  };
}
