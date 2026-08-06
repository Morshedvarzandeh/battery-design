// visual-report.js — a self-contained, animated decision report.
//
// This module is presentation only. It consumes the exact report snapshot,
// simulation output and portable 3D assets already produced by the engine. It
// never runs sizing, invents a comparison, or changes a model coefficient.

import { semanticTraceForReport } from './report.js';
import {
  REPORT_ASSET_IDS,
  fixedAsset3dById,
  validateAsset3d,
} from '../assets3d/catalog.js';

export const VISUAL_REPORT_SCHEMA = 'battery-design/visual-decision-report@1';
export const VISUAL_REPORT_SCENE_SECONDS = 7;

const finite = (value) => Number.isFinite(value);
const round = (value, digits = 1) => finite(value)
  ? Math.round(value * (10 ** digits)) / (10 ** digits)
  : null;
const portable = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

export function buildVisualReportModel(report) {
  const R = report || {};
  const S = R.summary;
  if (!S || !R.cell) throw new Error('A completed pack summary and selected cell are required');
  if (![S.s, S.p, S.cellCount, S.nominalV, S.energyWh].every(finite)) {
    throw new Error('The pack summary contains a missing or non-finite core value');
  }
  if (S.s * S.p !== S.cellCount) {
    throw new Error(`Topology integrity failed: ${S.s} x ${S.p} is not ${S.cellCount}`);
  }

  const preliminaryMassKg = R.massWithComponentsKg ?? S.massKg;
  assertSemanticBinding(R.semanticBinding, R.cell, S, preliminaryMassKg);
  const semantic = semanticTraceForReport(R);
  const appId = typeof R.application === 'string' ? R.application : R.application?.id || 'custom';
  const host = R.scene?.host || null;
  const useStationaryAsset = appId === 'solar-ess';
  const applicationAsset = useStationaryAsset
    ? fixedAsset3dById(REPORT_ASSET_IDS.stationaryStorage)
    : host?.model || null;
  assertPortableAsset(applicationAsset, 'application');

  const simulation = simulationProjection(R.sim);
  const thermal = thermalProjection(R.thermal, simulation);
  const thermalAsset = thermal?.assetId ? fixedAsset3dById(thermal.assetId) : null;
  assertPortableAsset(thermalAsset, 'thermal');

  const findings = (R.findings || []).map((finding) => ({
    severity: ['fail', 'warn', 'pass', 'info'].includes(finding?.severity) ? finding.severity : 'info',
    title: String(finding?.title || 'Unnamed finding'),
    detail: String(finding?.detail || ''),
    category: finding?.category ? String(finding.category) : null,
  }));
  const counts = Object.fromEntries(['fail', 'warn', 'pass', 'info'].map((severity) => [
    severity, findings.filter((finding) => finding.severity === severity).length,
  ]));
  const nextFinding = findings.find((finding) => finding.severity === 'fail')
    || findings.find((finding) => finding.severity === 'warn')
    || null;

  const sceneIds = [
    'application',
    'sizing',
    simulation ? 'mission' : null,
    thermal ? 'thermal' : null,
    'decision',
    'trace',
  ].filter(Boolean);

  return {
    schema: VISUAL_REPORT_SCHEMA,
    generatedOn: String(R.date || ''),
    durationS: sceneIds.length * VISUAL_REPORT_SCENE_SECONDS,
    sceneSeconds: VISUAL_REPORT_SCENE_SECONDS,
    sceneIds,
    title: 'Battery design — visual decision report',
    application: {
      id: appId,
      label: R.scene?.host?.name || (typeof R.application === 'object' ? R.application?.name : appId),
      host: host ? {
        id: host.id,
        kind: host.kind,
        name: host.name,
        mount: host.mount,
        fits: host.fits,
        fitStatus: host.fitStatus,
        fitLabel: host.fitLabel,
        fitNote: host.fitNote,
        dimensionsBasis: host.dimsLabel || host.dimsFrom || null,
        boundary: host.boundary || host.note || null,
      } : null,
      asset: assetProjection(applicationAsset),
    },
    pack: {
      cell: {
        id: R.cell.id,
        name: R.cell.name,
        chemistry: R.cell.chemistry,
        form: R.cell.form,
        basis: R.cell.basis || null,
        inferredFields: portable(R.cell.inferredFields || []),
      },
      topology: { series: S.s, parallel: S.p, cellCount: S.cellCount },
      nominalVoltageV: round(S.nominalV, 2),
      voltageWindowV: [round(S.vMin, 2), round(S.vMax, 2)],
      nominalCapacityAh: round(S.capacityAh, 2),
      nominalEnergyKWh: round(S.energyWh / 1000, 3),
      preliminaryMassKg: round(preliminaryMassKg, 1),
      screenedOuterDimensionsMm: S.dims ? {
        x: round(S.dims.x, 1), y: round(S.dims.y, 1), z: round(S.dims.z, 1),
      } : null,
      bayLabel: R.bayLabel || null,
      layout: R.scene?.pack ? {
        nx: R.scene.pack.nx,
        ny: R.scene.pack.ny,
        nz: R.scene.pack.nz,
        packingEfficiencyPct: round(R.scene.pack.packingEfficiency * 100, 1),
        wallMm: R.scene.pack.wallMm,
        headroomMm: R.scene.pack.headroomMm,
        thermalReserveMm: R.scene.pack.underMm,
      } : null,
      components: (R.scene?.parts || []).map((part) => ({
        category: part.category,
        name: part.name,
        id: part.id,
        dataQuality: part.dataQuality,
      })),
    },
    simulation,
    thermal,
    thermalAsset: assetProjection(thermalAsset),
    decision: {
      counts,
      issues: findings.filter((finding) => ['fail', 'warn'].includes(finding.severity)).slice(0, 4),
      nextAction: nextFinding
        ? `Resolve: ${nextFinding.title}`
        : 'Use measurements to calibrate the model, then plan system-level verification.',
      audit: portable(R.scene?.audit || null),
    },
    integrity: {
      rootId: semantic.semantics?.rootId || null,
      checksum: semantic.semantics?.ontology?.checksum || semantic.semantics?.checksum || null,
      binding: portable(R.semanticBinding),
      authorityKind: semantic.authority.kind,
      authorityLabel: semantic.authority.label,
      authoritative: semantic.authority.authoritative,
      detail: semantic.authority.detail,
    },
    claimBoundary: 'Concept-screening output. Nominal pack values, preliminary mass and simplified equivalent-circuit/lumped-thermal results require calibration, detailed integration and physical validation before release.',
  };
}

