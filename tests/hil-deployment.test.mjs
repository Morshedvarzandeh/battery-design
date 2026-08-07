import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  HIL_DEPLOYMENT_SCHEMA,
  HIL_RUNTIME_ABI,
  createHilDeploymentPlan,
  verifyHilDeploymentPlan,
} from '../js/hil-deployment.js';
import * as deploymentModule from '../js/hil-deployment.js';
import { ADDONS } from '../js/addons.js';
import { MODEL_TEMPLATES, canonicalGraphJson, graphChecksum } from '../js/cosim-graph.js';
import { HIL_SCHEMA, createHilTestContract } from '../js/loop-testing.js';

const ALL_FAULTS = [
  'sensor-open',
  'sensor-short',
  'sensor-stuck',
  'out-of-range',
  'communication-timeout',
  'target-overrun',
  'power-cycle',
  'emergency-safe-state',
];

const NON_CHANNEL_FAULTS = new Set([
  'communication-timeout', 'target-overrun', 'power-cycle', 'emergency-safe-state',
]);

const INJECTOR = {
  'sensor-open': 'driver',
  'sensor-short': 'driver',
  'sensor-stuck': 'driver',
  'out-of-range': 'driver',
  'communication-timeout': 'driver',
  'target-overrun': 'scheduler',
  'power-cycle': 'platform',
  'emergency-safe-state': 'scheduler',
};

function graphFixture() {
  return MODEL_TEMPLATES['road-electrothermal'].build({ mode: 'manual' });
}

function contractFixture(graph = graphFixture(), overrun = {
  maxConsecutive: 2,
  action: 'Documentation only: describe the reviewed physical response.',
}, overrides = {}) {
  return createHilTestContract({
    targetId: 'rt-target-a',
    modelId: graph.id,
    modelVersion: graph.version,
    graphChecksum: graphChecksum(graph),
    samplePeriodUs: 1_000,
    durationS: 0.005,
    inputs: [
      { id: 'pack-current', quantity: 'electricCurrent', unit: 'A', min: -100, max: 100 },
      { id: 'ambient-temperature', quantity: 'temperature', unit: 'degC', min: -40, max: 85 },
    ],
    outputs: [
      { id: 'pack-voltage', quantity: 'electricPotential', unit: 'V', min: 0, max: 1_000, safeValue: 0 },
      { id: 'contactor-command', quantity: 'boolean', unit: '0/1', min: 0, max: 1, safeValue: 0 },
    ],
    overrun,
    requiredFaults: ALL_FAULTS,
    ...overrides,
  });
}

function faultMappings() {
  return ALL_FAULTS.map((faultId) => ({
    faultId,
    operation: faultId,
    injector: INJECTOR[faultId],
    channelId: NON_CHANNEL_FAULTS.has(faultId) ? null : 'pack-current',
  }));
}

