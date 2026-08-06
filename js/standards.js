// standards.js — standards-awareness rule engine for the pack designer.
// Audits a computed pack design against public battery standards and good
// engineering practice. Pure functions, no state and no DOM.
//
// This module provides GUIDANCE ONLY — see DISCLAIMER below.

import { resolveIsolationRule } from './isolation-rule.js';
import { appClassOf } from './markets.js';

export const DISCLAIMER =
  'These checks are engineering guidance derived from publicly documented ' +
  'standards and common industry practice. They are generated from design ' +
  'parameters only: no physical testing has been performed, and passing every ' +
  'check here does not make a pack compliant or safe. Certification against ' +
  'UN 38.3, IEC, UL, EN or ECE requirements can only be granted after testing ' +
  'of real hardware by an accredited laboratory. Always verify against the ' +
  'current edition of each standard and the cell manufacturer’s ' +
  'specification before building, charging or transporting a battery pack.';

// Which application classes each reference belongs to (classes as defined
// in markets.js: vehicle, lmt, stationary, marine, industrial, portable;
// 'all' = transport/insulation/handling basics that apply everywhere).
// The Analysis reference list FILTERS by the active application, so a
// vacuum robot never advertises ECE R100 — integration, not decoration.
// The integration test suite fails if a STANDARDS_INFO entry is added
// without a classification here.
export const STANDARD_CLASSES = {
  un383: ['all'],
  'iata-dgr': ['all'],
  'adr-sp188': ['all'],
  'ece-r100': ['vehicle'],
  'iso6469-3': ['vehicle'],
  iec62619: ['stationary', 'industrial', 'marine', 'auxiliary'],
  'iec62133-2': ['portable', 'lmt'],
  ul2580: ['vehicle', 'industrial'],
  ul2271: ['lmt'],
  ul2272: ['lmt'],
  'en50604-1': ['lmt'],
  en15194: ['lmt'],
  ul1973: ['stationary', 'industrial', 'auxiliary'],
  ul9540: ['stationary'],
  ul9540a: ['stationary'],
  ul2743: ['portable'],
  'iec60664-1': ['all'],
  'abyc-e13': ['marine'],
  'niosh-lift': ['all'],
};

export function standardsForClass(cls) {
  return STANDARDS_INFO.filter((s) => {
    const c = STANDARD_CLASSES[s.id] || ['all'];
    return c.includes('all') || (cls != null && c.includes(cls));
  });
}

