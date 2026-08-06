// ontology.js — deterministic, dependency-free semantic graph runtime.
//
// It runs unchanged in the browser and Node. The ontology identifies and
// connects existing engineering answers; it never recalculates them. Maps are
// runtime indexes only and never cross the JSON/API boundary.

import {
  ARCHITECTURE_MODULE_DEFINITIONS,
  CLASS_DEFINITIONS,
  CONCEPT_DEFINITIONS,
  JSON_LD_CONTEXT,
  MATURITY_SCHEMES,
  MODULE_DEFINITIONS,
  NAMESPACES,
  ONTOLOGY,
  PRODUCT_SURFACES,
  RELATION_DEFINITIONS,
  RULE_DEFINITIONS,
  SHAPE_DEFINITIONS,
  STATUS_VOCABULARIES,
  UNIT_DEFINITIONS,
  ontologyCatalog,
} from './ontology-schema.js';
import {
  evaluateEngineeringRules, evaluateRuleApplicability, ruleDefinition,
} from './ontology-rules.js';
import { VESSEL_MODELS } from './vessels.js';

const BASIS = new Set(['published', 'supplier', 'measured', 'calculated', 'derived', 'assumed']);
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function validIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , zone, , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
  ].map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function plain(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, plain(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(plain(value));
}

// Dependency-free SHA-256. Browser, worker and Node surfaces therefore mint
// the same content identity without relying on an asynchronous platform API.
export function semanticDigest(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (word, bits) => (word >>> bits) | (word << (32 - bits));
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    const chunk = [a,b,c,d,e,f,g,hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + chunk[i]) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

const segment = (value) => encodeURIComponent(String(value ?? 'unknown').trim());
export const semanticId = (kind, id) => `${NAMESPACES.bdr}${segment(kind)}/${segment(id)}`;

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sortGraph(graph) {
  graph.nodes.sort((a, b) => a.id.localeCompare(b.id));
  graph.edges.sort((a, b) =>
    a.from.localeCompare(b.from) || a.type.localeCompare(b.type)
    || a.to.localeCompare(b.to) || a.id.localeCompare(b.id));
  return graph;
}

class Builder {
  constructor(rootId = null) {
    this.rootId = rootId;
    this.nodes = new Map();
    this.edges = new Map();
  }

  node(id, types, label, properties = {}) {
    if (!id || typeof id !== 'string') throw new TypeError('Semantic node id must be a non-empty string.');
    const list = [...new Set((Array.isArray(types) ? types : [types]).filter(Boolean))].sort();
    if (!list.length) throw new TypeError(`${id}: semantic node needs at least one type.`);
    const next = { id, types: list, label: String(label || id), properties: plain(properties) };
    const old = this.nodes.get(id);
    if (old && canonicalJson(old) !== canonicalJson(next)) {
      throw new Error(`Semantic identity collision at ${id}. Namespace the two entities separately.`);
    }
    this.nodes.set(id, next);
    return id;
  }

  edge(from, type, to, properties = {}) {
    const cleanProperties = plain(properties);
    const body = Object.keys(cleanProperties).length
      ? { from, type, to, properties: cleanProperties }
      : { from, type, to };
    const id = semanticId('relation', semanticDigest(body).slice(0, 24));
    const next = { id, ...body };
    const old = this.edges.get(id);
    if (old && canonicalJson(old) !== canonicalJson(next)) throw new Error(`Semantic edge collision at ${id}.`);
    this.edges.set(id, next);
    return id;
  }

  graph() {
    const graph = sortGraph({
      format: ONTOLOGY.graphFormat,
      ontology: { id: ONTOLOGY.id, version: ONTOLOGY.version, shapesVersion: ONTOLOGY.shapesVersion },
      rootId: this.rootId,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    });
    const validation = validateSemanticGraph(graph);
    const checksum = semanticDigest({ nodes: graph.nodes, edges: graph.edges });
    return deepFreeze({ ...graph, checksum, validation });
  }
}

function isKnownClass(type) {
  return !!CLASS_DEFINITIONS[type] || /^(prov|sosa|qudt|skos|time):/.test(type);
}

function inheritedTypes(node) {
  const visit = new Set(node?.types || []);
  const queue = [...visit];
  while (queue.length) {
    const type = queue.shift();
    const parent = CLASS_DEFINITIONS[type]?.parent;
    for (const next of (Array.isArray(parent) ? parent : [parent]).filter(Boolean)) {
      if (!visit.has(next)) { visit.add(next); queue.push(next); }
    }
  }
  return visit;
}

function hasType(node, target) { return inheritedTypes(node).has(target); }

const issue = (shapeId, focusNode, path, code, message, severity = 'error') =>
  ({ shapeId, focusNode, path, severity, code, message });

export function validateSemanticGraph(graph, { profile = graph?.profile || ONTOLOGY.profile } = {}) {
  const issues = [];
  const checked = new Set(['bd:GraphShape', 'bd:NodeShape', 'bd:EdgeShape']);
  if (graph?.format !== ONTOLOGY.graphFormat) {
    issues.push(issue('bd:GraphShape', graph?.rootId || '', 'format', 'GRAPH_FORMAT',
      `Expected ${ONTOLOGY.graphFormat}.`));
  }
  const nodes = new Map();
  for (const node of graph?.nodes || []) {
    if (!node?.id) { issues.push(issue('bd:NodeShape', '', 'id', 'NODE_ID', 'Node id is required.')); continue; }
    if (nodes.has(node.id)) issues.push(issue('bd:NodeShape', node.id, 'id', 'DUPLICATE_NODE', 'Node id must be globally unique.'));
    nodes.set(node.id, node);
    if (!Array.isArray(node.types) || !node.types.length) {
      issues.push(issue('bd:NodeShape', node.id, 'types', 'NODE_TYPE', 'At least one semantic type is required.'));
    } else {
      for (const type of node.types) if (!isKnownClass(type)) {
        issues.push(issue('bd:NodeShape', node.id, 'types', 'UNKNOWN_CLASS', `Unknown ontology class ${type}.`));
      }
    }
    if (hasType(node, 'bd:QuantityValue')) {
      checked.add('bd:QuantityValueShape');
      const p = node.properties || {};
      if (!Number.isFinite(p.numericValue)) issues.push(issue('bd:QuantityValueShape', node.id, 'numericValue', 'QUANTITY_VALUE', 'Quantity needs one finite numeric value.'));
      if (!UNIT_DEFINITIONS[p.unit]) issues.push(issue('bd:QuantityValueShape', node.id, 'unit', 'QUANTITY_UNIT', `Unknown unit ${p.unit ?? '(missing)'}.`));
      if (!p.quantityKind) issues.push(issue('bd:QuantityValueShape', node.id, 'quantityKind', 'QUANTITY_KIND', 'Quantity kind is required.'));
      if (UNIT_DEFINITIONS[p.unit] && p.quantityKind !== UNIT_DEFINITIONS[p.unit].quantityKind) {
        issues.push(issue('bd:QuantityValueShape', node.id, 'quantityKind', 'UNIT_DIMENSION',
          `${p.unit} has quantity kind ${UNIT_DEFINITIONS[p.unit].quantityKind}, not ${p.quantityKind}.`));
      }
    }
    if (hasType(node, 'bd:Claim')) {
      checked.add('bd:ProvenancedClaimShape');
      if (!BASIS.has(node.properties?.basis)) issues.push(issue('bd:ProvenancedClaimShape', node.id, 'basis', 'CLAIM_BASIS', 'Claim basis must be published, supplier, measured, calculated, derived or assumed.'));
    }
    if (hasType(node, 'bd:EngineeringResult')) {
      checked.add('bd:EngineeringResultShape');
      if (!/^[a-f0-9]{64}$/.test(node.properties?.resultDigest || '')) {
        issues.push(issue('bd:EngineeringResultShape', node.id, 'resultDigest', 'RESULT_IDENTITY',
          'Engineering result requires a SHA-256 digest of its portable result projection.'));
      }
    }
    if (['bd:TestEvidence', 'bd:CalibrationTrial', 'bd:ValidationTrial', 'bd:ReplayDataset']
      .some((type) => hasType(node, type))) {
      checked.add('bd:EvidenceRecordShape');
      if (typeof node.properties?.revision !== 'string' || !node.properties.revision.trim()) {
        issues.push(issue('bd:EvidenceRecordShape', node.id, 'revision', 'EVIDENCE_REVISION',
          'Governed evidence requires a non-empty revision or content-safe record version.'));
      }
      const issuedAt = node.properties?.issuedAt;
      if (!validIsoInstant(issuedAt)) {
        issues.push(issue('bd:EvidenceRecordShape', node.id, 'issuedAt', 'EVIDENCE_DATE',
          'Governed evidence requires a valid ISO-8601 instant with timezone.'));
      }
    }
    if (hasType(node, 'bd:WorkflowState') && !STATUS_VOCABULARIES.workflowState.includes(node.properties?.value)) {
      issues.push(issue('bd:WorkflowShape', node.id, 'value', 'WORKFLOW_STATE', `Unknown workflow state ${node.properties?.value ?? '(missing)'}.`));
    }
  }
  if (!graph?.rootId || !nodes.has(graph.rootId)) {
    issues.push(issue('bd:GraphShape', graph?.rootId || '', 'rootId', 'GRAPH_ROOT', 'Graph root must identify one graph node.'));
  }
  const edgeIds = new Set();
  for (const edge of graph?.edges || []) {
    if (!edge?.id || edgeIds.has(edge.id)) issues.push(issue('bd:EdgeShape', edge?.id || '', 'id', 'DUPLICATE_EDGE', 'Edge id must be present and unique.'));
    edgeIds.add(edge?.id);
    const relation = RELATION_DEFINITIONS[edge?.type];
    if (!relation) issues.push(issue('bd:EdgeShape', edge?.id || '', 'type', 'UNKNOWN_RELATION', `Unknown relation ${edge?.type ?? '(missing)'}.`));
    if (!nodes.has(edge?.from)) issues.push(issue('bd:EdgeShape', edge?.id || '', 'from', 'DANGLING_FROM', `Missing source node ${edge?.from}.`));
    if (!nodes.has(edge?.to)) issues.push(issue('bd:EdgeShape', edge?.id || '', 'to', 'DANGLING_TO', `Missing target node ${edge?.to}.`));
    if (relation && nodes.has(edge?.from) && !hasType(nodes.get(edge.from), relation.domain)) {
      issues.push(issue('bd:EdgeShape', edge.id, 'from', 'RELATION_DOMAIN',
        `${edge.type} requires source type ${relation.domain}.`));
    }
    if (relation && nodes.has(edge?.to) && !hasType(nodes.get(edge.to), relation.range)) {
      issues.push(issue('bd:EdgeShape', edge.id, 'to', 'RELATION_RANGE',
        `${edge.type} requires target type ${relation.range}.`));
    }
  }

  const outgoing = new Map(), incoming = new Map();
  for (const edge of graph?.edges || []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }
  const edgesFrom = (id, type) => (outgoing.get(id) || []).filter((edge) => !type || edge.type === type);
  const edgesTo = (id, type) => (incoming.get(id) || []).filter((edge) => !type || edge.type === type);
  for (const node of nodes.values()) {
    if (hasType(node, 'bd:ModelRun')) {
      checked.add('bd:ModelRunShape');
    for (const relation of ['bd:usesModel', 'bd:usesInput', 'bd:usesSolver', 'bd:produces']) {
        if (!edgesFrom(node.id, relation).length) issues.push(issue('bd:ModelRunShape', node.id, relation, 'RUN_LINEAGE', `Model run requires ${relation}.`));
      }
      if (!node.properties?.inputDigest || !node.properties?.modelVersion || !node.properties?.solverVersion) {
        issues.push(issue('bd:ModelRunShape', node.id, 'properties', 'RUN_IDENTITY', 'Run requires inputDigest, modelVersion and solverVersion.'));
      }
    }
    if (hasType(node, 'bd:HILRun')) {
      checked.add('bd:HILRunShape');
      for (const key of ['targetIdentity', 'samplePeriodS', 'measuredTiming', 'safeStateEvidence', 'faultEvidence']) {
        if (node.properties?.[key] == null) issues.push(issue('bd:HILRunShape', node.id, key, 'HIL_EVIDENCE', `HIL run requires ${key}.`));
      }
    }
    if (hasType(node, 'bd:DigitalTwin')) {
      checked.add('bd:TwinReadinessShape');
      const represented = edgesFrom(node.id, 'bd:representsAsset');
      if (represented.length !== 1) issues.push(issue('bd:TwinReadinessShape', node.id, 'bd:representsAsset', 'TWIN_ASSET', 'A digital twin represents exactly one physical asset.'));
      const support = edgesFrom(node.id, 'bd:supportedBy').map((edge) => nodes.get(edge.to)).filter(Boolean);
      for (const required of ['bd:CalibrationTrial', 'bd:ValidationTrial', 'bd:ReplayDataset']) {
        if (!support.some((evidence) => hasType(evidence, required))) issues.push(issue('bd:TwinReadinessShape', node.id, 'bd:supportedBy', 'TWIN_EVIDENCE', `Digital twin requires ${required}.`));
      }
      if (represented.length === 1) {
        const assetId = represented[0].to;
        for (const evidence of support) if (!edgesFrom(evidence.id, 'bd:observesAsset').some((edge) => edge.to === assetId)) {
          issues.push(issue('bd:TwinReadinessShape', node.id, 'bd:observesAsset', 'TWIN_ASSET_SCOPE', 'All twin evidence must observe the represented physical asset.'));
        }
      }
    }
    if (hasType(node, 'bd:ReleaseDecision')) {
      checked.add('bd:ReleaseShape');
      const releases = edgesFrom(node.id, 'bd:releases');
      const approvals = edgesTo(node.id, 'bd:authorizes');
      if (releases.length !== 1) issues.push(issue('bd:ReleaseShape', node.id, 'bd:releases', 'RELEASE_TARGET', 'Release decision must target one exact design version.'));
      if (approvals.length !== 1) issues.push(issue('bd:ReleaseShape', node.id, 'bd:authorizes', 'RELEASE_APPROVAL', 'Release decision requires one qualified human approval.'));
      const target = releases[0]?.to;
      if (target && ![...nodes.values()].some((candidate) => hasType(candidate, 'bd:TestEvidence')
        && candidate.properties?.result === 'pass' && edgesFrom(candidate.id, 'bd:verifies').some((edge) => edge.to === target))) {
        issues.push(issue('bd:ReleaseShape', node.id, 'bd:verifies', 'RELEASE_TEST_EVIDENCE', 'Release requires passing test evidence bound to the exact design version.'));
      }
      const releaseActors = edgesFrom(node.id, 'bd:performedBy').map((edge) => nodes.get(edge.to));
      if (releaseActors.length !== 1 || releaseActors[0]?.properties?.kind !== 'human'
        || !(releaseActors[0]?.properties?.authorities || []).includes('release')) {
        issues.push(issue('bd:ReleaseShape', node.id, 'bd:performedBy', 'RELEASE_AUTHORITY', 'Release requires one named human with release authority.'));
      }
      if (target && node.properties?.designChecksum !== nodes.get(target)?.properties?.contentDigest) {
        issues.push(issue('bd:ReleaseShape', node.id, 'designChecksum', 'RELEASE_VERSION_BINDING', 'Release checksum must match the exact design version.'));
      }
    }
    if (hasType(node, 'bd:Approval')) {
      checked.add('bd:ReleaseShape');
      const performers = edgesFrom(node.id, 'bd:performedBy').map((edge) => nodes.get(edge.to));
      const authorized = performers.length === 1 && performers[0]?.properties?.kind === 'human'
        && (performers[0]?.properties?.authorities || []).some((authority) => ['approve', 'release'].includes(authority));
      if (!authorized) issues.push(issue('bd:ReleaseShape', node.id, 'bd:performedBy', 'APPROVAL_AUTHORITY', 'Approval requires one named human with approve or release authority.'));
      if (!node.properties?.designChecksum) issues.push(issue('bd:ReleaseShape', node.id, 'designChecksum', 'APPROVAL_VERSION_BINDING', 'Approval must bind the exact design semantic checksum.'));
      const approvedDesign = edgesFrom(node.id, 'bd:approves')[0]?.to;
      if (approvedDesign && node.properties?.designChecksum !== nodes.get(approvedDesign)?.properties?.contentDigest) {
        issues.push(issue('bd:ReleaseShape', node.id, 'designChecksum', 'APPROVAL_VERSION_BINDING', 'Approval checksum must match the exact design version.'));
      }
    }
    if (hasType(node, 'bd:Design')) {
      const state = edgesFrom(node.id, 'bd:hasWorkflowState').map((edge) => nodes.get(edge.to)?.properties?.value)[0];
      if (state === 'approved' && !edgesTo(node.id, 'bd:approves').length) {
        issues.push(issue('bd:ReleaseShape', node.id, 'bd:approves', 'APPROVAL_MISSING', 'Approved workflow state requires a qualified approval.'));
      }
      if (state === 'released' && !edgesFrom(node.id, 'bd:hasReleaseDecision').length) {
        issues.push(issue('bd:ReleaseShape', node.id, 'bd:hasReleaseDecision', 'RELEASE_DECISION_MISSING', 'Released workflow state requires a release decision.'));
      }
    }
  }

  issues.sort((a, b) => a.severity.localeCompare(b.severity)
    || a.focusNode.localeCompare(b.focusNode) || a.shapeId.localeCompare(b.shapeId)
    || a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  return deepFreeze({
    conforms: !issues.some((x) => x.severity === 'error'),
    profile,
    shapesVersion: ONTOLOGY.shapesVersion,
    checkedShapes: [...checked].sort(),
    issues,
  });
}

function unitNode(builder, code) {
  const def = UNIT_DEFINITIONS[code];
  if (!def) throw new RangeError(`Unknown ontology unit ${code}.`);
  return builder.node(semanticId('unit', code), 'bd:Unit', def.label, { code, ...def });
}

function quantity(builder, owner, key, value, unit, label = key) {
  if (!Number.isFinite(value)) return null;
  const def = UNIT_DEFINITIONS[unit];
  if (!def) throw new RangeError(`Unknown ontology unit ${unit}.`);
  const id = semanticId('quantity', `${semanticDigest(owner).slice(0, 24)}-${key}`);
  builder.node(id, 'bd:QuantityValue', label, {
    key, numericValue: value, unit, quantityKind: def.quantityKind,
  });
  const u = unitNode(builder, unit);
  builder.edge(owner, 'bd:hasQuantity', id);
  builder.edge(id, 'bd:hasUnit', u);
  return id;
}

function softwareModule(builder, implementation) {
  const id = semanticId('software-module', implementation);
  return builder.node(id, ['bd:AssetModel', 'bd:SoftwareModule'], implementation);
}

function feasibility(findings = []) {
  if (findings.some((x) => x?.severity === 'fail')) return 'fail';
  if (findings.some((x) => x?.severity === 'warn')) return 'review';
  return 'pass';
}

export function cellEvidenceMaturity(design = {}) {
  const basis = design?.cell?.dataBasis;
  if (basis === 'supplier') return 'supplier';
  if (basis === 'teardown' || basis === 'measured') return 'measured';
  if (['external_datasheet', 'contrib', 'trade_press', 'published', 'official'].includes(basis)) return 'published';
  if (basis === 'recalled' || basis === 'assumed') return 'assumed';
  if (basis === 'composite' || basis) return 'provisional';
  return 'missing';
}

export function maturityFromChecks(schemeId, checks = {}) {
  const scheme = MATURITY_SCHEMES[schemeId];
  if (!scheme) throw new RangeError(`Unknown ontology maturity scheme "${schemeId}".`);
  const passed = Array.isArray(checks)
    ? Object.fromEntries(checks.map((check) => [check.id, check.pass === true]))
    : { ...checks };
  let achieved = scheme.levels[0];
  const required = [];
  for (const level of scheme.levels) {
    required.push(...level.requires);
    if (required.every((id) => passed[id] === true)) achieved = level;
    else break;
  }
  return Object.freeze({
    scheme: scheme.id, id: achieved.id, label: achieved.label,
    missing: [...new Set(required.filter((id) => passed[id] !== true))],
  });
}

function moduleResultProperties(value) {
  const status = value?.status || value?.verdict || value?.assessment?.verdict
    || value?.readiness?.maturity || value?.summary?.status || null;
  return { status: typeof status === 'string' ? status : null };
}

const RESULT_PROJECTION_EXCLUDED_KEYS = new Set([
  'evidence', 'evidenceBindings', 'twinEvidence', 'supplierEvidence',
  'replay', 'replaySamples', 'samples', 'trace', 'raw', 'content', 'document',
  'file', 'path', 'actorId', 'organization', 'reason', 'credential', 'token',
]);
const RESULT_PROJECTION_STRING_KEYS = new Set([
  'id', 'key', 'code', 'status', 'verdict', 'state', 'kind', 'type', 'mode',
  'unit', 'basis', 'decision', 'outcome', 'maturity', 'category', 'domain',
  'application', 'applicationId', 'vesselId', 'policyId', 'profileId',
  'referenceId', 'contactorId', 'limitedBy', 'flowRegime',
]);

// Result identity is based on an explicit portable projection: finite
// numbers and booleans, controlled identifier/status strings and their
// containing structure. Raw evidence, samples, traces, files and personal
// workflow fields are excluded before hashing and never enter the graph.
function portableModuleResultProjection(value, key = '', depth = 0) {
  if (depth > 24 || RESULT_PROJECTION_EXCLUDED_KEYS.has(key)) return undefined;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return RESULT_PROJECTION_STRING_KEYS.has(key) || /(?:Id|Code|Status|Type|Kind|Mode)$/.test(key)
      ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => portableModuleResultProjection(item, key, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.keys(value).sort().flatMap((childKey) => {
    const projected = portableModuleResultProjection(value[childKey], childKey, depth + 1);
    return projected === undefined ? [] : [[childKey, projected]];
  }));
}

function hasFinishedModuleResult(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== 'object') return true;
  if (value.unavailable === true || value.pending === true) return false;
  return Object.keys(value).length > 0;
}

function engineeringRuleNode(builder, key, definition, { full = false } = {}) {
  const ruleId = semanticId('engineering-rule', key);
  const portableDefinition = {
    key,
    evaluator: definition.evaluator,
    module: definition.module,
    authority: definition.authority || null,
    basis: definition.basis || null,
    definitionDigest: semanticDigest(definition),
  };
  if (full) Object.assign(portableDefinition, {
    match: definition.match,
    when: definition.when,
    requiredFacts: definition.requiredFacts || [],
    criteria: definition.criteria || [],
    effect: definition.effect || null,
    missingFactOutcome: definition.missingFactOutcome || null,
    evidence: definition.evidence || [],
  });
  return builder.node(ruleId, [...new Set(['bd:EngineeringRule', definition.type].filter(Boolean))],
    definition.label, portableDefinition);
}

function architectureCatalog(builder, rootId = null) {
  const capabilitySurfaces = new Map();
  for (const [surfaceKey, definition] of Object.entries(PRODUCT_SURFACES)) {
    const surfaceId = builder.node(semanticId('product-surface', surfaceKey), 'bd:ProductSurface', definition.label, {
      key: surfaceKey, execution: definition.execution,
    });
    if (rootId) builder.edge(rootId, 'bd:hasPart', surfaceId);
  }
  for (const [moduleKey, definition] of Object.entries(ARCHITECTURE_MODULE_DEFINITIONS)) {
    const moduleId = semanticId('architecture-module', moduleKey);
    builder.node(moduleId, 'bd:DomainModule', definition.label, {
      key: moduleKey, domain: definition.domain, implementation: definition.implementation,
    });
    if (rootId) builder.edge(rootId, 'bd:hasPart', moduleId);
    for (const capabilityKey of definition.capabilities || []) {
      const capabilityId = semanticId('capability', capabilityKey);
      builder.node(capabilityId, ['bd:Capability', 'bd:Concept'], capabilityKey, { legacyId: capabilityKey });
      builder.edge(moduleId, 'bd:implementsCapability', capabilityId);
      for (const [surfaceKey, mode] of Object.entries(definition.surfaces || {})) {
        if (!mode || mode === 'none' || mode === 'unavailable') continue;
        const pair = `${capabilityId}|${surfaceKey}`;
        if (!capabilitySurfaces.has(pair)) capabilitySurfaces.set(pair, []);
        capabilitySurfaces.get(pair).push({ moduleKey, mode });
      }
    }
  }
  for (const [pair, availability] of [...capabilitySurfaces].sort(([a], [b]) => a.localeCompare(b))) {
    const [capabilityId, surfaceKey] = pair.split('|');
    builder.edge(capabilityId, 'bd:availableOn', semanticId('product-surface', surfaceKey), { availability });
  }
  for (const [ruleKey, definition] of Object.entries(RULE_DEFINITIONS)) {
    const ruleId = engineeringRuleNode(builder, ruleKey, definition, { full: true });
    if (rootId) builder.edge(rootId, 'bd:hasPart', ruleId);
    const owner = semanticId('architecture-module', definition.module);
    if (ARCHITECTURE_MODULE_DEFINITIONS[definition.module]) builder.edge(owner, 'bd:implementsRule', ruleId);
  }
}

/** The complete product architecture is queryable independently from one
 * design result, avoiding a large repeated catalog in every API response. */
export function buildArchitectureSemanticGraph() {
  const rootId = semanticId('architecture', `battery-design-${ONTOLOGY.version}`);
  const builder = new Builder(rootId);
  builder.node(rootId, ['bd:AssetModel', 'bd:System'], 'battery-design system architecture', {
    ontologyVersion: ONTOLOGY.version,
  });
  architectureCatalog(builder, rootId);
  return builder.graph();
}

const portableScalars = (source, keys) => {
  const out = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
};

const opaqueContentDigest = (value) => {
  if (typeof value !== 'string' || !value) return null;
  return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : semanticDigest(value);
};

function portableDomainInputDigests(spec = {}) {
  const domains = {};
  const route = portableScalars(spec.route, ['targetKph']);
  if (Array.isArray(spec.route?.points)) {
    route.points = spec.route.points.map((point) => portableScalars(point, ['lat', 'lon', 'eleM', 'tS']))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  }
  if (Object.keys(route).length) domains.route = route;

  const mission = portableScalars(spec.mission, ['passes', 'startSoC', 'ambientC']);
  const charge = portableScalars(spec.mission?.charge, ['mode', 'powerW', 'minutes']);
  if (Object.keys(charge).length) mission.charge = charge;
  if (Object.keys(mission).length) domains.mission = mission;

  const vehicle = portableScalars(spec.vehicle, [
    'curbKg', 'payloadKg', 'cd', 'frontalAreaM2', 'crr', 'driveEff',
    'regenFrac', 'auxW', 'rotatingMass',
  ]);
  if (Object.keys(vehicle).length) domains.vehicle = vehicle;

  // Twin evidence, physical-asset identity, replay samples and replay
  // thresholds intentionally have no entry in this portable input grammar.
  // They govern twin maturity independently and cannot change a design IRI.
  const marine = portableScalars(spec.marine, [
    'vesselId', 'referenceMassKg', 'payloadKg', 'designSpeedKn',
    'serviceSpeedKn', 'headCurrentKn', 'headwindKn', 'propulsionAtDesignW',
    'hotelW', 'durationH', 'seaState',
  ]);
  if (Object.keys(marine).length) domains.marine = marine;

  const flight = portableScalars(spec.flight, [
    'emptyMassKg', 'payloadKg', 'rotorCount', 'rotorDiameterM', 'flightMinutes',
    'cruiseSpeedMps', 'headwindMps', 'altitudeM', 'temperatureC',
    'propulsiveEfficiency', 'auxiliaryW', 'hoverFraction',
  ]);
  if (Object.keys(flight).length) domains.flight = flight;

  const efficiency = portableScalars(spec.efficiency, [
    'chargeEff', 'batteryEff', 'dischargeEff', 'auxiliaryW', 'cycleHours',
  ]);
  if (Object.keys(efficiency).length) domains.efficiency = efficiency;

  const diagnostics = portableScalars(spec.diagnostics, [
    'rest', 'pulse', 'relaxation', 'thermal', 'aging',
  ]);
  if (Object.keys(diagnostics).length) domains.diagnostics = diagnostics;
  const monitoring = portableScalars(spec.conditionMonitoring, [
    'baselineWindows', 'operatingModes', 'samplingHz',
  ]);
  if (Object.keys(monitoring).length) domains.conditionMonitoring = monitoring;

  const geometry = {
    ...portableScalars(spec, ['arrangement', 'orientation', 'spacingMm', 'wallMm', 'headroomMm']),
    ...portableScalars(spec.layout, [
      'arrangement', 'orientation', 'spacingMm', 'wallMm', 'headroomMm',
      'maxXmm', 'maxYmm', 'maxZmm',
    ]),
  };
  if (Object.keys(geometry).length) domains.geometry = geometry;

  const protection = {};
  const precharge = portableScalars(spec.electricalProtection?.precharge, [
    'capacitanceUF', 'targetTimeS', 'closeGapV', 'resistanceOhm',
    'resistanceTolerancePct', 'loadCurrentA', 'startsPerHour', 'designMarginPct',
    'resistorVoltageRatingV', 'resistorPulseEnergyJ', 'resistorPulsePowerW',
    'resistorContinuousPowerW', 'contactorId', 'contactorMakeA',
    'contactorMechanicalCycles',
  ]);
  if (Object.keys(precharge).length) protection.precharge = precharge;
  const shunt = portableScalars(spec.electricalProtection?.shunt, [
    'referenceId', 'resistanceUOhm', 'resistanceTolerancePct', 'continuousRatingA',
    'peakRatingA', 'peakDurationRatingS', 'conductorAreaMm2', 'maxOperatingC',
    'gainErrorPct', 'offsetErrorA', 'noiseErrorA', 'thermalResistanceKPerW',
    'thermalTimeConstantS', 'ambientC', 'continuousA', 'peakA', 'peakDurationS',
    'tempcoPpmPerK', 'requiredAccuracyPct',
  ]);
  if (Array.isArray(spec.electricalProtection?.shunt?.currentSegments)) {
    shunt.currentSegments = spec.electricalProtection.shunt.currentSegments
      .map((row) => portableScalars(row, ['currentA', 'durationS']));
  }
  if (Object.keys(shunt).length) protection.shunt = shunt;
  const fast = portableScalars(spec.electricalProtection?.fast, [
    'thresholdA', 'totalDelayMs', 'shuntPeakRangeA', 'shuntErrorA',
    'interrupterVoltageRatingV', 'interrupterCurrentRatingA',
  ]);
  if (Object.keys(fast).length) protection.fast = fast;
  if (Object.keys(protection).length) domains.electricalProtection = protection;

  return Object.fromEntries(Object.entries(domains).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, semanticDigest(value)]));
}

