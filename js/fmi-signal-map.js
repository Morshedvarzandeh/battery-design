// fmi-signal-map.js — one immutable definition of the FMI 2.0 scalar ABI.
//
// Keep this module browser-safe: the browser preview, desktop runner, CLI and
// release builder all consume the same ordered contract. Existing value
// references are an external ABI and must never be renumbered; new variables
// may only be appended.

import { semanticDigest } from './ontology.js';

export const FMI_IO_CONTRACT_FORMAT = 'battery-design/fmi-io-contract@1';
export const FMI_IO_CONTRACT_VERSION = '1.0.0';

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

// Base-unit attributes use FMI 2.0's names and conversion semantics. The
// percent display unit is intentionally attached to the dimensionless unit:
// DisplayUnit_value = factor * Unit_value + offset, so 0.5 is displayed as 50.
export const FMI_UNIT_DEFINITIONS = deepFreeze([
  { name: 'A', baseUnit: { A: 1 }, displayUnits: [] },
  { name: 'V', baseUnit: { kg: 1, m: 2, s: -3, A: -1 }, displayUnits: [] },
  { name: 'W', baseUnit: { kg: 1, m: 2, s: -3 }, displayUnits: [] },
  { name: 'degC', baseUnit: { K: 1, offset: 273.15 }, displayUnits: [] },
  { name: 'kg/s', baseUnit: { kg: 1, s: -1 }, displayUnits: [] },
  { name: 's', baseUnit: { s: 1 }, displayUnits: [] },
  { name: '1', baseUnit: {}, displayUnits: [{ name: '%', factor: 100, offset: 0 }] },
  { name: 'A.h', baseUnit: { s: 1, A: 1, factor: 3600 }, displayUnits: [] },
  { name: 'mOhm', baseUnit: { kg: 1, m: 2, s: -3, A: -2, factor: 0.001 }, displayUnits: [] },
  { name: 'J/mol', baseUnit: { kg: 1, m: 2, s: -2, mol: -1 }, displayUnits: [] },
  { name: 'J/(kg.K)', baseUnit: { m: 2, s: -2, K: -1 }, displayUnits: [] },
  { name: 'kg', baseUnit: { kg: 1 }, displayUnits: [] },
  { name: 'W/K', baseUnit: { kg: 1, m: 2, s: -3, K: -1 }, displayUnits: [] },
  { name: 'V/K', baseUnit: { kg: 1, m: 2, s: -3, A: -1, K: -1 }, displayUnits: [] },
]);

const PARAMETER_UPDATE = 'Master-settable during instantiation or initialization; fixed after initialization.';
const INPUT_UPDATE = 'Written by the co-simulation master before a communication step and held over that step.';
const OUTPUT_UPDATE = 'Read-only; recalculated on reset, initialization exit, and each successful communication step.';

