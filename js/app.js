// app.js — UI state and wiring for the pack designer. All the math lives in
// pack-engine.js / optimizer.js; all the data in cells.js / presets.js /
// standards.js; all the rendering in viewer3d.js.

import { CELLS, CHEMISTRIES, cellById } from './cells.js';
import { PRESETS } from './presets.js';
import { layoutPack, summarize, ARRANGEMENTS_BY_FORM, defaultArrangement } from './pack-engine.js';
import { optimizeSpace, suggestDesigns, maxFill, costModel } from './optimizer.js';
import { layoutPackBay, polygonBounds } from './bay.js';
import { co2Model, GRID_FACTORS, buildReportHTML, buildWordDocument } from './report.js';
import {
  loadMyCells, saveMyCells, normalizeCustomCell, validateCustomCell, buildMailto,
} from './mycells.js';
import { sensitivityAnalysis, priceFlipThreshold } from './sensitivity.js';
import { matchPatents, PATENTS_DISCLAIMER } from './patents.js';
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
  bayKind: 'box',          // box | round | lshape | stepped | poly
  sketchPts: [],           // drawn polygon vertices, mm
  appliedBay: null,        // bay object of the applied shaped fill, or null
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
let lastFillResults = null; // most recent max-fill ranking, for robustness

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
// Space the selected cooling system consumes inside the envelope.
const coolingSpace = () => selComponents().cooling?.spaceMm || { bottom: 0, side: 0, rowGap: 0 };

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
  $('btnWizard').onclick = showWizard;
  $('wzSkip').onclick = () => hideWizard(true);
  if (!localStorage.getItem('bd-wizard-done')) showWizard();
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
  sel.innerHTML = '';
  const addGroup = (label, cells) => {
    if (!cells.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const c of cells) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.name} — ${c.chemistry} ${f1(c.capacityAh)} Ah`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  };
  addGroup('My cells (this device only)', myCells);
  const byForm = {};
  for (const c of CELLS) (byForm[c.form] ||= []).push(c);
  for (const [form, cells] of Object.entries(byForm)) {
    addGroup(form[0].toUpperCase() + form.slice(1), cells);
  }
  if (!cellFind(state.cellId)) state.cellId = CELLS[0].id;
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
  // The real-world flow: the application defines the available bay, so the
  // preset also seeds the Fit tab's envelope for max-fill.
  if (pr.maxDimsMm) {
    $('fitX').value = pr.maxDimsMm.x;
    $('fitY').value = pr.maxDimsMm.y;
    $('fitZ').value = pr.maxDimsMm.z;
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function bindControls() {
  document.querySelectorAll('#tabs .tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) =>
      p.classList.toggle('active', p.id === `pane-${t.dataset.tab}`));
    if (t.dataset.tab === 'results') renderResults();
    updateFlowBar(t.dataset.tab);
  });
  buildFlowBar();
  bindCellModal();
  bindResults();

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

  $('segBay').querySelectorAll('button').forEach((b) => b.onclick = () => setBayKind(b.dataset.bay));
  bindSketch();
  $('btnSuggest').onclick = runSuggest;
  $('btnFit').onclick = runFit;
  $('btnMaxFill').onclick = runMaxFill;
  // Weight/allowance sliders re-rank live once a max-fill search has run.
  for (const [id, lbl, suffix] of [['wEnergy', 'vWe', ''], ['wCost', 'vWc', ''], ['wMass', 'vWm', ''],
    ['inInteg', 'vInteg', '%']]) {
    $(id).oninput = () => {
      $(lbl).textContent = $(id).value + suffix;
      if ($('fitResults').querySelector('.card')) runMaxFill();
    };
  }
  $('segCost').querySelectorAll('button').forEach((b) => b.onclick = () => {
    $('segCost').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    if ($('fitResults').querySelector('.card')) runMaxFill();
  });
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
// Customer-private cells (this device only) sit in front of the public
// library everywhere cells are searched or listed.
let myCells = loadMyCells();
const allCells = () => [...myCells, ...CELLS];
const cellFind = (id) => myCells.find((c) => c.id === id) || cellById(id) || null;
const cell = () => cellFind(state.cellId) || CELLS[0];

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
// Guided start — iPhone-style: one decision per screen, everything
// pre-filled, the customer never has to think about the machinery.
// ---------------------------------------------------------------------------
let wzPreset = null;

function showWizard() { $('wizard').style.display = 'flex'; wizardStep1(); }
function hideWizard(done) {
  $('wizard').style.display = 'none';
  if (done) localStorage.setItem('bd-wizard-done', '1');
}

function wizardStep1() {
  $('wzTitle').textContent = 'What are you building?';
  $('wzSub').textContent = 'Pick the closest — every number after this is pre-filled and adjustable later.';
  $('wzBack').style.visibility = 'hidden';
  const body = $('wzBody');
  body.innerHTML = '<div class="wz-grid"></div>';
  const grid = body.querySelector('.wz-grid');
  for (const pr of PRESETS) {
    const b = document.createElement('button');
    b.className = 'wz-opt';
    b.innerHTML = `<span class="ico">${pr.icon}</span>${esc(pr.name)}`;
    b.onclick = () => { wzPreset = pr; applyPreset(pr); wizardStep2(); };
    grid.appendChild(b);
  }
}

function wizardStep2() {
  const d = wzPreset?.maxDimsMm || { x: 400, y: 300, z: 120 };
  $('wzTitle').textContent = 'How much space do you have?';
  $('wzSub').textContent = 'Typical for your application is already filled in — change anything, in millimetres.';
  $('wzBack').style.visibility = 'visible';
  $('wzBack').onclick = wizardStep1;
  $('wzBody').innerHTML = `
    <div class="wz-dims">
      <div><label>Length</label><input type="number" id="wzX" value="${d.x}"></div>
      <div><label>Width</label><input type="number" id="wzY" value="${d.y}"></div>
      <div><label>Height</label><input type="number" id="wzZ" value="${d.z}"></div>
    </div>
    <div class="hint">Space isn’t a box? Round, L-shape, stepped and free drawing live on the Fit tab —
      <a id="wzShapes" style="cursor:pointer">open it</a>.</div>
    <button class="btn primary wz-big" id="wzGo">Show my designs →</button>`;
  $('wzShapes').onclick = () => { hideWizard(true); document.querySelector('[data-tab="fit"]').click(); };
  $('wzGo').onclick = () => {
    $('fitX').value = $('wzX').value; $('fitY').value = $('wzY').value; $('fitZ').value = $('wzZ').value;
    wizardStep3();
  };
}

function wizardStep3() {
  $('wzTitle').textContent = 'Pick your design';
  $('wzSub').textContent = 'Best three for your space, balanced for energy, lifetime cost and weight. Tap one — you can fine-tune everything afterwards.';
  $('wzBack').style.visibility = 'visible';
  $('wzBack').onclick = wizardStep2;
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const results = maxFill(allCells(),
    { x: num('fitX'), y: num('fitY'), z: num('fitZ') },
    {
      vRange: [num('rqVlo') ?? 1, num('rqVhi') ?? 1000],
      contPowerW: num('rqPc'),
      cyclesPerYear: num('rqCy'), targetYears: num('rqYr'),
      costBasis: 'tco',
      weights: { energy: 5, cost: 3, mass: 2 },
    },
    {
      spacingMm: state.spacingMm, wallMm: state.wallMm,
      headroomMm: state.headroomMm, layerGapMm: state.layerGapMm,
      coolingSpace: coolingSpace(), integrationPct: 35,
    }, 3);
  const body = $('wzBody');
  if (!results.length) {
    body.innerHTML = '<div class="empty">Nothing fits that space — go back and make it a little bigger.</div>';
    return;
  }
  lastFillResults = results;
  body.innerHTML = '';
  results.forEach((r, i) => {
    const why = [
      i === 0 ? 'Best overall balance' : (r.pareto ? 'A different trade-off — nothing beats it on all counts' : 'Runner-up'),
      r.tco?.tcoUSD != null
        ? `~$${f0(r.tco.tcoUSD)} over ${f0(parseFloat($('rqYr').value) || 0)} years${r.tco.replacements > 1 ? ` (${r.tco.replacements} packs)` : ''}`
        : (r.costUSD != null ? `~$${f0(r.costUSD)} upfront` : ''),
    ].filter(Boolean).join(' · ');
    const el = document.createElement('div');
    el.className = 'wz-pick';
    el.innerHTML = `
      <div class="big">${fWh(r.energyWh)} · ${f1(r.massKg)} kg</div>
      <div>${esc(r.cell.name)} — ${r.s}S${r.p}P, ${r.n} cells</div>
      <div class="why">${esc(why)}</div>`;
    el.onclick = () => {
      state.cellId = r.cell.id;
      state.s = r.s; state.p = r.p;
      state.appliedBay = r.shaped ? r.bay : null;
      Object.assign(state, {
        arrangement: r.opts.arrangement, orientation: r.opts.orientation,
        nx: r.opts.nx, nz: r.opts.nz,
      });
      onCellChange();
      syncInputs();
      recompute();
      hideWizard(true);
      document.querySelector('[data-tab="design"]').click();
    };
    body.appendChild(el);
  });
}

// ---------------------------------------------------------------------------
// The system workflow, made visible — the same order a pack project runs in
// the market: the customer's application and boundaries come FIRST, the
// design is derived from them.
// ---------------------------------------------------------------------------
const FLOW_STEPS = [
  { tab: 'usage', num: '1', label: 'Application & duty' },
  { tab: 'fit', num: '2', label: 'Space & boundaries → scenarios' },
  { tab: 'design', num: '3', label: 'Chosen design' },
  { tab: 'comp', num: '4', label: 'Parts & suppliers' },
  { tab: 'analysis', num: '5', label: 'Engineering audit' },
  { tab: 'results', num: '6', label: 'Report' },
];

function buildFlowBar() {
  const bar = $('flowBar');
  FLOW_STEPS.forEach((st, i) => {
    if (i) {
      const a = document.createElement('span');
      a.className = 'farrow';
      a.textContent = '→';
      bar.appendChild(a);
    }
    const b = document.createElement('button');
    b.className = 'fstep';
    b.dataset.tab = st.tab;
    b.innerHTML = `<b>${st.num}</b>${esc(st.label)}`;
    b.onclick = () => document.querySelector(`#tabs .tab[data-tab="${st.tab}"]`)?.click();
    bar.appendChild(b);
  });
  updateFlowBar('design');
}