function portableDesignSeed(design, appId, cellId, pack, resolved) {
  const spec = design?.spec || {};
  const declared = {};
  for (const key of ['s', 'p', 'energyWh', 'market', 'dod', 'cyclesPerYear', 'targetYears',
    'gradePct', 'profileId', 'driveMode', 'policyId', 'isolationStandard', 'v2xPolicy',
    'vesselId', 'arrangement', 'orientation', 'spacingMm', 'wallMm', 'headroomMm',
    'busbarMOhm', 'contactorMOhm', 'fuseRatingA', 'fuseI2t',
    'contactorBreakingA', 'busbarAreaMm2', 'busbarKind', 'linkFuseA']) {
    const value = spec[key];
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) declared[key] = value ?? null;
  }
  if (Array.isArray(spec.ambientC)) declared.ambientC = spec.ambientC.filter(Number.isFinite).slice(0, 2);
  if (Array.isArray(spec.compareCellIds)) {
    declared.compareCellIds = spec.compareCellIds.filter((id) => typeof id === 'string').sort();
  }
  declared.domainInputDigests = portableDomainInputDigests(spec);
  const resolvedTraceIdentity = resolved.sizing?.traceIdentity;
  const traceIdentity = typeof resolvedTraceIdentity?.id === 'string'
    && /^[a-f0-9]{64}$/i.test(resolvedTraceIdentity?.checksum || '')
    ? { id: resolvedTraceIdentity.id, checksum: resolvedTraceIdentity.checksum.toLowerCase() }
    : null;
  return {
    application: appId, cell: cellId,
    resolved: {
      s: resolved.s ?? pack.s ?? null, p: resolved.p ?? pack.p ?? null,
      market: resolved.market || design.market || null,
      vesselId: resolved.vesselId || design.marine?.vessel?.id || null,
      isolationContext: resolved.isolationContext || design.architecture?.isolation?.contextId
        || design.architecture?.isolationReview?.contextId || null,
      isolationStatus: resolved.isolationStatus || design.architecture?.isolation?.status
        || design.architecture?.isolationReview?.status || null,
      sizing: {
        profileId: resolved.sizing?.profileId || null,
        policyId: resolved.sizing?.policyId || null,
        driveMode: resolved.sizing?.driveMode || null,
        traceIdentity,
        scaleW: Number.isFinite(resolved.sizing?.scaleW) ? resolved.sizing.scaleW : null,
      },
      components: Object.fromEntries(Object.entries(resolved.components || design.selection || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value?.id || value || null])),
    },
    declared,
    results: {
      pack: {
        nominalV: pack.nominalV ?? null, energyWh: pack.energyWh ?? null,
        massKg: pack.massKg ?? null,
        dimensionsMm: {
          x: pack.dims?.x ?? null, y: pack.dims?.y ?? null, z: pack.dims?.z ?? null,
        },
      },
      marine: design.marine ? { energyWh: design.marine.energyWh ?? null, peakW: design.marine.peakW ?? null, distanceNm: design.marine.distanceNm ?? null } : null,
      vehicle: design.vehicle ? { rangeKm: design.vehicle.rangeKm ?? null, peakW: design.vehicle.peakW ?? null } : null,
      flight: design.flight ? { energyWh: design.flight.energyWh ?? null, peakW: design.flight.peakW ?? null } : null,
    },
  };
}

