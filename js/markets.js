// markets.js — the release checklist: which standards and market rules a
// design must clear BEFORE it can ship, per application class and target
// market. This is the list a program manager pins to the wall — it does
// not certify anything, it names what certification will demand.
//
// HONESTY: entries are the well-established, publicly named requirements
// for each class; markets move (China's catalogue practice especially), so
// every list says "verify current text". Chemistry-market rules encode
// widely-documented practice — the flag tells the customer to check the
// current catalogue, not that a sale is legally impossible today.

export const MARKETS = [
  { id: 'eu', name: 'European Union' },
  { id: 'us', name: 'United States' },
  { id: 'cn', name: 'China' },
  { id: 'intl', name: 'International / UN' },
];

// Application classes: road vehicles, light means of transport, stationary
// storage, marine, portable/consumer, industrial trucks (AGV/forklift).
export const CLASS_OF_APP = {
  ev: 'vehicle', ebus: 'vehicle',
  ebike: 'lmt', escooter: 'lmt',
  'solar-ess': 'stationary', ups: 'stationary',
  rv: 'auxiliary',
  marine: 'marine',
  robot: 'industrial', humanoid: 'industrial',
  drone: 'portable', powertool: 'portable', powerstation: 'portable', robovac: 'portable',
  wearable: 'portable',
};

// The single source of "what kind of thing is this application" — every
// module that filters by application (standards list, checklist, comms)
// resolves through here so they can never disagree.
export function appClassOf(appId) {
  return CLASS_OF_APP[appId] || null;
}

const item = (code, title, scope, note) => ({ code, title, scope, note: note || '' });

