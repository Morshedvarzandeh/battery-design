import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_CATALOG_VERSION,
  GRAPH_SCHEMA,
  GRAPH_TRANSPORT_BLOCK_LENGTH,
  GRAPH_TRANSPORT_CONNECTION_LENGTH,
  GRAPH_TRANSPORT_HEADER_LENGTH,
  GRAPH_TRANSPORT_MAGIC,
  MODEL_TEMPLATES,
  applyApprovedGraphProposal,
  canonicalGraphJson,
  createBlockNode,
  createStudioGraph,
  debugStudioGraph,
  encodeGraphTransport,
  exportStudioGraph,
  graphChecksum,
  importStudioGraph,
  recommendBlockPlan,
  validateStudioGraph,
} from '../js/cosim-graph.js';
import { runRunawayPropagationModule, runVentSizingModule } from '../js/cosim-analysis.js';

const HUMAN = {
  id: 'engineer-1', kind: 'human', role: 'application-engineer', authorities: ['edit-graph'],
};

test('every first-release template is valid and transportable to Rust', () => {
  for (const template of Object.values(MODEL_TEMPLATES)) {
    const graph = template.build({ segment: 'home' });
    assert.equal(graph.schema, GRAPH_SCHEMA);
    assert.equal(graph.catalogVersion, BLOCK_CATALOG_VERSION);
    assert.equal(validateStudioGraph(graph).filter((item) => item.severity === 'fail').length, 0, template.id);
    const encoded = encodeGraphTransport(graph);
    assert.equal(encoded.values[0], GRAPH_TRANSPORT_MAGIC);
    assert.equal(encoded.values.length,
      GRAPH_TRANSPORT_HEADER_LENGTH
        + graph.nodes.length * GRAPH_TRANSPORT_BLOCK_LENGTH
        + graph.connections.length * GRAPH_TRANSPORT_CONNECTION_LENGTH);
    assert.deepEqual(encoded.blockIds, [...encoded.blockIds].sort(), 'Rust receives a stable block order');
  }
});

test('graph export is deterministic and import verifies corruption', () => {
  const graph = MODEL_TEMPLATES['road-electrothermal'].build();
  const shuffled = {
    ...graph,
    nodes: [...graph.nodes].reverse(), connections: [...graph.connections].reverse(),
  };
  assert.equal(canonicalGraphJson(graph), canonicalGraphJson(shuffled));
  assert.equal(graphChecksum(graph), graphChecksum(shuffled));

  const document = exportStudioGraph(shuffled);
  assert.equal(graphChecksum(importStudioGraph(document)), graphChecksum(graph));
  const tampered = JSON.parse(document);
  tampered.graph.nodes[0].parameters.value = 999;
  assert.throws(() => importStudioGraph(tampered), /checksum mismatch/i);
});

test('guided recommendations remain market-isolated and explain every block', () => {
  const road = createStudioGraph({ market: 'road', mode: 'automatic' });
  const proposal = recommendBlockPlan({
    text: 'Show cell voltage and temperature during a current step.', market: 'road', mode: 'automatic',
  }, road);
  assert.equal(proposal.status, 'ready-for-review');
  assert.equal(proposal.draftGraph.market, 'road');
  assert.ok(proposal.changes.length === proposal.draftGraph.nodes.length);
  assert.ok(proposal.changes.every((change) => change.reason));
  assert.equal(road.nodes.length, 0, 'the assistant creates a separate draft and never mutates the model');

  const blocked = recommendBlockPlan({
    text: 'Build a home outage model with an inverter.', market: 'road', mode: 'automatic',
  }, road);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.draftGraph, null);
  assert.match(blocked.explanation, /separate grid model/i);
});

