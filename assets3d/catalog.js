// assets3d/catalog.js — reusable, versioned visual assets for every 3D host.
//
// This library owns visual geometry. Engineering modules own dimensions,
// mounting, calculations and evidence. The renderer owns neither: it receives
// a complete portable model and only turns its declared primitives into GPU
// meshes. All geometry in this file is original, code-generated low-poly work.

export const ASSET_LIBRARY3D_VERSION = '2026.08.5';

export const ASSET_LIBRARY3D_LICENSE = Object.freeze({
  spdx: 'MIT',
  licenseFile: 'assets3d/LICENSE',
  copyright: '2026 Mohammad Hossein Morshed Varzandeh',
  origin: 'original-code-generated-geometry',
  thirdPartyAsset: false,
  reuse: 'May be reused under the repository MIT licence; retain asset identity and licence metadata.',
});

const MATERIALS = Object.freeze({
  hullNavy: material('hull-navy', '#12344a', 0.48, 0.12),
  hullBlue: material('hull-blue', '#17638a', 0.42, 0.10),
  antifouling: material('antifouling-red', '#8f2f35', 0.62, 0.04),
  white: material('marine-white', '#e8edf0', 0.54, 0.02),
  warmWhite: material('warm-white', '#f4f0e6', 0.58, 0.01),
  deck: material('working-deck', '#7e9298', 0.74, 0.18),
  deckDark: material('deck-dark', '#334c57', 0.72, 0.12),
  glass: material('bridge-glass', '#163746', 0.18, 0.16, 0.93),
  black: material('rubber-black', '#161d22', 0.88, 0.02),
  steel: material('marine-steel', '#93a4ab', 0.36, 0.62),
  orange: material('safety-orange', '#ee7a2c', 0.55, 0.04),
  yellow: material('equipment-yellow', '#e6b43f', 0.48, 0.18),
  red: material('safety-red', '#cf3f3f', 0.52, 0.08),
  teal: material('electric-teal', '#23b5a6', 0.38, 0.16),
  tealDark: material('electric-teal-dark', '#0b5961', 0.46, 0.12),
  solar: material('solar-panel', '#12385d', 0.24, 0.32),
  bodyBlue: material('vehicle-blue', '#2b6fa2', 0.34, 0.28),
  bodyGreen: material('machine-green', '#3f7c68', 0.48, 0.18),
  neutral: material('neutral-shell', '#62777c', 0.56, 0.16),
});

function material(id, color, roughness, metallic, opacity = 1) {
  return Object.freeze({ id, color, roughness, metallic, opacity });
}

const p3 = (x, y, z) => Object.freeze([round4(x), round4(y), round4(z)]);
const vec = (p) => ({ x: p[0], y: p[1], z: p[2] });
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const length = Math.sqrt(dot(a, a));
  return length > 1e-12 ? mul(a, 1 / length) : [0, 0, 0];
};

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function namedPrimitive(kind, role, name, materialDef, shape) {
  return Object.freeze({
    kind, role, name,
    material: materialDef,
    // Kept for compatibility with older payload consumers while material is
    // the new authoritative appearance contract.
    tint: materialDef.color,
    ...shape,
  });
}

function box(role, name, sizeM, atM, materialDef = MATERIALS.neutral) {
  return namedPrimitive('box', role, name, materialDef, {
    sizeM: Object.freeze({ ...sizeM }), atM: Object.freeze({ ...atM }),
  });
}

function cylinder(role, name, radiusM, heightM, atM, axis = 'z', materialDef = MATERIALS.steel) {
  const sizeM = axis === 'x'
    ? { x: heightM, y: radiusM * 2, z: radiusM * 2 }
    : axis === 'y'
      ? { x: radiusM * 2, y: heightM, z: radiusM * 2 }
      : { x: radiusM * 2, y: radiusM * 2, z: heightM };
  return namedPrimitive('cylinder', role, name, materialDef, {
    radiusM, heightM, axis,
    sizeM: Object.freeze(sizeM), atM: Object.freeze({ ...atM }),
  });
}

function mesh(role, name, absoluteVertices, triangles, materialDef = MATERIALS.neutral) {
  const xs = absoluteVertices.map((p) => p[0]);
  const ys = absoluteVertices.map((p) => p[1]);
  const zs = absoluteVertices.map((p) => p[2]);
  const min = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
  const max = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  const centre = mul(add(min, max), 0.5);
  const localVertices = absoluteVertices.map((point) => p3(...sub(point, centre)));
  return namedPrimitive('mesh', role, name, materialDef, {
    atM: Object.freeze(vec(p3(...centre))),
    sizeM: Object.freeze(vec(p3(...sub(max, min)))),
    vertices: Object.freeze(localVertices),
    triangles: Object.freeze(triangles.map((face) => Object.freeze([...face]))),
  });
}

// Join equally-sized cross-section rings along Y into one closed faceted mesh.
function loft(role, name, sections, materialDef) {
  const vertices = [];
  for (const section of sections) {
    for (const [x, z] of section.ring) vertices.push([x, section.y, z]);
  }
  const ringSize = sections[0].ring.length;
  const triangles = [];
  for (let sectionIndex = 0; sectionIndex < sections.length - 1; sectionIndex += 1) {
    const a = sectionIndex * ringSize;
    const b = (sectionIndex + 1) * ringSize;
    for (let pointIndex = 0; pointIndex < ringSize; pointIndex += 1) {
      const next = (pointIndex + 1) % ringSize;
      // Rings are clockwise when viewed from +Y. Reverse the strip winding so
      // side normals point outward; a normal GPU renderer may cull inward faces.
      triangles.push([a + pointIndex, b + next, b + pointIndex]);
      triangles.push([a + pointIndex, a + next, b + next]);
    }
  }
  for (let i = 1; i < ringSize - 1; i += 1) {
    triangles.push([0, i + 1, i]);
    const end = (sections.length - 1) * ringSize;
    triangles.push([end, end + i, end + i + 1]);
  }
  return mesh(role, name, vertices, triangles, materialDef);
}

function rectangleRing(halfWidth, bottomZ, topZ) {
  return [
    [-halfWidth, bottomZ], [-halfWidth, topZ],
    [halfWidth, topZ], [halfWidth, bottomZ],
  ];
}

