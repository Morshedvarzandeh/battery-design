#!/usr/bin/env node
// mcp-server.mjs — let an AI system use the battery designer.
//
// Claude, or any agent that speaks the Model Context Protocol, can call these
// tools directly: pick an application, size a pack, run its mission, sweep the
// cell library, ask what feeding power back would cost. The agent gets the
// same numbers the web app shows, from the same modules — it is the designer
// talking, not a language model guessing about batteries.
//
// Deliberately small: JSON-RPC 2.0 over stdio, newline-delimited, no
// dependencies, no network. Runs on the user's machine, reads nothing but the
// request, writes nothing to disk.
//
// Connect it (Claude Desktop / Claude Code, in mcpServers):
//   { "battery-design": { "command": "node",
//                         "args": ["/path/to/battery-design/desktop/mcp-server.mjs"] } }

import {
  buildArchitectureSemanticGraph, designFromSpec, briefFromDesign, describeOntology, listApplications, listCells, listVessels,
  querySemanticGraph, API_VERSION, DESIGN_SPEC_SCHEMA_VERSION, GOVERNED_DESIGN_SPEC_SCHEMA, normalizeDesignSpec,
} from '../js/api.js';
import { buildFmu } from '../js/fmi.js';
import { inspectFmiBuild } from '../js/desktop-link.js';
import { CELLS, cellById } from '../js/cells.js';
import { V2X_MODES, v2xParts } from '../js/v2x.js';
import { CONCEPTS, appNeeds } from '../js/knowledge.js';
import { buildTopology } from '../js/topology.js';
import { wiringStudy } from '../js/wiring.js';
import { groundingStudy, faultFromShortCircuit } from '../js/grounding.js';
import { designBrief } from '../js/brief.js';
import {
  findSimilarRootCauses, ROOT_CAUSE_RECORD_SCHEMA, ROOT_CAUSE_SCHEMA_VERSION,
} from '../js/root-cause-library.js';

const PROTOCOL_VERSION = '2024-11-05';

