// app.js — UI state and wiring for the pack designer. All the math lives in
// pack-engine.js / optimizer.js; all the data in cells.js / presets.js /
// standards.js; all the rendering in viewer3d.js.

import { CELLS, CHEMISTRIES, cellById } from './cells.js';
import { PRESETS } from './presets.js';
import { layoutPack, summarize, ARRANGEMENTS_BY_FORM, defaultArrangement } from './pack-engine.js';
import { optimizeSpace, suggestDesigns } from './optimizer.js';
import { DISCLAIMER, STANDARDS_INFO, runChecks } from './standards.js';
import { COMPONENT_CATEGORIES, DEFAULTS_BY_FORM, componentsFor, componentById } from './components.js';
import { ANALYSIS_DISCLAIMER, analyze } from './engineering.js';
import { PackViewer } from './viewer3d.js';
import { PackViewer2D } from './viewer2d.js';

const $ = (id) => document.getElementById(id);
const MAX_CELLS = 10000;

const ORIENTATIONS_BY_FORM = {
  cylindrical: [['upright', 'Upright'], ['lying', 'Lying']],
  prismatic: [['upright', 'Upright']],
  pouch: [['upright', 'Upright'], ['flat', 'Flat']],
};

const state = {
  cellId: 'samsung-inr21700-50e',
  s: 13, p: 4,
  arrangement: 'hex', orientation: 'upright',
  spacingMm: 1, wallMm: 2, headroomMm: 8, layerGapMm: 2,
  nx: 0, nz: 1,
  presetId: null,
  colorMode: 'series',
  sel: { ...DEFAULTS_BY_FORM.cylindrical }, // component ids per category
};

// 2D-first: the dimensioned 2D layout is the working view; the WebGL viewer
// is only instantiated when the user asks for a 3D render, and its loop is
// paused whenever 2D is showing.
let viewer2d = null;
let viewer = null;        // PackViewer (3D), lazy
let viewMode = '2d';
let pack3dDirty = true;
let lastFindings = [];
let lastSummary = null;
let lastLayout = null;
let lastAnalysis = null;
let lastForm = 'cylindrical';

const selComponents = () => Object.fromEntries(
  COMPONENT_CATEGORIES.map(({ key }) => [key, componentById(key, state.sel[key]) || null]));
const compViz = () => {
  const s = selComponents();
  return {
    cooling: s.cooling?.viz ?? null,
    vent: s.vent?.level === 'pack',
    housing: s.housing?.material ?? null,
  };
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const f1 = (v) => v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString();
const f0 = (v) => v == null ? '—' : Math.round(v).toLocaleString();
const fWh = (v) => v == null ? '—' : (v >= 5000 ? `${f1(v / 1000)} kWh` : `${f0(v)} Wh`);
const fDim = (d) => d ? `${f0(d.x)} × ${f0(d.y)} × ${f0(d.z)} mm` : '—';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function init() {
  initTheme();
  initCellSelect();
  initPresets();
  restoreHash();
  initComponents();
  bindControls();
  viewer2d = new PackViewer2D($('viewport2d'));
  syncInputs();
  recompute();
}

function isDark() {
  return document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
}

function setViewMode(mode) {
  viewMode = mode;
  $('viewport').style.display = mode === '3d' ? 'block' : 'none';
  $('viewport2d').style.display = mode === '2d' ? 'block' : 'none';
  $('glassExplode').style.display = mode === '3d' ? 'block' : 'none';
  $('segView').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === mode));
  if (mode === '3d') {
    if (!viewer) {
      viewer = new PackViewer($('viewport'));
      viewer.setTheme(isDark());
    }
    viewer.resume();
    viewer.resize();
    if (pack3dDirty && lastLayout) {
      viewer.setPack(lastLayout, CHEMISTRIES[cell().chemistry]?.color, compViz());
      viewer.setColorMode(state.colorMode, CHEMISTRIES[cell().chemistry]?.color);
      pack3dDirty = false;
    }
  } else {
    viewer?.pause();
    viewer2d.draw();
  }
}

