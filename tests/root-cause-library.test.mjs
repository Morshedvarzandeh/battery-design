import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROOT_CAUSE_CATALOG,
  ROOT_CAUSE_CATALOG_FORMAT,
  ROOT_CAUSE_RECORD_FORMAT,
  ROOT_CAUSE_RECORD_SCHEMA,
  ROOT_CAUSE_RECORDS,
  ROOT_CAUSE_SCHEMA_VERSION,
  findSimilarRootCauses,
  getRootCauseRecord,
  listRootCauseRecords,
  searchRootCauses,
  validateRootCauseCatalog,
  validateRootCauseRecord,
} from '../js/root-cause-library.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value), 'every exported knowledge object is frozen');
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('versioned seed catalog is closed, valid, immutable and locally referenced', () => {
  assert.equal(ROOT_CAUSE_CATALOG.format, ROOT_CAUSE_CATALOG_FORMAT);
  assert.equal(ROOT_CAUSE_CATALOG.version, ROOT_CAUSE_SCHEMA_VERSION);
  assert.equal(ROOT_CAUSE_RECORD_FORMAT, 'battery-design/root-cause-record@1');
  assert.equal(ROOT_CAUSE_RECORDS.length, 46);
  assert.deepEqual(validateRootCauseCatalog(), []);
  assert.equal(ROOT_CAUSE_RECORD_SCHEMA.additionalProperties, false);
  assertDeepFrozen(ROOT_CAUSE_RECORD_SCHEMA);
  assertDeepFrozen(ROOT_CAUSE_CATALOG);

  const requiredFields = [
    'symptom', 'evidence', 'detection', 'causalChain', 'rootCause', 'resolution',
    'prevention', 'regressionTests', 'affectedSurfaces', 'tags', 'status', 'references',
  ];
  for (const field of requiredFields) assert.ok(ROOT_CAUSE_RECORD_SCHEMA.required.includes(field), field);

  for (const record of ROOT_CAUSE_RECORDS) {
    assert.deepEqual(validateRootCauseRecord(record), [], record.id);
    for (const regression of record.regressionTests) {
      assert.ok(existsSync(resolve(ROOT, regression.path)), `${record.id}: ${regression.path}`);
    }
    for (const reference of record.references) {
      if (/^(?:\.|[a-z0-9_-]+)\//i.test(reference.locator)) {
        assert.ok(existsSync(resolve(ROOT, reference.locator)), `${record.id}: ${reference.locator}`);
      }
    }
  }
});

test('seed knowledge covers the requested recurring engineering failure classes', () => {
  assert.deepEqual(ROOT_CAUSE_RECORDS.map(({ id }) => id), [
    'rc-adaptive-integration-work-undercount',
    'rc-allof-closure-collision',
    'rc-calibration-holdout-relabel-leakage',
    'rc-calibration-holdout-score-masking',
    'rc-calibration-initial-state-ambiguity',
    'rc-calibration-parameter-identifiability-confounding',
    'rc-calibration-result-artifact-shape',
    'rc-calibration-result-identity-gap',
    'rc-calibration-trace-alignment-loss',
    'rc-calibration-work-undercount',
    'rc-capability-contract-mismatch',
    'rc-cli-typo-default-fallback',
    'rc-dae-csc-quadratic-lowering',
    'rc-dae-lowering-contract-gap',
    'rc-e2e-hidden-state-precondition',
    'rc-final-artifact-identity-gap',
    'rc-fmi-calibration-key-ignored',
    'rc-fmi-representation-drift',
    'rc-hil-contract-deployment-gap',
    'rc-hil-result-identity-gap',
    'rc-hil-timing-coverage-gap',
    'rc-ida-global-step-accounting-gap',
    'rc-ida-initial-target-span-gap',
    'rc-loop-contract-identity-gap',
    'rc-native-dae-callback-boundary-gap',
    'rc-native-solver-build-provenance-gap',
    'rc-nelder-mead-bound-simplex-collapse',
    'rc-nullable-alias-projection',
    'rc-object-allowlist-prototype-bypass',
    'rc-packaged-dependency-omission',
    'rc-product-surface-claim-drift',
    'rc-rc-euler-step-instability',
    'rc-regression-path-containment-gap',
    'rc-resource-self-checksum-trust',
    'rc-rust-msrv-float-pattern-lint-gap',
    'rc-schema-envelope-permissive',
    'rc-shared-test-mutex-poison-cascade',
    'rc-signed-bound-evidence-miss',
    'rc-sil-result-representation-gap',
    'rc-solver-evidence-acceptance-drift',
    'rc-solver-sparse-build-provenance-gap',
    'rc-solver-sparse-jacobian-pattern-erasure',
    'rc-source-revision-self-claim',
    'rc-test-multiplier-denominator-drift',
    'rc-thermal-explicit-step-instability',
    'rc-tree-link-containment',
  ]);
  assert.equal(ROOT_CAUSE_RECORDS.find(({ id }) => (
    id === 'rc-calibration-holdout-relabel-leakage'
  )).status, 'resolved');
  assert.equal(ROOT_CAUSE_RECORDS.find(({ id }) => (
    id === 'rc-calibration-parameter-identifiability-confounding'
  )).status, 'mitigated');

  for (const record of ROOT_CAUSE_RECORDS) {
    assert.ok(record.causalChain.length >= 2);
    assert.ok(record.resolution.length && record.prevention.length);
    assert.ok(record.detection.every((item) => item.method && item.signal && item.failureCondition));
  }
});