export function validateVisualReportModel(model) {
  const errors = [];
  if (model?.schema !== VISUAL_REPORT_SCHEMA) errors.push('visual report schema is missing or unsupported');
  const topology = model?.pack?.topology;
  if (!topology || topology.series * topology.parallel !== topology.cellCount) errors.push('pack topology is inconsistent');
  if (!(model?.pack?.nominalVoltageV > 0) || !(model?.pack?.nominalEnergyKWh > 0)) errors.push('nominal pack values are required');
  if (!(model?.pack?.preliminaryMassKg > 0)) errors.push('preliminary mass is required');
  if (!model?.integrity?.rootId || !model?.integrity?.checksum) errors.push('semantic root and checksum are required');
  if (!Array.isArray(model?.sceneIds) || model.sceneIds.length < 4) errors.push('the report needs at least four decision scenes');
  if (model?.application?.asset && !validateAsset3d(model.application.asset).valid) errors.push('application asset is invalid');
  if (model?.thermalAsset && !validateAsset3d(model.thermalAsset).valid) errors.push('thermal asset is invalid');
  return { valid: errors.length === 0, errors };
}

export function buildVisualReportHTML(report) {
  const model = buildVisualReportModel(report);
  const validation = validateVisualReportModel(model);
  if (!validation.valid) throw new Error(`Visual report blocked: ${validation.errors.join('; ')}`);
  const json = JSON.stringify(model).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const scenes = model.sceneIds.map((id, index) => sceneHtml(id, model, index)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)}</title>
<style>${visualReportCss()}</style>
</head>
<body>
<main class="shell" aria-label="Battery Design visual decision report">
  <header class="topbar">
    <div class="brand"><span class="mark">B</span><span>BATTERY DESIGN</span></div>
    <div class="mode"><span class="live"></span> VISUAL DECISION REPORT</div>
  </header>
  <section class="screen" id="screen">${scenes}</section>
  <footer class="controls">
    <button id="toggle" type="button">Pause</button>
    <button id="restart" type="button">Restart</button>
    <div class="time" id="time">0:00 / ${formatClock(model.durationS)}</div>
    <input id="seek" type="range" min="0" max="${model.durationS}" step="0.01" value="0" aria-label="Report timeline">
    <button id="data" type="button">Data</button>
    <button id="full" type="button">Full screen</button>
  </footer>
  <div class="boundary">${esc(model.claimBoundary)}</div>
