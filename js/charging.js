// charging.js — the AC side of the battery system, round one: how THIS
// application charges. The charging architecture differs by class and the
// tool says so instead of bolting an "on-board charger" onto everything:
//   · vehicles / RVs / boats  → a real on-board charger (or DC depot gear)
//   · e-bikes, tools, gadgets → the charger is an external brick — nothing
//     on the pack to design
//   · stationary storage      → the PCS / hybrid inverter IS the AC side
//   · robots / vacuums        → a dock supplies DC; the AC/DC conversion
//     lives in the dock
// Plus: OBC power classes, first-order charge-time math (CC to ~80%, a
// tapered CV tail above), the AC connector & comms per target market, and
// the charging strategies an application actually uses (depot vs
// opportunity is a pack-SIZING decision, not an afterthought).
//
// V2G / bidirectional power transfer is deliberately NOT here yet — it
// builds on this module and lands as its own round with its own standards
// (ISO 15118-20, UL 9741, IEEE 1547).
//
// Pure data + math, no DOM.

// ---------------------------------------------------------------------------
// OBC power classes (AC input). Efficiency is a class-typical estimate
// (~93%) — stated in REFERENCES.md §8, exposed in the workbook.
// ---------------------------------------------------------------------------
export const OBC_EFFICIENCY = 0.93;
export const OBC_CLASSES = [
  { id: 'obc-3k6', acKW: 3.6, phases: 1, name: '3.6 kW single-phase (16 A)', when: 'Household socket territory — overnight charging for small packs.' },
  { id: 'obc-7k4', acKW: 7.4, phases: 1, name: '7.4 kW single-phase (32 A)', when: 'The common home wallbox class.' },
  { id: 'obc-11k', acKW: 11, phases: 3, name: '11 kW three-phase (16 A)', when: 'The European three-phase default for EVs.' },
  { id: 'obc-22k', acKW: 22, phases: 3, name: '22 kW three-phase (32 A)', when: 'Fast AC — few packs accept this rate for long; often limited by the cell, not the charger.' },
];
export const obcById = (id) => OBC_CLASSES.find((o) => o.id === id) || null;

// ---------------------------------------------------------------------------
// AC interface per target market — connector and charge-comms families.
// Citations live in REFERENCES.md; the release checklist tells the customer
// to verify current editions.
// ---------------------------------------------------------------------------
export const AC_INTERFACE_BY_MARKET = {
  eu: {
    connector: 'Type 2 (IEC 62196-2)',
    dcConnector: 'CCS Combo 2 (IEC 62196-3)',
    comms: 'IEC 61851-1 control pilot; ISO 15118 / DIN 70121 for DC sessions',
  },
  us: {
    connector: 'J1772 (SAE J1772) / NACS (SAE J3400)',
    dcConnector: 'CCS Combo 1 / NACS (SAE J3400)',
    comms: 'SAE J1772 pilot; ISO 15118 or DIN 70121 for DC sessions',
  },
  cn: {
    connector: 'GB/T 20234.2 (AC)',
    dcConnector: 'GB/T 20234.3 (DC)',
    comms: 'GB/T 27930 charge communication',
  },
  intl: {
    connector: 'market-dependent — Type 2, J1772/NACS or GB/T by region',
    dcConnector: 'CCS / NACS / GB/T / CHAdeMO by region',
    comms: 'IEC 61851-1 baseline; ISO 15118 where DC smart charging is required',
  },
};
export const acInterfaceFor = (marketId) => AC_INTERFACE_BY_MARKET[marketId] || AC_INTERFACE_BY_MARKET.intl;

