// hil-deployment.js — governed binding from an approved HIL contract to one
// canonical equation graph and one physical target profile.
//
// This module prepares an immutable target-runtime plan. It deliberately does
// not claim that the target, driver, clock, WCET, or physical I/O have been
// qualified; those require later runtime iterations and measured hardware
// evidence.

import {
  GRAPH_SCHEMA,
  canonicalGraphJson,
  graphChecksum,
  validateStudioGraph,
} from './cosim-graph.js';
import { HIL_SCHEMA, verifyHilTestContract } from './loop-testing.js';
import { semanticDigest } from './ontology.js';

export const HIL_DEPLOYMENT_SCHEMA = 'battery-design/hil-deployment-plan@1';
export const HIL_RUNTIME_ABI = 'battery-design/hil-runtime-abi@1';

const SHA256 = /^[a-f0-9]{64}$/;
const FNV1A32 = /^fnv1a32:[a-f0-9]{8}$/;
const MAX_OPAQUE_ID_LENGTH = 160;
const PLAN_STATUS = 'deployment-plan-ready-runtime-not-qualified';
const SAFETY_MODE = 'latch-declared-safe-outputs';
const SAFETY_TRIGGER = 'overrun-limit-exceeded-or-runtime-failure';

const FAULT_RULES = Object.freeze({
  'sensor-open': Object.freeze({ injector: 'driver', channel: 'input' }),
  'sensor-short': Object.freeze({ injector: 'driver', channel: 'input' }),
  'sensor-stuck': Object.freeze({ injector: 'driver', channel: 'input' }),
  'out-of-range': Object.freeze({ injector: 'driver', channel: 'input' }),
  'communication-timeout': Object.freeze({ injector: 'driver', channel: null }),
  'target-overrun': Object.freeze({ injector: 'scheduler', channel: null }),
  'power-cycle': Object.freeze({ injector: 'platform', channel: null }),
  'emergency-safe-state': Object.freeze({ injector: 'scheduler', channel: null }),
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message) {
  throw new TypeError(`HIL deployment plan: ${message}`);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  record(value, label);
  const allowed = new Set(keys);
  const extra = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (extra.length) fail(`${label} contains unsupported field(s): ${extra.join(', ')}.`);
  const missing = keys.filter((key) => !own(value, key));
  if (missing.length) fail(`${label} is missing required field(s): ${missing.join(', ')}.`);
}

function denseArray(value, label, { minimum = 0 } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length < minimum) fail(`${label} requires at least ${minimum} item(s).`);
  for (let index = 0; index < value.length; index += 1) {
    if (!own(value, index)) fail(`${label} must not contain sparse array slots.`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function boundedSemanticText(value, label) {
  const normalized = text(value, label);
  if (normalized.length > MAX_OPAQUE_ID_LENGTH) {
    fail(`${label} must not exceed ${MAX_OPAQUE_ID_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    fail(`${label} contains a control character.`);
  }
  return normalized;
}

function opaqueId(value, label) {
  const normalized = boundedSemanticText(value, label);
  if (/[/\\]/u.test(normalized)) fail(`${label} contains a path separator.`);
  const lower = normalized.toLowerCase();
  if (lower.includes('..') || lower.includes('__proto__')
      || /(^|[.\-:@_])(prototype|constructor)($|[.\-:@_])/.test(lower)) {
    fail(`${label} contains an unsafe path or prototype-control segment.`);
  }
  return normalized;
}

function opaqueReference(value, label) {
  const normalized = boundedSemanticText(value, label);
  if (normalized.startsWith('/') || normalized.startsWith('\\') || normalized.includes('\\')
      || /^[a-zA-Z]:\//.test(normalized)) {
    fail(`${label} must be a relative namespaced reference without backslashes.`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${label} contains an empty or traversal path segment.`);
  }
  if (segments.some((segment) => {
    const lower = segment.toLowerCase();
    return lower.includes('__proto__')
      || /(^|[.\-:@_])(prototype|constructor)($|[.\-:@_])/.test(lower);
  })) fail(`${label} contains a prototype-control segment.`);
  return normalized;
}

function assertClosedJson(value, label = 'graph', active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== 'object') fail(`${label} contains a non-JSON value.`);
  if (active.has(value)) fail(`${label} contains a cycle.`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      denseArray(value, label);
      const extra = Reflect.ownKeys(value).filter((key) => (
        key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))
      ));
      if (extra.length) fail(`${label} array contains unsupported own properties.`);
      return value.map((item, index) => assertClosedJson(item, `${label}[${index}]`, active));
    }
    record(value, label);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) fail(`${label} contains a symbol key.`);
    const clone = Object.create(null);
    for (const key of keys) {
      if (['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase())) {
        fail(`${label}.${key} is a prototype-control key.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !own(descriptor, 'value')) {
        fail(`${label}.${key} must be an enumerable data property.`);
      }
      clone[key] = assertClosedJson(descriptor.value, `${label}.${key}`, active);
    }
    return clone;
  } finally {
    active.delete(value);
  }
}

function sha256(value, label) {
  const normalized = text(value, label);
  if (!SHA256.test(normalized)) fail(`${label} must be a lowercase SHA-256 digest.`);
  return normalized;
}

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be greater than zero.`);
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer.`);
  return value;
}

function finite(value, label) {
  if (!Number.isFinite(value)) fail(`${label} must be finite.`);
  return Object.is(value, -0) ? 0 : value;
}

function normalizeTarget(value) {
  exactKeys(value, ['id', 'platform', 'architecture', 'driverId', 'clockId'], 'target');
  return {
    id: opaqueId(value.id, 'target.id'),
    platform: opaqueId(value.platform, 'target.platform'),
    architecture: opaqueId(value.architecture, 'target.architecture'),
    driverId: opaqueReference(value.driverId, 'target.driverId'),
    clockId: opaqueId(value.clockId, 'target.clockId'),
  };
}

function normalizeChannelMappings(value, direction, { enriched = false } = {}) {
  denseArray(value, `channels.${direction}`, { minimum: 1 });
  return value.map((mapping, index) => {
    const label = `channels.${direction}[${index}]`;
    const semanticKeys = enriched
      ? ['quantity', 'unit', 'min', 'max', ...(direction === 'outputs' ? ['safeValue'] : [])]
      : [];
    exactKeys(mapping, [
      'channelId', ...semanticKeys, 'modelPortId', 'physicalEndpoint',
    ], label);
    const normalized = {
      channelId: opaqueId(mapping.channelId, `${label}.channelId`),
      ...(enriched ? {
        quantity: boundedSemanticText(mapping.quantity, `${label}.quantity`),
        unit: boundedSemanticText(mapping.unit, `${label}.unit`),
        min: finite(mapping.min, `${label}.min`),
        max: finite(mapping.max, `${label}.max`),
        ...(direction === 'outputs'
          ? { safeValue: finite(mapping.safeValue, `${label}.safeValue`) } : {}),
      } : {}),
      modelPortId: opaqueId(mapping.modelPortId, `${label}.modelPortId`),
      physicalEndpoint: opaqueReference(mapping.physicalEndpoint, `${label}.physicalEndpoint`),
    };
    if (enriched && normalized.min > normalized.max) fail(`${label} has unordered limits.`);
    if (direction === 'outputs' && enriched
        && (normalized.safeValue < normalized.min || normalized.safeValue > normalized.max)) {
      fail(`${label}.safeValue must be inside its declared limits.`);
    }
    return normalized;
  });
}

function normalizeChannels(value, options = {}) {
  exactKeys(value, ['inputs', 'outputs'], 'channels');
  const inputs = normalizeChannelMappings(value.inputs, 'inputs', options);
  const outputs = normalizeChannelMappings(value.outputs, 'outputs', options);
  const all = [...inputs, ...outputs];
  for (const field of ['channelId', 'modelPortId', 'physicalEndpoint']) {
    const items = all.map((mapping) => mapping[field]);
    if (new Set(items).size !== items.length) {
      fail(`every ${field} must be unique across DUT input and output mappings.`);
    }
  }
  return { inputs, outputs };
}

function materializeChannelMappings(mappings, contractChannels, direction) {
  const byId = new Map(mappings.map((mapping) => [mapping.channelId, mapping]));
  return contractChannels.map((channel) => ({
    channelId: channel.id,
    quantity: channel.quantity,
    unit: channel.unit,
    min: channel.min,
    max: channel.max,
    ...(direction === 'outputs' ? { safeValue: channel.safeValue } : {}),
    modelPortId: byId.get(channel.id).modelPortId,
    physicalEndpoint: byId.get(channel.id).physicalEndpoint,
  }));
}

function assertExactChannelCoverage(mappings, contractChannels, direction) {
  const expected = contractChannels.map((channel) => channel.id);
  const actual = mappings.map((mapping) => mapping.channelId);
  const expectedSet = new Set(expected);
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  const unknown = actual.filter((id) => !expectedSet.has(id));
  const missing = expected.filter((id) => !actual.includes(id));
  if (duplicates.length) fail(`channels.${direction} maps channel(s) more than once: ${[...new Set(duplicates)].join(', ')}.`);
  if (unknown.length) fail(`channels.${direction} contains unknown channel(s): ${[...new Set(unknown)].join(', ')}.`);
  if (missing.length) fail(`channels.${direction} does not map channel(s): ${missing.join(', ')}.`);
}

function normalizeFaults(value, { inputChannelIds = null, requiredFaults = null } = {}) {
  denseArray(value, 'faults', { minimum: 1 });
  const faults = value.map((fault, index) => {
    const label = `faults[${index}]`;
    exactKeys(fault, ['faultId', 'operation', 'injector', 'channelId'], label);
    const faultId = opaqueId(fault.faultId, `${label}.faultId`);
    const operation = opaqueId(fault.operation, `${label}.operation`);
    const injector = opaqueId(fault.injector, `${label}.injector`);
    const channelId = fault.channelId === null ? null : opaqueId(fault.channelId, `${label}.channelId`);
    const rule = FAULT_RULES[faultId];
    if (!rule) fail(`${label}.faultId is not an allowlisted runtime fault.`);
    if (operation !== faultId) fail(`${label}.operation must equal its allowlisted faultId.`);
    if (injector !== rule.injector) fail(`${label}.injector must be ${rule.injector} for ${faultId}.`);
    if (rule.channel === 'input') {
      if (channelId === null) fail(`${label}.channelId must name a DUT input channel for ${faultId}.`);
      if (inputChannelIds && !inputChannelIds.has(channelId)) {
        fail(`${label}.channelId does not name a mapped DUT input channel.`);
      }
    } else if (channelId !== null) {
      fail(`${label}.channelId must be null for ${faultId}.`);
    }
    return { faultId, operation, injector, channelId };
  });
  const ids = faults.map((fault) => fault.faultId);
  if (new Set(ids).size !== ids.length) fail('every faultId must be mapped exactly once.');
  if (requiredFaults) {
    const requiredSet = new Set(requiredFaults);
    const unknown = ids.filter((id) => !requiredSet.has(id));
    const missing = requiredFaults.filter((id) => !ids.includes(id));
    if (unknown.length) fail(`faults contains operation(s) not required by the contract: ${unknown.join(', ')}.`);
    if (missing.length) fail(`faults does not map required operation(s): ${missing.join(', ')}.`);
  }
  return faults;
}

function normalizeSafeOutputs(value, outputChannelIds = null) {
  denseArray(value, 'safeOutputs', { minimum: 1 });
  const outputs = value.map((entry, index) => {
    const label = `safeOutputs[${index}]`;
    exactKeys(entry, ['channelId', 'value'], label);
    const channelId = opaqueId(entry.channelId, `${label}.channelId`);
    if (outputChannelIds && !outputChannelIds.has(channelId)) {
      fail(`${label}.channelId does not name a mapped DUT output channel.`);
    }
    return { channelId, value: finite(entry.value, `${label}.value`) };
  });
  const ids = outputs.map((entry) => entry.channelId);
  if (new Set(ids).size !== ids.length) fail('every safe output channel must be declared exactly once.');
  if (outputChannelIds) {
    const missing = [...outputChannelIds].filter((id) => !ids.includes(id));
    if (missing.length) fail(`safeOutputs does not declare mapped output channel(s): ${missing.join(', ')}.`);
  }
  return outputs;
}

function normalizeSafety(value) {
  exactKeys(value, ['mode', 'trigger', 'overrunMissesBeforeLatch'], 'safety');
  if (value.mode !== SAFETY_MODE) fail(`safety.mode must be ${SAFETY_MODE}.`);
  if (value.trigger !== SAFETY_TRIGGER) fail(`safety.trigger must be ${SAFETY_TRIGGER}.`);
  return {
    mode: SAFETY_MODE,
    trigger: SAFETY_TRIGGER,
    overrunMissesBeforeLatch: positiveSafeInteger(
      value.overrunMissesBeforeLatch,
      'safety.overrunMissesBeforeLatch',
    ),
  };
}

function checkedPlan(body) {
  return deepFreeze({ ...body, checksum: semanticDigest(body) });
}

function normalizePlanBody(value) {
  if (value.schema !== HIL_DEPLOYMENT_SCHEMA) fail(`schema must be ${HIL_DEPLOYMENT_SCHEMA}.`);
  if (value.runtimeAbi !== HIL_RUNTIME_ABI) fail(`runtimeAbi must be ${HIL_RUNTIME_ABI}.`);
  if (value.contractSchema !== HIL_SCHEMA) fail(`contractSchema must be ${HIL_SCHEMA}.`);
  if (value.status !== PLAN_STATUS) fail(`status must be ${PLAN_STATUS}.`);
  const targetId = opaqueId(value.targetId, 'targetId');
  const target = normalizeTarget(value.target);
  if (target.id !== targetId) fail('target.id must equal targetId.');
  const channels = normalizeChannels(value.channels, { enriched: true });
  const inputIds = new Set(channels.inputs.map((mapping) => mapping.channelId));
  const outputIds = new Set(channels.outputs.map((mapping) => mapping.channelId));
  const safeOutputs = normalizeSafeOutputs(value.safeOutputs, outputIds);
  if (safeOutputs.length !== channels.outputs.length
      || safeOutputs.some((entry, index) => (
        entry.channelId !== channels.outputs[index].channelId
        || entry.value !== channels.outputs[index].safeValue
      ))) {
    fail('safeOutputs must exactly reproduce the ordered output-channel safe values.');
  }
  return {
    schema: HIL_DEPLOYMENT_SCHEMA,
    runtimeAbi: HIL_RUNTIME_ABI,
    contractSchema: HIL_SCHEMA,
    contractChecksum: sha256(value.contractChecksum, 'contractChecksum'),
    targetId,
    modelId: opaqueId(value.modelId, 'modelId'),
    modelVersion: opaqueId(value.modelVersion, 'modelVersion'),
    graphChecksum: (() => {
      const checksum = text(value.graphChecksum, 'graphChecksum');
      if (!FNV1A32.test(checksum)) fail('graphChecksum must be a canonical FNV-1a graph checksum.');
      return checksum;
    })(),
    graphArtifactSha256: sha256(value.graphArtifactSha256, 'graphArtifactSha256'),
    samplePeriodUs: positiveSafeInteger(value.samplePeriodUs, 'samplePeriodUs'),
    durationS: positiveFinite(value.durationS, 'durationS'),
    target,
    channels,
    faults: normalizeFaults(value.faults, { inputChannelIds: inputIds }),
    safeOutputs,
    safety: normalizeSafety(value.safety),
    status: PLAN_STATUS,
  };
}

/**
 * Bind one trusted HIL contract to one canonical graph and physical target.
 * This creates a deployment input; it does not qualify or execute a runtime.
 */
export function createHilDeploymentPlan(options = {}) {
  exactKeys(options, [
    'contract', 'expectedContractChecksum', 'graph', 'target', 'channels', 'faults', 'safety',
  ], 'options');
  const expectedContractChecksum = sha256(
    options.expectedContractChecksum,
    'expectedContractChecksum',
  );
  const contract = verifyHilTestContract(options.contract, {
    expectedChecksum: expectedContractChecksum,
  });

  const target = normalizeTarget(options.target);
  if (target.id !== contract.targetId) fail('target.id must equal the HIL contract targetId.');

  const closedGraph = assertClosedJson(options.graph);
  let canonicalJson;
  try {
    canonicalJson = canonicalGraphJson(closedGraph);
  } catch (error) {
    fail(`graph cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const graph = JSON.parse(canonicalJson);
  if (graph.schema !== GRAPH_SCHEMA) fail(`graph schema must be ${GRAPH_SCHEMA}.`);
  const graphFailures = validateStudioGraph(graph).filter((issue) => issue.severity === 'fail');
  if (graphFailures.length) fail(`graph is invalid: ${graphFailures[0].code}.`);
  const actualGraphChecksum = graphChecksum(graph);
  if (actualGraphChecksum !== contract.graphChecksum) {
    fail('canonical graph checksum must equal the HIL contract graphChecksum.');
  }
  if (graph.id !== contract.modelId) fail('graph.id must equal the HIL contract modelId.');
  if (graph.version !== contract.modelVersion) {
    fail('graph.version must equal the HIL contract modelVersion.');
  }

  const requestedChannels = normalizeChannels(options.channels);
  assertExactChannelCoverage(requestedChannels.inputs, contract.inputs, 'inputs');
  assertExactChannelCoverage(requestedChannels.outputs, contract.outputs, 'outputs');
  const channels = {
    inputs: materializeChannelMappings(requestedChannels.inputs, contract.inputs, 'inputs'),
    outputs: materializeChannelMappings(requestedChannels.outputs, contract.outputs, 'outputs'),
  };
  const inputIds = new Set(channels.inputs.map((mapping) => mapping.channelId));
  const requestedFaults = normalizeFaults(options.faults, {
    inputChannelIds: inputIds,
    requiredFaults: contract.requiredFaults,
  });
  const faultsById = new Map(requestedFaults.map((fault) => [fault.faultId, fault]));
  const faults = contract.requiredFaults.map((faultId) => faultsById.get(faultId));

  exactKeys(options.safety, ['mode', 'trigger'], 'safety');
  if (options.safety.mode !== SAFETY_MODE) fail(`safety.mode must be ${SAFETY_MODE}.`);
  if (options.safety.trigger !== SAFETY_TRIGGER) fail(`safety.trigger must be ${SAFETY_TRIGGER}.`);
  const safeOutputs = contract.outputs.map((channel) => ({
    channelId: channel.id,
    value: channel.safeValue,
  }));
  const safety = {
    mode: SAFETY_MODE,
    trigger: SAFETY_TRIGGER,
    overrunMissesBeforeLatch: positiveSafeInteger(
      contract.overrun.maxConsecutive + 1,
      'derived safety.overrunMissesBeforeLatch',
    ),
  };

  return checkedPlan({
    schema: HIL_DEPLOYMENT_SCHEMA,
    runtimeAbi: HIL_RUNTIME_ABI,
    contractSchema: HIL_SCHEMA,
    contractChecksum: contract.checksum,
    targetId: contract.targetId,
    modelId: contract.modelId,
    modelVersion: contract.modelVersion,
    graphChecksum: actualGraphChecksum,
    graphArtifactSha256: semanticDigest(canonicalJson),
    samplePeriodUs: contract.samplePeriodUs,
    durationS: contract.durationS,
    target,
    channels,
    faults,
    safeOutputs,
    safety,
    status: PLAN_STATUS,
  });
}

/** Validate a serialized deployment plan and optionally bind a trusted digest. */
export function verifyHilDeploymentPlan(value, options = {}) {
  record(options, 'verification options');
  const unsupportedOptions = Object.keys(options)
    .filter((key) => key !== 'expectedChecksum').sort();
  if (unsupportedOptions.length) {
    fail(`verification options contains unsupported field(s): ${unsupportedOptions.join(', ')}.`);
  }
  record(value, 'plan');
  exactKeys(value, [
    'schema', 'runtimeAbi', 'contractSchema', 'contractChecksum', 'targetId', 'modelId',
    'modelVersion', 'graphChecksum', 'graphArtifactSha256', 'samplePeriodUs', 'durationS',
    'target', 'channels', 'faults', 'safeOutputs', 'safety', 'status', 'checksum',
  ], 'plan');
  const body = normalizePlanBody(value);
  const verified = checkedPlan(body);
  if (value.checksum !== verified.checksum) fail('checksum mismatch.');
  if (own(options, 'expectedChecksum')) {
    const expected = sha256(options.expectedChecksum, 'verification options.expectedChecksum');
    if (expected !== verified.checksum) fail('plan does not match the trusted expected checksum.');
  }
  return verified;
}
