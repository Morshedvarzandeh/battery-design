// Canonical FMI signal-map tests. This fixture is intentionally independent
// of the generator: changing a public name, value reference, start or C binding
// must be an explicit ABI decision rather than a positional side effect.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FMI_IO_CONTRACT,
  FMI_IO_CONTRACT_CHECKSUM,
  FMI_IO_CONTRACT_FORMAT,
  FMI_IO_CONTRACT_VERSION,
  FMI_UNIT_DEFINITIONS,
  FMU_PARAMETERS,
  FMU_VARIABLES,
  materializeFmiIoMap,
} from '../js/fmi-signal-map.js';

const ABI = [
  ['cells_series', 1, 'VR_S', 's', 'DEFAULT_S', 'parameter', 'fixed', 'exact', '1', null],
  ['cells_parallel', 2, 'VR_P', 'p', 'DEFAULT_P', 'parameter', 'fixed', 'exact', '1', null],
  ['capacity_Ah', 3, 'VR_CAP', 'capAh', 'DEFAULT_CAP_AH', 'parameter', 'fixed', 'exact', 'A.h', null],
  ['ocv_min', 4, 'VR_OCVMIN', 'ocvMin', 'DEFAULT_OCV_MIN', 'parameter', 'fixed', 'exact', 'V', null],
  ['ocv_max', 5, 'VR_OCVMAX', 'ocvMax', 'DEFAULT_OCV_MAX', 'parameter', 'fixed', 'exact', 'V', null],
  ['r0_mOhm', 6, 'VR_R0', 'r0', 'DEFAULT_R0_MOHM', 'parameter', 'fixed', 'exact', 'mOhm', null],
  ['rc1_mOhm', 7, 'VR_RC1', 'rc1', 'DEFAULT_R1_MOHM', 'parameter', 'fixed', 'exact', 'mOhm', null],
  ['rc1_tau_s', 8, 'VR_TAU', 'tau', 'DEFAULT_TAU_S', 'parameter', 'fixed', 'exact', 's', null],
  ['r0_Ea_J', 9, 'VR_EA', 'ea', 'DEFAULT_EA_J', 'parameter', 'fixed', 'exact', 'J/mol', null],
  ['cp_cell', 10, 'VR_CP', 'cp', 'DEFAULT_CP', 'parameter', 'fixed', 'exact', 'J/(kg.K)', null],
  ['mass_cell_kg', 11, 'VR_MASS', 'massCell', 'DEFAULT_MASS_KG', 'parameter', 'fixed', 'exact', 'kg', null],
  ['h_cool_WK', 12, 'VR_HCOOL', 'hCool', 'DEFAULT_HCOOL', 'parameter', 'fixed', 'exact', 'W/K', null],
  ['ua_amb_WK', 13, 'VR_UAAMB', 'uaAmb', 'DEFAULT_UA_AMB', 'parameter', 'fixed', 'exact', 'W/K', null],
  ['entropy_VK', 14, 'VR_ENTROPY', 'entropy', 'DEFAULT_ENTROPY', 'parameter', 'fixed', 'exact', 'V/K', null],
  ['I_pack', 15, 'VR_I', 'iPack', null, 'input', 'continuous', null, 'A', 0],
  ['T_ambient', 16, 'VR_TAMB', 'tAmb', null, 'input', 'continuous', null, 'degC', 25],
  ['coolant_flow', 17, 'VR_FLOW', 'flow', null, 'input', 'continuous', null, 'kg/s', 0.05],
  ['V_pack', 18, 'VR_V', 'vPack', null, 'output', 'continuous', 'calculated', 'V', null],
  ['SoC', 19, 'VR_SOC', 'soc', null, 'output', 'continuous', 'calculated', '1', null],
  ['T_cell', 20, 'VR_TCELL', 'tCell', null, 'output', 'continuous', 'calculated', 'degC', null],
  ['Q_loss', 21, 'VR_QLOSS', 'qLoss', null, 'output', 'continuous', 'calculated', 'W', null],
  ['V_cell_min', 22, 'VR_VCELLMIN', 'vCellMin', null, 'output', 'continuous', 'calculated', 'V', null],
  ['P_terminal', 23, 'VR_PTERM', 'pTerm', null, 'output', 'continuous', 'calculated', 'W', null],
];

const PARAMETER_VALUES = Object.freeze({
  cells_series: 110,
  cells_parallel: 43,
  capacity_Ah: 3.5,
  ocv_min: 2.5,
  ocv_max: 4.2,
  r0_mOhm: 42.5,
  rc1_mOhm: 13.25,
  rc1_tau_s: 27,
  r0_Ea_J: 23456,
  cp_cell: 1000,
  mass_cell_kg: 0.067,
  h_cool_WK: 6,
  ua_amb_WK: 2,
  entropy_VK: -0.0002,
});

