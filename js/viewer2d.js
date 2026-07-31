// viewer2d.js — lightweight 2D engineering view of a pack layout.
//
// This is the DEFAULT working view: a dimensioned top view (X·Y) and side
// elevation (X·Z) drawn on a plain 2D canvas. It redraws once per design
// change — no WebGL, no animation loop — so iteration stays cheap. The 3D
// viewer is only instantiated when the user asks for a final render.

const GROUP_SATURATION = 62;

export class PackViewer2D {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block';
    container.appendChild(this.canvas);
    this.layout = null;
    this.colorMode = 'series';
    this.chemColor = '#2a78d6';
    this.compViz = null;
    this.showWiring = true;
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(container);
  }

  setPack(layout, opts = {}) {
    this.layout = layout;
    if (opts.chemColor) this.chemColor = opts.chemColor;
    if (opts.compViz !== undefined) this.compViz = opts.compViz;
    this.draw();
  }

  setColorMode(mode, chemColor) {
    this.colorMode = mode;
    if (chemColor) this.chemColor = chemColor;
    this.draw();
  }

  setToggles({ wiring }) {
    if (wiring != null) this.showWiring = wiring;
    this.draw();
  }

  setTheme() { this.draw(); }

  _css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  groupColor(sIndex, pIndex) {
    if (this.colorMode === 'chemistry') {
      return this.chemColor;
    }
    const hue = Math.round(((sIndex * 0.618034) % 1) * 360);
    return `hsl(${hue} ${GROUP_SATURATION}% 52%)`;
  }

  draw() {
    const L = this.layout;
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = this.container.clientWidth || 1;
    const H = this.container.clientHeight || 1;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!L) return;

    const ink = this._css('--ink', '#101615');
    const muted = this._css('--muted', '#5f6d69');
    const line = this._css('--line', '#dbe2e0');
    const accent = this._css('--accent', '#0b6e5f');
    const cool = '#3f7fd0';
    const mono = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

    // ── Layout of the two views on the canvas ────────────────────────────
    const margin = 56;
    const gapViews = 46;
    const sideShare = Math.min(0.30, (L.outer.z / (L.outer.z + L.outer.y)) * 0.9 + 0.08);
    const availW = W - margin * 2 - gapViews;
    const topW = availW * (1 - sideShare);
    const sideW = availW * sideShare;
    const availH = H - margin * 2;
    // One scale for everything so the two views read together.
    const scale = Math.min(topW / L.outer.x, availH / L.outer.y,
      sideW / L.outer.z, availH / L.outer.y) * 0.98;
    if (!isFinite(scale) || scale <= 0) return; // container too small to draw
    const s = (mm) => mm * scale;

    const topX = margin + (topW - s(L.outer.x)) / 2;
    const topY = margin + (availH - s(L.outer.y)) / 2;
    const sideX = margin + topW + gapViews;
    const sideY = topY;

    // ── Helpers ──────────────────────────────────────────────────────────
    const dim = (x1, y1, x2, y2, label, side) => {
      g.strokeStyle = muted; g.fillStyle = muted; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      const ah = 4;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      for (const [px, py, dir] of [[x1, y1, 0], [x2, y2, Math.PI]]) {
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + ah * Math.cos(ang + dir + 0.4), py + ah * Math.sin(ang + dir + 0.4));
        g.moveTo(px, py);
        g.lineTo(px + ah * Math.cos(ang + dir - 0.4), py + ah * Math.sin(ang + dir - 0.4));
        g.stroke();
      }
      g.font = mono;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      g.textAlign = 'center';
      if (side === 'below') { g.textBaseline = 'top'; g.fillText(label, mx, my + 4); }
      else if (side === 'left') {
        g.save(); g.translate(mx - 4, my); g.rotate(-Math.PI / 2);
        g.textBaseline = 'bottom'; g.fillText(label, 0, 0); g.restore();
      } else { g.textBaseline = 'bottom'; g.fillText(label, mx, my - 4); }
    };
    const label = (x, y, text, align = 'left') => {
      g.font = mono; g.fillStyle = muted; g.textAlign = align; g.textBaseline = 'alphabetic';
      g.fillText(text, x, y);
    };
    const mmTxt = (v) => `${Math.round(v * 10) / 10} mm`;

    // ── TOP VIEW (X·Y) ───────────────────────────────────────────────────
    const ox = topX, oy = topY;
    label(ox, oy - 10, `TOP VIEW · X–Y · ${L.nx}×${L.ny}${L.nz > 1 ? `×${L.nz}` : ''} ${L.arrangement}`);

    // Enclosure outline (outer), inner cavity dashed.
    g.strokeStyle = ink; g.lineWidth = 1.5;
    g.strokeRect(ox, oy, s(L.outer.x), s(L.outer.y));
    g.strokeStyle = line; g.lineWidth = 1; g.setLineDash([4, 3]);
    const wx = s(L.wallMm);
    g.strokeRect(ox + wx, oy + wx, s(L.inner.x), s(L.inner.y));
    g.setLineDash([]);

    // Cells of layer 0, engine coords → canvas: x right, y DOWN (engineering
    // top view; +Y away from viewer). Positions are centered at 0.
    const cx0 = ox + wx + s(L.inner.x / 2);
    const cy0 = oy + wx + s(L.inner.y / 2);
    const fp = L.cellFootprint;
    const layer0 = L.positions.filter((p) => p.layer === 0);
    for (const p of layer0) {
      g.fillStyle = this.groupColor(p.sIndex, p.pIndex);
      g.strokeStyle = ink; g.lineWidth = 0.5;
      const px = cx0 + s(p.x), py = cy0 + s(p.y);
      if (fp.round && fp.axis === 'z') {
        g.beginPath();
        g.arc(px, py, Math.max(0.5, s(L.cell.dims.d / 2) - 0.5), 0, Math.PI * 2);
        g.fill(); g.stroke();
        // polarity dot
        g.fillStyle = 'rgba(255,255,255,.55)';
        g.beginPath(); g.arc(px, py, Math.max(1.5, s(L.cell.dims.d * 0.18)), 0, Math.PI * 2); g.fill();
      } else {
        g.fillRect(px - s(fp.fx / 2) + 0.5, py - s(fp.fy / 2) + 0.5, s(fp.fx) - 1, s(fp.fy) - 1);
        g.strokeRect(px - s(fp.fx / 2) + 0.5, py - s(fp.fy / 2) + 0.5, s(fp.fx) - 1, s(fp.fy) - 1);
      }
    }

    // Series path (electrical order) over layer 0.
    if (this.showWiring && layer0.length > 1) {
      g.strokeStyle = 'rgba(210,85,31,.65)'; g.lineWidth = 1.2;
      g.beginPath();
      layer0.forEach((p, i) => {
        const px = cx0 + s(p.x), py = cy0 + s(p.y);
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.stroke();
    }

    // Cooling visualization in plan.
    const viz = this.compViz?.cooling;
    if (viz === 'side') {
      g.fillStyle = 'rgba(63,127,208,.5)';
      g.fillRect(ox - 5, oy, 4, s(L.outer.y));
      g.fillRect(ox + s(L.outer.x) + 1, oy, 4, s(L.outer.y));
      label(ox - 8, oy - 4, 'cold plates', 'left');
    } else if (viz === 'between') {
      const rows = [...new Set(layer0.map((p) => Math.round(p.y * 10) / 10))].sort((a, b) => a - b);
      g.strokeStyle = 'rgba(63,127,208,.8)'; g.lineWidth = Math.max(1.5, s(1.5));
      for (let i = 1; i < rows.length; i++) {
        const py = cy0 + s((rows[i - 1] + rows[i]) / 2);
        g.beginPath(); g.moveTo(ox + wx + 2, py); g.lineTo(ox + wx + s(L.inner.x) - 2, py); g.stroke();
      }
    }
    if (this.compViz?.vent) {
      g.strokeStyle = muted; g.lineWidth = 1;
      g.beginPath();
      g.arc(ox + s(L.outer.x) - 10, oy + 10, 4.5, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      g.arc(ox + s(L.outer.x) - 10, oy + 10, 1.5, 0, Math.PI * 2); g.stroke();
    }

    // Dimensions: X below, Y left.
    dim(ox, oy + s(L.outer.y) + 16, ox + s(L.outer.x), oy + s(L.outer.y) + 16, mmTxt(L.outer.x), 'below');
    dim(ox - 16, oy, ox - 16, oy + s(L.outer.y), mmTxt(L.outer.y), 'left');
    // Cell pitch callout (first two cells of a row).
    if (layer0.length > 1 && layer0[1].y === layer0[0].y) {
      const pitch = Math.abs(layer0[1].x - layer0[0].x);
      label(ox + 2, oy + s(L.outer.y) + 40, `pitch ${mmTxt(pitch)} · gap ${mmTxt(L.spacingMm)}`);
    } else {
      label(ox + 2, oy + s(L.outer.y) + 40, `gap ${mmTxt(L.spacingMm)} · wall ${mmTxt(L.wallMm)}`);
    }

    // ── SIDE VIEW (X·Z elevation, drawn as Z·Y panel) ────────────────────
    label(sideX, sideY - 10, 'SIDE · Z');
    g.strokeStyle = ink; g.lineWidth = 1.5;
    g.strokeRect(sideX, sideY, s(L.outer.z), s(L.outer.y));
    // Cells region per layer: stack along Z from the bottom wall, above any
    // reserved under-cell space (bottom cold plate).
    const zBase = sideX + s(L.wallMm + (L.underMm || 0));
    const pitchZ = fp.fz + L.layerGapMm;
    for (let iz = 0; iz < L.nz; iz++) {
      g.fillStyle = this.colorMode === 'chemistry' ? this.chemColor : accent;
      g.globalAlpha = 0.55;
      g.fillRect(zBase + s(iz * pitchZ), sideY + wx, s(fp.fz), s(L.inner.y));
      g.globalAlpha = 1;
    }
    // Headroom hatch at the top of Z (right side of panel).
    const hrX = sideX + s(L.outer.z - L.headroomMm - L.wallMm);
    g.strokeStyle = muted; g.lineWidth = 0.6;
    for (let hx = hrX; hx < sideX + s(L.outer.z) - 2; hx += 5) {
      g.beginPath(); g.moveTo(hx, sideY + 1); g.lineTo(hx + 4, sideY + s(L.outer.y) - 1); g.stroke();
    }
    // Bottom cold plate in elevation.
    if (viz === 'bottom') {
      g.fillStyle = 'rgba(63,127,208,.7)';
      g.fillRect(sideX - 4, sideY, 4, s(L.outer.y));
      label(sideX - 2, sideY + s(L.outer.y) + 14, 'plate', 'center');
    }
    dim(sideX, sideY + s(L.outer.y) + 16, sideX + s(L.outer.z), sideY + s(L.outer.y) + 16,
      mmTxt(L.outer.z), 'below');
    label(sideX + s(L.outer.z) / 2, sideY + s(L.outer.y) + 40,
      `${L.nz} layer${L.nz > 1 ? 's' : ''} + ${mmTxt(L.headroomMm)} headroom`, 'center');
  }

  dispose() {
    this._ro.disconnect();
    this.canvas.remove();
  }
}
