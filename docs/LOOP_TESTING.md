# Software- and Hardware-in-the-Loop add-ons

These add-ons share one versioned equation graph but answer different
questions. None is renamed live playback.

| Mode | What executes | Evidence required | Possible result |
|---|---|---|---|
| Live playback | A completed Rust/Wasm trace displayed over wall-clock time | Valid graph and solver run | Completed / stopped |
| Software-in-the-Loop (SIL) | The versioned software model adapter against test vectors | Independent numeric limits, units, model/checksum/solver identity | Pass / Fail |
| HIL contract | No hardware; freezes timing, I/O, faults, overruns and safe state | Reviewed interface and target requirements | Contract ready / Unproven |
| Hardware-in-the-Loop (HIL) | Real-time target and physical controller I/O | Measured cycle times, I/O, injected faults, overrun and safe-state observations | Pass / Fail |

`js/loop-testing.js` ships the executable SIL runner and the HIL contract plus
evidence evaluator. A future target runtime remains a separate planned add-on
because deterministic real time cannot be proven on a browser or ordinary
workstation.

Both builders return recursively immutable, closed snapshots with a
deterministic `checksum`. These governed snapshots are
`battery-design/sil-test-plan@2` and
`battery-design/hil-test-contract@2`; the original shallow `@1` documents are
accepted only by the explicit `migrateLegacySilTestPlan()` and
`migrateLegacyHilTestContract()` rematerializers. They are never executed
directly. `runSoftwareInLoop()` and `evaluateHilEvidence()`
reconstruct and verify those snapshots before use. The checksum identifies the
exact contract content; it is not a signature and does not authenticate its
producer. A custody-sensitive workflow must retain the reviewed checksum
separately and pass it as `expectedChecksum` to `verifySilTestPlan()` or
`verifyHilTestContract()` before execution.

## SIL calculation contract

Every SIL plan pins:

- model id and model version;
- canonical graph checksum;
- selected solver and deterministic seed;
- test inputs and run options;
- output path and unit;
- an independently obtained minimum/maximum accepted range.

The runner executes the adapter twice for repeatability, checks that the
reported model/checksum/solver identity did not change, checks units, and
checks the numeric range. A model is not allowed to generate its own accepted
range from the same run being tested.

The adapter response is closed: it must contain exactly `modelId`,
`modelVersion`, `graphChecksum`, `solver`, `outputs` and `units`, all as finite
JSON data where applicable. Repeatability compares canonical content, so
object key insertion order cannot create a false failure while any value change
still fails. The returned `battery-design/sil-test-result@1` evidence is deeply
frozen, binds the plan checksum and carries its own deterministic content
checksum. As with the plan checksum, this identifies content rather than
authenticating its producer.

A released calculation package should also include analytical or trusted
cross-tool cases, tolerance/step convergence, lower/upper boundaries,
invalid-input behavior, event timing and relevant charge/energy conservation.

## HIL contract

Every HIL contract pins:

- named target and model identity;
- integer sample period in microseconds and test duration;
- every input/output channel, quantity, unit and operating range;
- a safe value for each output;
- maximum allowed consecutive overruns and the required overrun action;
- sensor open, short, stuck and out-of-range faults;
- communication timeout, target overrun, power-cycle and emergency safe-state tests.

`evaluateHilEvidence()` returns Unproven when evidence is absent. With
evidence, it checks target/model identity, every measured cycle time, every
I/O channel, each required fault, the observed safe state and recorded
overruns. Passing a software simulation cannot satisfy any of those hardware
checks.

Timing evidence must cover at least
`ceil(durationS × 1,000,000 / samplePeriodUs)` consecutive cycles. A lone fast
sample cannot prove a complete run. Contracts are capped at 1,000,000 timing
samples, and the evaluator scans them iteratively rather than expanding an
unbounded array into function arguments. Results expose both required and
observed cycle counts plus the maximum measured cycle time.
Cycle-count derivation evaluates the canonical decimal representation of
`durationS` as an exact rational number. Thus `0.000123` seconds at 1 µs is
exactly 123 cycles, while any represented positive partial period requires the
next cycle. A partial trace fails coverage but retains its measured maximum
for diagnosis.

## Safety-calculation evidence

Thermal propagation and vent sizing may be exercised in SIL for regression,
unit consistency, sensitivity and deterministic repeatability. Their physical
validity still depends on representative cell/module/enclosure tests. In
particular, the vent module uses measured gas volume and release duration; it
does not infer them from NMC, LFP or LTO chemistry labels.

Primary boundaries:

- [NASA Glenn mass-flow choking relation](https://www.grc.nasa.gov/www/k-12/airplane/mflchk.html)
- [NFPA 68 — explosion protection by deflagration venting](https://www.nfpa.org/codes-and-standards/nfpa-68-standard-development/68)
- [UL 9540A thermal-runaway fire-propagation testing](https://www.ul.com/services/ul-9540a-test-method)
