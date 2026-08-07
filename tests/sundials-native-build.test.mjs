import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_LIMITS,
  SUNDIALS_CMAKE_DEFINITIONS,
  SUNDIALS_IDA_PROBE_DIRECTORY,
  SUNDIALS_IDA_PROBE_TARGET,
  SundialsNativeBuildError,
  auditProbeDynamicDependencies,
  auditSundialsCmakeCache,
  parseCmakeCache,
  validateArchiveEntries,
} from '../tools/build-sundials-ida.mjs';
import { SUNDIALS_SOURCE_LOCK } from '../tools/verify-sundials-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_ROOT = SUNDIALS_SOURCE_LOCK.sourceArchive.archiveRoot;

const REQUIRED_OFF = [
  'MPI', 'OPENMP', 'OPENMP_DEVICE', 'PTHREAD', 'CUDA', 'HIP', 'SYCL',
  'LAPACK', 'GINKGO', 'MAGMA', 'SUPERLUDIST', 'SUPERLUMT', 'KLU', 'HYPRE',
  'PETSC', 'RAJA', 'TRILINOS', 'XBRAID', 'ONEMKL', 'CALIPER', 'ADIAK',
  'KOKKOS', 'KOKKOS_KERNELS', 'FORTRAN', 'PYTHON', 'C_EXAMPLES',
  'CXX_EXAMPLES', 'FORTRAN_EXAMPLES', 'CUDA_EXAMPLES', 'EXAMPLES_INSTALL',
  'BENCHMARKS', 'EXTERNAL_ADDONS', 'PROFILING', 'MONITORING',
  'NVECTOR_MANYVECTOR',
].map((suffix) => `SUNDIALS_ENABLE_${suffix}`);

function validArchiveEntries() {
  return [
    { path: `${ARCHIVE_ROOT}/CMakeLists.txt`, type: '-', sizeBytes: 10 },
    { path: `${ARCHIVE_ROOT}/LICENSE`, type: '-', sizeBytes: 10 },
    { path: `${ARCHIVE_ROOT}/NOTICE`, type: '-', sizeBytes: 10 },
    { path: `${ARCHIVE_ROOT}/src/`, type: 'd', sizeBytes: 0 },
    { path: `${ARCHIVE_ROOT}/src/ida/`, type: 'd', sizeBytes: 0 },
    { path: `${ARCHIVE_ROOT}/src/ida/CMakeLists.txt`, type: '-', sizeBytes: 10 },
    { path: `${ARCHIVE_ROOT}/src/ida/ida.c`, type: '-', sizeBytes: 10 },
  ];
}

function syntheticCache(overrides = new Map()) {
  const install = '/tmp/battery-design-sundials-install-fixture';
  const types = new Map([
    ['CMAKE_BUILD_TYPE', 'STRING'],
    ['CMAKE_INSTALL_PREFIX', 'PATH'],
    ['BUILD_STATIC_LIBS', 'BOOL'],
    ['BUILD_SHARED_LIBS', 'BOOL'],
    ['SUNDIALS_PRECISION', 'STRING'],
    ['SUNDIALS_INDEX_SIZE', 'STRING'],
    ['SUNDIALS_ENABLE_IDA', 'BOOL'],
    ['SUNDIALS_ENABLE_ERROR_CHECKS', 'BOOL'],
    ['USE_XSDK_DEFAULTS', 'BOOL'],
  ]);
  const values = new Map([
    ['CMAKE_BUILD_TYPE', 'Release'],
    ['CMAKE_INSTALL_PREFIX', install],
    ['BUILD_STATIC_LIBS', 'ON'],
    ['BUILD_SHARED_LIBS', 'OFF'],
    ['SUNDIALS_PRECISION', 'DOUBLE'],
    ['SUNDIALS_INDEX_SIZE', '64'],
    ['SUNDIALS_ENABLE_IDA', 'ON'],
    ['SUNDIALS_ENABLE_ERROR_CHECKS', 'ON'],
    ['USE_XSDK_DEFAULTS', 'OFF'],
    ...REQUIRED_OFF.map((name) => [name, 'OFF']),
  ]);
  for (const name of REQUIRED_OFF) types.set(name, 'BOOL');
  for (const [name, entry] of overrides) {
    if (entry === null) {
      values.delete(name);
      types.delete(name);
    } else {
      types.set(name, entry.type);
      values.set(name, entry.value);
    }
  }
  return {
    install,
    text: [...values].map(([name, value]) => `${name}:${types.get(name)}=${value}`).join('\n'),
  };
}

