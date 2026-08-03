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
import { co2Model, GRID_FACTORS, buildReportHTML, buildWordDocument, buildArchReportHTML } from './report.js';
import { buildWorkbookXml, workbookFilename } from './excel.js';
import {
  loadMyCells, saveMyCells, normalizeCustomCell, validateCustomCell, buildMailto, OWNER_EMAIL,
} from './mycells.js';
import { sensitivityAnalysis, priceFlipThreshold } from './sensitivity.js';
import { parseOutline } from './bay-import.js';
import {
  LOAD_PROFILES, profileForApp, profilesForApp, profileById, profileStats, profileChecks,
  parseProfileCSV,
} from './loadprofiles.js';
import { climateById, climateSpan, seasonalOutlook, INDOOR_APPS } from './seasons.js';
import { EU_TIMELINE, EU_DISCLAIMER, euChecks } from './eurules.js';
import { buildThermalSystem } from './btms.js';
import { buildSensorPlan } from './sensors.js';
import { simulateMission, compareCells } from './sim1d.js';
import { buildChargingPlan } from './charging.js';
import { v2xPlan } from './v2x.js';
import { shortCircuitStudy } from './shortcircuit.js';
import { renderGuard } from './limits.js';
import { detectRunner, runnerStatusLine, runAdvancedModel, buildFmuOnRunner } from './desktop-link.js';
import {
  vehicleDefaultsFor, traceForApp, driveCyclePower, rangeKm, massShare,
  modeComparison, DRIVING_MODES,
} from './vehicle.js';
import { releaseChecklist, appClassOf } from './markets.js';
import { TRAINING_TRACKS } from './training.js';
import { stepsFor, needed, appNeeds } from './knowledge.js';
import { matchPatents, PATENTS_DISCLAIMER } from './patents.js';
import {
  buildArchitecture, modulePartition, systemPlan, divisors,
  assessBmsTopology, assessEmsArchitecture,
} from './architecture.js';
import { DISCLAIMER, STANDARDS_INFO, standardsForClass, runChecks } from './standards.js';
import { COMPONENT_CATEGORIES, COMPONENT_CLASSES, DEFAULTS_BY_FORM, componentsFor, componentById } from './components.js';
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
  loopOverride: 'auto',    // thermal loop choice (like BMS topology: an input)
  emsOverride: 'auto',     // EMS architecture (only for EMS-bearing applications)
  driveMode: 'normal',     // Eco | Normal | Sport — the driver, not the machine
  v2xPolicy: 'off',        // off | v2l | v2h | v2g | v2v — what you actually build
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
let lastTherm = null;     // thermal management system (loop, BTMS control, costs)
let lastThermFindings = []; // loop-choice verdicts folded into the Thermal pane
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
// Tiny packs are real packs: a 0.44 Wh wearable must never display as
// "0 Wh · 0 kg" — the units adapt to the scale.
const fWh = (v) => v == null ? '—'
  : v >= 5000 ? `${f1(v / 1000)} kWh`
    : v >= 10 ? `${f0(v)} Wh`
      : `${(Math.round(v * 100) / 100).toLocaleString()} Wh`;