</main>
<script type="application/json" id="visual-report-model">${json}</script>
<script>${visualReportRuntime()}</script>
</body>
</html>`;
}

export function visualReportFilename(report) {
  const S = report?.summary || {};
  const cellId = String(report?.cell?.id || 'cell').replace(/[^a-z0-9_-]+/gi, '-');
  return `pack-visual-${cellId}-${S.s || 0}s${S.p || 0}p.html`;
}

function thermalProjection(thermal, simulation) {
  if (!thermal?.loop) return null;
  const loopId = thermal.loopId || thermal.loop?.id || 'unspecified';
  const hardware = [
    ...(thermal.coolantSide || []),
    ...(thermal.refrigerantSide || []),
    ...(thermal.airSide || []),
  ].filter(Boolean).map(String);
  const assetId = loopId === 'liquid-chiller'
    ? REPORT_ASSET_IDS.liquidThermalSystem
    : loopId === 'liquid'
      ? REPORT_ASSET_IDS.liquidRadiatorThermalSystem
      : loopId === 'forced-air' && !thermal.ramAir
        ? REPORT_ASSET_IDS.forcedAirThermalSystem
        : null;
  return {
    loopId,
    loopName: String(thermal.loop.name || loopId),
    assessment: thermal.assessment ? {
      verdict: thermal.assessment.verdict,
      why: thermal.assessment.why,
    } : null,
    assetId,
    hardwareVisualNote: assetId
      ? 'The reusable asset matches the selected loop class.'
      : thermal.ramAir
        ? 'No dedicated loop hardware: motion-induced air or prop wash provides the declared airflow.'
        : 'No dedicated thermal-loop hardware is selected for this passive concept.',
    firstOrderDesign: {
      heatContinuousW: round(thermal.heatContW, 1),
      flowLpm: round(thermal.flowLpm, 2),
      chillerDutyKW: round(thermal.chillerKW, 2),
      compressorPowerKW: round(thermal.compressorKW, 2),
      coolant: portable(thermal.coolant || null),
    },
    hardware,
    control: thermal.control ? {
      name: thermal.control.name,
      drives: portable(thermal.control.drives || []),
    } : null,
    modeledMission: simulation ? {
      hottestNodeC: simulation.hottestModeledNodeC,
      moduleSpreadK: simulation.maximumModuleSpreadK,
      coolantOutC: simulation.coolantOutC,
    } : null,
    notes: portable(thermal.notes || []),
  };
}

function simulationProjection(simulation) {
  if (!simulation || simulation.unavailable || !simulation.summary) return null;
  const summary = simulation.summary;
  const durationS = finite(simulation.durationS) ? simulation.durationS : summary.durationS;
  const hottestModeledNodeC = finite(summary.maxT) ? summary.maxT : summary.maxTempC;
  const source = simulation.trace ? {
    timeS: simulation.trace.tS,
    voltageV: simulation.trace.vPack,
    currentA: simulation.trace.iA,
    soc: simulation.trace.soc,
    temperatureC: simulation.trace.tC,
  } : {
    timeS: simulation.series?.t,
    voltageV: simulation.series?.v,
    currentA: simulation.series?.i,
    soc: simulation.series?.soc,
    temperatureC: simulation.series?.tMax,
  };
  const series = sampleSimulationSeries(source);
  if (!(durationS > 0) || !series) {
    throw new Error('Available mission simulation is missing a finite duration or compatible trace');
  }
  return {
    label: 'Equivalent-circuit + lumped-thermal mission screen',
    durationS: round(durationS, 1),
    startSoCPct: round(summary.startSoC * 100, 1),
    endSoCPct: round(summary.endSoC * 100, 1),
    minimumVoltageV: round(summary.minV, 2),
    hottestModeledNodeC: round(hottestModeledNodeC, 2),
    maximumModuleSpreadK: round(summary.tempSpreadK, 2),
    coolantOutC: round(summary.coolantOutC, 2),
    unmetWh: round(summary.unmetWh, 2),
    efficiencyPct: round(summary.efficiencyPct, 2),
    assumptions: portable(simulation.assumptions || []),
    series,
  };
}

function sampleSimulationSeries(series, maximum = 160) {
  const required = [series?.timeS, series?.voltageV, series?.currentA, series?.soc];
  const length = required[0]?.length || 0;
  if (!length || required.some((values) => !Array.isArray(values) || values.length !== length
    || values.some((value) => !finite(value)))) return null;
  const temperature = Array.isArray(series.temperatureC) && series.temperatureC.length === length
    && series.temperatureC.every((value) => finite(value))
    ? series.temperatureC : null;
  const stride = Math.max(1, Math.ceil(length / maximum));
  const indices = [];
  for (let index = 0; index < length; index += stride) indices.push(index);
  if (indices.at(-1) !== length - 1) indices.push(length - 1);
  const pick = (values) => indices.map((index) => round(values[index], 3));
  return {
    timeS: pick(series.timeS),
    voltageV: pick(series.voltageV),
    currentA: pick(series.currentA),
    socPct: pick(series.soc).map((value) => round(value * 100, 3)),
    temperatureC: temperature ? indices.map((index) => round(temperature[index], 3)) : null,
  };
}

function assetProjection(model) {
  if (!model) return null;
  return portable({
    libraryVersion: model.libraryVersion,
    assetId: model.assetId,
    version: model.version,
    category: model.category,
    label: model.label,
    kind: model.kind,
    visualStyle: model.visualStyle,
    effects: model.effects,
    scenePreset: model.scenePreset,
    coordinateSystem: model.coordinateSystem,
    licence: model.licence,
    envelopeM: model.envelopeM,
    presentation: model.presentation,
    geometryDigest: model.geometryDigest,
    primitives: model.primitives,
  });
}

function assertPortableAsset(model, label) {
  if (!model) return;
  const result = validateAsset3d(model);
  if (!result.valid) throw new Error(`${label} visual asset is invalid: ${result.errors.join('; ')}`);
}

function assertSemanticBinding(binding, cell, summary, preliminaryMassKg) {
  if (!binding) throw new Error('The visual report requires an engine-owned semantic pack binding');
  const near = (left, right, tolerance = 1e-6) => finite(left) && finite(right)
    && Math.abs(left - right) <= tolerance;
  const mismatches = [];
  if (binding.cellId !== cell?.id) mismatches.push('cell');
  if (binding.series !== summary.s || binding.parallel !== summary.p
      || binding.cellCount !== summary.cellCount) mismatches.push('topology');
  if (!near(binding.nominalVoltageV, summary.nominalV)
      || !near(binding.nominalEnergyWh, summary.energyWh)) mismatches.push('nominal pack values');
  if (!near(binding.preliminaryMassKg, preliminaryMassKg, 1e-4)) mismatches.push('preliminary mass');
  const expected = binding.outerDimensionsMm;
  const actual = summary.dims;
  if (!expected || !actual || !['x', 'y', 'z'].every((axis) => near(expected[axis], actual[axis], 1e-4))) {
    mismatches.push('screened dimensions');
  }
  if (mismatches.length) {
    throw new Error(`Report snapshot does not match its semantic design binding: ${mismatches.join(', ')}`);
  }
}

function sceneHtml(id, model, index) {
  const step = String(index + 1).padStart(2, '0');
  if (id === 'application') return applicationScene(model, step);
  if (id === 'sizing') return sizingScene(model, step);
  if (id === 'mission') return missionScene(model, step);
  if (id === 'thermal') return thermalScene(model, step);
  if (id === 'decision') return decisionScene(model, step);
  return traceScene(model, step);
}

function applicationScene(M, step) {
  const A = M.application;
  const asset = A.asset;
  return `<article class="scene" data-scene="application">
    ${sceneHead(step, 'APPLICATION', 'Start with the thing the battery must power.')}
    <div class="hero-grid">
      <div class="asset-stage grid-floor">
        ${asset ? '<canvas class="asset-canvas" data-asset="application" width="760" height="430"></canvas>' : '<div class="empty-visual">No host visual was requested for this custom design.</div>'}
      </div>
      <div class="fact-stack">
        ${fact('APPLICATION', A.label || A.id)}
        ${fact('PACK LOCATION', A.host?.mount?.name || 'Declared by the integrator')}
        ${fact('FIT STATUS', fitText(A.host))}
        ${asset ? fact('VERSIONED ASSET', `${asset.assetId} · v${asset.version}`) : ''}
        ${asset ? fact('GEOMETRY IDENTITY', asset.geometryDigest) : ''}
      </div>
    </div>
    <p class="scope">${esc(A.host?.boundary || 'The host visual is an indicative integration context; the pack data remains the engineering authority.')}</p>
  </article>`;
}

function sizingScene(M, step) {
  const P = M.pack;
  const D = P.screenedOuterDimensionsMm;
  return `<article class="scene" data-scene="sizing">
    ${sceneHead(step, 'SIZE', 'Cell → topology → screened pack envelope.')}
    <div class="assembly">
      <div class="assembly-card"><span class="cell-icon"></span><small>SELECTED CELL</small><b>${esc(P.cell.name)}</b><em>${esc(P.cell.chemistry)} · ${esc(P.cell.form)}</em></div>
      <div class="arrow">→</div>
      <div class="assembly-card module-icon"><span>${P.topology.series}S</span><small>SERIES GROUPS</small><b>${P.topology.parallel} cells in parallel</b><em>${P.topology.cellCount.toLocaleString('en-US')} total cells</em></div>
      <div class="arrow">→</div>
      <div class="assembly-card pack-icon"><span>${fmt(P.nominalEnergyKWh, 3)}</span><small>kWh NOMINAL</small><b>${fmt(P.nominalVoltageV, 2)} V nominal</b><em>${fmt(P.nominalCapacityAh, 2)} Ah nominal</em></div>
    </div>
    <div class="metric-grid">
      ${metric('TOPOLOGY', `${P.topology.series}S × ${P.topology.parallel}P`, `${P.topology.cellCount.toLocaleString('en-US')} cells`)}
      ${metric('VOLTAGE', `${fmt(P.nominalVoltageV, 2)} V`, `${fmt(P.voltageWindowV[0], 1)}–${fmt(P.voltageWindowV[1], 1)} V screen`)}
      ${metric('ENERGY', `${fmt(P.nominalEnergyKWh, 3)} kWh`, 'nominal voltage × nominal capacity')}
      ${metric('MASS', `${fmt(P.preliminaryMassKg, 1)} kg`, 'preliminary; review exclusions')}
      ${metric('OUTER SIZE', D ? `${fmt(D.x, 1)} × ${fmt(D.y, 1)} × ${fmt(D.z, 1)} mm` : 'Not available', 'screened layout, not production CAD')}
      ${metric('PACKING', P.layout ? `${fmt(P.layout.packingEfficiencyPct, 1)}%` : 'Not available', P.bayLabel || 'declared design space')}
    </div>
  </article>`;
}

function missionScene(M, step) {
  const S = M.simulation;
  return `<article class="scene" data-scene="mission">
    ${sceneHead(step, 'SIMULATE', 'Run the selected pack through the selected duty.')}
    <div class="mission-layout">
      <div class="chart-card"><canvas id="mission-chart" width="760" height="430"></canvas></div>
      <div class="fact-stack">
        ${fact('DURATION', formatClock(S.durationS))}
        ${fact('STATE OF CHARGE', `${fmt(S.startSoCPct, 1)}% → ${fmt(S.endSoCPct, 1)}%`)}
        ${fact('MINIMUM VOLTAGE', `${fmt(S.minimumVoltageV, 2)} V`)}
        ${fact('HOTTEST MODELED NODE', finite(S.hottestModeledNodeC) ? `${fmt(S.hottestModeledNodeC, 2)} °C` : 'Not modeled for this run')}
        ${fact('UNMET DEMAND', `${fmt(S.unmetWh, 2)} Wh`)}
      </div>
    </div>
    <p class="scope">${esc(S.label)}. This is not electrochemical or 3-D thermal validation.</p>
  </article>`;
}

function thermalScene(M, step) {
  const T = M.thermal;
  const D = T.firstOrderDesign;
  return `<article class="scene" data-scene="thermal">
    ${sceneHead(step, 'THERMAL SYSTEM', 'Show the hardware implied by the selected cooling concept.')}
    <div class="hero-grid thermal-grid">
      <div class="asset-stage grid-floor">${M.thermalAsset
        ? '<canvas class="asset-canvas" data-asset="thermal" width="760" height="430"></canvas>'
        : `<div class="empty-visual">${esc(T.hardwareVisualNote)}</div>`}</div>
      <div class="fact-stack">
        ${fact('SELECTED LOOP', T.loopName)}
        ${fact('CONTINUOUS HEAT BASIS', finite(D.heatContinuousW) ? `${fmt(D.heatContinuousW, 1)} W` : 'Not available')}
        ${fact('DESIGN FLOW', finite(D.flowLpm) ? `${fmt(D.flowLpm, 2)} L/min` : 'Not applicable')}
        ${fact('CHILLER DUTY', finite(D.chillerDutyKW) ? `${fmt(D.chillerDutyKW, 2)} kW thermal` : 'Not applicable')}
        ${fact('CURRENT MISSION RESULT', finite(T.modeledMission?.hottestNodeC) ? `${fmt(T.modeledMission.hottestNodeC, 2)} °C hottest node` : 'No thermal result in this mission run')}
      </div>
    </div>
    <div class="hardware-strip">${T.hardware.slice(0, 6).map((item) => `<span>${esc(shortHardware(item))}</span>`).join('')}</div>
    <p class="scope">${esc(T.hardwareVisualNote)} First-order flow and chiller sizing where applicable; pressure drop, pump curve, CFD, controls calibration and hardware tests remain open.</p>
  </article>`;
}

function decisionScene(M, step) {
  const D = M.decision;
  const status = D.counts.fail ? 'BLOCKED' : D.counts.warn ? 'REVIEW' : 'SCREEN COMPLETE';
  return `<article class="scene" data-scene="decision">
    ${sceneHead(step, 'DECIDE', 'Turn model output into the next engineering action.')}
    <div class="decision-status ${D.counts.fail ? 'bad' : D.counts.warn ? 'caution' : 'good'}">
      <span>${status}</span><b>${esc(D.nextAction)}</b>
    </div>
    <div class="metric-grid four">
      ${metric('FAIL', D.counts.fail, 'release-blocking findings')}
      ${metric('WARN', D.counts.warn, 'review findings')}
      ${metric('PASS', D.counts.pass, 'screened checks')}
      ${metric('INFO', D.counts.info, 'model and evidence notes')}
    </div>
    <div class="issue-list">${D.issues.length ? D.issues.map((issue) => `<div class="issue ${issue.severity}"><b>${esc(issue.title)}</b><span>${esc(issue.detail)}</span></div>`).join('') : '<div class="issue pass"><b>No fail or warning finding in this snapshot</b><span>Calibration, integration analysis and physical validation are still required.</span></div>'}</div>
  </article>`;
}

function traceScene(M, step) {
  const I = M.integrity;
  return `<article class="scene" data-scene="trace">
    ${sceneHead(step, 'TRACE', 'Keep identity, assumptions and release limits with the result.')}
    <div class="trace-card">
      <div><small>DESIGN ROOT</small><code>${esc(I.rootId)}</code></div>
      <div><small>SEMANTIC CHECKSUM</small><code>${esc(I.checksum)}</code></div>
      <div><small>INTEGRITY STATUS</small><b>${esc(I.authorityLabel)}</b><p>${esc(I.detail)}</p></div>
    </div>
    <div class="final-copy"><span>REQUIREMENTS</span><i>→</i><span>SIZE</span><i>→</i><span>SIMULATE</span><i>→</i><span>DECIDE</span></div>
    <h2>One traceable screening flow.<br><em>Calibrate. Integrate. Test.</em></h2>
  </article>`;
}

function sceneHead(step, eyebrow, title) {
  return `<div class="scene-head"><span>${step} / ${esc(eyebrow)}</span><h1>${esc(title)}</h1></div>`;
}

function fact(label, value) {
  return `<div class="fact"><small>${esc(label)}</small><b>${esc(value ?? 'Not available')}</b></div>`;
}

function metric(label, value, note) {
  return `<div class="metric"><small>${esc(label)}</small><b>${esc(value)}</b><span>${esc(note)}</span></div>`;
}

function fitText(host) {
  if (!host) return 'No host envelope declared';
  if (host.fitLabel) return host.fitLabel;
  if (host.fits === true) return 'Inside indicative host envelope';
  if (host.fits === false) return 'Check real integration envelope';
  return 'Fit not established';
}

function shortHardware(value) {
  return String(value).split('—')[0].trim().replace(/\s*\([^)]*\)\s*/g, ' ');
}

function fmt(value, digits = 1) {
  return finite(value) ? Number(value).toFixed(digits) : '—';
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function visualReportCss() {
  return `