test('regression paths admit both governed Rust test roots without admitting escapes or non-Rust files', () => {
  const candidate = structuredClone(ROOT_CAUSE_RECORDS[0]);
  for (const path of [
    'rust-core/tests/dae_contract.rs',
    'rust-dae-native/tests/solve_reference.rs',
    'rust-dae-native/tests/nested/reference_case.rs',
  ]) {
    candidate.regressionTests = [{
      path,
      assertion: 'A repository-local Rust integration test may carry substantive numerical evidence.',
    }];
    assert.deepEqual(validateRootCauseRecord(candidate), [], path);
  }

  for (const path of [
    '/rust-core/tests/dae_contract.rs',
    'C:/rust-core/tests/dae_contract.rs',
    'C:\\rust-core\\tests\\dae_contract.rs',
    '\\\\server\\share\\rust-core\\tests\\dae_contract.rs',
    'rust-core/src/dae.rs',
    'rust-core/tests/dae_contract.mjs',
    'rust-core/tests/../src/dae.rs',
    'rust-core/tests/nested/../../src/dae.rs',
    'rust-core/tests/..\\src\\dae.rs',
    'rust-core/tests/nested\\..\\src\\dae.rs',
    '/rust-dae-native/tests/solve_reference.rs',
    'D:/rust-dae-native/tests/solve_reference.rs',
    'D:\\rust-dae-native\\tests\\solve_reference.rs',
    '\\\\server\\share\\rust-dae-native\\tests\\solve_reference.rs',
    'rust-dae-native/src/native.rs',
    'rust-dae-native/tests/solve_reference.mjs',
    'rust-dae-native/tests/../src/native.rs',
    'rust-dae-native/tests/nested/../../src/native.rs',
    'rust-dae-native/tests/..\\src\\native.rs',
    'rust-dae-native/tests/nested\\..\\src\\native.rs',
    'tests/../package.json',
    'tests\\..\\package.json',
  ]) {
    candidate.regressionTests[0].path = path;
    assert.ok(
      validateRootCauseRecord(candidate).some(({ path: issuePath, code }) => (
        issuePath === '$/regressionTests/0/path' && code === 'pattern'
      )),
      path,
    );
  }
});

