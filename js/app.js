// app.js — UI state and wiring for the pack designer. All the math lives in
// pack-engine.js / optimizer.js; all the data in cells.js / presets.js /
// standards.js; all the rendering in viewer3d.js.

import { CELLS, CHEMISTRIES, cellById, provenance } from './cells.js';
import { CellPicker } from './cell-picker.js';
import { drawRadar, radarTable, missingNotes, SERIES } from './radar.js';
import { PRESETS } from './presets.js';
import { layoutPack, summarize, ARRANGEMENTS_BY_FORM, defaultArrangement } from './pack-engine.js';
import { optimizeSpace, suggestDesigns, maxFill, costModel } from './optimizer.js';
import { layoutPackBay, polygonBounds } from './bay.js';
import { co2Model, GRID_FACTORS, buildReportHTML, buildWordDocument } from './report.js';
import {
  loadMyCells, saveMyCells, normalizeCustomCell, validateCustomCell, buildMailto,
} from './mycells.js';
import { sensitivityAnalysis, priceFlipThreshold } from './sensitivity.js';
import { parseOutline } from './bay-import.js';
import {
  LOAD_PROFILES, profileForApp, profilesForApp, profileById, profileStats, profileChecks,
  parseProfileCSV,
} from './loadprofiles.js';
import { climateById, climateSpan, seasonalOutlook } from './seasons.js';
import { EU_TIMELINE, EU_DISCLAIMER, euChecks } from './eurules.js';
import { releaseChecklist } from './markets.js';
import { TRAINING_TRACKS } from './training.js';
import { matchPatents, PATENTS_DISCLAIMER } from './patents.js';
import { buildArchitecture, modulePartition, systemPlan } from './architecture.js';
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
  profileId: null,         // active load profile id, 'custom', or null
  profileScaleW: null,     // absolute W the profile's peak (=1.0) maps to
  archTopology: 'auto',    // BMS topology choice ('auto' applies the scale rule)
  archIso: 'ece-r100',     // governing isolation standard — explicit, never averaged
  climateId: 'temperate',  // seasonal ambient family for the environment helper
  seasonId: 'all',         // winter|spring|summer|autumn|all — design for ALL seasons
  marketId: 'eu',          // release-checklist target market
};
let customProfile = null;  // uploaded profile (session only)

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
let lastArch = null;      // architecture (modules, BMS, HV chain) of the pack
let lastArchFindings = []; // architecture findings folded into the Electrical pane
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
  initProfiles();
  restoreHash();
  initComponents();
  bindControls();
  viewer2d = new PackViewer2D($('viewport2d'));
  syncInputs();
  recompute();
  $('btnWizard').onclick = showWizard;
  $('wzSkip').onclick = () => hideWizard(true);
  bindTraining();
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
  renderCompLegend();
}

// Names what the 3D render is actually showing, keyed to the mesh colors —
// so an exploded view stays readable instead of a guessing game.
function renderCompLegend() {
  const box = $('compLegend');
  if (viewMode !== '3d' || !lastSummary) { box.style.display = 'none'; return; }
  const s = selComponents();
  const key = (color, name, note) =>
    `<div><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px"></span><b>${esc(name)}</b>${note ? ` <span style="color:var(--muted)">— ${esc(note)}</span>` : ''}</div>`;
  const rows = [];
  if (s.cooling?.viz) {
    rows.push(key('#3f7fd0', s.cooling.name,
      s.cooling.viz === 'between' ? 'blue ribbons between the rows' : `blue ${s.cooling.viz} plate`));
  }
  if (s.vent) rows.push(key('#30363a', s.vent.name, s.vent.level === 'pack' ? 'dark nub on the lid (assembled view)' : 'cell-level, inside each cell'));
  if (s.housing) rows.push(key('#4fd1b5', s.housing.name, 'tinted shell (assembled view)'));
  if (s.busbar) rows.push(key('#d8d8d2', s.busbar.name, 'silver caps / series path'));
  if (s.spacer) rows.push(key('#8899aa', s.spacer.name, `sets the ${state.spacingMm} mm cell gap`));
  if (s.tim) rows.push(key('#d9a441', s.tim.name, 'between cells and the cooling surface'));
  if (!rows.length) { box.style.display = 'none'; return; }
  box.innerHTML = '<span class="lbl">Components in view</span>' + rows.join('') +
    '<div style="color:var(--muted);margin-top:4px">Exploding keeps the cooling hardware visible (it flies apart with the cells); housing and wiring hide while exploded.</div>';
  box.style.display = 'block';
}

// Rules tab: the market release checklist (standards per application and
// market, with chemistry-market gates like China's e-bus rule), the EU
// 2023/1542 timeline and what applies to the design on screen.
function renderEu() {
  $('euDisclaimer').textContent = EU_DISCLAIMER;
  $('euTimeline').innerHTML = EU_TIMELINE.map((e) =>
    `<div class="stat"><span>${esc(e.date)}</span><b style="font-weight:normal">${esc(e.what)}</b></div>`).join('');
  renderMarketChecklist();
  if (!lastSummary) { $('euBody').innerHTML = '<div class="empty">—</div>'; return; }
  const checks = euChecks({
    energyWh: lastSummary.energyWh,
    application: state.presetId || 'custom',
    chemistry: cell().chemistry,
    commsPrimary: lastArch?.comms?.primary,
  });
  $('euBody').innerHTML = checks.map(findingHTML).join('');
}