// scope: 'mandatory' (legally required / type approval), 'expected'
// (customers and insurers demand it), 'practice' (good practice).
const CHECKLISTS = {
  vehicle: {
    common: [
      item('UN 38.3', 'Transport test report (T1–T8)', 'mandatory', 'Needed before any cell or pack ships anywhere by air/sea/road.'),
      item('ISO 6469-1/-3', 'RESS safety + electrical protection', 'expected'),
      item('ISO 26262', 'Functional safety of the BMS (ASIL per hazard analysis)', 'expected'),
    ],
    eu: [
      item('UN ECE R100 Annex 4', 'Type approval of the REESS (M/N vehicles)', 'mandatory'),
      item('Regulation (EU) 2023/1542', 'Battery passport, carbon declaration, recycled content — see the Rules tab timeline', 'mandatory'),
    ],
    us: [
      item('FMVSS 305 / 305a', 'Electrolyte spillage & electrical isolation post-crash', 'mandatory'),
      item('SAE J2929 / J2464', 'Pack safety performance and abuse testing', 'expected'),
      item('UL 2580', 'Batteries for use in electric vehicles', 'expected'),
    ],
    cn: [
      item('GB 38031-2025', 'EV traction battery safety (incl. no-fire/no-explosion thermal propagation)', 'mandatory'),
      item('GB 18384-2025', 'Electric vehicle safety requirements', 'mandatory'),
      item('GB/T 31498', 'Post-crash safety requirements', 'expected'),
    ],
    intl: [
      item('UN ECE R100 / R136', 'REESS type approval under the 1958 Agreement', 'mandatory'),
    ],
  },
  lmt: {
    common: [
      item('UN 38.3', 'Transport test report', 'mandatory'),
      item('IEC 62133-2', 'Safety of portable sealed cells and packs', 'expected'),
    ],
    eu: [
      item('EN 15194 / UN ECE R136', 'EPAC e-bike / L-category type rules', 'mandatory'),
      item('EN 50604-1', 'Light EV battery safety', 'expected'),
      item('Regulation (EU) 2023/1542', 'LMT battery passport track from Feb 2027', 'mandatory'),
    ],
    us: [
      item('UL 2271', 'Batteries for light electric vehicles', 'expected', 'Mandated by several US cities for e-bike sales after fire incidents.'),
      item('UL 2849', 'E-bike electrical system', 'expected'),
    ],
    cn: [
      item('GB 42295 / CCC', 'Electric bicycle electrical safety + compulsory certification', 'mandatory'),
    ],
    intl: [item('IEC 62133-2', 'Portable cell/pack safety', 'expected')],
  },
  stationary: {
    common: [
      item('UN 38.3', 'Transport test report', 'mandatory'),
      item('IEC 62619:2022', 'Industrial cell/pack safety incl. propagation (§8)', 'expected'),
    ],
    eu: [
      item('IEC 63056', 'ESS-specific battery safety (grid storage)', 'expected'),
      item('Regulation (EU) 2023/1542', 'Industrial >2 kWh: passport from Feb 2027', 'mandatory'),
    ],
    us: [
      item('UL 1973', 'Batteries for stationary applications', 'expected'),
      item('UL 9540 / 9540A', 'ESS listing + thermal-runaway fire propagation test data', 'mandatory', 'Fire codes (NFPA 855) demand 9540A data for siting/permits.'),
      item('NFPA 855', 'Installation siting, spacing and suppression', 'mandatory'),
    ],
    cn: [
      item('GB/T 36276', 'Lithium batteries for electrical energy storage', 'expected'),
    ],
    intl: [item('IEC 62933-5-2', 'ESS system-level safety', 'expected')],
  },
  marine: {
    common: [
      item('UN 38.3', 'Transport test report', 'mandatory'),
      item('IEC 62619:2022', 'Industrial cell/pack safety', 'expected'),
    ],
    eu: [
      item('Class society type approval', 'DNV / Lloyd\'s Register / BV battery system approval', 'mandatory', 'Commercial vessels: the class society, not a product norm, is the gate.'),
      item('MGN 550', 'UK MCA guidance for battery vessels', 'expected'),
    ],
    us: [
      item('ABYC E-13', 'Lithium batteries on boats (recreational)', 'expected'),
      item('USCG / class approval', 'Commercial vessels', 'mandatory'),
    ],
    cn: [item('CCS rules', 'China Classification Society battery approval', 'mandatory')],
    intl: [item('IEC 62281', 'Safety during transport', 'mandatory')],
  },
  industrial: {
    common: [
      item('UN 38.3', 'Transport test report', 'mandatory'),
      item('IEC 62619:2022', 'Industrial cell/pack safety (200 ms disconnect, propagation)', 'expected'),
    ],
    eu: [
      item('EN 1175', 'Industrial truck electrical/electronic safety (lift trucks)', 'mandatory'),
      item('Machinery Directive / ISO 3691-4', 'Driverless truck (AGV/AMR) safety', 'mandatory'),
    ],
    us: [
      item('UL 2580 / UL 583', 'EV battery / electric industrial truck listing', 'expected'),
      item('ANSI/ITSDF B56.5', 'Driverless industrial vehicle safety', 'expected'),
    ],
    cn: [item('GB/T 27544', 'Industrial truck electrical requirements', 'expected')],
    intl: [item('IEC 61508', 'Functional safety baseline (SIL per risk graph)', 'expected')],
  },
  // Vehicle-installed house banks (RV/camper): not traction, not grid
  // storage, not hand-portable — the drop-in 12/24/48 V class with its own
  // rule set (vehicle EMC applies because it lives in a vehicle).
  auxiliary: {
    common: [
      item('UN 38.3', 'Transport test report', 'mandatory'),
      item('IEC 62619:2022', 'Industrial/large-format cell and pack safety', 'expected'),
    ],
    eu: [
      item('UN ECE R10', 'Automotive EMC for equipment installed in vehicles', 'mandatory'),
      item('CE (LVD/EMC)', 'System conformity for the charger/inverter combination', 'mandatory'),
    ],
    us: [
      item('UL 1973', 'The listing drop-in house batteries actually certify to', 'expected'),
      item('NFPA 1192 / RVIA', 'RV standard the installation must satisfy', 'expected'),
    ],
    cn: [
      item('GB/T 36276', 'Storage-battery norm used as the reference (no RV-specific national battery rule)', 'practice'),
    ],
    intl: [item('IEC 62619:2022', 'Large-format safety baseline', 'expected')],
  },
  portable: {
    common: [
      item('UN 38.3', 'Transport test report', 'mandatory'),
      item('IEC 62133-2', 'Portable sealed cell/pack safety', 'mandatory'),
    ],
    eu: [item('CE (LVD/EMC/RED)', 'System-level conformity for the end product', 'mandatory')],
    us: [
      item('UL 2054', 'Household/commercial battery packs', 'expected'),
      item('UL 2743', 'Portable power packs (power stations)', 'expected'),
    ],
    cn: [item('GB 31241', 'Portable electronic battery safety + CCC where listed', 'mandatory')],
    intl: [item('IEC 62281', 'Safety during transport', 'mandatory')],
  },
};

