#!/usr/bin/env node
// bd.mjs — the battery designer on your own machine.
//
// The web app is deliberately a small thing: one browser tab, instant answers,
// nothing to install. That ceiling is real, though. Searching a thousand
// designs, running a mission at one-second resolution for eight hours, or
// sweeping every cell in the library against your duty is work a browser tab
// should not be asked to do while you wait.
//
// This is the same designer with the ceiling removed. Identical modules —
// there is no second implementation to drift — driven from the command line,
// with the results written out as JSON you can keep, diff and re-run.
//
// Zero dependencies. Node 18+. Nothing leaves your machine.
//
//   node desktop/bd.mjs design --app ev --energy 60000
//   node desktop/bd.mjs sweep  --app ev --energy 60000 --vary cell
//   node desktop/bd.mjs sweep  --app ev --vary mass --from 1200 --to 2200 --step 100
//   node desktop/bd.mjs mission --app ebus --passes 6 --charge base --minutes 120
//   node desktop/bd.mjs serve  --port 8080
//   node desktop/bd.mjs apps | node desktop/bd.mjs cells --chemistry LFP

import { createReadStream, existsSync, statSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildArchitectureSemanticGraph, designFromSpec, briefFromDesign, describeOntology, listApplications, listCells, listVessels,
  resolveMarineSizing, toJsonLd, toNeo4jProjection, API_VERSION,
} from '../js/api.js';
import { CELLS } from '../js/cells.js';
import { vehicleDefaultsFor, traceForApp, driveCyclePower, rangeKm } from '../js/vehicle.js';
import { runPool, coreCount, PARALLEL_THRESHOLD } from './pool.mjs';
import { simulate, calibrate, defaultParams, PARAM_SPEC, PARAM_BY_ID } from '../js/sim2.js';
import { cellById } from '../js/cells.js';
import { profileById } from '../js/loadprofiles.js';
import { buildFmu } from '../js/fmi.js';
import {
  DESIGN_SPEC_SCHEMA_VERSION, DesignSpecValidationError, normalizeDesignSpec,
} from '../js/design-spec.js';
import { buildTopology, jointCompatibility, billOfMaterials, materialBreakdown } from '../js/topology.js';
import { wiringStudy, INSTALLATIONS } from '../js/wiring.js';
import { groundingStudy, faultFromShortCircuit } from '../js/grounding.js';
import { designBrief } from '../js/brief.js';
import { lifeCycle } from '../js/lca.js';
import { propagationStudy, BARRIERS } from '../js/runaway.js';
import { swapPlan, POLICIES as SWAP_POLICIES } from '../js/swap.js';
import { layoutPack } from '../js/pack-engine.js';
import { materialById } from '../js/materials.js';
import { ADDONS, addonsFor, addonsForSurface, capabilityReport } from '../js/addons.js';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);

// The runner is a local engineering service, not a public web server. These
// limits make that boundary explicit and keep malformed input from turning a
// desktop click into an unbounded allocation or CPU job.
const RUNNER_HOST = '127.0.0.1';
const RUNNER_ID = 'battery-design-desktop-v1';
const TOKEN_HEADER = 'x-battery-design-token';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_JSON_ITEMS = 500_000;
const MAX_PROFILE_SAMPLES = 100_000;
const MAX_CALIBRATION_SAMPLES = 10_000;
const MAX_SIM_WORK = 5_000_000;
const MAX_CALIBRATION_WORK = 2_000_000;
const MAX_RANGE_POINTS = 5_000;
const MAX_SEARCH_CANDIDATES = 5_000;
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  // The Godot showroom is a same-origin iframe. It must be embeddable by the
  // designer, but never by another origin.
  "frame-ancestors 'self'",
  "form-action 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
];

// Every shipped HTML document gets hashes for its own inline scripts. This is
// important for both the main import map and the generated Godot shell: a
// single hard-coded hash either breaks the renderer or quietly tempts a future
// change to add unsafe-inline. WebAssembly compilation is needed by both the
// Rust calculation core and Godot, while ordinary eval remains forbidden.
function contentSecurityPolicy(file = null) {
  const sources = ["'self'", "'wasm-unsafe-eval'"];
  if (file && path.extname(file).toLowerCase() === '.html') {
    const html = readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/i.test(match[1])) continue;
      const digest = createHash('sha256').update(match[2]).digest('base64');
      const source = `'sha256-${digest}'`;
      if (!sources.includes(source)) sources.push(source);
    }
  }
  return [...CSP_DIRECTIVES, `script-src ${sources.join(' ')}`].join('; ');
}

const BASE_CSP = contentSecurityPolicy();

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function boundedRange(from, to, step, { label = 'range', maxPoints = MAX_RANGE_POINTS, positive = false } = {}) {
  if (![from, to, step].every(Number.isFinite)) throw new RequestError(400, `${label}: from, to and step must be finite numbers.`);
  if (positive && (from <= 0 || to <= 0)) throw new RequestError(400, `${label}: from and to must be greater than zero.`);
  if (step === 0) throw new RequestError(400, `${label}: step must not be zero.`);
  if ((to - from) * step < 0) throw new RequestError(400, `${label}: step points away from the end of the range.`);
  const points = Math.floor(Math.abs((to - from) / step) + 1 + 1e-12);
  if (!Number.isSafeInteger(points) || points < 1 || points > maxPoints) {
    throw new RequestError(400, `${label}: ${points || 'too many'} points requested; the limit is ${maxPoints}.`);
  }
  return { from, to, step, points };
}

function rangeValues(range) {
  return Array.from({ length: range.points }, (_, index) => range.from + index * range.step);
}

function jsonComplexity(value, depth = 0) {
  if (depth > 32) throw new RequestError(400, 'JSON nesting is too deep.');
  if (Array.isArray(value)) return value.length + value.reduce((n, item) => n + jsonComplexity(item, depth + 1), 0);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length + entries.reduce((n, [, item]) => n + jsonComplexity(item, depth + 1), 0);
  }
  return 1;
}

function assertJsonWork(value) {
  if (jsonComplexity(value) > MAX_JSON_ITEMS) {
    throw new RequestError(413, `JSON contains too many values; the limit is ${MAX_JSON_ITEMS.toLocaleString()}.`);
  }
}