function taperedWallRing(bottomHalfWidth, topHalfWidth, bottomZ, topZ) {
  return [
    [-bottomHalfWidth, bottomZ], [-topHalfWidth, topZ],
    [topHalfWidth, topZ], [bottomHalfWidth, bottomZ],
  ];
}

function hullRing(halfBeam, chineWidth, keelZ, chineZ, topZ) {
  return [
    [0, keelZ], [-chineWidth, chineZ], [-halfBeam, topZ],
    [halfBeam, topZ], [chineWidth, chineZ],
  ];
}

function beam(role, name, fromM, toM, thicknessM, materialDef = MATERIALS.steel) {
  const start = [fromM.x, fromM.y, fromM.z];
  const end = [toM.x, toM.y, toM.z];
  const direction = norm(sub(end, start));
  const reference = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const side = mul(norm(cross(direction, reference)), thicknessM * 0.5);
  const up = mul(norm(cross(side, direction)), thicknessM * 0.5);
  const vertices = [
    add(add(start, side), up), add(sub(start, side), up),
    sub(sub(start, side), up), add(sub(start, up), side),
    add(add(end, side), up), add(sub(end, side), up),
    sub(sub(end, side), up), add(sub(end, up), side),
  ];
  const triangles = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return mesh(role, name, vertices, triangles, materialDef);
}

function railRun(name, x, y0, y1, z, materialDef = MATERIALS.steel) {
  return [
    beam('railing', `${name} top rail`, { x, y: y0, z }, { x, y: y1, z }, 0.045, materialDef),
    ...[y0, (y0 + y1) / 2, y1].map((y, index) => beam(
      'railing', `${name} stanchion ${index + 1}`,
      { x, y, z: z - 0.55 }, { x, y, z }, 0.035, materialDef,
    )),
  ];
}

function buildElectricCatamaran() {
  const primitives = [];
  for (const [sideName, xOffset] of [['Port', -0.78], ['Starboard', 0.78]]) {
    const stations = [
      { y: -2.45, beam: 0.35, chine: 0.27, keel: -0.18, top: 0.18 },
      { y: -1.65, beam: 0.53, chine: 0.42, keel: -0.20, top: 0.25 },
      { y: 0.35, beam: 0.58, chine: 0.46, keel: -0.20, top: 0.28 },
      { y: 1.65, beam: 0.45, chine: 0.34, keel: -0.16, top: 0.24 },
      { y: 2.48, beam: 0.03, chine: 0.02, keel: -0.025, top: 0.10 },
    ];
    primitives.push(loft('hull', `${sideName} catamaran hull`, stations.map((s) => ({
      y: s.y,
      ring: hullRing(s.beam, s.chine, s.keel, -0.04, s.top).map(([x, z]) => [x + xOffset, z]),
    })), MATERIALS.tealDark));
  }
  primitives.push(box('deck', 'Bridge deck', { x: 2.55, y: 4.35, z: 0.16 }, { x: 0, y: -0.02, z: 0.34 }, MATERIALS.deck));
  primitives.push(loft('superstructure', 'Faceted passenger cabin', [
    { y: -1.18, ring: taperedWallRing(0.86, 0.76, 0.43, 1.18) },
    { y: 0.78, ring: taperedWallRing(0.94, 0.82, 0.43, 1.18) },
    { y: 1.32, ring: taperedWallRing(0.66, 0.52, 0.50, 1.03) },
  ], MATERIALS.warmWhite));
  primitives.push(box('window', 'Port panoramic glazing', { x: 0.035, y: 1.58, z: 0.38 }, { x: -0.875, y: -0.06, z: 0.91 }, MATERIALS.glass));
  primitives.push(box('window', 'Starboard panoramic glazing', { x: 0.035, y: 1.58, z: 0.38 }, { x: 0.875, y: -0.06, z: 0.91 }, MATERIALS.glass));
  primitives.push(box('window', 'Port forward windshield', { x: 0.54, y: 0.035, z: 0.36 }, { x: -0.30, y: 1.305, z: 0.86 }, MATERIALS.glass));
  primitives.push(box('window', 'Starboard forward windshield', { x: 0.54, y: 0.035, z: 0.36 }, { x: 0.30, y: 1.305, z: 0.86 }, MATERIALS.glass));
  primitives.push(box('window', 'Aft glazing', { x: 1.42, y: 0.035, z: 0.35 }, { x: 0, y: -1.195, z: 0.91 }, MATERIALS.glass));
  primitives.push(box('roof', 'Cabin roof', { x: 1.88, y: 2.56, z: 0.08 }, { x: 0, y: 0.02, z: 1.24 }, MATERIALS.white));
  primitives.push(box('solar', 'Roof solar array', { x: 1.38, y: 1.52, z: 0.03 }, { x: 0, y: -0.16, z: 1.295 }, MATERIALS.solar));
  primitives.push(cylinder('mast', 'Sensor mast', 0.035, 0.68, { x: 0, y: 0.06, z: 1.66 }, 'z', MATERIALS.steel));
  primitives.push(cylinder('sensor', 'Autonomy sensor pod', 0.13, 0.11, { x: 0, y: 0.06, z: 1.92 }, 'z', MATERIALS.teal));
  primitives.push(cylinder('antenna', 'Air-draught antenna', 0.012, 1.30, { x: 0, y: 0.06, z: 2.65 }, 'z', MATERIALS.steel));
  primitives.push(box('light', 'Port navigation light', { x: 0.09, y: 0.08, z: 0.10 }, { x: -0.93, y: 0.65, z: 1.39 }, MATERIALS.red));
  primitives.push(box('light', 'Starboard navigation light', { x: 0.09, y: 0.08, z: 0.10 }, { x: 0.93, y: 0.65, z: 1.39 }, MATERIALS.teal));
  primitives.push(box('door', 'Port boarding door', { x: 0.04, y: 0.48, z: 0.67 }, { x: -0.89, y: -0.80, z: 0.79 }, MATERIALS.glass));
  primitives.push(box('door', 'Starboard boarding door', { x: 0.04, y: 0.48, z: 0.67 }, { x: 0.89, y: -0.80, z: 0.79 }, MATERIALS.glass));
  primitives.push(...railRun('Port bow rail', -1.22, 1.2, 2.13, 0.9));
  primitives.push(...railRun('Starboard bow rail', 1.22, 1.2, 2.13, 0.9));
  primitives.push(...railRun('Port aft rail', -1.22, -2.10, -1.35, 0.9));
  primitives.push(...railRun('Starboard aft rail', 1.22, -2.10, -1.35, 0.9));
  primitives.push(cylinder('thruster', 'Port azimuth thruster', 0.15, 0.32, { x: -0.78, y: -2.02, z: -0.02 }, 'z', MATERIALS.black));
  primitives.push(cylinder('thruster', 'Starboard azimuth thruster', 0.15, 0.32, { x: 0.78, y: -2.02, z: -0.02 }, 'z', MATERIALS.black));
  primitives.push(box('trim', 'Electric identity stripe', { x: 2.58, y: 2.32, z: 0.055 }, { x: 0, y: 0.08, z: 0.48 }, MATERIALS.teal));
  primitives.push(cylinder('fender', 'Port rub rail', 0.045, 3.45, { x: -1.34, y: -0.10, z: 0.42 }, 'y', MATERIALS.black));
  primitives.push(cylinder('fender', 'Starboard rub rail', 0.045, 3.45, { x: 1.34, y: -0.10, z: 0.42 }, 'y', MATERIALS.black));
  primitives.push(box('bumper', 'Bow docking bumper', { x: 1.55, y: 0.12, z: 0.15 }, { x: 0, y: 2.40, z: 0.40 }, MATERIALS.black));
  return asset({
    id: 'marine/electric-catamaran-ferry', version: '2.5.1', category: 'marine',
    label: 'Electric catamaran ferry', scenePreset: 'ocean', primitives,
    envelopeM: { x: 2.8, y: 5.0, zMin: -0.2, zMax: 3.3 },
    presentation: { targetM: { x: 0, y: 0, z: 0.72 }, orbitYawDeg: 38, orbitPitchDeg: -11, distanceFactor: 1.42 },
  });
}

