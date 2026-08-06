import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  API_VERSION,
  designFromSpec,
  describeOntology,
} from '../js/api.js';
import {
  buildArchitectureSemanticGraph,
  buildDesignSemanticGraph,
  buildGovernanceSemanticGraph,
  canonicalJson,
  createSemanticIndex,
  maturityFromChecks,
  querySemanticGraph,
  semanticDigest,
  semanticGraphSummary,
  semanticId,
  toJsonLd,
  toNeo4jProjection,
  traceSemanticPath,
  validateSemanticGraph,
} from '../js/ontology.js';
import {
  ARCHITECTURE_MODULE_DEFINITIONS, CONCEPT_APPLICABILITY, CONCEPT_DEFINITIONS,
  JSON_LD_CONTEXT, MATURITY_SCHEMES, ONTOLOGY, PRODUCT_SURFACES,
  RULE_DEFINITIONS, SHAPE_DEFINITIONS, STATUS_VOCABULARIES,
} from '../js/ontology-schema.js';
import {
  evaluateEngineeringRule, evaluateRuleApplicability, validateEngineeringRule,
} from '../js/ontology-rules.js';
import { needed } from '../js/knowledge.js';
import {
  createDesignRecord, recordMaterialChange, scopeForApplication, transitionDesign,
} from '../js/governance.js';
import { buildReportHTML } from '../js/report.js';
import { replayDatasetSha256 } from '../js/marine-workspace.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

test('the ontology catalog is architecture-wide and versioned', () => {
  const catalog = describeOntology();
  assert.equal(catalog.ontology.version, '1.0.0');
  assert.ok(catalog.classes.some((row) => row.id === 'bd:PackDesign'));
  assert.ok(catalog.classes.some((row) => row.id === 'bd:ChargingSource'));
  assert.ok(catalog.classes.some((row) => row.id === 'bd:VentPlacement'));
  assert.ok(catalog.classes.some((row) => row.id === 'bd:HILRun'));
  assert.ok(catalog.classes.some((row) => row.id === 'bd:Approval'));
  assert.ok(catalog.modules.length >= 19, 'every major calculation family is registered');
});

test('status meanings remain separate vocabularies', () => {
  assert.ok(STATUS_VOCABULARIES.diagnosticSeverity.includes('warn'));
  assert.ok(!STATUS_VOCABULARIES.workflowState.includes('warn'));
  assert.ok(STATUS_VOCABULARIES.workflowState.includes('released'));
  assert.ok(!STATUS_VOCABULARIES.engineeringFeasibility.includes('released'));
  assert.ok(STATUS_VOCABULARIES.evidenceMaturity.includes('supplier'));
});

test('the complete architecture graph is separate, conforming and queryable', () => {
  const graph = buildArchitectureSemanticGraph();
  const index = createSemanticIndex(graph);
  assert.equal(graph.validation.conforms, true);
  assert.ok(index.nodesByType('bd:DomainModule').length >= 20);
  assert.equal(index.nodesByType('bd:ProductSurface').length, 6);
  assert.ok(index.nodesByType('bd:EngineeringRule').length >= 3);
  const implemented = new Set(Object.values(ARCHITECTURE_MODULE_DEFINITIONS)
    .flatMap((module) => module.capabilities));
  assert.deepEqual([...new Set(Object.keys(CONCEPT_DEFINITIONS).filter((key) => !implemented.has(key)))], []);
  const hil = semanticId('architecture-module', 'hil');
  const cosim = semanticId('capability', 'cosim');
  assert.ok(index.outgoing(hil, 'bd:implementsCapability').some((edge) => edge.to === cosim));
  assert.ok(index.outgoing(cosim, 'bd:availableOn').some((edge) =>
    edge.to === semanticId('product-surface', 'desktop-target')));
  assert.equal(Object.keys(PRODUCT_SURFACES).length, 6);
});

test('implemented shape declarations match the checks the portable validator actually runs', () => {
  const implemented = new Set(SHAPE_DEFINITIONS.filter((shape) => shape.implemented).map((shape) => shape.id));
  for (const id of ['bd:QuantityValueShape', 'bd:ModelRunShape', 'bd:ProvenancedClaimShape',
    'bd:EvidenceRecordShape', 'bd:ReleaseShape', 'bd:TwinReadinessShape', 'bd:HILRunShape']) {
    assert.ok(implemented.has(id), id);
  }
  const graph = designFromSpec({ application: 'ev' }).semantics.graph;
  for (const shape of graph.validation.checkedShapes.filter((id) => id.endsWith('Shape')
    && !['bd:GraphShape', 'bd:NodeShape', 'bd:EdgeShape'].includes(id))) {
    assert.ok(implemented.has(shape), `${shape} is not falsely reported as checked`);
  }
});

test('evidence-record shape refuses impossible calendar instants and timezone offsets', () => {
  const base = designFromSpec({ application: 'marine' }).semantics.graph;
  const evidenceNode = {
    id: 'https://morshedvarzandeh.github.io/battery-design/resource/test-evidence/date-check',
    types: ['bd:TestEvidence'], label: 'Date validation evidence',
    properties: { revision: 'rev-1', issuedAt: '2026-02-30T12:00:00Z' },
  };
  const impossibleDate = validateSemanticGraph({
    ...base, nodes: [...base.nodes, evidenceNode], edges: [...base.edges],
  });
  assert.ok(impossibleDate.issues.some((issue) =>
    issue.code === 'EVIDENCE_DATE' && issue.focusNode === evidenceNode.id));

  const invalidOffsetId = `${evidenceNode.id}-offset`;
  const invalidOffset = validateSemanticGraph({
    ...base,
    nodes: [...base.nodes, {
      ...evidenceNode,
      id: invalidOffsetId,
      properties: { ...evidenceNode.properties, issuedAt: '2026-02-28T12:00:00+14:30' },
    }],
    edges: [...base.edges],
  });
  assert.ok(invalidOffset.issues.some((issue) =>
    issue.code === 'EVIDENCE_DATE' && issue.focusNode === invalidOffsetId));
});

