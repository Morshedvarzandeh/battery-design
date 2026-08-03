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
    module: 'shortcircuit.js', concepts: ['fault-study'],
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
    module: 'desktop/bd.mjs + desktop/pool.mjs', concepts: ['multi-objective'],
    what: 'Every cell against every energy target, each one fully worked and then ranked by cost per kWh delivered, range, mass or density — across all your cores.',
    provides: ['ranked candidate designs', 'sweeps over any one variable'],
    needs: ['the desktop runner'],
    why: 'Thousands of complete designs is minutes of computation, not milliseconds.',
  },
  {
    id: 'blocks', name: 'Block editor for model composition', tier: 'desktop', status: 'planned',
    module: 'planned', concepts: ['simulation', 'cosim'],
    what: 'Wiring the tool\'s own models together on a canvas the way Simulink or GT-SUITE does — pack, vehicle, thermal loop, charger and load as blocks with typed ports, so a customer can compose a study instead of choosing from the studies that exist.',
    provides: ['a visual model graph', 'studies the customer composes rather than picks', 'an export the FMU already knows how to carry'],
    needs: ['the modules to declare their inputs and outputs as typed ports', 'app.js split up first — at 3,500 lines it is the obstacle, not the canvas'],
    why: 'Every model here already has a clean functional signature, so the ports exist implicitly. Declaring them is what turns fifteen fixed studies into an open-ended one.',
  },
  // --- The physical simulation package -------------------------------------
  // Everything here is PLANNED, and grouped deliberately: these are the
  // domains a CAE suite sells, and the ones this tool has so far only been
  // able to point at. It already refuses to invent a wall thickness because
  // the crash standards prescribe an OUTCOME rather than a millimetre — this
  // is how it would say something useful about the outcome instead of
  // stopping at the refusal.
  //
  // They are also the first work here that a compiled language genuinely
  // needs. Everything shipped so far is closed-form or a few thousand time
  // steps, and measured at 0.63 ms for a complete design; a mesh is a
  // different kind of arithmetic, and the honest answer changes with it.
  {
    id: 'crush', name: 'Crush & intrusion', tier: 'desktop', status: 'planned',
    module: 'planned', concepts: ['crush', 'spaces-why'],
    what: 'What the structure does when something presses on it: intrusion into the cell block, the load path through the frame, and how much of the crush space is actually doing work. The counterpart to the crash tests the release checklist already names — ECE R100 Annex 4, GB 38031, UL 2580 — which prescribe an outcome and leave the dimension to you.',
    provides: ['intrusion depth against the cell block', 'load path and where it fails first', 'how much crush space earns its volume'],
    needs: ['pack and enclosure geometry', 'material yield data', 'a mesh, and the solver to run it'],
    why: 'The tool already says no standard prescribes a wall thickness. That is true and unhelpful on its own — this is the half that makes it actionable.',
  },
  {
    id: 'vibration', name: 'Vibration & shock', tier: 'desktop', status: 'planned',
    module: 'planned', concepts: ['vibration'],
    what: 'Mount loads, the first natural frequency, and the random-vibration and shock profiles the standards actually test against. A pack whose first mode sits inside the excitation band fails by fatigue long before anything electrical does.',
    provides: ['mount and fastener loads', 'first natural frequency vs the excitation band', 'a shock and vibration verdict'],
    needs: ['pack mass and mounting geometry', 'the vibration profile for the application class'],
    why: 'It is the one physical domain the tool currently says nothing about, and the cheapest of this package to build — a modal estimate needs far less than a crush solve.',
  },
  {
    id: 'thermal-field', name: 'Thermal field across the pack', tier: 'desktop', status: 'planned',
    module: 'planned', concepts: ['thermal-field'],
    what: 'Not the loop that removes the heat — that is the BTMS add-on — but where the heat IS. The gradient across the pack that ages one module faster than the rest, and turns a fleet-average life figure into a warranty claim on the hot corner.',
    provides: ['temperature field and the gradient across modules', 'which module ages first and how much faster', 'where a sensor would actually tell you something'],
    needs: ['the module partition', 'the cooling geometry', 'heat generation from the level-2 model'],
    why: 'The level-2 model already computes per-module temperatures on a lumped network. This is the same question asked spatially, and it is what decides sensor placement.',
  },
  {
    id: 'corrosion-sim', name: 'Corrosion over life', tier: 'desktop', status: 'planned',
    module: 'planned — on materials.js + topology.js', concepts: ['corrosion'],
    what: 'The galvanic check the wiring study already runs says whether a joint is a couple. This says what that costs over ten years in the environment the machine lives in: material loss at the interface, the joint resistance climbing as it goes, and when it stops being a joint.',
    provides: ['material loss per joint over life', 'joint resistance drift', 'time to an unacceptable joint'],
    needs: ['the connection graph', 'an environment and a duty', 'exposure time'],
    why: 'The pairing check is shipped and it answers a yes/no. Corrosion is a rate, and a rate is what tells you whether to care.',
  },
  {
    id: 'agents', name: 'AI & automation interface', tier: 'desktop', status: 'shipped',
    module: 'desktop/mcp-server.mjs + api.js + brief.js', concepts: ['report', 'simulation'],
    what: 'The whole designer as one JSON call, plus an MCP server so Claude or any agent can size packs, run missions and compare cells by calling the real modules — and review a design the way an engineer would, with every check read into one list ordered so that what could hurt someone comes before what costs money.',
    provides: ['designFromSpec() JSON', 'MCP tools', 'a prioritised design review', 'the questions the tool needs answered, ranked by leverage'],
    needs: ['the desktop runner for MCP'],
    why: 'Keeping a person in the loop needs the tool to say what it is GUESSING, not only what it found. The review returns both, so an assistant asks the three questions worth asking instead of presenting a confident answer built on estimates.',
  },
  {
    id: 'brief', name: 'Design review & briefing', tier: 'core', status: 'shipped',
    module: 'brief.js', concepts: ['report'],
    what: 'Fifteen modules answer fifteen questions, each in its own shape. This reads all of them into one prioritised list — safety before cost, failures before warnings, the same problem found twice merged rather than repeated — then says what the tool is still guessing and what it did not check at all.',
    provides: ['one ordered list of everything found', 'open questions ranked by how much they would change the answer', 'an explicit list of what was NOT checked'],
    needs: ['a design; the wiring and grounding studies fold in where the desktop tier has run them'],
    why: 'Written once so the report, the CLI and the assistant read the same translation instead of each growing their own copy of it.',
  },
  {
    id: 'wiring', name: 'Wiring, joints & bill of materials', tier: 'desktop', status: 'shipped',
    module: 'topology.js + materials.js + wiring.js', concepts: ['conductors', 'corrosion'],
    what: 'The pack as a connection graph rather than a number: every conductor run with its material, length and section, every joint with the two surfaces that meet there. Each run is then sized two ways — by the current-density rule of thumb and by the steady-state heat balance that says how hot it actually gets — and where they disagree the temperature answer wins. Out of the same graph come the interconnect resistance, the voltage drop and loss at continuous current, the galvanic check on every joint, and the bill of materials the customer receives.',
    provides: ['conductor runs and joints', 'temperature and required section per run', 'voltage drop and loss', 'galvanic compatibility per joint', 'bill of materials with mass and cost'],
    needs: ['a pack', 'run lengths (estimated from the envelope if not given)', 'how the runs are installed: free air, loomed, potted or on a cold plate'],
    why: 'Grounding, corrosion, runaway propagation and LCA are all views of this one graph. Building it first is what stops each of them reshaping the others\' work.',
  },
  {
    id: 'grounding', name: 'Grounding & bonding analysis', tier: 'desktop', status: 'shipped',
    module: 'grounding.js', concepts: ['bonding'],
    what: 'Isolation keeps fault current off the case; bonding decides what happens when isolation fails, and is asked about far less often. Every bonding path is checked three ways — continuity against the 0.1 Ω limit, touch voltage against the 60 V DC boundary, and whether the strap survives the fault current until protection clears. It catches the anodised housing that is not a bonding path however many bolts go through it, the stainless bond chosen for corrosion rather than conduction, and the machine that is conventionally ungrounded and to which none of these rules apply as written.',
    provides: ['bonding path resistance vs the 0.1 Ω limit', 'touch voltage at the prospective fault current', 'fault survival by the adiabatic rule', 'the ungrounded-system verdict where it applies'],
    needs: ['the connection graph', 'the bonding scheme (assumed and flagged if not described)', 'a fault current — taken from the short-circuit study'],
    why: 'The graph, the materials and the fault current already exist, so this is a reading of them rather than a new model.',
  },
  {
    id: 'lca', name: 'Life-cycle assessment', tier: 'desktop', status: 'shipped',
    module: 'lca.js', concepts: ['footprint'],
    what: 'The whole footprint by phase — cells, conductors, enclosure, use-phase losses and recycling recovery — each carrying its own data quality, because they differ by more than an order of magnitude in how well they are known. It answers the question worth asking first: the cells are around 95% of what it costs to build a pack, so chemistry and cell count move the footprint and busbar optimisation does not. It also picks the right comparison for the energy delivered, which for a vehicle is the fuel it replaces and NOT a grid factor.',
    provides: ['footprint by phase with a data-quality label on each', 'kg CO₂e per kWh of capacity and g per kWh delivered', 'the correct displacement basis for this machine', 'what is deliberately not estimated'],
    needs: ['a pack and a cell', 'the connection graph for the conductor share', 'a grid factor where the machine draws from one'],
    why: 'A screening estimate, never a declaration: a footprint declared under ISO 14040/14044 or the EU Battery Regulation is an audited study on supplier-specific data. This says so everywhere, and states pack assembly as unknown rather than inventing a number that would look just as confident as the grounded ones.'
  },
  {
    id: 'cosim', name: 'Co-simulation (FMI)', tier: 'desktop', status: 'shipped',
    module: 'fmi.js', concepts: ['cosim'],
    what: 'Export the pack as a standard FMI 2.0 co-simulation FMU so it runs as a component inside ANSYS Twin Builder, Simulink, GT-SUITE or Dymola — your vehicle or plant model drives it, and the pack answers with voltage, current, temperature and state of charge each coupling step.',
    provides: ['an .fmu the rest of your toolchain can load', 'a documented coupling interface'],
    needs: ['a C toolchain to compile the FMU binary'],
    why: 'FMI is the one interface every major suite already speaks, so it beats writing a bridge per tool. The stepping code is C, which is also where a compiled language genuinely belongs.',
  },
  {
    id: 'swap', name: 'Swappable-pack policy', tier: 'desktop', status: 'shipped',
    module: 'swap.js', concepts: ['swappable'],
    what: 'Fixed, swappable or hot-swappable as a design policy that cuts across every application. Choosing it changes four things at once: the mass stops being an outcome and becomes a requirement someone has to lift; the connector stops being a fitting and becomes a wear item with a finite mating count; you buy more packs than machines; and the pack has to survive being off the machine with no host BMS, disconnect or enclosure.',
    provides: ['the parts a fixed pack does not need', 'fleet size and packs per machine', 'connector mating-cycle life against the fleet life', 'the handling method the mass actually allows'],
    needs: ['a pack', 'a swap policy', 'run and charge hours for the fleet maths'],
    why: 'Swappability is a property, not an application. A preset per swappable variant would double the picker for one attribute.',
  },
  {
    id: 'runaway', name: 'Runaway propagation', tier: 'desktop', status: 'shipped',
    module: 'runaway.js', concepts: ['propagation'],
    what: 'One cell goes — how much does each design decision help? Cell adjacency from the real layout, then conduction, radiation and the interconnect stepped in time with two thermal nodes per cell. It ranks barrier options and spacing against each other, and sizes the energy the enclosure must contain. It does NOT predict whether a pack propagates: the mechanisms that carry a real event are ejecta and flame, which are not modelled, so it under-predicts and can never clear a design.',
    provides: ['barrier and spacing options ranked against each other', 'MJ per cell and per module to contain', 'the effect of state of charge and of a heat-bridging interconnect'],
    needs: ['a pack layout', 'a cell', 'what sits between the cells'],
    why: 'Relative ordering survives the missing physics because every option is wrong by the same amount; absolute prediction does not. UL 9540A and GB 38031-2025 exist because propagation is settled by burning a real pack.',
  },
  {
    id: 'garage', name: 'The garage', tier: 'browser', status: 'shipped',
    module: 'garage.js + garage-ui.js', concepts: ['part-swap'],
    what: 'Fit a different part and see what it does. Every option on the shelf is priced BEFORE it is chosen — what it buys, what it costs, whether it breaks anything, and whether it clears a failure the design already had. A part that wins on one number and fails the audit is marked rather than ranked, and a part that does not suit the pack says so instead of quietly reporting no change.',
    provides: ['every option on a shelf, evaluated', 'what a swap bought and what it cost, side by side', 'failures introduced, cleared, and already-failing ones that moved'],
    needs: ['a design to compare against'],
  },
  {
    id: 'showroom', name: 'The pack in 3D (Godot)', tier: 'browser', status: 'shipped',
    module: 'scene3d.js + garage3d/', concepts: ['showroom'],
    what: 'The pack itself, in a game engine, at the size it really is — every cell where the layout put it, the cooling hardware in the space it reserved, and the audit result on the caption so a failing pack cannot be admired without being told. The renderer computes nothing: it draws a payload the design engine produced, which is what lets a face in another language exist without the tool acquiring a second opinion.',
    provides: ['the real geometry, walkable', 'parts drawn where they sit', 'the audit alongside the picture'],
    needs: ['a design', 'the renderer, which CI builds and a plain checkout does not have'],
  },
  {
    id: 'circular', name: 'Circular economy: value by stage and place', tier: 'browser', status: 'shipped',
    module: 'circular.js', concepts: ['circular-value'],
    what: 'What the pack is worth at each point in its life, in the place it is actually standing. Stages are nodes and moving between them is an edge that costs money, takes time, loses some of what you had, and is sometimes not allowed. Regulation is carried as gates rather than averaged into a price — landfill is not expensive in the EU, it is prohibited — and every route reports what stands in the way, not just what it pays.',
    provides: ['every route out of a stage, priced and gated', 'the regulatory obligations and constraints on each, with the instrument cited', 'where the value actually drains away — usually into testing and freight'],
    needs: ['an energy figure', 'a place', 'a state of health, if the pack has been measured'],
  },
];