const sha256 = { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'Content SHA-256 (64 hexadecimal characters).' };
const twinAssetEvidence = {
  type: 'object', additionalProperties: false,
  properties: {
    assetId: { type: 'string' }, vesselId: { type: 'string' }, evidenceId: { type: 'string' },
    revision: { type: 'string' }, issuedAt: { type: 'string', description: 'Full ISO-8601 timestamp with timezone.' },
    sha256,
  },
  required: ['assetId', 'vesselId', 'evidenceId', 'revision', 'issuedAt', 'sha256'],
};
const twinModelEvidence = {
  type: 'object', additionalProperties: false,
  properties: {
    artifactId: { type: 'string' }, version: { type: 'string', description: 'Semantic model version.' },
    vesselId: { type: 'string' }, assetId: { type: 'string' }, sha256,
  },
  required: ['artifactId', 'version', 'vesselId', 'assetId', 'sha256'],
};
const twinTrialEvidence = {
  type: 'object', additionalProperties: false,
  properties: {
    trialId: { type: 'string' }, vesselId: { type: 'string' }, assetId: { type: 'string' },
    datasetSha256: sha256, modelArtifactSha256: sha256,
    completedAt: { type: 'string', description: 'Full ISO-8601 timestamp with timezone.' },
  },
  required: ['trialId', 'vesselId', 'assetId', 'datasetSha256', 'modelArtifactSha256', 'completedAt'],
};
const twinMetrics = {
  type: 'object', additionalProperties: false,
  properties: {
    speedRmsKn: { type: 'number' }, courseRmsDeg: { type: 'number' },
    powerRmsFraction: { type: 'number' },
  },
  required: ['speedRmsKn', 'courseRmsDeg', 'powerRmsFraction'],
};
const twinValidationEvidence = {
  ...twinTrialEvidence,
  properties: {
    ...twinTrialEvidence.properties,
    result: { type: 'string', enum: ['pass'] }, metrics: twinMetrics, limits: twinMetrics,
  },
  required: [...twinTrialEvidence.required, 'result', 'metrics', 'limits'],
};
const twinReplayEvidence = {
  type: 'object', additionalProperties: false,
  properties: {
    replayId: { type: 'string' }, vesselId: { type: 'string' }, assetId: { type: 'string' },
    datasetSha256: sha256, modelArtifactSha256: sha256,
    recordedAt: { type: 'string', description: 'Full ISO-8601 timestamp with timezone.' },
    maxAgeDays: { type: 'integer', minimum: 1, maximum: 365 },
    minSamples: { type: 'integer', minimum: 10 }, minDurationS: { type: 'number', minimum: 60 },
  },
  required: ['replayId', 'vesselId', 'assetId', 'datasetSha256', 'modelArtifactSha256',
    'recordedAt', 'maxAgeDays', 'minSamples', 'minDurationS'],
};
const twinEvidence = {
  type: 'object', additionalProperties: false,
  properties: {
    powerBasis: { type: 'string', enum: ['dc-bus-trace', 'shaft-power-curve', 'resistance-curve'] },
    assetEvidence: twinAssetEvidence, modelEvidence: twinModelEvidence,
    calibrationEvidence: twinTrialEvidence, validationEvidence: twinValidationEvidence,
    replayEvidence: twinReplayEvidence,
  },
};
const replaySample = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(['tS', 'actualSpeedKn', 'predictedSpeedKn', 'actualCourseDeg',
    'predictedCourseDeg', 'actualPowerW', 'predictedPowerW'].map((key) => [key, { type: 'number' }])),
  required: ['tS', 'actualSpeedKn', 'predictedSpeedKn', 'actualCourseDeg',
    'predictedCourseDeg', 'actualPowerW', 'predictedPowerW'],
};
const replayOptions = {
  type: 'object', additionalProperties: false,
  properties: {
    speedKn: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
    courseDeg: { type: 'number', exclusiveMinimum: 0, maximum: 180 },
    powerFraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    consecutive: { type: 'integer', minimum: 1 },
  },
};
const profileTrace = {
  type: 'object',
  description: 'Governed normalized custom battery/load trace. Raw samples are evaluated locally and only their resolved content identity is returned.',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    revision: { type: 'string' },
    dtS: { type: 'number', exclusiveMinimum: 0 },
    p: {
      type: 'array', minItems: 2, maxItems: 500,
      items: { type: 'number', minimum: -1, maximum: 1 },
    },
    scaleW: { type: 'number', exclusiveMinimum: 0 },
    note: { type: 'string' },
  },
  required: ['id', 'dtS', 'p', 'scaleW'],
};
const rootCauseStringArray = (itemSchema) => ({
  type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: itemSchema,
});
const ROOT_CAUSE_DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['symptom'],
  properties: {
    symptom: {
      type: 'string', minLength: 1, maxLength: 4000,
      description: 'Observed behavior to compare with recorded engineering incidents.',
    },
    evidence: rootCauseStringArray({ type: 'string', minLength: 1, maxLength: 4000 }),
    tags: rootCauseStringArray({
      type: 'string', pattern: ROOT_CAUSE_RECORD_SCHEMA.properties.tags.items.pattern,
    }),
    affectedSurfaces: rootCauseStringArray({
      type: 'string', enum: ROOT_CAUSE_RECORD_SCHEMA.properties.affectedSurfaces.items.enum,
    }),
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
  },
};
const shoreDeclaration = (detailField) => ({
  type: 'object', additionalProperties: false,
  properties: {
    declared: { type: 'boolean', const: true },
    [detailField]: { type: 'string', minLength: 1 },
  },
  required: ['declared', detailField],
});
const shoreConnection = {
  type: 'object',
  description: 'Project- or supplier-evidenced marine shore equipment. No connector, rating or turnaround time is inferred.',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['ac', 'dc'] },
    voltageV: { type: 'number', exclusiveMinimum: 0 },
    phases: { type: 'integer', enum: [1, 3] },
    frequencyHz: { type: 'number', exclusiveMinimum: 0 },
    powerFactor: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    ratedPowerKW: { type: 'number', exclusiveMinimum: 0 },
    ratedCurrentA: { type: 'number', exclusiveMinimum: 0 },
    efficiency: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    outputVoltageMinV: { type: 'number', exclusiveMinimum: 0 },
    outputVoltageMaxV: { type: 'number', exclusiveMinimum: 0 },
    connector: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } },
      required: ['id', 'name'],
    },
    earthing: shoreDeclaration('scheme'),
    isolation: shoreDeclaration('method'),
    interlock: shoreDeclaration('description'),
    emergencyDisconnect: shoreDeclaration('description'),
    evidence: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['supplier', 'project'] },
        source: { type: 'string', minLength: 1 },
        revision: { type: 'string', minLength: 1 },
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      required: ['kind', 'source', 'revision', 'date'],
    },
  },
  required: [
    'mode', 'voltageV', 'ratedPowerKW', 'ratedCurrentA', 'efficiency',
    'outputVoltageMinV', 'outputVoltageMaxV', 'connector', 'earthing',
    'isolation', 'interlock', 'emergencyDisconnect', 'evidence',
  ],
  allOf: [{
    if: { properties: { mode: { const: 'ac' } }, required: ['mode'] },
    then: { required: ['phases', 'frequencyHz', 'powerFactor'] },
  }],
};

