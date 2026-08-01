// patents.js — battery-pack patent & technology landscape, matched to the
// design choices made in the app.
//
// WHAT THIS IS: a curated map of well-known patent families and the pack
// technologies they cover, so a designer sees (a) patented approaches worth
// learning from for the thing they are building, and (b) an early
// freedom-to-operate flag when their design choice is close to an actively
// patented approach. Every entry links to Google Patents, including a
// this-year search so the daily stream of new filings is one click away.
//
// WHAT THIS IS NOT: legal advice. Patent scope is defined by claims read by
// professionals; families expire, lapse, and differ by jurisdiction. The
// entries below name famous families coarsely and may be imprecise — treat
// them as research starting points and consult patent counsel before
// commercializing. New entries integrate via the same CONTRIBUTING loop as
// cells and components (CI-validated).

export const PATENTS_DISCLAIMER =
  'Research starting points, not legal advice. Patent families are described ' +
  'coarsely, may have expired or lapsed, and differ by jurisdiction. Consult ' +
  'patent counsel before commercializing any design.';

const gp = (q) => `https://patents.google.com/?q=${encodeURIComponent(q)}`;
const gpRecent = (q) => `https://patents.google.com/?q=${encodeURIComponent(q)}&after=priority:${new Date().getFullYear() - 1}0101&sort=new`;

