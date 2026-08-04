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
// interface, and the C source that implements the FMI 2.0 co-simulation API
// around the same equivalent-circuit and thermal model as js/sim2.js. The
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

export const FMI_VERSION = '2.0';

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
  { name: 'r0_mOhm', unit: 'Ohm', description: 'Cell series resistance at reference temperature' },
  { name: 'rc1_mOhm', unit: 'Ohm', description: 'RC branch resistance' },
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

/** The FMI 2.0 modelDescription.xml — the contract the host tool reads. */
export function modelDescriptionXml({ cell, s, p, params = null, modelName = 'BatteryPack', guid = null, generatedOn = '1970-01-01T00:00:00Z' }) {
  const P = validateParams(params || defaultParams(cell)).params;
  // The GUID must match between the XML and the binary. It is derived from the
  // design so the same design always produces the same FMU — reproducible
  // builds matter when someone asks which pack a result came from.
  const id = guid || `bd-${s}s${p}p-${(cell.id || 'cell').replace(/[^a-z0-9]/gi, '')}`;
  let vr = 0;
  const next = () => ++vr;
  const paramValues = {
    cells_series: s, cells_parallel: p, capacity_Ah: cell.capacityAh,
    ocv_min: cell.vMin, ocv_max: cell.vMax,
    r0_mOhm: P.r0Ref, rc1_mOhm: P.rc1R, rc1_tau_s: P.rc1TauS, r0_Ea_J: P.r0EaJ,
    cp_cell: P.cpCellJkgK, mass_cell_kg: (cell.massG || 50) / 1000,
    h_cool_WK: P.hCoolWK, ua_amb_WK: P.uaAmbWK, entropy_VK: P.entropyVK,
  };
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
  description="Battery pack model exported by battery-design (AGPL-3.0-or-later). Equivalent circuit with RC dynamics and a lumped thermal node; the same model as js/sim2.js, with the same parameters."
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
    providesDirectionalDerivative="false"/>

  <UnitDefinitions>
    <Unit name="A"/><Unit name="V"/><Unit name="W"/><Unit name="degC"/>
    <Unit name="kg/s"/><Unit name="s"/><Unit name="1"/><Unit name="A.h"/>
    <Unit name="Ohm"/><Unit name="J/mol"/><Unit name="J/(kg.K)"/>
    <Unit name="kg"/><Unit name="W/K"/><Unit name="V/K"/>
  </UnitDefinitions>

  <ModelVariables>
${varLines.join('\n')}
  </ModelVariables>

  <ModelStructure>
    <Outputs>
${outputIdx.map(({ idx }) => `      <Unknown index="${idx}"/>`).join('\n')}
    </Outputs>
  </ModelStructure>
</fmiModelDescription>
`;
}

/**
 * The C source implementing FMI 2.0 co-simulation.
 *
 * Same physics as js/sim2.js, written plainly: no allocation in the step
 * function, no library dependencies, sub-stepped internally so the master can
 * take whatever macro step it likes without the RC or thermal state going
 * unstable.
 */
export function fmuSourceC({ modelName = 'BatteryPack', guid = 'bd-pack' } = {}) {
  return `/* ${modelName}.c — FMI 2.0 co-simulation battery pack.
 *
 * Generated by battery-design (AGPL-3.0-or-later). The physics matches js/sim2.js:
 * OCV + R0 + one RC branch with Arrhenius temperature dependence, irreversible
 * and reversible heat, and a lumped thermal node cooled by a coolant stream
 * through an epsilon-NTU effectiveness, plus loss to ambient.
 *
 * No dependencies beyond the C standard library and the FMI 2.0 headers.
 * Build: see README in this archive.
 */
#include <string.h>
#include <math.h>
#include <stdlib.h>
#include "fmi2Functions.h"

#define GUID "${guid}"
#define R_GAS 8.314462618
#define T0K   273.15
#define MAX_SUB_DT 0.01   /* internal sub-step: the master's step may be large */

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
  double soc, v1, tCell, time;
  /* outputs */
  double vPack, qLoss, vCellMin, pTerm;
  fmi2CallbackLogger logger;
  fmi2ComponentEnvironment env;
  char instanceName[256];
} Pack;

