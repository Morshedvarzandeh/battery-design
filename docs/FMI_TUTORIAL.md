# FMI signal contract tutorial

This tutorial introduces the battery-design FMI 2.0 Co-Simulation component's
scalar interface to developers who have not previously used FMI. It walks
through the component's role, the value-reference mechanism, the append-only
ABI discipline, the generated-documentation workflow, and a worked coupling
example.

This tutorial is hand-written. The generated [FMI signal map](FMI_SIGNAL_MAP.md)
is the authoritative scalar contract. If this page and that map ever disagree,
the signal map is correct.

## What the component is

The battery-design export is an FMI 2.0 Co-Simulation battery pack plant. It
is a system-level reduced model, not a detailed electrochemical or spatial
thermal simulation. The component exchanges only `Real` scalars:

- 3 runtime inputs: pack terminal current, ambient temperature, and coolant
  mass flow.
- 6 runtime outputs: pack terminal voltage, state of charge, representative
  cell temperature, net internal heat source, a uniform cell-voltage estimate,
  and terminal power.
- 14 fixed parameters: cell and pack topology counts, rated capacity, voltage
  and resistance characteristics, thermal properties, and reduced-model
  coefficients.

The co-simulation master writes the three inputs before each communication
step, advances the component through that step, and reads the six outputs. The
fourteen parameters are set during instantiation or initialization and are
fixed after initialization.

The reduced plant uses a linear open-circuit-voltage curve between the declared
voltage limits, one series resistance plus one RC polarization branch, and an
Arrhenius temperature dependence. There is one representative lumped
temperature state for the entire pack.

## How value references work

Every scalar variable in the FMI component has:

1. A stable integer value reference (VR).
2. A stable role string that documents its semantic binding (for example
   `battery.pack.terminalVoltage`).
3. A short FMI name used in the XML and host bindings (for example `V_pack`).
4. A unit (for example `V` or `A`).
5. A documented sign convention.

The co-simulation master addresses scalars by the FMI names and value
references declared in `modelDescription.xml`. For example, the pack terminal
current is:

- VR 15
- Stable role `battery.pack.terminalCurrent`
- FMI name `I_pack`
- Unit `A`
- Sign convention: positive current discharges the pack and leaves its positive
  terminal; negative current charges it.

Similarly, pack terminal voltage is VR 18, stable role
`battery.pack.terminalVoltage`, FMI name `V_pack`, unit `V`, and is positive
from the pack negative terminal to its positive terminal.

The complete mapping of all 17 scalar variables (14 fixed parameters and 3
inputs and 6 outputs) is maintained in the [FMI signal map](FMI_SIGNAL_MAP.md).

## The append-only ABI rule

Published value references are never renamed, renumbered or reused. This is an
append-only ABI. New signals are appended to the end of the contract. If an
existing signal is retired, its value reference is marked as reserved and is
not assigned to a new variable.

Every published version of the scalar contract is identified by a contract
version and a SHA-256 checksum. The contract version uses semantic versioning
(for example `1.0.0`). The checksum is a cryptographic hash of the complete
signal descriptors. Any change to a signal's VR, role, name, unit, constraint,
start value, or sign convention changes the checksum.

Changing the scalar contract version or checksum requires that all host-mapping
reviews be repeated. This is an intentional control gate: the host coupling
code and the product-specific acceptance evidence must be reverified for the
new contract.

The [FMI signal map](FMI_SIGNAL_MAP.md) documents the five change-control
steps:

1. Change the canonical descriptors only in `js/fmi-signal-map.js`.
2. Append new value references; never reuse or renumber a published reference.
3. Regenerate these documents and the artifact machine map.
4. Run contract, native lifecycle and packaging tests.
5. Repeat every product-specific and version-specific commercial-host
   acceptance record for the new contract checksum and exact FMU SHA-256.

This discipline prevents silent contract drift and ensures that every host
integration is validated against the exact binary and scalar ABI it will
consume.

## Validating the generated docs

The signal map and commercial-acceptance documents are generated from
`js/fmi-signal-map.js`. That JavaScript module is the single source of truth
for the scalar descriptors. The documents are regenerated with:

```bash
node tools/generate-fmi-signal-docs.mjs --write
```

To verify that the checked-in documents match the canonical source and have not
been edited by hand, run:

```bash
node tools/generate-fmi-signal-docs.mjs --check
```

If the check fails, it means either the documents were edited directly (which
violates the single-source-of-truth discipline) or `js/fmi-signal-map.js` was
changed and the documents were not regenerated. The correct fix is to
regenerate from the canonical source.

Every exported FMU also contains `resources/battery-design-io-map.json`, a
machine-readable JSON binding of the contract to that artifact's GUID, model
revision, and fixed-parameter start values.

## Worked example: reading a signal

The following C snippet uses the FMI 2.0 Co-Simulation API to set the input
`I_pack` (VR 15), advance one communication step, and read the output `V_pack`
(VR 18).

```c
#include "fmi2Functions.h"

/* Assume 'component' is a valid fmi2Component from a prior fmi2Instantiate call,
   and the component has been initialized. */

fmi2Real packCurrent = 50.0;  /* 50 A discharge */
fmi2Real packVoltage = 0.0;
fmi2ValueReference vrCurrent = 15;
fmi2ValueReference vrVoltage = 18;
fmi2Real stepSize = 1.0;      /* 1 second communication step */
fmi2Status status;

/* Write the pack terminal current input before the step. */
status = fmi2SetReal(component, &vrCurrent, 1, &packCurrent);
if (status != fmi2OK) {
    /* handle error */
}

/* Advance the component by one communication step. */
fmi2Real currentTime = 0.0;
status = fmi2DoStep(component, currentTime, stepSize, fmi2True);
if (status != fmi2OK) {
    /* handle error */
}

/* Read the pack terminal voltage output after the step. */
status = fmi2GetReal(component, &vrVoltage, 1, &packVoltage);
if (status != fmi2OK) {
    /* handle error */
}

/* packVoltage now contains the terminal voltage under the applied 50 A
   discharge current and the component's internal state. */
```

### Interpreting sign conventions

The pack terminal current `I_pack` follows the discharge-positive convention:
positive current discharges the pack and leaves its positive terminal; negative
current charges it. A 50 A discharge will decrease `SoC` and, under typical
operating conditions, produce a terminal voltage `V_pack` lower than the
open-circuit voltage due to the resistive voltage drop.

The net internal heat source `Q_loss` includes both irreversible resistive
losses and signed reversible entropic heat. It is positive when it heats the
lumped cell node. Because the reversible heat term is signed by the entropic
coefficient `entropy_VK` and the current direction, `Q_loss` can be negative
under some conditions.

State of charge `SoC` is a dimensionless fraction from 0 (empty) to 1 (full).
It may also be displayed as a percentage. Discharge current decreases it and
charge current increases it.

The representative cell temperature `T_cell` is reported in degrees Celsius.
The component internally converts it to absolute temperature for its thermal
and electrochemical calculations, but the FMI interface uses `degC` for
consistency with common co-simulation practice.