export const STANDARDS_INFO = [
  {
    id: 'un383',
    code: 'UN 38.3',
    title: 'Transport of lithium cells and batteries',
    scope:
      'Sub-section 38.3 of the UN Manual of Tests and Criteria. Defines tests ' +
      'T1–T8 (altitude simulation, thermal cycling, vibration, shock, ' +
      'external short circuit, impact/crush, overcharge, forced discharge) ' +
      'that every lithium cell and battery must pass before transport by any mode.'
  },
  {
    id: 'iata-dgr',
    code: 'IATA DGR PI 965–967',
    title: 'Air transport packing instructions for lithium-ion batteries',
    scope:
      'IATA Dangerous Goods Regulations packing instructions for UN 3480 ' +
      '(lithium-ion batteries shipped alone, PI 965) and UN 3481 (packed with ' +
      'or contained in equipment, PI 966/967). Includes the 30% state-of-charge ' +
      'limit for air shipment and the 100 Wh battery / 20 Wh cell thresholds ' +
      'for excepted (Section II) provisions.'
  },
  {
    id: 'adr-sp188',
    code: 'ADR SP 188',
    title: 'European road transport — excepted lithium batteries',
    scope:
      'Special provision 188 of the UN Model Regulations as applied by ADR ' +
      '(road transport of dangerous goods in Europe). Allows relaxed transport ' +
      'conditions for cells ≤ 20 Wh and batteries ≤ 100 Wh that have ' +
      'passed UN 38.3 and meet packaging/marking requirements.'
  },
  {
    id: 'ece-r100',
    code: 'ECE R100',
    title: 'UN Regulation No. 100 — electric power train vehicle safety',
    scope:
      'Approval requirements for electric power trains of road vehicles. ' +
      'Defines voltage class B (> 60 V and ≤ 1500 V DC), and requires ' +
      'topology-specific isolation resistance: 100 Ω/V for a separate DC bus, ' +
      '500 Ω/V for a separate AC bus, and 500 Ω/V for connected AC/DC buses ' +
      '(with a documented 100 Ω/V protection exception), ' +
      'protection against direct/indirect contact, HV marking and REESS abuse tests.'
  },
  {
    id: 'iso6469-3',
    code: 'ISO 6469-3',
    title: 'Electrically propelled road vehicles — electrical safety',
    scope:
      'Electrical safety requirements for voltage class B circuits in road ' +
      'vehicles: protection against electric shock, isolation, potential ' +
      'equalization and withstand voltage.'
  },
  {
    id: 'iec62619',
    code: 'IEC 62619',
    title: 'Secondary lithium cells and batteries — industrial applications',
    scope:
      'Safety requirements for lithium cells and batteries used in industrial ' +
      'applications, including stationary energy storage. Covers system-level ' +
      'protection (overcharge, over-current, overheating), and thermal-runaway ' +
      'propagation considerations.'
  },
  {
    id: 'iec62133-2',
    code: 'IEC 62133-2',
    title: 'Portable sealed secondary lithium cells and batteries',
    scope:
      'Safety requirements for portable sealed lithium cells and the batteries ' +
      'made from them, for use in portable applications. The usual route for ' +
      'consumer/portable packs (roughly hand-carriable sizes).'
  },
  {
    id: 'ul2580',
    code: 'UL 2580',
    title: 'Batteries for use in electric vehicles',
    scope:
      'Safety standard for EV traction battery packs: electrical, mechanical ' +
      'and environmental abuse tolerance, with emphasis on containing ' +
      'single-cell failure without hazard to occupants.'
  },
  {
    id: 'ul2271',
    code: 'UL 2271',
    title: 'Batteries for use in light electric vehicle (LEV) applications',
    scope:
      'Safety standard for battery packs used in e-bikes, e-scooters and other ' +
      'light electric vehicles.'
  },
  {
    id: 'ul2272',
    code: 'UL 2272',
    title: 'Electrical systems for personal e-mobility devices',
    scope:
      'System-level safety standard for self-balancing scooters, e-scooters ' +
      'and similar personal e-mobility devices, covering the battery together ' +
      'with the drive and charging system.'
  },
  {
    id: 'en50604-1',
    code: 'EN 50604-1',
    title: 'Secondary lithium batteries for light EV applications',
    scope:
      'European safety standard for lithium battery packs and systems used in ' +
      'light electric vehicles (e-bikes, mopeds, LEV category).'
  },
  {
    id: 'en15194',
    code: 'EN 15194',
    title: 'Electrically power assisted cycles (EPAC)',
    scope:
      'European product standard for pedal-assist e-bikes; references battery ' +
      'safety requirements for the traction battery of an EPAC.'
  },
  {
    id: 'ul1973',
    code: 'UL 1973',
    title: 'Batteries for use in stationary and motive auxiliary power',
    scope:
      'Safety standard for battery systems used in stationary applications ' +
      '(grid/home storage) and motive auxiliary power (rail, marine house banks).'
  },
  {
    id: 'ul9540',
    code: 'UL 9540',
    title: 'Energy storage systems and equipment',
    scope:
      'System-level safety standard for energy storage systems, combining the ' +
      'battery (e.g. UL 1973), power conversion and controls as an installed system.'
  },
  {
    id: 'ul9540a',
    code: 'UL 9540A',
    title: 'Test method for thermal runaway fire propagation in battery ESS',
    scope:
      'Standardized test method (cell, module, unit and installation level) ' +
      'used as evidence that thermal runaway does not propagate between cells ' +
      'or units of an energy storage system.'
  },
  {
    id: 'ul2743',
    code: 'UL 2743',
    title: 'Portable power packs',
    scope:
      'Safety standard for portable power stations / power packs that combine ' +
      'a rechargeable battery with outlets and charging electronics.'
  },
  {
    id: 'iec60664-1',
    code: 'IEC 60664-1',
    title: 'Insulation coordination — clearances and creepage distances',
    scope:
      'Defines minimum clearance and creepage distances for equipment in ' +
      'low-voltage systems as a function of working voltage, pollution degree ' +
      'and overvoltage category.'
  },
  {
    id: 'abyc-e13',
    code: 'ABYC E-13',
    title: 'Lithium-ion batteries on boats',
    scope:
      'American Boat & Yacht Council standard for the installation of ' +
      'lithium-ion battery systems on vessels: BMS requirements, disconnects, ' +
      'charging sources and installation practice.'
  },
  {
    id: 'niosh-lift',
    code: 'NIOSH lifting guideline',
    title: 'Ergonomics of manual lifting',
    scope:
      'The NIOSH lifting equation caps the recommended single-person lift at ' +
      '23 kg (51 lb) under ideal conditions. Used here as a coarse guide for ' +
      'when a pack needs two-person or mechanical handling.'
  }
];

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

const SEVERITY_ORDER = { fail: 0, warn: 1, pass: 2, info: 3 };

const HIGH_ENERGY_CHEMS = ['NMC', 'NCA', 'LCO'];

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// Format a number to a sensible precision without false precision.
function fmt(n, digits) {
  if (!isNum(n)) return '?';
  if (digits === undefined) {
    const a = Math.abs(n);
    digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  }
  const s = n.toFixed(digits);
  // strip trailing zeros / dot
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
}

function pct(ratio) {
  return fmt(ratio * 100, ratio * 100 >= 100 ? 0 : 1) + '%';
}

// Orchestrated designs pass the exact immutable architecture result so this
// standards surface cannot drift to another topology. Context re-resolution
// remains only for standalone/legacy module callers.
function isolationForConsumer(ctx, workingVoltageV) {
  if (Object.hasOwn(ctx || {}, 'isolationResolution')) {
    const resolved = ctx.isolationResolution || null;
    if (resolved?.workingVoltageV != null
      && Math.abs(resolved.workingVoltageV - workingVoltageV) > 1e-9) return null;
    return resolved;
  }
  const rawContext = ctx?.isolationContext || null;
  const applicationContext = rawContext && typeof rawContext === 'object'
    ? rawContext.applicationContext
    : (ctx?.usage?.application === 'marine' ? 'marine-it' : null);
  try {
    return resolveIsolationRule({
      ...(typeof rawContext === 'string' ? { contextId: rawContext } : (rawContext || {})),
      workingVoltageV,
      applicationContext,
    });
  } catch {
    return null;
  }
}

function finding(id, severity, category, title, detail, ref) {
  return { id, severity, category, title, detail, ref };
}

/* ------------------------------------------------------------------ *
 *  Rules — each takes ctx, returns a finding, an array of findings,
 *  or null. They never mutate ctx and never recompute pack math.
 * ------------------------------------------------------------------ */

