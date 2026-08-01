// presets.js — application usage presets that seed the requirements form
// ('design from usage'). Pure data + one lookup. No imports, no DOM, no state.
//
// Accuracy note: voltage windows, energy ranges and power levels are anchored
// to publicly documented 2026-era product classes (EU/US e-bike power law,
// hybrid-inverter ratings, rack-unit sizes, drone flight batteries, etc.).
// Mass limits (maxMassKg) and packaging envelopes (maxDimsMm) are engineering
// ESTIMATES of typical product constraints, not standards — treat them as
// starting points, and null means genuinely unconstrained.

export const PRESETS = [
  {
    id: 'ebike', name: 'E-bike', icon: '🚲',
    desc: 'Pedal-assist bicycle, downtube or rack pack',
    systemV: [36, 52], typicalV: 48,
    energyWh: [400, 1000], typicalEnergyWh: 500,
    contPowerW: 500, peakPowerW: 1500,
    maxMassKg: 4,
    maxDimsMm: { x: 450, y: 90, z: 110 },   // estimate: downtube envelope
    chargeRateC: 0.5,
    envTempC: [-10, 45],
    cyclesPerYear: 150, targetYears: 5,
    preferredChemistries: ['NMC', 'NCA', 'LFP'],
    notes: 'Rider carries the pack, so gravimetric energy density dominates: ' +
      '21700 NMC/NCA at 250+ Wh/kg cell level keeps a 500 Wh pack under 3 kg. ' +
      'Legal continuous motor power is 250 W in the EU and up to 750 W in the US; ' +
      'peak draw on hills is roughly 2x continuous.'
  },
  {
    id: 'escooter', name: 'E-scooter', icon: '🛴',
    desc: 'Stand-up electric scooter, deck-mounted pack',
    systemV: [36, 60], typicalV: 48,
    energyWh: [300, 1500], typicalEnergyWh: 600,
    contPowerW: 500, peakPowerW: 1500,
    maxMassKg: 8,
    maxDimsMm: { x: 400, y: 150, z: 60 },   // estimate: flat deck cavity
    chargeRateC: 0.5,
    envTempC: [-10, 45],
    cyclesPerYear: 250, targetYears: 3,
    preferredChemistries: ['NMC', 'LFP'],
    notes: 'Deck packs are long and flat, which forces low z-height cell layouts. ' +
      'Daily commuter duty means more cycles per year than an e-bike but a ' +
      'shorter expected service life; moderate discharge C so energy cells work.'
  },
  {
    id: 'drone', name: 'Drone / UAV', icon: '🛸',
    desc: 'Multirotor flight battery, FPV to industrial',
    systemV: [14.8, 51.8], typicalV: 22.2,   // 4S to 14S Li-ion nominal
    energyWh: [50, 800], typicalEnergyWh: 250,
    contPowerW: 1500, peakPowerW: 4000,
    maxMassKg: 3,
    maxDimsMm: { x: 180, y: 100, z: 80 },   // estimate: industrial smart-battery class
    chargeRateC: 1,
    envTempC: [-10, 40],
    cyclesPerYear: 300, targetYears: 2,
    preferredChemistries: ['NMC', 'LCO'],
    notes: 'Hover power makes this a 5-6C continuous, 10C+ burst duty, and every ' +
      'gram of pack mass is flight time lost — high-rate pouch NMC/LCO (LiPo) ' +
      'wins despite short cycle life. Typical values track industrial ' +
      'smart-battery packs in the DJI TB60 class (~274 Wh).'
  },
  {
    id: 'powertool', name: 'Power tool', icon: '🛠️',
    desc: 'Cordless drill/saw/grinder slide pack',
    systemV: [18, 36], typicalV: 18,
    energyWh: [50, 200], typicalEnergyWh: 90,
    contPowerW: 800, peakPowerW: 2000,
    maxMassKg: 1.5,
    maxDimsMm: { x: 120, y: 80, z: 70 },    // estimate: slide-pack envelope
    chargeRateC: 1,
    envTempC: [-20, 50],
    cyclesPerYear: 200, targetYears: 3,
    preferredChemistries: ['NMC', 'NCA'],
    notes: 'Stall and cut-in currents reach 10C+ on a 90 Wh pack, so high-power ' +
      'cylindrical cells (Molicel P-series / Samsung 25R class, 20-45 A rated) ' +
      'are mandatory; energy density is secondary to sag-free current delivery.'
  },
  {
    id: 'solar-ess', name: 'Home solar storage', icon: '☀️',
    desc: 'Stationary residential energy storage',
    systemV: [48, 52], typicalV: 51.2,       // 16S LFP; HV products use 400 V strings
    energyWh: [5000, 30000], typicalEnergyWh: 10000,
    contPowerW: 5000, peakPowerW: 10000,
    maxMassKg: null,
    maxDimsMm: { x: 760, y: 610, z: 155 }, // wall-cabinet class (Powerwall-size); HV container strings differ
    chargeRateC: 0.5,
    envTempC: [0, 40],
    cyclesPerYear: 300, targetYears: 10,
    preferredChemistries: ['LFP', 'NMC'],
    notes: 'Near-daily cycling for a decade (3000+ cycles) plus indoor siting makes ' +
      'LFP the default for cycle life and thermal stability; mass is a non-issue. ' +
      'The 48 V class dominates retrofit/DIY; integrated HV products stack modules ' +
      'into ~400 V strings instead — model those as series-connected 48 V blocks.'
  },
  {
    id: 'rv', name: 'RV / vanlife', icon: '🚐',
    desc: 'Camper house battery, 12/24/48 V systems',
    systemV: [12, 48], typicalV: 12.8,       // 4S LFP drop-in class
    energyWh: [2000, 10000], typicalEnergyWh: 5000,
    contPowerW: 2000, peakPowerW: 4000,
    maxMassKg: 60,
    maxDimsMm: { x: 600, y: 400, z: 300 },  // estimate: under-seat battery bay
    chargeRateC: 0.5,
    envTempC: [-20, 50],
    cyclesPerYear: 200, targetYears: 8,
    preferredChemistries: ['LFP'],
    notes: 'Lives in an uninsulated bay through winter and summer, so LFP thermal ' +
      'stability and cycle life win; sub-zero charging requires heater plates or ' +
      'a charge-inhibit BMS. 2 kW continuous covers a typical inverter; peaks ' +
      'come from induction cooktops and air-conditioner start-up.'
  },
  {
    id: 'ev', name: 'EV conversion / light EV', icon: '🚗',
    desc: 'Traction pack for a converted or light electric vehicle',
    systemV: [96, 800], typicalV: 400,
    energyWh: [20000, 100000], typicalEnergyWh: 60000,
    contPowerW: 50000, peakPowerW: 150000,
    maxMassKg: 450,
    maxDimsMm: { x: 1800, y: 1400, z: 150 }, // estimate: skateboard floor pack
    chargeRateC: 1,
    envTempC: [-30, 50],
    cyclesPerYear: 100, targetYears: 10,
    preferredChemistries: ['NMC', 'LFP'],
    notes: 'Prismatic NMC keeps a 60 kWh pack near 400 kg; LFP trades ~20% pack ' +
      'energy density for cost and cycle life and now dominates standard-range ' +
      'OEM packs. 1C DC fast charge and -30 C operation both assume active ' +
      'thermal management. Annual cycles are full-cycle equivalents.'
  },
  {
    id: 'robot', name: 'Robot / AGV', icon: '🤖',
    desc: 'Warehouse AGV/AMR with opportunity charging',
    systemV: [24, 48], typicalV: 48,
    energyWh: [500, 5000], typicalEnergyWh: 2000,
    contPowerW: 1000, peakPowerW: 3000,
    maxMassKg: 30,
    maxDimsMm: { x: 400, y: 300, z: 200 },  // estimate: chassis battery bay
    chargeRateC: 2,
    envTempC: [0, 40],
    cyclesPerYear: 1000, targetYears: 7,
    preferredChemistries: ['LTO', 'LFP'],
    notes: 'Opportunity charging at pick stations means many shallow cycles per day ' +
      'and 2C+ charge acceptance: LTO tolerates 4C+ charge and 15000+ cycles, ' +
      'LFP is the cheaper choice where a 1-2C charge and ~4000 cycles suffice. ' +
      'Indoor duty keeps the thermal window benign.'
  },
  {
    id: 'ups', name: 'UPS / telecom', icon: '🔌',
    desc: 'Standby backup power, rack-mounted 48 V',
    systemV: [48, 52], typicalV: 51.2,
    energyWh: [2000, 20000], typicalEnergyWh: 5000,
    contPowerW: 3000, peakPowerW: 6000,
    maxMassKg: null,
    maxDimsMm: { x: 440, y: 600, z: 133 },  // 19-inch rack, 3U height
    chargeRateC: 0.5,
    envTempC: [0, 45],
    cyclesPerYear: 10, targetYears: 10,
    preferredChemistries: ['LFP', 'LTO'],
    notes: 'Float-standby duty: the pack sits fully charged for years and cycles ' +
      'only during outages, so calendar life at elevated cabinet temperature — ' +
      'not cycle life — sizes the design. LFP replaces VRLA in the same 19-inch ' +
      'rack envelope; LTO where cabinets run hot.'
  },
  {
    id: 'powerstation', name: 'Portable power station', icon: '🔋',
    desc: 'Suitcase-style AC/DC power box for camping and backup',
    systemV: [21.6, 51.2], typicalV: 25.6,   // 6S NMC to 16S LFP internals
    energyWh: [500, 3000], typicalEnergyWh: 1000,
    contPowerW: 1800, peakPowerW: 3600,
    maxMassKg: 12,
    maxDimsMm: { x: 340, y: 250, z: 250 },  // estimate: carry-handle form factor
    chargeRateC: 1,
    envTempC: [-10, 40],
    cyclesPerYear: 100, targetYears: 8,
    preferredChemistries: ['LFP', 'NMC'],
    notes: 'The market has shifted from 21700 NMC to LFP for its 3000+ cycle ' +
      'ratings, accepting ~30% more mass at the same energy. 1800 W continuous ' +
      'matches the near-universal AC inverter rating; ~1C charging enables the ' +
      'advertised roughly-one-hour recharge.'
  },
  {
    id: 'marine', name: 'Marine trolling / house', icon: '⛵',
    desc: 'Boat house bank or trolling-motor battery',
    systemV: [12, 48], typicalV: 12.8,
    energyWh: [1000, 10000], typicalEnergyWh: 3000,
    contPowerW: 1000, peakPowerW: 2000,
    maxMassKg: 25,
    maxDimsMm: { x: 330, y: 173, z: 240 },  // BCI Group 31 box footprint
    chargeRateC: 0.5,
    envTempC: [-5, 45],
    cyclesPerYear: 150, targetYears: 8,
    preferredChemistries: ['LFP'],
    notes: 'Drop-in replacement for Group 24-31 lead-acid boxes, so the envelope ' +
      'is fixed and LFP safety in an enclosed hull is decisive. A 55 lb-thrust ' +
      'trolling motor draws ~600 W; house loads and 24/36 V trolling systems ' +
      'push continuous power toward 1 kW.'
  }
];

export function presetById(id) {
  return PRESETS.find(function (p) { return p.id === id; }) || null;
}
