#!/usr/bin/env node
// Generate the human-readable FMI signal map and commercial-host acceptance
// record from the same immutable scalar contract used by the FMU. The checked-
// in Markdown is reviewable release documentation, but it is never a second
// hand-maintained interface definition.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FMI_IO_CONTRACT,
  FMI_IO_CONTRACT_CHECKSUM,
  FMI_IO_CONTRACT_FORMAT,
  FMI_IO_CONTRACT_VERSION,
} from '../js/fmi-signal-map.js';

export const FMI_SIGNAL_DOCUMENT_FORMAT = 'battery-design/fmi-signal-document@1';
export const FMI_HOST_MAPPING_FORMAT = 'battery-design/fmi-host-mapping@1';

const SIGNAL_MAP_URL = new URL('../docs/FMI_SIGNAL_MAP.md', import.meta.url);
const ACCEPTANCE_URL = new URL('../docs/FMI_COMMERCIAL_ACCEPTANCE.md', import.meta.url);

const PROPRIETARY_HOSTS = Object.freeze([
  'ANSYS Twin Builder',
  'MATLAB/Simulink',
  'GT-SUITE',
  'Other',
]);

const CONTRACT_COUNTS = Object.freeze({
  parameters: FMI_IO_CONTRACT.filter(({ causality }) => causality === 'parameter').length,
  inputs: FMI_IO_CONTRACT.filter(({ causality }) => causality === 'input').length,
  outputs: FMI_IO_CONTRACT.filter(({ causality }) => causality === 'output').length,
});

function markdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function code(value) {
  return `\`${markdown(value)}\``;
}

function startText(variable) {
  if (variable.startPolicy === 'resolved') return 'design-bound';
  if (variable.startPolicy === 'calculated') return 'calculated';
  return code(variable.start);
}

function constraintText(variable) {
  const constraints = [];
  if (variable.min != null) constraints.push(`>= ${variable.min}`);
  if (variable.max != null) constraints.push(`<= ${variable.max}`);
  if (variable.exclusiveMinimum != null) constraints.push(`> ${variable.exclusiveMinimum}`);
  if (variable.greaterThan) constraints.push(`> ${variable.greaterThan}`);
  return constraints.length ? constraints.join('; ') : 'finite';
}

function contractIdentityLines() {
  return [
    `- Document format: ${code(FMI_SIGNAL_DOCUMENT_FORMAT)}`,
    `- Scalar contract format: ${code(FMI_IO_CONTRACT_FORMAT)}`,
    `- Scalar contract version: ${code(FMI_IO_CONTRACT_VERSION)}`,
    `- Scalar contract SHA-256: ${code(FMI_IO_CONTRACT_CHECKSUM)}`,
    '- FMI interface: `2.0` Co-Simulation (`Real` scalars only)',
  ];
}

function variableTable(variables, { includeSource = false } = {}) {
  const header = includeSource
    ? '| VR | Stable role | FMI name | Unit | Display | Start | Constraint | Design/model binding | Meaning and sign |\n'
      + '|---:|---|---|---|---|---|---|---|---|'
    : '| Direction | VR | Stable role | FMI name | Unit | Display | Start | Meaning and sign |\n'
      + '|---|---:|---|---|---|---|---|---|';
  const rows = variables.map((variable) => {
    const meaning = `${variable.description} ${variable.signConvention}`;
    const displayUnit = variable.displayUnit == null ? '—' : code(variable.displayUnit);
    if (includeSource) {
      return `| ${variable.valueReference} | ${code(variable.role)} | ${code(variable.name)} | ${code(variable.unit)} | ${displayUnit} | ${startText(variable)} | ${markdown(constraintText(variable))} | ${code(variable.sourceBinding)} | ${markdown(meaning)} |`;
    }
    const direction = variable.causality === 'input' ? 'Host -> FMU' : 'FMU -> Host';
    return `| ${direction} | ${variable.valueReference} | ${code(variable.role)} | ${code(variable.name)} | ${code(variable.unit)} | ${displayUnit} | ${startText(variable)} | ${markdown(meaning)} |`;
  });
  return [header, ...rows].join('\n');
}

