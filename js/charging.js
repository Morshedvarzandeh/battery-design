// charging.js — the AC side of the battery system, round one: how THIS
// application charges. The charging architecture differs by class and the
// tool says so instead of bolting an "on-board charger" onto everything:
//   · vehicles / RVs          → a real on-board charger (or DC depot gear)
//   · vessels                 → a project-specific shore connection; never
//                               silently reuse an automotive plug/OBC class
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

export const MARINE_SHORE_INTERFACE = Object.freeze({
  connector: 'Project-specific marine shore connection — supplier, port and class evidence required',
  dcConnector: 'No automotive CCS assumption; declare the vessel-side AC or DC interface',
  comms: 'Declare shore-connection control, interlocks, earthing/isolation and emergency-disconnect contract',
});

// A declared power and the power reconstructed from voltage/current must
// agree within this relative tolerance. This is a data-consistency screen,
// not a connector or installation rating.
export const MARINE_SHORE_POWER_TOLERANCE = 0.05;

const AUTOMOTIVE_CONNECTOR_PATTERN = /(type\s*2|j1772|ccs|combo\s*[12]|nacs|j3400|gb\s*\/?\s*t\s*20234|chademo)/i;
const missing = (value) => value === null || value === undefined || value === '';
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const cleanText = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

function shoreDiagnostic(code, severity, field, detail, action) {
  return { code, severity, field, detail, action };
}

