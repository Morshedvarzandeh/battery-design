// addons.js — the tool as a set of add-ons rather than one growing program.
//
// This started as a pack designer. It is now also a vehicle model, an AC-side
// model, a feed-back policy engine, a mission simulator, a parameterised
// electro-thermal model with calibration, and a fault study. Every one earns
// its place, and together they are too much to put in front of someone who
// wants to size an e-bike battery.
//
// So the capabilities are declared here as ADD-ONS — the way every serious
// engineering suite handles the same problem. Each one states what it does,
// what it needs, what it gives back, and which applications actually want it.
// Two things then follow for free:
//
//   · The customer sees a short list of what is relevant to THEIR machine,
//     with everything else available but out of the way.
//   · The tool can answer "what can this thing do?" honestly, including what
//     is planned and not yet built — which is the question a brochure
//     usually lies about.
//
// Relevance is not a new opinion: it is read from the knowledge graph that
// already decides which concepts each application needs. One source of truth,
// as everywhere else here.
//
// Pure data + queries, no DOM.

import { CONCEPTS, needed } from './knowledge.js';

// tier    — where it runs: 'core' is always there, 'browser' is in the page,
//           'desktop' needs the local runner because of what it computes.
// status  — 'shipped' or 'planned'. Planned entries are listed so the roadmap
//           is visible in the product rather than in someone's head.
export const ADDONS = [
  {
    id: 'pack', name: 'Pack designer', tier: 'core', status: 'shipped',
    module: 'pack-engine.js', concepts: ['space-fill', 'spaces-why', 'integration-allowance'],
    what: 'Cells into a pack: series/parallel, geometry, mass, the space every millimetre goes to, and the 2D/3D view of it.',
    provides: ['pack geometry', 'mass and volume', 'energy and voltage window'],
    needs: ['a cell', 'a target voltage or energy, or a space to fill'],
  },
  {
    id: 'audit', name: 'Engineering & standards audit', tier: 'core', status: 'shipped',
    module: 'engineering.js + standards.js', concepts: ['release-rules'],
    what: 'Four perspectives — mechanical, thermal, electrical, safety — plus the release checklist for your market. Every finding names the rule behind it.',
    provides: ['pass/warn/fail findings', 'market release checklist'],
    needs: ['a pack', 'an application', 'a target market'],
  },
  {
    id: 'economics', name: 'Cost, duty & CO₂', tier: 'core', status: 'shipped',
    module: 'optimizer.js + report.js', concepts: ['duty-economics', 'report'],
    what: 'Cycle-based cost of ownership, cost per kWh delivered over life, sensitivity to price and cycle life, and the CO₂ payback point.',
    provides: ['$/kWh delivered', 'replacement schedule', 'CO₂ payback'],
    needs: ['cell price and cycle life', 'cycles per year'],
  },
  {
    id: 'architecture', name: 'Electrical architecture & BMS', tier: 'browser', status: 'shipped',
    module: 'architecture.js', concepts: ['module-tier', 'hv-chain', 'bms-topology', 'ems-arch'],
    what: 'Module partition, BMS topology, the HV chain (precharge, contactors, isolation), DC-DC, and the supervisory layer above it.',
    provides: ['module and AFE plan', 'HV component sizing', 'topology verdicts'],
    needs: ['a pack', 'an application'],
  },
  {
    id: 'thermal', name: 'Thermal system & BTMS', tier: 'browser', status: 'shipped',
    module: 'btms.js', concepts: ['btms-loop'],
    what: 'Cooling loop selection, coolant flow, chiller cost, and the heater branch winter charging needs.',
    provides: ['loop choice with verdict', 'coolant flow', 'heat to move'],
    needs: ['heat load from the audit', 'a design ambient range'],
  },
  {
    id: 'sensors', name: 'Sensor plan', tier: 'browser', status: 'shipped',
    module: 'sensors.js', concepts: ['sensors-plan'],
    what: 'What the harness must carry at cell, module, system and cooling level.',
    provides: ['sensor counts and channel plan'],
    needs: ['module partition', 'thermal system'],
  },
  {
    id: 'mission', name: 'Mission simulation', tier: 'browser', status: 'shipped',
    module: 'sim1d.js', concepts: ['simulation', 'load-profile'],
    what: 'The design driven through its load profile in time: state of charge, voltage sag, temperature, and whether it runs out.',
    provides: ['SoC and temperature over time', 'unmet energy', 'cell comparison on one mission'],
    needs: ['a load profile', 'a pack'],
  },
  {
    id: 'vehicle', name: 'Vehicle & driving', tier: 'browser', status: 'shipped',
    module: 'vehicle.js', concepts: ['vehicle-dynamics'],
    what: 'Road load from the machine itself — mass, drag, rolling resistance, gradient, driving mode — giving Wh/km and range, with the pack carrying its own weight.',
    provides: ['Wh/km', 'range', 'a physics-derived load profile'],
    needs: ['a vehicle (mass, area, drag)', 'a speed trace'],
  },
  {
    id: 'acside', name: 'AC side & charging', tier: 'browser', status: 'shipped',
    module: 'charging.js', concepts: ['ac-side', 'charging-strategy'],
    what: 'How the machine charges: on-board charger or not, connector and comms per market, charge time with the CV tail, and the depot-vs-opportunity decision.',
    provides: ['charge times', 'connector and comms', 'strategy with pros and cons'],
    needs: ['a pack', 'a target market'],
  },
  {
    id: 'v2x', name: 'Feeding power back (V2X)', tier: 'browser', status: 'shipped',
    module: 'v2x.js', concepts: ['v2x'],
    what: 'V2L, V2H, V2G and V2V as a design policy: the parts each adds, the export budget after reserve, the wear floor that decides whether V2G pays, and the certification it drags in.',
    provides: ['policy verdicts', 'bill-of-materials additions', 'export budget', 'wear floor $/kWh'],
    needs: ['a pack', 'a feed-back policy'],
  },
  {
    id: 'fault', name: 'Short circuit & fault study', tier: 'browser', status: 'shipped',
    module: 'shortcircuit.js', concepts: [],
    what: 'The first milliseconds of a fault: prospective current, and the race between the fuse clearing, the busbar surviving and the cells reaching runaway onset. Includes the internal short, where the parallel neighbours are the danger.',
    provides: ['fault currents', 'fuse/busbar/runaway timing', 'fusible-link assessment'],
    needs: ['a pack', 'busbar section and fuse rating'],
  },
  {
    id: 'sim2', name: 'Advanced electro-thermal model', tier: 'desktop', status: 'shipped',
    module: 'sim2.js', concepts: ['simulation'],
    what: 'The correctable model: OCV + R0 + RC branches with Arrhenius dependence, reversible entropic heat, a per-module thermal network with an ε-NTU coolant stream, and calendar plus cycle aging. Every coefficient is an exposed parameter.',
    provides: ['per-module temperatures', 'aging schedule', 'a model fitted to YOUR cell'],
    needs: ['the desktop runner', 'measured data to calibrate against (optional but the point)'],
    why: 'Runs on the desktop because a real study is thousands of sub-stepped seconds, and because calibration searches the parameter space many times over.',
  },
  {
    id: 'search', name: 'Design-space search', tier: 'desktop', status: 'shipped',
    module: 'desktop/bd.mjs + pool.mjs', concepts: ['multi-objective'],
    what: 'Every cell against every energy target, each one fully worked and then ranked by cost per kWh delivered, range, mass or density — across all your cores.',
    provides: ['ranked candidate designs', 'sweeps over any one variable'],
    needs: ['the desktop runner'],
    why: 'Thousands of complete designs is minutes of computation, not milliseconds.',
  },
  {
    id: 'agents', name: 'AI & automation interface', tier: 'desktop', status: 'shipped',
    module: 'desktop/mcp-server.mjs + api.js + brief.js', concepts: [],
    what: 'The whole designer as one JSON call, plus an MCP server so Claude or any agent can size packs, run missions and compare cells by calling the real modules — and review a design the way an engineer would, with every check read into one list ordered so that what could hurt someone comes before what costs money.',
    provides: ['designFromSpec() JSON', 'MCP tools', 'a prioritised design review', 'the questions the tool needs answered, ranked by leverage'],
    needs: ['the desktop runner for MCP'],
    why: 'Keeping a person in the loop needs the tool to say what it is GUESSING, not only what it found. The review returns both, so an assistant asks the three questions worth asking instead of presenting a confident answer built on estimates.',
  },
  {
    id: 'brief', name: 'Design review & briefing', tier: 'core', status: 'shipped',
    module: 'brief.js', concepts: [],
    what: 'Fifteen modules answer fifteen questions, each in its own shape. This reads all of them into one prioritised list — safety before cost, failures before warnings, the same problem found twice merged rather than repeated — then says what the tool is still guessing and what it did not check at all.',
    provides: ['one ordered list of everything found', 'open questions ranked by how much they would change the answer', 'an explicit list of what was NOT checked'],
    needs: ['a design; the wiring and grounding studies fold in where the desktop tier has run them'],
    why: 'Written once so the report, the CLI and the assistant read the same translation instead of each growing their own copy of it.',
  },
  {
    id: 'wiring', name: 'Wiring, joints & bill of materials', tier: 'desktop', status: 'shipped',
    module: 'topology.js + materials.js + wiring.js', concepts: [],
    what: 'The pack as a connection graph rather than a number: every conductor run with its material, length and section, every joint with the two surfaces that meet there. Each run is then sized two ways — by the current-density rule of thumb and by the steady-state heat balance that says how hot it actually gets — and where they disagree the temperature answer wins. Out of the same graph come the interconnect resistance, the voltage drop and loss at continuous current, the galvanic check on every joint, and the bill of materials the customer receives.',
    provides: ['conductor runs and joints', 'temperature and required section per run', 'voltage drop and loss', 'galvanic compatibility per joint', 'bill of materials with mass and cost'],
    needs: ['a pack', 'run lengths (estimated from the envelope if not given)', 'how the runs are installed: free air, loomed, potted or on a cold plate'],
    why: 'Grounding, corrosion, runaway propagation and LCA are all views of this one graph. Building it first is what stops each of them reshaping the others\' work.',
  },
  {
    id: 'grounding', name: 'Grounding & bonding analysis', tier: 'desktop', status: 'shipped',
    module: 'grounding.js', concepts: [],
    what: 'Isolation keeps fault current off the case; bonding decides what happens when isolation fails, and is asked about far less often. Every bonding path is checked three ways — continuity against the 0.1 Ω limit, touch voltage against the 60 V DC boundary, and whether the strap survives the fault current until protection clears. It catches the anodised housing that is not a bonding path however many bolts go through it, the stainless bond chosen for corrosion rather than conduction, and the machine that is conventionally ungrounded and to which none of these rules apply as written.',
    provides: ['bonding path resistance vs the 0.1 Ω limit', 'touch voltage at the prospective fault current', 'fault survival by the adiabatic rule', 'the ungrounded-system verdict where it applies'],
    needs: ['the connection graph', 'the bonding scheme (assumed and flagged if not described)', 'a fault current — taken from the short-circuit study'],
    why: 'The graph, the materials and the fault current already exist, so this is a reading of them rather than a new model.',
  },
  {
    id: 'lca', name: 'Life-cycle assessment', tier: 'desktop', status: 'planned',
    module: 'planned — on topology.js', concepts: [],
    what: 'Cradle-to-grave footprint built from the bill of materials: embodied carbon per material, manufacturing, the use phase already modelled, and end-of-life recovery.',
    provides: ['embodied CO₂ by material', 'full life-cycle footprint'],
    needs: ['the bill of materials'],
    why: 'The BOM already carries mass per material and each material already carries its embodied CO₂ — the remaining work is the use and end-of-life phases.',
  },
  {
    id: 'cosim', name: 'Co-simulation (FMI)', tier: 'desktop', status: 'shipped',
    module: 'fmi.js', concepts: [],
    what: 'Export the pack as a standard FMI 2.0 co-simulation FMU so it runs as a component inside ANSYS Twin Builder, Simulink, GT-SUITE or Dymola — your vehicle or plant model drives it, and the pack answers with voltage, current, temperature and state of charge each coupling step.',
    provides: ['an .fmu the rest of your toolchain can load', 'a documented coupling interface'],
    needs: ['a C toolchain to compile the FMU binary'],
    why: 'FMI is the one interface every major suite already speaks, so it beats writing a bridge per tool. The stepping code is C, which is also where a compiled language genuinely belongs.',
  },
  {
    id: 'swap', name: 'Swappable-pack policy', tier: 'browser', status: 'planned',
    module: 'planned', concepts: [],
    what: 'Fixed, swappable or hot-swappable as a design policy that cuts across every application — adding the latch and connector, the mating-cycle rating, the standalone-safe BMS, the N+1 pack fleet in the cost model, and the off-machine charging story.',
    provides: ['swap parts list', 'fleet ratio in the cost model', 'connector mating-cycle requirement'],
    needs: ['a pack', 'a swap policy'],
    why: 'Swappability is a property, not an application. A preset per swappable variant would double the picker for one attribute.',
  },
  {
    id: 'runaway', name: 'Runaway propagation', tier: 'desktop', status: 'planned',
    module: 'planned', concepts: [],
    what: 'One cell goes into thermal runaway: does it take its neighbours with it? A per-cell thermal network with ignition thresholds, run across the whole pack to find whether the design contains a single-cell failure.',
    provides: ['propagation or containment verdict', 'time to neighbour ignition', 'the effect of barriers and spacing'],
    needs: ['the desktop runner', 'per-cell geometry'],
    why: 'Thousands of cells × thousands of steps × many scenarios. This is the first thing in the tool where a compiled language would earn its cost.',
  },
];

