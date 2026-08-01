// architecture.js — how a chosen pack is actually built up and switched:
// the module hierarchy (cells → optional modules → pack → parallel racks
// for big systems), the BMS topology, and the HV chain the customer needs
// around the cells — main contactors, precharge contactor + resistor, fuse,
// DC-DC converter, isolation floor and voltage class.
//
// Pure functions over a design summary. No DOM.
//
// Grounded in the pack implementation brief: module partition is divisor
// enumeration of S, with cell-to-pack as a first-class path (§4.1–4.2);
// BMS topology has NO quantitative crossover in any source, so it is an
// input with a scale-based suggestion (§8.4); precharge equations and
// closing sequence (§5.5); fuse rules of thumb (§5.5); isolation thresholds
// conflict between sources, so the governing standard is an explicit
// argument — never averaged, never silently defaulted (§5.6); 400 V and
// 800 V are power-semiconductor classes, not electrochemistry (§5.7).
// Where the sources give no number (wireless-BMS latency, contactor timing,
// aux DC-DC budget) this module says so instead of inventing one.

// AFE (analogue front-end) ICs run 14–25 cell channels at ±0.8–3 mV;
// daisy chains support up to 62 nodes.
export const AFE_CHANNELS_DEFAULT = 16;
export const AFE_CHANNELS_RANGE = [14, 25];
export const DAISY_NODE_LIMIT = 62;

// The §8.4 table, verbatim intent — shown to the customer so the topology
// choice is understandable, not hidden.
export const BMS_TOPOLOGIES = [
  { id: 'centralized', name: 'Centralized', when: 'Small, fixed-configuration packs; cost-dominated; low channel count. One controller senses every cell.' },
  { id: 'master-slave', name: 'Master / slave (daisy chain)', when: 'Scalable or configurable pack families; one slave board per module, daisy-chained to a master. Wiring reduction outweighs the slave PCB cost.' },
  { id: 'wireless', name: 'Wireless', when: 'Eliminates the intra-pack LV harness. No latency or reliability data exists in the sources — evaluate with the vendor before committing.' },
];

// Isolation floors — the two source standards CONFLICT (500 Ω/V citing
// UN ECE R100 vs 100 Ω/V DC per ISO 6469-3), so the governing standard is
// a required argument. Never average, never default silently.
export const ISOLATION_STANDARDS = {
  'ece-r100': { label: 'UN ECE R100', ohmsPerVolt: 500 },
  'iso-6469-dc': { label: 'ISO 6469-3 (DC circuits)', ohmsPerVolt: 100 },
};

