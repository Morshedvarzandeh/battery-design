#!/usr/bin/env node
// validate-vs-market.mjs — benchmark the max-fill algorithm against real EV
// packs on the market, then run "what if this car used a different battery"
// swaps. Ground truth (public press/teardown figures):
//
//   Tesla Model 3 Long Range: 4416x 2170 cells, 96s46p, 78.1 kWh nominal,
//     ~350 V nominal, pack 479 kg; flat cell region of the ~2180x1500 mm pack
//     (height of the cell section ~110 mm; the rear "penthouse" holds
//     electronics and is excluded here).
//   Nissan Leaf 40 kWh: 192 pouch cells 96s2p, ~39.5 kWh, ~350 V,
//     pack 1547 x 1188 x 264 mm, 303 kg (stepped enclosure; we use the
//     rectangular envelope, which flatters the fill).
//   BYD Atto 3: 138 LFP blades (~960 x 90 x 13.5 mm), 60.5 kWh gross at
//     ~403 V nominal (cell-to-pack: blades ARE the structure).
//
// Run: node tools/validate-vs-market.mjs [--calibrate]

import { CELLS, cellById } from '../js/cells.js';
import { maxFill } from '../js/optimizer.js';

const base = { spacingMm: 1, wallMm: 2, layerGapMm: 2, coolingSpace: { bottom: 10, side: 0, rowGap: 0 } };
const kwh = (wh) => (wh / 1000).toFixed(1);

const CARS = [
  {
    name: 'Tesla Model 3 LR',
    bay: { x: 2100, y: 1440, z: 110 },
    vRange: [320, 365],
    oem: { kWh: 78.1, cells: 4416, cellId: 'tesla-2170-m3lr', packKg: 479 },
  },
  {
    name: 'Nissan Leaf 40',
    // The Leaf enclosure is STEPPED — 264 mm exists only under the seats,
    // most of the pack is far shallower. Using the rectangular bounding box
    // therefore flatters the volume enormously; the low OEM/ideal ratio here
    // quantifies exactly why the bay-shape editor exists.
    bay: { x: 1547, y: 1188, z: 264 },
    stepped: true,
    vRange: [320, 365],
    oem: { kWh: 39.5, cells: 192, cellId: 'generic-nmc-pouch-60ah-ev', packKg: 303 },
  },
  {
    name: 'BYD Atto 3 (blade swap target)',
    // No public pack drawing; M3-class skateboard plan with a 120 mm CTP
    // height (blade cells stand 90 mm with end terminals — estimate).
    bay: { x: 2100, y: 1440, z: 120 },
    vRange: [380, 420],
    oem: { kWh: 60.5, cells: 138, cellId: 'byd-blade-lfp-150ah', packKg: null },
  },
];

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('  ✗', m); fails++; } };

console.log('=== A. Self-consistency: rebuild each car from its own cell ===');
const ratios = [];
for (const car of CARS) {
  const cell = cellById(car.oem.cellId);
  const req = { vRange: car.vRange, weights: { energy: 1, cost: 0, mass: 0 } };
  const r = maxFill([cell], car.bay, req, base, 1)[0];
  if (!r) { console.log(`${car.name}: cell does not fit the bay at all`); fails++; continue; }
  const ratio = car.oem.kWh / (r.energyWh / 1000);
  ratios.push({ car: car.name, ratio });
  console.log(`${car.name}: ideal fill ${r.n} cells / ${kwh(r.energyWh)} kWh ` +
    `(${r.s}S${r.p}P, ${r.grid.nx}x${r.grid.ny}${r.grid.nz > 1 ? 'x' + r.grid.nz : ''}) ` +
    `vs OEM ${car.oem.cells} cells / ${car.oem.kWh} kWh -> OEM achieves ${(ratio * 100).toFixed(0)}% of ideal`);
  // The unconstrained ideal must bound the OEM from above (they carry module
  // walls, crash structure, manifolds we don't model) but stay within ~2x —
  // wildly above means our geometry is wrong, below means it's optimistic
  // in the wrong direction.
  ok(r.energyWh / 1000 >= car.oem.kWh * 0.95, `${car.name}: ideal fill must not be below OEM reality`);
  // Flat rectangular bays: the OEM should land in the 45-90% integration
  // band. Stepped bays measured against their bounding box legitimately
  // score much lower — that is a bay-shape modeling artifact, not an
  // algorithm error, and it is why non-rectangular bays are supported.
  ok(ratio >= (car.stepped ? 0.15 : 0.45),
    `${car.name}: OEM at ${(ratio * 100).toFixed(0)}% of ideal — our ideal is implausibly high`);
}

console.log('\n=== B. Battery swaps at 35% integration allowance: what if the car used a different cell? ===');
for (const car of CARS) {
  const req = { vRange: car.vRange, weights: { energy: 5, cost: 3, mass: 2 } };
  const results = maxFill(CELLS, car.bay, req, { ...base, integrationPct: 35 }, 4);
  console.log(`\n${car.name} (bay ${car.bay.x}x${car.bay.y}x${car.bay.z}, ${car.vRange[0]}-${car.vRange[1]} V) — OEM ${car.oem.kWh} kWh:`);
  for (const r of results) {
    console.log(`  ${r.pareto ? '*' : ' '} ${r.cell.name.padEnd(40)} ${String(r.s).padStart(3)}S${String(r.p).padEnd(4)}P ` +
      `${String(r.n).padStart(4)} cells ${kwh(r.energyWh).padStart(6)} kWh ${r.massKg.toFixed(0).padStart(4)} kg` +
      (r.costUSD != null ? ` ~$${Math.round(r.costUSD)}`.padStart(9) : '         ') +
      ` score ${r.score}`);
  }
  ok(results.length >= 2, `${car.name}: swap candidates found`);
}

console.log('\n=== C. Calibration: OEM integration efficiency vs our ideal ===');
const avg = ratios.reduce((a, b) => a + b.ratio, 0) / ratios.length;
for (const r of ratios) console.log(`  ${r.car}: ${(r.ratio * 100).toFixed(0)}%`);
console.log(`  mean OEM/ideal = ${(avg * 100).toFixed(0)}% -> suggested integration allowance ~${((1 - avg) * 100).toFixed(0)}% of envelope volume`);

console.log(fails === 0 ? '\nMARKET VALIDATION PASSED' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