// The design spec, described once and reused by every tool that takes one.
const SPEC_PROPERTIES = {
  application: { type: 'string', description: 'Application preset id (use list_applications first).' },
  cell: { type: 'string', description: 'Cell id from the library (use list_cells).' },
  energyWh: { type: 'number', description: 'Energy target in Wh; used to size the parallel count.' },
  s: { type: 'number', description: 'Cells in series (overrides the voltage-derived default).' },
  p: { type: 'number', description: 'Cells in parallel (overrides the energy-derived default).' },
  market: { type: 'string', enum: ['eu', 'us', 'cn', 'intl'], description: 'Target market for the release checklist.' },
  batteryCategory: { type: 'string', enum: ['ev', 'lmt', 'industrial', 'portable', 'sli'], description: 'Declared Regulation (EU) 2023/1542 battery category when the application does not determine EV/LMT.' },
  evaluationDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Deterministic date used by time-gated regulatory ontology rules.' },
  dod: { type: 'number', description: 'Usable depth of discharge, 0–1.' },
  v2xPolicy: { type: 'string', enum: ['off', 'v2l', 'v2h', 'v2g', 'v2v'], description: 'Feed-back policy to design for.' },
  driveMode: { type: 'string', enum: ['eco', 'normal', 'sport'], description: 'Driving mode for road machines.' },
  policyId: { type: 'string', description: 'EMS/PMS operating goal for grid or marine sizing; list_applications returns allowed ids.' },
  vesselId: { type: 'string', description: 'Selected NTNU marine vessel id (use list_vessels).' },
  marine: {
    type: 'object',
    description: 'Vessel voyage plus governed TwinShip evidence and aligned replay. Published defaults remain visible; private evidence and raw samples are not echoed in output.',
    additionalProperties: false,
    properties: {
      vesselId: { type: 'string' }, referenceMassKg: { type: ['number', 'null'] },
      payloadKg: { type: 'number' }, designSpeedKn: { type: 'number' }, serviceSpeedKn: { type: 'number' },
      headCurrentKn: { type: 'number' }, headwindKn: { type: 'number' },
      propulsionAtDesignW: { type: 'number' }, hotelW: { type: 'number' }, durationH: { type: 'number' },
      seaState: { type: 'string', enum: ['calm', 'moderate', 'rough'] },
      shoreConnection, twinEvidence, replaySamples: { type: 'array', items: replaySample }, replayOptions,
    },
  },
  twinShip: {
    type: 'object',
    description: 'Top-level alias for governed, content-addressed TwinShip readiness evidence and time-aligned replay. The API evaluates replay itself.',
    additionalProperties: false,
    properties: {
      readiness: twinEvidence,
      replay: {
        type: 'object', additionalProperties: false,
        properties: { samples: { type: 'array', items: replaySample }, options: replayOptions },
        required: ['samples'],
      },
    },
  },
  gradePct: { type: 'number', description: 'Route gradient in percent.' },
  route: {
    type: 'object',
    description: 'Selected road route: points with lat/lon and optional elevation/timestamp, plus optional name and targetKph.',
    additionalProperties: true,
  },
  vehicle: {
    type: 'object', description: 'Vehicle overrides: curbKg (mass WITHOUT the pack), payloadKg, cd, frontalAreaM2, crr, driveEff, regenFrac, auxW.',
    additionalProperties: true,
  },
  profileId: { type: 'string', description: 'Battery/load profile id, or "vehicle" to derive demand from vehicle physics. Existing integrations remain supported.' },
  profileTrace,
};