export const addonById = (id) => ADDONS.find((a) => a.id === id) || null;

// Which add-ons matter for this application? Relevance comes from the same
// knowledge graph that decides everything else — an add-on whose concepts the
// application does not need is not "hidden", it is genuinely not its business.
export function addonsFor(appId, { tier = null, includePlanned = true } = {}) {
  return ADDONS.filter((a) => {
    if (tier && a.tier !== tier) return false;
    if (!includePlanned && a.status !== 'shipped') return false;
    if (a.tier === 'core') return true;
    if (!a.concepts.length) return true;      // no concept gate: always offered
    if (!appId) return true;                   // nothing chosen yet: show everything
    return a.concepts.some((c) => needed(appId, c));
  });
}

// The honest summary of what this tool can do, for an application or in
// general — including what is not built yet, marked as such.
export function capabilityReport(appId = null) {
  const relevant = addonsFor(appId);
  const shipped = relevant.filter((a) => a.status === 'shipped');
  const planned = relevant.filter((a) => a.status === 'planned');
  return {
    application: appId,
    total: ADDONS.length,
    relevant: relevant.length,
    shipped: shipped.length,
    planned: planned.length,
    byTier: {
      core: relevant.filter((a) => a.tier === 'core').length,
      browser: relevant.filter((a) => a.tier === 'browser').length,
      desktop: relevant.filter((a) => a.tier === 'desktop').length,
    },
    addons: relevant,
    notRelevant: ADDONS.filter((a) => !relevant.includes(a)),
    note: appId
      ? `${shipped.length} of the ${ADDONS.length} add-ons apply to this application; the rest are for machines this one is not. ${planned.length ? `${planned.length} are planned and named as such.` : ''}`
      : 'Every add-on, because no application has been chosen yet. Pick one and this list gets shorter.',
  };
}

// Every add-on must describe itself completely, and every concept it claims
// must exist. Checked by test, so the registry cannot drift from the graph.
export function validateAddons() {
  const errors = [];
  const seen = new Set();
  for (const a of ADDONS) {
    if (seen.has(a.id)) errors.push(`duplicate add-on id ${a.id}`);
    seen.add(a.id);
    if (!a.name || !a.what || !a.module) errors.push(`${a.id}: incomplete entry`);
    if (!['core', 'browser', 'desktop'].includes(a.tier)) errors.push(`${a.id}: unknown tier ${a.tier}`);
    if (!['shipped', 'planned'].includes(a.status)) errors.push(`${a.id}: unknown status ${a.status}`);
    if (!a.provides?.length || !a.needs?.length) errors.push(`${a.id}: must say what it provides and needs`);
    if (a.status === 'planned' && !a.why) errors.push(`${a.id}: a planned add-on must justify itself`);
    for (const c of a.concepts || []) {
      if (!CONCEPTS[c]) errors.push(`${a.id}: unknown concept ${c}`);
    }
  }
  return errors;
}
