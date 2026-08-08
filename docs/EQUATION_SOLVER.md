# Rust equation-graph solver

This is the numerical backend for the future block-based Co-Simulation Studio.
It is deliberately independent of the visual canvas: the canvas will edit and
review a graph, while this module decides whether that graph is valid and what
its equations predict.

## Shipped boundary

`rust-core/src/equations.rs` and `rust-core/src/dae.rs` currently provide:

- stable block and connection identifiers;
- exact port-quantity matching with no implicit conversions;
- constants, time steps, gains, sums, products, limits, integrators,
  first-order states and a lumped thermal-balance block;
- graph compilation with missing/duplicate input rejection;
- direct evaluation of acyclic algebraic graphs;
- damped Newton iteration with a finite-difference Jacobian and pivoted dense
  linear solve for finite algebraic feedback loops;
- adaptive Dormand-Prince 5(4) integration with absolute/relative tolerances,
  rejected-step accounting, hard step limits and deterministic event stops;
- an adaptive backward-Euler path with damped Newton state solves and
  step-doubling error control for stiff ODE graphs up to 64 states; larger
  implicit models stop with an explicit sparse-backend requirement;
- recorded automatic solver recommendations based on declared state time
  constants and the requested horizon; automatic selection never changes a
  tolerance;
- stable diagnostic codes plus conservative, human-readable next actions;
- complete traces in stable block order and solver statistics;
- a coupled electrical/thermal cell reference graph;
- a versioned numeric transport for browser-authored approved graphs;
- an opaque WebAssembly run handle that returns solver metadata and stable
  `[time, block values...]` trace rows without introducing a second solver;
- the dependency-free current `battery-design/dae-residual@2` lowering contract:
  `DaeResidualSystem::lower` publishes deterministic differential/algebraic
  variable and output mappings, the numeric ID vector, consistent initial
  values bound to an exact finite initialization time, exact event times, a
  deterministic CSC Jacobian pattern and exact caller-owned buffer
  requirements. It keeps ordinary residual evaluation right-continuous and
  provides a separately indexed exact event-left residual for a native
  terminal step. After lowering, its successful caller-buffer callbacks
  allocate no heap memory; lowering and initialization construction may
  allocate, and the contract does not select or contain a DAE solver.

### Current Iteration 4 event-restart contract boundary

The source-only Linux native reference now consumes
`battery-design/dae-residual@2` through the coordinated current identities
`battery-design/native-ida-dense@2`,
`battery-design/native-ida-dense-result@2`,
`battery-design/native-ida-klu@2` and
`battery-design/native-ida-klu-result@2`. The older `@1` identities and their
Iteration 1/2/3 evidence remain historical contracts; the event behavior below
is not retroactively attributed to them.

`IdaEventPolicy::Reject` is the default and preserves fail-closed rejection of
scheduled events. A caller must explicitly choose
`IdaEventPolicy::Restart { max_restarts }`; the request ceiling may not exceed
10,000 and must cover every compiled event in the exact active interval
`initial_time < event <= final_requested_time`. The backend does not accept a
caller-supplied event list, merge nearby values by tolerance or invent event
times outside `DaeResidualSystem::events()`.

For each active event, IDA is stopped exactly at the compiled time and advances
the left segment only with `IDA_ONE_STEP`; intermediate success may continue,
but terminal arrival must be the exact-time `IDA_TSTOP_RETURN`. Callback time
below the selected event uses the ordinary residual; exact equality uses the
indexed left-limit residual. A finite callback overshoot fails closed with
event/callback evidence, and the Jacobian callback applies the same boundary
guard. Requested rows
strictly inside a completed step use `IDAGetDky`; an exact step endpoint is
copied directly and an event-equality row is withheld until right-side
consistent correction. This keeps `IDAGetDky` out of both equality cases and
prevents an interpolated left row from being presented as the right state.

Active-event filtering does not by itself constrain IDA trial callbacks. When
no active event remains, Restart policy therefore installs a separate terminal
stop at `final_requested_time`, including on the final segment after an earlier
restart. This terminal boundary keeps ordinary right-continuous residual and
Jacobian semantics through equality, but a finite callback beyond final fails
as `ida.callback.horizon_boundary`. Exact terminal arrival must be
`IDA_TSTOP_RETURN`; the final row is copied directly from that step endpoint,
without `IDAGetDky`, reinitialization, consistent correction or an event-
restart increment. Dense and KLU regressions place an inactive StepSource one
ULP after final so post-horizon forcing cannot contaminate the requested row.