// ---------------------------------------------------------------------------
// Charging architecture per application — the who-needs-what of the AC side.
// kind: 'obc' | 'external' | 'pcs' | 'dock' | 'host'
// ---------------------------------------------------------------------------
export const CHARGING_ARCH_BY_APP = {
  ev: { kind: 'obc', name: 'On-board charger (AC) + CCS/NACS DC fast charging', note: 'The OBC converts AC to pack DC on the vehicle; DC fast charging bypasses it entirely and is limited by the CELL, not the charger.' },
  ebus: { kind: 'obc', name: 'DC depot / pantograph charging; AC OBC optional', note: 'City buses charge from DC depot chargers or opportunity pantographs — many carry no AC OBC at all. Where one exists it is a low-power service/limp-home path.' },
  rv: { kind: 'obc', name: 'Shore-power inverter/charger', note: 'The RV house bank charges from campground AC through an inverter/charger (and from the alternator while driving).' },
  marine: { kind: 'obc', name: 'Shore-power charger / inverter-charger', note: 'Vessels charge from shore AC through marine chargers; class rules apply to the installation.' },
  ebike: { kind: 'external', name: 'External charger brick (typ. 2–4 A)', note: 'The charger is an off-board brick — nothing to design on the pack beyond the charge port and the BMS charge path.' },
  escooter: { kind: 'external', name: 'External charger brick', note: 'Off-board brick; the pack carries only the port and protection.' },
  powertool: { kind: 'external', name: 'Dock/cradle charger (off-board)', note: 'The pack slots into a mains-powered cradle; AC/DC conversion lives in the cradle.' },
  powerstation: { kind: 'obc', name: 'Built-in AC charger + solar MPPT input', note: 'Power stations genuinely carry their charger on board — AC mains input plus a PV/MPPT input.' },
  drone: { kind: 'external', name: 'External charger / charging case', note: 'Flight packs charge off-board; mass on the airframe is too expensive for a charger.' },
  wearable: { kind: 'host', name: 'Charged via the host device (USB / cradle)', note: 'Nothing to design here — the host electronics own charging; the cell sees a regulated CC-CV source.' },
  robovac: { kind: 'dock', name: 'Charging dock (DC contacts)', note: 'The dock converts AC to DC; the robot carries only contacts and the BMS charge path.' },
  robot: { kind: 'dock', name: 'Automatic charging station / battery swap', note: 'AGVs use DC charging stations at waypoints, or swap batteries; opportunity charging at stations is a fleet-sizing decision.' },
  humanoid: { kind: 'dock', name: 'Charging dock (DC)', note: 'Dock supplies DC between missions.' },
  'solar-ess': { kind: 'pcs', name: 'PCS / hybrid inverter — the plant IS the AC side', note: 'Stationary storage has no "on-board charger": the power conversion system is the AC interface, and charging is a dispatch decision (PV surplus, tariff windows).' },
  ups: { kind: 'pcs', name: 'Rectifier/PCS float charging', note: 'UPS batteries float on the rectifier; charging power is sized against recharge-time requirements after an outage.' },
};
export const chargingArchitectureFor = (appId) =>
  CHARGING_ARCH_BY_APP[appId] || { kind: 'external', name: 'External charger', note: 'No application-specific charging architecture on record — an off-board charger is the safe default.' };

