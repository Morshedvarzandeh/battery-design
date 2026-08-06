// Render exact assets3d payloads into deterministic review SVGs.
// This is a lightweight visual-review tool, not the runtime renderer.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixedAsset3dById, VESSEL_ASSET_IDS } from '../assets3d/catalog.js';

const outputDir = resolve(process.argv[2] || 'previews/asset-iterations');
const iteration = process.argv[3] || 'iteration-1';
mkdirSync(resolve(outputDir, iteration), { recursive: true });

for (const [slug, assetId] of Object.entries({
  electricCatamaran: VESSEL_ASSET_IDS.milliAmpere1,
  researchWorkVessel: VESSEL_ASSET_IDS.gunnerus,
})) {
  const asset = fixedAsset3dById(assetId);
  const svg = renderAsset(asset, { width: 1280, height: 800 });
  writeFileSync(resolve(outputDir, iteration, `${slug}.svg`), svg);
  writeFileSync(resolve(outputDir, iteration, `${slug}.ppm`), renderRasterAsset(asset, { width: 1280, height: 800 }));
}

// A tiny depth-tested rasterizer keeps the review image honest. SVG painter's
// ordering cannot resolve intersecting deck, glazing and hull faces and used
// to place rear triangles over the vessel. This renderer has no cast shadows,
// reflections, textures or decorative wake: only flat material colour and a
// shallow orientation cue so the original geometry is easy to judge.
function renderRasterAsset(asset, { width, height }) {
  const triangles = asset.primitives.flatMap(primitiveTriangles);
  const target = asset.presentation?.targetM || { x: 0, y: 0, z: 0 };
  const span = Math.max(asset.envelopeM.x, asset.envelopeM.y, asset.envelopeM.zMax - asset.envelopeM.zMin);
  const yaw = (asset.presentation?.orbitYawDeg ?? 38) * Math.PI / 180;
  const pitch = Math.abs(asset.presentation?.orbitPitchDeg ?? -11) * Math.PI / 180;
  const cameraDirection = [Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
  const camera = add([target.x, target.y, target.z], mul(normalize(cameraDirection), span * 1.8));
  const basis = cameraBasis(camera, [target.x, target.y, target.z]);
  const visible = triangles.map((triangle, objectId) => {
    const normal = normalize(cross(sub(triangle.vertices[1], triangle.vertices[0]), sub(triangle.vertices[2], triangle.vertices[0])));
    const centre = triangle.vertices.reduce((sum, point) => add(sum, mul(point, 1 / 3)), [0, 0, 0]);
    return { ...triangle, objectId, normal, projected: triangle.vertices.map((point) => project(point, camera, basis)), facing: dot(normal, normalize(sub(camera, centre))) };
  }).filter((face) => face.facing > 0.001);
  const all = visible.flatMap((face) => face.projected);
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const maxY = Math.max(...all.map((p) => p.y));
  const scale = Math.min(width * 0.80 / Math.max(maxX - minX, 1e-6), height * 0.72 / Math.max(maxY - minY, 1e-6));
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const screen = (p) => ({ x: width * 0.52 + (p.x - centreX) * scale, y: height * 0.54 - (p.y - centreY) * scale, depth: p.depth });
  const pixels = Buffer.alloc(width * height * 3);
  const depth = new Float64Array(width * height).fill(Infinity);
  const owner = new Int32Array(width * height).fill(-1);
  const horizon = Math.round(height * 0.48);
  for (let y = 0; y < height; y += 1) {
    const t = y < horizon ? y / horizon : (y - horizon) / (height - horizon);
    const rgb = y < horizon ? mixRgb([222, 235, 240], [199, 220, 228], t) : mixRgb([177, 207, 215], [122, 169, 184], t);
    for (let x = 0; x < width; x += 1) setPixel(pixels, width, x, y, rgb);
  }
  for (const face of visible) {
    const points = face.projected.map(screen);
    const area = edge(points[0], points[1], points[2]);
    if (Math.abs(area) < 1e-8) continue;
    const x0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y))));
    const orientation = 0.91 + 0.09 * Math.abs(dot(face.normal, normalize([0.3, 0.4, 0.86])));
    const rgb = hexRgb(face.material.color).map((value) => Math.round(value * orientation));
    const opacity = face.material.opacity ?? 1;
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
      const p = { x: x + 0.5, y: y + 0.5 };
      const w0 = edge(points[1], points[2], p) / area;
      const w1 = edge(points[2], points[0], p) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const z = w0 * points[0].depth + w1 * points[1].depth + w2 * points[2].depth;
      const index = y * width + x;
      if (z >= depth[index]) continue;
      const at = index * 3;
      const behind = [pixels[at], pixels[at + 1], pixels[at + 2]];
      setPixel(pixels, width, x, y, mixRgb(behind, rgb, opacity));
      depth[index] = z;
      owner[index] = face.objectId;
    }
  }
  const outlined = Buffer.from(pixels);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const i = y * width + x;
    if (owner[i] < 0) continue;
    if (owner[i - 1] < 0 || owner[i + 1] < 0 || owner[i - width] < 0 || owner[i + width] < 0) {
      setPixel(outlined, width, x, y, [60, 82, 89]);
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), outlined]);
}

