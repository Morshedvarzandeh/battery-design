// knowledge.js — the who-needs-what graph. One queryable place that says
// which CONCEPTS each application actually needs, so every surface
// (training, component classes, panels) traces its visibility to an edge
// in this graph instead of ad-hoc ifs scattered through the UI. A wearable
// customer never meets rack stacks or EMS dispatch, and the reason is a
// missing edge here — inspectable, testable, and honest.
//
// Nodes: concepts. Edges: application class -> concept (with per-app
// overrides where a class is too coarse). Pure data + queries, no DOM.

import { CLASS_OF_APP, appClassOf } from './markets.js';

// The concept nodes. `label` names it for humans; `why` says what knowing
// it buys the customer.
export const CONCEPTS = {
  'duty-economics': { label: 'Duty cycle & lifetime cost', why: 'Cycles/year, DoD and cycle life set the real cost of every design.' },
  'load-profile': { label: 'Load profiles', why: 'The shape of the demand sizes the pack, not the average.' },
  'space-fill': { label: 'Space-first max fill', why: 'The bay is fixed; the design is extracted from it.' },
  'multi-objective': { label: 'Multi-objective weights & Pareto', why: 'Energy vs cost vs mass is a trade, not a formula.' },
  'integration-allowance': { label: 'Integration allowance', why: 'Real packs lose plan area to structure — calibrated against production packs.' },
  'spaces-why': { label: 'Why the spaces exist', why: 'Swelling, crash tests and vent paths are the reason for every millimetre.' },
  'seasons': { label: 'Climate & seasons', why: 'The system temperature swings with the seasons; winter changes charging.' },
  'module-tier': { label: 'Module partition', why: 'Bigger packs split into modules; the electronics follow the mechanics.' },
  'stacks-racks': { label: 'Stacks & racks (multi-pack systems)', why: 'MWh-scale systems are many packs in parallel — the tool models one.' },
  'hv-chain': { label: 'HV chain (precharge, contactors, isolation)', why: 'Above 60 V DC the switching and isolation hardware becomes mandatory.' },
  'bms-topology': { label: 'BMS topology', why: 'Centralized vs daisy chain vs wireless — each carries costs.' },
  'ems-arch': { label: 'EMS architecture', why: 'Plants with an energy management system choose centralized / hierarchical / distributed.' },
  'btms-loop': { label: 'Thermal loop & BTMS', why: 'Pumped loops, chillers and the thermal control unit — where heat is a system.' },
  'sensors-plan': { label: 'Sensor plan', why: 'What the harness must carry, by level.' },
  'release-rules': { label: 'Release rules & market checklist', why: 'What certification will demand in each target market.' },
  'report': { label: 'Report & sensitivity', why: 'The customer document, stress-tested.' },
};

// Edges: which application classes need each concept. Per-app extra edges
// (`apps`) and removals (`notApps`) refine where a class is too coarse.
// Classes: vehicle, lmt, stationary, marine, industrial, portable, auxiliary.
const ALL = ['vehicle', 'lmt', 'stationary', 'marine', 'industrial', 'portable', 'auxiliary'];
export const NEEDS = {
  'duty-economics': { classes: ALL },
  'load-profile': { classes: ALL },
  'space-fill': { classes: ALL },
  'multi-objective': { classes: ALL },
  'integration-allowance': { classes: ['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary'] },
  'spaces-why': { classes: ALL },
  'seasons': { classes: ALL },
  // Modules appear where packs outgrow one AFE — gadgets stay cell-to-pack.
  'module-tier': { classes: ['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary'] },
  // Multi-pack stacks: big systems only — a wearable NEVER needs this.
  'stacks-racks': { classes: ['vehicle', 'stationary', 'marine'], apps: ['robot'] },
  // The HV chain exists above 60 V DC — class-level approximation refined
  // by voltage at runtime where the UI has a live design.
  'hv-chain': { classes: ['vehicle', 'stationary', 'marine'], apps: [] },
  'bms-topology': { classes: ['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary'] },
  // EMS architecture: exactly the EMS-bearing applications.
  'ems-arch': { classes: [], apps: ['solar-ess', 'ups', 'ebus', 'marine', 'robot'] },
  // A thermal SYSTEM (loop + BTMS) — portable machines are air-cooled or
  // ram-air cooled; no loop, no BTMS.
  'btms-loop': { classes: ['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary'] },
  'sensors-plan': { classes: ALL },
  'release-rules': { classes: ALL },
  'report': { classes: ALL },
};

// Does this application need this concept? No app selected -> everything
// is on the table (the customer has not narrowed yet).
export function needed(appId, conceptId) {
  if (!appId) return true;
  const edge = NEEDS[conceptId];
  if (!edge) return true;
  if (edge.apps?.includes(appId)) return true;
  const cls = appClassOf(appId);
  return cls != null && edge.classes.includes(cls);
}

// Everything this application needs — the trace of "who needs what".
export function appNeeds(appId) {
  return Object.keys(CONCEPTS).filter((c) => needed(appId, c));
}

// Filter a training track's steps to the active application: steps tagged
// with a concept the application does not need are omitted entirely, and
// the numbering the customer sees stays consecutive.
export function stepsFor(track, appId) {
  return track.steps
    .filter((st) => !st.concept || needed(appId, st.concept))
    .map((st, i, arr) => ({ ...st, index: i + 1, of: arr.length }));
}

// Sanity for the tests: every class named in an edge must exist.
export const KNOWN_CLASSES = new Set([...ALL]);
export function validateGraph() {
  const errors = [];
  for (const [cid, edge] of Object.entries(NEEDS)) {
    if (!CONCEPTS[cid]) errors.push(`edge for unknown concept ${cid}`);
    for (const c of edge.classes) if (!KNOWN_CLASSES.has(c)) errors.push(`${cid}: unknown class ${c}`);
    for (const a of edge.apps || []) if (!CLASS_OF_APP[a]) errors.push(`${cid}: unknown app ${a}`);
  }
  for (const cid of Object.keys(CONCEPTS)) if (!NEEDS[cid]) errors.push(`concept ${cid} has no edge`);
  return errors;
}