// ---------------------------------------------------------------------------
// Charging strategies — how the duty cycle meets the grid. Depot vs
// opportunity is a pack-sizing decision: opportunity top-ups let a smaller,
// higher-C pack do the same route, at the price of more cycles and harder
// thermal duty. appIds lists who genuinely uses it; the first match in
// strategiesFor() is the default.
// ---------------------------------------------------------------------------
export const CHARGE_STRATEGIES = [
  {
    id: 'depot-overnight', name: 'Depot / overnight charging',
    appIds: ['ebus', 'ev', 'robot', 'marine', 'rv'],
    when: 'The whole recharge happens in one long window at base — lowest C-rate, cheapest energy, gentlest on the cells.',
    pros: ['lowest charge C-rate — cycle life and thermal duty are easy', 'cheapest energy (off-peak, managed site load)', 'simplest infrastructure: one charger per vehicle or a shared depot'],
    cons: ['the pack must carry the WHOLE duty between windows — largest pack', 'depot grid connection becomes the site bottleneck at fleet scale'],
  },
  {
    id: 'opportunity', name: 'Opportunity charging (top-ups in the duty)',
    appIds: ['ebus', 'robot', 'humanoid'],
    when: 'High-power top-ups during natural pauses (bus stops with pantographs, AGV waypoints). A smaller pack does the same route.',
    pros: ['smaller, lighter, cheaper pack for the same route', 'energy arrives during paid idle time'],
    cons: ['high charge C-rate — thermal duty and cycle count rise sharply', 'route is hostage to the charging points: one broken pantograph strands the schedule', 'many shallow cycles — check the cycle-life economics, not just the datasheet count'],
  },
  {
    id: 'home-ac', name: 'Home / workplace AC',
    appIds: ['ev', 'ebike', 'escooter'],
    when: 'The default life of a private vehicle: plugged in wherever it parks, limited by the OBC.',
    pros: ['cheapest infrastructure that exists — a socket', 'overnight window suits cell-friendly rates'],
    cons: ['the OBC, not the pack, sets the recharge speed', 'depends on parking with power'],
  },
  {
    id: 'public-dc', name: 'Public DC fast charging',
    appIds: ['ev'],
    when: 'Long-distance days: DC bypasses the OBC and the CELL becomes the limit. Preconditioning (the heater/BTMS branch) is what makes winter fast-charging work.',
    pros: ['minutes, not hours', 'enables long-distance duty without a bigger pack'],
    cons: ['hardest thermal duty the pack sees — the cooling system is sized by this, not by driving', 'fast cycles age the cells faster; frequent DC use changes the TCO', 'expensive energy'],
  },
  {
    id: 'shore-power', name: 'Shore power',
    appIds: ['rv', 'marine'],
    when: 'Campground or harbour AC through an inverter/charger; the alternator covers under way.',
    pros: ['long connected windows — low rates', 'standard installations and connectors'],
    cons: ['sites without power need the pack to carry the whole stay'],
  },
  {
    id: 'tariff-window', name: 'PV-surplus / tariff-window dispatch',
    appIds: ['solar-ess', 'ups', 'powerstation'],
    when: 'Charging is a dispatch decision by the EMS: absorb PV at midday, buy in the cheap window, hold reserve for outages.',
    pros: ['charging earns money (or avoids cost) instead of just costing it', 'C-rates are usually gentle'],
    cons: ['availability depends on forecast quality', 'reserve requirements limit how deep the window can be used'],
  },
  {
    id: 'dock', name: 'Dock between missions',
    appIds: ['robovac', 'humanoid', 'robot', 'powertool', 'drone', 'wearable'],
    when: 'The machine returns to a dock/cradle; charge windows are the gaps in the duty cycle.',
    pros: ['fully automatic — no human in the loop', 'many small top-ups keep the working window open'],
    cons: ['shallow-cycle count climbs quickly — check cycle-life economics', 'dock throughput limits fleet size'],
  },
];
export function strategiesFor(appId) {
  return CHARGE_STRATEGIES.filter((s) => s.appIds.includes(appId));
}

// ---------------------------------------------------------------------------
// Charge-time math. CC at the available DC power up to CV_KNEE_SOC, then a
// tapered CV tail modelled as charging at CV_TAPER × the CC power on
// average — a class simplification, stated in REFERENCES.md §8.
// The available DC power is the SMALLER of what the source provides and
// what the pack accepts — naming that limiter is the useful output.
// ---------------------------------------------------------------------------
export const CV_KNEE_SOC = 0.8;
export const CV_TAPER = 0.45;

