import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KLU_CRITICAL_HEADERS,
  KLU_PUBLISHED_ARCHIVES,
  KLU_PUBLISHED_LICENSES,
  SUITESPARSE_ARCHIVE_LIMITS,
  SUITESPARSE_CMAKE_DEFINITIONS,
  SUITESPARSE_NO_BLAS_INITIAL_CACHE,
  SUNDIALS_IDA_KLU_PROBE_DIRECTORY,
  SUNDIALS_IDA_KLU_PROBE_TARGET,
  SUNDIALS_KLU_CMAKE_DEFINITIONS,
  SundialsKluNativeBuildError,
  auditKluDynamicDependencies,
  auditKluLinkSymbols,
  auditSuiteSparseCmakeCache,
  auditSundialsKluCmakeCache,
  canonicalKluLinkOrder,
  expectedKluBuildReceipt,
  parseSuiteSparseTarInventory,
  validateKluReceiptShape,
  validateSuiteSparseArchiveEntries,
} from '../tools/build-sundials-ida-klu.mjs';
import { SUNDIALS_SOURCE_LOCK } from '../tools/verify-sundials-source.mjs';
import { SUITESPARSE_SOURCE_LOCK } from '../tools/verify-suitesparse-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_ROOT = SUITESPARSE_SOURCE_LOCK.sourceArchive.archiveRoot;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function temporary(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validArchiveEntries() {
  const files = [
    'CMakeLists.txt',
    'SuiteSparse_config/CMakeLists.txt',
    'SuiteSparse_config/SuiteSparse_config.c',
    'SuiteSparse_config/README.txt',
    'AMD/CMakeLists.txt',
    'AMD/Include/amd.h',
    'AMD/Doc/License.txt',
    'BTF/CMakeLists.txt',
    'BTF/Include/btf.h',
    'BTF/Doc/License.txt',
    'COLAMD/CMakeLists.txt',
    'COLAMD/Include/colamd.h',
    'COLAMD/Doc/License.txt',
    'KLU/CMakeLists.txt',
    'KLU/Include/klu.h',
    'KLU/Doc/License.txt',
  ];
  return files.map((path, index) => ({
    path: `${ARCHIVE_ROOT}/${path}`,
    type: '-',
    sizeBytes: index + 1,
  }));
}

function cacheLine(name, value) {
  let type = 'STRING';
  if (name === 'CMAKE_INSTALL_PREFIX' || name.endsWith('_ROOT')
      || name.endsWith('_DIR')) type = 'PATH';
  if (name.endsWith('_LIBRARY')) type = 'FILEPATH';
  if (value === 'ON' || value === 'OFF') type = 'BOOL';
  return `${name}:${type}=${value}`;
}

function suiteCache(overrides = {}) {
  const install = '/private/suite-install';
  const values = {
    ...SUITESPARSE_CMAKE_DEFINITIONS,
    CMAKE_INSTALL_PREFIX: install,
    BLAS_LIBRARIES: '',
    BLAS_INCLUDE_DIRS: '',
    CMAKE_FIND_USE_PACKAGE_REGISTRY: 'OFF',
    CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY: 'OFF',
    ...overrides,
  };
  return {
    install,
    text: Object.entries(values)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => cacheLine(name, value))
      .join('\n'),
  };
}

function kluPathContract() {
  const suite = '/private/suite-install';
  const libraryDirectory = `${suite}/lib`;
  return {
    suite,
    paths: {
      include: `${suite}/include/suitesparse`,
      libraryDirectory,
      libraries: {
        KLU_LIBRARY: `${libraryDirectory}/libklu.a`,
        AMD_LIBRARY: `${libraryDirectory}/libamd.a`,
        COLAMD_LIBRARY: `${libraryDirectory}/libcolamd.a`,
        BTF_LIBRARY: `${libraryDirectory}/libbtf.a`,
        SUITESPARSECONFIG_LIBRARY: `${libraryDirectory}/libsuitesparseconfig.a`,
      },
    },
  };
}

