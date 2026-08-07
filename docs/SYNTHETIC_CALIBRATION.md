# Governed synthetic calibration data

This workflow brings an external time trace into the existing battery-design
equivalent-circuit/lumped-thermal calibrator without guessing what any source
column means. It is a vendor-neutral ingestion path: one explicit mapping is
normalized into one immutable `battery-design/calibration-dataset@1` snapshot,
and the optimizer consumes only that snapshot.

It does not make battery-design a P2D electrochemistry solver or a CFD solver.
It also does not establish compatibility with a named commercial product merely
because a caller writes that product's name into source metadata.

## What is shipped

- A closed, versioned calibration-dataset schema in
  `js/calibration-dataset.js`.
- A closed, versioned import-mapping schema in `js/calibration-import.js`.
- Exact delimited-column and columnar-JSON adapters. There is no alias or unit
  guessing.
- Explicit time, sign, voltage-location and temperature-location conventions.
- Deterministic, reported preprocessing for long traces.
- Bounded, exactly counted optimizer evaluations and integration steps in
  `js/sim2.js`.
- Source/staged runner CLI and authenticated loopback-API calibration
  surfaces. There is no installed shell-command wrapper, calibration button
  in the desktop GUI or MCP calibration tool.

One dataset is one explicitly rested state-reset trial. A joint fit can accept up to eight
compatible trials. Every trial must bind the same non-null catalog cell, S/P
and module topology; starting SoC and ambient temperature may differ by trial
and are taken from each immutable dataset binding. This makes multi-context
ingestion possible without adding a new tuning strategy in this phase.

## Normalize a source trace

The mapping is the engineering statement that gives the source columns their
meaning. The example below intentionally uses neutral column names; replace
them with the exact names in the export being ingested.

```js
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importCalibrationDataset,
  materializeCalibrationImportMapping,
} from './js/calibration-import.js';

const mapping = materializeCalibrationImportMapping({
  adapter: 'delimited-columns',
  delimiter: ',',
  dataset: {
    id: 'solver-run-0042',
    kind: 'synthetic',
    purpose: 'calibration',
  },
  source: {
    tool: 'External high-fidelity solver',
    toolVersion: null,
    model: 'identified-cell-model',
    runId: 'run-0042',
    generatedAt: null,
  },
  binding: {
    cellId: 'eve-lf280k',
    seriesCells: 96,
    parallelCells: 4,
    startSoC: 0.9,
    ambientC: 25,
    moduleCount: 8,
    initialState: 'rested-equilibrium-at-ambient',
  },
  columns: {
    time: 'time',
    current: 'pack_current',
    voltage: 'pack_voltage',
    temperature: 'module_max_temperature',
  },
  units: {
    time: 's',
    current: 'A',
    voltage: 'V',
    temperature: 'degC',
  },
  sourceCurrentPositive: 'discharge',
  sourceCurrentScope: 'pack',
  sourceVoltageLocation: 'pack-terminal',
  sourceTemperatureLocation: 'module-maximum',
  sourceSampleAlignment: 'end-of-step',
  sourceFirstSampleTimeS: 0,
  timeToleranceS: 1e-9,
  segments: null,
});

const source = readFileSync('solver-run-0042.csv', 'utf8');
const dataset = importCalibrationDataset(source, mapping);
writeFileSync('solver-run-0042.mapping.json',
  `${JSON.stringify(mapping, null, 2)}\n`);
writeFileSync('solver-run-0042.calibration.json',
  `${JSON.stringify(dataset, null, 2)}\n`);
```

The CLI mapping file is the complete materialized mapping, including its
`format`, `schemaVersion` and `checksum`. It does not accept an unchecked
partial payload or guess a missing mapping.

`canonical-json` is also available when the source is one JSON object whose
mapped properties are equal-length numeric arrays. It is an adapter for raw
columns, not permission to submit an arbitrary JSON shape.

### Supported source conventions

| Quantity | Accepted source declaration | Canonical dataset convention |
|---|---|---|
| Time | `s`, `ms`, `min`; exact first-sample time declared in seconds | Uniform period; origin is the trial reset one period before sample zero |
| Current | `A`, `mA`, `kA`; cell or pack scope; positive on charge or discharge | Pack A, positive on discharge |
| Voltage | `V`, `mV`, `kV`; cell or pack terminal | V at pack terminal |
| Temperature | `degC`, `K`, `degF`, or absent | °C at one declared location, or absent |
| Sample phase | Explicitly declared `end-of-step`; unknown/start phase is rejected | End of step, zero-order current hold |