test('DAE lowering memory separates a residual contract from solver qualification', () => {
  const record = getRootCauseRecord('rc-dae-lowering-contract-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /differential states[\s\S]*algebraic block outputs[\s\S]*permute y, yp, residual and output/i);
  assert.match(record.evidence.join(' '), /1\.0[\s\S]*1\.0\+5e-13[\s\S]*collapsed[\s\S]*backend restart/i);
  assert.match(record.rootCause, /versioned backend-neutral lowering contract[\s\S]*sparse storage[\s\S]*caller-owned buffer/i);
  assert.match(record.resolution.join(' '), /DaeResidualSystem::lower[\s\S]*DAE_RESIDUAL_CONTRACT_VERSION[\s\S]*battery-design\/dae-residual@1[\s\S]*compiled state order[\s\S]*BlockId order[\s\S]*1\/0 differential\/algebraic ID vector[\s\S]*yp - f\(t, y\)[\s\S]*y - rhs\(t, y\)[\s\S]*deterministic CSC[\s\S]*no-partial-write[\s\S]*right-continuously[\s\S]*nonsmooth bound/i);
  assert.match(record.resolution.join(' '), /caller-buffer callbacks heap-allocation-free[\s\S]*lowering itself/i);
  assert.match(record.resolution.join(' '), /deduplicate only exact numeric equals[\s\S]*signed-zero[\s\S]*preserve every distinct finite event time/i);
  assert.match(record.resolution.join(' '), /SUNDIALS[\s\S]*IDA[\s\S]*outside the Iteration 1 lowering claim[\s\S]*optional Linux native reference[\s\S]*SuiteSparse[\s\S]*KLU[\s\S]*unshipped[\s\S]*not a solver capability/i);
  assert.deepEqual(record.regressionTests.map(({ path }) => path), [
    'rust-core/tests/dae_contract.rs',
    'rust-core/tests/dae_allocation.rs',
    'tests/root-cause-library.test.mjs',
  ]);
  assert.equal(
    searchRootCauses('DAE residual CSC duplicate Jacobian event buffer lowering', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('DAE CSC memory preserves linear construction before sparse qualification', () => {
  const record = getRootCauseRecord('rc-dae-csc-quadratic-lowering');
  assert.equal(record?.status, 'resolved');
  assert.match(`${record.symptom} ${record.evidence.join(' ')}`, /10,000-variable[\s\S]*19,999[\s\S]*one hundred million[\s\S]*N squared/i);
  assert.match(record.rootCause, /column-by-row search[\s\S]*bounded transpose[\s\S]*row dependencies/i);
  assert.match(record.resolution.join(' '), /Traverse rows twice[\s\S]*prefix-sum[\s\S]*generation marker[\s\S]*strictly row-sorted[\s\S]*four bounded[\s\S]*1,000-[\s\S]*10,000-variable/i);
  assert.match(record.prevention.join(' '), /vertices[\s\S]*compiled edges[\s\S]*nonzeros[\s\S]*wall-clock thresholds[\s\S]*KLU fill-in/i);
  const source = readFileSync(resolve(ROOT, 'rust-core/src/dae.rs'), 'utf8');
  assert.match(source, /Pass one counts each structural[\s\S]*column_counts[\s\S]*Pass two|Pass one counts each structural[\s\S]*Reuse the count buffer as per-column write cursors/i);
  assert.doesNotMatch(source, /for column in 0\.\.variable_count\s*\{\s*for variable in variables/);
  assert.equal(
    searchRootCauses('sparse CSC quadratic row column scan 10000 chain lowering', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('sparse native provenance binds both sources, real linkage and license limits', () => {
  const record = getRootCauseRecord('rc-solver-sparse-build-provenance-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /ordinary spaces[\s\S]*tar output[\s\S]*nvecserial[\s\S]*sunmatrixsparse[\s\S]*omit-one direct links still passed[\s\S]*redundant archive[\s\S]*every \*_CHECKS[\s\S]*LGPL-2\.1-or-later/i);
  assert.match(record.rootCause, /separate governed two-source build[\s\S]*link[\s\S]*license[\s\S]*runtime-evidence boundary/i);
  assert.match(record.resolution.join(' '), /SuiteSparse 7\.7\.0[\s\S]*KLU 2\.3\.3[\s\S]*85,876,065-byte[\s\S]*ordinary spaces[\s\S]*exact allowlist[\s\S]*receipt@2[\s\S]*exactly eight[\s\S]*omit the redundant standalone nvecserial and sunmatrixsparse[\s\S]*factor and solve[\s\S]*complete upstream LGPL-2\.1 texts[\s\S]*CI-only/i);
  assert.match(record.prevention.join(' '), /successful real link[\s\S]*remove redundant archives[\s\S]*initial build, reuse[\s\S]*self-consistent archive-tamper[\s\S]*dense build unchanged[\s\S]*browser, desktop, installer and release/i);
  assert.deepEqual(
    record.regressionTests.slice(0, 3).map(({ path }) => path),
    [
      'tests/suitesparse-source-lock.test.mjs',
      'tests/sundials-klu-native-build.test.mjs',
      'tools/test-native-dae-klu-build.mjs',
    ],
  );
  assert.equal(
    searchRootCauses('SuiteSparse KLU two source static link license archive spaces nvecserial', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('sparse Jacobian memory preserves full CSC restoration after native zeroing', () => {
  const record = getRootCauseRecord('rc-solver-sparse-jacobian-pattern-erasure');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /SUNMatZero_Sparse[\s\S]*numeric data[\s\S]*row-index[\s\S]*column-pointer[\s\S]*repeated-callback/i);
  assert.match(record.rootCause, /construction-time state[\s\S]*matrix-zero operation[\s\S]*structure and values/i);
  assert.match(record.resolution.join(' '), /matrix type[\s\S]*checked byte ranges[\s\S]*disjointness[\s\S]*every successful sparse Jacobian callback[\s\S]*column-pointer[\s\S]*row-index[\s\S]*numeric values[\s\S]*structural diagonal[\s\S]*more than one real KLU Jacobian setup/i);
  assert.deepEqual(
    record.regressionTests.slice(0, 2).map(({ path }) => path),
    [
      'rust-dae-native/tests/klu_solve_reference.rs',
      'rust-dae-native/tests/klu_backend_identity.rs',
    ],
  );
  const source = readFileSync(resolve(ROOT, 'rust-dae-native/src/native.rs'), 'utf8');
  assert.match(source, /sparse_callback_restores_columns_rows_and_values_after_every_zero[\s\S]*column_pointers[\s\S]*row_indices[\s\S]*jacobian_values_into/);
  assert.equal(
    searchRootCauses('SUNDIALS sparse matrix zero CSC row index column pointer callback restore', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('regression-path memory preserves cross-platform repository containment', () => {
  const record = getRootCauseRecord('rc-regression-path-containment-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /non-whitespace middle[\s\S]*Windows backslashes[\s\S]*rust-core\/tests\/\.\.\\src\\dae\.rs/i);
  assert.match(record.rootCause, /Linux-oriented prefix[\s\S]*platform-independent relative-path grammar/i);
  assert.equal(record.revision, 2);
  assert.match(record.resolution.join(' '), /exact rust-core\/tests or rust-dae-native\/tests prefix[\s\S]*\.rs suffix[\s\S]*safe ASCII segments[\s\S]*forward slashes[\s\S]*dot segments[\s\S]*backslashes[\s\S]*drive-letter[\s\S]*UNC/i);
  assert.match(record.prevention.join(' '), /Never use[\s\S]*non-whitespace class[\s\S]*POSIX and Windows separators/i);
  assert.equal(
    searchRootCauses('Rust regression evidence Windows backslash traversal UNC containment', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('native IDA memories keep seven causes separate, resolved and exactly searchable', () => {
  const ids = [
    'rc-ida-global-step-accounting-gap',
    'rc-ida-initial-target-span-gap',
    'rc-native-dae-callback-boundary-gap',
    'rc-native-solver-build-provenance-gap',
    'rc-rust-msrv-float-pattern-lint-gap',
    'rc-shared-test-mutex-poison-cascade',
    'rc-solver-evidence-acceptance-drift',
  ];
  assert.deepEqual(ids.map((id) => getRootCauseRecord(id)?.status), [
    'resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'resolved',
  ]);

  const globalSteps = getRootCauseRecord('rc-ida-global-step-accounting-gap');
  assert.match(globalSteps.rootCause, /per-IDASolve native work limit[\s\S]*cumulative request limit/i);
  assert.match(globalSteps.resolution.join(' '), /IDA_ONE_STEP[\s\S]*before every native step[\s\S]*increase the native counter by exactly one[\s\S]*IDAGetDky[\s\S]*explicit upper bound/i);

  const targetSpan = getRootCauseRecord('rc-ida-initial-target-span-gap');
  assert.match(targetSpan.rootCause, /exact floating-point target span[\s\S]*each IDA operation[\s\S]*initial-condition policy/i);
  assert.match(targetSpan.resolution.join(' '), /0\.001-scaled step[\s\S]*finite reciprocal[\s\S]*representable forward addition[\s\S]*roundoff[\s\S]*ContractConsistent[\s\S]*final IDASolve target[\s\S]*CorrectAlgebraicAndDerivative[\s\S]*first requested IDACalcIC tout1/i);

  const callbacks = getRootCauseRecord('rc-native-dae-callback-boundary-gap');
  assert.match(callbacks.rootCause, /pinned[\s\S]*pointer-view safety[\s\S]*unwind containment[\s\S]*first-error preservation[\s\S]*callback workspace/i);
  assert.match(callbacks.resolution.join(' '), /disjointness before constructing Rust slices[\s\S]*catch every residual and Jacobian unwind[\s\S]*first DaeError[\s\S]*repeated successful callbacks perform zero heap allocations[\s\S]*without extending that claim/i);

  const build = getRootCauseRecord('rc-native-solver-build-provenance-gap');
  assert.match(build.evidence.join(' '), /authoritative upstream lock[\s\S]*battery-design\/sundials-source-lock@1[\s\S]*native-backends\/sundials\/source-lock\.json[\s\S]*official IDA-only distribution[\s\S]*mandatory native vector, matrix and iterative-solver modules[\s\S]*not[\s\S]*dense-only/i);
  assert.match(build.evidence.join(' '), /helper reuse check[\s\S]*parsed receipt JSON semantically[\s\S]*identical duplicate key[\s\S]*build\.rs rejected[\s\S]*noncanonical raw receipt/i);
  assert.match(build.evidence.join(' '), /self-consistent receipt[\s\S]*empty but valid static archive[\s\S]*content agreement alone[\s\S]*real backend-identity link/i);
  assert.match(build.resolution.join(' '), /battery-design\/sundials-source-lock@1[\s\S]*native-backends\/sundials\/source-lock\.json[\s\S]*ida-7\.8\.0\.tar\.gz[\s\S]*5,022,403-byte[\s\S]*tools\/verify-sundials-source\.mjs[\s\S]*tools\/build-sundials-ida\.mjs[\s\S]*bounded regular-file IDA archive root[\s\S]*official asset is IDA-only by solver family[\s\S]*without claiming a dense-only binary[\s\S]*sundials-build-receipt@1[\s\S]*canonical receipt bytes[\s\S]*real feature-on backend-identity binary[\s\S]*receipt consistency alone is not semantic usability[\s\S]*do not authenticate the publisher[\s\S]*artifact custody/i);
  assert.deepEqual(
    build.regressionTests.slice(0, 2).map(({ path }) => path),
    ['tests/sundials-source-lock.test.mjs', 'tests/sundials-native-build.test.mjs'],
  );

  const mutex = getRootCauseRecord('rc-shared-test-mutex-poison-cascade');
  assert.match(mutex.evidence.join(' '), /12\.0[\s\S]*12\.000000000000002[\s\S]*10 passes[\s\S]*52 failures[\s\S]*one source assertion[\s\S]*51 follow-on[\s\S]*poison failures/i);
  assert.match(mutex.resolution.join(' '), /absolute and relative tolerances[\s\S]*poison-recovering test_lock[\s\S]*reset each test.s instrumentation state/i);

  const msrv = getRootCauseRecord('rc-rust-msrv-float-pattern-lint-gap');
  assert.match(msrv.evidence.join(' '), /PR 75[\s\S]*illegal-floating-point-literal-pattern[\s\S]*Rust 1\.77\.2[\s\S]*Rust 1\.87\.0/i);
  assert.match(msrv.rootCause, /floating-point patterns[\s\S]*exact warning-denied minimum-supported Rust toolchain/i);
  assert.match(msrv.resolution.join(' '), /full IdaError structural equality[\s\S]*Rust 1\.77\.2[\s\S]*RUSTFLAGS=-Dwarnings/i);
  const nativeSource = readFileSync(resolve(ROOT, 'rust-dae-native/src/native.rs'), 'utf8');
  assert.match(nativeSource, /interpolation_guard_rejects_replaying_the_previous_step_endpoint[\s\S]*assert_eq![\s\S]*IdaError::InterpolationIntervalMiss/);
  assert.doesNotMatch(nativeSource, /matches!\([\s\S]{0,240}interval_start_s:\s*0\.5[\s\S]{0,120}interval_end_s:\s*0\.75/);
  const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /sundials-native-build:[\s\S]*RUSTFLAGS:\s*-Dwarnings[\s\S]*toolchain:\s*1\.77\.2/);

  const evidence = getRootCauseRecord('rc-solver-evidence-acceptance-drift');
  assert.match(evidence.rootCause, /rewritten evidence summary[\s\S]*each original acceptance item[\s\S]*concrete test[\s\S]*provenance/i);
  assert.match(evidence.resolution.join(' '), /loose, medium and tight[\s\S]*Dormand–Prince[\s\S]*SciPy 1\.17\.0[\s\S]*solve_ivp[\s\S]*Radau[\s\S]*relative tolerance[\s\S]*absolute tolerance[\s\S]*81-case/i);

  for (const [query, id] of [
    ['IDA ONE_STEP cumulative global max steps per call reset', 'rc-ida-global-step-accounting-gap'],
    ['IDA initial target span underflow roundoff representable progress tout tout1', 'rc-ida-initial-target-span-gap'],
    ['native DAE FFI callback alias panic first error zero allocation', 'rc-native-dae-callback-boundary-gap'],
    ['official IDA-only source lock bounded archive build receipt exact linked bytes', 'rc-native-solver-build-provenance-gap'],
    ['Rust MSRV float literal pattern lint warning denied CI compatibility', 'rc-rust-msrv-float-pattern-lint-gap'],
    ['exact float assertion poisoned shared test mutex 51 cascading failures', 'rc-shared-test-mutex-poison-cascade'],
    ['solver acceptance tolerance convergence cross validation external SciPy provenance', 'rc-solver-evidence-acceptance-drift'],
  ]) {
    assert.equal(searchRootCauses(query, { limit: 1 })[0]?.id, id, query);
  }
});

test('equation-solver guide reports the exact Iteration 2 reference and product boundary', () => {
  const guide = readFileSync(resolve(ROOT, 'docs/EQUATION_SOLVER.md'), 'utf8');
  const prose = guide.replace(/\s+/gu, ' ');
  assert.match(prose, /implements a bounded native Linux reference backend in[\s\S]*battery-design\/native-ida-dense@1[\s\S]*not part of the[\s\S]*browser, desktop, service, npm package or any released product artifact/i);
  assert.match(prose, /native Linux target using `panic=unwind`[\s\S]*SUNDIALS\/IDA 7\.8\.0[\s\S]*BDF orders 1 through 5[\s\S]*NVECTOR_SERIAL[\s\S]*SUNMATRIX_DENSE[\s\S]*SUNLINSOL_DENSE[\s\S]*static non-MPI linkage[\s\S]*double[\s\S]*64-bit indices/i);
  assert.match(prose, /at most 256 DAE variables[\s\S]*at most 100,000 requested output points[\s\S]*at most 10,000,000 cumulative internal steps[\s\S]*at most 25,600,000 returned scalar values/i);
  assert.match(prose, /ContractConsistent[\s\S]*CorrectAlgebraicAndDerivative[\s\S]*scheduled events are explicitly rejected[\s\S]*ida\.events\.unsupported/i);
  assert.match(prose, /battery-design\/sundials-source-lock@1[\s\S]*native-backends\/sundials\/source-lock\.json[\s\S]*official[\s\S]*ida-7\.8\.0\.tar\.gz[\s\S]*tools\/verify-sundials-source\.mjs[\s\S]*tools\/build-sundials-ida\.mjs/i);
  assert.match(prose, /official asset is IDA-only at the solver-family level[\s\S]*mandatory native vector, matrix and iterative-solver modules[\s\S]*no dense-only binary switch[\s\S]*selects[\s\S]*NVECTOR_SERIAL[\s\S]*SUNMATRIX_DENSE[\s\S]*SUNLINSOL_DENSE/i);
  for (const task of ['2A', '2B', '2C', '2D', '2E', '2F', '2G', '2H']) {
    assert.match(prose, new RegExp(`${task}[^;]*complete`, 'iu'), task);
  }
  assert.match(prose, /28 unique tests[\s\S]*81 unique native cases: 80 feature-on[\s\S]*one feature-off[\s\S]*more than twice[\s\S]*not a claim that the repository.s global test suite doubled/i);
  assert.match(prose, /three-level analytical[\s\S]*tolerance-convergence[\s\S]*Dormand–Prince[\s\S]*SciPy 1\.17\.0[\s\S]*solve_ivp[\s\S]*Radau[\s\S]*rtol=1e-12[\s\S]*atol=1e-14/i);
  assert.match(prose, /hashes[\s\S]*self-recomputed receipt do not[\s\S]*authenticate the publisher[\s\S]*reproducible-build equivalence[\s\S]*artifact custody[\s\S]*signed chain of possession/i);
  assert.match(prose, /tests\/sundials-source-lock\.test\.mjs[\s\S]*tests\/sundials-native-build\.test\.mjs[\s\S]*tools\/test-native-dae-build\.mjs[\s\S]*source, build, derived-install[\s\S]*real-link regression boundaries/i);
  assert.match(prose, /cosim\.html[\s\S]*shipped `rust-core\/` backend, not the source-only native reference/i);
  for (const boundary of [
    /SuiteSparse\/KLU/i,
    /index reduction/i,
    /browser WebAssembly/i,
    /native service/i,
    /desktop integration/i,
    /product-packaged or released/i,
  ]) assert.match(prose, boundary);
});

test('loop-contract memory preserves the mutation, identity and trust-boundary fix', () => {
  const record = getRootCauseRecord('rc-loop-contract-identity-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.rootCause, /versioning[\s\S]*structural validation[\s\S]*content identity/i);
  assert.match(record.evidence.join(' '), /sparse arrays[\s\S]*waive every fault check/i);
  assert.match(record.evidence.join(' '), /negative measured overrun count[\s\S]*could pass/i);
  assert.match(record.resolution.join(' '), /deep-frozen[\s\S]*dense arrays[\s\S]*non-negative safe integers[\s\S]*@2[\s\S]*expected checksum/i);
  assert.match(record.prevention.join(' '), /content identity[\s\S]*not producer authentication/i);
  assert.match(
    getRootCauseRecord('rc-object-allowlist-prototype-bypass')?.resolution.join(' '),
    /SIL output paths[\s\S]*own properties/i,
  );
  assert.equal(
    searchRootCauses('schema-only mutable nested SIL HIL contract checksum', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('SIL result memory preserves canonical repeat and plan-bound evidence', () => {
  const record = getRootCauseRecord('rc-sil-result-representation-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /JSON\.stringify[\s\S]*model ID[\s\S]*own checksum[\s\S]*null-prototype/i);
  assert.match(record.rootCause, /canonical closed representation[\s\S]*content identity/i);
  assert.match(record.resolution.join(' '), /canonical semantic digest[\s\S]*guarded message[\s\S]*deeply frozen[\s\S]*plan checksum/i);
  assert.match(record.prevention.join(' '), /content identity[\s\S]*not producer authentication/i);
  assert.equal(
    searchRootCauses('SIL repeatability key order mutable adapter result evidence', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('HIL deployment memory keeps reviewed tests separate from executable target mapping', () => {
  const record = getRootCauseRecord('rc-hil-contract-deployment-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /test contract deliberately defines[\s\S]*does not claim to be a target runtime manifest/i);
  assert.match(record.evidence.join(' '), /Number\.MAX_SAFE_INTEGER[\s\S]*plus one[\s\S]*safe integer/i);
  assert.match(record.evidence.join(' '), /NaN[\s\S]*Infinity[\s\S]*sparse array slots[\s\S]*null[\s\S]*FNV[\s\S]*SHA-256/i);
  assert.match(record.evidence.join(' '), /own __proto__[\s\S]*prototype setter[\s\S]*alias/i);
  assert.match(record.evidence.join(' '), /opaque runtime reference[\s\S]*filesystem path[\s\S]*slash separators/i);
  assert.match(record.rootCause, /test acceptance semantics[\s\S]*runtime deployment semantics[\s\S]*closed content-addressed adapter layer/i);
  assert.match(record.resolution.join(' '), /expected checksum[\s\S]*before canonical serialization[\s\S]*non-finite[\s\S]*null-prototype[\s\S]*__proto__[\s\S]*runtime-abi@1[\s\S]*relative namespaced references[\s\S]*slash-separated[\s\S]*physical endpoint[\s\S]*contract[\s\S]*never caller-authored semantic copies[\s\S]*fixed driver, scheduler or platform[\s\S]*safe-output vector[\s\S]*overrunMissesBeforeLatch[\s\S]*safe-integer[\s\S]*runtime remains unqualified/i);
  assert.match(record.prevention.join(' '), /content identity[\s\S]*never producer authentication[\s\S]*physical qualification/i);
  assert.equal(
    searchRootCauses('HIL ad hoc glue physical endpoint model port fault injector safe vector deployment', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('HIL timing memory keeps duration coverage separate from one fast sample', () => {
  const record = getRootCauseRecord('rc-hil-timing-coverage-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /30-second[\s\S]*30,000 required cycles/i);
  assert.match(record.evidence.join(' '), /0\.000123 seconds[\s\S]*123\.00000000000001[\s\S]*cycle 124/i);
  assert.match(record.rootCause, /declared run coverage[\s\S]*iterative scan/i);
  assert.match(record.resolution.join(' '), /ceil\(durationS\*1,000,000\/samplePeriodUs\)[\s\S]*one-million[\s\S]*exact BigInt rational[\s\S]*independent of the coverage verdict[\s\S]*required and observed counts/i);
  assert.equal(
    searchRootCauses('one fast cycle partial HIL timing spread overflow', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('HIL result memory preserves complete identity and bounded summary semantics', () => {
  const record = getRootCauseRecord('rc-hil-result-identity-gap');
  assert.equal(record?.status, 'resolved');
  assert.match(record.evidence.join(' '), /contract@2[\s\S]*mutable[\s\S]*modelId/i);
  assert.match(record.rootCause, /versioned[\s\S]*immutable[\s\S]*content-addressed/i);
  assert.match(record.resolution.join(' '), /model ID[\s\S]*deeply frozen[\s\S]*does not authenticate raw measurements/i);
  assert.equal(
    searchRootCauses('HIL mutable verdict wrong schema missing model identity', { limit: 1 })[0]?.id,
    record.id,
  );
});

test('test-multiplier memory pins a reproducible denominator and local evidence', () => {
  const id = 'rc-test-multiplier-denominator-drift';
  const multiplier = getRootCauseRecord(id);
  assert.equal(multiplier?.status, 'resolved');
  assert.match(multiplier.rootCause, /comparison population[\s\S]*base revision[\s\S]*counting procedure/i);
  const resolution = multiplier.resolution.join(' ');
  assert.match(resolution, /66f7240 at 708[\s\S]*4da8c03 at 758[\s\S]*increase of 50/i);
  assert.match(resolution, /rg -n "\^test\\\(" tests --glob "\*\.test\.mjs" \| wc -l/);
  assert.match(resolution, /6094b3b at 824 only as an intermediate/i);
  assert.match(resolution, /at least 858 declarations[\s\S]*increase of at least 100/i);

  assert.deepEqual(
    multiplier.references.filter(({ kind }) => kind === 'commit').map(({ locator }) => locator),
    ['66f7240', '4da8c03', '6094b3bd5e5afbb3069fd9ba8a7c5d1558600d6f'],
  );

  const localTests = multiplier.references
    .filter(({ kind }) => kind === 'test')
    .map(({ locator }) => locator);
  assert.deepEqual(localTests, [
    'tests/ecm-tuning-plan.test.mjs',
    'tests/ecm-tuning.test.mjs',
    'tests/ecm-tuning-surfaces.test.mjs',
    'tests/packaged-tree.test.mjs',
  ]);
  for (const locator of localTests) assert.ok(existsSync(resolve(ROOT, locator)), locator);

  const matches = searchRootCauses(
    '91 tests Action 1 denominator 708 758 top-level declaration counting command',
    { limit: 3 },
  );
  assert.equal(matches[0]?.id, id);
});

test('validation is deterministic, non-mutating and rejects unknown or ambiguous data', () => {
  const bad = structuredClone(ROOT_CAUSE_RECORDS[0]);
  bad.tags = ['validation', 'allof'];
  bad.unreviewedGuess = true;
  const before = structuredClone(bad);
  const first = validateRootCauseRecord(bad);
  const second = validateRootCauseRecord(bad);
  assert.deepEqual(first, second);
  assert.deepEqual(bad, before, 'validation does not normalize or freeze caller input');
  assert.ok(first.some(({ path, code }) => path === '$/unreviewedGuess' && code === 'additionalProperties'));
  assert.ok(first.some(({ path, code }) => path === '$/tags' && code === 'canonicalOrder'));
  assertDeepFrozen(first);
  assert.throws(() => validateRootCauseRecord(bad, { pth: '$' }), /does not accept option/);

  const duplicateCatalog = structuredClone(ROOT_CAUSE_CATALOG);
  duplicateCatalog.records.splice(1, 0, structuredClone(duplicateCatalog.records[0]));
  const catalogErrors = validateRootCauseCatalog(duplicateCatalog);
  assert.ok(catalogErrors.some(({ code }) => code === 'uniqueId'));
  assert.ok(catalogErrors.some(({ code }) => code === 'canonicalOrder'));

  const cyclic = structuredClone(ROOT_CAUSE_RECORDS[0]);
  cyclic.evidence[0] = cyclic;
  const cyclicErrors = validateRootCauseRecord(cyclic);
  assert.ok(cyclicErrors.some(({ code }) => code === 'cycle'));
});

test('listing and exact lookup stay immutable and fail closed on option typos', () => {
  assert.equal(getRootCauseRecord('rc-fmi-representation-drift')?.rootCause.length > 20, true);
  assert.equal(getRootCauseRecord('rc-not-known'), null);

  const fmi = listRootCauseRecords({ tags: ['fmi'] });
  assert.deepEqual(fmi.map(({ id }) => id), [
    'rc-capability-contract-mismatch',
    'rc-fmi-calibration-key-ignored',
    'rc-fmi-representation-drift',
  ]);
  assert.ok(Object.isFrozen(fmi));
  assert.throws(() => fmi.push(ROOT_CAUSE_RECORDS[0]), TypeError);
  assert.throws(() => listRootCauseRecords({ tag: ['fmi'] }), /does not accept option/);
  assert.throws(() => listRootCauseRecords({ affectedSurfaces: ['cloud-service'] }), /unsupported value/);
});

test('lexical search deterministically retrieves causes, fixes and containment patterns', () => {
  const cases = [
    ['unknown option defaults typo', 'rc-cli-typo-default-fallback'],
    ['DAE residual CSC duplicate Jacobian lowering', 'rc-dae-lowering-contract-gap'],
    ['Rust regression evidence Windows backslash traversal UNC', 'rc-regression-path-containment-gap'],
    ['XML I/O map C binary mismatch', 'rc-fmi-representation-drift'],
    ['HIL physical endpoint model port fault injector deployment plan', 'rc-hil-contract-deployment-gap'],
    ['HIL verdict mutable result schema missing model identity', 'rc-hil-result-identity-gap'],
    ['trusted expected SHA provenance', 'rc-source-revision-self-claim'],
    ['symlink hardlink containment', 'rc-tree-link-containment'],
    ['allOf additional properties', 'rc-allof-closure-collision'],
    ['hidden tab button timeout', 'rc-e2e-hidden-state-precondition'],
    ['grouped null invalid flat alias', 'rc-nullable-alias-projection'],
    ['packaged runtime missing imported dependency', 'rc-packaged-dependency-omission'],
    ['calibration evidence envelope reusable params output file', 'rc-calibration-result-artifact-shape'],
    ['MCP calibration GUI product surface capability claim', 'rc-product-surface-claim-drift'],
    ['prefix RMSE mismatched arrays CSV row first timestamp delta sample phase', 'rc-calibration-trace-alignment-loss'],
    ['optimizer iterations undercount simulations maxDtS work budget', 'rc-calibration-work-undercount'],
    ['unknown polarization hysteresis warm start calibration', 'rc-calibration-initial-state-ambiguity'],
    ['calibration result algorithm model cell checksum raw trace identity', 'rc-calibration-result-identity-gap'],
    ['upper bound duplicate simplex false convergence', 'rc-nelder-mead-bound-simplex-collapse'],
    ['Euler RC dt tau unstable nonfinite heat', 'rc-rc-euler-step-instability'],
    ['adaptive thermal microsteps module node work preflight', 'rc-adaptive-integration-work-undercount'],
    ['negative signed lower bound atBound evidence', 'rc-signed-bound-evidence-miss'],
    ['SIL repeatability JSON key order mutable evidence checksum', 'rc-sil-result-representation-gap'],
    ['thermal Euler C G exponential decay coolant phase heat conservation', 'rc-thermal-explicit-step-instability'],
    ['holdout purpose relabel same observations raw source run leakage', 'rc-calibration-holdout-relabel-leakage'],
    ['pooled holdout RMSE hides failed short operating segment', 'rc-calibration-holdout-score-masking'],
    ['automatic ECM Arrhenius parameter confounding insufficient excitation coverage skipped groups', 'rc-calibration-parameter-identifiability-confounding'],
    ['constructor inherited prototype parameter allowlist membership', 'rc-object-allowlist-prototype-bypass'],
  ];
  for (const [query, expected] of cases) {
    const first = searchRootCauses(query, { limit: 3 });
    const second = searchRootCauses(query, { limit: 3 });
    assert.equal(first[0]?.id, expected, query);
    assert.deepEqual(first, second, `${query} is deterministic`);
    assertDeepFrozen(first);
  }
  assert.deepEqual(searchRootCauses('   '), []);
  assert.deepEqual(searchRootCauses('the and of'), []);
  assert.throws(() => searchRootCauses('fmi', { limt: 2 }), /does not accept option/);
});

test('similar-issue matching uses evidence, tags and affected surfaces without mutation', () => {
  const issue = {
    symptom: 'modelDescription advertises state serialization but native functions return errors',
    evidence: ['The imported FMU reports an optional operation that its binary rejects.'],
    tags: ['capability', 'fmi'],
    affectedSurfaces: ['compiled-fmu'],
  };
  const before = structuredClone(issue);
  const results = findSimilarRootCauses(issue, { limit: 3 });
  assert.equal(results[0]?.id, 'rc-capability-contract-mismatch');
  assert.ok(results[0].score > results[1].score);
  assert.ok(results[0].sharedTokens.includes('capability'));
  assert.deepEqual(issue, before, 'similarity does not modify caller evidence');
  assertDeepFrozen(results);

  const envelope = findSimilarRootCauses({
    symptom: 'A request param typo is ignored and the default is used.',
    tags: ['validation'],
    affectedSurfaces: ['local-api'],
  });
  assert.equal(envelope[0]?.id, 'rc-schema-envelope-permissive');
  assert.throws(() => findSimilarRootCauses({ guess: 'maybe' }), /does not accept field/);
});

test('runtime library remains import-safe in browser and Node with no hidden I/O', () => {
  for (const path of [
    'js/root-cause-library.js',
    'knowledge/root-causes/schema.v1.js',
    'knowledge/root-causes/records.v1.js',
  ]) {
    const source = readFileSync(resolve(ROOT, path), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:|require\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  }
});