test('the central TwinShip maturity registry keeps replay identity and mode coverage mandatory', () => {
  const digital = MATURITY_SCHEMES.twinShip.levels.find((level) => level.id === 'digital-twin');
  assert.ok(digital.requires.includes('replay-content-address'));
  assert.ok(digital.requires.includes('replay-mode-coverage'));
  const allChecks = Object.fromEntries(MATURITY_SCHEMES.twinShip.levels
    .flatMap((level) => level.requires).map((id) => [id, true]));
  delete allChecks['replay-mode-coverage'];
  assert.notEqual(maturityFromChecks('twinShip', allChecks).id, 'digital-twin');
  allChecks['replay-mode-coverage'] = true;
  assert.equal(maturityFromChecks('twinShip', allChecks).id, 'digital-twin');
});

test('ontology rules are portable data, not executable schema callbacks', () => {
  const catalog = describeOntology();
  assert.ok(catalog.ruleGrammar.operators.includes('gte'));
  assert.ok(catalog.rules.length >= 3);
  const serialized = JSON.stringify(catalog.rules);
  assert.doesNotMatch(serialized, /\bfunction\b|=>|eval\s*\(/);
  for (const rule of Object.values(RULE_DEFINITIONS)) {
    assert.deepEqual(validateEngineeringRule(rule), []);
  }
});

test('rule evaluation fails closed on missing context and rejects unsafe grammar', () => {
  const facts = {
    application: { class: 'vehicle' },
    pack: { maximumVoltage: { value: 400, unit: 'V' } },
    architecture: {},
  };
  const incomplete = evaluateRuleApplicability('un-r100-isolation', facts);
  assert.equal(incomplete.applies, true);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missingFacts, ['architecture.electricalReference', 'architecture.isolationContext']);
  const wrongUnit = evaluateRuleApplicability('un-r100-isolation', {
    ...facts, pack: { maximumVoltage: { value: 400, unit: 'A' } },
  });
  assert.equal(wrongUnit.applies, false);
  assert.ok(wrongUnit.missingFacts.includes('pack.maximumVoltage'));
  const unsafe = clone(RULE_DEFINITIONS['marine-shore-source-evidence']);
  unsafe.when[0].fact = '__proto__.polluted';
  assert.ok(validateEngineeringRule(unsafe).some((problem) => /unsafe fact path/i.test(problem)));
  assert.throws(() => evaluateEngineeringRule(unsafe, {}), /unsafe fact path/i);

  const nestedUnsafe = clone(RULE_DEFINITIONS['eu-battery-passport']);
  nestedUnsafe.criteria[1].when.conditions[1].fact = 'battery.constructor.energyWh';
  assert.ok(validateEngineeringRule(nestedUnsafe).some((problem) => /invalid when condition/i.test(problem)));
});

test('calendar and controlled-category facts fail closed instead of becoming non-applicable', () => {
  for (const date of ['not-a-date', '2027-02-30', '2027-13-01']) {
    const result = evaluateRuleApplicability('eu-battery-passport', {
      evaluation: { date }, battery: { category: 'ev' },
    });
    assert.equal(result.complete, false, date);
    assert.equal(result.applies, false, date);
    assert.equal(result.missingFactOutcome, 'review', date);
    assert.ok(result.conditionResults.some((row) => row.status === 'invalid-fact'), date);
  }
  const typo = evaluateRuleApplicability('eu-battery-passport', {
    evaluation: { date: '2027-02-18' }, battery: { category: 'industral', energyWh: { value: 9000, unit: 'Wh' } },
  });
  assert.equal(typo.complete, false);
  assert.equal(typo.missingFactOutcome, 'review');
  assert.deepEqual(typo.missingFacts, ['battery.category']);
});

test('EU passport criteria preserve date, category and energy boundaries without mandating UDS', () => {
  const base = { evaluation: { date: '2027-02-18' } };
  for (const category of ['ev', 'lmt']) {
    const result = evaluateRuleApplicability('eu-battery-passport', {
      ...base, battery: { category, energyWh: { value: 1, unit: 'Wh' } },
    });
    assert.equal(result.complete, true, category);
    assert.equal(result.criteria[0].kind, 'battery-passport-obligation', category);
    assert.ok(result.criteria[0].requirements.includes('accessible-current-state-of-health-data'));
    assert.ok(!result.criteria[0].requirements.some((item) => /uds/i.test(item)));
  }
  const industrial = evaluateRuleApplicability('eu-battery-passport', {
    ...base, battery: { category: 'industrial', energyWh: { value: 2001, unit: 'Wh' } },
  });
  assert.equal(industrial.criteria.length, 1);
  const smallIndustrial = evaluateRuleApplicability('eu-battery-passport', {
    ...base, battery: { category: 'industrial', energyWh: { value: 2000, unit: 'Wh' } },
  });
  assert.equal(smallIndustrial.criteria.length, 0);
  assert.equal(smallIndustrial.complete, true);
  assert.equal(smallIndustrial.unmatchedCriteriaOutcome, 'not-applicable');
});

