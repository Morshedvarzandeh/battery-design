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
  {
    id: 'centralized', name: 'Centralized',
    when: 'Small, fixed-configuration packs; cost-dominated; low channel count. One controller senses every cell.',
    pros: ['lowest cost — one board, no chain transceivers', 'simplest to certify and debug', 'no inter-board comms to fail'],
    cons: ['every sense wire runs the full pack to one board — harness length and noise grow with S', 'no serviceable module boundary', 'a board failure blinds the whole pack'],
  },
  {
    id: 'master-slave', name: 'Master / slave (daisy chain)',
    when: 'Scalable or configurable pack families; one slave board per module, daisy-chained to a master. Wiring reduction outweighs the slave PCB cost.',
    pros: ['sense wires stay short — inside each module', 'scales by adding slaves; modules are serviceable units', 'isoSPI chain replaces a fat harness'],
    cons: ['one slave PCB per module of extra cost', 'a broken chain link isolates everything past it (ring topology mitigates)', 'hard limit: ≤62 nodes per chain'],
  },
  {
    id: 'wireless', name: 'Wireless',
    when: 'Eliminates the intra-pack LV harness. No latency or reliability data exists in the sources — evaluate with the vendor before committing.',
    pros: ['no intra-pack LV harness at all — mass, connectors and routing disappear', 'modules place freely'],
    cons: ['NO latency or reliability data exists in the sources — unproven here', 'RF inside a metal enclosure needs validation', 'security/pairing adds certification scope'],
  },
];

// The chosen topology judged against THIS design — pros and cons are table
// facts; the verdict is contextual, and "not workable" is reserved for
// limits the sources actually give (the 62-node chain).
export function assessBmsTopology({ topology, s, afeTotal, nModules }) {
  const t = BMS_TOPOLOGIES.find((x) => x.id === topology);
  if (!t) return null;
  let verdict = 'workable';
  let why = '';
  if (topology === 'master-slave' && afeTotal > DAISY_NODE_LIMIT) {
    verdict = 'not-workable';
    why = `${afeTotal} AFE nodes exceed the ${DAISY_NODE_LIMIT}-node daisy-chain limit — as ONE chain this cannot be built. The fix: split into ${Math.ceil(afeTotal / DAISY_NODE_LIMIT)} parallel chains (or racks), each within the limit.`;
  } else if (topology === 'wireless') {
    verdict = 'unproven';
    why = 'No latency or reliability data exists in the sources — treat as a vendor evaluation, not a paper decision.';
  } else if (topology === 'centralized' && nModules > 1) {
    verdict = 'workable-with-costs';
    why = `${s + 1} sense wires must run from every group across ${nModules} physical modules to one board — the harness IS the cost; count it before choosing.`;
  } else {
    why = 'Fits the design at this scale.';
  }
  return { ...t, verdict, why };
}

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

  // Mechanics sometimes fix the module BEFORE the electronics: a 30S
  // module at 16-channel AFEs simply needs TWO slave ICs. An explicit
  // module size (any divisor of S) must be representable — the partition
  // adapts the electronics to it, never silently re-shapes the module.
  const ov = opts.sModOverride;
  if (ov != null && ov !== 'auto') {
    const sMod = Math.round(ov);
    if (sMod >= 1 && s % sMod === 0) {
      const nIcs = Math.ceil(sMod / channelsPerIc);
      if (nIcs > 1) {
        notes.push(`Each ${sMod}S module needs ${nIcs} AFE ICs at ${channelsPerIc} channels — multi-slave modules are normal when the mechanical module is fixed first.`);
      }
      return mk(sMod, p, false);
    }
    notes.push(`${ov}S does not divide ${s}S — the module series count must be a divisor of S (${divisors(s).join(', ')}); using the automatic partition instead.`);
  }

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
// Cell joining / welding — each cell format takes a DIFFERENT process, and
// showing the wrong one designs the wrong factory. Per the automotive
// joining review (Lee, Kim, Hu, Cai & Abell, ASME MSEC2010-34168) and the
// brief §4.3: aluminium and copper tabs resist resistance welding (high
// conductivity, dissimilar melting points Al 660 / Cu 1080 / Ni 1450 °C);
// ultrasonic (≥20 kHz, solid-state, <3 mm stack) is the pouch-tab champion;
// laser is the non-contact choice for cases, interconnects and busbars —
// with penetration controlled so the nugget never reaches the electrolyte.
// ---------------------------------------------------------------------------
export const WELDING_BY_FORM = {
  cylindrical: {
    primary: 'Resistance spot weld — nickel strip/tab onto can and cap',
    alternates: [
      'Projection weld (focused current — thicker tabs, repeatable nuggets)',
      'Laser weld collector plates to the can rim',
      'Ultrasonic Al wire bond (Tesla-style; each bond doubles as a per-cell fuse)',
    ],
    cautions: [
      'Nickel strip welds well; aluminium/copper busbars need nickel plating, projection joints or a different process.',
      'Slotted busbars force the weld current through the joint instead of shunting around it.',
    ],
  },
  prismatic: {
    primary: 'Laser weld — busbar (typically Al) onto the terminal',
    alternates: ['Bolted terminals / mechanical fastening (serviceable, higher contact resistance)'],
    cautions: [
      'Millisecond non-contact heating — penetration must be controlled so the weld nugget never reaches the case interior.',
      'Dissimilar Al–Cu terminal pairs need process care (660 vs 1080 °C melting points).',
    ],
  },
  pouch: {
    primary: 'Ultrasonic weld — the thin Al/Cu tab stack (≥20 kHz solid-state bond)',
    alternates: ['Laser or resistance weld with tab adapters'],
    cautions: [
      'The champion for dissimilar multi-layer thin foils: low temperature, no filler; joint stack limited to <3 mm and soft materials.',
    ],
  },
};

