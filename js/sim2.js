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

export const R_GAS = 8.314462618;      // J/(mol·K)
export const T0_K = 273.15;

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

/**
 * Run the model.
 *
 * profile: { dtS, w[] } power in watts (+ discharge) or { dtS, i[] } pack amps.
 * Returns per-step series plus a summary, an aging estimate, and the list of
 * assumptions this particular run made.
 */
export function simulate({
  cell, s, p, params = null, profile,
  startSoC = 1.0, ambientC = 25, nModules = 4,
  seriesPerModule = null, years = null, cyclesPerYear = null,
}) {
  const { params: P, notes: paramNotes } = validateParams(params || defaultParams(cell));
  if (!profile || !(profile.dtS > 0)) return null;
  const steps = profile.w || profile.i;
  if (!steps?.length) return null;
  const usingPower = !!profile.w;

  const nCells = s * p;
  const tRefK = P.tRefC + T0_K;
  const massCellKg = (cell.massG || 50) / 1000;
  const cthModuleJK = (massCellKg * nCells / nModules) * P.cpCellJkgK;

  // Per-cell resistances scale to the pack: series adds, parallel divides.
  const packScale = s / p / 1000; // mΩ per cell → Ω at pack level
  const capAh = cell.capacityAh * p;

  // State
  let soc = Math.min(1, Math.max(0, startSoC));
  let v1 = 0, v2 = 0;           // RC branch voltages (pack, V)
  let hyst = 0;                  // hysteresis state, −1…+1
  const T = Array.from({ length: nModules }, () => ambientC);
  let ahThroughput = 0, whOut = 0, whIn = 0, lossWh = 0, revHeatWh = 0;

  const series = { t: [], v: [], i: [], soc: [], tMax: [], tMin: [], tCoolOut: [], heatW: [] };
  const findings = [];
  let minV = Infinity, maxT = -Infinity, minSoC = soc, tSpreadMax = 0;
  let unmetWh = 0, tCoolOut = P.coolantInC;

  const nSub = Math.max(1, Math.ceil(profile.dtS / P.maxDtS));
  const dt = profile.dtS / nSub;

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

      const vTerm = ocv - v1 - v2 - I * r0;
      // Coulomb counting, with charge accepted at less than 100%.
      const dAh = (I * dt) / 3600;
      soc -= (I >= 0 ? dAh : dAh * P.coulombEff) / capAh;
      soc = Math.min(1, Math.max(0, soc));
      ahThroughput += Math.abs(dAh);
      hyst = I > 0 ? Math.max(-1, hyst - dt / 600) : Math.min(1, hyst + dt / 600);

      // RC states relax toward I·R with their own time constants.
      v1 += (I * r1 - v1) * (dt / P.rc1TauS);
      v2 += (I * r2 - v2) * (dt / P.rc2TauS);

      // Heat: irreversible in every resistive element, plus the reversible
      // entropic term, which cools the pack on charge and warms it on
      // discharge — and changes sign with the current, unlike I²R.
      const qIrrev = I * I * r0 + v1 * v1 / Math.max(r1, 1e-9) + v2 * v2 / Math.max(r2, 1e-9);
      const qRev = -I * tAvgK * P.entropyVK * s;
      const qTotal = qIrrev + qRev;
      revHeatWh += qRev * dt / 3600;

      // Thermal network: each module generates its share (the worst one more
      // than its share), conducts to its neighbours, convects into a coolant
      // stream that warms as it flows, and leaks to ambient.
      const share = qTotal / nModules;
      let tCool = P.coolantInC;
      const dT = new Array(nModules).fill(0);
      // The coolant is a STREAM with a finite capacity rate, not a
      // fixed-temperature sink. Modelling it as a sink makes a stopped pump
      // cool as well as a fast one — which is exactly backwards, and would
      // tell someone their failed-pump case was fine. The ε-NTU form gets
      // both limits right: no flow removes no heat, and infinite flow is
      // limited by the conductance of the plate.
      const capRateWK = P.mdotKgS * P.cpCoolJkgK;          // W/K the stream can carry
      const effectiveness = capRateWK > 0 ? 1 - Math.exp(-P.hCoolWK / capRateWK) : 0;
      for (let m = 0; m < nModules; m++) {
        const imbalance = m === 0 ? P.currentImbalance : (nModules > 1 ? (nModules - P.currentImbalance) / (nModules - 1) : 1);
        let q = share * imbalance;
        if (m > 0) q += P.kCondWK * (T[m - 1] - T[m]);
        if (m < nModules - 1) q += P.kCondWK * (T[m + 1] - T[m]);
        const qCool = effectiveness * capRateWK * (T[m] - tCool);
        q -= qCool;
        q -= (P.uaAmbWK / nModules) * (T[m] - ambientC);
        dT[m] = (q * dt) / cthModuleJK;
        // What the stream absorbed it carries to the next module, arriving
        // warmer — which is why the last module in a loop runs hottest.
        if (capRateWK > 0) tCool += qCool / capRateWK;
      }
      for (let m = 0; m < nModules; m++) T[m] += dT[m];
      tCoolOut = tCool;

      const tHot = Math.max(...T), tCold = Math.min(...T);
      minV = Math.min(minV, vTerm); maxT = Math.max(maxT, tHot);
      minSoC = Math.min(minSoC, soc); tSpreadMax = Math.max(tSpreadMax, tHot - tCold);
      const wOut = vTerm * I * dt / 3600;
      if (I >= 0) whOut += wOut; else whIn -= wOut;
      lossWh += qIrrev * dt / 3600;

      if (sub === nSub - 1) {
        series.t.push(k * profile.dtS);
        series.v.push(vTerm); series.i.push(I); series.soc.push(soc);
        series.tMax.push(tHot); series.tMin.push(tCold);
        series.tCoolOut.push(tCoolOut); series.heatW.push(qTotal);
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
    aging, params: P, paramNotes,
    assumptions: [
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
  const out = { fadePctPerScenario: null, resistanceGrowthPct: null, years: null, schedule: [] };
  if (years > 0) {
    for (let y = 1; y <= Math.ceil(years); y++) {
      const fade = perYear(y);
      out.schedule.push({ year: y, capacityFadePct: fade, remainingPct: 100 - fade, resistanceGrowthPct: fade * P.resGrowthK });
    }
    const last = out.schedule[out.schedule.length - 1];
    out.fadePctPerScenario = last.capacityFadePct;
    out.resistanceGrowthPct = last.resistanceGrowthPct;
    out.years = years;
    const eol = out.schedule.find((r) => r.remainingPct <= 80);
    out.yearsTo80Pct = eol ? eol.year : null;
  }
  out.note = 'Square-root calendar and cycle fade with Arrhenius temperature weighting. These coefficients are class estimates (§8) — fit them to your own cycling data before using the numbers for warranty.';
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
  const n = Math.min(a.length, b.length);
  if (!n) return Infinity;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / n);
}

// Measured: { dtS, i: [A], v: [V], t?: [°C] } — current positive on discharge.
export function calibrate({
  cell, s, p, measured, params = null, fit = ['r0Ref', 'rc1R', 'rc1TauS'],
  startSoC = 1.0, ambientC = 25, nModules = 1, maxIter = 300, weightTemp = 0.2,
}) {
  const base = validateParams(params || defaultParams(cell)).params;
  const names = fit.filter((f) => PARAM_BY_ID[f]);
  if (!names.length) throw new Error(`Nothing to fit: ${fit.join(', ')} are not parameters. See PARAM_SPEC.`);
  if (!measured?.i?.length || !measured?.v?.length) throw new Error('Calibration needs measured current and voltage series.');

  const run = (vec) => {
    const trial = { ...base };
    names.forEach((n, i) => { trial[n] = vec[i]; });
    const { params: clamped } = validateParams(trial);
    const r = simulate({
      cell, s, p, params: clamped, profile: { dtS: measured.dtS, i: measured.i },
      startSoC, ambientC, nModules,
    });
    if (!r) return { cost: Infinity, params: clamped };
    let cost = rmse(r.series.v, measured.v);
    if (measured.t?.length && weightTemp > 0) cost += weightTemp * rmse(r.series.tMax, measured.t);
    return { cost, params: clamped, result: r };
  };

  // Nelder-Mead over the chosen parameters, in their own units.
  const x0 = names.map((n) => base[n]);
  const simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v * 1.25 + 1e-6 : v)))];
  let evals = simplex.map((v) => ({ v, f: run(v).cost }));
  const bounds = names.map((n) => [PARAM_BY_ID[n].min, PARAM_BY_ID[n].max]);
  const clampVec = (v) => v.map((x, i) => Math.min(bounds[i][1], Math.max(bounds[i][0], x)));
  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    evals.sort((a, b) => a.f - b.f);
    const best = evals[0], worst = evals[evals.length - 1];
    if (Math.abs(worst.f - best.f) < 1e-9) break;
    const centroid = x0.map((_, i) => evals.slice(0, -1).reduce((a, e) => a + e.v[i], 0) / (evals.length - 1));
    const reflect = clampVec(centroid.map((c, i) => c + (c - worst.v[i])));
    const fr = run(reflect).cost;
    if (fr < best.f) {
      const expand = clampVec(centroid.map((c, i) => c + 2 * (c - worst.v[i])));
      const fe = run(expand).cost;
      evals[evals.length - 1] = fe < fr ? { v: expand, f: fe } : { v: reflect, f: fr };
    } else if (fr < evals[evals.length - 2].f) {
      evals[evals.length - 1] = { v: reflect, f: fr };
    } else {
      const contract = clampVec(centroid.map((c, i) => c + 0.5 * (worst.v[i] - c)));
      const fc = run(contract).cost;
      if (fc < worst.f) evals[evals.length - 1] = { v: contract, f: fc };
      else evals = evals.map((e, i) => i === 0 ? e : { v: clampVec(e.v.map((x, j) => best.v[j] + 0.5 * (x - best.v[j]))), f: run(clampVec(e.v.map((x, j) => best.v[j] + 0.5 * (x - best.v[j])))).cost });
    }
  }
  evals.sort((a, b) => a.f - b.f);
  const before = run(x0), after = run(evals[0].v);
  return {
    params: after.params,
    fitted: Object.fromEntries(names.map((n, i) => [n, {
      from: x0[i], to: evals[0].v[i],
      changedPct: x0[i] ? ((evals[0].v[i] - x0[i]) / x0[i]) * 100 : null,
      unit: PARAM_BY_ID[n].unit,
      atBound: evals[0].v[i] <= PARAM_BY_ID[n].min * 1.0001 || evals[0].v[i] >= PARAM_BY_ID[n].max * 0.9999,
    }])),
    rmseBefore: before.cost, rmseAfter: after.cost,
    improvementPct: before.cost > 0 ? (1 - after.cost / before.cost) * 100 : 0,
    iterations,
    note: after.cost < before.cost
      ? 'The fitted parameters reproduce your measurements more closely than the defaults did. Check any parameter marked atBound — it wanted to go further than its limit allows, which usually means the model is missing an effect rather than the value being extreme.'
      : 'The fit did not improve on the defaults. Either the defaults already describe this cell, or the parameters chosen are not the ones your data is sensitive to.',
  };
}