test('UN R100 ontology criteria resolve the four declared topology contexts', () => {
  const base = {
    application: { class: 'vehicle' },
    pack: { maximumVoltage: { value: 400, unit: 'V' } },
    architecture: { electricalReference: 'electrical-chassis' },
  };
  const cases = [
    ['un-r100-separate-dc', 100, null],
    ['un-r100-separate-ac', 500, null],
    ['un-r100-connected-ac-dc', 500, null],
    ['un-r100-connected-ac-dc-protected', 100, 'double-or-more-solid-insulation'],
  ];
  for (const [isolationContext, expected, acProtection] of cases) {
    const result = evaluateRuleApplicability('un-r100-isolation', {
      ...base,
      architecture: { ...base.architecture, isolationContext, acProtection },
    });
    assert.equal(result.complete, true, isolationContext);
    assert.equal(result.criteria.length, 1, isolationContext);
    assert.equal(result.criteria[0].coefficient.numericValue, expected, isolationContext);
  }
  const unprovenException = evaluateRuleApplicability('un-r100-isolation', {
    ...base,
    architecture: {
      ...base.architecture,
      isolationContext: 'un-r100-connected-ac-dc-protected',
    },
  });
  assert.equal(unprovenException.complete, false);
  assert.deepEqual(unprovenException.missingFacts, ['architecture.acProtection']);
  assert.equal(unprovenException.unmatchedCriteriaOutcome, null);
});

test('the checked-in JSON-LD context exactly matches the runtime context', () => {
  const file = JSON.parse(readFileSync(new URL('../ontology/context.v1.jsonld', import.meta.url), 'utf8'));
  assert.deepEqual(file['@context'], JSON_LD_CONTEXT);
});

test('one finished design carries a conforming semantic graph', () => {
  const design = designFromSpec({ application: 'ev', energyWh: 60000 });
  assert.equal(API_VERSION, '1.3');
  assert.equal(design.semantics.ontology.version, ONTOLOGY.version);
  assert.equal(design.semantics.conforms, true);
  assert.ok(design.semantics.counts.nodes > 100);
  assert.ok(design.semantics.counts.modelRuns >= 15);
  assert.deepEqual(design.semantics.issues, []);
});

test('system, pack and cell hierarchy is explicit', () => {
  const graph = designFromSpec({ application: 'ev' }).semantics.graph;
  const index = createSemanticIndex(graph);
  const design = index.node(graph.rootId);
  assert.ok(design.types.includes('bd:Design'));
  const specificationEdge = index.outgoing(graph.rootId, 'bd:hasSpecification')[0];
  assert.ok(specificationEdge, 'design links to a distinct resolved specification');
  const packEdge = index.outgoing(specificationEdge.to, 'bd:specifiesSystem')
    .find((edge) => index.node(edge.to)?.types.includes('bd:PackDesign'));
  assert.ok(packEdge, 'the specification defines a proposed pack system');
  const cellEdge = index.outgoing(packEdge.to, 'bd:specifiedBy')
    .find((edge) => index.node(edge.to)?.types.includes('bd:CellSpecification'));
  assert.ok(cellEdge, 'pack resolves its cell specification');
});

test('all engineering domains are peer model runs, not children of charging', () => {
  const graph = designFromSpec({ application: 'marine' }).semantics.graph;
  const models = querySemanticGraph(graph, { type: 'bd:EngineeringModel' }).nodes;
  const keys = new Set(models.map((node) => node.properties.key));
  for (const key of ['pack', 'architecture', 'thermal', 'charging', 'marine', 'twinShip',
    'simulation', 'shortCircuit', 'electricalProtection', 'cost', 'co2', 'checklist']) {
    assert.ok(keys.has(key), `registered model run: ${key}`);
  }
  const charging = models.find((node) => node.properties.key === 'charging');
  assert.notEqual(graph.rootId, charging.id, 'charging is not the graph root');
});

test('marine specifications expose both complete NTNU host choices while one study targets one model', () => {
  for (const selected of ['ntnu-gunnerus', 'ntnu-milliampere1']) {
    const graph = designFromSpec({ application: 'marine', marine: { vesselId: selected } }).semantics.graph;
    const index = createSemanticIndex(graph);
    const vessels = index.nodesByType('bd:VesselModel');
    const massing = index.nodesByType('bd:EngineeringMassingModel');
    const studies = index.nodesByType('bd:InstallationStudy');
    assert.equal(vessels.length, 2, selected);
    assert.equal(massing.length, 2, selected);
    assert.equal(studies.length, 1, selected);
    assert.equal(index.outgoing(studies[0].id, 'bd:targetsAssetModel').length, 1, selected);
    assert.equal(index.outgoing(studies[0].id, 'bd:targetsAssetModel')[0].to,
      semanticId('vessel-model', selected), selected);
    for (const vessel of vessels) {
      assert.equal(index.outgoing(vessel.id, 'bd:hasRepresentation').length, 1, vessel.id);
    }
    assert.equal(index.outgoing(studies[0].id, 'bd:installedIn').length, 0,
      'a study never claims an as-built installation');
  }
  const road = designFromSpec({ application: 'ev' }).semantics.graph;
  assert.equal(querySemanticGraph(road, { type: 'bd:VesselModel' }).nodes.length, 0);
});