function buildResearchWorkVessel() {
  const primitives = [];
  const stations = [
    { y: -17.75, beam: 3.65, chine: 2.70, keel: -2.25, top: 1.18 },
    { y: -14.0, beam: 4.55, chine: 3.55, keel: -2.62, top: 1.42 },
    { y: -4.0, beam: 4.88, chine: 3.82, keel: -2.70, top: 1.52 },
    { y: 7.5, beam: 4.64, chine: 3.58, keel: -2.55, top: 1.62 },
    { y: 13.2, beam: 3.55, chine: 2.45, keel: -1.85, top: 1.85 },
    { y: 18.10, beam: 0.03, chine: 0.02, keel: -0.16, top: 2.12 },
  ];
  primitives.push(loft('hull', 'Faceted research-vessel hull', stations.map((s) => ({
    y: s.y, ring: hullRing(s.beam, s.chine, s.keel, -0.55, s.top),
  })), MATERIALS.hullNavy));
  const lowerStations = stations.slice(0, -1).map((s) => ({
    y: s.y,
    ring: hullRing(s.beam * 0.91, s.chine * 0.94, s.keel, -0.72, -0.18),
  }));
  lowerStations.push({ y: 18.0, ring: hullRing(0.05, 0.03, -0.18, -0.15, -0.10) });
  primitives.push(loft('hull', 'Antifouling lower hull', lowerStations, MATERIALS.antifouling));
  primitives.push(box('deck', 'Main working deck', { x: 9.1, y: 24.8, z: 0.16 }, { x: 0, y: -3.2, z: 1.58 }, MATERIALS.deck));
  primitives.push(loft('deck', 'Tapered foredeck', [
    { y: 7.7, ring: taperedWallRing(4.34, 4.30, 1.58, 1.70) },
    { y: 13.2, ring: taperedWallRing(3.35, 3.28, 1.80, 1.92) },
    { y: 18.0, ring: taperedWallRing(0.06, 0.03, 2.04, 2.12) },
  ], MATERIALS.deck));
  primitives.push(loft('superstructure', 'Laboratory deckhouse', [
    { y: -8.5, ring: taperedWallRing(3.32, 3.16, 1.64, 4.30) },
    { y: 0.9, ring: taperedWallRing(3.48, 3.28, 1.64, 4.30) },
    { y: 3.1, ring: taperedWallRing(3.02, 2.82, 1.72, 4.00) },
  ], MATERIALS.warmWhite));
  primitives.push(loft('bridge', 'Wheelhouse', [
    { y: -1.0, ring: taperedWallRing(3.30, 3.02, 4.30, 5.88) },
    { y: 2.4, ring: taperedWallRing(3.48, 3.18, 4.30, 5.88) },
    { y: 4.35, ring: taperedWallRing(2.72, 2.42, 4.38, 5.52) },
  ], MATERIALS.white));
  primitives.push(box('window', 'Bridge front glazing', { x: 5.20, y: 0.06, z: 0.54 }, { x: 0, y: 4.29, z: 5.28 }, MATERIALS.glass));
  for (const x of [-3.44, 3.44]) {
    primitives.push(box('window', `${x < 0 ? 'Port' : 'Starboard'} bridge glazing`, { x: 0.055, y: 2.75, z: 0.58 }, { x, y: 1.0, z: 5.28 }, MATERIALS.glass));
    primitives.push(box('window', `${x < 0 ? 'Port' : 'Starboard'} laboratory glazing`, { x: 0.05, y: 5.35, z: 0.44 }, { x: x * 0.96, y: -3.55, z: 3.48 }, MATERIALS.glass));
  }
  primitives.push(box('roof', 'Wheelhouse roof', { x: 6.86, y: 5.45, z: 0.14 }, { x: 0, y: 1.2, z: 5.96 }, MATERIALS.deckDark));
  for (const [x, label] of [[-2.62, 'Port'], [0, 'Centre'], [2.62, 'Starboard']]) {
    primitives.push(cylinder('exhaust', `${label} exhaust`, 0.18, 1.18, { x, y: -2.25, z: 6.73 }, 'z', MATERIALS.black));
  }
  primitives.push(cylinder('mast', 'Main mast', 0.13, 4.8, { x: 0, y: 0.25, z: 8.45 }, 'z', MATERIALS.steel));
  primitives.push(beam('mast', 'Port mast stay', { x: 0, y: 0.25, z: 10.15 }, { x: -1.6, y: 0.25, z: 6.34 }, 0.09, MATERIALS.steel));
  primitives.push(beam('mast', 'Starboard mast stay', { x: 0, y: 0.25, z: 10.15 }, { x: 1.6, y: 0.25, z: 6.34 }, 0.09, MATERIALS.steel));
  primitives.push(cylinder('sensor', 'Navigation radar pod', 0.38, 0.22, { x: 0, y: 0.25, z: 9.82 }, 'z', MATERIALS.white));
  primitives.push(cylinder('antenna', 'Air-draught reference antenna', 0.018, 9.55, { x: 0, y: 0.25, z: 14.925 }, 'z', MATERIALS.steel));
  primitives.push(box('workdeck', 'Aft scientific work deck', { x: 8.5, y: 8.4, z: 0.12 }, { x: 0, y: -12.3, z: 1.72 }, MATERIALS.deckDark));
  primitives.push(beam('crane', 'Crane pedestal', { x: 3.15, y: -9.1, z: 1.75 }, { x: 3.15, y: -9.1, z: 5.30 }, 0.34, MATERIALS.yellow));
  primitives.push(beam('crane', 'Crane boom', { x: 3.15, y: -9.1, z: 5.18 }, { x: 0.45, y: -12.7, z: 5.55 }, 0.30, MATERIALS.yellow));
  primitives.push(beam('a-frame', 'Port A-frame leg', { x: -3.7, y: -16.1, z: 1.78 }, { x: -1.18, y: -15.45, z: 6.15 }, 0.22, MATERIALS.orange));
  primitives.push(beam('a-frame', 'Starboard A-frame leg', { x: 3.7, y: -16.1, z: 1.78 }, { x: 1.18, y: -15.45, z: 6.15 }, 0.22, MATERIALS.orange));
  primitives.push(beam('a-frame', 'A-frame cross member', { x: -1.18, y: -15.45, z: 6.15 }, { x: 1.18, y: -15.45, z: 6.15 }, 0.24, MATERIALS.orange));
  primitives.push(cylinder('winch', 'Scientific winch', 0.62, 1.8, { x: 0, y: -12.4, z: 2.45 }, 'x', MATERIALS.steel));
  primitives.push(cylinder('liferaft', 'Port liferaft canister', 0.34, 1.15, { x: -3.63, y: -7.0, z: 3.18 }, 'y', MATERIALS.white));
  primitives.push(cylinder('liferaft', 'Starboard liferaft canister', 0.34, 1.15, { x: 3.63, y: -7.0, z: 3.18 }, 'y', MATERIALS.white));
  primitives.push(cylinder('satcom', 'Satellite communications dome', 0.52, 0.66, { x: -2.25, y: -0.35, z: 6.48 }, 'z', MATERIALS.white));
  primitives.push(cylinder('searchlight', 'Bridge searchlight', 0.22, 0.42, { x: 2.52, y: 4.15, z: 6.18 }, 'y', MATERIALS.white));
  primitives.push(loft('rescue-craft', 'Port rescue craft', [
    { y: -6.8, ring: rectangleRing(0.18, 3.05, 3.35) },
    { y: -3.2, ring: rectangleRing(0.62, 3.05, 3.42) },
    { y: -1.8, ring: rectangleRing(0.08, 3.10, 3.28) },
  ].map((section) => ({ ...section, ring: section.ring.map(([x, z]) => [x - 3.72, z]) })), MATERIALS.orange));
  primitives.push(...railRun('Port work-deck rail', -4.25, -16.1, -8.3, 2.45));
  primitives.push(...railRun('Starboard work-deck rail', 4.25, -16.1, -8.3, 2.45));
  primitives.push(cylinder('azipod', 'Port azimuth propulsion unit', 0.46, 1.45, { x: -2.35, y: -16.35, z: -1.72 }, 'y', MATERIALS.black));
  primitives.push(cylinder('azipod', 'Starboard azimuth propulsion unit', 0.46, 1.45, { x: 2.35, y: -16.35, z: -1.72 }, 'y', MATERIALS.black));
  primitives.push(cylinder('thruster', 'Bow tunnel-thruster marker', 0.54, 4.9, { x: 0, y: 13.1, z: -1.2 }, 'x', MATERIALS.black));
  primitives.push(box('identity', 'Research stripe', { x: 9.02, y: 8.8, z: 0.16 }, { x: 0, y: -3.7, z: 2.05 }, MATERIALS.teal));
  primitives.push(box('hull-band', 'Port white hull band', { x: 0.08, y: 18.0, z: 0.28 }, { x: -4.78, y: -3.2, z: 0.56 }, MATERIALS.white));
  primitives.push(box('hull-band', 'Starboard white hull band', { x: 0.08, y: 18.0, z: 0.28 }, { x: 4.78, y: -3.2, z: 0.56 }, MATERIALS.white));
  primitives.push(box('light', 'Port navigation light', { x: 0.16, y: 0.12, z: 0.16 }, { x: -3.78, y: 3.1, z: 6.18 }, MATERIALS.red));
  primitives.push(box('light', 'Starboard navigation light', { x: 0.16, y: 0.12, z: 0.16 }, { x: 3.78, y: 3.1, z: 6.18 }, MATERIALS.teal));
  return asset({
    id: 'marine/research-work-vessel', version: '2.5.1', category: 'marine',
    label: 'Research and work vessel', scenePreset: 'ocean', primitives,
    envelopeM: { x: 9.9, y: 36.25, zMin: -2.7, zMax: 19.7 },
    presentation: { targetM: { x: 0, y: -1.0, z: 3.15 }, orbitYawDeg: 52, orbitPitchDeg: -10, distanceFactor: 1.30 },
  });
}

