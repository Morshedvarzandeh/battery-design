# HIL target runtime and five-iteration qualification campaign

The deterministic HIL target runtime remains **planned**. Iteration 1 adds a
governed deployment plan for a future runtime; it does not add a scheduler,
cycle loop, operating-system integration, I/O driver, physical fault injector
or hardware qualification. A deployment plan is therefore not evidence of
real-time execution and cannot produce a HIL pass.

The shipped `battery-design/hil-test-contract@2` remains the source of reviewed
test requirements. The new `battery-design/hil-deployment-plan@1` closes the
mapping from that contract to the `battery-design/hil-runtime-abi@1` expected by
later runtime work. These are different responsibilities:

| Artifact | Responsibility | What it does not prove |
|---|---|---|
| `hil-test-contract@2` | Reviewed target/model identity, period, duration, channels, faults, overrun policy and safe values | That any target can execute it |
| `hil-deployment-plan@1` | Canonical target, graph, ABI, channel, fault and executable-safety mapping | That the plan has run or met a deadline |
| `hil-test-result@1` | Bounded verdict over supplied measured evidence | Producer identity, raw-evidence custody or independent hardware origin |

## Iteration 1: deployment boundary only

The deployment-plan builder verifies the complete HIL contract and requires
the independently retained contract checksum. It then binds all runtime-facing
facts into one closed, recursively immutable, deterministically checksummed
snapshot:

- the verified `hil-test-contract@2` schema and checksum;
- the target, model and model-version identity from that contract;
- the canonical graph's existing checksum and its SHA-256 package identity;
- the exact `hil-runtime-abi@1` declaration and target profile;
- one binding for every contract input in the
  **physical-to-model** direction;
- one binding for every contract output in the
  **model-to-physical** direction;
- an allowlisted injector route for every required fault; and
- an executable safety rule plus the safe-output vector derived from the
  contract outputs.

The complete creation boundary is:

```js
createHilDeploymentPlan({
  contract,
  expectedContractChecksum,
  graph, // validated battery-design/equation-graph@1
  target: { id, platform, architecture, driverId, clockId },
  channels: {
    inputs: [{ channelId, modelPortId, physicalEndpoint }],
    outputs: [{ channelId, modelPortId, physicalEndpoint }],
  },
  faults: [{ faultId, operation, injector, channelId }],
  safety: {
    mode: 'latch-declared-safe-outputs',
    trigger: 'overrun-limit-exceeded-or-runtime-failure',
  },
});
```

`expectedContractChecksum` is mandatory: the builder does not let the
contract's self-carried checksum become its own trust anchor. The target id
must equal the contract target id. The equation graph is independently
walked before JSON canonicalization to reject cycles, sparse slots,
unsupported prototypes and non-finite numbers, then validated. This order is a
content-identity requirement: JSON serialization aliases `NaN`, infinity and
sparse slots to `null`, which could otherwise make distinct invalid graphs
share bytes. The walk reconstructs string-keyed records through null-prototype
data objects so an enumerable own `__proto__` key cannot invoke an ordinary
object's legacy prototype setter and disappear from the identity. The canonical
FNV checksum must equal the contract graph checksum, the graph id and version
must equal the contract model identity, and
`graphArtifactSha256` is derived from the exact canonical graph UTF-8 bytes.

The returned snapshot has exactly these conceptual fields:

```js
{
  schema: 'battery-design/hil-deployment-plan@1',
  runtimeAbi: 'battery-design/hil-runtime-abi@1',
  contractSchema: 'battery-design/hil-test-contract@2',
  contractChecksum,
  targetId, modelId, modelVersion,
  graphChecksum, graphArtifactSha256,
  samplePeriodUs, durationS,
  target,
  channels: { inputs, outputs },
  faults,
  safeOutputs,
  safety: {
    mode: 'latch-declared-safe-outputs',
    trigger: 'overrun-limit-exceeded-or-runtime-failure',
    overrunMissesBeforeLatch,
  },
  status: 'deployment-plan-ready-runtime-not-qualified',
  checksum,
}
```

`verifyHilDeploymentPlan(plan, { expectedChecksum })` reconstructs the same
closed snapshot, checks its checksum and optionally compares it with a plan
identity retained outside the supplied artifact.

Bindings are complete and one-to-one. Each contract channel is represented
exactly once, and an input cannot be projected as an output or vice versa.
Callers supply only `channelId`, `modelPortId` and `physicalEndpoint`. The
builder places the binding in the fixed `inputs` or `outputs` collection and
enriches the returned immutable input binding with its contract-derived
quantity, unit, minimum and maximum; an output binding additionally carries its
contract-derived `safeValue`. Those semantics are therefore both explicit in
the deployment snapshot and pinned by the trusted contract checksum, rather
than copied from editable caller metadata. The plan records the physical
endpoint and the model ABI slot; it does not open either endpoint. In Iteration
1, `modelPortId` is an opaque identifier. Iteration 2 must bind it to an actual
Rust external-input or observable-output slot. Driver identities and physical
endpoints are relative slash-separated namespaced references, not filesystem
paths: control characters, absolute/backslash forms, empty or traversal
segments and prototype-control names fail closed.

Fault routes use the closed shape
`{ faultId, operation, injector, channelId }`:

| Required fault class | Injector | Channel rule |
|---|---|---|
| Sensor open, short, stuck or out of range | `driver` | Exactly one contract input channel |
| Communication timeout | `driver` | `null` |
| Target overrun or emergency safe state | `scheduler` | `null` |
| Power cycle | `platform` | `null` |

For every route, `operation` must equal the allowlisted `faultId`; Iteration 1
does not translate free-form operation names. Custom required faults remain
unsupported until a later ABI version defines their executable semantics.

The contract's `overrun.action` remains human-readable review documentation;
free text is never interpreted as target code. The executable rule is the
fixed enum `overrun-limit-exceeded-or-runtime-failure`, paired with the safe
vector derived from every contract output's `safeValue`. The plan derives
`overrunMissesBeforeLatch` as `contract.overrun.maxConsecutive + 1`; a limit of
zero therefore latches on the first consecutive miss. A contract whose limit
would make that addition exceed JavaScript's safe-integer range is rejected at
deployment planning even though it remains a structurally valid test contract:
an executable threshold must be representable exactly. This threshold controls
the safety action; it does not relax timing acceptance. The existing HIL
evidence evaluator still fails timing when any measured cycle exceeds
`samplePeriodUs`.

The deployment plan checksum and graph SHA-256 are content identities, not
signatures. They detect a different canonical representation when compared
with an independently retained expected value, but do not authenticate the
author, target, measurements or custody chain. Signing and protected key use
belong to physical qualification, after raw evidence has been captured.

### Iteration 1 test gate

The focused campaign pairs each accepted behavior with a rejected counterpart
instead of using the total repository-suite count as evidence. It covers:

- deterministic rematerialization, recursive immutability and checksum
  verification;
- trusted-contract checksum mismatch and coordinated contract mutation;
- graph checksum/SHA-256 and runtime-ABI identity mismatch;
- pre-canonical graph NaN, infinity, sparse-slot, cycle,
  unsupported-prototype, literal-null and own-`__proto__` alias cases;
- complete input/output mapping, reversed direction, duplicate or missing
  channels, duplicate endpoints and duplicate ABI slots;
- contract-only derivation and preservation of the directional collection,
  quantity, unit, bounds and output safe values;
- every allowed fault route plus missing, duplicate, wrong-injector and
  wrong-channel routes;
- the fixed executable safety trigger, exact derived safe vector and
  below/exact/overflow missed-deadline threshold cases;
- unknown fields, inherited fields, sparse arrays, non-finite values and
  blank identifiers; and
- explicit assertions that no scheduler, driver or hardware-pass surface is
  exported and that `hil-runtime` remains planned.

## Five iterations

Each iteration is a separately reviewable commit and pull request, pushed only
after its focused gate passes and retained with exact-commit CI evidence. Its
campaign includes positive, negative and adversarial tests. Numeric boundaries
use below/exact/above cases; state-machine transitions cover every state and
forbidden transition. A later iteration must preserve the earlier gates.

| Iteration | Build scope | Required campaign and exit evidence | Claim boundary |
|---:|---|---|---|
| 1 | Closed deployment plan, runtime ABI, graph identities, channel/fault bindings and derived safety rule | Contract reconstruction, mapping completeness, mutation/tamper cases, deterministic identity and product-status assertions | Planning artifact only; no execution |
| 2 | Bounded Rust one-cycle kernel with fixed-sample state, external input slots, observable outputs, preallocated buffers and exact work limits | Deterministic sequences, analytical/offline agreement, convergence, boundary/fault cases, no post-initialization allocation and bounded-failure safe output | Numerical cycle only; no clock, OS or I/O |
| 3 | Virtual target scheduler and I/O traits with an injected clock, absolute deadlines, no-drift scheduling, safe latch, fault injection and raw-trace digest | Seeded repeatability, early/exact/late deadlines, long-run drift, every fault and safe-latch transition, trace tamper/replay and bounded-evidence checks | Workstation/virtual evidence remains Unproven for hardware |
| 4 | Fail-closed Linux PREEMPT_RT adapter and target package using `SCHED_FIFO`, CPU affinity, locked/pre-touched memory, absolute monotonic timing and identified drivers | Compile/mock CI, denied privilege, missing RT kernel, affinity/locking/driver mismatch, startup rollback, deadline/safe-latch and package-identity checks | No fallback to normal scheduling; host benchmarks are not qualification |
| 5 | First named physical target/controller/I/O/fault rig qualification on a protected, self-hosted exact-commit job | Independent timing and I/O observation, full-duration load, every fault, safe state, power cycle, wrong target/key, tamper/replay, post-run signing and retained raw evidence | Only the explicitly qualified target may become shipped |

## Physical qualification dependency

Iterations 1 through 4 must leave the `hil-runtime` add-on in `planned` status.
They may establish content identity, deterministic numerical behavior, virtual
scheduler behavior and a fail-closed target adapter, but none supplies physical
I/O or independent real-time measurements.

Iteration 5 requires a selected target and real-time operating system,
production-representative controller I/O, calibrated drivers, a fault rig,
worst-case execution-time qualification, independent observation and a
protected evidence/signing workflow. Until that exact-target campaign passes,
the honest product result is **planned / unproven**, not HIL pass. A successful
campaign changes status only for the target and deployment surface named by
the retained qualification evidence; it does not certify other hardware.
