// Co-Simulation Studio model boundary.
//
// This module is deliberately pure: it owns the approved block manifest,
// versioned graph document, deterministic transport, guided recommendations
// and reviewable repair proposals.  The browser canvas is only a view over
// this data, and Rust remains the authority that compiles and solves it.

export const GRAPH_SCHEMA = 'battery-design/equation-graph@1';
export const BLOCK_CATALOG_VERSION = '2026.08.1';
export const GRAPH_TRANSPORT_MAGIC = 0x42444731; // "BDG1"
export const GRAPH_TRANSPORT_VERSION = 1;
export const GRAPH_TRANSPORT_HEADER_LENGTH = 17;
export const GRAPH_TRANSPORT_BLOCK_LENGTH = 6;
export const GRAPH_TRANSPORT_CONNECTION_LENGTH = 3;

export const QUANTITIES = Object.freeze({
  dimensionless: { code: 0, label: 'Number', unit: '—' },
  fraction: { code: 1, label: 'Fraction', unit: '0–1' },
  'fraction-per-second': { code: 2, label: 'Fraction rate', unit: '1/s' },
  voltage: { code: 3, label: 'Voltage', unit: 'V' },
  current: { code: 4, label: 'Current', unit: 'A' },
  power: { code: 5, label: 'Power', unit: 'W' },
  energy: { code: 6, label: 'Energy', unit: 'J' },
  temperature: { code: 7, label: 'Temperature', unit: 'K' },
  'temperature-rate': { code: 8, label: 'Temperature rate', unit: 'K/s' },
  heat: { code: 9, label: 'Heat flow', unit: 'W' },
  speed: { code: 10, label: 'Angular speed', unit: 'rad/s' },
  torque: { code: 11, label: 'Torque', unit: 'N·m' },
});

const PARAM = (name, label, defaultValue, options = {}) => Object.freeze({
  name, label, defaultValue, ...options,
});

export const BLOCK_CATALOG = Object.freeze({
  constant: Object.freeze({
    code: 0, name: 'Constant', group: 'Sources', summary: 'A fixed sourced value.',
    parameters: [PARAM('value', 'Value', 1)],
    output: 'selectable', inputs: () => [],
  }),
  step: Object.freeze({
    code: 1, name: 'Step source', group: 'Sources', summary: 'A value that changes once at a known time.',
    parameters: [
      PARAM('before', 'Before', 0), PARAM('after', 'After', 1),
      PARAM('atS', 'Change at', 1, { unit: 's', min: 0 }),
    ],
    output: 'selectable', inputs: () => [],
  }),
  gain: Object.freeze({
    code: 2, name: 'Gain', group: 'Math', summary: 'Scales one signal with an explicit input quantity.',
    parameters: [
      PARAM('gain', 'Gain', 1), PARAM('inputQuantity', 'Input quantity', 'dimensionless', { kind: 'quantity' }),
    ],
    output: 'selectable', inputs: (node) => [{ id: 'in0', label: 'Input', quantity: node.parameters.inputQuantity }],
  }),
  sum: Object.freeze({
    code: 3, name: 'Sum', group: 'Math', summary: 'Adds signals carrying the same quantity.',
    parameters: [PARAM('inputs', 'Inputs', 2, { integer: true, min: 1, max: 16 })],
    output: 'selectable', inputs: (node) => Array.from(
      { length: Math.max(0, Math.trunc(node.parameters.inputs)) },
      (_, index) => ({ id: `in${index}`, label: `Input ${index + 1}`, quantity: node.outputQuantity }),
    ),
  }),
  product: Object.freeze({
    code: 4, name: 'Product', group: 'Math', summary: 'Multiplies two typed inputs and an explicit scale.',
    parameters: [
      PARAM('scale', 'Scale', 1),
      PARAM('leftQuantity', 'Left quantity', 'dimensionless', { kind: 'quantity' }),
      PARAM('rightQuantity', 'Right quantity', 'dimensionless', { kind: 'quantity' }),
    ],
    output: 'selectable', inputs: (node) => [
      { id: 'in0', label: 'Left', quantity: node.parameters.leftQuantity },
      { id: 'in1', label: 'Right', quantity: node.parameters.rightQuantity },
    ],
  }),
  limit: Object.freeze({
    code: 5, name: 'Limit', group: 'Control', summary: 'Keeps a signal inside reviewed minimum and maximum bounds.',
    parameters: [PARAM('min', 'Minimum', 0), PARAM('max', 'Maximum', 1)],
    output: 'selectable', inputs: (node) => [{ id: 'in0', label: 'Input', quantity: node.outputQuantity }],
  }),
  integrator: Object.freeze({
    code: 6, name: 'Integrator', group: 'States', summary: 'Accumulates a typed rate into a continuous state.',
    parameters: [
      PARAM('initial', 'Initial value', 0),
      PARAM('rateQuantity', 'Rate quantity', 'dimensionless', { kind: 'quantity' }),
      PARAM('gain', 'Rate gain', 1),
    ],
    output: 'selectable', inputs: (node) => [{ id: 'in0', label: 'Rate', quantity: node.parameters.rateQuantity }],
  }),
  'first-order': Object.freeze({
    code: 7, name: 'First-order state', group: 'States', summary: 'A state that approaches its input with one time constant.',
    parameters: [
      PARAM('tauS', 'Time constant', 1, { unit: 's', minExclusive: 0 }),
      PARAM('initial', 'Initial value', 0),
    ],
    output: 'selectable', inputs: (node) => [{ id: 'in0', label: 'Target', quantity: node.outputQuantity }],
  }),
  'thermal-rate': Object.freeze({
    code: 8, name: 'Thermal balance', group: 'Battery', summary: 'Lumped heat balance with ambient loss.',
    parameters: [
      PARAM('heatCapacityJPerK', 'Heat capacity', 900, { unit: 'J/K', minExclusive: 0 }),
      PARAM('conductanceWPerK', 'Ambient conductance', 1, { unit: 'W/K', min: 0 }),
    ],
    output: 'temperature-rate', inputs: () => [
      { id: 'in0', label: 'Generated heat', quantity: 'heat' },
      { id: 'in1', label: 'Temperature', quantity: 'temperature' },
      { id: 'in2', label: 'Ambient', quantity: 'temperature' },
    ],
  }),
});