export const addonById = (id) => ADDONS.find((a) => a.id === id) || null;

// Which add-ons matter for this application? Relevance comes from the same
// knowledge graph that decides everything else — an add-on whose concepts the
// application does not need is not "hidden", it is genuinely not its business.
/**
 * Every shipped capability must be findable in the knowledge graph.
 *
 * This exists because it had already gone wrong. The graph was built early
 * and then eight modules and eleven add-ons were added without an edge, so
 * `addonsFor()` could not filter them by relevance and they were shown to
 * every application regardless — including a route simulation offered to a
 * wearable. A graph that does not know a capability exists cannot say who
 * needs it, and the whole point of it is that visibility traces to an edge
 * rather than to a guess.
 *
 * Checked by test, so the next capability cannot be added silently.
 */
export function validateAddonConcepts(CONCEPTS) {
  const errors = [];
  for (const a of ADDONS) {
    if (!a.concepts?.length) {
      errors.push(`${a.id} declares no concept, so nothing can decide which applications need it`);
      continue;
    }
    for (const c of a.concepts) {
      if (!CONCEPTS[c]) errors.push(`${a.id} names concept "${c}", which is not in the graph`);
    }
  }
  return errors;
}

export function addonsFor(appId, { tier = null, includePlanned = true } = {}) {
  return ADDONS.filter((a) => {
    if (tier && a.tier !== tier) return false;
    if (!includePlanned && a.status !== 'shipped') return false;
    if (a.tier === 'core') return true;
    if (!a.concepts.length) return true;      // no concept gate: always offered
    if (!appId) return true;                   // nothing chosen yet: show everything
    // The FIRST concept is the defining one and is what gates; the rest are
    // context. Matching on any of them let a universal concept smuggle a
    // specialised add-on everywhere: crush declares ['crush', 'spaces-why'],
    // and because every application needs spaces-why, crush simulation was
    // being offered to a wearable. An add-on is defined by the one thing it
    // is for, not by everything it touches.
    return needed(appId, a.concepts[0]);
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
