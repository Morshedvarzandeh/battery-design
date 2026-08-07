# Governed staged ECM tuning

This is calibration **Action 2**: a bounded, staged workflow for the existing
two-RC equivalent-circuit model. It consumes separate, already governed
calibration-purpose and validation-purpose whole trials, builds an immutable
plan, executes only the groups supported by the submitted experiment, and
adopts a candidate only when every caller-predeclared acceptance gate passes.

It is exposed by the source/staged Node runner CLI and the authenticated
loopback local API. It is not a desktop-GUI button or MCP tool, and the desktop
packages do not install a stable customer-facing shell wrapper.

## Action 1 and Action 2 are different

| Boundary | Action 1: ingestion and manual fitting | Action 2: staged ECM tuning |
|---|---|---|
| Input | An exactly mapped delimited/columnar-JSON trace, or a canonical dataset | Separate canonical calibration and validation datasets |
| Main job | Normalize a source trace and fit a caller-selected allowlist | Qualify groups, plan stages, check numerical sensitivity, fit and score a fixed holdout |
| Artifacts | `battery-design/calibration-dataset@1`, calibration result and parameter-only file | `battery-design/ecm-tuning-plan@1`, `battery-design/ecm-tuning-result@1` and surface run envelope |
| Adoption | Caller uses the fitted parameter file deliberately | Result separates diagnostic `candidateParams` from fail-closed `adoptedParams` |
| Vendor support | Generic exact mapping, with no vendor-specific adapter claim | No raw importer and no vendor-specific tuning recipe |

Use [Governed synthetic calibration data](SYNTHETIC_CALIBRATION.md) for Action
1. Action 2 never guesses columns, units, current polarity or signal locations;
those decisions must already be bound into each immutable
`battery-design/calibration-dataset@1` input.

## Product surfaces

From a clone or explicitly staged runner tree, the CLI shape is:

```bash
node desktop/bd.mjs tune-ecm \
  --calibration calibration-trials.json \
  --validation validation-trials.json \
  --acceptance acceptance.json \
  --groups auto \
  --out ecm-tuning-run.json \
  --params-out adopted-params.json
```

`--calibration`, `--validation` and `--acceptance` are required. Optional
inputs include `--params`, `--groups`, `--cell`, `--max-evaluations`,
`--max-module-work`, `--max-samples`, `--out`, `--params-out` and `--json`.
`--out` is the complete evidence envelope; `--params-out` contains only the
adopted parameter map. A rejected candidate therefore cannot silently become
the parameter file used by a later simulation.

The authenticated local API accepts the corresponding closed JSON request at
`POST /api/tune-ecm`:

```json
{
  "format": "battery-design/ecm-tuning-request@1",
  "calibrationDatasets": [],
  "validationDatasets": [],
  "acceptance": {
    "maxVoltageRmseMvPerCell": 10,
    "maxVoltageMaxAbsMvPerCell": 25,
    "maxTemperatureRmseC": null,
    "maxTemperatureMaxAbsC": null,
    "minValidationDatasets": 1,
    "minIncludedSamplesPerDataset": 8,
    "requiredModes": ["pulse", "rest"],
    "requireNoHoldoutRegression": true,
    "requireNoFittedParameterAtBound": true
  },
  "groups": "auto"
}
```

The empty dataset arrays above show the request shape only and are rejected by
execution. Supply complete canonical dataset objects, not URLs, filesystem
paths or raw source text. The API performs no network fetch.

Both surfaces return `battery-design/ecm-tuning-run@1`, which binds the surface
request to its nested `battery-design/ecm-tuning-plan@1` and untouched
`battery-design/ecm-tuning-result@1` evidence.

## Planning groups and skip behavior

The versioned strategy considers six parameter groups in stable order and then
adds one joint-refinement stage over the active union:

| Stage | Parameters | Required experiment distinction |
|---|---|---|
| `ohmic` | `r0Ref` | Resolved current edges and rested OCV evidence |
| `fast-rc` | `rc1R`, `rc1TauS` | Sample rate, pulse duration and relaxation that resolve the fast branch |
| `slow-rc` | `rc2R`, `rc2TauS` | Longer pulse and rest evidence that resolves the slow branch |
| `soc-dependence` | `r0SocRise` | Scored resistance excitation across separated SoC basis regions |
| `arrhenius` | `r0EaJ` | A near-isothermal, cell-average multi-temperature family around the reference condition |
| `hysteresis` | `hystV` | Charge/discharge overlap and nonzero hysteresis-state excursion |
| `joint-refinement` | Active union | Final constrained refinement after the active group stages |

Coverage gates inspect included scoring windows on the exact deterministic
preprocessed calibration grid. With `groups: "auto"`, a group whose coverage
gates fail is recorded as `skipped` with exact reasons. If the caller requests
an explicit group list, a failed requested group blocks planning instead of
quietly disappearing. A plan with no active group is rejected.

Coverage is not proof of identifiability. Before each stage fits anything, the
executor evaluates a normalized finite-difference prediction Jacobian on that
stage's calibration trials. It fails closed on an unusable perturbation, weak
column magnitude, deficient numerical rank or excessive column correlation.
This is a local sensitivity/confounding screen, not a claim of globally unique
physical parameters.

The invariant `rc2TauS >= 3 * rc1TauS` is checked before planning and enforced
before simulation for every sensitivity probe and optimizer candidate, as well
as for the final candidate. Rejected constraint proposals are counted; they do
not become unrecorded simulator work.