/** Build a portable semantic graph around one finished engineering design. */
export function buildDesignSemanticGraph(design = {}) {
  const pack = design.pack || design.summary || {};
  const resolved = design.spec?.resolved || {};
  const appId = resolved.application || design.application?.id || design.application || 'custom';
  const cellId = resolved.cell || design.cell?.id || 'unknown-cell';
  // Identity uses an explicit allowlist. Raw replay, physical asset ids,
  // caller-supplied semantic claims and free-form customer evidence can never
  // enter a portable graph or influence its identity by accident.
  const seed = portableDesignSeed(design, appId, cellId, pack, resolved);
  const designKey = semanticDigest(seed);
  const designScope = designKey.slice(0, 24);
  const projectRef = design.spec?.projectId == null
    ? null : semanticDigest(String(design.spec.projectId)).slice(0, 24);
  const designVersion = design.spec?.version || design.apiVersion || ONTOLOGY.version;
  const designId = semanticId('design-version', projectRef
    ? `${projectRef}/${designVersion}/${designScope}` : `content/${designScope}`);
  const specificationId = semanticId('design-specification', designScope);
  const builder = new Builder(designId);
  builder.node(designId, 'bd:Design', `${appId} battery design`, {
    designKey, contentDigest: designKey, projectRef, designVersion,
    applicationId: appId, ontologyVersion: ONTOLOGY.version,
  });
  builder.node(specificationId, 'bd:DesignSpecification', `${appId} battery design inputs`, {
    inputDigest: designKey, applicationId: appId, apiVersion: design.apiVersion || null,
    resolved: seed.resolved, declared: seed.declared,
  });
  builder.edge(designId, 'bd:hasSpecification', specificationId);

  const app = semanticId('application', appId);
  builder.node(app, 'bd:Application', design.application?.name || appId, {
    legacyId: appId, applicationClass: design.application?.class || null,
  });
  builder.edge(designId, 'bd:selects', app);
  if (design.application?.class) {
    const appClass = semanticId('application-class', design.application.class);
    builder.node(appClass, 'bd:ApplicationClass', design.application.class, { legacyId: design.application.class });
    builder.edge(app, 'bd:classifiedAs', appClass);
  }
  for (const conceptId of design.concepts || []) {
    const capability = semanticId('capability', conceptId);
    builder.node(capability, ['bd:Concept', 'bd:Capability'], conceptId);
    builder.edge(app, 'bd:requiresCapability', capability);
  }

  const packId = semanticId('pack-design', designScope);
  builder.node(packId, ['bd:System', 'bd:BatterySystem', 'bd:PackDesign'], `${pack.s ?? '?'}S${pack.p ?? '?'}P pack`, {
    seriesCount: pack.s ?? resolved.s ?? null, parallelCount: pack.p ?? resolved.p ?? null,
    cellCount: pack.cellCount ?? null,
  });
  builder.edge(specificationId, 'bd:specifiesSystem', packId);

  const cell = semanticId('cell-specification', cellId);
  builder.node(cell, 'bd:CellSpecification', design.cell?.name || cellId, {
    legacyId: cellId, form: design.cell?.form || null, dataQuality: design.cell?.dataQuality || null,
  });
  builder.edge(packId, 'bd:specifiedBy', cell, { count: pack.cellCount ?? null });
  builder.edge(designId, 'bd:selects', cell);
  if (design.cell?.chemistry) {
    const chemistry = semanticId('chemistry', design.cell.chemistry);
    builder.node(chemistry, 'bd:ChemistryFamily', design.cell.chemistry, { legacyId: design.cell.chemistry });
    builder.edge(cell, 'bd:hasChemistry', chemistry);
    builder.edge(packId, 'bd:hasChemistry', chemistry);
  }

  const quantities = [
    ['nominal-voltage', pack.nominalV, 'V', 'Pack nominal voltage'],
    ['maximum-voltage', pack.vMax, 'V', 'Pack maximum voltage'],
    ['minimum-voltage', pack.vMin, 'V', 'Pack minimum voltage'],
    ['capacity', pack.capacityAh, 'Ah', 'Pack capacity'],
    ['stored-energy', pack.energyWh, 'Wh', 'Pack stored energy'],
    ['mass', pack.massKg, 'kg', 'Pack mass'],
    ['continuous-current', pack.maxContCurrentA, 'A', 'Maximum continuous current'],
    ['continuous-power', pack.maxContPowerW, 'W', 'Maximum continuous power'],
    ['resistance', pack.dcirMOhm, 'mOhm', 'Pack DC resistance'],
    ['length-x', pack.dims?.x, 'mm', 'Pack X dimension'],
    ['length-y', pack.dims?.y, 'mm', 'Pack Y dimension'],
    ['length-z', pack.dims?.z, 'mm', 'Pack Z dimension'],
  ];
  for (const row of quantities) quantity(builder, packId, ...row);

  for (const [category, selected] of Object.entries(resolved.components || design.selection || {})) {
    const legacyId = selected?.id || selected;
    if (!legacyId) continue;
    const component = semanticId(`component-${category}`, legacyId);
    builder.node(component, 'bd:Component', selected?.name || String(legacyId), { category, legacyId });
    builder.edge(designId, 'bd:selects', component);
    builder.edge(packId, 'bd:hasPart', component);
  }

  const selectedVessel = design.marine?.vessel;
  let installationStudyId = null;
  if (selectedVessel?.id) {
    for (const vessel of VESSEL_MODELS) {
      const vesselModel = semanticId('vessel-model', vessel.id);
      const representation = semanticId('engineering-massing-model', `${vessel.id}-${vessel.model.version}`);
      builder.node(vesselModel, 'bd:VesselModel', vessel.name, {
        legacyId: vessel.id, segment: vessel.segment,
        sourceTitle: vessel.evidence.title, sourceUrl: vessel.evidence.url,
      });
      builder.node(representation, ['bd:EngineeringMassingModel', 'bd:EngineeringModel'], `${vessel.name} engineering massing model`, {
        modelVersion: vessel.model.version, primitiveCount: vessel.model.primitives.length,
        fidelity: 'complete-low-detail-engineering-massing-not-production-cad',
      });
      builder.edge(specificationId, 'bd:hasCandidateHostModel', vesselModel);
      builder.edge(vesselModel, 'bd:hasRepresentation', representation);
    }

    const vesselModel = semanticId('vessel-model', selectedVessel.id);
    installationStudyId = semanticId('installation-study', `${designScope}-${selectedVessel.id}`);
    builder.node(installationStudyId, 'bd:InstallationStudy', `${selectedVessel.name || selectedVessel.id} battery study`, {
      asBuilt: false,
      boundary: selectedVessel.boundary || 'Installation remains a study until physical evidence exists.',
    });
    builder.edge(designId, 'bd:hasStudy', installationStudyId);
    builder.edge(installationStudyId, 'bd:studiesInstallationOf', packId);
    builder.edge(installationStudyId, 'bd:targetsAssetModel', vesselModel);

    const missionInput = design.marine?.inputs || {};
    const missionFacts = {
      durationH: Number.isFinite(missionInput.durationH) ? missionInput.durationH : null,
      serviceSpeedKn: Number.isFinite(missionInput.serviceSpeedKn) ? missionInput.serviceSpeedKn : null,
      payloadKg: Number.isFinite(missionInput.payloadKg) ? missionInput.payloadKg : null,
    };
    const voyageId = semanticId('voyage', `${designScope}-${semanticDigest(missionFacts).slice(0, 24)}`);
    const policyKey = design.marine?.policyId || resolved.sizing?.policyId || 'unresolved-marine-policy';
    const policyId = semanticId('operating-policy', policyKey);
    builder.node(voyageId, ['bd:Mission', 'bd:Voyage'], `${selectedVessel.name || selectedVessel.id} voyage`, {
      missionDigest: semanticDigest(missionFacts), ...missionFacts,
      distanceNm: design.marine?.distanceNm ?? null,
    });
    builder.node(policyId, 'bd:OperatingPolicy', policyKey, { key: policyKey });
    builder.edge(designId, 'bd:selects', voyageId);
    builder.edge(designId, 'bd:selects', policyId);
    builder.edge(voyageId, 'bd:forAssetModel', vesselModel);
    builder.edge(voyageId, 'bd:usesPolicy', policyId);
    const profile = design.simulation?.profile || design.marine?.profile;
    if (profile?.id) {
      const profileId = semanticId('load-profile', `${designScope}-${profile.id}`);
      const profileTraceIdentity = profile.traceIdentity || design.simulation?.trace?.identity
        || resolved.sizing?.traceIdentity || null;
      const profileProjection = {
        key: profile.id, policyId: profile.policyId || policyKey,
        dtS: Number.isFinite(profile.dtS) ? profile.dtS : null,
        scaleW: Number.isFinite(resolved.sizing?.scaleW) ? resolved.sizing.scaleW
          : (Number.isFinite(design.simulation?.profile?.scaleW)
            ? design.simulation.profile.scaleW : null),
        traceChecksum: /^[a-f0-9]{64}$/i.test(profileTraceIdentity?.checksum || '')
          ? profileTraceIdentity.checksum.toLowerCase() : null,
      };
      builder.node(profileId, 'bd:LoadProfile', profile.name || profile.id, {
        ...profileProjection, resultDigest: semanticDigest(profileProjection),
      });
      builder.edge(policyId, 'bd:generatesProfile', profileId);
      builder.edge(designId, 'bd:selects', profileId);
    }

    const readiness = design.twinShip?.readiness;
    const evidence = readiness?.evidenceBindings || {};
    const assetBinding = opaqueContentDigest(evidence.asset?.assetBindingDigest);
    const modelBinding = opaqueContentDigest(evidence.model?.modelBindingDigest);
    if (assetBinding && readiness?.evidenceAccepted?.asset) {
      const assetId = semanticId('physical-asset-binding', assetBinding.slice(0, 24));
      builder.node(assetId, ['bd:HostAsset', 'bd:PhysicalAsset'], `${selectedVessel.name || selectedVessel.id} identified asset`, {
        identityWithheld: true, assetBindingDigest: assetBinding,
      });
      builder.edge(assetId, 'bd:instanceOf', vesselModel);
      builder.edge(installationStudyId, 'bd:boundToAsset', assetId);
      if (modelBinding && readiness?.evidenceAccepted?.model) {
        const twinModelId = semanticId('vessel-engineering-model', modelBinding.slice(0, 24));
        builder.node(twinModelId, 'bd:EngineeringModel', `${selectedVessel.name || selectedVessel.id} governed vessel model`, {
          modelBindingDigest: modelBinding, version: evidence.model.revision || null,
        });
        builder.edge(twinModelId, 'bd:modelOf', vesselModel);
        builder.edge(twinModelId, 'bd:boundToAsset', assetId);
        const supportIds = [];
        const evidenceTypes = {
          asset: 'bd:EvidenceRecord', model: 'bd:EvidenceRecord',
          calibration: 'bd:CalibrationTrial', validation: 'bd:ValidationTrial', replay: 'bd:ReplayDataset',
        };
        for (const [kind, type] of Object.entries(evidenceTypes)) {
          const record = evidence[kind];
          if (!record?.recordDigest || !readiness.evidenceAccepted?.[kind]) continue;
          const recordDigest = opaqueContentDigest(record.recordDigest);
          const recordAssetBinding = opaqueContentDigest(record.assetBindingDigest);
          const recordModelBinding = opaqueContentDigest(record.modelBindingDigest);
          const evidenceId = semanticId(`${kind}-evidence`, recordDigest.slice(0, 24));
          builder.node(evidenceId, type, `${kind} evidence`, {
            kind, recordDigest, revision: record.revision || null,
            issuedAt: record.issuedAt || null, result: record.result || null,
            assetBindingDigest: recordAssetBinding,
            modelBindingDigest: recordModelBinding,
          });
          builder.edge(evidenceId, 'bd:observesAsset', assetId);
          if (kind !== 'asset') builder.edge(evidenceId, 'bd:evaluatesModel', twinModelId);
          if (kind === 'calibration') builder.edge(evidenceId, 'bd:calibrates', twinModelId);
          if (kind === 'validation') builder.edge(evidenceId, 'bd:validates', twinModelId);
          builder.edge(twinModelId, 'bd:supportedBy', evidenceId);
          if (['calibration', 'validation', 'replay'].includes(kind)) supportIds.push(evidenceId);
          if (kind === 'replay') {
            const observationId = semanticId('observation', recordDigest.slice(0, 24));
            builder.node(observationId, 'bd:Observation', 'Representative vessel replay observation', {
              basis: 'measured', recordDigest,
            });
            builder.edge(observationId, 'bd:boundToAsset', assetId);
            builder.edge(observationId, 'bd:derivedFrom', evidenceId);
            builder.edge(observationId, 'bd:observes', vesselModel);
          }
        }
        const sameBinding = supportIds.length === 3 && supportIds.every((evidenceId) => {
          const record = builder.nodes.get(evidenceId)?.properties;
          return record?.assetBindingDigest === assetBinding && record?.modelBindingDigest === modelBinding;
        });
        if (readiness.maturity === 'digital-twin' && sameBinding) {
          const twinId = semanticId('digital-twin', semanticDigest({ assetBinding, modelBinding }).slice(0, 24));
          builder.node(twinId, 'bd:DigitalTwin', `${selectedVessel.name || selectedVessel.id} governed digital twin`, {
            assetBindingDigest: assetBinding, modelBindingDigest: modelBinding,
            promotionBasis: 'calibration-validation-representative-replay',
          });
          builder.edge(twinId, 'bd:representsAsset', assetId);
          builder.edge(twinId, 'bd:specifiedBy', twinModelId);
          for (const evidenceId of supportIds) builder.edge(twinId, 'bd:supportedBy', evidenceId);
          builder.edge(designId, 'bd:selects', twinId);
        }
      }
    }
  }

  // One run/result chain for every returned domain module. This is what makes
  // charging, marine, safety and lifecycle peers under one architecture.
  for (const [key, definition] of Object.entries(MODULE_DEFINITIONS)) {
    const resultKey = (definition.resultKeys || [key])
      .find((candidate) => hasFinishedModuleResult(design[candidate]));
    const value = resultKey ? design[resultKey] : null;
    if (!hasFinishedModuleResult(value)) continue;
    const model = semanticId('model', key);
    const modelVersion = `${design.apiVersion || 'api-unknown'}+ontology-${ONTOLOGY.version}`;
    const solverVersion = definition.runType === 'bd:SimulationRun'
      ? `ecmascript-time-domain@${design.apiVersion || 'unknown'}`
      : `ecmascript-deterministic@${design.apiVersion || 'unknown'}`;
    const inputDigest = semanticDigest({ seed, moduleKey: key });
    const assetScope = resolved.vesselId || appId;
    const runKey = semanticDigest({ inputDigest, model: key, modelVersion, solverVersion, assetScope });
    const resultProperties = moduleResultProperties(value);
    const resultDigest = semanticDigest({
      designKey, moduleKey: key,
      result: portableModuleResultProjection(value),
    });
    const run = semanticId('run', runKey.slice(0, 24));
    const result = semanticId('result', `${runKey.slice(0, 24)}-${resultDigest.slice(0, 24)}`);
    const implementation = softwareModule(builder, definition.module);
    const solver = semanticId('solver', definition.runType === 'bd:SimulationRun'
      ? `js-time-domain-${definition.module}` : 'js-deterministic-functions');
    builder.node(model, ['bd:AssetModel', 'bd:EngineeringModel'], definition.label, {
      key, domain: definition.domain, version: modelVersion,
    });
    builder.node(solver, ['bd:AssetModel', 'bd:Solver'], definition.runType === 'bd:SimulationRun'
      ? `JavaScript time-domain solver (${definition.module})` : 'JavaScript deterministic function runtime', {
      implementation: definition.runType === 'bd:SimulationRun' ? definition.module : 'ECMAScript pure functions',
      transport: 'in-process', version: solverVersion,
    });
    builder.node(run, [definition.runType, 'bd:ModelRun'], `${definition.label} run`, {
      moduleKey: key, sourceResultKey: resultKey, inputDigest, modelVersion, solverVersion, assetScope,
    });
    builder.node(result, 'bd:EngineeringResult', `${definition.label} result`, {
      ...resultProperties, resultDigest,
    });
    builder.edge(designId, 'bd:selects', model);
    builder.edge(model, 'bd:implementedBy', implementation);
    for (const conceptId of definition.capabilities || []) {
      if (!(design.concepts || []).includes(conceptId)) continue;
      const capability = semanticId('capability', conceptId);
      builder.edge(implementation, 'bd:implementsCapability', capability);
    }
    builder.edge(run, 'bd:usesModel', model);
    builder.edge(run, 'bd:usesInput', specificationId);
    builder.edge(run, 'bd:usesSolver', solver);
    builder.edge(run, 'bd:produces', result);
    builder.edge(result, 'bd:generatedBy', run);
  }

  for (const [index, finding] of (design.findings || []).entries()) {
    const key = finding.id || finding.code || semanticDigest({ index, finding });
    const findingId = semanticId('diagnostic', semanticDigest({ designScope, key, index }).slice(0, 24));
    const severity = STATUS_VOCABULARIES.diagnosticSeverity.includes(finding.severity)
      ? finding.severity : 'info';
    builder.node(findingId, 'bd:Diagnostic', finding.title || key, {
      legacyId: finding.id || finding.code || null, severity, category: finding.category || null,
      findingDigest: semanticDigest(finding).slice(0, 24),
    });
    builder.edge(designId, 'bd:hasFinding', findingId);
    builder.edge(findingId, 'bd:evaluates', packId);
    if (finding.ref) {
      const standardId = semanticId('standard', semanticDigest(finding.ref).slice(0, 24));
      builder.node(standardId, ['bd:EvidenceRecord', 'bd:Standard'], finding.ref, { referenceDigest: semanticDigest(finding.ref).slice(0, 24) });
      builder.edge(findingId, 'bd:referencesRule', standardId);
    }
  }

  for (const [index, item] of (design.checklist?.items || design.checklist || []).entries()) {
    if (!item?.code) continue;
    const standardId = semanticId('standard-code', semanticDigest(item.code).slice(0, 24));
    const requirementId = semanticId('requirement', semanticDigest({
      designScope, index, code: item.code, title: item.title || null, scope: item.scope || null,
    }).slice(0, 24));
    builder.node(standardId, ['bd:EvidenceRecord', 'bd:Standard'], item.code, { code: item.code });
    builder.node(requirementId, 'bd:Requirement', item.title || item.code, {
      scope: item.scope || null, requirementDigest: semanticDigest(item).slice(0, 24),
    });
    builder.edge(designId, 'bd:hasRequirement', requirementId);
    builder.edge(requirementId, 'bd:derivedFrom', standardId);
  }

  const f = feasibility(design.findings || []);
  const fNode = semanticId('feasibility', f);
  builder.node(fNode, 'bd:EngineeringFeasibility', f, { value: f });
  builder.edge(designId, 'bd:hasFeasibility', fNode);
  const maturity = cellEvidenceMaturity(design);
  const mNode = semanticId('evidence-maturity', maturity);
  builder.node(mNode, 'bd:EvidenceMaturity', `${maturity} cell evidence`, { value: maturity, scope: 'cell-source' });
  builder.edge(cell, 'bd:hasEvidenceMaturity', mNode);
  if (installationStudyId) {
    const twinMaturity = design.twinShip?.readiness?.maturity || 'screening';
    const scheme = MATURITY_SCHEMES.twinShip;
    const allowed = scheme.levels.some((level) => level.id === twinMaturity) ? twinMaturity : 'screening';
    const twinNode = semanticId('twin-maturity', allowed);
    builder.node(twinNode, 'bd:TwinMaturity', `${allowed} vessel-twin maturity`, {
      value: allowed, scheme: scheme.id,
    });
    builder.edge(installationStudyId, 'bd:hasTwinMaturity', twinNode);
  }

  // Evaluate portable rule data against explicit, unit-bearing facts. A rule
  // can create a traceable review/evidence requirement, but it never mutates a
  // design or silently selects hardware.
  const isolation = design.architecture?.isolation || null;
  const regulatory = design.regulatory || design.eu || null;
  const regulatoryMetadata = Array.isArray(regulatory) ? null : regulatory;
  const ruleFacts = {
    application: { id: appId, class: design.application?.class || null },
    pack: {
      maximumVoltage: { value: pack.vMax ?? null, unit: 'V' },
      seriesCount: { value: pack.s ?? resolved.s ?? null, unit: 'one' },
    },
    architecture: {
      busNature: isolation?.busType === 'ac-dc' ? 'combined' : (isolation?.busType || null),
      electricalReference: isolation?.applies ? 'electrical-chassis' : null,
      isolationContext: isolation?.contextId || null,
      acProtection: isolation?.acProtection || null,
    },
    charging: {
      resultPresent: design.charging != null,
      sourceResolved: design.charging?.t2080 != null,
    },
    evaluation: {
      date: regulatoryMetadata?.evaluationDate ?? design.spec?.evaluationDate ?? null,
    },
    battery: {
      category: regulatoryMetadata?.batteryCategory
        ?? regulatoryMetadata?.category ?? design.spec?.batteryCategory ?? null,
      energyWh: { value: regulatoryMetadata?.energyWh ?? pack.energyWh ?? null, unit: 'Wh' },
    },
  };
  for (const evaluation of evaluateEngineeringRules(ruleFacts)) {
    if (!evaluation.applies && evaluation.missingFactOutcome !== 'review') continue;
    const definition = RULE_DEFINITIONS[evaluation.key];
    const ruleId = engineeringRuleNode(builder, evaluation.key, definition);
    if (evaluation.applies) {
      builder.edge(designId, 'bd:appliesRule', ruleId, {
        complete: evaluation.complete,
        missingFacts: evaluation.missingFacts,
        missingFactOutcome: evaluation.missingFactOutcome,
      });
    }
    if (evaluation.missingFacts.length && evaluation.missingFactOutcome === 'review') {
      const req = semanticId('requirement', `${designScope}-${evaluation.key}-context`);
      builder.node(req, 'bd:Requirement', `${definition.label}: declare missing rule context`, {
        status: 'unresolved', missingFacts: evaluation.missingFacts, ruleId,
      });
      builder.edge(designId, 'bd:requiresEvidence', req);
      builder.edge(req, 'bd:derivedFrom', ruleId);
    }
    if (evaluation.effect?.type === 'require-evidence') {
      const req = semanticId('requirement', `${designScope}-${evaluation.key}-evidence`);
      builder.node(req, 'bd:Requirement', definition.label, {
        status: 'unresolved', target: evaluation.effect.target, ruleId,
        detail: evaluation.effect.message,
      });
      builder.edge(designId, 'bd:requiresEvidence', req);
      builder.edge(req, 'bd:derivedFrom', ruleId);
    }
  }

  return builder.graph();
}