At a stop, the adapter preserves the exact endpoint y and yp before draining
pre-event output, clears the stop and event-left marker, restores the endpoint,
and calls `IDAReInit`. It then bounds event correction with at most 5 IC steps,
4 IC Jacobians, 10 IC nonlinear iterations and 100 backtracks, calls
`IDACalcIC(IDA_YA_YDP_INIT, target)` and `IDAGetConsistentIC`, and requires
bit-exact continuity of every differential y component. The correction target
is the next active event, otherwise the later final output, or—when the event
equals the final output—a finite representable horizon mirroring the preceding
segment. Every left segment and correction target passes the pinned IDA 7.8.0
floating-point span gates before native allocation.

`IDAReInit` resets native statistics. The Rust owner therefore snapshots and
checked-adds every segment, requires all governed raw counters to be zero after
reinitialization, retains callback-owned KLU Jacobian work across restarts and
applies one cumulative successful-`IDA_ONE_STEP` ceiling to the complete
request. Interpolated, exact step-endpoint and corrected event-equality output
rows are counted separately and must sum to the requested row count. The
settings initial time must numerically equal the residual system's stored
initialization time before allocation; `-0.0` and `+0.0` are the same instant.
Generic callback, native, KLU and phase failures owned by an event carry exactly
one `EventRestartFailure` layer with compiled event index, exact time and
`IdaEventPhase`; the unchanged inner callback, native stage/flag or KLU
last-linear-flag evidence remains its source. Self-identifying
`EventDifferentialDiscontinuity` and `ReinitCounterInvariant` failures retain
their direct typed identity instead of gaining a redundant wrapper.
Endpoint y/yp capture is gated to an event stop or a direct step-endpoint row,
not every internal step; `endpoint_state_captures()` must equal
`event_restarts() + step_endpoint_output_rows()`.
If the request ends at an event, `last_order()`,
`last_accepted_step_current_order()`, `last_step_s()` and
`last_accepted_step_next_step_s()` retain the last accepted integration-step
evidence captured before `IDAReInit`; `actual_initial_step_s()` retains the
first integration segment's actual initial step, and `terminal_state_time_s()`
reports the post-correction terminal event time.

This is an opt-in event-restart capability of the tested source-only native
Linux dense and KLU references. It is not compiled into the browser
WebAssembly module, exposed by a service or desktop integration, copied into
an npm/installer/release artifact, qualified for arbitrary DAEs, or certified
for product or safety decisions. KLU factor-fill isolation and the Iteration 4
native service boundary remain separate work.

### Historical Iteration 2 native reference boundary (`@1`)

`rust-dae-native/` now implements a bounded native Linux reference backend in
source under `battery-design/native-ida-dense@1`. It is not part of the
browser, desktop, service, npm package or any released product artifact. The
crate's default feature set contains no native adapter:
`IdaDenseBackend::new()` returns `ida.backend.unavailable` and never falls back
to a built-in integrator while claiming IDA evidence.

With the explicit `sundials-ida` feature, an accepted native install and a
native Linux target using `panic=unwind`, the reference backend is exactly
SUNDIALS/IDA 7.8.0 using BDF orders 1 through 5, `NVECTOR_SERIAL`,
`SUNMATRIX_DENSE` and `SUNLINSOL_DENSE`, with static non-MPI linkage, double
precision and 64-bit indices. It consumes `battery-design/dae-residual@1` and
has backend-owned ceilings:

- at most 256 DAE variables for the dense system;
- at most 100,000 requested output points;
- at most 10,000,000 cumulative internal steps for one consumed session; and
- at most 25,600,000 returned scalar values.

A caller may reduce those ceilings but cannot raise them. Requests select
scalar or component-wise absolute tolerances and either use the residual
contract's consistent initial values (`ContractConsistent`) or ask IDA to
correct algebraic `y` and differential `yp` from exact-length finite guesses
(`CorrectAlgebraicAndDerivative`). Scheduled events are explicitly rejected
as `ida.events.unsupported` before request-specific native allocation;
Iteration 2 does not pretend that an event-free run proves restart behavior.