test('native build contract is exact SUNDIALS 7.8.0 static IDA, double and 64-bit', () => {
  assert.equal(SUNDIALS_SOURCE_LOCK.version, '7.8.0');
  assert.deepEqual({
    buildType: SUNDIALS_CMAKE_DEFINITIONS.CMAKE_BUILD_TYPE,
    static: SUNDIALS_CMAKE_DEFINITIONS.BUILD_STATIC_LIBS,
    shared: SUNDIALS_CMAKE_DEFINITIONS.BUILD_SHARED_LIBS,
    precision: SUNDIALS_CMAKE_DEFINITIONS.SUNDIALS_PRECISION,
    indexSize: SUNDIALS_CMAKE_DEFINITIONS.SUNDIALS_INDEX_SIZE,
    ida: SUNDIALS_CMAKE_DEFINITIONS.SUNDIALS_ENABLE_IDA,
    errorChecks: SUNDIALS_CMAKE_DEFINITIONS.SUNDIALS_ENABLE_ERROR_CHECKS,
  }, {
    buildType: 'Release', static: 'ON', shared: 'OFF', precision: 'DOUBLE',
    indexSize: '64', ida: 'ON', errorChecks: 'ON',
  });
  for (const name of REQUIRED_OFF) assert.equal(SUNDIALS_CMAKE_DEFINITIONS[name], 'OFF', name);
  assert.equal(SUNDIALS_IDA_PROBE_DIRECTORY, join(ROOT, 'tools/sundials-ida-probe'));
  assert.equal(SUNDIALS_IDA_PROBE_TARGET, 'sundials_ida_lifecycle_probe');
});