/* Open-circuit voltage of one cell: linear in SoC between the stated window.
 * The richer chemistry-shaped curve lives in the JS model; this is the shape
 * an FMU consumer can reason about, and it is stated rather than implied. */
static double ocv_cell(Pack *m, double soc) {
  if (soc < 0) { soc = 0; }
  if (soc > 1) { soc = 1; }
  return m->ocvMin + (m->ocvMax - m->ocvMin) * soc;
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

  m->v1 += (i * r1 - m->v1) * (dt / (m->tau > 1e-6 ? m->tau : 1e-6));
  m->vPack = ocv - m->v1 - i * r0;
  m->vCellMin = m->vPack / m->s;
  m->pTerm = m->vPack * i;

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
  double qOut = eff * capRate * (m->tCell - m->tAmb) + m->uaAmb * (m->tCell - m->tAmb);
  if (cth > 0) m->tCell += ((m->qLoss - qOut) * dt) / cth;
}

/* ---- FMI 2.0 co-simulation entry points ---- */

const char* fmi2GetTypesPlatform(void) { return fmi2TypesPlatform; }
const char* fmi2GetVersion(void) { return fmi2Version; }

fmi2Component fmi2Instantiate(fmi2String instanceName, fmi2Type fmuType,
    fmi2String fmuGUID, fmi2String resourceLocation,
    const fmi2CallbackFunctions *functions, fmi2Boolean visible, fmi2Boolean loggingOn) {
  (void)fmuType; (void)resourceLocation; (void)visible; (void)loggingOn;
  if (!fmuGUID || strcmp(fmuGUID, GUID) != 0) return NULL;
  Pack *m = (Pack *)calloc(1, sizeof(Pack));
  if (!m) return NULL;
  if (functions) { m->logger = functions->logger; m->env = functions->componentEnvironment; }
  if (instanceName) { strncpy(m->instanceName, instanceName, sizeof(m->instanceName) - 1); }
  /* Defaults; the master overwrites them through fmi2SetReal before init. */
  m->s = 96; m->p = 4; m->capAh = 4.9; m->ocvMin = 2.5; m->ocvMax = 4.2;
  m->r0 = 35; m->rc1 = 17; m->tau = 15; m->ea = 20000;
  m->cp = 1000; m->massCell = 0.07; m->hCool = 6; m->uaAmb = 2; m->entropy = -0.0002;
  m->tAmb = 25; m->flow = 0.05; m->soc = 1.0; m->tCell = 25;
  return m;
}

void fmi2FreeInstance(fmi2Component c) { if (c) free(c); }

fmi2Status fmi2SetupExperiment(fmi2Component c, fmi2Boolean toleranceDefined, fmi2Real tolerance,
    fmi2Real startTime, fmi2Boolean stopTimeDefined, fmi2Real stopTime) {
  (void)toleranceDefined; (void)tolerance; (void)stopTimeDefined; (void)stopTime;
  Pack *m = (Pack *)c; if (!m) return fmi2Error;
  m->time = startTime; return fmi2OK;
}

fmi2Status fmi2EnterInitializationMode(fmi2Component c) { (void)c; return fmi2OK; }

fmi2Status fmi2ExitInitializationMode(fmi2Component c) {
  Pack *m = (Pack *)c; if (!m) return fmi2Error;
  m->tCell = m->tAmb;
  m->vPack = ocv_cell(m, m->soc) * m->s;
  m->vCellMin = m->vPack / m->s;
  return fmi2OK;
}

fmi2Status fmi2Terminate(fmi2Component c) { (void)c; return fmi2OK; }
fmi2Status fmi2Reset(fmi2Component c) {
  Pack *m = (Pack *)c; if (!m) return fmi2Error;
  m->soc = 1.0; m->v1 = 0; m->tCell = m->tAmb; m->time = 0; return fmi2OK;
}