The solve loop uses `IDA_ONE_STEP` and cumulative native counters so repeated
output requests cannot reset the global step budget. Requested rows are
materialized with `IDAGetDky` only inside the newly completed step. Result
objects bind their residual, backend and result contract identities and expose
owned read-only row views plus solve-statistic deltas. Residual and Jacobian
callbacks preflight native shapes and aliasing, contain Rust panics, preserve
the first exact `DaeError`, and use preallocated work. The measured
zero-allocation statement applies only to repeated successful callbacks after
session construction; it does not cover lowering, initialization, solve
orchestration or error handling.

The authoritative source identity is the closed
`battery-design/sundials-source-lock@1` document at
`native-backends/sundials/source-lock.json`. It pins the official
`ida-7.8.0.tar.gz` release asset, its tag object and commit, exact byte length
and SHA-256, plus the checked-in BSD-3-Clause license and NOTICE identities.
`tools/verify-sundials-source.mjs` verifies that source boundary, while
`tools/build-sundials-ida.mjs` performs the bounded archive inventory, static
Linux build, installed CMake-package audit and lifecycle probe established by
Tasks 2A and 2B.

The official asset is IDA-only at the solver-family level. Its installed IDA
package still contains mandatory native vector, matrix and iterative-solver
modules because upstream exposes no dense-only binary switch; neither the
source lock nor the build gate claims otherwise. The Rust reference selects
`NVECTOR_SERIAL`, `SUNMATRIX_DENSE` and `SUNLINSOL_DENSE`. Its derived adapter
link root must additionally match the accepted source identity, configuration,
closed receipt, recomputed archive hashes and exact archives consumed by
Cargo before link directives are emitted. Runtime construction then probes
SUNDIALS 7.8.0 and the complete selected native object stack.

Those checks prove fail-closed content and configuration self-consistency for
the accepted local build. Adjacent hashes and a self-recomputed receipt do not
authenticate the publisher, prove reproducible-build equivalence, establish
compiler trust, preserve artifact custody or provide a signed chain of
possession. `tests/sundials-source-lock.test.mjs`,
`tests/sundials-native-build.test.mjs` and
`tools/test-native-dae-build.mjs` preserve the source, build, derived-install
and real-link regression boundaries.

### Historical Iteration 3 native sparse reference boundary (`@1`)

`rust-dae-native/` also contains a bounded, source-only Linux sparse reference
under `battery-design/native-ida-klu@1`. It is available only with the explicit
`sundials-ida-klu` feature and an accepted `SUNDIALS_IDA_KLU_ROOT`; selecting
that identity never falls back to the dense solver. The exact native identity
is SUNDIALS/IDA 7.8.0, SuiteSparse 7.7.0 and KLU 2.3.3 with
`NVECTOR_SERIAL`, `SUNMATRIX_SPARSE_CSC`, `SUNLINSOL_KLU_COLAMD`, static
non-MPI linkage, double precision and 64-bit indices. It is not part of the
browser, desktop, service, npm package, installer or any released artifact.

Sparse requests are admitted before request-specific native allocation. The
backend ceilings are 10,000 variables, 1,000,000 structural nonzeros, 64 MiB
of known CSC storage, 1,000,000 Jacobian evaluations, 10,000,000,000 projected
Jacobian-entry writes and 25,600,000 returned scalar values; callers may only
reduce them. The known-storage figure covers the native CSC arrays and Rust
callback scratch that the adapter can calculate exactly. It deliberately
excludes input-dependent KLU symbolic and numeric factor fill, so it is not a
bound on total process memory and does not justify an unqualified
memory-bounded claim. Process isolation remains an Iteration 4 gate.

The scaling evidence keeps two different statements separate. Deterministic
lowering and complete sparse admission are exercised at 1,000 and 10,000
variables, including exact sorted unique CSC structure and known-storage
accounting. A real native KLU session is constructed and dropped at 1,000
variables. The campaign does not claim that the 10,000-variable case performs
a native factorization or numerical solve.