test('thermal-runaway requests attach the specialized safety module', () => {
  const proposal = recommendBlockPlan({
    text: 'Compare thermal runaway propagation barriers after one cell starts.',
    market: 'road', mode: 'guided',
  }, createStudioGraph({ market: 'road' }));
  assert.equal(proposal.title, 'Thermal-runaway propagation screening');
  assert.equal(proposal.draftGraph.analysisModules[0].type, 'runaway-propagation');
  assert.equal(proposal.draftGraph.analysisModules[1].type, 'vent-sizing');
  assert.ok(validateStudioGraph(proposal.draftGraph).some((item) => item.code === 'analysis.vent_test_data_required'));
  assert.ok(proposal.evidence.some((item) => /9540A|38031/.test(item)));

  const gridProposal = recommendBlockPlan({
    text: 'Add thermal runaway propagation.', market: 'grid', mode: 'automatic',
  }, createStudioGraph({ market: 'grid', segment: 'home' }));
  assert.equal(gridProposal.status, 'ready-for-review');
  assert.equal(gridProposal.draftGraph.market, 'grid');
  assert.equal(gridProposal.draftGraph.segment, 'home');
  assert.equal(gridProposal.draftGraph.analysisModules[0].type, 'runaway-propagation');
  assert.equal(gridProposal.draftGraph.analysisModules[1].type, 'vent-sizing');
});

test('assistant and debugger proposals require named human graph authority', () => {
  const original = createStudioGraph({ market: 'road' });
  const proposal = recommendBlockPlan({ text: 'cell voltage and temperature', market: 'road' }, original);
  assert.throws(() => applyApprovedGraphProposal(original, proposal, {
    actor: { id: 'assistant', kind: 'ai', authorities: ['edit-graph'] },
  }), /named human/i);
  assert.throws(() => applyApprovedGraphProposal(original, proposal, {
    actor: { id: 'viewer', kind: 'human', authorities: [] },
  }), /no graph-edit authority/i);

  const approved = applyApprovedGraphProposal(original, proposal, {
    actor: HUMAN, nextVersion: '0.2.0-draft', reason: 'Reviewed the complete block list.',
    at: '2026-08-05T12:00:00Z',
  });
  assert.equal(approved.nodes.length, 8);
  assert.equal(approved.history.at(-1).actorId, HUMAN.id);
  assert.equal(approved.history.at(-1).proposalId, proposal.id);
  assert.ok(approved.history.at(-1).approvedContentChecksum);
  assert.equal(original.nodes.length, 0, 'the prior model remains unchanged');
});

test('debugging identifies root connections and proposes only deterministic repairs', () => {
  const graph = createStudioGraph({ market: 'road', mode: 'manual' });
  const source = createBlockNode('constant', {
    id: 'voltage', name: 'Voltage', outputQuantity: 'voltage', parameters: { value: 3.7 },
  });
  const gain = createBlockNode('gain', {
    id: 'current-gain', name: 'Current gain', outputQuantity: 'current',
    parameters: { gain: 2, inputQuantity: 'current' },
  });
  graph.nodes = [source, gain];
  graph.connections = [{ id: 'bad-wire', from: source.id, to: gain.id, toPort: 0 }];
  const report = debugStudioGraph(graph);
  assert.equal(report.status, 'blocked');
  assert.ok(report.diagnostics.some((item) => item.code === 'connection.quantity_mismatch'));
  assert.ok(report.diagnostics.some((item) => item.code === 'connection.missing_input'));
  assert.deepEqual(report.proposal.changes.map((change) => change.operation), ['remove-connection']);
  assert.ok(report.proposal.changes.every((change) => !/tolerance|setting/i.test(change.operation)),
    'debugging never proposes a solver-setting mutation');

  const repaired = applyApprovedGraphProposal(graph, report.proposal, {
    actor: HUMAN, reason: 'Remove the incompatible wire after review.',
  });
  assert.equal(repaired.connections.length, 0);
  assert.equal(graph.connections.length, 1, 'repairs are immutable');
});