function hostNeutralMappingTable() {
  const runtime = FMI_IO_CONTRACT.filter(({ causality }) => causality !== 'parameter');
  const lines = [
    '| Mapping ID | Host responsibility | FMI port | VR | Unit / display | Conversion policy |',
    '|---|---|---|---:|---|---|',
  ];
  for (const variable of runtime) {
    const responsibility = variable.causality === 'input'
      ? `Write ${code(variable.role)} before each communication step and hold it over the step.`
      : `Read ${code(variable.role)} after initialization and each successful communication step.`;
    const unit = variable.displayUnit == null
      ? code(variable.unit)
      : `${code(variable.unit)} / ${code(variable.displayUnit)}`;
    lines.push(`| ${code(`runtime.${variable.role}`)} | ${responsibility} | ${code(variable.name)} | ${variable.valueReference} | ${unit} | Explicit only; preserve the documented sign and do not rely on an implicit host conversion. |`);
  }
  return lines.join('\n');
}

function acceptanceRuntimeTable() {
  const runtime = FMI_IO_CONTRACT.filter(({ causality }) => causality !== 'parameter');
  return [
    '| Direction | FMI name | VR | Unit | Display | Acceptance check |',
    '|---|---|---:|---|---|---|',
    ...runtime.map((variable) => {
      const direction = variable.causality === 'input' ? 'Host -> FMU' : 'FMU -> Host';
      const displayUnit = variable.displayUnit == null ? '—' : code(variable.displayUnit);
      return `| ${direction} | ${code(variable.name)} | ${variable.valueReference} | ${code(variable.unit)} | ${displayUnit} | ${markdown(variable.signConvention)} |`;
    }),
  ].join('\n');
}

export function generatedFmiSignalMapMarkdown() {
  const parameters = FMI_IO_CONTRACT.filter(({ causality }) => causality === 'parameter');
  const runtime = FMI_IO_CONTRACT.filter(({ causality }) => causality !== 'parameter');
  return `# FMI enterprise signal map

> Generated by \`node tools/generate-fmi-signal-docs.mjs --write\` from
> \`js/fmi-signal-map.js\`. Do not edit this file by hand. Validate it with
> \`node tools/generate-fmi-signal-docs.mjs --check\`.

This is the stable, host-facing scalar contract for the battery-design FMI 2.0
Co-Simulation component. Value references are an append-only ABI: existing
references must not be renamed or renumbered. A contract-version or checksum
change requires a new host-mapping review.

## Contract identity

${contractIdentityLines().join('\n')}

The checked-in document describes the generic ABI. Every exported FMU also
contains \`resources/battery-design-io-map.json\`, which binds this contract to
that artifact's GUID, revision and fixed parameter starts.

## Fixed parameters

The host may set these parameters during instantiation or initialization. They
are fixed after initialization. A governed DesignSpec export resolves their
starts from one validated design and the reduced-model coefficients; the XML,
generated C defaults and machine I/O map carry the same values.

${variableTable(parameters, { includeSource: true })}

## Runtime ports

Inputs are written by the co-simulation master before a communication step and
held over that step. Outputs are read-only and are recalculated on reset,
initialization exit and each successful communication step.

${variableTable(runtime)}

## Versioned host mapping matrix

- Mapping format: ${code(FMI_HOST_MAPPING_FORMAT)}
- Mapping revision: \`1\`
- Applies to scalar contract: ${code(`${FMI_IO_CONTRACT_FORMAT}/${FMI_IO_CONTRACT_VERSION}`)}
- Applies to contract checksum: ${code(FMI_IO_CONTRACT_CHECKSUM)}

The matrix is deliberately host-neutral. Twin Builder, Simulink, GT-SUITE and
other FMI 2.0 masters consume the names and value references declared in
\`modelDescription.xml\`; product UI labels or adapters may differ. Those local
labels must be recorded in the product/version-specific acceptance evidence,
not added as an unverified second signal contract here.

${hostNeutralMappingTable()}

## Static design/layout data is not a runtime port

\`resources/battery-design-design.json\` is the immutable design snapshot bound
to the FMU GUID. It records the source kind and completeness, DesignSpec and
semantic checksums, cell/application identity, S/P architecture, module
partition, mass, energy, resistance, voltage range, dimensions, layout summary
and selected component IDs. It is provenance for the exported plant and may be
read as a resource by tooling.

That JSON resource is not an FMI scalar interface, is not updated while the
component steps, and must not be mistaken for live telemetry. Runtime coupling
uses only the ${CONTRACT_COUNTS.inputs} inputs and ${CONTRACT_COUNTS.outputs} outputs above. Adding a live layout,
module-temperature or BMS-register signal requires an appended, versioned FMI
contract variable.

## Reduced-plant and thermal-boundary semantics

The component is a system-level reduced plant: linear cell OCV between the
declared voltage limits, R0 plus one RC polarization branch, and Arrhenius
temperature dependence. It is not a P2D electrochemical, degradation, cell-
imbalance, CFD or spatial thermal model. \`V_cell_min\` is therefore the uniform
estimate \`V_pack / cells_series\`, not a resolved minimum across cells.

There is one representative lumped temperature state, \`T_cell\`. The
\`h_cool_WK\` parameter is the total pack-to-coolant conductance in this
reduction; it is not a per-module value and is not multiplied by module count.
\`ua_amb_WK\` is total pack-to-ambient conductance. \`T_ambient\` supplies both
the ambient and current coolant-inlet reference. \`coolant_flow\` is a
non-negative forward mass-flow magnitude: zero disables coolant heat removal,
while positive flow is reduced through a finite-capacity-rate epsilon-NTU
boundary. \`Q_loss\` is the net internal heat source, including irreversible
losses and signed reversible entropic heat, so it can be negative.

## Change control

1. Change the canonical descriptors only in \`js/fmi-signal-map.js\`.
2. Append new value references; never reuse or renumber a published reference.
3. Regenerate these documents and the artifact machine map.
4. Run contract, native lifecycle and packaging tests.
5. Repeat every product/version-specific commercial-host acceptance record for
   the new contract checksum and exact FMU SHA-256.
`;
}

