// cell-picker.js — choosing the cell, which is the decision that matters most.
//
// The cell was a bare dropdown of twenty names. That is not a choice, it is a
// guess: nothing about "Molicel INR21700-P42A — NMC 4.2 Ah" tells you whether
// it beats the LG next to it for YOUR pack, and the answer changes with the
// series count, the space and the load. So a picker has to do two things the
// dropdown could not.
//
// FILTER, so the list is the cells worth considering — by format, chemistry,
// and a free-text match over maker and part number.
//
// COMPARE, at the configuration actually being designed. Cell A and cell B
// are not comparable in the abstract; they are comparable as 13S4P packs with
// this enclosure. Every column here is computed through the same engine the
// design tab uses, so the numbers are the ones the design will report, not a
// separate approximation that drifts.
//
// The provenance badge travels with the cell into the comparison, because a
// row that wins on paper while resting on a recalled datasheet is a different
// recommendation from one backed by a document.

import { CELLS, CHEMISTRIES, provenance } from './cells.js';
import { layoutPack, summarize } from './pack-engine.js';

const $ = (id) => document.getElementById(id);
const f1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toString());
const f0 = (v) => (v == null ? '—' : Math.round(v).toString());

// Columns of the comparison. Each says which way is better, so the winner can
// be marked without a reader having to remember whether low or high wins.
const COLS = [
  ['wh', 'Wh', 'up', 0],
  ['whPerKg', 'Wh/kg', 'up', 0],
  ['whPerL', 'Wh/L', 'up', 0],
  ['massKg', 'kg', 'down', 2],
  ['volumeL', 'L', 'down', 2],
  ['contA', 'A cont', 'up', 0],
  ['cells', 'cells', 'down', 0],
  ['costUSD', '$', 'down', 0],
];

export class CellPicker {
  // getConfig: () => { s, p, opts }  — the live design, so comparison is
  //   always at the configuration on screen rather than some default.
  // onPick:   (cellId) => void
  constructor(getConfig, onPick, extraCells = () => [], onCompareChange = null) {
    this.getConfig = getConfig;
    this.onPick = onPick;
    this.extraCells = extraCells;
    this.onCompareChange = onCompareChange;
    this.filters = { form: '', chem: '', q: '' };
    this.selected = new Set();
    this._build();
  }

  all() {
    return [...this.extraCells(), ...CELLS];
  }

  matching() {
    const { form, chem, q } = this.filters;
    const needle = q.trim().toLowerCase();
    return this.all().filter((c) => {
      if (form && c.form !== form && c.formFactor !== form) return false;
      if (chem && c.chemistry !== chem) return false;
      if (!needle) return true;
      return `${c.manufacturer} ${c.model} ${c.name} ${c.formFactor}`
        .toLowerCase().includes(needle);
    });
  }

  _build() {
    const host = $('cellPicker');
    if (!host) return;
    const forms = [...new Set(this.all().map((c) => c.formFactor || c.form))].sort();
    const chems = [...new Set(this.all().map((c) => c.chemistry))].sort();
    host.innerHTML = `
      <div class="pickfilters">
        <input type="search" id="cpQ" placeholder="maker or part number">
        <select id="cpForm"><option value="">every format</option>${
          forms.map((f) => `<option value="${f}">${f}</option>`).join('')}</select>
        <select id="cpChem"><option value="">every chemistry</option>${
          chems.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
      </div>
      <div class="pickcount" id="cpCount"></div>
      <div class="picklist" id="cpList"></div>
      <div class="pickhint">Tick two or more to compare them as the pack you are
        designing. Click a name to use it.</div>
      <div id="cpCompare"></div>`;
    $('cpQ').oninput = () => { this.filters.q = $('cpQ').value; this.render(); };
    $('cpForm').onchange = () => { this.filters.form = $('cpForm').value; this.render(); };
    $('cpChem').onchange = () => { this.filters.chem = $('cpChem').value; this.render(); };
    this.render();
  }

