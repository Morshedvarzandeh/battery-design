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
  const badge = $('healthBadge');
  if (!graph.nodes.length) { badge.textContent = 'Empty'; badge.className = 'status-chip neutral'; }
  else if (failures.length) { badge.textContent = `${failures.length} blocked`; badge.className = 'status-chip fail'; }
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
    setRunMessage('Simulation complete', `${result.points.length} trace points · ${result.solver.method}`, 'pass');
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

function renderSafetyResults(results) {
  $('safetySection').hidden = !results.length;
  $('safetyResults').innerHTML = results.map((result) => `
    <div class="safety-card ${result.status === 'fail' ? 'fail' : ''}">
      <h3>${result.status === 'fail' ? 'Fail — propagation predicted' : 'Unproven — never a safety pass'}</h3>
      <p>${esc(result.headline)}</p>
      <p><b>${result.evidence.triggeredCells}/${result.evidence.modelledCells}</b> cells triggered · containment case <b>${result.evidence.containmentMJ.toFixed(1)} MJ</b></p>
      <h3>Chemistry behavior on the same design</h3>
      <p>${esc(result.evidence.chemistryComparisonBasis)}</p>
      <table class="barrier-table chemistry-table"><thead><tr><th>Chemistry</th><th>Onset</th><th>Heat class</th><th>Meaning</th></tr></thead><tbody>${result.evidence.chemistryComparison.map((row) => `<tr><td><b>${esc(row.label)}</b><br><span class="status-chip ${row.outcome === 'fail' ? 'fail' : 'neutral'}">${row.outcome === 'fail' ? 'Fail' : 'Unproven'}</span></td><td>${row.onsetC.toFixed(0)} °C</td><td>${row.releaseMultiple.toFixed(1)}× stored energy<br>${row.releasePerCellMJ.toFixed(2)} MJ/cell</td><td><b>${esc(row.tone)}</b><br>${esc(row.explanation)}</td></tr>`).join('')}</tbody></table>
      <p><b>Customer meaning:</b> NMC demands the earliest intervention in this class comparison; LFP normally provides more onset and heat-release margin; LTO provides the largest thermal margin here. None is a safety approval.</p>
      <h3>Barrier comparison for the selected chemistry</h3>
      <table class="barrier-table"><thead><tr><th>Barrier</th><th>Comparison margin</th></tr></thead><tbody>${result.evidence.rankedBarriers.map((row) => `<tr><td>${esc(row.label)}</td><td>${row.marginK.toFixed(0)} K</td></tr>`).join('')}</tbody></table>
      <p><b>Boundary:</b> ${esc(result.limitations[0])}</p>
    </div>`).join('');
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