function buildModularBess() {
  const primitives = [];
  const cabinetXs = [-2.70, -0.90, 0.90];
  for (const [cabinetIndex, x] of cabinetXs.entries()) {
    primitives.push(box(
      'battery-cabinet', `Battery cabinet ${cabinetIndex + 1}`,
      { x: 1.55, y: 1.10, z: 2.35 }, { x, y: 0, z: 1.275 }, MATERIALS.warmWhite,
    ));
    primitives.push(box(
      'cabinet-door', `Battery cabinet ${cabinetIndex + 1} service door`,
      { x: 1.34, y: 0.035, z: 2.02 }, { x, y: -0.565, z: 1.28 }, MATERIALS.deck,
    ));
    for (let shelf = 0; shelf < 7; shelf += 1) {
      primitives.push(box(
        'battery-module', `Cabinet ${cabinetIndex + 1} module ${shelf + 1}`,
        { x: 1.12, y: 0.10, z: 0.18 },
        { x, y: -0.605, z: 0.34 + shelf * 0.255 }, MATERIALS.tealDark,
      ));
    }
    primitives.push(box(
      'status-panel', `Cabinet ${cabinetIndex + 1} status panel`,
      { x: 0.28, y: 0.045, z: 0.16 }, { x: x + 0.45, y: -0.61, z: 2.23 }, MATERIALS.glass,
    ));
  }
  primitives.push(box(
    'pcs-cabinet', 'Power-conversion-system cabinet',
    { x: 1.45, y: 1.10, z: 2.05 }, { x: 2.76, y: 0, z: 1.125 }, MATERIALS.neutral,
  ));
  for (let vent = 0; vent < 9; vent += 1) {
    primitives.push(box(
      'pcs-vent', `PCS ventilation slot ${vent + 1}`,
      { x: 1.02, y: 0.04, z: 0.045 },
      { x: 2.76, y: -0.575, z: 0.44 + vent * 0.15 }, MATERIALS.deckDark,
    ));
  }
  primitives.push(box(
    'control-panel', 'PCS control display',
    { x: 0.48, y: 0.05, z: 0.28 }, { x: 2.76, y: -0.58, z: 1.88 }, MATERIALS.glass,
  ));
  primitives.push(box(
    'skid', 'Shared equipment skid',
    { x: 7.55, y: 1.34, z: 0.14 }, { x: 0, y: 0, z: 0.07 }, MATERIALS.steel,
  ));
  primitives.push(cylinder(
    'dc-bus', 'Protected DC collection bus', 0.045, 5.50,
    { x: -0.86, y: 0.60, z: 0.23 }, 'x', MATERIALS.teal,
  ));
  for (const x of cabinetXs) {
    primitives.push(beam(
      'dc-drop', 'Cabinet protected DC drop',
      { x, y: 0.60, z: 0.23 }, { x, y: 0.60, z: 0.70 }, 0.055, MATERIALS.teal,
    ));
  }
  primitives.push(box(
    'hvac', 'Cabinet HVAC interface',
    { x: 1.20, y: 0.82, z: 0.42 }, { x: 2.76, y: 0.05, z: 2.37 }, MATERIALS.white,
  ));
  return asset({
    id: 'stationary/modular-bess', version: '1.0.0', category: 'stationary',
    label: 'Modular stationary energy-storage system', scenePreset: 'studio-grid', primitives,
    envelopeM: { x: 7.60, y: 1.38, zMin: 0, zMax: 2.60 },
    presentation: { targetM: { x: 0, y: 0, z: 1.20 }, orbitYawDeg: 38, orbitPitchDeg: -12, distanceFactor: 1.55 },
  });
}

