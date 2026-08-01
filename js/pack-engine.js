// pack-engine.js — electrical and geometric core of the pack designer.
//
// Everything here is a pure function of (cell, s, p, options). No DOM, no state.
//
// Geometry convention (shared with cells.js and viewer3d.js):
//   X = pack width, Y = pack depth, Z = pack height (up).
//   Cylindrical cells stand upright: axis along Z, dims {d, h}.
//   Prismatic/pouch cells: dims {w, t, h}; w along X, t (thickness, the stack
//   direction) along Y, h along Z with terminals up.
//   All lengths in mm, masses in g/kg as named, energies in Wh.

// ---------------------------------------------------------------------------
// Electrical
// ---------------------------------------------------------------------------

export function electrical(cell, s, p) {
  const cellCount = s * p;
  const nominalV = s * cell.nominalV;
  const maxContCurrentA = p * cell.maxContDischargeA;
  const dcirMOhm = cell.dcirMOhm != null ? (cell.dcirMOhm * s) / p : null;
  return {
    s, p, cellCount,
    nominalV,
    vMax: s * cell.vMax,
    vMin: s * cell.vMin,
    capacityAh: p * cell.capacityAh,
    energyWh: cellCount * cell.nominalV * cell.capacityAh,
    massCellsKg: (cellCount * cell.massG) / 1000,
    maxContCurrentA,
    maxPulseCurrentA: cell.maxPulseDischargeA != null ? p * cell.maxPulseDischargeA : null,
    maxContPowerW: nominalV * maxContCurrentA,
    // ...and the same at the bottom of the window, which is the figure a
    // design has to survive: a constant-power load draws its highest current
    // when the pack is nearly empty, and the load does not care that the
    // nameplate was quoted at nominal.
    maxContPowerAtVMinW: s * cell.vMin * maxContCurrentA,
    maxChargeCurrentA: p * cell.maxContChargeA,
    // Cells-only DCIR (series adds, parallel divides). Interconnects add more
    // in reality; the UI labels this as a cells-only lower bound.
    dcirMOhm,
    // Voltage sag at maximum continuous current, from cells-only DCIR.
    sagVAtMaxCont: dcirMOhm != null ? (maxContCurrentA * dcirMOhm) / 1000 : null,
  };
}

// ---------------------------------------------------------------------------
// Geometry — cheap analytical pass (no per-cell positions)
// ---------------------------------------------------------------------------
// arrangement: 'grid' | 'hex'   (cylindrical)
//              'stack'          (prismatic / pouch: cells stacked along t)
// orientation (prismatic/pouch): 'upright' (h up), 'flat' (lying on largest
//              face, h along Y, t up)  — cylindrical: 'upright' | 'lying'
//              (axis along Y).

export const ARRANGEMENTS_BY_FORM = {
  cylindrical: ['grid', 'hex'],
  prismatic: ['stack'],
  pouch: ['stack'],
};

export function defaultArrangement(cell) {
  return cell.form === 'cylindrical' ? 'hex' : 'stack';
}

// Per-cell occupied footprint on the XY plane and height, after orientation.
// `round` marks cylindrical geometry for the renderer; `hexOk` marks that the
// circular cross-section lies in the XY plane, which is the only case where
// hex (staggered, sqrt(3)/2 row pitch) packing is geometrically valid.
function orientedDims(cell, orientation) {
  if (cell.form === 'cylindrical') {
    if (orientation === 'lying') {
      // Axis along Y: footprint d (X) x h (Y), height d. Rows of lying cells
      // cannot nest into each other, so hexOk is false.
      return { fx: cell.dims.d, fy: cell.dims.h, fz: cell.dims.d, round: true, hexOk: false, axis: 'y' };
    }
    return { fx: cell.dims.d, fy: cell.dims.d, fz: cell.dims.h, round: true, hexOk: true, axis: 'z' };
  }
  const { w, t, h } = cell.dims;
  if (orientation === 'flat') {
    // Lying on the w x h face: h along Y, t up.
    return { fx: w, fy: h, fz: t, round: false, hexOk: false, axis: 'z' };
  }
  return { fx: w, fy: t, fz: h, round: false, hexOk: false, axis: 'z' };
}