test('marine shore evidence stays unresolved without inventing a road connector', () => {
  const design = designFromSpec({ application: 'marine' });
  assert.equal(design.charging.t2080, null);
  assert.doesNotMatch(design.charging.iface.connector, /type 2|ccs/i);
  assert.match(design.charging.iface.dcConnector, /no automotive ccs assumption/i);
  assert.ok(design.semantics.unresolvedEvidence.some((row) => /marine shore source/i.test(row.label)));
  const requirements = querySemanticGraph(design.semantics.graph, { type: 'bd:Requirement' }).nodes;
  assert.ok(requirements.some((node) => node.properties.status === 'unresolved'));
});

test('road designs do not inherit the marine shore requirement', () => {
  const design = designFromSpec({ application: 'ev' });
  assert.ok(!design.semantics.unresolvedEvidence.some((row) => /marine shore/i.test(row.label)));
  assert.ok(design.charging.t2080 != null, 'the existing road charging screen remains available');
});

test('every application produces a conforming, namespaced graph', () => {
  const apps = describeOntology();
  assert.ok(apps.ontology.id.startsWith('https://'));
  for (const appId of ['ev', 'ebus', 'marine', 'solar-ess', 'wearable', 'drone', 'robot']) {
    const graph = designFromSpec({ application: appId }).semantics.graph;
    assert.equal(graph.validation.conforms, true, appId);
    assert.ok(graph.nodes.every((node) => node.id.startsWith('https://morshedvarzandeh.github.io/battery-design/resource/')), appId);
  }
});

test('semantic output is deterministic for the same resolved design', () => {
  const a = designFromSpec({ application: 'marine', marine: { vesselId: 'ntnu-gunnerus' } }).semantics.graph;
  const b = designFromSpec({ marine: { vesselId: 'ntnu-gunnerus' }, application: 'marine' }).semantics.graph;
  assert.equal(a.checksum, b.checksum);
  assert.equal(canonicalJson(a.nodes), canonicalJson(b.nodes));
  assert.equal(canonicalJson(a.edges), canonicalJson(b.edges));
});

test('semantic digest ignores object key order but not values', () => {
  assert.equal(semanticDigest({ a: 1, b: 2 }), semanticDigest({ b: 2, a: 1 }));
  assert.notEqual(semanticDigest({ a: 1, b: 2 }), semanticDigest({ a: 1, b: 3 }));
});

test('indexes query by type and relation without scanning UI state', () => {
  const graph = designFromSpec({ application: 'ev' }).semantics.graph;
  const index = createSemanticIndex(graph);
  assert.equal(index.counts.nodes, graph.nodes.length);
  assert.ok(index.nodesByType('bd:ModelRun').length >= 15);
  assert.ok(index.outgoing(graph.rootId, 'bd:selects').length > 1);
  const specification = index.outgoing(graph.rootId, 'bd:hasSpecification')[0].to;
  assert.ok(index.incoming(specification, 'bd:usesInput').length >= 10);
  assert.ok(index.nodesByType('bd:Entity').length > index.nodesByType('bd:ModelRun').length,
    'superclass queries include inherited types');
});

test('capability ownership produces explainable semantic paths', () => {
  const graph = designFromSpec({ application: 'marine' }).semantics.graph;
  const model = querySemanticGraph(graph, { type: 'bd:EngineeringModel', text: 'marine voyage duty' }).nodes[0];
  const capability = semanticId('capability', 'hull-resistance');
  const path = traceSemanticPath(graph, model.id, capability);
  assert.equal(path.length, 2);
  assert.deepEqual(path.map((edge) => edge.type), ['bd:implementedBy', 'bd:implementsCapability']);
  const app = semanticId('application', 'marine');
  assert.ok(createSemanticIndex(graph).outgoing(app, 'bd:requiresCapability').some((edge) => edge.to === capability));
});

test('unknown concepts fail closed instead of becoming universal', () => {
  assert.throws(() => needed('ev', 'not-a-real-concept'), /unknown design concept/i);
  assert.throws(() => needed(null, 'not-a-real-concept'), /unknown design concept/i);
});

test('the canonical payload concept covers applicable hosts without a passenger synonym', () => {
  for (const app of ['ebus', 'marine', 'drone', 'robot']) assert.equal(needed(app, 'payload'), true, app);
  for (const app of ['ev', 'wearable']) assert.equal(needed(app, 'payload'), false, app);
  assert.throws(() => needed('ebus', 'passenger-load'), /unknown design concept/i);
});

test('duplicate semantic identities are rejected', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  graph.nodes.push(clone(graph.nodes[0]));
  const validation = validateSemanticGraph(graph);
  assert.equal(validation.conforms, false);
  assert.ok(validation.issues.some((row) => row.code === 'DUPLICATE_NODE'));
});

test('dangling relation endpoints are rejected', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  graph.edges[0].to = semanticId('missing', 'target');
  const validation = validateSemanticGraph(graph);
  assert.equal(validation.conforms, false);
  assert.ok(validation.issues.some((row) => row.code === 'DANGLING_TO'));
});

test('unknown predicates are rejected', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  graph.edges[0].type = 'bd:maybeMeansSomething';
  const validation = validateSemanticGraph(graph);
  assert.ok(validation.issues.some((row) => row.code === 'UNKNOWN_RELATION'));
});

test('declared relationship domains and ranges are enforced', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  const edge = graph.edges.find((row) => row.type === 'bd:usesModel');
  edge.from = graph.nodes.find((node) => node.types.includes('bd:CellSpecification')).id;
  const validation = validateSemanticGraph(graph);
  assert.ok(validation.issues.some((row) => row.code === 'RELATION_DOMAIN' && row.focusNode === edge.id));
});

