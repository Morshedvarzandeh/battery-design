// fmi.js — the pack as a component in someone else's simulation.
//
// Co-simulation with ANSYS Twin Builder, Simulink, GT-SUITE or Dymola does
// not need a bridge per tool. Every one of them already speaks FMI — the
// Functional Mock-up Interface — so the pack is exported as a standard FMU
// and dropped into whatever the rest of the toolchain is.
//
// The coupling is the obvious one: the master (a vehicle model, a plant
// model, a drive cycle) tells the pack what current it is drawing and how
// cold it is; the pack answers with terminal voltage, state of charge,
// temperature and the power it is losing as heat. Both sides step at a macro
// time step the master chooses.
//
//   inputs   I_pack [A]  (+ discharge),  T_ambient [°C],  coolant flow [kg/s]
//   outputs  V_pack [V],  SoC [-],  T_cell [°C],  Q_loss [W],  V_min_cell [V]
//
// This module GENERATES the FMU: the modelDescription.xml that declares the
// interface, and the C source that implements a reduced one-RC plant model
// using a documented subset of the coefficients exposed by js/sim2.js. The
// stepping code is C on purpose — an FMU has to be a compiled shared library,
// and this is the one place in the project where a compiled language is not
// an optimisation but a requirement of the format.
//
// Honesty: this emits a SOURCE FMU. The C is complete and self-contained, but
// somebody has to compile it for their platform — the build line is in the
// generated README and needs nothing but cc. No binary is shipped that anyone
// cannot reproduce.
//
// Pure string generation, no filesystem, no DOM: the desktop runner writes
// the files, the browser can preview them.

import { defaultParams, validateParams } from './sim2.js';
import { semanticDigest } from './ontology.js';

export const FMI_VERSION = '2.0';
export const FMI_STANDARD_VERSION = '2.0.5';

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

// The coupling interface. Kept deliberately small: every variable here is one
// a vehicle or plant model actually has, and nothing is exposed that the
// master could not sensibly provide.
export const FMU_VARIABLES = [
  { name: 'I_pack', causality: 'input', unit: 'A', start: 0, description: 'Pack current, positive on discharge' },
  { name: 'T_ambient', causality: 'input', unit: 'degC', start: 25, description: 'Ambient temperature around the pack' },
  { name: 'coolant_flow', causality: 'input', unit: 'kg/s', start: 0.05, description: 'Coolant mass flow; 0 means no loop running' },
  { name: 'V_pack', causality: 'output', unit: 'V', start: 0, description: 'Terminal voltage under load' },
  { name: 'SoC', causality: 'output', unit: '1', start: 1, description: 'State of charge, 0 to 1' },
  { name: 'T_cell', causality: 'output', unit: 'degC', start: 25, description: 'Cell temperature (hottest module)' },
  { name: 'Q_loss', causality: 'output', unit: 'W', start: 0, description: 'Heat generated, for the thermal side of the co-simulation' },
  { name: 'V_cell_min', causality: 'output', unit: 'V', start: 0, description: 'Lowest cell voltage — what a BMS would trip on' },
  { name: 'P_terminal', causality: 'output', unit: 'W', start: 0, description: 'Electrical power at the terminals' },
];

// Parameters the master can set once at initialisation. These are the same
// coefficients js/sim2.js exposes, so a model calibrated there is the model
// that runs inside ANSYS.
export const FMU_PARAMETERS = [
  { name: 'cells_series', unit: '1', description: 'Cells in series' },
  { name: 'cells_parallel', unit: '1', description: 'Cells in parallel' },
  { name: 'capacity_Ah', unit: 'A.h', description: 'Cell capacity' },
  { name: 'ocv_min', unit: 'V', description: 'Cell voltage at empty' },
  { name: 'ocv_max', unit: 'V', description: 'Cell voltage at full' },
  { name: 'r0_mOhm', unit: 'mOhm', description: 'Cell series resistance at reference temperature' },
  { name: 'rc1_mOhm', unit: 'mOhm', description: 'RC branch resistance' },
  { name: 'rc1_tau_s', unit: 's', description: 'RC branch time constant' },
  { name: 'r0_Ea_J', unit: 'J/mol', description: 'Activation energy for the resistance temperature dependence' },
  { name: 'cp_cell', unit: 'J/(kg.K)', description: 'Cell specific heat' },
  { name: 'mass_cell_kg', unit: 'kg', description: 'Cell mass' },
  { name: 'h_cool_WK', unit: 'W/K', description: 'Conductance from cells into the coolant' },
  { name: 'ua_amb_WK', unit: 'W/K', description: 'Conductance from pack to ambient' },
  { name: 'entropy_VK', unit: 'V/K', description: 'Entropic coefficient dU/dT' },
];