// Analytical dimensions of an nx * ny * nz arrangement. ny is derived from N.
// rowExtraMm is additional space reserved between rows (e.g. a between-cell
// cooling ribbon or fin plate). Returns null for impossible combinations.
export function gridDims(cell, N, nx, nz, arrangement, spacingMm, layerGapMm, orientation, rowExtraMm = 0) {
  if (nx < 1 || nz < 1) return null;
  const perLayer = Math.ceil(N / nz);
  if (perLayer < 1) return null;
  if (nz > 1 && (nz - 1) * perLayer >= N) return null; // last layer would be empty
  const ny = Math.ceil(perLayer / nx);
  if ((ny - 1) * nx >= perLayer) return null; // last row would be empty
  const od = orientedDims(cell, orientation);
  const gap = spacingMm;
  let innerX, innerY;
  if (arrangement === 'hex' && od.hexOk) {
    const pitch = od.fx + gap;
    const rowPitch = pitch * (Math.sqrt(3) / 2) + rowExtraMm;
    innerX = (nx - 1) * pitch + od.fx + (ny > 1 ? pitch / 2 : 0);
    innerY = (ny - 1) * rowPitch + od.fy;
  } else {
    innerX = nx * od.fx + (nx - 1) * gap;
    innerY = ny * od.fy + (ny - 1) * (gap + rowExtraMm);
  }
  const innerZ = nz * od.fz + (nz - 1) * layerGapMm;
  return { nx, ny, nz, innerX, innerY, innerZ, perLayer, od };
}

// Pick nx so a single layer's footprint is close to square (used as the
// automatic default; the optimizer explores the full range instead).
export function autoNx(cell, N, nz, arrangement, spacingMm, orientation) {
  const od = orientedDims(cell, orientation);
  const perLayer = Math.ceil(N / nz);
  const gap = spacingMm;
  const px = od.fx + gap;
  const py = (arrangement === 'hex' && od.hexOk) ? px * (Math.sqrt(3) / 2) : od.fy + gap;
  let nx = Math.round(Math.sqrt((perLayer * py) / px));
  nx = Math.max(1, Math.min(perLayer, nx));
  return nx;
}