const fKg = (v) => v == null ? '—' : (v < 0.0995 ? `${f1(v * 1000)} g` : `${f1(v)} kg`);
// Power stated in kW must never round to "0 kW" — below a kilowatt it
// reads in watts.
const fPow = (kW) => kW == null ? '—' : (kW < 0.9995 ? `${f0(kW * 1000)} W` : `${f1(kW)} kW`);
const fDim = (d) => d ? `${f0(d.x)} × ${f0(d.y)} × ${f0(d.z)} mm` : '—';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function init() {
  initTheme();
  initCellSelect();
  initPresets();
  initProfiles();
  bindVehicle();
  bindShort();
  initRunner();
  bindShort();
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
// so an exploded view stays readable instead of a guessing game. Folded by
// default: the header is always there, the list opens on a click so the
// overlay never covers the render uninvited.
let compLegendOpen = false;
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
  box.innerHTML =
    `<details class="fold"${compLegendOpen ? ' open' : ''}>` +
    `<summary><span class="lbl" style="cursor:pointer">Components in view (${rows.length})</span></summary>` +
    rows.join('') +
    '<div style="color:var(--muted);margin-top:4px">Exploding keeps the cooling hardware visible (it flies apart with the cells); housing and wiring hide while exploded.</div>' +
    '</details>';
  const det = box.querySelector('details');
  det.ontoggle = () => { compLegendOpen = det.open; };
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
  // A grid-facing V2X policy adds interconnection items to this list — the
  // certification cost of the decision, shown where certification lives.
  const cl = releaseChecklist({
    market: state.marketId, application: app, chemistry: cell().chemistry,
    v2x: state.v2xPolicy,
  });
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
let trainSteps = [];
let trainStep = 0;

function startTraining(trackId) {
  trainTrack = TRAINING_TRACKS[trackId];
  // The knowledge graph decides which steps THIS application needs — a
  // wearable never meets the stacks or EMS steps, and the numbering the
  // customer sees stays consecutive.
  trainSteps = stepsFor(trainTrack, state.presetId);
  trainStep = 0;
  showTrainStep();
}

function showTrainStep() {
  const card = $('trainCard');
  if (!trainTrack) { card.style.display = 'none'; return; }
  const st = trainSteps[trainStep];
  document.querySelector(`#tabs .tab[data-tab="${st.tab}"]`)?.click();
  card.style.display = 'block';
  // Titles carry their track-order number, but the graph may have dropped
  // steps for this application — the progress chip is the numbering now.
  $('trainTitle').textContent = st.title.replace(/^\d+[ab]? · /, '');
  $('trainText').textContent = st.text;
  $('trainProg').textContent = `${st.index}/${st.of}`;
  $('trainBack').style.visibility = trainStep === 0 ? 'hidden' : 'visible';
  $('trainNext').textContent = trainStep === trainSteps.length - 1 ? 'Finish ✓' : 'Next →';
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
    if (trainStep >= trainSteps.length - 1) {
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
    computeCharging(); renderCharging();
  });
  // Diagram lightbox: the side panel is narrow, so both architecture
  // drawings open at reading size on a tap (rendered on the white report
  // background at 2× resolution).
  const zoomDiagram = (title, drawFn) => {
    if (!lastArch) return;
    $('diagTitle').textContent = title;
    drawFn($('diagZoom'));
    $('diagModal').style.display = 'flex';
  };
  $('archCanvas').onclick = () =>
    zoomDiagram('System — pack, HV chain & supervisory layer', (c) => drawArchDiagram(c, lastArch, lastSummary, true));
  $('archBmsCanvas').onclick = () =>
    zoomDiagram('Inside the BMS — layer 2', (c) => drawBmsInternals(c, lastArch, true));
  $('thermCanvas').onclick = () => {
    if (!lastTherm) return;
    $('diagTitle').textContent = 'Thermal management system — loop & control';
    drawThermalLoop($('diagZoom'), lastTherm, true);
    $('diagModal').style.display = 'flex';
  };
  $('simCanvas').onclick = () => {
    if (!lastSim || lastSim.unavailable) return;
    $('diagTitle').textContent = 'Mission simulation — power, SoC/voltage, temperature';
    drawSimChart($('diagZoom'), lastSim, true);
    $('diagModal').style.display = 'flex';
  };
  $('segSimSeason').querySelectorAll('button').forEach((b) => b.onclick = () => {
    simSeason = b.dataset.season;
    $('segSimSeason').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    computeSim(); renderSim();
  });
  $('simPasses').onchange = () => {
    simPasses = Math.max(1, Math.min(50, Math.round(parseFloat($('simPasses').value) || 1)));
    $('simPasses').value = simPasses;
    computeSim(); renderSim();
  };
  $('simSoC').onchange = () => {
    simSoC = Math.max(5, Math.min(100, Math.round(parseFloat($('simSoC').value) || 100)));
    $('simSoC').value = simSoC;
    computeSim(); renderSim();
  };
  $('segSimCharge').querySelectorAll('button').forEach((b) => b.onclick = () => {
    simChargeMode = b.dataset.charge;
    $('segSimCharge').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    computeSim(); renderSim();
  });
  $('simChargeMin').onchange = () => {
    simChargeMin = Math.max(1, Math.min(600, Math.round(parseFloat($('simChargeMin').value) || 15)));
    $('simChargeMin').value = simChargeMin;
    computeSim(); renderSim();
  };
  $('segObc').querySelectorAll('button').forEach((b) => b.onclick = () => {
    obcSel = b.dataset.obc;
    $('segObc').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    computeCharging(); renderCharging(); computeSim(); renderSim();
  });
  $('segLoop').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.loopOverride = b.dataset.loop;
    $('segLoop').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    recompute(); // the loop verdict is an Analysis finding, not just a tab row
  });
  $('diagClose').onclick = () => { $('diagModal').style.display = 'none'; };
  $('diagModal').onclick = (e) => { if (e.target === $('diagModal')) $('diagModal').style.display = 'none'; };
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
  // Integration: reserves must scale with the application. A wearable's
  // battery cavity has ~1 mm of structure, not the 2 mm walls + 8 mm
  // busbar headroom of a vehicle pack — those defaults would eat the whole
  // bay. Tiny applications (a few Wh) get watch-scale reserves.
  if (pr.typicalEnergyWh <= 10) {
    state.wallMm = 1; state.headroomMm = 2; state.spacingMm = 0.5;
    syncInputs();
  }
  // Integration: portable-class machines (wearables, drones, tools, robot
  // vacuums, power boxes) are air-cooled by default and have NO pack-level
  // vent hardware — the cell's own venting feature is the vent. The form
  // defaults (liquid plate, pack breather) would drag phantom hardware
  // into the Thermal/Sensors views and the 3D render. Still user-changeable.
  if (appClassOf(pr.id) === 'portable') {
    state.sel.cooling = 'passive-air';
    state.sel.vent = 'none-cell-venting';
    initComponents();
  }
  // Integration: an indoor machine never sees a Nordic winter — picking an
  // indoor application selects the conditioned climate; picking an outdoor
  // one leaves an explicitly-chosen outdoor climate alone.
  if (INDOOR_APPS.has(pr.id)) {
    state.climateId = 'indoor';
  } else if (state.climateId === 'indoor') {
    state.climateId = 'temperate';
  }
  $('selClimate').value = state.climateId;
  // Each application carries its OWN characteristic load shape (a truck-like
  // van is not a rooftop solar plant), plus a short list of alternates the
  // customer can switch between — the dropdown regroups per application.
  fillVehicleInputs(pr.id);
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
  // The physics-derived profile: built from the vehicle, not stored anywhere.
  if (state.profileId === 'vehicle') return lastVehicle?.drive?.profile || null;
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
  // A machine that drives can have its demand DERIVED from its own physics.
  if (appId && vehicleDefaultsFor(appId)) {
    opt(null, 'vehicle', 'From your vehicle — derived from mass & driving mode');
  }
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
    if (state.profileId === 'vehicle') {
      useVehicleProfile();
      return;
    }
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
    if (t.dataset.tab === 'therm') renderThermal();
    if (t.dataset.tab === 'sim') renderSim();
    if (t.dataset.tab === 'sensors') renderSensors();
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
    () => myCells,
    () => { computeSim(); renderSim(); renderRadar(); });
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
    recompute(); // the choice's verdict is an Analysis finding, not just a panel row
  });
  $('segIso').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.archIso = b.dataset.iso;
    $('segIso').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    recompute(); // the choice's verdict is an Analysis finding, not just a panel row
  });
  $('segEms').querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.emsOverride = b.dataset.ems;
    $('segEms').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    recompute(); // the choice's verdict is an Analysis finding, not just a panel row
  });
  // Architecture assumptions and the advanced duty inputs feed the
  // Electrical pane and the cost model, so a change re-runs the full audit.
  for (const id of ['archCh', 'archCap', 'archTpre', 'archRep', 'archTs', 'archSmod', 'rqRacks', 'rqDod']) {
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
  // A new cell shape gets that shape's default component set — but the
  // APPLICATION rule survives the swap: portable-class machines stay
  // air-cooled regardless of which form's defaults just loaded.
  if (c.form !== lastForm) {
    state.sel = { ...DEFAULTS_BY_FORM[c.form] };
    if (appClassOf(state.presetId) === 'portable') {
      state.sel.cooling = 'passive-air';
      state.sel.vent = 'none-cell-venting';
    }
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
      <div class="big">${fWh(r.energyWh)} · ${fKg(r.massKg)}</div>
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
  const download = (content, name, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // The second report: the layered architecture document.
  $('btnArchRep').onclick = () => {
    if (!lastSummary) return;
    download(buildArchReportHTML(currentReportData()),
      `pack-architecture-${cell().id}-${state.s}s${state.p}p.html`, 'text/html');
  };
  // The engineer's workbook: live formulas + the feedback loop.
  $('btnXls').onclick = () => {
    if (!lastSummary) return;
    const R = currentReportData();
    download(buildWorkbookXml(R, { feedbackEmail: OWNER_EMAIL }),
      workbookFilename(R), 'application/vnd.ms-excel');
  };
  // The bridge to any chatbot: the design as data plus a written brief, so an
  // assistant reasons about THIS design instead of about batteries in general.
  $('btnAiBrief').onclick = async () => {
    if (!lastSummary) return;
    const btn = $('btnAiBrief');
    const payload = aiBriefText();
    try {
      await navigator.clipboard.writeText(payload);
      btn.textContent = '✓ Copied — paste it into your assistant';
    } catch {
      // Clipboard refused (permissions, insecure context): give them the file.
      download(payload, 'battery-design-brief.txt', 'text/plain');
      btn.textContent = '✓ Downloaded as a text file';
    }
    setTimeout(() => { btn.textContent = '🤖 Copy this design for an AI assistant'; }, 4000);
  };
}

// A brief an assistant can actually use: what the design IS in words, then
// the machine-readable version, then the honesty note. Customer cell data is
// never included — it stays on the device, as promised.
function aiBriefText() {
  const R = currentReportData();
  const S = lastSummary;
  const lines = [
    'BATTERY PACK DESIGN — generated by battery-design (open source, Apache-2.0).',
    '',
    `Application: ${R.application || 'custom'}`,
    `Cell: ${R.cell?.name} (${R.cell?.chemistry}, ${R.cell?.form})`,
    `Pack: ${S.s}S${S.p}P, ${S.cellCount} cells, ${(S.energyWh / 1000).toFixed(2)} kWh, ${S.nominalV.toFixed(1)} V nominal (${S.vMin.toFixed(1)}–${S.vMax.toFixed(1)} V), ${S.massKg.toFixed(1)} kg, ${Math.round(S.dims.x)}×${Math.round(S.dims.y)}×${Math.round(S.dims.z)} mm`,
  ];
  if (lastVehicle?.drive) {
    lines.push(`Vehicle: ${Math.round(lastVehicle.drive.massKg)} kg moving, ${f1(lastVehicle.drive.whPerKm)} Wh/km in ${lastVehicle.drive.mode.name}${lastVehicle.range != null ? `, about ${Math.round(lastVehicle.range)} km range` : ''}`);
  }
  if (lastCharging?.t2080) {
    lines.push(`Charging: ${lastCharging.obc ? `${lastCharging.obc.acKW} kW on-board charger` : lastCharging.arch.name}, 20→80% in ${fmtH(lastCharging.t2080.hours)}`);
  }
  if (lastV2x?.chosen) lines.push(`Feed-back policy: ${lastV2x.chosen.name} — ${lastV2x.parts.length} parts added`);
  const all = R.findings || [];
  lines.push(`Audit: ${all.filter((f) => f.severity === 'fail').length} fail, ${all.filter((f) => f.severity === 'warn').length} warn`);
  for (const f of all.filter((f) => f.severity === 'fail' || f.severity === 'warn')) {
    lines.push(`  ${f.severity.toUpperCase()}: ${f.title} — ${f.detail}`);
  }
  lines.push('',
    'The JSON below is the same design as structured data.',
    'Figures marked as estimates are estimates: the cell records carry their own data quality, and the',
    'assumptions with no public source are listed in REFERENCES.md section 8. Please do not present',
    'estimated values as datasheet values.',
    '',
    JSON.stringify(aiBriefData(R), null, 2));
  return lines.join('\n');
}

// The structured half of the brief. Deliberately not the whole internal state:
// no canvas images, no private cell library, nothing the customer did not ask
// to share.
function aiBriefData(R) {
  return {
    application: R.application, market: state.marketId,
    cell: {
      id: R.cell?.id, name: R.cell?.name, chemistry: R.cell?.chemistry, form: R.cell?.form,
      nominalV: R.cell?.nominalV, capacityAh: R.cell?.capacityAh,
      priceUSD: R.cell?.priceUSD, cycleLife: R.cell?.cycleLife, dataQuality: R.cell?.dataQuality,
    },
    pack: lastSummary,
    architecture: lastArch ? {
      bms: lastArch.bms?.topology?.name, modules: lastArch.partition?.nModules,
      resistanceMOhm: lastArch.resistance?.totalMOhm,
    } : null,
    thermal: lastTherm ? { loop: lastTherm.loop?.name, verdict: lastTherm.assessment?.verdict } : null,
    charging: lastCharging, v2x: lastV2x,
    vehicle: lastVehicle ? {
      vehicle: lastVehicle.vehicle, whPerKm: lastVehicle.drive?.whPerKm,
      rangeKm: lastVehicle.range, mode: lastVehicle.drive?.mode?.id,
      breakdown: lastVehicle.drive?.breakdown,
    } : null,
    simulation: lastSim && !lastSim.unavailable ? lastSim.summary : null,
    cost: R.cost, co2: R.co2,
    findings: (R.findings || []).map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })),
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
    findings: [...engFindings, ...lastArchFindings, ...lastThermFindings, ...lastSimFindings, ...(lastShort?.findings || []), ...lastFindings],
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
    archAssess: lastArch ? {
      topo: assessBmsTopology({
        topology: lastArch.bms.topology, s: state.s,
        afeTotal: lastArch.bms.afeTotal, nModules: lastArch.partition.nModules,
      }),
      ems: lastArch.emsArch ? assessEmsArchitecture(lastArch.emsArch) : null,
    } : null,
    archPng: (() => {
      if (!lastArch) return null;
      const off = document.createElement('canvas');
      drawArchDiagram(off, lastArch, lastSummary, true);
      return off.toDataURL('image/png');
    })(),
    bmsPng: (() => {
      if (!lastArch) return null;
      const off = document.createElement('canvas');
      drawBmsInternals(off, lastArch, true);
      return off.toDataURL('image/png');
    })(),
    thermal: lastTherm,
    thermPng: (() => {
      if (!lastTherm) return null;
      const off = document.createElement('canvas');
      drawThermalLoop(off, lastTherm, true);
      return off.toDataURL('image/png');
    })(),
    sim: lastSim && !lastSim.unavailable ? lastSim : null,
    simCompare: lastSimCompare,
    charging: lastCharging,
    v2x: lastV2x,
    vehicle: lastVehicle,
    shortCircuit: lastShort,
    simPng: (() => {
      if (!lastSim || lastSim.unavailable) return null;
      const off = document.createElement('canvas');
      drawSimChart(off, lastSim, true);
      return off.toDataURL('image/png');
    })(),
    sensors: lastSensors,
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
  // One collapsible level per component CLASS (electrical / thermal /
  // control / safety / mechanical). Pickers mount inside their class; the
  // read-only members (contactors, precharge, BMS, EMS, standards…) are
  // filled from the live architecture by renderCompClasses().
  const bodies = {};
  for (const k of COMPONENT_CLASSES) {
    const det = document.createElement('details');
    det.className = 'ccls';
    det.id = `ccls-${k.id}`;
    det.open = true;
    det.innerHTML =
      `<summary><b>${k.icon} ${esc(k.name)}</b> <span class="chip" id="cchip-${k.id}">—</span>` +
      `<div class="hint" style="margin:2px 0 0">${esc(k.blurb)}</div></summary>` +
      `<div class="cbody"></div><div class="cder" id="cder-${k.id}"></div>`;
    bodies[k.id] = det.querySelector('.cbody');
    box.appendChild(det);
  }
  for (const { key, name, cls } of COMPONENT_CATEGORIES) {
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
    (bodies[cls] || box).appendChild(sec);
  }
  compClsApp = undefined; // force the open/collapse state to re-derive
  renderCompClasses();
}