function assertDeepFrozen(value, path = 'root', seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value), `${path} is frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${path}.${key}`, seen);
  }
}

test('ordered signal contract pins the existing 23-scalar ABI', () => {
  assert.equal(FMI_IO_CONTRACT_FORMAT, 'battery-design/fmi-io-contract@1');
  assert.equal(FMI_IO_CONTRACT_VERSION, '1.0.0');
  assert.equal(FMI_IO_CONTRACT_CHECKSUM, '5b63861f581ef668dd0e9b8eb26bfa4d7936ca4d92dd89ef02e2e57b10640a50');
  assert.deepEqual(FMI_IO_CONTRACT.map((variable) => [
    variable.name,
    variable.valueReference,
    variable.cSymbol,
    variable.cField,
    variable.cDefaultMacro,
    variable.causality,
    variable.variability,
    variable.initial,
    variable.unit,
    variable.start,
  ]), ABI);
  assert.ok(FMI_IO_CONTRACT.every(({ type }) => type === 'Real'));
});

test('contract, unit catalog and compatibility projections are deeply frozen', () => {
  assertDeepFrozen(FMI_IO_CONTRACT, 'FMI_IO_CONTRACT');
  assertDeepFrozen(FMI_UNIT_DEFINITIONS, 'FMI_UNIT_DEFINITIONS');
  assertDeepFrozen(FMU_PARAMETERS, 'FMU_PARAMETERS');
  assertDeepFrozen(FMU_VARIABLES, 'FMU_VARIABLES');
  assert.throws(() => { FMI_IO_CONTRACT[0].name = 'renumbered'; }, TypeError);
  assert.throws(() => { FMI_UNIT_DEFINITIONS[0].baseUnit.A = 2; }, TypeError);

  assert.deepEqual(FMU_PARAMETERS, FMI_IO_CONTRACT
    .filter(({ causality }) => causality === 'parameter')
    .map(({ name, unit, description }) => ({ name, unit, description })));
  assert.deepEqual(FMU_VARIABLES, FMI_IO_CONTRACT
    .filter(({ causality }) => causality !== 'parameter')
    .map(({ name, causality, unit, start, description }) => ({
      name, causality, unit, start, description,
    })));
});

test('roles, host-safe names, value references and C bindings are unique', () => {
  const unique = (values, label) => {
    assert.equal(new Set(values).size, values.length, `${label} must be unique`);
  };
  unique(FMI_IO_CONTRACT.map(({ role }) => role), 'roles');
  unique(FMI_IO_CONTRACT.map(({ name }) => name), 'names');
  unique(FMI_IO_CONTRACT.map(({ name }) => name.toLowerCase()), 'case-insensitive names');
  unique(FMI_IO_CONTRACT.map(({ valueReference }) => valueReference), 'value references');
  unique(FMI_IO_CONTRACT.map(({ cSymbol }) => cSymbol), 'C symbols');
  unique(FMI_IO_CONTRACT.map(({ cField }) => cField), 'C fields');
  unique(FMI_IO_CONTRACT.filter(({ cDefaultMacro }) => cDefaultMacro)
    .map(({ cDefaultMacro }) => cDefaultMacro), 'C default macros');

  for (const variable of FMI_IO_CONTRACT) {
    assert.match(variable.name, /^[A-Za-z_][A-Za-z0-9_]{0,54}$/,
      `${variable.name} is a <=55-character flat identifier for strict importers`);
    assert.match(variable.cSymbol, /^VR_[A-Z0-9_]+$/);
    assert.match(variable.cField, /^[A-Za-z_][A-Za-z0-9_]*$/);
    if (variable.causality === 'parameter') assert.match(variable.cDefaultMacro, /^DEFAULT_[A-Z0-9_]+$/);
    else assert.equal(variable.cDefaultMacro, null);
  }
});

test('every signal unit and display unit is defined with the correct percent transform', () => {
  const units = new Map(FMI_UNIT_DEFINITIONS.map((unit) => [unit.name, unit]));
  assert.equal(units.size, FMI_UNIT_DEFINITIONS.length, 'unit names are unique');
  for (const variable of FMI_IO_CONTRACT) {
    assert.ok(units.has(variable.unit), `${variable.name}: ${variable.unit} is defined`);
    if (variable.displayUnit) {
      assert.ok(units.get(variable.unit).displayUnits
        .some(({ name }) => name === variable.displayUnit), `${variable.name}: display unit is defined`);
    }
  }
  assert.deepEqual(units.get('1').displayUnits, [{ name: '%', factor: 100, offset: 0 }]);
  assert.equal(FMI_IO_CONTRACT.find(({ name }) => name === 'SoC').displayUnit, '%');
});