function renderMarketChecklist() {
  const box = $('mktBody');
  const app = state.presetId;
  if (!app) {
    box.innerHTML = '<div class="empty">Pick an application on the Usage tab — the checklist is per application class.</div>';
    return;
  }
  const cl = releaseChecklist({ market: state.marketId, application: app, chemistry: cell().chemistry });
  const scopeChip = (s) => ({
    mandatory: '<span class="chip fail">mandatory</span>',
    expected: '<span class="chip warn">expected</span>',
    practice: '<span class="chip info">practice</span>',
    blocker: '<span class="chip fail">blocker</span>',
    pass: '<span class="chip pass">pass</span>',
    note: '<span class="chip info">note</span>',
  })[s] || '';
  // Chemistry-market gates first — a blocker must never hide below the fold.
  const ruleHtml = cl.rules.map((r) => `
    <div class="finding ${r.scope === 'blocker' ? 'fail' : r.scope === 'pass' ? 'pass' : 'warn'}">
      <div class="t">${scopeChip(r.scope)} ${esc(r.title)}</div>
      <div class="d">${esc(r.note)}</div>
      <div class="r">${esc(r.code)}</div>
    </div>`).join('');
  const itemHtml = cl.items.map((i) => `
    <div class="stat"><span>☐ <b>${esc(i.code)}</b></span>
      <b style="font-weight:normal">${scopeChip(i.scope)} ${esc(i.title)}${i.note ? ` <span style="color:var(--muted)">— ${esc(i.note)}</span>` : ''}</b></div>`).join('');
  box.innerHTML = ruleHtml + itemHtml + `<div class="hint">${esc(cl.note)}</div>`;
}

// Interactive training: walks the REAL UI, one step per tab, in two tracks
// (simple clicks vs advanced levers) so the process never confuses anyone.
let trainTrack = null;
let trainStep = 0;

function startTraining(trackId) {
  trainTrack = TRAINING_TRACKS[trackId];
  trainStep = 0;
  showTrainStep();
}

function showTrainStep() {
  const card = $('trainCard');
  if (!trainTrack) { card.style.display = 'none'; return; }
  const steps = trainTrack.steps;
  const st = steps[trainStep];
  document.querySelector(`#tabs .tab[data-tab="${st.tab}"]`)?.click();
  card.style.display = 'block';
  $('trainTitle').textContent = st.title;
  $('trainText').textContent = st.text;
  $('trainProg').textContent = `${trainStep + 1}/${steps.length}`;
  $('trainBack').style.visibility = trainStep === 0 ? 'hidden' : 'visible';
  $('trainNext').textContent = trainStep === steps.length - 1 ? 'Finish ✓' : 'Next →';
}

function bindTraining() {
  $('btnTrain').onclick = () => {
    // Track chooser inside the same card — one decision, no modal maze.
    trainTrack = null;
    const card = $('trainCard');
    card.style.display = 'block';
    $('trainTitle').textContent = 'Training — pick your track';
    $('trainProg').textContent = '';
    $('trainText').innerHTML = '';
    const wrap = document.createElement('div');
    const b1 = document.createElement('button');
    b1.className = 'btn primary'; b1.style.cssText = 'width:100%;margin-bottom:6px';
    b1.textContent = `🟢 ${TRAINING_TRACKS.simple.name}`;
    b1.onclick = () => startTraining('simple');
    const b2 = document.createElement('button');
    b2.className = 'btn'; b2.style.cssText = 'width:100%';
    b2.textContent = `🔵 ${TRAINING_TRACKS.advanced.name}`;
    b2.onclick = () => startTraining('advanced');
    $('trainText').append(wrap, b1, b2);
    $('trainBack').style.visibility = 'hidden';
    $('trainNext').textContent = 'Close';
  };
  $('trainNext').onclick = () => {
    if (!trainTrack) { $('trainCard').style.display = 'none'; return; }
    if (trainStep >= trainTrack.steps.length - 1) {
      $('trainCard').style.display = 'none'; trainTrack = null; return;
    }
    trainStep++; showTrainStep();
  };
  $('trainBack').onclick = () => { if (trainStep > 0) { trainStep--; showTrainStep(); } };
  $('trainExit').onclick = () => { $('trainCard').style.display = 'none'; trainTrack = null; };
  $('segMarket').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.marketId = b.dataset.mkt;
    $('segMarket').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderMarketChecklist();
  });
}

const findingHTML = (x) => `
  <div class="finding ${x.severity}">
    <div class="t"><span class="chip ${x.severity}">${x.severity}</span> ${esc(x.title)}</div>
    <div class="d">${esc(x.detail)}</div>
    <div class="r">${esc(x.ref || 'engineering practice')}${x.category ? ' · ' + esc(x.category) : ''}</div>
  </div>`;

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
  // Each application carries its OWN characteristic load shape (a truck-like
  // van is not a rooftop solar plant), plus a short list of alternates the
  // customer can switch between — the dropdown regroups per application.
  rebuildProfileSelect(pr.id);
  const prof = profileForApp(pr.id);
  if (prof) {
    state.profileId = prof.id;
    state.profileScaleW = pr.peakPowerW;
    $('selProfile').value = prof.id;
    applyProfileToRequirements();
  }
  renderProfile();
}

// ---------------------------------------------------------------------------
// Load profiles
// ---------------------------------------------------------------------------
function currentProfile() {
  if (state.profileId === 'custom') return customProfile;
  return state.profileId ? profileById(state.profileId) : null;
}

