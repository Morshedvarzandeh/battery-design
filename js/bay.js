// bay.js — the customer's available space, which is often NOT a rectangle.
//
// Calculator-simple shape templates (type a few sizes) plus a free polygon
// (drawn in the panel sketcher). Every bay resolves to one or more ZONES:
//   { poly: [[x,y], ...] (mm, plan view, counter-clockwise), z: heightMm }
// and the packer fills each zone with real cell footprints, testing every
// candidate against the polygon with wall clearance. Pure functions, no DOM.

// ---------------------------------------------------------------------------
// Templates → zones
// ---------------------------------------------------------------------------
// bay = { kind:'box',     x, y, z }
//     | { kind:'round',   d, z }
//     | { kind:'lshape',  x, y, cutX, cutY, z }        cut removed at +X/+Y corner
//     | { kind:'stepped', xA, zA, xB, zB, y }          two heights side by side
//     | { kind:'poly',    points:[[x,y],...], z }      free drawn shape

export function bayZones(bay) {
  switch (bay.kind) {
    case 'round': {
      const r = bay.d / 2;
      const pts = [];
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * 2 * Math.PI;
        pts.push([r + r * Math.cos(a), r + r * Math.sin(a)]);
      }
      return [{ poly: pts, z: bay.z }];
    }
    case 'lshape': {
      const { x, y, cutX, cutY } = bay;
      const cx = Math.min(cutX, x - 1), cy = Math.min(cutY, y - 1);
      return [{
        poly: [[0, 0], [x, 0], [x, y - cy], [x - cx, y - cy], [x - cx, y], [0, y]],
        z: bay.z,
      }];
    }
    case 'stepped':
      return [
        { poly: rect(0, 0, bay.xA, bay.y), z: bay.zA },
        { poly: rect(bay.xA, 0, bay.xB, bay.y), z: bay.zB },
      ];
    case 'poly':
      return (bay.points?.length >= 3) ? [{ poly: bay.points, z: bay.z }] : [];
    case 'box':
    default:
      return [{ poly: rect(0, 0, bay.x, bay.y), z: bay.z }];
  }
}

const rect = (x0, y0, w, h) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function polygonBounds(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToEdges(px, py, poly) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)));
  }
  return d;
}

// A round cell of radius r fits at (x,y) with `margin` wall clearance.
function circleFits(x, y, r, poly, margin) {
  return pointInPolygon(x, y, poly) && distToEdges(x, y, poly) >= r + margin;
}