fmi2Status fmi2GetReal(fmi2Component c, const fmi2ValueReference vr[], size_t nvr, fmi2Real value[]) {
  Pack *m = (Pack *)c; if (!m) return fmi2Error;
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
  Pack *m = (Pack *)c; if (!m) return fmi2Error;
  for (size_t k = 0; k < nvr; k++) {
    switch (vr[k]) {
      case VR_I: m->iPack = value[k]; break;
      case VR_TAMB: m->tAmb = value[k]; break;
      case VR_FLOW: m->flow = value[k]; break;
      case VR_S: m->s = value[k]; break;
      case VR_P: m->p = value[k]; break;
      case VR_CAP: m->capAh = value[k]; break;
      case VR_OCVMIN: m->ocvMin = value[k]; break;
      case VR_OCVMAX: m->ocvMax = value[k]; break;
      case VR_R0: m->r0 = value[k]; break;
      case VR_RC1: m->rc1 = value[k]; break;
      case VR_TAU: m->tau = value[k]; break;
      case VR_EA: m->ea = value[k]; break;
      case VR_CP: m->cp = value[k]; break;
      case VR_MASS: m->massCell = value[k]; break;
      case VR_HCOOL: m->hCool = value[k]; break;
      case VR_UAAMB: m->uaAmb = value[k]; break;
      case VR_ENTROPY: m->entropy = value[k]; break;
      default: return fmi2Error;
    }
  }
  return fmi2OK;
}

fmi2Status fmi2DoStep(fmi2Component c, fmi2Real currentCommunicationPoint,
    fmi2Real communicationStepSize, fmi2Boolean noSetFMUStatePriorToCurrentPoint) {
  (void)noSetFMUStatePriorToCurrentPoint;
  Pack *m = (Pack *)c; if (!m) return fmi2Error;
  if (communicationStepSize < 0) return fmi2Error;
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
  return `# ${modelName} — an FMI ${FMI_VERSION} co-simulation FMU

Exported by battery-design (AGPL-3.0-or-later). This is the ${s}S${p}P pack of
${cell?.name || 'the selected cell'} as a component you can drop into
ANSYS Twin Builder, Simulink, GT-SUITE, Dymola, OpenModelica, or any other
tool that speaks FMI.

## The coupling

Your model tells the pack what it is drawing; the pack answers with what that
costs it.

| Direction | Variable | Unit | Meaning |
|---|---|---|---|
${FMU_VARIABLES.map((v) => `| ${v.causality} | \`${v.name}\` | ${v.unit} | ${v.description} |`).join('\n')}

Parameters (set once at initialisation) are the same coefficients the desktop
model uses, so **a model calibrated against your own measurements is the model
that runs inside your host tool**:

${FMU_PARAMETERS.map((v) => `- \`${v.name}\` (${v.unit}) — ${v.description}`).join('\n')}

## Building it

This is a SOURCE FMU: the C is complete and dependency-free, but you compile it
for your own platform. Put the FMI 2.0 headers (\`fmi2Functions.h\`,
\`fmi2FunctionTypes.h\`, \`fmi2TypesPlatform.h\`, from the FMI standard) beside
the source, then:

    # Linux
    cc -O2 -fPIC -shared -I. ${modelName}.c -o binaries/linux64/${modelName}.so -lm
    # macOS
    cc -O2 -fPIC -shared -I. ${modelName}.c -o binaries/darwin64/${modelName}.dylib -lm
    # Windows (MSVC)
    cl /O2 /LD /I. ${modelName}.c /Fe:binaries/win64/${modelName}.dll

Then zip \`modelDescription.xml\`, \`binaries/\` and \`sources/\` into
\`${modelName}.fmu\`.

## What this model is

Equivalent circuit — OCV + R0 + one RC branch, Arrhenius temperature
dependence — with irreversible and reversible (entropic) heat into a lumped
thermal node cooled by an ε-NTU coolant stream and loss to ambient. It
sub-steps internally at 10 ms, so your master can take whatever macro step it
likes without destabilising the RC or thermal states.

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
  const guid = `bd-${s}s${p}p-${(cell.id || 'cell').replace(/[^a-z0-9]/gi, '')}`;
  return {
    guid, modelName,
    files: {
      'modelDescription.xml': modelDescriptionXml({ cell, s, p, params, modelName, guid, generatedOn }),
      [`sources/${modelName}.c`]: fmuSourceC({ modelName, guid }),
      'README.md': fmuReadme({ modelName, cell, s, p }),
    },
    note: 'A source FMU: complete, readable C that you compile for your own platform. No binary is shipped that you cannot reproduce.',
  };
}