function shoreStatus(diagnostics) {
  return diagnostics.some((item) => item.severity === 'fail')
    ? 'fail'
    : diagnostics.some((item) => item.severity === 'review') ? 'review' : 'pass';
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validate one project- or supplier-declared marine shore connection.
 *
 * Contract shape (all fields are required unless AC-only is noted):
 * {
 *   mode: 'ac' | 'dc', voltageV, ratedPowerKW, ratedCurrentA, efficiency,
 *   phases, frequencyHz, powerFactor, // AC only
 *   outputVoltageMinV, outputVoltageMaxV,
 *   connector: { id, name },
 *   earthing: { declared: true, scheme },
 *   isolation: { declared: true, method },
 *   interlock: { declared: true, description },
 *   emergencyDisconnect: { declared: true, description },
 *   evidence: { kind: 'supplier' | 'project', source, revision, date }
 * }
 *
 * No connector, voltage, power or standard is inferred here. Invalid caller
 * values are never echoed as NaN/Infinity in the result.
 */
export function evaluateMarineShoreConnection({ shoreConnection = null, vNomV, packChargeKW } = {}) {
  const diagnostics = [];
  const supplied = shoreConnection && typeof shoreConnection === 'object' && !Array.isArray(shoreConnection);
  const input = supplied ? shoreConnection : {};
  const normalized = {
    mode: null,
    voltageV: null,
    phases: null,
    frequencyHz: null,
    powerFactor: null,
    ratedPowerKW: null,
    ratedCurrentA: null,
    efficiency: null,
    outputVoltageMinV: null,
    outputVoltageMaxV: null,
    connector: { id: null, name: null },
    earthing: { declared: false, scheme: null },
    isolation: { declared: false, method: null },
    interlock: { declared: false, description: null },
    emergencyDisconnect: { declared: false, description: null },
    evidence: { kind: null, source: null, revision: null, date: null },
  };

  if (!supplied) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_CONNECTION_REQUIRED', 'review', 'shoreConnection',
      'No governed marine shore-connection contract was supplied, so turnaround time is unproven.',
      'Enter the actual vessel/port equipment contract and its supplier or project evidence.',
    ));
  }

  const modeText = cleanText(input.mode)?.toLowerCase() || null;
  if (!modeText) {
    if (supplied) diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_MODE_REQUIRED', 'review', 'mode',
      'Declare whether the shore equipment supplies AC or DC.',
      "Set mode to 'ac' or 'dc' from the project equipment evidence.",
    ));
  } else if (!['ac', 'dc'].includes(modeText)) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_MODE_INVALID', 'fail', 'mode',
      `The declared shore mode ${JSON.stringify(modeText)} is not AC or DC.`,
      "Use the evidenced value 'ac' or 'dc'.",
    ));
  } else {
    normalized.mode = modeText;
  }

  const positiveField = (field, codeStem) => {
    const raw = input[field];
    if (missing(raw)) {
      if (supplied) diagnostics.push(shoreDiagnostic(
        `MARINE_SHORE_${codeStem}_REQUIRED`, 'review', field,
        `${field} is required by the shore-connection contract.`,
        `Enter ${field} from the supplier or project evidence.`,
      ));
      return null;
    }
    if (!finiteNumber(raw) || raw <= 0) {
      diagnostics.push(shoreDiagnostic(
        `MARINE_SHORE_${codeStem}_INVALID`, 'fail', field,
        `${field} must be a finite number greater than zero.`,
        `Correct ${field} using the evidenced equipment rating.`,
      ));
      return null;
    }
    return raw;
  };

  normalized.voltageV = positiveField('voltageV', 'VOLTAGE');
  normalized.ratedPowerKW = positiveField('ratedPowerKW', 'RATED_POWER');
  normalized.ratedCurrentA = positiveField('ratedCurrentA', 'RATED_CURRENT');
  normalized.outputVoltageMinV = positiveField('outputVoltageMinV', 'OUTPUT_VOLTAGE_MIN');
  normalized.outputVoltageMaxV = positiveField('outputVoltageMaxV', 'OUTPUT_VOLTAGE_MAX');

  if (missing(input.efficiency)) {
    if (supplied) diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_EFFICIENCY_REQUIRED', 'review', 'efficiency',
      'End-to-pack conversion efficiency is required; it is not inferred from equipment type.',
      'Enter the evidenced efficiency as a fraction greater than zero and no greater than one.',
    ));
  } else if (!finiteNumber(input.efficiency) || input.efficiency <= 0 || input.efficiency > 1) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_EFFICIENCY_INVALID', 'fail', 'efficiency',
      'Efficiency must be a finite fraction greater than zero and no greater than one.',
      'Correct the end-to-pack efficiency from equipment evidence.',
    ));
  } else {
    normalized.efficiency = input.efficiency;
  }

  if (normalized.mode === 'ac') {
    if (missing(input.phases)) {
      diagnostics.push(shoreDiagnostic(
        'MARINE_SHORE_PHASES_REQUIRED', 'review', 'phases',
        'AC phase count is required.', 'Enter the evidenced AC phase count (one or three).',
      ));
    } else if (!Number.isInteger(input.phases) || ![1, 3].includes(input.phases)) {
      diagnostics.push(shoreDiagnostic(
        'MARINE_SHORE_PHASES_INVALID', 'fail', 'phases',
        'AC phase count must be the integer 1 or 3.', 'Correct the phase count from the shore equipment evidence.',
      ));
    } else {
      normalized.phases = input.phases;
    }
    normalized.frequencyHz = positiveField('frequencyHz', 'FREQUENCY');
    if (missing(input.powerFactor)) {
      diagnostics.push(shoreDiagnostic(
        'MARINE_SHORE_POWER_FACTOR_REQUIRED', 'review', 'powerFactor',
        'AC power factor is required to reconcile rated voltage, current and real power.',
        'Enter the equipment power factor as a fraction greater than zero and no greater than one.',
      ));
    } else if (!finiteNumber(input.powerFactor) || input.powerFactor <= 0 || input.powerFactor > 1) {
      diagnostics.push(shoreDiagnostic(
        'MARINE_SHORE_POWER_FACTOR_INVALID', 'fail', 'powerFactor',
        'AC power factor must be a finite fraction greater than zero and no greater than one.',
        'Correct powerFactor from the equipment evidence.',
      ));
    } else {
      normalized.powerFactor = input.powerFactor;
    }
  } else if (normalized.mode === 'dc') {
    const acOnly = ['phases', 'frequencyHz', 'powerFactor'].filter((field) => !missing(input[field]));
    if (acOnly.length) diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_DC_AC_FIELDS_INCOMPATIBLE', 'fail', acOnly.join(','),
      `DC mode cannot carry the AC-only field(s): ${acOnly.join(', ')}.`,
      'Remove AC-only fields or correct the declared mode.',
    ));
  }

  if (normalized.outputVoltageMinV != null && normalized.outputVoltageMaxV != null
    && normalized.outputVoltageMinV > normalized.outputVoltageMaxV) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_OUTPUT_RANGE_INVALID', 'fail', 'outputVoltageMinV,outputVoltageMaxV',
      'The declared minimum charger output voltage exceeds its maximum.',
      'Correct the evidenced charger output-voltage range.',
    ));
  }

  if (!finiteNumber(vNomV) || vNomV <= 0) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_PACK_VOLTAGE_INVALID', 'fail', 'vNomV',
      'A finite positive pack nominal voltage is required for shore-equipment compatibility.',
      'Correct the battery design nominal voltage.',
    ));
  } else if (normalized.outputVoltageMinV != null && normalized.outputVoltageMaxV != null
    && normalized.outputVoltageMinV <= normalized.outputVoltageMaxV
    && (vNomV < normalized.outputVoltageMinV || vNomV > normalized.outputVoltageMaxV)) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_PACK_VOLTAGE_INCOMPATIBLE', 'fail', 'vNomV',
      `The ${vNomV} V nominal pack lies outside the declared ${normalized.outputVoltageMinV}–${normalized.outputVoltageMaxV} V charger output range.`,
      'Select compatible conversion equipment or correct the evidenced output-voltage range.',
    ));
  }

  const connector = input.connector && typeof input.connector === 'object' ? input.connector : {};
  normalized.connector.id = cleanText(connector.id);
  normalized.connector.name = cleanText(connector.name);
  for (const field of ['id', 'name']) {
    if (!normalized.connector[field] && supplied) diagnostics.push(shoreDiagnostic(
      `MARINE_SHORE_CONNECTOR_${field.toUpperCase()}_REQUIRED`, 'review', `connector.${field}`,
      `A project-specific connector ${field} is required; the software will not select one.`,
      `Enter connector.${field} from the vessel/port equipment record.`,
    ));
  }
  const connectorIdentity = `${normalized.connector.id || ''} ${normalized.connector.name || ''}`;
  if (connectorIdentity.trim() && AUTOMOTIVE_CONNECTOR_PATTERN.test(connectorIdentity)) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_AUTOMOTIVE_CONNECTOR_REFUSED', 'fail', 'connector',
      'An automotive charging connector identity cannot be accepted as a governed marine shore connection.',
      'Enter the actual non-automotive vessel/port connector identity and evidence.',
    ));
  }

  const declaration = (field, textField, label) => {
    const raw = input[field] && typeof input[field] === 'object' ? input[field] : {};
    const declaredPresent = Object.prototype.hasOwnProperty.call(raw, 'declared');
    const detail = cleanText(raw[textField]);
    normalized[field] = { declared: raw.declared === true, [textField]: detail };
    if (!declaredPresent) {
      if (supplied) diagnostics.push(shoreDiagnostic(
        `MARINE_SHORE_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}_DECLARATION_REQUIRED`,
        'review', `${field}.declared`, `${label} declaration is required.`,
        `Set ${field}.declared only after the project record confirms it.`,
      ));
    } else if (raw.declared !== true) {
      diagnostics.push(shoreDiagnostic(
        `MARINE_SHORE_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}_NOT_DECLARED`,
        'fail', `${field}.declared`, `${label} is explicitly not declared.`,
        `Resolve and document ${label.toLowerCase()} before calculating turnaround time.`,
      ));
    }
    if (!detail && supplied) diagnostics.push(shoreDiagnostic(
      `MARINE_SHORE_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}_DETAIL_REQUIRED`,
      'review', `${field}.${textField}`, `${label} method or implementation detail is required.`,
      `Enter ${field}.${textField} from project or supplier evidence.`,
    ));
  };
  declaration('earthing', 'scheme', 'Earthing');
  declaration('isolation', 'method', 'Isolation');
  declaration('interlock', 'description', 'Connection interlock');
  declaration('emergencyDisconnect', 'description', 'Emergency disconnect');

  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  normalized.evidence.kind = cleanText(evidence.kind)?.toLowerCase() || null;
  normalized.evidence.source = cleanText(evidence.source);
  normalized.evidence.revision = cleanText(evidence.revision);
  normalized.evidence.date = cleanText(evidence.date);
  if (!normalized.evidence.kind) {
    if (supplied) diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_EVIDENCE_KIND_REQUIRED', 'review', 'evidence.kind',
      'Evidence must identify whether its authority is the supplier or this vessel project.',
      "Set evidence.kind to 'supplier' or 'project'.",
    ));
  } else if (!['supplier', 'project'].includes(normalized.evidence.kind)) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_EVIDENCE_KIND_INVALID', 'fail', 'evidence.kind',
      'Evidence kind must be supplier or project.', "Use 'supplier' or 'project' and retain the source record.",
    ));
  }
  for (const field of ['source', 'revision', 'date']) {
    if (!normalized.evidence[field] && supplied) diagnostics.push(shoreDiagnostic(
      `MARINE_SHORE_EVIDENCE_${field.toUpperCase()}_REQUIRED`, 'review', `evidence.${field}`,
      `Evidence ${field} is required.`, `Enter evidence.${field} from the controlled source record.`,
    ));
  }
  if (normalized.evidence.date && !validCalendarDate(normalized.evidence.date)) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_EVIDENCE_DATE_INVALID', 'fail', 'evidence.date',
      'Evidence date must be a real calendar date in YYYY-MM-DD form.',
      'Correct the controlled-source date without substituting the current date.',
    ));
  }

  let currentDerivedPowerKW = null;
  const powerInputsComplete = normalized.mode === 'dc'
    ? normalized.voltageV != null && normalized.ratedCurrentA != null
    : normalized.mode === 'ac'
      && normalized.voltageV != null && normalized.ratedCurrentA != null
      && normalized.phases != null && normalized.powerFactor != null;
  if (normalized.voltageV != null && normalized.ratedCurrentA != null) {
    if (normalized.mode === 'dc') {
      const calculated = normalized.voltageV * normalized.ratedCurrentA / 1000;
      if (Number.isFinite(calculated)) currentDerivedPowerKW = calculated;
    } else if (normalized.mode === 'ac' && normalized.phases != null && normalized.powerFactor != null) {
      const phaseFactor = normalized.phases === 3 ? Math.sqrt(3) : 1;
      const calculated = phaseFactor * normalized.voltageV * normalized.ratedCurrentA * normalized.powerFactor / 1000;
      if (Number.isFinite(calculated)) currentDerivedPowerKW = calculated;
    }
  }
  let ratedPowerErrorPct = null;
  if (currentDerivedPowerKW == null && powerInputsComplete) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_POWER_CALCULATION_INVALID', 'fail', 'ratedPowerKW,ratedCurrentA',
      'The declared ratings overflow or cannot produce a finite electrical power check.',
      'Correct the equipment voltage, current, phase and power-factor ratings.',
    ));
  } else if (currentDerivedPowerKW != null && normalized.ratedPowerKW != null) {
    const error = Math.abs(currentDerivedPowerKW - normalized.ratedPowerKW)
      / normalized.ratedPowerKW * 100;
    if (!Number.isFinite(error)) {
      diagnostics.push(shoreDiagnostic(
        'MARINE_SHORE_POWER_CALCULATION_INVALID', 'fail', 'ratedPowerKW,ratedCurrentA',
        'The declared ratings cannot produce a finite power-consistency result.',
        'Correct the equipment voltage, current, phase, power-factor and power ratings.',
      ));
    } else {
      ratedPowerErrorPct = error;
      if (ratedPowerErrorPct > MARINE_SHORE_POWER_TOLERANCE * 100 + 1e-10) diagnostics.push(shoreDiagnostic(
        'MARINE_SHORE_POWER_CURRENT_MISMATCH', 'fail', 'ratedPowerKW,ratedCurrentA',
        `The voltage/current-derived power differs from ratedPowerKW by ${ratedPowerErrorPct.toFixed(2)}%, above the ${(MARINE_SHORE_POWER_TOLERANCE * 100).toFixed(0)}% consistency tolerance.`,
        'Reconcile the evidenced voltage, current, phase, power-factor and power ratings.',
      ));
    }
  }

  const packLimitKW = finiteNumber(packChargeKW) && packChargeKW > 0 ? packChargeKW : null;
  if (packLimitKW == null) diagnostics.push(shoreDiagnostic(
    'MARINE_SHORE_PACK_ACCEPTANCE_REQUIRED', 'review', 'packChargeKW',
    'A finite positive pack charge-acceptance limit is required before turnaround can be calculated.',
    'Complete the cell-derived pack charge-acceptance calculation.',
  ));

  const candidateShoreToPackKW = normalized.ratedPowerKW != null && normalized.efficiency != null
    ? normalized.ratedPowerKW * normalized.efficiency : null;
  if (candidateShoreToPackKW != null
    && (!Number.isFinite(candidateShoreToPackKW) || candidateShoreToPackKW <= 0
      || !Number.isFinite(1 / candidateShoreToPackKW)
      || !Number.isFinite(normalized.ratedPowerKW * 1000))) {
    diagnostics.push(shoreDiagnostic(
      'MARINE_SHORE_CONVERSION_POWER_INVALID', 'fail', 'ratedPowerKW,efficiency',
      'The declared power and efficiency do not produce a finite positive conversion-power result.',
      'Correct the evidenced rated power and efficiency.',
    ));
  }

  const status = shoreStatus(diagnostics);
  const shoreToPackKW = status === 'pass' ? candidateShoreToPackKW : null;
  const effectiveChargeKW = status === 'pass'
    ? Math.min(shoreToPackKW, packLimitKW) : null;
  return {
    status,
    complete: status === 'pass',
    compatible: status === 'pass',
    diagnostics,
    normalized,
    calculated: {
      currentDerivedPowerKW,
      ratedPowerErrorPct,
      ratedPowerTolerancePct: MARINE_SHORE_POWER_TOLERANCE * 100,
      shoreToPackKW,
      packChargeKW: packLimitKW,
      effectiveChargeKW,
      limitedBy: status === 'pass' ? (packLimitKW < shoreToPackKW ? 'pack' : 'source') : null,
    },
    sourceLabel: status === 'pass'
      ? `${normalized.connector.name} (${normalized.mode.toUpperCase()} shore equipment)` : null,
  };
}

