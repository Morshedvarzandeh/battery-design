// scene3d.js — the design as a scene, in millimetres.
//
// The 3D garage runs in Godot. This module is the reason that is safe: it
// turns a finished design into a plain-data description of what to draw, and
// nothing downstream of it is allowed to compute anything.
//
//   designFromSpec(spec) -> buildScene({ design, layout }) -> { cells, parts, ... }
//
// The face may be decorative. The data is not. Every coordinate here comes
// from layoutPack — the same geometry the 2D view, the packing efficiency and
// the enclosure mass are derived from — so the pack you walk around is the
// pack the audit is about, down to the millimetre. If the renderer wants a
// number this file does not give it, the answer is to add it here from the
// engine, never to work it out in GDScript. The moment the engine calculates,
// the tool has two opinions and they drift.
//
// Plain data, no DOM, no engine, no imports beyond the component database.
// It runs in Node, which is how it is tested without a GPU anywhere near it.

import { COMPONENT_CATEGORIES, componentById } from './components.js';
import { CHEMISTRIES } from './cells.js';
import { hostFor, packSeat, fitInHost } from './hosts.js';

export const SCENE_VERSION = 1;

// How each fitted part shows up in the scene. Parts that are real hardware
// with a place get a shape; parts whose presence is a property rather than a
// volume (a vent membrane, a data quality) get a label and no geometry.
//
// The shapes are deliberately crude — a cold plate is a slab, not a stamped
// channel network. Detail we do not have would be an invention, and an
// invented channel layout in a photorealistic render is a lie a drawing
// would not tell.
const PART_SHAPE = {
  cooling: (part, L) => {
    const s = part.spaceMm || { bottom: 0, side: 0, rowGap: 0 };
    if (part.viz === 'bottom' || s.bottom > 0) {
      return [{
        kind: 'slab', role: 'cooling',
        size: { x: L.inner.x, y: L.inner.y, z: Math.max(s.bottom, 4) },
        at: { x: 0, y: 0, z: -(L.inner.z / 2) - Math.max(s.bottom, 4) / 2 },
      }];
    }
    if (part.viz === 'side') {
      const t = Math.max(s.side, 4);
      return [-1, 1].map((sign) => ({
        kind: 'slab', role: 'cooling',
        size: { x: t, y: L.inner.y, z: L.inner.z },
        at: { x: sign * (L.inner.x / 2 + t / 2), y: 0, z: 0 },
      }));
    }
    if (part.viz === 'between' && s.rowGap > 0) {
      // One ribbon per row of cells, in the gap the layout actually reserved.
      const rows = [...new Set(L.positions.map((q) => Math.round(q.y * 100) / 100))].sort((a, b) => a - b);
      return rows.slice(0, -1).map((y, i) => ({
        kind: 'slab', role: 'cooling',
        size: { x: L.inner.x, y: s.rowGap, z: L.cellFootprint.fz * 0.8 },
        at: { x: 0, y: (y + rows[i + 1]) / 2, z: 0 },
      }));
    }
    return [];
  },
  housing: (part, L) => [{
    kind: 'shell', role: 'housing',
    size: { x: L.outer.x, y: L.outer.y, z: L.outer.z },
    at: { x: 0, y: 0, z: (L.headroomMm - (L.underMm || 0)) / 2 },
    wallMm: L.wallMm,
  }],
  vent: (part, L) => (part.level !== 'pack' ? [] : [{
    kind: 'nub', role: 'vent',
    size: { x: L.outer.x * 0.05, y: L.outer.x * 0.05, z: L.outer.x * 0.03 },
    at: { x: L.outer.x * 0.3, y: L.outer.y * 0.3, z: L.outer.z / 2 + (L.headroomMm - (L.underMm || 0)) / 2 },
  }]),
};

/**
 * The scene for one design.
 *
 * `layout` is passed in rather than recomputed: the caller already has it, and
 * building a second one risks it being a different one.
 *
 * Cell positions are emitted as a flat Float64Array-shaped array of triples
 * rather than objects. A 250 kWh bus is 15,000 cells; as objects that is
 * megabytes of JSON crossing a postMessage boundary on every swap.
 */