// 1a. Continuous current utilization
function ruleContinuousCurrent(ctx) {
  const { usage, pack } = ctx;
  if (!usage || !isNum(usage.contPowerW) || usage.contPowerW <= 0) {
    return finding(
      'load-continuous', 'info', 'electrical',
      'Continuous load not specified',
      'No usage profile was provided, so continuous current utilization was not audited. ' +
      'Enter an application load to check the design against the cells’ continuous discharge rating.',
      'IEC 62619'
    );
  }
  if (!isNum(pack.nominalV) || pack.nominalV <= 0 || !isNum(pack.maxContCurrentA) || pack.maxContCurrentA <= 0) {
    return null;
  }
  const reqA = usage.contPowerW / pack.nominalV;
  const util = reqA / pack.maxContCurrentA;
  const sev = util > 1 ? 'fail' : util >= 0.7 ? 'warn' : 'pass';
  const base =
    'A continuous load of ' + fmt(usage.contPowerW, 0) + ' W at ' + fmt(pack.nominalV) +
    ' V nominal draws about ' + fmt(reqA) + ' A, which is ' + pct(util) +
    ' of the pack’s ' + fmt(pack.maxContCurrentA) + ' A continuous rating.';
  const tail =
    sev === 'fail'
      ? ' This exceeds the cells’ continuous discharge capability; the design must add parallel strings, use a higher-rate cell, or reduce load.'
      : sev === 'warn'
        ? ' Running above 70% of the rating leaves little margin for aging, cold operation and voltage sag; consider more parallel capability or derating.'
        : ' This leaves healthy margin (< 70% utilization) for aging and temperature derating.';
  return finding('load-continuous', sev, 'electrical', 'Continuous current utilization', base + tail, 'IEC 62619');
}

// 1b. Peak current vs pulse rating
function rulePeakCurrent(ctx) {
  const { usage, pack, cell, p } = ctx;
  if (!usage || !isNum(usage.peakPowerW) || usage.peakPowerW <= 0) return null;
  if (!isNum(pack.nominalV) || pack.nominalV <= 0) return null;
  const pulsePerCell = isNum(cell.maxPulseDischargeA) ? cell.maxPulseDischargeA : cell.maxContDischargeA;
  if (!isNum(pulsePerCell) || pulsePerCell <= 0) return null;
  const packPulseA = pulsePerCell * p;
  const reqA = usage.peakPowerW / pack.nominalV;
  const util = reqA / packPulseA;
  const usedCont = !isNum(cell.maxPulseDischargeA);
  const sev = util > 1 ? 'fail' : util >= 0.7 ? 'warn' : 'pass';
  const base =
    'The peak load of ' + fmt(usage.peakPowerW, 0) + ' W draws about ' + fmt(reqA) + ' A, which is ' +
    pct(util) + ' of the pack’s ' + fmt(packPulseA) + ' A ' +
    (usedCont ? 'continuous rating (no pulse rating is published for this cell, so the continuous rating was used as a conservative stand-in).'
              : 'pulse rating (' + fmt(pulsePerCell) + ' A per cell × ' + p + 'P).');
  const tail =
    sev === 'fail'
      ? ' Peak demand exceeds the cells’ rating; expect severe voltage sag, protection trips or cell damage.'
      : sev === 'warn'
        ? ' Peaks above 70% of the rating will cause significant voltage sag, especially when cold or aged.'
        : ' Peak demand fits comfortably within the rating.';
  return finding('load-peak', sev, 'electrical', 'Peak current utilization', base + ' ' + tail, 'IEC 62619');
}

// 2. Charge rate
function ruleChargeRate(ctx) {
  const { usage, cell } = ctx;
  if (!isNum(cell.maxContChargeA) || !isNum(cell.capacityAh) || cell.capacityAh <= 0) return null;
  const maxC = cell.maxContChargeA / cell.capacityAh;
  if (!usage || !isNum(usage.chargeRateC) || usage.chargeRateC <= 0) {
    return finding(
      'charge-rate', 'info', 'electrical',
      'Charge rate not specified',
      'No charge rate was provided. This cell supports up to ' + fmt(cell.maxContChargeA) +
      ' A continuous charge (about ' + fmt(maxC, 2) + 'C); size the charger at or below that per parallel cell.',
      'IEC 62619'
    );
  }
  const ratio = usage.chargeRateC / maxC;
  const sev = ratio > 1 ? 'fail' : ratio >= 0.8 ? 'warn' : 'pass';
  let detail =
    'The requested charge rate of ' + fmt(usage.chargeRateC, 2) + 'C corresponds to ' +
    fmt(usage.chargeRateC * cell.capacityAh, 2) + ' A per cell against the cell’s maximum of ' +
    fmt(cell.maxContChargeA) + ' A (' + fmt(maxC, 2) + 'C).';
  if (sev === 'fail') {
    detail += ' This exceeds the cell’s charge rating and risks lithium plating, heating and accelerated degradation; reduce the charge current or choose a faster-charging cell.';
  } else if (sev === 'warn') {
    detail += ' This is at or near the cell’s limit (≥ 80%); expect elevated heating and reduced cycle life, and derate in cold conditions.';
  } else {
    detail += ' This is within the cell’s rating with margin.';
  }
  if (cell.chemistry === 'LTO') {
    detail += ' Note: high charge rates are a strength of LTO chemistry, which tolerates fast charging far better than graphite-anode cells.';
  }
  return finding('charge-rate', sev, 'electrical', 'Charge rate vs cell rating', detail, 'IEC 62619');
}