function optionsFixture({ graph = graphFixture(), contract = null } = {}) {
  const boundContract = contract || contractFixture(graph);
  return {
    contract: boundContract,
    expectedContractChecksum: boundContract.checksum,
    graph,
    target: {
      id: 'rt-target-a',
      platform: 'posix-reference-target',
      architecture: 'x86_64',
      driverId: 'battery-design/reference-io@1',
      clockId: 'clock-monotonic-raw',
    },
    channels: {
      inputs: [
        { channelId: 'pack-current', modelPortId: 'plant.current', physicalEndpoint: 'daq/ai/0' },
        { channelId: 'ambient-temperature', modelPortId: 'plant.ambient', physicalEndpoint: 'daq/ai/1' },
      ],
      outputs: [
        { channelId: 'pack-voltage', modelPortId: 'dut.voltage', physicalEndpoint: 'daq/ao/0' },
        { channelId: 'contactor-command', modelPortId: 'dut.contactor', physicalEndpoint: 'daq/dio/0' },
      ],
    },
    faults: faultMappings(),
    safety: {
      mode: 'latch-declared-safe-outputs',
      trigger: 'overrun-limit-exceeded-or-runtime-failure',
    },
  };
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('creates a closed content-addressed deployment plan without claiming runtime qualification', () => {
  const options = optionsFixture();
  const plan = createHilDeploymentPlan(options);
  assert.equal(plan.schema, HIL_DEPLOYMENT_SCHEMA);
  assert.equal(plan.runtimeAbi, HIL_RUNTIME_ABI);
  assert.equal(plan.contractSchema, HIL_SCHEMA);
  assert.equal(plan.status, 'deployment-plan-ready-runtime-not-qualified');
  assert.equal(plan.contractChecksum, options.contract.checksum);
  assert.equal(plan.graphChecksum, options.contract.graphChecksum);
  assert.match(plan.checksum, /^[a-f0-9]{64}$/);
  assertDeepFrozen(plan);
});

test('binds the SHA-256 of the exact canonical UTF-8 graph bytes', () => {
  const options = optionsFixture();
  const plan = createHilDeploymentPlan(options);
  const expected = createHash('sha256').update(canonicalGraphJson(options.graph), 'utf8').digest('hex');
  assert.equal(plan.graphArtifactSha256, expected);
  assert.notEqual(plan.graphArtifactSha256, plan.graphChecksum);
});

test('canonical graph order and caller mutation cannot change an existing plan', () => {
  const options = optionsFixture();
  const first = createHilDeploymentPlan(options);
  const reorderedGraph = structuredClone(options.graph);
  reorderedGraph.nodes.reverse();
  reorderedGraph.connections.reverse();
  reorderedGraph.analysisModules.reverse();
  const reorderedOptions = optionsFixture({ graph: reorderedGraph, contract: options.contract });
  const second = createHilDeploymentPlan(reorderedOptions);
  assert.equal(second.graphArtifactSha256, first.graphArtifactSha256);
  assert.equal(second.checksum, first.checksum);
  options.target.platform = 'mutated-after-creation';
  options.channels.inputs[0].physicalEndpoint = 'ao/99';
  assert.equal(first.target.platform, 'posix-reference-target');
  assert.equal(first.channels.inputs[0].physicalEndpoint, 'daq/ai/0');
});

test('requires the caller to supply the exact trusted HIL contract checksum', () => {
  const options = optionsFixture();
  assert.throws(
    () => createHilDeploymentPlan({ ...options, expectedContractChecksum: '0'.repeat(64) }),
    /trusted expected checksum/i,
  );
  const missing = { ...options };
  delete missing.expectedContractChecksum;
  assert.throws(() => createHilDeploymentPlan(missing), /missing required field.*expectedContractChecksum/i);
  assert.throws(
    () => createHilDeploymentPlan({ ...options, expectedContractChecksum: 'ABC' }),
    /lowercase SHA-256/i,
  );
});

test('rejects a contract changed after its trusted checksum was selected', () => {
  const options = optionsFixture();
  const changed = structuredClone(options.contract);
  changed.outputs[0].safeValue = 10;
  assert.throws(
    () => createHilDeploymentPlan({ ...options, contract: changed }),
    /contract checksum mismatch/i,
  );
});

test('rejects a coordinated valid contract rewrite against the independently retained checksum', () => {
  const options = optionsFixture();
  const changedOutputs = options.contract.outputs.map((channel) => (
    channel.id === 'pack-voltage' ? { ...channel, safeValue: 1 } : channel
  ));
  const changedContract = contractFixture(options.graph, undefined, { outputs: changedOutputs });
  assert.notEqual(changedContract.checksum, options.contract.checksum);
  assert.throws(
    () => createHilDeploymentPlan({
      ...options,
      contract: changedContract,
      expectedContractChecksum: options.contract.checksum,
    }),
    /does not match the trusted expected checksum/i,
  );
});

test('requires canonical graph checksum identity with the HIL contract', () => {
  const options = optionsFixture();
  const changedGraph = structuredClone(options.graph);
  changedGraph.title = 'Different governed artifact';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, graph: changedGraph }),
    /graph checksum must equal/i,
  );
});