export function divisors(n) {
  const out = [];
  for (let d = 1; d * d <= n; d++) {
    if (n % d === 0) { out.push(d); if (d !== n / d) out.push(n / d); }
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Module partition — divisor enumeration of S (§4.2). Selection criterion:
// the largest series divisor one AFE IC can sense, so each module carries
// exactly one slave board. Cell-to-pack (one virtual group, no physical
// module tier) is first-class, not a fallback: when a single AFE covers the
// whole string there is nothing to partition. Sanity check: 96S with
// 24-channel AFEs → 4 modules of 24S — the Tesla Model 3 architecture.
// ---------------------------------------------------------------------------
export function modulePartition(s, p, cell, opts = {}) {
  const channelsPerIc = opts.channelsPerIc ?? AFE_CHANNELS_DEFAULT;
  const notes = [];
  const mk = (sMod, pMod, virtual) => {
    const nModules = (s / sMod) * (p / pMod);
    const cellsPerModule = sMod * pMod;
    return {
      sMod, pMod, nModules, virtual, cellsPerModule,
      moduleVoltageNomV: sMod * cell.nominalV,
      moduleVoltageMaxV: sMod * cell.vMax,
      moduleEnergyWh: cellsPerModule * cell.nominalV * cell.capacityAh,
      moduleMassCellsKg: (cellsPerModule * cell.massG) / 1000,
      senseWiresPerModule: sMod + 1,
      senseWiresTotal: (s / sMod) * (sMod + 1),
      lvModule: sMod * cell.vMax <= 60,
      notes,
    };
  };

  if (s <= channelsPerIc) {
    notes.push('One AFE IC senses the whole string — the module collapses to a virtual group (cell-to-pack). No physical module tier is required.');
    return mk(s, p, true);
  }

  // Divisors of S that a single slave AFE can cover; ≥2 so a "module" means
  // an actual grouping, not one cell group per cell.
  const cands = divisors(s).filter((d) => d >= 2 && d <= channelsPerIc);
  if (!cands.length) {
    // No even series split exists (prime or awkward S). The honest answer is
    // a virtual grouping with several AFEs covering the string — plus a hint
    // that a divisor-friendly series count splits cleanly.
    notes.push(`${s} in series has no even split into ≤${channelsPerIc}-channel groups — the string stays one virtual group with ${Math.ceil(s / channelsPerIc)} AFE ICs. A series count with more divisors (e.g. ${nearestComposite(s)}) would partition into equal modules.`);
    return mk(s, p, true);
  }
  const sMod = cands[cands.length - 1];
  const part = mk(sMod, p, false);
  if (part.lvModule) {
    notes.push('Each module stays at or below the 60 V DC boundary (UN ECE R100) — it can be handled as a low-voltage part on its own.');
  } else {
    notes.push('A single module already exceeds 60 V DC — it is a high-voltage part even outside the pack.');
  }
  if (part.moduleMassCellsKg > 25) {
    notes.push(`~${Math.round(part.moduleMassCellsKg)} kg of cells per module — above common one-person manual-handling guidance (~25 kg); plan machine placement or split the parallel group.`);
  }
  return part;
}

function nearestComposite(s) {
  for (let d = 1; d < s; d++) {
    for (const c of [s - d, s + d]) {
      if (c >= 4 && divisors(c).some((x) => x >= 2 && x <= 25)) return c;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// The clear limit for big applications: this tool models ONE pack. A 1 MWh
// system is not one pack — it is N packs (racks / strings) of this design
// in parallel, each with its own contactors, fuse and BMS string. The plan
// says how many, instead of pretending a single enclosure scales forever.
// ---------------------------------------------------------------------------
export function systemPlan(targetEnergyWh, packEnergyWh) {
  if (!targetEnergyWh || !packEnergyWh || packEnergyWh <= 0) return null;
  const racks = Math.max(1, Math.ceil(targetEnergyWh / packEnergyWh));
  return {
    racks,
    targetWh: targetEnergyWh,
    coveragePct: Math.min(100, (packEnergyWh / targetEnergyWh) * 100),
    totalWh: racks * packEnergyWh,
    perPackWh: packEnergyWh,
  };
}

// ---------------------------------------------------------------------------
// Voltage class (§5.7). 400 V and 800 V clusters are power-semiconductor
// voltage classes (600 V Si, 1200 V SiC) — nothing about a cell prefers one.
// ---------------------------------------------------------------------------
export function voltageClass(vMaxV) {
  if (vMaxV <= 60) {
    return {
      id: 'lv', label: 'Low voltage (≤60 V DC)',
      note: 'Below the UN ECE R100 60 V DC boundary — no HVIL or isolation-monitoring burden. This is the entire reason 48 V systems exist.',
    };
  }
  if (vMaxV <= 300) {
    return {
      id: 'hv', label: 'High voltage (>60 V DC)',
      note: 'Above 60 V DC: isolation monitoring, HVIL, creepage rules and HV PPE all become mandatory.',
    };
  }
  if (vMaxV <= 500) {
    return {
      id: 'hv-400', label: 'High voltage — 400 V class',
      note: 'Matches 600 V silicon IGBT/MOSFET ratings. A semiconductor class, not an electrochemistry preference.',
    };
  }
  if (vMaxV <= 1000) {
    return {
      id: 'hv-800', label: 'High voltage — 800 V class',
      note: 'Matches 1200 V SiC MOSFET ratings. A semiconductor class, not an electrochemistry preference.',
    };
  }
  return {
    id: 'hv-1000+', label: 'High voltage (>1000 V DC)',
    note: 'Beyond the common automotive semiconductor classes — stationary/industrial switchgear territory.',
  };
}

// ---------------------------------------------------------------------------
// BMS architecture (§8.4). No quantitative crossover point exists in any
// source, so the topology is an INPUT; 'auto' applies a simple scale rule
// (one group → centralized, several → master/slave) and says so.
// ---------------------------------------------------------------------------
export function bmsArchitecture({ s, cellCount, partition, topology = 'auto', channelsPerIc, cellsPerTempSensor = 6 }) {
  const ch = channelsPerIc ?? AFE_CHANNELS_DEFAULT;
  const notes = [];
  let topo = topology;
  if (topo === 'auto') {
    topo = partition.nModules === 1 ? 'centralized' : 'master-slave';
    notes.push('Topology suggested by scale (one group → centralized, several modules → master/slave). The sources give no quantitative crossover — override it if your platform standardizes differently.');
  }
  const afePerModule = Math.ceil(partition.sMod / ch);
  const afeTotal = topo === 'centralized'
    ? Math.ceil(s / ch)
    : afePerModule * (s / partition.sMod);
  const daisyNodes = afeTotal;
  if (topo === 'master-slave' && daisyNodes > DAISY_NODE_LIMIT) {
    notes.push(`${daisyNodes} daisy-chained AFE nodes exceeds the ${DAISY_NODE_LIMIT}-node chain limit — split into several strings/racks, each with its own chain.`);
  }
  if (topo === 'wireless') {
    notes.push('Wireless eliminates the intra-pack LV harness, but no latency or reliability data exists in the sources — evaluate with the vendor before committing.');
  }
  // Temperature sensors: production reality spans 1 per 3 cells (BMW i3) to
  // 1 per 73 (Hyundai Kona) — a 24× spread. The ratio is an input; the
  // observability-optimal figure (1 per 3) is the justified maximum.
  const ratio = Math.max(1, cellsPerTempSensor);
  const tempSensors = Math.max(1, Math.ceil(cellCount / ratio));
  const tempSensorsObservability = Math.max(1, Math.ceil(cellCount / 3));
  return {
    topology: topo,
    topologyInfo: BMS_TOPOLOGIES.find((t) => t.id === topo) || null,
    channelsPerIc: ch,
    afeTotal, afePerModule, daisyNodes,
    senseWiresPerModule: partition.senseWiresPerModule,
    senseWiresTotal: partition.senseWiresTotal,
    tempSensors, cellsPerTempSensor: ratio, tempSensorsObservability,
    accuracyNote: 'AFE cell-voltage accuracy ±0.8–3 mV; current sensing better than 1%.',
    notes,
  };
}

// ---------------------------------------------------------------------------
// Precharge (§5.5): τ = R·C, V_c(t) = V·(1 − e^(−t/τ)), E = ½·C·V²,
// P_avg = E/t. Sequence: main negative → precharge → main positive, closing
// the mains only once the DC link is within ~10 V of pack voltage. The
// resistor is sized for a STATED repetition rate — no source gives a
// duty-cycle derating, and automotive (a few precharges a day) and robotics
// (many an hour) are very different duties.
// ---------------------------------------------------------------------------
export function prechargeDesign({ vPackMaxV, linkCapUF = 500, closeGapV = 10, targetTimeS = 0.5, prechargesPerHour = 4 }) {
  if (!(vPackMaxV > closeGapV)) return null;
  const C = linkCapUF * 1e-6;
  // t to come within closeGapV of V: V·e^(−t/τ) = gap → t = τ·ln(V/gap).
  const tau = targetTimeS / Math.log(vPackMaxV / closeGapV);
  const rOhm = tau / C;
  const energyJ = 0.5 * C * vPackMaxV * vPackMaxV;
  return {
    rOhm, tauS: tau, closeGapV, timeToCloseS: targetTimeS,
    peakCurrentA: vPackMaxV / rOhm,
    peakPowerW: (vPackMaxV * vPackMaxV) / rOhm,
    energyPerEventJ: energyJ,
    avgPowerDuringEventW: energyJ / targetTimeS,
    prechargesPerHour,
    continuousDissipationW: (energyJ * prechargesPerHour) / 3600,
    linkCapUF,
    sequence: [
      'Close the main NEGATIVE contactor',
      'Close the precharge contactor — the resistor charges the DC link',
      `Wait ~${round2(targetTimeS)} s until the link is within ~${closeGapV} V of pack voltage`,
      'Close the main POSITIVE contactor',
      'Open the precharge contactor',
    ],
    notes: [
      'The DC-link capacitance belongs to the load\'s inverter — replace the default with the real value from its datasheet.',
      'Pick the resistor\'s energy (J) and power ratings for the stated repetition rate; the sources give no duty-cycle derating.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Contactors and fuse (§5.4–5.5). Fuse ≈2× continuous; operate ≤50% of the
// melting curve; break ≥1.15× the worst-case incomplete short. Contactor
// mass ≈150 g + 1 g/A (the reference itself calls the n=23 fit weak).
// ---------------------------------------------------------------------------
export function contactorsAndFuse({ contA, vMaxV }) {
  const massEachG = contA != null ? 150 + contA : null;
  return {
    mains: 2, precharge: 1,
    ratingA: contA ?? null,
    massEachG,
    contactResistanceNote: '400 A-class contact resistance 50–150 µΩ new; >500 µΩ is critical — replace at +30% from baseline.',
    massNote: 'Mass ≈150 g + 1 g per amp of continuous rating — a weak fit (n=23), use for budgeting only.',
    fuse: {
      ratingA: contA != null ? 2 * contA : null,
      rules: [
        'Rating ≈2× continuous current (automotive rule of thumb).',
        'Operating current ≤50% of the melting I–t curve.',
        'Breaking capacity ≥1.15× the worst-case incomplete short circuit.',
      ],
      stationaryNote: 'Re-examine for stationary racks: paralleled strings feed much larger fault currents than a single automotive pack.',
    },
    lvNote: vMaxV != null && vMaxV <= 60
      ? 'At ≤60 V DC many designs replace contactors with solid-state (MOSFET) disconnects; the chain shown is the general capacitive-load case.'
      : null,
  };
}

// ---------------------------------------------------------------------------
// Isolation floor (§5.6). The standard is a REQUIRED argument because the
// sources conflict; this function refuses to guess.
// ---------------------------------------------------------------------------
export function isolationRequirement(vMaxV, standard) {
  const std = ISOLATION_STANDARDS[standard];
  if (!std) {
    throw new Error(`isolationRequirement needs the governing standard as an explicit argument (${Object.keys(ISOLATION_STANDARDS).join(' | ')}) — the sources conflict (500 Ω/V vs 100 Ω/V DC) and must not be averaged or silently defaulted.`);
  }
  return {
    standard, standardLabel: std.label, ohmsPerVolt: std.ohmsPerVolt,
    floorKOhm: (vMaxV * std.ohmsPerVolt) / 1000,
    oemPracticeNote: 'Observed OEM design targets sit an order of magnitude above the floor — >1.5 MΩ; one manufacturer specifies >3 MΩ contactors-open, >2 MΩ closed.',
    groundingNote: 'Assumes a chassis-referenced ground. Do not apply to ungrounded/IT topologies (conventional in marine DC systems).',
  };
}

// ---------------------------------------------------------------------------
// DC-DC converter. In the pack architecture this is the HV→LV auxiliary
// supply (BMS, contactor coils, pumps, fans). The sources give NO aux power
// budget — sizing needs the customer's LV load list, and this says so.
// For >500 V packs the §7.6 charging trade-off is attached.
// ---------------------------------------------------------------------------
export function dcdcConverter({ vMin, vMax, lvBusV = 12, auxPowerW = null }) {
  return {
    inputRangeV: [vMin, vMax], lvBusV, auxPowerW,
    sizingNote: auxPowerW != null
      ? `Sized for the stated ${Math.round(auxPowerW)} W auxiliary budget — confirm against the real LV load list.`
      : 'The sources give no default auxiliary budget — size from the LV load list (BMS, contactor coils, pumps, fans).',
    chargingNote: vMax > 500
      ? 'An 800 V-class pack at a 400 V charger needs either a DC-DC boost stage (50–150 kW, 3–5% loss) or a split-pack/bank arrangement (2× fuses/contactors/current sensors, <15 V SoC alignment before paralleling, asymmetric-ageing risk).'
      : null,
  };
}

// ---------------------------------------------------------------------------
// Pack resistance (§5.2): R_pack = S·R_cell/P + R_interconnect, where the
// interconnect lump (busbars, joints, contactors, fuse, shunt) is 10–30 mΩ
// typical for an automotive HV pack — a 3× spread, so the value is exposed.
// ---------------------------------------------------------------------------
export function packResistanceModel({ s, p, cellDcirMOhm, interconnectMOhm = 20, contA = null }) {
  const cellsMOhm = cellDcirMOhm != null ? (s * cellDcirMOhm) / p : null;
  const totalMOhm = cellsMOhm != null ? cellsMOhm + interconnectMOhm : null;
  return {
    cellsMOhm, interconnectMOhm, totalMOhm,
    droopVAtCont: totalMOhm != null && contA != null ? (totalMOhm / 1000) * contA : null,
    lossWAtCont: totalMOhm != null && contA != null ? (totalMOhm / 1000) * contA * contA : null,
    interconnectNote: 'Interconnect lump (busbars, joints, contactors, fuse, current shunt) is 10–30 mΩ typical automotive — a 3× spread; build it up from components when the joint count is known.',
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — everything the customer needs to see the architecture of
// one design, in one object.
// ---------------------------------------------------------------------------
export function buildArchitecture({ cell, s, p, summary, options = {} }) {
  const partition = modulePartition(s, p, cell, { channelsPerIc: options.channelsPerIc });
  const vc = voltageClass(summary.vMax);
  const bms = bmsArchitecture({
    s, cellCount: summary.cellCount, partition,
    topology: options.topology ?? 'auto',
    channelsPerIc: options.channelsPerIc,
    cellsPerTempSensor: options.cellsPerTempSensor,
  });
  const precharge = prechargeDesign({
    vPackMaxV: summary.vMax,
    linkCapUF: options.linkCapUF,
    targetTimeS: options.prechargeTimeS,
    prechargesPerHour: options.prechargesPerHour,
  });
  const contactors = contactorsAndFuse({ contA: summary.maxContCurrentA, vMaxV: summary.vMax });
  // Below 60 V DC there is no isolation-monitoring burden — that is the
  // point of the LV boundary; above it the standard must be stated.
  const isolation = summary.vMax > 60
    ? isolationRequirement(summary.vMax, options.isolationStandard)
    : null;
  const dcdc = dcdcConverter({
    vMin: summary.vMin, vMax: summary.vMax,
    lvBusV: options.lvBusV, auxPowerW: options.auxPowerW,
  });
  const resistance = packResistanceModel({
    s, p, cellDcirMOhm: cell.dcirMOhm ?? null,
    interconnectMOhm: options.interconnectMOhm,
    contA: summary.maxContCurrentA,
  });
  const system = systemPlan(options.targetEnergyWh, summary.energyWh);
  return { partition, voltageClass: vc, bms, precharge, contactors, isolation, dcdc, resistance, system };
}

const round2 = (v) => Math.round(v * 100) / 100;