:root{color-scheme:dark;--bg:#030c10;--panel:#07171d;--panel2:#0c252c;--line:#2d5960;--ink:#ebf8f9;--muted:#88a5aa;--cyan:#54f1dc;--green:#7df5a7;--amber:#ffb067;--red:#ff6975}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}body{display:grid;place-items:center;padding:18px}.shell{width:min(1080px,100%);aspect-ratio:1/1;min-height:640px;border:1px solid #21434a;background:linear-gradient(180deg,#06141a,#030c10 62%);display:grid;grid-template-rows:72px 1fr 68px auto;overflow:hidden}.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 34px;border-bottom:1px solid #21434a;font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.brand{display:flex;gap:12px;align-items:center}.mark{display:grid;place-items:center;width:30px;height:32px;background:var(--cyan);color:#031a1d;clip-path:polygon(15% 0,100% 0,83% 100%,0 100%);font-size:17px}.mode{color:var(--muted)}.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:8px}.screen{position:relative;overflow:hidden}.scene{position:absolute;inset:0;padding:36px 54px 30px;opacity:0;transform:translateY(14px);pointer-events:none;transition:opacity .35s ease,transform .35s ease}.scene.active{opacity:1;transform:none;pointer-events:auto}.scene-head span{display:block;color:var(--cyan);font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}.scene-head h1{margin:10px 0 24px;font-size:clamp(30px,4.2vw,52px);line-height:1.03;max-width:800px;letter-spacing:-.035em}.hero-grid,.mission-layout{display:grid;grid-template-columns:minmax(0,1.72fr) minmax(220px,.78fr);gap:22px}.asset-stage,.chart-card{height:430px;border:1px solid #28515a;background:#071a20;overflow:hidden;position:relative}.grid-floor{background-color:#06161b;background-image:linear-gradient(#17444b55 1px,transparent 1px),linear-gradient(90deg,#17444b55 1px,transparent 1px);background-size:34px 34px}.asset-canvas{width:100%;height:100%;display:block}.empty-visual{height:100%;display:grid;place-items:center;color:var(--muted);padding:24px;text-align:center}.fact-stack{display:grid;align-content:start;gap:10px}.fact,.metric{border:1px solid #21474f;background:#081b21;padding:14px 16px;min-width:0}.fact small,.metric small,.assembly-card small,.trace-card small{display:block;color:var(--muted);font:700 9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em;margin-bottom:8px}.fact b{display:block;font-size:13px;line-height:1.35;overflow-wrap:anywhere}.scope{color:var(--muted);font-size:11px;line-height:1.45;margin:14px 0 0;border-left:2px solid var(--cyan);padding-left:12px}.assembly{display:grid;grid-template-columns:1fr 38px 1fr 38px 1fr;align-items:stretch;gap:8px;margin:12px 0 22px}.assembly-card{min-height:178px;border:1px solid #2b5c62;background:#081d23;padding:18px;display:flex;flex-direction:column;justify-content:flex-end;position:relative}.assembly-card b{font-size:17px;margin-bottom:5px}.assembly-card em{font-size:11px;color:var(--muted);font-style:normal}.assembly-card>span{position:absolute;right:18px;top:20px;color:var(--cyan);font:800 31px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.cell-icon{width:34px!important;height:72px;border-radius:17px;background:linear-gradient(90deg,#2d6961,#54f1dc,#23534f);border:2px solid #9bf7ec}.cell-icon:before{content:"";position:absolute;top:-5px;left:9px;width:12px;height:5px;background:#9bd9d4;border-radius:2px}.arrow{display:grid;place-items:center;color:var(--cyan);font-size:30px}.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric-grid.four{grid-template-columns:repeat(4,1fr)}.metric b{display:block;font-size:21px;margin-bottom:6px}.metric span{display:block;color:var(--muted);font-size:10px;line-height:1.35}.chart-card canvas{width:100%;height:100%;display:block}.hardware-strip{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.hardware-strip span{border:1px solid #2d6064;background:#0a2528;color:#b8e8e2;padding:7px 9px;font:700 8px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.decision-status{display:grid;grid-template-columns:180px 1fr;align-items:center;border:1px solid #31565c;padding:20px;margin:12px 0 18px;background:#0a1e23}.decision-status span{font:800 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.decision-status b{font-size:20px}.decision-status.good{border-color:#347a57}.decision-status.good span{color:var(--green)}.decision-status.caution{border-color:#8c6034}.decision-status.caution span{color:var(--amber)}.decision-status.bad{border-color:#893d45}.decision-status.bad span{color:var(--red)}.issue-list{display:grid;gap:8px;margin-top:16px}.issue{display:grid;grid-template-columns:minmax(170px,.65fr) 1.5fr;gap:16px;padding:11px 14px;border-left:3px solid var(--line);background:#07191e}.issue.fail{border-color:var(--red)}.issue.warn{border-color:var(--amber)}.issue.pass{border-color:var(--green)}.issue b{font-size:12px}.issue span{font-size:10px;color:var(--muted);line-height:1.4}.trace-card{display:grid;gap:10px;margin-top:12px}.trace-card>div{border:1px solid #28525a;background:#071a20;padding:15px 18px}.trace-card code{font:700 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--cyan);overflow-wrap:anywhere}.trace-card b{display:block;font-size:15px}.trace-card p{margin:6px 0 0;color:var(--muted);font-size:10px;line-height:1.4}.final-copy{display:flex;justify-content:center;align-items:center;gap:20px;margin:25px 0 13px;color:var(--cyan);font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.final-copy i{color:#496c72}.scene[data-scene="trace"] h2{text-align:center;font-size:28px;line-height:1.2;margin:0}.scene[data-scene="trace"] h2 em{color:var(--cyan);font-style:normal}.controls{display:flex;align-items:center;gap:10px;padding:12px 22px;border-top:1px solid #21434a;background:#041116}.controls button{border:1px solid #2d5960;background:#082027;color:var(--ink);height:34px;padding:0 13px;font-weight:700;cursor:pointer}.controls button:hover{border-color:var(--cyan)}.controls .time{font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);min-width:84px;text-align:center}.controls input{flex:1;accent-color:var(--cyan)}.boundary{padding:8px 22px 10px;border-top:1px solid #173239;color:#719096;font-size:9px;line-height:1.35}.asset-meta{position:absolute;left:12px;bottom:10px;font:700 8px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8ab1b5}@media(max-width:760px){body{padding:0}.shell{aspect-ratio:auto;min-height:100vh;border:0}.topbar{padding:0 16px}.scene{padding:24px 18px}.hero-grid,.mission-layout{grid-template-columns:1fr}.asset-stage,.chart-card{height:300px}.fact-stack{grid-template-columns:repeat(2,1fr)}.metric-grid,.metric-grid.four{grid-template-columns:repeat(2,1fr)}.assembly{grid-template-columns:1fr}.arrow{transform:rotate(90deg);height:24px}.assembly-card{min-height:120px}.controls{flex-wrap:wrap}.controls input{order:3;flex-basis:100%}.mode{display:none}}`;
}

