// desktop-link.js — the same interface, with the ceiling removed.
//
// The page does not know or care whether it was opened from the public site
// or served by the local runner. It asks once, at startup, whether a runner is
// answering — and if one is, the capabilities that a browser tab cannot
// reasonably compute stop being absent and start being buttons.
//
// That is the whole design: ONE interface, not a cut-down web version and a
// separate desktop program. The 3D and 2D viewers, the wizard, the training,
// the private cell library, the PDF/Word/Excel export, the bay editor — all of
// it is the same code either way. The desktop adds what it can compute, not a
// different way of working.
//
// Everything here fails soft. If no runner answers — the usual case on the
// public site — nothing appears, nothing errors, and the page behaves exactly
// as it always has.

import {
  FMI_IO_CONTRACT_CHECKSUM, materializeFmiIoMap,
} from './fmi-signal-map.js';
import { verifyFmiDesignResource } from './fmi-export-snapshot.js';
import { fmuReadme, fmuSourceC, modelDescriptionXml } from './fmi.js';

const PROBE_TIMEOUT_MS = 1500;
const TOKEN_STORAGE_KEY = 'battery-design.runner-token';
const TOKEN_HEADER = 'X-Battery-Design-Token';
const RUNNER_ID = 'battery-design-desktop-v1';

export const FMI_INSPECTION_FORMAT = 'battery-design/fmi-inspection@1';

const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

function freezeTree(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeTree(child, seen);
  return Object.freeze(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireSameJson(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new TypeError(`${label} does not match the canonical FMU resource.`);
  }
}

function requireCanonicalFiles(files, expected) {
  const actualPaths = Object.keys(files).sort();
  const expectedPaths = Object.keys(expected).sort();
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new TypeError('FMU source-kit file set does not match the canonical build.');
  }
  for (const path of expectedPaths) {
    if (typeof files[path] !== 'string' || files[path] !== expected[path]) {
      throw new TypeError(`FMU source-kit ${path} does not match canonical generated content.`);
    }
  }
}

const OPTIONAL_PORT_FIELDS = Object.freeze([
  'initial', 'displayUnit', 'start', 'min', 'max', 'exclusiveMinimum', 'greaterThan', 'nominal',
]);

function inspectPort(variable) {
  const port = {
    role: variable.role,
    name: variable.name,
    valueReference: variable.valueReference,
    type: variable.type,
    causality: variable.causality,
    variability: variable.variability,
    unit: variable.unit,
    quantity: variable.quantity,
    startPolicy: variable.startPolicy,
    sourceBinding: variable.sourceBinding,
    updateSemantics: variable.updateSemantics,
    signConvention: variable.signConvention,
  };
  for (const key of OPTIONAL_PORT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(variable, key)) port[key] = variable[key];
  }
  return port;
}

/**
 * Build the safe cross-surface inspection view used by the GUI and MCP.
 *
 * This is deliberately a projection of the two canonical resources returned
 * by buildFmu(), not another list of ports or design facts. Source files and
 * the original DesignSpec are excluded, so inspecting a mapping cannot echo
 * raw mission samples or private evidence that was evaluated during design.
 */
export function inspectFmiBuild(build) {
  requireRecord(build, 'FMU build');
  const guid = requireString(build.guid, 'FMU guid');
  const contractChecksum = requireString(build.ioContractChecksum, 'FMU I/O contract checksum');
  const snapshotChecksum = requireString(build.designSnapshotChecksum, 'FMU design snapshot checksum');
  const modelName = requireString(build.modelName, 'FMU model name');
  const generatedOn = requireString(build.generatedOn, 'FMU generation timestamp');
  const modelRevision = requireString(build.modelRevision, 'FMU model revision');
  const standardVersion = requireString(build.standardVersion, 'FMI standard version');
  const defaults = requireRecord(build.defaults, 'FMU parameter defaults');
  if (contractChecksum !== FMI_IO_CONTRACT_CHECKSUM) {
    throw new TypeError('FMU inspection contract checksum is not the canonical application contract.');
  }
  const resource = verifyFmiDesignResource(
    requireRecord(build.designResource, 'FMU design resource'),
    {
      guid,
      modelIdentifier: modelName,
      defaults,
      ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
      modelRevision,
      fmiVersion: '2.0',
      fmiStandardVersion: standardVersion,
    },
  );
  if (resource.snapshotChecksum !== snapshotChecksum) {
    throw new TypeError('FMU inspection design checksum does not match the returned snapshot checksum.');
  }
  const snapshot = resource.snapshot;
  const source = snapshot.source;
  if (build.designComplete !== source.complete) {
    throw new TypeError('FMU inspection completeness does not match the verified design resource.');
  }
  requireSameJson(build.designBinding ?? null, source.binding ?? null, 'FMU design binding');

  const ioMap = materializeFmiIoMap({
    parameterValues: defaults,
    modelName,
    modelRevision,
    guid,
    fmiStandardVersion: standardVersion,
  });
  requireSameJson(requireRecord(build.ioMap, 'FMU I/O map'), ioMap, 'FMU I/O map');

  const files = requireRecord(build.files, 'FMU source-kit files');
  const selectedCell = snapshot.cell;
  const seriesCells = snapshot.pack.seriesCells;
  const parallelCells = snapshot.pack.parallelCells;
  requireCanonicalFiles(files, {
    'modelDescription.xml': modelDescriptionXml({
      cell: selectedCell,
      s: seriesCells,
      p: parallelCells,
      defaults,
      modelName,
      guid,
      generatedOn,
    }),
    [`sources/${modelName}.c`]: fmuSourceC({ modelName, guid, defaults }),
    'resources/battery-design-io-map.json': `${JSON.stringify(ioMap, null, 2)}\n`,
    'resources/battery-design-design.json': `${JSON.stringify(resource, null, 2)}\n`,
    'README.md': fmuReadme({
      modelName,
      cell: selectedCell,
      s: seriesCells,
      p: parallelCells,
    }),
  });

  const groups = { parameters: [], inputs: [], outputs: [] };
  for (const variable of ioMap.variables) {
    requireRecord(variable, 'FMI variable');
    const port = inspectPort(variable);
    if (variable.causality === 'parameter') groups.parameters.push(port);
    else if (variable.causality === 'input') groups.inputs.push(port);
    else if (variable.causality === 'output') groups.outputs.push(port);
    else throw new TypeError(`Unsupported FMI variable causality: ${String(variable.causality)}.`);
  }

  const binding = source.binding == null ? null : requireRecord(source.binding, 'FMU design binding');
  return freezeTree({
    format: FMI_INSPECTION_FORMAT,
    identity: {
      modelName,
      guid,
      fmiStandardVersion: standardVersion,
      modelRevision,
      ioContractChecksum: contractChecksum,
      designSnapshotChecksum: snapshotChecksum,
    },
    ports: groups,
    staticDesign: {
      source: {
        kind: requireString(source.kind, 'FMU design source kind'),
        complete: source.complete === true,
        apiVersion: source.apiVersion ?? null,
        binding,
      },
      application: snapshot.application ?? null,
      cell: snapshot.cell ?? null,
      pack: snapshot.pack ?? null,
      architecture: snapshot.architecture ?? null,
      layout: snapshot.layout ?? null,
      components: snapshot.components ?? null,
    },
  });
}