const TOOLS = [
  {
    name: 'list_applications',
    description: 'List the application presets the designer knows (EV, e-bus, e-bike, home storage, UPS, drone, wearable, AGV and more), with their typical energy, voltage and power, and the design concepts each one actually needs. Call this before designing so the application id is real.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_cells',
    description: 'List the cell library with chemistry, format, energy, price, cycle life and data quality. Every record says whether its figures are from a datasheet or estimated.',
    inputSchema: {
      type: 'object',
      properties: {
        chemistry: { type: 'string', description: 'Filter: LFP, NMC, NCA, LTO, Na-ion, LiPo…' },
        form: { type: 'string', description: 'Filter: cylindrical, prismatic, pouch.' },
      },
    },
  },
  {
    name: 'list_vessels',
    description: 'List the two evidenced NTNU vessel models available to the Vessel Twin workspace, including published particulars, defaults, source and interpretation boundary.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_ontology_schema',
    description: 'Return the compact versioned ontology catalog so an agent can discover classes, relations, units, rules, product surfaces, architecture modules, competency questions and validation shapes without generating a design.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'inspect_fmi_mapping',
    description: 'Build and inspect the exact FMI 2.0 enterprise mapping for one closed, schema-versioned DesignSpec. Returns the canonical design-bound parameters, host inputs, outputs, sign/update semantics, checksums, and sanitized static pack/layout/module facts without source files, raw traces, or private evidence.',
    inputSchema: GOVERNED_DESIGN_SPEC_SCHEMA,
    annotations: {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
  },
  {
    name: 'diagnose_known_issue',
    description: 'Compare an observed symptom and optional evidence with the versioned battery-design root-cause catalog. Returns deterministic known-pattern matches and recorded fixes; it is catalog retrieval, not an AI diagnosis or certainty claim.',
    inputSchema: ROOT_CAUSE_DIAGNOSIS_SCHEMA,
    annotations: {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
  },
  {
    name: 'query_ontology',
    description: 'Query the architecture-wide ontology or one design semantic graph. This covers applications, pack/cell/component hierarchy, all calculation and simulation modules, requirements, evidence, findings and governance; it is not a charging-only graph.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        application: { type: 'string', description: 'Optional application id. When supplied, query its complete design graph.' },
        type: { type: 'string', description: 'Optional semantic type such as bd:ModelRun, bd:Requirement or bd:Diagnostic.' },
        relation: { type: 'string', description: 'Optional relation such as bd:usesModel or bd:requiresCapability.' },
        text: { type: 'string', description: 'Optional case-insensitive label/property search.' },
      },
    },
  },
  {
    name: 'design_pack',
    description: 'Design a complete battery pack from a specification and return the whole answer: geometry, mass, electrical architecture, BMS topology, thermal system, sensor plan, charging, feed-back policy, vehicle consumption and range, mission simulation, cost, CO2 and the release checklist. This is the full designer, not a summary of it.',
    inputSchema: { type: 'object', properties: SPEC_PROPERTIES, required: ['application'] },
  },
  {
    name: 'run_mission',
    description: 'Drive a design through its load profile in time and report state of charge, voltage sag, temperature, energy lost and whether the pack ran out. Optionally include charging during the mission (top-ups or a charge at base).',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPEC_PROPERTIES,
        passes: { type: 'number', description: 'How many times to repeat the profile.' },
        startSoC: { type: 'number', description: 'Starting state of charge, 0–1.' },
        ambientC: { type: 'number', description: 'Ambient temperature for this run.' },
        chargeMode: { type: 'string', enum: ['none', 'topup', 'base'], description: 'Charging during the mission.' },
        chargeMinutes: { type: 'number', description: 'Minutes of charging per opportunity.' },
      },
      required: ['application'],
    },
  },
  {
    name: 'compare_cells',
    description: 'Run several cells through the SAME mission and duty and compare what they deliver: pack energy, mass, cost per kWh delivered over life, and consumption or range where the machine drives. Use this to answer "which cell should I use".',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPEC_PROPERTIES,
        cellIds: { type: 'array', items: { type: 'string' }, description: 'Cell ids to compare. Omit to sweep the whole library.' },
        chemistry: { type: 'string', description: 'Restrict a library-wide sweep to one chemistry.' },
      },
      required: ['application'],
    },
  },
  {
    name: 'explain_v2x',
    description: 'Explain what feeding power back would mean for a design: which modes the application can do (V2L, V2H, V2G, V2V), the verdict on each, the parts the choice adds to the bill of materials, how much energy can be exported while keeping a usable reserve, and the wear floor in $/kWh that decides whether V2G ever pays.',
    inputSchema: { type: 'object', properties: SPEC_PROPERTIES, required: ['application'] },
  },
  {
    name: 'review_design',
    description: 'Review a design the way an engineer would. Every check the tool runs — the audit, the fault study, conductor sizing, grounding, thermal, charging, sensors and feed-back policy — read into ONE list, ordered so that what could hurt someone comes before what costs money, with the same problem found by two modules merged rather than repeated. It also returns the questions the tool needs answered, ranked by how much each would change the answer, and an explicit list of what was NOT checked. Use this for "what is wrong with my design" or "what should I do next" — and ASK the customer the open questions rather than quietly designing around a guess.',
    inputSchema: { type: 'object', properties: SPEC_PROPERTIES, required: ['application'] },
  },
  {
    name: 'explain_concept',
    description: 'Explain a design concept the tool models and say which applications actually need it — the knowledge graph behind what each customer is shown.',
    inputSchema: {
      type: 'object',
      properties: {
        concept: { type: 'string', description: `One of: ${Object.keys(CONCEPTS).join(', ')}` },
        application: { type: 'string', description: 'Optional: answer for this application specifically.' },
      },
    },
  },
];

// --- tool implementations ---------------------------------------------------
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const structured = (value) => ({
  // Keep a compact JSON fallback for protocol clients that predate
  // structuredContent; newer clients receive the object directly.
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
});

function rootCauseDiagnosisInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('Known-issue diagnosis requires one object.');
  }
  const allowed = new Set(['symptom', 'evidence', 'tags', 'affectedSurfaces', 'limit']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) {
    throw new TypeError(`Known-issue diagnosis does not accept field(s): ${unknown.join(', ')}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(args, 'symptom')
      || typeof args.symptom !== 'string' || !args.symptom.trim()) {
    throw new TypeError('Known-issue diagnosis requires a non-empty symptom string.');
  }
  if (args.symptom.length > 4000) {
    throw new RangeError('Known-issue diagnosis symptom must not exceed 4000 characters.');
  }
  const stringList = (name, { pattern = null, allowedValues = null } = {}) => {
    if (args[name] == null) return [];
    if (!Array.isArray(args[name]) || args[name].length < 1 || args[name].length > 20
        || args[name].some((value) => typeof value !== 'string' || !value || value.length > 4000)) {
      throw new TypeError(`Known-issue diagnosis ${name} must contain 1 to 20 non-empty strings.`);
    }
    if (new Set(args[name]).size !== args[name].length) {
      throw new TypeError(`Known-issue diagnosis ${name} must not contain duplicates.`);
    }
    if (pattern && args[name].some((value) => !pattern.test(value))) {
      throw new TypeError(`Known-issue diagnosis ${name} contains an invalid value.`);
    }
    const unsupported = allowedValues
      ? args[name].filter((value) => !allowedValues.includes(value)).sort()
      : [];
    if (unsupported.length) {
      throw new TypeError(`Known-issue diagnosis ${name} contains unsupported value(s): ${unsupported.join(', ')}.`);
    }
    return [...args[name]].sort();
  };
  const tagPattern = new RegExp(ROOT_CAUSE_RECORD_SCHEMA.properties.tags.items.pattern);
  const surfaces = ROOT_CAUSE_RECORD_SCHEMA.properties.affectedSurfaces.items.enum;
  const limit = args.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new RangeError('Known-issue diagnosis limit must be an integer from 1 to 10.');
  }
  return Object.freeze({
    symptom: args.symptom.trim(),
    evidence: stringList('evidence'),
    tags: stringList('tags', { pattern: tagPattern }),
    affectedSurfaces: stringList('affectedSurfaces', { allowedValues: surfaces }),
    limit,
  });
}

function rootCauseDiagnosisMatch(match) {
  const { record } = match;
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    score: match.score,
    sharedTokens: match.sharedTokens,
    affectedSurfaces: record.affectedSurfaces,
    tags: record.tags,
    symptom: record.symptom,
    evidence: record.evidence,
    rootCause: record.rootCause,
    resolution: record.resolution,
    prevention: record.prevention,
    regressionTests: record.regressionTests,
  };
}

function specOf(args) {
  const { passes, startSoC, ambientC, chargeMode, chargeMinutes, cellIds, chemistry, concept, ...spec } = args || {};
  return spec;
}

const HANDLERS = {
  list_applications() {
    const apps = listApplications();
    return text([
      `${apps.length} applications (API v${API_VERSION}):`,
      ...apps.map((a) => `· ${a.id} — ${a.name} [${a.class}], typically ${(a.typicalEnergyWh / 1000).toFixed(1)} kWh at ${a.typicalV} V, ${(a.contPowerW / 1000).toFixed(1)} kW continuous. Prefers ${a.preferredChemistries.join('/')}.`),
    ].join('\n'));
  },

  list_cells(args) {
    const cells = listCells({ chemistry: args?.chemistry, form: args?.form });
    if (!cells.length) return text('No cells match that filter. Chemistries available: ' + [...new Set(CELLS.map((c) => c.chemistry))].join(', '));
    return text([
      `${cells.length} cells:`,
      ...cells.map((c) => `· ${c.id} — ${c.name}: ${c.chemistry} ${c.form}, ${c.nominalV} V ${c.capacityAh} Ah (${c.energyWh.toFixed(1)} Wh), ${c.massG} g${c.priceUSD != null ? `, $${c.priceUSD}` : ', price unknown'}${c.cycleLife != null ? `, ${c.cycleLife} cycles` : ''} [${c.dataQuality}]`),
    ].join('\n'));
  },

  list_vessels() {
    const vessels = listVessels();
    return text([
      `${vessels.length} NTNU vessel models:`,
      ...vessels.map((vessel) => `· ${vessel.id} — ${vessel.name}: ${vessel.dimensionsM.length} m × ${vessel.dimensionsM.beam} m. Default PMS: ${vessel.policyId}. ${vessel.boundary}`),
    ].join('\n'));
  },

  get_ontology_schema() {
    return text(JSON.stringify(describeOntology(), null, 2));
  },

  inspect_fmi_mapping(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new TypeError('FMI mapping requires one governed DesignSpec object.');
    }
    if (!Object.prototype.hasOwnProperty.call(args, 'schemaVersion')) {
      throw new TypeError(`FMI mapping DesignSpec must declare schemaVersion ${DESIGN_SPEC_SCHEMA_VERSION}.`);
    }
    const spec = normalizeDesignSpec(args, { strict: true, closed: true });
    const design = designFromSpec(spec);
    if (design.warnings.length) {
      throw new TypeError(`FMI mapping DesignSpec did not resolve exactly: ${design.warnings.join(' ')}`);
    }
    return structured(inspectFmiBuild(buildFmu({ design })));
  },

  diagnose_known_issue(args) {
    const issue = rootCauseDiagnosisInput(args);
    const matches = findSimilarRootCauses({
      symptom: issue.symptom,
      ...(issue.evidence.length ? { evidence: issue.evidence } : {}),
      ...(issue.tags.length ? { tags: issue.tags } : {}),
      ...(issue.affectedSurfaces.length ? { affectedSurfaces: issue.affectedSurfaces } : {}),
    }, { limit: issue.limit });
    return structured({
      format: 'battery-design/root-cause-diagnosis@1',
      knowledge: {
        kind: 'versioned-curated-catalog',
        schemaVersion: ROOT_CAUSE_SCHEMA_VERSION,
        notice: 'These are deterministic similarities to recorded project evidence, not AI certainty, a live investigation, or proof of causation.',
      },
      query: {
        symptom: issue.symptom,
        evidence: issue.evidence,
        tags: issue.tags,
        affectedSurfaces: issue.affectedSurfaces,
        limit: issue.limit,
      },
      matches: matches.map(rootCauseDiagnosisMatch),
    });
  },

  query_ontology(args) {
    if (!args?.application) {
      if (args?.type || args?.relation) {
        const graph = buildArchitectureSemanticGraph();
        const result = querySemanticGraph(graph, {
          type: args.type, relation: args.relation, text: args.text,
        });
        return text([
          `battery-design architecture graph — ontology ${graph.ontology.version}; query matched ${result.nodes.length} entities and ${result.edges.length} relations.`,
          ...result.nodes.slice(0, 40).map((node) => `· ${node.label} [${node.types.join(', ')}] — ${node.id}`),
          ...result.edges.slice(0, 40).map((edge) => `· ${edge.from} —${edge.type}→ ${edge.to}`),
          ...(result.nodes.length + result.edges.length > 80 ? ['… narrow the query to see fewer matches.'] : []),
        ].join('\n'));
      }
      const catalog = describeOntology();
      const needle = String(args?.text || '').trim().toLowerCase();
      const rows = [
        ...catalog.classes, ...catalog.relations, ...catalog.units,
        ...catalog.productSurfaces, ...catalog.architectureModules, ...catalog.modules,
        ...catalog.rules, ...catalog.concepts, ...catalog.competencyQuestions, ...catalog.shapes,
      ]
        .filter((row) => !args?.type || row.id === args.type || row.target === args.type)
        .filter((row) => !needle || JSON.stringify(row).toLowerCase().includes(needle));
      return text([
        `battery-design ontology ${catalog.ontology.version}: ${catalog.classes.length} classes, ${catalog.relations.length} relations, ${catalog.architectureModules.length} registered architecture modules.`,
        ...rows.slice(0, 50).map((row) => `· ${row.id} — ${row.label || row.description || row.module || row.profile || 'semantic definition'}`),
        ...(rows.length > 50 ? [`… ${rows.length - 50} more matches; narrow the text or type filter.`] : []),
      ].join('\n'));
    }
    const design = designFromSpec({ application: args.application });
    const result = querySemanticGraph(design.semantics.graph, {
      type: args.type, relation: args.relation, text: args.text,
    });
    return text([
      `${design.application?.name || args.application} — ontology ${design.semantics.ontology.version}, graph ${design.semantics.ontology.checksum}`,
      `${design.semantics.counts.nodes} entities / ${design.semantics.counts.edges} relations total; query matched ${result.nodes.length} entities and ${result.edges.length} relations.`,
      ...result.nodes.slice(0, 40).map((node) => `· ${node.label} [${node.types.join(', ')}] — ${node.id}`),
      ...result.edges.slice(0, 40).map((edge) => `· ${edge.from} —${edge.type}→ ${edge.to}`),
      ...(result.nodes.length + result.edges.length > 80 ? ['… narrow the query to see fewer matches.'] : []),
    ].join('\n'));
  },

  design_pack(args) {
    const d = designFromSpec(specOf(args));
    const lines = [briefFromDesign(d), ''];
    lines.push(`Architecture: ${d.architecture.bms.topology.name} BMS, ${d.architecture.partition.nModules} module(s) of ${d.architecture.partition.sMod}S, ${d.architecture.bms.afeTotal} AFE channel(s)`);
    const iso = d.architecture.isolation;
    if (iso) lines.push(`Isolation: ${iso.ohmsPerVolt} Ω/V per ${iso.standardLabel} — a floor of ${iso.floorKOhm} kΩ at ${d.pack.vMax.toFixed(0)} V`);
    lines.push(`Thermal: ${d.thermal.loop.name} — ${d.thermal.assessment.verdict}. ${d.thermal.assessment.why}`);
    const sensorCount = (d.sensors.groups || []).reduce((n, g) => n + (g.sensors?.length || 0), 0);
    if (sensorCount) lines.push(`Sensor plan: ${sensorCount} entries across cell, module, system and cooling levels`);
    if (d.diagnostics?.batteryModel?.next) lines.push(`Model diagnostics: next measurement — ${d.diagnostics.batteryModel.next.title}`);
    if (d.diagnostics?.conditionMonitoring?.applicable) lines.push(`Condition monitoring: ${d.diagnostics.conditionMonitoring.recommendation}`);
    lines.push(`Ontology: v${d.semantics.ontology.version}, ${d.semantics.counts.nodes} entities / ${d.semantics.counts.edges} relations / ${d.semantics.counts.modelRuns} model runs, ${d.semantics.conforms ? 'conforms' : 'INVALID'}; ${d.semantics.unresolvedEvidence.length} unresolved evidence requirement(s).`);
    lines.push(`Release (${d.spec.resolved.market}): ${d.checklist.items.length} items, ${d.checklist.items.filter((i) => i.scope === 'mandatory').length} mandatory`);
    if (d.co2?.paybackCycles) lines.push(`CO2: ${d.co2.mfgKgPerPack.toFixed(0)} kg to manufacture, payback in ${Math.round(d.co2.paybackCycles)} cycles`);
    lines.push('', 'Full result available as JSON from the same call in the desktop runner: node desktop/bd.mjs design --json');
    return text(lines.join('\n'));
  },

  run_mission(args) {
    const spec = specOf(args);
    spec.mission = {
      passes: args.passes ?? 1,
      startSoC: args.startSoC ?? 1.0,
      ambientC: args.ambientC,
      charge: args.chargeMode && args.chargeMode !== 'none'
        ? { mode: args.chargeMode, powerW: 11000, minutes: args.chargeMinutes ?? 60 } : undefined,
    };
    const d = designFromSpec(spec);
    if (!d.simulation) return text('This application has no load profile, so there is no mission to run.');
    const s = d.simulation.summary;
    return text([
      `${d.application?.name} — ${d.pack.s}S${d.pack.p}P ${d.cell.name}, ${(d.pack.energyWh / 1000).toFixed(1)} kWh`,
      ...(d.marine ? [`Vessel: ${d.marine.vessel.name}; PMS ${d.spec.resolved.sizing.policyId}; ${d.marine.distanceNm.toFixed(1)} nmi voyage, ${Math.round(d.simulation.stats.peakW / 1000)} kW battery-profile peak.`] : []),
      `Profile: ${d.simulation.profile.name}, ${spec.mission.passes} pass(es)`,
      `SoC ${Math.round(s.startSoC * 100)}% → ${Math.round(s.endSoC * 100)}% (minimum ${Math.round(s.minSoC * 100)}%)`,
      `Energy ${s.energyOutWh.toFixed(0)} Wh out, ${s.lossWh.toFixed(0)} Wh lost, ${s.efficiencyPct.toFixed(1)}% efficient`,
      `Modeled peak cell temperature ${s.maxT?.toFixed(1)} °C (cell limit ${s.tempMaxC?.toFixed(1)} °C), voltage ${s.vMinPack.toFixed(1)}–${s.vMaxPack.toFixed(1)} V`,
      s.unmetWh > 0 ? `RAN OUT: ${s.unmetWh.toFixed(0)} Wh of the mission was not delivered.` : 'The pack completed the mission.',
      ...(s.chargedWh > 0 ? [`Charged ${s.chargedWh.toFixed(0)} Wh${s.chargeRefusedWh > 0 ? `, refused ${s.chargeRefusedWh.toFixed(0)} Wh (too cold)` : ''}`] : []),
      '',
      'Findings:',
      ...d.simulation.findings.map((f) => `  ${f.severity.toUpperCase()}: ${f.title} — ${f.detail}`),
      '',
      'Assumptions:',
      ...d.simulation.assumptions.map((a) => `  · ${a}`),
    ].join('\n'));
  },

  compare_cells(args) {
    const base = specOf(args);
    const pool = args.cellIds?.length
      ? args.cellIds
      : CELLS.filter((c) => !args.chemistry || c.chemistry === args.chemistry).map((c) => c.id);
    const rows = [];
    let marineDutyLine = null;
    for (const id of pool) {
      try {
        const d = designFromSpec({ ...base, cell: id });
        if (!marineDutyLine && d.marine) {
          marineDutyLine = `Vessel duty: ${d.marine.vessel.name}; PMS ${d.spec.resolved.sizing.policyId}; ${Math.round(d.simulation.stats.peakW / 1000)} kW battery-profile peak.`;
        }
        rows.push({
          id, kWh: d.pack.energyWh / 1000, massKg: d.pack.massKg,
          usd: d.cost?.upfrontUSD ?? null, perKWh: d.cost?.usdPerKWhDelivered ?? null,
          whPerKm: d.vehicle?.drive?.whPerKm ?? null, rangeKm: d.vehicle?.range ?? null,
          fails: d.findings.filter((f) => f.severity === 'fail').length,
        });
      } catch (e) { rows.push({ id, error: e.message }); }
    }
    rows.sort((a, b) => (a.perKWh ?? 1e9) - (b.perKWh ?? 1e9));
    return text([
      `${rows.length} cells on the same duty, best value first (cost per kWh DELIVERED over cycle life, not sticker price):`,
      ...(marineDutyLine ? [marineDutyLine] : []),
      ...rows.map((r) => r.error ? `· ${r.id}: ${r.error}`
        : `· ${r.id}: ${r.kWh.toFixed(1)} kWh, ${r.massKg.toFixed(1)} kg, ${r.usd != null ? `$${Math.round(r.usd)} upfront` : 'price unknown'}, ${r.perKWh != null ? `$${r.perKWh.toFixed(3)}/kWh delivered` : 'lifetime cost unknown'}${r.whPerKm != null ? `, ${r.whPerKm.toFixed(0)} Wh/km` : ''}${r.rangeKm != null ? `, ${Math.round(r.rangeKm)} km range` : ''}${r.fails ? `, ${r.fails} FAIL finding(s)` : ''}`),
      '',
      'Packs are built from whole cells, so energies differ slightly — compare cost per kWh delivered rather than totals.',
    ].join('\n'));
  },

  // The whole tool's opinion of one design, in the order it should be heard.
  // The open questions are returned last and deliberately: an assistant that
  // reads to the end is told to ask them rather than design around a guess.
  review_design(args) {
    const d = designFromSpec(specOf(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cell.form });
    const wiring = wiringStudy({
      topology: topo, packV: d.pack.nominalV,
      maxTempC: cell.tempDischargeC?.[1] ?? 90,
    });
    const fault = faultFromShortCircuit(d.shortCircuit) || {};
    const grounding = groundingStudy({
      topology: topo, application: specOf(args).application, packVMax: d.pack.vMax,
      isolation: d.architecture?.isolation,
      faultA: fault.faultA, clearingS: fault.clearingS, faultBasis: fault.basis,
    });
    const b = designBrief(d, { wiring, grounding });
    const mark = { fail: 'MUST FIX', warn: 'WORTH KNOWING', info: 'NOTED', pass: 'OK' };
    return text([
      `${b.pack.application} — ${b.pack.s}S${b.pack.p}P ${b.pack.cell}, ${(b.pack.energyWh / 1000).toFixed(1)} kWh, verdict: ${b.verdict}`,
      b.headline,
      '',
      'WHAT MATTERS, IN ORDER',
      ...b.findings.filter((f) => f.severity !== 'pass').slice(0, 20).map((f) =>
        `[${mark[f.severity]}] ${f.title} (${f.sources.join(' + ')}${f.ref ? `, ${f.ref}` : ''})\n    ${f.detail}`),
      '',
      'QUESTIONS FOR THE CUSTOMER — ask these, do not guess past them',
      ...(b.questions.length
        ? b.questions.map((q) => `? ${q.asks}\n    Why it matters: ${q.why}\n    How to answer: ${q.how}`)
        : ['Nothing material is being estimated.']),
      '',
      'NOT CHECKED',
      ...b.notChecked.map((n) => `· ${n}`),
    ].join('\n'));
  },

  explain_v2x(args) {
    const d = designFromSpec(specOf(args));
    const v = d.v2x;
    if (!v.applicable) return text(`${d.application?.name}: ${v.why}`);
    const lines = [`${d.application?.name} — feeding power back`, ''];
    for (const m of v.modes) {
      lines.push(`${m.name} — ${m.assessment.verdict}`);
      lines.push(`  ${m.assessment.why}`);
      lines.push(`  Needs: ${m.needs.join('; ')}`);
    }
    lines.push('', v.wearNote);
    if (v.chosen) {
      lines.push('', `Chosen policy: ${v.chosen.name}`);
      lines.push(...v2xParts(v.chosen.id).map((p) => `  · ${p.part} — ${p.why} [${p.standard}]`));
      if (v.budget) lines.push(`  ${v.budget.note}${v.budget.hours != null ? ` About ${v.budget.hours.toFixed(1)} h at ${v.budget.powerKW} kW.` : ''}`);
    } else {
      lines.push('', `No policy chosen. Pass v2xPolicy (one of ${V2X_MODES.map((m) => m.id).join(', ')}) to see the parts, the export budget and the certification it adds.`);
    }
    return text(lines.join('\n'));
  },

  explain_concept(args) {
    const id = args?.concept;
    if (!id || !CONCEPTS[id]) {
      return text(['Concepts the designer models:', ...Object.entries(CONCEPTS).map(([k, c]) => `· ${k} — ${c.label}: ${c.why}`)].join('\n'));
    }
    const c = CONCEPTS[id];
    const lines = [`${c.label} (${id})`, c.why];
    if (args.application) {
      const needs = appNeeds(args.application);
      lines.push('', needs.includes(id)
        ? `${args.application} needs this concept — it appears in that application's training track and panels.`
        : `${args.application} does NOT need this concept, so the tool never shows it there. That is a deliberate edge in the knowledge graph, not an omission.`);
    }
    return text(lines.join('\n'));
  },
};

