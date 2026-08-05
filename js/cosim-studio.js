// Browser surface for the governed equation graph.  Every calculation and
// recommendation lives in an imported pure module; this file only renders,
// collects deliberate human actions and plays back completed traces.

import {
  BLOCK_CATALOG,
  QUANTITIES,
  applyApprovedGraphProposal,
  createBlockNode,
  createStudioGraph,
  debugStudioGraph,
  exportStudioGraph,
  graphChecksum,
  importStudioGraph,
  inputPorts,
  recommendBlockPlan,
  validateStudioGraph,
} from './cosim-graph.js';
import {
  equationGraphWasmReady,
  initializeWasmCore,
  simulateEquationGraph,
} from './wasm-core.js';
import { runAttachedAnalysisModules } from './cosim-analysis.js';
import { BARRIERS, SPACERS } from './runaway.js';
import { CELLS } from './cells.js';
import {
  createHilTestContract,
  createSilTestPlan,
  evaluateHilEvidence,
  runSoftwareInLoop,
} from './loop-testing.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

let graph = createStudioGraph({ id: 'studio-draft', title: 'Untitled model', market: 'road' });
let selectedNodeId = null;
let assistantProposal = null;
let repairProposal = null;
let pendingSource = null;
let lastDiagnostics = [];
let traceAnimation = 0;

const humanActor = {
  id: 'local-engineer', kind: 'human', role: 'application-engineer',
  authorities: ['edit-graph'],
};

function init() {
  populateBlockTypes();
  bindControls();
  renderAll();
  initializeWasmCore().then((ready) => {
    if (!ready) setRunMessage('Rust engine unavailable', 'Build the generated WebAssembly asset before running this model.', 'fail');
  });
}

function populateBlockTypes() {
  const groups = new Map();
  for (const [id, block] of Object.entries(BLOCK_CATALOG)) {
    if (!groups.has(block.group)) groups.set(block.group, []);
    groups.get(block.group).push([id, block]);
  }
  $('blockTypeSelect').replaceChildren(...[...groups].map(([label, blocks]) => {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const [id, block] of blocks) group.append(new Option(block.name, id));
    return group;
  }));
}

function bindControls() {
  $('marketSelect').onchange = () => {
    const market = $('marketSelect').value;
    if (graph.nodes.length && !confirm('Start a new isolated market model? The current draft can be exported first.')) {
      $('marketSelect').value = graph.market;
      return;
    }
    graph = createStudioGraph({
      id: market === 'grid' ? 'grid-model' : 'road-model', market,
      segment: market === 'grid' ? $('segmentSelect').value : null,
      mode: selectedMode(), title: market === 'grid' ? 'Grid energy model' : 'Road model',
    });
    resetTransientState();
    renderAll();
  };
  $('segmentSelect').onchange = () => {
    graph = withHumanEdit({ ...graph, segment: $('segmentSelect').value },
      'grid-segment-changed', 'Selected the customer segment for this isolated Grid model.');
    renderAll();
  };
  document.querySelectorAll('input[name=studioMode]').forEach((input) => {
    input.onchange = () => { graph = { ...graph, mode: selectedMode() }; renderAll(); };
  });
  document.querySelectorAll('[data-example]').forEach((button) => {
    button.onclick = () => {
      $('goalInput').value = button.dataset.example;
      if (/home outage/i.test(button.dataset.example)) {
        if (!graph.nodes.length) {
          graph = createStudioGraph({ id: 'grid-model', market: 'grid', segment: 'home', mode: selectedMode() });
        }
      } else if (!graph.nodes.length && graph.market !== 'road') {
        graph = createStudioGraph({ id: 'road-model', market: 'road', mode: selectedMode() });
      }
      renderAll();
    };
  });
  $('suggestButton').onclick = prepareSuggestion;
  $('addBlockButton').onclick = addManualBlock;
  $('debugButton').onclick = () => { runDebug(true); renderDiagnostics(); };
  $('applyRepairButton').onclick = applyRepair;
  $('exportButton').onclick = exportGraphFile;
  $('importButton').onclick = () => $('importFile').click();
  $('importFile').onchange = importGraphFile;
  $('runButton').onclick = runSimulation;
  $('runSilButton').onclick = runSilCalculationTest;
  $('prepareHilButton').onclick = prepareHilContract;
  $('graphCanvas').addEventListener('keydown', (event) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodeId) removeSelectedNode();
    if (event.key === 'Escape') { pendingSource = null; renderCanvas(); }
  });
  window.addEventListener('resize', renderWires);
}

function selectedMode() {
  return document.querySelector('input[name=studioMode]:checked')?.value || 'guided';
}

function resetTransientState() {
  selectedNodeId = null;
  assistantProposal = null;
  repairProposal = null;
  pendingSource = null;
  cancelAnimationFrame(traceAnimation);
}

function withHumanEdit(nextGraph, action, reason) {
  return {
    ...nextGraph,
    history: [...(graph.history || []), {
      action, actorId: humanActor.id, actorKind: 'human',
      reason, at: new Date().toISOString(),
    }],
  };
}

function prepareSuggestion() {
  assistantProposal = recommendBlockPlan({
    text: $('goalInput').value,
    market: graph.market,
    segment: graph.segment,
    mode: graph.mode,
  }, graph);
  renderAssistant();
}

function renderAssistant() {
  const panel = $('assistantCard');
  if (!assistantProposal) {
    panel.className = 'assistant-card empty-card';
    panel.innerHTML = '<p class="eyebrow">Design assistant</p><p>Describe the result you need. I will explain which approved blocks are required and why.</p>';
    return;
  }
  panel.className = 'assistant-card';
  const changes = assistantProposal.changes || [];
  panel.innerHTML = `
    <p class="eyebrow">${assistantProposal.status === 'blocked' ? 'Market boundary' : 'Draft for human review'}</p>
    <h3>${esc(assistantProposal.title)}</h3>
    <p>${esc(assistantProposal.explanation)}</p>
    ${changes.length ? `<ul>${changes.slice(0, 9).map((change) => `<li>${esc(change.blockId || change.operation)} — ${esc(change.reason || '')}</li>`).join('')}</ul>` : ''}
    ${assistantProposal.questions ? `<ul>${assistantProposal.questions.map((question) => `<li>${esc(question)}</li>`).join('')}</ul>` : ''}
    <p><b>Evidence:</b> ${assistantProposal.evidence.map(esc).join(' · ')}</p>
    ${assistantProposal.draftGraph ? '<div class="proposal-actions"><button type="button" class="primary" id="approveDraft">Approve this draft</button><button type="button" id="inspectDraft">Preview first</button></div>' : ''}`;
  $('approveDraft')?.addEventListener('click', () => applyAssistantProposal(true));
  $('inspectDraft')?.addEventListener('click', () => applyAssistantProposal(false));
}