/** Convert an immutable governance record into the same semantic contract. */
export function buildGovernanceSemanticGraph(record = {}) {
  const projectRef = semanticDigest(String(record.projectId || 'unidentified-project')).slice(0, 24);
  const version = typeof record.version === 'string' ? record.version : 'unknown';
  const designChecksum = semanticDigest({
    projectRef,
    version,
    scope: portableScalars(record.scope, ['application', 'domain']),
  });
  const designId = semanticId('design-version', `${projectRef}-${semanticDigest(version).slice(0, 12)}-${designChecksum.slice(0, 24)}`);
  const builder = new Builder(designId);
  builder.node(designId, 'bd:Design', `Governed design version ${version}`, {
    projectRef, version, contentDigest: designChecksum,
  });
  const state = record.state || 'draft';
  const stateId = semanticId('workflow-state', state);
  builder.node(stateId, 'bd:WorkflowState', state, { value: state });
  builder.edge(designId, 'bd:hasWorkflowState', stateId);
  let approvalId = null;
  for (const [index, event] of (record.history || []).entries()) {
    const actorRef = semanticDigest({ projectRef, actorId: event.actorId || `unknown-${index}` }).slice(0, 24);
    const actorId = semanticId('agent', actorRef);
    const eventRef = semanticDigest({
      projectRef, index, action: event.action || null, at: event.at || null,
      fromState: event.fromState || null, toState: event.toState || null,
      fromVersion: event.fromVersion || null, toVersion: event.toVersion || null,
    }).slice(0, 24);
    const activityId = semanticId('governance-activity', eventRef);
    const actorKind = ['human', 'system', 'ai', 'organization'].includes(event.actorKind)
      ? event.actorKind : 'unknown';
    const authorities = [...new Set((event.actorAuthorities || [])
      .filter((authority) => ['review', 'approve', 'release', 'validate'].includes(authority)))].sort();
    builder.node(actorId, 'bd:Agent', `${actorKind} governance actor`, {
      kind: actorKind, authorities, identityWithheld: true,
    });
    const bindsCurrentVersion = (event.toVersion || record.version || null) === (record.version || null);
    if (event.action === 'approved' && bindsCurrentVersion) {
      approvalId = semanticId('approval', eventRef);
      builder.node(approvalId, 'bd:Approval', 'Design approval', {
        action: event.action, at: event.at || null,
        designChecksum, version: event.toVersion || record.version || null,
      });
      builder.edge(approvalId, 'bd:performedBy', actorId);
      builder.edge(approvalId, 'bd:approves', designId, { designChecksum });
      continue;
    }
    if (event.action === 'released' && bindsCurrentVersion) {
      const decisionId = semanticId('release-decision', eventRef);
      builder.node(decisionId, 'bd:ReleaseDecision', 'Design release decision', {
        action: event.action, at: event.at || null,
        designChecksum, version: event.toVersion || record.version || null,
        decision: 'released',
      });
      builder.edge(decisionId, 'bd:performedBy', actorId);
      builder.edge(decisionId, 'bd:releases', designId, { designChecksum });
      builder.edge(designId, 'bd:hasReleaseDecision', decisionId);
      if (approvalId) builder.edge(approvalId, 'bd:authorizes', decisionId, { designChecksum });
      continue;
    }
    builder.node(activityId, 'bd:GovernanceActivity', event.action || 'governance event', {
      action: event.action || null, at: event.at || null,
      fromState: event.fromState || null, toState: event.toState || null,
      fromVersion: event.fromVersion || null, toVersion: event.toVersion || null,
    });
    builder.edge(activityId, 'bd:performedBy', actorId);
    if (event.action === 'validated' && bindsCurrentVersion && event.evidence) {
      const evidenceDigest = semanticDigest({ designChecksum, evidence: String(event.evidence) });
      const evidenceId = semanticId('test-evidence', evidenceDigest.slice(0, 24));
      builder.node(evidenceId, 'bd:TestEvidence', 'Design validation evidence', {
        recordDigest: evidenceDigest, revision: event.toVersion || record.version || null,
        issuedAt: event.at || null, result: 'pass', designChecksum,
      });
      builder.edge(evidenceId, 'bd:verifies', designId, { designChecksum });
    }
  }
  return builder.graph();
}