export function generatedFmiCommercialAcceptanceMarkdown() {
  return `# FMI commercial-host acceptance

> Generated by \`node tools/generate-fmi-signal-docs.mjs --write\` from
> \`js/fmi-signal-map.js\`. Do not edit this file by hand. Validate it with
> \`node tools/generate-fmi-signal-docs.mjs --check\`.

This document records evidence for one exact \`battery-design-ev.fmu\`.
Open-source validation is not vendor certification and does not prove
acceptance in an untested proprietary product and version. The published
baseline below contains no proprietary-host acceptance evidence.

For an actual proprietary-host trial, copy this generated baseline into an
artifact-specific evidence record and fill that copy. Keep this checked-in
baseline generated so documentation cannot silently redefine the scalar ABI.

## Contract and artifact identity

- Host mapping format: ${code(FMI_HOST_MAPPING_FORMAT)}
- Host mapping revision: \`1\`
- Scalar contract format: ${code(FMI_IO_CONTRACT_FORMAT)}
- Scalar contract version: ${code(FMI_IO_CONTRACT_VERSION)}
- Scalar contract SHA-256: ${code(FMI_IO_CONTRACT_CHECKSUM)}
- Release tag:
- Git commit:
- FMU SHA-256:
- FMI GUID:
- Model identifier:
- Model revision:
- Included platforms:
- Reviewer and date:

Any changed SHA-256, GUID, binary, model description, scalar-contract checksum
or mapping revision requires a new record. Do not copy a verdict between
artifacts or product versions.

## Automated release evidence

| Gate | \`linux64\` | \`win64\` | Evidence |
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

## Runtime signal contract checked

${acceptanceRuntimeTable()}

Confirm exact names, value references, units, sign convention, initialization
and communication step explicitly in every host model. Confirm all ${CONTRACT_COUNTS.parameters} fixed
parameters against the generated [enterprise signal map](FMI_SIGNAL_MAP.md).

The FMU is a reduced one-RC, one-node lumped-thermal plant. \`T_ambient\` is
also the coolant inlet reference; \`coolant_flow\` is non-negative; and
\`h_cool_WK\` is a total pack conductance. It is not P2D electrochemistry, a
cell-imbalance model or CFD. The separate
\`resources/battery-design-design.json\` resource is a static design/layout
snapshot, not live FMI telemetry.

## Proprietary host mapping and evidence matrix

Every row is pinned to mapping ${code(`${FMI_HOST_MAPPING_FORMAT} revision 1`)},
scalar contract ${code(FMI_IO_CONTRACT_VERSION)} and checksum
${code(FMI_IO_CONTRACT_CHECKSUM)}. Replace the result only when the exact
product/version, OS and FMU SHA-256 evidence fields are complete.

| Host | Mapping contract | Exact version | OS | Import | Step | Reset/reopen | Result | Evidence |
|---|---|---|---|---|---|---|---|---|
${PROPRIETARY_HOSTS.map((host) => `| ${host} | v1 / contract ${FMI_IO_CONTRACT_VERSION} | | | | | | Not run | |`).join('\n')}

For each host:

- [ ] Start from a clean project and import the exact FMU SHA-256.
- [ ] Record every importer warning and error.
- [ ] Confirm FMI 2.0 Co-Simulation and the expected model identifier/GUID.
- [ ] Confirm scalar-contract version/checksum and host-mapping revision.
- [ ] Confirm all ${CONTRACT_COUNTS.parameters} parameters, ${CONTRACT_COUNTS.inputs} inputs and ${CONTRACT_COUNTS.outputs} outputs by exact name, VR,
      causality and unit.
- [ ] Record the host-side label or adapter for each runtime mapping ID.
- [ ] Map the ${CONTRACT_COUNTS.inputs} inputs and ${CONTRACT_COUNTS.outputs} outputs without implicit unit or sign
      conversion.
- [ ] Initialize at declared/bound starts and record the initial outputs.
- [ ] Run a fixed zero-current case.
- [ ] Run positive discharge and negative charge cases; check voltage, SoC,
      terminal power, heat and temperature direction.
- [ ] Change ambient temperature and coolant flow and check the expected
      reduced thermal response.
- [ ] Confirm \`V_cell_min = V_pack / cells_series\`; do not treat it as a
      measured cell minimum.
- [ ] Reset or reinstantiate and reproduce the initial state.
- [ ] Save, close, reopen and reproduce the test.
- [ ] Attach host logs, settings, result CSV and screenshots.
- [ ] Record reviewer, date and Accepted / Failed / Blocked verdict.

## Allowed claims

After automated gates pass:

> Open-source FMI 2.0 schema, ABI, lifecycle and import-and-step checks passed
> with fmusim and FMPy on \`linux64\` and \`win64\`.

After a named host row passes:

> Imported and stepped successfully in [product] [exact version] on [OS] using
> FMU SHA-256 [digest], scalar contract ${FMI_IO_CONTRACT_VERSION} and host
> mapping revision 1.

Do not use “vendor-certified,” “certified compatible,” or an unqualified
“works with Twin Builder/Simulink/GT-SUITE” without corresponding vendor or
product/version-specific evidence.
`;
}