function applyAssistantProposal(approved) {
  if (!assistantProposal?.draftGraph) return;
  if (approved) {
    graph = applyApprovedGraphProposal(graph, assistantProposal, {
      actor: humanActor, nextVersion: '0.2.0-draft',
      reason: 'Reviewed the assistant block list, market scope and stated evidence.',
    });
    assistantProposal = null;
    setRunMessage('Draft approved for validation', 'The graph changed under a named human action; it is not released.', 'neutral');
  } else {
    graph = JSON.parse(JSON.stringify(assistantProposal.draftGraph));
    graph.history = [...(graph.history || []), {
      action: 'proposal-previewed', actorId: humanActor.id, actorKind: 'human',
      reason: 'Opened an assistant draft for inspection without approval.', at: new Date().toISOString(),
    }];
  }
  selectedNodeId = graph.nodes[0]?.id || null;
  pendingSource = null;
  renderAll();
}

function addManualBlock() {
  if (graph.mode !== 'manual') return;
  const type = $('blockTypeSelect').value;
  const index = graph.nodes.length + 1;
  const spec = BLOCK_CATALOG[type];
  const node = createBlockNode(type, {
    id: `${type}-${index}`, name: `${spec.name} ${index}`,
    position: { x: 60 + (index % 4) * 240, y: 60 + Math.floor(index / 4) * 190 },
  });
  graph = withHumanEdit({ ...graph, nodes: [...graph.nodes, node] },
    'block-added', `Added approved ${spec.name} block ${node.id}.`);
  selectedNodeId = node.id;
  renderAll();
}

function removeSelectedNode() {
  if (!selectedNodeId || graph.mode !== 'manual') return;
  graph = withHumanEdit({
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== selectedNodeId),
    connections: graph.connections.filter((wire) => wire.from !== selectedNodeId && wire.to !== selectedNodeId),
  }, 'block-removed', `Removed block ${selectedNodeId} and its connected wires.`);
  selectedNodeId = null;
  pendingSource = null;
  renderAll();
}

function renderAll() {
  $('marketSelect').value = graph.market;
  $('segmentField').hidden = graph.market !== 'grid';
  if (graph.market === 'grid') $('segmentSelect').value = graph.segment;
  const modeInput = document.querySelector(`input[name=studioMode][value="${graph.mode}"]`);
  if (modeInput) modeInput.checked = true;
  const manual = graph.mode === 'manual';
  $('blockTypeSelect').disabled = !manual;
  $('addBlockButton').disabled = !manual;
  $('suggestButton').textContent = graph.mode === 'automatic' ? 'Prepare automatic draft' : 'Prepare block draft';
  $('modelTitle').textContent = graph.title;
  $('graphIdentity').textContent = `${graph.nodes.length} blocks · ${graphChecksum(graph).slice(-8)}`;
  $('canvasEmpty').hidden = graph.nodes.length > 0;
  $('saveState').textContent = graph.version;
  renderAssistant();
  renderCanvas();
  runDebug(false);
  renderDiagnostics();
  renderInspector();
  renderScenarioInspector();
  renderLoopOutputOptions();
}

function renderLoopOutputOptions() {
  const select = $('silOutputSelect');
  const previous = select.value;
  select.replaceChildren(...graph.nodes.map((node) => new Option(
    `${node.name} · ${QUANTITIES[node.outputQuantity]?.unit || '—'}`, node.id,
  )));
  if (graph.nodes.some((node) => node.id === previous)) select.value = previous;
  else if (selectedNodeId && graph.nodes.some((node) => node.id === selectedNodeId)) select.value = selectedNodeId;
  $('runSilButton').disabled = !graph.nodes.length;
}

function renderCanvas() {
  const layer = $('nodeLayer');
  layer.replaceChildren();
  for (const node of graph.nodes) {
    const spec = BLOCK_CATALOG[node.type];
    const element = document.createElement('article');
    element.className = `sim-node${selectedNodeId === node.id ? ' selected' : ''}`;
    element.dataset.nodeId = node.id;
    element.style.left = `${node.position.x}px`;
    element.style.top = `${node.position.y}px`;
    const ports = inputPorts(node);
    const connectedInputs = new Set(graph.connections.filter((wire) => wire.to === node.id).map((wire) => wire.toPort));
    element.innerHTML = `
      <div class="node-head"><span class="node-icon">${esc(spec.group.slice(0, 2).toUpperCase())}</span><span class="node-title"><b>${esc(node.name)}</b><small>${esc(spec.name)}</small></span></div>
      <div class="node-body">
        ${ports.map((port, index) => `<div class="port-row"><button type="button" class="port input${connectedInputs.has(index) ? ' connected' : ''}" data-input="${index}" aria-label="Connect ${esc(port.label)} on ${esc(node.name)}"></button><span>${esc(port.label)} · ${esc(QUANTITIES[port.quantity]?.unit)}</span></div>`).join('')}
        <div class="port-row output-row"><span>${esc(QUANTITIES[node.outputQuantity]?.label)} · ${esc(QUANTITIES[node.outputQuantity]?.unit)}</span><button type="button" class="port output${pendingSource === node.id ? ' pending' : ''}" data-output aria-label="Start wire from ${esc(node.name)}"></button></div>
      </div>`;
    element.onclick = (event) => {
      if (event.target.closest('.port')) return;
      selectedNodeId = node.id;
      renderCanvas(); renderInspector();
    };
    element.querySelector('[data-output]').onclick = () => {
      pendingSource = pendingSource === node.id ? null : node.id;
      renderCanvas();
    };
    element.querySelectorAll('[data-input]').forEach((button) => {
      button.onclick = () => connectPending(node.id, Number(button.dataset.input));
    });
    bindDrag(element, node);
    layer.append(element);
  }
  requestAnimationFrame(renderWires);
}

function bindDrag(element, node) {
  const handle = element.querySelector('.node-head');
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    selectedNodeId = node.id;
    handle.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, left: node.position.x, top: node.position.y };
    handle.onpointermove = (move) => {
      if (!handle.hasPointerCapture(move.pointerId)) return;
      node.position.x = Math.max(10, start.left + move.clientX - start.x);
      node.position.y = Math.max(10, start.top + move.clientY - start.y);
      element.style.left = `${node.position.x}px`;
      element.style.top = `${node.position.y}px`;
      renderWires();
    };
    handle.onpointerup = () => { renderInspector(); handle.onpointermove = null; };
  };
}

function connectPending(targetId, toPort) {
  if (!pendingSource || pendingSource === targetId || graph.mode !== 'manual') return;
  const idBase = `${pendingSource}--${targetId}-${toPort}`;
  let id = idBase;
  let suffix = 2;
  while (graph.connections.some((wire) => wire.id === id)) id = `${idBase}-${suffix++}`;
  graph = withHumanEdit({ ...graph, connections: [...graph.connections, { id, from: pendingSource, to: targetId, toPort }] },
    'blocks-connected', `Connected ${pendingSource} to ${targetId} input ${toPort}.`);
  pendingSource = null;
  renderAll();
}