export const STUDIO_MODES = Object.freeze({
  guided: {
    label: 'Guided', description: 'Describe the goal; review a small, explained block draft.',
  },
  manual: {
    label: 'Manual', description: 'Add and connect approved blocks yourself.',
  },
  automatic: {
    label: 'Automatic draft', description: 'The assistant prepares a complete draft; a human must approve it.',
  },
});

// Spatial/safety studies do not pretend to be scalar equation blocks.  They
// attach to the governed graph as versioned analysis modules and preserve
// their own validation boundary and limitations.
export const ANALYSIS_MODULE_CATALOG = Object.freeze({
  'runaway-propagation': Object.freeze({
    id: 'runaway-propagation', name: 'Thermal-runaway propagation', markets: ['road', 'grid'],
    solver: 'js/runaway.propagationStudy@1',
    summary: 'Compares cell spacing and barrier options after one cell is triggered.',
    limitation: 'Screening comparison only: hot gas, flame, electrolyte and ejecta are not modelled, so it can reject a design but never clear one.',
  }),
  'vent-sizing': Object.freeze({
    id: 'vent-sizing', name: 'Emergency pressure-relief sizing', markets: ['road', 'grid'],
    solver: 'js/venting.sizeEmergencyVent@1+vent-layout.selectVentHardwareLayout@2',
    summary: 'Calculates a conditional free-flow area, supplier vent quantity and provisional placement on reviewed enclosure faces.',
    limitation: 'Compressible-orifice screening only: measured gas-release data and production enclosure/vent tests are required; it is not NFPA 68 deflagration sizing or a safety approval.',
  }),
});