// 3. BMS requirement
function ruleBms(ctx) {
  const { s, p } = ctx;
  if (s > 1) {
    return finding(
      'bms-required', 'info', 'protection',
      'BMS with per-group monitoring required',
      'With ' + s + ' cell groups in series, a battery management system that monitors every series ' +
      'group’s voltage and provides cell balancing is required — series groups drift apart over ' +
      'life, and an unmonitored group can be overcharged or overdischarged even when the pack voltage looks normal. ' +
      'The BMS must disconnect or inhibit charge/discharge on overvoltage, undervoltage, overcurrent and overtemperature.',
      'IEC 62619 §8; IEC 62133-2'
    );
  }
  return finding(
    'bms-required', 'info', 'protection',
    'Protection circuit still required at 1S',
    'This pack has a single series group' + (p > 1 ? ' (' + p + ' cells in parallel)' : '') +
    ', so no balancing is needed, but overcharge, overdischarge, overcurrent and overtemperature ' +
    'protection are still required. A simple protection circuit or charge controller enforcing the ' +
    'cell’s voltage and current limits satisfies this.',
    'IEC 62133-2; IEC 62619 §8'
  );
}

// 4. Parallel-group fusing
function ruleParallelFusing(ctx) {
  const { p, cell } = ctx;
  const highEnergyCyl = cell.form === 'cylindrical' && HIGH_ENERGY_CHEMS.indexOf(cell.chemistry) >= 0;
  if (p >= 10 && highEnergyCyl) {
    return finding(
      'parallel-fusing', 'warn', 'protection',
      'Per-cell fusing recommended for large parallel groups',
      'This design directly parallels ' + p + ' high-energy ' + cell.chemistry + ' cylindrical cells per group. ' +
      'If one cell fails short, all its parallel neighbours discharge into the fault; industry practice for groups ' +
      'this size is a fusible link (wire bond or fuse) on each cell so a shorted cell is isolated instead of ' +
      'igniting the group. This follows the single-cell-failure tolerance philosophy of UL 2580 / UL 9540A.',
      'UL 2580'
    );
  }
  if (p > 1) {
    return finding(
      'parallel-fusing', 'pass', 'protection',
      'Parallel group size below fusing threshold',
      'With ' + p + ' cells per parallel group' +
      (highEnergyCyl ? '' : ' and this cell type') +
      ', the stored energy available to feed a single shorted cell is limited; per-cell fusing is not flagged ' +
      'as necessary here, though it remains good practice for high-energy designs.',
      'UL 2580'
    );
  }
  return finding(
    'parallel-fusing', 'pass', 'protection',
    'No parallel cells',
    'Each series group is a single cell (1P), so there is no parallel-group fault path and per-cell fusing ' +
    'does not apply. String-level overcurrent protection is still required.',
    'UL 2580'
  );
}

// 5. Short-circuit / fuse sizing
function ruleShortCircuit(ctx) {
  const { pack } = ctx;
  if (isNum(pack.dcirMOhm) && pack.dcirMOhm > 0 && isNum(pack.vMax)) {
    const iscA = pack.vMax / (pack.dcirMOhm / 1000);
    return finding(
      'short-circuit', 'info', 'protection',
      'Prospective short-circuit current',
      'From the pack DC internal resistance of ' + fmt(pack.dcirMOhm) + ' mΩ at ' + fmt(pack.vMax) +
      ' V max, the prospective bolted-short current is roughly ' + fmt(iscA, 0) + ' A (an upper bound; ' +
      'interconnect resistance will reduce it). The main pack fuse or breaker must have an interrupt (breaking) ' +
      'rating above this current at the pack voltage — a fuse that cannot break the arc is worse than none.',
      'IEC 62619; UL 2580'
    );
  }
  const nominal = isNum(pack.maxContCurrentA) ? pack.maxContCurrentA : null;
  return finding(
    'short-circuit', 'info', 'protection',
    'Pack fuse sizing',
    'Pack internal resistance is not specified, so the prospective short-circuit current was not estimated. ' +
    'Fit a main fuse or breaker sized at roughly 1.25–1.5× the maximum continuous current' +
    (nominal ? ' (' + fmt(nominal * 1.25, 0) + '–' + fmt(nominal * 1.5, 0) + ' A for this pack)' : '') +
    ', with a DC voltage and interrupt rating suitable for the pack.',
    'IEC 62619'
  );
}

