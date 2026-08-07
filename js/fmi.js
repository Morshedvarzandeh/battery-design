// fmi.js — the pack as a component in someone else's simulation.
//
// ANSYS Twin Builder, Simulink, GT-SUITE and Dymola support FMI co-simulation,
// so one standards-based component can target their import pipelines. Actual
// acceptance is still recorded per product/version rather than inferred from
// an open-source conformance run.
//
// The coupling is the obvious one: the master (a vehicle model, a plant
// model, a drive cycle) tells the pack what current it is drawing and how
// cold it is; the pack answers with terminal voltage, state of charge,
// temperature and the power it is losing as heat. Both sides step at a macro
// time step the master chooses.
//
//   inputs   I_pack [A]  (+ discharge),  T_ambient [°C],  coolant flow [kg/s]
//   outputs  V_pack [V],  SoC [-],  T_cell [°C],  Q_loss [W],
//            V_cell_min [V], P_terminal [W]
//
// This module generates the canonical FMI source tree: modelDescription.xml,
// the complete reduced one-RC C implementation and source-build documentation.
// tools/fmu-build.mjs compiles, inspects and packages that tree into a loadable
// .fmu. The stepping code is C on purpose — an FMU has to be a compiled shared
// library, so here a compiled language is a format requirement rather than an
// optimisation.
//
// Honesty: buildFmu() emits a source-FMU build kit. The release workflow
// separately compiles reproducible native binaries and packages the downloadable
// .fmu; browser, CLI and local-API exports remain source-only.
//
// Pure string generation, no filesystem, no DOM: the desktop runner writes
// the files, the browser can preview them.

import { defaultParams, validateParams } from './sim2.js';
import { semanticDigest } from './ontology.js';
import { cellById } from './cells.js';
import {
  FMI_IO_CONTRACT, FMI_IO_CONTRACT_CHECKSUM, FMI_IO_CONTRACT_FORMAT,
  FMI_IO_CONTRACT_VERSION, FMI_UNIT_DEFINITIONS,
  FMU_PARAMETERS, FMU_VARIABLES, materializeFmiIoMap,
} from './fmi-signal-map.js';
import {
  createFmiExportSnapshot, FMI_DESIGN_RESOURCE_FORMAT, FMI_EXPORT_SNAPSHOT_FORMAT,
  materializeFmiDesignResource, verifyFmiDesignResource,
} from './fmi-export-snapshot.js';

export {
  FMI_IO_CONTRACT, FMI_IO_CONTRACT_CHECKSUM, FMI_IO_CONTRACT_FORMAT,
  FMI_IO_CONTRACT_VERSION, FMI_UNIT_DEFINITIONS,
  FMU_PARAMETERS, FMU_VARIABLES, materializeFmiIoMap,
} from './fmi-signal-map.js';
export {
  createFmiExportSnapshot, FMI_DESIGN_RESOURCE_FORMAT, FMI_EXPORT_SNAPSHOT_FORMAT,
  materializeFmiDesignResource, verifyFmiDesignResource,
} from './fmi-export-snapshot.js';

export const FMI_VERSION = '2.0';
export const FMI_STANDARD_VERSION = '2.0.5';
export const FMU_MODEL_REVISION = 'battery-plant-1rc-v1';

// Every symbol an FMI 2.0 Co-Simulation shared library must export, including
// functions for capabilities this model declares unsupported.
export const FMI2_REQUIRED_CO_SIMULATION_SYMBOLS = Object.freeze([
  'fmi2GetTypesPlatform', 'fmi2GetVersion', 'fmi2SetDebugLogging',
  'fmi2Instantiate', 'fmi2FreeInstance', 'fmi2SetupExperiment',
  'fmi2EnterInitializationMode', 'fmi2ExitInitializationMode', 'fmi2Terminate', 'fmi2Reset',
  'fmi2GetReal', 'fmi2GetInteger', 'fmi2GetBoolean', 'fmi2GetString',
  'fmi2SetReal', 'fmi2SetInteger', 'fmi2SetBoolean', 'fmi2SetString',
  'fmi2GetFMUstate', 'fmi2SetFMUstate', 'fmi2FreeFMUstate',
  'fmi2SerializedFMUstateSize', 'fmi2SerializeFMUstate', 'fmi2DeSerializeFMUstate',
  'fmi2GetDirectionalDerivative', 'fmi2SetRealInputDerivatives',
  'fmi2GetRealOutputDerivatives', 'fmi2DoStep', 'fmi2CancelStep',
  'fmi2GetStatus', 'fmi2GetRealStatus', 'fmi2GetIntegerStatus',
  'fmi2GetBooleanStatus', 'fmi2GetStringStatus',
]);

const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const xmlAttrs = (attributes) => Object.entries(attributes)
  .filter(([, value]) => value != null)
  .map(([name, value]) => `${name}="${xmlEscape(value)}"`)
  .join(' ');

const unitDefinitionsXml = () => FMI_UNIT_DEFINITIONS.map((unit) => {
  const base = `<BaseUnit${Object.keys(unit.baseUnit).length ? ` ${xmlAttrs(unit.baseUnit)}` : ''}/>`;
  const displays = unit.displayUnits
    .map((display) => `<DisplayUnit ${xmlAttrs(display)}/>`)
    .join('');
  return `    <Unit name="${xmlEscape(unit.name)}">${base}${displays}</Unit>`;
}).join('\n');