// Fill each component class with its live derived members and mark the
// classes this application does NOT need — collapsed with the reason, not
// shown every time. The knowledge graph decides; the live design refines.
let compClsApp; // last app the open/collapsed state was derived for
function renderCompClasses() {
  if (!$('ccls-electrical')) return;
  const app = state.presetId;
  const appName = PRESETS.find((x) => x.id === app)?.name || 'this application';
  const A = lastArch, T = lastTherm;
  const row = (name, val, note) =>
    `<div class="stat"><span>${esc(name)}</span><b style="font-weight:normal;text-align:right">${val}${note ? `<br><span style="color:var(--muted);font-size:11px">${esc(note)}</span>` : ''}</b></div>`;
  const need = { electrical: true, control: true, safety: true, mechanical: true };
  // The GRAPH decides the marking — that is the point: the visibility of a
  // whole class traces to an edge in knowledge.js, not to whatever design
  // happens to be on screen. (The Thermal tab itself always shows the
  // physics of the live design.)
  need.thermal = needed(app, 'btms-loop');

  for (const k of COMPONENT_CLASSES) {
    const chip = $(`cchip-${k.id}`);
    const ok = need[k.id];
    chip.textContent = ok ? 'needed' : `not needed for ${appName}`;
    chip.className = `chip ${ok ? 'pass' : ''}`;
    chip.title = ok ? '' : 'The knowledge graph has no edge from this application to this class — nothing here to choose.';
  }
  // Only clobber the user's open/collapse choices when the application (and
  // with it the neededness) changes — not on every slider move.
  if (compClsApp !== app) {
    compClsApp = app;
    for (const k of COMPONENT_CLASSES) $(`ccls-${k.id}`).open = need[k.id];
  }

  // --- electrical: architecture-derived members --------------------------
  const el = [];
  if (A) {
    const hv = A.precharge != null;
    el.push(row('Contactors', hv ? `${A.contactors.mains} main + ${A.contactors.precharge} precharge` : 'solid-state disconnect (≤60 V)',
      A.contactors.ratingA != null ? `${f0(A.contactors.ratingA)} A class` : null));
    if (hv) el.push(row('Precharge resistor', `${f1(A.precharge.rOhm)} Ω`, `τ = ${A.precharge.tauS.toFixed(2)} s · peak ${fPow(A.precharge.peakPowerW / 1000)}`));
    if (A.contactors.fuse?.ratingA != null) el.push(row('Main fuse', `${f0(A.contactors.fuse.ratingA)} A`, '≈2× continuous current'));
    el.push(row('DC-DC (LV supply)', `${A.dcdc.lvBusV} V bus`, A.dcdc.auxPowerW != null ? `${f0(A.dcdc.auxPowerW)} W aux budget` : 'size from the LV load list'));
    if (A.comms?.primary) el.push(row('Communication bus', esc(A.comms.primary), 'application-standard interface'));
    if (lastCharging) {
      el.push(row('Charging', lastCharging.obc ? esc(lastCharging.obc.name) : esc(lastCharging.arch.name),
        lastCharging.arch.kind === 'obc' ? 'on-board AC charger' : 'no on-board charger to design'));
    }
  }
  $('cder-electrical').innerHTML = el.length
    ? `<div class="hint" style="margin-top:6px">Derived by the architecture (Analysis tab) — shown here so the class is complete:</div>${el.join('')}`
    : '';

  // --- control: the three-unit hierarchy ---------------------------------
  const ct = [];
  if (A) {
    ct.push(row('BMS', esc(A.bms.topologyInfo?.name || A.bms.topology), `${A.bms.afeTotal} AFE${A.bms.afeTotal === 1 ? '' : 's'} · protects the cells`));
    ct.push(row('BTMS', T?.control ? esc(T.control.name) : 'none — no active thermal loop', T?.control ? 'moves the heat' : null));
    if (A.supervisor) ct.push(row('Supervisor', esc(A.supervisor.name), 'decides — the layer above the BMS/BTMS'));
    if (A.emsArch) ct.push(row('EMS architecture', esc(A.emsArch.chosen.name), 'see Analysis → EMS'));
  }
  $('cder-control').innerHTML = ct.length
    ? `<div class="hint" style="margin-top:6px">Control units are designed, not picked from a catalogue — details in Analysis / Thermal:</div>${ct.join('')}`
    : '<div class="hint" style="margin-top:6px">Run a design to see the control units.</div>';

  // --- safety: isolation + the standards gate ----------------------------
  const sf = [];
  if (A?.isolation) sf.push(row('Isolation monitoring', `${f0(A.isolation.ohmsPerVolt)} Ω/V floor`, esc(A.isolation.standardLabel)));
  const cls = appClassOf(app);
  if (cls) {
    const stds = standardsForClass(cls);
    if (stds?.length) sf.push(row('Standards', `${stds.length} apply to ${esc(appName)}`, 'full checklist in the Rules tab'));
  }
  $('cder-safety').innerHTML = sf.length
    ? `<div class="hint" style="margin-top:6px">Beyond the vent hardware, safety is requirements:</div>${sf.join('')}`
    : '';

  // --- thermal: why it is / is not needed --------------------------------
  $('cder-thermal').innerHTML = !need.thermal
    ? `<div class="hint" style="margin-top:6px">${esc(appName)} sheds its heat without a pumped loop${T?.ramAir ? ' (ram air — free airflow in use)' : ''} — nothing to buy here. The pickers stay for what-if studies.</div>`
    : (T?.loop ? `<div class="hint" style="margin-top:6px">Loop: ${esc(T.loop.name)} — the full system (pump, flow, chiller, BTMS) is designed in the Thermal tab.</div>` : '');
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
  // Every panel is contained. If one throws, it says so in its own box and
  // the rest of the design still renders — a blank frozen page helps nobody.
  renderGuard('The analysis', $('findings'), runAnalysis);
  renderGuard('The pack summary', $('statsBody'), renderStats);
  renderGuard('The component legend', null, renderCompLegend);
  renderGuard('The thermal system', $('thermBody'), renderThermal);
  renderGuard('The sensor plan', $('sensorBody'), renderSensors);
  renderGuard('The mission simulation', $('simStats'), renderSim);
  renderGuard('Charging', $('acBody'), renderCharging);
  renderGuard('The vehicle model', $('vehSummary'), renderVehicle);
  renderGuard('The fault study', $('scSummary'), renderShort);
  renderGuard('Component classes', null, renderCompClasses);
  if (document.querySelector('#pane-eu.active')) renderGuard('Release rules', $('euBody'), renderEu);
  renderGuard('Saving the design to the URL', null, saveHash);
}

// ---------------------------------------------------------------------------
// Sensors — the plan by level (cell / module / system / cooling loop).
// Model in js/sensors.js; absent groups are genuinely absent.
// ---------------------------------------------------------------------------
let lastSensors = null;

function renderSensors() {
  const box = $('sensorBody');
  if (!box) return;
  if (!lastSummary || !lastArch) { box.innerHTML = '<div class="empty">—</div>'; lastSensors = null; return; }
  lastSensors = buildSensorPlan({
    cell: cell(), s: state.s, p: state.p, summary: lastSummary,
    partition: lastArch.partition, bms: lastArch.bms,
    therm: lastTherm, selection: selComponents(),
  });
  const stat = (k, v) => `<div class="stat"><span>${esc(k)}</span><b>${v}</b></div>`;
  box.innerHTML = lastSensors.groups.map((gr) => `
    <h3 style="font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 0 4px">${esc(gr.level)}</h3>
    ${gr.sensors.map((sn) => stat(`${sn.count != null ? `${sn.count}× ` : ''}${sn.name}`, `<span style="font-weight:normal">${esc(sn.note)}</span>`)).join('')}`).join('') +
    lastSensors.notes.map((n) => `<div class="hint">${esc(n)}</div>`).join('');
}

// ---------------------------------------------------------------------------
// Thermal management system — loop, BTMS control unit, higher-system cost.
// Model in js/btms.js.
// ---------------------------------------------------------------------------
// Verdict → severity chip: only physics/sourced limits ever read as fail.
const VERDICT_CHIP = {
  suggested: ['pass', 'suggested'],
  workable: ['pass', 'workable'],
  'workable-with-costs': ['warn', 'workable — costs listed'],
  unproven: ['warn', 'unproven'],
  'not-workable': ['fail', 'not workable here'],
};
const verdictChip = (v) => {
  const [sev, label] = VERDICT_CHIP[v] || ['info', v];
  return `<span class="chip ${sev}">${esc(label)}</span>`;
};
// Pros/cons card for a chosen architecture option — the customer sees the
// trade BEFORE living with it.
const assessCard = (a) => a ? `
  ${verdictChip(a.verdict)} <span style="font-size:11.5px">${esc(a.why)}</span>
  <div style="margin-top:3px">${(a.pros || []).map((p) => `<div>✓ ${esc(p)}</div>`).join('')}
  ${(a.cons || []).map((c) => `<div>✗ ${esc(c)}</div>`).join('')}</div>` : '';

function computeThermal() {
  if (!lastSummary) { lastTherm = null; return; }
  const nv = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  lastTherm = buildThermalSystem({
    heatContW: lastAnalysis?.totals?.heatContW ?? null,
    ambientC: [nv('rqTlo') ?? 0, nv('rqThi') ?? 40],
    cooling: selComponents().cooling,
    cell: cell(),
    override: state.loopOverride,
    appId: state.presetId,
  });
}

// ---------------------------------------------------------------------------
// Mission simulation (level 1) — the design run through time. Controls are
// session-local (not persisted); the physics lives in js/sim1d.js.
// ---------------------------------------------------------------------------
let lastSim = null;
let lastSimFindings = [];
let lastSimCompare = null;
let simSeason = 'design', simPasses = 1, simSoC = 100;
let simChargeMode = 'none', simChargeMin = 15;

// ---------------------------------------------------------------------------
// Charging (the AC side, round one). The customer sees ONE plain sentence —
// how this machine charges and how long it takes; everything else lives
// behind the collapsed expert fold. The knowledge graph decides who gets
// the detail at all.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Where am I running? The same interface either way — the desktop runner just
// answers questions the browser cannot compute. Probed once, fails soft.
// ---------------------------------------------------------------------------
let runnerInfo = null;

async function initRunner() {
  runnerInfo = await detectRunner();
  renderRunnerBox();
}

function renderRunnerBox() {
  const box = $('runnerBox');
  if (!box) return;
  const status = runnerStatusLine(runnerInfo);
  if (status.here === 'browser') {
    box.innerHTML = `<div class="hint">${esc(status.text)}</div>`
      + `<div class="hint" style="margin-top:6px;font-family:ui-monospace,monospace;font-size:11px;`
      + `background:var(--surface-2);padding:6px;border-radius:var(--r)">node desktop/bd.mjs serve</div>`;
    return;
  }
  box.innerHTML = `<div class="stat"><span>Running on</span><b style="font-weight:normal;text-align:right">`
    + `your machine · ${runnerInfo.cores} cores</b></div>`
    + `<div class="hint" style="margin-top:4px">${esc(status.text)}</div>`
    + `<button class="btn" id="btnAdvModel" style="width:100%;margin-top:8px">Run the advanced electro-thermal model</button>`
    + `<button class="btn" id="btnFmuExport" style="width:100%;margin-top:6px">Export for co-simulation (FMI 2.0)</button>`
    + `<div id="runnerOut" style="margin-top:8px"></div>`;
  $('btnAdvModel').onclick = async () => {
    const out = $('runnerOut');
    out.innerHTML = '<div class="hint">Running on your machine…</div>';
    try {
      const r = await runAdvancedModel({ spec: currentSpec(), nModules: 6, ambientC: 25 });
      const q = r.summary;
      out.innerHTML = `<div class="stat"><span>Peak module</span><b>${f1(q.maxTempC)} °C</b></div>`
        + `<div class="stat"><span>Module spread</span><b>${f1(q.tempSpreadK)} K</b></div>`
        + `<div class="stat"><span>Coolant out</span><b>${f1(q.coolantOutC)} °C</b></div>`
        + `<div class="stat"><span>Efficiency</span><b>${f1(q.efficiencyPct)}%</b></div>`
        + (r.aging?.schedule?.length
          ? `<div class="stat"><span>Capacity at year ${r.aging.years}</span><b>${f1(r.aging.schedule[r.aging.schedule.length - 1].remainingPct)}%</b></div>` : '')
        + `<div class="hint" style="margin-top:6px">${r.assumptions.slice(0, 3).map(esc).join(' ')}</div>`;
    } catch (e) {
      out.innerHTML = `<div class="hint">Could not run it: ${esc(e.message)}</div>`;
    }
  };
  $('btnFmuExport').onclick = async () => {
    const out = $('runnerOut');
    out.innerHTML = '<div class="hint">Building the FMU…</div>';
    try {
      const fmu = await buildFmuOnRunner({ spec: currentSpec() });
      const names = Object.keys(fmu.files);
      out.innerHTML = `<div class="hint">Built <b>${esc(fmu.modelName)}</b> (${names.length} files, guid `
        + `<span style="font-family:ui-monospace,monospace">${esc(fmu.guid)}</span>). `
        + `Drop it into ANSYS Twin Builder, Simulink, GT-SUITE or Dymola after compiling — `
        + `the build line is in its README.</div>`;
      for (const [name, content] of Object.entries(fmu.files)) {
        saveTextFile(content, name.split('/').pop());
      }
    } catch (e) {
      out.innerHTML = `<div class="hint">Could not build it: ${esc(e.message)}</div>`;
    }
  };
}

// Save a generated file. The export button lives outside the bind closure
// that owns the report downloader, so it gets its own.
function saveTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// The design on screen, as the spec the engine speaks.
function currentSpec() {
  return {
    application: state.presetId || undefined,
    cell: cell().id, s: state.s, p: state.p,
    market: state.marketId, dod: currentDod(),
    v2xPolicy: state.v2xPolicy, driveMode: state.driveMode,
  };
}

// ---------------------------------------------------------------------------
// The fault study — what the pack does in the first milliseconds of a short.
// Model in js/shortcircuit.js. One sentence visible; the race between fuse,
// busbar and thermal runaway is behind the fold.
// ---------------------------------------------------------------------------
let lastShort = null;

