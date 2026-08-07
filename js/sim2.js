// sim2.js — the level-2 simulation: a parameterised, correctable model.
//
// The level-1 model (js/sim1d.js) answers "does this pack survive the duty?"
// with one resistance and one thermal mass. That is the right size for a
// browser tab and the wrong size for engineering decisions, because every
// number in it is fixed by the tool. This model is built the other way round:
//
//   EVERY coefficient is a named, bounded, documented parameter the user can
//   change — and, given their own measurements, the model CORRECTS ITSELF to
//   match them.
//
// That is the difference between a calculator and a simulation tool. A model
// you cannot fit to your own cell is a model you cannot trust on your own
// cell.
//
// What is modelled
//  · Equivalent circuit: OCV(SoC,T) + R0(SoC,T) + N RC branches, Arrhenius
//    temperature dependence, optional one-state hysteresis.
//  · Heat: irreversible I²R in every element, plus the REVERSIBLE entropic
//    term I·T·(dU/dT) that flips sign between charge and discharge — the term
//    lumped models leave out and then cannot explain their cooling data.
//  · Thermal network: a chain of module nodes, conduction between neighbours,
//    convection into a coolant stream that warms as it flows, and loss to
//    ambient. Not one lumped mass: modules run at different temperatures, and
//    the spread is usually what limits the design.
//  · Aging: calendar (Arrhenius, SoC-weighted, √t) and cycle (throughput,
//    C-rate weighted) giving capacity fade and resistance growth.
//
// What is NOT modelled, stated plainly rather than implied:
//  · No electrochemistry. This is an equivalent-circuit model, not a
//    Newman/P2D model — there is no lithium concentration, no particle
//    diffusion, no plating criterion beyond a temperature gate.
//  · No 3-D fields. The thermal network is a lumped chain, not CFD. It will
//    tell you a module is 8 K hotter than its neighbour; it will not tell you
//    which corner of it.
//  · Default coefficients are class-typical estimates, not your cell. That is
//    exactly why calibrate() exists: measure, fit, then trust.
//
// Pure math, no DOM, no I/O. Runs in a browser and in Node.

import { ocvCell } from './sim1d.js';
import {
  MAX_CALIBRATION_PREPROCESSED_SAMPLES,
  preprocessCalibrationDataset,
  readCalibrationDataset,
} from './calibration-dataset.js';

export const R_GAS = 8.314462618;      // J/(mol·K)
export const T0_K = 273.15;
const MAX_SIM2_INTEGRATION_STEPS = 100_000_000;
// Forward Euler at C/G is monotone but resolves a one-time-constant decay as
// one jump to equilibrium. Restricting dt to 2% of C/G gives at least 50
// points per fastest local thermal time constant: (1 - 0.02)^50 differs from
// exp(-1) by about 1%, while retaining the positivity guarantee.
const THERMAL_EXPLICIT_ACCURACY_FRACTION = 0.02;

// ---------------------------------------------------------------------------
// The parameter set. This IS the model — everything below reads from it, and
// nothing is hard-coded behind the user's back. Each entry carries units,
// bounds and where the default came from, so a value can be argued with.
// ---------------------------------------------------------------------------
export const PARAM_SPEC = [
  // --- electrical ---------------------------------------------------------
  { id: 'r0Ref', group: 'electrical', label: 'Series resistance R0 at reference', unit: 'mΩ per cell', def: null, min: 0.05, max: 500,
    why: 'The instantaneous voltage step when current changes. Defaults to the cell record\'s DCIR.', source: 'cell datasheet where published, else estimated' },
  { id: 'r0EaJ', group: 'electrical', label: 'Activation energy for R0', unit: 'J/mol', def: 20000, min: 0, max: 80000,
    why: 'How strongly resistance rises in the cold: R0(T) = R0ref·exp(Ea/R·(1/T − 1/Tref)).', source: 'class estimate (§8)' },
  { id: 'r0SocRise', group: 'electrical', label: 'R0 rise at the SoC extremes', unit: '×', def: 1.6, min: 1, max: 6,
    why: 'Resistance climbs near empty and near full. 1.0 disables the effect.', source: 'class estimate (§8)' },
  { id: 'rc1R', group: 'electrical', label: 'RC branch 1 resistance', unit: 'mΩ per cell', def: null, min: 0, max: 500,
    why: 'Fast polarisation — the sag that develops over seconds. Defaults to 0.5·R0.', source: 'class estimate (§8)' },
  { id: 'rc1TauS', group: 'electrical', label: 'RC branch 1 time constant', unit: 's', def: 15, min: 0.1, max: 600,
    why: 'How quickly that sag develops and recovers.', source: 'class estimate (§8)' },
  { id: 'rc2R', group: 'electrical', label: 'RC branch 2 resistance', unit: 'mΩ per cell', def: null, min: 0, max: 500,
    why: 'Slow polarisation — diffusion-scale, minutes. Defaults to 0.35·R0.', source: 'class estimate (§8)' },
  { id: 'rc2TauS', group: 'electrical', label: 'RC branch 2 time constant', unit: 's', def: 200, min: 1, max: 5000,
    why: 'The long tail after a load step.', source: 'class estimate (§8)' },
  { id: 'hystV', group: 'electrical', label: 'OCV hysteresis', unit: 'V per cell', def: 0, min: 0, max: 0.2,
    why: 'Charge and discharge OCV differ at the same SoC. Significant for LFP, small for NMC. 0 disables it.', source: 'class estimate (§8)' },
  { id: 'coulombEff', group: 'electrical', label: 'Coulombic efficiency', unit: '—', def: 0.995, min: 0.8, max: 1,
    why: 'Charge accepted per charge delivered. Below 1 the pack loses a little every cycle.', source: 'class estimate (§8)' },
  // --- thermal ------------------------------------------------------------
  { id: 'cpCellJkgK', group: 'thermal', label: 'Cell specific heat', unit: 'J/(kg·K)', def: 1000, min: 300, max: 2000,
    why: 'Thermal inertia. Lithium cells sit near 1000 J/(kg·K).', source: 'literature class value' },
  { id: 'entropyVK', group: 'thermal', label: 'Entropic coefficient dU/dT', unit: 'V/K', def: -0.0002, min: -0.002, max: 0.002,
    why: 'Reversible heat: I·T·dU/dT. Makes discharge warmer and charge cooler than I²R alone predicts.', source: 'class estimate (§8)' },
  { id: 'kCondWK', group: 'thermal', label: 'Module-to-module conduction', unit: 'W/K', def: 4, min: 0, max: 200,
    why: 'How well heat spreads along the pack. Low values let one module run away.', source: 'class estimate (§8)' },
  { id: 'hCoolWK', group: 'thermal', label: 'Module-to-coolant conductance', unit: 'W/K per module', def: 6, min: 0, max: 500,
    why: 'The cooling path per module — plate, TIM and coolant film combined.', source: 'derived from the thermal analysis where available' },
  { id: 'uaAmbWK', group: 'thermal', label: 'Pack-to-ambient conductance', unit: 'W/K', def: 2, min: 0, max: 200,
    why: 'Loss through the enclosure. Small in an insulated pack, large in a bare one.', source: 'geometry estimate' },
  { id: 'mdotKgS', group: 'thermal', label: 'Coolant mass flow', unit: 'kg/s', def: 0.05, min: 0, max: 5,
    why: 'Zero means no coolant loop — modules then reject heat only to ambient.', source: 'user input' },
  { id: 'cpCoolJkgK', group: 'thermal', label: 'Coolant specific heat', unit: 'J/(kg·K)', def: 3600, min: 1000, max: 4200,
    why: '50/50 water-glycol ≈ 3600; pure water 4180; air ≈ 1000.', source: 'coolant property table' },
  { id: 'coolantInC', group: 'thermal', label: 'Coolant inlet temperature', unit: '°C', def: 25, min: -40, max: 80,
    why: 'What the chiller or radiator delivers.', source: 'user input' },
  { id: 'currentImbalance', group: 'thermal', label: 'Worst-module current share', unit: '×', def: 1.08, min: 1, max: 2,
    why: 'Real modules do not share current equally; the hottest carries more. 1.0 assumes perfection.', source: 'class estimate (§8)' },
  // --- aging --------------------------------------------------------------
  { id: 'calA', group: 'aging', label: 'Calendar aging coefficient', unit: '%/√day', def: 0.09, min: 0, max: 5,
    why: 'Capacity lost with time alone, as √t.', source: 'class estimate (§8)' },
  { id: 'calEaJ', group: 'aging', label: 'Calendar activation energy', unit: 'J/mol', def: 48000, min: 0, max: 120000,
    why: 'How much faster it ages when hot.', source: 'class estimate (§8)' },
  { id: 'calSocK', group: 'aging', label: 'Calendar SoC sensitivity', unit: '—', def: 1.2, min: 0, max: 5,
    why: 'Storage near full ages faster. 0 removes the SoC dependence.', source: 'class estimate (§8)' },
  { id: 'cycA', group: 'aging', label: 'Cycle aging coefficient', unit: '%/√(equivalent full cycle)', def: 0.55, min: 0, max: 20,
    why: 'Capacity lost per unit of throughput, as √EFC.', source: 'class estimate (§8)' },
  { id: 'cycEaJ', group: 'aging', label: 'Cycle activation energy', unit: 'J/mol', def: 32000, min: 0, max: 120000,
    why: 'Throughput at high temperature costs more.', source: 'class estimate (§8)' },
  { id: 'cycCrateK', group: 'aging', label: 'Cycle C-rate sensitivity', unit: '—', def: 0.3, min: 0, max: 3,
    why: 'Hard cycling ages faster than gentle cycling at the same throughput.', source: 'class estimate (§8)' },
  { id: 'resGrowthK', group: 'aging', label: 'Resistance growth per capacity lost', unit: '×', def: 2.5, min: 0, max: 20,
    why: 'Resistance typically rises faster than capacity falls.', source: 'class estimate (§8)' },
  // --- solver -------------------------------------------------------------
  { id: 'tRefC', group: 'solver', label: 'Reference temperature', unit: '°C', def: 25, min: -20, max: 60,
    why: 'The temperature the resistance parameters are quoted at.', source: 'convention' },
  { id: 'maxDtS', group: 'solver', label: 'Maximum integration step', unit: 's', def: 1, min: 0.001, max: 60,
    why: 'The profile is sub-stepped to this so the RC and thermal states stay stable.', source: 'numerical' },
];

