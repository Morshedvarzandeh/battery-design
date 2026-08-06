# FMI 2.0.5 build contract

This directory pins the official Modelica Association FMI 2.0.5 C headers and
XML Schema used to compile and validate battery-design FMUs. They are build
inputs; the standard headers are not declared as model-owned FMU sources.

- Upstream: <https://github.com/modelica/fmi-standard>
- Tag: `v2.0.5`
- Annotated tag object: `3982541be7f4b3a4ce05f009f7c573705f4ecb68`
- Dereferenced commit: `913d6b6908f6e6f59457bf299e875f17c818b921`
- Retrieved: 2026-08-06

Every vendored file retains the upstream copyright and BSD-2-Clause notice.
The generated battery model remains AGPL-3.0-or-later; the FMI standard's
permissive license does not relicense the model implementation.

`SHA256SUMS` is checked in tests so a silent standards-input change cannot
alter the ABI or validation contract.