// matches: { forms?, chemistries?, arrangements?, coolingKinds?, busbarKinds?,
//            spacerKinds?, housingKinds?, minCells? } — all optional; an entry
// applies when every provided condition matches the design.
export const PATENT_LANDSCAPE = [
  {
    id: 'byd-blade-ctp',
    title: 'Cell-to-pack "blade" cells as structural members',
    holder: 'BYD (FinDreams)',
    era: '2019+',
    example: 'CN110165116A family',
    covers: 'Long thin LFP cells mounted directly into the pack as load-bearing "blades", removing module housings entirely.',
    designNote: 'If your prismatic fill approaches cell-to-pack (no modules, cells as structure), this family is the landmark — study it for what it enables and where its claims sit.',
    matches: { forms: ['prismatic'], chemistries: ['LFP'] },
    links: [gp('BYD blade battery cell-to-pack'), gpRecent('cell-to-pack battery')],
  },
  {
    id: 'tesla-serpentine',
    title: 'Serpentine between-cell cooling ribbon',
    holder: 'Tesla',
    era: '2009+',
    example: 'US8286743 family',
    covers: 'A flattened coolant tube snaking between rows of cylindrical cells, bonded to the can side walls.',
    designNote: 'Selecting the between-cell cooling ribbon puts your design closest to this family — a freedom-to-operate check is prudent before commercializing.',
    matches: { coolingKinds: ['cooling-ribbon'] },
    links: [gp('Tesla serpentine cooling battery cylindrical'), gpRecent('battery between-cell cooling ribbon')],
  },
  {
    id: 'tesla-tabless',
    title: 'Tabless ("shingled spiral") cylindrical electrode',
    holder: 'Tesla',
    era: '2020+',
    example: 'US2020/0144676 family',
    covers: 'Electrode foils forming the current path along the full jelly-roll edge instead of discrete tabs — key to large-format (4680) cylindrical cells.',
    designNote: 'Relevant when building around 4680-class cells: their price/performance trajectory is driven by this family and its licensing.',
    matches: { forms: ['cylindrical'], minCellDiaMm: 40 },
    links: [gp('tabless electrode cylindrical battery cell'), gpRecent('tabless cylindrical cell')],
  },
  {
    id: 'wire-bond-interconnect',
    title: 'Ultrasonic wire-bond cell interconnects as fuses',
    holder: 'Tesla and others',
    era: '2009+',
    example: 'US7923144 family',
    covers: 'Thin aluminium wire bonds connecting each cylindrical cell to the busbar, sized to melt open on cell fault — interconnect and per-cell fuse in one.',
    designNote: 'Your wire-bond busbar selection mirrors this approach; the base family is aging (check expiry — early members may now be open), with active younger filings around it.',
    matches: { busbarKinds: ['wire-bond'] },
    links: [gp('battery wire bond interconnect fuse'), gpRecent('battery wire bond interconnect')],
  },
  {
    id: 'ctp-catl',
    title: 'Module-free cell-to-pack architectures',
    holder: 'CATL',
    era: '2019+',
    example: 'CN110518156A family',
    covers: 'Large prismatic cells assembled directly into the pack with integrated cooling plates and structural adhesives.',
    designNote: 'A high integration allowance (few module walls) with large prismatic cells is the CTP direction — the enabling details (adhesives, plate integration) are heavily filed.',
    matches: { forms: ['prismatic'], minCells: 20 },
    links: [gp('CATL cell to pack battery'), gpRecent('cell-to-pack prismatic battery structure')],
  },
  {
    id: 'immersion-cooling',
    title: 'Dielectric immersion cooling of cells',
    holder: 'multiple (XING Mobility, M&I, Shell, Rimac…)',
    era: '2016+',
    example: 'US2019/0173139 class',
    covers: 'Cells fully or partially submerged in circulating dielectric fluid, including flow guidance and fluid selection.',
    designNote: 'Immersion selected: an active, crowded filing space — search by your specific fluid routing before committing to a production design.',
    matches: { coolingKinds: ['immersion'] },
    links: [gp('battery immersion cooling dielectric'), gpRecent('battery immersion cooling')],
  },
  {
    id: 'pcm-matrix',
    title: 'Phase-change composite matrix around cylindrical cells',
    holder: 'AllCell (Beam Global)',
    era: '2005+',
    example: 'US7270910 family',
    covers: 'Wax-graphite composite molded around cells to absorb burst heat and block propagation.',
    designNote: 'PCM matrix selected: the foundational family is old enough that early members have expired — a good candidate for freely usable prior art (verify the specific claims you rely on).',
    matches: { coolingKinds: ['pcm-composite'] },
    links: [gp('phase change material graphite battery pack'), gpRecent('battery phase change composite')],
  },
  {
    id: 'aerogel-barrier',
    title: 'Aerogel thermal-runaway barriers between cells',
    holder: 'Aspen Aerogels and others',
    era: '2018+',
    example: 'US2021/0167438 class',
    covers: 'Thin silica-aerogel composite sheets between cells or modules to block thermal-runaway propagation.',
    designNote: 'Aerogel spacer selected: material itself is bought from suppliers (their patents cover manufacture), but pack-level placement claims exist — check the assembly claims, not just the material.',
    matches: { spacerKinds: ['aerogel-sheet'] },
    links: [gp('aerogel battery thermal runaway barrier'), gpRecent('aerogel battery barrier')],
  },
  {
    id: 'cell-vent-channel',
    title: 'Directed vent-gas channels and mica covers',
    holder: 'multiple (LG, CATL, GM…)',
    era: '2015+',
    example: 'US2021/0143376 class',
    covers: 'Pack-level ducting that routes cell vent gases away from neighbouring cells and out of the enclosure.',
    designNote: 'A vent duct/rupture path in your design touches an active filing area driven by EV thermal-propagation rules — recent filings are worth scanning.',
    matches: { ventKinds: ['vent-duct', 'rupture-panel'] },
    links: [gp('battery pack vent gas channel thermal runaway'), gpRecent('battery vent gas duct')],
  },
  {
    id: 'ccs-flexpcb',
    title: 'Cell contact systems with integrated sense circuits',
    holder: 'multiple (Diehl, Interplex, Jonver-class CCS suppliers)',
    era: '2014+',
    example: 'EP3151307 class',
    covers: 'Plastic-carrier busbar assemblies with welded flex-PCB voltage/temperature sensing routed to one connector.',
    designNote: 'CCS selected: typically bought as a component — the supplier carries the IP; your exposure is mainly in custom carrier geometry.',
    matches: { busbarKinds: ['cell-contact-system'] },
    links: [gp('cell contact system battery flexible printed circuit'), gpRecent('cell contacting system battery')],
  },
  {
    id: 'structural-pack',
    title: 'Structural pack / cell-to-chassis',
    holder: 'Tesla, BYD, Leapmotor…',
    era: '2020+',
    example: 'US2021/0344061 class',
    covers: 'The battery enclosure as a load-bearing chassis element, cells bonded structurally to the lid or floor.',
    designNote: 'Direct-bond spacer with no holders points toward structural integration — the hottest current filing area in packs; scan the this-year feed.',
    matches: { spacerKinds: ['structural-bond'] },
    links: [gp('structural battery pack cell to chassis'), gpRecent('cell-to-chassis battery')],
  },
  {
    id: 'cyl-module-architecture',
    title: 'Cylindrical module architecture (holders, strips, interstitial cooling)',
    holder: 'Tesla (Roadster/Model S era) and many others',
    era: '2007+',
    example: 'US8133287-class families',
    covers: 'Molded cell holders, nickel-strip interconnect layouts, staggered-array packaging and interstitial cooling of 18650/21700 arrays.',
    designNote: 'The foundational cylindrical-module families are old enough that many members have expired — useful prior art to build on; younger filings concentrate on cooling and busbar details.',
    matches: { forms: ['cylindrical'] },
    links: [gp('cylindrical battery module cell holder nickel strip'), gpRecent('cylindrical battery module')],
  },
  {
    id: 'pouch-module-architecture',
    title: 'Pouch module stacks with cooling fins and compression',
    holder: 'LG Energy Solution, SK on, GM (Ultium heritage)',
    era: '2010+',
    example: 'US2012/0009455-class families',
    covers: 'Stacked pouch cells with interleaved cooling fins, compression foams, end plates and tab interconnect boards.',
    designNote: 'Any pouch stack with fins/foam sits in this well-filed space; the specific fin-to-cold-plate joints carry most of the active claims.',
    matches: { forms: ['pouch'] },
    links: [gp('pouch battery module cooling fin compression'), gpRecent('pouch battery module')],
  },
  {
    id: 'na-ion',
    title: 'Sodium-ion cell and pack adaptations',
    holder: 'CATL, HiNa, Faradion (Reliance)',
    era: '2021+',
    example: 'CN114050271A class',
    covers: 'Na-ion chemistries plus pack-side adaptations (0V-safe shipping and BMS windows).',
    designNote: 'Na-ion selected: young, fast-moving IP space — chemistry is supplier-side, but 0V-handling pack logic has its own filings.',
    matches: { chemistries: ['NAION'] },
    links: [gp('sodium ion battery pack'), gpRecent('sodium-ion battery')],
  },
];

// Match the landscape against the current design.
// design: { cell, cellCount, selection:{busbar,spacer,vent,cooling,tim,housing} }
export function matchPatents(design) {
  const sel = design.selection || {};
  const kindOf = (comp) => comp?.kind ?? null;
  return PATENT_LANDSCAPE.filter((p) => {
    const m = p.matches || {};
    if (m.forms && !m.forms.includes(design.cell.form)) return false;
    if (m.chemistries && !m.chemistries.includes(design.cell.chemistry)) return false;
    if (m.minCells && !(design.cellCount >= m.minCells)) return false;
    if (m.minCellDiaMm && !(design.cell.dims?.d >= m.minCellDiaMm)) return false;
    if (m.coolingKinds && !m.coolingKinds.includes(kindOf(sel.cooling))) return false;
    if (m.busbarKinds && !m.busbarKinds.includes(kindOf(sel.busbar))) return false;
    if (m.spacerKinds && !m.spacerKinds.includes(kindOf(sel.spacer))) return false;
    if (m.ventKinds && !m.ventKinds.includes(kindOf(sel.vent))) return false;
    return true;
  });
}