export function weldingForCell(cell) {
  return WELDING_BY_FORM[cell.form] || null;
}

// ---------------------------------------------------------------------------
// Communication — different applications speak different buses, and the
// BMS must speak the right one: SAE J1939 on heavy trucks and lift trucks,
// CAN/CAN FD with UDS diagnostics on automotive, CANopen on industrial
// AGVs, Modbus/SunSpec on stationary storage, NMEA 2000 on boats. These
// are public standard names and class practice; the bit rate and node IDs
// come from the vehicle/plant integration (the sources give no CAN bit
// rate — that is the integrator's number, not the pack's).
// ---------------------------------------------------------------------------
export const COMMS_BY_APP = {
  ev: {
    primary: 'CAN 2.0B / CAN FD (ISO 11898) + UDS diagnostics (ISO 14229)',
    alternates: ['SAE J1939 for heavy/commercial vehicles', 'ISO 15118 / DIN 70121 to the DC charger'],
    note: 'Automotive BMS report on the vehicle CAN and expose diagnostics (incl. live SoH for the EU battery passport) over UDS; heavy trucks and buses use the J1939 flavor instead.',
  },
  ebus: {
    primary: 'SAE J1939 (heavy-vehicle CAN, PGN-based)',
    alternates: ['CAN FD + UDS (ISO 14229) diagnostics', 'ISO 15118 / OppCharge to the pantograph or plug charger'],
    note: 'Buses and heavy trucks live on the J1939 bus — the battery reports as a J1939 node; diagnostics and passport SoH access still ride UDS.',
  },
  robot: {
    primary: 'CANopen (CiA 301, battery profile CiA 418)',
    alternates: ['SAE J1939 (lift trucks / heavy platforms)', 'EtherCAT (high-rate robotics)'],
    note: 'Industrial AGVs/AMRs standardize on CANopen; counterbalance lift trucks inherit the J1939 truck bus from their diesel ancestors.',
  },
  humanoid: {
    primary: 'CAN FD battery node on the robot bus',
    alternates: ['EtherCAT (joint/actuator bus)'],
    note: 'Humanoids run a high-rate joint bus; the battery reports as a CAN/CAN FD node beside it.',
  },
  robovac: {
    primary: 'SMBus / I²C smart-battery (SBS 1.1 gauge)',
    alternates: ['proprietary UART'],
    note: 'Consumer robots use a smart-battery gauge link, not a vehicle bus.',
  },
  wearable: {
    primary: 'I²C fuel gauge to the 1S PMIC',
    alternates: ['BLE to the phone via the SoC'],
    note: 'A wearable has no battery bus: a fuel-gauge IC reports over I²C to the power-management IC, and the SoC relays state over BLE. Protection is a 1S protection IC, not a BMS board.',
  },
  marine: {
    primary: 'NMEA 2000 (J1939-based)',
    alternates: ['CAN (Victron VE.Can class)', 'Modbus to shore/inverter gear'],
    note: 'Boat networks are NMEA 2000; house-bank BMS often bridge to the inverter/charger vendor bus as well.',
  },
  rv: {
    primary: 'RV-C or CAN (J1939-derived)',
    alternates: ['Victron VE.Can class', 'Modbus'],
    note: 'RV house systems use RV-C in North America and vendor CAN elsewhere; inverter/solar controllers usually add a Modbus or vendor-CAN link.',
  },
  'solar-ess': {
    primary: 'Modbus RTU/TCP (SunSpec profile)',
    alternates: ['inverter-vendor CAN (SMA / Victron / BYD-style)', 'IEC 61850 at grid scale'],
    note: 'Stationary storage talks to the hybrid inverter — SunSpec Modbus is the interop baseline; every inverter brand also has its own CAN dialect.',
  },
  ups: {
    primary: 'Modbus RTU/TCP',
    alternates: ['SNMP via the UPS controller', 'CAN'],
    note: 'Telecom/UPS cabinets are monitored over Modbus or SNMP; the battery string reports into the rectifier controller.',
  },
  powerstation: {
    primary: 'Proprietary UART/BLE app link',
    alternates: ['SMBus internally'],
    note: 'Suitcase power boxes expose a phone app; internally the pack is a smart-battery gauge.',
  },
  ebike: {
    primary: 'Drive-system CAN (Bosch/Shimano-class) or UART',
    alternates: ['proprietary BMS UART (DIY/hobby)'],
    note: 'Branded drive systems pair battery and motor over their own CAN; open systems use simple UART BMS links.',
  },
  escooter: {
    primary: 'UART/proprietary BMS link',
    alternates: ['CAN on fleet scooters (IoT board)'],
    note: 'Shared-fleet scooters add a CAN/IoT board for telemetry; consumer ones stay on UART.',
  },
  drone: {
    primary: 'SMBus smart-battery (DJI-class)',
    alternates: ['UART telemetry to the flight controller'],
    note: 'Smart flight batteries authenticate and report over SMBus; the flight controller enforces the limits.',
  },
  powertool: {
    primary: 'Proprietary 1-Wire/serial pack link',
    alternates: [],
    note: 'Tool packs use a minimal vendor link for temperature/ID — there is no open standard here.',
  },
  default: {
    primary: 'CAN (the dominant industrial choice)',
    alternates: ['SAE J1939 (heavy vehicles)', 'CANopen (industrial machines)', 'Modbus (stationary plant)'],
    note: 'Pick the bus your integration already speaks — the pack adapts to the vehicle/plant network, not the other way around.',
  },
};