export const PARAM_BY_ID = Object.fromEntries(PARAM_SPEC.map((p) => [p.id, p]));

// Defaults, with the cell-dependent ones filled from the cell record so the
// model starts somewhere defensible rather than somewhere generic.
export function defaultParams(cell = null) {
  const out = {};
  for (const p of PARAM_SPEC) out[p.id] = p.def;
  const dcir = cell?.dcirMOhm ?? 20;
  out.r0Ref = dcir;
  out.rc1R = dcir * 0.5;
  out.rc2R = dcir * 0.35;
  // LFP's flat plateau carries real hysteresis; sloped chemistries much less.
  if (cell?.chemistry === 'LFP') out.hystV = 0.012;
  return out;
}

// Anything the user hands us is clamped to its declared bounds and reported,
// so a typo cannot quietly produce a plausible-looking wrong answer.
export function validateParams(params) {
  const clamped = { ...params };
  const notes = [];
  for (const p of PARAM_SPEC) {
    const v = clamped[p.id];
    if (v == null || !isFinite(v)) { clamped[p.id] = p.def; notes.push(`${p.id}: missing → default ${p.def}`); continue; }
    if (v < p.min) { clamped[p.id] = p.min; notes.push(`${p.id}: ${v} below minimum → ${p.min} ${p.unit}`); }
    if (v > p.max) { clamped[p.id] = p.max; notes.push(`${p.id}: ${v} above maximum → ${p.max} ${p.unit}`); }
  }
  return { params: clamped, notes };
}

// Arrhenius scaling of a resistance from the reference temperature.
const arrhenius = (ref, eaJ, tK, tRefK) => ref * Math.exp((eaJ / R_GAS) * (1 / tK - 1 / tRefK));

// Resistance climbs at both ends of the SoC window — a parabola in SoC that
// equals 1 at mid-charge and `rise` at the extremes.
const socFactor = (soc, rise) => 1 + (rise - 1) * Math.pow(2 * Math.abs(soc - 0.5), 2);

export const SIM2_SUPPORTED_INITIAL_STATE = 'rested-equilibrium-at-ambient';

function restedInitialStateAssumption({ ambientC, nModules, datasetId = null }) {
  return Object.freeze({
    kind: SIM2_SUPPORTED_INITIAL_STATE,
    datasetId,
    rcPolarizationV: Object.freeze([0, 0]),
    hysteresisState: 0,
    thermalNodes: Object.freeze({ count: nModules, temperatureC: ambientC }),
  });
}

// Integrals of g(x)=1-exp(-x), evaluated with series where direct subtraction
// would discard the small result. They make the RC heat integral stable at
// both allowed extremes: dt/tau can be as small as 2e-7 or as large as 600.
function integratedRcShapes(x) {
  if (x < 1e-3) {
    const g1 = x * x * (0.5 + x * (-1 / 6 + x * (1 / 24 + x * (-1 / 120 + x / 720))));
    const g2 = x * x * x * (1 / 3 + x * (-1 / 4 + x * (7 / 60 - x / 24)));
    return { g1, g2 };
  }
  const oneMinusDecay = -Math.expm1(-x);
  const oneMinusDecay2 = -Math.expm1(-2 * x);
  return {
    g1: x - oneMinusDecay,
    g2: x - 2 * oneMinusDecay + 0.5 * oneMinusDecay2,
  };
}

function exactRcStep(voltage, current, resistance, tauS, dtS) {
  const x = dtS / tauS;
  const alpha = -Math.expm1(-x);
  const target = current * resistance;
  const delta = target - voltage;
  const nextVoltage = voltage + delta * alpha;
  if (!(resistance > 0)) return { nextVoltage, averageHeatW: 0 };

  // v(t)=v(0)+delta*(1-exp(-t/tau)). Integrating v(t)^2/R gives
  // dissipated branch energy without coupling heat to the integration step.
  const { g1, g2 } = integratedRcShapes(x);
  const integralV2S = voltage * voltage * dtS
    + 2 * voltage * delta * tauS * g1
    + delta * delta * tauS * g2;
  const averageHeatW = Math.max(0, integralV2S / (resistance * dtS));
  return { nextVoltage, averageHeatW };
}

const rcInstantHeat = (voltage, resistance) => (
  resistance > 0 ? voltage * voltage / resistance : 0
);

function thermalIntegrationPlan({
  cell, s, p, nModules, params, profileDtS, maximumThermalStepS = Infinity,
}) {
  const massCellKg = (cell.massG || 50) / 1000;
  const cthModuleJK = (massCellKg * s * p / nModules) * params.cpCellJkgK;
  const capRateWK = params.mdotKgS * params.cpCoolJkgK;
  const coolingConductanceWK = capRateWK > 0
    ? capRateWK * -Math.expm1(-params.hCoolWK / capRateWK)
    : 0;
  const conductionNeighbours = nModules <= 1 ? 0 : nModules === 2 ? 1 : 2;
  const totalNodeConductanceWK = conductionNeighbours * params.kCondWK
    + coolingConductanceWK + params.uaAmbWK / nModules;
  // For explicit dT/dt=(q-G*T)/C, dt<=C/G keeps the self-weight
  // non-negative. With non-negative neighbour/coolant weights this is a
  // monotone, bounded update rather than merely the looser oscillatory
  // stability limit dt<2C/G. The accuracy fraction also resolves the fastest
  // local time constant with at least 50 microsteps instead of treating the
  // positivity limit itself as an accurate discretisation.
  const stableThermalStepS = totalNodeConductanceWK > 0
    ? THERMAL_EXPLICIT_ACCURACY_FRACTION * cthModuleJK / totalNodeConductanceWK
    : Infinity;
  const appliedThermalStepS = Math.min(stableThermalStepS, maximumThermalStepS);
  if (!(cthModuleJK > 0) || !Number.isFinite(cthModuleJK)
    || !(appliedThermalStepS > 0)
    || (!Number.isFinite(appliedThermalStepS) && appliedThermalStepS !== Infinity)) {
    throw new RangeError('sim2 thermal integration requires finite positive heat capacity and step limits.');
  }
  const electricalSubsteps = Math.max(1, Math.ceil(profileDtS / params.maxDtS));
  const electricalStepS = profileDtS / electricalSubsteps;
  const thermalSubstepsPerElectricalStep = Number.isFinite(appliedThermalStepS)
    ? Math.max(1, Math.ceil(electricalStepS / appliedThermalStepS))
    : 1;
  const totalSubstepsPerProfileStep = electricalSubsteps * thermalSubstepsPerElectricalStep;
  if (!Number.isSafeInteger(electricalSubsteps)
    || !Number.isSafeInteger(thermalSubstepsPerElectricalStep)
    || !Number.isSafeInteger(totalSubstepsPerProfileStep)) {
    throw new RangeError('sim2 integration plan exceeds the safe integer range.');
  }
  return {
    cthModuleJK,
    appliedThermalStepS,
    electricalSubsteps,
    electricalStepS,
    thermalSubstepsPerElectricalStep,
    thermalStepS: electricalStepS / thermalSubstepsPerElectricalStep,
    totalSubstepsPerProfileStep,
  };
}