function sundialsCache(overrides = {}) {
  const install = '/private/sundials-install';
  const { suite, paths } = kluPathContract();
  const values = {
    ...SUNDIALS_KLU_CMAKE_DEFINITIONS,
    CMAKE_INSTALL_PREFIX: install,
    CMAKE_FIND_USE_PACKAGE_REGISTRY: 'OFF',
    CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY: 'OFF',
    SUNDIALS_ENABLE_SUNLINSOL_KLU: 'ON',
    KLU_ROOT: suite,
    KLU_INCLUDE_DIR: paths.include,
    KLU_LIBRARY_DIR: paths.libraryDirectory,
    ...paths.libraries,
    ...overrides,
  };
  return {
    install,
    suite,
    paths,
    text: Object.entries(values)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => cacheLine(name, value))
      .join('\n'),
  };
}

const TOOLCHAIN = Object.freeze({
  cmake: 'cmake version fixture',
  cCompiler: 'cc version fixture',
  cxxCompiler: 'c++ version fixture',
  archiver: 'ar version fixture',
  linker: 'ld version fixture',
});

function receiptFixture(t) {
  const root = temporary(t, 'battery-design-klu-receipt-');
  for (const relative of [
    ...KLU_PUBLISHED_ARCHIVES.map((name) => `lib/${name}`),
    ...KLU_CRITICAL_HEADERS,
    ...KLU_PUBLISHED_LICENSES,
  ]) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fixture:${relative}`);
  }
  return { root, receipt: expectedKluBuildReceipt({ root, toolchain: TOOLCHAIN }) };
}

test('closed KLU contract pins exact source versions, static options, and eight archives', () => {
  assert.equal(SUNDIALS_SOURCE_LOCK.version, '7.8.0');
  assert.equal(SUITESPARSE_SOURCE_LOCK.version, '7.7.0');
  assert.equal(SUITESPARSE_CMAKE_DEFINITIONS.KLU_USE_CHOLMOD, 'OFF');
  assert.equal(SUITESPARSE_CMAKE_DEFINITIONS.BUILD_SHARED_LIBS, 'OFF');
  assert.match(SUITESPARSE_NO_BLAS_INITIAL_CACHE, /set\(BLAS_LIBRARIES "" CACHE STRING/u);
  assert.match(SUITESPARSE_NO_BLAS_INITIAL_CACHE, /CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY OFF/u);
  assert.equal(SUNDIALS_KLU_CMAKE_DEFINITIONS.SUNDIALS_ENABLE_KLU, 'ON');
  assert.equal(SUNDIALS_KLU_CMAKE_DEFINITIONS.SUNDIALS_ENABLE_KLU_CHECKS, 'ON');
  assert.equal(KLU_PUBLISHED_ARCHIVES.length, 8);
  assert.ok(!KLU_PUBLISHED_ARCHIVES.includes('libsundials_nvecserial.a'));
  assert.ok(!KLU_PUBLISHED_ARCHIVES.includes('libsundials_sunmatrixsparse.a'));
  assert.deepEqual([...KLU_PUBLISHED_ARCHIVES].sort(), [...KLU_PUBLISHED_ARCHIVES]);
});

test('build helper has no network path and CLI requires both separately supplied archives', () => {
  const source = readFileSync(join(ROOT, 'tools/build-sundials-ida-klu.mjs'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|\bcurl\b|\bwget\b/u);
  const run = spawnSync(process.execPath, ['tools/build-sundials-ida-klu.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /--sundials-archive is required/u);
});

test('orchestrator selectively extracts only the five reviewed SuiteSparse components', () => {
  const source = readFileSync(join(ROOT, 'tools/build-sundials-ida-klu.mjs'), 'utf8');
  for (const selected of ['SuiteSparse_config', 'AMD', 'BTF', 'COLAMD', 'KLU']) {
    assert.match(source, new RegExp(`\\$\\{root\\}/${selected}/\\*`, 'u'));
  }
  assert.doesNotMatch(source, /\$\{root\}\/CHOLMOD\/\*/u);
  assert.match(source, /--wildcards[\s\S]+--anchored/u);
});

test('archive inventory accepts a bounded selected-source fixture', () => {
  const evidence = validateSuiteSparseArchiveEntries(validArchiveEntries());
  assert.equal(evidence.entries, 16);
  assert.equal(evidence.archiveRoot, ARCHIVE_ROOT);
  assert.equal(evidence.selectedEntries, 16);
  const spaced = `${ARCHIVE_ROOT}/GraphBLAS/Config file.txt`;
  const parsed = parseSuiteSparseTarInventory(
    `${spaced}\n`,
    `-rw-r--r-- 0/0 12 2024-03-22 12:00:00 ${spaced}\n`,
  );
  assert.deepEqual(parsed, [{ path: spaced, type: '-', sizeBytes: 12 }]);
});

const archiveAttacks = [
  ['parent traversal', (entries) => { entries[0].path = `${ARCHIVE_ROOT}/../CMakeLists.txt`; }],
  ['symbolic-link member', (entries) => { entries[2].type = 'l'; }],
  ['oversized member', (entries) => {
    entries[3].sizeBytes = SUITESPARSE_ARCHIVE_LIMITS.regularFileBytes + 1;
  }],
  ['missing KLU header', (entries) => { entries.splice(14, 1); }],
  ['duplicate path', (entries) => { entries.push({ ...entries[5] }); }],
];

for (const [name, mutate] of archiveAttacks) {
  test(`archive inventory rejects ${name}`, () => {
    const entries = structuredClone(validArchiveEntries());
    mutate(entries);
    assert.throws(
      () => validateSuiteSparseArchiveEntries(entries),
      SundialsKluNativeBuildError,
    );
    if (name === 'parent traversal') {
      for (const unsafe of [
        `/${ARCHIVE_ROOT}/CMakeLists.txt`,
        `${ARCHIVE_ROOT}\\CMakeLists.txt`,
        `${ARCHIVE_ROOT}/control\u0001name`,
      ]) {
        const candidate = structuredClone(validArchiveEntries());
        candidate[0].path = unsafe;
        assert.throws(() => validateSuiteSparseArchiveEntries(candidate), SundialsKluNativeBuildError);
      }
    }
    if (name === 'symbolic-link member') {
      for (const unsafeType of ['h', 'c', 'b', 'p']) {
        const candidate = structuredClone(validArchiveEntries());
        candidate[2].type = unsafeType;
        assert.throws(() => validateSuiteSparseArchiveEntries(candidate), SundialsKluNativeBuildError);
      }
    }
  });
}

test('exact archive inventory mode rejects a plausible but incomplete archive', () => {
  assert.throws(
    () => validateSuiteSparseArchiveEntries(validArchiveEntries(), SUITESPARSE_SOURCE_LOCK, {
      exactInventory: true,
    }),
    (error) => error.code === 'klu.archive.inventory_drift',
  );
});

test('SuiteSparse CMake cache accepts only the private static KLU contract', () => {
  const fixture = suiteCache();
  const parsed = auditSuiteSparseCmakeCache(fixture.text, '-- Configuring done', {
    sourceDirectory: '/private/suite-source',
    buildDirectory: '/private/suite-build',
    installDirectory: fixture.install,
  });
  assert.equal(parsed.get('KLU_USE_CHOLMOD').value, 'OFF');
});

const suiteCacheAttacks = [
  ['shared libraries', { BUILD_SHARED_LIBS: 'ON' }],
  ['CHOLMOD enablement', { KLU_USE_CHOLMOD: 'ON' }],
  ['system AMD fallback', { SUITESPARSE_USE_SYSTEM_AMD: 'ON' }],
  ['dependency path outside private roots', { AMD_LIBRARY: '/usr/lib/libamd.a' }],
];

for (const [name, override] of suiteCacheAttacks) {
  test(`SuiteSparse CMake audit rejects ${name}`, () => {
    const fixture = suiteCache(override);
    assert.throws(() => auditSuiteSparseCmakeCache(fixture.text, '-- Configuring done', {
      sourceDirectory: '/private/suite-source',
      buildDirectory: '/private/suite-build',
      installDirectory: fixture.install,
    }), SundialsKluNativeBuildError);
  });
}

test('SUNDIALS CMake cache accepts exact KLU checks and private explicit libraries', () => {
  const fixture = sundialsCache({
    SUNDIALS_ENABLE_ADIAK: null,
    SUNDIALS_ENABLE_CALIPER: null,
    SUNDIALS_ENABLE_CUDA_EXAMPLES: null,
    SUNDIALS_ENABLE_FORTRAN_EXAMPLES: null,
  });
  const parsed = auditSundialsKluCmakeCache(fixture.text, '-- Configuring done', {
    installDirectory: fixture.install,
    suiteSparseDirectory: fixture.suite,
    kluPaths: fixture.paths,
  });
  assert.equal(parsed.get('SUNDIALS_ENABLE_KLU_CHECKS').value, 'ON');
});

test('SUNDIALS CMake audit rejects disabled KLU, disabled KLU checks, or unrelated checks', () => {
  for (const override of [
    { SUNDIALS_ENABLE_KLU: 'OFF' },
    { SUNDIALS_ENABLE_KLU_CHECKS: 'OFF' },
    { SUNDIALS_ENABLE_FOO_CHECKS: 'ON' },
  ]) {
    const fixture = sundialsCache(override);
    assert.throws(() => auditSundialsKluCmakeCache(fixture.text, '-- Configuring done', {
      installDirectory: fixture.install,
      suiteSparseDirectory: fixture.suite,
      kluPaths: fixture.paths,
    }), SundialsKluNativeBuildError);
  }
});

test('SUNDIALS CMake audit rejects a /usr KLU library fallback', () => {
  const fixture = sundialsCache({ KLU_LIBRARY: '/usr/lib/libklu.a' });
  assert.throws(() => auditSundialsKluCmakeCache(fixture.text, '-- Configuring done', {
    installDirectory: fixture.install,
    suiteSparseDirectory: fixture.suite,
    kluPaths: fixture.paths,
  }), SundialsKluNativeBuildError);
});

test('CMake audits reject unused manually supplied and untyped variables', () => {
  const suite = suiteCache();
  assert.throws(() => auditSuiteSparseCmakeCache(
    suite.text,
    'Manually-specified variables were not used by the project',
    {
      sourceDirectory: '/private/suite-source',
      buildDirectory: '/private/suite-build',
      installDirectory: suite.install,
    },
  ), SundialsKluNativeBuildError);
  const untyped = suiteCache({ UNREVIEWED: 'OFF' });
  untyped.text += '\nUNUSED_INPUT:UNINITIALIZED=OFF';
  assert.throws(() => auditSuiteSparseCmakeCache(untyped.text, '-- Configuring done', {
    sourceDirectory: '/private/suite-source',
    buildDirectory: '/private/suite-build',
    installDirectory: untyped.install,
  }), SundialsKluNativeBuildError);
});

test('@2 receipt binds the exact backend, two source identities, and toolchain shape', (t) => {
  const { receipt } = receiptFixture(t);
  assert.equal(receipt.format, 'battery-design/native-dae-klu-build-receipt@2');
  assert.equal(receipt.backend, 'SUNDIALS/IDA+SuiteSparse/KLU');
  assert.deepEqual(Object.keys(receipt.sources), ['sundials', 'suitesparse']);
  assert.deepEqual(receipt.toolchain, TOOLCHAIN);
});

test('@2 receipt pins source-lock and archive digests rather than mutable paths', (t) => {
  const { receipt } = receiptFixture(t);
  assert.equal(receipt.sources.sundials.archiveSha256, SUNDIALS_SOURCE_LOCK.sourceArchive.sha256);
  assert.equal(receipt.sources.suitesparse.archiveSha256, SUITESPARSE_SOURCE_LOCK.sourceArchive.sha256);
  assert.match(receipt.sources.sundials.lockSha256, /^[0-9a-f]{64}$/u);
  assert.match(receipt.sources.suitesparse.lockSha256, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(receipt.sources), /\/tmp\/|\/usr\//u);
});

test('@2 receipt records the closed sparse ABI and no optional dense ecosystem', (t) => {
  const { receipt } = receiptFixture(t);
  assert.deepEqual(receipt.build, {
    linkage: 'static', precision: 'double', indexBits: 64, mpi: false,
    openmp: false, klu: true, kluChecks: true, cholmod: false, blas: false,
  });
});

test('@2 receipt records exact SuiteSparse component versions', (t) => {
  const { receipt } = receiptFixture(t);
  assert.deepEqual(receipt.components, {
    SuiteSparse_config: '7.7.0', AMD: '3.3.2', BTF: '2.3.2',
    COLAMD: '3.3.3', KLU: '2.3.3',
  });
});

test('@2 receipt hashes every and only curated archive', (t) => {
  const { root, receipt } = receiptFixture(t);
  assert.deepEqual(Object.keys(receipt.artifacts), KLU_PUBLISHED_ARCHIVES);
  const name = 'libklu.a';
  assert.equal(receipt.artifacts[name], digest(readFileSync(join(root, 'lib', name))));
});

test('@2 receipt binds header bytes and detects a changed critical header hash', (t) => {
  const { root, receipt } = receiptFixture(t);
  const relative = 'include/suitesparse/klu.h';
  writeFileSync(join(root, relative), 'changed KLU ABI');
  const changed = expectedKluBuildReceipt({ root, toolchain: TOOLCHAIN });
  assert.notEqual(changed.headers[relative], receipt.headers[relative]);
});

test('@2 receipt binds all selected notices and both full LGPL texts', (t) => {
  const { receipt } = receiptFixture(t);
  assert.deepEqual(Object.keys(receipt.licenses), KLU_PUBLISHED_LICENSES);
  assert.ok(KLU_PUBLISHED_LICENSES.includes('share/licenses/suitesparse/BTF-LGPL-2.1.txt'));
  assert.ok(KLU_PUBLISHED_LICENSES.includes('share/licenses/suitesparse/KLU-LGPL-2.1.txt'));
});

test('@2 receipt shape accepts the exact generated schema', (t) => {
  const { receipt } = receiptFixture(t);
  assert.deepEqual(validateKluReceiptShape(receipt), {
    format: 'battery-design/native-dae-klu-build-receipt@2', artifactCount: 8,
  });
});

test('@2 receipt shape rejects unknown root data', (t) => {
  const { receipt } = receiptFixture(t);
  receipt.unreviewed = true;
  assert.throws(() => validateKluReceiptShape(receipt), SundialsKluNativeBuildError);
});

test('@2 receipt shape rejects an omitted static artifact identity', (t) => {
  const { receipt } = receiptFixture(t);
  delete receipt.artifacts['libklu.a'];
  assert.throws(() => validateKluReceiptShape(receipt), SundialsKluNativeBuildError);
});

test('@2 receipt shape rejects unsafe toolchain control characters', (t) => {
  const { receipt } = receiptFixture(t);
  receipt.toolchain.linker = 'ld\nforged';
  assert.throws(
    () => validateKluReceiptShape(receipt),
    (error) => error.code === 'klu.output.receipt_toolchain',
  );
});

test('dynamic audit allows libc/libm and rejects all governed shared dependencies', () => {
  assert.deepEqual(auditKluDynamicDependencies([
    'libm.so.6 => /lib/x86_64-linux-gnu/libm.so.6',
    'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6',
  ].join('\n')), { forbiddenDynamicDependencies: 0 });
  for (const library of [
    'libsundials_ida.so', 'libklu.so', 'libgomp.so', 'libblas.so',
    'libopenblas.so', 'libatlas.so', 'libmkl_rt.so',
  ]) {
    assert.throws(
      () => auditKluDynamicDependencies(`${library} => /usr/lib/${library}`),
      SundialsKluNativeBuildError,
    );
  }
});

test('symbol audit and source prove a real KLU factor/solve with canonical static order', () => {
  assert.deepEqual(auditKluLinkSymbols([
    '000 T SUNLinSol_KLU', '000 T klu_l_factor', '000 T SuiteSparse_version',
  ].join('\n')), { requiredSymbols: 3, cholmodSymbols: 0 });
  assert.throws(
    () => auditKluLinkSymbols('000 T SUNLinSol_KLU\n000 T SuiteSparse_version'),
    SundialsKluNativeBuildError,
  );
  assert.throws(
    () => auditKluLinkSymbols('U SUNLinSol_KLU\n000 T klu_l_factor\n000 T SuiteSparse_version'),
    SundialsKluNativeBuildError,
  );
  assert.throws(
    () => auditKluLinkSymbols('w SUNLinSol_KLU\n000 T klu_l_factor\n000 T SuiteSparse_version'),
    SundialsKluNativeBuildError,
  );
  const source = readFileSync(join(SUNDIALS_IDA_KLU_PROBE_DIRECTORY, 'main.c'), 'utf8');
  assert.match(source, /SUNLinSolSetup\(solver, matrix\)/u);
  assert.match(source, /SUNLinSolSolve\(solver, matrix, solution, right_hand_side/u);
  assert.equal(SUNDIALS_IDA_KLU_PROBE_TARGET, 'sundials_ida_klu_factor_probe');
  assert.deepEqual(canonicalKluLinkOrder(), [
    'libsundials_ida.a', 'libsundials_sunlinsolklu.a',
    'libsundials_core.a', 'libklu.a', 'libamd.a',
    'libcolamd.a', 'libbtf.a', 'libsuitesparseconfig.a',
  ]);
});
