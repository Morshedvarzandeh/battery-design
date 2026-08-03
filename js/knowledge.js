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
  'simulation': { label: 'Mission simulation', why: 'The design run through time — SoC, sag and temperature over the real profile.' },
  'ac-side': { label: 'AC side & charging', why: 'How the pack meets the grid — on-board charger, connectors, charge time.' },
  'charging-strategy': { label: 'Charging strategy', why: 'Depot vs opportunity vs tariff windows — a pack-sizing decision, not an afterthought.' },
  'v2x': { label: 'Feeding power back (V2X)', why: 'V2L, V2H, V2G — and the wear floor that decides whether selling energy back ever pays.' },
  'vehicle-dynamics': { label: 'The vehicle & driving mode', why: 'Mass, drag and the driver decide the demand — and the pack carries its own weight.' },

  // --- What the pack is made of, and what happens when it fails -----------
  // These arrived module by module and none of them had an edge here, which
  // meant the graph had quietly stopped covering most of the tool: eight
  // modules and eleven add-ons were invisible to it. A graph that does not
  // know a capability exists cannot say who needs it, and the whole point of
  // this file is that visibility traces to an edge rather than to a guess.
  conductors: { label: 'Conductor sizing & the connection graph', why: 'Every run has a material, a length and a section — and a temperature that decides whether it survives the current it carries.' },
  bonding: { label: 'Grounding & bonding', why: 'Isolation keeps fault current off the case; bonding decides what happens once it fails.' },
  corrosion: { label: 'Galvanic corrosion at joints', why: 'Two metals that must not touch, and the one that dissolves when they do.' },
  'fault-study': { label: 'Short circuit & fault currents', why: 'The first milliseconds: whether the fuse clears before the busbar fails.' },
  propagation: { label: 'Runaway propagation', why: 'One cell goes — what the spacing, the barrier and the state of charge do about the next one.' },
  footprint: { label: 'Life-cycle footprint', why: 'What it costs to build, run and recycle, and which of those you can actually change.' },
  swappable: { label: 'Swappable-pack policy', why: 'Fixed, swappable or hot-swappable — a decision that changes the mass, the connector and how many packs you buy.' },
  cosim: { label: 'Co-simulation & model export', why: 'The pack as a component inside the toolchain you already run.' },

  // --- Working on the machine ----------------------------------------------
  'part-swap': { label: 'Fitting a different part', why: 'What one change actually buys and costs, priced before you commit to it rather than after.' },
  showroom: { label: 'The pack in three dimensions', why: 'Standing in front of the thing rather than reading a table about it — the same geometry, at the size it really is.' },

  // --- How the machine actually moves --------------------------------------
  // Deliberately SEPARATE concepts rather than one 'route simulation', because
  // the physics genuinely differs by domain and a shared node would let road
  // assumptions reach a boat. A ship is not a slow car.
  'route-road': { label: 'Route simulation (road)', why: 'A real journey rather than a synthetic cycle: the hill outside town, and what it costs.' },
  terrain: { label: 'Terrain & off-road surfaces', why: 'Sand is fifteen times the rolling resistance of tarmac, and at low speed that IS the consumption.' },
  'hull-resistance': { label: 'Hull resistance & sea state', why: 'A boat is not a slow car: resistance rises with the cube of speed, and current and waves decide the crossing.' },
  'flight-weather': { label: 'Flight physics & weather', why: 'Lift has to be paid for continuously, and wind, air density and temperature change what a flight costs.' },
  'legged-gait': { label: 'Legged locomotion & gait', why: 'Legs pay for every step and for standing still — a duty cycle that looks nothing like rolling.' },

  // --- The physical simulation package -------------------------------------
  // The domains a CAE suite sells, and the ones this tool has so far only been
  // able to point at. It already refuses to invent a wall thickness because
  // the standards prescribe OUTCOMES rather than millimetres — these are how
  // it would say something useful about those outcomes instead of stopping.
  crush: { label: 'Crush & intrusion', why: 'The crash tests prescribe an outcome, not a dimension. This is what the structure does when something presses on it.' },
  vibration: { label: 'Vibration & shock', why: 'Mount loads and the first natural frequency against what the road, the sea or the airframe actually shakes it with.' },
  'thermal-field': { label: 'Thermal field across the pack', why: 'Not the loop that removes the heat, but where the heat IS — the gradient that ages one module faster than the rest.' },
};