// 6. Voltage class
function ruleVoltageClass(ctx) {
  const { pack } = ctx;
  if (!isNum(pack.vMax)) return null;
  if (pack.vMax > 1500) {
    return finding(
      'voltage-class', 'fail', 'electrical',
      'Above 1500 V DC — outside scope',
      'The pack maximum voltage of ' + fmt(pack.vMax) + ' V DC exceeds 1500 V DC, the upper bound of ' +
      'voltage class B in ECE R100 / ISO 6469-3 and the scope of the standards this tool references. ' +
      'Designs above 1500 V DC fall under high-voltage installation rules and are out of scope here.',
      'ECE R100; ISO 6469-3'
    );
  }
  if (pack.vMax > 60) {
    const isolation = isolationForConsumer(ctx, pack.vMax);
    const isolationText = isolation && isolation.applies
      ? ' The declared ' + isolation.busType.toUpperCase() + ' ' +
        isolation.topology.replace('galvanically-', 'galvanically ') + ' case resolves to ' +
        isolation.ohmsPerVolt + ' Ω/V (' + fmt(isolation.floorKOhm, 0) + ' kΩ at this working voltage) ' +
        'under UN R100 §' + isolation.clause + '.'
      : isolation && isolation.status === 'review-required'
        ? ' No UN R100 numeric floor is applied: ' + isolation.basis
        : ' No numeric isolation floor is asserted until the bus type and galvanic topology are declared; ' +
          'UN R100 distinguishes separate DC (100 Ω/V), separate AC (500 Ω/V), and connected AC/DC ' +
          '(500 Ω/V baseline) cases.';
    const nonRoad = isolation && isolation.status === 'review-required';
    const voltageIntro = nonRoad
      ? 'At ' + fmt(pack.vMax) + ' V maximum, this pack exceeds 60 V DC and requires a declared ' +
        'high-voltage protection and earthing basis for its actual installation.'
      : 'At ' + fmt(pack.vMax) + ' V maximum, this pack exceeds 60 V DC and is voltage class B under ' +
        'ECE R100 / ISO 6469-3.';
    return finding(
      'voltage-class', 'warn', 'electrical',
      nonRoad ? 'High-voltage safety basis required' : 'Voltage class B — HV safety measures required',
      voltageIntro + ' Required measures include double or reinforced insulation, touch protection to ' +
      'at least IPXXB on live parts, topology-appropriate isolation protection and monitoring where applicable, ' +
      'a high-voltage interlock loop (HVIL) on serviceable connections, and orange marking of HV wiring.' +
      isolationText,
      nonRoad ? 'applicable marine class / flag-state requirements' : 'ECE R100; ISO 6469-3'
    );
  }
  const applicationClass = appClassOf(ctx.usage?.application);
  if (applicationClass !== 'vehicle') {
    const marine = applicationClass === 'marine';
    return finding(
      'voltage-class', 'info', 'electrical',
      marine ? 'Below the project 60 V DC boundary — marine basis still required' : 'Below the project 60 V DC boundary',
      'The pack maximum voltage of ' + fmt(pack.vMax) + ' V is at or below the project boundary. ' +
      'UN R100 and ISO 6469-3 are road-vehicle references, so this result does not use their voltage-class label ' +
      'or claim that they waive protection for this application. ' +
      (marine
        ? 'Declare the vessel distribution, earthing philosophy, class rules and flag-state requirements; an intentionally unearthed marine system may still need first-fault monitoring.'
        : 'Apply the governing product, industrial or installation standard for the declared application.'),
      marine ? 'applicable marine class / flag-state requirements' : 'applicable product / installation standard'
    );
  }
  return finding(
    'voltage-class', 'pass', 'electrical',
    'Voltage class A (≤ 60 V DC)',
    'The road-vehicle pack maximum voltage of ' + fmt(pack.vMax) + ' V is at or below 60 V DC, so it is voltage class A ' +
    'under UN R100 / ISO 6469-3. The dedicated high-voltage shock-protection measures ' +
    '(HVIL, isolation monitoring, orange marking) are not mandated by those vehicle provisions, though good insulation practice still applies.',
    'UN R100; ISO 6469-3'
  );
}

// 7. Creepage / clearance pointer
function ruleCreepage(ctx) {
  const { pack } = ctx;
  if (!isNum(pack.vMax) || pack.vMax <= 60) return null;
  return finding(
    'creepage-clearance', 'info', 'electrical',
    'Creepage and clearance distances',
    'At ' + fmt(pack.vMax) + ' V DC, printed-circuit and busbar spacing inside the pack must satisfy the ' +
    'clearance and creepage distances of IEC 60664-1 for the working voltage, expected pollution degree and ' +
    'overvoltage category. Condensation and conductive dust inside an enclosure push the required creepage up; ' +
    'conformal coating or potting can reduce it.',
    'IEC 60664-1'
  );
}

// 8. Cell spacing / thermal propagation
function ruleCellSpacing(ctx) {
  const { cell, layout } = ctx;
  const sp = isNum(layout.spacingMm) ? layout.spacingMm : 0;
  const refStr = 'UL 2580; IEC 62619; UL 9540A';

  if (cell.chemistry === 'LTO') {
    return finding(
      'cell-spacing', 'pass', 'thermal',
      'Cell spacing — low propagation risk chemistry',
      'LTO cells have very high thermal stability and are not prone to energetic thermal runaway, so the ' +
      fmt(sp) + ' mm cell spacing is not flagged. Normal thermal management for heat rejection under load still applies.',
      refStr
    );
  }

  if (layout.arrangement === 'stack' && (cell.form === 'prismatic' || cell.form === 'pouch')) {
    return finding(
      'cell-spacing', 'pass', 'thermal',
      'Stacked prismatic/pouch arrangement',
      'A ' + fmt(sp) + ' mm spacing in a stacked ' + cell.form + ' arrangement is acceptable when the stack is ' +
      'under controlled compression, which pouch and many prismatic cells require. However, direct face-to-face ' +
      'contact gives an easy heat path between cells, so include propagation barriers (aerogel, mica or ' +
      'intumescent sheets between cells) and demonstrate non-propagation, e.g. via a UL 9540A-style test.',
      refStr
    );
  }

  const highRisk = HIGH_ENERGY_CHEMS.indexOf(cell.chemistry) >= 0;
  const threshold = highRisk ? 1 : 0.5; // LFP / NAION relaxed
  if (cell.form === 'cylindrical' && sp < threshold) {
    return finding(
      'cell-spacing', 'warn', 'thermal',
      'Cell spacing may not mitigate propagation',
      'Cylindrical ' + cell.chemistry + ' cells at ' + fmt(sp) + ' mm spacing are below the ~' + fmt(threshold, 1) +
      ' mm this tool uses as a minimum air gap for thermal-runaway propagation mitigation' +
      (highRisk ? ' for high-energy chemistries' : ' (relaxed threshold for this lower-risk chemistry)') +
      '. Touching or near-touching cells conduct runaway heat directly into neighbours; add spacing, potting, or ' +
      'interstitial barriers, and validate non-propagation by test (UL 9540A is the recognized evidence route).',
      refStr
    );
  }
  return finding(
    'cell-spacing', 'pass', 'thermal',
    'Cell spacing adequate for propagation mitigation',
    'The ' + fmt(sp) + ' mm spacing between ' + cell.form + ' ' + cell.chemistry + ' cells meets the ~' +
    fmt(threshold, 1) + ' mm minimum this tool applies for thermal-runaway propagation mitigation. Spacing alone ' +
    'is not proof of non-propagation — a test to a method such as UL 9540A is the accepted evidence.',
    refStr
  );
}