// Tauri and `bd.mjs serve` open one tokenised bootstrap URL. Keep the secret
// only for this tab session, then remove it from the address bar immediately
// so reload still works without leaking it through history or referrers.
function bootstrapToken() {
  let token = null;
  let url = null;
  try {
    const href = globalThis.location?.href;
    if (href) {
      url = new URL(href);
      token = url.searchParams.get('token');
      if (token) {
        try { globalThis.sessionStorage?.setItem(TOKEN_STORAGE_KEY, token); } catch { /* session-only memory still works */ }
      }
    }
  } catch {
    // A malformed host URL cannot happen in the packaged app; fail soft if an
    // embedder supplies one.
  }
  if (token && url) {
    try {
      url.searchParams.delete('token');
      globalThis.history?.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* the token remains memory-only even if history is unavailable */ }
  }
  try { token ||= globalThis.sessionStorage?.getItem(TOKEN_STORAGE_KEY) || null; } catch { /* storage can be disabled */ }
  return token;
}

let cached = null;   // null = not asked yet, false = no runner, object = runner
let runnerToken = bootstrapToken();

/**
 * Is a local runner answering? Asked once; the answer is remembered.
 * Returns the capability list, or false.
 */
export async function detectRunner() {
  if (cached !== null) return cached;
  cached = false;
  if (!runnerToken) return cached;
  let timer;
  try {
    const ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch('/api/capabilities', {
      signal: ctl.signal,
      headers: { [TOKEN_HEADER]: runnerToken },
      credentials: 'same-origin',
    });
    if (res.ok) {
      const info = await res.json();
      // Only trust an answer that looks like ours.
      if (info?.runnerId === RUNNER_ID && info?.runner === 'battery-design desktop'
        && Array.isArray(info.capabilities)) cached = info;
    }
  } catch {
    // No runner, a timeout, or a plain static host. All the same thing: the
    // page carries on as the browser version.
  } finally {
    clearTimeout(timer);
  }
  return cached;
}

// For tests and for code that must not re-probe.
export function knownRunner() { return cached; }
export function resetRunner() { cached = null; }

async function post(path, body) {
  if (!runnerToken) throw new Error('The authenticated desktop runner is not available in this session.');
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TOKEN_HEADER]: runnerToken },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({ error: `The runner returned ${res.status}.` }));
  if (!res.ok || data.error) throw new Error(data.error || `The runner returned ${res.status}.`);
  return data;
}

/** The advanced electro-thermal model, computed by the runner. */
export const runAdvancedModel = (body) => post('/api/sim2', body);

/** Fit the model to measured data. */
export const runCalibration = (body) => post('/api/calibrate', body);

/** Search the design space across every core. */
export const runSearch = (body) => post('/api/search', body);

/** Build an FMI source-FMU kit. Returns its path-preserving files as strings. */
export const buildFmuOnRunner = (body) => post('/api/fmu', body);

/**
 * What to tell the customer, in one sentence, about where they are running.
 * Honest in both directions: the browser version is not broken, it is bounded.
 */
export function runnerStatusLine(info) {
  if (!info) {
    return {
      here: 'browser',
      text: 'Running in your browser — instant, private, nothing installed. '
        + 'The desktop GUI adds the advanced model and source-FMU export. '
        + 'Design-space search, calibration and automation are available separately through its CLI/API/MCP interfaces.',
    };
  }
  return {
    here: 'desktop',
    text: `Running on your machine across ${info.cores} core${info.cores === 1 ? '' : 's'} — `
      + `${info.capabilities.length} desktop-GUI extra${info.capabilities.length === 1 ? ' is' : 's are'} visible here: `
      + `${info.capabilities.map((c) => c.name).join(', ')}. Nothing leaves this computer.`,
  };
}