Cell-terminal voltage is multiplied by the declared series-cell count. A
cell-scoped current is multiplied by the declared parallel-cell count, and a
charge-positive source current is negated. These are recorded conversions, not
heuristics. A temperature column, its unit and its physical location must be
declared together or all be absent.

`sourceFirstSampleTimeS` must match the first converted timestamp. Because the
only accepted source phase is end-of-step, the canonical trial reset is exactly
one sample period earlier; both source time and derived reset time are preserved
in normalization provenance. Merely having uniform timestamps is not enough:
an export whose phase is unknown or start-of-step must be converted and reviewed
upstream rather than relabelled during import.

The supported initial state is deliberately narrow:
`rested-equilibrium-at-ambient`. At the trial reset, both RC polarization states
and hysteresis are zero and every thermal node equals the declared ambient
temperature. A warm, polarized, hysteretic or otherwise preconditioned trace is
rejected by this contract until a future version carries those initial states
explicitly; the optimizer must not absorb an unknown initial condition into
fitted parameters.

The parser accepts comma, semicolon or tab delimiters, UTF-8 BOMs, CRLF and
quoted fields. It rejects duplicate or missing headers, malformed rows,
non-decimal numeric tokens, unequal column lengths, non-increasing time and
every interval outside the explicit time tolerance. It never drops a row and
continues.

## Segments and preprocessing

Segments cover the complete source trace once, in order. Each segment records
a mode and whether its observations enter the objective. Excluded samples
remain in the state history so later included predictions begin from the right
state.

Long traces are reduced deterministically before optimization. Current is
averaged across a contiguous block while voltage and temperature retain the
block's end-of-step phase. A block crossing an include/exclude boundary remains
in the state history but is not scored. The result reports the reduction
factor, original and used sample periods, mixed boundary blocks, unrepresented
included samples and any dropped tail. It never silently claims that every
source observation entered the objective.

Temperature affects the objective only when its canonical location is
`module-maximum` and `weightTemp` is greater than zero. Other temperature
locations remain useful provenance but are explicitly excluded from the fit;
asking to weight one is rejected.

## Checksums and trust

The import workflow records three related identities:

- `source.rawSha256` identifies the exact UTF-8 source bytes, including line
  endings and a BOM.
- `normalization.mappingChecksum` identifies the exact closed mapping.
- `dataset.checksum` identifies the complete canonical dataset content.

These digests detect accidental drift and let another system compare a dataset
with an independently trusted expected digest. A checksum stored beside mutable
content does not authenticate the producer, prove chain of custody, or prove
that the `source.tool` declaration is true. Use
`verifyCalibrationDataset(dataset, { expectedChecksum })` only with an expected
checksum obtained through an independent trusted channel.

Each `battery-design/calibration-result@1` additionally records the exact fit
list and order, complete initial parameter set, objective temperature weight,
iteration/evaluation/work limits, algorithm version, model version, exact model
implementation checksum and catalog-cell checksum. `requestChecksum` identifies
that complete execution request; `checksum` identifies the complete result
record. These are deterministic content identities, not signatures: they do not
authenticate a producer, establish custody or prove model accuracy.

Raw traces are not echoed in calibration results. A caller that intentionally
writes a normalized dataset file is responsible for protecting it as source
engineering data.

## Source/staged runner CLI and local API

The CLI examples below run `desktop/bd.mjs` from a clone or an explicitly staged
runner tree. Current `.deb` and AppImage installers expose the GUI and local API;
their bundled Node sidecar is internal and is not an installed shell-command
contract.

Import one raw export and calibrate it:

```bash
node desktop/bd.mjs calibrate \
  --data solver-run-0042.csv \
  --mapping solver-run-0042.mapping.json \
  --fit r0Ref,rc1R,rc1TauS \
  --dataset-out solver-run-0042.calibration.json \
  --out solver-run-0042.calibration-result.json \
  --params-out solver-run-0042.params.json
```

Reuse one canonical dataset, or a JSON array of compatible canonical datasets:

```bash
node desktop/bd.mjs calibrate \
  --dataset solver-run-0042.calibration.json \
  --fit r0Ref,rc1R,rc1TauS \
  --out solver-run-0042.calibration-result.json \
  --params-out solver-run-0042.params.json
```

