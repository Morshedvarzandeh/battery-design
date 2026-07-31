// optimizer.js — turns requirements into ranked pack designs, and packs a
// given S/P configuration into the smallest (or a constrained) volume.
//
// Pure functions over cells.js data and pack-engine.js math. No DOM.

import { electrical, gridDims, layoutPack, summarize, ARRANGEMENTS_BY_FORM } from './pack-engine.js';
import { cellEnergyWh } from './cells.js';
import { bayCapacity, scaleBayPlan } from './bay.js';

const ORIENTATIONS_BY_FORM = {
  cylindrical: ['upright', 'lying'],
  prismatic: ['upright'],
  pouch: ['upright', 'flat'],
};

// ---------------------------------------------------------------------------
// Space optimization: enumerate arrangements for a fixed cell and S/P
// ---------------------------------------------------------------------------
// target (optional): {x, y, z} mm outer envelope the pack must fit inside.
// Returns candidates sorted by (fits, volume): every entry has the options
// needed to reproduce it with layoutPack().

export function optimizeSpace(cell, s, p, baseOpts = {}, target = null, topK = 6) {
  const N = s * p;
  const spacingMm = baseOpts.spacingMm ?? 1;
  const layerGapMm = baseOpts.layerGapMm ?? 2;
  const wallMm = baseOpts.wallMm ?? 2;
  const headroomMm = baseOpts.headroomMm ?? (cell.form === 'cylindrical' ? 8 : 15);
  const underMm = baseOpts.underMm ?? 0;
  const rowExtraMm = baseOpts.rowExtraMm ?? 0;
  const out = [];
  const maxNz = Math.min(6, N);
  for (const orientation of ORIENTATIONS_BY_FORM[cell.form]) {
    for (const arrangement of ARRANGEMENTS_BY_FORM[cell.form]) {
      // Hex nesting is only real for upright cylinders; lying rows can't nest.
      if (arrangement === 'hex' && orientation === 'lying') continue;
      for (let nz = 1; nz <= maxNz; nz++) {
        const perLayer = Math.ceil(N / nz);
        const maxNx = Math.min(perLayer, 200);
        for (let nx = 1; nx <= maxNx; nx++) {
          const g = gridDims(cell, N, nx, nz, arrangement, spacingMm, layerGapMm, orientation, rowExtraMm);
          if (!g) continue;
          const outer = {
            x: g.innerX + 2 * wallMm,
            y: g.innerY + 2 * wallMm,
            z: g.innerZ + 2 * wallMm + headroomMm + underMm,
          };
          const fitsDirect = !target
            || (outer.x <= target.x && outer.y <= target.y && outer.z <= target.z);
          const fitsRotated = !fitsDirect && !!target
            && outer.y <= target.x && outer.x <= target.y && outer.z <= target.z;
          const volumeL = (outer.x * outer.y * outer.z) / 1e6;
          out.push({
            nx, ny: g.ny, nz, arrangement, orientation,
            outer, volumeL, fits: fitsDirect || fitsRotated, fitsRotated,
            opts: { arrangement, orientation, spacingMm, layerGapMm, wallMm, headroomMm, underMm, rowExtraMm, nx, nz },
          });
        }
      }
    }
  }
  out.sort((a, b) => (a.fits === b.fits) ? a.volumeL - b.volumeL : (a.fits ? -1 : 1));
  // Deduplicate near-identical shapes (transposed grids etc.) by rounded dims.
  const seen = new Set();
  const picked = [];
  for (const c of out) {
    const key = [Math.round(c.outer.x), Math.round(c.outer.y), Math.round(c.outer.z), c.arrangement, c.orientation]
      .join('|');
    const tkey = [Math.round(c.outer.y), Math.round(c.outer.x), Math.round(c.outer.z), c.arrangement, c.orientation]
      .join('|');
    if (seen.has(key) || seen.has(tkey)) continue;
    seen.add(key);
    picked.push(c);
    if (picked.length >= topK) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Requirement-driven design search
// ---------------------------------------------------------------------------
// req: {
//   vRange: [lo, hi]        acceptable nominal pack voltage (required)
//   energyWh                required energy (null if driven by power only)
//   contPowerW, peakPowerW  continuous / peak load (null ok)
//   chargeRateC             desired charge rate in C (null ok)
//   maxMassKg, maxDimsMm    hard constraints (null ok)
//   envTempC: [min, max]    operating environment (null ok)
//   preferredChemistries    ordered list, earlier = better (may be empty)
//   cyclesPerYear, targetYears   for cycle-life fit (null ok)
// }
// Returns ranked candidates: { cell, s, p, summary, best (space candidate),
//   score, reasons[], warnings[] }.

export function suggestDesigns(req, cells, topK = 8) {
  const raw = [];
  for (const cell of cells) {
    const sCands = seriesCandidates(cell, req.vRange);
    for (const s of sCands) {
      const cand = buildCandidate(cell, s, req);
      if (cand) raw.push(cand);
    }
  }
  if (raw.length === 0) return [];

  // Normalize metrics across the feasible field, then score.
  const norm = (get) => {
    const vals = raw.map(get).filter((v) => v != null && isFinite(v));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return (v) => (v == null || !isFinite(v) || hi === lo) ? 0.5 : (v - lo) / (hi - lo);
  };
  const nMass = norm((c) => c.summary.massKg);
  const nVol = norm((c) => c.summary.volumeL);
  const nCost = norm((c) => c.costUSD);
  const nCount = norm((c) => c.summary.cellCount);

  for (const c of raw) {
    const chemRank = req.preferredChemistries?.indexOf(c.cell.chemistry);
    const chemScore = (chemRank == null || chemRank < 0)
      ? 0.6
      : chemRank / Math.max(1, (req.preferredChemistries.length - 1) || 1) * 0.5;
    let cycleScore = 0.5;
    if (req.cyclesPerYear && req.targetYears && c.cell.cycleLife != null) {
      const need = req.cyclesPerYear * req.targetYears;
      cycleScore = c.cell.cycleLife >= need ? 0 : Math.min(1, (need - c.cell.cycleLife) / need);
      if (c.cell.cycleLife < need) {
        c.warnings.push(`Cycle life ${c.cell.cycleLife} < ~${need} cycles needed for ${req.targetYears} y`);
      } else {
        c.reasons.push(`Cycle life ${c.cell.cycleLife} covers ~${need} cycles target`);
      }
    }
    // Lower is better everywhere; weights sum to 1.
    c.score =
      0.24 * nMass(c.summary.massKg) +
      0.18 * nVol(c.summary.volumeL) +
      0.18 * nCost(c.costUSD) +
      0.10 * nCount(c.summary.cellCount) +
      0.15 * cycleScore +
      0.15 * chemScore +
      0.05 * c.penalty;
    c.score = Math.round((1 - c.score) * 1000) / 10; // present as 0–100, higher better
  }
  raw.sort((a, b) => b.score - a.score);
  return raw.slice(0, topK);
}

function seriesCandidates(cell, vRange) {
  if (!vRange) return [];
  const [lo, hi] = vRange;
  let sMin = Math.max(1, Math.ceil(lo / cell.nominalV));
  let sMax = Math.floor(hi / cell.nominalV);
  if (sMax < sMin) {
    // No integer count lands inside the window — take the closest and let the
    // candidate carry a warning.
    const s = Math.max(1, Math.round(((lo + hi) / 2) / cell.nominalV));
    return [s];
  }
  // At most three candidates spread across the window.
  const cands = new Set([sMin, sMax, Math.round((sMin + sMax) / 2)]);
  return [...cands].sort((a, b) => a - b);
}

function buildCandidate(cell, s, req) {
  const reasons = [];
  const warnings = [];
  let penalty = 0;

  const nominalV = s * cell.nominalV;
  if (req.vRange && (nominalV < req.vRange[0] - 1e-9 || nominalV > req.vRange[1] + 1e-9)) {
    warnings.push(`Nominal ${fmt(nominalV)} V falls outside ${req.vRange[0]}–${req.vRange[1]} V window`);
    penalty += 1;
  }

  // Parallel count from the binding constraint.
  const cellWh = cellEnergyWh(cell);
  const pE = req.energyWh ? Math.ceil(req.energyWh / (s * cellWh)) : 1;
  const pI = req.contPowerW ? Math.ceil(req.contPowerW / nominalV / cell.maxContDischargeA) : 1;
  const pulseA = cell.maxPulseDischargeA ?? cell.maxContDischargeA;
  const pPk = req.peakPowerW ? Math.ceil(req.peakPowerW / nominalV / pulseA) : 1;
  const p = Math.max(1, pE, pI, pPk);
  if (p === pE && req.energyWh) reasons.push('Sized by energy requirement');
  else if (p === pI && req.contPowerW && pI > pE) reasons.push('Sized by continuous power (energy alone would need fewer cells)');
  else if (p === pPk && req.peakPowerW && pPk > Math.max(pE, pI)) reasons.push('Sized by peak power');

  if (s * p > 5000) return null; // absurd designs out

  // Charge rate feasibility is per-cell: C * capacity vs max charge current.
  if (req.chargeRateC) {
    const cellChargeC = cell.maxContChargeA / cell.capacityAh;
    if (cellChargeC < req.chargeRateC) {
      warnings.push(`Cell supports ${fmt(cellChargeC)}C charge; ${fmt(req.chargeRateC)}C requested`);
      penalty += 0.5;
    } else {
      reasons.push(`Supports the requested ${fmt(req.chargeRateC)}C charge`);
    }
  }

  // Environment.
  if (req.envTempC) {
    const [lo, hi] = req.envTempC;
    if (lo < cell.tempDischargeC[0] || hi > cell.tempDischargeC[1]) {
      warnings.push(`Discharge window ${cell.tempDischargeC[0]}…${cell.tempDischargeC[1]} °C misses environment ${lo}…${hi} °C`);
      penalty += 1;
    }
    if (lo < cell.tempChargeC[0] && cell.chemistry !== 'LTO') {
      warnings.push(`Charging below ${cell.tempChargeC[0]} °C needs a heater or charge inhibit`);
    }
  }

  // Best compact layout, then hard constraints.
  const space = optimizeSpace(cell, s, p, {}, req.maxDimsMm || null, 1);
  const best = space[0];
  if (!best) return null;
  if (req.maxDimsMm && !best.fits) {
    warnings.push('Does not fit the size envelope in any orientation tried');
    penalty += 2;
  }
  const layout = layoutPack(cell, s, p, best.opts);
  const summary = summarize(cell, s, p, layout);

  if (req.maxMassKg && summary.massKg > req.maxMassKg) {
    warnings.push(`~${fmt(summary.massKg)} kg exceeds the ${req.maxMassKg} kg limit`);
    penalty += 2;
  }

  // Margin narration.
  if (req.contPowerW) {
    const util = req.contPowerW / summary.maxContPowerW;
    if (util <= 0.7) reasons.push(`${Math.round((1 - util) * 100)}% continuous-current headroom`);
    else if (util <= 1) warnings.push(`Only ${Math.round((1 - util) * 100)}% continuous-current headroom`);
    else warnings.push('Continuous power exceeds pack rating');
  }
  if (req.energyWh && summary.energyWh > req.energyWh * 1.6 && p > 1) {
    reasons.push('Energy overshoot from power sizing — consider a higher-power cell');
  }

  const costUSD = cell.priceUSD != null ? cell.priceUSD * s * p : null;
  return { cell, s, p, summary, best, layout, costUSD, reasons, warnings, penalty };
}

function fmt(v) {
  return v >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
}

// ---------------------------------------------------------------------------
// Max fill — the real-world flow: the application fixes the available space,
// the algorithm packs the maximum number of cells into it (after subtracting
// the space the selected supplier components consume) and treats the choice
// as a MULTI-OBJECTIVE optimization: maximize energy in the space, minimize
// cost, minimize mass. Candidates are scored with user weights and the
// Pareto-optimal (non-dominated) ones are flagged, so the trade-off surface
// stays visible instead of being collapsed silently.
// ---------------------------------------------------------------------------
// envelope: {x, y, z} outer mm.
// req: { vRange:[lo,hi], contPowerW|null, energyWh|null (minimum useful),
//        weights: {energy, cost, mass} — relative priorities, any scale }
// baseOpts: { spacingMm, wallMm, headroomMm, layerGapMm,
//             coolingSpace: {bottom, side, rowGap} }  — from the selected parts.

export function maxFill(cells, envelope, req, baseOpts = {}, topK = 8) {
  const spacingMm = baseOpts.spacingMm ?? 1;
  const wallMm = baseOpts.wallMm ?? 2;
  const layerGapMm = baseOpts.layerGapMm ?? 2;
  const cool = baseOpts.coolingSpace || { bottom: 0, side: 0, rowGap: 0 };
  // Integration allowance: real packs lose plan area to module walls, crash
  // structure, manifolds and wiring that this tool does not model. Validated
  // against the Tesla Model 3 LR (4,416 real cells vs 6,956 geometric ideal
  // in the same bay -> the OEM realizes ~64% of ideal, i.e. ~36% overhead).
  // Applied to the plan (x, y); height is left alone.
  const integ = Math.min(60, Math.max(0, baseOpts.integrationPct ?? 0)) / 100;
  const planFactor = Math.sqrt(1 - integ);
  // A non-rectangular bay (round, L-shape, stepped, drawn polygon) packs
  // against the real outline; a plain box keeps the fast rectangular path.
  const shaped = baseOpts.bay && baseOpts.bay.kind && baseOpts.bay.kind !== 'box';
  const bayScaled = shaped ? scaleBayPlan(baseOpts.bay, planFactor) : null;
  const env = envelope
    ? { x: envelope.x * planFactor, y: envelope.y * planFactor, z: envelope.z }
    : null;
  const out = [];

  for (const cell of cells) {
    const headroomMm = baseOpts.headroomMm ?? (cell.form === 'cylindrical' ? 8 : 15);
    let best = null;
    if (shaped) {
      const cap = bayCapacity(cell, bayScaled, {
        spacingMm, layerGapMm, wallMm, headroomMm,
        underMm: cool.bottom, rowExtraMm: cool.rowGap,
      });
      if (cap) {
        best = { nMax: cap.count, nx: null, ny: null, nz: null,
          arrangement: cap.arrangement, orientation: cap.orientation };
      }
    } else {
      for (const orientation of ORIENTATIONS_BY_FORM[cell.form]) {
        for (const arrangement of ARRANGEMENTS_BY_FORM[cell.form]) {
          if (arrangement === 'hex' && orientation === 'lying') continue;
          const cand = maxGridInBox(cell, env, {
            arrangement, orientation, spacingMm, wallMm, headroomMm, layerGapMm,
            underMm: cool.bottom, sideMm: cool.side, rowExtraMm: cool.rowGap,
          });
          if (cand && (!best || cand.nMax > best.nMax)) best = cand;
        }
      }
    }
    if (!best || best.nMax < 1) continue;

    // Best S×P split inside the voltage window: use as many of the fitted
    // cells as possible; ties go to the higher voltage (thinner busbars).
    const [vLo, vHi] = req.vRange || [1, 1000];
    const sMin = Math.max(1, Math.ceil(vLo / cell.nominalV));
    const sMax = Math.max(sMin, Math.floor(vHi / cell.nominalV) || sMin);
    let pick = null;
    for (let s = sMin; s <= sMax; s++) {
      const p = Math.floor(best.nMax / s);
      if (p < 1) continue;
      const n = s * p;
      if (!pick || n > pick.n || (n === pick.n && s > pick.s)) pick = { s, p, n };
    }
    if (!pick) continue;
    if (pick.s * cell.nominalV < vLo - 1e-9) continue; // can't reach the window

    const energyWh = pick.n * cell.nominalV * cell.capacityAh;
    if (req.energyWh && energyWh < req.energyWh) continue; // below the application's minimum
    const costUSD = cell.priceUSD != null ? cell.priceUSD * pick.n : null;
    const warnings = [];
    if (req.contPowerW) {
      const maxP = pick.s * cell.nominalV * pick.p * cell.maxContDischargeA;
      if (maxP < req.contPowerW) warnings.push(`Continuous power capability ${fmt(maxP)} W < required ${fmt(req.contPowerW)} W`);
    }
    out.push({
      cell, s: pick.s, p: pick.p, n: pick.n, nMax: best.nMax,
      utilization: pick.n / best.nMax,
      energyWh, costUSD,
      usdPerKWh: costUSD != null && energyWh > 0 ? costUSD / (energyWh / 1000) : null,
      massKg: (pick.n * cell.massG) / 1000, // cells only, comparable across candidates
      nominalV: pick.s * cell.nominalV,
      grid: { nx: best.nx, ny: best.ny, nz: best.nz },
      shaped: !!shaped,
      bay: shaped ? baseOpts.bay : null,
      warnings,
      opts: {
        arrangement: best.arrangement, orientation: best.orientation,
        spacingMm, wallMm, headroomMm, layerGapMm,
        underMm: cool.bottom, rowExtraMm: cool.rowGap,
        nx: best.nx ?? 0, nz: best.nz ?? 1,
      },
    });
  }
  scoreMultiObjective(out, req.weights);
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}

// Weighted-sum scalarization over normalized objectives, plus Pareto-front
// flagging over (energy up, cost down, mass down). Weights are relative
// priorities on any scale; when no candidate has a price, the cost weight is
// folded into energy rather than silently skewing the ranking.
function scoreMultiObjective(cands, weights) {
  if (!cands.length) return;
  let { energy: wE = 0.5, cost: wC = 0.3, mass: wM = 0.2 } = weights || {};
  const havePrices = cands.some((c) => c.costUSD != null);
  if (!havePrices) { wE += wC; wC = 0; }
  const sum = wE + wC + wM || 1;
  wE /= sum; wC /= sum; wM /= sum;

  const eMax = Math.max(...cands.map((c) => c.energyWh));
  const costs = cands.filter((c) => c.costUSD != null).map((c) => c.costUSD);
  const cMax = costs.length ? Math.max(...costs) : 1;
  const mMax = Math.max(...cands.map((c) => c.massKg));

  for (const c of cands) {
    const badEnergy = eMax > 0 ? 1 - c.energyWh / eMax : 0;
    // Unknown price gets the field's midpoint rather than a free ride.
    const badCost = cMax > 0 ? (c.costUSD != null ? c.costUSD / cMax : 0.5) : 0;
    const badMass = mMax > 0 ? c.massKg / mMax : 0;
    c.score = Math.round((1 - (wE * badEnergy + wC * badCost + wM * badMass)) * 1000) / 10;
    c.weightsUsed = { energy: wE, cost: wC, mass: wM };
  }
  for (const c of cands) {
    c.pareto = !cands.some((o) => o !== c &&
      o.energyWh >= c.energyWh &&
      (o.costUSD ?? Infinity) <= (c.costUSD ?? Infinity) &&
      o.massKg <= c.massKg &&
      (o.energyWh > c.energyWh || (o.costUSD ?? Infinity) < (c.costUSD ?? Infinity) || o.massKg < c.massKg));
  }
}

// Maximum nx*ny*nz of one cell that fits the envelope after subtracting
// walls, busbar headroom and the cooling system's reserved space. Verified
// against gridDims so the fill and the layout engine can never disagree.
function maxGridInBox(cell, env, o) {
  const od = { // mirror pack-engine's orientation footprints
    cylindrical: o.orientation === 'lying'
      ? { fx: cell.dims.d, fy: cell.dims.h, fz: cell.dims.d, hexOk: false }
      : { fx: cell.dims.d, fy: cell.dims.d, fz: cell.dims.h, hexOk: true },
    prismatic: { fx: cell.dims.w, fy: cell.dims.t, fz: cell.dims.h, hexOk: false },
    pouch: o.orientation === 'flat'
      ? { fx: cell.dims.w, fy: cell.dims.h, fz: cell.dims.t, hexOk: false }
      : { fx: cell.dims.w, fy: cell.dims.t, fz: cell.dims.h, hexOk: false },
  }[cell.form];
  const usableX = env.x - 2 * o.wallMm - 2 * o.sideMm;
  const usableY = env.y - 2 * o.wallMm;
  const usableZ = env.z - 2 * o.wallMm - o.headroomMm - o.underMm;
  if (usableX < od.fx || usableY < od.fy || usableZ < od.fz) return null;

  const hex = o.arrangement === 'hex' && od.hexOk;
  const pitchX = od.fx + o.spacingMm;
  const rowPitch = (hex ? pitchX * (Math.sqrt(3) / 2) : od.fy + o.spacingMm) + o.rowExtraMm;
  const ny = 1 + Math.floor((usableY - od.fy) / rowPitch);
  // Hex staggering costs pitch/2 of width whenever there is more than one row.
  const xBudget = usableX - od.fx - (hex && ny > 1 ? pitchX / 2 : 0);
  const nx = 1 + Math.floor(Math.max(0, xBudget) / pitchX);
  const nz = 1 + Math.floor((usableZ - od.fz) / (od.fz + o.layerGapMm));
  const nMax = nx * ny * nz;
  if (nMax < 1) return null;
  // Consistency check with the layout engine (must never overflow).
  const g = gridDims(cell, nMax, nx, nz, o.arrangement, o.spacingMm, o.layerGapMm, o.orientation, o.rowExtraMm);
  if (!g || g.innerX > usableX + 1e-6 || g.innerY > usableY + 1e-6 || g.innerZ > usableZ + 1e-6) return null;
  return { nx, ny, nz, nMax, arrangement: o.arrangement, orientation: o.orientation };
}