export function chargeTime({ energyWh, socFrom = 0.2, socTo = 1.0, sourceKW, sourceLabel = 'charger', efficiency = 1.0, packChargeKW = null }) {
  if (!(energyWh > 0) || !(sourceKW > 0) || socTo <= socFrom) return null;
  const dcFromSourceKW = sourceKW * efficiency;
  const dcKW = packChargeKW != null ? Math.min(dcFromSourceKW, packChargeKW) : dcFromSourceKW;
  const limitedBy = packChargeKW != null && packChargeKW < dcFromSourceKW ? 'pack' : 'source';
  const packKWh = energyWh / 1000;
  const ccFrac = Math.max(0, Math.min(socTo, CV_KNEE_SOC) - socFrom);
  const cvFrac = Math.max(0, socTo - Math.max(socFrom, CV_KNEE_SOC));
  const ccH = (packKWh * ccFrac) / dcKW;
  const cvH = (packKWh * cvFrac) / (dcKW * CV_TAPER);
  return {
    hours: ccH + cvH, ccHours: ccH, cvHours: cvH,
    dcKW, limitedBy,
    lossW: sourceKW * 1000 * (1 - efficiency), // conversion heat while charging
    note: limitedBy === 'pack'
      ? `The pack's charge acceptance (${packChargeKW.toFixed(1)} kW) is the bottleneck — a bigger ${sourceLabel} would not charge faster.`
      : `The ${sourceLabel} (${(sourceKW * efficiency).toFixed(1)} kW DC after losses) is the bottleneck — the pack could accept more.`,
  };
}

// ---------------------------------------------------------------------------
// The orchestrated plan the UI and report consume.
// ---------------------------------------------------------------------------
export function buildChargingPlan({ appId, marketId, energyWh, vNomV, cell, obcOverride = 'auto' }) {
  const arch = chargingArchitectureFor(appId);
  const iface = acInterfaceFor(marketId);
  const strategies = strategiesFor(appId);

  // The pack's charge acceptance, from the ONE number cells actually
  // publish: the rated continuous charge current. No second, faster
  // "maximum" is invented — if the datasheet gives one figure, so do we.
  const chargeC = cell?.maxContChargeA != null && cell?.capacityAh > 0
    ? cell.maxContChargeA / cell.capacityAh : null;
  const packChargeKW = chargeC != null && energyWh > 0
    ? (chargeC * energyWh) / 1000 : null;

  // OBC selection only where an OBC exists. Auto: smallest class that is
  // NOT the bottleneck against the standard charge rate (or the largest
  // class if the pack out-accepts them all).
  let obc = null;
  if (arch.kind === 'obc') {
    if (obcOverride && obcOverride !== 'auto' && obcOverride !== 'none') {
      obc = obcById(obcOverride);
    } else if (obcOverride !== 'none') {
      obc = OBC_CLASSES.find((o) => packChargeKW == null || o.acKW * OBC_EFFICIENCY >= packChargeKW)
        || OBC_CLASSES[OBC_CLASSES.length - 1];
    }
  }

  // Charge times: the daily story (20→80% on the OBC/standard source) and
  // the full story (10→100% with the CV tail).
  const sourceKW = obc ? obc.acKW : packChargeKW;
  const sourceLabel = obc ? `${obc.acKW} kW OBC` : 'rated-current charger';
  const efficiency = obc ? OBC_EFFICIENCY : 1.0;
  const t2080 = sourceKW ? chargeTime({ energyWh, socFrom: 0.2, socTo: 0.8, sourceKW, sourceLabel, efficiency, packChargeKW }) : null;
  const t10100 = sourceKW ? chargeTime({ energyWh, socFrom: 0.1, socTo: 1.0, sourceKW, sourceLabel, efficiency, packChargeKW }) : null;

  return {
    arch, iface, strategies, obc,
    packChargeKW, chargeC,
    t2080, t10100,
    obcEfficiency: obc ? OBC_EFFICIENCY : null,
    notes: [
      arch.note,
      ...(arch.kind === 'obc' && packChargeKW != null
        ? [`DC fast charging bypasses the OBC entirely — but the ceiling stays the cell's own charge rating (${packChargeKW.toFixed(1)} kW pack-level, ${chargeC.toFixed(1)}C), and holding it needs the cooling system, not the charger, to keep up.`]
        : []),
    ],
  };
}