test('quantity unit and dimension errors are rejected', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  const quantity = graph.nodes.find((node) => node.types.includes('bd:QuantityValue'));
  quantity.properties.unit = 'not-a-unit';
  let validation = validateSemanticGraph(graph);
  assert.ok(validation.issues.some((row) => row.code === 'QUANTITY_UNIT'));
  quantity.properties.unit = 'V';
  quantity.properties.quantityKind = 'mass';
  validation = validateSemanticGraph(graph);
  assert.ok(validation.issues.some((row) => row.code === 'UNIT_DIMENSION'));
});

test('orphan model runs are rejected', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  const run = graph.nodes.find((node) => node.types.includes('bd:ModelRun'));
  graph.edges = graph.edges.filter((edge) => !(edge.from === run.id && edge.type === 'bd:produces'));
  const validation = validateSemanticGraph(graph);
  assert.ok(validation.issues.some((row) => row.code === 'RUN_LINEAGE' && row.focusNode === run.id));
});

test('every engineering run records model, input, solver and output lineage', () => {
  const graph = designFromSpec({ application: 'marine' }).semantics.graph;
  const index = createSemanticIndex(graph);
  for (const run of index.nodesByType('bd:ModelRun')) {
    for (const relation of ['bd:usesModel', 'bd:usesInput', 'bd:usesSolver', 'bd:produces']) {
      assert.ok(index.outgoing(run.id, relation).length >= 1, `${run.label}: ${relation}`);
    }
  }
});

test('module catalog presence does not fabricate execution lineage', () => {
  const finished = buildDesignSemanticGraph({
    apiVersion: 'test',
    spec: { resolved: { application: 'custom', cell: 'test-cell', s: 1, p: 1 } },
    application: { id: 'custom', name: 'Custom', class: 'portable' },
    cell: { id: 'test-cell', name: 'Test cell', dataBasis: 'assumed' },
    pack: { s: 1, p: 1, cellCount: 1, nominalV: 3.7, energyWh: 10, massKg: 0.1 },
    charging: {},
    thermal: { status: 'review', temperatureC: 25 },
  });
  const models = new Set(querySemanticGraph(finished, { type: 'bd:EngineeringModel' }).nodes
    .map((node) => node.properties.key).filter(Boolean));
  assert.ok(models.has('pack'));
  assert.ok(models.has('thermal'));
  assert.ok(!models.has('charging'));
  assert.equal(createSemanticIndex(finished).nodesByType('bd:ModelRun').length, 2);
});

test('portable result digests bind numeric engineering outputs without copying raw evidence', () => {
  const base = {
    apiVersion: 'test',
    spec: { resolved: { application: 'custom', cell: 'test-cell', s: 1, p: 1 } },
    application: { id: 'custom', name: 'Custom', class: 'portable' },
    cell: { id: 'test-cell', name: 'Test cell', dataBasis: 'assumed' },
    pack: { s: 1, p: 1, cellCount: 1, nominalV: 3.7, energyWh: 10, massKg: 0.1 },
  };
  const a = buildDesignSemanticGraph({ ...base, thermal: { status: 'pass', temperatureC: 25 } });
  const b = buildDesignSemanticGraph({ ...base, thermal: { status: 'pass', temperatureC: 999 } });
  assert.equal(a.rootId, b.rootId, 'result changes do not rewrite the input/design identity');
  assert.notEqual(a.checksum, b.checksum, 'the content-addressed graph snapshot changes');
  const result = querySemanticGraph(a, { type: 'bd:EngineeringResult' }).nodes[0];
  assert.match(result.properties.resultDigest, /^[a-f0-9]{64}$/);

  const privateA = buildDesignSemanticGraph({
    ...base, thermal: { status: 'pass', temperatureC: 25, evidence: { secret: 'private-a' } },
  });
  const privateB = buildDesignSemanticGraph({
    ...base, thermal: { status: 'pass', temperatureC: 25, evidence: { secret: 'private-b' } },
  });
  assert.equal(privateA.checksum, privateB.checksum);
  assert.doesNotMatch(JSON.stringify(privateA), /private-a/);
});

test('materially different mission inputs mint different design identities', () => {
  const a = designFromSpec({ application: 'ev', mission: { passes: 1, startSoC: 0.9 } });
  const b = designFromSpec({ application: 'ev', mission: { passes: 2, startSoC: 0.9 } });
  assert.notEqual(a.semantics.rootId, b.semantics.rootId);
  assert.notEqual(a.semantics.ontology.checksum, b.semantics.ontology.checksum);
});

test('custom trace content participates in design and load-profile identity', () => {
  const base = {
    application: 'marine', vesselId: 'ntnu-milliampere1',
    profileTrace: { id: 'customer-duty', name: 'Customer duty', dtS: 60, scaleW: 4000 },
  };
  const forward = designFromSpec({ ...base, profileTrace: { ...base.profileTrace, p: [1, -1, 0] } });
  const reverse = designFromSpec({ ...base, profileTrace: { ...base.profileTrace, p: [-1, 1, 0] } });
  assert.equal(forward.pack.energyWh, reverse.pack.energyWh, 'the regression isolates trace content, not pack size');
  assert.notEqual(forward.semantics.rootId, reverse.semantics.rootId);
  assert.notEqual(forward.semantics.ontology.checksum, reverse.semantics.ontology.checksum);
  for (const design of [forward, reverse]) {
    const profile = design.semantics.graph.nodes.find((node) => node.types.includes('bd:LoadProfile'));
    assert.equal(profile.properties.traceChecksum, design.spec.resolved.sizing.traceIdentity.checksum);
    assert.equal(profile.properties.scaleW, 4000);
  }
});