// Fixed-parameter starts are design-dependent, hence null here and resolved by
// materializeFmiIoMap(). Calculated outputs have no start: their values depend
// on the resolved parameters, inputs and state initialization.
export const FMI_IO_CONTRACT = deepFreeze([
  {
    role: 'battery.pack.seriesCount',
    name: 'cells_series', valueReference: 1, type: 'Real',
    cSymbol: 'VR_S', cField: 's', cDefaultMacro: 'DEFAULT_S',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: '1', displayUnit: null, quantity: 'count', start: null, startPolicy: 'resolved',
    min: 1, nominal: 1,
    description: 'Number of cells connected in series in the exported pack.',
    sourceBinding: 'design.pack.s',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive integer count; the value has no signed direction.',
  },
  {
    role: 'battery.pack.parallelCount',
    name: 'cells_parallel', valueReference: 2, type: 'Real',
    cSymbol: 'VR_P', cField: 'p', cDefaultMacro: 'DEFAULT_P',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: '1', displayUnit: null, quantity: 'count', start: null, startPolicy: 'resolved',
    min: 1, nominal: 1,
    description: 'Number of cells connected in parallel in the exported pack.',
    sourceBinding: 'design.pack.p',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive integer count; the value has no signed direction.',
  },
  {
    role: 'battery.cell.ratedCapacity',
    name: 'capacity_Ah', valueReference: 3, type: 'Real',
    cSymbol: 'VR_CAP', cField: 'capAh', cDefaultMacro: 'DEFAULT_CAP_AH',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'A.h', displayUnit: null, quantity: 'electricCharge', start: null, startPolicy: 'resolved',
    exclusiveMinimum: 0, nominal: 1,
    description: 'Rated capacity of one cell; pack capacity is this value times cells_parallel.',
    sourceBinding: 'design.cell.capacityAh',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive magnitude; zero or negative capacity is outside the physical contract.',
  },
  {
    role: 'battery.cell.ocvMinimum',
    name: 'ocv_min', valueReference: 4, type: 'Real',
    cSymbol: 'VR_OCVMIN', cField: 'ocvMin', cDefaultMacro: 'DEFAULT_OCV_MIN',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'V', displayUnit: null, quantity: 'electricPotential', start: null, startPolicy: 'resolved',
    exclusiveMinimum: 0, nominal: 1,
    description: 'Cell open-circuit voltage at zero state of charge.',
    sourceBinding: 'design.cell.vMin',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive cell potential in the pack discharge polarity.',
  },
  {
    role: 'battery.cell.ocvMaximum',
    name: 'ocv_max', valueReference: 5, type: 'Real',
    cSymbol: 'VR_OCVMAX', cField: 'ocvMax', cDefaultMacro: 'DEFAULT_OCV_MAX',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'V', displayUnit: null, quantity: 'electricPotential', start: null, startPolicy: 'resolved',
    exclusiveMinimum: 0, greaterThan: 'ocv_min', nominal: 1,
    description: 'Cell open-circuit voltage at full state of charge.',
    sourceBinding: 'design.cell.vMax',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive cell potential in the pack discharge polarity.',
  },
  {
    role: 'battery.cell.ohmicResistanceReference',
    name: 'r0_mOhm', valueReference: 6, type: 'Real',
    cSymbol: 'VR_R0', cField: 'r0', cDefaultMacro: 'DEFAULT_R0_MOHM',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'mOhm', displayUnit: null, quantity: 'electricResistance', start: null, startPolicy: 'resolved',
    min: 0, nominal: 1,
    description: 'Cell ohmic series resistance at the reference temperature.',
    sourceBinding: 'simulation.params.r0Ref',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Non-negative resistance magnitude.',
  },
  {
    role: 'battery.cell.rcBranchResistance',
    name: 'rc1_mOhm', valueReference: 7, type: 'Real',
    cSymbol: 'VR_RC1', cField: 'rc1', cDefaultMacro: 'DEFAULT_R1_MOHM',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'mOhm', displayUnit: null, quantity: 'electricResistance', start: null, startPolicy: 'resolved',
    min: 0, nominal: 1,
    description: 'Cell resistance of the reduced model first RC polarization branch.',
    sourceBinding: 'simulation.params.rc1R',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Non-negative resistance magnitude.',
  },
  {
    role: 'battery.cell.rcBranchTimeConstant',
    name: 'rc1_tau_s', valueReference: 8, type: 'Real',
    cSymbol: 'VR_TAU', cField: 'tau', cDefaultMacro: 'DEFAULT_TAU_S',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 's', displayUnit: null, quantity: 'time', start: null, startPolicy: 'resolved',
    exclusiveMinimum: 0, nominal: 1,
    description: 'Time constant of the reduced model first RC polarization branch.',
    sourceBinding: 'simulation.params.rc1TauS',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive duration; zero is outside the physical contract.',
  },
  {
    role: 'battery.cell.resistanceActivationEnergy',
    name: 'r0_Ea_J', valueReference: 9, type: 'Real',
    cSymbol: 'VR_EA', cField: 'ea', cDefaultMacro: 'DEFAULT_EA_J',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'J/mol', displayUnit: null, quantity: 'molarEnergy', start: null, startPolicy: 'resolved',
    min: 0, nominal: 1,
    description: 'Activation energy used by the Arrhenius resistance-temperature relation.',
    sourceBinding: 'simulation.params.r0EaJ',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Non-negative activation-energy magnitude.',
  },
  {
    role: 'battery.cell.specificHeatCapacity',
    name: 'cp_cell', valueReference: 10, type: 'Real',
    cSymbol: 'VR_CP', cField: 'cp', cDefaultMacro: 'DEFAULT_CP',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'J/(kg.K)', displayUnit: null, quantity: 'specificHeatCapacity', start: null, startPolicy: 'resolved',
    exclusiveMinimum: 0, nominal: 1,
    description: 'Specific heat capacity of one cell used by the lumped thermal node.',
    sourceBinding: 'simulation.params.cpCellJkgK',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive material-property magnitude; zero is outside the physical contract.',
  },
  {
    role: 'battery.cell.mass',
    name: 'mass_cell_kg', valueReference: 11, type: 'Real',
    cSymbol: 'VR_MASS', cField: 'massCell', cDefaultMacro: 'DEFAULT_MASS_KG',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'kg', displayUnit: null, quantity: 'mass', start: null, startPolicy: 'resolved',
    exclusiveMinimum: 0, nominal: 1,
    description: 'Mass of one cell used to derive the lumped pack heat capacity.',
    sourceBinding: 'design.cell.massG / 1000',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Positive mass magnitude; zero is outside the physical contract.',
  },
  {
    role: 'battery.thermal.coolantConductance',
    name: 'h_cool_WK', valueReference: 12, type: 'Real',
    cSymbol: 'VR_HCOOL', cField: 'hCool', cDefaultMacro: 'DEFAULT_HCOOL',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'W/K', displayUnit: null, quantity: 'thermalConductance', start: null, startPolicy: 'resolved',
    min: 0, nominal: 1,
    description: 'hCoolWK applied as total pack-to-coolant conductance in the current single-node reduction; it is not multiplied by module count.',
    sourceBinding: 'simulation.params.hCoolWK (direct reduced-model value)',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Non-negative heat-transfer conductance.',
  },
  {
    role: 'battery.thermal.ambientConductance',
    name: 'ua_amb_WK', valueReference: 13, type: 'Real',
    cSymbol: 'VR_UAAMB', cField: 'uaAmb', cDefaultMacro: 'DEFAULT_UA_AMB',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'W/K', displayUnit: null, quantity: 'thermalConductance', start: null, startPolicy: 'resolved',
    min: 0, nominal: 1,
    description: 'Pack-to-ambient conductance used by the lumped thermal node.',
    sourceBinding: 'simulation.params.uaAmbWK',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Non-negative heat-transfer conductance.',
  },
  {
    role: 'battery.cell.entropicVoltageCoefficient',
    name: 'entropy_VK', valueReference: 14, type: 'Real',
    cSymbol: 'VR_ENTROPY', cField: 'entropy', cDefaultMacro: 'DEFAULT_ENTROPY',
    causality: 'parameter', variability: 'fixed', initial: 'exact',
    unit: 'V/K', displayUnit: null, quantity: 'temperatureCoefficientOfVoltage', start: null, startPolicy: 'resolved',
    nominal: 0.001,
    description: 'Cell open-circuit-voltage temperature coefficient dU/dT for reversible heat.',
    sourceBinding: 'simulation.params.entropyVK',
    updateSemantics: PARAMETER_UPDATE,
    signConvention: 'Signed dU/dT; its sign controls the reversible heating term for a given current direction.',
  },
  {
    role: 'battery.pack.terminalCurrent',
    name: 'I_pack', valueReference: 15, type: 'Real',
    cSymbol: 'VR_I', cField: 'iPack', cDefaultMacro: null,
    causality: 'input', variability: 'continuous', initial: null,
    unit: 'A', displayUnit: null, quantity: 'electricCurrent', start: 0, startPolicy: 'declared',
    nominal: 1,
    description: 'Pack terminal current supplied by the host model.',
    sourceBinding: 'fmi.master.inputs.I_pack',
    updateSemantics: INPUT_UPDATE,
    signConvention: 'Positive current discharges the pack and leaves its positive terminal; negative current charges it.',
  },
  {
    role: 'battery.environment.ambientTemperature',
    name: 'T_ambient', valueReference: 16, type: 'Real',
    cSymbol: 'VR_TAMB', cField: 'tAmb', cDefaultMacro: null,
    causality: 'input', variability: 'continuous', initial: null,
    unit: 'degC', displayUnit: null, quantity: 'thermodynamicTemperature', start: 25, startPolicy: 'declared',
    nominal: 25,
    description: 'Ambient temperature; the current reduced model also uses it as the coolant inlet reference.',
    sourceBinding: 'fmi.master.inputs.T_ambient',
    updateSemantics: INPUT_UPDATE,
    signConvention: 'Signed Celsius value; conversion to absolute temperature is internal to the model.',
  },
  {
    role: 'battery.coolant.massFlow',
    name: 'coolant_flow', valueReference: 17, type: 'Real',
    cSymbol: 'VR_FLOW', cField: 'flow', cDefaultMacro: null,
    causality: 'input', variability: 'continuous', initial: null,
    unit: 'kg/s', displayUnit: null, quantity: 'massFlowRate', start: 0.05, startPolicy: 'declared',
    min: 0, nominal: 0.05,
    description: 'Coolant mass flow through the reduced thermal boundary; zero disables coolant heat removal.',
    sourceBinding: 'fmi.master.inputs.coolant_flow',
    updateSemantics: INPUT_UPDATE,
    signConvention: 'Non-negative forward mass-flow magnitude; reverse flow is not represented.',
  },
  {
    role: 'battery.pack.terminalVoltage',
    name: 'V_pack', valueReference: 18, type: 'Real',
    cSymbol: 'VR_V', cField: 'vPack', cDefaultMacro: null,
    causality: 'output', variability: 'continuous', initial: 'calculated',
    unit: 'V', displayUnit: null, quantity: 'electricPotential', start: null, startPolicy: 'calculated',
    nominal: 1,
    description: 'Pack terminal voltage under the applied current and current reduced-model state.',
    sourceBinding: 'fmu.runtime.outputs.vPack',
    updateSemantics: OUTPUT_UPDATE,
    signConvention: 'Positive from the pack negative terminal to its positive terminal.',
  },
  {
    role: 'battery.pack.stateOfCharge',
    name: 'SoC', valueReference: 19, type: 'Real',
    cSymbol: 'VR_SOC', cField: 'soc', cDefaultMacro: null,
    causality: 'output', variability: 'continuous', initial: 'calculated',
    unit: '1', displayUnit: '%', quantity: 'stateOfCharge', start: null, startPolicy: 'calculated',
    min: 0, max: 1, nominal: 1,
    description: 'Pack state of charge as a fraction from empty (0) to full (1).',
    sourceBinding: 'fmu.runtime.state.soc',
    updateSemantics: OUTPUT_UPDATE,
    signConvention: 'Dimensionless fraction; discharge current decreases it and charge current increases it.',
  },
  {
    role: 'battery.cell.representativeTemperature',
    name: 'T_cell', valueReference: 20, type: 'Real',
    cSymbol: 'VR_TCELL', cField: 'tCell', cDefaultMacro: null,
    causality: 'output', variability: 'continuous', initial: 'calculated',
    unit: 'degC', displayUnit: null, quantity: 'thermodynamicTemperature', start: null, startPolicy: 'calculated',
    nominal: 25,
    description: 'Representative temperature of the single lumped cell node.',
    sourceBinding: 'fmu.runtime.state.tCell',
    updateSemantics: OUTPUT_UPDATE,
    signConvention: 'Signed Celsius value; conversion to absolute temperature is internal to the model.',
  },
  {
    role: 'battery.pack.netInternalHeatSource',
    name: 'Q_loss', valueReference: 21, type: 'Real',
    cSymbol: 'VR_QLOSS', cField: 'qLoss', cDefaultMacro: null,
    causality: 'output', variability: 'continuous', initial: 'calculated',
    unit: 'W', displayUnit: null, quantity: 'power', start: null, startPolicy: 'calculated',
    nominal: 1,
    description: 'Net internal pack heat source: irreversible losses plus signed reversible entropic heat.',
    sourceBinding: 'fmu.runtime.outputs.qLoss',
    updateSemantics: OUTPUT_UPDATE,
    signConvention: 'Positive heats the lumped cell node; reversible heat can make the net value negative.',
  },
  {
    role: 'battery.cell.uniformTerminalVoltageEstimate',
    name: 'V_cell_min', valueReference: 22, type: 'Real',
    cSymbol: 'VR_VCELLMIN', cField: 'vCellMin', cDefaultMacro: null,
    causality: 'output', variability: 'continuous', initial: 'calculated',
    unit: 'V', displayUnit: null, quantity: 'electricPotential', start: null, startPolicy: 'calculated',
    nominal: 1,
    description: 'Uniform-cell terminal-voltage estimate V_pack/cells_series; not a resolved cell minimum.',
    sourceBinding: 'fmu.runtime.outputs.vCellMin',
    updateSemantics: OUTPUT_UPDATE,
    signConvention: 'Positive in the pack discharge polarity; follows the sign of V_pack.',
  },
  {
    role: 'battery.pack.terminalPower',
    name: 'P_terminal', valueReference: 23, type: 'Real',
    cSymbol: 'VR_PTERM', cField: 'pTerm', cDefaultMacro: null,
    causality: 'output', variability: 'continuous', initial: 'calculated',
    unit: 'W', displayUnit: null, quantity: 'power', start: null, startPolicy: 'calculated',
    nominal: 1,
    description: 'Electrical terminal power V_pack multiplied by I_pack.',
    sourceBinding: 'fmu.runtime.outputs.pTerm',
    updateSemantics: OUTPUT_UPDATE,
    signConvention: 'Positive is power delivered by the pack on discharge; negative is power absorbed on charge.',
  },
]);