function edge(a, b, p) { return (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x); }
function setPixel(buffer, width, x, y, rgb) { const at = (y * width + x) * 3; buffer[at] = rgb[0]; buffer[at + 1] = rgb[1]; buffer[at + 2] = rgb[2]; }
function mixRgb(a, b, t) { return a.map((value, index) => Math.max(0, Math.min(255, Math.round(value * (1 - t) + b[index] * t)))); }
function hexRgb(hex) { const clean = hex.replace('#', ''); return [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16)); }

function renderAsset(asset, { width, height }) {
  const triangles = asset.primitives.flatMap(primitiveTriangles);
  const target = asset.presentation?.targetM || { x: 0, y: 0, z: 0 };
  const span = Math.max(asset.envelopeM.x, asset.envelopeM.y, asset.envelopeM.zMax - asset.envelopeM.zMin);
  const camera = add([target.x, target.y, target.z], mul(normalize([1.15, 1.55, 0.76]), span * 1.8));
  const basis = cameraBasis(camera, [target.x, target.y, target.z]);
  const projectedPoints = triangles.flatMap((triangle) => triangle.vertices.map((point) => project(point, camera, basis)));
  const minX = Math.min(...projectedPoints.map((p) => p.x));
  const maxX = Math.max(...projectedPoints.map((p) => p.x));
  const minY = Math.min(...projectedPoints.map((p) => p.y));
  const maxY = Math.max(...projectedPoints.map((p) => p.y));
  const contentW = width * 0.77;
  const contentH = height * 0.70;
  const scale = Math.min(contentW / Math.max(maxX - minX, 1e-6), contentH / Math.max(maxY - minY, 1e-6));
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const screen = (p) => ({
    x: width * 0.57 + (p.x - centreX) * scale,
    y: height * 0.53 - (p.y - centreY) * scale,
    depth: p.depth,
  });
  const light = normalize([-0.4, 0.55, 0.9]);
  const faces = triangles.map((triangle) => {
    const points = triangle.vertices.map((point) => screen(project(point, camera, basis)));
    const normal = normalize(cross(sub(triangle.vertices[1], triangle.vertices[0]), sub(triangle.vertices[2], triangle.vertices[0])));
    const centre = triangle.vertices.reduce((sum, point) => add(sum, mul(point, 1 / 3)), [0, 0, 0]);
    const facing = dot(normal, normalize(sub(camera, centre)));
    const brightness = 0.56 + 0.44 * Math.abs(dot(normal, light));
    return { ...triangle, points, facing, depth: points.reduce((sum, point) => sum + point.depth, 0) / 3, brightness };
  }).filter((face) => face.facing > 0.001 || (face.material.opacity ?? 1) < 0.98)
    .sort((a, b) => b.depth - a.depth);

  const objectPolygons = faces.map((face) => {
    const color = shade(face.material.color, face.brightness);
    const opacity = face.material.opacity ?? 1;
    const points = face.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `<polygon points="${points}" fill="${color}" fill-opacity="${opacity}" stroke="${shade(face.material.color, 0.42)}" stroke-opacity="0.13" stroke-width="0.45"/>`;
  }).join('\n');

  const assetLabel = escapeXml(asset.label);
  const metadata = `${asset.assetId} · v${asset.version} · ${asset.geometryDigest}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6eb3df"/><stop offset="0.56" stop-color="#d5e8ef"/><stop offset="1" stop-color="#eef3f0"/></linearGradient>
    <linearGradient id="ocean" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c7894"/><stop offset="1" stop-color="#082d45"/></linearGradient>
    <linearGradient id="hud" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1b28" stop-opacity="0.94"/><stop offset="1" stop-color="#122d3b" stop-opacity="0.85"/></linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <path d="M0 378 L1280 344 L1280 800 L0 800 Z" fill="url(#ocean)"/>
  <g opacity="0.22" stroke="#b9e8ec" stroke-width="1">
    ${Array.from({ length: 11 }, (_, i) => `<path d="M0 ${420 + i * 36} Q320 ${398 + i * 38} 640 ${420 + i * 36} T1280 ${420 + i * 36}" fill="none"/>`).join('')}
  </g>
  <g>${objectPolygons}</g>
  <g transform="translate(28 28)">
    <rect width="430" height="118" rx="18" fill="url(#hud)" stroke="#65d8d0" stroke-opacity="0.32"/>
    <text x="24" y="34" fill="#74e1d8" font-family="Arial,sans-serif" font-size="13" letter-spacing="2">3D ASSET LIBRARY · MARINE</text>
    <text x="24" y="69" fill="#ffffff" font-family="Arial,sans-serif" font-size="25" font-weight="700">${assetLabel}</text>
    <text x="24" y="94" fill="#b8cad2" font-family="Arial,sans-serif" font-size="12">${escapeXml(metadata)}</text>
  </g>
  <g transform="translate(1010 28)" font-family="Arial,sans-serif" font-size="12" text-anchor="middle">
    ${['BOW','PORT','AFT','TOP'].map((label, index) => `<g transform="translate(${(index % 2) * 112} ${(Math.floor(index / 2)) * 48})"><rect width="100" height="38" rx="11" fill="#0b1b28" fill-opacity="0.82" stroke="#ffffff" stroke-opacity="0.20"/><text x="50" y="24" fill="#d9e8ec">${label}</text></g>`).join('')}
  </g>
  <g transform="translate(28 738)">
    <rect width="610" height="38" rx="12" fill="#0b1b28" fill-opacity="0.78"/>
    <circle cx="22" cy="19" r="5" fill="#52d7c8"/><text x="38" y="24" fill="#d5e5e9" font-family="Arial,sans-serif" font-size="13">ORIGINAL LOW-POLY VISUAL · MIT · NOT CAD · ENGINEERING DATA REMAINS SEPARATE</text>
  </g>
</svg>`;
}

