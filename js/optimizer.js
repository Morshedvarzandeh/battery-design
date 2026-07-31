// optimizer.js — turns requirements into ranked pack designs, and packs a
// given S/P configuration into the smallest (or a constrained) volume.
//
// Pure functions over cells.js data and pack-engine.js math. No DOM.

import { electrical, gridDims, layoutPack, summarize, ARRANGEMENTS_BY_FORM } from './pack-engine.js';
import { cellEnergyWh } from './cells.js';

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
          const g = gridDims(cell, N, nx, nz, arrangement, spacingMm, layerGapMm, orientation);
          if (!g) continue;
          const outer = {
            x: g.innerX + 2 * wallMm,
            y: g.innerY + 2 * wallMm,
            z: g.innerZ + 2 * wallMm + headroomMm,
          };
          const fitsDirect = !target
            || (outer.x <= target.x && outer.y <= target.y && outer.z <= target.z);
          const fitsRotated = !fitsDirect && !!target
            && outer.y <= target.x && outer.x <= target.y && outer.z <= target.z;
          const volumeL = (outer.x * outer.y * outer.z) / 1e6;
          out.push({
            nx, ny: g.ny, nz, arrangement, orientation,
            outer, volumeL, fits: fitsDirect || fitsRotated, fitsRotated,
            opts: { arrangement, orientation, spacingMm, layerGapMm, wallMm, headroomMm, nx, nz },
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