function initCellSelect() {
  const sel = $('selCell');
  const byForm = {};
  for (const c of CELLS) (byForm[c.form] ||= []).push(c);
  for (const [form, cells] of Object.entries(byForm)) {
    const og = document.createElement('optgroup');
    og.label = form[0].toUpperCase() + form.slice(1);
    for (const c of cells) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.name} — ${c.chemistry} ${f1(c.capacityAh)} Ah`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  if (!cellById(state.cellId)) state.cellId = CELLS[0].id;
  sel.value = state.cellId;
}

function initPresets() {
  const grid = $('presetGrid');
  for (const pr of PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.id = pr.id;
    b.innerHTML = `<span class="ico">${pr.icon}</span>${pr.name}`;
    b.title = pr.desc;
    b.onclick = () => applyPreset(pr);
    grid.appendChild(b);
  }
}

function applyPreset(pr) {
  state.presetId = pr.id;
  document.querySelectorAll('.preset').forEach((el) =>
    el.classList.toggle('active', el.dataset.id === pr.id));
  $('rqVlo').value = pr.systemV[0];
  $('rqVhi').value = pr.systemV[1];
  $('rqWh').value = pr.typicalEnergyWh;
  $('rqPc').value = pr.contPowerW;
  $('rqPp').value = pr.peakPowerW;
  $('rqC').value = pr.chargeRateC;
  $('rqKg').value = pr.maxMassKg ?? '';
  $('rqDx').value = pr.maxDimsMm?.x ?? '';
  $('rqDy').value = pr.maxDimsMm?.y ?? '';
  $('rqDz').value = pr.maxDimsMm?.z ?? '';
  $('rqTlo').value = pr.envTempC[0];
  $('rqThi').value = pr.envTempC[1];
  $('rqCy').value = pr.cyclesPerYear;
  $('rqYr').value = pr.targetYears;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function bindControls() {
  document.querySelectorAll('#tabs .tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) =>
      p.classList.toggle('active', p.id === `pane-${t.dataset.tab}`));
  });

  $('selCell').onchange = () => { state.cellId = $('selCell').value; onCellChange(); recompute(); };
  $('inS').onchange = $('inP').onchange = () => { readNumbers(); recompute(); };
  document.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => {
    const [k, d] = b.dataset.step.split(':');
    const input = k === 's' ? $('inS') : $('inP');
    const max = k === 's' ? 300 : 200;
    input.value = clamp((parseInt(input.value, 10) || 1) + parseInt(d, 10), 1, max);
    readNumbers(); recompute();
  });
  $('inNx').onchange = $('inNz').onchange = () => { readNumbers(); recompute(); };

  $('segArr').querySelectorAll('button').forEach((b) => b.onclick = () => {
    if (b.disabled) return;
    state.arrangement = b.dataset.arr; syncInputs(); recompute();
  });
  $('segView').querySelectorAll('button').forEach((b) => b.onclick = () => setViewMode(b.dataset.view));
  $('segColor').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.colorMode = b.dataset.col;
    $('segColor').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    const chemCol = CHEMISTRIES[cell().chemistry]?.color;
    viewer2d.setColorMode(state.colorMode, chemCol);
    viewer?.setColorMode(state.colorMode, chemCol);
  });

  const slider = (id, key, label, unit) => {
    $(id).oninput = () => {
      state[key] = parseFloat($(id).value);
      $(label).textContent = `${state[key]} ${unit}`;
      recompute();
    };
  };
  slider('inSpacing', 'spacingMm', 'vSpacing', 'mm');
  slider('inWall', 'wallMm', 'vWall', 'mm');
  slider('inHead', 'headroomMm', 'vHead', 'mm');

  $('inExplode').oninput = () => viewer?.setExploded(parseFloat($('inExplode').value));
  $('ckEnc').onchange = () => viewer?.setToggles({ enclosure: $('ckEnc').checked });
  $('ckWire').onchange = () => {
    viewer2d.setToggles({ wiring: $('ckWire').checked });
    viewer?.setToggles({ wiring: $('ckWire').checked });
  };

  $('btnSuggest').onclick = runSuggest;
  $('btnFit').onclick = runFit;
  $('btnExport').onclick = exportJSON;
  $('btnTheme').onclick = toggleTheme;
}

function readNumbers() {
  state.s = clamp(parseInt($('inS').value, 10) || 1, 1, 300);
  state.p = clamp(parseInt($('inP').value, 10) || 1, 1, 200);
  state.nx = clamp(parseInt($('inNx').value, 10) || 0, 0, 200);
  state.nz = clamp(parseInt($('inNz').value, 10) || 1, 1, 6);
  // Reflect clamping back so the fields never display a value the state
  // silently rejected.
  $('inS').value = state.s; $('inP').value = state.p;
  $('inNx').value = state.nx; $('inNz').value = state.nz;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cell = () => cellById(state.cellId) || CELLS[0];

function onCellChange() {
  const c = cell();
  if (!ARRANGEMENTS_BY_FORM[c.form].includes(state.arrangement)) {
    state.arrangement = defaultArrangement(c);
  }
  const oris = ORIENTATIONS_BY_FORM[c.form].map(([k]) => k);
  if (!oris.includes(state.orientation)) state.orientation = 'upright';
  // A new cell shape gets that shape's default component set.
  if (c.form !== lastForm) {
    state.sel = { ...DEFAULTS_BY_FORM[c.form] };
    lastForm = c.form;
    initComponents();
  }
  syncInputs();
}

// ---------------------------------------------------------------------------
// Components tab
// ---------------------------------------------------------------------------
function initComponents() {
  const box = $('compPickers');
  box.innerHTML = '';
  const form = cell().form;
  for (const { key, name } of COMPONENT_CATEGORIES) {
    const options = componentsFor(key, form);
    if (state.sel[key] && !options.some((o) => o.id === state.sel[key])) {
      state.sel[key] = DEFAULTS_BY_FORM[form][key] ?? options[0]?.id ?? null;
    }
    const sec = document.createElement('div');
    sec.className = 'sec';
    sec.innerHTML = `<h3>${esc(name)}</h3><select data-cat="${key}"></select><div class="hint"></div>`;
    const sel = sec.querySelector('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      sel.appendChild(opt);
    }
    if (state.sel[key]) sel.value = state.sel[key];
    const hint = sec.querySelector('.hint');
    const showHint = () => {
      const o = componentById(key, sel.value);
      hint.innerHTML = o
        ? `${esc(o.notes)}<br><span style="opacity:.75">e.g. ${esc((o.suppliers || []).join(', '))}</span>`
        : '';
    };
    showHint();
    sel.onchange = () => {
      state.sel[key] = sel.value;
      showHint();
      const o = componentById(key, sel.value);
      // A spacer that fixes the cell gap drives the spacing slider.
      if (key === 'spacer' && o && o.providesGapMm != null) {
        state.spacingMm = o.providesGapMm;
        syncInputs();
      }
      recompute();
    };
    box.appendChild(sec);
  }
}

function syncInputs() {
  const c = cell();
  $('inS').value = state.s; $('inP').value = state.p;
  $('inNx').value = state.nx; $('inNz').value = state.nz;
  $('inSpacing').value = state.spacingMm; $('vSpacing').textContent = `${state.spacingMm} mm`;
  $('inWall').value = state.wallMm; $('vWall').textContent = `${state.wallMm} mm`;
  $('inHead').value = state.headroomMm; $('vHead').textContent = `${state.headroomMm} mm`;
  $('selCell').value = c.id;

  // Hex nesting is only real for upright cylinders.
  if (state.arrangement === 'hex' && state.orientation === 'lying') state.arrangement = 'grid';
  const allowed = ARRANGEMENTS_BY_FORM[c.form]
    .filter((a) => !(a === 'hex' && state.orientation === 'lying'));
  $('segArr').querySelectorAll('button').forEach((b) => {
    b.disabled = !allowed.includes(b.dataset.arr);
    b.classList.toggle('active', b.dataset.arr === state.arrangement);
  });
  const seg = $('segOri');
  seg.innerHTML = '';
  for (const [k, label] of ORIENTATIONS_BY_FORM[c.form]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('active', k === state.orientation);
    b.onclick = () => { state.orientation = k; syncInputs(); recompute(); };
    seg.appendChild(b);
  }
  const ch = CHEMISTRIES[c.chemistry];
  $('cellHint').innerHTML =
    `${c.form} ${c.formFactor} · <b style="color:${ch?.color}">${c.chemistry}</b> · ` +
    `${f1(c.nominalV)} V · ${f1(c.capacityAh)} Ah · ${f0(c.massG)} g · ` +
    `${c.dataQuality === 'datasheet' ? 'datasheet' : 'estimated'} data`;
}

// ---------------------------------------------------------------------------
// Recompute + render
// ---------------------------------------------------------------------------
function recompute() {
  const c = cell();
  const N = state.s * state.p;
  if (N > MAX_CELLS) {
    // Invalidate every derived surface so nothing keeps describing the
    // previous configuration (stats, 3D, findings, export).
    $('cfgHint').textContent = `${N.toLocaleString()} cells — above the ${MAX_CELLS.toLocaleString()}-cell render cap; reduce S or P.`;
    lastLayout = null; lastSummary = null; lastFindings = []; lastAnalysis = null;
    const emptyMsg = '<div class="empty">Over the cell cap — no pack computed.</div>';
    $('hdrStats').innerHTML = '';
    $('statsBody').innerHTML = emptyMsg;
    $('stageStats').innerHTML = emptyMsg;
    $('findings').innerHTML = emptyMsg;
    for (const id of ['anMech', 'anTherm', 'anElec', 'anSafe']) $(id).innerHTML = emptyMsg;
    const badge = $('stdBadge'); badge.textContent = '—'; badge.className = 'chip';
    $('btnExport').disabled = true;
    viewer2d.setPack(null);
    viewer?.setPack(null);
    saveHash();
    return;
  }
  $('btnExport').disabled = false;
  const opts = {
    arrangement: state.arrangement, orientation: state.orientation,
    spacingMm: state.spacingMm, wallMm: state.wallMm,
    headroomMm: state.headroomMm, layerGapMm: state.layerGapMm,
    nx: state.nx, nz: state.nz,
  };
  let layout = layoutPack(c, state.s, state.p, opts);
  if (!layout) layout = layoutPack(c, state.s, state.p, { ...opts, nx: 0 });
  lastLayout = layout;
  lastSummary = summarize(c, state.s, state.p, layout);
  $('cfgHint').textContent =
    `${N} cells · ${layout.nx}×${layout.ny}${layout.nz > 1 ? `×${layout.nz}` : ''} ${layout.arrangement}`;

  const chemCol = CHEMISTRIES[c.chemistry]?.color;
  viewer2d.setColorMode(state.colorMode, chemCol);
  viewer2d.setPack(layout, { chemColor: chemCol, compViz: compViz() });
  if (viewer && viewMode === '3d') {
    viewer.setPack(layout, chemCol, compViz());
    viewer.setColorMode(state.colorMode, chemCol);
    pack3dDirty = false;
  } else {
    pack3dDirty = true; // pushed lazily when the user switches to 3D
  }
  runAnalysis();
  renderStats();
  saveHash();
}

function renderStats() {
  const S = lastSummary, c = cell();
  const rows = [
    ['sec', 'Configuration'],
    ['Cell', c.name],
    ['Topology', `${S.s}S${S.p}P · ${S.cellCount} cells`],
    ['sec', 'Electrical'],
    ['Nominal voltage', `${f1(S.nominalV)} V`],
    ['Voltage range', `${f1(S.vMin)} – ${f1(S.vMax)} V`],
    ['Capacity', `${f1(S.capacityAh)} Ah`],
    ['Energy', fWh(S.energyWh)],
    ['Max cont. discharge', `${f0(S.maxContCurrentA)} A`],
    ['Max cont. power', S.maxContPowerW >= 10000 ? `${f1(S.maxContPowerW / 1000)} kW` : `${f0(S.maxContPowerW)} W`],
    ['Max pulse current', S.maxPulseCurrentA != null ? `${f0(S.maxPulseCurrentA)} A` : '—'],
    ['Max charge current', `${f0(S.maxChargeCurrentA)} A`],
    ['DCIR (cells only)', S.dcirMOhm != null ? `${f1(S.dcirMOhm)} mΩ` : '—'],
    ['Sag @ max cont.', S.sagVAtMaxCont != null ? `${f1(S.sagVAtMaxCont)} V` : '—'],
    ['sec', 'Physical'],
    ['Outer dimensions', fDim(S.dims)],
    ['Volume', `${f1(S.volumeL)} L`],
    ['Mass (est.)', `${f1(S.massKg)} kg`],
    ['Cells mass', `${f1(S.massCellsKg)} kg`],
    ['Energy density', `${f0(S.whPerKg)} Wh/kg · ${f0(S.whPerL)} Wh/L`],
    ['Packing efficiency', `${f0(S.packingEfficiency * 100)}%`],
  ];
  const T = lastAnalysis?.totals;
  if (T) {
    rows.push(['sec', 'Components & thermal']);
    if (T.packMassWithComponentsKg != null) rows.push(['Mass w/ components', `${f1(T.packMassWithComponentsKg)} kg`]);
    if (T.componentMassKg?.total != null) rows.push(['Component mass', `${f1(T.componentMassKg.total)} kg`]);
    if (T.heatContW != null) rows.push(['Heat @ cont. load', `${f1(T.heatContW)} W`]);
    if (T.tempRiseContC != null) rows.push(['Est. temp rise', `${f1(T.tempRiseContC)} °C`]);
    if (T.creepageReqMm != null) rows.push(['Creepage req. (~)', `${f1(T.creepageReqMm)} mm`]);
  }
  const html = rows.map(([k, v]) =>
    k === 'sec'
      ? `<h3 style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 0 4px">${v}</h3>`
      : `<div class="stat"><span>${k}</span><b>${v}</b></div>`
  ).join('');
  $('statsBody').innerHTML = html;
  $('stageStats').innerHTML = html;
  $('hdrStats').innerHTML =
    `<span>${S.s}S${S.p}P</span><span><b>${f1(S.nominalV)}</b> V</span>` +
    `<span><b>${f1(S.capacityAh)}</b> Ah</span><span><b>${fWh(S.energyWh)}</b></span>` +
    `<span><b>${f1(S.massKg)}</b> kg</span>`;
}

