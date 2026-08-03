// topology.js — what is joined to what, and through which piece of metal.
//
// The tool has always known the pack as numbers: 96S44P, a module partition, a
// resistance total. What it has never had is the actual CONNECTIVITY — that
// this busbar joins group 12 to group 13, is 80 mm of 50 mm² copper, and ends
// in two bolted joints between copper and tin.
//
// That absence is fine until you try to answer any of the questions that are
// coming, and then it is the whole problem:
//
//   wiring      needs the runs, their lengths and their sections
//   grounding   needs the bonding paths and where isolation barriers sit
//   corrosion   needs the JOINTS — galvanic attack happens at interfaces,
//               not along conductors
//   runaway     needs cell-to-cell adjacency
//   LCA         needs the bill of materials with a mass per material
//
// All five are views of one graph. Building it once, first, is why none of
// them will have to reshape the others' work.
//
//   NODES   cell group, module terminal, pack terminal, chassis, component
//   EDGES   a conductor run (material, length, section) or a joint
//
// Derived from the pack the customer already designed — nothing here asks for
// new input. Where a length is unknown it is ESTIMATED from the geometry and
// flagged as an estimate, never quietly invented.
//
// Pure data + math, no DOM.

import { materialById, conductorResistance, conductorMassKg, galvanicRisk } from './materials.js';

export const NODE_KINDS = {
  'cell-group': 'One parallel group of cells — the smallest thing the pack wires as a unit.',
  'module-terminal': 'Where a module hands its current to the pack.',
  'pack-terminal': 'The positive or negative the machine connects to.',
  chassis: 'The vehicle or enclosure body — the reference the isolation is measured against.',
  component: 'A contactor, fuse, shunt or connector sitting in the current path.',
};

/** One conductor run between two nodes. */
export function conductor({ id, from, to, materialId = 'copper', lengthMm, areaMm2, carriesA = null, note = null, estimated = false }) {
  return {
    id, kind: 'conductor', from, to, materialId,
    lengthMm, areaMm2, carriesA, note, estimated,
    resistanceOhm: conductorResistance({ materialId, lengthM: lengthMm / 1000, areaMm2 }),
    massKg: conductorMassKg({ materialId, lengthM: lengthMm / 1000, areaMm2 }),
  };
}

/** One joint — where two materials meet, which is where corrosion happens. */
export function joint({ id, at, materialA, materialB, method = 'bolted', note = null, base = null }) {
  // materialA/B are the two MATING SURFACES. `base` records what sits under a
  // plating, so the check can say what would be exposed if it were damaged.
  return { id, kind: 'joint', at, materialA, materialB, method, note, base };
}

/**
 * Build the connection graph for a design.
 *
 * `lengths` lets the customer give real numbers; without them the runs are
 * estimated from the pack's own dimensions and every estimate is marked, so
 * nothing downstream can mistake a guess for a measurement.
 */