function primitiveTriangles(primitive) {
  const material = primitive.material || { color: primitive.tint || '#6b7d82', opacity: 1 };
  const at = [primitive.atM.x, primitive.atM.y, primitive.atM.z];
  if (primitive.kind === 'mesh') {
    const vertices = primitive.vertices.map((point) => add(point, at));
    return primitive.triangles.map((face) => ({ vertices: face.map((index) => vertices[index]), material }));
  }
  if (primitive.kind === 'box') {
    const half = [primitive.sizeM.x / 2, primitive.sizeM.y / 2, primitive.sizeM.z / 2];
    const vertices = [
      [-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],
      [-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],
    ].map((sign) => add(at, sign.map((value, index) => value * half[index])));
    const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
    return faces.map((face) => ({ vertices: face.map((index) => vertices[index]), material }));
  }
  if (primitive.kind === 'cylinder') {
    const segments = 14;
    const axis = primitive.axis || 'z';
    const rings = [[], []];
    for (let side = 0; side < 2; side += 1) {
      for (let index = 0; index < segments; index += 1) {
        const angle = index / segments * Math.PI * 2;
        const circle = [Math.cos(angle) * primitive.radiusM, Math.sin(angle) * primitive.radiusM];
        const axial = (side - 0.5) * primitive.heightM;
        const local = axis === 'x' ? [axial, circle[0], circle[1]] : axis === 'y' ? [circle[0], axial, circle[1]] : [circle[0], circle[1], axial];
        rings[side].push(add(at, local));
      }
    }
    const output = [];
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      output.push({ vertices: [rings[0][index], rings[1][index], rings[1][next]], material });
      output.push({ vertices: [rings[0][index], rings[1][next], rings[0][next]], material });
      output.push({ vertices: [at, rings[0][next], rings[0][index]], material });
      output.push({ vertices: [at, rings[1][index], rings[1][next]], material });
    }
    return output;
  }
  return [];
}

function cameraBasis(camera, target) {
  const forward = normalize(sub(target, camera));
  const right = normalize(cross(forward, [0, 0, 1]));
  return { forward, right, up: normalize(cross(right, forward)) };
}

function project(point, camera, basis) {
  const relative = sub(point, camera);
  return { x: dot(relative, basis.right), y: dot(relative, basis.up), depth: dot(relative, basis.forward) };
}

function shade(hex, factor) {
  const clean = hex.replace('#', '');
  const values = [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16));
  return `#${values.map((value) => Math.max(0, Math.min(255, Math.round(value * factor))).toString(16).padStart(2, '0')).join('')}`;
}

function escapeXml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char])); }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function mul(a, n) { return [a[0] * n, a[1] * n, a[2] * n]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(a) { const length = Math.sqrt(dot(a, a)); return length > 1e-12 ? mul(a, 1 / length) : [0, 0, 0]; }
