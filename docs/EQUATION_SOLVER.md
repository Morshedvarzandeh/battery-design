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
- the dependency-free `battery-design/dae-residual@1` lowering contract:
  `DaeResidualSystem::lower` publishes deterministic differential/algebraic
  variable and output mappings, the numeric ID vector, consistent initial
  values, exact event times, a deterministic CSC Jacobian pattern and exact
  caller-owned buffer requirements. After lowering, its successful
  caller-buffer callbacks allocate no heap memory; lowering and initialization
  construction may allocate, and the contract does not select or contain a
  DAE solver.

### Iteration 2 native reference boundary

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
- large sparse Jacobians, SuiteSparse/KLU and other sparse linear algebra;
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
3. **Sparse native path:** add an explicitly qualified sparse Jacobian and KLU
   configuration, with sparsity, scaling and large-model convergence evidence.
4. **Native execution integration:** add governed event restart plus a bounded
   native service protocol and desktop integration without routing untrusted
   requests directly into the solver process.
5. **Package and release acceptance:** expose only backend/method combinations
   that passed native conformance, package the accepted binaries, prove their
   exact artifact lineage in CI and preserve the built-in fallback.

Iteration 2 is implemented and tested only as the native Linux dense reference
described above; it is not product-packaged or released. Iterations 3–5 remain
unimplemented and unshipped. `rust-core/` itself remains dependency-free and
does not compile or link SUNDIALS, IDA, SuiteSparse or KLU. Neither completed
iteration provides index reduction, qualifies general implicit DAEs, adds a
KLU/sparse path, exposes a native service or desktop integration, or changes
the current WebAssembly ABI. The native reference must not appear in product
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
identities. These tests establish this bounded reference configuration only;
they do not qualify arbitrary DAEs, sparse KLU, event restarts, another
operating system or a product package.

Before exposing the native reference through a product, the later campaign
gates must keep these tests and add the platform, integration, packaging and
release evidence for that exact surface. A sparse or materially broader DAE
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