`--out` is the complete `battery-design/calibration-result@1` evidence record.
`--params-out` contains only the validated parameter object accepted by
`sim2 --params`; the two files are intentionally different contracts.
`--dataset-out` is available only when importing `--data` with `--mapping`,
because a `--dataset` input is already reusable. `--cell`, when supplied, is
only an exact cross-check against the immutable dataset binding and never an
override.

The result's `request` member is sufficient to reproduce the governed numerical
request without returning raw signal arrays: it carries canonical dataset
checksums, the complete initial parameters, fit order and every numerical limit.
The separately stored canonical datasets must still be retrieved and verified
against those checksums.

In the result JSON, `voltageRmseBefore` and `voltageRmseAfter` are volts, while
`temperatureRmseBefore` and `temperatureRmseAfter` are degrees Celsius when a
module-maximum temperature channel is scored. `rmseBefore` and `rmseAfter` are
the combined objective `voltage RMSE + weightTemp × temperature RMSE`; that
weighted score is not a voltage. Human CLI output therefore prints the two
physical RMSE values with their own units and labels the combined value as a
unitless weighted objective score.

The authenticated local API accepts this exact closed envelope:

```json
{
  "format": "battery-design/calibration-request@1",
  "datasets": {},
  "params": null,
  "fit": ["r0Ref", "rc1R", "rc1TauS"],
  "maxIter": 100,
  "weightTemp": 0,
  "maxEvaluations": 500,
  "maxModuleWeightedIntegrationSteps": 2000000,
  "maxSamplesPerDataset": 5000
}
```

`datasets` is one canonical dataset or an array. Optional keys may be omitted;
unknown keys, numeric strings and explicit invalid values are rejected before
defaults are selected. Context comes from each dataset binding. The response
uses the same result format as CLI JSON and includes both integration-step and
module-weighted work counters, surface limits and preprocessing evidence,
without returning the source signals.

## Bounded execution

The reusable contracts enforce these implementation ceilings:

- 32 MiB per imported source text;
- 512 source columns;
- 250,000 samples per canonical dataset;
- eight datasets per joint calibration;
- default 5,000 and maximum 20,000 preprocessed samples per dataset.

The CLI limits total input to 250,000 samples, mappings to 1 MiB, parameter
files to 256 KiB, module topology to 64 modules, optimizer evaluations to 500
and module-weighted integration work to 2,000,000 steps. Its preprocessing
ceiling is 20,000 samples per dataset.

The local HTTP runner additionally retains its 4 MiB request-body and 500,000
JSON-item limits. Calibration is limited to 20,000 total input samples, eight
datasets, 64 modules, 500 evaluations, 5,000 preprocessed samples per dataset
and 2,000,000 module-weighted integration steps. These values are also
advertised by `GET /api/capabilities` so a client does not have to infer them
from a rejected run.

The local API accepts canonical dataset JSON only. It does not accept a URL,
filesystem path or raw source text, and it performs no network fetch. Import
raw exports through the CLI or the JavaScript importer, inspect the canonical
snapshot, then submit that snapshot.

## Evidence status

| Claim | Status | Evidence boundary |
|---|---|---|
| Exact CSV/TSV/columnar-JSON normalization | Automated | Repository import and malformed-input regressions |
| Canonical snapshot validation and identity | Automated | Closed-schema, immutability and checksum regressions |
| Bounded optimizer consumes governed datasets | Automated | Synthetic self-recovery, alignment and exact-work regressions |
| GT-AutoLion export ingestion | **Not run** | No licensed, representative GT-AutoLion export fixture was supplied |
| Simcenter Amesim export ingestion | **Not run** | No licensed, representative Amesim export fixture was supplied |
| Accuracy against a proprietary high-fidelity model | **Not run** | Requires governed source curves, acceptance tolerances and independent validation data |
| Compatibility with a proprietary application or file format | **Not run** | Generic column mapping is not a vendor acceptance result |

The internal synthetic recovery test generates observations with the same
battery-design equations and verifies that the optimizer can recover known
parameters. That is an optimizer regression, not independent model validation.

## Phase boundary

This phase adds governed ingestion into the existing calibrator. It does not
add a vendor-specific calibration recipe, parameter-identifiability study,
multi-temperature Arrhenius workflow, new RC network, SEI or lithium-plating
equations, CFD field reduction, or an accuracy claim against proprietary
ground truth. Those belong to the next calibration action and require their own
data, acceptance criteria and commits.