export function buildTopology({
  summary, partition = null, cellForm = 'cylindrical',
  busbarMaterial = null, interconnectMaterial = null,
  cableMaterial = 'copper', lengths = {}, plating = 'tin',
}) {
  if (!summary?.cellCount) return null;
  const notes = [];
  // Cylindrical cells are welded with nickel strip; prismatic and pouch get
  // copper or aluminium busbars. Defaulting by format rather than asking is
  // the difference between a tool and a form.
  const interconnect = interconnectMaterial
    || (cellForm === 'cylindrical' ? 'nickel-plated-copper' : 'copper');
  const busbar = busbarMaterial || 'copper';

  const nModules = partition?.nModules || 1;
  const groups = summary.s;                     // one parallel group per series step
  const d = summary.dims || { x: 200, y: 150, z: 80 };

  // Estimated run lengths from the pack's own geometry. Stated as estimates.
  const groupPitchMm = lengths.groupPitchMm ?? Math.max(20, d.x / Math.max(1, Math.ceil(groups / nModules)));
  const moduleRunMm = lengths.moduleRunMm ?? Math.max(60, (d.x + d.y) / 2);
  const packRunMm = lengths.packRunMm ?? Math.max(150, d.x * 0.6 + d.y * 0.6);
  if (lengths.groupPitchMm == null || lengths.moduleRunMm == null || lengths.packRunMm == null) {
    notes.push('Run lengths are estimated from the pack envelope. Measure them on the real layout and the resistance, mass and voltage-drop numbers all sharpen at once.');
  }

  const nodes = [];
  const edges = [];
  const joints = [];

  // Cell groups in series, joined group to group.
  for (let g = 0; g < groups; g++) {
    nodes.push({ id: `g${g}`, kind: 'cell-group', label: `Group ${g + 1} of ${groups}`, module: Math.floor(g / Math.max(1, groups / nModules)) });
  }
  const contA = summary.maxContCurrentA || 0;
  // Interconnect between groups carries the FULL pack current: series means
  // every electron passes through every one of these.
  const interArea = lengths.interconnectAreaMm2 ?? Math.max(2, contA / 5);
  for (let g = 0; g < groups - 1; g++) {
    edges.push(conductor({
      id: `ic${g}`, from: `g${g}`, to: `g${g + 1}`, materialId: interconnect,
      lengthMm: groupPitchMm, areaMm2: interArea, carriesA: contA,
      estimated: lengths.groupPitchMm == null,
      note: g === 0 ? 'Group-to-group interconnect. Carries the full pack current — series gives it no help from anywhere.' : null,
    }));
    joints.push(joint({
      id: `j-ic${g}`, at: `g${g}`, materialA: interconnect,
      materialB: cellForm === 'cylindrical' ? 'steel-nickel-plated' : 'aluminium',
      method: cellForm === 'cylindrical' ? 'welded' : 'bolted',
    }));
  }

  // Module terminals and the runs that gather them into the pack.
  const busArea = lengths.busbarAreaMm2 ?? Math.max(10, contA / 4);
  for (let m = 0; m < nModules; m++) {
    nodes.push({ id: `m${m}`, kind: 'module-terminal', label: `Module ${m + 1} terminal` });
    edges.push(conductor({
      id: `mb${m}`, from: `g${Math.min(groups - 1, Math.round((m + 1) * groups / nModules) - 1)}`, to: `m${m}`,
      materialId: busbar, lengthMm: moduleRunMm, areaMm2: busArea, carriesA: contA,
      estimated: lengths.moduleRunMm == null,
      note: m === 0 ? 'Module busbar into the pack collection point.' : null,
    }));
    // A bolted joint between two plated busbars mates PLATING TO PLATING —
    // that is the whole reason plating exists. The couple to worry about is
    // the one under the plating, and only if it is damaged.
    joints.push(joint({
      id: `j-mb${m}`, at: `m${m}`, materialA: plating, materialB: plating, method: 'bolted',
      base: [busbar, busbar],
      note: m === 0 ? `Plated joint: the mating surfaces are ${plating}, so there is no couple while the plating is intact. Damage it and the ${busbar} underneath is exposed at exactly the point current passes.` : null,
    }));
  }

  // Pack terminals, the main cable, and the chassis reference.
  nodes.push({ id: 'p+', kind: 'pack-terminal', label: 'Pack positive' });
  nodes.push({ id: 'p-', kind: 'pack-terminal', label: 'Pack negative' });
  nodes.push({ id: 'chassis', kind: 'chassis', label: 'Chassis / enclosure' });
  const cableArea = lengths.cableAreaMm2 ?? Math.max(16, contA / 4);
  for (const t of ['p+', 'p-']) {
    edges.push(conductor({
      id: `pk${t}`, from: t === 'p+' ? `m${nModules - 1}` : 'm0', to: t,
      materialId: cableMaterial, lengthMm: packRunMm, areaMm2: cableArea, carriesA: contA,
      estimated: lengths.packRunMm == null,
      note: t === 'p+' ? 'Main pack cable. Both polarities carry the same current, so both are sized the same.' : null,
    }));
    joints.push(joint({ id: `j-${t}`, at: t, materialA: plating, materialB: plating, method: 'bolted', base: [cableMaterial, cableMaterial] }));
  }
  // The enclosure joint exists whether or not anyone designed it — a bolt
  // through an aluminium housing is a galvanic couple and a bonding path.
  joints.push(joint({
    id: 'j-chassis', at: 'chassis', materialA: 'aluminium-housing', materialB: 'stainless-304',
    method: 'bolted', note: 'Housing-to-bracket. This is both the bonding path and a galvanic couple, and it is usually nobody\'s job until it fails.',
  }));

  const seriesPath = edges.filter((e) => e.id.startsWith('ic'));
  const totalSeriesOhm = seriesPath.reduce((s, e) => s + (e.resistanceOhm || 0), 0);
  const packCableOhm = edges.filter((e) => e.id.startsWith('pk')).reduce((s, e) => s + (e.resistanceOhm || 0), 0);
  const conductorMass = edges.reduce((s, e) => s + (e.massKg || 0), 0);

  return {
    nodes, edges, joints, notes,
    materials: { interconnect, busbar, cable: cableMaterial, plating },
    totals: {
      conductorMassKg: conductorMass,
      interconnectOhm: totalSeriesOhm,
      packCableOhm,
      // What the tool has always used as one scalar, now derived from parts
      // that have a material, a length and a section behind them.
      interconnectMOhm: (totalSeriesOhm + packCableOhm) * 1000,
      lossAtContW: contA * contA * (totalSeriesOhm + packCableOhm),
      dropAtContV: contA * (totalSeriesOhm + packCableOhm),
    },
    estimated: edges.some((e) => e.estimated),
  };
}