// ---------------------------------------------------------------------------
// Charging architecture per application — the who-needs-what of the AC side.
// kind: 'obc' | 'shore' | 'external' | 'pcs' | 'dock' | 'host'
// ---------------------------------------------------------------------------
export const CHARGING_ARCH_BY_APP = {
  ev: { kind: 'obc', name: 'On-board charger (AC) + CCS/NACS DC fast charging', note: 'The OBC converts AC to pack DC on the vehicle; DC fast charging bypasses it entirely and is limited by the CELL, not the charger.' },
  ebus: { kind: 'obc', name: 'DC depot / pantograph charging; AC OBC optional', note: 'City buses charge from DC depot chargers or opportunity pantographs — many carry no AC OBC at all. Where one exists it is a low-power service/limp-home path.' },
  rv: { kind: 'obc', name: 'Shore-power inverter/charger', note: 'The RV house bank charges from campground AC through an inverter/charger (and from the alternator while driving).' },
  marine: { kind: 'shore', name: 'Marine shore-power connection and charger', note: 'No shore rating, connector or conversion equipment is inferred from the vessel model. Supply the actual port/vessel interface, charger rating, isolation/earthing design and class evidence before calculating turnaround time.' },
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
export function buildChargingPlan({
  appId, marketId, energyWh, vNomV, cell, obcOverride = 'auto', shoreConnection = null,
}) {
  const arch = chargingArchitectureFor(appId);
  const iface = appId === 'marine' ? MARINE_SHORE_INTERFACE : acInterfaceFor(marketId);
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
  // Cell charge acceptance is not a shore-source rating. Without declared
  // marine connection/charger equipment there is no honest turnaround time.
  const governedShore = arch.kind === 'shore'
    ? evaluateMarineShoreConnection({ shoreConnection, vNomV, packChargeKW }) : null;
  const sourceKW = arch.kind === 'shore'
    ? (governedShore.status === 'pass' ? governedShore.normalized.ratedPowerKW : null)
    : (obc ? obc.acKW : packChargeKW);
  const sourceLabel = arch.kind === 'shore'
    ? (governedShore.sourceLabel || 'unproven marine shore equipment')
    : (obc ? `${obc.acKW} kW OBC` : 'rated-current charger');
  const efficiency = arch.kind === 'shore'
    ? (governedShore.status === 'pass' ? governedShore.normalized.efficiency : null)
    : (obc ? OBC_EFFICIENCY : 1.0);
  const t2080 = sourceKW ? chargeTime({ energyWh, socFrom: 0.2, socTo: 0.8, sourceKW, sourceLabel, efficiency, packChargeKW }) : null;
  const t10100 = sourceKW ? chargeTime({ energyWh, socFrom: 0.1, socTo: 1.0, sourceKW, sourceLabel, efficiency, packChargeKW }) : null;

  return {
    arch, iface, strategies, obc,
    packChargeKW, chargeC,
    t2080, t10100,
    obcEfficiency: obc ? OBC_EFFICIENCY : null,
    ...(arch.kind === 'shore' ? { shoreConnection: governedShore } : {}),
    notes: [
      arch.note,
      ...(arch.kind === 'shore' && governedShore.status === 'pass'
        ? [`Turnaround uses the declared ${governedShore.normalized.ratedPowerKW} kW ${governedShore.normalized.mode.toUpperCase()} shore rating at ${(governedShore.normalized.efficiency * 100).toFixed(1)}% end-to-pack efficiency, limited by the smaller of source and cell-derived pack acceptance.`]
        : []),
      ...(arch.kind === 'obc' && packChargeKW != null
        ? [`DC fast charging bypasses the OBC entirely — but the ceiling stays the cell's own charge rating (${packChargeKW.toFixed(1)} kW pack-level, ${chargeC.toFixed(1)}C), and holding it needs the cooling system, not the charger, to keep up.`]
        : []),
    ],
  };
}