function buildForcedAirThermalSystem() {
  const primitives = [];
  primitives.push(box(
    'air-duct', 'Filtered pack inlet duct',
    { x: 3.50, y: 1.70, z: 0.46 }, { x: -0.25, y: 0, z: 0.31 }, MATERIALS.deck,
  ));
  primitives.push(box(
    'air-filter', 'Replaceable inlet filter',
    { x: 0.12, y: 1.56, z: 0.38 }, { x: -2.07, y: 0, z: 0.31 }, MATERIALS.neutral,
  ));
  for (let vane = 0; vane < 7; vane += 1) {
    primitives.push(box(
      'flow-vane', `Duct flow vane ${vane + 1}`,
      { x: 2.90, y: 0.035, z: 0.20 },
      { x: -0.32, y: -0.63 + vane * 0.21, z: 0.55 }, MATERIALS.teal,
    ));
  }
  for (let fan = 0; fan < 2; fan += 1) {
    primitives.push(cylinder(
      'fan', `PWM cooling fan ${fan + 1}`,
      0.39, 0.18, { x: 1.70, y: -0.48 + fan * 0.96, z: 0.46 }, 'x', MATERIALS.deckDark,
    ));
  }
  primitives.push(box(
    'outlet-plenum', 'Pack outlet plenum',
    { x: 0.45, y: 1.70, z: 0.72 }, { x: 1.95, y: 0, z: 0.39 }, MATERIALS.warmWhite,
  ));
  return asset({
    id: 'thermal/forced-air-duct', version: '1.0.0', category: 'thermal-equipment',
    label: 'Forced-air fans, filter and pack duct', scenePreset: 'studio-grid', primitives,
    envelopeM: { x: 4.50, y: 1.75, zMin: 0, zMax: 0.90 },
    presentation: { targetM: { x: 0, y: 0, z: 0.34 }, orbitYawDeg: 42, orbitPitchDeg: -18, distanceFactor: 1.42 },
  });
}