test('all release-critical resolved inputs change semantic identity', () => {
  const pairs = [
    [{ application: 'ev', driveMode: 'eco' }, { application: 'ev', driveMode: 'sport' }],
    [{ application: 'ev', dod: 0.6 }, { application: 'ev', dod: 0.9 }],
    [{ application: 'marine', marine: { durationH: 1 } }, { application: 'marine', marine: { durationH: 2 } }],
    [{ application: 'marine', marine: { seaState: 'calm' } }, { application: 'marine', marine: { seaState: 'rough' } }],
    [{ application: 'ev', arrangement: 'grid' }, { application: 'ev', arrangement: 'honeycomb' }],
  ];
  for (const [left, right] of pairs) {
    const a = designFromSpec(left).semantics;
    const b = designFromSpec(right).semantics;
    assert.notEqual(a.rootId, b.rootId);
    assert.notEqual(a.ontology.checksum, b.ontology.checksum);
  }
});

test('JSON-LD carries the same graph identity and compact semantic types', () => {
  const graph = designFromSpec({ application: 'ev' }).semantics.graph;
  const jsonld = toJsonLd(graph);
  assert.equal(jsonld.ontology.checksum, graph.checksum);
  assert.equal(jsonld['@graph'].length, graph.nodes.length + graph.edges.length);
  assert.ok(jsonld['@context'].prov && jsonld['@context'].qudt && jsonld['@context'].sosa);
  assert.ok(jsonld['@graph'].some((row) => row['@type']?.includes?.('bd:PackDesign')));
  const quantity = jsonld['@graph'].find((row) => row['@type']?.includes?.('bd:QuantityValue'));
  assert.ok(quantity.unitCode && quantity.unit === undefined);
  const relation = jsonld['@graph'].find((row) => row['@type'] === 'bd:Relation');
  assert.ok(relation.from && relation.to && relation.predicate);
  const root = jsonld['@graph'].find((row) => row['@id'] === graph.rootId);
  assert.ok(root['bd:hasSpecification']?.['@id'], 'actual RDF predicate is emitted on the subject');
});

test('Neo4j export is parameterized, deterministic and preserves IRIs', () => {
  const graph = designFromSpec({ application: 'marine' }).semantics.graph;
  const a = toNeo4jProjection(graph), b = toNeo4jProjection(graph);
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(a.manifest.nodeCount, graph.nodes.length);
  assert.equal(a.manifest.relationshipCount, graph.edges.length);
  assert.ok(a.statements.every((statement) => !statement.includes(graph.rootId)), 'IRIs are parameters, not interpolated Cypher');
  assert.ok(a.parameters.nodes.some((node) => node.id === graph.rootId));
  assert.ok(a.statements.some((statement) => /CREATE CONSTRAINT/.test(statement)));
});

test('Neo4j export revalidates and refuses a tampered graph', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  graph.nodes.push({ id: semanticId('tampered', 'node'), types: ['bd:Invented'], label: 'Tampered', properties: {} });
  assert.throws(() => toNeo4jProjection(graph), /checksum mismatch/i);
});

test('finished semantic graphs are deeply immutable', () => {
  const graph = designFromSpec({ application: 'wearable' }).semantics.graph;
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(graph.nodes), true);
  assert.equal(Object.isFrozen(graph.nodes[0]), true);
  assert.equal(Object.isFrozen(graph.nodes[0].properties), true);
  assert.throws(() => graph.nodes.push({}), /not extensible|read only|object is not extensible/i);
});

test('private TwinShip evidence and raw replay never enter the portable graph', () => {
  const secretAsset = 'private-physical-asset-774';
  const design = designFromSpec({
    application: 'marine',
    marine: {
      vesselId: 'ntnu-gunnerus',
      twinEvidence: { assetEvidence: { assetId: secretAsset } },
      replaySamples: [{ tS: 0, actualPowerW: 1, predictedPowerW: 1 }],
    },
  });
  const portable = JSON.stringify(design.semantics.graph);
  assert.ok(!portable.includes(secretAsset));
  assert.ok(!portable.includes('replaySamples'));
  assert.ok(!portable.includes('actualPowerW'));
  const other = designFromSpec({
    application: 'marine',
    marine: {
      vesselId: 'ntnu-gunnerus',
      twinEvidence: { assetEvidence: { assetId: 'different-private-asset' } },
      replaySamples: [{ tS: 9, actualPowerW: 999, predictedPowerW: 1 }],
    },
  });
  assert.equal(design.semantics.rootId, other.semantics.rootId,
    'private evidence never changes the engineering design identity');
});

test('cell-source evidence and vessel-twin maturity remain independent status axes', () => {
  const design = designFromSpec({ application: 'marine' });
  assert.equal(design.semantics.evidenceMaturity, design.semantics.cellEvidenceMaturity);
  assert.equal(design.semantics.twinMaturity, design.twinShip.readiness.maturity);
  const graph = design.semantics.graph;
  const evidenceNodes = querySemanticGraph(graph, { type: 'bd:EvidenceMaturity' }).nodes;
  const twinNodes = querySemanticGraph(graph, { type: 'bd:TwinMaturity' }).nodes;
  assert.equal(evidenceNodes.length, 1);
  assert.equal(evidenceNodes[0].properties.scope, 'cell-source');
  assert.equal(twinNodes.length, 1);
  assert.ok(querySemanticGraph(graph, { relation: 'bd:hasEvidenceMaturity' }).edges
    .every((edge) => querySemanticGraph(graph, { type: 'bd:CellSpecification' }).nodes
      .some((cell) => cell.id === edge.from)));
});

