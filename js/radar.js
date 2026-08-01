// radar.js — the shape of a cell's compromise, on seven axes.
//
// Every cell is a set of trade-offs made in a particular direction: energy
// bought with cycle life, power bought with energy, cost bought with both. A
// table shows the numbers; it does not show the SHAPE, and the shape is what
// tells you a cell is a power cell or an energy cell before you read a digit.
//
// TWO DECISIONS THAT DECIDE WHETHER THIS CHART LIES
//
// 1. The axes are scaled against FIXED market ranges, not against the cells on
//    screen. Set-relative scaling is the obvious choice and it is wrong: with
//    two cells selected, one lands on the rim and the other at the centre on
//    every axis, which says only "these differ" — it cannot say "both are good"
//    or "both are poor". Fixed ranges make the shape mean the same thing in
//    every session, and make a small polygon genuinely small.
//
// 2. An unpublished value is NOT zero. Several cells here have no cycle-life
//    figure; plotting them at the centre would draw a cell with unknown life
//    identically to one measured at zero cycles, which is a lie the reader
//    cannot see. Unknown axes are skipped: the outline runs dashed straight
//    across the gap and the axis carries a hollow marker, so a missing claim
//    looks like a missing claim.
//
// Radar has a known weakness — area grows with the square of the radius, and
// the enclosed area depends on the order the axes happen to sit in. So this is
// never shown alone: the exact numbers sit beside it in the comparison table,
// and the polygons are outlines with a light wash rather than solid fills that
// invite area-reading.

import { CHEMISTRIES } from './cells.js';

// Validated with scripts/validate_palette.js against both surfaces
// (#FCFCFB light, #1A1A19 dark): all six checks pass in both modes. The worst
// adjacent tritan separation is ΔE 7.4, inside the 6–8 floor band, which is
// legal only with secondary encoding — hence the direct labels below, not just
// the legend.
export const SERIES = ['#0E9C82', '#2E6FD0', '#D2551F', '#9257D8'];

// Axis definitions. `to` maps a cell to a raw value in the axis's own unit;
// `range` is the fixed market span it is scored against; `better` says which
// end is good, so cost can point outward when it is LOW.
//
// The ranges are round numbers chosen to bracket the commercial field rather
// than to flatter any cell: an LTO sits near the bottom of energy and near the
// top of life and power, and the chart should show exactly that.
export const AXES = [
  { key: 'whkg',  label: 'Energy', short: 'Energy', unit: 'Wh/kg',  range: [0, 300],  better: 'high',
    to: (c) => (c.nominalV * c.capacityAh) / (c.massG / 1000) },
  { key: 'whl',   label: 'Compactness', short: 'Compact', unit: 'Wh/L',   range: [0, 800],  better: 'high',
    to: (c) => (c.nominalV * c.capacityAh) / cellVolumeL(c) },
  { key: 'power', label: 'Power', short: 'Power', unit: 'C cont', range: [0, 20],   better: 'high',
    to: (c) => c.maxContDischargeA / c.capacityAh },
  { key: 'charge', label: 'Fast charge', short: 'Fast chg', unit: 'C chg', range: [0, 6],    better: 'high',
    to: (c) => c.maxContChargeA / c.capacityAh },
  { key: 'life',  label: 'Cycle life', short: 'Life', unit: 'cycles', range: [0, 8000], better: 'high',
    to: (c) => c.cycleLife },
  { key: 'value', label: 'Value', short: 'Value', unit: '$/kWh',  range: [600, 80], better: 'low',
    to: (c) => (c.priceUSD == null ? null
                : c.priceUSD / ((c.nominalV * c.capacityAh) / 1000)) },
  // Chemistry-class, not cell-specific, and labelled as such in the caption.
  // Worth an axis anyway: it is the trade-off buyers most often forget they
  // are making when they chase Wh/kg.
  { key: 'safety', label: 'Thermal safety', short: 'Safety', unit: 'class', range: [0, 1], better: 'high',
    to: (c) => ({ low: 1, medium: 0.6, high: 0.3 }[CHEMISTRIES[c.chemistry]?.thermalRisk] ?? null) },
];