export function createSemanticIndex(graph) {
  const byId = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const byType = new Map(), outgoing = new Map(), incoming = new Map();
  for (const node of byId.values()) for (const type of inheritedTypes(node)) {
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(node);
  }
  for (const list of byType.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of graph?.edges || []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge); incoming.get(edge.to).push(edge);
  }
  for (const lists of [outgoing, incoming]) for (const list of lists.values()) {
    list.sort((a, b) => a.type.localeCompare(b.type) || a.to.localeCompare(b.to) || a.from.localeCompare(b.from));
  }
  return Object.freeze({
    node(id) { return byId.get(id) || null; },
    nodesByType(type) { return [...(byType.get(type) || [])]; },
    outgoing(id, type = null) { return [...(outgoing.get(id) || [])].filter((edge) => !type || edge.type === type); },
    incoming(id, type = null) { return [...(incoming.get(id) || [])].filter((edge) => !type || edge.type === type); },
    has(id) { return byId.has(id); },
    counts: Object.freeze({ nodes: byId.size, edges: graph?.edges?.length || 0 }),
  });
}

export function querySemanticGraph(graph, query = {}) {
  const index = createSemanticIndex(graph);
  const text = String(query.text || '').trim().toLowerCase();
  let nodes = graph?.nodes || [];
  if (query.type) nodes = index.nodesByType(query.type);
  if (query.id) nodes = nodes.filter((node) => node.id === query.id);
  if (text) nodes = nodes.filter((node) => canonicalJson(node).toLowerCase().includes(text));
  let edges = graph?.edges || [];
  if (query.relation) edges = edges.filter((edge) => edge.type === query.relation);
  if (query.from) edges = edges.filter((edge) => edge.from === query.from);
  if (query.to) edges = edges.filter((edge) => edge.to === query.to);
  return { nodes: [...nodes], edges: [...edges] };
}