test('ordinary native build tests have no network or download path', () => {
  const source = readFileSync(join(ROOT, 'tools/build-sundials-ida.mjs'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|https:\/\/|\bcurl\b|\bwget\b/u);
  const run = spawnSync(process.execPath, ['tools/build-sundials-ida.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /--archive is required/u);
});

test('archive inventory accepts only a bounded single-root IDA source distribution', () => {
  assert.deepEqual(validateArchiveEntries(validArchiveEntries()), {
    entries: 7,
    expandedBytes: 50,
    archiveRoot: ARCHIVE_ROOT,
  });
  const cases = [
    (entries) => { entries[0].path = `../${ARCHIVE_ROOT}/CMakeLists.txt`; },
    (entries) => { entries[0].path = `/${ARCHIVE_ROOT}/CMakeLists.txt`; },
    (entries) => { entries[0].path = `${ARCHIVE_ROOT}\\CMakeLists.txt`; },
    (entries) => { entries[0].path = `wrong-root/CMakeLists.txt`; },
    (entries) => { entries.push({ ...entries[0] }); },
    (entries) => { entries[0].type = 'l'; },
    (entries) => { entries[0].sizeBytes = ARCHIVE_LIMITS.regularFileBytes + 1; },
    (entries) => { entries.push({ path: `${ARCHIVE_ROOT}/src/cvode/cvode.c`, type: '-', sizeBytes: 1 }); },
    (entries) => { entries.pop(); },
  ];
  for (const mutate of cases) {
    const entries = structuredClone(validArchiveEntries());
    mutate(entries);
    assert.throws(() => validateArchiveEntries(entries), SundialsNativeBuildError);
  }
});

test('CMake cache audit rejects unused variables, contract drift, and unexpected enables', () => {
  const good = syntheticCache();
  const parsed = auditSundialsCmakeCache(good.text, '-- Configuring done', good.install);
  assert.equal(parsed.get('SUNDIALS_ENABLE_IDA').value, 'ON');
  assert.equal(parseCmakeCache('VALUE:STRING=a=b').get('VALUE').value, 'a=b');

  assert.throws(
    () => auditSundialsCmakeCache(good.text, 'Manually-specified variables were not used by the project', good.install),
    (error) => error.code === 'sundials.cmake.unused_variables',
  );
  for (const overrides of [
    new Map([['BUILD_SHARED_LIBS', { type: 'BOOL', value: 'ON' }]]),
    new Map([['SUNDIALS_ENABLE_KLU', { type: 'BOOL', value: 'ON' }]]),
    new Map([['SUNDIALS_PRECISION', { type: 'STRING', value: 'SINGLE' }]]),
    new Map([['UNKNOWN_INPUT', { type: 'UNINITIALIZED', value: 'OFF' }]]),
    new Map([['SUNDIALS_ENABLE_MYSTERY', { type: 'BOOL', value: 'ON' }]]),
  ]) {
    const candidate = syntheticCache(overrides);
    assert.throws(
      () => auditSundialsCmakeCache(candidate.text, '-- Configuring done', candidate.install),
      SundialsNativeBuildError,
    );
  }
});

test('dynamic dependency audit permits system libraries but rejects shared SUNDIALS', () => {
  assert.deepEqual(auditProbeDynamicDependencies([
    'linux-vdso.so.1 (0x00007fff00000000)',
    'libm.so.6 => /lib/x86_64-linux-gnu/libm.so.6 (0x00007f0000000000)',
    'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)',
  ].join('\n')), { sundialsDynamicDependencies: 0 });
  assert.throws(
    () => auditProbeDynamicDependencies(
      'libsundials_ida.so.7 => /usr/lib/libsundials_ida.so.7 (0x00007f0000000000)',
    ),
    (error) => error instanceof SundialsNativeBuildError
      && error.code === 'sundials.probe.dynamic_sundials',
  );
});

test('external probe is lifecycle-only and links the exact IDA package target', () => {
  const cmake = readFileSync(join(SUNDIALS_IDA_PROBE_DIRECTORY, 'CMakeLists.txt'), 'utf8');
  const source = readFileSync(join(SUNDIALS_IDA_PROBE_DIRECTORY, 'main.c'), 'utf8');
  assert.match(
    cmake,
    /^find_package\(SUNDIALS 7\.8\.0 EXACT CONFIG REQUIRED COMPONENTS ida\)$/mu,
  );
  assert.match(
    cmake,
    /^target_link_libraries\(sundials_ida_lifecycle_probe PRIVATE SUNDIALS::ida\)$/mu,
  );
  assert.doesNotMatch(
    source,
    /\b(?:IDAInit|IDAReInit|IDASetLinearSolver|IDASolve|IDAResFn)\b|\bcallbacks?\b/iu,
  );
});

test('orchestrator stages and re-verifies bytes before archive extraction', () => {
  const source = readFileSync(join(ROOT, 'tools/build-sundials-ida.mjs'), 'utf8');
  const firstVerify = source.indexOf('await verifySundialsArchive(archive, lock)');
  const stage = source.indexOf('copyFileSync(archive, stagedArchive');
  const secondVerify = source.indexOf('await verifySundialsArchive(stagedArchive, lock)');
  const inspect = source.indexOf('inspectArchive(stagedArchive, lock)');
  const extract = source.indexOf("'--extract', '--gzip'");
  assert.ok(firstVerify >= 0 && firstVerify < stage);
  assert.ok(stage < secondVerify && secondVerify < inspect && inspect < extract);
  assert.doesNotMatch(source, /dense-only/iu);
});