export function validatePublishedFmiSignalDocs({
  signalMapText = readFileSync(SIGNAL_MAP_URL, 'utf8'),
  acceptanceText = readFileSync(ACCEPTANCE_URL, 'utf8'),
} = {}) {
  const errors = [];
  if (signalMapText !== generatedFmiSignalMapMarkdown()) {
    errors.push('docs/FMI_SIGNAL_MAP.md drifted from js/fmi-signal-map.js; run node tools/generate-fmi-signal-docs.mjs --write');
  }
  if (acceptanceText !== generatedFmiCommercialAcceptanceMarkdown()) {
    errors.push('docs/FMI_COMMERCIAL_ACCEPTANCE.md drifted from js/fmi-signal-map.js; run node tools/generate-fmi-signal-docs.mjs --write');
  }
  return errors;
}

function parseMode(argv) {
  const modes = argv.filter((arg) => arg === '--write' || arg === '--check');
  const unknown = argv.filter((arg) => arg !== '--write' && arg !== '--check');
  if (unknown.length || modes.length !== 1 || new Set(modes).size !== modes.length) {
    throw new TypeError('Usage: node tools/generate-fmi-signal-docs.mjs (--write | --check)');
  }
  return modes[0];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const mode = parseMode(process.argv.slice(2));
    if (mode === '--write') {
      writeFileSync(SIGNAL_MAP_URL, generatedFmiSignalMapMarkdown());
      writeFileSync(ACCEPTANCE_URL, generatedFmiCommercialAcceptanceMarkdown());
      process.stdout.write('Generated FMI signal-map documentation.\n');
    } else {
      const errors = validatePublishedFmiSignalDocs();
      if (errors.length) throw new Error(errors.join('\n'));
      process.stdout.write('FMI signal-map documentation is current.\n');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