export function commsForApp(appId) {
  return COMMS_BY_APP[appId] || COMMS_BY_APP.default;
}

// ---------------------------------------------------------------------------
// The supervisory layer ABOVE the BMS — the control hierarchy is cell →
// module (slave AFE) → BMS master → SUPERVISOR, and the supervisor is a
// different machine per application: an EMS dispatches a storage plant, a
// VCU coordinates a vehicle, a fleet controller runs the AGVs, a host SoC
// owns a gadget. The BMS protects the battery; the supervisor decides what
// the battery is asked to do.
// ---------------------------------------------------------------------------
export const SUPERVISORS_BY_APP = {
  ev: {
    name: 'VCU (vehicle control unit)',
    role: 'Coordinates torque, regen blending, charging and thermal preconditioning; the BMS publishes limits (SoP), the VCU stays inside them.',
    detail: {
      functions: ['torque & regen blending inside the BMS SoP limits', 'charge session control (ISO 15118 to the charger)', 'thermal preconditioning requests to the BTMS'],
      interfaces: ['vehicle CAN / CAN FD', 'UDS (ISO 14229) diagnostics', 'ISO 15118 / DIN 70121 charge comms'],
    },
  },
  ebus: {
    name: 'VCU + depot EMS',
    role: 'Vehicle control on board plus a DEPOT ENERGY MANAGEMENT SYSTEM off board — the depot EMS schedules which bus charges when, against grid limits and departure times; the BMS only enforces limits.',
    detail: {
      functions: ['on-board: torque/regen and charge control', 'depot EMS: fleet charging schedule vs grid connection limit', 'departure-time and route-energy planning'],
      interfaces: ['SAE J1939 on board', 'OppCharge / ISO 15118 to chargers', 'OCPP from the depot EMS to charge points'],
    },
  },
  ebike: {
    name: 'Drive unit controller',
    role: 'The motor drive unit is the system master (Bosch/Shimano pattern); the battery reports capacity and limits to it.',
    detail: {
      functions: ['assist-level power management', 'range estimation from the pack gauge'],
      interfaces: ['drive-system CAN or UART'],
    },
  },
  escooter: {
    name: 'Controller + fleet IoT board',
    role: 'The motor controller runs the ride; shared fleets add an IoT board for remote lock, telemetry and geofencing.',
    detail: {
      functions: ['ride power control', 'fleet: remote lock, geofencing, battery telemetry'],
      interfaces: ['UART to the BMS', 'CAN + cellular on fleet IoT boards'],
    },
  },
  'solar-ess': {
    name: 'EMS (energy management system)',
    role: 'Dispatches charge/discharge against tariffs, solar forecast and grid codes via the hybrid inverter (PCS); the BMS enforces the battery envelope.',
    detail: {
      functions: ['dispatch: charge on solar surplus / cheap tariff, discharge on peaks', 'solar and load forecasting', 'grid-code compliance (feed-in limits, frequency response)', 'PCS/inverter setpoints — always inside the BMS-published envelope'],
      interfaces: ['SunSpec Modbus RTU/TCP to the inverter', 'inverter-vendor CAN dialects', 'IEC 61850 at grid scale', 'cloud/portal for tariffs and monitoring'],
    },
  },
  ups: {
    name: 'UPS / rectifier controller (EMS role)',
    role: 'Owns the transfer logic and float strategy; the battery string reports health and takes the load on mains failure.',
    detail: {
      functions: ['mains-failure transfer logic', 'float/equalize strategy and battery test cycles', 'alarm escalation to the NOC'],
      interfaces: ['Modbus RTU/TCP', 'SNMP to the monitoring system', 'dry contacts for hard alarms'],
    },
  },
  rv: {
    name: 'Power hub / inverter-charger controller (EMS role)',
    role: 'Prioritizes alternator, solar and shore sources and sheds loads; the battery publishes its state on the house network.',
    detail: {
      functions: ['source priority: alternator / solar / shore', 'load shedding below a state-of-charge floor', 'charge profile per battery chemistry'],
      interfaces: ['RV-C or vendor CAN', 'Modbus to solar/inverter gear'],
    },
  },
  marine: {
    name: 'PMS (power management system — the vessel\'s EMS)',
    role: 'Vessel-level source and load management under class rules; battery banks are one source among generators and shore power.',
    detail: {
      functions: ['source scheduling: generators / battery / shore', 'load management under class-society rules', 'blackout prevention and recovery'],
      interfaces: ['NMEA 2000', 'Modbus to inverter/chargers', 'class-approved alarm panel'],
    },
  },
  robot: {
    name: 'Robot / fleet controller (fleet EMS role)',
    role: 'Schedules missions and opportunity charging across the fleet (PLC/WMS level); each truck\'s BMS guards its own pack.',
    detail: {
      functions: ['mission scheduling vs pack state of charge', 'opportunity-charge slotting across the fleet', 'charger allocation'],
      interfaces: ['CANopen to the vehicle', 'WMS/PLC network (fieldbus or Ethernet)'],
    },
  },
  humanoid: {
    name: 'Robot main computer',
    role: 'The locomotion/planning computer budgets power per task; the battery node reports state over the robot bus.',
    detail: {
      functions: ['per-task power budgeting', 'return-to-dock decision from pack state'],
      interfaces: ['CAN FD battery node', 'EtherCAT joint bus alongside'],
    },
  },
  drone: {
    name: 'Flight controller',
    role: 'Enforces return-to-home and landing thresholds from the smart battery\'s reported state.',
    detail: {
      functions: ['return-to-home / forced-landing thresholds', 'per-mission energy budgeting'],
      interfaces: ['SMBus smart battery', 'telemetry downlink'],
    },
  },
  powertool: {
    name: 'Tool MCU',
    role: 'A minimal controller reads pack ID/temperature and cuts on stall; there is no higher layer.',
    detail: {
      functions: ['stall cut-off', 'pack ID / chemistry handshake'],
      interfaces: ['1-Wire / vendor serial'],
    },
  },
  powerstation: {
    name: 'Device MCU + phone app (EMS role)',
    role: 'Owns the inverter, input priorities and the user interface; the pack gauge feeds it.',
    detail: {
      functions: ['input priority: solar / AC / car', 'inverter load management', 'user limits via the app'],
      interfaces: ['SMBus internally', 'BLE/Wi-Fi to the app'],
    },
  },
  robovac: {
    name: 'Host SoC (navigation computer)',
    role: 'Decides when to return to dock from the gauge\'s reported state; charging is dock-controlled.',
    detail: {
      functions: ['return-to-dock decision', 'clean-cycle planning vs remaining charge'],
      interfaces: ['I²C gauge', 'dock charge handshake'],
    },
  },
  wearable: {
    name: 'Host SoC / PMIC',
    role: 'The power-management IC and SoC budget every milliwatt; the fuel gauge is their sensor, not a controller.',
    detail: {
      functions: ['milliwatt power budgeting per feature', 'low-battery feature shedding'],
      interfaces: ['I²C fuel gauge', 'BLE to the phone'],
    },
  },
  default: {
    name: 'Supervisory controller (EMS / ECU / host)',
    role: 'Every deployed pack answers to a system controller above the BMS — name it early; its bus and update rate shape the BMS interface.',
    detail: {
      functions: ['decides what the battery is asked to do, inside the BMS-published limits'],
      interfaces: ['the bus named under Communication'],
    },
  },
};