// sim2.js has a wider parameter surface than this deliberately reduced
// one-RC FMU. Accepting a valid sim2 parameter that the FMU does not use is
// worse than rejecting it: the caller would receive an unchanged component
// while believing their calibration had been embedded. Keep this allow-list
// beside the projection below so every accepted override affects the FMU.
const FMU_PARAMETER_OVERRIDE_KEYS = Object.freeze([
  'r0Ref', 'rc1R', 'rc1TauS', 'r0EaJ',
  'cpCellJkgK', 'hCoolWK', 'uaAmbWK', 'entropyVK',
]);
const FMU_PARAMETER_OVERRIDE_KEY_SET = new Set(FMU_PARAMETER_OVERRIDE_KEYS);

/**
 * The one set of fixed starts shared by modelDescription.xml and the binary.
 * FMI importers are allowed to instantiate without writing parameter starts
 * back into the component, so duplicating these values in C is a correctness
 * bug rather than a harmless default.
 */
export function resolveFmuParameterValues({ cell, s, p, params = null, strict = false }) {
  if (!cell || typeof cell !== 'object') throw new TypeError('FMU export requires a cell record.');
  if (!Number.isInteger(s) || s < 1 || !Number.isInteger(p) || p < 1) {
    throw new RangeError('FMU series and parallel counts must be positive integers.');
  }
  if (params != null && (typeof params !== 'object' || Array.isArray(params))) {
    throw new TypeError('FMU parameter overrides must be one JSON object.');
  }
  const unsupported = params == null ? [] : Object.keys(params)
    .filter((name) => !FMU_PARAMETER_OVERRIDE_KEY_SET.has(name))
    .sort();
  if (strict && unsupported.length) {
    throw new TypeError(`FMU parameter overrides are not represented by the reduced one-RC component: ${unsupported.join(', ')}.`);
  }
  const supportedOverrides = params == null ? {} : Object.fromEntries(
    Object.entries(params).filter(([name]) => FMU_PARAMETER_OVERRIDE_KEY_SET.has(name)),
  );
  const validated = validateParams({ ...defaultParams(cell), ...supportedOverrides });
  if (strict && validated.notes.length) {
    throw new RangeError(`FMU parameter overrides require repair: ${validated.notes.join('; ')}`);
  }
  const P = validated.params;
  const values = {
    cells_series: s,
    cells_parallel: p,
    capacity_Ah: Number(cell.capacityAh),
    ocv_min: Number(cell.vMin),
    ocv_max: Number(cell.vMax),
    r0_mOhm: Number(P.r0Ref),
    rc1_mOhm: Number(P.rc1R),
    rc1_tau_s: Number(P.rc1TauS),
    r0_Ea_J: Number(P.r0EaJ),
    cp_cell: Number(P.cpCellJkgK),
    mass_cell_kg: Number(cell.massG ?? 50) / 1000,
    h_cool_WK: Number(P.hCoolWK),
    ua_amb_WK: Number(P.uaAmbWK),
    entropy_VK: Number(P.entropyVK),
  };
  if (Object.values(values).some((value) => !Number.isFinite(value))) {
    throw new TypeError('FMU fixed starts must all be finite numbers.');
  }
  if (!(values.capacity_Ah > 0 && values.ocv_min > 0 && values.ocv_max > values.ocv_min
      && values.rc1_tau_s > 0 && values.cp_cell > 0 && values.mass_cell_kg > 0)) {
    throw new RangeError('FMU fixed starts violate the battery model physical contract.');
  }
  return Object.freeze({
    values: Object.freeze(values),
    warnings: Object.freeze([
      ...unsupported.map((name) => `${name}: ignored because it is not represented by the reduced one-RC FMU`),
      ...validated.notes,
    ]),
  });
}

export function fmuParameterValues(options) {
  return resolveFmuParameterValues(options).values;
}

/** A content identity that changes with every binary-affecting default. */
export function fmuGuid({
  cell, s, p, params = null, defaults = null, modelName = 'BatteryPack',
  designSnapshotChecksum = null,
}) {
  if (designSnapshotChecksum != null
      && !/^[a-f0-9]{64}$/.test(designSnapshotChecksum)) {
    throw new TypeError('FMU design snapshot checksum must be a lowercase SHA-256 digest.');
  }
  const resolvedDefaults = defaults || fmuParameterValues({ cell, s, p, params });
  const snapshotChecksum = designSnapshotChecksum || createFmiExportSnapshot({
    cell, s, p, modelName, defaults: resolvedDefaults,
    ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
    modelRevision: FMU_MODEL_REVISION,
    fmiVersion: FMI_VERSION,
    fmiStandardVersion: FMI_STANDARD_VERSION,
  }).snapshotChecksum;
  const digest = semanticDigest({
    format: 'battery-design/fmi-2.0-co-simulation@1',
    standardPatch: FMI_STANDARD_VERSION,
    modelRevision: FMU_MODEL_REVISION,
    modelName,
    cellId: cell?.id || null,
    ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
    defaults: resolvedDefaults,
    designSnapshotChecksum: snapshotChecksum,
  });
  return `{${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}}`;
}

