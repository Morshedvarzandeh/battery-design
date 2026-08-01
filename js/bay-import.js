// bay-import.js — read the customer's pack space straight from a CAD export
// so engineers never redraw an outline that already exists. Pure parsers,
// no DOM, node-testable.
//
// Supported: DXF (ASCII R12+: LWPOLYLINE, POLYLINE/VERTEX, CIRCLE),
// SVG (polygon, polyline, rect, circle, simple absolute paths M/L/H/V/Z),
// CSV ("x,y" per line), JSON ({points:[[x,y],…]} or bare [[x,y],…]).
// Units are taken as millimetres (the norm for pack CAD); the app shows the
// parsed bounding box so a wrong-unit import is obvious at a glance.

export function parseOutline(filename, text) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let pts;
  if (ext === 'dxf') pts = parseDXF(text);
  else if (ext === 'svg') pts = parseSVG(text);
  else if (ext === 'csv' || ext === 'txt') pts = parseCSV(text);
  else if (ext === 'json') pts = parseJSONOutline(text);
  else throw new Error(`Unsupported file type ".${ext}" — use DXF, SVG, CSV or JSON.`);
  return finalize(pts, ext.toUpperCase());
}

function finalize(pts, source) {
  if (!pts || pts.length < 3) {
    throw new Error('No closed outline found — the file needs a polyline/polygon with at least 3 points.');
  }
  // Drop consecutive duplicates and a repeated closing point.
  const clean = [];
  for (const [x, y] of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(x - last[0], y - last[1]) > 1e-6) clean.push([x, y]);
  }
  if (clean.length > 1) {
    const [fx, fy] = clean[0], [lx, ly] = clean[clean.length - 1];
    if (Math.hypot(fx - lx, fy - ly) < 1e-6) clean.pop();
  }
  if (clean.length < 3) throw new Error('Outline collapsed to fewer than 3 distinct points.');
  // Normalize to a positive origin; CAD Y grows up, screen Y grows down —
  // flip so the shape appears as drawn.
  const ys = clean.map((p) => p[1]);
  const maxY = Math.max(...ys);
  let out = clean.map(([x, y]) => [x, maxY - y]);
  const xs = out.map((p) => p[0]), ys2 = out.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys2);
  out = out.map(([x, y]) => [round1(x - minX), round1(y - minY)]);
  // Simplify: drop collinear points, then decimate to <= 100 vertices.
  out = dropCollinear(out);
  while (out.length > 100) out = out.filter((_, i) => i % 2 === 0);
  const area = polyArea(out);
  if (!(area > 1)) throw new Error('Outline area is ~zero — is this a closed shape in millimetres?');
  const bb = {
    x: round1(Math.max(...out.map((p) => p[0]))),
    y: round1(Math.max(...out.map((p) => p[1]))),
  };
  return { points: out, source, bbox: bb, areaMm2: round1(area), vertexCount: out.length };
}

const round1 = (v) => Math.round(v * 10) / 10;