export function supervisorForApp(appId) {
  return SUPERVISORS_BY_APP[appId] || SUPERVISORS_BY_APP.default;
}

// ---------------------------------------------------------------------------
// EMS architectures — from the microgrid/ESS literature, the same way the
// BMS got its topology table. Three families recur across the reviews and
// the IEEE 2030.7 microgrid-controller framing:
//   centralized — one controller optimizes every asset;
//   hierarchical — three control levels with separate timescales (primary:
//     device, ms; secondary: site coordination, seconds–minutes; tertiary:
//     market/grid dispatch, minutes–hours);
//   distributed — units decide locally and coordinate through shared
//     signals (droop / price), no single point of failure.
// Like BMS topology, no universal crossover exists — the choice is an
// input with a scale-based suggestion. And integration holds: this table
// exists ONLY for applications that genuinely have an EMS; a wearable or
// a power tool never sees it.
// ---------------------------------------------------------------------------
export const EMS_ARCHITECTURES = [
  {
    id: 'centralized',
    name: 'Centralized EMS',
    when: 'One controller measures and dispatches every asset. Right for single-site, few-asset plants (a home ESS, one container) — simplest to build and certify, but a single point of failure and it scales poorly past a handful of assets.',
    pros: ['simplest to build, certify and reason about', 'globally optimal dispatch is straightforward — one solver sees everything', 'one integration point for tariffs and monitoring'],
    cons: ['single point of failure — the plant is blind when it dies', 'scales poorly: every asset added grows one controller\'s I/O and compute', 'site-wide comms outage stops dispatch entirely'],
  },
  {
    id: 'hierarchical',
    name: 'Hierarchical EMS (three control levels)',
    when: 'The microgrid-literature standard (IEEE 2030.7 framing): primary control at the device (milliseconds, inverter-local), secondary coordinating the site (seconds–minutes, voltage/frequency restoration and setpoint sharing), tertiary running dispatch against markets and grid codes (minutes–hours). Right for multi-rack plants, depots and utility-scale systems.',
    pros: ['each timescale handled where it belongs — device stability survives a site-level outage', 'scales to utility plants and depots', 'the literature and IEEE 2030.7 default — auditors know it'],
    cons: ['three layers to build, test and version', 'inter-level interfaces need careful specification', 'overkill for a single home unit'],
  },
  {
    id: 'distributed',
    name: 'Distributed EMS (droop / peer signals)',
    when: 'Each unit decides locally and coordinates through shared signals — droop curves, price broadcasts, consensus. No single point of failure and racks can join/leave freely; harder to prove optimal behavior, and market participation still needs an aggregating layer.',
    pros: ['no single point of failure — units keep working alone', 'racks join and leave freely (plug-and-play growth)', 'minimal central infrastructure'],
    cons: ['global optimality is hard to prove — behavior emerges from local rules', 'market/grid-code participation still needs an aggregating layer on top', 'fault diagnosis across peers is harder'],
  },
];