test('a maturity label alone cannot create a digital twin', () => {
  const design = designFromSpec({ application: 'marine' });
  const graph = buildDesignSemanticGraph({
    ...design,
    semantics: undefined,
    twinShip: {
      ...design.twinShip,
      readiness: {
        ...design.twinShip.readiness,
        maturity: 'digital-twin',
        evidenceAccepted: { asset: true, model: true, calibration: true, validation: true, replay: true },
        evidenceBindings: {},
      },
    },
  });
  assert.equal(querySemanticGraph(graph, { type: 'bd:DigitalTwin' }).nodes.length, 0);
});

test('governed vessel-bound evidence creates one conforming digital-twin instance', () => {
  const samples = Array.from({ length: 12 }, (_, index) => ({
    tS: index * 10,
    actualSpeedKn: 5, predictedSpeedKn: 5,
    actualCourseDeg: 20, predictedCourseDeg: 20,
    actualPowerW: 1000, predictedPowerW: 1000,
  }));
  const assetId = 'rv-gunnerus-physical-ontology-test';
  const modelSha = 'a'.repeat(64);
  const design = designFromSpec({
    application: 'marine',
    marine: {
      vesselId: 'ntnu-gunnerus', replaySamples: samples,
      twinEvidence: {
        powerBasis: 'dc-bus-trace',
        assetEvidence: {
          assetId, vesselId: 'ntnu-gunnerus', evidenceId: 'asset-registry-ontology-test',
          revision: 'rev-1', issuedAt: '2026-07-01T09:00:00Z', sha256: 'e'.repeat(64),
        },
        modelEvidence: {
          artifactId: 'gunnerus-model-ontology-test', version: '1.0.0',
          vesselId: 'ntnu-gunnerus', assetId, sha256: modelSha,
        },
        calibrationEvidence: {
          trialId: 'calibration-ontology-test', vesselId: 'ntnu-gunnerus', assetId,
          datasetSha256: 'b'.repeat(64), modelArtifactSha256: modelSha,
          completedAt: '2026-07-10T10:00:00Z',
        },
        validationEvidence: {
          trialId: 'validation-ontology-test', vesselId: 'ntnu-gunnerus', assetId,
          datasetSha256: 'c'.repeat(64), modelArtifactSha256: modelSha,
          completedAt: '2026-07-15T10:00:00Z', result: 'pass',
          metrics: { speedRmsKn: 0.1, courseRmsDeg: 1, powerRmsFraction: 0.02 },
          limits: { speedRmsKn: 0.5, courseRmsDeg: 10, powerRmsFraction: 0.15 },
        },
        replayEvidence: {
          replayId: 'replay-ontology-test', vesselId: 'ntnu-gunnerus', assetId,
          datasetSha256: replayDatasetSha256(samples), modelArtifactSha256: modelSha,
          recordedAt: '2026-08-05T10:00:00Z', maxAgeDays: 7,
          minSamples: 10, minDurationS: 60,
        },
      },
    },
  });
  assert.equal(design.twinShip.readiness.maturity, 'digital-twin');
  assert.equal(design.semantics.conforms, true);
  const graph = design.semantics.graph;
  assert.equal(querySemanticGraph(graph, { type: 'bd:DigitalTwin' }).nodes.length, 1);
  assert.equal(querySemanticGraph(graph, { type: 'bd:PhysicalAsset' }).nodes.length, 1);
  assert.equal(querySemanticGraph(graph, { type: 'bd:Observation' }).nodes.length, 1);
  assert.equal(querySemanticGraph(graph, { relation: 'bd:representsAsset' }).edges.length, 1);
  assert.doesNotMatch(JSON.stringify(graph), new RegExp(assetId));
});

test('invalid digital-twin and HIL declarations fail their executable shapes', () => {
  const graph = clone(designFromSpec({ application: 'wearable' }).semantics.graph);
  graph.nodes.push({
    id: semanticId('digital-twin', 'unsupported'), types: ['bd:DigitalTwin'],
    label: 'Unsupported twin', properties: {},
  }, {
    id: semanticId('hil-run', 'unsupported'), types: ['bd:HILRun', 'bd:ModelRun'],
    label: 'Unsupported HIL run', properties: {},
  });
  const validation = validateSemanticGraph(graph);
  assert.ok(validation.issues.some((row) => row.code === 'TWIN_ASSET'));
  assert.ok(validation.issues.some((row) => row.code === 'TWIN_EVIDENCE'));
  assert.ok(validation.issues.some((row) => row.code === 'HIL_EVIDENCE'));
});