function computeShort() {
  if (!lastSummary) { lastShort = null; return; }
  const nv = (id) => { const v = parseFloat($(id)?.value); return isFinite(v) ? v : null; };
  lastShort = shortCircuitStudy({
    cell: cell(), s: state.s, p: state.p, summary: lastSummary,
    busbarAreaMm2: nv('scArea') ?? 50,
    fuseRatingA: nv('scFuse'),
    linkFuseA: nv('scLink'),
    contactorBreakingA: lastArch?.contactors?.breakingA ?? null,
  });
}

function renderShort() {
  const box = $('scSummary');
  if (!box) return;
  const S = lastShort;
  if (!S) { box.innerHTML = '<div class="empty">—</div>'; if ($('scBody')) $('scBody').innerHTML = ''; return; }
  const terminal = S.faults.find((f) => f.kind.id === 'terminal');
  // The plain sentence: how big, how fast, and is that fast enough.
  box.innerHTML = `${verdictChip(S.verdict)} <b>${esc(S.headline)}</b>`
    + `<div class="hint">${esc(terminal.why)}</div>`;
  const body = $('scBody');
  if (!body) return;
  const ms = (v) => v == null ? '—' : `${(v * 1000).toFixed(2)} ms`;
  const row = (k, v, note) =>
    `<div class="stat"><span>${esc(k)}</span><b style="font-weight:normal;text-align:right">${v}${note ? `<br><span style="color:var(--muted);font-size:11px">${esc(note)}</span>` : ''}</b></div>`;
  const rows = S.faults.map((f) => {
    const r = f.result;
    return `<div style="margin-top:8px">${verdictChip(f.verdict)} <b style="font-size:11.5px">${esc(f.kind.name)}</b>`
      + `<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(f.why)}</div>`
      + row('Peak current', `${f1(r.peakA / 1000)} kA`, `rises with the ${(r.timeConstantS * 1e6).toFixed(0)} µs loop time constant`)
      + row('The race', `fuse ${ms(r.fuseClearedAtS)} · busbar ${r.busbarFailedAtS == null ? 'survives' : ms(r.busbarFailedAtS)} · runaway ${r.runawayAtS == null ? 'not reached' : ms(r.runawayAtS)}`, 'the fuse has to be first')
      + (f.contactor ? `<div class="hint" style="margin-top:4px">${esc(f.contactor.note)}</div>` : '')
      + `</div>`;
  }).join('');
  const I = S.internal;
  const internal = `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
      ${verdictChip(I.verdict)} <b style="font-size:11.5px">Internal short inside one parallel group</b>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(I.why)}</div>
      ${row('Neighbours feeding it', `${I.neighbours} cells, ${f0(I.totalIntoFaultA)} A total`, `${f0(I.faultPowerW / 1000)} kW into one can`)}
      ${row('Time to runaway onset', `${ms(I.secondsToOnset)} to ${I.onsetC} °C`, I.linkOpensAtS != null ? `fusible link opens in ${ms(I.linkOpensAtS)}` : 'nothing interrupts it')}
    </div>`;
  body.innerHTML = rows + internal
    + `<div class="hint" style="margin-top:8px">${S.assumptions.map(esc).join(' ')}</div>`;
}

// ---------------------------------------------------------------------------
// The vehicle — mass, driving mode, and the demand that follows from physics
// instead of a typed number. Model in js/vehicle.js.
// ---------------------------------------------------------------------------
let lastVehicle = null;

// The vehicle as it stands on screen: application defaults, then whatever the
// customer changed.
function vehicleFromInputs() {
  const base = vehicleDefaultsFor(state.presetId);
  if (!base) return null;
  const nv = (id, fb) => { const v = parseFloat($(id)?.value); return isFinite(v) ? v : fb; };
  return {
    ...base,
    curbKg: nv('vehMass', base.curbKg),
    payloadKg: nv('vehPayload', base.payloadKg),
    cd: nv('vehCd', base.cd),
    frontalAreaM2: nv('vehArea', base.frontalAreaM2),
    crr: nv('vehCrr', base.crr),
    driveEff: nv('vehEff', base.driveEff),
    regenFrac: nv('vehRegen', base.regenFrac),
    auxW: nv('vehAux', base.auxW),
  };
}

// Application switch: show the card only for machines that actually drive,
// and reload that machine's class defaults.
function fillVehicleInputs(appId) {
  const d = vehicleDefaultsFor(appId);
  const sec = $('vehSec');
  if (!sec) return;
  sec.style.display = d ? '' : 'none';
  if (!d) return;
  $('vehMass').value = d.curbKg;
  $('vehPayload').value = d.payloadKg;
  $('vehCd').value = d.cd;
  $('vehArea').value = d.frontalAreaM2;
  $('vehCrr').value = d.crr;
  $('vehEff').value = d.driveEff;
  $('vehRegen').value = d.regenFrac;
  $('vehAux').value = d.auxW;
  $('vehGrade').value = 0;
}

function computeVehicle() {
  const vehicle = vehicleFromInputs();
  const trace = traceForApp(state.presetId);
  if (!vehicle || !trace) { lastVehicle = null; return; }
  // The pack the customer just designed is part of the mass the wheels carry.
  const packMassKg = lastSummary?.massKg ?? 0;
  const gradeRaw = parseFloat($('vehGrade')?.value);
  const gradePct = isFinite(gradeRaw) ? gradeRaw : 0;
  // Regen cannot exceed what the pack will accept — the charging model
  // already knows that number, so the two stay consistent.
  const regenCapW = lastCharging?.packChargeKW != null ? lastCharging.packChargeKW * 1000 : null;
  const drive = driveCyclePower({ trace, vehicle, mode: state.driveMode, packMassKg, gradePct, regenCapW });
  if (!drive) { lastVehicle = null; return; }
  const dod = currentDod();
  const energyWh = lastSummary?.energyWh ?? 0;
  lastVehicle = {
    vehicle, trace, drive, packMassKg, gradePct, dod,
    range: rangeKm({ energyWh, dod, whPerKm: drive.whPerKm }),
    share: massShare({ vehicle, packMassKg }),
    modes: energyWh > 0
      ? modeComparison({ trace, vehicle, packMassKg, gradePct, energyWh, dod, regenCapW })
      : [],
  };
}

function renderVehicle() {
  const box = $('vehSummary');
  if (!box) return;
  const V = lastVehicle;
  if (!V) { box.innerHTML = ''; if ($('vehBody')) $('vehBody').innerHTML = ''; return; }
  const D = V.drive;
  // The plain sentence: what it drinks, and how far this pack takes it.
  // Range is always the range of the pack ON SCREEN. If that pack is nowhere
  // near what this application normally needs, say so — otherwise a 5 km
  // answer reads as a broken tool instead of a tiny pack.
  const pr = PRESETS.find((p) => p.id === state.presetId);
  const typicalWh = pr?.typicalEnergyWh;
  const haveWh = lastSummary?.energyWh;
  const offBy = typicalWh && haveWh && (haveWh < typicalWh * 0.5 || haveWh > typicalWh * 2);
  box.innerHTML = `<b>${f1(D.whPerKm)} Wh/km</b> in ${esc(D.mode.name)}` +
    (V.range != null ? ` · <b>about ${f0(V.range)} km</b> on this pack` : '') +
    `<div class="hint">${f0(D.massKg)} kg moving, including ${f0(V.packMassKg)} kg of battery. ` +
    `Peak ${f1(D.peakW / 1000)} kW on the ${esc(V.trace.name.toLowerCase())}.</div>` +
    (offBy ? `<div class="hint">That range is for the pack currently on the Design tab (${f1(haveWh / 1000)} kWh). ` +
      `A ${esc(pr.name)} usually needs around ${f0(typicalWh / 1000)} kWh — size it with “From usage” and this updates.</div>` : '');
  const body = $('vehBody');
  if (!body) return;
  const b = D.breakdown;
  const spent = b.rolling + b.aero + b.grade + b.accel + b.aux;
  const pct = (x) => spent > 0 ? `${Math.round((x / spent) * 100)}%` : '—';
  const row = (k, v, note) =>
    `<div class="stat"><span>${esc(k)}</span><b style="font-weight:normal;text-align:right">${v}${note ? `<br><span style="color:var(--muted);font-size:11px">${esc(note)}</span>` : ''}</b></div>`;
  const rows = [
    row('Moving mass', `${f0(D.massKg)} kg`, `${f0(V.vehicle.curbKg)} kg vehicle + ${f0(V.vehicle.payloadKg)} kg payload + ${f0(V.packMassKg)} kg pack`),
    row('Rolling resistance', `${f0(b.rolling)} Wh (${pct(b.rolling)})`),
    row('Aerodynamic drag', `${f0(b.aero)} Wh (${pct(b.aero)})`),
    row('Acceleration', `${f0(b.accel)} Wh (${pct(b.accel)})`, 'ends up in the brakes, minus what regen takes back'),
    ...(Math.abs(b.grade) > 1 ? [row('Gradient', `${f0(b.grade)} Wh (${pct(b.grade)})`, `${V.gradePct}% climb`)] : []),
    row('Auxiliaries', `${f0(b.aux)} Wh (${pct(b.aux)})`, `${f0(D.auxW)} W held for the whole ${f0(D.durationS / 60)} min`),
    row('Recovered by regen', `${f0(b.recovered)} Wh`, D.regenFrac > 0 ? `${Math.round(D.regenFrac * 100)}% of braking energy returns to the pack` : 'no regenerative braking on this machine'),
    row('Cycle', `${f1(D.distanceKm)} km in ${f0(D.durationS / 60)} min`, `average ${f0(D.avgSpeedKmh)} km/h`),
  ];
  // The same vehicle in all three modes — the comparison before choosing a size.
  const modeTable = V.modes.length
    ? `<div style="margin-top:8px"><b style="font-size:12px">Same vehicle, three drivers</b>` +
      V.modes.map((m) => `<div class="stat"><span>${esc(m.mode.name)}${m.mode.id === state.driveMode ? ' (selected)' : ''}</span><b style="font-weight:normal">${f1(m.whPerKm)} Wh/km · ${m.rangeKm != null ? `${f0(m.rangeKm)} km` : '—'}</b></div>`).join('') +
      `</div>` : '';
  body.innerHTML = rows.join('') + modeTable +
    `<div class="hint" style="margin-top:6px">${esc(V.drive.mode.what)} ${esc(V.vehicle.note)}</div>` +
    `<div class="hint" style="margin-top:4px">${esc(V.trace.note)}</div>`;
}

// Hand the physics-derived demand to the rest of the tool: it becomes the
// active load profile, and the scalar requirements follow from it.
function useVehicleProfile() {
  computeVehicle();
  if (!lastVehicle?.drive) return;
  state.profileId = 'vehicle';
  state.profileScaleW = lastVehicle.drive.scaleW;
  const sel = $('selProfile');
  if (sel && ![...sel.options].some((o) => o.value === 'vehicle')) rebuildProfileSelect(state.presetId);
  if (sel) sel.value = 'vehicle';
  applyProfileToRequirements();
  renderProfile();
  renderVehicle();
}

// The fault inputs are design decisions - busbar section, fuse rating, and
// whether per-cell links are fitted - so changing one re-runs the study and,
// since its findings are audit findings, the whole analysis with it.
function bindShort() {
  for (const id of ['scArea', 'scFuse', 'scLink']) {
    const el = $(id);
    if (el) el.onchange = () => recompute();
  }
}

function bindVehicle() {
  const refresh = () => { computeVehicle(); renderVehicle(); if (state.profileId === 'vehicle') useVehicleProfile(); };
  for (const id of ['vehMass', 'vehPayload', 'vehCd', 'vehArea', 'vehCrr', 'vehEff', 'vehRegen', 'vehAux', 'vehGrade']) {
    const el = $(id);
    if (el) el.onchange = refresh;
  }
  $('segDriveMode')?.querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.driveMode = b.dataset.mode;
    $('segDriveMode').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    refresh();
  });
  const apply = $('btnVehApply');
  if (apply) apply.onclick = useVehicleProfile;
}