function updateFlowBar(tab) {
  $('flowBar').querySelectorAll('.fstep').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
}

// ---------------------------------------------------------------------------
// Customer cells — private, this device only (see js/mycells.js)
// ---------------------------------------------------------------------------
function bindCellModal() {
  $('btnAddCell').onclick = () => {
    $('ccForm').style.display = 'block';
    $('ccDone').style.display = 'none';
    $('ccErrs').textContent = '';
    $('cellModal').style.display = 'flex';
  };
  $('ccClose').onclick = () => { $('cellModal').style.display = 'none'; };
  $('ccForm2').onchange = () => {
    const cyl = $('ccForm2').value === 'cylindrical';
    $('ccDimsCyl').style.display = cyl ? 'grid' : 'none';
    $('ccDimsBox').style.display = cyl ? 'none' : 'grid';
  };
  $('ccSave').onclick = () => {
    const form = $('ccForm2').value;
    const raw = {
      manufacturer: $('ccMfr').value, model: $('ccModel').value,
      form, chemistry: $('ccChem').value,
      d: $('ccD').value, h: form === 'cylindrical' ? $('ccH').value : $('ccH2').value,
      w: $('ccW').value, t: $('ccT').value,
      capacityAh: $('ccAh').value, massG: $('ccG').value, cycleLife: $('ccCyc').value,
      nominalV: $('ccVn').value, vMax: $('ccVx').value, vMin: $('ccVm').value,
      maxContDischargeA: $('ccId').value, maxContChargeA: $('ccIc').value,
      priceUSD: $('ccPr').value,
    };
    const errs = validateCustomCell(raw);
    if (errs.length) { $('ccErrs').innerHTML = errs.map(esc).join('<br>'); return; }
    const cellRec = normalizeCustomCell(raw);
    myCells = [cellRec, ...myCells.filter((c) => c.id !== cellRec.id)];
    saveMyCells(myCells);
    initCellSelect();
    state.cellId = cellRec.id;
    onCellChange();
    syncInputs();
    recompute();
    $('ccForm').style.display = 'none';
    $('ccDone').style.display = 'block';
    $('ccMail').href = buildMailto(cellRec);
    $('ccJson').onclick = () => {
      const blob = new Blob([JSON.stringify(cellRec, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${cellRec.id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  };
}

// ---------------------------------------------------------------------------
// Results tab — economical + CO2 analysis, PDF and Word export
// ---------------------------------------------------------------------------
function bindResults() {
  const sel = $('selGrid');
  for (const gf of GRID_FACTORS) {
    const o = document.createElement('option');
    o.value = gf.id;
    o.textContent = gf.g != null ? `${gf.label} (${gf.g} g/kWh)` : gf.label;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    $('inGridG').style.display = sel.value === 'custom' ? 'block' : 'none';
    renderResults();
  };
  $('inGridG').oninput = renderResults;
  $('btnPdf').onclick = () => {
    $('printArea').innerHTML = currentReportHTML();
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  };
  $('btnWord').onclick = () => {
    const doc = buildWordDocument(currentReportHTML(), 'Battery pack design report');
    const blob = new Blob(['﻿' + doc], { type: 'application/msword' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pack-report-${cell().id}-${state.s}s${state.p}p.doc`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function currentGridFactor() {
  const id = $('selGrid').value || 'world';
  const gf = GRID_FACTORS.find((g) => g.id === id) || GRID_FACTORS[0];
  if (gf.id === 'custom') {
    const v = parseFloat($('inGridG').value);
    return { label: 'Custom source', g: isFinite(v) && v > 0 ? v : 440 };
  }
  return gf;
}

function currentReportData() {
  const c = cell();
  const nv = (id) => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : null; };
  const usage = { cyclesPerYear: nv('rqCy'), targetYears: nv('rqYr') };
  const gf = currentGridFactor();
  const costM = costModel(c, lastSummary.cellCount, lastSummary.energyWh, usage);
  const co2M = co2Model({
    cell: c, energyWh: lastSummary.energyWh,
    cyclesPerYear: usage.cyclesPerYear, targetYears: usage.targetYears,
    gridGPerKWh: gf.g,
  });
  const engFindings = lastAnalysis
    ? ['mechanical', 'thermal', 'electrical', 'safety'].flatMap((k) => lastAnalysis.perspectives[k] || [])
    : [];
  return {
    date: new Date().toISOString().slice(0, 10),
    application: state.presetId || 'custom',
    cell: c,
    summary: lastSummary,
    massWithComponentsKg: lastAnalysis?.totals?.packMassWithComponentsKg ?? null,
    bayLabel: state.appliedBay ? `${state.appliedBay.kind} bay` : 'box',
    cost: costM,
    co2: co2M,
    gridLabel: gf.label,
    usage,
    selection: selComponents(),
    findings: [...engFindings, ...lastFindings],
    sensitivity: sensitivityAnalysis({
      cell: c, n: lastSummary.cellCount, energyWh: lastSummary.energyWh, usage,
    }, 20),
    robustness: (() => {
      if (!lastFillResults || lastFillResults.length < 2) return null;
      const [w, r] = lastFillResults;
      if (w.cell.id !== c.id) return null; // report is not about the fill winner
      const basis = w.costBasisUsed === 'tco' && w.tco?.tcoUSD != null ? 'tco' : 'upfront';
      const fl = priceFlipThreshold(w, r, basis);
      return fl ? { ...fl, runnerUp: r.cell.name } : null;
    })(),
    patents: matchPatents({ cell: c, cellCount: lastSummary.cellCount, selection: selComponents() }),
    patentsDisclaimer: PATENTS_DISCLAIMER,
    disclaimer: `${ANALYSIS_DISCLAIMER} ${DISCLAIMER}`,
  };
}

function currentReportHTML() {
  return buildReportHTML(currentReportData());
}

function renderResults() {
  if (!lastSummary) return;
  $('reportView').innerHTML = currentReportHTML();
}

// ---------------------------------------------------------------------------
// Bay shape (available space) — calculator-simple templates + a tiny sketcher
// ---------------------------------------------------------------------------
const BAY_FIELDS = {
  round: [['bayD', 'Diameter (mm)', 600], ['bayZ1', 'Height (mm)', 120]],
  lshape: [['bayLX', 'L (x, mm)', 800], ['bayLY', 'W (y, mm)', 600],
    ['bayCutX', 'Cut x (mm)', 300], ['bayCutY', 'Cut y (mm)', 250], ['bayZ1', 'Height (mm)', 120]],
  stepped: [['bayXA', 'Zone A length (mm)', 900], ['bayZA', 'Zone A height (mm)', 140],
    ['bayXB', 'Zone B length (mm)', 600], ['bayZB', 'Zone B height (mm)', 260], ['bayY', 'Width (y, mm)', 1100]],
  poly: [['bayZ1', 'Height (mm)', 120]],
};

function setBayKind(kind) {
  state.bayKind = kind;
  $('segBay').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.bay === kind));
  $('bayBox').style.display = kind === 'box' ? 'block' : 'none';
  const box = $('bayFields');
  box.innerHTML = '';
  for (const [id, label, dflt] of BAY_FIELDS[kind] || []) {
    const d = document.createElement('div');
    d.innerHTML = `<label class="f">${label}</label><input type="number" id="${id}" value="${dflt}">`;
    box.appendChild(d);
  }
  $('sketch').style.display = kind === 'poly' ? 'block' : 'none';
  if (kind === 'poly') {
    $('bayHint').textContent = 'Click to add corners (grid = 50 mm). Click the first corner to close, drag a corner to move it, double-click a corner to delete it. The shape is your bay in plan view.';
    drawSketch();
  } else {
    $('bayHint').textContent = 'Type the sizes — like a calculator. Walls, spacer gap, busbar headroom and the selected cooling system’s space are subtracted before packing.';
  }
}

function readBay() {
  const n = (id, dflt) => { const v = parseFloat($(id)?.value); return isFinite(v) && v > 0 ? v : dflt; };
  switch (state.bayKind) {
    case 'round': return { kind: 'round', d: n('bayD', 600), z: n('bayZ1', 120) };
    case 'lshape': return {
      kind: 'lshape', x: n('bayLX', 800), y: n('bayLY', 600),
      cutX: n('bayCutX', 300), cutY: n('bayCutY', 250), z: n('bayZ1', 120),
    };
    case 'stepped': return {
      kind: 'stepped', xA: n('bayXA', 900), zA: n('bayZA', 140),
      xB: n('bayXB', 600), zB: n('bayZB', 260), y: n('bayY', 1100),
    };
    case 'poly':
      return state.sketchPts.length >= 3
        ? { kind: 'poly', points: state.sketchPts, z: n('bayZ1', 120) }
        : null;
    case 'box':
    default: {
      const x = parseFloat($('fitX').value), y = parseFloat($('fitY').value), z = parseFloat($('fitZ').value);
      return [x, y, z].every((v) => isFinite(v) && v > 0) ? { kind: 'box', x, y, z } : null;
    }
  }
}

// Tiny polygon sketcher: fixed 1500 mm world width, 50 mm snap.
const SKETCH_WORLD = 1500;
let sketchDrag = null;
function sketchScale() {
  const c = $('sketch');
  return (c.clientWidth || 300) / SKETCH_WORLD;
}
function drawSketch() {
  const c = $('sketch');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wCss = c.clientWidth || 300, hCss = 230;
  c.width = wCss * dpr; c.height = hCss * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, wCss, hCss);
  const sc = sketchScale();
  const css = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  g.strokeStyle = css('--line', '#ddd'); g.lineWidth = 0.5;
  for (let mm = 0; mm <= SKETCH_WORLD; mm += 100) {
    g.beginPath(); g.moveTo(mm * sc, 0); g.lineTo(mm * sc, hCss); g.stroke();
    g.beginPath(); g.moveTo(0, mm * sc); g.lineTo(wCss, mm * sc); g.stroke();
  }
  const pts = state.sketchPts;
  if (!pts.length) {
    g.fillStyle = css('--muted', '#888'); g.font = '12px system-ui';
    g.fillText('click to sketch your bay outline (100 mm grid)', 12, 20);
    return;
  }
  g.strokeStyle = css('--accent', '#0b6e5f'); g.lineWidth = 1.6;
  g.beginPath();
  pts.forEach(([x, y], i) => i ? g.lineTo(x * sc, y * sc) : g.moveTo(x * sc, y * sc));
  if (pts.length >= 3) g.closePath();
  g.stroke();
  g.fillStyle = 'rgba(11,110,95,.08)'; if (pts.length >= 3) g.fill();
  for (const [x, y] of pts) {
    g.fillStyle = css('--accent', '#0b6e5f');
    g.beginPath(); g.arc(x * sc, y * sc, 4, 0, Math.PI * 2); g.fill();
  }
  // Edge lengths.
  g.fillStyle = css('--muted', '#888'); g.font = '10px ui-monospace, monospace';
  for (let i = 0; i < pts.length - (pts.length >= 3 ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    g.fillText(`${Math.round(len)}`, ((a[0] + b[0]) / 2) * sc + 3, ((a[1] + b[1]) / 2) * sc - 3);
  }
}
function bindSketch() {
  const c = $('sketch');
  const toMm = (e) => {
    const r = c.getBoundingClientRect();
    const sc = sketchScale();
    const snap = (v) => Math.round(v / 50) * 50;
    return [snap((e.clientX - r.left) / sc), snap((e.clientY - r.top) / sc)];
  };
  const hitIdx = (e) => {
    const r = c.getBoundingClientRect();
    const sc = sketchScale();
    return state.sketchPts.findIndex(([x, y]) =>
      Math.hypot(x * sc - (e.clientX - r.left), y * sc - (e.clientY - r.top)) < 9);
  };
  c.onpointerdown = (e) => {
    const i = hitIdx(e);
    if (i >= 0) { sketchDrag = i; c.setPointerCapture(e.pointerId); return; }
    state.sketchPts.push(toMm(e));
    drawSketch();
  };
  c.onpointermove = (e) => {
    if (sketchDrag == null) return;
    state.sketchPts[sketchDrag] = toMm(e);
    drawSketch();
  };
  c.onpointerup = () => { sketchDrag = null; };
  c.ondblclick = (e) => {
    const i = hitIdx(e);
    if (i >= 0) { state.sketchPts.splice(i, 1); drawSketch(); }
  };
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
  const cool = coolingSpace();
  const opts = {
    arrangement: state.arrangement, orientation: state.orientation,
    spacingMm: state.spacingMm, wallMm: state.wallMm,
    headroomMm: state.headroomMm, layerGapMm: state.layerGapMm,
    underMm: cool.bottom, rowExtraMm: cool.rowGap,
    nx: state.nx, nz: state.nz,
  };
  let layout = null;
  let bayNote = '';
  if (state.appliedBay) {
    // A shaped fill was applied: place the cells inside the real bay outline.
    layout = layoutPackBay(c, state.s, state.p, state.appliedBay, opts);
    if (!layout) {
      state.appliedBay = null; // S·P outgrew the bay — fall back to a free grid
      bayNote = ' · exceeds bay capacity, showing free grid';
    }
  }
  if (!layout) layout = layoutPack(c, state.s, state.p, opts);
  if (!layout) layout = layoutPack(c, state.s, state.p, { ...opts, nx: 0 });
  lastLayout = layout;
  lastSummary = summarize(c, state.s, state.p, layout);
  $('cfgHint').textContent = layout.bayZonesOut
    ? `${N} cells in ${state.appliedBay.kind} bay · ${layout.arrangement}`
    : `${N} cells · ${layout.nx}×${layout.ny}${layout.nz > 1 ? `×${layout.nz}` : ''} ${layout.arrangement}${bayNote}`;

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
  {
    const nv = (id) => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : null; };
    const cm = costModel(c, S.cellCount, S.energyWh,
      { cyclesPerYear: nv('rqCy'), targetYears: nv('rqYr') });
    if (cm.upfrontUSD != null || cm.usdPerKWhDelivered != null) {
      rows.push(['sec', 'Cost (cells, estimate)']);
      if (cm.upfrontUSD != null) rows.push(['Upfront', `~$${f0(cm.upfrontUSD)} · ${f0(cm.usdPerKWhCap)} $/kWh`]);
      if (cm.usdPerKWhDelivered != null) {
        rows.push(['Per kWh delivered', `${(Math.round(cm.usdPerKWhDelivered * 100) / 100).toFixed(2)} $ (${f0(c.cycleLife)} cyc)`]);
      }
      if (cm.serviceYears != null) rows.push(['Service life', `~${f1(cm.serviceYears)} y at duty`]);
      if (cm.tcoUSD != null) {
        rows.push(['TCO over target', `~$${f0(cm.tcoUSD)}${cm.replacements > 1 ? ` (${cm.replacements}× packs)` : ''}`]);
      }
    }
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
  const results = suggestDesigns(req, allCells());
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
// The real-world flow: the bay is fixed; find the cell and S×P that pack the
// most energy into it — accounting for the space the selected components
// consume — then compare on cost.
function runMaxFill() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const box = $('fitResults');
  const bay = readBay();
  if (!bay) {
    box.innerHTML = state.bayKind === 'poly'
      ? '<div class="empty">Sketch at least three corners of your bay first.</div>'
      : '<div class="empty">Max fill needs the bay dimensions — enter the space your application offers (a preset on the Usage tab pre-fills the box).</div>';
    return;
  }
  const shaped = bay.kind !== 'box';
  const envelope = shaped ? null : { x: bay.x, y: bay.y, z: bay.z };
  const req = {
    vRange: [num('rqVlo') ?? 1, num('rqVhi') ?? 1000],
    contPowerW: num('rqPc'),
    cyclesPerYear: num('rqCy'), targetYears: num('rqYr'),
    costBasis: $('segCost').querySelector('.active')?.dataset.cost || 'tco',
    weights: {
      energy: parseFloat($('wEnergy').value),
      cost: parseFloat($('wCost').value),
      mass: parseFloat($('wMass').value),
    },
  };
  const cool = coolingSpace();
  const integrationPct = parseFloat($('inInteg').value) || 0;
  const results = maxFill(allCells(), envelope, req, {
    spacingMm: state.spacingMm, wallMm: state.wallMm,
    headroomMm: state.headroomMm, layerGapMm: state.layerGapMm,
    coolingSpace: cool, integrationPct, bay: shaped ? bay : null,
  });
  if (!results.length) {
    box.innerHTML = '<div class="empty">No cell in the library fits that envelope with the current walls, spacing and cooling reservation.</div>';
    return;
  }
  lastFillResults = results;
  const w = results[0]?.weightsUsed;
  const bayLabel = shaped
    ? `${bay.kind} bay`
    : `${f0(bay.x)}×${f0(bay.y)}×${f0(bay.z)} mm`;
  box.innerHTML = `<div class="hint" style="margin-bottom:8px">${esc(bayLabel)} ·
    ${req.vRange[0]}–${req.vRange[1]} V window · cooling reserve ${cool.bottom}/${cool.side}/${cool.rowGap} mm (bottom/side/row)
    · integration ${f0(integrationPct)}%
    ${w ? `· weights E ${f0(w.energy * 100)}% / $ ${f0(w.cost * 100)}% / kg ${f0(w.mass * 100)}%` : ''}</div>`;
  results.forEach((r, i) => {
    const ch = CHEMISTRIES[r.cell.chemistry];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h4>#${i + 1} ${esc(r.cell.name)}
        <span class="chip" style="color:${ch?.color};border-color:${ch?.color}">${r.cell.chemistry}</span>
        ${r.pareto ? '<span class="chip pass">Pareto-optimal</span>' : '<span class="chip info">dominated</span>'}</h4>
      <div class="m">${r.s}S${r.p}P · ${f1(r.nominalV)} V · ${r.n}/${r.nMax} cells (${f0(r.utilization * 100)}% of fit) ·
        ${fWh(r.energyWh)} · ${f1(r.massKg)} kg ·
        ${r.grid.nx != null ? `${r.grid.nx}×${r.grid.ny}${r.grid.nz > 1 ? `×${r.grid.nz}` : ''} ` : ''}${r.opts.arrangement}</div>
      ${r.costUSD != null ? `<div class="m" style="margin-top:2px">Upfront ~$${f0(r.costUSD)} (${f0(r.usdPerKWh)} $/kWh cap.)
        ${r.tco?.usdPerKWhDelivered != null ? ` · <b>${(Math.round(r.tco.usdPerKWhDelivered * 100) / 100).toFixed(2)} $/kWh delivered</b> over ${f0(r.cell.cycleLife)} cycles` : ''}
        ${r.tco?.tcoUSD != null ? ` · TCO ~$${f0(r.tco.tcoUSD)}${r.tco.replacements > 1 ? ` (${r.tco.replacements}× packs)` : ''}${r.tco.serviceYears != null ? ` · ~${f1(r.tco.serviceYears)} y/pack` : ''}` : ''}</div>` : ''}
      <div class="scorebar"><i style="width:${clamp(r.score, 2, 100)}%"></i></div>
      ${r.warnings.length ? `<ul>${r.warnings.map((x) => `<li class="warn">${esc(x)}</li>`).join('')}</ul>` : ''}
      <button class="btn primary" style="margin-top:8px">Apply this fill</button>`;
    card.querySelector('button').onclick = () => {
      state.cellId = r.cell.id;
      state.s = r.s; state.p = r.p;
      state.appliedBay = r.shaped ? r.bay : null;
      Object.assign(state, {
        arrangement: r.opts.arrangement, orientation: r.opts.orientation,
        nx: r.opts.nx, nz: r.opts.nz,
      });
      onCellChange();
      syncInputs();
      recompute();
      document.querySelector('[data-tab="design"]').click();
    };
    box.appendChild(card);
  });
}

function runFit() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const t = [num('fitX'), num('fitY'), num('fitZ')];
  const target = t.every((v) => v != null) ? { x: t[0], y: t[1], z: t[2] } : null;
  const cool = coolingSpace();
  const baseOpts = {
    spacingMm: state.spacingMm, wallMm: state.wallMm,
    headroomMm: state.headroomMm, layerGapMm: state.layerGapMm,
    underMm: cool.bottom, rowExtraMm: cool.rowGap,
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
    if (h.c && cellFind(h.c)) state.cellId = h.c;
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