function finiteInRange(value, fallback, { label, min, max, integer = false }) {
  const selected = value == null ? fallback : Number(value);
  if (!Number.isFinite(selected) || selected < min || selected > max || (integer && !Number.isInteger(selected))) {
    throw new RequestError(400, `${label} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  }
  return selected;
}

function validateProfile(profile, { maxSamples = MAX_PROFILE_SAMPLES, label = 'profile' } = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new RequestError(400, `${label} must be an object.`);
  const dtS = finiteInRange(profile.dtS, null, { label: `${label}.dtS`, min: 0.001, max: 3600 });
  const values = Array.isArray(profile.w) ? profile.w : Array.isArray(profile.i) ? profile.i : null;
  if (!values?.length) throw new RequestError(400, `${label} needs a non-empty w[] or i[] series.`);
  if (values.length > maxSamples) throw new RequestError(400, `${label} has ${values.length.toLocaleString()} samples; the limit is ${maxSamples.toLocaleString()}.`);
  if (!values.every(Number.isFinite)) throw new RequestError(400, `${label} samples must all be finite numbers.`);
  return { dtS, samples: values.length };
}

function workForProfile({ dtS, samples }, maxDtS, modules = 1, repetitions = 1) {
  return samples * Math.ceil(dtS / maxDtS) * modules * repetitions;
}

function safeTokenEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- argument parsing, the smallest thing that works ------------------------
const PARSED_FLAGS = Symbol('parsedFlags');
const DUPLICATE_FLAGS = Symbol('duplicateFlags');

function parseArgs(argv) {
  const out = { _: [] };
  out[PARSED_FLAGS] = [];
  out[DUPLICATE_FLAGS] = [];
  const seenFlags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[PARSED_FLAGS].push(key);
      if (seenFlags.has(key)) out[DUPLICATE_FLAGS].push(key);
      seenFlags.add(key);
      if (next == null || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
const num = (v, fb = null) => { const n = parseFloat(v); return isFinite(n) ? n : fb; };

function specFrom(args) {
  const spec = {
    application: args.app || args.application,
    cell: args.cell,
    market: args.market,
    batteryCategory: args['battery-category'],
    evaluationDate: args['evaluation-date'],
    v2xPolicy: args.v2x,
    driveMode: args.mode,
    policyId: args.policy,
  };
  if (args.energy != null) spec.energyWh = num(args.energy);
  if (args.s != null) spec.s = num(args.s);
  if (args.p != null) spec.p = num(args.p);
  if (args.dod != null) spec.dod = num(args.dod) > 1 ? num(args.dod) / 100 : num(args.dod);
  if (args.grade != null) spec.gradePct = num(args.grade);
  if (args.profile != null) spec.profileId = args.profile;
  if (args['profile-trace'] != null) {
    if (spec.application !== 'marine') {
      console.error('--profile-trace is currently a governed marine sizing input; select --app marine.');
      process.exit(2);
    }
    const trace = loadParams(args['profile-trace']);
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
      console.error(`${args['profile-trace']}: profile trace must be one JSON object.`);
      process.exit(2);
    }
    spec.profileTrace = trace;
    if (spec.profileId == null && typeof trace.id === 'string') spec.profileId = trace.id;
  }
  const marineKeys = ['vessel', 'reference-mass', 'payload', 'design-kn', 'service-kn',
    'current-kn', 'wind-kn', 'propulsion-w', 'hotel-w', 'duration-h', 'sea',
    'twin-evidence', 'replay', 'shore-connection'];
  if (spec.application === 'marine' && marineKeys.some((key) => args[key] != null)) {
    spec.marine = {};
    if (args.vessel != null) spec.marine.vesselId = args.vessel;
    if (args['reference-mass'] != null) spec.marine.referenceMassKg = num(args['reference-mass']);
    if (args.payload != null) spec.marine.payloadKg = num(args.payload);
    if (args['design-kn'] != null) spec.marine.designSpeedKn = num(args['design-kn']);
    if (args['service-kn'] != null) spec.marine.serviceSpeedKn = num(args['service-kn']);
    if (args['current-kn'] != null) spec.marine.headCurrentKn = num(args['current-kn']);
    if (args['wind-kn'] != null) spec.marine.headwindKn = num(args['wind-kn']);
    if (args['propulsion-w'] != null) spec.marine.propulsionAtDesignW = num(args['propulsion-w']);
    if (args['hotel-w'] != null) spec.marine.hotelW = num(args['hotel-w']);
    if (args['duration-h'] != null) spec.marine.durationH = num(args['duration-h']);
    if (args.sea != null) spec.marine.seaState = args.sea;
    if (args['shore-connection'] != null) {
      const connection = loadParams(args['shore-connection']);
      if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
        console.error(`${args['shore-connection']}: shore connection must be one JSON object.`);
        process.exit(2);
      }
      spec.marine.shoreConnection = connection;
    }
    if (args['twin-evidence'] != null) {
      const evidence = loadParams(args['twin-evidence']);
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        console.error(`${args['twin-evidence']}: TwinShip evidence must be one JSON object.`);
        process.exit(2);
      }
      spec.marine.twinEvidence = evidence;
    }
    if (args.replay != null) {
      const replay = loadParams(args.replay);
      const samples = Array.isArray(replay) ? replay : replay?.samples;
      if (!Array.isArray(samples)) {
        console.error(`${args.replay}: voyage replay must be a JSON sample array or an object with a samples array.`);
        process.exit(2);
      }
      spec.marine.replaySamples = samples;
      if (!Array.isArray(replay) && replay.options && typeof replay.options === 'object') {
        spec.marine.replayOptions = replay.options;
      }
    }
  } else if (args.mass != null || args.payload != null) {
    spec.vehicle = {};
    if (args.mass != null) spec.vehicle.curbKg = num(args.mass);
    if (args.payload != null) spec.vehicle.payloadKg = num(args.payload);
  }
  if (args.passes != null || args.charge != null || args.soc != null) {
    spec.mission = {};
    if (args.passes != null) spec.mission.passes = num(args.passes);
    if (args.soc != null) spec.mission.startSoC = num(args.soc) > 1 ? num(args.soc) / 100 : num(args.soc);
    if (args.charge != null) {
      spec.mission.charge = {
        mode: args.charge === true ? 'base' : args.charge,
        powerW: num(args.chargeW, 11000),
        minutes: num(args.minutes, 60),
      };
    }
  }
  for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
  return spec;
}

// A persisted DesignSpec is the complete design input. Mixing it with legacy
// design flags would create an order-dependent merge, so fail closed instead.
// Export-only flags such as --out, --name and --params remain valid alongside
// --spec.
const FMU_SPEC_CONFLICT_FLAGS = Object.freeze([
  'app', 'application', 'cell', 'market', 'battery-category', 'evaluation-date',
  'v2x', 'mode', 'policy', 'energy', 's', 'p', 'dod', 'grade', 'profile',
  'profile-trace', 'vessel', 'reference-mass', 'payload', 'design-kn',
  'service-kn', 'current-kn', 'wind-kn', 'propulsion-w', 'hotel-w',
  'duration-h', 'sea', 'twin-evidence', 'replay', 'shore-connection', 'mass',
  'passes', 'charge', 'soc', 'chargeW', 'minutes',
]);
const FMU_EXPORT_FLAGS = Object.freeze(['spec', 'out', 'name', 'params']);
const FMU_ALLOWED_FLAGS = new Set([...FMU_EXPORT_FLAGS, ...FMU_SPEC_CONFLICT_FLAGS]);

function fmuSpecFrom(args) {
  const unknown = args[PARSED_FLAGS].filter((key) => !FMU_ALLOWED_FLAGS.has(key));
  if (unknown.length) {
    throw new TypeError(`fmu does not accept option(s): ${[...new Set(unknown)]
      .map((key) => `--${key}`).join(', ')}.`);
  }
  const unexpectedPositionals = args._.slice(1);
  if (unexpectedPositionals.length) {
    throw new TypeError(`fmu does not accept positional arguments: ${unexpectedPositionals.join(', ')}.`);
  }
  if (args[DUPLICATE_FLAGS].length) {
    throw new TypeError(`fmu option(s) may be supplied only once: ${[...new Set(args[DUPLICATE_FLAGS])]
      .map((key) => `--${key}`).join(', ')}.`);
  }
  if (args.spec == null) return specFrom(args);
  const conflicts = FMU_SPEC_CONFLICT_FLAGS.filter((key) => args[key] != null);
  if (conflicts.length) {
    throw new TypeError(`--spec cannot be combined with design-shaping flags: ${conflicts.map((key) => `--${key}`).join(', ')}.`);
  }
  return loadDesignSpec(args.spec);
}

function emit(args, data, humanLines) {
  if (args.json || args.out) {
    const text = JSON.stringify(data, null, 2);
    if (args.out) { writeFileSync(args.out, text); console.log(`Written: ${args.out}`); }
    else console.log(text);
    return;
  }
  console.log(humanLines);
}

// --- commands ---------------------------------------------------------------
const COMMANDS = {
  design(args) {
    const d = designFromSpec(specFrom(args));
    emit(args, d, briefFromDesign(d));
  },

  ontology(args) {
    if (args.catalog) {
      const catalog = describeOntology();
      return emit(args, catalog,
        `battery-design ontology ${catalog.ontology.version}: ${catalog.classes.length} classes, ${catalog.relations.length} relations, ${catalog.units.length} units, ${catalog.architectureModules.length} architecture modules and ${catalog.shapes.length} validation shapes.`);
    }
    const architectureOnly = args.architecture === true;
    const design = architectureOnly ? null : designFromSpec(specFrom(args));
    const graph = architectureOnly ? buildArchitectureSemanticGraph() : design.semantics.graph;
    const format = args.format || 'summary';
    const data = format === 'jsonld' ? toJsonLd(graph)
      : format === 'neo4j' ? toNeo4jProjection(graph)
        : architectureOnly ? graph : design.semantics;
    if (architectureOnly) {
      return emit(args, data, [
        `battery-design architecture graph — ontology ${graph.ontology.version}`,
        `${graph.nodes.length} typed entities · ${graph.edges.length} relations`,
        `Validation: ${graph.validation.conforms ? 'conforms' : 'INVALID'}`,
        `Graph checksum: ${graph.checksum}`,
      ].join('\n'));
    }
    const missing = design.semantics.unresolvedEvidence.map((item) => `  · ${item.label}`);
    return emit(args, data, [
      `${design.application?.name || 'Custom design'} semantic graph — ontology ${design.semantics.ontology.version}`,
      `${design.semantics.counts.nodes} typed entities · ${design.semantics.counts.edges} relations · ${design.semantics.counts.modelRuns} model runs`,
      `Validation: ${design.semantics.conforms ? 'conforms' : 'INVALID'} · feasibility ${design.semantics.feasibility} · evidence ${design.semantics.evidenceMaturity}`,
      ...(missing.length ? ['Unresolved evidence:', ...missing] : ['Unresolved evidence: none declared by the calculation-ready profile']),
      `Graph checksum: ${design.semantics.ontology.checksum}`,
    ].join('\n'));
  },

  // Everything the browser should not do while you wait: change one thing at
  // a time across a range and report what it did to the answers that matter.
  async sweep(args) {
    const base = specFrom(args);
    const vary = args.vary || 'cell';
    const jobs = [];
    const add = (value, spec) => jobs.push({ index: jobs.length, variable: vary, value, spec });
    if (vary === 'cell') {
      // Every cell in the library, on the same duty, sized to the same energy.
      const pool = args.chemistry ? CELLS.filter((c) => c.chemistry === args.chemistry) : CELLS;
      for (const c of pool) add(c.id, { ...base, cell: c.id });
    } else if (vary === 'mass' || vary === 'payload') {
      const from = num(args.from, 1000), to = num(args.to, 2500), step = num(args.step, 100);
      const field = vary === 'mass' ? 'curbKg' : 'payloadKg';
      const range = boundedRange(from, to, step, { label: `${vary} sweep` });
      for (const v of rangeValues(range)) add(v, { ...base, vehicle: { ...(base.vehicle || {}), [field]: v } });
    } else if (vary === 'energy') {
      const from = num(args.from, 10000), to = num(args.to, 100000), step = num(args.step, 10000);
      const range = boundedRange(from, to, step, { label: 'energy sweep', positive: true });
      for (const v of rangeValues(range)) add(v, { ...base, energyWh: v });
    } else {
      console.error(`Unknown --vary "${vary}". Supported: cell, mass, payload, energy.`);
      process.exit(2);
    }
    const t0 = Date.now();
    const { rows, workers, mode } = await runPool(jobs, { jobs: args.jobs != null ? num(args.jobs) : null });
    const ms = Date.now() - t0;
    if (vary === 'cell') rows.sort((a, b) => (a.usdPerKWhDelivered ?? 1e9) - (b.usdPerKWhDelivered ?? 1e9));
    const table = [
      `Sweep over ${vary} — ${rows.length} designs, same duty, same application`
      + `  [${ms} ms, ${mode}${mode === 'parallel' ? ` on ${workers} threads` : ''}]`,
      pad('value', 26) + pad('kWh', 9) + pad('kg', 8) + pad('$/kWh del.', 12) + pad('Wh/km', 9) + pad('range km', 10) + 'audit',
      ...rows.map((r) => r.error
        ? pad(String(r.value), 26) + `error: ${r.error}`
        : pad(String(r.value), 26) + pad(r.kWh?.toFixed(2), 9) + pad(r.massKg?.toFixed(1), 8)
          + pad(r.usdPerKWhDelivered != null ? r.usdPerKWhDelivered.toFixed(3) : '—', 12)
          + pad(r.whPerKm != null ? r.whPerKm.toFixed(1) : '—', 9)
          + pad(r.rangeKm != null ? Math.round(r.rangeKm) : '—', 10)
          + `${r.fails} fail / ${r.warns} warn`),
    ].join('\n');
    emit(args, { apiVersion: API_VERSION, sweep: vary, rows }, table);
  },

  mission(args) {
    const spec = specFrom(args);
    spec.mission = spec.mission || {};
    if (spec.mission.passes == null) spec.mission.passes = 3;
    const d = designFromSpec(spec);
    if (!d.simulation) { console.error('No load profile for this application.'); process.exit(2); }
    const s = d.simulation.summary;
    const lines = [
      briefFromDesign(d), '',
      `Mission detail (${d.simulation.profile.name}, ${spec.mission.passes} passes)`,
      `  SoC        ${Math.round(s.startSoC * 100)}% → ${Math.round(s.endSoC * 100)}% (minimum ${Math.round(s.minSoC * 100)}%)`,
      `  Energy     ${s.energyOutWh.toFixed(0)} Wh out, ${s.energyInWh.toFixed(0)} Wh recovered, ${s.lossWh.toFixed(0)} Wh lost (${s.efficiencyPct.toFixed(1)}% efficient)`,
      `  Thermal    modeled peak ${s.maxT?.toFixed(1)} °C (cell limit ${s.tempMaxC?.toFixed(1)} °C), ${s.peakHeatW.toFixed(0)} W peak heat, ${s.avgHeatW.toFixed(0)} W average`,
      `  Voltage    ${s.vMinPack.toFixed(1)}–${s.vMaxPack.toFixed(1)} V`,
      ...(s.unmetWh > 0 ? [`  UNMET      ${s.unmetWh.toFixed(0)} Wh — the pack ran out before the mission ended`] : []),
      ...(s.chargedWh > 0 ? [`  Charged    ${s.chargedWh.toFixed(0)} Wh accepted${s.chargeRefusedWh > 0 ? `, ${s.chargeRefusedWh.toFixed(0)} Wh refused (too cold)` : ''}`] : []),
      '', 'Assumptions:', ...d.simulation.assumptions.map((a) => `  · ${a}`),
    ];
    emit(args, d, lines.join('\n'));
  },

  // A drive-cycle study at full resolution: what mass and driving style cost,
  // across the whole range, in one pass.
  range(args) {
    const appId = args.app || 'ev';
    const veh = vehicleDefaultsFor(appId);
    if (!veh) { console.error(`"${appId}" is not a machine that drives.`); process.exit(2); }
    const trace = traceForApp(appId);
    const energyWh = num(args.energy, 60000);
    const dod = num(args.dod, 0.8) > 1 ? num(args.dod) / 100 : num(args.dod, 0.8);
    const packMassKg = num(args.packmass, energyWh / 1000 * 6); // ~6 kg/kWh pack class
    const from = num(args.from, veh.curbKg), to = num(args.to, veh.curbKg + 800), step = num(args.step, 100);
    const rows = [];
    const range = boundedRange(from, to, step, { label: 'mass range' });
    for (const m of rangeValues(range)) {
      for (const mode of ['eco', 'normal', 'sport']) {
        const r = driveCyclePower({ trace, vehicle: { ...veh, curbKg: m }, mode, packMassKg });
        rows.push({
          curbKg: m, mode, whPerKm: r.whPerKm, peakKW: r.peakW / 1000,
          rangeKm: rangeKm({ energyWh, dod, whPerKm: r.whPerKm }),
        });
      }
    }
    const table = [
      `Range study — ${appId}, ${(energyWh / 1000).toFixed(1)} kWh pack at ${Math.round(dod * 100)}% DoD, ${trace.name}`,
      pad('curb kg', 10) + pad('mode', 9) + pad('Wh/km', 9) + pad('peak kW', 10) + 'range km',
      ...rows.map((r) => pad(r.curbKg, 10) + pad(r.mode, 9) + pad(r.whPerKm.toFixed(1), 9)
        + pad(r.peakKW.toFixed(1), 10) + Math.round(r.rangeKm)),
      '', trace.note,
    ].join('\n');
    emit(args, { apiVersion: API_VERSION, application: appId, energyWh, dod, rows }, table);
  },

  // The job the desktop tier exists for: not one design, but the whole space
  // of them. Every cell against every energy target, each one fully worked —
  // geometry, architecture, thermal, audit, cost, mission — then ranked by
  // what you actually care about. Thousands of complete designs, which is
  // where using all the cores stops being a nicety.
  async search(args) {
    const base = specFrom(args);
    const pool = args.chemistry ? CELLS.filter((c) => c.chemistry === args.chemistry) : CELLS;
    const from = num(args.from, 20000), to = num(args.to, 100000), step = num(args.step, 2000);
    const energyRange = boundedRange(from, to, step, {
      label: 'design-search energy range', maxPoints: MAX_SEARCH_CANDIDATES, positive: true,
    });
    const candidateCount = pool.length * energyRange.points;
    if (candidateCount > MAX_SEARCH_CANDIDATES) {
      throw new RequestError(400, `Design search requests ${candidateCount.toLocaleString()} candidates; the limit is ${MAX_SEARCH_CANDIDATES.toLocaleString()}. Narrow the energy range or chemistry.`);
    }
    const jobs = [];
    for (const c of pool) {
      for (const e of rangeValues(energyRange)) {
        jobs.push({
          index: jobs.length, variable: 'cell×energy',
          value: `${c.id} @ ${(e / 1000).toFixed(0)} kWh`,
          meta: { targetWh: e },
          spec: { ...base, cell: c.id, energyWh: e },
        });
      }
    }
    const rank = args.rank || 'cost';
    const KEYS = {
      cost: ['usdPerKWhDelivered', 1, '$/kWh delivered'],
      range: ['rangeKm', -1, 'range km'],
      mass: ['massKg', 1, 'kg'],
      density: ['whPerKg', -1, 'Wh/kg'],
      upfront: ['upfrontUSD', 1, '$ upfront'],
    };
    if (!KEYS[rank]) { console.error(`Unknown --rank "${rank}". Supported: ${Object.keys(KEYS).join(', ')}.`); process.exit(2); }
    const [key, dir, unit] = KEYS[rank];
    console.error(`Searching ${jobs.length.toLocaleString()} complete designs (${pool.length} cells × ${energyRange.points} energy targets) on ${coreCount()} cores…`);
    const t0 = Date.now();
    const { rows, workers, mode } = await runPool(jobs, { jobs: args.jobs != null ? num(args.jobs) : null });
    const ms = Date.now() - t0;
    const ok = rows.filter((r) => !r.error && r[key] != null);
    // A pack is built from whole cells, so it lands NEAR a target, never on
    // it. But a 302 Ah cell asked for 20 kWh returns 120 kWh — one series
    // string already overshoots — and ranking that as the cheapest design is
    // meaningless: it is not the pack anyone asked for. Designs that miss the
    // target by more than the tolerance are excluded and counted, because
    // "this cell cannot build a pack that small at this voltage" is a real
    // answer worth seeing.
    const tol = num(args.tol, 0.2);
    const onTarget = ok.filter((r) => r.targetWh > 0 && Math.abs(r.kWh * 1000 - r.targetWh) / r.targetWh <= tol);
    const missed = ok.length - onTarget.length;
    // A design with a FAIL finding is not a candidate, whatever it scores.
    const scored = args.all ? onTarget : onTarget.filter((r) => r.fails === 0);
    scored.sort((a, b) => (a[key] - b[key]) * dir);
    // Neighbouring targets round to the SAME whole-cell pack, so an
    // undeduplicated top-10 is often one design listed ten times. Keep the
    // first (best-ranked) instance of each distinct pack, so "top 10" means
    // ten different answers.
    const seen = new Set();
    const viable = scored.filter((r) => {
      const id = `${r.cell}|${r.cellCount}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const top = viable.slice(0, num(args.top, 12));
    const table = [
      `Design search — ${rows.length.toLocaleString()} designs in ${(ms / 1000).toFixed(1)} s `
      + `(${mode}${mode === 'parallel' ? `, ${workers} threads` : ''}, ${(ms / rows.length).toFixed(2)} ms each)`,
      `${missed.toLocaleString()} missed their energy target by more than ${Math.round(tol * 100)}% (whole cells only — the cell is too big or too small for that target)`,
      `${viable.length.toLocaleString()} distinct viable packs${args.all ? '' : ' (designs with a FAIL finding excluded — --all to include)'} — best ${rank} first:`,
      '',
      pad('cell', 30) + pad('cells', 8) + pad('kWh', 8) + pad('kg', 8) + pad(unit, 16) + 'audit',
      ...top.map((r) => pad(r.cell.slice(0, 29), 30) + pad(r.cellCount, 8)
        + pad(r.kWh?.toFixed(1), 8) + pad(r.massKg?.toFixed(1), 8)
        + pad(typeof r[key] === 'number' ? (r[key] < 10 ? r[key].toFixed(3) : Math.round(r[key])) : '—', 16)
        + `${r.fails} fail / ${r.warns} warn`),
      ...(top.length ? [] : ['', 'Nothing met the target within tolerance. Widen it with --tol 0.4, or check the energy range.']),
    ].join('\n');
    emit(args, {
      apiVersion: API_VERSION, rank, searched: rows.length, missedTarget: missed,
      viable: viable.length, tolerance: tol, ms, workers, rows: top,
    }, table);
  },

  // The level-2 model: every coefficient exposed, nothing hard-coded behind
  // the user's back.
  sim2(args) {
    const spec = specFrom(args);
    const d = designFromSpec(spec);
    const cell = cellById(d.cell.id);
    const params = args.params ? loadParams(args.params) : null;
    // Drive it with the vehicle's own physics where there is a vehicle,
    // otherwise the application's load profile.
    let profile;
    if (d.vehicle) {
      const veh = { ...vehicleDefaultsFor(spec.application), ...(spec.vehicle || {}) };
      const drive = driveCyclePower({ trace: traceForApp(spec.application), vehicle: veh, mode: spec.driveMode || 'normal', packMassKg: d.pack.massKg });
      profile = { dtS: drive.dtS, w: drive.w };
    } else if (d.marine) {
      const resolved = resolveMarineSizing(spec);
      profile = { dtS: resolved.profile.dtS, w: resolved.profile.p.map((x) => x * resolved.scaleW) };
    } else if (d.simulation) {
      const pr = profileById(d.simulation.profile.id);
      const scale = num(args.scale, d.pack.maxContPowerW);
      profile = { dtS: pr.dtS, w: pr.p.map((x) => x * scale) };
    } else { console.error('No load profile for this application — give --profile or --scale.'); process.exit(2); }
    const r = simulate({
      cell, s: d.pack.s, p: d.pack.p, params, profile,
      startSoC: num(args.soc, 1) > 1 ? num(args.soc) / 100 : num(args.soc, 1),
      ambientC: num(args.ambient, 25), nModules: num(args.modules, 4),
      years: num(args.years, spec.targetYears ?? 8), cyclesPerYear: num(args.cycles, spec.cyclesPerYear ?? 250),
    });
    const q = r.summary;
    const resolvedProfile = {
      profileId: d.spec.resolved.sizing.profileId,
      policyId: d.spec.resolved.sizing.policyId,
      traceIdentity: d.spec.resolved.sizing.traceIdentity,
      scaleW: d.spec.resolved.sizing.scaleW,
      dtS: profile.dtS,
      samples: profile.w.length,
      durationS: profile.dtS * profile.w.length,
    };
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}, ${(d.pack.energyWh / 1000).toFixed(1)} kWh, ${q.nModules} modules`,
      '',
      'Electrical',
      `  SoC          ${(q.startSoC * 100).toFixed(0)}% → ${(q.endSoC * 100).toFixed(1)}% (minimum ${(q.minSoC * 100).toFixed(1)}%)`,
      `  Voltage      minimum ${q.minV.toFixed(1)} V under load`,
      `  Energy       ${q.energyOutWh.toFixed(0)} Wh out, ${q.energyInWh.toFixed(0)} Wh recovered, ${q.lossWh.toFixed(0)} Wh lost (${q.efficiencyPct?.toFixed(1)}% efficient)`,
      ...(q.unmetWh > 0 ? [`  UNMET        ${q.unmetWh.toFixed(0)} Wh — the pack could not follow the demand`] : []),
      '',
      'Thermal',
      `  Peak module  ${q.maxTempC.toFixed(1)} °C`,
      `  Spread       ${q.tempSpreadK.toFixed(2)} K between hottest and coldest module`,
      `  Coolant      out at ${q.coolantOutC.toFixed(1)} °C`,
      `  Reversible   ${q.reversibleHeatWh.toFixed(1)} Wh of entropic heat (negative = the pack cooled itself)`,
      '',
      'Aging',
      ...(r.aging.schedule.length
        ? [...r.aging.schedule.filter((x) => x.year % Math.max(1, Math.round(r.aging.schedule.length / 5)) === 0 || x.year === 1)
          .map((x) => `  year ${String(x.year).padStart(2)}      ${x.remainingPct.toFixed(1)}% capacity, +${x.resistanceGrowthPct.toFixed(1)}% resistance`),
        `  reaches 80% ${r.aging.yearsTo80Pct ? `in year ${r.aging.yearsTo80Pct}` : 'beyond the horizon simulated'}`]
        : ['  (give --years and --cycles for an aging estimate)']),
      '',
      ...(r.findings.length ? ['Findings', ...r.findings.map((f) => `  ${f.severity.toUpperCase()}: ${f.title} — ${f.detail}`), ''] : []),
      'Assumptions',
      ...r.assumptions.map((a) => `  · ${a}`),
      ...(r.paramNotes.length ? ['', 'Parameters adjusted:', ...r.paramNotes.map((n) => `  · ${n}`)] : []),
    ];
    emit(args, {
      apiVersion: API_VERSION,
      design: { cell: d.cell.id, s: d.pack.s, p: d.pack.p },
      ...r,
      profile: resolvedProfile,
    }, lines.join('\n'));
  },

  // Correct the model against your own measurements. This is the command
  // that turns a class-typical model into a model of YOUR cell.
  calibrate(args) {
    if (!args.data) { console.error('Give --data FILE.csv with columns: time_s,current_A,voltage_V[,temp_C]'); process.exit(2); }
    const measured = readMeasuredCsv(args.data);
    const cell = cellById(args.cell || 'samsung-inr21700-50e');
    if (!cell) { console.error(`Unknown cell "${args.cell}". Use: cells`); process.exit(2); }
    const fit = (args.fit === true || !args.fit ? 'r0Ref,rc1R,rc1TauS' : args.fit).split(',').map((x) => x.trim());
    const unknown = fit.filter((f) => !PARAM_BY_ID[f]);
    if (unknown.length) { console.error(`Not parameters: ${unknown.join(', ')}. Run: params`); process.exit(2); }
    const out = calibrate({
      cell, s: num(args.s, 1), p: num(args.p, 1), measured,
      params: args.params ? loadParams(args.params) : null,
      fit, startSoC: num(args.soc, 1) > 1 ? num(args.soc) / 100 : num(args.soc, 1),
      ambientC: num(args.ambient, 25), nModules: num(args.modules, 1),
      maxIter: num(args.iter, 300),
    });
    const lines = [
      `Calibrated ${cell.name} against ${measured.i.length} measured points (${args.data})`,
      `  RMSE ${out.rmseBefore.toFixed(4)} V → ${out.rmseAfter.toFixed(4)} V  (${out.improvementPct.toFixed(1)}% closer, ${out.iterations} iterations)`,
      '',
      pad('parameter', 14) + pad('default', 12) + pad('fitted', 12) + pad('change', 12) + 'unit',
      ...Object.entries(out.fitted).map(([k, f]) => pad(k, 14) + pad(f.from?.toFixed(3), 12) + pad(f.to?.toFixed(3), 12)
        + pad(f.changedPct != null ? `${f.changedPct > 0 ? '+' : ''}${f.changedPct.toFixed(1)}%` : '—', 12)
        + f.unit + (f.atBound ? '   ← AT ITS LIMIT' : '')),
      '',
      out.note,
      '',
      `Save these with --out params.json, then use them everywhere: sim2 --params params.json`,
    ];
    emit(args, { apiVersion: API_VERSION, cell: cell.id, ...out }, lines.join('\n'));
  },

  // Every knob, what it means, and what it is allowed to be.
  params(args) {
    const cell = args.cell ? cellById(args.cell) : null;
    const defs = defaultParams(cell);
    if (args.json || args.out) { emit(args, defs, ''); return; }
    let group = null;
    const lines = [`Model parameters${cell ? ` for ${cell.name}` : ' (generic defaults)'} — every one of these is yours to change:`];
    for (const s of PARAM_SPEC) {
      if (s.group !== group) { group = s.group; lines.push('', group.toUpperCase()); }
      lines.push(`  ${pad(s.id, 17)}${pad(defs[s.id], 11)}${pad(s.unit, 26)}${s.min}…${s.max}`);
      lines.push(`  ${' '.repeat(17)}${s.why}`);
      lines.push(`  ${' '.repeat(17)}source: ${s.source}`);
    }
    lines.push('', 'Dump them with --json --out params.json, edit, then: sim2 --params params.json');
    lines.push('Or let your own measurements set them: calibrate --data test.csv --fit r0Ref,rc1R,rc1TauS');
    console.log(lines.join('\n'));
  },

  // Export the source-FMU build kit. It becomes a loadable FMI 2.0 component
  // only after the target-platform binary is compiled and the tree packaged.
  fmu(args) {
    const spec = fmuSpecFrom(args);
    const d = designFromSpec(spec);
    if (args.spec != null) assertGovernedDesignResolved(d, args.spec);
    const cell = cellById(d.cell.id);
    const dir = args.out === true || !args.out ? './fmu' : args.out;
    const buildOptions = {
      params: args.params ? loadParams(args.params) : null,
      modelName: args.name || 'BatteryPack',
    };
    const built = args.spec != null
      ? buildFmu({ ...buildOptions, design: d })
      : buildFmu({ ...buildOptions, cell, s: d.pack.s, p: d.pack.p });
    for (const [rel, content] of Object.entries(built.files)) {
      const full = path.join(dir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    console.log([
      `FMI 2.0 source-FMU build kit for ${d.pack.s}S${d.pack.p}P ${cell.name}`,
      `  written to ${dir}/`,
      ...Object.keys(built.files).map((f) => `    ${f}`),
      `  model ${built.modelName}, guid ${built.guid}`,
      `  design snapshot ${built.designSnapshotChecksum} (${built.designComplete ? 'complete design binding' : 'legacy incomplete provenance'})`,
      ...built.parameterWarnings.map((warning) => `  warning: ${warning}`),
      '',
      built.note,
      `Compile and package it with the commands in ${dir}/README.md, then validate the resulting .fmu in your host tool.`,
    ].join('\n'));
  },

  // What can this thing do? Including what it cannot do yet.
  addons(args) {
    const rep = capabilityReport(args.app || null);
    if (args.json || args.out) { emit(args, rep, ''); return; }
    const line = (a) => `  ${a.status === 'shipped' ? '✓' : '·'} ${pad(a.id, 19)}${a.name}`
      + `\n      ${a.what}`
      + (a.status === 'planned' ? `\n      NOT BUILT YET — ${a.why}` : '');
    const relevant = (surface) => addonsForSurface(surface, { appId: args.app || null })
      .filter((addon) => rep.addons.includes(addon));
    console.log([
      rep.note, '',
      'CORE — always present', ...rep.addons.filter((a) => a.tier === 'core').map(line), '',
      'BROWSER GUI', ...[...new Set([
        ...rep.addons.filter((a) => a.tier === 'browser'), ...relevant('browser-gui'),
      ])].map(line), '',
      'DESKTOP GUI EXTRAS', ...relevant('desktop-gui').map(line), '',
      'CLI', ...relevant('cli').map(line), '',
      'MCP / AUTOMATION', ...relevant('mcp').map(line), '',
      'LOCAL API (not a visible button)', ...relevant('local-api').map(line), '',
      'PLANNED — not shipped', ...relevant('planned').map(line),
      ...(rep.notRelevant.length ? ['', `NOT FOR THIS APPLICATION: ${rep.notRelevant.map((a) => a.id).join(', ')}`] : []),
    ].join('\n'));
  },

  // Wiring, joints and the bill of materials the customer receives.
  bom(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({
      summary: d.pack, partition: d.architecture.partition, cellForm: cell.form,
      busbarMaterial: args.busbar, cableMaterial: args.cable || 'copper',
      plating: args.plating || 'tin',
      lengths: {
        groupPitchMm: num(args.pitch), moduleRunMm: num(args.modrun), packRunMm: num(args.packrun),
      },
    });
    const env = args.env || 'normal';
    const joints = jointCompatibility(topo, env);
    const failing = joints.filter((j) => !j.risk.ok);
    const bom = billOfMaterials({ topology: topo, summary: d.pack, cell, selection: {} });
    // The temperature limit is what the SURROUNDINGS tolerate, not what the
    // copper survives. Beside cells that is the cell's own upper discharge
    // temperature, which the library already knows — so the default is the
    // right number without anyone being asked for it.
    const maxTempC = num(args.maxtemp) ?? cell.tempDischargeC?.[1] ?? 90;
    const install = args.install || 'free-air';
    const study = wiringStudy({
      topology: topo, packV: d.pack.nominalV, ambientC: num(args.ambient, 25),
      installation: install, maxTempC, dropLimitPct: num(args.droplimit, 2),
    });
    const t = topo.totals;
    const w = study.totals;
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}`,
      '',
      'WIRING',
      `  Interconnect      ${t.interconnectMOhm.toFixed(2)} mΩ total through ${topo.edges.length} runs`,
      `  At ${Math.round(d.pack.maxContCurrentA)} A continuous   ${w.seriesDropV.toFixed(2)} V dropped, ${w.totalHeatW.toFixed(0)} W lost in the conductors`,
      `  Conductor mass    ${t.conductorMassKg.toFixed(2)} kg`,
      ...(topo.estimated ? [`  NOTE  ${topo.notes[0]}`] : []),
      '',
      `CONDUCTOR SIZING (${(INSTALLATIONS[install]?.name || install).toLowerCase()}, ${maxTempC} °C limit, ${num(args.ambient, 25)} °C ambient)`,
      `  ${study.headline}`,
      `  ${w.runsChecked} runs checked · ${w.failing} undersized · ${w.costly} hot or dropping voltage`,
      ...(study.findings.length
        ? study.findings.map((f) => `  ${f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '!' : 'i'} ${f.title}\n${wrap(f.detail, 6)}`)
        : ['  ✓ Every conductor stays inside the limit on both the rule of thumb and the heat balance.']),
      '',
      `JOINTS (${env} environment)`,
      `  ${joints.length} joints, ${failing.length} needing attention`,
      ...failing.slice(0, 4).map((j) => `  ✗ ${j.id}: ${j.risk.why}`),
      ...(failing.length === 0 ? ['  ✓ Every joint is galvanically compatible in this environment.'] : []),
      '',
      'BILL OF MATERIALS',
      pad('  group', 14) + pad('item', 34) + pad('qty', 9) + pad('mass kg', 10) + 'cost',
      ...bom.lines.map((l) => pad('  ' + l.group, 14) + pad(l.item.slice(0, 32), 34)
        + pad(`${l.qty} ${l.unit}`, 9) + pad(l.massKg != null ? l.massKg.toFixed(2) : '—', 10)
        + (l.totalCost != null ? `$${Math.round(l.totalCost).toLocaleString()}` : '—')),
      `  ${'-'.repeat(60)}`,
      pad('  TOTAL', 48) + pad(bom.totals.massKg.toFixed(1), 10) + `$${Math.round(bom.totals.knownCost).toLocaleString()} of ${bom.totals.pricedLines} priced lines`,
      '',
      `  ${bom.note}`,
    ];
    emit(args, {
      apiVersion: API_VERSION,
      topology: { totals: topo.totals, estimated: topo.estimated },
      wiring: { verdict: study.verdict, totals: study.totals, findings: study.findings, assumptions: study.assumptions, runs: study.runs },
      joints, bom,
    }, lines.join('\n'));
  },

  // Bonding: what happens after isolation has already failed.
  ground(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({
      summary: d.pack, partition: d.architecture.partition, cellForm: cell.form,
      busbarMaterial: args.busbar, cableMaterial: args.cable || 'copper',
    });
    // The fault current comes from the short-circuit study the design already
    // ran. Asking for it twice would let the two answers drift apart.
    const fault = faultFromShortCircuit(d.shortCircuit) || {};
    const study = groundingStudy({
      topology: topo, application: d.spec?.application || args.app,
      packVMax: d.pack.vMax, isolation: d.architecture?.isolation,
      faultA: num(args.fault) ?? fault.faultA,
      clearingS: num(args.clearing) ?? fault.clearingS,
      faultBasis: fault.basis,
      finish: args.finish || 'bare',
      method: args.bond || 'bolt-serrated',
      strapMaterial: args.strap || 'copper',
      bonds: args.strapmm2 || args.straplen
        ? [{
          id: 'bond-enclosure', from: 'Pack enclosure', to: 'Chassis / vehicle earth',
          materialId: args.strap || 'copper',
          lengthMm: num(args.straplen, 250), areaMm2: num(args.strapmm2, 16),
          finish: args.finish || 'bare', method: args.bond || 'bolt-serrated',
        }]
        : null,
    });
    const iso = d.architecture?.isolation;
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}, ${d.pack.vMax.toFixed(0)} V max`,
      '',
      'ISOLATION — keeping fault current off the case',
      ...(iso
        ? [`  ${iso.floorKOhm.toFixed(0)} kΩ floor at ${iso.ohmsPerVolt} Ω/V (${iso.standardLabel})`,
          `  ${wrap(iso.oemPracticeNote, 2).trimStart()}`]
        : ['  Below 60 V DC — no isolation-monitoring burden.']),
      '',
      'BONDING — what happens when isolation has already failed',
      `  ${wrap(study.headline, 2).trimStart()}`,
      study.ungrounded
        ? `  ${plural(study.totals.pathsChecked, 'path')} measured, against a rule that does not govern this machine`
        : `  ${plural(study.totals.pathsChecked, 'path')} checked · ${study.totals.failing} inadequate · ${study.totals.costly} marginal`,
      ...(study.findings.length
        ? study.findings.map((f) => `  ${f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '!' : 'i'} ${f.title}\n${wrap(f.detail, 6)}`)
        : ['  ✓ Every bonding path is inside the limit and survives the fault.']),
      '',
      'PATHS',
      pad('  id', 20) + pad('material', 24) + pad('mΩ', 9) + pad('touch V', 10) + 'verdict',
      ...study.paths.map((b) => pad('  ' + b.id, 20)
        + pad((materialById(b.materialId)?.name || b.materialId).slice(0, 22), 24)
        + pad((b.resistanceOhm * 1000).toFixed(2), 9)
        + pad(b.touchV != null ? b.touchV.toFixed(1) : '—', 10) + b.verdict),
      '',
      'ASSUMPTIONS',
      ...study.assumptions.map((a) => bullet(a)),
    ];
    emit(args, { apiVersion: API_VERSION, isolation: iso || null, grounding: study }, lines.join('\n'));
  },

  // Everything the tool knows about one design, in one prioritised list —
  // including the wiring and grounding studies the browser tier does not run.
  brief(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cell.form });
    const wiring = wiringStudy({
      topology: topo, packV: d.pack.nominalV, ambientC: num(args.ambient, 25),
      installation: args.install || 'free-air',
      maxTempC: num(args.maxtemp) ?? cell.tempDischargeC?.[1] ?? 90,
    });
    const fault = faultFromShortCircuit(d.shortCircuit) || {};
    const grounding = groundingStudy({
      topology: topo, application: d.spec?.application || args.app, packVMax: d.pack.vMax,
      isolation: d.architecture?.isolation,
      faultA: fault.faultA, clearingS: fault.clearingS, faultBasis: fault.basis,
      finish: args.finish || 'bare', method: args.bond || 'bolt-serrated',
    });
    const b = designBrief(d, { wiring, grounding });
    const mark = { fail: '✗', warn: '!', info: 'i', pass: '✓' };
    const show = num(args.top, 12);
    const lines = [
      `${b.pack.application || 'Custom'} — ${b.pack.s}S${b.pack.p}P ${b.pack.cell}, ${(b.pack.energyWh / 1000).toFixed(1)} kWh`,
      '',
      wrap(b.headline),
      `${b.counts.fail} must fix · ${b.counts.warn} worth knowing · ${b.counts.info} noted · ${b.counts.total} checks reported`,
      '',
      `WHAT MATTERS, IN ORDER${b.counts.total > show ? ` (top ${show} of ${b.counts.total})` : ''}`,
      ...b.findings.slice(0, show).flatMap((f) => [
        `  ${mark[f.severity] || '·'} ${f.title}   [${f.sources.join(' + ')}${f.ref ? ` · ${f.ref}` : ''}]`,
        wrap(f.detail, 6),
      ]),
      '',
      'WHAT WOULD CHANGE THE ANSWER — questions for you',
      ...(b.questions.length
        ? b.questions.flatMap((q) => [`  ? ${q.asks}`, wrap(q.why, 6), wrap(`→ ${q.how}`, 6)])
        : ['  Nothing material is being guessed.']),
      '',
      'NOT CHECKED',
      ...b.notChecked.map((n) => bullet(n)),
    ];
    emit(args, { apiVersion: API_VERSION, brief: b }, lines.join('\n'));
  },

  // The whole footprint, with an honest account of how well each part is known.
  lca(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cell.form });
    const r = lifeCycle({
      pack: d.pack, cell, topology: topo, application: d.spec?.application || args.app,
      gridGPerKWh: num(args.grid, 440), chargeGPerKWh: num(args.chargegrid),
      dod: d.spec?.dod ?? 0.8, roundTripEff: num(args.rte, 0.92),
    });
    const t = r.totals;
    const kg = (v) => (v == null ? 'not estimated' : `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(0)} kg`);
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}, ${r.capacityKWh.toFixed(1)} kWh`,
      '',
      wrap(r.headline),
      '',
      'BY PHASE',
      pad('  phase', 30) + pad('kg CO2e', 15) + pad('share of build', 16) + 'how well known',
      ...r.phases.map((p) => pad('  ' + p.name, 30) + pad(kg(p.kgCO2e), 15)
        + pad(p.shareOfMaterials != null ? `${(p.shareOfMaterials * 100).toFixed(1)}%` : '—', 16)
        + p.quality.label),
      `  ${'-'.repeat(70)}`,
      pad('  TO BUILD (cradle to gate)', 30) + pad(kg(t.cradleToGateKg), 15)
        + `${t.gateLowKg.toFixed(0)}–${t.gateHighKg.toFixed(0)} kg on the spread of the factors`,
      pad('  WHOLE LIFE', 30) + pad(kg(t.totalKg), 15) + `${t.lowKg.toFixed(0)}–${t.highKg.toFixed(0)} kg`,
      '',
      `  ${t.kgPerKWhCapacity.toFixed(0)} kg CO2e per kWh of capacity`
        + (t.gPerKWhDelivered != null ? ` · ${t.gPerKWhDelivered.toFixed(0)} g CO2e per kWh delivered over life` : ''),
      ...(t.unknownPhases.length ? [`  NOT ESTIMATED: ${t.unknownPhases.join(', ')}`] : []),
      '',
      `HOW TO COMPARE THE ENERGY IT DELIVERS — ${r.basis.name}`,
      wrap(r.basis.what, 2),
      wrap(`You need: ${r.basis.needs}`, 2),
      '',
      'WHAT THIS TELLS YOU',
      ...r.findings.map((f) => `  ${f.severity === 'warn' ? '!' : 'i'} ${f.title}\n${wrap(f.detail, 6)}`),
      '',
      'ASSUMPTIONS',
      ...r.assumptions.map((a) => bullet(a)),
    ];
    emit(args, { apiVersion: API_VERSION, lca: r }, lines.join('\n'));
  },

  // Propagation: a COMPARISON of options, never a clearance.
  runaway(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const layout = layoutPack(cell, d.pack.s, d.pack.p, { spacingMm: num(args.gap, 1) });
    if (!layout) { console.error('This cell and pack do not lay out.'); process.exit(2); }
    const st = propagationStudy({
      layout, cell, barrier: args.barrier || 'none',
      barrierThicknessMm: num(args.barriermm, 0.5),
      soc: num(args.soc, 1), ambientC: num(args.ambient, 25),
      interconnectWK: num(args.bridge, 0.02),
    });
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}, ${cell.chemistry}`,
      '',
      'WHAT THIS CAN AND CANNOT TELL YOU',
      wrap('This counts conduction, radiation and the interconnect. Hot gas, burning electrolyte and ejecta — which carry most of a real event — are not modelled, so it UNDER-predicts propagation and can never clear a design. Use the ranking; ignore the absolute numbers.', 2),
      '',
      `BARRIER OPTIONS ON THIS GEOMETRY (${st.coupling.gapMm.toFixed(1)} mm gap, ${st.modelled} cells)`,
      pad('  option', 26) + pad('margin to onset', 18) + pad('neighbour peak', 17) + 'radiation',
      ...st.ranked.map((r) => pad('  ' + r.label, 26)
        + pad(`${r.marginK.toFixed(0)} K`, 18)
        + pad(`${r.peakNeighbourC.toFixed(0)} °C`, 17)
        + (r.radiates ? 'NOT blocked' : 'blocked')),
      '',
      wrap(st.headline, 2),
      '',
      'WHAT YOU MUST CONTAIN',
      wrap(st.containment.note, 2),
      '',
      'FINDINGS',
      ...st.findings.map((f) => `  ${f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '!' : 'i'} ${f.title}\n${wrap(f.detail, 6)}`),
      '',
      'ASSUMPTIONS',
      ...st.assumptions.map((a) => bullet(a)),
    ];
    emit(args, { apiVersion: API_VERSION, runaway: st }, lines.join('\n'));
  },

  // Swappability as a policy that cuts across every application.
  swap(args) {
    const d = designFromSpec(specFrom(args));
    const r = swapPlan({
      policy: args.policy || 'swappable', pack: d.pack,
      application: d.spec?.application || args.app,
      handling: args.handling || null,
      runHours: num(args.runh), chargeHours: num(args.chargeh),
      machines: num(args.machines, 1), swapsPerDay: num(args.swaps, 2),
      years: num(args.years, 10), connectorRatedCycles: num(args.cycles, 5000),
    });
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P, ${d.pack.massKg.toFixed(1)} kg`,
      '',
      `POLICY — ${r.policy.name}`,
      wrap(r.policy.what, 2),
      '',
      wrap(r.headline, 2),
      ...(r.swappable ? [
        '',
        `PARTS THE FIXED VERSION DOES NOT NEED (${r.parts.length})`,
        ...r.parts.map((p) => `  · ${p.name}\n${wrap(p.why, 6)}`),
        '',
        'FLEET',
        wrap(r.fleet.why, 2),
        '',
        'CONNECTOR',
        wrap(r.connector.why, 2),
      ] : []),
      '',
      'FINDINGS',
      ...(r.findings.length
        ? r.findings.map((f) => `  ${f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '!' : 'i'} ${f.title}\n${wrap(f.detail, 6)}`)
        : ['  ✓ Nothing to flag.']),
      '',
      'ASSUMPTIONS',
      ...r.assumptions.map((a) => bullet(a)),
    ];
    emit(args, { apiVersion: API_VERSION, swap: r }, lines.join('\n'));
  },

  apps(args) {
    const list = listApplications();
    emit(args, list, list.map((a) =>
      `${pad(a.id, 14)}${pad(a.class, 12)}${pad((a.typicalEnergyWh / 1000).toFixed(1) + ' kWh', 11)}${a.name}`).join('\n'));
  },

  vessels(args) {
    const list = listVessels();
    emit(args, list, list.map((vessel) =>
      `${pad(vessel.id, 24)}${pad(vessel.dimensionsM.length + ' m', 10)}${pad(vessel.dimensionsM.beam + ' m', 10)}${vessel.name}\n  Default PMS: ${vessel.policyId}. ${vessel.boundary}`).join('\n'));
  },

  cells(args) {
    const list = listCells({ chemistry: args.chemistry, form: args.form });
    emit(args, list, list.map((c) =>
      `${pad(c.id, 30)}${pad(c.chemistry, 8)}${pad(c.form, 13)}${pad(c.energyWh.toFixed(1) + ' Wh', 10)}${c.priceUSD != null ? '$' + c.priceUSD : '—'}`).join('\n'));
  },

  // The web UI, served from your own machine — offline, no CDN, no telemetry.
  serve(args) {
    const port = finiteInRange(args.port, 8080, { label: 'port', min: 0, max: 65535, integer: true });
    if (port > 0 && port < 1024) {
      throw new RequestError(400, 'port must be 0 (automatic) or between 1024 and 65535.');
    }
    if (args.token === true) throw new RequestError(400, '--token needs a value.');
    const token = args.token == null ? randomBytes(32).toString('base64url') : String(args.token);
    if (token.length < 32 || token.length > 256) {
      throw new RequestError(400, '--token must contain between 32 and 256 characters. Omit it to generate a secure token.');
    }
    const MIME = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
      '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
      '.wasm': 'application/wasm', '.pck': 'application/octet-stream',
      '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
    };
    let boundPort = port;
    const server = createServer((req, res) => {
      const commonHeaders = {
        'content-security-policy': BASE_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'x-battery-design-runner': RUNNER_ID,
      };
      const write = (code, headers = {}) => res.writeHead(code, { ...commonHeaders, ...headers });
      const json = (code, obj) => {
        if (res.headersSent) return;
        const payload = JSON.stringify(obj);
        write(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(payload);
      };
      let requestTimedOut = false;
      req.setTimeout(10_000, () => {
        requestTimedOut = true;
        json(408, { error: 'Request timed out before its body was received.' });
        req.resume();
      });
      let requestUrl;
      let url;
      try {
        requestUrl = new URL(req.url || '/', `http://${RUNNER_HOST}:${boundPort}`);
        url = decodeURIComponent(requestUrl.pathname);
        if (url.includes('\0')) throw new URIError('NUL byte');
      } catch {
        return json(400, { error: 'Malformed request URL.' });
      }

      const expectedHost = `${RUNNER_HOST}:${boundPort}`;
      if (req.headers.host !== expectedHost) {
        return json(421, { error: 'Request host does not match this loopback runner.' });
      }

      const isApi = url === '/api' || url.startsWith('/api/');
      if (isApi) {
        const expectedOrigin = `http://${expectedHost}`;
        if (req.headers.origin && req.headers.origin !== expectedOrigin) {
          return json(403, { error: 'This local API accepts requests only from its own desktop window.' });
        }
        if (!safeTokenEqual(req.headers[TOKEN_HEADER], token)) {
          return json(401, { error: 'Missing or invalid desktop runner token.' });
        }
      }

      // Read a JSON body, then hand it to a handler. Every desktop endpoint
      // answers with either a result or a readable reason — never a stack.
      const withBody = (handler) => {
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json') return json(415, { error: 'Expected application/json.' });
        const chunks = [];
        let bytes = 0;
        let rejected = false;
        req.on('data', (chunk) => {
          if (rejected || requestTimedOut) return;
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            rejected = true;
            chunks.length = 0;
            json(413, { error: `Request body exceeds the ${MAX_BODY_BYTES / 1024 / 1024} MiB limit.` });
            req.resume();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (rejected || requestTimedOut) return;
          req.setTimeout(0); // body is complete; bounded compute may legitimately take longer
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            assertJsonWork(body);
            Promise.resolve(handler(body))
              .then((result) => json(200, result))
              .catch((error) => json(error.status || 400, { error: error.message }));
          } catch (error) {
            json(error.status || 400, { error: error.message });
          }
        });
        req.on('error', () => json(400, { error: 'Could not read the request body.' }));
      };

      // The page asks this first. Its answer is what turns the desktop
      // capabilities on in the interface: same UI, ceiling removed.
      if (url === '/api/capabilities' && req.method === 'GET') {
        const guiCapabilities = addonsForSurface('desktop-gui');
        const cliCapabilities = addonsForSurface('cli');
        const mcpCapabilities = addonsForSurface('mcp');
        return json(200, {
          runner: 'battery-design desktop', runnerId: RUNNER_ID, apiVersion: API_VERSION,
          cores: coreCount(),
          capabilities: guiCapabilities
            .map((a) => ({ id: a.id, name: a.name, what: a.what })),
          cliCapabilities: cliCapabilities.map((a) => ({ id: a.id, name: a.name })),
          mcpCapabilities: mcpCapabilities.map((a) => ({ id: a.id, name: a.name })),
          plannedCapabilities: addonsForSurface('planned').map((a) => ({ id: a.id, name: a.name })),
          endpoints: ['/api/design', '/api/ontology', '/api/sim2', '/api/calibrate', '/api/search', '/api/fmu'],
        });
      }
      if (url === '/api/ontology' && req.method === 'GET') return json(200, describeOntology());
      if (url === '/api/design' && req.method === 'POST') return withBody((spec) => designFromSpec(spec));

      // The advanced electro-thermal model — the one the browser cannot
      // reasonably run, now reachable from the same panel it belongs in.
      if (url === '/api/sim2' && req.method === 'POST') {
        return withBody((body) => {
          const d = designFromSpec(body.spec || {});
          const cell = cellById(d.cell.id);
          // Where the load comes from, in order of how much it knows:
          // what the caller sent, then the vehicle's own physics, then the
          // application's characteristic profile. Only if all three are
          // absent is there genuinely nothing to simulate.
          const prof = body.profile || (() => {
            const app = d.spec.resolved.application;
            const veh = vehicleDefaultsFor(app);
            if (veh) {
              const drive = driveCyclePower({
                trace: traceForApp(app), vehicle: veh,
                mode: body.driveMode || 'normal', packMassKg: d.pack.massKg,
              });
              return { dtS: drive.dtS, w: drive.w };
            }
            if (d.marine) {
              const resolved = resolveMarineSizing(body.spec || {});
              return {
                dtS: resolved.profile.dtS,
                w: resolved.profile.p.map((x) => x * resolved.scaleW),
              };
            }
            if (d.simulation?.profile?.id) {
              const pr = profileById(d.simulation.profile.id);
              if (pr) {
                const scale = body.scaleW || d.pack.maxContPowerW || 1000;
                return { dtS: pr.dtS, w: pr.p.map((x) => x * scale) };
              }
            }
            throw new Error('Nothing to simulate: pick an application on the Usage tab, or send a profile of your own.');
          })();
          const profileMetrics = validateProfile(prof);
          const nModules = finiteInRange(body.nModules, 4, { label: 'nModules', min: 1, max: 64, integer: true });
          const maxDtS = finiteInRange(body.params?.maxDtS, defaultParams(cell).maxDtS, {
            label: 'params.maxDtS', min: 0.001, max: 60,
          });
          const work = workForProfile(profileMetrics, maxDtS, nModules);
          if (work > MAX_SIM_WORK) {
            throw new RequestError(400, `Simulation requests ${work.toLocaleString()} integration-module steps; the limit is ${MAX_SIM_WORK.toLocaleString()}. Shorten/downsample the profile or increase maxDtS.`);
          }
          const r = simulate({
            cell, s: d.pack.s, p: d.pack.p, params: body.params || null, profile: prof,
            startSoC: body.startSoC ?? 1, ambientC: body.ambientC ?? 25,
            nModules,
            years: finiteInRange(body.years, 8, { label: 'years', min: 0, max: 100 }),
            cyclesPerYear: finiteInRange(body.cyclesPerYear, 250, { label: 'cyclesPerYear', min: 0, max: 5000 }),
          });
          // The full series would be megabytes over the wire for no gain.
          return {
            ...r,
            series: undefined,
            seriesLength: r.series.t.length,
            profile: {
              profileId: d.spec.resolved.sizing.profileId,
              policyId: d.spec.resolved.sizing.policyId,
              traceIdentity: d.spec.resolved.sizing.traceIdentity,
              scaleW: d.spec.resolved.sizing.scaleW,
              dtS: prof.dtS,
              samples: prof.w?.length ?? prof.i?.length ?? 0,
              durationS: prof.dtS * (prof.w?.length ?? prof.i?.length ?? 0),
            },
          };
        });
      }

      // Correct the model against measured data, from the browser.
      if (url === '/api/calibrate' && req.method === 'POST') {
        return withBody((body) => {
          const cell = cellById(body.cell) || cellById('samsung-inr21700-50e');
          const measuredMetrics = validateProfile(
            { dtS: body.measured?.dtS, i: body.measured?.i },
            { maxSamples: MAX_CALIBRATION_SAMPLES, label: 'measured' },
          );
          for (const key of ['v', 't']) {
            const values = body.measured?.[key];
            if (key === 't' && values == null) continue;
            if (!Array.isArray(values) || values.length !== measuredMetrics.samples || !values.every(Number.isFinite)) {
              throw new RequestError(400, `measured.${key} must contain ${measuredMetrics.samples.toLocaleString()} finite samples.`);
            }
          }
          if (body.fit != null && (!Array.isArray(body.fit) || body.fit.length < 1 || body.fit.length > 8)) {
            throw new RequestError(400, 'fit must contain between 1 and 8 parameter names.');
          }
          const nModules = finiteInRange(body.nModules, 1, { label: 'nModules', min: 1, max: 64, integer: true });
          const maxIter = finiteInRange(body.maxIter, 100, { label: 'maxIter', min: 1, max: 300, integer: true });
          const maxDtS = finiteInRange(body.params?.maxDtS, defaultParams(cell).maxDtS, {
            label: 'params.maxDtS', min: 0.001, max: 60,
          });
          const work = workForProfile(measuredMetrics, maxDtS, nModules, maxIter);
          if (work > MAX_CALIBRATION_WORK) {
            throw new RequestError(400, `Calibration requests ${work.toLocaleString()} integration-module iterations; the limit is ${MAX_CALIBRATION_WORK.toLocaleString()}. Downsample the data or reduce maxIter.`);
          }
          return calibrate({
            cell, s: body.s ?? 1, p: body.p ?? 1, measured: body.measured,
            params: body.params || null, fit: body.fit || ['r0Ref', 'rc1R', 'rc1TauS'],
            startSoC: body.startSoC ?? 1, ambientC: body.ambientC ?? 25,
            nModules, maxIter,
          });
        });
      }

      // Design-space search across every core.
      if (url === '/api/search' && req.method === 'POST') {
        return withBody(async (body) => {
          const pool = body.chemistry ? CELLS.filter((c) => c.chemistry === body.chemistry) : CELLS;
          const range = boundedRange(
            Number(body.from ?? 20000), Number(body.to ?? 100000), Number(body.step ?? 5000),
            { label: 'design-search energy range', maxPoints: MAX_SEARCH_CANDIDATES, positive: true },
          );
          const candidateCount = pool.length * range.points;
          if (candidateCount > MAX_SEARCH_CANDIDATES) {
            throw new RequestError(400, `Design search requests ${candidateCount.toLocaleString()} candidates; the limit is ${MAX_SEARCH_CANDIDATES.toLocaleString()}. Narrow the range or chemistry.`);
          }
          const jobs = [];
          for (const c of pool) {
            for (const energyWh of rangeValues(range)) {
              jobs.push({
                index: jobs.length, variable: 'cell×energy', value: `${c.id} @ ${(energyWh / 1000).toFixed(0)} kWh`,
                meta: { targetWh: energyWh }, spec: { ...(body.spec || {}), cell: c.id, energyWh },
              });
            }
          }
          const { rows, workers, mode } = await runPool(jobs);
          return { searched: rows.length, workers, mode, rows: rows.filter((row) => !row.error) };
        });
      }

      // Co-simulation source-kit export: path-preserving files the page serializes for download.
      if (url === '/api/fmu' && req.method === 'POST') {
        return withBody((body) => {
          const request = validateFmuRequestEnvelope(body);
          const label = 'FMU request body.spec';
          const spec = normalizeGovernedDesignSpec(request.spec, label);
          const d = designFromSpec(spec);
          assertGovernedDesignResolved(d, label);
          return buildFmu({ design: d, params: request.params ?? null,
            modelName: request.modelName ?? 'BatteryPack' });
        });
      }
      if (isApi) {
        if (['GET', 'POST'].includes(req.method || '')) return json(404, { error: 'Unknown desktop API endpoint.' });
        return json(405, { error: 'Method not allowed.' });
      }
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        write(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
      }

      const pathname = url === '/' ? '/index.html' : url;
      // Backslashes are ordinary URL characters on POSIX but path separators
      // on Windows. Treat both forms identically so an encoded `\\.git\\`
      // cannot bypass the hidden-segment rule in a future Windows package.
      if (pathname.split(/[\\/]/).some((segment) => segment.startsWith('.'))) {
        write(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      let file = path.resolve(REAL_ROOT, `.${pathname}`);
      let relative = path.relative(REAL_ROOT, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        write(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
        file = realpathSync(file);
        relative = path.relative(REAL_ROOT, file);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !statSync(file).isFile()) throw new RequestError(403, 'Forbidden');
      } catch (error) {
        const status = error.status || (existsSync(file) ? 403 : 404);
        write(status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(status === 403 ? 'Forbidden' : 'Not found');
        return;
      }
      write(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
        'content-security-policy': contentSecurityPolicy(file),
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    server.listen(port, RUNNER_HOST, () => {
      const address = server.address();
      boundPort = typeof address === 'object' && address ? address.port : port;
      const launchUrl = `http://${RUNNER_HOST}:${boundPort}/index.html?token=${encodeURIComponent(token)}`;
      console.log(`Battery designer running at ${launchUrl}`);
      console.log('Desktop GUI extras: '
        + addonsForSurface('desktop-gui').map((a) => a.name).join(', ') + '.');
      console.log('Additional CLI/MCP capabilities are listed by: node desktop/bd.mjs addons');
      console.log(`Using ${coreCount()} cores. Offline, on your machine. Nothing is sent anywhere. Ctrl-C to stop.`);
    });
  },

  help() { console.log(HELP); },
};

const pad = (v, n) => String(v ?? '—').padEnd(n);

// Findings are written as prose because that is what makes them readable.
// Prose in a terminal needs wrapping, or it becomes one line that scrolls.
function wrap(text, indent = 0, width = 92) {
  const pre = ' '.repeat(indent);
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && (line.length + 1 + word.length) > width - indent) { out.push(pre + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(pre + line);
  return out.join('\n');
}

// A wrapped bullet, with its continuation lines indented past the marker so
// the eye can tell one item from the next.
const bullet = (text, indent = 2) => {
  const body = wrap(text, indent + 2);
  return `${' '.repeat(indent)}· ${body.slice(indent + 2)}`;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A parameter file is plain JSON: dump it, edit it in any editor, hand it back.
function loadParams(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Could not read parameters from ${file}: ${e.message}`);
    process.exit(2);
  }
}

const FMU_REQUEST_KEYS = new Set(['spec', 'params', 'modelName']);

function validateFmuRequestEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('FMU request body must be one JSON object.');
  }
  const unsupported = Object.keys(body).filter((key) => !FMU_REQUEST_KEYS.has(key));
  if (unsupported.length) {
    throw new TypeError(`FMU request body contains unsupported field(s): ${unsupported.join(', ')}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'spec')) {
    throw new TypeError('FMU request body must contain spec.');
  }
  return body;
}

function normalizeGovernedDesignSpec(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label}: DesignSpec must be one JSON object.`);
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'schemaVersion')) {
    throw new TypeError(
      `${label}: DesignSpec must declare schemaVersion ${DESIGN_SPEC_SCHEMA_VERSION}.`,
    );
  }
  try {
    return normalizeDesignSpec(input, { strict: true, closed: true });
  } catch (error) {
    if (error instanceof DesignSpecValidationError) {
      throw new TypeError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

function assertGovernedDesignResolved(design, label) {
  if (design.warnings.length) {
    throw new TypeError(
      `${label}: governed DesignSpec did not resolve exactly: ${design.warnings.join(' ')}`,
    );
  }
}

function loadDesignSpec(file) {
  if (typeof file !== 'string' || !file) {
    throw new TypeError('--spec requires a DesignSpec JSON file path.');
  }
  let input;
  try {
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new TypeError(`Could not read DesignSpec from ${file}: ${error.message}`);
  }
  return normalizeGovernedDesignSpec(input, file);
}

// Measured data: time_s, current_A, voltage_V and optionally temp_C. Header
// optional, comma or semicolon or tab, because real exports vary.
function readMeasuredCsv(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(2); }
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/[,;\t]/).map((x) => parseFloat(x)))
    .filter((r) => r.length >= 3 && r.every((x, i) => i > 3 || isFinite(x)));
  if (rows.length < 3) { console.error(`${file}: need at least 3 rows of time_s,current_A,voltage_V`); process.exit(2); }
  const dtS = rows.length > 1 ? (rows[1][0] - rows[0][0]) : 1;
  if (!(dtS > 0)) { console.error(`${file}: the time column must increase.`); process.exit(2); }
  return {
    dtS,
    i: rows.map((r) => r[1]),
    v: rows.map((r) => r[2]),
    t: rows.every((r) => isFinite(r[3])) ? rows.map((r) => r[3]) : null,
  };
}

const HELP = `battery-design — desktop runner (API v${API_VERSION})

  design    one design, fully worked           --app ev --energy 60000 [--cell ID] [--s N --p N]
  ontology  semantic trace or export            --app marine [--format summary|jsonld|neo4j] [--json]
            complete architecture graph         --architecture [--format summary|jsonld|neo4j] [--json]
            vocabulary catalog                  --catalog [--json]
  mission   the design driven through time     --app ebus --passes 6 [--charge base --minutes 120]
  sim2      the full model: RC dynamics,       --app ev [--modules 8] [--ambient 35] [--params p.json]
            entropic heat, per-module
            temperatures, coolant, aging
  calibrate correct the model against YOUR     --data test.csv --cell ID [--fit r0Ref,rc1R,rc1TauS]
            measurements
  params    every coefficient, with bounds     [--cell ID] [--json --out params.json]
  sweep     one variable across a range        --vary cell|mass|payload|energy [--from --to --step]
  search    the whole design space, ranked     --app ev --rank cost|range|mass|density|upfront [--top N]
  range     drive-cycle study, mass × mode     --app ev --energy 60000 [--from --to --step]
  fmu       export an FMI 2.0 source-FMU kit   --spec design-spec.json [--out ./fmu]
                                                  (legacy --app/--energy flags remain supported)
  addons    what this tool can do, and cannot   [--app ev]
  bom       every conductor sized, every       --app ev [--install bundled] [--env harsh]
            joint checked, and the bill of     [--modrun 300 --packrun 400 --pitch 25]
            materials you hand over
  brief     every check in one ordered list,   --app ev --energy 60000 [--top 20]
            plus what the tool is guessing
  lca       the whole footprint by phase, and   --app ev --energy 60000 [--grid 250]
            how well each part is known
  runaway   compare barriers and spacing, and    --app ev [--barrier mica] [--gap 2]
            size what you must contain
  swap      fixed / swappable / hot-swappable    --app ebike --policy swappable
            as a policy, with the fleet maths     [--runh 3 --chargeh 4 --machines 20]
  ground    isolation, bonding paths and       --app ev [--finish anodised] [--bond bolt-plain]
            whether the bond survives the      [--strap aluminium --strapmm2 25]
            fault it exists for
  apps      the application presets
  vessels   the two NTNU Vessel Twin models
  cells     the cell library                   [--chemistry LFP] [--form cylindrical]
  serve     the web UI from your own machine   [--port 8080] [--token SECRET]

Common flags
  --app ID          application preset (see: apps)          --market eu|us|cn|intl
  --battery-category ev|lmt|industrial|portable|sli        --evaluation-date YYYY-MM-DD
  --cell ID         cell from the library (see: cells)      --v2x off|v2l|v2h|v2g
  --energy WH       energy target                           --mode eco|normal|sport
  --policy ID       EMS/PMS operating goal (grid/marine)
  --vessel ID       NTNU vessel (see: vessels)             --service-kn KN --duration-h H
  --current-kn KN   head current sensitivity               --wind-kn KN --sea calm|moderate|rough
  --propulsion-w W  published/supplied design-point power  --hotel-w W --reference-mass KG
  --twin-evidence FILE  governed TwinShip evidence JSON    --replay FILE aligned replay JSON
  --profile-trace FILE  governed normalized marine trace JSON (id, dtS, p[], scaleW)
  --shore-connection FILE  governed marine shore equipment/evidence JSON
  --s N --p N       explicit series/parallel                --mass KG --payload KG
  --dod 0.8         usable depth of discharge               --grade PCT   route gradient
  --profile ID      profile, or "vehicle" for physics       --soc 0.9     mission start SoC
  --json            machine-readable output                 --out FILE    write JSON to a file
  --jobs N          worker threads (default: every core)     --top N       how many results to show
  --chemistry LFP   restrict a sweep or search              --all         include designs that FAIL the audit

Wiring flags (bom)
  --install free-air|bundled|potted|plate-bonded   how the runs are installed; it changes
                                                   how hot they get more than anything else
  --modrun MM --packrun MM --pitch MM              REAL run lengths. Without them the tool
                                                   estimates from the pack envelope and says so
  --maxtemp C       temperature limit (default: the cell's own upper discharge rating)
  --ambient C       ambient the runs sit in (default 25)   --droplimit PCT  voltage budget (default 2)
  --busbar ID --cable ID --plating ID              conductor and plating materials
  --env harsh|normal|dry                           environment for the galvanic check

Grounding flags (ground)
  --finish bare|conversion-coated|anodised|painted  the enclosure surface the bond lands on.
                                                    Anodised and painted do not conduct
  --bond bolt-plain|bolt-serrated|welded|strap-bolted   what makes the connection. Only a
                                                    serrated washer or a weld cuts a coating
  --strap ID --strapmm2 MM2 --straplen MM          the bonding strap itself
  --fault A --clearing S                           override the fault current and clearing
                                                    time (default: from the short-circuit study)

Big runs use every core. Small ones stay on one thread on purpose: starting a
worker costs more than the few designs it would have saved. Serial and
parallel runs return identical rows.

The serve command binds only to 127.0.0.1. It generates a per-launch API token
and prints the private URL; --token is reserved for the packaged app and tests.
Everything runs locally. No network, no account, no telemetry.`;

// --- entry ------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';
const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`Unknown command "${cmd}".\n`);
  console.log(HELP);
  process.exit(2);
}
// Some commands fan out across worker threads and are therefore async. User
// input errors stay readable and never dump an implementation stack.
try {
  await fn(args);
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 2;
}