// Do segments p1p2 and p3p4 properly cross? Used to catch a wall that passes
// through a footprint without any sampled point landing outside it.
function segmentsCross(p1, p2, p3, p4) {
  const side = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = side(p3, p4, p1), d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3), d4 = side(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// A rectangular footprint fits at (x, y) with `margin` wall clearance.
//
// This used to sample the four corners and four edge midpoints. Sampling is
// not enough, and the failure is not exotic: a slot narrower than the gap
// between sample columns passes straight through the cell while every probe
// still lands inside the bay. With a 40 mm cell the probes sit at x = -20, 0,
// +20, so a 10 mm slot at x = 5..15 is invisible to all eight of them, and the
// packer confidently places a cell the wall bisects.
//
// The exact test is containment of the corners PLUS no crossing between the
// footprint's edges and the bay's. Clearance is then checked at the sample
// points as before, which is sound because the margin is small relative to a
// cell and the crossing test has already excluded the geometry that fooled it.
function rectFits(x, y, fx, fy, poly, margin) {
  const hx = fx / 2 + margin, hy = fy / 2 + margin;
  const corners = [
    [x - hx, y - hy], [x + hx, y - hy], [x + hx, y + hy], [x - hx, y + hy],
  ];
  for (const [qx, qy] of corners) if (!pointInPolygon(qx, qy, poly)) return false;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    for (let j = 0; j < poly.length; j++) {
      if (segmentsCross(a, b, poly[j], poly[(j + 1) % poly.length])) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Packing one zone with a cell footprint
// ---------------------------------------------------------------------------
// Returns { positions:[{x,y}], perLayer, nz, count } — positions are plan
// centers in zone coordinates, row-major (serpentine ordering is applied by
// the layout builder). Scans rows across the zone's bounding box.

export function packZone(cell, zone, o) {
  const od = orientedFootprint(cell, o.orientation);
  const hex = o.arrangement === 'hex' && od.hexOk;
  const pitchX = od.fx + o.spacingMm;
  const rowPitch = (hex ? pitchX * (Math.sqrt(3) / 2) : od.fy + o.spacingMm) + (o.rowExtraMm || 0);
  const usableZ = zone.z - 2 * o.wallMm - o.headroomMm - (o.underMm || 0);
  if (usableZ < od.fz) return { positions: [], perLayer: 0, nz: 0, count: 0, od };
  const nz = 1 + Math.floor((usableZ - od.fz) / (od.fz + o.layerGapMm));

  const b = polygonBounds(zone.poly);
  const positions = [];
  let row = 0;
  for (let y = b.minY + o.wallMm + od.fy / 2; y <= b.maxY - od.fy / 2 - o.wallMm + 1e-9; y += rowPitch, row++) {
    const xOff = hex && row % 2 === 1 ? pitchX / 2 : 0;
    for (let x = b.minX + o.wallMm + od.fx / 2 + xOff; x <= b.maxX - od.fx / 2 - o.wallMm + 1e-9; x += pitchX) {
      const fits = od.round
        ? circleFits(x, y, od.fx / 2, zone.poly, o.wallMm)
        : rectFits(x, y, od.fx, od.fy, zone.poly, o.wallMm);
      if (fits) positions.push({ x, y, row });
    }
  }
  return { positions, perLayer: positions.length, nz, count: positions.length * nz, od };
}

function orientedFootprint(cell, orientation) {
  if (cell.form === 'cylindrical') {
    return orientation === 'lying'
      ? { fx: cell.dims.d, fy: cell.dims.h, fz: cell.dims.d, round: true, hexOk: false, axis: 'y' }
      : { fx: cell.dims.d, fy: cell.dims.d, fz: cell.dims.h, round: true, hexOk: true, axis: 'z' };
  }
  const { w, t, h } = cell.dims;
  return orientation === 'flat'
    ? { fx: w, fy: h, fz: t, round: false, hexOk: false, axis: 'z' }
    : { fx: w, fy: t, fz: h, round: false, hexOk: false, axis: 'z' };
}

// ---------------------------------------------------------------------------
// Full shaped layout — engine-compatible object for the viewers/summary
// ---------------------------------------------------------------------------
// Places N = s*p cells across the zones (zone by zone, serpentine within
// each zone's rows) and returns the same shape layoutPack() produces, plus
// `bayZonesOut` so the viewers can draw the real outline. Returns null when
// the zones cannot hold N cells.

export function layoutPackBay(cell, s, p, bay, opts = {}) {
  const o = {
    arrangement: opts.arrangement || (cell.form === 'cylindrical' ? 'hex' : 'stack'),
    orientation: opts.orientation || 'upright',
    spacingMm: opts.spacingMm ?? 1,
    layerGapMm: opts.layerGapMm ?? 2,
    wallMm: opts.wallMm ?? 2,
    headroomMm: opts.headroomMm ?? (cell.form === 'cylindrical' ? 8 : 15),
    underMm: opts.underMm ?? 0,
    rowExtraMm: opts.rowExtraMm ?? 0,
  };
  if (o.arrangement === 'hex' && o.orientation === 'lying') o.arrangement = 'grid';
  const zones = bayZones(bay);
  if (!zones.length) return null;
  const packs = zones.map((z) => ({ zone: z, res: packZone(cell, z, o) }));
  const capacity = packs.reduce((a, b) => a + b.res.count, 0);
  const N = s * p;
  if (capacity < N) return null;

  const od = packs[0].res.od;
  const positions = [];
  let placed = 0;
  for (const { res } of packs) {
    if (placed >= N) break;
    // All zones share the floor: layers stack up from z=0 in each zone, so a
    // shallow step simply holds fewer layers.
    for (let iz = 0; iz < res.nz && placed < N; iz++) {
      // Serpentine within the zone: alternate row direction.
      const rows = new Map();
      for (const q of res.positions) {
        if (!rows.has(q.row)) rows.set(q.row, []);
        rows.get(q.row).push(q);
      }
      let ri = 0;
      for (const [, cellsInRow] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
        const ordered = ri % 2 === 0 ? cellsInRow : [...cellsInRow].reverse();
        for (const q of ordered) {
          if (placed >= N) break;
          positions.push({
            x: q.x, y: q.y,
            z: iz * (od.fz + o.layerGapMm) + od.fz / 2,
            sIndex: Math.floor(placed / p), pIndex: placed % p, layer: iz,
          });
          placed++;
        }
        ri++;
      }
    }
  }

  // Bounding box over all zones for stats; center everything at the origin.
  const allPolys = zones.flatMap((z) => z.poly);
  const bx = polygonBounds(allPolys);
  const zMax = Math.max(...zones.map((z) => z.z));
  const innerX = bx.maxX - bx.minX - 2 * o.wallMm;
  const innerY = bx.maxY - bx.minY - 2 * o.wallMm;
  const innerZ = zMax - 2 * o.wallMm - o.headroomMm - (o.underMm || 0);
  const cx = (bx.minX + bx.maxX) / 2, cy = (bx.minY + bx.maxY) / 2;
  for (const q of positions) { q.x -= cx; q.y -= cy; q.z -= innerZ / 2; }
  const bayZonesOut = zones.map((z) => ({
    poly: z.poly.map(([px, py]) => [px - cx, py - cy]), z: z.z,
  }));

  const areaMm2 = zones.reduce((a, z) => a + polygonArea(z.poly), 0);
  const cellVolL = N * (od.round
    ? (Math.PI * (cell.dims.d / 2) ** 2 * cell.dims.h) / 1e6
    : (cell.dims.w * cell.dims.t * cell.dims.h) / 1e6);
  const bayVolL = zones.reduce((a, z) => a + polygonArea(z.poly) * z.z, 0) / 1e6;

  return {
    cell, s, p, N,
    arrangement: o.arrangement, orientation: o.orientation,
    spacingMm: o.spacingMm, layerGapMm: o.layerGapMm, wallMm: o.wallMm,
    headroomMm: o.headroomMm, underMm: o.underMm, rowExtraMm: o.rowExtraMm,
    nx: null, ny: null, nz: Math.max(...packs.map((pk) => pk.res.nz)),
    positions,
    cellFootprint: { fx: od.fx, fy: od.fy, fz: od.fz, round: od.round, axis: od.axis },
    inner: { x: innerX, y: innerY, z: innerZ },
    outer: { x: innerX + 2 * o.wallMm, y: innerY + 2 * o.wallMm, z: zMax },
    volumeL: bayVolL,
    packingEfficiency: bayVolL > 0 ? cellVolL / ((areaMm2 * innerZ) / 1e6) : 0,
    bayZonesOut,
    capacity,
  };
}

// Capacity of a bay for one cell across arrangements/orientations — the
// shaped-mode equivalent of maxGridInBox.
export function bayCapacity(cell, bay, o) {
  const zones = bayZones(bay);
  if (!zones.length) return null;
  const arrangements = cell.form === 'cylindrical' ? ['hex', 'grid'] : ['stack'];
  const orientations = cell.form === 'cylindrical' ? ['upright', 'lying']
    : cell.form === 'pouch' ? ['upright', 'flat'] : ['upright'];
  let best = null;
  for (const orientation of orientations) {
    for (const arrangement of arrangements) {
      if (arrangement === 'hex' && orientation === 'lying') continue;
      const count = zones.reduce((a, z) =>
        a + packZone(cell, z, { ...o, arrangement, orientation }).count, 0);
      if (!best || count > best.count) best = { count, arrangement, orientation };
    }
  }
  return best && best.count > 0 ? best : null;
}

// Scale a bay about its centroid in plan — used by the integration allowance.
export function scaleBayPlan(bay, factor) {
  const zones = bayZones(bay);
  const all = zones.flatMap((z) => z.poly);
  const b = polygonBounds(all);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const scalePoly = (poly) => poly.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
  switch (bay.kind) {
    case 'poly': return { ...bay, points: scalePoly(bay.points) };
    case 'round': return { ...bay, d: bay.d * factor };
    case 'lshape': return { ...bay, x: bay.x * factor, y: bay.y * factor, cutX: bay.cutX * factor, cutY: bay.cutY * factor };
    case 'stepped': return { ...bay, xA: bay.xA * factor, xB: bay.xB * factor, y: bay.y * factor };
    case 'box':
    default: return { ...bay, x: bay.x * factor, y: bay.y * factor };
  }
}