function cellVolumeL(c) {
  if (c.form === 'cylindrical') {
    const r = c.dims.d / 2;
    return (Math.PI * r * r * c.dims.h) / 1e6;
  }
  return (c.dims.w * c.dims.t * c.dims.h) / 1e6;
}

// Raw value -> 0..1 against the axis's fixed range. Clamped, because a cell
// beyond the market span should sit on the rim rather than outside the chart.
function score(axis, raw) {
  if (raw == null || !isFinite(raw)) return null;
  const [lo, hi] = axis.range;
  const t = (raw - lo) / (hi - lo);
  return Math.max(0, Math.min(1, t));
}

export function cellScores(cell) {
  return AXES.map((a) => {
    const raw = a.to(cell);
    return { axis: a, raw, score: score(a, raw) };
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function drawRadar(canvas, cells, opts = {}) {
  const g = canvas.getContext('2d');
  const cs = getComputedStyle(document.body);
  const ink = (cs.getPropertyValue('--ink') || '#111').trim();
  const muted = (cs.getPropertyValue('--muted') || '#666').trim();
  const line = (cs.getPropertyValue('--line') || '#ddd').trim();

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 520;
  const H = opts.height || 420;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.height = H + 'px';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  // Reserve room for the widest axis label on each side rather than guessing a
  // padding: in a 350 px panel a fixed inset clipped "Compactness" and
  // "Thermal safety" off both edges.
  g.font = '11px ui-sans-serif, system-ui, sans-serif';
  // Short labels on the chart, full names in the table: 'Thermal safety'
  // alone cost about 40 px of radius in a 350 px panel.
  const widest = Math.max(...AXES.map((a) => g.measureText(a.short).width));
  const cx = W / 2, cy = H / 2 + 4;
  const R = Math.max(60, Math.min(
    (W / 2) - widest - 10,          // horizontal: label must fit beside the web
    (H / 2) - 26,                   // vertical: label above and below
  ));
  const n = AXES.length;
  const ang = (i) => (i / n) * Math.PI * 2 - Math.PI / 2;
  const pt = (i, t) => [cx + Math.cos(ang(i)) * R * t, cy + Math.sin(ang(i)) * R * t];

  // Web: recessive rings and spokes, so the data reads first.
  g.strokeStyle = withAlpha(line, 0.9);
  g.lineWidth = 1;
  for (const t of [0.25, 0.5, 0.75, 1]) {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i, t);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.stroke();
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, 1);
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke();
  }

  // Axis labels, just outside the rim.
  g.font = '11px ui-sans-serif, system-ui, sans-serif';
  g.fillStyle = muted;
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, 1.10);
    g.textAlign = Math.abs(x - cx) < 6 ? 'center' : (x > cx ? 'left' : 'right');
    g.textBaseline = y < cy - 6 ? 'bottom' : (y > cy + 6 ? 'top' : 'middle');
    g.fillText(AXES[i].short, x, y);
  }

  // One outline per cell.
  const labels = [];
  cells.forEach((cell, ci) => {
    const col = SERIES[ci % SERIES.length];
    const rows = cellScores(cell);
    const known = rows.map((r, i) => (r.score == null ? null : { i, t: r.score }))
                      .filter(Boolean);
    if (!known.length) return;

    // Wash first, so outlines stay legible where they overlap.
    g.beginPath();
    known.forEach(({ i, t }, k) => {
      const [x, y] = pt(i, t);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.closePath();
    g.fillStyle = withAlpha(col, 0.10);
    g.fill();

    // Outline: solid between adjacent known axes, dashed across a gap, so a
    // skipped axis is visible as a skipped axis.
    g.lineWidth = 2;
    g.strokeStyle = col;
    for (let k = 0; k < known.length; k++) {
      const a = known[k], b = known[(k + 1) % known.length];
      const adjacent = ((a.i + 1) % n) === b.i;
      g.setLineDash(adjacent ? [] : [4, 4]);
      g.beginPath();
      const [x1, y1] = pt(a.i, a.t), [x2, y2] = pt(b.i, b.t);
      g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.setLineDash([]);

    // Vertices: filled where measured, hollow ring on the rim where unknown.
    for (const { i, t } of known) {
      const [x, y] = pt(i, t);
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
      g.lineWidth = 2; g.strokeStyle = surfaceColor(cs); g.stroke();
    }
    rows.forEach((r, i) => {
      if (r.score != null) return;
      const [x, y] = pt(i, 1);
      g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2);
      g.lineWidth = 1.5; g.strokeStyle = withAlpha(col, 0.85);
      g.setLineDash([2, 2]); g.stroke(); g.setLineDash([]);
    });

    // Direct label at the cell's strongest axis, queued so overlapping labels
    // can be nudged apart after every polygon is placed. Required, not
    // decorative: the palette's worst adjacent pair sits in the CVD floor
    // band, which is legal only with a second channel carrying identity.
    const best = known.reduce((m, k) => (k.t > m.t ? k : m), known[0]);
    const [lx, ly] = pt(best.i, Math.max(0.28, best.t - 0.12));
    labels.push({ x: lx, y: ly, text: shortName(cell), col });
  });

  // Push apart any labels that would sit on top of each other. Two 21700s
  // peak on the same axis and their names landed in the same six pixels.
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    const gap = labels[i].y - labels[i - 1].y;
    if (Math.abs(labels[i].x - labels[i - 1].x) < 70 && gap < 14) {
      labels[i].y = labels[i - 1].y + 14;
    }
  }
  g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  g.textBaseline = 'middle';
  for (const L of labels) {
    g.textAlign = L.x > cx ? 'left' : 'right';
    // A halo, so a label crossing a web line or another polygon stays readable.
    g.lineWidth = 3;
    g.strokeStyle = surfaceColor(cs);
    g.strokeText(L.text, L.x, L.y);
    g.fillStyle = L.col;
    g.fillText(L.text, L.x, L.y);
  }
}