function visualReportRuntime() {
  return `
(() => {
  const M = JSON.parse(document.getElementById('visual-report-model').textContent);
  const scenes = [...document.querySelectorAll('.scene')];
  const seek = document.getElementById('seek');
  const time = document.getElementById('time');
  const toggle = document.getElementById('toggle');
  let playing = true;
  let current = 0;
  let previous = performance.now();
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const clock = (seconds) => { const n=Math.max(0,Math.round(seconds)); return Math.floor(n/60)+':'+String(n%60).padStart(2,'0'); };
  function show() {
    current = clamp(current,0,M.durationS-0.001);
    const index = Math.min(scenes.length-1,Math.floor(current/M.sceneSeconds));
    scenes.forEach((scene,i)=>scene.classList.toggle('active',i===index));
    seek.value = current;
    time.textContent = clock(current)+' / '+clock(M.durationS);
  }
  function frame(now) {
    const delta=(now-previous)/1000; previous=now;
    if (playing) { current += delta; if (current>=M.durationS) current=0; show(); }
    requestAnimationFrame(frame);
  }
  toggle.addEventListener('click',()=>{playing=!playing;toggle.textContent=playing?'Pause':'Play';previous=performance.now();});
  document.getElementById('restart').addEventListener('click',()=>{current=0;playing=true;toggle.textContent='Pause';show();});
  seek.addEventListener('input',()=>{current=Number(seek.value);playing=false;toggle.textContent='Play';show();});
  document.getElementById('full').addEventListener('click',()=>document.querySelector('.shell').requestFullscreen?.());
  document.getElementById('data').addEventListener('click',()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(M,null,2)],{type:'application/json'}));a.download='battery-design-visual-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),0);});
  renderAsset(document.querySelector('[data-asset="application"]'),M.application.asset);
  renderAsset(document.querySelector('[data-asset="thermal"]'),M.thermalAsset);
  renderMission(document.getElementById('mission-chart'),M.simulation?.series);
  show(); requestAnimationFrame(frame);

  function renderMission(canvas,series){
    if(!canvas||!series?.timeS?.length)return;
    const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
    c.fillStyle='#06161b';c.fillRect(0,0,w,h);
    const rows=[['PACK CURRENT',series.currentA,'#54f1dc','A'],['STATE OF CHARGE',series.socPct,'#7df5a7','%'],['HOTTEST MODELED NODE',series.temperatureC,'#ffb067','°C']].filter((row)=>Array.isArray(row[1])&&row[1].length);
    rows.forEach((row,i)=>{const [label,values,color,unit]=row;const top=24+i*132,bottom=top+92;const lo=Math.min(...values),hi=Math.max(...values),span=Math.max(1e-9,hi-lo);c.strokeStyle='#1c4249';c.lineWidth=1;for(let g=0;g<5;g++){const y=top+g*(bottom-top)/4;c.beginPath();c.moveTo(76,y);c.lineTo(w-22,y);c.stroke();}c.fillStyle='#88a5aa';c.font='700 11px monospace';c.fillText(label,18,top+12);c.fillText(hi.toFixed(1)+unit,18,top+32);c.fillText(lo.toFixed(1)+unit,18,bottom);c.strokeStyle=color;c.lineWidth=3;c.beginPath();values.forEach((v,j)=>{const x=76+j*(w-98)/Math.max(1,values.length-1);const y=bottom-(v-lo)/span*(bottom-top);if(j)c.lineTo(x,y);else c.moveTo(x,y);});c.stroke();});
  }

  function renderAsset(canvas,asset){
    if(!canvas||!asset?.primitives?.length)return;
    const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
    const triangles=asset.primitives.flatMap(primitiveTriangles);
    const target=asset.presentation?.targetM||{x:0,y:0,z:0};
    const env=asset.envelopeM||{x:4,y:4,zMin:0,zMax:2};
    const span=Math.max(env.x,env.y,(env.zMax||1)-(env.zMin||0));
    const yaw=(asset.presentation?.orbitYawDeg??38)*Math.PI/180;
    const pitch=Math.abs(asset.presentation?.orbitPitchDeg??-14)*Math.PI/180;
    const dir=[Math.sin(yaw)*Math.cos(pitch),Math.cos(yaw)*Math.cos(pitch),Math.sin(pitch)];
    const camera=add([target.x,target.y,target.z],mul(norm(dir),span*1.8));
    const basis=cameraBasis(camera,[target.x,target.y,target.z]);
    const visible=triangles.map((face,id)=>{const normal=norm(cross(sub(face.v[1],face.v[0]),sub(face.v[2],face.v[0])));const centre=face.v.reduce((s,p)=>add(s,mul(p,1/3)),[0,0,0]);return{...face,id,normal,p:face.v.map(q=>project(q,camera,basis)),facing:dot(normal,norm(sub(camera,centre)))}}).filter(f=>f.facing>.001);
    if(!visible.length)return;
    const all=visible.flatMap(f=>f.p),minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)),minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y));
    const scale=Math.min(w*.82/Math.max(1e-6,maxX-minX),h*.72/Math.max(1e-6,maxY-minY));const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
    const screen=p=>({x:w*.51+(p.x-cx)*scale,y:h*.50-(p.y-cy)*scale,z:p.depth});
    const image=c.createImageData(w,h),depth=new Float64Array(w*h);depth.fill(Infinity);const owner=new Int32Array(w*h);owner.fill(-1);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const at=(y*w+x)*4;const grid=(x%34===0||y%34===0);image.data[at]=grid?12:6;image.data[at+1]=grid?35:22;image.data[at+2]=grid?41:27;image.data[at+3]=255;}
    for(const face of visible){const p=face.p.map(screen),area=edge(p[0],p[1],p[2]);if(Math.abs(area)<1e-8)continue;const x0=Math.max(0,Math.floor(Math.min(...p.map(q=>q.x)))),x1=Math.min(w-1,Math.ceil(Math.max(...p.map(q=>q.x)))),y0=Math.max(0,Math.floor(Math.min(...p.map(q=>q.y)))),y1=Math.min(h-1,Math.ceil(Math.max(...p.map(q=>q.y))));const rgb=hex(face.material?.color||'#62777c');const opacity=face.material?.opacity??1;for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const q={x:x+.5,y:y+.5},a=edge(p[1],p[2],q)/area,b=edge(p[2],p[0],q)/area,d=1-a-b;if(a<-.000001||b<-.000001||d<-.000001)continue;const z=a*p[0].z+b*p[1].z+d*p[2].z,idx=y*w+x;if(z>=depth[idx])continue;const at=idx*4;image.data[at]=Math.round(image.data[at]*(1-opacity)+rgb[0]*opacity);image.data[at+1]=Math.round(image.data[at+1]*(1-opacity)+rgb[1]*opacity);image.data[at+2]=Math.round(image.data[at+2]*(1-opacity)+rgb[2]*opacity);depth[idx]=z;owner[idx]=face.id;}}
    c.putImageData(image,0,0);c.fillStyle='#b6d6d8';c.font='700 10px monospace';c.fillText(asset.assetId+' · v'+asset.version+' · '+asset.geometryDigest,16,h-18);
  }
  function primitiveTriangles(p){const material=p.material||{color:p.tint||'#62777c',opacity:1},at=[p.atM.x,p.atM.y,p.atM.z];if(p.kind==='mesh'){const vertices=p.vertices.map(q=>add(q,at));return p.triangles.map(f=>({v:f.map(i=>vertices[i]),material}));}if(p.kind==='box'){const q=[p.sizeM.x/2,p.sizeM.y/2,p.sizeM.z/2],v=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(s=>add(at,s.map((n,i)=>n*q[i]))),f=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];return f.map(x=>({v:x.map(i=>v[i]),material}));}if(p.kind==='cylinder'){const n=12,r=[[],[]];for(let side=0;side<2;side++)for(let i=0;i<n;i++){const a=i/n*Math.PI*2,c=[Math.cos(a)*p.radiusM,Math.sin(a)*p.radiusM],ax=(side-.5)*p.heightM,local=p.axis==='x'?[ax,c[0],c[1]]:p.axis==='y'?[c[0],ax,c[1]]:[c[0],c[1],ax];r[side].push(add(at,local));}const out=[];for(let i=0;i<n;i++){const j=(i+1)%n;out.push({v:[r[0][i],r[1][i],r[1][j]],material},{v:[r[0][i],r[1][j],r[0][j]],material});}return out;}return[];}
  function cameraBasis(camera,target){const f=norm(sub(target,camera)),r=norm(cross(f,[0,0,1]));return{f,r,u:norm(cross(r,f))};}function project(p,c,b){const q=sub(p,c);return{x:dot(q,b.r),y:dot(q,b.u),depth:dot(q,b.f)};}function edge(a,b,p){return(p.x-a.x)*(b.y-a.y)-(p.y-a.y)*(b.x-a.x);}function add(a,b){return[a[0]+b[0],a[1]+b[1],a[2]+b[2]];}function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}function mul(a,n){return[a[0]*n,a[1]*n,a[2]*n];}function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}function norm(a){const l=Math.sqrt(dot(a,a));return l>1e-12?mul(a,1/l):[0,0,0];}function hex(v){const s=v.replace('#','');return[0,2,4].map(i=>parseInt(s.slice(i,i+2),16));}
})();`;
}