## Calibration and fixed holdout roles

Only calibration-purpose trials enter sensitivity probes or the optimizer
objective. Validation observations never select or fit a candidate.

The initial parameters and the final diagnostic candidate are each scored on
the same fixed validation trials at their original, full sample rate. Excluded
samples still drive the model state but do not enter the score. Acceptance is
checked in physical units for:

- pooled validation evidence;
- every validation trial; and
- every included validation segment.

Voltage evidence reports RMSE, maximum absolute error and mean bias in
mV-per-cell. When both temperature limits are declared and eligible
module-maximum measurements exist, temperature evidence reports the same
scalar metrics in °C. The result also applies no-holdout-regression,
strict-calibration-improvement, no-fitted-bound and ordered-RC checks. A short
bad segment therefore cannot be hidden by a long, easy pooled trace.

The caller owns all thresholds before planning. Their closed policy is
content-addressed in the plan; the executor does not choose thresholds after
seeing a result.

## Candidate is not adoption

`candidateParams` is the diagnostic parameter map produced by the completed
stages, even when a later sensitivity or acceptance check rejects the run.
`adoptedParams` equals that candidate only when every predeclared check passes.
Otherwise `adoptedParams` equals the immutable initial parameter map and the
verdict is `rejected`.

This split preserves useful failure evidence without turning optimizer output
into an engineering release decision.

## Limits and exact work

Planning reserves a baseline-plus-axis sensitivity set and a separate initial
optimizer simplex for every stage. Before the first simulation, execution
preflights fixed initial/final calibration and validation scoring plus every
stage allocation. Both temporal integration steps and module-weighted thermal
node steps are checked with safe-integer arithmetic. Counters are cumulative
across stages and include sensitivity probes, optimizer proposals and fixed
scoring work.

Both partitions may use versioned deterministic block preprocessing for
planning identities and coverage, bounded by `maxSamplesPerDataset`; the
prepared calibration grid also drives the optimizer. Validation scoring is
separate and is never downsampled: it remains at the original full rate. The core
contracts accept at most eight calibration and eight validation trials,
250,000 raw samples per canonical dataset, and 20,000 preprocessed samples per
dataset. A single simulator call is also bounded independently of the plan's
cumulative work ceiling.

The exposed surfaces add tighter service limits:

| Limit | Source/staged CLI | Authenticated local API |
|---|---:|---:|
| Combined raw calibration + validation samples | 250,000 | 20,000 |
| Calibration / validation trials | 8 / 8 | 8 / 8 |
| Module count | 64 | 64 |
| Candidate evaluations | 500 | 500 |
| Module-weighted integration steps | 2,000,000 | 2,000,000 |
| Prepared planning/optimizer-grid samples per dataset (both partitions as applicable) | 20,000 | 5,000 |

The API additionally retains its 4 MiB request-body and 500,000 JSON-item
limits. These are service ceilings, not evidence that a smaller experiment is
informative enough; coverage and sensitivity gates still apply.

## Artifact and privacy boundary

The portable run contains versioned request, plan, policy, implementation,
cell, trial, stage, metric, verdict and work identities. Scalar per-trial and
per-segment metrics are retained so a failed condition stays reviewable. Raw
current, voltage and temperature arrays and raw Jacobian vectors are not copied
into the plan or result.

Checksums establish reproducible content identity and make accidental or
rechecksummed nested substitution detectable when the trusted implementation
rebuilds the plan. A checksum stored beside mutable content is not a signature:
it does not authenticate the producer, prove custody, prove that two trials are
statistically independent or validate model accuracy.

The planner rejects exact cross-partition collisions across governed
observation, trial-content, raw/preprocessed scored-electrical, raw-source and
declared source-run identities. These are exact duplicate/leakage guards only.
The caller remains responsible for experimental separation, source custody and
whether the holdout answers the intended engineering question.

## Evidence status

| Claim | Status | Evidence boundary |
|---|---|---|
| Deterministic planning, group gates/skips and exact budget allocation | Automated | Repository planner and adversarial budget regressions |
| Normalized sensitivity gates, constrained candidates and fail-closed adoption | Automated | Repository executor and adversarial holdout regressions |
| Fixed original-rate pooled/trial/segment scoring without raw-trace retention | Automated | Repository result-contract and privacy regressions |
| GT-AutoLion export import or tuning | **Not run** | No licensed representative GT-AutoLion fixture or accepted vendor recipe was supplied |
| Simcenter Amesim export import or tuning | **Not run** | No licensed representative Amesim fixture or accepted vendor recipe was supplied |
| Accuracy against a proprietary high-fidelity model | **Not run** | Requires governed source curves, predeclared tolerances and truly separate validation data |
| Compatibility with a proprietary application or file format | **Not run** | Generic canonical datasets and checksums are not a vendor acceptance result |

The automated fixtures are generated from battery-design's own equations.
They establish deterministic software behavior and optimizer regressions, not
independent physics accuracy.

## Model boundary

Action 2 tunes only the existing allowlisted ECM coefficients. It does not add
a new RC branch, a P2D/electrochemical model, particle diffusion, an SEI or
lithium-plating model, a CFD field model, a vendor importer or a
vendor-specific calibration recipe. Skipped groups remain skipped, and an
accepted result does not elevate this lumped ECM into a validated proprietary
high-fidelity model.
