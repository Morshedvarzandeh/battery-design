/*
 * cells.js — curated battery cell library for the 3D pack designer.
 *
 * Fully self-contained ES module. No imports. Plain JavaScript.
 *
 * ── GEOMETRY CONVENTION (the layout engine depends on this) ─────────────────
 *   cylindrical cells:
 *     dims = { d: <diameter in mm>, h: <height in mm> }
 *     The cylinder axis is vertical (Z). Terminals up.
 *   prismatic and pouch cells:
 *     dims = { w: <width mm>, t: <thickness mm>, h: <height mm> }
 *     w = long face width  -> X axis
 *     t = stack / thickness direction -> Y axis  (t < w always)
 *     h = height with terminals up -> Z axis
 *   All dimensions are nominal outer-envelope values in millimetres.
 *
 * ── HONESTY RULES ───────────────────────────────────────────────────────────
 *   - Provenance is TWO fields, not one flag, because 'datasheet vs estimate'
 *     collapsed two independent questions and the answers disagreed: cells
 *     with no document anywhere read as datasheet-grade, while the Toshiba
 *     records -- the best-evidenced here, extracted from a catalogue in the
 *     companion battery-data repo -- read as estimates because their
 *     dimensions were worked out.
 *
 *     basis: where the electrical core came from
 *       'contrib'            a contribution in battery-data, named by
 *                            contribUid, carrying a page and a quote
 *       'external_datasheet' a real datasheet read elsewhere, not held in
 *                            either repo, so nobody can re-check it here
 *       'teardown'           measured from hardware by a third party
 *       'trade_press'        reported by press coverage, not by the maker
 *       'composite'          a family of similar cells, not one part number
 *       'recalled'           remembered without the document in hand
 *
 *     inferredFields: which named fields were worked out rather than read.
 *       ['ALL'] means the whole record is inference. A cell can be sourced
 *       and still have inferred dimensions; one flag could not say that.
 *   - null means "unknown / not published", never "zero".
 *   - priceUSD is ALWAYS a rough single-unit street-price estimate, even on
 *     'datasheet' records; treat it as order-of-magnitude only.
 *   - dcirMOhm marked as derived/estimated in sourceNote where it is not a
 *     datasheet DC-IR figure (e.g. ~1.5x the published 1 kHz AC-IR, or backed
 *     out of a published pulse-power figure).
 *   - sourceNote states provenance and calls out exactly what was estimated.
 *   Several records (Samsung 50E, CATL 302Ah, Toshiba SCiB) are extracted from
 *   the datasheet YAMLs in the companion battery-data repo
 *   (github.com/morshedvarzandeh/battery-data) under contrib/cells/; those YAMLs mostly
 *   lack dimensions, which are supplied here from public documentation and
 *   flagged in sourceNote.
 */

export const CELL_LIST_VERSION = '1';