/**
 * Every joint checked for galvanic compatibility. This is the corrosion
 * question, and it is answered from the graph rather than from a new model.
 */
export function jointCompatibility(topology, environment = 'normal') {
  if (!topology) return [];
  return topology.joints.map((j) => {
    const risk = galvanicRisk(j.materialA, j.materialB, environment);
    // A plated joint is safe while the plating holds. Say what happens when
    // it does not, rather than either crying wolf or staying silent.
    const ifDamaged = j.base && j.base[0] !== j.base[1]
      ? galvanicRisk(j.base[0], j.base[1], environment) : null;
    return { ...j, risk, ifDamaged };
  }).filter((j) => j.risk);
}

/** The bill of materials by material — what LCA and cost both want. */
export function materialBreakdown(topology) {
  if (!topology) return [];
  const byId = new Map();
  for (const e of topology.edges) {
    if (!e.massKg) continue;
    const cur = byId.get(e.materialId) || { materialId: e.materialId, massKg: 0, runs: 0 };
    cur.massKg += e.massKg; cur.runs += 1;
    byId.set(e.materialId, cur);
  }
  return [...byId.values()]
    .map((r) => {
      const m = materialById(r.materialId);
      return { ...r, name: m?.name || r.materialId, co2Kg: m ? r.massKg * m.co2PerKg : null };
    })
    .sort((a, b) => b.massKg - a.massKg);
}

/**
 * The bill of materials the customer actually receives.
 *
 * Cells, conductors and the selected components, each with a count, a mass and
 * a cost where one is known — and an explicit list of what is NOT priced,
 * because a BOM with silent gaps is worse than one that admits them.
 */
export function billOfMaterials({ topology, summary, cell, selection = {}, currency = 'USD' }) {
  const lines = [];
  const unpriced = [];

  if (cell && summary?.cellCount) {
    const unit = cell.priceUSD ?? null;
    lines.push({
      group: 'Cells', item: cell.name, ref: cell.id,
      qty: summary.cellCount, unit: 'ea',
      massKg: (cell.massG || 0) * summary.cellCount / 1000,
      unitCost: unit, totalCost: unit != null ? unit * summary.cellCount : null,
      note: `${summary.s}S${summary.p}P`,
    });
    if (unit == null) unpriced.push(cell.name);
  }

  for (const m of materialBreakdown(topology)) {
    lines.push({
      group: 'Conductors', item: m.name, ref: m.materialId,
      qty: m.runs, unit: 'runs', massKg: m.massKg,
      unitCost: null, totalCost: null,
      note: `${m.massKg.toFixed(2)} kg${m.co2Kg != null ? ` · ${m.co2Kg.toFixed(1)} kg CO₂e embodied` : ''}`,
    });
    unpriced.push(m.name);
  }

  for (const [category, comp] of Object.entries(selection)) {
    if (!comp) continue;
    lines.push({
      group: 'Components', item: comp.name, ref: comp.id || category,
      qty: 1, unit: 'set', massKg: comp.massKg ?? null,
      unitCost: comp.priceUSD ?? null, totalCost: comp.priceUSD ?? null,
      note: category + (comp.suppliers?.length ? ` · e.g. ${comp.suppliers.join(', ')}` : ''),
    });
    if (comp.priceUSD == null) unpriced.push(comp.name);
  }

  if (topology) {
    lines.push({
      group: 'Joints', item: 'Bolted and welded joints', ref: 'joints',
      qty: topology.joints.length, unit: 'ea', massKg: null,
      unitCost: null, totalCost: null,
      note: 'Every one is a galvanic couple — see the corrosion check',
    });
  }

  const massKg = lines.reduce((s, l) => s + (l.massKg || 0), 0);
  const costed = lines.filter((l) => l.totalCost != null);
  return {
    currency, lines,
    totals: {
      lineCount: lines.length,
      massKg,
      knownCost: costed.reduce((s, l) => s + l.totalCost, 0),
      pricedLines: costed.length,
      unpricedLines: lines.length - costed.length,
    },
    unpriced: [...new Set(unpriced)],
    note: unpriced.length
      ? `${new Set(unpriced).size} item${new Set(unpriced).size === 1 ? '' : 's'} carry no price here — conductors are sold by the kilogram against a quote, and several components have no public list price. The mass is real; treat the cost total as the priced subset, not the pack.`
      : 'Every line is priced.',
    estimated: topology?.estimated ?? false,
  };
}