let lastCharging = null;
let lastV2x = null;
let obcSel = 'auto';

function computeCharging() {
  if (!lastSummary) { lastCharging = null; lastV2x = null; return; }
  lastCharging = buildChargingPlan({
    appId: state.presetId, marketId: state.marketId,
    energyWh: lastSummary.energyWh, vNomV: lastSummary.nominalV,
    cell: cell(), obcOverride: obcSel,
  });
  lastV2x = v2xPlan({
    appId: state.presetId, cell: cell(),
    cellCount: lastSummary.cellCount, energyWh: lastSummary.energyWh,
    dod: currentDod(),
    // The policy is a design decision the customer makes; the export power
    // it can actually sustain comes from the charging path already computed.
    policy: state.v2xPolicy,
    powerKW: lastCharging?.obc?.acKW ?? lastCharging?.packChargeKW ?? null,
  });
}

const fmtH = (h) => h >= 1 ? `${(Math.round(h * 10) / 10)} h` : `${Math.round(h * 60)} min`;

function renderCharging() {
  const sumBox = $('acSummary');
  if (!sumBox) return;
  const C = lastCharging;
  if (!C) { sumBox.innerHTML = '<div class="empty">—</div>'; $('acBody').innerHTML = ''; return; }
  // The one sentence a customer needs — plain words, no jargon.
  const how = C.obc ? `${C.obc.acKW} kW on-board charger` : esc(C.arch.name);
  sumBox.innerHTML = `<b>Charges via:</b> ${how}` +
    (C.t2080 ? ` · <b>20→80% in ${fmtH(C.t2080.hours)}</b>` : '') +
    (C.t10100 ? ` <span style="color:var(--muted)">(full charge ${fmtH(C.t10100.hours)})</span>` : '');
  // Expert fold content.
  $('segObc').style.display = C.arch.kind === 'obc' ? '' : 'none';
  const row = (k, v, note) =>
    `<div class="stat"><span>${esc(k)}</span><b style="font-weight:normal;text-align:right">${v}${note ? `<br><span style="color:var(--muted);font-size:11px">${esc(note)}</span>` : ''}</b></div>`;
  const rows = [];
  rows.push(row('Architecture', esc(C.arch.name)));
  rows.push(row('AC connector (market)', esc(C.iface.connector), `DC: ${C.iface.dcConnector}`));
  rows.push(row('Charge communication', esc(C.iface.comms)));
  if (C.packChargeKW != null) rows.push(row('Pack accepts', `${f1(C.packChargeKW)} kW (${(Math.round(C.chargeC * 10) / 10)}C)`, 'from the cell\'s rated charge current — also the DC fast ceiling'));
  if (C.t2080) rows.push(row('Bottleneck', C.t2080.limitedBy === 'pack' ? 'the pack' : 'the charger', C.t2080.note));
  const strat = C.strategies[0];
  if (strat) {
    rows.push(row('Charging strategy', esc(strat.name),
      C.strategies.length > 1 ? `alternatives: ${C.strategies.slice(1).map((x) => x.name).join(' · ')}` : null));
  }
  // Feeding power back (V2X) — vehicles with a bidirectional port get the
  // per-mode verdicts and the wear floor; storage gets the one honest line
  // ("the PCS already does this"); everyone else hears nothing. All of it
  // stays inside the fold — the plain summary above never changes.
  let v2x = '';
  const V = lastV2x;
  if (V?.applicable) {
    // The policy comes first: what are you actually building? Everything
    // below is the consequence of that answer.
    const btn = (id, label) =>
      `<button data-v2x="${id}"${state.v2xPolicy === id ? ' class="active"' : ''}>${esc(label)}</button>`;
    const B = V.budget;
    v2x = `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
      <b style="font-size:12px">Feeding power back (V2X)</b>
      <div class="seg" id="segV2x" style="margin-top:6px">${btn('off', 'Off')}${V.modes.map((m) => btn(m.id, m.id.toUpperCase())).join('')}</div>
      <div class="hint" style="margin-top:6px">${esc(V.policyNote)}</div>` +
      (B ? `<div class="stat" style="margin-top:6px"><span>Available to export</span><b style="font-weight:normal;text-align:right">${f1(B.exportableWh / 1000)} kWh${B.hours != null ? ` · about ${f1(B.hours)} h at ${f1(B.powerKW)} kW` : ''}<br><span style="color:var(--muted);font-size:11px">${Math.round(B.reserve * 100)}% reserved so the machine still works${B.wearCostUSD != null ? ` · that export costs about $${f1(B.wearCostUSD)} in battery wear` : ''}</span></b></div>` : '') +
      (V.parts.length ? `<div style="margin-top:6px"><b style="font-size:11.5px">What this adds to the design</b>` +
        V.parts.map((p) => `<div style="margin-top:4px;font-size:11.5px">• ${esc(p.part)}<br><span style="color:var(--muted);font-size:11px">${esc(p.why)} <i>${esc(p.standard)}</i></span></div>`).join('') +
        (V.gridFacing ? `<div class="hint" style="margin-top:5px">Grid-facing: the interconnection standards are now on the Rules tab checklist for your market.</div>` : '') +
        `</div>` : '') +
      V.modes.map((m) =>
        `<div style="margin-top:5px">${verdictChip(m.assessment.verdict)} <b style="font-size:11.5px">${esc(m.name)}</b><br><span style="font-size:11px;color:var(--muted)">${esc(m.assessment.why)}</span></div>`).join('') +
      `<div class="hint" style="margin-top:6px">${esc(V.wearNote)}</div></div>`;
  } else if (V && (C.arch.kind === 'pcs' || V.native)) {
    v2x = `<div class="hint" style="margin-top:8px">${esc(V.why)}</div>`;
  }
  $('acBody').innerHTML = rows.join('') +
    (strat ? `<div class="hint" style="margin-top:6px">✓ ${strat.pros.map(esc).join(' · ')}<br>✗ ${strat.cons.map(esc).join(' · ')}</div>` : '') +
    `<div class="hint" style="margin-top:6px">${C.notes.map(esc).join(' ')}</div>` + v2x;
  // The policy buttons are re-rendered with the panel, so they are re-bound
  // with it. Choosing one changes parts, budget and the release checklist.
  $('segV2x')?.querySelectorAll('button').forEach((b) => b.onclick = () => {
    state.v2xPolicy = b.dataset.v2x;
    computeCharging();
    renderCharging();
    if (document.querySelector('#pane-eu.active')) renderEu();
  });
}

function computeSim() {
  const prof = currentProfile();
  const S = lastSummary;
  if (!S || !prof || !state.profileScaleW) {
    lastSim = { unavailable: true, why: 'No load profile applied — pick one on the Usage tab and press "Use profile".' };
    lastSimFindings = [];
    return;
  }
  // Scenario ambient: the design window's hot end by default; the winter /
  // summer stress cases come from the chosen climate's seasonal bands.
  const nv = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const cl = climateById(state.climateId);
  const ambientC = simSeason === 'winter' && cl ? cl.seasons.winter[0]
    : simSeason === 'summer' && cl ? cl.seasons.summer[1]
    : (nv('rqThi') ?? 25);
  // Thermal conductance from the engineering analysis (heat / temperature
  // rise for the selected cooling); geometric fallback for sparse cases.
  const tot = lastAnalysis?.totals;
  const d = S.dims;
  const uaWK = tot?.heatContW > 0 && tot?.tempRiseContC > 0
    ? tot.heatContW / tot.tempRiseContC
    : (d ? (8 * 2 * (d.x * d.y + d.x * d.z + d.y * d.z)) / 1e6 : null);
  // Mission charging: top-ups use the cell's MAXIMUM charge rating
  // (opportunity charging is fast by definition); charging at base uses the
  // standard rate, throttled by the OBC where one exists. Both numbers come
  // from the datasheet, not from thin air.
  const chPowerW = simChargeMode === 'topup'
    ? (lastCharging?.packChargeKW ?? 0) * 1000
    : simChargeMode === 'base'
      ? (lastCharging?.t2080?.dcKW ?? lastCharging?.packChargeKW ?? 0) * 1000
      : 0;
  lastSim = simulateMission({
    cell: cell(), s: state.s, p: state.p,
    profile: prof, scaleW: state.profileScaleW,
    passes: simPasses, startSoC: simSoC / 100,
    ambientC,
    resistanceMOhm: lastArch?.resistance?.totalMOhm ?? undefined,
    uaWK, thermalMassJK: (S.massCellsKg ?? S.massKg ?? 1) * 1000,
    hasHeater: !!lastTherm?.heaterNeeded,
    charge: { mode: simChargeMode, powerW: chPowerW, minutes: simChargeMin },
  });
  lastSimFindings = lastSim.unavailable ? [] : lastSim.findings;

  // Comparison: the compare ticks in the cell picker (the same selection
  // that drives the radar) run the IDENTICAL mission as equivalent packs —
  // so the value of different cells can be weighed on outcomes, not specs.
  const ids = picker ? [...picker.selected] : [];
  const compCells = ids.map(cellFind).filter(Boolean).slice(0, 4);
  const cur = cell();
  if (compCells.length && !compCells.some((c) => c.id === cur.id)) compCells.unshift(cur);
  if (compCells.length >= 2) {
    const cmp = compareCells({
      cells: compCells, targetVNom: S.nominalV, targetEnergyWh: S.energyWh,
      profile: prof, scaleW: state.profileScaleW, passes: simPasses, startSoC: simSoC / 100,
      ambientC, interconnectMOhm: lastArch?.resistance?.interconnectMOhm ?? 0,
      uaWK, hasHeater: !!lastTherm?.heaterNeeded, currentId: cur.id,
    });
    // The VALUE side of the comparison: same duty, each cell's lifetime cost.
    const usage = { cyclesPerYear: nv('rqCy'), targetYears: nv('rqYr'), dod: currentDod() };
    for (const r of cmp.rows) r.cost = costModel(r.cell, r.s * r.p, r.energyWh, usage);
    lastSimCompare = cmp;
  } else {
    lastSimCompare = null;
  }
}

// The loop choice's consequences belong in the Analysis, not only the tab:
// a physically unworkable selection is a FAIL finding with the reason.
function thermFindings() {
  const T = lastTherm;
  if (!T || T.assessment.verdict === 'suggested') return [];
  const sev = T.assessment.verdict === 'not-workable' ? 'fail' : 'warn';
  return [{
    severity: sev,
    title: `Thermal loop choice: ${T.loop.name} — ${VERDICT_CHIP[T.assessment.verdict][1]}`,
    detail: `${T.assessment.why} Key cons of this choice: ${(T.loop.cons || []).join('; ')}.`,
    ref: 'thermal system assessment', category: 'architecture',
  }];
}