test('requires graph model id and version identities to equal the contract', () => {
  const graph = graphFixture();
  const wrongIdContract = contractFixture(graph, undefined, { modelId: 'different-model' });
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph, contract: wrongIdContract })),
    /graph\.id must equal/i,
  );
  const wrongVersionContract = contractFixture(graph, undefined, { modelVersion: '9.9.9' });
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph, contract: wrongVersionContract })),
    /graph\.version must equal/i,
  );
});

test('rejects an invalid graph even when its contract carries the matching corruption checksum', () => {
  const graph = graphFixture();
  graph.nodes[0].type = 'unapproved-runtime-block';
  const contract = contractFixture(graph);
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph, contract })),
    /graph is invalid/i,
  );
});

test('target profile is closed, complete, and bound to contract targetId', () => {
  const options = optionsFixture();
  assert.throws(
    () => createHilDeploymentPlan({
      ...options,
      target: { ...options.target, id: 'other-target' },
    }),
    /target\.id must equal/i,
  );
  const extra = { ...options.target, privateDriverState: 'hidden' };
  assert.throws(
    () => createHilDeploymentPlan({ ...options, target: extra }),
    /unsupported field.*privateDriverState/i,
  );
  const missing = { ...options.target };
  delete missing.clockId;
  assert.throws(
    () => createHilDeploymentPlan({ ...options, target: missing }),
    /missing required field.*clockId/i,
  );
});

test('maps every contract channel exactly once in its DUT-relative direction', () => {
  const options = optionsFixture();
  const missing = structuredClone(options.channels);
  missing.inputs.pop();
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: missing }),
    /does not map channel.*ambient-temperature/i,
  );
  const unknown = structuredClone(options.channels);
  unknown.outputs[0].channelId = 'unknown-output';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: unknown }),
    /unknown channel.*unknown-output/i,
  );
  const swapped = structuredClone(options.channels);
  [swapped.inputs[0].channelId, swapped.outputs[0].channelId] = [
    swapped.outputs[0].channelId, swapped.inputs[0].channelId,
  ];
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: swapped }),
    /channels\.inputs contains unknown channel/i,
  );
});

test('returned channel bindings preserve exact contract semantics without caller authority', () => {
  const options = optionsFixture();
  const plan = createHilDeploymentPlan(options);
  assert.deepEqual(plan.channels.inputs[0], {
    channelId: 'pack-current',
    quantity: 'electricCurrent',
    unit: 'A',
    min: -100,
    max: 100,
    modelPortId: 'plant.current',
    physicalEndpoint: 'daq/ai/0',
  });
  assert.deepEqual(plan.channels.outputs[1], {
    channelId: 'contactor-command',
    quantity: 'boolean',
    unit: '0/1',
    min: 0,
    max: 1,
    safeValue: 0,
    modelPortId: 'dut.contactor',
    physicalEndpoint: 'daq/dio/0',
  });
  const forgedCallerSemantics = structuredClone(options.channels);
  forgedCallerSemantics.inputs[0].unit = 'kA';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: forgedCallerSemantics }),
    /unsupported field.*unit/i,
  );
});

test('caller channel and fault ordering cannot mint a different deployment identity', () => {
  const options = optionsFixture();
  const first = createHilDeploymentPlan(options);
  const reordered = structuredClone(options);
  reordered.channels.inputs.reverse();
  reordered.channels.outputs.reverse();
  reordered.faults.reverse();
  const second = createHilDeploymentPlan(reordered);
  assert.deepEqual(second.channels, first.channels);
  assert.deepEqual(second.faults, first.faults);
  assert.equal(second.checksum, first.checksum);
});