The governed CI-only build combines the closed SUNDIALS source lock with the
closed SuiteSparse source lock, builds only SuiteSparse_config, AMD, BTF,
COLAMD and KLU, and publishes a private eight-archive static link root. Its
installed-prefix and curated direct-link probes perform a real KLU factor and
solve. The hosted Rust adapter gate pins Rust 1.77.2 with warnings denied and
executes both debug and release configurations. BTF and KLU remain
LGPL-2.1-or-later: checked-in license texts and hashes are evidence, not legal
approval. Relinkable-object obligations, source-offer requirements, artifact
custody and the product distribution plan remain unresolved, so this root is
not copied into a product or release surface.

`cosim.html`, `js/cosim-graph.js` and `js/cosim-studio.js` provide the first
guided visual composition surface over the shipped `rust-core/` backend, not
the source-only native reference. The graph document is canonical and
checksummed, typed wires are checked before transport, and Guided, Manual and
Automatic draft modes all end at the same human approval boundary.
Assistant/debugger changes are proposals; they cannot apply themselves.

Thermal-runaway propagation is attached as a separate specialist analysis
module because its spatial two-node-per-cell model is not one scalar equation
block. It compares spacing/barriers and containment energy using
`js/runaway.js`, runs off the UI thread, and can return Fail or Unproven only.
It never returns Pass and never substitutes for UL 9540A or GB 38031 testing.
The customer result also presents a controlled NMC/LFP/LTO comparison in
plain language. Geometry, mass, stored energy, spacing, barrier, ambient and
state of charge remain identical; only the chemistry-class onset and release
multiple change. This makes the behavioral difference visible without
pretending that chemistry class replaces actual-cell ARC and propagation data.

The propagation evidence also keeps every inter-cell heat path separate:

\[
G_{gap}=\left(\frac{L_{barrier}}{k_{barrier}A}
 +\frac{L_{air}}{k_{air}A}\right)^{-1},\qquad
G_{spacer}=\frac{k_{spacer}f_{contact}A}{L_{spacer}}
\]

and `G_between = G_gap + G_spacer + G_interconnect`. Radiation is added with
the nonlinear Stefan–Boltzmann term only when an opaque barrier does not block
it. Spacer conductivity comes from the component library; contact fraction
and heat-path length remain visible geometry assumptions that must be checked
against the actual holder drawing. The customer receives this path breakdown,
a spacer/holder comparison and the equations—not only a temperature graph.

Emergency vent sizing is a second attached module rather than a hidden term
inside propagation. `js/venting.js` converts the declared low/high gas volume
and release-duration ranges to mass flow, evaluates the isentropic
subcritical or choked opening mass flux, and returns unobstructed free area
and equivalent diameter. It deliberately supplies no gas-yield default:
representative cell/module gas volume, composition, temperature and release
rate must be measured for the actual cell, SOC, age and abuse condition. The
screen does not model flame, combustion, vent opening dynamics, ducts,
ejecta, enclosure response or exclusion zones, and is not NFPA 68 sizing.

`js/vent-layout.js` is a third, downstream decision layer. It requires a
supplier-declared free area and footprint, selects multiple units when the
high-case area exceeds one unit, constrains them to the actual enclosure and
human-permitted faces, and returns provisional coordinates. It blocks a
layout that cannot fit rather than changing pressure assumptions. See
[`VENT_LAYOUT.md`](VENT_LAYOUT.md) for the exact market and approval boundary.

Calculation verification is split again from the physical model. The SIL
runner executes the versioned software adapter against independent numeric
oracles while checking graph/model/solver identity, units and exact
repeatability. The HIL module defines the fixed-period I/O, fault, overrun and
safe-state contract and evaluates measured hardware evidence. A generated HIL
contract without target evidence remains Unproven; browser playback is never
described as HIL. The full boundary is in `docs/LOOP_TESTING.md`.

This is a real solver, but it is not yet a general industrial DAE platform.
The following remain explicitly unshipped:

- physical conserving ports and automatic index reduction;
- any product-shipped large-sparse, SuiteSparse/KLU or other sparse-linear-
  algebra backend beyond the CI-only Linux source reference described above;
- general-DAE qualification or product-facing high-order BDF/IDA integration;
- any SUNDIALS or PETSc adapter in browser WebAssembly, a service, the desktop
  application or a product package;
- an FMI 3.0 importing master and scheduled execution;
- certification for safety-critical decisions.

The existing `js/fmi.js` source-FMU exporter is a separate compatibility
feature. Its presence does not imply any of the unshipped capabilities above.

## High-order DAE backend campaign

