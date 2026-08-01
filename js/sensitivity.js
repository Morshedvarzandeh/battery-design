// sensitivity.js — "if a battery parameter changes, what happens to the
// cost?" One-at-a-time sensitivity of the design's economics, plus a
// decision-robustness check against the runner-up scenario. Pure functions.

import { costModel } from './optimizer.js';

// Parameters perturbed one at a time. Each knows how to build a modified
// (cell, usage) pair from a relative delta.
const PARAMS = [
  {
    id: 'price', label: 'Cell price',
    apply: (cell, usage, d) => [{ ...cell, priceUSD: cell.priceUSD != null ? cell.priceUSD * (1 + d) : null }, usage],
  },
  {
    id: 'cycleLife', label: 'Cycle life',
    apply: (cell, usage, d) => [{ ...cell, cycleLife: cell.cycleLife != null ? Math.max(1, Math.round(cell.cycleLife * (1 + d))) : null }, usage],
  },
  {
    id: 'cyclesPerYear', label: 'Usage (cycles/year)',
    apply: (cell, usage, d) => [cell, { ...usage, cyclesPerYear: usage.cyclesPerYear != null ? usage.cyclesPerYear * (1 + d) : null }],
  },
  {
    id: 'energy', label: 'Usable energy (capacity fade)',
    // Energy enters the delivered-kWh denominator; model as capacity change.
    applyEnergy: true,
  },
];

// One-at-a-time tornado around the base case.
// base: { cell, n, energyWh, usage:{cyclesPerYear,targetYears} }
// Returns rows sorted by how hard each parameter swings TCO (falling back
// to $/kWh delivered, then upfront, whichever exists).
export function sensitivityAnalysis(base, deltaPct = 20) {
  const d = Math.abs(deltaPct) / 100;
  const metric = (cm) => cm.tcoUSD ?? (cm.usdPerKWhDelivered != null ? cm.usdPerKWhDelivered * 1000 : cm.upfrontUSD);
  const metricName = (cm) => cm.tcoUSD != null ? 'tco' : (cm.usdPerKWhDelivered != null ? 'perKWh' : 'upfront');
  const baseCm = costModel(base.cell, base.n, base.energyWh, base.usage);
  const baseVal = metric(baseCm);
  if (baseVal == null) return { baseVal: null, basis: null, deltaPct, rows: [] };

  const rows = [];
  for (const p of PARAMS) {
    const run = (delta) => {
      if (p.applyEnergy) {
        return costModel(base.cell, base.n, base.energyWh * (1 + delta), base.usage);
      }
      const [c2, u2] = p.apply(base.cell, base.usage, delta);
      return costModel(c2, base.n, base.energyWh, base.usage === u2 ? base.usage : u2);
    };
    const lo = run(-d), hi = run(+d);
    const loVal = metric(lo), hiVal = metric(hi);
    if (loVal == null || hiVal == null) continue;
    rows.push({
      id: p.id, label: p.label,
      base: baseVal, lo: loVal, hi: hiVal,
      loReplacements: lo.replacements, hiReplacements: hi.replacements,
      swing: Math.max(Math.abs(loVal - baseVal), Math.abs(hiVal - baseVal)),
    });
  }
  rows.sort((a, b) => b.swing - a.swing);
  return { baseVal, basis: metricName(baseCm), deltaPct, rows, baseReplacements: baseCm.replacements };
}

// Decision robustness: how much would the WINNER's cell price have to rise
// before the runner-up becomes cheaper on the given basis? Positive result =
// headroom; null when either side lacks price data.
export function priceFlipThreshold(winner, runnerUp, basis = 'tco') {
  const cost = (cand) => basis === 'tco'
    ? (cand.tco?.tcoUSD ?? null)
    : (cand.costUSD ?? null);
  const cw = cost(winner), cr = cost(runnerUp);
  if (cw == null || cr == null || cw <= 0) return null;
  if (cr <= cw) return { alreadyCheaper: true, pct: 0 };
  // Both bases scale linearly with the winner's cell price.
  return { alreadyCheaper: false, pct: (cr / cw - 1) * 100 };
}