test('rejects duplicate physical endpoints and model ABI ports across directions', () => {
  const options = optionsFixture();
  const endpointReuse = structuredClone(options.channels);
  endpointReuse.outputs[0].physicalEndpoint = endpointReuse.inputs[0].physicalEndpoint;
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: endpointReuse }),
    /physicalEndpoint must be unique/i,
  );
  const portReuse = structuredClone(options.channels);
  portReuse.outputs[0].modelPortId = portReuse.inputs[0].modelPortId;
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: portReuse }),
    /modelPortId must be unique/i,
  );
});

test('channel mapping documents are closed and require nonblank stable ids', () => {
  const options = optionsFixture();
  const extra = structuredClone(options.channels);
  extra.inputs[0].gain = 2;
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: extra }),
    /unsupported field.*gain/i,
  );
  const blank = structuredClone(options.channels);
  blank.inputs[0].modelPortId = '  ';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: blank }),
    /modelPortId must be a non-empty string/i,
  );
});

test('opaque ids and namespaced references reject traversal and prototype-control forms', () => {
  const options = optionsFixture();
  assert.throws(
    () => createHilDeploymentPlan({
      ...options,
      target: { ...options.target, id: '../rt-target-a' },
    }),
    /unsafe path|path separator/i,
  );
  assert.throws(
    () => createHilDeploymentPlan({
      ...options,
      target: { ...options.target, driverId: 'battery-design/../private-driver' },
    }),
    /traversal path segment/i,
  );
  const unsafeEndpoint = structuredClone(options.channels);
  unsafeEndpoint.inputs[0].physicalEndpoint = 'daq/__proto__/polluted';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: unsafeEndpoint }),
    /prototype-control segment/i,
  );
  const unsafePort = structuredClone(options.channels);
  unsafePort.inputs[0].modelPortId = 'constructor.output';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: unsafePort }),
    /prototype-control segment/i,
  );
  const oversized = structuredClone(options.channels);
  oversized.inputs[0].modelPortId = 'x'.repeat(161);
  assert.throws(
    () => createHilDeploymentPlan({ ...options, channels: oversized }),
    /must not exceed 160/i,
  );
});

test('maps every required allowlisted fault exactly once and no others', () => {
  const options = optionsFixture();
  assert.throws(
    () => createHilDeploymentPlan({ ...options, faults: options.faults.slice(1) }),
    /does not map required operation.*sensor-open/i,
  );
  assert.throws(
    () => createHilDeploymentPlan({ ...options, faults: [...options.faults, options.faults[0]] }),
    /faultId must be mapped exactly once/i,
  );
  const customContract = contractFixture(options.graph, undefined, {
    requiredFaults: ['custom-physical-fault'],
  });
  assert.throws(
    () => createHilDeploymentPlan({
      ...options,
      contract: customContract,
      expectedContractChecksum: customContract.checksum,
      faults: [{
        faultId: 'custom-physical-fault', operation: 'custom-physical-fault',
        injector: 'driver', channelId: 'pack-current',
      }],
    }),
    /not an allowlisted runtime fault/i,
  );
});

test('fault operation is the allowlisted contract literal and cannot be translated', () => {
  const options = optionsFixture();
  const translated = structuredClone(options.faults);
  translated[0].operation = 'open-circuit';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, faults: translated }),
    /operation must equal its allowlisted faultId/i,
  );
});

test('fault injector and channel routing follow the fixed execution boundary', () => {
  const options = optionsFixture();
  const wrongInjector = structuredClone(options.faults);
  wrongInjector.find((fault) => fault.faultId === 'power-cycle').injector = 'driver';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, faults: wrongInjector }),
    /injector must be platform/i,
  );
  const missingChannel = structuredClone(options.faults);
  missingChannel.find((fault) => fault.faultId === 'sensor-short').channelId = null;
  assert.throws(
    () => createHilDeploymentPlan({ ...options, faults: missingChannel }),
    /must name a DUT input channel/i,
  );
  const forbiddenChannel = structuredClone(options.faults);
  forbiddenChannel.find((fault) => fault.faultId === 'target-overrun').channelId = 'pack-current';
  assert.throws(
    () => createHilDeploymentPlan({ ...options, faults: forbiddenChannel }),
    /channelId must be null/i,
  );
});