The first campaign iteration is deliberately a dependency-free lowering
foundation inside `rust-core/`. It describes the existing compiled graph in a
backend-neutral residual form, but it does not add a new numerical method or
make a DAE result available to the product. The built-in Dormand-Prince and
backward-Euler implementations remain the only shipped integrators.

The campaign is split into independently reviewable gates:

1. **Residual lowering foundation:** `DaeResidualSystem` defines and tests one
   deterministic mapping from a validated compiled graph to backend-neutral
   variables, residual rows, numeric differential/algebraic IDs, initialization,
   events, CSC structure and work-buffer sizes. This iteration adds no external
   library dependency.
2. **Native dense IDA reference path:** this is split again so that every
   change remains short and independently reversible:
   - **2A — source pin (complete):** lock the exact official release asset,
     tag object, commit, byte length, SHA-256, BSD-3-Clause license and NOTICE
     identities;
   - **2B — minimal Linux build (complete):** compile the official IDA-only
     distribution with every optional third-party solver disabled, then prove
     the reference probe selects the serial vector, dense matrix and dense
     linear solver. Upstream does not expose a native-module switch for a
     dense-only binary;
   - **2C — FFI compile contract (complete):** bind and version-check only the
     C symbols required by the adapter;
   - **2D — safe lifecycle (complete):** construct and destroy the context,
     vectors, matrix, linear solver and IDA memory through owned Rust wrappers;
   - **2E — residual bridge (complete):** connect the allocation-free residual
     contract to IDA with pinned user data, panic containment and exact
     first-error preservation;
   - **2F — dense Jacobian bridge (complete):** map deterministic CSC values
     into the native dense column-major matrix with checked view orientation;
   - **2G — initialization and solve (complete):** apply IDs, scalar or vector
     tolerances and both supported initial-condition policies, then execute a
     cumulatively bounded `IDA_ONE_STEP` requested-grid solve;
   - **2H — diagnostics and evidence (complete):** expose stable failure and
     result identities, solve-statistic deltas, a three-level analytical
     tolerance-convergence study, an in-repository Dormand–Prince comparison,
     an independently generated SciPy 1.17.0 Radau Robertson reference, and
     adversarial native-boundary evidence.

   Tasks 2C–2H are implemented and tested in the source-only optional
   `rust-dae-native/` crate under the `sundials-ida` feature. Completion of
   these subtasks creates a bounded native Linux reference backend, not a
   browser, desktop, service, package, release or general-DAE capability.
3. **Sparse native path (complete as a source-only Linux reference):** preserve
   linear deterministic CSC lowering; govern the second SuiteSparse source,
   build, license and exact static-link boundary; implement the separate
   IDA/KLU/COLAMD identity and sparse callback; and exercise bounded admission,
   real numerical solves, failure evidence and scale-specific tests. The
   10,000-variable evidence is lowering/admission evidence, not a
   10,000-variable native convergence claim.
4. **Native execution integration (event restart complete; service pending):**
   the coordinated `@2` contracts add the governed opt-in event restart
   described above. A bounded native service protocol and desktop integration
   still must be added without routing untrusted requests directly into the
   solver process.
5. **Package and release acceptance:** expose only backend/method combinations
   that passed native conformance, package the accepted binaries, prove their
   exact artifact lineage in CI and preserve the built-in fallback.

Iterations 2 and 3 and the event-restart slice of Iteration 4 are implemented
and tested only as source-only native Linux references; none is
product-packaged or released. The Iteration 4 service/desktop slice and all of
Iteration 5 remain unimplemented and unshipped. `rust-core/` itself remains
dependency-free and does not compile or link SUNDIALS, IDA, SuiteSparse or
KLU. The completed work does not provide index reduction, qualify general
implicit DAEs, expose a native service or desktop integration, or change the
current WebAssembly ABI. Neither native reference may appear in product
capability metadata until the later integration, package and release gates
exist. A SUNDIALS WebAssembly build is an optional later qualification track,
not an implied outcome of native acceptance: Emscripten uses a distinct
platform ABI, while the current standalone WebAssembly solver remains intact.

Task 2A adds `native-backends/sundials/source-lock.json`, checked-in license
notices and an offline byte verifier. The lock identifies the official
SUNDIALS 7.8.0 IDA-only source distribution; it does not download, extract,
compile, link or execute upstream code. Those actions remain gated behind
Task 2B.