function resolveSim2Topology(s, p, requestedNModules) {
  if (!Number.isSafeInteger(s) || s < 1 || !Number.isSafeInteger(p) || p < 1
    || !Number.isSafeInteger(s * p)) {
    throw new RangeError('sim2 topology requires positive safe-integer s and p values.');
  }
  const nModules = requestedNModules == null ? Math.min(4, s * p) : requestedNModules;
  if (!Number.isSafeInteger(nModules) || nModules < 1) {
    throw new RangeError('sim2 topology requires a positive safe-integer nModules value.');
  }
  if (nModules > s * p) {
    throw new RangeError(`sim2 nModules (${nModules}) cannot exceed the ${s * p} modeled cells.`);
  }
  return nModules;
}

function sim2WorkPlan({
  cell, s, p, params, profileDtS, profileSamples, nModules,
  maximumThermalStepS = Infinity,
}) {
  const integration = thermalIntegrationPlan({
    cell, s, p, nModules, params, profileDtS, maximumThermalStepS,
  });
  const integrationStepCount = profileSamples * integration.totalSubstepsPerProfileStep;
  const thermalNodeUpdateCount = integrationStepCount * nModules;
  if (!Number.isSafeInteger(profileSamples) || profileSamples < 1
    || !Number.isSafeInteger(integrationStepCount)
    || !Number.isSafeInteger(thermalNodeUpdateCount)) {
    throw new RangeError('sim2 work estimate exceeds the safe integer range.');
  }
  return Object.freeze({
    profileSamples,
    nModules,
    electricalSubstepsPerSample: integration.electricalSubsteps,
    thermalSubstepsPerElectricalStep: integration.thermalSubstepsPerElectricalStep,
    temporalStepsPerSample: integration.totalSubstepsPerProfileStep,
    integrationStepCount,
    thermalNodeUpdateCount,
    electricalStepS: integration.electricalStepS,
    thermalStepS: integration.thermalStepS,
    cthModuleJK: integration.cthModuleJK,
    maximumThermalStepS: integration.appliedThermalStepS,
  });
}

/** Exact browser-safe preflight for the work simulate() will execute. */
export function estimateSim2Work({
  cell, s, p, params = null, profile, nModules: requestedNModules = null,
}) {
  if (!profile || !Number.isFinite(profile.dtS) || !(profile.dtS > 0)) {
    throw new RangeError('sim2 work estimation requires a finite positive profile.dtS.');
  }
  const steps = profile.w || profile.i;
  if (!Array.isArray(steps) || !steps.length) {
    throw new TypeError('sim2 work estimation requires a non-empty profile.w or profile.i array.');
  }
  const nModules = resolveSim2Topology(s, p, requestedNModules);
  const { params: checkedParams } = validateParams(params || defaultParams(cell));
  return sim2WorkPlan({
    cell, s, p, params: checkedParams, profileDtS: profile.dtS,
    profileSamples: steps.length, nModules,
  });
}

/**
 * Run the model.
 *
 * profile: { dtS, w[] } power in watts (+ discharge) or { dtS, i[] } pack amps.
 * Returns per-step series plus a summary, an aging estimate, and the list of
 * assumptions this particular run made.
 */
export function simulate(input) {
  return simulateModel(input);
}

