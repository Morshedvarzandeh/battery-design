// marine.js — first-order vessel duty for sizing.
//
// A vessel is not a slow road vehicle. Propulsion power for a displacement
// hull rises approximately with speed-through-water cubed, while head current,
// wind and sea state change the water/air the hull actually works through.
// This is a transparent sizing model, not naval architecture or class proof.

const KNOT_MPS = 0.514444;
const SEA_FACTOR = { calm: 1.00, moderate: 1.15, rough: 1.35 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const MARINE_DEFAULTS = {
  referenceMassKg: 2500,
  payloadKg: 400,
  designSpeedKn: 5,
  serviceSpeedKn: 4.5,
  headCurrentKn: 0,
  headwindKn: 5,
  propulsionAtDesignW: 1200,
  hotelW: 250,
  durationH: 4,
  seaState: 'calm',
};

export function marineDuty(input = {}) {
  const x = { ...MARINE_DEFAULTS, ...input };
  const referenceMass = Math.max(1, x.referenceMassKg);
  const payload = Math.max(0, x.payloadKg);
  const totalMassKg = referenceMass + payload;
  const speedGroundKn = Math.max(0.1, x.serviceSpeedKn);
  const speedWaterKn = Math.max(0.1, speedGroundKn + Math.max(-speedGroundKn + 0.1, x.headCurrentKn));
  const speedRatio = speedWaterKn / Math.max(0.1, x.designSpeedKn);
  const massFactor = (totalMassKg / referenceMass) ** (2 / 3);
  const seaFactor = SEA_FACTOR[x.seaState] || SEA_FACTOR.calm;
  // Headwind penalty is deliberately bounded: without above-water frontal
  // area this is a sensitivity term, not a CFD result.
  const windFactor = 1 + clamp((Math.max(0, x.headwindKn) / 25) ** 2 * 0.22, 0, 0.35);
  const propulsionW = Math.max(0, x.propulsionAtDesignW) * speedRatio ** 3
    * massFactor * seaFactor * windFactor;
  const hotelW = Math.max(0, x.hotelW);
  const cruiseW = propulsionW + hotelW;
  const peakW = cruiseW * 1.22;
  const dtS = 60;
  const durationS = Math.max(60, x.durationH * 3600);
  const n = Math.max(4, Math.round(durationS / dtS));
  const absoluteW = Array.from({ length: n }, (_, i) => {
    const q = i / Math.max(1, n - 1);
    if (q < 0.05) return peakW;          // departure / acceleration
    if (q > 0.92) return cruiseW * 0.72; // approach / manoeuvre
    return cruiseW * (1 + 0.06 * Math.sin(i * 0.37));
  });
  const scaleW = Math.max(...absoluteW, 1);
  const p = absoluteW.map((w) => w / scaleW);
  const energyWh = absoluteW.reduce((s, w) => s + (w * dtS) / 3600, 0);

  return {
    profile: {
      id: 'marine-physics', name: 'Vessel mission from hull conditions',
      family: 'marine-duty', kind: 'physics-output', dtS, p,
      note: 'Generated from vessel mass, payload, speed through water, wind, current, sea state and hotel load. First-order displacement-hull sizing; validate with the vessel resistance curve or measured shaft power.',
    },
    scaleW, energyWh, peakW, continuousW: cruiseW,
    distanceNm: speedGroundKn * x.durationH,
    inputs: x,
    metrics: { totalMassKg, speedGroundKn, speedWaterKn, propulsionW, hotelW, seaFactor, windFactor },
    assumptions: [
      'Displacement-hull propulsion scales with speed-through-water cubed around the stated design point.',
      'Payload changes wetted-area demand with a two-thirds mass exponent.',
      'Wind and sea-state factors are bounded class estimates; measured shaft power or a resistance curve should replace them for final sizing.',
    ],
  };
}

export { KNOT_MPS };