test('every scalar carries explicit source, update and sign semantics', () => {
  for (const variable of FMI_IO_CONTRACT) {
    assert.match(variable.role, /^battery\./, `${variable.name}: stable battery role`);
    assert.ok(variable.quantity.length > 0, `${variable.name}: quantity`);
    assert.ok(variable.description.length > 12, `${variable.name}: description`);
    assert.ok(variable.sourceBinding.length > 4, `${variable.name}: source binding`);
    assert.ok(variable.updateSemantics.length > 20, `${variable.name}: update semantics`);
    assert.ok(variable.signConvention.length > 20, `${variable.name}: sign convention`);
  }
  const byName = Object.fromEntries(FMI_IO_CONTRACT.map((variable) => [variable.name, variable]));
  assert.match(byName.I_pack.signConvention, /Positive current discharges/);
  assert.match(byName.P_terminal.signConvention, /Positive is power delivered/);
  assert.match(byName.Q_loss.signConvention, /net value negative/);
  assert.match(byName.V_cell_min.description, /not a resolved cell minimum/);
  assert.match(byName.T_ambient.description, /coolant inlet reference/);
  assert.equal(byName.cells_series.sourceBinding, 'design.pack.s');
  assert.equal(byName.r0_mOhm.sourceBinding, 'simulation.params.r0Ref');
  for (const name of ['capacity_Ah', 'ocv_min', 'ocv_max', 'rc1_tau_s', 'cp_cell', 'mass_cell_kg']) {
    assert.equal(byName[name].exclusiveMinimum, 0, `${name}: strict-positive runtime constraint is explicit`);
    assert.equal(byName[name].min, undefined, `${name}: XML does not overstate an inclusive zero minimum`);
  }
  assert.equal(byName.ocv_max.greaterThan, 'ocv_min');
});

test('materializer resolves all parameter starts without mutating or sharing input state', () => {
  const ioMap = materializeFmiIoMap({
    parameterValues: PARAMETER_VALUES,
    modelName: 'BatteryPack',
    modelRevision: 'battery-plant-1rc-v1',
    guid: '{00000000-0000-0000-0000-000000000000}',
  });
  assertDeepFrozen(ioMap, 'ioMap');
  assert.equal(ioMap.format, FMI_IO_CONTRACT_FORMAT);
  assert.equal(ioMap.version, FMI_IO_CONTRACT_VERSION);
  assert.equal(ioMap.fmiVersion, '2.0');
  assert.equal(ioMap.fmiStandardPatch, '2.0.5');
  assert.equal(ioMap.contractChecksum, FMI_IO_CONTRACT_CHECKSUM);
  assert.equal(ioMap.modelName, 'BatteryPack');
  assert.equal(ioMap.modelIdentifier, 'BatteryPack');
  assert.equal(ioMap.modelRevision, 'battery-plant-1rc-v1');
  assert.deepEqual(ioMap.unitDefinitions, FMI_UNIT_DEFINITIONS);
  assert.equal(ioMap.variables.length, 23);
  for (const variable of ioMap.variables.filter(({ causality }) => causality === 'output')) {
    assert.ok(!Object.prototype.hasOwnProperty.call(variable, 'start'));
    assert.ok(!Object.prototype.hasOwnProperty.call(variable, 'implementationStart'));
    assert.equal(variable.startPolicy, 'calculated');
  }
  assert.deepEqual(Object.fromEntries(ioMap.variables
    .filter(({ causality }) => causality === 'parameter')
    .map(({ name, start }) => [name, start])), PARAMETER_VALUES);
  assert.equal(FMI_IO_CONTRACT[0].start, null, 'canonical design-dependent start remains unresolved');
  assert.notEqual(ioMap.variables[0], FMI_IO_CONTRACT[0], 'materialized entries are detached copies');
});

test('materializer rejects incomplete, non-finite and out-of-range parameter maps', () => {
  const { cells_series: _omitted, ...missing } = PARAMETER_VALUES;
  assert.throws(() => materializeFmiIoMap({ parameterValues: missing }), /cells_series/);
  assert.throws(() => materializeFmiIoMap({
    parameterValues: { ...PARAMETER_VALUES, capacity_Ah: Number.NaN },
  }), /capacity_Ah/);
  assert.throws(() => materializeFmiIoMap({
    parameterValues: { ...PARAMETER_VALUES, capacity_Ah: 0 },
  }), /capacity_Ah/);
  assert.throws(() => materializeFmiIoMap({
    parameterValues: { ...PARAMETER_VALUES, cells_parallel: 0 },
  }), /cells_parallel/);
  assert.throws(() => materializeFmiIoMap({ parameterValues: null }), /parameterValues/);
  assert.throws(() => materializeFmiIoMap({
    parameterValues: PARAMETER_VALUES, modelName: '',
  }), /modelName/);
});