export const CHEMISTRIES = {
  NMC: {
    key: 'NMC',
    name: 'Lithium Nickel Manganese Cobalt',
    nominalV: 3.6,
    vMaxTyp: 4.2,
    vMinTyp: 2.5,
    whKgCell: [150, 260],
    cycleLifeTyp: [500, 2000],
    maxChargeCTyp: 1,
    thermalRisk: 'high',
    color: '#3b82f6',
    notes: 'Workhorse EV/power-tool chemistry. Good energy and power balance; needs careful thermal design and cell-level fusing in large packs.'
  },
  NCA: {
    key: 'NCA',
    name: 'Lithium Nickel Cobalt Aluminium',
    nominalV: 3.6,
    vMaxTyp: 4.2,
    vMinTyp: 2.5,
    whKgCell: [200, 260],
    cycleLifeTyp: [500, 1500],
    maxChargeCTyp: 0.7,
    thermalRisk: 'high',
    color: '#8b5cf6',
    notes: 'High specific energy (Tesla/Panasonic lineage). Similar handling requirements to NMC; typically modest continuous charge rates.'
  },
  LFP: {
    key: 'LFP',
    name: 'Lithium Iron Phosphate',
    nominalV: 3.2,
    vMaxTyp: 3.65,
    vMinTyp: 2.5,
    whKgCell: [90, 180],
    cycleLifeTyp: [2000, 6000],
    maxChargeCTyp: 1,
    thermalRisk: 'low',
    color: '#22c55e',
    notes: 'Long life, thermally stable, cobalt-free. Lower energy density and a very flat voltage curve (harder SOC estimation). Do not charge below 0 C without heating.'
  },
  LTO: {
    key: 'LTO',
    name: 'Lithium Titanate (LTO anode)',
    nominalV: 2.3,
    vMaxTyp: 2.7,
    vMinTyp: 1.5,
    whKgCell: [45, 100],
    cycleLifeTyp: [8000, 20000],
    maxChargeCTyp: 4,
    thermalRisk: 'very-low',
    color: '#06b6d4',
    notes: 'Extreme cycle life, fast charge, wide temperature window including sub-zero charging. Low energy density and low cell voltage (more cells in series).'
  },
  LCO: {
    key: 'LCO',
    name: 'Lithium Cobalt Oxide',
    nominalV: 3.7,
    vMaxTyp: 4.2,
    vMinTyp: 2.75,
    whKgCell: [150, 220],
    cycleLifeTyp: [300, 700],
    maxChargeCTyp: 0.7,
    thermalRisk: 'high',
    color: '#ec4899',
    notes: 'Legacy consumer-electronics chemistry. Good energy density, poor cycle life and abuse tolerance; rarely appropriate for new pack designs.'
  },
  NAION: {
    key: 'NAION',
    name: 'Sodium-ion',
    nominalV: 3.0,
    vMaxTyp: 3.95,
    vMinTyp: 1.5,
    whKgCell: [100, 160],
    cycleLifeTyp: [2000, 5000],
    maxChargeCTyp: 1,
    thermalRisk: 'medium',
    color: '#f59e0b',
    notes: 'Emerging lithium-free chemistry (HiNa, CATL Naxtra class). Excellent cold-temperature behaviour, can ship at 0 V; energy density between lead-acid and LFP. Specs still moving fast.'
  }
};