// 9. Operating temperature envelope + cold charging
function ruleTempEnvelope(ctx) {
  const { usage, cell } = ctx;
  const out = [];
  const dis = cell.tempDischargeC;
  const chg = cell.tempChargeC;
  if (!usage || !Array.isArray(usage.envTempC) || usage.envTempC.length !== 2) {
    out.push(finding(
      'temp-envelope', 'info', 'thermal',
      'Environment temperature not specified',
      'No environmental temperature range was provided, so the operating envelope was not audited. ' +
      'This cell is rated for discharge over ' + fmt(dis && dis[0]) + ' to ' + fmt(dis && dis[1]) +
      ' °C and charge over ' + fmt(chg && chg[0]) + ' to ' + fmt(chg && chg[1]) + ' °C per its datasheet.',
      'Cell datasheet'
    ));
    return out;
  }
  const [envMin, envMax] = usage.envTempC;

  if (Array.isArray(dis) && (envMin < dis[0] || envMax > dis[1])) {
    out.push(finding(
      'temp-envelope', 'fail', 'thermal',
      'Environment outside cell discharge window',
      'The application environment of ' + fmt(envMin) + ' to ' + fmt(envMax) + ' °C extends outside the ' +
      'cell’s rated discharge window of ' + fmt(dis[0]) + ' to ' + fmt(dis[1]) + ' °C. Operating a cell ' +
      'outside its datasheet window voids its ratings and can cause damage; add heating/cooling or select a cell ' +
      'rated for this environment.',
      'Cell datasheet; IEC 62619'
    ));
  } else if (Array.isArray(dis)) {
    out.push(finding(
      'temp-envelope', 'pass', 'thermal',
      'Environment within cell discharge window',
      'The application environment of ' + fmt(envMin) + ' to ' + fmt(envMax) + ' °C sits inside the ' +
      'cell’s rated discharge window of ' + fmt(dis[0]) + ' to ' + fmt(dis[1]) + ' °C.',
      'Cell datasheet'
    ));
  }

  if (Array.isArray(chg)) {
    if (envMin < chg[0]) {
      if (cell.chemistry === 'LTO') {
        out.push(finding(
          'cold-charge', 'warn', 'thermal',
          'Ambient below cell charge window',
          'The environment can reach ' + fmt(envMin) + ' °C, below this LTO cell’s minimum charge ' +
          'temperature of ' + fmt(chg[0]) + ' °C. LTO does not suffer lithium plating like graphite cells, ' +
          'but the datasheet window still governs; inhibit or derate charging below it.',
          'Cell datasheet'
        ));
      } else {
        out.push(finding(
          'cold-charge', 'warn', 'thermal',
          'Cold charging risk — lithium plating',
          'The environment can reach ' + fmt(envMin) + ' °C, below the cell’s minimum charge ' +
          'temperature of ' + fmt(chg[0]) + ' °C. Charging graphite-anode lithium cells below ~0 °C ' +
          'deposits metallic lithium on the anode (plating), permanently reducing capacity and creating an ' +
          'internal-short hazard. The BMS must inhibit charge below the datasheet limit, or the pack needs a ' +
          'heater to warm cells before charging.',
          'Cell datasheet; IEC 62619'
        ));
      }
    }
    if (envMax > chg[1]) {
      out.push(finding(
        'hot-charge', 'warn', 'thermal',
        'Ambient above cell charge window',
        'The environment can reach ' + fmt(envMax) + ' °C, above the cell’s maximum charge ' +
        'temperature of ' + fmt(chg[1]) + ' °C. Charging above the datasheet limit accelerates ' +
        'degradation and is an overtemperature hazard; the BMS must inhibit or derate charge above it.',
        'Cell datasheet; IEC 62619 §8'
      ));
    }
    if (envMin >= chg[0] && envMax <= chg[1]) {
      out.push(finding(
        'cold-charge', 'pass', 'thermal',
        'Charging environment within cell window',
        'The environment range of ' + fmt(envMin) + ' to ' + fmt(envMax) + ' °C sits inside the cell’s ' +
        'charge window of ' + fmt(chg[0]) + ' to ' + fmt(chg[1]) + ' °C, so neither cold-charge lithium ' +
        'plating nor hot-charge overtemperature is flagged for this design.',
        'Cell datasheet'
      ));
    }
  }
  return out;
}

// 10. Pack transport energy threshold
function rulePackTransport(ctx) {
  const { pack } = ctx;
  if (!isNum(pack.energyWh)) return null;
  if (pack.energyWh > 100) {
    return finding(
      'transport-pack-energy', 'info', 'transport',
      'Pack > 100 Wh — fully regulated for transport',
      'At ' + fmt(pack.energyWh, 0) + ' Wh, this pack exceeds the 100 Wh limit for the excepted (Section II) ' +
      'provisions of IATA PI 966/967 and ADR SP 188, so it ships as fully regulated Class 9 dangerous goods ' +
      'under UN 3480 (battery shipped alone) or UN 3481 (packed with / contained in equipment). For air ' +
      'transport it must be offered at no more than 30% state of charge — long required under PI 965 and, ' +
      'from the 2026 regulations, also for UN 3481 shipments under PI 966/967 (limited exceptions with ' +
      'operator/state approval) — and shipments require trained/certified dangerous-goods handling.',
      'IATA DGR PI 965–967; ADR SP 188'
    );
  }
  return finding(
    'transport-pack-energy', 'pass', 'transport',
    'Pack ≤ 100 Wh — excepted provisions available',
    'At ' + fmt(pack.energyWh, 0) + ' Wh, the pack is within the 100 Wh threshold, so it can qualify for the ' +
    'excepted (Section II) provisions of IATA PI 966/967 and ADR SP 188 — simplified marking and ' +
    'documentation rather than full Class 9 handling. UN 38.3 testing and the lithium battery mark are ' +
    'still required.',
    'IATA DGR PI 966/967; ADR SP 188'
  );
}