const DEFAULT_SETTINGS = Object.freeze({
  method: 'auto', startS: 0, endS: 20, initialStepS: 0.02,
  minStepS: 1e-9, maxStepS: 0.25, relativeTolerance: 1e-6,
  absoluteTolerance: 1e-9, maxSteps: 100000,
  algebraicTolerance: 1e-10, algebraicMaxIterations: 30,
  implicitTolerance: 1e-10, implicitMaxIterations: 20,
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const safeId = (value) => String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '');

/** Create one approved primitive block. */
export function createBlockNode(type, options = {}) {
  const spec = BLOCK_CATALOG[type];
  if (!spec) throw new RangeError(`Unknown approved block type: ${type}`);
  const outputQuantity = spec.output === 'selectable'
    ? (options.outputQuantity || 'dimensionless') : spec.output;
  if (!QUANTITIES[outputQuantity]) throw new RangeError(`Unknown output quantity: ${outputQuantity}`);
  const parameters = Object.fromEntries(spec.parameters.map((parameter) => [
    parameter.name,
    options.parameters?.[parameter.name] ?? parameter.defaultValue,
  ]));
  return {
    id: safeId(options.id || `${type}-${Math.random().toString(36).slice(2, 8)}`),
    type,
    name: String(options.name || spec.name),
    outputQuantity,
    parameters,
    position: {
      x: Number.isFinite(options.position?.x) ? options.position.x : 80,
      y: Number.isFinite(options.position?.y) ? options.position.y : 80,
    },
  };
}

export function createStudioGraph(options = {}) {
  const market = options.market || 'road';
  if (!['road', 'grid'].includes(market)) throw new RangeError(`Unsupported first-release market: ${market}`);
  const segment = market === 'grid' ? (options.segment || 'home') : null;
  if (market === 'grid' && !['home', 'small-company', 'industrial'].includes(segment)) {
    throw new RangeError(`Unknown grid segment: ${segment}`);
  }
  const mode = options.mode || 'guided';
  if (!STUDIO_MODES[mode]) throw new RangeError(`Unknown studio mode: ${mode}`);
  return {
    schema: GRAPH_SCHEMA,
    catalogVersion: BLOCK_CATALOG_VERSION,
    id: safeId(options.id || 'untitled-model'),
    title: String(options.title || 'Untitled model'),
    market,
    segment,
    mode,
    version: String(options.version || '0.1.0-draft'),
    nodes: [],
    connections: [],
    analysisModules: [],
    settings: { ...DEFAULT_SETTINGS, ...(options.settings || {}) },
    history: [{
      action: 'created', actorId: options.actorId || 'local-user', actorKind: 'human',
      reason: options.reason || 'Created a new governed equation graph.', at: options.at || now(),
    }],
  };
}

/** @param {ReturnType<typeof createBlockNode>} node */
export function inputPorts(node) {
  const spec = BLOCK_CATALOG[node?.type];
  return spec ? spec.inputs(node) : [];
}

const diag = (code, severity, summary, detail, extra = {}) => ({
  code, severity, summary, detail, ...extra,
});

function parameterDiagnostics(node, spec) {
  const out = [];
  for (const parameter of spec.parameters) {
    const value = node.parameters?.[parameter.name];
    if (parameter.kind === 'quantity') {
      if (!QUANTITIES[value]) out.push(diag(
        'block.invalid_quantity_parameter', 'fail', `${node.name} has an unknown quantity.`,
        `${parameter.label} must name an approved quantity.`, { nodeId: node.id },
      ));
      continue;
    }
    if (!Number.isFinite(value)
      || (parameter.integer && !Number.isInteger(value))
      || (parameter.min != null && value < parameter.min)
      || (parameter.max != null && value > parameter.max)
      || (parameter.minExclusive != null && value <= parameter.minExclusive)) {
      out.push(diag(
        'block.invalid_parameter', 'fail', `${node.name} has an invalid ${parameter.label.toLowerCase()}.`,
        'Restore the value to its sourced operating range before simulation.',
        { nodeId: node.id, parameter: parameter.name },
      ));
    }
  }
  if (node.type === 'limit' && node.parameters.min > node.parameters.max) {
    out.push(diag('block.invalid_parameter', 'fail', `${node.name} has reversed limits.`,
      'Minimum must not exceed maximum.', { nodeId: node.id, parameter: 'min' }));
  }
  return out;
}

/** Validate the same structural contract before transport reaches Rust. */
export function validateStudioGraph(graph) {
  const diagnostics = [];
  if (!graph || graph.schema !== GRAPH_SCHEMA) {
    return [diag('graph.schema', 'fail', 'This model uses an unsupported graph format.',
      `Expected ${GRAPH_SCHEMA}. Export or migrate the model before opening it.`)];
  }
  if (!['road', 'grid'].includes(graph.market)) diagnostics.push(diag(
    'market.unsupported', 'fail', 'This market is not enabled in the first block release.',
    'Choose Road or a segmented Grid workspace.',
  ));
  if (graph.market === 'grid' && !['home', 'small-company', 'industrial'].includes(graph.segment)) {
    diagnostics.push(diag('market.grid_segment_required', 'fail', 'Choose the grid customer segment.',
      'Home, Small company and Industrial have isolated templates and questions.'));
  }
  if (!STUDIO_MODES[graph.mode]) diagnostics.push(diag(
    'graph.mode', 'fail', 'The editing mode is unknown.', 'Choose Guided, Manual or Automatic draft.',
  ));
  if (!Array.isArray(graph.nodes) || !graph.nodes.length) diagnostics.push(diag(
    'graph.empty', 'fail', 'No simulation blocks have been added.',
    'Describe the goal or add an approved source/component block.',
  ));
  for (const module of graph.analysisModules || []) {
    const spec = ANALYSIS_MODULE_CATALOG[module.type];
    if (!spec || !spec.markets.includes(graph.market)) {
      diagnostics.push(diag('analysis.unapproved_module', 'fail', 'This analysis module is not approved for the selected market.',
        'Remove it or open a separate model in the correct market.', { moduleId: module.id }));
      continue;
    }
    const p = module.parameters || {};
    if (module.type === 'runaway-propagation' && (
      !safeId(p.cellId) || !Number.isInteger(p.series) || p.series < 1
      || !Number.isInteger(p.parallel) || p.parallel < 2
      || !Number.isFinite(p.spacingMm) || p.spacingMm < 0
      || !['none', 'mica', 'aerogel', 'potting', 'contact'].includes(p.barrier)
      || !['none', 'pp-holder', 'silicone-pad', 'compression-pad', 'structural-adhesive'].includes(p.spacer)
      || !Number.isFinite(p.soc) || p.soc <= 0 || p.soc > 1
    )) diagnostics.push(diag('analysis.invalid_parameter', 'fail', 'The runaway study has invalid scenario inputs.',
      'Choose a real cell, at least two neighbouring cells, non-negative spacing, a listed barrier and 0–100% state of charge.', { moduleId: module.id }));
    if (module.type === 'vent-sizing') {
      const requiredTestData = [p.gasVolumeLowLPerCell, p.gasVolumeHighLPerCell,
        p.releaseDurationLowS, p.releaseDurationHighS];
      const missingTestData = requiredTestData.some((value) => value == null || value === '');
      if (missingTestData || !String(p.gasDataBasis || '').trim()) diagnostics.push(diag(
        'analysis.vent_test_data_required', 'warn', 'Vent sizing needs representative gas-release test data.',
        'Enter the low/high gas volume per cell, release-duration range and the measurement or scenario basis. Chemistry alone is not a gas-yield input.',
        { moduleId: module.id },
      ));
      const finitePositive = (value) => Number.isFinite(value) && value > 0;
      if (!Number.isInteger(p.ventingCells) || p.ventingCells < 1
        || (!missingTestData && (!requiredTestData.every(finitePositive)
          || p.gasVolumeHighLPerCell < p.gasVolumeLowLPerCell
          || p.releaseDurationHighS < p.releaseDurationLowS))
        || !finitePositive(p.allowableGaugePressureKPa)
        || !finitePositive(p.ambientPressureKPa)
        || !Number.isFinite(p.ventGasTemperatureC) || p.ventGasTemperatureC <= -273.15
        || !finitePositive(p.dischargeCoefficient) || p.dischargeCoefficient > 1
        || !finitePositive(p.specificGasConstantJPerKgK)
        || !Number.isFinite(p.gamma) || p.gamma <= 1) diagnostics.push(diag(
        'analysis.invalid_parameter', 'fail', 'The vent-sizing scenario has invalid inputs.',
        'Use positive ordered gas/release ranges, absolute-valid temperature, 0 < discharge coefficient ≤ 1 and γ > 1.',
        { moduleId: module.id },
      ));
      const hardwareFields = [p.ventUnitId, p.ventUnitName, p.ventSupplier, p.ventPartNumber,
        p.ventUnitFreeAreaCm2, p.ventUnitWidthMm, p.ventUnitHeightMm,
        p.ventUnitMechanism, p.ventOpeningGaugePressureKPa, p.ventTemperatureRatingC,
        p.ventUnitMarketProfiles, p.ventUnitEvidenceBasis, p.ventEvidenceRevision, p.ventEvidenceDate,
        p.allowedVentFaces, p.edgeClearanceMm, p.minimumVentSpacingMm];
      const missingHardwareData = hardwareFields.some((value) => value == null || String(value).trim() === '');
      if (missingHardwareData) diagnostics.push(diag(
        'analysis.vent_hardware_required', 'warn', 'Vent hardware quantity and placement need supplier and enclosure-face data.',
        'Enter supplier free area/footprint/evidence, market compatibility, permitted discharge faces and the reviewed edge/spacing clearances.',
        { moduleId: module.id },
      ));
      if (!(graph.analysisModules || []).some((item) => item.enabled !== false && item.type === 'runaway-propagation')) {
        diagnostics.push(diag(
          'analysis.vent_geometry_required', 'warn', 'Vent placement needs enclosure and gas-source geometry.',
          'Attach the governed runaway scenario so placement uses its actual pack outline and worst-enclosed trigger location.',
          { moduleId: module.id },
        ));
      }
      if (!missingHardwareData) {
        const profiles = String(p.ventUnitMarketProfiles).split(',').map((item) => item.trim()).filter(Boolean);
        const faces = String(p.allowedVentFaces).split(',').map((item) => item.trim()).filter(Boolean);
        const expectedProfile = graph.market === 'road' ? 'road-pack'
          : graph.segment === 'home' ? 'grid-home-pack'
            : graph.segment === 'small-company' ? 'grid-commercial-cabinet'
              : 'grid-industrial-enclosure';
        const validFaces = ['top', 'bottom', 'front', 'rear', 'left', 'right'];
        const footprintCm2 = p.ventUnitWidthMm * p.ventUnitHeightMm / 100;
        const evidenceDate = String(p.ventEvidenceDate || '');
        const parsedEvidenceDate = new Date(`${evidenceDate}T00:00:00Z`);
        const validEvidenceDate = /^\d{4}-\d{2}-\d{2}$/.test(evidenceDate)
          && !Number.isNaN(parsedEvidenceDate.getTime())
          && parsedEvidenceDate.toISOString().slice(0, 10) === evidenceDate;
        if (!finitePositive(p.ventUnitFreeAreaCm2)
          || !finitePositive(p.ventUnitWidthMm) || !finitePositive(p.ventUnitHeightMm)
          || p.ventUnitFreeAreaCm2 > footprintCm2
          || !finitePositive(p.ventOpeningGaugePressureKPa)
          || !Number.isFinite(p.ventTemperatureRatingC) || p.ventTemperatureRatingC <= -273.15
          || !validEvidenceDate
          || !['pressure-relief-device', 'burst-opening', 'directed-duct-exit'].includes(p.ventUnitMechanism)
          || !profiles.includes(expectedProfile)
          || !faces.length || faces.some((face) => !validFaces.includes(face))
          || !Number.isFinite(p.edgeClearanceMm) || p.edgeClearanceMm < 0
          || !Number.isFinite(p.minimumVentSpacingMm) || p.minimumVentSpacingMm < 0
          || (p.preferredVentFace && !faces.includes(p.preferredVentFace))
          || !Number.isInteger(p.maxVentCount) || p.maxVentCount < 1) diagnostics.push(diag(
          'analysis.invalid_parameter', 'fail', 'The supplier vent or placement constraint is invalid.',
          `Use a real positive free area no larger than the footprint, an approved pressure-relief mechanism, ${expectedProfile} compatibility, valid permitted faces and non-negative clearances.`,
          { moduleId: module.id },
        ));
        if (finitePositive(p.ventOpeningGaugePressureKPa)
          && p.ventOpeningGaugePressureKPa >= p.allowableGaugePressureKPa) diagnostics.push(diag(
          'analysis.vent_opening_pressure_incompatible', 'fail', 'The selected vent opens at or above the allowable enclosure pressure.',
          'Select verified hardware whose worst-case opening pressure stays below the structural pressure limit; do not raise the limit without evidence and human approval.',
          { moduleId: module.id },
        ));
        if (Number.isFinite(p.ventTemperatureRatingC)
          && p.ventTemperatureRatingC < p.ventGasTemperatureC) diagnostics.push(diag(
          'analysis.vent_temperature_incompatible', 'fail', 'The selected vent temperature rating is below the declared hot-gas case.',
          'Select hardware with a documented transient temperature rating that covers the declared vent-gas temperature.',
          { moduleId: module.id },
        ));
      }
    }
  }
  const nodes = new Map();
  for (const node of graph.nodes || []) {
    if (!node?.id || nodes.has(node.id)) {
      diagnostics.push(diag('graph.duplicate_block_id', 'fail', 'Every block needs a unique identifier.',
        'Rename or recreate the duplicated block.', { nodeId: node?.id || null }));
      continue;
    }
    nodes.set(node.id, node);
    const spec = BLOCK_CATALOG[node.type];
    if (!spec) {
      diagnostics.push(diag('block.unapproved_type', 'fail', `${node.name || node.id} is not an approved block.`,
        'Replace it with a versioned block from this market library.', { nodeId: node.id }));
      continue;
    }
    if (!QUANTITIES[node.outputQuantity] || (spec.output !== 'selectable' && spec.output !== node.outputQuantity)) {
      diagnostics.push(diag('block.output_quantity', 'fail', `${node.name} has an invalid output quantity.`,
        'Restore the quantity defined by the approved block manifest.', { nodeId: node.id }));
    }
    diagnostics.push(...parameterDiagnostics(node, spec));
  }

  const occupied = new Map();
  const validConnections = new Set();
  for (const connection of graph.connections || []) {
    const source = nodes.get(connection.from);
    const target = nodes.get(connection.to);
    if (!source || !target) {
      diagnostics.push(diag('connection.unknown_block', 'fail', 'A wire points to a block that no longer exists.',
        'Remove the orphaned wire or reconnect it to this model version.', {
          connectionId: connection.id,
          repair: { operation: 'remove-connection', connectionId: connection.id },
        }));
      continue;
    }
    const ports = inputPorts(target);
    const port = ports[connection.toPort];
    if (!port) {
      diagnostics.push(diag('connection.invalid_port', 'fail', `${target.name} has no input ${connection.toPort + 1}.`,
        'Choose an available input on the destination block.', {
          nodeId: target.id, connectionId: connection.id,
          repair: { operation: 'remove-connection', connectionId: connection.id },
        }));
      continue;
    }
    const key = `${target.id}:${connection.toPort}`;
    if (occupied.has(key)) {
      diagnostics.push(diag('connection.duplicate_input', 'fail', `${target.name} input ${connection.toPort + 1} has two wires.`,
        'Keep one wire or insert an approved Sum block.', {
          nodeId: target.id, connectionId: connection.id,
          repair: { operation: 'remove-connection', connectionId: connection.id },
        }));
      continue;
    }
    occupied.set(key, connection.id);
    if (source.outputQuantity !== port.quantity) {
      diagnostics.push(diag('connection.quantity_mismatch', 'fail', `${source.name} cannot connect to ${target.name}.`,
        `${source.name} carries ${QUANTITIES[source.outputQuantity]?.label || source.outputQuantity}; this input requires ${QUANTITIES[port.quantity]?.label || port.quantity}.`, {
          nodeId: target.id, connectionId: connection.id,
          repair: { operation: 'remove-connection', connectionId: connection.id },
        }));
      continue;
    }
    validConnections.add(key);
  }
  for (const node of nodes.values()) {
    for (const [portIndex, port] of inputPorts(node).entries()) {
      const key = `${node.id}:${portIndex}`;
      if (validConnections.has(key)) continue;
      const candidates = [...nodes.values()].filter((source) => source.id !== node.id
        && source.outputQuantity === port.quantity);
      diagnostics.push(diag('connection.missing_input', 'fail', `${node.name} is missing ${port.label.toLowerCase()}.`,
        `Connect one ${QUANTITIES[port.quantity]?.label || port.quantity} output.`, {
          nodeId: node.id, portIndex,
          repair: candidates.length === 1 ? {
            operation: 'connect', from: candidates[0].id, to: node.id, toPort: portIndex,
          } : null,
        }));
    }
  }
  return diagnostics;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalGraph(graph) {
  const copy = clone(graph);
  copy.nodes = [...(copy.nodes || [])].sort((a, b) => a.id.localeCompare(b.id));
  copy.connections = [...(copy.connections || [])].sort((a, b) =>
    a.to.localeCompare(b.to) || a.toPort - b.toPort || a.from.localeCompare(b.from));
  copy.analysisModules = [...(copy.analysisModules || [])].sort((a, b) => a.id.localeCompare(b.id));
  return canonicalize(copy);
}

export function canonicalGraphJson(graph) {
  return JSON.stringify(canonicalGraph(graph));
}

// FNV-1a is a corruption/change detector, not a security signature.  Released
// results still carry the repository and human-approval history separately.
export function graphChecksum(graph) {
  let hash = 0x811c9dc5;
  for (const character of canonicalGraphJson(graph)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export function exportStudioGraph(graph) {
  const failures = validateStudioGraph(graph).filter((item) => item.code.startsWith('graph.schema'));
  if (failures.length) throw new TypeError(failures[0].detail);
  return JSON.stringify({
    format: GRAPH_SCHEMA,
    checksum: graphChecksum(graph),
    graph: canonicalGraph(graph),
  }, null, 2);
}

export function importStudioGraph(document) {
  const parsed = typeof document === 'string' ? JSON.parse(document) : clone(document);
  if (parsed?.format !== GRAPH_SCHEMA || parsed?.graph?.schema !== GRAPH_SCHEMA) {
    throw new TypeError(`Unsupported graph document; expected ${GRAPH_SCHEMA}.`);
  }
  const actual = graphChecksum(parsed.graph);
  if (parsed.checksum !== actual) throw new Error('Graph checksum mismatch; the file is incomplete or changed.');
  return canonicalGraph(parsed.graph);
}

const node = (type, id, name, outputQuantity, x, y, parameters = {}) => createBlockNode(type, {
  id, name, outputQuantity, position: { x, y }, parameters,
});
const connection = (from, to, toPort) => ({ id: `${from}--${to}-${toPort}`, from, to, toPort });

function electrothermalTemplate(options = {}) {
  const graph = createStudioGraph({
    id: 'electrothermal-cell-step', title: 'Cell current step and temperature', market: 'road',
    mode: options.mode || 'guided', actorId: options.actorId, reason: 'Approved road electrothermal template.',
    settings: { endS: 20, maxStepS: 0.2 },
  });
  graph.nodes = [
    node('step', 'current', 'Current demand', 'current', 40, 70, { before: 5, after: 40, atS: 2 }),
    node('constant', 'ocv', 'Open-circuit voltage', 'voltage', 40, 260, { value: 3.7 }),
    node('gain', 'voltage-drop', 'Ohmic voltage drop', 'voltage', 300, 60, { gain: -0.018, inputQuantity: 'current' }),
    node('sum', 'terminal-voltage', 'Terminal voltage', 'voltage', 570, 170, { inputs: 2 }),
    node('product', 'heat', 'Ohmic heat', 'heat', 300, 350, { scale: 0.018, leftQuantity: 'current', rightQuantity: 'current' }),
    node('constant', 'ambient', 'Ambient temperature', 'temperature', 300, 530, { value: 298.15 }),
    node('thermal-rate', 'thermal-balance', 'Cell thermal balance', 'temperature-rate', 570, 360, { heatCapacityJPerK: 900, conductanceWPerK: 1.2 }),
    node('integrator', 'temperature', 'Cell temperature', 'temperature', 830, 360, { initial: 298.15, rateQuantity: 'temperature-rate', gain: 1 }),
  ];
  graph.connections = [
    connection('current', 'voltage-drop', 0), connection('ocv', 'terminal-voltage', 0),
    connection('voltage-drop', 'terminal-voltage', 1), connection('current', 'heat', 0),
    { ...connection('current', 'heat', 1), id: 'current--heat-1' },
    connection('heat', 'thermal-balance', 0), connection('temperature', 'thermal-balance', 1),
    connection('ambient', 'thermal-balance', 2), connection('thermal-balance', 'temperature', 0),
  ];
  return graph;
}

function gridBackupTemplate(options = {}) {
  const segment = options.segment || 'home';
  const graph = createStudioGraph({
    id: `grid-${segment}-backup`, title: `${segment.replace('-', ' ')} outage energy`,
    market: 'grid', segment, mode: options.mode || 'guided', actorId: options.actorId,
    reason: `Approved isolated Grid / ${segment} template.`,
    settings: { endS: 14400, initialStepS: 1, maxStepS: 60 },
  });
  const load = segment === 'home' ? [1500, 3500] : segment === 'small-company' ? [8000, 18000] : [60000, 150000];
  const initialJ = segment === 'home' ? 18_000_000 : segment === 'small-company' ? 108_000_000 : 900_000_000;
  graph.nodes = [
    node('step', 'critical-load', 'Critical load', 'power', 70, 150, { before: load[0], after: load[1], atS: 1800 }),
    node('gain', 'inverter-loss', 'Battery-side inverter demand', 'power', 370, 150, { gain: 1 / 0.92, inputQuantity: 'power' }),
    node('integrator', 'stored-energy', 'Remaining battery energy', 'energy', 690, 150, { initial: initialJ, rateQuantity: 'power', gain: -1 }),
  ];
  graph.connections = [
    connection('critical-load', 'inverter-loss', 0), connection('inverter-loss', 'stored-energy', 0),
  ];
  return graph;
}

function runawayTemplate(options = {}) {
  const market = options.market || 'road';
  const graph = market === 'grid' ? gridBackupTemplate(options) : electrothermalTemplate(options);
  graph.id = `${market}-runaway-propagation`;
  graph.title = 'Cell heating and runaway propagation screening';
  const runawayCellId = market === 'grid' ? 'eve-lf280k' : 'lg-inr18650-mj1';
  const ventingCells = market === 'grid' ? 4 : 8;
  graph.analysisModules = [{
    id: 'runaway-screening', type: 'runaway-propagation', enabled: true,
    parameters: {
      cellId: runawayCellId,
      series: market === 'grid' ? 16 : 13, parallel: market === 'grid' ? 4 : 8, spacingMm: 1,
      barrier: 'mica', barrierThicknessMm: 0.5,
      spacer: market === 'grid' ? 'compression-pad' : 'pp-holder',
      soc: 1, ambientC: 25,
    },
  }, {
    id: 'emergency-vent-screening', type: 'vent-sizing', enabled: true,
    parameters: {
      cellId: runawayCellId, ventingCells,
      gasVolumeLowLPerCell: null, gasVolumeHighLPerCell: null,
      releaseDurationLowS: null, releaseDurationHighS: null,
      gasDataBasis: '', allowableGaugePressureKPa: 10,
      ambientPressureKPa: 101.325, ventGasTemperatureC: 400,
      referenceTemperatureC: 20, referencePressureKPa: 101.325,
      dischargeCoefficient: 0.7, specificGasConstantJPerKgK: 287, gamma: 1.3,
      ventUnitId: '', ventUnitName: '', ventSupplier: '', ventPartNumber: '',
      ventUnitFreeAreaCm2: null, ventUnitWidthMm: null, ventUnitHeightMm: null,
      ventUnitMechanism: '', ventOpeningGaugePressureKPa: null, ventTemperatureRatingC: null,
      ventUnitMarketProfiles: '', ventUnitEvidenceBasis: '', ventEvidenceRevision: '', ventEvidenceDate: '',
      allowedVentFaces: '', preferredVentFace: '', edgeClearanceMm: null,
      minimumVentSpacingMm: null, maxVentCount: 128,
    },
  }];
  return graph;
}

export const MODEL_TEMPLATES = Object.freeze({
  'road-electrothermal': Object.freeze({
    id: 'road-electrothermal', market: 'road', label: 'Cell voltage and temperature',
    summary: 'Current demand, terminal voltage, ohmic heat and lumped cell temperature.',
    evidence: ['equation/current-step', 'equation/ohmic-loss', 'equation/lumped-thermal-balance'],
    build: electrothermalTemplate,
  }),
  'road-runaway': Object.freeze({
    id: 'road-runaway', market: 'road', label: 'Thermal-runaway propagation screening',
    summary: 'Couples normal cell heating evidence with a module-scale comparison of spacing and barrier options after one triggered cell.',
    evidence: ['equation/lumped-thermal-balance', 'safety/runaway-comparison-boundary', 'test/UL-9540A-or-GB-38031-required'],
    build: runawayTemplate,
  }),
  'grid-runaway': Object.freeze({
    id: 'grid-runaway', market: 'grid', label: 'Grid battery runaway propagation screening',
    summary: 'Keeps the Grid outage model isolated while attaching a module-scale comparison of cell spacing and barrier options after one triggered cell.',
    evidence: ['equation/energy-balance', 'safety/runaway-comparison-boundary', 'test/UL-9540A-or-GB-38031-required'],
    build: (options = {}) => runawayTemplate({ ...options, market: 'grid' }),
  }),
  'grid-backup': Object.freeze({
    id: 'grid-backup', market: 'grid', label: 'Outage energy and inverter loss',
    summary: 'Critical load, inverter efficiency and remaining battery energy during an outage.',
    evidence: ['requirement/outage-duration', 'component/inverter-efficiency', 'equation/energy-balance'],
    build: gridBackupTemplate,
  }),
});

function requestFamily(text, market) {
  const words = String(text || '').toLowerCase();
  const runaway = /runaway|propagation|cell[- ]to[- ]cell|fire|barrier|ejecta|venting/.test(words);
  const grid = /home|building|company|industrial|grid|solar|inverter|backup|outage|critical load/.test(words);
  const road = /cell|vehicle|car|drive|current|voltage|temperature|thermal|cooling|heat/.test(words);
  if (grid && market !== 'grid') return { conflict: 'grid' };
  if (runaway) return { templateId: market === 'grid' ? 'grid-runaway' : 'road-runaway' };
  if (road && market === 'grid' && !grid) return { conflict: 'road' };
  if (market === 'grid' || grid) return { templateId: 'grid-backup' };
  if (market === 'road' || road) return { templateId: 'road-electrothermal' };
  return {};
}

/**
 * Create a deterministic, evidence-carrying assistant proposal.  An external
 * LLM may phrase the request, but it cannot introduce block types or bypass
 * this market/catalog check.
 */
export function recommendBlockPlan(request, currentGraph) {
  const market = request.market || currentGraph?.market || 'road';
  const mode = request.mode || currentGraph?.mode || 'guided';
  const family = requestFamily(request.text, market);
  if (family.conflict) return {
    id: `proposal-market-${family.conflict}`, status: 'blocked', kind: 'assistant-draft',
    title: 'Keep this model inside its selected market',
    explanation: `This request belongs to ${family.conflict}, while the open workspace is ${market}. Start a separate ${family.conflict} model so its assumptions and block library cannot leak into this one.`,
    evidence: ['governance/market-isolation'], changes: [], draftGraph: null,
    requiresHumanApproval: true,
  };
  if (!family.templateId) return {
    id: 'proposal-questions', status: 'needs-input', kind: 'assistant-draft',
    title: 'Two details are still needed',
    explanation: 'Name the system, the result you need to observe, and the event or duty that drives it.',
    questions: ['What system are you simulating?', 'Which result decides Pass or Fail?', 'What changes over time?'],
    evidence: ['workflow/minimum-missing-inputs'], changes: [], draftGraph: null,
    requiresHumanApproval: true,
  };
  const template = MODEL_TEMPLATES[family.templateId];
  const draftGraph = template.build({ market, segment: request.segment || currentGraph?.segment, mode });
  const existing = currentGraph?.nodes?.length || 0;
  return {
    id: `proposal-${template.id}-${graphChecksum(draftGraph).slice(-8)}`,
    status: 'ready-for-review', kind: 'assistant-draft', title: template.label,
    explanation: `${template.summary} ${existing ? 'The proposal is shown as a separate draft and will not overwrite the open model.' : 'Review every block before applying it.'}`,
    evidence: [...template.evidence, `catalog/${BLOCK_CATALOG_VERSION}`],
    changes: draftGraph.nodes.map((item) => ({ operation: 'add-block', blockId: item.id, reason: BLOCK_CATALOG[item.type].summary })),
    draftGraph, requiresHumanApproval: true,
  };
}

/** Turn graph diagnostics into a reviewable, never-self-applying repair. */
export function debugStudioGraph(graph) {
  const diagnostics = validateStudioGraph(graph);
  const repairs = diagnostics.filter((item) => item.repair).map((item) => ({
    ...item.repair, diagnosticCode: item.code, reason: item.detail,
  }));
  return {
    status: diagnostics.some((item) => item.severity === 'fail') ? 'blocked' : 'ready',
    headline: diagnostics.length
      ? `${diagnostics.filter((item) => item.severity === 'fail').length} issue(s) need review.`
      : 'The graph is structurally ready for the Rust compiler.',
    diagnostics,
    proposal: repairs.length ? {
      id: `repair-${graphChecksum(graph).slice(-8)}`, kind: 'debug-repair',
      title: 'Minimal structural repair', explanation: 'Only deterministic wire repairs are included. Parameters and tolerances are never changed automatically.',
      evidence: [...new Set(repairs.map((item) => `diagnostic/${item.diagnosticCode}`))],
      changes: repairs, draftGraph: null, requiresHumanApproval: true,
    } : null,
  };
}

function nextConnectionId(graph, change) {
  const base = `${change.from}--${change.to}-${change.toPort}`;
  let id = base;
  let suffix = 2;
  while (graph.connections.some((item) => item.id === id)) id = `${base}-${suffix++}`;
  return id;
}

/** Apply a proposal only after a named human with graph-edit authority approves it. */
export function applyApprovedGraphProposal(graph, proposal, approval) {
  if (approval?.actor?.kind !== 'human' || !approval.actor.id) {
    throw new Error('A named human must approve every assistant or debugger graph change.');
  }
  if (!approval.actor.authorities?.includes('edit-graph')) {
    throw new Error(`${approval.actor.id} has no graph-edit authority.`);
  }
  if (!proposal?.requiresHumanApproval) throw new TypeError('This is not a governed graph proposal.');
  let updated = proposal.draftGraph ? clone(proposal.draftGraph) : clone(graph);
  if (!proposal.draftGraph) {
    for (const change of proposal.changes || []) {
      if (change.operation === 'remove-connection') {
        updated.connections = updated.connections.filter((item) => item.id !== change.connectionId);
      } else if (change.operation === 'connect') {
        updated.connections.push({ id: nextConnectionId(updated, change), ...change });
        delete updated.connections.at(-1).operation;
        delete updated.connections.at(-1).diagnosticCode;
        delete updated.connections.at(-1).reason;
      } else {
        throw new RangeError(`Unsupported governed repair: ${change.operation}`);
      }
    }
  }
  updated.version = String(approval.nextVersion || updated.version);
  const approvedContentChecksum = graphChecksum(updated);
  updated.history = [...(graph.history || []), {
    action: 'proposal-approved', proposalId: proposal.id, actorId: approval.actor.id,
    actorKind: 'human', reason: String(approval.reason || 'Reviewed and applied the proposed graph changes.'),
    at: approval.at || now(), fromChecksum: graphChecksum(graph), approvedContentChecksum,
  }];
  return updated;
}

const METHOD_CODES = Object.freeze({ auto: 0, 'dormand-prince-45': 1, 'backward-euler': 2 });

function blockTransport(node) {
  const q = (value) => QUANTITIES[value]?.code;
  const p = node.parameters;
  switch (node.type) {
    case 'constant': return [0, q(node.outputQuantity), p.value, 0, 0, 0];
    case 'step': return [1, q(node.outputQuantity), p.before, p.after, p.atS, 0];
    case 'gain': return [2, q(node.outputQuantity), p.gain, q(p.inputQuantity), 0, 0];
    case 'sum': return [3, q(node.outputQuantity), p.inputs, 0, 0, 0];
    case 'product': return [4, q(node.outputQuantity), p.scale, q(p.leftQuantity), q(p.rightQuantity), 0];
    case 'limit': return [5, q(node.outputQuantity), p.min, p.max, 0, 0];
    case 'integrator': return [6, q(node.outputQuantity), p.initial, q(p.rateQuantity), p.gain, 0];
    case 'first-order': return [7, q(node.outputQuantity), p.tauS, p.initial, 0, 0];
    case 'thermal-rate': return [8, q(node.outputQuantity), p.heatCapacityJPerK, p.conductanceWPerK, 0, 0];
    default: throw new RangeError(`Cannot transport block type: ${node.type}`);
  }
}

/** Encode the canonical graph into the dependency-free Rust/Wasm ABI. */
export function encodeGraphTransport(graph) {
  const failures = validateStudioGraph(graph).filter((item) => item.severity === 'fail');
  if (failures.length) {
    const error = new Error(failures[0].summary);
    error.code = failures[0].code;
    throw error;
  }
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const nodeIndex = new Map(nodes.map((item, index) => [item.id, index]));
  const connections = [...graph.connections].sort((a, b) =>
    a.to.localeCompare(b.to) || a.toPort - b.toPort || a.from.localeCompare(b.from));
  const s = { ...DEFAULT_SETTINGS, ...graph.settings };
  const header = [
    GRAPH_TRANSPORT_MAGIC, GRAPH_TRANSPORT_VERSION, nodes.length, connections.length,
    METHOD_CODES[s.method], s.startS, s.endS, s.initialStepS, s.minStepS, s.maxStepS,
    s.relativeTolerance, s.absoluteTolerance, s.maxSteps, s.algebraicTolerance,
    s.algebraicMaxIterations, s.implicitTolerance, s.implicitMaxIterations,
  ];
  const values = [
    ...header,
    ...nodes.flatMap(blockTransport),
    ...connections.flatMap((item) => [nodeIndex.get(item.from), nodeIndex.get(item.to), item.toPort]),
  ];
  if (values.some((value) => !Number.isFinite(value))) throw new TypeError('Graph transport contains a non-finite value.');
  return { values: new Float64Array(values), blockIds: nodes.map((item) => item.id), schemaVersion: GRAPH_TRANSPORT_VERSION };
}