function buildLiquidThermalSystem({ chilled = false } = {}) {
  const primitives = [];
  primitives.push(box(
    'cold-plate', 'Bottom liquid cold plate',
    { x: 3.50, y: 2.25, z: 0.12 }, { x: -0.45, y: 0, z: 0.16 }, MATERIALS.steel,
  ));
  for (let channel = 0; channel < 7; channel += 1) {
    const x = -1.75 + channel * 0.43;
    primitives.push(cylinder(
      'coolant-channel', `Cold-plate coolant channel ${channel + 1}`,
      0.035, 1.98, { x, y: 0, z: 0.245 }, 'y', MATERIALS.teal,
    ));
  }
  primitives.push(cylinder(
    'manifold', 'Inlet manifold', 0.075, 2.82,
    { x: -0.45, y: -1.02, z: 0.245 }, 'x', MATERIALS.tealDark,
  ));
  primitives.push(cylinder(
    'manifold', 'Outlet manifold', 0.075, 2.82,
    { x: -0.45, y: 1.02, z: 0.245 }, 'x', MATERIALS.tealDark,
  ));
  primitives.push(cylinder(
    'pump', 'Electric coolant pump', 0.28, 0.58,
    { x: 2.18, y: -1.14, z: 0.42 }, 'x', MATERIALS.tealDark,
  ));
  if (chilled) {
    primitives.push(box(
      'chiller', 'Coolant-to-refrigerant chiller interface',
      { x: 0.82, y: 0.68, z: 0.62 }, { x: 2.18, y: 0.10, z: 0.43 }, MATERIALS.white,
    ));
  }
  primitives.push(box(
    'radiator', 'Radiator and fan assembly',
    { x: 0.30, y: 1.55, z: 1.22 }, { x: 2.28, y: 1.20, z: 0.73 }, MATERIALS.deckDark,
  ));
  for (let fan = 0; fan < 2; fan += 1) {
    primitives.push(cylinder(
      'fan', `Radiator fan ${fan + 1}`,
      0.31, 0.09, { x: 2.10, y: 0.84 + fan * 0.70, z: 0.73 }, 'x', MATERIALS.black,
    ));
  }
  primitives.push(box(
    'reservoir', 'Expansion tank',
    { x: 0.46, y: 0.44, z: 0.72 }, { x: 1.22, y: 1.48, z: 0.46 }, MATERIALS.warmWhite,
  ));
  const hose = (name, fromM, toM) => primitives.push(beam('coolant-hose', name, fromM, toM, 0.085, MATERIALS.teal));
  hose('Cold-plate outlet to pump', { x: 0.96, y: -1.02, z: 0.25 }, { x: 1.88, y: -1.14, z: 0.42 });
  if (chilled) {
    hose('Pump to chiller', { x: 2.47, y: -1.14, z: 0.42 }, { x: 2.47, y: -0.24, z: 0.43 });
    hose('Chiller to radiator', { x: 2.47, y: 0.44, z: 0.43 }, { x: 2.32, y: 0.55, z: 0.73 });
  } else {
    hose('Pump to radiator', { x: 2.47, y: -1.14, z: 0.42 }, { x: 2.32, y: 0.55, z: 0.73 });
  }
  hose('Radiator to reservoir', { x: 2.32, y: 1.76, z: 0.73 }, { x: 1.45, y: 1.48, z: 0.62 });
  hose('Reservoir return to plate', { x: 0.99, y: 1.48, z: 0.50 }, { x: 0.96, y: 1.02, z: 0.25 });
  return asset({
    id: chilled ? 'thermal/liquid-cold-plate-chiller' : 'thermal/liquid-cold-plate-radiator',
    version: '1.0.0', category: 'thermal-equipment',
    label: chilled
      ? 'Liquid cold plate, pump and chiller interface'
      : 'Liquid cold plate, pump and radiator loop',
    scenePreset: 'studio-grid', primitives,
    envelopeM: { x: 5.20, y: 4.10, zMin: 0, zMax: 1.40 },
    presentation: { targetM: { x: 0.35, y: 0.12, z: 0.42 }, orbitYawDeg: 42, orbitPitchDeg: -18, distanceFactor: 1.42 },
  });
}

function asset({ id, version, category, label, scenePreset = 'studio', primitives, envelopeM = null, presentation = null }) {
  const portable = {
    libraryVersion: ASSET_LIBRARY3D_VERSION,
    assetId: id,
    version,
    category,
    label,
    kind: 'low-poly-engineering-visual',
    visualStyle: 'flat-technical',
    effects: Object.freeze({ castShadows: false, decorativeWake: false }),
    scenePreset,
    coordinateSystem: 'metres; x starboard/right, y forward, z up',
    licence: ASSET_LIBRARY3D_LICENSE,
    envelopeM,
    presentation,
    primitives: Object.freeze(primitives),
  };
  // The digest identifies geometry, not the study binding around it. A vessel
  // may add evidence or a display datum without changing a vertex; that must
  // retain the same geometry identity. Conversely, changing any primitive or
  // declared envelope changes this digest and fails validation until the
  // asset is intentionally regenerated.
  portable.geometryDigest = geometryDigestFor(portable);
  return deepFreeze(portable);
}