export function traceSemanticPath(graph, from, to, { maxDepth = 6 } = {}) {
  const index = createSemanticIndex(graph);
  if (!index.has(from) || !index.has(to)) return null;
  const queue = [{ id: from, path: [] }], seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length >= maxDepth) continue;
    for (const edge of index.outgoing(current.id)) {
      const path = [...current.path, edge];
      if (edge.to === to) return path;
      if (!seen.has(edge.to)) { seen.add(edge.to); queue.push({ id: edge.to, path }); }
    }
  }
  return null;
}

export function semanticGraphSummary(graph) {
  const runs = (graph?.nodes || []).filter((node) => hasType(node, 'bd:ModelRun'));
  const unresolved = (graph?.nodes || []).filter((node) =>
    hasType(node, 'bd:Requirement') && node.properties?.status === 'unresolved');
  const diagnostics = (graph?.nodes || []).filter((node) => hasType(node, 'bd:Diagnostic'));
  const cellEvidence = (graph.nodes || []).find((node) => hasType(node, 'bd:EvidenceMaturity')
    && node.properties?.scope === 'cell-source')?.properties?.value || null;
  const twinMaturity = (graph.nodes || []).find((node) => hasType(node, 'bd:TwinMaturity'))
    ?.properties?.value || null;
  return {
    ontology: { ...graph.ontology, checksum: graph.checksum },
    rootId: graph.rootId,
    conforms: graph.validation?.conforms === true,
    profile: graph.validation?.profile || ONTOLOGY.profile,
    counts: { nodes: graph.nodes?.length || 0, edges: graph.edges?.length || 0, modelRuns: runs.length },
    feasibility: (graph.nodes || []).find((node) => hasType(node, 'bd:EngineeringFeasibility'))?.properties?.value || null,
    // Compatibility name now means cell-source evidence only. It is never a
    // synthetic minimum of cell, shore-source and vessel-twin readiness.
    evidenceMaturity: cellEvidence,
    cellEvidenceMaturity: cellEvidence,
    twinMaturity,
    unresolvedEvidence: unresolved.map((node) => ({ id: node.id, label: node.label })),
    diagnosticCounts: Object.fromEntries(STATUS_VOCABULARIES.diagnosticSeverity.map((severity) =>
      [severity, diagnostics.filter((node) => node.properties?.severity === severity).length])),
    issues: graph.validation?.issues || [],
  };
}

