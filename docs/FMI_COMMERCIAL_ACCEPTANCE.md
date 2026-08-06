# FMI commercial-host acceptance

This document records evidence for one exact `battery-design-ev.fmu`.
Open-source validation is not vendor certification and does not prove acceptance
in an untested proprietary product and version.

## Artifact identity

- Release tag:
- Git commit:
- FMU SHA-256:
- FMI GUID:
- Model identifier:
- Model revision:
- Included platforms:
- Reviewer and date:

Any changed SHA-256, GUID, binary or model description requires a new record.

## Automated release evidence

| Gate | `linux64` | `win64` | Evidence |
|---|---|---|---|
| FMI 2.0.5 XSD validation | Pending | Pending | CI run/link |
| Required 34-symbol Co-Simulation ABI | Pending | Pending | CI run/link |
| Architecture and dependency inspection | Pending | Pending | CI run/link |
| Deterministic rebuild | Pending | Pending | CI run/link |
| Native lifecycle/reset/two-instance smoke | Pending | Pending | CI run/link |
| fmusim validate and import/step | Pending | Pending | CI run/link |
| FMPy validate and import/step | Pending | Pending | CI run/link |
| Finite outputs and physical invariants | Pending | Pending | CI run/link |

Mark a cell Passed only from the matching native operating-system run.

## Signal contract checked

Inputs:

- `I_pack` [A], positive on discharge
- `T_ambient` [degC]
- `coolant_flow` [kg/s]

Outputs:

- `V_pack` [V]
- `SoC` [1]
- `T_cell` [degC], representative lumped-node temperature
- `Q_loss` [W]
- `V_cell_min` [V], uniform-cell estimate rather than a resolved minimum
- `P_terminal` [W]

Confirm unit conversion, sign convention and sample period explicitly in every
host model. The FMU is a reduced one-RC, lumped-thermal plant; it is not P2D
electrochemistry or CFD.

## Proprietary host matrix

| Host | Exact version | OS | Import | Step | Reset/reopen | Result | Evidence |
|---|---|---|---|---|---|---|---|
| ANSYS Twin Builder | | | | | | Not run | |
| MATLAB/Simulink | | | | | | Not run | |
| GT-SUITE | | | | | | Not run | |
| Other | | | | | | Not run | |

For each host:

- [ ] Start from a clean project and import the exact FMU SHA-256.
- [ ] Record every importer warning and error.
- [ ] Confirm FMI 2.0 Co-Simulation and the expected model identifier/GUID.
- [ ] Confirm all parameters, variables, units and causality.
- [ ] Map the three inputs and six outputs without implicit unit conversion.
- [ ] Initialize at declared starts and record the initial outputs.
- [ ] Run a fixed zero-current case.
- [ ] Run a fixed positive-discharge case and check voltage, SoC, heat and temperature direction.
- [ ] Change ambient temperature and coolant flow and check the expected thermal response.
- [ ] Reset or reinstantiate and reproduce the initial state.
- [ ] Save, close, reopen and reproduce the test.
- [ ] Attach host logs, settings, result CSV and screenshots.
- [ ] Record reviewer, date and Accepted / Failed / Blocked verdict.

## Allowed claims

After automated gates pass:

> Open-source FMI 2.0 schema, ABI, lifecycle and import-and-step checks passed
> with fmusim and FMPy on `linux64` and `win64`.

After a named host row passes:

> Imported and stepped successfully in [product] [exact version] on [OS] using
> FMU SHA-256 [digest].

Do not use “vendor-certified,” “certified compatible,” or an unqualified
“works with Twin Builder/Simulink/GT-SUITE” without corresponding vendor or
product/version-specific evidence.