function genericAsset(kind, sizeM) {
  const w = sizeM.x;
  const l = sizeM.y;
  const h = sizeM.z;
  const primitives = [];
  const wheel = (name, x, y, z, radius = h * 0.18) => primitives.push(cylinder('wheel', name, radius, w * 0.11, { x, y, z }, 'x', MATERIALS.black));
  switch (kind) {
    case 'car':
      primitives.push(loft('body', 'Passenger-car body', [
        { y: -l * 0.49, ring: rectangleRing(w * 0.32, h * 0.18, h * 0.48) },
        { y: -l * 0.34, ring: rectangleRing(w * 0.49, h * 0.12, h * 0.55) },
        { y: l * 0.28, ring: rectangleRing(w * 0.49, h * 0.12, h * 0.55) },
        { y: l * 0.49, ring: rectangleRing(w * 0.28, h * 0.2, h * 0.42) },
      ], MATERIALS.bodyBlue));
      primitives.push(loft('cabin', 'Passenger cabin', [
        { y: -l * 0.22, ring: rectangleRing(w * 0.39, h * 0.52, h * 0.93) },
        { y: l * 0.10, ring: rectangleRing(w * 0.42, h * 0.52, h * 0.94) },
        { y: l * 0.28, ring: rectangleRing(w * 0.30, h * 0.52, h * 0.70) },
      ], MATERIALS.glass));
      for (const y of [-l * 0.32, l * 0.31]) for (const x of [-w * 0.48, w * 0.48]) wheel(`${x < 0 ? 'Port' : 'Starboard'} wheel`, x, y, h * 0.20);
      break;
    case 'bus':
    case 'van':
      primitives.push(loft('body', `${kind} body`, [
        { y: -l * 0.5, ring: rectangleRing(w * 0.47, h * 0.08, h * 0.88) },
        { y: l * 0.34, ring: rectangleRing(w * 0.49, h * 0.08, h * 0.92) },
        { y: l * 0.5, ring: rectangleRing(w * 0.40, h * 0.12, h * 0.78) },
      ], kind === 'bus' ? MATERIALS.tealDark : MATERIALS.bodyGreen));
      primitives.push(box('window', 'Panoramic side glazing', { x: w * 0.96, y: l * 0.62, z: h * 0.24 }, { x: 0, y: l * 0.04, z: h * 0.67 }, MATERIALS.glass));
      for (const y of kind === 'bus' ? [-l * 0.37, 0, l * 0.36] : [-l * 0.34, l * 0.32]) for (const x of [-w * 0.48, w * 0.48]) wheel('Road wheel', x, y, h * 0.17, h * 0.15);
      break;
    case 'boat':
      primitives.push(loft('hull', 'Small-craft hull', [
        { y: -l * 0.49, ring: hullRing(w * 0.36, w * 0.28, 0, h * 0.08, h * 0.34) },
        { y: -l * 0.2, ring: hullRing(w * 0.49, w * 0.38, 0, h * 0.07, h * 0.38) },
        { y: l * 0.28, ring: hullRing(w * 0.42, w * 0.32, h * 0.05, h * 0.10, h * 0.42) },
        { y: l * 0.49, ring: hullRing(w * 0.05, w * 0.04, h * 0.20, h * 0.22, h * 0.48) },
      ], MATERIALS.hullBlue));
      primitives.push(loft('cabin', 'Small-craft cabin', [
        { y: -l * 0.12, ring: rectangleRing(w * 0.29, h * 0.42, h * 0.82) },
        { y: l * 0.22, ring: rectangleRing(w * 0.34, h * 0.42, h * 0.82) },
        { y: l * 0.32, ring: rectangleRing(w * 0.22, h * 0.46, h * 0.72) },
      ], MATERIALS.white));
      break;
    case 'bike':
    case 'scooter': {
      wheel('Front wheel', 0, l * 0.40, h * 0.28, h * 0.26);
      wheel('Rear wheel', 0, -l * 0.40, h * 0.28, h * 0.26);
      primitives.push(beam('frame', 'Main frame', { x: 0, y: -l * 0.34, z: h * 0.3 }, { x: 0, y: l * 0.30, z: h * 0.55 }, w * 0.10, MATERIALS.orange));
      primitives.push(beam('frame', 'Steering stem', { x: 0, y: l * 0.30, z: h * 0.30 }, { x: 0, y: l * 0.33, z: h * 0.92 }, w * 0.08, MATERIALS.steel));
      break;
    }
    case 'drone':
      primitives.push(box('body', 'Multirotor body', { x: w * 0.28, y: l * 0.28, z: h * 0.62 }, { x: 0, y: 0, z: h * 0.5 }, MATERIALS.neutral));
      for (const x of [-w * 0.36, w * 0.36]) for (const y of [-l * 0.36, l * 0.36]) {
        primitives.push(beam('arm', 'Rotor arm', { x: 0, y: 0, z: h * 0.56 }, { x, y, z: h * 0.60 }, h * 0.10, MATERIALS.neutral));
        primitives.push(cylinder('rotor', 'Rotor disc', w * 0.18, h * 0.035, { x, y, z: h * 0.68 }, 'z', MATERIALS.black));
      }
      break;
    case 'humanoid':
      primitives.push(box('torso', 'Torso', { x: w * 0.72, y: l * 0.72, z: h * 0.34 }, { x: 0, y: 0, z: h * 0.68 }, MATERIALS.neutral));
      primitives.push(box('head', 'Head', { x: w * 0.38, y: l * 0.45, z: h * 0.15 }, { x: 0, y: 0, z: h * 0.94 }, MATERIALS.white));
      for (const x of [-w * 0.22, w * 0.22]) primitives.push(beam('leg', 'Leg', { x, y: 0, z: 0 }, { x, y: 0, z: h * 0.51 }, w * 0.18, MATERIALS.bodyBlue));
      break;
    case 'quadruped':
      primitives.push(box('body', 'Quadruped body', { x: w * 0.82, y: l * 0.68, z: h * 0.34 }, { x: 0, y: 0, z: h * 0.68 }, MATERIALS.neutral));
      for (const x of [-w * 0.34, w * 0.34]) for (const y of [-l * 0.25, l * 0.25]) primitives.push(beam('leg', 'Articulated leg', { x, y, z: h * 0.58 }, { x, y, z: 0 }, w * 0.11, MATERIALS.bodyBlue));
      break;
    case 'agv':
    case 'puck':
      primitives.push(kind === 'puck'
        ? cylinder('body', 'Robot-vacuum body', w * 0.5, h, { x: 0, y: 0, z: h * 0.5 }, 'z', MATERIALS.neutral)
        : box('body', 'AGV chassis', { x: w, y: l, z: h * 0.72 }, { x: 0, y: 0, z: h * 0.44 }, MATERIALS.bodyGreen));
      break;
    case 'cabinet':
      primitives.push(box('cabinet', 'Storage cabinet', { x: w, y: l, z: h }, { x: 0, y: 0, z: h * 0.5 }, MATERIALS.neutral));
      for (let i = 1; i < 5; i += 1) primitives.push(box('shelf', `Shelf ${i}`, { x: w * 0.94, y: l * 0.94, z: h * 0.012 }, { x: 0, y: 0, z: h * i / 5 }, MATERIALS.steel));
      break;
    case 'handtool':
      primitives.push(box('motor', 'Motor body', { x: w * 1.6, y: l * 0.55, z: h * 0.42 }, { x: 0, y: l * 0.12, z: h * 0.74 }, MATERIALS.orange));
      primitives.push(box('grip', 'Tool grip', { x: w, y: l * 0.42, z: h * 0.62 }, { x: 0, y: -l * 0.08, z: h * 0.32 }, MATERIALS.black));
      break;
    case 'wrist':
      primitives.push(box('case', 'Wearable case', { x: w, y: l, z: h }, { x: 0, y: 0, z: h * 0.5 }, MATERIALS.neutral));
      primitives.push(box('strap', 'Wrist strap', { x: w * 0.72, y: l * 2.8, z: h * 0.18 }, { x: 0, y: 0, z: h * 0.42 }, MATERIALS.black));
      break;
    default:
      primitives.push(box('body', 'Host envelope', { x: w, y: l, z: h }, { x: 0, y: 0, z: h * 0.5 }, MATERIALS.neutral));
  }
  return asset({
    id: `host/${kind}`, version: '1.0.1', category: 'host',
    label: `${kind} host visual`, primitives,
    envelopeM: { x: w, y: l, zMin: 0, zMax: h },
    presentation: { targetM: { x: 0, y: 0, z: h * 0.45 }, orbitYawDeg: 34, orbitPitchDeg: -18, distanceFactor: 1.65 },
  });
}