  render(currentId) {
    const list = $('cpList');
    if (!list) return;
    const rows = this.matching();
    $('cpCount').textContent =
      `${rows.length} of ${this.all().length} cells`;
    list.innerHTML = '';
    for (const c of rows) {
      const pv = provenance(c);
      const el = document.createElement('div');
      el.className = 'pickrow' + (c.id === currentId ? ' on' : '');
      el.innerHTML = `
        <label class="pickbox"><input type="checkbox" data-id="${c.id}"
          ${this.selected.has(c.id) ? 'checked' : ''}></label>
        <button class="pickname" data-id="${c.id}">
          <span class="pn">${c.name}</span>
          <span class="pm">${c.formFactor || c.form} · <b style="color:${
            CHEMISTRIES[c.chemistry]?.color}">${c.chemistry}</b> ·
            ${f1(c.capacityAh)} Ah · ${f0(c.massG)} g</span>
        </button>
        <span class="prov prov-${pv.tone}" title="${pv.detail}">${pv.label}</span>`;
      list.appendChild(el);
    }
    list.querySelectorAll('.pickname').forEach((b) => {
      b.onclick = () => this.onPick(b.dataset.id);
    });
    list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.onchange = () => {
        if (cb.checked) this.selected.add(cb.dataset.id);
        else this.selected.delete(cb.dataset.id);
        this.renderCompare();
        // The same ticks drive the radar AND the mission comparison —
        // tell the app so every comparing surface refreshes together.
        this.onCompareChange?.();
      };
    });
    this.renderCompare();
  }

  // Build each candidate as a real pack at the current S/P and enclosure, so
  // the comparison is of designs rather than of datasheets.
  renderCompare() {
    const host = $('cpCompare');
    if (!host) return;
    const ids = [...this.selected];
    if (ids.length < 2) {
      host.innerHTML = ids.length === 1
        ? '<div class="pickempty">Tick one more to compare.</div>' : '';
      return;
    }
    const { s, p, opts } = this.getConfig();
    const byId = new Map(this.all().map((c) => [c.id, c]));
    const rows = [];
    for (const id of ids) {
      const cell = byId.get(id);
      if (!cell) continue;
      let layout = layoutPack(cell, s, p, opts);
      if (!layout) layout = layoutPack(cell, s, p, { ...opts, nx: 0 });
      if (!layout) continue;
      const sum = summarize(cell, s, p, layout);
      rows.push({
        cell,
        wh: sum.energyWh,
        whPerKg: sum.whPerKg,
        whPerL: sum.whPerL,
        massKg: sum.massKg,
        volumeL: sum.volumeL,
        contA: sum.maxContCurrentA,
        cells: sum.cellCount,
        costUSD: cell.priceUSD != null ? cell.priceUSD * s * p : null,
      });
    }
    if (rows.length < 2) { host.innerHTML = ''; return; }

    // Best value per column, so a reader can scan rather than compute.
    const best = {};
    for (const [key, , dir] of COLS) {
      const vals = rows.map((r) => r[key]).filter((v) => v != null && isFinite(v));
      if (!vals.length) continue;
      best[key] = dir === 'up' ? Math.max(...vals) : Math.min(...vals);
    }

    host.innerHTML = `
      <div class="pickcmp">
        <div class="pickcmphead">Compared as ${s}S${p}P, same enclosure</div>
        <div class="tblwrap"><table class="cmptbl">
          <thead><tr><th>cell</th>${
            COLS.map(([, label]) => `<th class="num">${label}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => {
            const pv = provenance(r.cell);
            return `<tr>
              <td><span class="cmpname">${r.cell.name}</span>
                  <span class="prov prov-${pv.tone}">${pv.label}</span></td>
              ${COLS.map(([key, , , dec]) => {
                const v = r[key];
                const win = v != null && best[key] != null
                  && Math.abs(v - best[key]) < 1e-9;
                return `<td class="num${win ? ' win' : ''}">${
                  v == null ? '—' : (dec ? v.toFixed(dec) : Math.round(v))}</td>`;
              }).join('')}
            </tr>`;
          }).join('')}</tbody>
        </table></div>
        <div class="pickhint">Highlighted is best in that column. Mass and volume
          include the enclosure estimate; cost is order-of-magnitude. A row that
          wins while resting on a recalled figure is a weaker recommendation than
          one backed by a document — the badge travels with the number.</div>
      </div>`;
  }
}
