// marine.js — first-order vessel duty for sizing.
//
// A vessel is not a slow road vehicle. Propulsion power for a displacement
// hull rises approximately with speed-through-water cubed, while head current,
// wind and sea state change the water/air the hull actually works through.
// This is a transparent sizing model, not naval architecture or class proof.

import { defaultVesselModel, marineInputsForVessel, vesselModelById } from './vessels.js';

const KNOT_MPS = 0.514444;
const SEA_FACTOR = { calm: 1.00, moderate: 1.15, rough: 1.35 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const MARINE_SEA_STATES = Object.freeze(Object.keys(SEA_FACTOR));

// These are screening-model input limits, not vessel operating limits. The
// browser controls use the same voyage envelope, while the wider bounds on
// published design-point fields keep Node/desktop callers useful without
// allowing a malformed value to overflow the cubic propulsion calculation.
export const MARINE_MISSION_LIMITS = Object.freeze({
  referenceMassKg: Object.freeze({ min: 1, max: 1_000_000_000, nullable: true }),
  payloadKg: Object.freeze({ min: 0, max: 100_000 }),
  designSpeedKn: Object.freeze({ min: 0.1, max: 100 }),
  serviceSpeedKn: Object.freeze({ min: 0.5, max: 15 }),
  headCurrentKn: Object.freeze({ min: -5, max: 5 }),
  headwindKn: Object.freeze({ min: 0, max: 50 }),
  propulsionAtDesignW: Object.freeze({ min: 1, max: 100_000_000 }),
  hotelW: Object.freeze({ min: 0, max: 1_000_000 }),
  durationH: Object.freeze({ min: 0.25, max: 24 }),
});

export const MARINE_DEFAULTS = {
  ...defaultVesselModel().missionDefaults,
  vesselId: defaultVesselModel().id,
};

// Shared by the browser and Node/desktop entry points. It returns a new,
// resolved mission object and never mutates the caller's input.
export function validateMarineMission(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Marine mission input must be an object.');
  }
  const selectedVessel = vesselModelById(input.vesselId) || defaultVesselModel();
  const x = {
    ...MARINE_DEFAULTS,
    ...marineInputsForVessel(selectedVessel.id),
    ...input,
    vesselId: selectedVessel.id,
  };

  for (const [field, limits] of Object.entries(MARINE_MISSION_LIMITS)) {
    const value = x[field];
    if (limits.nullable && value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`${field} must be a finite number between ${limits.min} and ${limits.max}.`);
    }
    if (value < limits.min || value > limits.max) {
      throw new RangeError(`${field} must be between ${limits.min} and ${limits.max}.`);
    }
  }

  if (typeof x.seaState !== 'string' || !MARINE_SEA_STATES.includes(x.seaState)) {
    throw new RangeError(`seaState must be one of: ${MARINE_SEA_STATES.join(', ')}.`);
  }

  return x;
}

export function marineDuty(input = {}) {
  const x = validateMarineMission(input);
  const selectedVessel = vesselModelById(x.vesselId) || defaultVesselModel();
  const hasReferenceMass = Number.isFinite(x.referenceMassKg) && x.referenceMassKg > 0;
  const referenceMass = hasReferenceMass ? x.referenceMassKg : null;
  const payload = Math.max(0, x.payloadKg);
  const totalMassKg = hasReferenceMass ? referenceMass + payload : null;
  const speedGroundKn = Math.max(0.1, x.serviceSpeedKn);
  const speedWaterKn = Math.max(0.1, speedGroundKn + Math.max(-speedGroundKn + 0.1, x.headCurrentKn));
  const speedRatio = speedWaterKn / Math.max(0.1, x.designSpeedKn);
  // Gunnerus publishes deadweight rather than displacement/lightship mass.
  // Substituting one for the other would make the payload correction look
  // sourced when it is not, so mass scaling is disabled until a real vessel
  // mass is provided.
  const massFactor = hasReferenceMass ? (totalMassKg / referenceMass) ** (2 / 3) : 1;
  const seaFactor = SEA_FACTOR[x.seaState] || SEA_FACTOR.calm;
  // Headwind penalty is deliberately bounded: without above-water frontal
  // area this is a sensitivity term, not a CFD result.
  const windFactor = 1 + clamp((Math.max(0, x.headwindKn) / 25) ** 2 * 0.22, 0, 0.35);
  const propulsionW = Math.max(0, x.propulsionAtDesignW) * speedRatio ** 3
    * massFactor * seaFactor * windFactor;
  const hotelW = Math.max(0, x.hotelW);
  const cruiseW = propulsionW + hotelW;
  const peakW = cruiseW * 1.22;
  const durationH = x.durationH;
  const durationS = durationH * 3600;
  // Keep a roughly one-minute screen while integrating the exact requested
  // voyage duration. A fixed 60 s step plus a rounded sample count made a
  // 1.01 h request simulate 61 minutes but report 1.01 h of distance.
  const n = Math.max(4, Math.ceil(durationS / 60));
  const dtS = durationS / n;
  const absoluteW = Array.from({ length: n }, (_, i) => {
    const q = i / Math.max(1, n - 1);
    if (q < 0.05) return peakW;          // departure / acceleration
    if (q > 0.92) return cruiseW * 0.72; // approach / manoeuvre
    return cruiseW * (1 + 0.06 * Math.sin(i * 0.37));
  });
  const scaleW = Math.max(...absoluteW, 1);
  const p = absoluteW.map((w) => w / scaleW);
  const energyWh = absoluteW.reduce((s, w) => s + (w * dtS) / 3600, 0);
  const distanceNm = speedGroundKn * durationH;
  const energyPerNmWh = energyWh / Math.max(distanceNm, 1e-9);

  if (![scaleW, energyWh, peakW, cruiseW, distanceNm, energyPerNmWh,
    speedGroundKn, speedWaterKn, propulsionW, hotelW, seaFactor, windFactor,
    massFactor, dtS].every(Number.isFinite) || p.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Marine mission calculation did not produce finite outputs.');
  }

  return {
    profile: {
      id: 'marine-physics', name: `${selectedVessel.shortName} mission from hull conditions`,
      family: 'marine-duty', kind: 'physics-output', dtS, p,
      note: `Generated for ${selectedVessel.name} from the published design point plus visible voyage inputs. First-order displacement-hull screening; replace it with a measured DC-bus trace, shaft-power curve or resistance curve for vessel engineering.`,
    },
    scaleW, energyWh, peakW, continuousW: cruiseW,
    distanceNm,
    energyPerNmWh,
    inputs: { ...x, durationH },
    vessel: {
      id: selectedVessel.id, name: selectedVessel.name,
      segment: selectedVessel.segment, evidence: selectedVessel.evidence,
      boundary: selectedVessel.boundary,
    },
    maturity: 'screening',
    metrics: {
      totalMassKg, speedGroundKn, speedWaterKn, propulsionW, hotelW,
      seaFactor, windFactor, massFactor, massCorrectionApplied: hasReferenceMass,
    },
    assumptions: [
      'Displacement-hull propulsion scales with speed-through-water cubed around the stated design point.',
      hasReferenceMass
        ? 'Payload changes wetted-area demand with a two-thirds mass exponent around the supplied reference mass.'
        : 'Payload mass correction is disabled because this vessel has no supplied displacement/lightship mass; published deadweight is not silently substituted.',
      'Wind and sea-state factors are bounded class estimates; measured shaft power or a resistance curve should replace them for final sizing.',
      selectedVessel.boundary,
    ],
  };
}

export { KNOT_MPS };