const FIXED_ASSETS = deepFreeze({
  'marine/electric-catamaran-ferry': buildElectricCatamaran(),
  'marine/research-work-vessel': buildResearchWorkVessel(),
  'stationary/modular-bess': buildModularBess(),
  'thermal/forced-air-duct': buildForcedAirThermalSystem(),
  'thermal/liquid-cold-plate-radiator': buildLiquidThermalSystem(),
  'thermal/liquid-cold-plate-chiller': buildLiquidThermalSystem({ chilled: true }),
});

export const VESSEL_ASSET_IDS = Object.freeze({
  milliAmpere1: 'marine/electric-catamaran-ferry',
  gunnerus: 'marine/research-work-vessel',
});

export const REPORT_ASSET_IDS = Object.freeze({
  stationaryStorage: 'stationary/modular-bess',
  forcedAirThermalSystem: 'thermal/forced-air-duct',
  liquidRadiatorThermalSystem: 'thermal/liquid-cold-plate-radiator',
  liquidThermalSystem: 'thermal/liquid-cold-plate-chiller',
});

export const HOST_ASSET_KINDS = Object.freeze([
  'car', 'bus', 'van', 'bike', 'scooter', 'boat', 'drone', 'agv',
  'humanoid', 'quadruped', 'puck', 'cabinet', 'box', 'handtool', 'wrist',
]);

export function fixedAsset3dById(id) {
  return FIXED_ASSETS[id] || null;
}

export function instantiateHostAsset3d(kind, sizeM) {
  if (!HOST_ASSET_KINDS.includes(kind) || !validSize(sizeM)) return null;
  return genericAsset(kind, sizeM);
}

export function asset3dCatalog() {
  const fixed = Object.values(FIXED_ASSETS).map(assetMetadata);
  const templates = HOST_ASSET_KINDS.map((kind) => ({
    assetId: `host/${kind}`, version: '1.0.1', category: 'host-template',
    label: `${kind} host visual`, licence: ASSET_LIBRARY3D_LICENSE,
    parameterSchema: Object.freeze({
      sizeM: Object.freeze({
        unit: 'm',
        axes: Object.freeze(['x', 'y', 'z']),
        rule: 'Each axis must be a finite number greater than zero.',
      }),
    }),
    digestStrategy: 'Each instantiated size receives a geometry-derived digest.',
    visualStyle: 'flat-technical',
    effects: Object.freeze({ castShadows: false, decorativeWake: false }),
  }));
  return deepFreeze({ version: ASSET_LIBRARY3D_VERSION, fixed, templates });
}

export function validateAsset3d(model) {
  const errors = [];
  if (!model || typeof model !== 'object') return { valid: false, errors: ['asset must be an object'] };
  if (!model.assetId || !model.version || !model.geometryDigest) errors.push('identity, version and geometry digest are required');
  if (model.geometryDigest && model.geometryDigest !== geometryDigestFor(model)) errors.push('geometry digest does not match the portable geometry');
  if (model.licence?.spdx !== 'MIT' || model.licence?.thirdPartyAsset !== false) errors.push('explicit original MIT licence metadata is required');
  if (model.visualStyle !== 'flat-technical' || model.effects?.castShadows !== false || model.effects?.decorativeWake !== false) {
    errors.push('flat technical style must explicitly forbid cast shadows and decorative wake');
  }
  if (!Array.isArray(model.primitives) || model.primitives.length === 0) errors.push('at least one primitive is required');
  for (const [index, primitive] of (model.primitives || []).entries()) {
    const prefix = `primitive ${index}`;
    if (!['box', 'mesh', 'cylinder'].includes(primitive.kind)) errors.push(`${prefix}: unsupported kind`);
    if (!primitive.role || !primitive.name || !primitive.material?.id) errors.push(`${prefix}: role, name and material are required`);
    if (!validSize(primitive.sizeM) || !finitePoint(primitive.atM)) errors.push(`${prefix}: finite positive bounds are required`);
    if (primitive.kind === 'mesh') {
      if (!Array.isArray(primitive.vertices) || primitive.vertices.length < 4) errors.push(`${prefix}: mesh needs vertices`);
      if (!Array.isArray(primitive.triangles) || primitive.triangles.length < 4) errors.push(`${prefix}: mesh needs triangles`);
      for (const face of primitive.triangles || []) {
        if (!Array.isArray(face) || face.length !== 3 || face.some((v) => !Number.isInteger(v) || v < 0 || v >= primitive.vertices.length)) {
          errors.push(`${prefix}: triangle index is invalid`);
          break;
        }
        const [a, b, c] = face.map((v) => primitive.vertices[v]);
        if (Math.sqrt(dot(cross(sub(b, a), sub(c, a)), cross(sub(b, a), sub(c, a)))) < 1e-8) {
          errors.push(`${prefix}: zero-area triangle`);
          break;
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function assetMetadata(model) {
  return {
    assetId: model.assetId, version: model.version, category: model.category,
    label: model.label, geometryDigest: model.geometryDigest,
    licence: model.licence, visualStyle: model.visualStyle, effects: model.effects,
    primitiveCount: model.primitives.length,
  };
}

function validSize(value) {
  return value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key]) && value[key] > 0);
}

function finitePoint(value) {
  return value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key]));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function geometryDigestFor(model) {
  const geometry = {
    coordinateSystem: model?.coordinateSystem || null,
    envelopeM: model?.envelopeM || null,
    primitives: model?.primitives || null,
  };
  return `fnv1a32:${fnv1a(stableStringify(geometry))}`;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export { MATERIALS };