// Regroups the profile dropdown around the chosen application: its
// recommended shapes first (default on top), everything else still one
// click away, the customer's upload always last.
function rebuildProfileSelect(appId) {
  const sel = $('selProfile');
  const cur = sel.value;
  sel.innerHTML = '';
  const group = (label) => {
    const g = document.createElement('optgroup');
    g.label = label;
    sel.appendChild(g);
    return g;
  };
  const opt = (parent, v, label) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    (parent || sel).appendChild(o);
  };
  opt(null, '', 'None — type the power numbers below');
  const rec = appId ? profilesForApp(appId) : [];
  if (rec.length) {
    const appName = PRESETS.find((p) => p.id === appId)?.name || appId;
    const g = group(`Recommended for ${appName}`);
    for (const pr of rec) opt(g, pr.id, pr.name);
  }
  const others = LOAD_PROFILES.filter((pr) => !rec.includes(pr));
  const g2 = group(rec.length ? 'Other shapes' : 'Profiles');
  for (const pr of others) opt(g2, pr.id, pr.name);
  if (customProfile) opt(null, 'custom', customProfile.name);
  opt(null, 'upload', 'Custom — upload CSV (time_s, power_W)…');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function initProfiles() {
  const sel = $('selProfile');
  rebuildProfileSelect(null);
  sel.onchange = () => {
    if (sel.value === 'upload') { $('profileFile').click(); return; }
    state.profileId = sel.value || null;
    if (state.profileId) {
      state.profileScaleW = customScaleOr(parseFloat($('rqPp').value) || 1000);
      applyProfileToRequirements();
    }
    renderProfile();
  };
  $('profileFile').onchange = async () => {
    const file = $('profileFile').files[0];
    if (!file) return;
    try {
      customProfile = parseProfileCSV(await file.text());
      state.profileId = 'custom';
      state.profileScaleW = customProfile.uploadedPeakW;
      rebuildProfileSelect(state.presetId);
      $('selProfile').value = 'custom';
      applyProfileToRequirements();
    } catch (e) {
      $('profileStatsLine').innerHTML = `<span style="color:var(--missing)">✗ ${esc(e.message)}</span>`;
    }
    $('profileFile').value = '';
    renderProfile();
  };
  // The obvious path for "I have my own measurements": one button, one
  // sample file showing the exact format.
  $('btnProfileUpload').onclick = () => $('profileFile').click();
  $('btnProfileSample').onclick = () => {
    const csv = 'time_s,power_W\n' +
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map((t) => `${t},${[120, 450, 890, 1200, 300, -200, 640, 980, 210, 60][t]}`)
        .join('\n') + '\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'load-profile-sample.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('btnProfileApply').onclick = () => { applyProfileToRequirements(); renderProfile(); };
}

const customScaleOr = (fallback) =>
  state.profileId === 'custom' && customProfile ? customProfile.uploadedPeakW : fallback;

// The profile drives the scalar requirements: RMS (heating-equivalent) sets
// the continuous power, the true peak sets the peak power.
function applyProfileToRequirements() {
  const prof = currentProfile();
  if (!prof || !state.profileScaleW) return;
  const st = profileStats(prof, state.profileScaleW);
  $('rqPc').value = Math.round(st.rmsW);
  $('rqPp').value = Math.round(st.peakW);
  recompute();
}

function renderProfile() {
  const prof = currentProfile();
  const canvas = $('profileChart');
  const line = $('profileStatsLine');
  $('btnProfileApply').style.display = prof ? 'block' : 'none';
  canvas.style.display = prof ? 'block' : 'none';
  if (!prof) { line.textContent = ''; return; }
  const scale = state.profileScaleW || 1000;
  const st = profileStats(prof, scale);
  drawProfileChart(canvas, prof, scale);
  const dur = st.durationS >= 3600 ? `${f1(st.durationS / 3600)} h` : `${f0(st.durationS)} s`;
  line.innerHTML = `${esc(prof.note)}<br><b>${dur}</b> pass · peak <b>${f0(st.peakW)} W</b> ·
    RMS <b>${f0(st.rmsW)} W</b> · mean <b>${f0(st.meanW)} W</b> ·
    ${st.crestFactor ? `crest ${f1(st.crestFactor)}× · ` : ''}energy/pass <b>${f0(st.energyPerPassWh)} Wh</b>
    ${st.regenWh > 0.5 ? ` · regen ${f0(st.regenWh)} Wh` : ''}`;
}

function drawProfileChart(canvas, prof, scaleW, forExport = false) {
  const dpr = forExport ? 2 : Math.min(window.devicePixelRatio || 1, 2);
  const W = forExport ? 640 : (canvas.clientWidth || 300);
  const H = forExport ? 150 : 110;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n, fb) => forExport ? fb :
    (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  g.fillStyle = forExport ? '#ffffff' : css('--ground', '#f4f6f5');
  g.fillRect(0, 0, W, H);
  const vals = prof.p;
  const maxAbs = Math.max(...vals.map(Math.abs), 1e-9);
  const pad = 6;
  const zeroY = vals.some((v) => v < 0) ? H * 0.62 : H - pad;
  const yOf = (v) => zeroY - (v / maxAbs) * (zeroY - pad);
  const xOf = (i) => pad + (i / (vals.length - 1)) * (W - 2 * pad);
  // zero line
  g.strokeStyle = css('--line', '#ccc'); g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, zeroY); g.lineTo(W - pad, zeroY); g.stroke();
  // filled discharge (teal) and charge (amber) areas
  const drawArea = (sign, color) => {
    g.fillStyle = color; g.globalAlpha = 0.25;
    g.beginPath(); g.moveTo(xOf(0), zeroY);
    vals.forEach((v, i) => g.lineTo(xOf(i), yOf(sign === 1 ? Math.max(0, v) : Math.min(0, v))));
    g.lineTo(xOf(vals.length - 1), zeroY); g.closePath(); g.fill();
    g.globalAlpha = 1;
  };
  drawArea(1, '#0b6e5f');
  if (vals.some((v) => v < 0)) drawArea(-1, '#b4441f');
  // trace
  g.strokeStyle = css('--accent', '#0b6e5f'); g.lineWidth = 1.5;
  g.beginPath();
  vals.forEach((v, i) => i ? g.lineTo(xOf(i), yOf(v)) : g.moveTo(xOf(i), yOf(v)));
  g.stroke();
  // peak label
  g.fillStyle = css('--muted', '#666'); g.font = '10px ui-monospace, monospace';
  g.fillText(`peak ${Math.round(scaleW)} W`, pad + 2, 12);
  if (vals.some((v) => v < 0)) g.fillText('below line = charging/regen', pad + 2, H - 4);
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
    if (t.dataset.tab === 'eu') renderEu();
    updateFlowBar(t.dataset.tab);
  });
  buildFlowBar();
  bindCellModal();
  bindResults();

  $('selCell').onchange = () => { state.cellId = $('selCell').value; onCellChange(); recompute(); };

  // The dropdown stays for anyone who knows the part they want. The picker is
  // for everyone else: filter the field down, then compare the survivors as
  // the pack actually being designed.
  picker = new CellPicker(
    () => ({ s: state.s, p: state.p, opts: layoutOpts(coolingSpace()) }),
    (id) => {
      state.cellId = id;
      $('selCell').value = id;
      onCellChange();
      recompute();
      picker.render(id);
    },
    () => myCells);
  $('btnBrowse').onclick = () => {
    const panel = $('cellPicker');
    panel.hidden = !panel.hidden;
    $('btnBrowse').textContent = panel.hidden
      ? 'Browse and compare cells' : 'Hide the cell list';
    if (!panel.hidden) picker.render(state.cellId);
  };
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
  // CAD outline upload: stop the double work — read the bay straight from
  // the engineer's existing drawing.
  $('btnBayUpload').onclick = () => $('bayFile').click();
  $('bayFile').onchange = async () => {
    const file = $('bayFile').files[0];
    if (!file) return;
    try {
      const res = parseOutline(file.name, await file.text());
      setBayKind('poly');
      state.sketchPts = res.points;
      drawSketch();
      $('bayFileInfo').innerHTML = `✓ ${esc(file.name)} (${esc(res.source)}): ${res.vertexCount} points, ` +
        `${f0(res.bbox.x)} × ${f0(res.bbox.y)} mm — check the size looks right (units are read as mm), ` +
        `set the height below, then run Max fill.`;
    } catch (e) {
      $('bayFileInfo').innerHTML = `<span style="color:var(--missing)">✗ ${esc(e.message)}</span>`;
    }
    $('bayFile').value = '';
  };
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
  // Architecture controls: topology and isolation standard are explicit
  // choices; the numeric assumptions live behind the details block.
  $('segTopo').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.archTopology = b.dataset.topo;
    $('segTopo').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    runArchitecture();
  });
  $('segIso').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.archIso = b.dataset.iso;
    $('segIso').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    runArchitecture();
  });
  // Architecture assumptions and the advanced duty inputs feed the
  // Electrical pane and the cost model, so a change re-runs the full audit.
  for (const id of ['archCh', 'archCap', 'archTpre', 'archRep', 'archTs', 'rqRacks', 'rqDod']) {
    $(id).onchange = recompute;
  }
  // Climate & season: the picker fills the env-temp window; the design case
  // is "All year" (the full span), a season button shows what that season
  // does to the system temperature.
  $('selClimate').onchange = () => { state.climateId = $('selClimate').value; applySeason(); };
  $('segSeason').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.seasonId = b.dataset.season;
    $('segSeason').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    applySeason();
  });
  $('btnExport').onclick = exportJSON;
  $('btnTheme').onclick = toggleTheme;
}