export const FMI_IO_CONTRACT_CHECKSUM = semanticDigest({
  format: FMI_IO_CONTRACT_FORMAT,
  version: FMI_IO_CONTRACT_VERSION,
  fmiVersion: '2.0',
  unitDefinitions: FMI_UNIT_DEFINITIONS,
  variables: FMI_IO_CONTRACT,
});

// Compatibility views retain the public shape previously exported by fmi.js.
// They are projections of the canonical descriptors, never a second contract.
export const FMU_PARAMETERS = deepFreeze(FMI_IO_CONTRACT
  .filter(({ causality }) => causality === 'parameter')
  .map(({ name, unit, description }) => ({ name, unit, description })));

export const FMU_VARIABLES = deepFreeze(FMI_IO_CONTRACT
  .filter(({ causality }) => causality !== 'parameter')
  .map(({ name, causality, unit, start, description }) => ({
    name, causality, unit, start, description,
  })));

function presentString(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

/**
 * Resolve design-specific fixed starts into a JSON-safe, immutable I/O map.
 * The returned descriptors preserve canonical order, resolve finite parameter
 * starts, retain declared input starts, and omit starts for calculated outputs.
 */
export function materializeFmiIoMap({
  parameterValues,
  modelName = 'BatteryPack',
  modelRevision = null,
  guid = null,
  fmiStandardVersion = '2.0.5',
} = {}) {
  if (!parameterValues || typeof parameterValues !== 'object' || Array.isArray(parameterValues)) {
    throw new TypeError('FMI I/O map requires a parameterValues object.');
  }
  const resolved = FMI_IO_CONTRACT.map((variable) => {
    if (variable.causality === 'output') {
      const { start: _calculatedStart, ...hostContract } = variable;
      return hostContract;
    }
    if (variable.causality !== 'parameter') return { ...variable };
    if (!Object.prototype.hasOwnProperty.call(parameterValues, variable.name)) {
      throw new TypeError(`Missing FMI parameter start: ${variable.name}`);
    }
    const start = parameterValues[variable.name];
    if (typeof start !== 'number' || !Number.isFinite(start)) {
      throw new TypeError(`FMI parameter start must be finite: ${variable.name}`);
    }
    if (variable.min != null && start < variable.min) {
      throw new RangeError(`FMI parameter start is below its minimum: ${variable.name}`);
    }
    if (variable.max != null && start > variable.max) {
      throw new RangeError(`FMI parameter start is above its maximum: ${variable.name}`);
    }
    if (variable.exclusiveMinimum != null && start <= variable.exclusiveMinimum) {
      throw new RangeError(`FMI parameter start must exceed its exclusive minimum: ${variable.name}`);
    }
    if (variable.greaterThan && !(start > parameterValues[variable.greaterThan])) {
      throw new RangeError(`FMI parameter start must exceed ${variable.greaterThan}: ${variable.name}`);
    }
    return { ...variable, start };
  });
  return deepFreeze({
    format: FMI_IO_CONTRACT_FORMAT,
    version: FMI_IO_CONTRACT_VERSION,
    fmiVersion: '2.0',
    fmiStandardPatch: presentString(fmiStandardVersion, 'FMI standard version'),
    contractChecksum: FMI_IO_CONTRACT_CHECKSUM,
    modelName: presentString(modelName, 'FMI modelName'),
    modelIdentifier: presentString(modelName, 'FMI modelIdentifier'),
    modelRevision: presentString(modelRevision, 'FMI modelRevision', { nullable: true }),
    guid: presentString(guid, 'FMI guid', { nullable: true }),
    unitDefinitions: FMI_UNIT_DEFINITIONS,
    variables: resolved,
  });
}