export function buildScene({ design, layout, highlight = null, showHost = false } = {}) {
  if (!design || !layout) return null;
  const L = layout;
  const cell = L.cell;
  const fp = L.cellFootprint;

  const xyz = new Array(L.positions.length * 3);
  const group = new Array(L.positions.length);
  for (let i = 0; i < L.positions.length; i++) {
    const q = L.positions[i];
    xyz[i * 3] = round2(q.x);
    xyz[i * 3 + 1] = round2(q.y);
    xyz[i * 3 + 2] = round2(q.z);
    group[i] = q.sIndex;                       // which series group — the colour bands
  }

  // The parts that were actually fitted, with the shapes they occupy. Read
  // from the design's own resolved selection, so what is drawn and what the
  // mass was computed from cannot disagree.
  const fitted = design.spec?.resolved?.components || {};
  const parts = [];
  for (const { key, name: catName } of COMPONENT_CATEGORIES) {
    const id = fitted[key];
    if (!id) {
      // Nothing fitted is a fact worth showing, not an empty slot to hide.
      parts.push({ category: key, categoryName: catName, id: null, name: 'none fitted', shapes: [] });
      continue;
    }
    const part = componentById(key, id);
    parts.push({
      category: key, categoryName: catName, id,
      name: part?.name || id,
      kind: part?.kind || null,
      dataQuality: part?.dataQuality || null,
      massKg: design.analysis?.totals?.componentMassKg?.[key] ?? null,
      shapes: part && PART_SHAPE[key] ? PART_SHAPE[key](part, L) : [],
    });
  }

  return {
    v: SCENE_VERSION,
    units: 'mm',
    // Enough to caption the scene without a second call back to the engine.
    title: `${design.pack.s}S${design.pack.p}P ${cell.name}`,
    subtitle: [
      design.application?.name,
      fmtWh(design.pack.energyWh),
      `${design.pack.nominalV.toFixed(0)} V`,
      fmtKg(design.pack.massKg),
    ].filter(Boolean).join(' · '),
    pack: {
      inner: { ...L.inner }, outer: { ...L.outer },
      wallMm: L.wallMm, headroomMm: L.headroomMm, underMm: L.underMm || 0,
      cellCount: L.N, s: L.s, p: L.p, nx: L.nx, ny: L.ny, nz: L.nz,
      packingEfficiency: L.packingEfficiency,
    },
    cell: {
      id: cell.id, name: cell.name, form: cell.form, chemistry: cell.chemistry,
      round: !!fp.round, axis: fp.axis,
      // The drawn size, which is the cell body inside its footprint — the
      // footprint includes the gap and drawing that would fuse the pack into
      // one solid block.
      size: { x: round2(fp.fx), y: round2(fp.fy), z: round2(fp.fz) },
      diameterMm: cell.dims?.d ?? null, heightMm: cell.dims?.h ?? null,
      // The same palette the 2D and Three.js views read, not a copy of it.
      // A copy was already wrong here: it was keyed in lower case against
      // chemistries the database spells NCA, NMC, LFP, so every cell fell
      // through to the grey default and the 3D pack was the one view where
      // chemistry did not show.
      color: CHEMISTRIES[cell.chemistry]?.color || '#6f7b78',
    },
    cells: { count: L.positions.length, xyz, group, groups: L.s },
    parts,
    // The machine the pack goes into, when asked for. Off by default: it is a
    // desktop feature, and more importantly a silhouette is an INDICATIVE
    // shape that should never turn up unrequested next to numbers that are not.
    host: showHost ? hostBlock(design, L) : null,
    // What the audit says, so the scene can mark the pack rather than making
    // the customer switch tabs to find out it is failing.
    audit: {
      fail: (design.findings || []).filter((f) => f.severity === 'fail').length,
      warn: (design.findings || []).filter((f) => f.severity === 'warn').length,
      worst: (design.findings || []).find((f) => f.severity === 'fail')?.title || null,
    },
    highlight,
  };
}

// The machine, its mounting, and whether the pack fits in it. Metres here
// rather than millimetres: a bus is 12 m and a wearable pack is 40 mm, and
// mixing the two scales in one unit is how a decimal point goes missing.
function hostBlock(design, L) {
  const host = hostFor(design.spec?.resolved?.application);
  if (!host) return null;
  const packM = { x: L.outer.x / 1000, y: L.outer.y / 1000, z: L.outer.z / 1000 };
  const seat = packSeat(host, packM);
  const fit = fitInHost(host, packM);
  return {
    kind: host.kind, name: host.name,
    sizeM: host.sizeM, dimsFrom: host.dimsFrom, note: host.note,
    mount: { id: host.mount.id, name: host.mount.name, what: host.mount.what },
    seatM: seat,
    fits: fit?.fits ?? null, over: fit?.over ?? [], fitNote: fit?.note ?? null,
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
const fmtWh = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kWh` : `${v.toFixed(0)} Wh`);
const fmtKg = (v) => (v < 0.0995 ? `${(v * 1000).toFixed(0)} g` : `${v.toFixed(1)} kg`);

/**
 * The message protocol, in one place.
 *
 * Both sides of an iframe boundary have to agree on this, and one of them is
 * written in another language. Naming the messages here — rather than typing
 * the strings twice — is what keeps a rename from silently ending the
 * conversation, with the 3D view left showing a pack from two swaps ago.
 */
export const MSG = {
  READY: 'bd3d:ready',        // engine -> host: the renderer is up
  SCENE: 'bd3d:scene',        // host -> engine: draw this
  PICK: 'bd3d:pick',          // engine -> host: the customer clicked something
  VIEW: 'bd3d:view',          // host -> engine: camera preset
  ERROR: 'bd3d:error',        // engine -> host: it could not
};

/** True when `m` is a message this protocol recognises, at a version we speak. */
export function isSceneMessage(m) {
  return !!m && typeof m === 'object' && typeof m.type === 'string'
    && m.type.startsWith('bd3d:') && (m.v == null || m.v === SCENE_VERSION);
}