// 11. Cell transport energy threshold
function ruleCellTransport(ctx) {
  const { cell } = ctx;
  if (!isNum(cell.capacityAh) || !isNum(cell.nominalV)) return null;
  const cellWh = cell.capacityAh * cell.nominalV;
  if (cellWh > 20) {
    return finding(
      'transport-cell-energy', 'info', 'transport',
      'Cell > 20 Wh — fully regulated at cell level',
      'Each ' + (cell.name || 'cell') + ' stores about ' + fmt(cellWh, 1) + ' Wh, above the 20 Wh per-cell ' +
      'limit for excepted transport provisions. Individual cells of this size ship as fully regulated Class 9 ' +
      'dangerous goods (UN 3480) even outside a pack — relevant for shipping spares or prototypes.',
      'IATA DGR PI 965; ADR SP 188'
    );
  }
  return finding(
    'transport-cell-energy', 'pass', 'transport',
    'Cell ≤ 20 Wh',
    'Each ' + (cell.name || 'cell') + ' stores about ' + fmt(cellWh, 1) + ' Wh, within the 20 Wh per-cell ' +
    'threshold for excepted transport provisions. By road (ADR), UN 38.3-tested cells can use the SP 188 ' +
    'excepted route. By air, Section II of PI 965 was withdrawn in 2022: cells shipped alone use PI 965 ' +
    'Section IB, which still requires the Class 9 lithium battery label and a shipper’s declaration.',
    'IATA DGR PI 965 Section IB; ADR SP 188'
  );
}

// 12. UN 38.3 always applies
function ruleUn383(ctx) {
  const { pack } = ctx;
  return finding(
    'un383-testing', 'info', 'transport',
    'UN 38.3 testing required before transport',
    'Regardless of size (' + (isNum(pack.energyWh) ? fmt(pack.energyWh, 0) + ' Wh here' : 'any energy') +
    '), every lithium cell design and every battery design must pass the applicable UN 38.3 tests ' +
    '(T1–T5 apply to cells and batteries; T6 impact/crush and T8 forced discharge to cells only; ' +
    'T7 overcharge to batteries only) before it may be transported, and a test summary must be ' +
    'available. Home-built packs that have not been through this testing cannot legally be shipped.',
    'UN 38.3 §38.3.4'
  );
}

// 13. Certification path by application
const APP_CERT_PATHS = {
  ebike: {
    label: 'e-bike',
    path: 'EN 50604-1 and/or UL 2271 for the battery; EN 15194 governs the complete pedal-assist bicycle in the EU.',
    ref: 'EN 50604-1; UL 2271; EN 15194'
  },
  escooter: {
    label: 'e-scooter',
    path: 'UL 2271 / EN 50604-1 for the battery; UL 2272 covers the complete personal e-mobility device system.',
    ref: 'UL 2271; UL 2272; EN 50604-1'
  },
  drone: {
    label: 'drone',
    path: 'no single harmonized drone-battery standard exists; IEC 62133-2 is the closest fit for the pack, with UN 38.3 for transport and any airframe-specific requirements from the aviation authority.',
    ref: 'IEC 62133-2; UN 38.3'
  },
  powertool: {
    label: 'power tool',
    path: 'IEC 62133-2 (portable sealed cells and batteries).',
    ref: 'IEC 62133-2'
  },
  'solar-ess': {
    label: 'solar / home energy storage',
    path: 'IEC 62619 and UL 1973 for the battery, UL 9540 for the installed system, with UL 9540A propagation test data commonly required by installers and authorities.',
    ref: 'IEC 62619; UL 1973; UL 9540'
  },
  rv: {
    label: 'RV house power',
    path: 'UL 1973 / IEC 62619 (motive auxiliary and stationary use) are the usual references for RV house banks.',
    ref: 'UL 1973; IEC 62619'
  },
  ev: {
    label: 'EV traction',
    path: 'UL 2580 and ISO 6469-3 for the battery/vehicle, with ECE R100 type approval required for road vehicles in UNECE markets.',
    ref: 'UL 2580; ISO 6469-3; ECE R100'
  },
  robot: {
    label: 'robotics',
    path: 'IEC 62619 (industrial applications) for larger platforms, or IEC 62133-2 for small portable-class packs.',
    ref: 'IEC 62619; IEC 62133-2'
  },
  ups: {
    label: 'UPS',
    path: 'IEC 62619 and UL 1973 for the battery within the UPS system.',
    ref: 'IEC 62619; UL 1973'
  },
  powerstation: {
    label: 'portable power station',
    path: 'UL 2743 (portable power packs) for the product, built on IEC 62133-2 / UL-recognized cells.',
    ref: 'UL 2743; IEC 62133-2'
  },
  marine: {
    label: 'marine',
    path: 'ABYC E-13 for installation on boats, with the battery itself to IEC 62619 / UL 1973.',
    ref: 'ABYC E-13; IEC 62619; UL 1973'
  }
};