// "Samsung SDI INR21700-50E" -> "INR21700-50E": the maker is in the legend,
// and a full name at every vertex would bury the chart.
function shortName(c) {
  return c.model || c.name.split(' ').slice(-1)[0];
}

function surfaceColor(cs) {
  return (cs.getPropertyValue('--surface') || '#fff').trim();
}

function withAlpha(col, a) {
  const c = String(col).trim();
  if (c.startsWith('#')) {
    const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
    const v = parseInt(h, 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }
  const m = c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : c;
}

// The table under the chart. Radar is for shape; exact values belong in type,
// and the reader needs both to act.
export function radarTable(cells) {
  const head = `<tr><th>axis</th>${cells.map((c, i) =>
    `<th class="num"><span class="rdrkey" style="background:${SERIES[i % SERIES.length]}"></span>${
      shortName(c)}</th>`).join('')}</tr>`;
  const rows = AXES.map((a, ai) => {
    const cellsRow = cells.map((c) => {
      const r = cellScores(c)[ai];
      if (r.raw == null || !isFinite(r.raw)) return '<td class="num unk">not published</td>';
      const dec = a.key === 'safety' ? 2 : (Math.abs(r.raw) >= 100 ? 0 : 1);
      return `<td class="num">${r.raw.toFixed(dec)}</td>`;
    }).join('');
    return `<tr><td>${a.label} <span class="rdru">${a.unit}</span></td>${cellsRow}</tr>`;
  }).join('');
  return `<table class="rdrtbl"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

export function missingNotes(cells) {
  const out = [];
  for (const c of cells) {
    const gaps = cellScores(c).filter((r) => r.score == null).map((r) => r.axis.label);
    if (gaps.length) out.push(`${shortName(c)}: ${gaps.join(', ')} not published`);
  }
  return out;
}