function renderThermal() {
  const box = $('thermBody');
  if (!lastSummary) { box.innerHTML = '<div class="empty">—</div>'; lastTherm = null; return; }
  if (!lastTherm) computeThermal();
  const T = lastTherm;
  $('loopAssess').innerHTML = assessCard({ ...T.assessment, pros: T.loop.pros, cons: T.loop.cons });
  const stat = (k, v) => `<div class="stat"><span>${esc(k)}</span><b>${v}</b></div>`;
  const rows = [];
  rows.push(stat('Loop', `${esc(T.loop.name)} ${verdictChip(T.assessment.verdict)}`));
  rows.push(stat('Heat to move', `~${f1(T.heatContW)} W at continuous load · ambient ${T.ambientC[0]}…${T.ambientC[1]} °C`));
  if (T.flowLpm != null) {
    rows.push(stat('Coolant flow', `~${f1(T.flowLpm)} L/min (ΔT ${T.coolant.dTdesignK} K, 50/50 water-glycol — ṁ = Q/(c_p·ΔT))`));
  }
  if (T.chillerKW != null) {
    rows.push(stat('Chiller duty', `~${fPow(T.chillerKW)} battery side → ~${fPow(T.compressorKW)} compressor load on the HIGHER system (COP ~${T.chillerCOP})`));
  }
  rows.push(stat('Heater', T.heaterNeeded
    ? `required — ambient below the ${T.chargeFloorC} °C charge floor`
    : 'not required in this climate window'));
  rows.push(stat('Control', T.control
    ? `${esc(T.control.name)} — drives ${esc(T.control.drives.join(', '))}`
    : T.ramAir ? 'none — ram air / prop wash does the work, nothing to control'
      : 'none — passive system, no moving parts'));
  // Suggested parts by SIDE, with the customer's own cold-plate selection
  // named verbatim — never a generic word where a chosen part exists.
  const side = (label, list) => list?.length
    ? `<div class="hint" style="margin-top:6px"><b>${esc(label)}:</b><br>${list.map(esc).join('<br>')}</div>`
    : '';
  const comps = side('Coolant loop', T.coolantSide)
    + side('Refrigerant side — higher system', T.refrigerantSide)
    + side('Air side', T.airSide);
  const control = T.control
    ? `<div class="hint">${esc(T.control.inputs)}. ${esc(T.control.note)}</div>` : '';
  box.innerHTML = rows.join('') + comps + control +
    T.notes.map((n) => `<div class="hint">${esc(n)}</div>`).join('');
  drawThermalLoop($('thermCanvas'), T);
}

