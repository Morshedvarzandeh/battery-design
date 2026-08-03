// sim1d.js — the level-1 mission simulation: the design, run through TIME.
//
// The static tool answers "is this pack big enough on paper"; this module
// answers "what actually happens over the mission": an equivalent-circuit
// electrical model (OCV(SoC) − I·R) driven step by step by the application's
// load profile, coupled to a lumped thermal model (I²R in, UA·ΔT out).
// It reports SoC(t), terminal voltage(t), pack temperature(t) and every
// violation as a finding: voltage cutoff under peak load, the pack running
// empty mid-mission, temperature leaving the rating, winter charge inhibit,
// regen lost against a full battery.
//
// HONESTY — what this is and is not:
//  · OCV curves are CHEMISTRY-CLASS shapes (LFP's flat plateau, NMC's slope)
//    anchored to the cell's own vMin/vMax — class-typical, not measured.
//  · Coulomb counting with constant DCIR; no RC dynamics, no aging, no
//    temperature-dependent resistance. First-order, like the rest of the tool.
//  · The thermal model is one lumped mass with one conductance to ambient —
//    it shows the trend and the steady state, not gradients inside the pack.
// This is the system-level simulation (level 1). Electrode-level physics
// (Newman/P2D) needs parameters manufacturers do not publish — deliberately
// out of scope.
//
// Pure functions, no DOM — runs in the browser and under node --test alike.

// Normalized OCV shapes u(soc) ∈ [0,1] between vMin (soc=0) and vMax (soc=1),
// per chemistry class. Piecewise-linear breakpoints [soc, u].
export const OCV_SHAPES = {
  // LFP / LTO: steep knees, long flat plateau — the defining LFP behavior.
  flat: [[0, 0], [0.05, 0.55], [0.15, 0.66], [0.5, 0.69], [0.9, 0.72], [0.97, 0.82], [1, 1]],
  // NMC / NCA / LCO: monotonic slope through the whole window.
  sloped: [[0, 0], [0.05, 0.3], [0.2, 0.42], [0.5, 0.54], [0.8, 0.68], [0.95, 0.83], [1, 1]],
  // Sodium-ion: close to linear — the steep, information-rich OCV.
  linear: [[0, 0], [1, 1]],
};
export const SHAPE_OF_CHEMISTRY = {
  LFP: 'flat', LTO: 'flat', NMC: 'sloped', NCA: 'sloped', LCO: 'sloped', NAION: 'linear',
};

// Cell open-circuit voltage at a state of charge (class-shape estimate).
export function ocvCell(cell, soc) {
  const pts = OCV_SHAPES[SHAPE_OF_CHEMISTRY[cell.chemistry] || 'sloped'];
  const x = Math.min(1, Math.max(0, soc));
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, u0] = pts[i - 1], [x1, u1] = pts[i];
      const u = u0 + ((x - x0) / (x1 - x0)) * (u1 - u0);
      return cell.vMin + u * (cell.vMax - cell.vMin);
    }
  }
  return cell.vMax;
}

// Solve pack current from demanded terminal power with V = OCV − I·R.
// P > 0 discharges. Returns { i, v, clamped } — clamped when the demand
// exceeds what the source can physically deliver (P_max = OCV²/4R).
function solveCurrent(pDemandW, ocvV, rOhm) {
  if (rOhm <= 0) return { i: pDemandW / ocvV, v: ocvV, clamped: false };
  const pMax = (ocvV * ocvV) / (4 * rOhm);
  let p = pDemandW, clamped = false;
  if (p > pMax) { p = pMax; clamped = true; }
  // Clamping to pMax makes the discriminant exactly 0 — keep floating-point
  // noise from turning it into sqrt(-1e-13) = NaN.
  const disc = Math.max(0, ocvV * ocvV - 4 * rOhm * p);
  const i = (ocvV - Math.sqrt(disc)) / (2 * rOhm);
  return { i, v: ocvV - i * rOhm, clamped };
}