Task 2B adds a Linux-only, CI reference build of that locked archive. The
build accepts a caller-supplied archive, verifies its length and SHA-256 before
extracting it, configures a static Release build with double precision,
64-bit indices and every optional third-party library disabled, and consumes
the installed CMake package from a separate probe project. The probe checks
the exact runtime version and type widths, then creates and destroys an IDA
memory object together with a serial vector, native dense matrix and native
dense linear solver. It does not register residual callbacks, call `IDAInit`
or run a numerical solve.

Task 2B alone proves a repeatable reference build and the selected C object
lifecycle on Ubuntu only. It does not add Rust FFI, link SUNDIALS into
`rust-core`, alter the WebAssembly build, package a native library, qualify a
DAE result or expose a product capability. The upstream IDA-only distribution
also contains other mandatory native vector, matrix and iterative-solver
modules; Task 2B therefore makes no claim that the installed package or
compiled archives are dense-only.

Tasks 2C–2H build on, rather than rewrite, that source and build history. The
optional sibling crate owns the narrow Rust FFI, lifetime-safe native object
stack, contained residual and dense-Jacobian callbacks, initialization,
requested-grid solve, result/statistic contract and reference campaign.
`rust-core/` remains dependency-free, and the source-only adapter is not copied
into or selected by any product surface. The accepted evidence therefore says
that this exact dense serial native reference configuration works on Linux; it
does not say that every module in the upstream IDA distribution is dense, that
an arbitrary DAE will converge or that a user can select IDA in the product.

Iteration 3 adds a separate optional KLU identity instead of widening the dense
contract. The sparse callback validates native type, shape, byte ranges and
disjointness before making Rust slices, and restores column pointers, row
indices and numeric values after every SUNDIALS sparse-matrix zero operation.
The result retains the original IDA stage and flag if querying the last KLU
flag also fails. These controls qualify the tested source reference; they do
not establish isolation, arbitrary sparse convergence or product readiness.

## Numerical contract

Every run follows the same sequence:

1. Validate block parameters and exact port quantities.
2. Reject missing or multiply connected input ports.
3. Partition continuous states from algebraic outputs.
4. Topologically evaluate an acyclic algebraic graph, or assemble and solve
   the simultaneous residual `y - f(t, x, y) = 0` when feedback remains.
5. Recommend explicit Dormand-Prince or implicit backward Euler from the
   declared time scales, unless a specialist explicitly selected a method.
6. Integrate `dx/dt = g(t, x, y)` with adaptive local-error control. The
   implicit path solves each state residual with a damped Newton iteration.
7. Shorten a step at every declared time event.
8. Return the trace, selected-method reason, nonlinear-iteration count,
   accepted/rejected step counts and graph summary.

No UI, AI layer or external adapter may bypass compilation or silently loosen
the tolerances. A materially changed graph is a new governed design version
and must pass human review again before release.

## Validation gates

Native Rust tests currently prove:

- incompatible quantities are rejected before compilation;
- every required input must be connected exactly once;
- a coupled two-variable algebraic loop reaches its analytical solution;
- an oversized step is rejected and a fast first-order response converges to
  its analytical solution;
- separated fast and slow states select the implicit method, remain stable and
  converge to their analytical solutions;
- a deliberately oversized implicit step remains bounded for a fast state;
- an integrator conserves accumulated energy for a constant-power case;
- the electrothermal reference graph lands on its current-step event and
  matches analytical terminal-voltage, heat and temperature results;
- the DAE residual lowering preserves deterministic differential-first and
  BlockId mappings, numeric differential/algebraic IDs, consistent initial
  conditions, stable output order and exact caller-owned buffer lengths;
- closed-form and independent finite-difference checks cover residual and CSC
  Jacobian values, accumulated duplicate-source terms, exact distinct-event
  preservation, right continuity and fail-closed buffer, finite-input and
  nonsmooth-Jacobian behavior;
- instrumented allocator checks prove zero heap allocations across successful
  caller-buffer callbacks after lowering; they do not claim allocation-free
  lowering or initialization construction.

The focused Iteration 1 DAE campaign contains 28 unique tests. The focused
Iteration 2 native campaign contains 81 unique native cases: 80 feature-on
cases plus one feature-off case proving explicit unavailability without
fallback. This is more than twice the Iteration 1 focused count; it is a
scope-for-scope campaign comparison, not a claim that the repository's global
test suite doubled.