function renderWires() {
  const canvasRect = $('graphCanvas').getBoundingClientRect();
  const paths = graph.connections.map((wire) => {
    const source = document.querySelector(`[data-node-id="${CSS.escape(wire.from)}"] [data-output]`);
    const target = document.querySelector(`[data-node-id="${CSS.escape(wire.to)}"] [data-input="${wire.toPort}"]`);
    if (!source || !target) return '';
    const a = source.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - canvasRect.left + $('graphCanvas').scrollLeft;
    const y1 = a.top + a.height / 2 - canvasRect.top + $('graphCanvas').scrollTop;
    const x2 = b.left + b.width / 2 - canvasRect.left + $('graphCanvas').scrollLeft;
    const y2 = b.top + b.height / 2 - canvasRect.top + $('graphCanvas').scrollTop;
    const bend = Math.max(45, Math.abs(x2 - x1) * .45);
    const bad = lastDiagnostics.some((item) => item.connectionId === wire.id && item.severity === 'fail');
    return `<path class="wire${bad ? ' bad' : ''}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"/>`;
  }).join('');
  $('wireLayer').innerHTML = paths;
}

function runDebug(keepProposal) {
  const report = debugStudioGraph(graph);
  lastDiagnostics = report.diagnostics;
  if (keepProposal) repairProposal = report.proposal;
  $('applyRepairButton').hidden = !repairProposal;
}

function renderDiagnostics() {
  const failures = lastDiagnostics.filter((item) => item.severity === 'fail');
  const warnings = lastDiagnostics.filter((item) => item.severity === 'warn');
  const badge = $('healthBadge');
  if (!graph.nodes.length) { badge.textContent = 'Empty'; badge.className = 'status-chip neutral'; }
  else if (failures.length) { badge.textContent = `${failures.length} blocked`; badge.className = 'status-chip fail'; }
  else if (warnings.length) { badge.textContent = `${warnings.length} review`; badge.className = 'status-chip'; }
  else { badge.textContent = 'Ready'; badge.className = 'status-chip pass'; }
  $('diagnosticsList').innerHTML = lastDiagnostics.length
    ? lastDiagnostics.slice(0, 12).map((item) => `<div class="diagnostic ${item.severity}"><b>${esc(item.summary)}</b><span>${esc(item.detail)}</span></div>`).join('')
    : '<div class="diagnostic pass"><b>Structure is ready</b><span>Rust will compile the same graph before solving it.</span></div>';
  renderWires();
}

function applyRepair() {
  if (!repairProposal) return;
  graph = applyApprovedGraphProposal(graph, repairProposal, {
    actor: humanActor, nextVersion: graph.version,
    reason: 'Reviewed and approved the deterministic minimal wire repair.',
  });
  repairProposal = null;
  $('applyRepairButton').hidden = true;
  renderAll();
}

function renderInspector() {
  const node = graph.nodes.find((item) => item.id === selectedNodeId);
  $('inspectorSection').hidden = !node;
  if (!node) return;
  const spec = BLOCK_CATALOG[node.type];
  const editable = graph.mode === 'manual';
  $('blockInspector').innerHTML = `
    <div class="inspector-title"><h3>${esc(node.name)}</h3><span class="status-chip neutral">${esc(spec.group)}</span></div>
    <p class="muted">${esc(spec.summary)}</p>
    <div class="inspector-form">
      <label>Name<input type="text" data-node-name value="${esc(node.name)}" ${editable ? '' : 'disabled'}></label>
      ${spec.output === 'selectable' ? quantityField('Output quantity', 'outputQuantity', node.outputQuantity, editable) : ''}
      ${spec.parameters.map((parameter) => parameter.kind === 'quantity'
        ? quantityField(parameter.label, parameter.name, node.parameters[parameter.name], editable)
        : `<label>${esc(parameter.label)}${parameter.unit ? ` (${esc(parameter.unit)})` : ''}<input type="number" data-parameter="${esc(parameter.name)}" value="${esc(node.parameters[parameter.name])}" ${parameter.min != null ? `min="${parameter.min}"` : ''} ${parameter.max != null ? `max="${parameter.max}"` : ''} ${parameter.integer ? 'step="1"' : 'step="any"'} ${editable ? '' : 'disabled'}></label>`).join('')}
    </div>
    ${editable ? '<button type="button" class="remove-block" id="removeBlockButton">Remove block and its wires</button>' : ''}`;
  $('blockInspector').querySelector('[data-node-name]')?.addEventListener('change', (event) => {
    node.name = event.target.value.trim() || spec.name;
    graph = withHumanEdit({ ...graph, nodes: [...graph.nodes] }, 'block-renamed', `Renamed block ${node.id}.`);
    renderAll();
  });
  $('blockInspector').querySelector('[data-quantity="outputQuantity"]')?.addEventListener('change', (event) => {
    node.outputQuantity = event.target.value;
    graph = withHumanEdit({ ...graph, nodes: [...graph.nodes] }, 'block-quantity-changed', `Changed output quantity on ${node.id}.`);
    renderAll();
  });
  $('blockInspector').querySelectorAll('[data-quantity]:not([data-quantity="outputQuantity"])').forEach((select) => {
    select.onchange = () => {
      node.parameters[select.dataset.quantity] = select.value;
      graph = withHumanEdit({ ...graph, nodes: [...graph.nodes] }, 'block-parameter-changed', `Changed ${select.dataset.quantity} on ${node.id}.`);
      renderAll();
    };
  });
  $('blockInspector').querySelectorAll('[data-parameter]').forEach((input) => {
    input.onchange = () => {
      node.parameters[input.dataset.parameter] = Number(input.value);
      graph = withHumanEdit({ ...graph, nodes: [...graph.nodes] }, 'block-parameter-changed', `Changed ${input.dataset.parameter} on ${node.id}.`);
      renderAll();
    };
  });
  $('removeBlockButton')?.addEventListener('click', removeSelectedNode);
}