function simulateModel({
  cell, s, p, params = null, profile,
  startSoC = 1.0, ambientC = 25, nModules: requestedNModules = null,
  seriesPerModule = null, years = null, cyclesPerYear = null,
}, { maximumThermalStepS = Infinity } = {}) {
  const { params: P, notes: paramNotes } = validateParams(params || defaultParams(cell));
  if (!profile || !(profile.dtS > 0)) return null;
  const steps = profile.w || profile.i;
  if (!steps?.length) return null;
  const usingPower = !!profile.w;
  const nModules = resolveSim2Topology(s, p, requestedNModules);

  const tRefK = P.tRefC + T0_K;
  const work = sim2WorkPlan({
    cell, s, p, nModules, params: P, profileDtS: profile.dtS,
    profileSamples: steps.length, maximumThermalStepS,
  });
  const integration = thermalIntegrationPlan({
    cell, s, p, nModules, params: P, profileDtS: profile.dtS, maximumThermalStepS,
  });
  if (work.integrationStepCount > MAX_SIM2_INTEGRATION_STEPS) {
    throw new RangeError(`sim2 run requires more than ${MAX_SIM2_INTEGRATION_STEPS.toLocaleString()} internal integration steps.`);
  }
  if (work.thermalNodeUpdateCount > MAX_SIM2_INTEGRATION_STEPS) {
    throw new RangeError(`sim2 run requires more than ${MAX_SIM2_INTEGRATION_STEPS.toLocaleString()} thermal node updates.`);
  }
  const { cthModuleJK } = integration;

  // Per-cell resistances scale to the pack: series adds, parallel divides.
  const packScale = s / p / 1000; // mΩ per cell → Ω at pack level
  const capAh = cell.capacityAh * p;

  // State. sim2 currently supports only a fully rested trial start. Keep that
  // assumption structured in the result so calibration evidence cannot hide
  // zero polarization, neutral hysteresis or thermal equilibrium at ambient.
  const initialStateAssumptions = Object.freeze([
    restedInitialStateAssumption({ ambientC, nModules }),
  ]);
  let soc = Math.min(1, Math.max(0, startSoC));
  let v1 = 0, v2 = 0;           // RC branch voltages (pack, V)
  let hyst = 0;                  // hysteresis state, −1…+1
  const T = Array.from({ length: nModules }, () => ambientC);
  let ahThroughput = 0, whOut = 0, whIn = 0, lossWh = 0, revHeatWh = 0;

  const series = { t: [], v: [], i: [], soc: [], tMax: [], tMin: [], tCoolOut: [], heatW: [] };
  const findings = [];
  let minV = Infinity, maxT = -Infinity, minSoC = soc, tSpreadMax = 0;
  let unmetWh = 0, tCoolOut = P.coolantInC;

  const nSub = integration.electricalSubsteps;
  const dt = integration.electricalStepS;
  const thermalSubsteps = integration.thermalSubstepsPerElectricalStep;
  const thermalDt = integration.thermalStepS;

  for (let k = 0; k < steps.length; k++) {
    for (let sub = 0; sub < nSub; sub++) {
      const tAvgK = T.reduce((a, b) => a + b, 0) / nModules + T0_K;
      const r0 = arrhenius(P.r0Ref, P.r0EaJ, tAvgK, tRefK) * socFactor(soc, P.r0SocRise) * packScale;
      const r1 = arrhenius(P.rc1R, P.r0EaJ, tAvgK, tRefK) * packScale;
      const r2 = arrhenius(P.rc2R, P.r0EaJ, tAvgK, tRefK) * packScale;
      const ocv = ocvCell(cell, soc) * s + hyst * P.hystV * s;

      // Current: either commanded directly, or solved from commanded power
      // against the instantaneous Thevenin source (OCV − v1 − v2 − I·R0).
      let I;
      if (!usingPower) {
        I = steps[k] * 1;
      } else {
        const pw = steps[k];
        const e = ocv - v1 - v2;
        const disc = e * e - 4 * r0 * pw;
        // Beyond the deliverable maximum the pack simply cannot follow the
        // demand; take the peak-power point and book the shortfall.
        I = disc >= 0 ? (e - Math.sqrt(disc)) / (2 * r0) : e / (2 * r0);
        if (disc < 0) unmetWh += (pw - (e * e) / (4 * r0)) * dt / 3600;
      }

      const vStart = ocv - v1 - v2 - I * r0;
      // Coulomb counting, with charge accepted at less than 100%.
      const dAh = (I * dt) / 3600;
      soc -= (I >= 0 ? dAh : dAh * P.coulombEff) / capAh;
      soc = Math.min(1, Math.max(0, soc));
      ahThroughput += Math.abs(dAh);
      if (I > 0) hyst = Math.max(-1, hyst - dt / 600);
      else if (I < 0) hyst = Math.min(1, hyst + dt / 600);

      // Constant-current RC branches have an exact exponential state update.
      // This stays stable even at the declared dt/tau extremes, unlike Euler
      // stepping, and supplies the interval-average resistive heat below.
      const rc1 = exactRcStep(v1, I, r1, P.rc1TauS, dt);
      const rc2 = exactRcStep(v2, I, r2, P.rc2TauS, dt);
      v1 = rc1.nextVoltage;
      v2 = rc2.nextVoltage;

      // Heat: irreversible in every resistive element, plus the reversible
      // entropic term, which cools the pack on charge and warms it on
      // discharge — and changes sign with the current, unlike I²R.
      const qIrrev = I * I * r0 + rc1.averageHeatW + rc2.averageHeatW;
      const qRev = -I * tAvgK * P.entropyVK * s;
      const qTotal = qIrrev + qRev;
      revHeatWh += qRev * dt / 3600;

      // Thermal network: each module generates its share (the worst one more
      // than its share), conducts to its neighbours, convects into a coolant
      // stream that warms as it flows, and leaks to ambient.
      const share = qTotal / nModules;
      // The coolant is a STREAM with a finite capacity rate, not a
      // fixed-temperature sink. Modelling it as a sink makes a stopped pump
      // cool as well as a fast one — which is exactly backwards, and would
      // tell someone their failed-pump case was fine. The ε-NTU form gets
      // both limits right: no flow removes no heat, and infinite flow is
      // limited by the conductance of the plate.
      const capRateWK = P.mdotKgS * P.cpCoolJkgK;          // W/K the stream can carry
      const effectiveness = capRateWK > 0 ? -Math.expm1(-P.hCoolWK / capRateWK) : 0;
      for (let thermalSub = 0; thermalSub < thermalSubsteps; thermalSub++) {
        let tCool = P.coolantInC;
        const dT = new Array(nModules).fill(0);
        for (let m = 0; m < nModules; m++) {
          const imbalance = nModules === 1
            ? 1
            : (m === 0 ? P.currentImbalance : (nModules - P.currentImbalance) / (nModules - 1));
          let q = share * imbalance;
          if (m > 0) q += P.kCondWK * (T[m - 1] - T[m]);
          if (m < nModules - 1) q += P.kCondWK * (T[m + 1] - T[m]);
          const qCool = effectiveness * capRateWK * (T[m] - tCool);
          q -= qCool;
          q -= (P.uaAmbWK / nModules) * (T[m] - ambientC);
          dT[m] = (q * thermalDt) / cthModuleJK;
          // What the stream absorbed it carries to the next module, arriving
          // warmer — which is why the last module in a loop runs hottest.
          if (capRateWK > 0) tCool += qCool / capRateWK;
        }
        for (let m = 0; m < nModules; m++) T[m] += dT[m];
        tCoolOut = tCool;
      }
      // The integration pass above used the pre-update temperature of each
      // microstep. Report coolant at the same final state as voltage, SoC and
      // module temperature by evaluating one read-only serial outlet pass.
      let reportedCoolantOut = P.coolantInC;
      for (let m = 0; m < nModules; m++) {
        reportedCoolantOut += effectiveness * (T[m] - reportedCoolantOut);
      }
      tCoolOut = reportedCoolantOut;

      // End-of-step output: every reported electrical and thermal quantity is
      // evaluated after this interval's state transition. This is the phase
      // declared by governed calibration datasets.
      const tHot = Math.max(...T), tCold = Math.min(...T);
      const tAvgEndK = T.reduce((a, b) => a + b, 0) / nModules + T0_K;
      const r0End = arrhenius(P.r0Ref, P.r0EaJ, tAvgEndK, tRefK) * socFactor(soc, P.r0SocRise) * packScale;
      const r1End = arrhenius(P.rc1R, P.r0EaJ, tAvgEndK, tRefK) * packScale;
      const r2End = arrhenius(P.rc2R, P.r0EaJ, tAvgEndK, tRefK) * packScale;
      const ocvEnd = ocvCell(cell, soc) * s + hyst * P.hystV * s;
      const vTerm = ocvEnd - v1 - v2 - I * r0End;
      const qIrrevEnd = I * I * r0End + rcInstantHeat(v1, r1End) + rcInstantHeat(v2, r2End);
      const qRevEnd = -I * tAvgEndK * P.entropyVK * s;
      const qTotalEnd = qIrrevEnd + qRevEnd;
      minV = Math.min(minV, vTerm); maxT = Math.max(maxT, tHot);
      minSoC = Math.min(minSoC, soc); tSpreadMax = Math.max(tSpreadMax, tHot - tCold);
      const wOut = ((vStart + vTerm) / 2) * I * dt / 3600;
      if (I >= 0) whOut += wOut; else whIn -= wOut;
      lossWh += qIrrev * dt / 3600;

      if (sub === nSub - 1) {
        series.t.push((k + 1) * profile.dtS);
        series.v.push(vTerm); series.i.push(I); series.soc.push(soc);
        series.tMax.push(tHot); series.tMin.push(tCold);
        series.tCoolOut.push(tCoolOut); series.heatW.push(qTotalEnd);
      }
    }
  }

  // Aging over the service life this duty implies.
  const aging = agingEstimate({
    params: P, tAvgC: maxT, meanSoC: (startSoC + minSoC) / 2,
    efc: ahThroughput / (2 * capAh), years, cyclesPerYear,
    cRate: capAh > 0 ? (series.i.reduce((a, b) => a + Math.abs(b), 0) / series.i.length) / capAh : 0,
  });

  if (minSoC <= 0.001) findings.push({ severity: 'fail', title: 'Pack runs empty', detail: `The mission is not completed: state of charge reaches zero${unmetWh > 0 ? ` and ${unmetWh.toFixed(0)} Wh of demand goes unmet` : ''}.`, category: 'electrical' });
  if (tSpreadMax > 5) findings.push({ severity: tSpreadMax > 10 ? 'fail' : 'warn', title: `Module temperature spread ${tSpreadMax.toFixed(1)} K`, detail: 'Modules at different temperatures age at different rates and drift apart in resistance and capacity. Above about 5 K the pack ages as its worst module; above 10 K the imbalance becomes the design limit. Increase module-to-module conduction, coolant flow, or improve current sharing.', category: 'thermal' });
  if (maxT > (cell.tempDischargeC?.[1] ?? 60)) findings.push({ severity: 'fail', title: `Peak module temperature ${maxT.toFixed(1)} °C`, detail: `Above the cell's rated discharge maximum of ${cell.tempDischargeC?.[1] ?? 60} °C.`, category: 'thermal' });

  return {
    series, findings,
    summary: {
      startSoC, endSoC: soc, minSoC, minV, maxTempC: maxT,
      tempSpreadK: tSpreadMax, coolantOutC: tCoolOut,
      energyOutWh: whOut, energyInWh: whIn, lossWh, reversibleHeatWh: revHeatWh,
      unmetWh, ahThroughput, equivalentFullCycles: ahThroughput / (2 * capAh),
      efficiencyPct: whOut > 0 ? (100 * (whOut - lossWh)) / whOut : null,
      durationS: steps.length * profile.dtS, nModules,
    },
    aging, params: P, paramNotes, initialStateAssumptions,
    assumptions: [
      `Initial state is ${SIM2_SUPPORTED_INITIAL_STATE}: both RC polarization voltages and hysteresis are zero, and all ${nModules} thermal nodes start at the ${ambientC} °C ambient temperature.`,
      `Equivalent-circuit model: OCV + R0 + 2 RC branches, Arrhenius temperature dependence (Ea ${Math.round(P.r0EaJ / 1000)} kJ/mol), ${P.hystV > 0 ? `${(P.hystV * 1000).toFixed(0)} mV hysteresis` : 'no hysteresis'}.`,
      `Reversible entropic heat included at dU/dT = ${P.entropyVK} V/K — it cools on charge and warms on discharge.`,
      `${nModules}-node thermal chain: ${P.kCondWK} W/K between modules, ${P.hCoolWK} W/K each into coolant at ${P.mdotKgS} kg/s, ${P.uaAmbWK} W/K to ${ambientC} °C ambient.`,
      `Worst module carries ${P.currentImbalance}× its share of the current.`,
      'Equivalent-circuit, NOT electrochemical: no concentration gradients, no particle diffusion, no plating model.',
      'Lumped nodes, NOT 3-D: this finds a hot module, not a hot corner.',
      'Default coefficients are class-typical estimates. Fit them to your own measurements with calibrate() before quoting the numbers.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Aging. Two mechanisms, both √-law, both temperature-driven: time alone, and
// throughput. Reported as capacity fade and resistance growth.
// ---------------------------------------------------------------------------
export function agingEstimate({ params, tAvgC = 25, meanSoC = 0.6, efc = 0, years = null, cyclesPerYear = null, cRate = 0.5 }) {
  const P = params;
  const tK = tAvgC + T0_K, tRefK = P.tRefC + T0_K;
  const arr = (ea) => Math.exp((-ea / R_GAS) * (1 / tK - 1 / tRefK));
  const socW = 1 + P.calSocK * (meanSoC - 0.5);
  const crW = Math.pow(Math.max(0.05, cRate), P.cycCrateK);
  const perYear = (y) => {
    const days = y * 365;
    const cal = P.calA * arr(P.calEaJ) * Math.max(0, socW) * Math.sqrt(days);
    const cyc = P.cycA * arr(P.cycEaJ) * crW * Math.sqrt(Math.max(0, efc) * (cyclesPerYear || 0) * y);
    return cal + cyc;
  };
  const out = { fadePctPerScenario: null, resistanceGrowthPct: null, years: null, schedule: [], extrapolated: false };
  // The correlation was fitted around normal operating temperatures. Run it at
  // 340 °C and the Arrhenius term explodes into numbers like minus a hundred
  // thousand percent remaining — which is not a pessimistic answer, it is a
  // meaningless one. Bound the output and SAY the model is outside its range,
  // rather than printing nonsense with a straight face.
  const OUTSIDE_RANGE_C = 60;
  if (tAvgC > OUTSIDE_RANGE_C) out.extrapolated = true;
  if (years > 0) {
    for (let y = 1; y <= Math.ceil(years); y++) {
      const fade = Math.min(100, Math.max(0, perYear(y)));
      out.schedule.push({
        year: y, capacityFadePct: fade, remainingPct: 100 - fade,
        resistanceGrowthPct: Math.min(1000, fade * P.resGrowthK),
      });
    }
    const last = out.schedule[out.schedule.length - 1];
    out.fadePctPerScenario = last.capacityFadePct;
    out.resistanceGrowthPct = last.resistanceGrowthPct;
    out.years = years;
    const eol = out.schedule.find((r) => r.remainingPct <= 80);
    out.yearsTo80Pct = eol ? eol.year : null;
  }
  out.note = 'Square-root calendar and cycle fade with Arrhenius temperature weighting. These coefficients are class estimates (§8) — fit them to your own cycling data before using the numbers for warranty.'
    + (out.extrapolated
      ? ` NOT VALID HERE: the pack averages ${tAvgC.toFixed(0)} °C, far outside the range this correlation describes. At that temperature the design has a thermal problem, not an aging one — fix the cooling and ask again.`
      : '');
  return out;
}

// ---------------------------------------------------------------------------
// Calibration — the part that makes the model yours.
//
// Give it what you measured (time, current, voltage, and temperature if you
// have it) and the names of the parameters you believe are wrong, and it
// searches for the values that reproduce your data. Nelder-Mead: derivative
// free, small, and adequate for the handful of coefficients that matter.
// ---------------------------------------------------------------------------
export function rmse(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new TypeError('RMSE requires two arrays.');
  if (a.length !== b.length) throw new RangeError(`RMSE requires equal lengths; received ${a.length} and ${b.length}.`);
  if (!a.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new TypeError(`RMSE operands at index ${i} must be finite.`);
    s += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(s / a.length);
}

export const MAX_CALIBRATION_DATASETS = 8;
export const DEFAULT_MAX_SAMPLES_PER_DATASET = 5_000;
export const MAX_PREPROCESSED_SAMPLES_PER_DATASET = MAX_CALIBRATION_PREPROCESSED_SAMPLES;
export const ECM_RC_MINIMUM_TIME_CONSTANT_RATIO = 3;
export const ORDERED_RC_CANDIDATE_POLICY = 'ordered-rc-v1';
export const CALIBRATION_MINIMUM_NORMALIZED_AXIS_STEP = 1e-8;
export const CALIBRATION_FIT_ELIGIBLE = Object.freeze(PARAM_SPEC
  .filter(({ group }) => group === 'electrical' || group === 'thermal')
  .map(({ id }) => id));

const CALIBRATION_FIT_ELIGIBLE_SET = new Set(CALIBRATION_FIT_ELIGIBLE);
const DEFAULT_MAX_EVALUATIONS = 2_000;
const DEFAULT_MAX_INTEGRATION_STEPS = MAX_SIM2_INTEGRATION_STEPS;

function calibrationObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function calibrationFinite(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${label} must be ${integer ? 'an integer ' : ''}from ${min} to ${max}.`);
  }
  return value;
}

function calibrationSeries(value, label, expectedLength = null) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (expectedLength == null && value.length < 3) throw new RangeError(`${label} must contain at least 3 samples.`);
  if (expectedLength != null && value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} samples; received ${value.length}.`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Number.isFinite(value[index])) throw new TypeError(`${label}[${index}] must be finite.`);
  }
  return value;
}

function calibrationMeasured(measured) {
  calibrationObject(measured, 'measured');
  calibrationFinite(measured.dtS, 'measured.dtS', { min: Number.MIN_VALUE, max: 3_600 });
  if (!Array.isArray(measured.i) || !Array.isArray(measured.v)
    || measured.i.length === 0 || measured.v.length === 0) {
    throw new TypeError('Calibration needs measured current and voltage series with at least 3 samples.');
  }
  const i = calibrationSeries(measured.i, 'measured.i');
  const v = calibrationSeries(measured.v, 'measured.v', i.length);
  const t = measured.t === undefined ? null : calibrationSeries(measured.t, 'measured.t', i.length);
  return { dtS: measured.dtS, i, v, t };
}

function calibrationFit(fit) {
  if (!Array.isArray(fit) || fit.length < 1 || fit.length > 8) {
    throw new RangeError('fit must be an array containing 1 to 8 parameter names.');
  }
  const names = [];
  const seen = new Set();
  for (let index = 0; index < fit.length; index++) {
    const name = fit[index];
    if (typeof name !== 'string' || !name) throw new TypeError(`fit[${index}] must be a non-empty string.`);
    if (seen.has(name)) throw new TypeError(`fit contains duplicate parameter "${name}".`);
    seen.add(name);
    const spec = PARAM_BY_ID[name];
    if (!spec) throw new TypeError(`Not parameters: "${name}" is not a model parameter. See PARAM_SPEC.`);
    if (!CALIBRATION_FIT_ELIGIBLE_SET.has(name)) {
      throw new TypeError(`Parameter "${name}" is not fit-eligible: calibration excludes ${spec.group} parameters, including maxDtS.`);
    }
    names.push(name);
  }
  return names;
}

function calibrationBaseParams(cell, overrides) {
  if (overrides !== null && overrides !== undefined) calibrationObject(overrides, 'params');
  const supplied = overrides || {};
  const unknown = Object.keys(supplied).filter((key) => !Object.hasOwn(PARAM_BY_ID, key));
  if (unknown.length) throw new TypeError(`Unknown calibration parameter override(s): ${unknown.join(', ')}.`);
  const base = { ...defaultParams(cell), ...supplied };
  for (const spec of PARAM_SPEC) {
    const value = base[spec.id];
    if (!Number.isFinite(value)) throw new TypeError(`params.${spec.id} must be finite; calibration does not repair missing values.`);
    if (value < spec.min || value > spec.max) {
      throw new RangeError(`params.${spec.id} must be from ${spec.min} to ${spec.max}; calibration does not clamp overrides.`);
    }
  }
  return Object.freeze(base);
}

function calibrationContext({ cell, s, p, startSoC, ambientC, nModules }) {
  calibrationObject(cell, 'cell');
  calibrationFinite(s, 's', { min: 1, max: 100_000, integer: true });
  calibrationFinite(p, 'p', { min: 1, max: 100_000, integer: true });
  calibrationFinite(startSoC, 'startSoC', { min: 0, max: 1 });
  calibrationFinite(ambientC, 'ambientC', { min: -100, max: 200 });
  calibrationFinite(nModules, 'nModules', { min: 1, max: 10_000, integer: true });
  if (!Number.isSafeInteger(s * p) || nModules > s * p) {
    throw new RangeError(`nModules (${nModules}) cannot exceed the ${s * p} modeled cells.`);
  }
  return Object.freeze({ cell, s, p, startSoC, ambientC, nModules });
}

function selectedSse(predicted, observed, selectedIndices) {
  if (predicted.length !== observed.length) {
    throw new RangeError(`Calibration prediction length ${predicted.length} does not match observation length ${observed.length}.`);
  }
  let sum = 0;
  const add = (index) => {
    if (!Number.isFinite(predicted[index]) || !Number.isFinite(observed[index])) {
      throw new RangeError(`Calibration operands at index ${index} must remain finite.`);
    }
    sum += (predicted[index] - observed[index]) ** 2;
  };
  if (selectedIndices === null) {
    for (let index = 0; index < predicted.length; index++) add(index);
    return { sum, count: predicted.length };
  }
  for (const index of selectedIndices) add(index);
  return { sum, count: selectedIndices.length };
}

function validateCalibrationLimits({ names, maxIter, maxEvaluations, maxIntegrationSteps, weightTemp }) {
  calibrationFinite(maxIter, 'maxIter', { min: 1, max: 100_000, integer: true });
  calibrationFinite(maxEvaluations, 'maxEvaluations', { min: names.length + 1, max: 1_000_000, integer: true });
  calibrationFinite(maxIntegrationSteps, 'maxIntegrationSteps', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
  calibrationFinite(weightTemp, 'weightTemp', { min: 0, max: 1_000_000 });
}

class CalibrationBudgetStop extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Choose one deterministic, numerically usable perturbation inside scalar
 * bounds and an optional coupled-candidate constraint. Full nominal steps in
 * either direction always win over a truncated boundary sliver; geometric
 * shrinking is used only when the coupled constraint requires it.
 */
export function boundAwareAdmissibleAxisStep({
  value,
  lower,
  upper,
  nominalNormalizedStep,
  minimumNormalizedStep = CALIBRATION_MINIMUM_NORMALIZED_AXIS_STEP,
  admissible = null,
}) {
  for (const [candidate, label] of [
    [value, 'value'], [lower, 'lower'], [upper, 'upper'],
    [nominalNormalizedStep, 'nominalNormalizedStep'],
    [minimumNormalizedStep, 'minimumNormalizedStep'],
  ]) {
    if (!Number.isFinite(candidate)) throw new TypeError(`${label} must be finite.`);
  }
  if (!(upper > lower) || value < lower || value > upper) {
    throw new RangeError('Axis bounds must contain value and have positive span.');
  }
  if (!(nominalNormalizedStep > 0 && nominalNormalizedStep <= 1)
    || !(minimumNormalizedStep > 0
      && minimumNormalizedStep <= nominalNormalizedStep)) {
    throw new RangeError('Normalized axis steps must satisfy 0 < minimum <= nominal <= 1.');
  }
  if (admissible !== null && typeof admissible !== 'function') {
    throw new TypeError('admissible must be a function or null.');
  }

  const span = upper - lower;
  const nominalStep = span * nominalNormalizedStep;
  const minimumStep = span * minimumNormalizedStep;
  const room = new Map([[1, upper - value], [-1, value - lower]]);
  const directions = room.get(1) >= room.get(-1) ? [1, -1] : [-1, 1];
  const accept = (direction, step) => {
    const candidate = value + direction * step;
    if (candidate === value || candidate < lower || candidate > upper) return null;
    if (admissible && !admissible(candidate)) return null;
    return Object.freeze({
      value: candidate,
      direction: direction > 0 ? 'increase' : 'decrease',
      delta: candidate - value,
      normalizedDelta: (candidate - value) / span,
    });
  };

  // First inspect both directions at the complete governed step. This avoids
  // selecting a roundoff-sized outward sliver when a full inward probe exists.
  for (const direction of directions) {
    if (room.get(direction) >= nominalStep) {
      const accepted = accept(direction, nominalStep);
      if (accepted) return accepted;
    }
  }

  // Coupled constraints can make a full step inadmissible even when a smaller
  // one is useful. Halving is deterministic and stops at the governed floor.
  for (const direction of directions) {
    let step = Math.min(room.get(direction), nominalStep);
    if (room.get(direction) >= nominalStep) step /= 2;
    while (step >= minimumStep) {
      const accepted = accept(direction, step);
      if (accepted) return accepted;
      step /= 2;
    }
  }
  return null;
}

function boundAwareInitialSimplex(x0, bounds, admissible = null) {
  return [x0, ...x0.map((_, axis) => {
    const value = x0[axis];
    const [lower, upper] = bounds[axis];
    const nominalStep = Math.max(
      (upper - lower) * 0.05,
      Math.abs(value) * 0.25,
      Number.EPSILON * Math.max(1, Math.abs(value)),
    );
    const selected = boundAwareAdmissibleAxisStep({
      value,
      lower,
      upper,
      nominalNormalizedStep: Math.min(1, nominalStep / (upper - lower)),
      admissible: admissible ? (candidate) => {
        const point = [...x0];
        point[axis] = candidate;
        return admissible(point);
      } : null,
    });
    if (selected) {
      const point = [...x0];
      point[axis] = selected.value;
      return point;
    }
    throw new Error(`Cannot construct a full-rank admissible simplex for axis ${axis}.`);
  })];
}

function calibrationCandidatePolicy(value) {
  if (value === null) return null;
  if (value !== ORDERED_RC_CANDIDATE_POLICY) {
    throw new TypeError(`candidatePolicy must equal "${ORDERED_RC_CANDIDATE_POLICY}".`);
  }
  return value;
}

function calibrationThermalStabilityParams(base, fittedNames) {
  const params = { ...base };
  const fitted = new Set(fittedNames);
  if (fitted.has('cpCellJkgK')) params.cpCellJkgK = PARAM_BY_ID.cpCellJkgK.min;
  for (const name of ['kCondWK', 'hCoolWK', 'uaAmbWK', 'mdotKgS', 'cpCoolJkgK']) {
    if (fitted.has(name)) params[name] = PARAM_BY_ID[name].max;
  }
  return params;
}

function parameterAtBound(value, spec) {
  const spanTolerance = (spec.max - spec.min) * 1e-8;
  const absoluteTolerance = Number.EPSILON
    * Math.max(1, Math.abs(spec.min), Math.abs(spec.max)) * 8;
  const tolerance = Math.max(spanTolerance, absoluteTolerance);
  return Math.abs(value - spec.min) <= tolerance
    || Math.abs(spec.max - value) <= tolerance;
}

function calibrateTrials({
  cell, trials, params, fit, maxIter, weightTemp, maxEvaluations,
  maxIntegrationSteps, datasetChecksums = [], preprocessing = [], notes = [],
  candidatePolicy = null,
}) {
  const names = calibrationFit(fit);
  const base = calibrationBaseParams(cell, params);
  const appliedCandidatePolicy = calibrationCandidatePolicy(candidatePolicy);
  const orderedRcAdmissibleParams = (candidate) => (
    candidate.rc2TauS / candidate.rc1TauS >= ECM_RC_MINIMUM_TIME_CONSTANT_RATIO
  );
  if (appliedCandidatePolicy && !orderedRcAdmissibleParams(base)) {
    throw new RangeError(`candidatePolicy "${appliedCandidatePolicy}" requires rc2TauS to remain at least ${ECM_RC_MINIMUM_TIME_CONSTANT_RATIO} times rc1TauS; the initial ratio is ${base.rc2TauS / base.rc1TauS}.`);
  }
  validateCalibrationLimits({ names, maxIter, maxEvaluations, maxIntegrationSteps, weightTemp });
  const initialStateAssumptions = Object.freeze(trials.map((trial, index) => (
    restedInitialStateAssumption({
      ambientC: trial.context.ambientC,
      nModules: trial.context.nModules,
      datasetId: preprocessing[index]?.datasetId ?? null,
    })
  )));

  // Thermal coefficients may themselves be fitted. Fix one conservative
  // thermal step for the complete optimization so candidates cannot alter
  // numerical fidelity or escape work accounting. The worst fitted values
  // maximize conductance and minimize node heat capacity.
  const stabilityParams = calibrationThermalStabilityParams(base, names);
  const trialIntegration = trials.map((trial) => {
    const plan = thermalIntegrationPlan({
      cell,
      s: trial.context.s,
      p: trial.context.p,
      nModules: trial.context.nModules,
      params: stabilityParams,
      profileDtS: trial.measured.dtS,
    });
    return {
      maximumThermalStepS: plan.appliedThermalStepS,
      work: trial.measured.i.length * plan.totalSubstepsPerProfileStep,
      nodeWork: trial.measured.i.length * plan.totalSubstepsPerProfileStep
        * trial.context.nModules,
    };
  });
  let workPerEvaluation = 0;
  let nodeWorkPerEvaluation = 0;
  for (const { work, nodeWork } of trialIntegration) {
    if (!Number.isSafeInteger(work) || !Number.isSafeInteger(workPerEvaluation + work)) {
      throw new RangeError('Calibration integration work exceeds the safe integer range.');
    }
    if (!Number.isSafeInteger(nodeWork)
      || !Number.isSafeInteger(nodeWorkPerEvaluation + nodeWork)) {
      throw new RangeError('Calibration thermal node-update work exceeds the safe integer range.');
    }
    workPerEvaluation += work;
    nodeWorkPerEvaluation += nodeWork;
  }
  if (nodeWorkPerEvaluation > MAX_SIM2_INTEGRATION_STEPS) {
    throw new RangeError(`Calibration evaluation requires more than ${MAX_SIM2_INTEGRATION_STEPS.toLocaleString()} thermal node updates.`);
  }
  const initialEvaluations = names.length + 1;
  if (workPerEvaluation > maxIntegrationSteps / initialEvaluations) {
    throw new RangeError(`maxIntegrationSteps must allow the ${initialEvaluations}-evaluation initial simplex (${(workPerEvaluation * initialEvaluations).toLocaleString()} steps).`);
  }

  let evaluationCount = 0;
  let integrationStepCount = 0;
  let thermalNodeUpdateCount = 0;
  let rejectedCandidateCount = 0;
  let proposalCount = 0;
  let cacheHitCount = 0;
  let minimumProposedRcTimeConstantRatio = Infinity;
  let bestRecord = null;
  const cache = new Map();

  const run = (vec) => {
    if (appliedCandidatePolicy) {
      if (proposalCount >= maxEvaluations) throw new CalibrationBudgetStop('max-evaluations');
      proposalCount++;
    }
    const key = JSON.stringify(vec);
    const cached = cache.get(key);
    if (cached) {
      if (appliedCandidatePolicy) cacheHitCount++;
      return cached;
    }
    if (!appliedCandidatePolicy && evaluationCount >= maxEvaluations) {
      throw new CalibrationBudgetStop('max-evaluations');
    }
    const trialParams = { ...base };
    names.forEach((name, index) => { trialParams[name] = vec[index]; });
    if (appliedCandidatePolicy) {
      minimumProposedRcTimeConstantRatio = Math.min(
        minimumProposedRcTimeConstantRatio,
        trialParams.rc2TauS / trialParams.rc1TauS,
      );
    }
    if (appliedCandidatePolicy && !orderedRcAdmissibleParams(trialParams)) {
      evaluationCount++;
      rejectedCandidateCount++;
      const rejected = {
        vec: [...vec], params: trialParams, cost: Infinity,
        voltageRmse: Infinity, temperatureRmse: null,
        voltageSampleCount: 0, temperatureSampleCount: 0,
      };
      cache.set(key, rejected);
      return rejected;
    }
    if (integrationStepCount + workPerEvaluation > maxIntegrationSteps) {
      throw new CalibrationBudgetStop('max-integration-steps');
    }
    evaluationCount++;
    integrationStepCount += workPerEvaluation;
    thermalNodeUpdateCount += nodeWorkPerEvaluation;
    let voltageSum = 0, voltageCount = 0, temperatureSum = 0, temperatureCount = 0;
    for (let trialIndex = 0; trialIndex < trials.length; trialIndex++) {
      const trial = trials[trialIndex];
      const result = simulateModel({
        cell, s: trial.context.s, p: trial.context.p, params: trialParams,
        profile: { dtS: trial.measured.dtS, i: trial.measured.i },
        startSoC: trial.context.startSoC, ambientC: trial.context.ambientC,
        nModules: trial.context.nModules,
      }, {
        maximumThermalStepS: trialIntegration[trialIndex].maximumThermalStepS,
      });
      if (!result) throw new Error('Validated calibration trial unexpectedly failed to simulate.');
      const voltage = selectedSse(result.series.v, trial.measured.v, trial.selectedIndices);
      voltageSum += voltage.sum;
      voltageCount += voltage.count;
      if (trial.measured.t !== null && weightTemp > 0) {
        const temperature = selectedSse(result.series.tMax, trial.measured.t, trial.selectedIndices);
        temperatureSum += temperature.sum;
        temperatureCount += temperature.count;
      }
    }
    const voltageRmse = voltageCount ? Math.sqrt(voltageSum / voltageCount) : Infinity;
    const temperatureRmse = temperatureCount ? Math.sqrt(temperatureSum / temperatureCount) : null;
    const record = {
      vec: [...vec], params: trialParams,
      cost: voltageRmse + (temperatureRmse === null ? 0 : weightTemp * temperatureRmse),
      voltageRmse, temperatureRmse, voltageSampleCount: voltageCount,
      temperatureSampleCount: temperatureCount,
    };
    cache.set(key, record);
    if (bestRecord === null || record.cost < bestRecord.cost) bestRecord = record;
    return record;
  };

  // Nelder-Mead over the chosen parameters, in their own units. Candidate
  // points are constrained to declared model bounds; caller input was already
  // checked strictly above and is never repaired or clamped.
  const x0 = names.map((name) => base[name]);
  const bounds = names.map((name) => [PARAM_BY_ID[name].min, PARAM_BY_ID[name].max]);
  const clampVec = (vec) => vec.map((value, index) => Math.min(bounds[index][1], Math.max(bounds[index][0], value)));
  const admissibleVector = appliedCandidatePolicy ? (vec) => {
    const candidate = { ...base };
    names.forEach((name, index) => { candidate[name] = vec[index]; });
    return orderedRcAdmissibleParams(candidate);
  } : null;
  const simplex = boundAwareInitialSimplex(x0, bounds, admissibleVector);
  let evals = simplex.map((vec) => ({ vec, cost: run(vec).cost }));
  const before = cache.get(JSON.stringify(x0));
  let iterations = 0;
  let terminationReason = 'max-iterations';

  for (; iterations < maxIter; iterations++) {
    evals.sort((a, b) => a.cost - b.cost);
    const best = evals[0], worst = evals[evals.length - 1];
    if (Math.abs(worst.cost - best.cost) < 1e-9) {
      terminationReason = 'converged';
      break;
    }
    try {
      const centroid = x0.map((_, index) => evals.slice(0, -1)
        .reduce((sum, entry) => sum + entry.vec[index], 0) / (evals.length - 1));
      const reflect = clampVec(centroid.map((value, index) => value + (value - worst.vec[index])));
      const reflectedCost = run(reflect).cost;
      if (reflectedCost < best.cost) {
        const expand = clampVec(centroid.map((value, index) => value + 2 * (value - worst.vec[index])));
        const expandedCost = run(expand).cost;
        evals[evals.length - 1] = expandedCost < reflectedCost
          ? { vec: expand, cost: expandedCost } : { vec: reflect, cost: reflectedCost };
      } else if (reflectedCost < evals[evals.length - 2].cost) {
        evals[evals.length - 1] = { vec: reflect, cost: reflectedCost };
      } else {
        const contract = clampVec(centroid.map((value, index) => value + 0.5 * (worst.vec[index] - value)));
        const contractedCost = run(contract).cost;
        if (contractedCost < worst.cost) {
          evals[evals.length - 1] = { vec: contract, cost: contractedCost };
        } else {
          const shrunk = [best];
          for (let index = 1; index < evals.length; index++) {
            const vec = clampVec(evals[index].vec.map((value, column) => best.vec[column] + 0.5 * (value - best.vec[column])));
            shrunk.push({ vec, cost: run(vec).cost });
          }
          evals = shrunk;
        }
      }
    } catch (error) {
      if (!(error instanceof CalibrationBudgetStop)) throw error;
      terminationReason = error.reason;
      break;
    }
  }

  const after = bestRecord;
  return {
    params: after.params,
    fitted: Object.fromEntries(names.map((name, index) => [name, {
      from: x0[index], to: after.vec[index],
      changedPct: x0[index] ? ((after.vec[index] - x0[index]) / x0[index]) * 100 : null,
      unit: PARAM_BY_ID[name].unit,
      atBound: parameterAtBound(after.vec[index], PARAM_BY_ID[name]),
    }])),
    rmseBefore: before.cost, rmseAfter: after.cost,
    voltageRmseBefore: before.voltageRmse, voltageRmseAfter: after.voltageRmse,
    temperatureRmseBefore: before.temperatureRmse, temperatureRmseAfter: after.temperatureRmse,
    improvementPct: before.cost > 0 ? (1 - after.cost / before.cost) * 100 : 0,
    iterations, evaluationCount, integrationStepCount, workPerEvaluation,
    nodeWorkPerEvaluation, thermalNodeUpdateCount,
    terminationReason, maxEvaluations, maxIntegrationSteps,
    voltageSampleCount: after.voltageSampleCount,
    temperatureSampleCount: after.temperatureSampleCount,
    datasetChecksums: [...datasetChecksums],
    checksumSemantics: datasetChecksums.length
      ? 'Dataset checksums identify exact canonical content; they do not authenticate its producer or custody.'
      : null,
    preprocessing: [...preprocessing], notes: [...notes], initialStateAssumptions,
    note: after.cost < before.cost
      ? 'The fitted parameters reproduce your measurements more closely than the defaults did. Check any parameter marked atBound — it wanted to go further than its limit allows, which usually means the model is missing an effect rather than the value being extreme.'
      : 'The fit did not improve on the defaults. Either the defaults already describe this cell, or the parameters chosen are not the ones your data is sensitive to.',
    ...(appliedCandidatePolicy ? {
      candidateConstraintEvidence: {
        policy: appliedCandidatePolicy,
        minimumRcTimeConstantRatio: ECM_RC_MINIMUM_TIME_CONSTANT_RATIO,
        proposalCount,
        cacheHitCount,
        rejectedCandidateCount,
        minimumProposedRcTimeConstantRatio,
        finalRcTimeConstantRatio: after.params.rc2TauS / after.params.rc1TauS,
      },
    } : {}),
  };
}

// Measured: { dtS, i: [A], v: [V], t?: [°C] } — current positive on discharge.
export function calibrate({
  cell, s, p, measured, params = null, fit = ['r0Ref', 'rc1R', 'rc1TauS'],
  startSoC = 1.0, ambientC = 25, nModules = 1, maxIter = 300, weightTemp = 0.2,
  maxEvaluations = DEFAULT_MAX_EVALUATIONS,
  maxIntegrationSteps = DEFAULT_MAX_INTEGRATION_STEPS,
}) {
  const context = calibrationContext({ cell, s, p, startSoC, ambientC, nModules });
  const checkedMeasured = calibrationMeasured(measured);
  return calibrateTrials({
    cell,
    trials: [{ context, measured: checkedMeasured, selectedIndices: null }],
    params, fit, maxIter, weightTemp, maxEvaluations, maxIntegrationSteps,
  });
}

function calibrateDatasetsImpl({
  cell, datasets, params = null, fit = ['r0Ref', 'rc1R', 'rc1TauS'],
  maxIter = 300, weightTemp = 0, maxEvaluations = DEFAULT_MAX_EVALUATIONS,
  maxIntegrationSteps = DEFAULT_MAX_INTEGRATION_STEPS,
  maxSamplesPerDataset = DEFAULT_MAX_SAMPLES_PER_DATASET,
}, candidatePolicy = null) {
  const values = Array.isArray(datasets) ? datasets : [datasets];
  if (values.length < 1 || values.length > MAX_CALIBRATION_DATASETS) {
    throw new RangeError(`datasets must contain 1 to ${MAX_CALIBRATION_DATASETS} canonical datasets.`);
  }
  calibrationFinite(maxSamplesPerDataset, 'maxSamplesPerDataset', {
    min: 8, max: MAX_PREPROCESSED_SAMPLES_PER_DATASET, integer: true,
  });
  calibrationFinite(weightTemp, 'weightTemp', { min: 0, max: 1_000_000 });
  const canonical = values.map((dataset) => readCalibrationDataset(dataset));
  const checksumSet = new Set();
  for (const dataset of canonical) {
    if (dataset.purpose !== 'calibration') throw new TypeError(`Dataset "${dataset.id}" has purpose "${dataset.purpose}"; calibration purpose is required.`);
    if (dataset.binding.initialState !== SIM2_SUPPORTED_INITIAL_STATE) {
      throw new TypeError(`Dataset "${dataset.id}" must declare binding.initialState "${SIM2_SUPPORTED_INITIAL_STATE}"; non-rested RC, hysteresis or thermal states are not supported.`);
    }
    if (checksumSet.has(dataset.checksum)) throw new TypeError(`Dataset checksum ${dataset.checksum} is duplicated in this calibration.`);
    checksumSet.add(dataset.checksum);
    if (dataset.binding.cellId !== cell?.id) {
      throw new TypeError(`Dataset "${dataset.id}" is bound to cell "${dataset.binding.cellId}" rather than "${cell?.id ?? 'unknown'}".`);
    }
  }
  const binding = canonical[0].binding;
  for (const dataset of canonical.slice(1)) {
    for (const key of ['cellId', 'seriesCells', 'parallelCells', 'moduleCount']) {
      if (dataset.binding[key] !== binding[key]) {
        throw new TypeError(`Dataset "${dataset.id}" has incompatible binding.${key}; joint calibration requires one cell/S/P/module topology.`);
      }
    }
  }
  const notes = [];
  for (const dataset of canonical) {
    const location = dataset.conventions.temperatureLocation;
    if (dataset.signals.temperatureC !== null && location !== 'module-maximum') {
      if (weightTemp > 0) {
        throw new TypeError(`Dataset "${dataset.id}" temperature is at ${location}; weightTemp requires module-maximum temperature.`);
      }
      notes.push(`Dataset ${dataset.id}: ignored ${location} temperature because sim2 calibrates only against module-maximum temperature; voltage remains included.`);
    }
  }
  const prepared = canonical.map((dataset) => preprocessCalibrationDataset(dataset, maxSamplesPerDataset));
  return calibrateTrials({
    cell,
    trials: prepared.map(({ measured, selectedIndices }, index) => ({
      context: calibrationContext({
        cell, s: canonical[index].binding.seriesCells, p: canonical[index].binding.parallelCells,
        startSoC: canonical[index].binding.startSoC, ambientC: canonical[index].binding.ambientC,
        nModules: canonical[index].binding.moduleCount,
      }),
      measured, selectedIndices,
    })),
    params, fit, maxIter, weightTemp, maxEvaluations, maxIntegrationSteps,
    datasetChecksums: canonical.map(({ checksum }) => checksum),
    preprocessing: prepared.map(({ preprocessing }) => preprocessing), notes,
    candidatePolicy,
  });
}

/** Calibrate one parameter set against one to eight governed, compatible trials. */
export function calibrateDatasets(input) {
  return calibrateDatasetsImpl(input);
}

/**
 * Governed staged-tuning seam with one closed coupled-candidate policy.
 * The ordinary Action 1 calibrateDatasets API and result shape remain unchanged.
 */
export function calibrateDatasetsConstrained(input) {
  calibrationObject(input, 'constrained calibration input');
  const allowed = new Set([
    'cell', 'datasets', 'params', 'fit', 'maxIter', 'weightTemp',
    'maxEvaluations', 'maxIntegrationSteps', 'maxSamplesPerDataset',
    'candidatePolicy',
  ]);
  const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw new TypeError(`Constrained calibration input contains unsupported field(s): ${unsupported.join(', ')}.`);
  }
  if (!Object.hasOwn(input, 'candidatePolicy')) {
    throw new TypeError(`Constrained calibration input requires candidatePolicy "${ORDERED_RC_CANDIDATE_POLICY}".`);
  }
  const { candidatePolicy, ...ordinary } = input;
  calibrationCandidatePolicy(candidatePolicy);
  return calibrateDatasetsImpl(ordinary, candidatePolicy);
}