The frozen pre-implementation Iteration 3 sparse-readiness proxy is derived
from merged Iteration 2 SHA
`9f4a43421de34efd067d38a070a0f2c4b9a859dc`. Its exact population is every
Cargo `#[test]` function name in `rust-dae-native/src/native.rs` (67),
`rust-dae-native/tests/feature_off.rs` (1),
`rust-dae-native/tests/backend_identity.rs` (2) and
`rust-dae-native/tests/solve_reference.rs` (11): 81 unique names in total.
Sort those names and retain the ones matching the case-sensitive regular
expression
`(csc|jacobian|matrix|sparse|linear_solver|resource|construction|drop|backend)`.
That unchanged procedure produces the 21-name denominator frozen verbatim in
`tests/dae-iteration3-evidence.test.mjs`, so the acceptance floor is 42 without
requiring Git history during a test run. Iteration 3 adds exactly 48
manifest-listed KLU cases: four feature-off cases, 25
identity/admission/scaling cases and 19 solve/failure/lifecycle cases. That is
48 / 21 = 2.29 times the frozen scope-for-scope proxy and clears the floor.
Six additional KLU-only internal callback and diagnostic seam tests execute
inside the crate's unit-test binary but are reported separately and are not
used to inflate the 48-case comparison. This is not a claim that the
repository's global test suite doubled.

The separate source/build campaign passes 80/80 focused source,
configuration, receipt and link cases, followed by 28/28 mutation attacks.
The prior 81-case dense native campaign is retained unchanged in its own
feature configurations. Sparse numerical evidence covers closed-form
exponential response, an affine index-one system, the same independently
generated Robertson Radau fixture, repeated Jacobian reconstruction, typed
failure propagation and deterministic fresh sessions. Scale claims remain
literal: the 10,000-variable chain is lowered and admitted, while the largest
real native session in this campaign is the 1,000-variable chain.

The 80 feature-on cases cover exact runtime identity and context recreation;
native resource construction and drop order; complete registration order;
both initial-condition policies; scalar/vector tolerances; BDF order 1 and 5;
callback shape, alias, error, panic and allocation behavior; global
`IDA_ONE_STEP` accounting and bounded interpolation; target-span floating-point
edges; result shape, identities and statistics; analytical exponential and
affine index-one systems; three-decade analytical tolerance convergence; and
the same ODE graph solved independently by rust-core Dormand–Prince. The stiff
Robertson index-one case is also compared with fixed values independently
generated by SciPy 1.17.0 `solve_ivp(method='Radau')` at `rtol=1e-12` and
`atol=1e-14`; the reproduction parameters and official SciPy solver-document
URL are preserved beside the regression. The separate build-provenance harness
attacks canonical lock and receipt bytes, install contents and archive
identities. These Iteration 2 tests establish the bounded dense reference
configuration only; the separate Iteration 3 campaign qualifies only its exact
Linux KLU source reference. Neither campaign qualifies arbitrary DAEs, event
restarts, another operating system or a product package.

Before exposing the native reference through a product, the later campaign
gates must keep these tests and add the platform, integration, packaging and
release evidence for that exact surface. Any materially broader sparse or DAE
backend additionally needs its own benchmark, convergence and independent
cross-validation campaign. The built-in backward-Euler path remains the
shipped auditable fallback for small stiff ODE graphs; it is not presented as
IDA, CVODE or a general industrial DAE solver. The UI may describe the
capability that passed—not the capability that is merely present in source or
planned.

## Human-facing product boundary

Managers and non-specialist engineers should receive a guided template,
requirements, assumptions, Pass/Review/Fail results and one approval decision.
Application engineers may open the graph and evidence. Simulation specialists
may open tolerances, events and residual diagnostics. All three views refer to
the same versioned graph and result identifier.

Validation failures expose a stable code such as
`connection.quantity_mismatch` or `solver.implicit_non_convergence` and a
conservative suggested action. The shipped assistant may explain or draft
that action, but it may not reconnect blocks, alter tolerances or approve the
model without the existing human review workflow. The studio enforces this by
returning immutable proposals and requiring a named human carrying
`edit-graph` authority before a draft or deterministic repair is applied.