// One-line thermal loop: pack plate → pump → valve → radiator / chiller
// (the chiller couples into the HIGHER system's refrigerant circuit),
// heater branch, and the BTMS ECU driving it all. Same enlarge/report
// pattern as the architecture figures.
// ---------------------------------------------------------------------------
// Mission simulation pane: three-strip chart (power / SoC+V / temperature)
// and the findings the mission raised.
// ---------------------------------------------------------------------------
const fmtDur = (sec) => sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`;

function drawSimChart(canvas, sim, forExport = false) {
  const dpr = forExport ? 2 : Math.min(window.devicePixelRatio || 1, 2);
  const W = 640, H = 280;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n, fb) => forExport ? fb :
    (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  const ink = css('--ink', '#1a1a1a'), mut = css('--muted', '#666'),
    acc = css('--accent', '#0b6e5f'), bad = css('--missing', '#b3261e');
  g.fillStyle = forExport ? '#ffffff' : css('--ground', '#f4f6f5');
  g.fillRect(0, 0, W, H);
  g.font = '10px ui-monospace, monospace';
  g.lineWidth = 1.2;
  const T = sim.trace, n = T.tS.length;
  if (!n) return;
  const X0 = 44, X1 = W - 10;
  const x = (i) => X0 + (i / Math.max(1, n - 1)) * (X1 - X0);
  const strip = (y0, y1, lo, hi, arr, color, dash = false) => {
    if (hi <= lo) hi = lo + 1;
    const y = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
    g.strokeStyle = color;
    if (dash) g.setLineDash([3, 3]);
    g.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) continue;
      if (!started) { g.moveTo(x(i), y(arr[i])); started = true; } else g.lineTo(x(i), y(arr[i]));
    }
    g.stroke(); g.setLineDash([]);
    return y;
  };
  const label = (txt, yv, color) => { g.fillStyle = color; g.fillText(txt, 4, yv); };

  // Strip 1 — power demand (regen below zero).
  const pLo = Math.min(0, ...T.pW), pHi = Math.max(1, ...T.pW);
  const yP = strip(16, 88, pLo, pHi, T.pW, acc);
  g.strokeStyle = mut; g.setLineDash([2, 3]);
  g.beginPath(); g.moveTo(X0, yP(0)); g.lineTo(X1, yP(0)); g.stroke(); g.setLineDash([]);
  label(`Power · peak ${fPow(pHi / 1000)}${pLo < 0 ? ' · regen below 0' : ''}`, 12, ink);

  // Strip 2 — SoC (accent) and pack voltage (ink) on their own scales.
  strip(112, 184, 0, 1, T.soc, acc);
  const vLo = sim.summary.vMinPack, vHi = sim.summary.vMaxPack;
  strip(112, 184, vLo, vHi, T.vPack, ink, true);
  label(`SoC (solid) · V pack (dashed, ${Math.round(vLo)}–${Math.round(vHi)} V)`, 108, ink);
  g.fillStyle = mut;
  g.fillText('100%', 6, 120); g.fillText('0%', 6, 184);

  // Strip 3 — temperature with ambient + rating lines.
  const hasT = T.tC.some((v) => v != null);
  if (hasT) {
    const tArr = T.tC.filter((v) => v != null);
    const lim = sim.summary.tempMaxC;
    const tLo = Math.min(sim.ambientC, ...tArr) - 2;
    const tHi = Math.max(lim, ...tArr) + 2;
    const yT = strip(208, 268, tLo, tHi, T.tC, acc);
    g.strokeStyle = mut; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(X0, yT(sim.ambientC)); g.lineTo(X1, yT(sim.ambientC)); g.stroke();
    g.strokeStyle = bad;
    g.beginPath(); g.moveTo(X0, yT(lim)); g.lineTo(X1, yT(lim)); g.stroke(); g.setLineDash([]);
    label(`Temperature · ambient ${Math.round(sim.ambientC)} °C (grey) · limit ${lim} °C (red)`, 204, ink);
  } else {
    label('Temperature: no thermal model for this run', 204, mut);
  }

  // Time axis.
  g.fillStyle = mut;
  for (let k = 0; k <= 4; k++) {
    const tv = (sim.durationS * k) / 4;
    g.fillText(fmtDur(tv), X0 + ((X1 - X0) * k) / 4 - 8, 278);
  }
}

function renderSim() {
  const statsBox = $('simStats'), body = $('simBody');
  if (!statsBox) return;
  const canvas = $('simCanvas');
  if (!lastSim || lastSim.unavailable) {
    statsBox.innerHTML = '';
    body.innerHTML = `<div class="empty">${esc(lastSim?.why || '—')}</div>`;
    $('simAssump').textContent = '';
    const g = canvas.getContext('2d');
    canvas.width = 640; canvas.height = 280;
    g.font = '12px ui-monospace, monospace'; g.fillStyle = '#888';
    g.fillText(lastSim?.why || 'No simulation yet.', 20, 140);
    return;
  }
  drawSimChart(canvas, lastSim, false);
  const m = lastSim.summary;
  const stat = (k, v) => `<div class="stat"><span>${esc(k)}</span><b style="font-weight:normal;text-align:right">${v}</b></div>`;
  statsBox.innerHTML = [
    stat('Mission', `${lastSim.passes}× profile · ${fmtDur(lastSim.durationS)} · ${Math.round(lastSim.ambientC)} °C ambient`),
    stat('State of charge', `${Math.round(m.startSoC * 100)}% → <b>${Math.round(m.endSoC * 100)}%</b> (min ${Math.round(m.minSoC * 100)}%)`),
    stat('Voltage', `min ${f1(m.minV)} V · cutoff ${f1(m.vMinPack)} V`),
    m.maxT != null ? stat('Temperature', `peak ${f1(m.maxT)} °C · limit ${f0(m.tempMaxC)} °C`) : '',
    stat('Energy', `${fWh(m.energyOutWh)} out · ${fWh(m.energyInWh)} regen · ${fWh(m.lossWh)} loss`),
    m.efficiencyPct != null ? stat('Round-trip efficiency', `${f1(m.efficiencyPct)}%`) : '',
    stat('Heat', `${fPow(m.avgHeatW / 1000)} average · ${fPow(m.peakHeatW / 1000)} peak`),
  ].join('');
  body.innerHTML = lastSim.findings.map(findingHTML).join('');
  $('simAssump').innerHTML = lastSim.assumptions.map((a) => `• ${esc(a)}`).join('<br>');
  renderSimCompare();
}

// The comparison cards: one per compared cell, same mission, same duty.
function renderSimCompare() {
  const box = $('simCompare');
  if (!box) return;
  if (!lastSimCompare?.rows?.length) {
    box.innerHTML = '<div class="hint">Tick two or more cells to compare in the cell picker (Design tab) — the same mission runs for each as the equivalent pack, and the outcomes land here and in the report.</div>';
    return;
  }
  const vch = (r) => r.verdict === 'unavailable'
    ? '<span class="chip info">no DCIR</span>'
    : `<span class="chip ${r.verdict}">${r.verdict === 'pass' ? 'completes' : r.verdict}</span>`;
  const cards = lastSimCompare.rows.map((r) => {
    const m = r.sim.unavailable ? null : r.sim.summary;
    const line = (k, v) => `<div class="stat"><span>${esc(k)}</span><b style="font-weight:normal;text-align:right">${v}</b></div>`;
    return `<div class="card"${r.current ? ' style="border-color:var(--accent)"' : ''}>
      <h4>${esc(r.cell.name)} ${r.current ? '<span class="chip pass">this design</span>' : ''} ${vch(r)}</h4>
      ${line('Pack for this job', `${r.s}S${r.p}P · ${fWh(r.energyWh)} · ${fKg(r.massKg)}`)}
      ${m ? line('Mission outcome', `SoC → ${Math.round(m.endSoC * 100)}% · min ${f1(m.minV)} V${m.maxT != null ? ` · peak ${f1(m.maxT)} °C` : ''} · loss ${fWh(m.lossWh)}`) : ''}
      ${r.cost?.upfrontUSD != null ? line('Value', `$${f0(r.cost.upfrontUSD)} cells${r.cost.usdPerKWhDelivered != null ? ` · $${r.cost.usdPerKWhDelivered.toFixed(2)}/kWh delivered` : ''}${r.cost.replacements != null ? ` · ${r.cost.replacements} pack${r.cost.replacements > 1 ? 's' : ''} over the duty` : ''}`) : ''}
      ${r.notes.length ? `<div class="hint">${r.notes.map(esc).join(' · ')}</div>` : ''}
      ${r.sim.unavailable ? `<div class="hint">${esc(r.sim.why)}</div>` : ''}
    </div>`;
  }).join('');
  box.innerHTML = `<h3 style="margin-top:12px">Cell comparison — same mission, same duty</h3>
    <div class="hint" style="margin-bottom:6px">${esc(lastSimCompare.basis)}</div>${cards}`;
}

// --- P&ID-style glyphs — a pump LOOKS like a pump (circle + impeller
// triangle), a valve is a bowtie, a radiator has fins, a fuse is the IEC
// rectangle-with-a-line — not just another rigid box.
function glyphPump(g, cx, cy, r, stroke) {
  g.strokeStyle = stroke;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.beginPath();
  g.moveTo(cx - r * 0.45, cy - r * 0.62);
  g.lineTo(cx + r * 0.78, cy);
  g.lineTo(cx - r * 0.45, cy + r * 0.62);
  g.closePath(); g.stroke();
}
function glyphFan(g, cx, cy, r, stroke) {
  g.strokeStyle = stroke; g.fillStyle = stroke;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 3; i++) {
    g.save(); g.translate(cx, cy); g.rotate((i * 2 * Math.PI) / 3);
    g.beginPath(); g.ellipse(0, -r * 0.5, r * 0.2, r * 0.38, 0, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  g.beginPath(); g.arc(cx, cy, 1.6, 0, Math.PI * 2); g.fill();
}
function glyphValve3(g, cx, cy, sz, stroke) {
  g.strokeStyle = stroke;
  g.beginPath(); g.moveTo(cx - sz, cy - sz * 0.55); g.lineTo(cx, cy); g.lineTo(cx - sz, cy + sz * 0.55); g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(cx + sz, cy - sz * 0.55); g.lineTo(cx, cy); g.lineTo(cx + sz, cy + sz * 0.55); g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(cx - sz * 0.55, cy - sz); g.lineTo(cx, cy); g.lineTo(cx + sz * 0.55, cy - sz); g.closePath(); g.stroke();
}
function glyphRadiator(g, x, y, w, h, stroke) {
  g.strokeStyle = stroke; g.strokeRect(x, y, w, h);
  for (let fx = x + 8; fx < x + w - 5; fx += 9) {
    g.beginPath(); g.moveTo(fx, y + 4); g.lineTo(fx, y + h - 4); g.stroke();
  }
}
function glyphHX(g, x, y, w, h, stroke) {
  g.strokeStyle = stroke; g.strokeRect(x, y, w, h);
  const n = 4, step = (w - 8) / n;
  g.beginPath(); g.moveTo(x + 4, y + h - 5);
  for (let i = 0; i < n; i++) g.lineTo(x + 4 + step * (i + 0.5), i % 2 ? y + h - 5 : y + 5);
  g.lineTo(x + w - 4, y + h - 5); g.stroke();
}
function zigzag(g, x, cy, len, amp, n, stroke) {
  g.strokeStyle = stroke;
  const step = len / n;
  g.beginPath(); g.moveTo(x, cy);
  for (let i = 0; i < n; i++) g.lineTo(x + step * (i + 0.5), cy + (i % 2 ? amp : -amp));
  g.lineTo(x + len, cy); g.stroke();
}
function glyphSwitch(g, x1, x2, cy, stroke) {
  g.strokeStyle = stroke; g.fillStyle = stroke;
  g.beginPath(); g.moveTo(x1, cy); g.lineTo(x1 + 6, cy); g.stroke();
  g.beginPath(); g.arc(x1 + 8, cy, 1.8, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(x2 - 8, cy, 1.8, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(x1 + 9.5, cy - 1); g.lineTo(x2 - 9, cy - 7); g.stroke();
  g.beginPath(); g.moveTo(x2 - 6, cy); g.lineTo(x2, cy); g.stroke();
}
function glyphFuse(g, x, cy, len, stroke) {
  g.strokeStyle = stroke;
  g.strokeRect(x, cy - 4, len, 8);
  g.beginPath(); g.moveTo(x - 4, cy); g.lineTo(x + len + 4, cy); g.stroke();
}

function drawThermalLoop(canvas, T, forExport = false) {
  const dpr = forExport ? 2 : Math.min(window.devicePixelRatio || 1, 2);
  const W = 640, H = 280;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n, fb) => forExport ? fb :
    (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  const ink = css('--ink', '#1a1a1a'), mut = css('--muted', '#666'), acc = css('--accent', '#0b6e5f');
  g.fillStyle = forExport ? '#ffffff' : css('--ground', '#f4f6f5');
  g.fillRect(0, 0, W, H);
  g.font = '11px ui-monospace, monospace';
  g.lineWidth = 1.2;
  const boxAt = (x, y, w, h, label, sub, dashed = false) => {
    g.strokeStyle = dashed ? mut : acc;
    if (dashed) g.setLineDash([5, 4]);
    g.strokeRect(x, y, w, h);
    g.setLineDash([]);
    g.fillStyle = ink; g.fillText(label, x + 5, y + 15);
    if (sub) { g.fillStyle = mut; g.fillText(sub, x + 5, y + 28); }
  };
  const line = (x1, y1, x2, y2, dashed = false) => {
    g.strokeStyle = mut;
    if (dashed) g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.setLineDash([]);
  };
  boxAt(10, 80, 120, 80, 'Pack', T.loopId === 'passive-air' ? 'natural convection'
    : T.loopId === 'forced-air' ? 'air ducts' : T.plateShort);
  if (T.loopId === 'passive-air') {
    g.fillStyle = mut;
    g.fillText('≈ ≈ ≈  no moving parts, no control unit', 150, 125);
    return;
  }
  if (T.loopId === 'forced-air') {
    line(130, 120, 181, 120);
    if (T.ramAir) {
      g.fillStyle = mut;
      g.fillText('≋ ram air / prop wash — no fans, no ducting, no BTMS', 185, 124);
      return;
    }
    glyphFan(g, 198, 120, 17, acc);
    g.fillStyle = ink; g.fillText('Fan(s)', 180, 152);
    g.fillStyle = mut; g.fillText('PWM', 187, 164);
    line(215, 120, 300, 120);
    g.fillStyle = mut; g.fillText('→ ambient exhaust', 305, 124);
  } else {
    // Liquid loop, in P&ID symbols: pack → pump → 3-way valve →
    // radiator (top branch) / chiller HX (bottom branch) → return.
    line(130, 100, 169, 100);
    glyphPump(g, 185, 100, 16, acc);
    g.fillStyle = ink;
    g.fillText(`Pump${T.flowLpm != null ? ` · ${Math.round(T.flowLpm * 10) / 10} L/min` : ''}`, 148, 78);
    line(201, 100, 266, 100);
    glyphValve3(g, 280, 100, 14, acc);
    g.fillStyle = ink; g.fillText('3-way valve', 250, 130);
    line(294, 96, 410, 58);
    glyphRadiator(g, 410, 40, 100, 36, acc);
    glyphFan(g, 524, 58, 12, acc);
    g.fillStyle = ink; g.fillText('Radiator + fan', 412, 34);
    g.fillStyle = mut; g.fillText('→ ambient', 412, 90);
    if (T.loopId === 'liquid-chiller') {
      line(294, 104, 410, 150);
      glyphHX(g, 410, 140, 110, 40, acc);
      g.fillStyle = ink; g.fillText('Chiller HX', 414, 134);
      g.fillStyle = mut; g.fillText('coolant ↔ refrig.', 414, 192);
      boxAt(545, 128, 88, 64, 'Higher', 'system', true);
      g.fillStyle = mut; g.fillText('AC/HVAC', 550, 182);
      line(520, 160, 545, 160, true);
      g.fillStyle = mut;
      if (T.compressorKW != null) g.fillText(`~${fPow(T.compressorKW)}`, 545, 122);
    }
    if (T.heaterNeeded) {
      g.strokeStyle = acc; g.strokeRect(135, 152, 105, 30);
      zigzag(g, 150, 167, 75, 6, 6, acc);
      g.fillStyle = ink; g.fillText('PTC heater · cold charge', 135, 196);
      line(185, 116, 185, 152);
    }
    // Return line to the pack (routed around the branch boxes).
    line(520, 58, 532, 58); line(532, 58, 532, 210); line(532, 210, 70, 210); line(70, 210, 70, 160);
    g.fillStyle = mut; g.fillText('return', 300, 205);
  }
  // BTMS ECU drives the loop; the hierarchy line names all three units.
  boxAt(10, 228, 180, 34, 'BTMS ECU', 'thermal control unit');
  line(100, 228, 100, 165, true);
  g.fillStyle = mut;
  g.fillText('BMS (protects) ↔ BTMS (moves heat) ↔ supervisor (decides)', 200, 250);
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
    ['Mass (est.)', fKg(S.massKg)],
    ['Cells mass', fKg(S.massCellsKg)],
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
    `<span><b>${fKg(S.massKg)}</b></span>`;
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
  computeThermal();
  lastThermFindings = thermFindings();
  computeCharging();
  computeVehicle();
  computeShort();
  computeSim();

  const perspectives = lastAnalysis?.perspectives || {};
  const engFindings = ['mechanical', 'thermal', 'electrical', 'safety']
    .flatMap((k) => perspectives[k] || []);
  const all = [...engFindings, ...lastArchFindings, ...lastThermFindings, ...lastSimFindings, ...(lastShort?.findings || []), ...lastFindings];
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
  renderPane('anTherm', [...(perspectives.thermal || []), ...lastThermFindings]);
  renderPane('anElec', [...(perspectives.electrical || []), ...lastArchFindings]);
  // Fault-study findings are safety findings: they belong in the safety
  // audit, not only in the panel that produced them.
  renderPane('anSafe', [...(perspectives.safety || []), ...(lastShort?.findings || [])]);
  $('findings').innerHTML = lastFindings.map(findingHtml).join('');
  // Integration: the reference list follows the application — a vacuum
  // robot never advertises ECE R100; transport/insulation basics always
  // stay. No application picked yet -> full list with a nudge.
  const appCls = appClassOf(state.presetId);
  const stds = appCls ? standardsForClass(appCls) : STANDARDS_INFO;
  $('stdList').innerHTML = (appCls
    ? `<div class="hint" style="margin-bottom:6px">Filtered to your application class (${esc(appCls)}) — transport and insulation basics always apply.</div>`
    : '<div class="hint" style="margin-bottom:6px">Pick an application on the Usage tab to narrow this list to what applies to you.</div>')
    + stds.map((s) =>
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
  // The chosen BMS topology judged against this design — an unbuildable
  // chain is a FAIL with the fix, not a footnote; overrides carry their
  // cons into the audit.
  const topoA = assessBmsTopology({
    topology: A.bms.topology, s: state.s,
    afeTotal: A.bms.afeTotal, nModules: A.partition.nModules,
  });
  if (topoA && topoA.verdict !== 'workable') {
    out.push({
      severity: topoA.verdict === 'not-workable' ? 'fail' : 'warn',
      title: `BMS topology: ${topoA.name} — ${(VERDICT_CHIP[topoA.verdict] || [null, topoA.verdict])[1]}`,
      detail: `${topoA.why} Cons to carry: ${(topoA.cons || []).join('; ')}.`,
      ref: 'BMS topology assessment', category: 'architecture',
    });
  }
  if (A.emsArch) {
    const emsA = assessEmsArchitecture(A.emsArch);
    if (emsA && emsA.verdict !== 'suggested') {
      out.push({
        severity: 'warn',
        title: `EMS architecture: ${emsA.name} — ${(VERDICT_CHIP[emsA.verdict] || [null, emsA.verdict])[1]}`,
        detail: `${emsA.why} Cons to carry: ${(emsA.cons || []).join('; ')}.`,
        ref: 'EMS architecture assessment', category: 'architecture',
      });
    }
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
  // Clamp AFE channels to the real 14–25-class silicon range and REFLECT
  // it back, so the field never displays a value the math silently ignored.
  const ch = clamp(Math.round(n('archCh', 16)), 2, 25);
  if ($('archCh').value !== String(ch)) $('archCh').value = ch;
  const smodRaw = $('archSmod').value;
  return {
    topology: state.archTopology,
    isolationStandard: state.archIso,
    emsOverride: state.emsOverride,
    sModOverride: smodRaw && smodRaw !== 'auto' ? parseInt(smodRaw, 10) : null,
    channelsPerIc: ch,
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
  if (A.supervisor) {
    rows.push(stat('Supervisory layer', `${esc(A.supervisor.name)} — <span style="font-weight:normal">${esc(A.supervisor.role)}</span>`));
    if (A.supervisor.detail) {
      rows.push(stat('… its functions', `<span style="font-weight:normal">${A.supervisor.detail.functions.map(esc).join(' · ')}</span>`));
      rows.push(stat('… its interfaces', `<span style="font-weight:normal">${A.supervisor.detail.interfaces.map(esc).join(' · ')}</span>`));
    }
    // EMS architecture — only for applications that genuinely have an EMS
    // (the selector stays hidden everywhere else; a wearable never sees it).
    $('emsArchWrap').style.display = A.emsArch ? 'block' : 'none';
    if (A.emsArch) {
      rows.push(stat('EMS architecture', `${esc(A.emsArch.chosen.name)}${A.emsArch.overridden
        ? ` <span class="chip warn">override — auto suggests ${esc(A.emsArch.recommended)}</span>` : ''}
        — <span style="font-weight:normal">${esc(A.emsArch.chosen.when)}</span>`));
    }
  }
  if (PR) {
    rows.push(stat('Precharge', `${f1(PR.rOhm)} Ω · within ${PR.closeGapV} V in ${PR.timeToCloseS} s · ${f0(PR.energyPerEventJ)} J/event · avg ${f1(PR.avgPowerDuringEventW)} W during event`));
    rows.push(stat('Sequence', PR.sequence.map((x, i) => `${i + 1}. ${esc(x)}`).join('<br>')));
  } else {
    rows.push(stat('Disconnect', 'solid-state (MOSFET) disconnect typical at ≤60 V DC — the HV precharge chain is omitted for this pack'));
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
  // Module-size selector tracks the current S: 'auto' plus every divisor,
  // keeping the user's pick when it still divides.
  const smodSel = $('archSmod');
  if (smodSel.dataset.s !== String(state.s)) {
    const cur = smodSel.value || 'auto';
    smodSel.innerHTML = '';
    const optEl = (v, label) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      smodSel.appendChild(o);
    };
    optEl('auto', 'auto — one AFE per module');
    for (const d of divisors(state.s).filter((x) => x >= 2)) optEl(String(d), `${d}S per module`);
    smodSel.dataset.s = String(state.s);
    smodSel.value = [...smodSel.options].some((o) => o.value === cur) ? cur : 'auto';
  }
  box.innerHTML = rows.join('') + notes.map(note).join('');
  // Pros/cons cards under the selectors: the trade is visible AT the
  // control, not three scrolls below it.
  const topoA = assessBmsTopology({
    topology: A.bms.topology, s: state.s,
    afeTotal: A.bms.afeTotal, nModules: A.partition.nModules,
  });
  $('topoAssess').innerHTML = assessCard(topoA);
  $('emsAssess').innerHTML = A.emsArch ? assessCard(assessEmsArchitecture(A.emsArch)) : '';
  drawArchDiagram($('archCanvas'), A, lastSummary);
  drawBmsInternals($('archBmsCanvas'), A);
}

// Layer 2 — inside the BMS: the master's real contents and every slave
// AFE IC (a 30S module at 16-channel AFEs correctly shows TWO slave ICs),
// linked per the chosen topology. Same forExport PNG path as the other
// figures, so the report carries it too.
function drawBmsInternals(canvas, A, forExport = false) {
  const dpr = forExport ? 2 : Math.min(window.devicePixelRatio || 1, 2);
  const W = 640, H = 280;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n, fb) => forExport ? fb :
    (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  const ink = css('--ink', '#1a1a1a'), mut = css('--muted', '#666'), acc = css('--accent', '#0b6e5f');
  g.fillStyle = forExport ? '#ffffff' : css('--ground', '#f4f6f5');
  g.fillRect(0, 0, W, H);
  g.font = '11px ui-monospace, monospace';
  g.lineWidth = 1.2;
  const B = A.bms, P = A.partition;
  // Master block with its real internals.
  g.strokeStyle = acc; g.strokeRect(10, 14, 220, 210);
  g.fillStyle = ink; g.fillText('BMS MASTER', 18, 28);
  const sub = (y, label) => {
    g.strokeStyle = mut; g.strokeRect(18, y, 204, 26);
    g.fillStyle = ink; g.fillText(label, 24, y + 17);
  };
  const commShort = (A.comms?.primary || 'CAN').split('(')[0].trim().slice(0, 24);
  sub(36, 'MCU — SoC/SoH, limits (SoP)');
  sub(66, `${commShort} interface`);
  sub(96, 'Isolated supply + comm isolation');
  sub(126, A.precharge ? 'Contactor + precharge drivers' : 'Solid-state disconnect driver');
  sub(156, 'Pack current sense (shunt/Hall)');
  sub(186, `Isolation monitor${A.isolation ? '' : ' (n/a ≤60 V)'}`);
  // Slave/AFE field: one box per IC, grouped by module.
  const total = B.afeTotal;
  const shown = Math.min(total, 12);
  const cols = Math.min(4, Math.max(1, Math.ceil(shown / 3)));
  const rowsN = Math.ceil(shown / cols);
  const bw = Math.min(92, (380 - 10 * cols) / cols);
  const bh = Math.min(54, (185 - 8 * rowsN) / rowsN);
  const boxXY = (i) => [250 + (i % cols) * (bw + 10), 34 + Math.floor(i / cols) * (bh + 8)];
  for (let i = 0; i < shown; i++) {
    const [x, y] = boxXY(i);
    g.strokeStyle = acc; g.strokeRect(x, y, bw, bh);
    g.fillStyle = ink; g.fillText(`AFE ${i + 1}·${B.channelsPerIc}ch`, x + 4, y + 14);
    g.fillStyle = mut;
    if (bh >= 34) g.fillText('sense+bal', x + 4, y + 27);
    if (bh >= 50) g.fillText(`module ${Math.floor(i / Math.max(1, B.afePerModule)) + 1}`, x + 4, y + 41);
  }
  // Links per topology.
  g.strokeStyle = mut;
  if (B.topology === 'wireless') {
    g.fillStyle = mut;
    for (let i = 0; i < shown; i++) { const [x, y] = boxXY(i); g.fillText(')))', x + bw - 22, y + 14); }
    g.fillText('))) RF link — no harness', 250, 250);
  } else if (B.topology === 'centralized') {
    for (let i = 0; i < shown; i++) {
      const [x, y] = boxXY(i);
      g.beginPath(); g.moveTo(230, 110); g.lineTo(x, y + bh / 2); g.stroke();
    }
    g.fillStyle = mut; g.fillText('parallel sense harness to one controller', 250, 250);
  } else {
    let px = 230, py = 110;
    for (let i = 0; i < shown; i++) {
      const [x, y] = boxXY(i);
      g.beginPath(); g.moveTo(px, py); g.lineTo(x, y + bh / 2); g.stroke();
      px = x + bw; py = y + bh / 2;
    }
    g.fillStyle = mut; g.fillText(`isoSPI daisy chain — ${total} node${total > 1 ? 's' : ''} (≤62)`, 250, 250);
  }
  // Uplink to the supervisory layer (EMS / VCU / host) — the machine above
  // the BMS that decides what the battery is asked to do.
  if (A.supervisor) {
    g.strokeStyle = mut;
    g.beginPath(); g.moveTo(120, 224); g.lineTo(120, 240); g.stroke();
    g.strokeStyle = acc; g.strokeRect(10, 240, 220, 26);
    g.fillStyle = ink; g.fillText(`↑ ${A.supervisor.name.slice(0, 28)}`, 18, 257);
  }
  g.fillStyle = mut;
  if (total > shown) g.fillText(`${shown} of ${total} AFE ICs shown`, 480, 26);
  g.fillText(`${B.senseWiresTotal} sense wires · ${B.tempSensors} temp sensors (1:${B.cellsPerTempSensor})`, 250, 270);
}

// One-line diagram of the HV chain: pack (with its modules) → fuse → main
// and precharge contactors → DC link → load, plus BMS and DC-DC. Doubles as
// the report figure via the forExport PNG path (same pattern as the load
// profile chart).
function drawArchDiagram(canvas, A, S, forExport = false) {
  // Fixed 640×280 logical drawing; the on-screen canvas is scaled down by
  // its CSS width (tap to enlarge), the report PNG uses it at full size.
  const dpr = forExport ? 2 : Math.min(window.devicePixelRatio || 1, 2);
  const W = 640, H = 280;
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
  // Positive bus: pack → fuse → K+ (precharge branch only where one
  // exists — LV packs correctly show the plain solid-state path).
  line(150, 70, 180, 70);
  boxAt(180, 55, 70, 30, 'Fuse', `${Math.round(A.contactors.fuse.ratingA ?? 0)} A`);
  glyphFuse(g, 224, 63, 16, mut);
  line(250, 70, 285, 70);
  boxAt(285, 55, 75, 30, A.precharge ? 'K+ main' : 'Disconnect', A.precharge ? null : 'solid-state');
  if (A.precharge) glyphSwitch(g, 293, 352, 77, mut);
  if (A.precharge) {
    // Precharge branch over K+.
    line(267, 70, 267, 25); line(267, 25, 285, 25);
    boxAt(285, 12, 55, 26, 'K pre', null);
    glyphSwitch(g, 291, 334, 32, mut);
    line(340, 25, 352, 25);
    // Resistor zigzag.
    g.strokeStyle = mut; g.beginPath(); g.moveTo(352, 25);
    for (let i = 0; i < 6; i++) g.lineTo(356 + i * 7, 25 + (i % 2 ? 7 : -7));
    g.lineTo(400, 25); g.stroke();
    g.fillStyle = mut;
    g.fillText(`${(Math.round(A.precharge.rOhm * 10) / 10)} Ω`, 350, 48);
    line(400, 25, 412, 25); line(412, 25, 412, 70);
  }
  line(360, 70, 470, 70);
  // DC link capacitor between the buses.
  line(440, 70, 440, 100); line(430, 100, 450, 100); line(430, 106, 450, 106); line(440, 106, 440, 190);
  if (A.precharge) { g.fillStyle = mut; g.fillText(`${Math.round(A.precharge.linkCapUF)} µF`, 452, 106); }
  // Load.
  boxAt(490, 55, 140, 150, 'Inverter / load', null);
  line(470, 70, 490, 70);
  // Negative bus: pack → K− → load.
  line(150, 190, 285, 190);
  boxAt(285, 175, 75, 30, 'K− main', null);
  if (A.precharge) glyphSwitch(g, 293, 352, 197, mut);
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
  // Closing order (only meaningful where a precharge chain exists).
  if (A.precharge) {
    g.fillStyle = mut;
    g.fillText('close: K− → K pre → K+ (link within ~10 V) → open K pre', 180, 245);
  }
  // The supervisory layer above the BMS — EMS / VCU / fleet or host
  // controller: the machine that decides what the battery is asked to do.
  if (A.supervisor) {
    line(58, 246, 58, 254);
    boxAt(10, 254, 200, 24, A.supervisor.name.slice(0, 30), null);
    g.fillStyle = mut;
    g.fillText('supervisory layer — decides; the BMS protects', 220, 270);
  }
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
        ${fKg(r.summary.massKg)} · ${f1(r.summary.volumeL)} L
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
    // Integration: when an application is active, chemistry outside its
    // preferred set is visibly marked — still offered, never hidden.
    const preset = PRESETS.find((x) => x.id === state.presetId);
    const offPref = preset?.preferredChemistries?.length
      && !preset.preferredChemistries.includes(r.cell.chemistry);
    card.innerHTML = `
      <h4>#${i + 1} ${esc(r.cell.name)}
        <span class="chip" style="color:${ch?.color};border-color:${ch?.color}">${r.cell.chemistry}</span>
        ${r.pareto ? '<span class="chip pass">Pareto-optimal</span>' : '<span class="chip info">dominated</span>'}
        ${r.targetEnergyWh ? (r.meetsEnergy ? '<span class="chip pass">meets target</span>' : '<span class="chip warn">closest possible</span>') : ''}
        ${offPref ? `<span class="chip warn">off-preference for ${esc(preset.name)}</span>` : ''}</h4>
      <div class="m">${r.s}S${r.p}P · ${f1(r.nominalV)} V · ${r.n}/${r.nMax} cells (${f0(r.utilization * 100)}% of fit) ·
        ${fWh(r.energyWh)} · ${fKg(r.massKg)} ·
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
