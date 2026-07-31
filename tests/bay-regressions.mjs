// Regressions for non-rectangular bays: templates, polygon packing, shaped
// layouts, and their consistency with the rectangular engine.
import { cellById } from '../js/cells.js';
import { layoutPack } from '../js/pack-engine.js';
import { maxFill } from '../js/optimizer.js';
import {
  bayZones, bayCapacity, layoutPackBay, packZone, pointInPolygon, polygonArea,
} from '../js/bay.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } };
const cell = cellById('samsung-inr21700-50e');
const o = { spacingMm: 1, layerGapMm: 2, wallMm: 2, headroomMm: 8, underMm: 0, rowExtraMm: 0 };

// Box bay ≈ rectangular engine: the polygon scanner and the closed-form
// grid math must agree closely on the same box (the scanner may find a few
// extra cells in staggered rows — never dramatically fewer).
{
  const bay = { kind: 'box', x: 300, y: 200, z: 90 };
  const cap = bayCapacity(cell, bay, o);
  ok(cap && cap.count > 50, `box bay capacity plausible (${cap?.count})`);
  const rect = maxFill([cell], { x: bay.x, y: bay.y, z: bay.z },
    { vRange: [3, 60], weights: { energy: 1, cost: 0, mass: 0 } },
    { ...o, coolingSpace: { bottom: 0, side: 0, rowGap: 0 } }, 1)[0];
  ok(rect, 'rectangular path returns a fill');
  const rel = Math.abs(cap.count - rect.nMax) / rect.nMax;
  ok(rel <= 0.1, `scanner ${cap.count} vs closed-form ${rect.nMax} within 10% (${(rel * 100).toFixed(1)}%)`);
}

// Round bay: fewer cells than its bounding box, and every cell fully inside.
{
  const round = { kind: 'round', d: 200, z: 90 };
  const box = { kind: 'box', x: 200, y: 200, z: 90 };
  const capR = bayCapacity(cell, round, o);
  const capB = bayCapacity(cell, box, o);
  ok(capR && capR.count > 0, 'round bay packs cells');
  ok(capR.count < capB.count, `round (${capR.count}) < bounding box (${capB.count})`);
  const zone = bayZones(round)[0];
  const res = packZone(cell, zone, { ...o, arrangement: 'hex', orientation: 'upright' });
  const r = cell.dims.d / 2, c0 = 100;
  for (const q of res.positions) {
    ok(Math.hypot(q.x - c0, q.y - c0) <= 100 - r - o.wallMm + 1e-6, 'cell inside circle with wall margin');
  }
}

// L-shape: less than the full rectangle; nothing in the cut corner.
{
  const l = { kind: 'lshape', x: 300, y: 200, cutX: 120, cutY: 100, z: 90 };
  const full = { kind: 'box', x: 300, y: 200, z: 90 };
  const capL = bayCapacity(cell, l, o);
  const capF = bayCapacity(cell, full, o);
  ok(capL.count < capF.count, `L-shape (${capL.count}) < full rect (${capF.count})`);
  const zone = bayZones(l)[0];
  const res = packZone(cell, zone, { ...o, arrangement: 'grid', orientation: 'upright' });
  for (const q of res.positions) {
    ok(!(q.x > 300 - 120 && q.y > 200 - 100), `no cell center in the cut corner (${q.x},${q.y})`);
  }
}

// Stepped: the shallow zone holds fewer layers than the tall one.
{
  const st = { kind: 'stepped', xA: 200, zA: 90, xB: 150, zB: 170, y: 200 };
  const zones = bayZones(st);
  const rA = packZone(cell, zones[0], { ...o, arrangement: 'hex', orientation: 'upright' });
  const rB = packZone(cell, zones[1], { ...o, arrangement: 'hex', orientation: 'upright' });
  ok(rA.nz === 1 && rB.nz === 2, `layer counts per zone height (A:${rA.nz} B:${rB.nz})`);
  ok(bayCapacity(cell, st, o).count === rA.count + rB.count, 'stepped capacity = sum of zones');
}

// Drawn polygon (triangle): packs, everything inside.
{
  const tri = { kind: 'poly', points: [[0, 0], [300, 0], [0, 300]], z: 90 };
  const cap = bayCapacity(cell, tri, o);
  ok(cap && cap.count > 10, `triangle packs (${cap?.count})`);
  const res = packZone(cell, bayZones(tri)[0], { ...o, arrangement: cap.arrangement, orientation: cap.orientation });
  for (const q of res.positions) ok(pointInPolygon(q.x, q.y, tri.points), 'cell center inside triangle');
  ok(Math.abs(polygonArea(tri.points) - 45000) < 1, 'polygon area math');
}

// Shaped layout: builds for N <= capacity, refuses N > capacity, cells carry
// series groups, and the layout advertises the bay outline.
{
  const round = { kind: 'round', d: 300, z: 90 };
  const cap = bayCapacity(cell, round, o).count;
  const s = 7, p = Math.floor(cap / 7);
  const L = layoutPackBay(cell, s, p, round, o);
  ok(L && L.positions.length === s * p, 'shaped layout places s*p cells');
  ok(L.bayZonesOut?.length === 1, 'layout carries bay outline');
  ok(new Set(L.positions.map((q) => q.sIndex)).size === s, 'series groups assigned');
  ok(layoutPackBay(cell, cap + 1, 1, round, o) === null, 'over-capacity refused');
}

// maxFill in shaped mode: candidates respect capacity and voltage window.
{
  const round = { kind: 'round', d: 400, z: 90 };
  const res = maxFill([cell, cellById('eve-lf280k'), cellById('generic-nmc-pouch-10ah-hp')],
    null, { vRange: [24, 52], weights: { energy: 1, cost: 0, mass: 0 } },
    { ...o, coolingSpace: { bottom: 0, side: 0, rowGap: 0 }, bay: round }, 5);
  ok(res.length > 0, 'shaped maxFill returns candidates');
  for (const r of res) {
    ok(r.shaped === true && r.bay?.kind === 'round', 'candidate flagged shaped');
    ok(r.n <= r.nMax, 'n <= capacity');
    const L = layoutPackBay(r.cell, r.s, r.p, r.bay, { ...o, ...r.opts });
    ok(L, `shaped candidate ${r.cell.id} applies`);
  }
}

console.log(fails === 0 ? 'BAY REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