// Edges: which application classes need each concept. Per-app extra edges
// (`apps`) and removals (`notApps`) refine where a class is too coarse.
// Classes: vehicle, lmt, stationary, marine, industrial, portable, auxiliary.
const ALL = ['vehicle', 'lmt', 'stationary', 'marine', 'industrial', 'portable', 'auxiliary'];
export const NEEDS = {
  // --- What the pack is made of, and what happens when it fails -----------
  // Every pack has conductors and joints, so these are universal. Bonding is
  // not: below 60 V DC there is no shock hazard to bond against, and a boat
  // is deliberately ungrounded — the grounding module says so itself, and the
  // graph agrees with it rather than contradicting it.
  conductors: { classes: ALL },
  corrosion: { classes: ALL },
  'fault-study': { classes: ALL },
  propagation: { classes: ALL },
  footprint: { classes: ALL },
  bonding: { classes: ['vehicle', 'stationary', 'industrial', 'auxiliary', 'marine'] },
  swappable: { classes: ['lmt', 'industrial', 'portable', 'auxiliary'], apps: ['ev', 'ebus'] },
  cosim: { classes: ['vehicle', 'marine', 'industrial', 'stationary'] },

  // Every machine has parts and every part can be changed, so the garage is
  // universal. The showroom is too — a wearable pack is as worth looking at
  // as a bus one, and arguably more, since nobody can picture six cells the
  // size of a stamp until they see them.
  'part-swap': { classes: ALL },
  showroom: { classes: ALL },

  // --- How the machine actually moves --------------------------------------
  // The edges that keep road physics away from a boat. Each domain gets the
  // ONE that matches how it moves, and nothing else: a drone has no terrain,
  // a ship has no gradient, and a humanoid has neither.
  // NOT 'auxiliary'. An RV house bank does not travel under its own power —
  // the vehicle carries it while it runs the fridge — so it has no road-load
  // model and a range target is meaningless for it. The edge was wrong, and
  // it surfaced as a co-design solver returning a malformed answer rather
  // than as anything that looked like a graph problem.
  'route-road': { classes: ['vehicle', 'lmt'], apps: ['robot'] },
  terrain: { classes: ['lmt'], apps: ['ev', 'ebus', 'robot', 'cyberdog'] },
  'hull-resistance': { classes: ['marine'] },
  'flight-weather': { classes: [], apps: ['drone'] },
  'legged-gait': { classes: [], apps: ['cyberdog', 'humanoid'] },

  // The simulation package. Crush follows the machines that carry people or
  // meet crash rules; vibration follows anything that moves at all; the
  // thermal field matters wherever there is enough pack for a gradient.
  crush: { classes: ['vehicle', 'lmt', 'marine', 'auxiliary'] },
  vibration: { classes: ['vehicle', 'lmt', 'marine', 'industrial', 'auxiliary'], apps: ['drone'] },
  'thermal-field': { classes: ['vehicle', 'stationary', 'marine', 'industrial'] },


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
  'simulation': { classes: ALL },
  // The AC side is a design topic only where the machine owns its charger
  // (or IS the grid interface) — a gadget's brick or dock needs no design.
  'ac-side': { classes: ['vehicle', 'auxiliary', 'marine', 'stationary'], apps: ['powerstation'] },
  'charging-strategy': { classes: ['vehicle', 'industrial', 'stationary', 'marine', 'auxiliary'], apps: [] },
  // Feeding power back is a VEHICLE topic (bidirectional charge port).
  // Stationary storage feeds the grid as its normal duty — that is the PCS
  // panel's story, not a V2X edge.
  // Re-derived: anything with an inverter output can do V2L, so RVs and
  // boats belong here too. What they cannot do is interconnect with a grid.
  'v2x': { classes: [], apps: ['ev', 'ebus', 'rv', 'marine'] },
  // Road load applies to machines that actually drive. A drone flies, a
  // humanoid walks, a plant sits still — none of them are road vehicles.
  'vehicle-dynamics': { classes: [], apps: ['ev', 'ebus', 'ebike', 'escooter', 'robot'] },
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