const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * The one set of fixed starts shared by modelDescription.xml and the binary.
 * FMI importers are allowed to instantiate without writing parameter starts
 * back into the component, so duplicating these values in C is a correctness
 * bug rather than a harmless default.
 */
export function fmuParameterValues({ cell, s, p, params = null }) {
  if (!cell || typeof cell !== 'object') throw new TypeError('FMU export requires a cell record.');
  if (!Number.isInteger(s) || s < 1 || !Number.isInteger(p) || p < 1) {
    throw new RangeError('FMU series and parallel counts must be positive integers.');
  }
  const P = validateParams({ ...defaultParams(cell), ...(params || {}) }).params;
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
  return Object.freeze(values);
}

/** A content identity that changes with every binary-affecting default. */
export function fmuGuid({ cell, s, p, params = null, modelName = 'BatteryPack' }) {
  const digest = semanticDigest({
    format: 'battery-design/fmi-2.0-co-simulation@1',
    standardPatch: FMI_STANDARD_VERSION,
    modelName,
    cellId: cell?.id || null,
    defaults: fmuParameterValues({ cell, s, p, params }),
  });
  return `{${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}}`;
}

/** The FMI 2.0 modelDescription.xml — the contract the host tool reads. */
export function modelDescriptionXml({ cell, s, p, params = null, modelName = 'BatteryPack', guid = null, generatedOn = '1970-01-01T00:00:00Z' }) {
  const paramValues = fmuParameterValues({ cell, s, p, params });
  // The GUID must match between the XML and the binary. It is derived from the
  // design so the same design always produces the same FMU — reproducible
  // builds matter when someone asks which pack a result came from.
  const id = guid || fmuGuid({ cell, s, p, params, modelName });
  let vr = 0;
  const next = () => ++vr;
  const varLines = [
    ...FMU_PARAMETERS.map((v) => `    <ScalarVariable name="${xmlEscape(v.name)}" valueReference="${next()}" causality="parameter" variability="fixed" description="${xmlEscape(v.description)}">
      <Real start="${paramValues[v.name]}" unit="${xmlEscape(v.unit)}"/>
    </ScalarVariable>`),
    ...FMU_VARIABLES.map((v) => `    <ScalarVariable name="${xmlEscape(v.name)}" valueReference="${next()}" causality="${v.causality}" variability="continuous"${v.causality === 'input' ? '' : ' initial="calculated"'} description="${xmlEscape(v.description)}">
      <Real${v.causality === 'input' ? ` start="${v.start}"` : ''} unit="${xmlEscape(v.unit)}"/>
    </ScalarVariable>`),
  ];
  // Outputs must be listed in the model structure, by index, 1-based.
  const outputIdx = FMU_VARIABLES
    .map((v, i) => ({ v, idx: FMU_PARAMETERS.length + i + 1 }))
    .filter(({ v }) => v.causality === 'output');

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
    canNotUseMemoryManagementFunctions="true"
    canGetAndSetFMUstate="false"
    canSerializeFMUstate="false"
    providesDirectionalDerivative="false">
    <SourceFiles>
      <File name="${xmlEscape(modelName)}.c"/>
    </SourceFiles>
  </CoSimulation>

  <UnitDefinitions>
    <Unit name="A"><BaseUnit A="1"/></Unit>
    <Unit name="V"><BaseUnit kg="1" m="2" s="-3" A="-1"/></Unit>
    <Unit name="W"><BaseUnit kg="1" m="2" s="-3"/></Unit>
    <Unit name="degC"><BaseUnit K="1" offset="273.15"/></Unit>
    <Unit name="kg/s"><BaseUnit kg="1" s="-1"/></Unit>
    <Unit name="s"><BaseUnit s="1"/></Unit>
    <Unit name="1"><BaseUnit/></Unit>
    <Unit name="A.h"><BaseUnit s="1" A="1" factor="3600"/></Unit>
    <Unit name="mOhm"><BaseUnit kg="1" m="2" s="-3" A="-2" factor="0.001"/></Unit>
    <Unit name="J/mol"><BaseUnit kg="1" m="2" s="-2" mol="-1"/></Unit>
    <Unit name="J/(kg.K)"><BaseUnit m="2" s="-2" K="-1"/></Unit>
    <Unit name="kg"><BaseUnit kg="1"/></Unit>
    <Unit name="W/K"><BaseUnit kg="1" m="2" s="-3" K="-1"/></Unit>
    <Unit name="V/K"><BaseUnit kg="1" m="2" s="-3" A="-1" K="-1"/></Unit>
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

/**
 * The C source implementing FMI 2.0 co-simulation.
 *
 * Same physics as js/sim2.js, written plainly: no allocation in the step
 * function, no library dependencies, sub-stepped internally so the master can
 * take whatever macro step it likes without the RC or thermal state going
 * unstable.
 */
export function fmuSourceC({ modelName = 'BatteryPack', guid = '{00000000-0000-0000-0000-000000000000}', defaults = SOURCE_DEFAULTS } = {}) {
  if (!validModelIdentifier(modelName)) throw new TypeError('Invalid FMI model identifier.');
  const D = { ...SOURCE_DEFAULTS, ...(defaults || {}) };
  for (const name of FMU_PARAMETERS.map((parameter) => parameter.name)) {
    if (!Number.isFinite(D[name])) throw new TypeError(`Missing finite FMU C default: ${name}`);
  }
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

#define DEFAULT_S       ${cNumber(D.cells_series)}
#define DEFAULT_P       ${cNumber(D.cells_parallel)}
#define DEFAULT_CAP_AH  ${cNumber(D.capacity_Ah)}
#define DEFAULT_OCV_MIN ${cNumber(D.ocv_min)}
#define DEFAULT_OCV_MAX ${cNumber(D.ocv_max)}
#define DEFAULT_R0_MOHM ${cNumber(D.r0_mOhm)}
#define DEFAULT_R1_MOHM ${cNumber(D.rc1_mOhm)}
#define DEFAULT_TAU_S   ${cNumber(D.rc1_tau_s)}
#define DEFAULT_EA_J    ${cNumber(D.r0_Ea_J)}
#define DEFAULT_CP      ${cNumber(D.cp_cell)}
#define DEFAULT_MASS_KG ${cNumber(D.mass_cell_kg)}
#define DEFAULT_HCOOL   ${cNumber(D.h_cool_WK)}
#define DEFAULT_UA_AMB  ${cNumber(D.ua_amb_WK)}
#define DEFAULT_ENTROPY ${cNumber(D.entropy_VK)}

/* Value references must match modelDescription.xml, in declaration order. */
enum {
  VR_S = 1, VR_P, VR_CAP, VR_OCVMIN, VR_OCVMAX, VR_R0, VR_RC1, VR_TAU,
  VR_EA, VR_CP, VR_MASS, VR_HCOOL, VR_UAAMB, VR_ENTROPY,
  VR_I, VR_TAMB, VR_FLOW,
  VR_V, VR_SOC, VR_TCELL, VR_QLOSS, VR_VCELLMIN, VR_PTERM
};

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
  m->s = DEFAULT_S; m->p = DEFAULT_P; m->capAh = DEFAULT_CAP_AH;
  m->ocvMin = DEFAULT_OCV_MIN; m->ocvMax = DEFAULT_OCV_MAX;
  m->r0 = DEFAULT_R0_MOHM; m->rc1 = DEFAULT_R1_MOHM; m->tau = DEFAULT_TAU_S;
  m->ea = DEFAULT_EA_J; m->cp = DEFAULT_CP; m->massCell = DEFAULT_MASS_KG;
  m->hCool = DEFAULT_HCOOL; m->uaAmb = DEFAULT_UA_AMB; m->entropy = DEFAULT_ENTROPY;
  m->iPack = 0.0; m->tAmb = 25.0; m->flow = 0.05;
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
  Pack *m = (Pack *)calloc(1, sizeof(Pack));
  if (!m) return NULL;
  if (functions) { m->logger = functions->logger; m->env = functions->componentEnvironment; }
  if (instanceName) { strncpy(m->instanceName, instanceName, sizeof(m->instanceName) - 1); }
  restore_start_values(m);
  return m;
}

void fmi2FreeInstance(fmi2Component c) { if (c) free(c); }

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
      case VR_V: value[k] = m->vPack; break;
      case VR_SOC: value[k] = m->soc; break;
      case VR_TCELL: value[k] = m->tCell; break;
      case VR_QLOSS: value[k] = m->qLoss; break;
      case VR_VCELLMIN: value[k] = m->vCellMin; break;
      case VR_PTERM: value[k] = m->pTerm; break;
      case VR_I: value[k] = m->iPack; break;
      case VR_TAMB: value[k] = m->tAmb; break;
      case VR_FLOW: value[k] = m->flow; break;
      case VR_S: value[k] = m->s; break;
      case VR_P: value[k] = m->p; break;
      case VR_CAP: value[k] = m->capAh; break;
      case VR_OCVMIN: value[k] = m->ocvMin; break;
      case VR_OCVMAX: value[k] = m->ocvMax; break;
      case VR_R0: value[k] = m->r0; break;
      case VR_RC1: value[k] = m->rc1; break;
      case VR_TAU: value[k] = m->tau; break;
      case VR_EA: value[k] = m->ea; break;
      case VR_CP: value[k] = m->cp; break;
      case VR_MASS: value[k] = m->massCell; break;
      case VR_HCOOL: value[k] = m->hCool; break;
      case VR_UAAMB: value[k] = m->uaAmb; break;
      case VR_ENTROPY: value[k] = m->entropy; break;
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
    if (vr[k] <= VR_ENTROPY && m->mode != MODE_INSTANTIATED && m->mode != MODE_INITIALIZATION) return fmi2Error;
    switch (vr[k]) {
      case VR_I: trial.iPack = value[k]; break;
      case VR_TAMB: trial.tAmb = value[k]; break;
      case VR_FLOW: trial.flow = value[k]; break;
      case VR_S: trial.s = value[k]; break;
      case VR_P: trial.p = value[k]; break;
      case VR_CAP: trial.capAh = value[k]; break;
      case VR_OCVMIN: trial.ocvMin = value[k]; break;
      case VR_OCVMAX: trial.ocvMax = value[k]; break;
      case VR_R0: trial.r0 = value[k]; break;
      case VR_RC1: trial.rc1 = value[k]; break;
      case VR_TAU: trial.tau = value[k]; break;
      case VR_EA: trial.ea = value[k]; break;
      case VR_CP: trial.cp = value[k]; break;
      case VR_MASS: trial.massCell = value[k]; break;
      case VR_HCOOL: trial.hCool = value[k]; break;
      case VR_UAAMB: trial.uaAmb = value[k]; break;
      case VR_ENTROPY: trial.entropy = value[k]; break;
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
  if (k == fmi2LastSuccessfulTime && m) { *v = m->time; return fmi2OK; }
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

| Direction | Variable | Unit | Meaning |
|---|---|---|---|
${FMU_VARIABLES.map((v) => `| ${v.causality} | \`${v.name}\` | ${v.unit} | ${v.description} |`).join('\n')}

Parameters (set once at initialisation) are an explicit subset of the desktop
model coefficients. Calibrated R0/RC1 values are baked into both XML and binary
starts so the selected reduced plant is the one that runs inside your host:

${FMU_PARAMETERS.map((v) => `- \`${v.name}\` (${v.unit}) — ${v.description}`).join('\n')}

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
export function buildFmu({ cell, s, p, params = null, modelName = 'BatteryPack', generatedOn = '1970-01-01T00:00:00Z' }) {
  if (!validModelIdentifier(modelName)) {
    throw new TypeError('FMU modelName must start with a letter or underscore and contain only letters, numbers and underscores (64 characters maximum).');
  }
  const defaults = fmuParameterValues({ cell, s, p, params });
  const guid = fmuGuid({ cell, s, p, params, modelName });
  return {
    guid, modelName, standardVersion: FMI_STANDARD_VERSION, defaults,
    files: {
      'modelDescription.xml': modelDescriptionXml({ cell, s, p, params, modelName, guid, generatedOn }),
      [`sources/${modelName}.c`]: fmuSourceC({ modelName, guid, defaults }),
      'README.md': fmuReadme({ modelName, cell, s, p }),
    },
    note: 'A path-preserving source FMU build kit: complete, readable C that must be compiled and packaged for the target platform. It is not a loadable .fmu yet.',
  };
}