export const CELLS = [
  // ── Cylindrical NCA / NMC ────────────────────────────────────────────────
  {
    id: 'samsung-inr21700-50e',
    name: 'Samsung SDI INR21700-50E',
    manufacturer: 'Samsung SDI',
    model: 'INR21700-50E',
    form: 'cylindrical',
    formFactor: '21700',
    chemistry: 'NCA',
    dims: { d: 21.1, h: 70.2 },
    massG: 69,
    capacityAh: 4.9,
    nominalV: 3.6,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 9.8,
    maxPulseDischargeA: 14.7,
    maxContChargeA: 2.45,
    dcirMOhm: 35,
    cycleLife: 500,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: 5,
    basis: 'contrib',
    contribUid: 'cell/samsung-sdi/inr21700-50e',
    inferredFields: ['dims', 'maxContChargeA', 'dcirMOhm', 'priceUSD'],
    sourceNote: 'Core electricals from Samsung spec V1.0 via contrib/cells/samsung-sdi/inr21700-50e.yaml (4.9 Ah std, 14.7 A pulse with no stated duration, 69 g max, 500 cycles to 80%). Dims are nominal 21700 (datasheet max 21.25 x 70.80). Charge current is the 0.5C standard rate; DCIR and price estimated.'
  },
  {
    id: 'samsung-inr18650-25r',
    name: 'Samsung SDI INR18650-25R',
    manufacturer: 'Samsung SDI',
    model: 'INR18650-25R',
    form: 'cylindrical',
    formFactor: '18650',
    chemistry: 'NMC',
    dims: { d: 18.3, h: 65.0 },
    massG: 45,
    capacityAh: 2.5,
    nominalV: 3.6,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 20,
    maxPulseDischargeA: null,
    maxContChargeA: 4,
    dcirMOhm: 22,
    cycleLife: null,
    tempDischargeC: [-20, 75],
    tempChargeC: [0, 50],
    priceUSD: 4,
    basis: 'external_datasheet',
    contribUid: null,
    inferredFields: ['dcirMOhm', 'priceUSD'],
    sourceNote: 'Samsung 25R datasheet: 2.5 Ah, 20 A continuous, 4 A rapid charge, 45 g max. cycleLife null because the sheet only states 60% retention at 250 cycles (10 A), not a cycles-to-80% figure. DCIR ~ published AC-IR class, treat as estimate; price estimated.'
  },
  {
    id: 'lg-inr18650-hg2',
    name: 'LG INR18650-HG2',
    manufacturer: 'LG Energy Solution',
    model: 'INR18650-HG2',
    form: 'cylindrical',
    formFactor: '18650',
    chemistry: 'NMC',
    dims: { d: 18.4, h: 65.0 },
    massG: 48,
    capacityAh: 3.0,
    nominalV: 3.6,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 20,
    maxPulseDischargeA: null,
    maxContChargeA: 4,
    dcirMOhm: 20,
    cycleLife: null,
    tempDischargeC: [-20, 75],
    tempChargeC: [0, 50],
    priceUSD: 5,
    basis: 'external_datasheet',
    contribUid: null,
    inferredFields: ['dcirMOhm', 'priceUSD'],
    sourceNote: 'LG HG2 datasheet: 3.0 Ah, 20 A continuous, 4 A max charge, 48 g max. cycleLife null (sheet criterion is ~70% at 300 cycles, not cycles-to-80%). DCIR and price estimated.'
  },
  {
    id: 'lg-inr18650-mj1',
    name: 'LG INR18650-MJ1',
    manufacturer: 'LG Energy Solution',
    model: 'INR18650-MJ1',
    form: 'cylindrical',
    formFactor: '18650',
    chemistry: 'NMC',
    dims: { d: 18.4, h: 65.0 },
    massG: 49,
    capacityAh: 3.5,
    nominalV: 3.635,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 10,
    maxPulseDischargeA: null,
    maxContChargeA: 1.7,
    dcirMOhm: 36,
    cycleLife: 400,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: 4.5,
    basis: 'external_datasheet',
    contribUid: null,
    inferredFields: ['maxContChargeA', 'dcirMOhm', 'priceUSD'],
    sourceNote: 'LG MJ1 datasheet: 3.5 Ah, 10 A continuous, 49 g max, >=80% at 400 cycles. Charge current shown is the standard 0.5C rate (sheet max not carried here). DCIR and price estimated.'
  },
  {
    id: 'molicel-inr21700-p42a',
    name: 'Molicel INR21700-P42A',
    manufacturer: 'Molicel (E-One Moli)',
    model: 'INR21700-P42A',
    form: 'cylindrical',
    formFactor: '21700',
    chemistry: 'NMC',
    dims: { d: 21.1, h: 70.2 },
    massG: 70,
    capacityAh: 4.2,
    nominalV: 3.6,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 45,
    maxPulseDischargeA: null,
    maxContChargeA: 4.2,
    dcirMOhm: 16,
    cycleLife: 500,
    tempDischargeC: [-40, 60],
    tempChargeC: [0, 60],
    priceUSD: 6,
    basis: 'external_datasheet',
    contribUid: null,
    inferredFields: ['dims', 'dcirMOhm', 'priceUSD'],
    sourceNote: 'Molicel P42A datasheet: 4.2 Ah, 45 A continuous, 70 g max, rated to -40 C discharge. Cycle-life retention criterion is roughly 70-80% depending on test current. Dims are nominal 21700. DCIR and price estimated.'
  },
  {
    id: 'panasonic-ncr18650b',
    name: 'Panasonic NCR18650B',
    manufacturer: 'Panasonic',
    model: 'NCR18650B',
    form: 'cylindrical',
    formFactor: '18650',
    chemistry: 'NCA',
    dims: { d: 18.5, h: 65.3 },
    massG: 48.5,
    capacityAh: 3.35,
    nominalV: 3.6,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 6.7,
    maxPulseDischargeA: null,
    maxContChargeA: 1.625,
    dcirMOhm: 45,
    cycleLife: 500,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: 5,
    basis: 'external_datasheet',
    contribUid: null,
    inferredFields: ['maxContDischargeA', 'dcirMOhm', 'cycleLife', 'priceUSD'],
    sourceNote: 'Panasonic NCR18650B datasheet: 3.35 Ah typ, 1.625 A standard charge, 48.5 g max. Panasonic does not state a hard max discharge current; 6.7 A (~2C) reflects the published discharge curves and is an estimate. DCIR, cycle life criterion and price estimated.'
  },
  {
    id: 'tesla-4680-gen1',
    name: 'Tesla 4680 (gen 1, teardown-derived)',
    manufacturer: 'Tesla',
    model: '4680 gen 1',
    form: 'cylindrical',
    formFactor: '4680',
    chemistry: 'NMC',
    dims: { d: 46, h: 80 },
    massG: 355,
    capacityAh: 23.5,
    nominalV: 3.7,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 35,
    maxPulseDischargeA: null,
    maxContChargeA: 23.5,
    dcirMOhm: null,
    cycleLife: null,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: null,
    basis: 'teardown',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'No public datasheet exists. Mass (~355 g) and capacity from independent teardowns (published figures span roughly 22-26 Ah; ~87 Wh at 3.7 V used here). Current limits unpublished — the ~1.5C continuous discharge and 1C charge here are deliberately conservative placeholders. DCIR and cycle life unpublished; temperature windows are generic NMC assumptions. Everything on this record is an estimate.'
  },

  // ── Cylindrical LFP ──────────────────────────────────────────────────────
  {
    id: 'a123-anr26650m1b',
    name: 'A123 ANR26650M1B',
    manufacturer: 'A123 Systems',
    model: 'ANR26650M1B',
    form: 'cylindrical',
    formFactor: '26650',
    chemistry: 'LFP',
    dims: { d: 26.0, h: 65.2 },
    massG: 76,
    capacityAh: 2.5,
    nominalV: 3.3,
    vMax: 3.6,
    vMin: 2.0,
    maxContDischargeA: 50,
    maxPulseDischargeA: 120,
    maxContChargeA: 10,
    dcirMOhm: 9,
    cycleLife: 1000,
    tempDischargeC: [-30, 55],
    tempChargeC: [0, 55],
    priceUSD: 9,
    basis: 'external_datasheet',
    contribUid: null,
    inferredFields: ['dcirMOhm', 'tempChargeC', 'priceUSD'],
    sourceNote: 'A123 M1B datasheet: 2.5 Ah, 50 A continuous, 120 A 10 s pulse, 10 A fast charge, 76 g, 6 mOhm 1 kHz AC-IR. cycleLife per datasheet ">1000 at 10C, 100% DOD" (not a cycles-to-80% figure). DCIR estimated at ~1.5x AC-IR; charge temperature floor set conservatively at 0 C; price estimated.'
  },
  {
    id: 'generic-lfp-32700',
    name: 'Generic 32700 LFP 6 Ah',
    manufacturer: 'Generic',
    model: '32700 6 Ah LFP (EVE/Hakadi class)',
    form: 'cylindrical',
    formFactor: '32700',
    chemistry: 'LFP',
    dims: { d: 32.2, h: 70.5 },
    massG: 142,
    capacityAh: 6.0,
    nominalV: 3.2,
    vMax: 3.65,
    vMin: 2.0,
    maxContDischargeA: 18,
    maxPulseDischargeA: 30,
    maxContChargeA: 6,
    dcirMOhm: 8,
    cycleLife: 2000,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 55],
    priceUSD: 4,
    basis: 'composite',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'Composite of common Chinese 32700 LFP cells (6 Ah, 3C discharge, 1C charge, ~140 g class). Representative of the family, not a specific SKU; all values are estimates.'
  },

  // ── Prismatic LFP ────────────────────────────────────────────────────────
  {
    id: 'catl-302ah-lfp',
    name: 'CATL 302Ah LiFePO4',
    manufacturer: 'CATL',
    model: '302Ah LiFePO4',
    form: 'prismatic',
    formFactor: 'prismatic',
    chemistry: 'LFP',
    dims: { w: 173.7, t: 71.7, h: 207.2 },
    massG: 5510,
    capacityAh: 302,
    nominalV: 3.22,
    vMax: 3.65,
    vMin: 2.5,
    maxContDischargeA: 302,
    maxPulseDischargeA: 906,
    maxContChargeA: 302,
    dcirMOhm: 0.27,
    cycleLife: 4000,
    tempDischargeC: [-30, 60],
    tempChargeC: [0, 55],
    priceUSD: 90,
    basis: 'contrib',
    contribUid: 'cell/catl/302ah-lifepo4',
    inferredFields: ['dims', 'dcirMOhm', 'tempChargeC', 'priceUSD'],
    sourceNote: 'Core electricals from the CATL product spec via contrib/cells/catl/302ah-lifepo4.yaml (302 Ah, 3.22 V, 1C cont charge/discharge, 906 A 30 s pulse at 25 C, 5.51 kg max, >=4000 cycles, 0.18 mOhm 1 kHz AC-IR). Dims are the public LF-type footprint, not from the extracted spec. DCIR ~1.5x AC-IR (estimate); charge temperature window and price estimated.'
  },
  {
    id: 'eve-lf280k',
    name: 'EVE LF280K',
    manufacturer: 'EVE Energy',
    model: 'LF280K',
    form: 'prismatic',
    formFactor: 'prismatic',
    chemistry: 'LFP',
    dims: { w: 173.7, t: 71.7, h: 207.2 },
    massG: 5420,
    capacityAh: 280,
    nominalV: 3.2,
    vMax: 3.65,
    vMin: 2.5,
    maxContDischargeA: 280,
    maxPulseDischargeA: null,
    maxContChargeA: 280,
    dcirMOhm: 0.38,
    cycleLife: 6000,
    tempDischargeC: [-30, 60],
    tempChargeC: [0, 60],
    priceUSD: 80,
    basis: 'external_datasheet',
    contribUid: null,
    inferredFields: ['dims', 'dcirMOhm', 'tempChargeC', 'tempDischargeC', 'priceUSD'],
    sourceNote: 'EVE LF280K public spec: 280 Ah, 1C cont charge/discharge, ~5.42 kg, <=0.25 mOhm AC-IR, >=6000 cycles (EVE claim, 25 C standard cycling). Dims are the LF-type footprint to +/-0.5 mm. DCIR ~1.5x AC-IR (estimate); temperature windows approximate; price estimated.'
  },

  // ── Prismatic LTO (Toshiba SCiB) ─────────────────────────────────────────
  {
    id: 'toshiba-scib-20ah',
    name: 'Toshiba SCiB 20Ah',
    manufacturer: 'Toshiba',
    model: 'SCiB 20Ah',
    form: 'prismatic',
    formFactor: 'prismatic',
    chemistry: 'LTO',
    dims: { w: 116, t: 22, h: 106 },
    massG: 515,
    capacityAh: 20,
    nominalV: 2.3,
    vMax: 2.7,
    vMin: 1.5,
    maxContDischargeA: 160,
    maxPulseDischargeA: null,
    maxContChargeA: 60,
    dcirMOhm: 1.1,
    cycleLife: 15000,
    tempDischargeC: [-30, 55],
    tempChargeC: [-30, 45],
    priceUSD: 45,
    basis: 'contrib',
    contribUid: 'cell/toshiba/scib-20ah',
    inferredFields: ['dims', 'dcirMOhm', 'maxContDischargeA', 'maxContChargeA', 'cycleLife', 'tempChargeC', 'tempDischargeC', 'priceUSD'],
    sourceNote: 'Capacity, 2.3 V nominal, 515 g and energy densities from the Toshiba SCiB catalog via contrib/cells/toshiba/scib-20ah.yaml. Dims from the same catalog family (W116 x D22 x H106, cross-checked against 176 Wh/L). Toshiba publishes power (1200 W out / 10 s / SOC 50%) rather than current limits: DCIR ~1.1 mOhm backed out of that figure; discharge/charge currents (8C/3C), cycle life (Toshiba long-life claim, own criterion), temperatures and price are estimates.'
  },
  {
    id: 'toshiba-scib-23ah',
    name: 'Toshiba SCiB 23Ah',
    manufacturer: 'Toshiba',
    model: 'SCiB 23Ah',
    form: 'prismatic',
    formFactor: 'prismatic',
    chemistry: 'LTO',
    dims: { w: 116, t: 22, h: 106 },
    massG: 550,
    capacityAh: 23,
    nominalV: 2.3,
    vMax: 2.7,
    vMin: 1.5,
    maxContDischargeA: 70,
    maxPulseDischargeA: null,
    maxContChargeA: 46,
    dcirMOhm: 1.3,
    cycleLife: 8000,
    tempDischargeC: [-30, 55],
    tempChargeC: [-30, 45],
    priceUSD: 50,
    basis: 'contrib',
    contribUid: 'cell/toshiba/scib-23ah',
    inferredFields: ['dims', 'dcirMOhm', 'maxContDischargeA', 'maxContChargeA', 'cycleLife', 'tempChargeC', 'tempDischargeC', 'priceUSD'],
    sourceNote: 'High-energy SCiB type. Capacity, 2.3 V nominal, 550 g and 202 Wh/L from the Toshiba catalog via contrib/cells/toshiba/scib-23ah.yaml; dims are the shared W116 x D22 x H106 case (consistent with the stated Wh/L). DCIR ~1.3 mOhm backed out of the 1000 W / 10 s power figure. Current limits (~3C/2C), cycle life, temperatures and price are estimates.'
  },
  {
    id: 'toshiba-scib-2-9ah',
    name: 'Toshiba SCiB 2.9Ah',
    manufacturer: 'Toshiba',
    model: 'SCiB 2.9Ah',
    form: 'prismatic',
    formFactor: 'prismatic',
    chemistry: 'LTO',
    dims: { w: 63, t: 14, h: 97 },
    massG: 150,
    capacityAh: 2.9,
    nominalV: 2.4,
    vMax: 2.7,
    vMin: 1.5,
    maxContDischargeA: 29,
    maxPulseDischargeA: 100,
    maxContChargeA: 29,
    dcirMOhm: 2.8,
    cycleLife: 15000,
    tempDischargeC: [-30, 55],
    tempChargeC: [-30, 45],
    priceUSD: 20,
    basis: 'contrib',
    contribUid: 'cell/toshiba/scib-2-9ah',
    inferredFields: ['dcirMOhm', 'maxContDischargeA', 'maxPulseDischargeA', 'maxContChargeA', 'vMax', 'vMin', 'cycleLife', 'tempChargeC', 'tempDischargeC', 'priceUSD'],
    sourceNote: 'High-power SCiB type. Capacity, 2.4 V nominal, 150 g and W63 x D14 x H97 dims all from the Toshiba catalog via contrib/cells/toshiba/scib-2-9ah.yaml. Toshiba publishes power (520 W out / 10 s) instead of current limits; the 10C continuous / ~35C pulse figures here are conservative estimates backed out of that power figure, and DCIR ~2.8 mOhm likewise. Voltage window assumed same as other SCiB types; cycle life is the Toshiba family claim; temperatures and price estimated.'
  },

  {
    id: 'tesla-2170-m3lr',
    name: 'Tesla/Panasonic 2170 (Model 3 LR class)',
    manufacturer: 'Panasonic (Tesla)',
    model: '2170 automotive',
    form: 'cylindrical',
    formFactor: '21700',
    chemistry: 'NCA',
    dims: { d: 21.1, h: 70.2 },
    massG: 68,
    capacityAh: 4.8,
    nominalV: 3.65,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 15,
    maxPulseDischargeA: null,
    maxContChargeA: 7,
    dcirMOhm: 20,
    cycleLife: 1500,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: 4,
    basis: 'teardown',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'Automotive 2170 as used in the Model 3 Long Range (96s46p, 4416 cells, 78.1 kWh nominal => ~17.7 Wh/cell => ~4.8 Ah at 3.65 V). No public datasheet; capacity, currents, DCIR, cycle life and price are teardown/press-derived estimates. Added for validating the max-fill algorithm against real vehicle packs.'
  },

  // ── Prismatic LFP blade ──────────────────────────────────────────────────
  {
    id: 'byd-blade-lfp-150ah',
    name: 'BYD Blade LFP (Atto 3 class)',
    manufacturer: 'BYD (FinDreams)',
    model: 'Blade EV cell',
    form: 'prismatic',
    formFactor: 'prismatic',
    chemistry: 'LFP',
    dims: { w: 960, t: 13.5, h: 90 },
    massG: 2900,
    capacityAh: 150,
    nominalV: 3.2,
    vMax: 3.65,
    vMin: 2.5,
    maxContDischargeA: 150,
    maxPulseDischargeA: 450,
    maxContChargeA: 150,
    dcirMOhm: 0.6,
    cycleLife: 3500,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 55],
    priceUSD: 95,
    basis: 'trade_press',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'Cell-to-pack blade format, ~960 x 90 x 13.5 mm per press coverage of the Atto 3 (60.5 kWh gross at ~403 V nominal across 138 blades => ~150 Ah class). Mass from ~165 Wh/kg blade-level figures; currents (1C cont / 3C pulse), DCIR, cycle life and price are class estimates. Added for validating the max-fill algorithm against real vehicle packs.'
  },

  // ── Pouch NMC ────────────────────────────────────────────────────────────
  {
    id: 'generic-nmc-pouch-10ah-hp',
    name: 'Generic 10 Ah high-power NMC pouch',
    manufacturer: 'Generic',
    model: '10 Ah high-power pouch (Kokam/Melasta class)',
    form: 'pouch',
    formFactor: 'pouch',
    chemistry: 'NMC',
    dims: { w: 140, t: 9, h: 98 },
    massG: 230,
    capacityAh: 10,
    nominalV: 3.7,
    vMax: 4.2,
    vMin: 2.7,
    maxContDischargeA: 150,
    maxPulseDischargeA: 250,
    maxContChargeA: 40,
    dcirMOhm: 1.2,
    cycleLife: 1000,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: 50,
    basis: 'composite',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'Composite of ~10 Ah 15C-class high-power NMC pouches (Kokam SLPB / Melasta style): ~160 Wh/kg, 15C continuous, 25C pulse, 4C charge. Representative of the class, not a specific SKU; all values are estimates.'
  },
  {
    id: 'generic-nmc-pouch-60ah-ev',
    name: 'Generic 60 Ah EV-class NMC pouch',
    manufacturer: 'Generic',
    model: '60 Ah EV pouch (LG/SK class)',
    form: 'pouch',
    formFactor: 'pouch',
    chemistry: 'NMC',
    dims: { w: 338, t: 11, h: 100 },
    massG: 890,
    capacityAh: 60,
    nominalV: 3.65,
    vMax: 4.2,
    vMin: 2.5,
    maxContDischargeA: 180,
    maxPulseDischargeA: 300,
    maxContChargeA: 60,
    dcirMOhm: 0.9,
    cycleLife: 1000,
    tempDischargeC: [-25, 60],
    tempChargeC: [0, 45],
    priceUSD: 70,
    basis: 'composite',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'Composite modelled on LG/SK EV pouch cells of the Chevy Bolt generation (~60 Ah, ~246 Wh/kg, ~338 x 11 x 100 mm envelope from teardown reports). Current limits (3C/5C pulse/1C charge), DCIR, cycle life, temperatures and price are estimates.'
  },

  // ── Sodium-ion ───────────────────────────────────────────────────────────
  {
    id: 'generic-naion-prismatic-100ah',
    name: 'Generic first-gen Na-ion prismatic 100 Ah',
    manufacturer: 'Generic',
    model: 'First-gen Na-ion prismatic ~100 Ah (HiNa/CATL class)',
    form: 'prismatic',
    formFactor: 'prismatic',
    chemistry: 'NAION',
    dims: { w: 148, t: 48, h: 218 },
    massG: 2400,
    capacityAh: 100,
    nominalV: 3.1,
    vMax: 3.95,
    vMin: 1.5,
    maxContDischargeA: 200,
    maxPulseDischargeA: null,
    maxContChargeA: 100,
    dcirMOhm: null,
    cycleLife: 3000,
    tempDischargeC: [-30, 60],
    tempChargeC: [-10, 45],
    priceUSD: 60,
    basis: 'composite',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'Composite of announced first-generation sodium-ion prismatic cells (HiNa / CATL gen-1 class, ~130 Wh/kg, ~200 Wh/L, strong cold-temperature performance, deep-discharge tolerant). Representative of the class, not a specific SKU; all values are estimates.'
  },

  // ── LCO ──────────────────────────────────────────────────────────────────
  {
    id: 'samsung-icr18650-26j',
    name: 'Samsung SDI ICR18650-26J',
    manufacturer: 'Samsung SDI',
    model: 'ICR18650-26J',
    form: 'cylindrical',
    formFactor: '18650',
    chemistry: 'LCO',
    dims: { d: 18.4, h: 65.0 },
    massG: 45,
    capacityAh: 2.6,
    nominalV: 3.63,
    vMax: 4.2,
    vMin: 2.75,
    maxContDischargeA: 5.2,
    maxPulseDischargeA: null,
    maxContChargeA: 2.6,
    dcirMOhm: 40,
    cycleLife: 300,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: 4,
    basis: 'recalled',
    contribUid: null,
    inferredFields: ['ALL'],
    sourceNote: 'Classic cobalt-based (ICR family; LCO or LCO-rich blend) energy 18650: 2.6 Ah, 2C max discharge, 1C charge. Values recalled from the Samsung 26J datasheet without the document in hand — treat the whole record as an estimate. Mass, DCIR, cycle life and price approximate.'
  }
];

