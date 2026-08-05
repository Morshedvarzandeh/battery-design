# Rust equation-graph solver

This is the numerical backend for the future block-based Co-Simulation Studio.
It is deliberately independent of the visual canvas: the canvas will edit and
review a graph, while this module decides whether that graph is valid and what
its equations predict.

## Shipped boundary

`rust-core/src/equations.rs` currently provides:

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
  `[time, block values...]` trace rows without introducing a second solver.

`cosim.html`, `js/cosim-graph.js` and `js/cosim-studio.js` provide the first
guided visual composition surface over that exact backend. The graph document
is canonical and checksummed, typed wires are checked before transport, and
Guided, Manual and Automatic draft modes all end at the same human approval
boundary. Assistant/debugger changes are proposals; they cannot apply
themselves.

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
- large sparse Jacobians and sparse linear algebra;
- high-order BDF/IDA-class stiff integration and general implicit DAEs;
- SUNDIALS or PETSc adapters;
- an FMI 3.0 importing master and scheduled execution;
- certification for safety-critical decisions.

The existing `js/fmi.js` source-FMU exporter is a separate compatibility
feature. Its presence does not imply any of the unshipped capabilities above.

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
  matches analytical terminal-voltage, heat and temperature results.

Before adding a SUNDIALS, high-order BDF, DAE or sparse backend, its adapter
must keep these tests and add solver-specific benchmark suites,
tolerance-convergence studies and cross-validation against a trusted external
implementation. The built-in backward-Euler path is an auditable reliability
fallback for small stiff ODE graphs; it is not presented as IDA, CVODE or a
general industrial DAE solver. The UI may describe the capability that
passed—not the capability that is merely planned.

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