/** The FMI 2.0 modelDescription.xml — the contract the host tool reads. */
export function modelDescriptionXml({
  cell, s, p, params = null, defaults = null, modelName = 'BatteryPack',
  guid = null, generatedOn = '1970-01-01T00:00:00Z',
}) {
  const paramValues = defaults || fmuParameterValues({ cell, s, p, params });
  // The GUID must match between the XML and the binary. It is derived from the
  // design so the same design always produces the same FMU — reproducible
  // builds matter when someone asks which pack a result came from.
  const id = guid || fmuGuid({ cell, s, p, params, defaults: paramValues, modelName });
  const ioMap = materializeFmiIoMap({
    parameterValues: paramValues, modelName, modelRevision: FMU_MODEL_REVISION,
    guid: id, fmiStandardVersion: FMI_STANDARD_VERSION,
  });
  const varLines = ioMap.variables.map((variable) => {
    const scalarAttributes = {
      name: variable.name,
      valueReference: variable.valueReference,
      causality: variable.causality,
      variability: variable.variability,
      initial: variable.initial,
      description: variable.description,
    };
    const realAttributes = {
      start: variable.causality === 'parameter' || variable.causality === 'input'
        ? variable.start : null,
      unit: variable.unit,
      displayUnit: variable.displayUnit,
      quantity: variable.quantity,
      min: variable.min,
      max: variable.max,
      nominal: variable.nominal,
    };
    return `    <ScalarVariable ${xmlAttrs(scalarAttributes)}>
      <Real ${xmlAttrs(realAttributes)}/>
    </ScalarVariable>`;
  });
  // ModelStructure Unknown@index is the 1-based ModelVariables position, not
  // the value reference. Preserve declaration order while VRs stay explicit.
  const outputIdx = ioMap.variables
    .map((variable, index) => ({ variable, idx: index + 1 }))
    .filter(({ variable }) => variable.causality === 'output');

  return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription
  fmiVersion="${FMI_VERSION}"
  modelName="${xmlEscape(modelName)}"
  guid="${xmlEscape(id)}"
  description="Battery pack plant model exported by battery-design (AGPL-3.0-or-later). Reduced one-RC equivalent circuit with Arrhenius resistance and one lumped thermal node."
  generationTool="battery-design"
  generationDateAndTime="${generatedOn}"
  variableNamingConvention="flat"
  numberOfEventIndicators="0">

  <CoSimulation
    modelIdentifier="${xmlEscape(modelName)}"
    canHandleVariableCommunicationStepSize="true"
    canInterpolateInputs="false"
    maxOutputDerivativeOrder="0"
    canBeInstantiatedOnlyOncePerProcess="false"
    canNotUseMemoryManagementFunctions="false"
    canGetAndSetFMUstate="false"
    canSerializeFMUstate="false"
    providesDirectionalDerivative="false">
    <SourceFiles>
      <File name="${xmlEscape(modelName)}.c"/>
    </SourceFiles>
  </CoSimulation>

  <UnitDefinitions>
${unitDefinitionsXml()}
  </UnitDefinitions>

  <DefaultExperiment startTime="0" stopTime="10" tolerance="0.0001" stepSize="0.1"/>

  <ModelVariables>
${varLines.join('\n')}
  </ModelVariables>

  <ModelStructure>
    <Outputs>
${outputIdx.map(({ idx }) => `      <Unknown index="${idx}"/>`).join('\n')}
    </Outputs>
    <InitialUnknowns>
${outputIdx.map(({ idx }) => `      <Unknown index="${idx}"/>`).join('\n')}
    </InitialUnknowns>
  </ModelStructure>
</fmiModelDescription>
`;
}

const SOURCE_DEFAULTS = Object.freeze({
  cells_series: 96,
  cells_parallel: 4,
  capacity_Ah: 4.9,
  ocv_min: 2.5,
  ocv_max: 4.2,
  r0_mOhm: 35,
  rc1_mOhm: 17,
  rc1_tau_s: 15,
  r0_Ea_J: 20000,
  cp_cell: 1000,
  mass_cell_kg: 0.07,
  h_cool_WK: 6,
  ua_amb_WK: 2,
  entropy_VK: -0.0002,
});

const cNumber = (value) => {
  if (!Number.isFinite(value)) throw new TypeError('FMU C defaults must be finite.');
  return Number.isInteger(value) ? `${value}.0` : String(value);
};

const validModelIdentifier = (value) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const validGenerationTimestamp = (value) => (
  typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
);

/**
 * The C source implementing FMI 2.0 co-simulation.
 *
 * A deliberately reduced subset of js/sim2.js, written plainly: no allocation
 * in the step function, no non-standard library dependencies, and bounded
 * internal steps with stable exponential RC and thermal updates.
 */
export function fmuSourceC({ modelName = 'BatteryPack', guid = '{00000000-0000-0000-0000-000000000000}', defaults = SOURCE_DEFAULTS } = {}) {
  if (!validModelIdentifier(modelName)) throw new TypeError('Invalid FMI model identifier.');
  const D = { ...SOURCE_DEFAULTS, ...(defaults || {}) };
  for (const name of FMU_PARAMETERS.map((parameter) => parameter.name)) {
    if (!Number.isFinite(D[name])) throw new TypeError(`Missing finite FMU C default: ${name}`);
  }
  const parameterContract = FMI_IO_CONTRACT.filter((variable) => variable.causality === 'parameter');
  const inputContract = FMI_IO_CONTRACT.filter((variable) => variable.causality === 'input');
  const defaultMacros = parameterContract
    .map((variable) => `#define ${variable.cDefaultMacro.padEnd(16)} ${cNumber(D[variable.name])}`)
    .join('\n');
  const valueReferenceEnum = FMI_IO_CONTRACT
    .map((variable) => `  ${variable.cSymbol} = ${variable.valueReference}`)
    .join(',\n');
  const parameterResets = parameterContract
    .map((variable) => `m->${variable.cField} = ${variable.cDefaultMacro};`)
    .join(' ');
  const inputResets = inputContract
    .map((variable) => `m->${variable.cField} = ${cNumber(variable.start)};`)
    .join(' ');
  const getRealCases = FMI_IO_CONTRACT
    .map((variable) => `      case ${variable.cSymbol}: value[k] = m->${variable.cField}; break;`)
    .join('\n');
  const setRealCases = [...inputContract, ...parameterContract]
    .map((variable) => `      case ${variable.cSymbol}: trial.${variable.cField} = value[k]; break;`)
    .join('\n');
  const parameterPredicateCases = parameterContract
    .map((variable) => `    case ${variable.cSymbol}: return 1;`)
    .join('\n');
  return `/* ${modelName}.c — FMI 2.0 co-simulation battery pack.
 *
 * Generated by battery-design (AGPL-3.0-or-later). This reduced plant uses
 * linear OCV + R0 + one RC branch with Arrhenius temperature dependence, irreversible
 * and reversible heat, and a lumped thermal node cooled by a coolant stream
 * through an epsilon-NTU effectiveness, plus loss to ambient.
 *
 * No dependencies beyond the C standard library and the FMI 2.0 headers.
 * Build: see README in this archive. A shared-library build defines
 * FMI2_OVERRIDE_FUNCTION_PREFIX; a source/static build keeps ${modelName}_
 * symbols as required by the FMI 2.0 source-code convention.
 */
#include <string.h>
#include <math.h>
#include <stdlib.h>
#define FMI2_FUNCTION_PREFIX ${modelName}_
#include "fmi2Functions.h"

#define GUID ${JSON.stringify(String(guid))}
#define R_GAS 8.314462618
#define T0K   273.15
#define MAX_SUB_DT 1.0       /* accuracy bound; RC and thermal updates are stable exponentials */
#define MAX_COMM_STEP 3600.0 /* reject pathological requests instead of doing unbounded work */

${defaultMacros}

/* Explicit value references generated from the versioned host I/O contract. */
enum {
${valueReferenceEnum}
};

static int is_parameter_vr(fmi2ValueReference vr) {
  switch (vr) {
${parameterPredicateCases}
    default: return 0;
  }
}

typedef struct {
  /* parameters */
  double s, p, capAh, ocvMin, ocvMax, r0, rc1, tau, ea, cp, massCell, hCool, uaAmb, entropy;
  /* inputs */
  double iPack, tAmb, flow;
  /* state */
  double soc, v1, tCell, time, stopTime;
  /* outputs */
  double vPack, qLoss, vCellMin, pTerm;
  fmi2CallbackLogger logger;
  fmi2CallbackAllocateMemory allocate;
  fmi2CallbackFreeMemory release;
  fmi2ComponentEnvironment env;
  char instanceName[256];
  int mode, stopTimeDefined;
} Pack;

enum { MODE_INSTANTIATED = 1, MODE_INITIALIZATION, MODE_STEP, MODE_TERMINATED };

/* Open-circuit voltage of one cell: linear in SoC between the stated window.
 * The richer chemistry-shaped curve lives in the JS model; this is the shape
 * an FMU consumer can reason about, and it is stated rather than implied. */
static double ocv_cell(Pack *m, double soc) {
  if (soc < 0) { soc = 0; }
  if (soc > 1) { soc = 1; }
  return m->ocvMin + (m->ocvMax - m->ocvMin) * soc;
}

static void refresh_outputs(Pack *m) {
  double tK = m->tCell + T0K, tRefK = 25.0 + T0K;
  double arr = exp((m->ea / R_GAS) * (1.0 / tK - 1.0 / tRefK));
  double scale = (m->s / m->p) / 1000.0;
  double r0 = m->r0 * arr * scale;
  double r1 = m->rc1 * arr * scale;
  m->vPack = ocv_cell(m, m->soc) * m->s - m->v1 - m->iPack * r0;
  m->vCellMin = m->vPack / m->s;
  m->pTerm = m->vPack * m->iPack;
  m->qLoss = m->iPack * m->iPack * r0
    + (r1 > 1e-12 ? m->v1 * m->v1 / r1 : 0.0)
    - m->iPack * tK * m->entropy * m->s;
}

static void restore_start_values(Pack *m) {
  ${parameterResets}
  ${inputResets}
  m->soc = 1.0; m->v1 = 0.0; m->tCell = 25.0; m->time = 0.0;
  m->stopTime = 0.0; m->stopTimeDefined = 0;
  refresh_outputs(m);
  m->mode = MODE_INSTANTIATED;
}

static void step_once(Pack *m, double dt) {
  double tK = m->tCell + T0K, tRefK = 25.0 + T0K;
  double arr = exp((m->ea / R_GAS) * (1.0 / tK - 1.0 / tRefK));
  /* per-cell milliohms -> pack ohms */
  double scale = (m->s / m->p) / 1000.0;
  double r0 = m->r0 * arr * scale;
  double r1 = m->rc1 * arr * scale;
  double ocv = ocv_cell(m, m->soc) * m->s;
  double i = m->iPack;

  (void)ocv;
  m->v1 = i * r1 + (m->v1 - i * r1) * exp(-dt / m->tau);

  double capPack = m->capAh * m->p;
  if (capPack > 0) m->soc -= (i * dt / 3600.0) / capPack;
  if (m->soc < 0) { m->soc = 0; }
  if (m->soc > 1) { m->soc = 1; }

  /* Heat: irreversible in R0 and the RC branch, plus the reversible entropic
   * term, which changes sign with the current. */
  double qIrr = i * i * r0 + (r1 > 1e-12 ? m->v1 * m->v1 / r1 : 0.0);
  double qRev = -i * tK * m->entropy * m->s;
  m->qLoss = qIrr + qRev;

  /* Lumped thermal node. The coolant is a stream with a finite capacity rate:
   * no flow removes no heat, and lots of flow is limited by hCool. */
  double cth = m->massCell * m->s * m->p * m->cp;
  double capRate = m->flow * 3600.0;              /* kg/s * J/(kg.K) for glycol */
  double eff = capRate > 0 ? 1.0 - exp(-m->hCool / capRate) : 0.0;
  double kOut = eff * capRate + m->uaAmb;
  if (kOut > 1e-12) {
    double decay = exp(-kOut * dt / cth);
    m->tCell = m->tAmb + (m->tCell - m->tAmb) * decay + (m->qLoss / kOut) * (1.0 - decay);
  } else {
    m->tCell += (m->qLoss * dt) / cth;
  }
  refresh_outputs(m);
}

/* ---- FMI 2.0 co-simulation entry points ---- */

const char* fmi2GetTypesPlatform(void) { return fmi2TypesPlatform; }
const char* fmi2GetVersion(void) { return fmi2Version; }

fmi2Component fmi2Instantiate(fmi2String instanceName, fmi2Type fmuType,
    fmi2String fmuGUID, fmi2String resourceLocation,
    const fmi2CallbackFunctions *functions, fmi2Boolean visible, fmi2Boolean loggingOn) {
  (void)resourceLocation; (void)visible; (void)loggingOn;
  if (fmuType != fmi2CoSimulation || !fmuGUID || strcmp(fmuGUID, GUID) != 0) return NULL;
  Pack *m = functions && functions->allocateMemory && functions->freeMemory
    ? (Pack *)functions->allocateMemory(1, sizeof(Pack))
    : (Pack *)calloc(1, sizeof(Pack));
  if (!m) return NULL;
  if (functions) {
    m->logger = functions->logger; m->env = functions->componentEnvironment;
    if (functions->allocateMemory && functions->freeMemory) {
      m->allocate = functions->allocateMemory; m->release = functions->freeMemory;
    }
  }
  size_t instanceNameLength = 0;
  if (instanceName) {
    while (instanceNameLength + 1 < sizeof(m->instanceName) &&
        instanceName[instanceNameLength] != '\\0') {
      m->instanceName[instanceNameLength] = instanceName[instanceNameLength];
      instanceNameLength++;
    }
  }
  m->instanceName[instanceNameLength] = '\\0';
  restore_start_values(m);
  return m;
}

void fmi2FreeInstance(fmi2Component c) {
  Pack *m = (Pack *)c;
  if (m && m->release) { fmi2CallbackFreeMemory release = m->release; release(m); }
  else if (m) { free(m); }
}

fmi2Status fmi2SetupExperiment(fmi2Component c, fmi2Boolean toleranceDefined, fmi2Real tolerance,
    fmi2Real startTime, fmi2Boolean stopTimeDefined, fmi2Real stopTime) {
  if (toleranceDefined && (!isfinite(tolerance) || tolerance <= 0.0)) return fmi2Error;
  Pack *m = (Pack *)c; if (!m || m->mode != MODE_INSTANTIATED || !isfinite(startTime)) return fmi2Error;
  if (stopTimeDefined && (!isfinite(stopTime) || stopTime < startTime)) return fmi2Error;
  m->time = startTime; m->stopTimeDefined = stopTimeDefined ? 1 : 0; m->stopTime = stopTime;
  return fmi2OK;
}

fmi2Status fmi2EnterInitializationMode(fmi2Component c) {
  Pack *m = (Pack *)c; if (!m || m->mode != MODE_INSTANTIATED) return fmi2Error;
  m->mode = MODE_INITIALIZATION; return fmi2OK;
}

fmi2Status fmi2ExitInitializationMode(fmi2Component c) {
  Pack *m = (Pack *)c; if (!m || m->mode != MODE_INITIALIZATION) return fmi2Error;
  m->tCell = m->tAmb;
  refresh_outputs(m);
  m->mode = MODE_STEP;
  return fmi2OK;
}

fmi2Status fmi2Terminate(fmi2Component c) {
  Pack *m = (Pack *)c; if (!m || m->mode == MODE_TERMINATED) return fmi2Error;
  m->mode = MODE_TERMINATED; return fmi2OK;
}
fmi2Status fmi2Reset(fmi2Component c) {
  Pack *m = (Pack *)c; if (!m) return fmi2Error;
  restore_start_values(m); return fmi2OK;
}

fmi2Status fmi2GetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Real value[]) {
  Pack *m = (Pack *)c; if (!m || (nvr && (!vr || !value))) return fmi2Error;
  for (size_t k = 0; k < nvr; k++) {
    switch (vr[k]) {
${getRealCases}
      default: return fmi2Error;
    }
  }
  return fmi2OK;
}

fmi2Status fmi2SetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, const fmi2Real value[]) {
  Pack *m = (Pack *)c; if (!m || m->mode == MODE_TERMINATED || (nvr && (!vr || !value))) return fmi2Error;
  Pack trial = *m;
  for (size_t k = 0; k < nvr; k++) {
    if (!isfinite(value[k])) return fmi2Error;
    if (is_parameter_vr(vr[k]) && m->mode != MODE_INSTANTIATED && m->mode != MODE_INITIALIZATION) return fmi2Error;
    switch (vr[k]) {
${setRealCases}
      default: return fmi2Error;
    }
  }
  if (!(trial.s >= 1.0 && floor(trial.s) == trial.s && trial.p >= 1.0 && floor(trial.p) == trial.p
      && trial.capAh > 0.0 && trial.ocvMin > 0.0 && trial.ocvMax > trial.ocvMin
      && trial.r0 >= 0.0 && trial.rc1 >= 0.0 && trial.tau > 0.0 && trial.ea >= 0.0
      && trial.cp > 0.0 && trial.massCell > 0.0 && trial.hCool >= 0.0 && trial.uaAmb >= 0.0
      && trial.flow >= 0.0 && trial.tAmb > -T0K)) return fmi2Error;
  *m = trial;
  refresh_outputs(m);
  return fmi2OK;
}

fmi2Status fmi2DoStep(fmi2Component c, fmi2Real currentCommunicationPoint,
    fmi2Real communicationStepSize, fmi2Boolean noSetFMUStatePriorToCurrentPoint) {
  (void)noSetFMUStatePriorToCurrentPoint;
  Pack *m = (Pack *)c; if (!m || m->mode != MODE_STEP) return fmi2Error;
  if (!isfinite(currentCommunicationPoint) || !isfinite(communicationStepSize)
      || communicationStepSize <= 0.0 || communicationStepSize > MAX_COMM_STEP) return fmi2Error;
  double timeTolerance = 1e-9 * fmax(1.0, fabs(m->time));
  if (fabs(currentCommunicationPoint - m->time) > timeTolerance) return fmi2Error;
  if (m->stopTimeDefined && currentCommunicationPoint + communicationStepSize > m->stopTime + timeTolerance) return fmi2Error;
  /* The master may take a large macro step; sub-step internally so the RC and
   * thermal states stay stable whatever it chooses. */
  double remaining = communicationStepSize;
  while (remaining > 1e-12) {
    double dt = remaining > MAX_SUB_DT ? MAX_SUB_DT : remaining;
    step_once(m, dt);
    remaining -= dt;
  }
  m->time = currentCommunicationPoint + communicationStepSize;
  return fmi2OK;
}

fmi2Status fmi2SetRealInputDerivatives(fmi2Component c, const fmi2ValueReference vr[], size_t nvr,
    const fmi2Integer order[], const fmi2Real value[]) {
  (void)c; (void)vr; (void)nvr; (void)order; (void)value; return fmi2Error;
}
fmi2Status fmi2GetRealOutputDerivatives(fmi2Component c, const fmi2ValueReference vr[], size_t nvr,
    const fmi2Integer order[], fmi2Real value[]) {
  (void)c; (void)vr; (void)nvr; (void)order; (void)value; return fmi2Error;
}

/* Not supported, and honestly declared as such in modelDescription.xml. */
fmi2Status fmi2CancelStep(fmi2Component c) { (void)c; return fmi2Error; }
fmi2Status fmi2GetStatus(fmi2Component c, const fmi2StatusKind k, fmi2Status *v) { (void)c;(void)k;(void)v; return fmi2Discard; }
fmi2Status fmi2GetRealStatus(fmi2Component c, const fmi2StatusKind k, fmi2Real *v) {
  Pack *m = (Pack *)c;
  if (k == fmi2LastSuccessfulTime && m && v) { *v = m->time; return fmi2OK; }
  return fmi2Discard;
}
fmi2Status fmi2GetIntegerStatus(fmi2Component c, const fmi2StatusKind k, fmi2Integer *v) { (void)c;(void)k;(void)v; return fmi2Discard; }
fmi2Status fmi2GetBooleanStatus(fmi2Component c, const fmi2StatusKind k, fmi2Boolean *v) { (void)c;(void)k;(void)v; return fmi2Discard; }
fmi2Status fmi2GetStringStatus(fmi2Component c, const fmi2StatusKind k, fmi2String *v) { (void)c;(void)k;(void)v; return fmi2Discard; }

/* Integer/Boolean/String variables are not used by this model. */
fmi2Status fmi2GetInteger(fmi2Component c, const fmi2ValueReference vr[], size_t n, fmi2Integer v[]) { (void)c;(void)vr;(void)v; return n ? fmi2Error : fmi2OK; }
fmi2Status fmi2SetInteger(fmi2Component c, const fmi2ValueReference vr[], size_t n, const fmi2Integer v[]) { (void)c;(void)vr;(void)v; return n ? fmi2Error : fmi2OK; }
fmi2Status fmi2GetBoolean(fmi2Component c, const fmi2ValueReference vr[], size_t n, fmi2Boolean v[]) { (void)c;(void)vr;(void)v; return n ? fmi2Error : fmi2OK; }
fmi2Status fmi2SetBoolean(fmi2Component c, const fmi2ValueReference vr[], size_t n, const fmi2Boolean v[]) { (void)c;(void)vr;(void)v; return n ? fmi2Error : fmi2OK; }
fmi2Status fmi2GetString(fmi2Component c, const fmi2ValueReference vr[], size_t n, fmi2String v[]) { (void)c;(void)vr;(void)v; return n ? fmi2Error : fmi2OK; }
fmi2Status fmi2SetString(fmi2Component c, const fmi2ValueReference vr[], size_t n, const fmi2String v[]) { (void)c;(void)vr;(void)v; return n ? fmi2Error : fmi2OK; }
fmi2Status fmi2SetDebugLogging(fmi2Component c, fmi2Boolean on, size_t n, const fmi2String cat[]) { (void)c;(void)on;(void)n;(void)cat; return fmi2OK; }
fmi2Status fmi2GetFMUstate(fmi2Component c, fmi2FMUstate *s) { (void)c;(void)s; return fmi2Error; }
fmi2Status fmi2SetFMUstate(fmi2Component c, fmi2FMUstate s) { (void)c;(void)s; return fmi2Error; }
fmi2Status fmi2FreeFMUstate(fmi2Component c, fmi2FMUstate *s) { (void)c;(void)s; return fmi2Error; }
fmi2Status fmi2SerializedFMUstateSize(fmi2Component c, fmi2FMUstate s, size_t *sz) { (void)c;(void)s;(void)sz; return fmi2Error; }
fmi2Status fmi2SerializeFMUstate(fmi2Component c, fmi2FMUstate s, fmi2Byte b[], size_t sz) { (void)c;(void)s;(void)b;(void)sz; return fmi2Error; }
fmi2Status fmi2DeSerializeFMUstate(fmi2Component c, const fmi2Byte b[], size_t sz, fmi2FMUstate *s) { (void)c;(void)b;(void)sz;(void)s; return fmi2Error; }
fmi2Status fmi2GetDirectionalDerivative(fmi2Component c, const fmi2ValueReference u[], size_t nu,
    const fmi2ValueReference k[], size_t nk, const fmi2Real dk[], fmi2Real du[]) {
  (void)c;(void)u;(void)nu;(void)k;(void)nk;(void)dk;(void)du; return fmi2Error;
}
`;
}