// Chemistry-market rules — the user's exact case: China's new-energy bus
// practice. Since the 2017 MIIT recommended-vehicle catalogue pause on
// ternary chemistry in urban e-buses (after fleet fires) and with
// GB 38031's no-propagation demands, Chinese e-buses ship on LFP/LTO.
// Encoded as a checklist flag, verified against the CURRENT catalogue.
function chemistryRules({ market, application, chemistry }) {
  const out = [];
  if (market === 'cn' && application === 'ebus') {
    const ternary = ['NMC', 'NCA', 'LCO'].includes(chemistry);
    out.push({
      code: 'MIIT catalogue practice',
      title: ternary
        ? `Ternary chemistry (${chemistry}) is effectively excluded from Chinese urban e-buses`
        : `${chemistry} matches Chinese e-bus practice`,
      scope: ternary ? 'blocker' : 'pass',
      note: ternary
        ? 'Since 2017 the recommended-vehicle catalogue practice has kept NMC/NCA out of urban e-buses on safety grounds — programs ship LFP or LTO. Verify the current MIIT catalogue before committing this chemistry.'
        : 'LFP/LTO are the chemistries Chinese e-bus programs actually certify. Verify the current MIIT catalogue text.',
    });
  }
  if (market === 'cn' && CLASS_OF_APP[application] === 'vehicle' && chemistry !== 'LFP') {
    out.push({
      code: 'GB 38031-2025',
      title: 'No-fire / no-explosion propagation requirement is chemistry-blind but harder for high-nickel packs',
      scope: 'note',
      note: 'The 2025 revision demands no fire and no explosion after internal thermal runaway — achievable with NMC, but the propagation barriers and venting must prove it.',
    });
  }
  return out;
}

// The release checklist for a design: application class + market rules +
// chemistry gates, ready to render as a to-do list.
// Deciding to feed power back is not a feature toggle — it drags a second
// certification path in with it, and the checklist has to say so. These are
// the items a GRID-FACING design adds on top of its class list. (V2L is an
// islanded inverter output and does not interconnect, so it adds none.)
const V2X_ITEMS = {
  eu: [
    item('EN 50549-1/-2', 'Generating plants connected in parallel with distribution networks', 'mandatory', 'Exporting makes the vehicle a generating plant — this is the EU grid-code gate.'),
  ],
  us: [
    item('IEEE 1547', 'Interconnection and interoperability of distributed energy resources', 'mandatory', 'The interconnection rules the utility holds you to before any export is permitted.'),
    item('UL 1741', 'Inverters, converters and interconnection system equipment for DER', 'mandatory', 'Certification of the grid-facing conversion path, including the supplements for bidirectional equipment.'),
    item('UL 9741', 'Bidirectional electric vehicle charging system equipment', 'expected', 'The equipment standard for the bidirectional charger itself.'),
  ],
  cn: [
    item('GB/T 20234', 'Connection set for conductive charging of electric vehicles', 'mandatory', 'The connector family the bidirectional session runs over in China.'),
  ],
  intl: [
    item('ISO 15118-20', 'Vehicle-to-grid communication interface — bidirectional power transfer', 'expected', 'The charge-session protocol that makes export negotiable at all.'),
  ],
};

export function releaseChecklist({ market, application, chemistry, v2x = null }) {
  const cls = CLASS_OF_APP[application] || 'portable';
  const book = CHECKLISTS[cls];
  const items = [...book.common, ...(book[market] || [])];
  // Grid-facing export only. An islanded V2L socket interconnects with
  // nothing and must not be made to look as if it does.
  if (v2x && v2x !== 'off' && v2x !== 'v2l') {
    items.push(...(V2X_ITEMS[market] || []), ...V2X_ITEMS.intl);
  }
  const rules = chemistryRules({ market, application, chemistry });
  return {
    applicationClass: cls,
    items,
    rules,
    note: 'A release to-do list for this application class and market — it names what certification will ask for; it is not the certification. Verify each document\'s current edition with your test house.',
  };
}