// ---------------------------------------------------------------------------
// Standards
// ---------------------------------------------------------------------------
function currentUsage() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  return {
    application: state.presetId || 'custom',
    contPowerW: num('rqPc'), peakPowerW: num('rqPp'),
    chargeRateC: num('rqC'),
    envTempC: (num('rqTlo') != null && num('rqThi') != null) ? [num('rqTlo'), num('rqThi')] : null,
  };
}

function runAnalysis() {
  const S = lastSummary, c = cell();
  const pack = {
    nominalV: S.nominalV, vMax: S.vMax, vMin: S.vMin,
    capacityAh: S.capacityAh, energyWh: S.energyWh, massKg: S.massKg,
    massCellsKg: S.massCellsKg,
    cellCount: S.cellCount, maxContCurrentA: S.maxContCurrentA,
    maxContPowerW: S.maxContPowerW, dcirMOhm: S.dcirMOhm,
    dims: S.dims, volumeL: S.volumeL,
  };
  const usage = currentUsage();
  const stdCtx = {
    cell: c, s: state.s, p: state.p, pack,
    layout: { spacingMm: state.spacingMm, arrangement: state.arrangement, wallMm: state.wallMm },
    usage,
  };
  lastFindings = runChecks(stdCtx);

  try {
    lastAnalysis = analyze({
      cell: c, s: state.s, p: state.p, pack,
      layout: {
        arrangement: state.arrangement, orientation: state.orientation,
        spacingMm: state.spacingMm, wallMm: state.wallMm,
        inner: lastLayout.inner, outer: lastLayout.outer,
        nx: lastLayout.nx, ny: lastLayout.ny, nz: lastLayout.nz,
      },
      usage,
      selection: selComponents(),
    });
  } catch (e) {
    console.error('analysis failed', e);
    lastAnalysis = null;
  }

  const perspectives = lastAnalysis?.perspectives || {};
  const engFindings = ['mechanical', 'thermal', 'electrical', 'safety']
    .flatMap((k) => perspectives[k] || []);
  const all = [...engFindings, ...lastFindings];
  const nFail = all.filter((x) => x.severity === 'fail').length;
  const nWarn = all.filter((x) => x.severity === 'warn').length;
  const badge = $('stdBadge');
  badge.textContent = nFail ? `${nFail}!` : (nWarn ? `${nWarn}` : '✓');
  badge.className = `chip ${nFail ? 'fail' : (nWarn ? 'warn' : 'pass')}`;

  $('stdDisclaimer').textContent = `${ANALYSIS_DISCLAIMER} ${DISCLAIMER}`;
  const findingHtml = (x) => `
    <div class="finding ${x.severity}">
      <div class="t"><span class="chip ${x.severity}">${x.severity}</span> ${esc(x.title)}</div>
      <div class="d">${esc(x.detail)}</div>
      <div class="r">${esc(x.ref || 'engineering practice')}${x.category ? ' · ' + esc(x.category) : ''}</div>
    </div>`;
  const renderPane = (id, list) => {
    $(id).innerHTML = list?.length ? list.map(findingHtml).join('')
      : '<div class="empty">Nothing to report.</div>';
  };
  renderPane('anMech', perspectives.mechanical);
  renderPane('anTherm', perspectives.thermal);
  renderPane('anElec', perspectives.electrical);
  renderPane('anSafe', perspectives.safety);
  $('findings').innerHTML = lastFindings.map(findingHtml).join('');
  $('stdList').innerHTML = STANDARDS_INFO.map((s) =>
    `<div style="margin-bottom:4px"><b>${esc(s.code)}</b> — ${esc(s.title)}</div>`).join('');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// ---------------------------------------------------------------------------
// Suggestions ("from usage")
// ---------------------------------------------------------------------------
function runSuggest() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const preset = PRESETS.find((x) => x.id === state.presetId);
  const dims = [num('rqDx'), num('rqDy'), num('rqDz')];
  const req = {
    vRange: [num('rqVlo') ?? 1, num('rqVhi') ?? 1000],
    energyWh: num('rqWh'),
    contPowerW: num('rqPc'), peakPowerW: num('rqPp'),
    chargeRateC: num('rqC'),
    maxMassKg: num('rqKg'),
    maxDimsMm: dims.every((v) => v != null) ? { x: dims[0], y: dims[1], z: dims[2] } : null,
    envTempC: (num('rqTlo') != null && num('rqThi') != null) ? [num('rqTlo'), num('rqThi')] : null,
    preferredChemistries: preset?.preferredChemistries || [],
    cyclesPerYear: num('rqCy'), targetYears: num('rqYr'),
  };
  const results = suggestDesigns(req, CELLS);
  const box = $('suggestions');
  if (!results.length) {
    box.innerHTML = '<div class="empty">Nothing feasible in the library for those numbers — widen the voltage window or relax constraints.</div>';
    return;
  }
  box.innerHTML = '';
  results.forEach((r, i) => {
    const ch = CHEMISTRIES[r.cell.chemistry];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h4>#${i + 1} ${esc(r.cell.name)}
        <span class="chip" style="color:${ch?.color};border-color:${ch?.color}">${r.cell.chemistry}</span></h4>
      <div class="m">${r.s}S${r.p}P · ${f1(r.summary.nominalV)} V · ${fWh(r.summary.energyWh)} ·
        ${f1(r.summary.massKg)} kg · ${f1(r.summary.volumeL)} L
        ${r.costUSD != null ? `· ~$${f0(r.costUSD)}` : ''}</div>
      <div class="scorebar"><i style="width:${clamp(r.score, 2, 100)}%"></i></div>
      <ul>${r.reasons.map((t) => `<li>${esc(t)}</li>`).join('')}
          ${r.warnings.map((t) => `<li class="warn">${esc(t)}</li>`).join('')}</ul>
      <button class="btn primary" style="margin-top:8px">Apply this design</button>`;
    card.querySelector('button').onclick = () => applyCandidate(r);
    box.appendChild(card);
  });
}

function applyCandidate(r) {
  state.cellId = r.cell.id;
  state.s = r.s; state.p = r.p;
  // Copy the full layout options the suggestion was priced with, so the
  // applied pack reproduces the card's mass/volume/dims exactly.
  Object.assign(state, {
    arrangement: r.best.opts.arrangement,
    orientation: r.best.opts.orientation,
    nx: r.best.opts.nx, nz: r.best.opts.nz,
    spacingMm: r.best.opts.spacingMm, layerGapMm: r.best.opts.layerGapMm,
    wallMm: r.best.opts.wallMm, headroomMm: r.best.opts.headroomMm,
  });
  onCellChange();
  syncInputs();
  recompute();
  document.querySelector('[data-tab="design"]').click();
}

// ---------------------------------------------------------------------------
// Fit box
// ---------------------------------------------------------------------------
function runFit() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const t = [num('fitX'), num('fitY'), num('fitZ')];
  const target = t.every((v) => v != null) ? { x: t[0], y: t[1], z: t[2] } : null;
  const baseOpts = {
    spacingMm: state.spacingMm, wallMm: state.wallMm,
    headroomMm: state.headroomMm, layerGapMm: state.layerGapMm,
  };
  const cands = optimizeSpace(cell(), state.s, state.p, baseOpts, target, 8);
  const box = $('fitResults');
  if (!cands.length) { box.innerHTML = '<div class="empty">No arrangement found.</div>'; return; }
  box.innerHTML = '';
  cands.forEach((cd) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h4>${cd.arrangement} · ${cd.orientation}
        ${target ? `<span class="chip ${cd.fits ? 'pass' : 'fail'}">${cd.fits ? (cd.fitsRotated ? 'fits (rotated 90°)' : 'fits') : 'does not fit'}</span>` : ''}</h4>
      <div class="m">${cd.nx}×${cd.ny}${cd.nz > 1 ? `×${cd.nz}` : ''} ·
        ${f0(cd.outer.x)} × ${f0(cd.outer.y)} × ${f0(cd.outer.z)} mm · ${f1(cd.volumeL)} L</div>
      <button class="btn" style="margin-top:8px">Apply</button>`;
    card.querySelector('button').onclick = () => {
      Object.assign(state, {
        arrangement: cd.arrangement, orientation: cd.orientation,
        nx: cd.nx, nz: cd.nz,
      });
      syncInputs(); recompute();
    };
    box.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Export / hash / theme
// ---------------------------------------------------------------------------
function exportJSON() {
  const c = cell();
  const doc = {
    tool: 'battery-data pack designer',
    generated: new Date().toISOString(),
    cell: c, config: { s: state.s, p: state.p },
    layout: {
      arrangement: state.arrangement, orientation: state.orientation,
      spacingMm: state.spacingMm, wallMm: state.wallMm, headroomMm: state.headroomMm,
      grid: lastLayout ? { nx: lastLayout.nx, ny: lastLayout.ny, nz: lastLayout.nz } : null,
    },
    components: selComponents(),
    summary: lastSummary,
    analysis: lastAnalysis,
    standardsFindings: lastFindings,
    disclaimer: `${ANALYSIS_DISCLAIMER} ${DISCLAIMER}`,
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pack-${c.id}-${state.s}s${state.p}p.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function saveHash() {
  const h = {
    c: state.cellId, s: state.s, p: state.p, a: state.arrangement, o: state.orientation,
    g: state.spacingMm, w: state.wallMm, hd: state.headroomMm, nx: state.nx, nz: state.nz,
    sel: state.sel,
  };
  history.replaceState(null, '', `#${encodeURIComponent(JSON.stringify(h))}`);
}

function restoreHash() {
  try {
    const raw = location.hash.slice(1);
    if (!raw) return;
    const h = JSON.parse(decodeURIComponent(raw));
    if (h.c && cellById(h.c)) state.cellId = h.c;
    if (h.s) state.s = clamp(h.s, 1, 300);
    if (h.p) state.p = clamp(h.p, 1, 200);
    if (h.a) state.arrangement = h.a;
    if (h.o) state.orientation = h.o;
    if (h.g != null) state.spacingMm = h.g;
    if (h.w != null) state.wallMm = h.w;
    if (h.hd != null) state.headroomMm = h.hd;
    if (h.nx != null) state.nx = h.nx;
    if (h.nz != null) state.nz = h.nz;
    if (h.sel && typeof h.sel === 'object') state.sel = { ...state.sel, ...h.sel };
    lastForm = (cellById(state.cellId) || CELLS[0]).form;
    onCellChange();
  } catch { /* stale hash — ignore */ }
}

function initTheme() {
  const saved = localStorage.getItem('bd-theme');
  if (saved) document.documentElement.dataset.theme = saved;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('bd-theme', next);
  viewer2d.setTheme();
  viewer?.setTheme(next === 'dark');
}

init();