function applySeason() {
  const cl = climateById(state.climateId);
  if (!cl) return;
  const band = state.seasonId === 'all' ? climateSpan(cl) : cl.seasons[state.seasonId];
  if (band) {
    $('rqTlo').value = band[0];
    $('rqThi').value = band[1];
  }
  recompute(); // env window feeds the standards + thermal checks directly
}

function renderSeasonTable() {
  const box = $('seasonTable');
  if (!box) return;
  const cl = climateById(state.climateId);
  if (!cl || !lastSummary) { box.innerHTML = ''; return; }
  const rows = seasonalOutlook(cl, cell(), lastAnalysis?.totals?.tempRiseContC ?? null);
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  box.innerHTML = rows.map((r) => `
    <div class="stat"><span>${cap(r.season)} · ${r.ambientC[0]}…${r.ambientC[1]} °C ambient</span>
      <b><span class="chip ${r.severity}">${r.severity}</span>
      system ~${Math.round(r.systemHiC)} °C${r.flags.length ? ` — ${esc(r.flags[0])}` : ''}</b></div>`).join('') +
    `<div class="hint">System temperature = seasonal ambient high + the pack's ~${f1(lastAnalysis?.totals?.tempRiseContC ?? 0)} °C heat rise at continuous load.</div>`;
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
// One place that turns the current UI state into engine options, so the
// design tab and the cell comparison cannot drift apart.
function layoutOpts(cool) {
  return {
    arrangement: state.arrangement, orientation: state.orientation,
    spacingMm: state.spacingMm, wallMm: state.wallMm,
    headroomMm: state.headroomMm, layerGapMm: state.layerGapMm,
    underMm: cool.bottom, rowExtraMm: cool.rowGap,
    nx: state.nx, nz: state.nz,
  };
}

let picker = null;
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
  $('wzSub').textContent = 'Best three for your space, balanced for energy, lifetime cost and weight. Tap one — then choose cooling plates, cell spacers, thermal interface materials and suppliers under “Components”.';
  $('wzBack').style.visibility = 'visible';
  $('wzBack').onclick = wizardStep2;
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const results = maxFill(allCells(),
    { x: num('fitX'), y: num('fitY'), z: num('fitZ') },
    {
      vRange: [num('rqVlo') ?? 1, num('rqVhi') ?? 1000],
      energyWh: (num('rqWh') ?? 0) > 0 ? num('rqWh') : null,
      contPowerW: num('rqPc'),
      cyclesPerYear: num('rqCy'), targetYears: num('rqYr'), dod: currentDod(),
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
    body.innerHTML = '<div class="empty">That space is smaller than any single cell in the library — the closest possible solution starts with a few more millimetres. Go back and add a little room.</div>';
    return;
  }
  lastFillResults = results;
  body.innerHTML = '';
  results.forEach((r, i) => {
    const why = [
      i === 0 ? 'Best overall balance' : (r.pareto ? 'A different trade-off — nothing beats it on all counts' : 'Runner-up'),
      r.targetEnergyWh && !r.meetsEnergy
        ? `the most possible in your space — ${f0(r.energyCoverage * 100)}% of the ${fWh(r.targetEnergyWh)} target`
        : null,
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
  { tab: 'comp', num: '4', label: 'Components & suppliers' },
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
  const usage = { cyclesPerYear: nv('rqCy'), targetYears: nv('rqYr'), dod: currentDod() };
  const gf = currentGridFactor();
  const costM = costModel(c, lastSummary.cellCount, lastSummary.energyWh, usage);
  const co2M = co2Model({
    cell: c, energyWh: lastSummary.energyWh,
    cyclesPerYear: usage.cyclesPerYear, targetYears: usage.targetYears,
    gridGPerKWh: gf.g, dod: usage.dod,
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
    findings: [...engFindings, ...lastArchFindings, ...lastFindings],
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
    architecture: lastArch,
    archPng: (() => {
      if (!lastArch) return null;
      const off = document.createElement('canvas');
      drawArchDiagram(off, lastArch, lastSummary, true);
      return off.toDataURL('image/png');
    })(),
    loadProfile: (() => {
      const prof = currentProfile();
      if (!prof || !state.profileScaleW) return null;
      const chk = profileChecks(prof, state.profileScaleW, {
        nominalV: lastSummary.nominalV, energyWh: lastSummary.energyWh,
        maxContCurrentA: lastSummary.maxContCurrentA,
        maxPulseCurrentA: lastSummary.maxPulseCurrentA,
        maxChargeCurrentA: lastSummary.maxChargeCurrentA,
      }, c);
      const off = document.createElement('canvas');
      drawProfileChart(off, prof, state.profileScaleW, true);
      return { name: prof.name, note: prof.note, stats: chk.stats, findings: chk.findings, chartPng: off.toDataURL('image/png') };
    })(),
    disclaimer: `${ANALYSIS_DISCLAIMER} ${DISCLAIMER}`,
  };
}

function currentReportHTML() {
  return buildReportHTML(currentReportData());
}

function renderResults() {
  renderRadar();
  if (!lastSummary) return;
  $('reportView').innerHTML = currentReportHTML();
}

// The radar reads the picker's ticks, so "compare these" means the same thing
// in both tabs rather than each keeping its own idea of the selection.
function renderRadar() {
  const canvas = $('radarCanvas');
  if (!canvas) return;
  const ids = picker ? [...picker.selected] : [];
  const cells = ids.map(cellFind).filter(Boolean).slice(0, SERIES.length);
  const enough = cells.length >= 2;
  $('radarEmpty').hidden = enough;
  canvas.hidden = !enough;
  $('radarLegend').innerHTML = '';
  $('radarGaps').textContent = '';
  $('radarTable').innerHTML = '';
  $('radarNote').textContent = '';
  if (!enough) return;

  drawRadar(canvas, cells, { height: 400 });
  $('radarLegend').innerHTML = cells.map((c, i) =>
    `<span class="k"><span class="rdrkey" style="background:${SERIES[i]}"></span>${c.name}</span>`
  ).join('');
  const gaps = missingNotes(cells);
  $('radarGaps').textContent = gaps.length
    ? `Skipped, not scored as zero — ${gaps.join(' · ')}` : '';
  $('radarTable').innerHTML = radarTable(cells);
  $('radarNote').textContent =
    'Each axis is scored against a fixed market range, not against the cells on '
    + 'screen, so a small shape means genuinely small rather than merely smaller '
    + 'than its neighbour. Value points outward when $/kWh is LOW. Thermal safety '
    + 'is a chemistry-class figure, not a measurement of this cell. Read the '
    + 'numbers below for the values themselves — a radar shows the shape of a '
    + 'compromise, and its enclosed area depends on the order of the axes.';
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

// Tiny polygon sketcher: adaptive world width (grows to fit imported CAD
// outlines), 50 mm snap for hand drawing.
let sketchDrag = null;
function sketchWorld() {
  const pts = state.sketchPts;
  if (!pts.length) return 1500;
  const span = Math.max(...pts.map((p) => p[0]), ...pts.map((p) => p[1]));
  return Math.max(1500, span * 1.15);
}
function sketchScale() {
  const c = $('sketch');
  return (c.clientWidth || 300) / sketchWorld();
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
  const world = sketchWorld();
  const gridStep = world > 4000 ? 500 : 100;
  g.strokeStyle = css('--line', '#ddd'); g.lineWidth = 0.5;
  for (let mm = 0; mm <= world; mm += gridStep) {
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
  const pv = provenance(c);
  $('cellHint').innerHTML =
    `${c.form} ${c.formFactor} · <b style="color:${ch?.color}">${c.chemistry}</b> · ` +
    `${f1(c.nominalV)} V · ${f1(c.capacityAh)} Ah · ${f0(c.massG)} g · ` +
    `<span class="prov prov-${pv.tone}">${pv.label}</span>` +
    (pv.contribUid ? ` <span class="provuid">${pv.contribUid}</span>` : '') +
    `<div class="provdetail">${pv.detail}</div>`;
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
    lastLayout = null; lastSummary = null; lastFindings = []; lastAnalysis = null; lastArch = null;
    const emptyMsg = '<div class="empty">Over the cell cap — no pack computed.</div>';
    $('archBody').innerHTML = emptyMsg;
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
  const opts = layoutOpts(cool);
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
  renderCompLegend();
  if (document.querySelector('#pane-eu.active')) renderEu();
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
      { cyclesPerYear: nv('rqCy'), targetYears: nv('rqYr'), dod: currentDod() });
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

  // The architecture is part of the electrical picture, not a separate
  // world: compute it first, then fold its findings into the Electrical
  // pane, the pass/fail badge and the report.
  runArchitecture();
  lastArchFindings = archElectricalFindings();

  const perspectives = lastAnalysis?.perspectives || {};
  const engFindings = ['mechanical', 'thermal', 'electrical', 'safety']
    .flatMap((k) => perspectives[k] || []);
  const all = [...engFindings, ...lastArchFindings, ...lastFindings];
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
  renderPane('anElec', [...(perspectives.electrical || []), ...lastArchFindings]);
  renderPane('anSafe', perspectives.safety);
  $('findings').innerHTML = lastFindings.map(findingHtml).join('');
  $('stdList').innerHTML = STANDARDS_INFO.map((s) =>
    `<div style="margin-bottom:4px"><b>${esc(s.code)}</b> — ${esc(s.title)}</div>`).join('');
  renderSeasonTable();
}

// The architecture seen through the Electrical perspective: droop with the
// interconnect lump, the isolation floor, the precharge necessity and the
// communication bus the application expects — folded into the same audit
// list as the busbar/creepage findings so nothing lives in a silo.
function archElectricalFindings() {
  const A = lastArch, S = lastSummary;
  if (!A || !S) return [];
  const out = [];
  const R = A.resistance;
  if (R.totalMOhm != null && R.droopVAtCont != null) {
    const pct = (R.droopVAtCont / S.nominalV) * 100;
    out.push({
      severity: pct > 8 ? 'warn' : 'info',
      title: 'Voltage droop with interconnect resistance',
      detail: `R_pack ≈ ${f1(R.totalMOhm)} mΩ (cells ${f1(R.cellsMOhm)} + interconnect ${f0(R.interconnectMOhm)} mΩ) drops ~${f1(R.droopVAtCont)} V (${f1(pct)}% of nominal) at max continuous current — busbars, joints and contactors must be sized for it.`,
      ref: 'R_pack = S·R_cell/P + R_interconnect', category: 'architecture',
    });
  }
  out.push(A.isolation ? {
    severity: 'info',
    title: `Isolation floor ${f0(A.isolation.floorKOhm)} kΩ (${A.isolation.standardLabel})`,
    detail: `${A.isolation.ohmsPerVolt} Ω/V at ${f1(S.vMax)} V max. ${A.isolation.oemPracticeNote}`,
    ref: A.isolation.standardLabel, category: 'architecture',
  } : {
    severity: 'pass',
    title: 'Low voltage — no isolation-monitoring burden',
    detail: 'The pack stays at or below the 60 V DC boundary, so HVIL and isolation monitoring are not required — the reason 48 V architectures exist.',
    ref: 'UN ECE R100', category: 'architecture',
  });
  if (A.precharge) {
    out.push({
      severity: 'info',
      title: 'Precharge path required for the capacitive DC link',
      detail: `A ${f1(A.precharge.rOhm)} Ω resistor brings the link within ${A.precharge.closeGapV} V in ${A.precharge.timeToCloseS} s before the main positive contactor closes — without it the contacts see a near-short inrush on every start.`,
      ref: 'τ = RC · E = ½CV²', category: 'architecture',
    });
  }
  if (A.comms) {
    out.push({
      severity: 'info',
      title: `Communication: ${A.comms.primary}`,
      detail: `${A.comms.note}${A.comms.alternates?.length ? ` Alternates: ${A.comms.alternates.join('; ')}.` : ''}`,
      ref: 'application practice', category: 'architecture',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Architecture — modules, BMS topology and the HV chain (contactors,
// precharge, fuse, DC-DC, isolation). Math in js/architecture.js.
// ---------------------------------------------------------------------------
function archOptions() {
  const n = (id, dflt) => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : dflt; };
  const target = parseFloat($('rqWh').value);
  return {
    topology: state.archTopology,
    isolationStandard: state.archIso,
    channelsPerIc: clamp(Math.round(n('archCh', 16)), 2, 25),
    linkCapUF: n('archCap', 500),
    prechargeTimeS: n('archTpre', 0.5),
    prechargesPerHour: n('archRep', 4),
    cellsPerTempSensor: Math.max(1, Math.round(n('archTs', 6))),
    targetEnergyWh: isFinite(target) && target > 0 ? target : null,
    // BESS containers, ships and buses often fix the stack count up front —
    // an explicit racks input (Advanced settings) overrides the auto plan.
    racksOverride: (() => { const v = parseFloat($('rqRacks').value); return isFinite(v) && v >= 1 ? v : null; })(),
    appId: state.presetId,
  };
}

function runArchitecture() {
  if (!lastSummary) return;
  try {
    lastArch = buildArchitecture({
      cell: cell(), s: state.s, p: state.p, summary: lastSummary, options: archOptions(),
    });
  } catch (e) {
    console.error('architecture failed', e);
    lastArch = null;
  }
  renderArchitecture();
}

function renderArchitecture() {
  const box = $('archBody');
  const A = lastArch;
  if (!A) { box.innerHTML = '<div class="empty">—</div>'; return; }
  const P = A.partition, B = A.bms, PR = A.precharge, K = A.contactors, R = A.resistance;
  const stat = (k, v) => `<div class="stat"><span>${esc(k)}</span><b>${v}</b></div>`;
  const note = (t) => `<div class="hint">${esc(t)}</div>`;
  const rows = [];
  rows.push(stat('Structure', P.virtual
    ? `cell-to-pack — one virtual group (no physical module tier)`
    : `${P.nModules} modules of ${P.sMod}S${P.pMod}P`));
  if (!P.virtual) {
    rows.push(stat('Per module', `${f1(P.moduleVoltageMaxV)} V max · ${fWh(P.moduleEnergyWh)} · ${f1(P.moduleMassCellsKg)} kg cells · ${P.senseWiresPerModule} sense wires`));
  }
  if (A.system && (A.system.racks > 1 || A.system.overridden)) {
    rows.push(stat('System scale', A.system.overridden
      ? `you set ${A.system.racks} stacks — ${fWh(A.system.totalWh)} total${A.system.targetWh ? ` (${f0(A.system.coveragePct)}% of your ${fWh(A.system.targetWh)} target)` : ''}; this tool models ONE stack, each with its own contactors, fuse and BMS string`
      : `your ${fWh(A.system.targetWh)} target needs ${A.system.racks} packs (racks) of this design in parallel — this tool models ONE pack; each rack keeps its own contactors, fuse and BMS string`));
  }
  rows.push(stat('Voltage class', `${esc(A.voltageClass.label)}`));
  rows.push(stat('BMS', `${esc(B.topologyInfo?.name || B.topology)} · ${B.afeTotal}× AFE (${B.channelsPerIc} ch) · ${B.senseWiresTotal} sense wires · ${B.tempSensors} temp sensors (1:${B.cellsPerTempSensor})`));
  if (A.comms) {
    rows.push(stat('Communication', `${esc(A.comms.primary)}${A.comms.alternates?.length ? ` · alt: ${esc(A.comms.alternates.join('; '))}` : ''}`));
  }
  if (PR) {
    rows.push(stat('Precharge', `${f1(PR.rOhm)} Ω · within ${PR.closeGapV} V in ${PR.timeToCloseS} s · ${f0(PR.energyPerEventJ)} J/event · avg ${f1(PR.avgPowerDuringEventW)} W during event`));
    rows.push(stat('Sequence', PR.sequence.map((x, i) => `${i + 1}. ${esc(x)}`).join('<br>')));
  }
  rows.push(stat('Contactors', `2 mains + 1 precharge · rated ≥${f0(K.ratingA)} A cont. · ~${f0(K.massEachG)} g each (weak fit — budgeting only)`));
  rows.push(stat('Fuse', `≈${f0(K.fuse.ratingA)} A (2× continuous) · operate ≤50% of melting curve · break ≥1.15× worst short`));
  rows.push(stat('Isolation', A.isolation
    ? `≥${f0(A.isolation.floorKOhm)} kΩ floor at ${A.isolation.ohmsPerVolt} Ω/V (${esc(A.isolation.standardLabel)}) — OEM practice >1.5 MΩ`
    : 'not required — pack stays at or below the 60 V DC boundary'));
  rows.push(stat('DC-DC', `${f1(A.dcdc.inputRangeV[0])}–${f1(A.dcdc.inputRangeV[1])} V in → ${A.dcdc.lvBusV} V aux`));
  if (R.totalMOhm != null) {
    rows.push(stat('Pack resistance', `~${f1(R.totalMOhm)} mΩ (cells ${f1(R.cellsMOhm)} + interconnect ${f0(R.interconnectMOhm)}) · droop ~${f1(R.droopVAtCont)} V, loss ~${f0(R.lossWAtCont)} W at max cont.`));
  }
  if (A.welding) {
    rows.push(stat('Cell joining', `${esc(A.welding.primary)}<br>alt: ${esc(A.welding.alternates.join(' · '))}`));
  }
  const notes = [
    ...(P.notes || []), ...(B.notes || []), ...(PR?.notes || []),
    A.dcdc.sizingNote, A.dcdc.chargingNote, K.lvNote,
    A.isolation?.groundingNote, A.comms?.note,
    ...(A.welding ? [...A.welding.cautions,
      'Joining guidance per Lee, Kim, Hu, Cai & Abell — Joining Technologies for Automotive Li-Ion Battery Manufacturing (ASME MSEC2010-34168).'] : []),
  ].filter(Boolean);
  box.innerHTML = rows.join('') + notes.map(note).join('');
  drawArchDiagram($('archCanvas'), A, lastSummary);
}

// One-line diagram of the HV chain: pack (with its modules) → fuse → main
// and precharge contactors → DC link → load, plus BMS and DC-DC. Doubles as
// the report figure via the forExport PNG path (same pattern as the load
// profile chart).
function drawArchDiagram(canvas, A, S, forExport = false) {
  // Fixed 640×250 logical drawing; the on-screen canvas is scaled down by
  // its CSS width, the report PNG uses it at full size.
  const dpr = forExport ? 2 : Math.min(window.devicePixelRatio || 1, 2);
  const W = 640, H = 250;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n, fb) => forExport ? fb :
    (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  const ink = css('--ink', '#1a1a1a'), mut = css('--muted', '#666'), acc = css('--accent', '#0b6e5f');
  g.fillStyle = forExport ? '#ffffff' : css('--ground', '#f4f6f5');
  g.fillRect(0, 0, W, H);
  g.font = '10px ui-monospace, monospace';
  g.lineWidth = 1.2;
  const boxAt = (x, y, w, h, label, sub) => {
    g.strokeStyle = acc; g.strokeRect(x, y, w, h);
    g.fillStyle = ink;
    g.fillText(label, x + 4, y + 13);
    if (sub) { g.fillStyle = mut; g.fillText(sub, x + 4, y + 25); }
  };
  const line = (x1, y1, x2, y2) => {
    g.strokeStyle = mut; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  };
  const P = A.partition;
  // Pack with module slots (or one dashed virtual group).
  boxAt(10, 40, 140, 170, `${S.s}S${S.p}P`, `${Math.round(S.nominalV)} V`);
  const slots = P.virtual ? 1 : Math.min(P.nModules, 6);
  const slotH = 130 / slots;
  for (let i = 0; i < slots; i++) {
    g.strokeStyle = acc;
    if (P.virtual) g.setLineDash([4, 3]);
    g.strokeRect(18, 70 + i * slotH + 2, 124, slotH - 4);
    g.setLineDash([]);
  }
  g.fillStyle = mut;
  g.fillText(P.virtual ? 'cell-to-pack (virtual)' : `${P.nModules}× ${P.sMod}S${P.pMod}P${P.nModules > slots ? ` (${slots} shown)` : ''}`, 20, 66);
  // Positive bus: pack → fuse → K+ (with precharge branch) → link → load.
  line(150, 70, 180, 70);
  boxAt(180, 55, 70, 30, 'Fuse', `${Math.round(A.contactors.fuse.ratingA ?? 0)} A`);
  line(250, 70, 285, 70);
  boxAt(285, 55, 75, 30, 'K+ main', null);
  // Precharge branch over K+.
  line(267, 70, 267, 25); line(267, 25, 285, 25);
  boxAt(285, 12, 55, 26, 'K pre', null);
  line(340, 25, 352, 25);
  // Resistor zigzag.
  g.strokeStyle = mut; g.beginPath(); g.moveTo(352, 25);
  for (let i = 0; i < 6; i++) g.lineTo(356 + i * 7, 25 + (i % 2 ? 7 : -7));
  g.lineTo(400, 25); g.stroke();
  g.fillStyle = mut;
  if (A.precharge) g.fillText(`${(Math.round(A.precharge.rOhm * 10) / 10)} Ω`, 350, 48);
  line(400, 25, 412, 25); line(412, 25, 412, 70);
  line(360, 70, 470, 70);
  // DC link capacitor between the buses.
  line(440, 70, 440, 100); line(430, 100, 450, 100); line(430, 106, 450, 106); line(440, 106, 440, 190);
  g.fillStyle = mut; g.fillText(`${Math.round(A.precharge?.linkCapUF ?? 0)} µF`, 452, 106);
  // Load.
  boxAt(490, 55, 140, 150, 'Inverter / load', null);
  line(470, 70, 490, 70);
  // Negative bus: pack → K− → load.
  line(150, 190, 285, 190);
  boxAt(285, 175, 75, 30, 'K− main', null);
  line(360, 190, 490, 190);
  // DC-DC to LV aux.
  line(420, 190, 420, 215);
  boxAt(380, 215, 100, 28, 'DC-DC', `${A.dcdc.lvBusV} V aux`);
  // The BMS graphic follows the chosen topology, so switching it visibly
  // changes the drawing: a sense-harness fan for centralized, one slave
  // node per module chained to the master for daisy chain, dashed radio
  // links for wireless.
  const topo = A.bms.topology;
  boxAt(10, 218, 96, 28, 'BMS master', `${A.bms.afeTotal}× AFE · ${topo}`);
  const slotY = (i) => 70 + i * slotH + slotH / 2;
  if (topo === 'centralized') {
    // One board, a sense-wire fan to every group.
    for (let i = 0; i < slots; i++) { line(142, slotY(i), 158, slotY(i)); line(158, slotY(i), 158, 232); }
    line(106, 232, 158, 232);
    g.fillStyle = mut; g.fillText(`sense harness (${A.bms.senseWiresTotal} wires)`, 164, 235);
  } else {
    // One slave AFE node per module.
    for (let i = 0; i < slots; i++) { g.strokeStyle = acc; g.strokeRect(128, slotY(i) - 5, 12, 10); }
    if (topo === 'wireless') {
      g.setLineDash([2, 3]);
      for (let i = 0; i < slots; i++) line(128, slotY(i), 60, 218);
      g.setLineDash([]);
      g.fillStyle = mut; g.fillText('wireless links — no harness', 112, 235);
    } else {
      // Daisy chain: master up through every slave in order.
      g.strokeStyle = mut; g.beginPath(); g.moveTo(58, 218);
      g.lineTo(134, slotY(slots - 1) + 5);
      for (let i = slots - 1; i >= 0; i--) g.lineTo(134, slotY(i));
      g.stroke();
      g.fillStyle = mut; g.fillText(`daisy chain (${A.bms.daisyNodes} nodes)`, 112, 235);
    }
  }
  // Closing order.
  g.fillStyle = mut;
  g.fillText('close: K− → K pre → K+ (link within ~10 V) → open K pre', 180, 245);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Usable depth of discharge from Advanced settings, as a 0–1 fraction.
function currentDod() {
  const v = parseFloat($('rqDod').value);
  return isFinite(v) && v >= 10 && v <= 100 ? v / 100 : 0.8;
}

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
    box.innerHTML = '<div class="empty">No library cell lands near those numbers yet — the closest possible solutions open up if you widen the voltage window or relax a constraint, then run again.</div>';
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
    energyWh: (num('rqWh') ?? 0) > 0 ? num('rqWh') : null,
    contPowerW: num('rqPc'),
    cyclesPerYear: num('rqCy'), targetYears: num('rqYr'), dod: currentDod(),
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
    box.innerHTML = '<div class="empty">Even the smallest library cell doesn\'t fit that space yet — the closest possible solution needs a few more millimetres, thinner walls, or a smaller cooling reservation. Loosen one of those and run again.</div>';
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
    // Module structure per candidate, and — when the space can't reach the
    // requested energy — the closest-possible framing with the way to scale
    // up (more bays/racks), never a bare "impossible".
    const part = modulePartition(r.s, r.p, r.cell);
    const plan = r.targetEnergyWh && !r.meetsEnergy ? systemPlan(r.targetEnergyWh, r.energyWh) : null;
    card.innerHTML = `
      <h4>#${i + 1} ${esc(r.cell.name)}
        <span class="chip" style="color:${ch?.color};border-color:${ch?.color}">${r.cell.chemistry}</span>
        ${r.pareto ? '<span class="chip pass">Pareto-optimal</span>' : '<span class="chip info">dominated</span>'}
        ${r.targetEnergyWh ? (r.meetsEnergy ? '<span class="chip pass">meets target</span>' : '<span class="chip warn">closest possible</span>') : ''}</h4>
      <div class="m">${r.s}S${r.p}P · ${f1(r.nominalV)} V · ${r.n}/${r.nMax} cells (${f0(r.utilization * 100)}% of fit) ·
        ${fWh(r.energyWh)} · ${f1(r.massKg)} kg ·
        ${r.grid.nx != null ? `${r.grid.nx}×${r.grid.ny}${r.grid.nz > 1 ? `×${r.grid.nz}` : ''} ` : ''}${r.opts.arrangement}</div>
      <div class="m" style="margin-top:2px">Architecture: ${part.virtual
        ? 'cell-to-pack — one virtual group'
        : `${part.nModules} modules of ${part.sMod}S${part.pMod}P (${f1(part.moduleVoltageMaxV)} V max each)`}</div>
      ${plan ? `<div class="m" style="margin-top:2px;color:#b4441f">The most possible in this space: ${f0(r.energyCoverage * 100)}% of your ${fWh(r.targetEnergyWh)} target.${plan.racks > 1 ? ` ${plan.racks} bays of this design in parallel would cover it.` : ''}</div>` : ''}
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
    architecture: lastArch,
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