/** The build and use instructions that travel inside the FMU. */
export function fmuReadme({ modelName = 'BatteryPack', cell, s, p }) {
  return `# ${modelName} — FMI ${FMI_VERSION} source-FMU build kit

Exported by battery-design (AGPL-3.0-or-later) for the ${s}S${p}P pack of
${cell?.name || 'the selected cell'}. **This directory is source code, not a
loadable FMU yet.** Compile it for the target platform, preserve the directory
tree, package it as described below, and validate the resulting component
before importing it into ANSYS Twin Builder, Simulink, GT-SUITE, Dymola,
OpenModelica, or another FMI host.

## The coupling

Your model tells the pack what it is drawing; the pack answers with what that
costs it.

| Direction | VR | Stable role | Variable | Unit | Meaning and sign |
|---|---:|---|---|---|---|
${FMI_IO_CONTRACT.filter((v) => v.causality !== 'parameter')
    .map((v) => `| ${v.causality} | ${v.valueReference} | \`${v.role}\` | \`${v.name}\` | ${v.unit} | ${v.description} ${v.signConvention} |`)
    .join('\n')}

Parameters (set once at initialisation) are an explicit subset of the desktop
model coefficients. Selected R0/RC1 values are baked into both XML and binary
starts so the declared reduced plant is internally consistent in any host:

${FMI_IO_CONTRACT.filter((v) => v.causality === 'parameter')
    .map((v) => `- VR ${v.valueReference} \`${v.name}\` (${v.unit}, role \`${v.role}\`) — ${v.description}`)
    .join('\n')}

The machine-readable form of this exact mapping is
\`resources/battery-design-io-map.json\`. Its checksum is part of the FMU GUID,
so host caches cannot silently reuse a component after the interface contract
changes.

The physical topology, cell facts, module partition, dimensions, mass, layout
and selected component ids that produced this component are bound separately
in \`resources/battery-design-design.json\`. Its snapshot checksum is also part
of the GUID. A governed DesignSpec export marks that resource complete; the
legacy cell/S/P adapter remains visibly incomplete rather than inventing
layout provenance it never received.

## Building it

The C is complete and dependency-free. Compile it against the official FMI
${FMI_STANDARD_VERSION} headers (the XML/API version remains FMI 2.0). FMI
importers supply those standard headers for source builds; do not add them to
the FMU's declared source list. Set \`FMI2_OVERRIDE_FUNCTION_PREFIX\` when
building a shared library so it exports the unprefixed dynamic ABI:

    # Linux
    mkdir -p binaries/linux64
    cc -std=c11 -O2 -fPIC -shared -DFMI2_OVERRIDE_FUNCTION_PREFIX \\
      -I/path/to/fmi-2.0.5/headers sources/${modelName}.c -o binaries/linux64/${modelName}.so -lm
    # macOS
    mkdir -p binaries/darwin64
    cc -std=c11 -O2 -fPIC -shared -DFMI2_OVERRIDE_FUNCTION_PREFIX \\
      -I/path/to/fmi-2.0.5/headers sources/${modelName}.c -o binaries/darwin64/${modelName}.dylib -lm
    # Windows (MSVC)
    mkdir binaries\\win64
    cl /nologo /std:c11 /O2 /MT /LD /DFMI2_OVERRIDE_FUNCTION_PREFIX \\
      /I\\path\\to\\fmi-2.0.5\\headers sources\\${modelName}.c \\
      /Fe:binaries\\win64\\${modelName}.dll

Then zip the *contents* of this directory—not the directory itself—so
\`modelDescription.xml\`, \`sources/\` and \`binaries/\` remain at the archive
root, and name the archive \`${modelName}.fmu\`. Run an FMI conformance or host
import check before treating it as a usable binary artifact.

## What this model is

Reduced plant model — linear OCV + R0 + one RC branch, Arrhenius temperature
dependence — with irreversible and reversible (entropic) heat into a lumped
thermal node cooled by an ε-NTU coolant stream and loss to ambient. Stable
exponential state updates are evaluated on internal steps of at most 1 s; a
single communication step is bounded to one hour to prevent unbounded work.

## What this model is not

- **Not electrochemical.** No concentration, no diffusion, no plating model.
- **Not multi-node thermally.** The desktop model resolves per-module
  temperatures and their spread; this FMU reports one cell temperature,
  because that is what a system-level co-simulation asks for.
- **Linear OCV.** The chemistry-shaped OCV curve lives in the full model; here
  it is a straight line between the stated cell voltage limits, which is
  stated rather than implied.

If you need any of those inside the co-simulation, say so — the FMU can carry
them, at the cost of a bigger interface.
`;
}