function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function dropCollinear(pts) {
  if (pts.length <= 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

// ---------------------------------------------------------------------------
// DXF — ASCII group-code pairs. We take the closed poly entity with the
// largest area (a drawing usually contains dimensions, borders, etc.).
// ---------------------------------------------------------------------------
function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const candidates = [];
  let i = 0;
  const readPair = () => {
    if (i + 1 >= lines.length) return null;
    const code = lines[i].trim(), value = lines[i + 1].trim();
    i += 2;
    return [code, value];
  };
  let cur = null, inVertexChain = false;
  while (i + 1 < lines.length) {
    const pair = readPair();
    if (!pair) break;
    const [code, value] = pair;
    if (code === '0') {
      if (value === 'LWPOLYLINE') { cur = []; candidates.push(cur); inVertexChain = false; }
      else if (value === 'POLYLINE') { cur = []; candidates.push(cur); inVertexChain = true; }
      else if (value === 'VERTEX' && inVertexChain) { /* points follow via 10/20 */ }
      else if (value === 'SEQEND') { inVertexChain = false; cur = null; }
      else if (value === 'CIRCLE') { cur = { circle: {} }; candidates.push(cur); inVertexChain = false; }
      else if (!inVertexChain) cur = null;
    } else if (cur && !cur.circle) {
      if (code === '10') cur.push([parseFloat(value), 0]);
      else if (code === '20' && cur.length) cur[cur.length - 1][1] = parseFloat(value);
    } else if (cur && cur.circle) {
      if (code === '10') cur.circle.cx = parseFloat(value);
      else if (code === '20') cur.circle.cy = parseFloat(value);
      else if (code === '40') cur.circle.r = parseFloat(value);
    }
  }
  const polys = candidates.map((c) => {
    if (c.circle) {
      const { cx = 0, cy = 0, r } = c.circle;
      if (!(r > 0)) return null;
      return Array.from({ length: 36 }, (_, k) => {
        const a = (k / 36) * 2 * Math.PI;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      });
    }
    return c.filter((p) => isFinite(p[0]) && isFinite(p[1]));
  }).filter((p) => p && p.length >= 3);
  if (!polys.length) throw new Error('No LWPOLYLINE/POLYLINE/CIRCLE outline found in the DXF.');
  polys.sort((a, b) => polyArea(b) - polyArea(a));
  return polys[0];
}

// ---------------------------------------------------------------------------
// SVG — regex-based (no DOM) so the same code runs in tests.
// ---------------------------------------------------------------------------
function parseSVG(text) {
  const polys = [];
  const num = '[-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?';
  for (const m of text.matchAll(/<(?:polygon|polyline)[^>]*\bpoints\s*=\s*"([^"]+)"/gi)) {
    const nums = (m[1].match(new RegExp(num, 'g')) || []).map(Number);
    const pts = [];
    for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
    if (pts.length >= 3) polys.push(pts);
  }
  for (const m of text.matchAll(/<rect[^>]*>/gi)) {
    const attr = (name) => {
      const a = m[0].match(new RegExp(`\\b${name}\\s*=\\s*"(${num})"`));
      return a ? parseFloat(a[1]) : null;
    };
    const x = attr('x') ?? 0, y = attr('y') ?? 0, w = attr('width'), h = attr('height');
    if (w > 0 && h > 0) polys.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  }
  for (const m of text.matchAll(/<circle[^>]*>/gi)) {
    const attr = (name) => {
      const a = m[0].match(new RegExp(`\\b${name}\\s*=\\s*"(${num})"`));
      return a ? parseFloat(a[1]) : null;
    };
    const cx = attr('cx') ?? 0, cy = attr('cy') ?? 0, r = attr('r');
    if (r > 0) {
      polys.push(Array.from({ length: 36 }, (_, k) => {
        const a = (k / 36) * 2 * Math.PI;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      }));
    }
  }
  for (const m of text.matchAll(/<path[^>]*\bd\s*=\s*"([^"]+)"/gi)) {
    const pts = parseSVGPath(m[1]);
    if (pts && pts.length >= 3) polys.push(pts);
  }
  if (!polys.length) throw new Error('No polygon/polyline/rect/circle/path outline found in the SVG.');
  polys.sort((a, b) => polyArea(b) - polyArea(a));
  return polys[0];
}

// Absolute M/L/H/V (+Z) only — the vocabulary of a CAD outline export.
// Curves or relative commands → null (caller falls through to other shapes).
function parseSVGPath(d) {
  const tokens = d.match(/[MLHVZmlhvz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g);
  if (!tokens) return null;
  const pts = [];
  let cmd = null, x = 0, y = 0, k = 0;
  const next = () => parseFloat(tokens[k++]);
  while (k < tokens.length) {
    const t = tokens[k];
    if (/[A-Za-z]/.test(t)) {
      cmd = t; k++;
      if (cmd === 'Z' || cmd === 'z') break;
      if (!'MLHV'.includes(cmd)) return null; // curves/relative not supported
      continue;
    }
    if (cmd === 'M' || cmd === 'L') { x = next(); y = next(); pts.push([x, y]); }
    else if (cmd === 'H') { x = next(); pts.push([x, y]); }
    else if (cmd === 'V') { y = next(); pts.push([x, y]); }
    else return null;
  }
  return pts.length >= 3 ? pts : null;
}

// ---------------------------------------------------------------------------
function parseCSV(text) {
  const pts = [];
  for (const line of text.split(/\r?\n/)) {
    const nums = (line.match(/[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || []).map(Number);
    if (nums.length >= 2) pts.push([nums[0], nums[1]]);
  }
  return pts;
}

function parseJSONOutline(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.points;
  if (!Array.isArray(arr)) throw new Error('JSON must be [[x,y],…] or {points:[[x,y],…]}.');
  return arr.map((p) => Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.x), Number(p.y)]);
}
