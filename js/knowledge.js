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
import { CONCEPT_APPLICABILITY, CONCEPT_DEFINITIONS } from './ontology-schema.js';

// The architecture ontology owns the canonical concept identifiers, labels
// and applicability edges. These aliases preserve the established knowledge
// API while making UI visibility, API discovery and semantic export query the
// same declarations.
export const CONCEPTS = CONCEPT_DEFINITIONS;
export const NEEDS = CONCEPT_APPLICABILITY;

// The knowledge graph also owns the choices shown by Sizing. Data modules
// describe profiles, policies and driving modes; only this graph decides
// which of them an application is allowed to expose and which is the default.
export const SIZING_OPTIONS = {
  'load-profile': {
    ebike: { default: 'ebike-assist', options: ['ebike-assist'] },
    escooter: { default: 'escooter-urban', options: ['escooter-urban'] },
    drone: { default: 'drone-mission', options: ['drone-mission'] },
    powertool: { default: 'powertool-bursts', options: ['powertool-bursts'] },
    'solar-ess': { default: 'grid-site-net-day', options: ['grid-site-net-day'] },
    rv: { default: 'rv-house', options: ['rv-house', 'grid-site-net-day'] },
    ev: { default: 'wltp-ev', options: ['wltp-ev', 'ebus-route'] },
    ebus: { default: 'ebus-route', options: ['ebus-route'] },
    robot: { default: 'robot-shift', options: ['robot-shift'] },
    humanoid: { default: 'humanoid-locomotion', options: ['humanoid-locomotion', 'robot-shift'] },
    cyberdog: { default: 'quadruped-patrol', options: ['quadruped-patrol'] },
    wearable: { default: 'wearable-day', options: ['wearable-day'] },
    robovac: { default: 'robovac-clean', options: ['robovac-clean', 'robot-shift'] },
    ups: { default: 'ups-standby', options: ['ups-standby', 'powerstation-trip'] },
    powerstation: { default: 'powerstation-trip', options: ['powerstation-trip', 'grid-site-net-day'] },
    marine: { default: 'marine-vessel-duty', options: ['marine-vessel-duty'] },
  },
  'energy-policy': {
    'solar-ess': {
      default: 'grid-self-consumption',
      options: ['grid-self-consumption', 'grid-peak-shaving', 'grid-load-shifting'],
    },
    marine: {
      default: 'marine-full-electric',
      options: [
        'marine-full-electric', 'marine-load-levelling', 'marine-boost',
        'marine-spinning-reserve', 'marine-peak-shaving',
        'marine-load-smoothing', 'marine-ramp-support',
      ],
    },
  },
  'driving-mode': {
    ev: { default: 'normal', options: ['eco', 'normal', 'sport'] },
    ebus: { default: 'normal', options: ['eco', 'normal', 'sport'] },
    ebike: { default: 'normal', options: ['eco', 'normal', 'sport'] },
    escooter: { default: 'normal', options: ['eco', 'normal', 'sport'] },
    robot: { default: 'normal', options: ['eco', 'normal', 'sport'] },
  },
};

export function sizingOptionsFor(appId, conceptId) {
  const entry = SIZING_OPTIONS[conceptId]?.[appId];
  return entry ? [...entry.options] : [];
}

export function defaultSizingOption(appId, conceptId) {
  return SIZING_OPTIONS[conceptId]?.[appId]?.default || null;
}

// The one decision presented on the simple Sizing page. Policies take
// precedence over driving modes; otherwise the customer chooses a duty.
export function primarySizingDecision(appId) {
  if (sizingOptionsFor(appId, 'energy-policy').length) return 'energy-policy';
  if (sizingOptionsFor(appId, 'driving-mode').length) return 'driving-mode';
  return 'load-profile';
}

export function sizingInputsForApp(appId) {
  return [
    ...(needed(appId, 'route-road') ? ['route'] : []),
    ...(needed(appId, 'hull-resistance') ? ['voyage', 'sea-conditions'] : []),
    ...(needed(appId, 'flight-weather') ? ['flight-mission', 'flight-weather'] : []),
    ...(needed(appId, 'payload') ? ['payload'] : []),
    ...(needed(appId, 'round-trip-efficiency') ? ['round-trip-efficiency'] : []),
    ...(sizingOptionsFor(appId, 'driving-mode').length ? ['driving-mode'] : []),
    ...(sizingOptionsFor(appId, 'energy-policy').length ? ['operating-goal'] : []),
  ];
}

// Does this application need this concept? No app selected -> everything
// is on the table (the customer has not narrowed yet).
export function needed(appId, conceptId) {
  if (!CONCEPTS[conceptId]) {
    throw new RangeError(`Unknown design concept "${conceptId}". Register it in the ontology before using it.`);
  }
  if (!appId) return true;
  const edge = NEEDS[conceptId];
  if (!edge) throw new RangeError(`Design concept "${conceptId}" has no applicability relation.`);
  if (edge.notApps?.includes(appId)) return false;
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
export const KNOWN_CLASSES = new Set(Object.values(CLASS_OF_APP));
export function validateGraph() {
  const errors = [];
  for (const [cid, edge] of Object.entries(NEEDS)) {
    if (!CONCEPTS[cid]) errors.push(`edge for unknown concept ${cid}`);
    for (const c of edge.classes) if (!KNOWN_CLASSES.has(c)) errors.push(`${cid}: unknown class ${c}`);
    for (const a of edge.apps || []) if (!CLASS_OF_APP[a]) errors.push(`${cid}: unknown app ${a}`);
  }
  for (const cid of Object.keys(CONCEPTS)) if (!NEEDS[cid]) errors.push(`concept ${cid} has no edge`);
  for (const [cid, apps] of Object.entries(SIZING_OPTIONS)) {
    if (!CONCEPTS[cid]) errors.push(`sizing options for unknown concept ${cid}`);
    for (const [appId, entry] of Object.entries(apps)) {
      if (!CLASS_OF_APP[appId]) errors.push(`${cid}: sizing options for unknown app ${appId}`);
      if (!entry.options?.includes(entry.default)) errors.push(`${cid}/${appId}: default is not an allowed option`);
    }
  }
  return errors;
}