/** Everything needed to write an FMU to disk, as plain strings. */
export function buildFmu({
  design = null, cell = null, s = null, p = null, params = null,
  modelName = 'BatteryPack', generatedOn = '1970-01-01T00:00:00Z',
} = {}) {
  if (!validModelIdentifier(modelName)) {
    throw new TypeError('FMU modelName must start with a letter or underscore and contain only letters, numbers and underscores (64 characters maximum).');
  }
  if (!validGenerationTimestamp(generatedOn)) {
    throw new TypeError('FMU generatedOn must be an ISO 8601 timestamp with a timezone.');
  }
  const hasDesign = design != null;
  const hasAnyLegacy = cell != null || s != null || p != null;
  if (hasDesign && hasAnyLegacy) {
    throw new TypeError('FMU export accepts either one complete design or legacy cell/s/p inputs, not both.');
  }
  const selectedCell = hasDesign ? cellById(design?.cell?.id) : cell;
  const selectedS = hasDesign ? design?.pack?.s : s;
  const selectedP = hasDesign ? design?.pack?.p : p;
  const parameterResolution = resolveFmuParameterValues({
    cell: selectedCell, s: selectedS, p: selectedP, params, strict: hasDesign,
  });
  const { values: defaults, warnings: parameterWarnings } = parameterResolution;
  const exportSnapshot = createFmiExportSnapshot({
    ...(hasDesign
      ? { design }
      : { cell: selectedCell, s: selectedS, p: selectedP }),
    modelName,
    defaults,
    ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
    modelRevision: FMU_MODEL_REVISION,
    fmiVersion: FMI_VERSION,
    fmiStandardVersion: FMI_STANDARD_VERSION,
  });
  const guid = fmuGuid({
    cell: selectedCell, s: selectedS, p: selectedP, defaults, modelName,
    designSnapshotChecksum: exportSnapshot.snapshotChecksum,
  });
  const designResource = materializeFmiDesignResource({ ...exportSnapshot, guid });
  const ioMap = materializeFmiIoMap({
    parameterValues: defaults, modelName, modelRevision: FMU_MODEL_REVISION,
    guid, fmiStandardVersion: FMI_STANDARD_VERSION,
  });
  const files = Object.freeze({
    'modelDescription.xml': modelDescriptionXml({
      cell: selectedCell, s: selectedS, p: selectedP, defaults, modelName, guid, generatedOn,
    }),
    [`sources/${modelName}.c`]: fmuSourceC({ modelName, guid, defaults }),
    'resources/battery-design-io-map.json': `${JSON.stringify(ioMap, null, 2)}\n`,
    'resources/battery-design-design.json': `${JSON.stringify(designResource, null, 2)}\n`,
    'README.md': fmuReadme({ modelName, cell: selectedCell, s: selectedS, p: selectedP }),
  });
  return Object.freeze({
    guid, modelName, generatedOn, standardVersion: FMI_STANDARD_VERSION,
    modelRevision: FMU_MODEL_REVISION, ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
    designSnapshotChecksum: exportSnapshot.snapshotChecksum,
    designComplete: designResource.snapshot.source.complete,
    designBinding: designResource.snapshot.source.binding,
    defaults, parameterWarnings, ioMap, designResource, files,
    note: 'A path-preserving source FMU build kit: complete, readable C that must be compiled and packaged for the target platform. It is not a loadable .fmu yet.',
  });
}