// The chosen EMS architecture judged against THIS plant.
export function assessEmsArchitecture(emsArch) {
  if (!emsArch) return null;
  const a = emsArch.chosen;
  let verdict = emsArch.overridden ? 'workable-with-costs' : 'suggested';
  let why = emsArch.overridden
    ? `Auto suggests ${emsArch.recommended} at this scale — your choice stands, with its costs listed.`
    : 'Matches the scale suggestion.';
  return { ...a, verdict, why };
}

// Applications whose supervisor genuinely IS an energy management system
// coordinating multiple assets. Everything else returns null — the EMS
// architecture question must never appear for a wearable.
const EMS_ARCH_APPS = new Set(['solar-ess', 'ups', 'ebus', 'marine', 'robot']);

export function emsArchitectureFor(appId, racks = 1, override = 'auto') {
  if (!EMS_ARCH_APPS.has(appId)) return null;
  // Scale suggestion: one asset -> centralized; several racks/vehicles ->
  // hierarchical (the literature default for coordinated plants).
  const recommended = (racks ?? 1) > 1 ? 'hierarchical' : 'centralized';
  const chosenId = override && override !== 'auto' ? override : recommended;
  const chosen = EMS_ARCHITECTURES.find((a) => a.id === chosenId) || EMS_ARCHITECTURES[0];
  return {
    chosen, recommended,
    overridden: !!(override && override !== 'auto' && override !== recommended),
    list: EMS_ARCHITECTURES,
    note: 'Families per the microgrid EMS literature and the IEEE 2030.7 microgrid-controller framing — like BMS topology, no universal crossover exists, so the choice is an input with a scale-based suggestion.',
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — everything the customer needs to see the architecture of
// one design, in one object.
// ---------------------------------------------------------------------------
export function buildArchitecture({ cell, s, p, summary, options = {} }) {
  const partition = modulePartition(s, p, cell, {
    channelsPerIc: options.channelsPerIc,
    sModOverride: options.sModOverride,
  });
  const vc = voltageClass(summary.vMax);
  const bms = bmsArchitecture({
    s, cellCount: summary.cellCount, partition,
    topology: options.topology ?? 'auto',
    channelsPerIc: options.channelsPerIc,
    cellsPerTempSensor: options.cellsPerTempSensor,
  });
  // Integration: below the 60 V DC boundary the HV precharge chain is
  // noise — LV packs use solid-state disconnects (the contactor section
  // carries that note) — so the whole section is omitted, and the panel,
  // diagram, report and findings all follow from this one decision.
  const precharge = summary.vMax > 60 ? prechargeDesign({
    vPackMaxV: summary.vMax,
    linkCapUF: options.linkCapUF,
    targetTimeS: options.prechargeTimeS,
    prechargesPerHour: options.prechargesPerHour,
  }) : null;
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
  // The stack/rack count: derived from the energy target by default, but a
  // customer whose plant layout already fixes it (BESS container, ship bus,
  // articulated bus) can set it directly — that is a legitimate input, not
  // something to re-derive against their will.
  let system;
  const n = Math.round(options.racksOverride);
  if (n >= 1) {
    const totalWh = n * summary.energyWh;
    system = {
      racks: n, targetWh: options.targetEnergyWh ?? null,
      totalWh, perPackWh: summary.energyWh,
      coveragePct: options.targetEnergyWh ? Math.min(100, (totalWh / options.targetEnergyWh) * 100) : null,
      overridden: true,
    };
  } else {
    system = systemPlan(options.targetEnergyWh, summary.energyWh);
  }
  const comms = commsForApp(options.appId);
  const welding = weldingForCell(cell);
  const supervisor = supervisorForApp(options.appId);
  const emsArch = emsArchitectureFor(options.appId, system?.racks ?? 1, options.emsOverride);
  return { partition, voltageClass: vc, bms, precharge, contactors, isolation, dcdc, resistance, system, comms, welding, supervisor, emsArch };
}

const round2 = (v) => Math.round(v * 100) / 100;