export function toJsonLd(graph) {
  const nodeRecord = (node) => {
    const properties = { ...node.properties };
    if (hasType(node, 'bd:QuantityValue') && properties.unit) {
      properties.unitCode = properties.unit;
      delete properties.unit;
    }
    return { '@id': node.id, '@type': node.types, label: node.label, ...properties };
  };
  const records = new Map((graph.nodes || []).map((node) => [node.id, nodeRecord(node)]));
  for (const edge of graph.edges || []) {
    const subject = records.get(edge.from);
    if (!subject) continue;
    const object = { '@id': edge.to };
    if (subject[edge.type] == null) subject[edge.type] = object;
    else if (Array.isArray(subject[edge.type])) subject[edge.type].push(object);
    else subject[edge.type] = [subject[edge.type], object];
  }
  return {
    '@context': { ...JSON_LD_CONTEXT },
    ontology: { ...graph.ontology, checksum: graph.checksum },
    '@graph': [
      ...records.values(),
      ...(graph.edges || []).map((edge) => ({
        '@id': edge.id, '@type': 'bd:Relation', from: edge.from,
        predicate: edge.type, to: edge.to, ...(edge.properties || {}),
      })),
    ],
  };
}

const neoType = (value) => String(value).replace(/^bd:/, '').replace(/([a-z])([A-Z])/g, '$1_$2')
  .replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