/**
 * Run the mission.
 * @param {object} a
 *  cell            — library cell (vMin/vMax/capacityAh/chemistry/temp windows)
 *  s, p            — pack configuration
 *  profile         — { dtS, p: [-1..1] } (the tool's load-profile format)
 *  scaleW          — peak power the profile is scaled to (W)
 *  passes          — how many times the profile repeats (default 1)
 *  startSoC        — 0..1 (default 1)
 *  ambientC        — scenario ambient (°C)
 *  resistanceMOhm  — pack resistance incl. interconnect (falls back to S·R/P)
 *  uaWK            — thermal conductance to ambient (W/K); null → no thermal model
 *  thermalMassJK   — lumped heat capacity (J/K); default cells mass × 1000
 *  hasHeater       — the design carries a heater branch (winter charging)
 * @returns simulation result, or { unavailable, why } when inputs are missing.
 */
import { clampSteps } from './limits.js';

export function simulateMission(a) {
  // No mission may run forever: bound the work before starting it.
  {
    const b = clampSteps({ profileLength: a?.profile?.p?.length || 0, passes: a?.passes ?? 1 });
    a = { ...a, passes: b.passes, _limitNotes: b.notes };
  }
  const { cell, s, p, profile, scaleW } = a;
  if (!profile || !profile.p?.length || !(scaleW > 0)) {
    return { unavailable: true, why: 'No load profile applied — pick or upload one on the Usage tab.' };
  }
  const rCellMOhm = cell.dcirMOhm;
  const rMOhm = a.resistanceMOhm ?? (rCellMOhm != null ? (s * rCellMOhm) / p : null);
  if (rMOhm == null) {
    return { unavailable: true, why: `${cell.name} publishes no DCIR — the voltage/heat model has no resistance to work with.` };
  }
  const rOhm = rMOhm / 1000;
  const passes = Math.max(1, Math.round(a.passes ?? 1));
  const ambientC = a.ambientC ?? 25;
  const capAh = p * cell.capacityAh;
  const capC = capAh * 3600; // coulombs at 1 A·s
  const vMinPack = s * cell.vMin, vMaxPack = s * cell.vMax;
  const chargeFloorC = cell.tempChargeC?.[0] ?? 0;
  const tempMaxC = cell.tempDischargeC?.[1] ?? 60;
  const ua = a.uaWK > 0 ? a.uaWK : null;
  const cth = a.thermalMassJK > 0 ? a.thermalMassJK
    : Math.max(1, (s * p * (cell.massG ?? 50)) / 1000) * 1000; // ≈1 kJ/kgK cell class

  // Thermal stability: sub-step so explicit Euler stays well inside τ = C/UA.
  const dtProfile = profile.dtS;
  const sub = ua ? Math.min(20, Math.max(1, Math.ceil(dtProfile / (0.25 * (cth / ua))))) : 1;
  const dt = dtProfile / sub;

  let soc = Math.min(1, Math.max(0, a.startSoC ?? 1));
  let tC = ambientC;

  // The mission's step sequence: driving passes from the profile, plus
  // commanded CHARGE segments — top-ups after every pass (opportunity) or
  // one charge at the end (depot/base). The physics below treats commanded
  // charge like any other power demand, so the CV taper, the winter charge
  // floor and "already full" all fall out of the same code.
  const stepsW = [], stepKind = [];
  const ch = a.charge && a.charge.mode && a.charge.mode !== 'none' && a.charge.powerW > 0 ? a.charge : null;
  const chSteps = ch ? Math.max(1, Math.round(((ch.minutes ?? 15) * 60) / dtProfile)) : 0;
  for (let pass = 0; pass < passes; pass++) {
    for (const v of profile.p) { stepsW.push(v * scaleW); stepKind.push('drive'); }
    if (ch?.mode === 'topup') for (let q = 0; q < chSteps; q++) { stepsW.push(-ch.powerW); stepKind.push('charge'); }
  }
  if (ch?.mode === 'base') for (let q = 0; q < chSteps; q++) { stepsW.push(-ch.powerW); stepKind.push('charge'); }
  const nSteps = stepsW.length;

  // Traces (decimated later), extremes, energy books, event bookkeeping.
  const trace = { tS: [], soc: [], vPack: [], pW: [], tC: [], iA: [] };
  let minV = Infinity, maxT = -Infinity, minSoC = soc, peakHeatW = 0;
  let eOutWh = 0, eInWh = 0, lossWh = 0, heatWhSum = 0;
  let unmetWh = 0, regenLostWh = 0, chargeInhibitS = 0, cvTaperS = 0;
  let chargedWh = 0, chargeRefusedWh = 0;
  let firstEmptyS = null, firstCutoffS = null, firstHotS = null;

  for (let k = 0; k < nSteps; k++) {
    const want = stepsW[k]; // + discharge, − charge
    const kind = stepKind[k];
    let stepP = want;
    // Winter physics: charging below the cell's charge floor is inhibited
    // unless the design carries the heater branch (then the BTMS holds the
    // window — its energy cost is the heater's business, not modeled here).
    if (stepP < 0 && tC < chargeFloorC && !a.hasHeater) {
      chargeInhibitS += dtProfile;
      if (kind === 'drive') regenLostWh += (-stepP * dtProfile) / 3600;
      else chargeRefusedWh += (-stepP * dtProfile) / 3600;
      stepP = 0;
    }
    // Empty pack: demand goes unmet from here.
    if (stepP > 0 && soc <= 0) {
      if (firstEmptyS == null) firstEmptyS = k * dtProfile;
      unmetWh += (stepP * dtProfile) / 3600;
      stepP = 0;
    }
    // Full pack: drive-cycle regen has nowhere to go (a warning); a
    // commanded charge that reaches full has simply finished (not one).
    if (stepP < 0 && soc >= 1) {
      if (kind === 'drive') regenLostWh += (-stepP * dtProfile) / 3600;
      stepP = 0;
    }

    const ocv = s * ocvCell(cell, soc);
    let { i, v, clamped } = solveCurrent(stepP, ocv, rOhm);
    if (clamped && stepP > 0) {
      unmetWh += ((stepP - v * i) * dtProfile) / 3600; // shortfall against the demand
    }
    // Voltage cutoffs: hold the boundary instead of crossing it (what a BMS
    // does), and book the shortfall / taper.
    if (stepP > 0 && v < vMinPack) {
      if (firstCutoffS == null) firstCutoffS = k * dtProfile;
      const pHold = Math.max(0, (vMinPack * (ocv - vMinPack)) / rOhm);
      unmetWh += (Math.max(0, stepP - pHold) * dtProfile) / 3600;
      i = (ocv - vMinPack) / rOhm; v = vMinPack;
    } else if (stepP < 0 && v > vMaxPack) {
      cvTaperS += dtProfile;
      i = (ocv - vMaxPack) / rOhm; v = vMaxPack; // negative i: CV taper
    }

    // Books.
    const pTerm = v * i;
    if (pTerm > 0) eOutWh += (pTerm * dtProfile) / 3600;
    else {
      eInWh += (-pTerm * dtProfile) / 3600;
      if (kind === 'charge') chargedWh += (-pTerm * dtProfile) / 3600;
    }
    const heatW = i * i * rOhm;
    lossWh += (heatW * dtProfile) / 3600;
    peakHeatW = Math.max(peakHeatW, heatW);
    heatWhSum += (heatW * dtProfile) / 3600;

    // State updates: coulomb counting + lumped thermal (sub-stepped).
    soc = Math.min(1, Math.max(0, soc - (i * dtProfile) / capC));
    if (ua) {
      for (let q = 0; q < sub; q++) tC += ((heatW - ua * (tC - ambientC)) * dt) / cth;
    }

    minV = Math.min(minV, v); maxT = Math.max(maxT, tC); minSoC = Math.min(minSoC, soc);
    if (tC > tempMaxC && firstHotS == null) firstHotS = k * dtProfile;

    trace.tS.push(k * dtProfile); trace.soc.push(soc); trace.vPack.push(v);
    trace.pW.push(pTerm); trace.tC.push(ua ? tC : null); trace.iA.push(i);
  }

  // Decimate the traces to a chartable size.
  const MAXPTS = 600;
  const stride = Math.max(1, Math.ceil(nSteps / MAXPTS));
  const dec = (arr) => arr.filter((_, idx) => idx % stride === 0);
  for (const k2 of Object.keys(trace)) trace[k2] = dec(trace[k2]);

  const durationS = nSteps * dtProfile;
  const fmtT = (sec) => sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`;

  // Findings — same shape the Analysis panes and report already speak.
  const findings = [];
  if (firstEmptyS != null) {
    findings.push({
      id: 'sim-empty',
      severity: 'fail', category: 'simulation',
      title: `Pack runs EMPTY at ${fmtT(firstEmptyS)} — ${Math.round(unmetWh)} Wh of the mission unmet`,
      detail: `Starting from ${Math.round((a.startSoC ?? 1) * 100)}% SoC the pack is exhausted before the mission ends. More capacity, a shallower mission, or mid-mission charging is required.`,
      ref: 'mission simulation (coulomb counting)',
    });
  } else if (firstCutoffS != null) {
    findings.push({
      id: 'sim-voltage-cutoff',
      severity: 'fail', category: 'simulation',
      title: `Voltage cutoff under load at ${fmtT(firstCutoffS)}`,
      detail: `Sag (I·R) drives the terminal voltage to the ${vMinPack.toFixed(1)} V cutoff during a peak while charge remains — the pack is power-limited, not energy-limited. Lower-DCIR cells or more parallel strings fix this.`,
      ref: 'mission simulation (OCV − I·R)',
    });
  } else if (unmetWh > 0.005) {
    findings.push({
      id: 'sim-peak-unmet',
      severity: 'warn', category: 'simulation',
      title: `${unmetWh.toFixed(1)} Wh of peak demand not deliverable`,
      detail: 'Moments of the profile exceed what the source impedance can physically deliver (P ≤ OCV²/4R); the simulation clamps them. Check the peaks against the pack\'s pulse rating.',
      ref: 'mission simulation',
    });
  }
  if (firstHotS != null) {
    findings.push({
      id: 'sim-overtemp',
      severity: 'fail', category: 'simulation',
      title: `Temperature exceeds the cell rating (${tempMaxC} °C) at ${fmtT(firstHotS)}`,
      detail: `Lumped pack temperature reaches ${maxT.toFixed(1)} °C at ${ambientC} °C ambient — the cooling as modeled cannot hold the mission. A stronger loop or a derated mission is needed.`,
      ref: 'mission simulation (lumped thermal)',
    });
  } else if (ua && maxT > tempMaxC - 5) {
    findings.push({
      id: 'sim-temp-margin',
      severity: 'warn', category: 'simulation',
      title: `Temperature peaks at ${maxT.toFixed(1)} °C — within 5 °C of the rating`,
      detail: `At ${ambientC} °C ambient the mission ends ${(tempMaxC - maxT).toFixed(1)} °C under the ${tempMaxC} °C limit. A hotter day erases the margin.`,
      ref: 'mission simulation (lumped thermal)',
    });
  }
  if (chargeInhibitS > 0) {
    findings.push({
      id: 'sim-charge-inhibited',
      severity: 'warn', category: 'simulation',
      title: `Charging inhibited for ${fmtT(chargeInhibitS)} — below the ${chargeFloorC} °C charge floor`,
      detail: `${(regenLostWh + chargeRefusedWh).toFixed(1)} Wh of charge/regen is refused while the pack sits below the cell's charge window and the design has no heater branch. The Thermal tab adds one when the climate demands it.`,
      ref: 'mission simulation (charge window)',
    });
  } else if (regenLostWh > 0.005) {
    findings.push({
      id: 'sim-regen-lost',
      severity: 'warn', category: 'simulation',
      title: `${regenLostWh.toFixed(1)} Wh of regen lost against a full battery`,
      detail: 'Charge arrives while SoC is at 100% (or the CV boundary) and is turned away. Starting the mission below full converts this into recovered energy.',
      ref: 'mission simulation',
    });
  }
  if (!findings.some((f) => f.severity === 'fail')) {
    findings.push({
      id: 'sim-mission-ok',
      severity: 'pass', category: 'simulation',
      title: `Mission completes: SoC ${Math.round((a.startSoC ?? 1) * 100)}% → ${Math.round(soc * 100)}%`,
      detail: `${passes}× profile (${fmtT(durationS)}): V ≥ ${minV.toFixed(1)} V (cutoff ${vMinPack.toFixed(1)} V)` +
        (ua ? `, T ≤ ${maxT.toFixed(1)} °C (limit ${tempMaxC} °C)` : '') +
        `, round-trip loss ${lossWh.toFixed(1)} Wh.`,
      ref: 'mission simulation',
    });
  }

  return {
    unavailable: false,
    trace, durationS, passes, ambientC, stride,
    summary: {
      startSoC: a.startSoC ?? 1, endSoC: soc, minSoC, minV, maxT: ua ? maxT : null,
      energyOutWh: eOutWh, energyInWh: eInWh, lossWh,
      efficiencyPct: eOutWh + lossWh > 0 ? (eOutWh / (eOutWh + lossWh)) * 100 : null,
      peakHeatW, avgHeatW: durationS > 0 ? (heatWhSum * 3600) / durationS : 0,
      unmetWh, regenLostWh, chargeInhibitS, cvTaperS,
      chargedWh, chargeRefusedWh, chargeMode: ch?.mode ?? 'none',
      vMinPack, vMaxPack, tempMaxC, chargeFloorC,
      resistanceMOhm: rMOhm, uaWK: ua, thermalMassJK: cth,
    },
    findings,
    assumptions: [
      ...(a._limitNotes || []),
      `OCV(SoC) is a ${SHAPE_OF_CHEMISTRY[cell.chemistry] || 'sloped'}-class shape anchored to this cell's ${cell.vMin}–${cell.vMax} V window — class-typical, not measured.`,
      `Constant pack resistance ${rMOhm.toFixed(1)} mΩ (no RC dynamics, no temperature dependence).`,
      'Coulomb counting; charge acceptance treated as ideal inside the window.',
      ua ? `One lumped thermal mass (${(cth / 1000).toFixed(1)} kJ/K) with ${ua.toFixed(1)} W/K to a fixed ${ambientC} °C ambient.`
        : 'No thermal model for this run — the cooling data gives no conductance.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Cell comparison over the SAME mission. The compare ticks in the cell
// picker already drive the radar; this runs the identical mission for each
// ticked cell, built as the equivalent pack for the same job: S from the
// design's voltage, P from its energy target. Same profile, same climate,
// same cooling conductance — the CELLS differ, nothing else, so the
// difference in outcome is the difference in value.
// ---------------------------------------------------------------------------
export function compareCells({ cells, targetVNom, targetEnergyWh, profile, scaleW, passes = 1, startSoC = 1, ambientC = 25, interconnectMOhm = 0, uaWK = null, hasHeater = false, currentId = null }) {
  const rows = [];
  for (const cell of cells || []) {
    const s = Math.max(1, Math.round((targetVNom || cell.nominalV) / cell.nominalV));
    const cellWh = cell.nominalV * cell.capacityAh;
    const p = Math.max(1, Math.round((targetEnergyWh || s * cellWh) / (s * cellWh)));
    const energyWh = s * p * cellWh;
    const massKg = (s * p * (cell.massG ?? 0)) / 1000;
    const resistanceMOhm = cell.dcirMOhm != null ? (s * cell.dcirMOhm) / p + interconnectMOhm : null;
    const notes = [];
    // Honesty: a big-format cell can overshoot a small target even at 1P.
    if (targetEnergyWh && energyWh > 2 * targetEnergyWh) {
      notes.push(`oversized for this job — ${s}S1P is already ${(energyWh / targetEnergyWh).toFixed(1)}× the target energy`);
    }
    const sim = simulateMission({
      cell, s, p, profile, scaleW, passes, startSoC, ambientC,
      resistanceMOhm: resistanceMOhm ?? undefined,
      uaWK, thermalMassJK: Math.max(1, massKg) * 1000, hasHeater,
    });
    rows.push({
      cell, s, p, energyWh, massKg, resistanceMOhm, notes, sim,
      current: cell.id === currentId,
      verdict: sim.unavailable ? 'unavailable'
        : sim.findings.some((f) => f.severity === 'fail') ? 'fail'
        : sim.findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass',
    });
  }
  return {
    rows,
    basis: `Each cell built as the equivalent pack for the same job (S from the ${Math.round(targetVNom)} V window, P from the ${Math.round(targetEnergyWh)} Wh target), run through the identical mission, climate and cooling conductance.`,
  };
}