// --- JSON-RPC over stdio ----------------------------------------------------
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

export function handleMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'battery-design', version: API_VERSION },
        instructions: 'A battery pack designer. Call list_applications and list_cells to learn the real ids; for marine work also call list_vessels, then design_pack. Numbers come from the design modules, not from a language model — where a figure is an estimate rather than a datasheet value, the answer says so.',
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const fn = HANDLERS[params?.name];
      if (!fn) throw Object.assign(new Error(`Unknown tool "${params?.name}"`), { code: -32601 });
      try {
        return fn(params.arguments || {});
      } catch (e) {
        // A failed design is an answer too — report it as tool output the
        // agent can act on, not as a protocol error it cannot see.
        return { content: [{ type: 'text', text: `The design could not be completed: ${e.message}` }], isError: true };
      }
    }
    case 'ping':
      return {};
    default:
      throw Object.assign(new Error(`Unknown method "${method}"`), { code: -32601 });
  }
}

// Only start reading stdin when run as a server, so the handler can be tested.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { replyError(null, -32700, 'Parse error'); continue; }
      if (msg.method?.startsWith('notifications/')) continue; // nothing to acknowledge
      try {
        reply(msg.id, handleMessage(msg));
      } catch (e) {
        replyError(msg.id, e.code || -32603, e.message);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