function ruleCertificationPath(ctx) {
  const { usage, pack } = ctx;
  const app = usage && usage.application ? String(usage.application) : null;
  const entry = app && APP_CERT_PATHS[app] ? APP_CERT_PATHS[app] : null;

  if (entry) {
    return finding(
      'certification-path', 'info', 'application',
      'Certification path: ' + entry.label,
      'For a ' + entry.label + ' application, the usual certification route is: ' + entry.path +
      ' UN 38.3 applies for transport in every case. Which standard is mandatory depends on the market and ' +
      'the authority having jurisdiction.',
      entry.ref
    );
  }

  // Infer coarsely from pack numbers.
  let inferred;
  let ref;
  const wh = isNum(pack.energyWh) ? pack.energyWh : 0;
  const kg = isNum(pack.massKg) ? pack.massKg : 0;
  const v = isNum(pack.vMax) ? pack.vMax : 0;
  if (wh <= 100 && kg < 18) {
    inferred = 'a portable-class pack, pointing to IEC 62133-2';
    ref = 'IEC 62133-2';
  } else if (v > 60) {
    inferred = 'a high-voltage traction or storage pack, pointing to UL 2580 / ISO 6469-3 / ECE R100 (vehicle) or IEC 62619 + UL 1973/UL 9540 (stationary)';
    ref = 'UL 2580; ISO 6469-3; ECE R100; IEC 62619';
  } else if (wh > 2000) {
    inferred = 'a stationary or industrial energy pack, pointing to IEC 62619 with UL 1973 / UL 9540 at product/system level';
    ref = 'IEC 62619; UL 1973; UL 9540';
  } else {
    inferred = 'a light-EV or industrial class pack, pointing to UL 2271 / EN 50604-1 (light EV) or IEC 62619 (industrial)';
    ref = 'UL 2271; EN 50604-1; IEC 62619';
  }
  return finding(
    'certification-path', 'info', 'application',
    'Certification path (inferred)',
    'No application was specified. From ' + fmt(wh, 0) + ' Wh, ' + fmt(kg) + ' kg and ' + fmt(v) +
    ' V max, this looks like ' + inferred + '. UN 38.3 applies for transport in every case; select an ' +
    'application in the designer for a more specific path.',
    ref
  );
}

// 14. Mass handling
function ruleMassHandling(ctx) {
  const { pack } = ctx;
  if (!isNum(pack.massKg)) return null;
  if (pack.massKg > 400) {
    return finding(
      'mass-handling', 'info', 'mechanical',
      'Heavy pack — mechanical handling and system-level rules',
      'At ' + fmt(pack.massKg, 0) + ' kg, this pack requires mechanical handling equipment for any movement. ' +
      'At this scale a stationary installation is treated as an energy storage system: UL 9540 system-level ' +
      'requirements, installation-code separation distances and, typically, UL 9540A fire test data apply.',
      'UL 9540; NIOSH lifting guideline'
    );
  }
  if (pack.massKg > 23) {
    return finding(
      'mass-handling', 'info', 'mechanical',
      'Two-person lift or mechanical handling',
      'At ' + fmt(pack.massKg) + ' kg, the pack exceeds the ~23 kg (51 lb) single-person limit of the NIOSH ' +
      'lifting guideline. Plan for two-person lifting or mechanical assistance, and provide handles or lift ' +
      'points sized for the load.',
      'NIOSH lifting guideline'
    );
  }
  return finding(
    'mass-handling', 'pass', 'mechanical',
    'Single-person handling',
    'At ' + fmt(pack.massKg) + ' kg, the pack is within the ~23 kg single-person lifting guideline under ' +
    'good conditions.',
    'NIOSH lifting guideline'
  );
}

// 15. Cell count sanity
function ruleCellCount(ctx) {
  const { pack } = ctx;
  if (!isNum(pack.cellCount)) return null;
  if (pack.cellCount > 500) {
    return finding(
      'cell-count', 'info', 'mechanical',
      'Very large cell count — subdivide into modules',
      'With ' + pack.cellCount + ' cells, a monolithic pack becomes hard to build, inspect and protect. ' +
      'Industry practice is to subdivide into modules with module-level BMS boards, fusing and contactors, so a ' +
      'fault can be isolated to one module and modules can be tested and replaced individually.',
      'IEC 62619; UL 2580'
    );
  }
  return finding(
    'cell-count', 'pass', 'mechanical',
    'Cell count manageable',
    'With ' + pack.cellCount + ' cells, the pack is within a range that can reasonably be built and monitored ' +
    'as a single unit with one BMS.',
    'IEC 62619'
  );
}

const RULES = [
  ruleContinuousCurrent,
  rulePeakCurrent,
  ruleChargeRate,
  ruleBms,
  ruleParallelFusing,
  ruleShortCircuit,
  ruleVoltageClass,
  ruleCreepage,
  ruleCellSpacing,
  ruleTempEnvelope,
  rulePackTransport,
  ruleCellTransport,
  ruleUn383,
  ruleCertificationPath,
  ruleMassHandling,
  ruleCellCount
];

/**
 * Run every rule against the design context and return findings ordered
 * fail -> warn -> pass -> info (stable within each severity).
 * @param {object} ctx design context (see module docs / input contract)
 * @returns {Array<object>} findings
 */
export function runChecks(ctx) {
  if (!ctx || !ctx.cell || !ctx.pack) return [];
  const findings = [];
  for (const rule of RULES) {
    let out = null;
    try {
      out = rule(ctx);
    } catch (e) {
      // A malformed field should not take down the whole audit.
      continue;
    }
    if (!out) continue;
    if (Array.isArray(out)) {
      for (const f of out) if (f) findings.push(f);
    } else {
      findings.push(out);
    }
  }
  return findings.sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
  );
}