/** Parameterized, offline Neo4j projection. No credentials or live driver. */
export function toNeo4jProjection(graph) {
  const checksum = semanticDigest({ nodes: graph?.nodes || [], edges: graph?.edges || [] });
  if (!graph?.checksum || checksum !== graph.checksum) {
    throw new Error('Refusing Neo4j projection: semantic graph checksum mismatch.');
  }
  const validation = validateSemanticGraph(graph);
  if (!validation.conforms) throw new Error('Refusing Neo4j projection: semantic graph does not conform.');
  const parameters = {
    nodes: graph.nodes.map((node) => ({
      id: node.id, label: node.label, types: node.types,
      primaryType: node.types[0], properties: canonicalJson(node.properties),
      ontologyVersion: graph.ontology.version,
    })),
  };
  const statements = [
    'CREATE CONSTRAINT semantic_entity_id IF NOT EXISTS FOR (n:SemanticEntity) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT semantic_graph_checksum IF NOT EXISTS FOR (g:SemanticGraph) REQUIRE g.checksum IS UNIQUE',
    'CREATE INDEX semantic_entity_type IF NOT EXISTS FOR (n:SemanticEntity) ON (n.primaryType)',
    'MERGE (g:SemanticGraph {checksum: $graphChecksum}) SET g.rootId = $graphRootId, g.ontologyVersion = $ontologyVersion',
    'UNWIND $nodes AS row MERGE (n:SemanticEntity {id: row.id}) SET n.label = row.label, n.types = row.types, n.primaryType = row.primaryType, n.propertiesJson = row.properties, n.ontologyVersion = row.ontologyVersion',
    'UNWIND $nodes AS row MATCH (g:SemanticGraph {checksum: $graphChecksum}), (n:SemanticEntity {id: row.id}) MERGE (g)-[:CONTAINS {id: $graphChecksum + ":" + row.id}]->(n)',
  ];
  const groups = new Map();
  for (const edge of graph.edges) {
    if (!groups.has(edge.type)) groups.set(edge.type, []);
    groups.get(edge.type).push({
      id: edge.id, from: edge.from, to: edge.to,
      properties: canonicalJson(edge.properties || {}),
    });
  }
  for (const [type, edges] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = `edges_${neoType(type).toLowerCase()}`;
    parameters[key] = edges;
    statements.push(`UNWIND $${key} AS row MATCH (a:SemanticEntity {id: row.from}), (b:SemanticEntity {id: row.to}) MERGE (a)-[r:${neoType(type)} {id: row.id}]->(b) SET r.propertiesJson = row.properties, r.ontologyVersion = $ontologyVersion`);
  }
  parameters.ontologyVersion = graph.ontology.version;
  parameters.graphChecksum = graph.checksum;
  parameters.graphRootId = graph.rootId;
  return {
    format: 'battery-design/neo4j-projection@1',
    ontology: { ...graph.ontology }, checksum: graph.checksum,
    statements, parameters,
    manifest: { nodeCount: graph.nodes.length, relationshipCount: graph.edges.length, relationshipTypes: [...groups.keys()].sort() },
  };
}

export function describeOntology() {
  return ontologyCatalog();
}

export { evaluateRuleApplicability, ruleDefinition };