function quantityField(label, key, value, enabled) {
  return `<label>${esc(label)}<select data-quantity="${esc(key)}" ${enabled ? '' : 'disabled'}>${Object.entries(QUANTITIES).map(([id, quantity]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${esc(quantity.label)} (${esc(quantity.unit)})</option>`).join('')}</select></label>`;
}

function renderScenarioInspector() {
  const runawayModule = graph.analysisModules?.find((item) => item.type === 'runaway-propagation');
  const ventModule = graph.analysisModules?.find((item) => item.type === 'vent-sizing');
  $('scenarioSection').hidden = !runawayModule && !ventModule;
  if (!runawayModule && !ventModule) return;
  const p = runawayModule?.parameters;
  const v = ventModule?.parameters;
  const ventProfile = graph.market === 'road' ? 'road-pack'
    : graph.segment === 'home' ? 'grid-home-pack'
      : graph.segment === 'small-company' ? 'grid-commercial-cabinet'
        : 'grid-industrial-enclosure';
  const selectedVentFaces = new Set(String(v?.allowedVentFaces || '').split(',').map((face) => face.trim()).filter(Boolean));
  const inputValue = (value) => value == null ? '' : esc(value);
  $('scenarioInspector').innerHTML = `
    ${runawayModule ? `<div class="scenario-module"><h3>Propagation and heat paths</h3>
      <p class="muted">One cell is deliberately triggered. These inputs control every calculated air, barrier, spacer, interconnect and radiation path.</p>
      <div class="inspector-form">
        <label>Actual cell<select data-runaway="cellId">${CELLS.map((cell) => `<option value="${esc(cell.id)}" ${cell.id === p.cellId ? 'selected' : ''}>${esc(cell.name)} · ${esc(cell.chemistry)}</option>`).join('')}</select></label>
        <div class="field-grid scenario-grid"><label>Series cells<input type="number" min="1" step="1" data-runaway="series" value="${p.series}"></label><label>Parallel cells<input type="number" min="2" step="1" data-runaway="parallel" value="${p.parallel}"></label></div>
        <label>Free cell spacing (mm)<input type="number" min="0" step="0.1" data-runaway="spacingMm" value="${p.spacingMm}"></label>
        <label>Structural spacer / holder<select data-runaway="spacer">${Object.entries(SPACERS).map(([id, item]) => `<option value="${id}" ${id === p.spacer ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
        <label>Thermal barrier<select data-runaway="barrier">${Object.entries(BARRIERS).map(([id, item]) => `<option value="${id}" ${id === p.barrier ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
        <label>Barrier thickness (mm)<input type="number" min="0" step="0.1" data-runaway="barrierThicknessMm" value="${p.barrierThicknessMm}"></label>
        <label>State of charge (%)<input type="number" min="1" max="100" step="1" data-runaway-percent="soc" value="${Math.round(p.soc * 100)}"></label>
        <label>Ambient temperature (°C)<input type="number" step="1" data-runaway="ambientC" value="${p.ambientC}"></label>
      </div>
      <p class="muted"><b>Equation boundary:</b> post-trigger propagation only. Actual-cell ARC/DSC onset, heat release and reaction-rate data are required for measured kinetics.</p></div>` : ''}
    ${ventModule ? `<div class="scenario-module"><h3>Emergency vent sizing</h3>
      <p class="muted">No gas-yield value is invented from chemistry. Enter representative test data; the tool then calculates a conditional unobstructed free-flow area range.</p>
      <div class="inspector-form">
        <label>Cells venting in the scenario<input type="number" min="1" step="1" data-vent="ventingCells" value="${inputValue(v.ventingCells)}"></label>
        <div class="field-grid scenario-grid"><label>Gas low (L/cell)<input type="number" min="0.001" step="any" data-vent="gasVolumeLowLPerCell" value="${inputValue(v.gasVolumeLowLPerCell)}" placeholder="from test"></label><label>Gas high (L/cell)<input type="number" min="0.001" step="any" data-vent="gasVolumeHighLPerCell" value="${inputValue(v.gasVolumeHighLPerCell)}" placeholder="from test"></label></div>
        <div class="field-grid scenario-grid"><label>Release time min (s)<input type="number" min="0.001" step="any" data-vent="releaseDurationLowS" value="${inputValue(v.releaseDurationLowS)}" placeholder="from test"></label><label>Release time max (s)<input type="number" min="0.001" step="any" data-vent="releaseDurationHighS" value="${inputValue(v.releaseDurationHighS)}" placeholder="from test"></label></div>
        <label>Measurement / scenario basis<input type="text" data-vent-text="gasDataBasis" value="${inputValue(v.gasDataBasis)}" placeholder="Report, test id, cell/SOC/age"></label>
        <div class="field-grid scenario-grid"><label>Allowable gauge pressure (kPa)<input type="number" min="0.001" step="any" data-vent="allowableGaugePressureKPa" value="${inputValue(v.allowableGaugePressureKPa)}"></label><label>Vent-gas temperature (°C)<input type="number" min="-273" step="any" data-vent="ventGasTemperatureC" value="${inputValue(v.ventGasTemperatureC)}"></label></div>
        <div class="field-grid scenario-grid"><label>Discharge coefficient<input type="number" min="0.01" max="1" step="0.01" data-vent="dischargeCoefficient" value="${inputValue(v.dischargeCoefficient)}"></label><label>Gas γ<input type="number" min="1.01" step="0.01" data-vent="gamma" value="${inputValue(v.gamma)}"></label></div>
        <label>Specific gas constant (J/kg·K)<input type="number" min="0.001" step="any" data-vent="specificGasConstantJPerKgK" value="${inputValue(v.specificGasConstantJPerKgK)}"></label>
        <div class="vent-hardware-fields">
          <h4>Supplier vent and market constraint</h4>
          <p class="muted">This workspace requires <b>${esc(ventProfile)}</b>. The supplier record must explicitly include that profile; product outside dimensions are never treated as free area.</p>
          <div class="field-grid scenario-grid"><label>Supplier<input type="text" data-vent-text="ventSupplier" value="${inputValue(v.ventSupplier)}" placeholder="manufacturer"></label><label>Part number<input type="text" data-vent-text="ventPartNumber" value="${inputValue(v.ventPartNumber)}" placeholder="verified part"></label></div>
          <div class="field-grid scenario-grid"><label>Vent record id<input type="text" data-vent-text="ventUnitId" value="${inputValue(v.ventUnitId)}" placeholder="supplier catalog id"></label><label>Vent name<input type="text" data-vent-text="ventUnitName" value="${inputValue(v.ventUnitName)}" placeholder="customer label"></label></div>
          <div class="field-grid scenario-grid"><label>Unobstructed free area (cm²)<input type="number" min="0.001" step="any" data-vent="ventUnitFreeAreaCm2" value="${inputValue(v.ventUnitFreeAreaCm2)}" placeholder="supplier flow data"></label><label>Footprint W × H (mm)<span class="inline-inputs"><input type="number" min="0.001" step="any" data-vent="ventUnitWidthMm" value="${inputValue(v.ventUnitWidthMm)}" aria-label="Vent footprint width"><input type="number" min="0.001" step="any" data-vent="ventUnitHeightMm" value="${inputValue(v.ventUnitHeightMm)}" aria-label="Vent footprint height"></span></label></div>
          <label>Mechanism<select data-vent-text="ventUnitMechanism"><option value="">Choose verified mechanism</option>${['pressure-relief-device', 'burst-opening', 'directed-duct-exit'].map((id) => `<option value="${id}" ${v.ventUnitMechanism === id ? 'selected' : ''}>${id.replaceAll('-', ' ')}</option>`).join('')}</select></label>
          <div class="field-grid scenario-grid"><label>Opening gauge pressure (kPa)<input type="number" min="0.001" step="any" data-vent="ventOpeningGaugePressureKPa" value="${inputValue(v.ventOpeningGaugePressureKPa)}" placeholder="worst-case opening"></label><label>Transient temperature rating (°C)<input type="number" min="-273" step="any" data-vent="ventTemperatureRatingC" value="${inputValue(v.ventTemperatureRatingC)}" placeholder="supplier rating"></label></div>
          <label>Supplier-declared market profiles<input type="text" data-vent-text="ventUnitMarketProfiles" value="${inputValue(v.ventUnitMarketProfiles)}" placeholder="${esc(ventProfile)}"></label>
          <label>Supplier evidence basis<input type="text" data-vent-text="ventUnitEvidenceBasis" value="${inputValue(v.ventUnitEvidenceBasis)}" placeholder="datasheet revision, drawing and flow curve"></label>
          <div class="field-grid scenario-grid"><label>Evidence revision<input type="text" data-vent-text="ventEvidenceRevision" value="${inputValue(v.ventEvidenceRevision)}" placeholder="revision id"></label><label>Evidence date<input type="date" data-vent-text="ventEvidenceDate" value="${inputValue(v.ventEvidenceDate)}"></label></div>
        </div>
        <div class="vent-placement-fields">
          <h4>Permitted placement</h4>
          <p class="muted">Choose only faces already screened for a safe external discharge path. The algorithm will not decide that a passenger, egress, intake, responder or ignition-facing surface is safe.</p>
          <fieldset class="face-picker"><legend>Human-screened discharge faces</legend>${['top', 'bottom', 'front', 'rear', 'left', 'right'].map((face) => `<label><input type="checkbox" data-vent-face="${face}" ${selectedVentFaces.has(face) ? 'checked' : ''}>${face}</label>`).join('')}</fieldset>
          <label>Preferred face<select data-vent-text="preferredVentFace"><option value="">Nearest permitted face</option>${['top', 'bottom', 'front', 'rear', 'left', 'right'].filter((face) => selectedVentFaces.has(face)).map((face) => `<option value="${face}" ${v.preferredVentFace === face ? 'selected' : ''}>${face}</option>`).join('')}</select></label>
          <div class="field-grid scenario-grid"><label>Edge clearance (mm)<input type="number" min="0" step="any" data-vent="edgeClearanceMm" value="${inputValue(v.edgeClearanceMm)}" placeholder="reviewed CAD constraint"></label><label>Between vents (mm)<input type="number" min="0" step="any" data-vent="minimumVentSpacingMm" value="${inputValue(v.minimumVentSpacingMm)}" placeholder="reviewed CAD constraint"></label></div>
          <label>Maximum permitted vent count<input type="number" min="1" step="1" data-vent="maxVentCount" value="${inputValue(v.maxVentCount)}"></label>
        </div>
      </div>
      <p class="muted"><b>Boundary:</b> pressure-relief orifice and geometric placement screening, not NFPA 68 deflagration sizing. The production vent, duct, enclosure, external safe zone and fire scenario still require physical tests and qualified review.</p></div>` : ''}`;
  $('scenarioInspector').querySelectorAll('[data-runaway]').forEach((input) => {
    input.onchange = () => {
      const key = input.dataset.runaway;
      p[key] = input.tagName === 'SELECT' ? input.value : Number(input.value);
      if (key === 'cellId' && ventModule) ventModule.parameters.cellId = input.value;
      graph = withHumanEdit({ ...graph, analysisModules: [...graph.analysisModules] },
        'safety-scenario-changed', `Changed runaway scenario parameter ${key}.`);
      renderAll();
    };
  });
  $('scenarioInspector').querySelector('[data-runaway-percent="soc"]')?.addEventListener('change', (event) => {
    p.soc = Number(event.target.value) / 100;
    graph = withHumanEdit({ ...graph, analysisModules: [...graph.analysisModules] },
      'safety-scenario-changed', 'Changed runaway scenario state of charge.');
    renderAll();
  });
  $('scenarioInspector').querySelectorAll('[data-vent]').forEach((input) => {
    input.onchange = () => {
      v[input.dataset.vent] = input.value === '' ? null : Number(input.value);
      graph = withHumanEdit({ ...graph, analysisModules: [...graph.analysisModules] },
        'vent-scenario-changed', `Changed vent-sizing parameter ${input.dataset.vent}.`);
      renderAll();
    };
  });
  $('scenarioInspector').querySelectorAll('[data-vent-text]').forEach((input) => {
    input.onchange = () => {
      v[input.dataset.ventText] = input.value.trim();
      graph = withHumanEdit({ ...graph, analysisModules: [...graph.analysisModules] },
        'vent-scenario-changed', `Changed vent-sizing evidence ${input.dataset.ventText}.`);
      renderAll();
    };
  });
  $('scenarioInspector').querySelectorAll('[data-vent-face]').forEach((input) => {
    input.onchange = () => {
      const faces = [...$('scenarioInspector').querySelectorAll('[data-vent-face]:checked')]
        .map((item) => item.dataset.ventFace);
      v.allowedVentFaces = faces.join(',');
      if (v.preferredVentFace && !faces.includes(v.preferredVentFace)) v.preferredVentFace = '';
      graph = withHumanEdit({ ...graph, analysisModules: [...graph.analysisModules] },
        'vent-placement-changed', 'Changed the human-screened vent discharge faces.');
      renderAll();
    };
  });
}

function exportGraphFile() {
  try {
    const blob = new Blob([exportStudioGraph(graph)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${graph.id || 'equation-graph'}.bdgraph.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    setRunMessage('Export failed', error.message, 'fail');
  }
}

async function importGraphFile() {
  const file = $('importFile').files?.[0];
  if (!file) return;
  try {
    graph = importStudioGraph(await file.text());
    resetTransientState();
    renderAll();
    setRunMessage('Graph imported', 'Checksum verified. Validate before running.', 'neutral');
  } catch (error) {
    setRunMessage('Import rejected', error.message, 'fail');
  } finally {
    $('importFile').value = '';
  }
}

async function runSilCalculationTest() {
  const outputId = $('silOutputSelect').value;
  const node = graph.nodes.find((item) => item.id === outputId);
  const minimum = Number($('silMinimum').value);
  const maximum = Number($('silMaximum').value);
  if (!node || $('silMinimum').value === '' || $('silMaximum').value === ''
    || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
    $('loopResults').innerHTML = '<div class="diagnostic fail"><b>SIL test needs an independent acceptance range</b><span>Select an output and enter finite ordered minimum and maximum values from a requirement, analytical result or trusted reference.</span></div>';
    return;
  }
  const failure = validateStudioGraph(graph).find((item) => item.severity === 'fail');
  if (failure) {
    $('loopResults').innerHTML = `<div class="diagnostic fail"><b>Graph is not executable</b><span>${esc(failure.summary)}</span></div>`;
    return;
  }
  if (!equationGraphWasmReady() && !await initializeWasmCore()) {
    $('loopResults').innerHTML = '<div class="diagnostic fail"><b>Rust engine unavailable</b><span>Build the generated WebAssembly asset before running SIL.</span></div>';
    return;
  }
  try {
    const probe = simulateEquationGraph(graph);
    const unit = QUANTITIES[node.outputQuantity]?.unit || '—';
    const plan = createSilTestPlan({
      modelId: graph.id, modelVersion: graph.version, graphChecksum: graphChecksum(graph),
      solver: probe.solver.method,
      cases: [{
        id: `final-${node.id}`, purpose: `Verify final ${node.name} against an independent accepted range.`,
        inputs: {}, expected: { outputPath: 'finalValue', unit, min: minimum, max: maximum },
      }],
    });
    const adapter = () => {
      const result = simulateEquationGraph(graph);
      return {
        graphChecksum: graphChecksum(graph), modelVersion: graph.version,
        solver: result.solver.method,
        outputs: { finalValue: result.points.at(-1)?.values?.[node.id] },
        units: { finalValue: unit },
      };
    };
    const report = runSoftwareInLoop(plan, adapter);
    const item = report.cases[0];
    $('loopResults').innerHTML = `<div class="diagnostic ${item.status}"><b>SIL calculation ${item.status === 'pass' ? 'passed' : 'failed'}</b><span>${esc(node.name)} = ${formatValue(item.actual)} ${esc(item.actualUnit || unit)}; accepted ${formatValue(minimum)}–${formatValue(maximum)}. Identity, units and exact repeatability were also checked.</span></div><p class="muted">Graph ${esc(report.graphChecksum)} · model ${esc(report.modelVersion)} · solver ${esc(report.solver)}</p>`;
  } catch (error) {
    $('loopResults').innerHTML = `<div class="diagnostic fail"><b>SIL execution stopped</b><span>${esc(error.message)}</span></div>`;
  }
}

function prepareHilContract() {
  try {
    if (!graph.nodes.length) throw new Error('Prepare and validate a model before creating its HIL contract.');
    const samplePeriodUs = Number($('hilSamplePeriod').value);
    const contract = createHilTestContract({
      targetId: 'customer-hil-target', modelId: graph.id, modelVersion: graph.version,
      graphChecksum: graphChecksum(graph), samplePeriodUs, durationS: 60,
      inputs: [
        { id: 'pack-voltage', quantity: 'voltage', unit: 'V', min: 0, max: 1000 },
        { id: 'pack-current', quantity: 'current', unit: 'A', min: -1000, max: 1000 },
        { id: 'max-cell-temperature', quantity: 'temperature', unit: 'K', min: 223.15, max: 523.15 },
      ],
      outputs: [
        { id: 'contactor-command', quantity: 'boolean', unit: '0/1', min: 0, max: 1, safeValue: 0 },
        { id: 'cooling-command', quantity: 'fraction', unit: '0–1', min: 0, max: 1, safeValue: 1 },
      ],
      overrun: { maxConsecutive: 0, action: 'Open contactors and command maximum cooling.' },
    });
    const report = evaluateHilEvidence(contract);
    $('loopResults').innerHTML = `<div class="diagnostic warn"><b>HIL starter contract ready — hardware run required</b><span>${esc(report.headline)} Fixed period ${contract.samplePeriodUs} µs; ${contract.inputs.length} inputs, ${contract.outputs.length} outputs and ${contract.requiredFaults.length} required fault tests.</span></div><p class="muted">The visible voltage, current, temperature, contactor and cooling channels are a battery-controller starter map. A human must replace them with the production I/O map. Required faults: ${contract.requiredFaults.map(esc).join(' · ')}. Browser playback cannot satisfy this contract.</p>`;
  } catch (error) {
    $('loopResults').innerHTML = `<div class="diagnostic fail"><b>HIL contract rejected</b><span>${esc(error.message)}</span></div>`;
  }
}

async function runSimulation() {
  runDebug(false); renderDiagnostics();
  const failure = lastDiagnostics.find((item) => item.severity === 'fail');
  if (failure) { setRunMessage('Simulation blocked', failure.summary, 'fail'); return; }
  $('runButton').disabled = true;
  setRunMessage('Running authoritative equation graph…', 'The UI remains separate from the numerical result.', 'neutral');
  try {
    if (!equationGraphWasmReady() && !await initializeWasmCore()) {
      throw Object.assign(new Error('The generated Rust/WebAssembly asset is unavailable.'), { code: 'runtime.rust_unavailable' });
    }
    const result = simulateEquationGraph(graph);
    const safety = graph.analysisModules?.length ? await runAnalysisWorker(graph) : [];
    renderSimulationResult(result);
    renderSafetyResults(safety);
    if (safety.some((item) => item.status === 'fail')) {
      setRunMessage('Simulation completed with a safety failure', `${result.points.length} trace points · review the failing attached study`, 'fail');
    } else if (safety.some((item) => item.status !== 'pass')) {
      setRunMessage('Simulation completed — review required', `${result.points.length} trace points · attached safety evidence is conditional, unproven or incomplete`, 'neutral');
    } else {
      setRunMessage('Simulation complete', `${result.points.length} trace points · ${result.solver.method}`, 'pass');
    }
  } catch (error) {
    setRunMessage('Simulation stopped', `${error.code ? `${error.code}: ` : ''}${error.message}`, 'fail');
  } finally {
    $('runButton').disabled = false;
  }
}

function runAnalysisWorker(model) {
  if (typeof Worker !== 'function') return Promise.resolve(runAttachedAnalysisModules(model));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cosim-analysis-worker.js', import.meta.url), { type: 'module', name: 'battery-safety-analysis' });
    const id = Date.now();
    worker.onmessage = (event) => {
      if (event.data.id !== id) return;
      worker.terminate();
      if (event.data.ok) resolve(event.data.results);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id, graph: model });
  });
}

function renderSimulationResult(result) {
  $('resultSection').hidden = false;
  const last = result.points.at(-1);
  $('resultSummary').innerHTML = `<div class="diagnostic pass"><b>Equation run completed</b><span>The result is a Rust trace over the approved graph, not a UI estimate.</span></div>`;
  const visibleId = selectedNodeId && result.blockIds.includes(selectedNodeId)
    ? selectedNodeId : result.blockIds.at(-1);
  const values = result.points.map((point) => point.values[visibleId]);
  const times = result.points.map((point) => point.timeS);
  drawTrace(times, values);
  $('solverEvidence').innerHTML = `Selected <b>${esc(result.solver.method)}</b> because <b>${esc(result.solver.reason)}</b>.<br>${result.acceptedSteps} accepted steps · ${result.rejectedSteps} rejected · ${result.nonlinearIterations} nonlinear iterations.<br>Graph checksum: <code>${esc(graphChecksum(graph))}</code>`;
  playTrace(result);
  if (last) updateLiveValues(last, result.blockIds);
}

function drawTrace(times, values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) { $('traceChart').replaceChildren(); return; }
  const x0 = times[0], x1 = times.at(-1) || x0 + 1;
  let y0 = Math.min(...finite), y1 = Math.max(...finite);
  if (y1 === y0) { y0 -= 1; y1 += 1; }
  const point = (time, value) => `${20 + 288 * (time - x0) / (x1 - x0 || 1)},${112 - 96 * (value - y0) / (y1 - y0)}`;
  const stride = Math.max(1, Math.floor(times.length / 400));
  const sampled = times.map((time, index) => ({ time, value: values[index], index })).filter((item) => item.index % stride === 0 || item.index === times.length - 1);
  $('traceChart').innerHTML = `<path class="trace-axis" d="M20 8V112H312"/><polyline class="trace-line" points="${sampled.map((item) => point(item.time, item.value)).join(' ')}"/><line id="traceCursor" class="trace-cursor" x1="20" y1="8" x2="20" y2="112"/>`;
}

function playTrace(result) {
  cancelAnimationFrame(traceAnimation);
  const started = performance.now();
  const durationMs = 4200;
  const step = (stamp) => {
    const progress = Math.min(1, (stamp - started) / durationMs);
    const index = Math.min(result.points.length - 1, Math.floor(progress * (result.points.length - 1)));
    updateLiveValues(result.points[index], result.blockIds);
    const cursor = $('traceCursor');
    if (cursor) { const x = 20 + 288 * progress; cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); }
    if (progress < 1) traceAnimation = requestAnimationFrame(step);
  };
  traceAnimation = requestAnimationFrame(step);
}

function updateLiveValues(point, blockIds) {
  const chosen = [selectedNodeId, ...blockIds.slice(-3)].filter((id, index, all) => id && all.indexOf(id) === index && point.values[id] != null).slice(0, 4);
  $('liveValues').innerHTML = `<div class="live-value"><span>Simulation time</span><b>${formatValue(point.timeS)} s</b></div>${chosen.map((id) => {
    const node = graph.nodes.find((item) => item.id === id);
    return `<div class="live-value"><span>${esc(node?.name || id)}</span><b>${formatValue(point.values[id])} ${esc(QUANTITIES[node?.outputQuantity]?.unit || '')}</b></div>`;
  }).join('')}`;
}

function renderRunawaySafetyResult(result) {
  return `
    <div class="safety-card ${result.status === 'fail' ? 'fail' : ''}">
      <h3>${result.status === 'fail' ? 'Fail — propagation predicted' : 'Unproven — never a safety pass'}</h3>
      <p>${esc(result.headline)}</p>
      <p><b>${result.evidence.triggeredCells}/${result.evidence.modelledCells}</b> cells triggered · containment case <b>${result.evidence.containmentMJ.toFixed(1)} MJ</b></p>
      <h3>Chemistry behavior on the same design</h3>
      <p>${esc(result.evidence.chemistryComparisonBasis)}</p>
      <table class="barrier-table chemistry-table"><thead><tr><th>Chemistry</th><th>Onset</th><th>Heat class</th><th>Meaning</th></tr></thead><tbody>${result.evidence.chemistryComparison.map((row) => `<tr><td><b>${esc(row.label)}</b><br><span class="status-chip ${row.outcome === 'fail' ? 'fail' : 'neutral'}">${row.outcome === 'fail' ? 'Fail' : 'Unproven'}</span></td><td>${row.onsetC.toFixed(0)} °C</td><td>${row.releaseMultiple.toFixed(1)}× stored energy<br>${row.releasePerCellMJ.toFixed(2)} MJ/cell</td><td><b>${esc(row.tone)}</b><br>${esc(row.explanation)}</td></tr>`).join('')}</tbody></table>
      <p><b>Customer meaning:</b> NMC demands the earliest intervention in this class comparison; LFP normally provides more onset and heat-release margin; LTO provides the largest thermal margin here. None is a safety approval.</p>
      <h3>Calculated heat paths between cells</h3>
      <p>The selected <b>${esc(result.evidence.heatPaths.spacer)}</b> contacts ${(result.evidence.heatPaths.spacerContactFraction * 100).toFixed(0)}% of the modeled face over a ${result.evidence.heatPaths.spacerLengthMm.toFixed(1)} mm heat path.</p>
      <table class="barrier-table"><thead><tr><th>Path</th><th>Conductance</th><th>How it enters the equation</th></tr></thead><tbody>
        <tr><td>Air + barrier</td><td>${result.evidence.heatPaths.gapWPerK.toFixed(4)} W/K</td><td>Series resistance through barrier and remaining air</td></tr>
        <tr><td>Cell spacer / holder</td><td>${result.evidence.heatPaths.spacerWPerK.toFixed(4)} W/K</td><td>Parallel bridge from material, contact area and path length</td></tr>
        <tr><td>Electrical interconnect</td><td>${result.evidence.heatPaths.interconnectWPerK.toFixed(4)} W/K</td><td>Parallel metallic heat bridge</td></tr>
        <tr><td><b>Total conduction</b></td><td><b>${result.evidence.heatPaths.totalWPerK.toFixed(4)} W/K</b></td><td>Sum of all three paths</td></tr>
        <tr><td>Radiation</td><td>${result.evidence.heatPaths.radiationActive ? 'Active' : 'Blocked'}</td><td>Nonlinear T⁴ exchange unless the barrier is opaque</td></tr>
      </tbody></table>
      <h3>Spacer / holder comparison</h3>
      <table class="barrier-table"><thead><tr><th>Spacer</th><th>Spacer bridge</th><th>Comparison margin</th></tr></thead><tbody>${result.evidence.rankedSpacers.map((row) => `<tr><td>${esc(row.label)}</td><td>${row.spacerWK.toFixed(4)} W/K</td><td>${row.marginK.toFixed(0)} K</td></tr>`).join('')}</tbody></table>
      <h3>Barrier comparison for the selected chemistry</h3>
      <table class="barrier-table"><thead><tr><th>Barrier</th><th>Comparison margin</th></tr></thead><tbody>${result.evidence.rankedBarriers.map((row) => `<tr><td>${esc(row.label)}</td><td>${row.marginK.toFixed(0)} K</td></tr>`).join('')}</tbody></table>
      <details class="evidence-fold"><summary>Show the propagation equations</summary><div>${Object.entries(result.evidence.equations).map(([name, equation]) => `<p><b>${esc(name)}</b><br><code>${esc(equation)}</code></p>`).join('')}</div></details>
      <p><b>Boundary:</b> ${esc(result.limitations[0])}</p>
    </div>`;
}

function renderVentSafetyResult(result) {
  if (result.status === 'needs-input') return `
    <div class="safety-card">
      <h3>Vent area — test data required</h3>
      <p>${esc(result.headline)}</p>
      <p><b>Enter:</b> ${result.missingInputs.map(esc).join(', ')}.</p>
      <p><b>Why:</b> gas yield and release rate vary by actual cell, state of charge, age and abuse method; NMC, LFP or LTO alone is not enough.</p>
      <p><b>Boundary:</b> ${esc(result.limitations[0])}</p>
    </div>`;
  if (result.status === 'needs-hardware') {
    const vent = result.evidence;
    return `<div class="safety-card">
      <h3>Vent hardware and placement — evidence required</h3>
      <p>${esc(result.headline)}</p>
      <div class="vent-range"><div><span>Low case</span><b>${vent.low.areaCm2.toFixed(1)} cm²</b></div><div><span>High case</span><b>${vent.high.areaCm2.toFixed(1)} cm²</b></div></div>
      <p><b>Still needed:</b> ${result.missingHardwareInputs.map(esc).join(', ')}.</p>
      <p><b>Customer meaning:</b> the pressure equation is available, but the software will not invent a supplier vent, quantity, compatible market or safe discharge face.</p>
      <p><b>Boundary:</b> ${esc(result.limitations[0])}</p>
    </div>`;
  }
  const vent = result.evidence;
  const layout = vent.hardwareLayout;
  const placementRows = layout.placements.map((item) => `<tr><td>${esc(item.id)}</td><td>${esc(item.face)}</td><td>${item.centerMm.x.toFixed(1)}, ${item.centerMm.y.toFixed(1)}, ${item.centerMm.z.toFixed(1)} mm</td><td>${item.footprintMm.width.toFixed(1)} × ${item.footprintMm.height.toFixed(1)} mm${item.rotated ? ' · rotated' : ''}</td><td>${item.dischargeDirection.x}, ${item.dischargeDirection.y}, ${item.dischargeDirection.z}</td></tr>`).join('');
  return `
    <div class="safety-card ${result.status === 'fail' ? 'fail' : ''}">
      <h3>${result.status === 'fail' ? 'Vent layout blocked' : 'Conditional vent-area screen and hardware layout'}</h3>
      <p>${esc(result.headline)}</p>
      <div class="vent-range"><div><span>Low case</span><b>${vent.low.areaCm2.toFixed(1)} cm²</b><small>Ø ${vent.low.equivalentDiameterMm.toFixed(0)} mm equivalent</small></div><div><span>High case</span><b>${vent.high.areaCm2.toFixed(1)} cm²</b><small>Ø ${vent.high.equivalentDiameterMm.toFixed(0)} mm equivalent</small></div></div>
      <table class="barrier-table"><thead><tr><th>Calculation input</th><th>Declared range / value</th></tr></thead><tbody>
        <tr><td>Cells venting</td><td>${vent.inputs.ventingCells}</td></tr>
        <tr><td>Gas at reference conditions</td><td>${vent.inputs.gasVolumeLowLPerCell}–${vent.inputs.gasVolumeHighLPerCell} L/cell</td></tr>
        <tr><td>Release duration</td><td>${vent.inputs.releaseDurationLowS}–${vent.inputs.releaseDurationHighS} s</td></tr>
        <tr><td>Allowable enclosure pressure</td><td>${vent.inputs.allowableGaugePressureKPa} kPa gauge</td></tr>
        <tr><td>Gas / opening assumptions</td><td>${vent.inputs.ventGasTemperatureC} °C · C<sub>d</sub> ${vent.inputs.dischargeCoefficient} · γ ${vent.inputs.gamma}</td></tr>
        <tr><td>Flow regime</td><td>${esc(vent.low.regime)} to ${esc(vent.high.regime)}</td></tr>
        <tr><td>Evidence basis</td><td>${esc(vent.inputs.gasDataBasis)}</td></tr>
      </tbody></table>
      <h3>Market-bounded hardware selection</h3>
      <table class="barrier-table"><tbody>
        <tr><td>Market profile</td><td>${esc(layout.marketProfile.label)} · ${esc(layout.marketProfile.id)}</td></tr>
        <tr><td>Supplier unit</td><td>${esc(layout.unit.supplier)} ${esc(layout.unit.partNumber)} · ${esc(layout.unit.name)}</td></tr>
        <tr><td>Required quantity</td><td><b>${layout.requiredQuantity}</b> × ${layout.unit.freeAreaCm2.toFixed(1)} cm² free area</td></tr>
        <tr><td>Total declared free area</td><td>${layout.totalDeclaredFreeAreaCm2.toFixed(1)} cm²${layout.status === 'provisional' ? ` · ${layout.freeAreaMarginCm2.toFixed(1)} cm² above high case` : ''}</td></tr>
        <tr><td>Supplier evidence</td><td>${esc(layout.unit.evidenceBasis)}</td></tr>
      </tbody></table>
      ${layout.status === 'blocked' ? `<p><b>Why blocked:</b> ${esc(layout.headline)}</p><ul>${layout.correctiveActions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `
      <h3>Provisional vent coordinates</h3>
      <p>Enclosure X/Y/Z: ${layout.enclosureMm.x.toFixed(1)} × ${layout.enclosureMm.y.toFixed(1)} × ${layout.enclosureMm.z.toFixed(1)} mm. Gas source: ${layout.gasSourceMm.x.toFixed(1)}, ${layout.gasSourceMm.y.toFixed(1)}, ${layout.gasSourceMm.z.toFixed(1)} mm.</p>
      <table class="barrier-table vent-placement-table"><thead><tr><th>Vent</th><th>Face</th><th>Center X/Y/Z</th><th>Footprint</th><th>Outward vector</th></tr></thead><tbody>${placementRows}</tbody></table>
      <p>${esc(layout.placementBasis)}</p>
      <details class="evidence-fold"><summary>Show placement approval checklist</summary><ul>${layout.approvalChecklist.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></details>`}
      <p><b>Customer meaning:</b> the high-case area sets the minimum unobstructed opening. The quantity uses supplier-declared free area, not outside diameter, and the coordinates use only faces a human marked as externally safe.</p>
      <details class="evidence-fold"><summary>Show vent equations and required tests</summary><div>${Object.entries(vent.equations).map(([name, equation]) => `<p><b>${esc(name)}</b><br><code>${esc(equation)}</code></p>`).join('')}<h4>Required physical evidence</h4><ul>${vent.requiredTests.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div></details>
      <p><b>Boundary:</b> ${esc(result.limitations[0])}</p>
    </div>`;
}

function renderSafetyResults(results) {
  $('safetySection').hidden = !results.length;
  $('safetyResults').innerHTML = results.map((result) => {
    if (result.type === 'runaway-propagation') return renderRunawaySafetyResult(result);
    if (result.type === 'vent-sizing') return renderVentSafetyResult(result);
    return `<div class="safety-card fail"><h3>Unsupported safety result</h3><p>${esc(result.type)}</p></div>`;
  }).join('');
}

function setRunMessage(headline, detail, tone) {
  $('runHeadline').textContent = headline;
  $('runDetail').textContent = detail;
  $('runHeadline').style.color = tone === 'fail' ? 'var(--fail)' : tone === 'pass' ? 'var(--ok)' : '';
}

function formatValue(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 100000 || (magnitude > 0 && magnitude < .001)) return value.toExponential(3);
  return value.toLocaleString(undefined, { maximumFractionDigits: magnitude < 10 ? 3 : 1 });
}

init();