test('runaway simulation can reject or compare but never reports a safety pass', () => {
  const graph = MODEL_TEMPLATES['road-runaway'].build();
  const result = runRunawayPropagationModule(graph.analysisModules[0]);
  assert.ok(['fail', 'unproven'].includes(result.status));
  assert.notEqual(result.status, 'pass');
  assert.match(result.limitations[0], /never clear one/i);
  assert.ok(result.evidence.rankedBarriers.length >= 4);
  assert.ok(result.evidence.containmentMJ > 0);
  assert.deepEqual(result.evidence.chemistryComparison.map((row) => row.chemistry), ['NMC', 'LFP', 'LTO']);
  const byChemistry = Object.fromEntries(result.evidence.chemistryComparison.map((row) => [row.chemistry, row]));
  assert.ok(byChemistry.NMC.onsetC < byChemistry.LFP.onsetC);
  assert.ok(byChemistry.LFP.onsetC < byChemistry.LTO.onsetC);
  assert.ok(byChemistry.NMC.releaseMultiple > byChemistry.LFP.releaseMultiple);
  assert.ok(byChemistry.LFP.releaseMultiple > byChemistry.LTO.releaseMultiple);
  assert.ok(result.evidence.chemistryComparison.every((row) => ['fail', 'unproven'].includes(row.outcome)));
  assert.match(result.evidence.chemistryComparisonBasis, /only the chemistry-class onset and release multiple change/i);
  assert.ok(result.evidence.heatPaths.spacerWPerK > 0, 'the selected physical spacer is calculated');
  assert.ok(Math.abs(result.evidence.heatPaths.totalWPerK
      - result.evidence.heatPaths.gapWPerK
      - result.evidence.heatPaths.spacerWPerK
      - result.evidence.heatPaths.interconnectWPerK) < 1e-12);
  assert.ok(result.evidence.rankedSpacers.length >= 5);
  assert.match(result.evidence.equations.spacer, /contact_fraction/);
  assert.ok(result.evidence.gasSourceMm.x >= 0 && result.evidence.gasSourceMm.x <= result.evidence.enclosureMm.x);
  assert.ok(result.evidence.gasSourceMm.y >= 0 && result.evidence.gasSourceMm.y <= result.evidence.enclosureMm.y);
  assert.ok(result.evidence.gasSourceMm.z >= 0 && result.evidence.gasSourceMm.z <= result.evidence.enclosureMm.z);
});

test('vent sizing, supplier quantity and placement remain separate and conditional', () => {
  const graph = MODEL_TEMPLATES['road-runaway'].build();
  const module = graph.analysisModules.find((item) => item.type === 'vent-sizing');
  const missing = runVentSizingModule(module);
  assert.equal(missing.status, 'needs-input');
  assert.match(missing.headline, /not calculated/i);
  Object.assign(module.parameters, {
    gasVolumeLowLPerCell: 5, gasVolumeHighLPerCell: 12,
    releaseDurationLowS: 1.5, releaseDurationHighS: 4,
    gasDataBasis: 'Cell abuse report TR-99, 100% SOC',
  });
  const areaOnly = runVentSizingModule(module);
  assert.equal(areaOnly.status, 'needs-hardware');
  assert.ok(areaOnly.missingHardwareInputs.some((item) => /supplier/i.test(item)));
  Object.assign(module.parameters, {
    ventUnitId: 'verified-vent-10', ventUnitName: 'Verified vent 10',
    ventSupplier: 'Supplier', ventPartNumber: 'V-10',
    ventUnitFreeAreaCm2: 10, ventUnitWidthMm: 40, ventUnitHeightMm: 30,
    ventUnitMechanism: 'pressure-relief-device', ventUnitMarketProfiles: 'road-pack',
    ventUnitEvidenceBasis: 'Supplier flow report F-10 rev B',
    allowedVentFaces: 'top,rear', preferredVentFace: 'top',
    edgeClearanceMm: 5, minimumVentSpacingMm: 5, maxVentCount: 32,
  });
  const runaway = runRunawayPropagationModule(graph.analysisModules[0]);
  const result = runVentSizingModule(module, {
    market: graph.market, segment: graph.segment, runawayEvidence: runaway.evidence,
  });
  assert.equal(result.status, 'conditional');
  assert.ok(result.evidence.high.areaCm2 > result.evidence.low.areaCm2);
  assert.ok(result.evidence.hardwareLayout.requiredQuantity > 1);
  assert.equal(result.evidence.hardwareLayout.placements.length,
    result.evidence.hardwareLayout.requiredQuantity);
  assert.match(result.limitations[0], /not NFPA 68/i);
});