test('safe latch values and deadline threshold are executable derivatives of the contract', () => {
  const options = optionsFixture();
  const plan = createHilDeploymentPlan(options);
  assert.deepEqual(plan.safeOutputs, [
    { channelId: 'pack-voltage', value: 0 },
    { channelId: 'contactor-command', value: 0 },
  ]);
  assert.deepEqual(plan.safety, {
    mode: 'latch-declared-safe-outputs',
    trigger: 'overrun-limit-exceeded-or-runtime-failure',
    overrunMissesBeforeLatch: 3,
  });
});

test('overrun action text is documentation only and is never parsed as policy', () => {
  const graph = graphFixture();
  const firstContract = contractFixture(graph, {
    maxConsecutive: 0,
    action: 'OPEN contactor; after 999 misses; parse-me-never',
  });
  const secondContract = contractFixture(graph, {
    maxConsecutive: 0,
    action: 'This deliberately says something entirely different.',
  });
  const first = createHilDeploymentPlan(optionsFixture({ graph, contract: firstContract }));
  const second = createHilDeploymentPlan(optionsFixture({ graph, contract: secondContract }));
  assert.deepEqual(first.safety, second.safety);
  assert.deepEqual(first.safeOutputs, second.safeOutputs);
  assert.equal(first.safety.overrunMissesBeforeLatch, 1);
});

test('rejects an unrepresentable derived latch threshold at MAX_SAFE_INTEGER', () => {
  const graph = graphFixture();
  const exactContract = contractFixture(graph, {
    maxConsecutive: Number.MAX_SAFE_INTEGER - 1,
    action: 'Largest exactly executable threshold.',
  });
  const exactPlan = createHilDeploymentPlan(optionsFixture({ graph, contract: exactContract }));
  assert.equal(exactPlan.safety.overrunMissesBeforeLatch, Number.MAX_SAFE_INTEGER);

  const contract = contractFixture(graph, {
    maxConsecutive: Number.MAX_SAFE_INTEGER,
    action: 'Documentation only.',
  });
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph, contract })),
    /derived safety\.overrunMissesBeforeLatch must be a positive safe integer/i,
  );
});

test('strict graph walk prevents non-finite and literal-null canonical aliases', () => {
  const graphWithNull = graphFixture();
  graphWithNull.history[0].aliasProbe = null;
  const nullContract = contractFixture(graphWithNull);
  assert.doesNotThrow(() => createHilDeploymentPlan(optionsFixture({
    graph: graphWithNull,
    contract: nullContract,
  })));

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const graph = structuredClone(graphWithNull);
    graph.history[0].aliasProbe = invalid;
    assert.equal(graphChecksum(graph), graphChecksum(graphWithNull),
      'legacy JSON graph checksum aliases non-finite numbers to literal null');
    assert.throws(
      () => createHilDeploymentPlan(optionsFixture({ graph, contract: nullContract })),
      /non-finite number/i,
    );
  }
});

test('strict graph walk rejects sparse arrays, cycles, prototypes and accessors before hashing', () => {
  const trustedContract = contractFixture(graphFixture());
  const sparse = graphFixture();
  sparse.history = new Array(1);
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph: sparse, contract: trustedContract })),
    /sparse array slots/i,
  );

  const cyclic = graphFixture();
  cyclic.history[0].cycle = cyclic;
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph: cyclic, contract: trustedContract })),
    /contains a cycle/i,
  );

  const inherited = graphFixture();
  Object.setPrototypeOf(inherited.nodes[0], { hidden: true });
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph: inherited, contract: trustedContract })),
    /must be a plain object/i,
  );

  const accessor = graphFixture();
  Object.defineProperty(accessor.history[0], 'unstable', {
    enumerable: true,
    get() { return 1; },
  });
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph: accessor, contract: trustedContract })),
    /enumerable data property/i,
  );

  const nonEnumerable = graphFixture();
  Object.defineProperty(nonEnumerable.history[0], 'ignored', { value: 1, enumerable: false });
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph: nonEnumerable, contract: trustedContract })),
    /enumerable data property/i,
  );

  const prototypeKey = graphFixture();
  Object.defineProperty(prototypeKey, '__proto__', {
    value: { injected: true }, enumerable: true, configurable: true, writable: true,
  });
  assert.throws(
    () => createHilDeploymentPlan(optionsFixture({ graph: prototypeKey, contract: trustedContract })),
    /prototype-control key/i,
  );
});