test('governance approvals use the same ontology without becoming calculations', () => {
  const ai = { id: 'assistant', kind: 'ai', role: 'assistant', organization: 'battery-design', marketAccess: ['road'] };
  const validator = { id: 'validator', kind: 'system', role: 'validation-system', organization: 'battery-design', marketAccess: ['road'] };
  const reviewer = { id: 'reviewer', kind: 'human', role: 'engineer', organization: 'Example', marketAccess: ['road'], authorities: ['review'] };
  const approver = { id: 'approver', kind: 'human', role: 'manager', organization: 'Example', marketAccess: ['road'], authorities: ['approve'] };
  let record = createDesignRecord({ projectId: 'onto-project', scope: scopeForApplication('ev'), version: '1.0.0', actor: ai, reason: 'Create.', at: '2026-08-06T08:00:00Z' });
  record = transitionDesign(record, { to: 'validated', actor: validator, reason: 'Validate.', evidence: 'run/1', at: '2026-08-06T09:00:00Z' });
  record = transitionDesign(record, { to: 'reviewed', actor: reviewer, reason: 'Review.', evidence: 'review/1', at: '2026-08-06T10:00:00Z' });
  record = transitionDesign(record, { to: 'approved', actor: approver, reason: 'Approve.', evidence: 'approval/1', at: '2026-08-06T11:00:00Z' });
  const graph = buildGovernanceSemanticGraph(record);
  assert.equal(graph.validation.conforms, true);
  assert.equal(querySemanticGraph(graph, { type: 'bd:Approval' }).nodes.length, 1);
  assert.ok(querySemanticGraph(graph, { relation: 'bd:approves' }).edges.some((edge) => edge.to === graph.rootId));
  const portable = JSON.stringify(graph);
  for (const privateValue of ['onto-project', 'assistant', 'validator', 'reviewer', 'approver',
    'Example', 'Create.', 'Validate.', 'Review.', 'Approve.', 'run/1']) {
    assert.ok(!portable.includes(privateValue), `governance graph leaked ${privateValue}`);
  }
  assert.ok(querySemanticGraph(graph, { type: 'bd:Agent' }).nodes
    .every((node) => node.properties.identityWithheld === true));
});

test('release needs passing tests, exact-version approval and a release-authorized human', () => {
  const fake = buildGovernanceSemanticGraph({
    projectId: 'fake-release', version: '1.0.0', state: 'released',
    scope: scopeForApplication('ev'), history: [],
  });
  assert.equal(fake.validation.conforms, false);
  assert.ok(fake.validation.issues.some((row) => row.code === 'RELEASE_DECISION_MISSING'));

  const ai = { id: 'assistant', kind: 'ai', role: 'assistant', organization: 'battery-design', marketAccess: ['road'] };
  const validator = { id: 'validator', kind: 'system', role: 'validation-system', organization: 'battery-design', marketAccess: ['road'] };
  const reviewer = { id: 'reviewer', kind: 'human', role: 'engineer', organization: 'Example', marketAccess: ['road'], authorities: ['review'] };
  const approver = { id: 'approver', kind: 'human', role: 'manager', organization: 'Example', marketAccess: ['road'], authorities: ['approve'] };
  const releaser = { id: 'releaser', kind: 'human', role: 'release-manager', organization: 'Example', marketAccess: ['road'], authorities: ['release'] };
  let record = createDesignRecord({ projectId: 'release-project', scope: scopeForApplication('ev'), version: '1.0.0', actor: ai, reason: 'Create.', at: '2026-08-06T08:00:00Z' });
  record = transitionDesign(record, { to: 'validated', actor: validator, reason: 'Validate.', evidence: 'run/1', at: '2026-08-06T09:00:00Z' });
  record = transitionDesign(record, { to: 'reviewed', actor: reviewer, reason: 'Review.', evidence: 'review/1', at: '2026-08-06T10:00:00Z' });
  record = transitionDesign(record, { to: 'approved', actor: approver, reason: 'Approve.', evidence: 'approval/1', at: '2026-08-06T11:00:00Z' });
  record = transitionDesign(record, { to: 'released', actor: releaser, reason: 'Release.', evidence: 'release/1', at: '2026-08-06T12:00:00Z' });
  const released = buildGovernanceSemanticGraph(record);
  assert.equal(released.validation.conforms, true);
  assert.equal(querySemanticGraph(released, { type: 'bd:ReleaseDecision' }).nodes.length, 1);
  assert.equal(querySemanticGraph(released, { type: 'bd:TestEvidence' }).nodes.length, 1);

  const changed = recordMaterialChange(record, {
    nextVersion: '2.0.0', actor: ai, reason: 'Material design change.', at: '2026-08-07T08:00:00Z',
  });
  const changedGraph = buildGovernanceSemanticGraph(changed);
  assert.equal(querySemanticGraph(changedGraph, { type: 'bd:Approval' }).nodes.length, 0);
  assert.equal(querySemanticGraph(changedGraph, { type: 'bd:ReleaseDecision' }).nodes.length, 0);
});

test('the report exposes ontology version, checksum and independent status axes', () => {
  const design = designFromSpec({ application: 'ev' });
  const html = buildReportHTML({
    date: '2026-08-06', application: 'ev', cell: design.cell, summary: design.pack,
    cost: design.cost, co2: design.co2, usage: { cyclesPerYear: 250, targetYears: 8 },
    selection: {}, findings: design.findings, semantics: design.semantics,
    disclaimer: 'Screening only.',
  });
  assert.match(html, /Ontology &amp; traceability/);
  assert.match(html, /ontology 1\.0\.0/);
  assert.ok(html.includes(design.semantics.ontology.checksum));
  assert.match(html, /engineering feasibility.*evidence maturity/i);
});

test('the summary is a compact projection of the authoritative graph', () => {
  const graph = buildDesignSemanticGraph(designFromSpec({ application: 'wearable' }));
  const summary = semanticGraphSummary(graph);
  assert.equal(summary.counts.nodes, graph.nodes.length);
  assert.equal(summary.counts.edges, graph.edges.length);
  assert.equal(summary.ontology.checksum, graph.checksum);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(graph).length / 5);
});
