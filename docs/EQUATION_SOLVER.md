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
- a coupled electrical/thermal cell reference graph.

This is a real solver, but it is not yet a general industrial DAE platform.
The following remain explicitly unshipped:

- a visual block canvas and drag/drop editing;
- generic browser/Wasm graph serialization;
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
conservative suggested action. A future assistant may explain or draft that
action, but it may not reconnect blocks, alter tolerances or approve the model
without the existing human review workflow.