test('verification rematerializes a deeply frozen snapshot and supports a trusted digest', () => {
  const plan = createHilDeploymentPlan(optionsFixture());
  const serialized = JSON.parse(JSON.stringify(plan));
  const verified = verifyHilDeploymentPlan(serialized, { expectedChecksum: plan.checksum });
  assert.deepEqual(verified, plan);
  assert.notEqual(verified, serialized);
  assertDeepFrozen(verified);
  assert.throws(
    () => verifyHilDeploymentPlan(serialized, { expectedChecksum: '0'.repeat(64) }),
    /trusted expected checksum/i,
  );
});

test('verification rejects nested mutation, schema drift, and unknown fields', () => {
  const plan = createHilDeploymentPlan(optionsFixture());
  const changedEndpoint = structuredClone(plan);
  changedEndpoint.channels.inputs[0].physicalEndpoint = 'ao/99';
  assert.throws(() => verifyHilDeploymentPlan(changedEndpoint), /checksum mismatch/i);
  const changedAbi = { ...structuredClone(plan), runtimeAbi: 'battery-design/hil-runtime-abi@2' };
  assert.throws(() => verifyHilDeploymentPlan(changedAbi), /runtimeAbi must be/i);
  const unknown = { ...structuredClone(plan), signedBy: 'nobody' };
  assert.throws(() => verifyHilDeploymentPlan(unknown), /unsupported field.*signedBy/i);
  assert.throws(
    () => verifyHilDeploymentPlan(plan, { trustAnything: true }),
    /verification options contains unsupported field/i,
  );
});

test('verification rejects inherited envelopes, sparse routes and non-finite derived semantics', () => {
  const plan = createHilDeploymentPlan(optionsFixture());
  const inherited = Object.create(plan);
  assert.throws(() => verifyHilDeploymentPlan(inherited), /must be a plain object/i);

  const sparse = structuredClone(plan);
  sparse.faults = new Array(plan.faults.length);
  assert.throws(() => verifyHilDeploymentPlan(sparse), /sparse array slots/i);

  const nonFinite = structuredClone(plan);
  nonFinite.channels.outputs[0].safeValue = Number.NaN;
  nonFinite.safeOutputs[0].value = Number.NaN;
  assert.throws(() => verifyHilDeploymentPlan(nonFinite), /must be finite/i);

  const safeMismatch = structuredClone(plan);
  safeMismatch.channels.outputs[0].safeValue = 1;
  assert.throws(
    () => verifyHilDeploymentPlan(safeMismatch),
    /safeOutputs must exactly reproduce/i,
  );
});

test('Iteration 1 exports no executor and keeps the physical HIL runtime planned', () => {
  assert.deepEqual(Object.keys(deploymentModule).sort(), [
    'HIL_DEPLOYMENT_SCHEMA',
    'HIL_RUNTIME_ABI',
    'createHilDeploymentPlan',
    'verifyHilDeploymentPlan',
  ]);
  const addon = ADDONS.find((item) => item.id === 'hil-runtime');
  assert.equal(addon?.status, 'planned');
  assert.equal(addon?.module, 'planned');
  assert.deepEqual(addon?.surfaces, ['planned']);
});

test('module remains browser-safe and does not import Node-only APIs', () => {
  const source = readFileSync(new URL('../js/hil-deployment.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.match(source, /semanticDigest\(canonicalJson\)/);
});