// ---------------------------------------------------------------------------
// Full layout with per-cell positions and series-group assignment
// ---------------------------------------------------------------------------
// opts: {
//   arrangement, orientation,
//   spacingMm    cell-to-cell air gap / spacer thickness
//   layerGapMm   gap between stacked layers (holder plates)
//   wallMm       enclosure wall thickness (all sides)
//   headroomMm   extra height above cells for busbars/BMS
//   underMm      space reserved under the cells (e.g. bottom cold plate)
//   rowExtraMm   extra space between rows (between-cell cooling)
//   nx           cells per row; 0 = auto
//   nz           layers
// }
export function layoutPack(cell, s, p, opts = {}) {
  const N = s * p;
  const arrangement = opts.arrangement || defaultArrangement(cell);
  const orientation = opts.orientation || 'upright';
  const spacingMm = opts.spacingMm ?? 1;
  const layerGapMm = opts.layerGapMm ?? 2;
  const wallMm = opts.wallMm ?? 2;
  const headroomMm = opts.headroomMm ?? (cell.form === 'cylindrical' ? 8 : 15);
  const underMm = opts.underMm ?? 0;
  const rowExtraMm = opts.rowExtraMm ?? 0;
  let nz = Math.max(1, Math.min(opts.nz || 1, N));
  while (nz > 1 && (nz - 1) * Math.ceil(N / nz) >= N) nz--; // drop empty top layers
  const nx = (opts.nx && opts.nx > 0)
    ? Math.min(opts.nx, Math.ceil(N / nz))
    : autoNx(cell, N, nz, arrangement, spacingMm, orientation);

  const g = gridDims(cell, N, nx, nz, arrangement, spacingMm, layerGapMm, orientation, rowExtraMm);
  if (!g) return null;
  const { od } = g;
  const gap = spacingMm;
  const hexActive = arrangement === 'hex' && od.hexOk;
  const pitchX = od.fx + gap;
  const pitchY = (hexActive ? pitchX * (Math.sqrt(3) / 2) : od.fy + gap) + rowExtraMm;
  const pitchZ = od.fz + layerGapMm;

  // Serpentine placement: layer by layer, row by row, alternating row
  // direction, so consecutive cells (and therefore each parallel group of p
  // consecutive cells) sit next to each other — matching how packs are
  // actually welded and making the series coloring legible.
  const positions = [];
  let placed = 0;
  for (let iz = 0; iz < g.nz && placed < N; iz++) {
    for (let iy = 0; iy < g.ny && placed < N; iy++) {
      const rowLen = Math.min(nx, Math.ceil(N / g.nz) - iy * nx, N - placed);
      for (let k = 0; k < rowLen && placed < N; k++) {
        const ix = (iy % 2 === 0) ? k : rowLen - 1 - k;
        let x = ix * pitchX + od.fx / 2;
        if (hexActive && iy % 2 === 1) x += pitchX / 2;
        const y = iy * pitchY + od.fy / 2;
        const z = iz * pitchZ + od.fz / 2;
        positions.push({
          x, y, z,
          sIndex: Math.floor(placed / p),
          pIndex: placed % p,
          layer: iz,
        });
        placed++;
      }
    }
  }

  // Center at origin.
  const cx = g.innerX / 2, cy = g.innerY / 2, cz = g.innerZ / 2;
  for (const q of positions) { q.x -= cx; q.y -= cy; q.z -= cz; }

  const outer = {
    x: g.innerX + 2 * wallMm,
    y: g.innerY + 2 * wallMm,
    z: g.innerZ + 2 * wallMm + headroomMm + underMm,
  };
  const innerVolL = (g.innerX * g.innerY * g.innerZ) / 1e6;
  const cellVolL = N * singleCellVolumeL(cell);

  return {
    cell, s, p, N,
    arrangement, orientation,
    spacingMm, layerGapMm, wallMm, headroomMm, underMm, rowExtraMm,
    nx: g.nx, ny: g.ny, nz: g.nz,
    positions,
    cellFootprint: { fx: od.fx, fy: od.fy, fz: od.fz, round: od.round, axis: od.axis },
    inner: { x: g.innerX, y: g.innerY, z: g.innerZ },
    outer,
    volumeL: (outer.x * outer.y * outer.z) / 1e6,
    packingEfficiency: cellVolL / innerVolL,
  };
}

function singleCellVolumeL(cell) {
  if (cell.form === 'cylindrical') {
    const r = cell.dims.d / 2;
    return (Math.PI * r * r * cell.dims.h) / 1e6;
  }
  return (cell.dims.w * cell.dims.t * cell.dims.h) / 1e6;
}

// ---------------------------------------------------------------------------
// Summary — everything the stats panel and the standards checker need
// ---------------------------------------------------------------------------

export function summarize(cell, s, p, layout) {
  const e = electrical(cell, s, p);
  // Enclosure mass estimate: aluminium walls (2.7 g/cm3) at the given wall
  // thickness over the outer surface area — a rough but honest placeholder.
  let enclosureKg = null;
  if (layout) {
    const { x, y, z } = layout.outer;
    const areaMm2 = 2 * (x * y + y * z + x * z);
    enclosureKg = (areaMm2 * layout.wallMm * 2.7e-6);
  }
  const massKg = layout ? e.massCellsKg * 1.08 + (enclosureKg || 0) : e.massCellsKg;
  // 8% on cells for busbars/holders/wiring; labeled as an estimate in the UI.
  return {
    ...e,
    massKg,
    enclosureKg,
    dims: layout ? layout.outer : null,
    volumeL: layout ? layout.volumeL : null,
    whPerKg: massKg > 0 ? e.energyWh / massKg : null,
    whPerL: layout && layout.volumeL > 0 ? e.energyWh / layout.volumeL : null,
    packingEfficiency: layout ? layout.packingEfficiency : null,
  };
}
