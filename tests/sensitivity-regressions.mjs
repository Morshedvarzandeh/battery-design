// Regressions for the cost-sensitivity analysis and the patent landscape.
import { cellById } from '../js/cells.js';
import { sensitivityAnalysis, priceFlipThreshold } from '../js/sensitivity.js';
import { PATENT_LANDSCAPE, matchPatents } from '../js/patents.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } };

// --- Sensitivity on a TCO-bearing base case
{
  const c = cellById('samsung-inr21700-50e'); // $5, 500 cycles
  const base = { cell: c, n: 52, energyWh: 917, usage: { cyclesPerYear: 250, targetYears: 6 } };
  const S = sensitivityAnalysis(base, 20);
  ok(S.basis === 'tco' && S.baseVal > 0, `TCO basis chosen (${S.basis}, ${S.baseVal})`);
  ok(S.rows.length >= 3, `${S.rows.length} parameters analyzed`);
  const price = S.rows.find((r) => r.id === 'price');
  // Price is linear in TCO with fixed replacements: ±20% price → ±20% TCO.
  ok(Math.abs(price.hi / price.base - 1.2) < 1e-9 && Math.abs(price.lo / price.base - 0.8) < 1e-9,
    'price sensitivity is linear ±20%');
  // Cycle life ±20% around 500 crosses a replacement boundary at this duty
  // (1500 cycles needed: 400→4 packs, 500→3, 600→3): lo must jump cost up.
  const cyc = S.rows.find((r) => r.id === 'cycleLife');
  ok(cyc.lo > cyc.base && cyc.loReplacements > S.baseReplacements,
    `cycle-life downside triggers replacement jump (${cyc.loReplacements} packs)`);
  // Sorted by swing, descending.
  for (let i = 1; i < S.rows.length; i++) ok(S.rows[i - 1].swing >= S.rows[i].swing, 'tornado sorted');
}

// --- Sensitivity degrades gracefully without prices
{
  const c = { ...cellById('samsung-inr21700-50e'), priceUSD: null, cycleLife: null };
  const S = sensitivityAnalysis({ cell: c, n: 10, energyWh: 176, usage: {} }, 20);
  ok(S.baseVal === null && S.rows.length === 0, 'no-price case returns empty, not NaN');
}

// --- Price flip threshold
{
  const w = { tco: { tcoUSD: 1000 }, costUSD: 500 };
  const r = { tco: { tcoUSD: 1300 }, costUSD: 450 };
  const fl = priceFlipThreshold(w, r, 'tco');
  ok(Math.abs(fl.pct - 30) < 1e-9 && !fl.alreadyCheaper, 'flip at +30% on TCO basis');
  const fl2 = priceFlipThreshold(w, r, 'upfront');
  ok(fl2.alreadyCheaper === true, 'runner-up already cheaper upfront detected');
  ok(priceFlipThreshold({ tco: {}, costUSD: null }, r, 'tco') === null, 'null-safe');
}

// --- Patent landscape shape and matching
{
  for (const p of PATENT_LANDSCAPE) {
    ok(p.id && p.title && p.holder && p.covers && p.designNote, `${p.id || '?'} entry complete`);
    ok(Array.isArray(p.links) && p.links.length >= 1 &&
      p.links.every((u) => u.startsWith('https://patents.google.com/')),
      `${p.id} links to Google Patents only`);
  }
  const tesla2170 = cellById('tesla-2170-m3lr');
  const ribbonSel = { cooling: { kind: 'cooling-ribbon' }, busbar: { kind: 'wire-bond' } };
  const m1 = matchPatents({ cell: tesla2170, cellCount: 100, selection: ribbonSel });
  ok(m1.some((p) => p.id === 'tesla-serpentine'), 'ribbon cooling matches serpentine family');
  ok(m1.some((p) => p.id === 'wire-bond-interconnect'), 'wire bonds match');
  ok(!m1.some((p) => p.id === 'byd-blade-ctp'), 'blade family not matched for cylindrical NCA');
  const blade = cellById('byd-blade-lfp-150ah');
  const m2 = matchPatents({ cell: blade, cellCount: 138, selection: {} });
  ok(m2.some((p) => p.id === 'byd-blade-ctp') && m2.some((p) => p.id === 'ctp-catl'),
    'blade prismatic LFP matches CTP families');
  const m3 = matchPatents({ cell: tesla2170, cellCount: 5, selection: { cooling: { kind: 'natural-convection' } } });
  ok(!m3.some((p) => p.id === 'tesla-serpentine'), 'passive cooling does not match ribbon family');
  ok(m3.some((p) => p.id === 'cyl-module-architecture'), 'every cylindrical design gets the baseline family');
  const mPouch = matchPatents({ cell: cellById('generic-nmc-pouch-10ah-hp'), cellCount: 10, selection: {} });
  ok(mPouch.some((p) => p.id === 'pouch-module-architecture'), 'pouch baseline family matches');
}

console.log(fails === 0 ? 'SENSITIVITY/PATENT REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