export function cellEnergyWh(cell) { return cell.nominalV * cell.capacityAh; }

export function cellVolumeL(cell) {
  if (cell.form === 'cylindrical') {
    return Math.PI * (cell.dims.d / 2) * (cell.dims.d / 2) * cell.dims.h / 1e6;
  }
  return cell.dims.w * cell.dims.t * cell.dims.h / 1e6;
}

export function cellById(id) {
  for (let i = 0; i < CELLS.length; i++) {
    if (CELLS[i].id === id) return CELLS[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provenance, in one place so the UI and any tooling say the same thing
// ---------------------------------------------------------------------------
// Deliberately blunt wording: 'external datasheet' reads worse than
// 'datasheet' did, because it is worse — nobody can re-check it from either
// repository.

export const BASIS_INFO = {
  contrib: { label: 'sourced', tone: 'good',
    blurb: 'Core values come from a contribution in the battery-data repo, with a page and a quote behind each one.' },
  external_datasheet: { label: 'external datasheet', tone: 'warn',
    blurb: 'Read from a real datasheet that is not held in either repo, so it cannot be re-checked here.' },
  teardown: { label: 'teardown', tone: 'warn',
    blurb: 'Measured from hardware by a third party. No manufacturer document exists.' },
  trade_press: { label: 'trade press', tone: 'warn',
    blurb: 'Reported by press coverage rather than by the manufacturer.' },
  composite: { label: 'composite', tone: 'estimate',
    blurb: 'Representative of a family of similar cells rather than any one part number.' },
  recalled: { label: 'recalled', tone: 'estimate',
    blurb: 'Remembered without the document in hand. Treat every figure as approximate.' },
};

export function provenance(cell) {
  const info = BASIS_INFO[cell.basis] || BASIS_INFO.recalled;
  const inferred = cell.inferredFields || [];
  const all = inferred.length === 1 && inferred[0] === 'ALL';
  return {
    ...info,
    basis: cell.basis,
    contribUid: cell.contribUid || null,
    inferred: all ? [] : inferred,
    inferredAll: all,
    detail: info.blurb + (all
      ? ' Every field on this record is an estimate.'
      : inferred.length ? ` Worked out rather than read: ${inferred.join(', ')}.` : ''),
  };
}
