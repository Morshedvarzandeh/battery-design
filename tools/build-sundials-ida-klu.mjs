#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants, copyFileSync, readFileSync } from 'node:fs';
import {
  chmod, cp, lstat, mkdir, mkdtemp, realpath, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  SUNDIALS_CMAKE_DEFINITIONS,
  parseCmakeCache,
  validateArchiveEntries as validateSundialsArchiveEntries,
} from './build-sundials-ida.mjs';
import {
  SUNDIALS_SOURCE_LOCK,
  SUNDIALS_SOURCE_LOCK_PATH,
  verifySundialsArchive,
  verifySundialsLicenseFiles,
} from './verify-sundials-source.mjs';
import {
  SUITESPARSE_COMPONENT_CONTRACT,
  SUITESPARSE_SOURCE_LOCK,
  SUITESPARSE_SOURCE_LOCK_PATH,
  verifySuiteSparseArchive,
  verifySuiteSparseLicenseFiles,
} from './verify-suitesparse-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SUNDIALS_IDA_KLU_PROBE_DIRECTORY = resolve(ROOT, 'tools/sundials-ida-klu-probe');
export const SUNDIALS_IDA_KLU_PROBE_TARGET = 'sundials_ida_klu_factor_probe';
export const KLU_BUILD_RECEIPT = 'battery-design-native-dae-klu-build.json';
export const PUBLISHED_SUNDIALS_LOCK = 'battery-design-sundials-source-lock.json';
export const PUBLISHED_SUITESPARSE_LOCK = 'battery-design-suitesparse-source-lock.json';

export const KLU_PUBLISHED_ARCHIVES = Object.freeze([
  'libamd.a',
  'libbtf.a',
  'libcolamd.a',
  'libklu.a',
  'libsuitesparseconfig.a',
  'libsundials_core.a',
  'libsundials_ida.a',
  'libsundials_sunlinsolklu.a',
]);

export const KLU_CRITICAL_HEADERS = Object.freeze([
  'include/sundials/sundials_config.h',
  'include/ida/ida.h',
  'include/ida/ida_ls.h',
  'include/nvector/nvector_serial.h',
  'include/sunlinsol/sunlinsol_klu.h',
  'include/sunmatrix/sunmatrix_sparse.h',
  'include/suitesparse/SuiteSparse_config.h',
  'include/suitesparse/amd.h',
  'include/suitesparse/btf.h',
  'include/suitesparse/colamd.h',
  'include/suitesparse/klu.h',
]);

export const KLU_PUBLISHED_LICENSES = Object.freeze([
  'share/licenses/sundials/LICENSE',
  'share/licenses/sundials/NOTICE',
  'share/licenses/suitesparse/AMD.txt',
  'share/licenses/suitesparse/BTF.txt',
  'share/licenses/suitesparse/BTF-LGPL-2.1.txt',
  'share/licenses/suitesparse/COLAMD.txt',
  'share/licenses/suitesparse/KLU.txt',
  'share/licenses/suitesparse/KLU-LGPL-2.1.txt',
  'share/licenses/suitesparse/SuiteSparse_config.txt',
]);

export const SUITESPARSE_ARCHIVE_LIMITS = Object.freeze({
  entries: 20_000,
  pathBytes: 4_096,
  regularFileBytes: 64 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
});

export const SUITESPARSE_CMAKE_DEFINITIONS = Object.freeze({
  CMAKE_BUILD_TYPE: 'Release',
  CMAKE_INSTALL_LIBDIR: 'lib',
  BUILD_SHARED_LIBS: 'OFF',
  BUILD_STATIC_LIBS: 'ON',
  SUITESPARSE_ENABLE_PROJECTS: 'suitesparse_config;amd;btf;colamd;klu',
  KLU_USE_CHOLMOD: 'OFF',
  CHOLMOD_CAMD: 'OFF',
  UMFPACK_USE_CHOLMOD: 'OFF',
  SUITESPARSE_USE_OPENMP: 'OFF',
  SUITESPARSE_CONFIG_USE_OPENMP: 'OFF',
  SUITESPARSE_USE_FORTRAN: 'OFF',
  SUITESPARSE_USE_CUDA: 'OFF',
  SUITESPARSE_USE_STRICT: 'ON',
  SUITESPARSE_DEMOS: 'OFF',
  SUITESPARSE_USE_SYSTEM_BTF: 'OFF',
  SUITESPARSE_USE_SYSTEM_CHOLMOD: 'OFF',
  SUITESPARSE_USE_SYSTEM_AMD: 'OFF',
  SUITESPARSE_USE_SYSTEM_COLAMD: 'OFF',
  SUITESPARSE_USE_SYSTEM_CAMD: 'OFF',
  SUITESPARSE_USE_SYSTEM_CCOLAMD: 'OFF',
  SUITESPARSE_USE_SYSTEM_GRAPHBLAS: 'OFF',
  SUITESPARSE_USE_SYSTEM_SUITESPARSE_CONFIG: 'OFF',
  SUITESPARSE_USE_SYSTEM_UMFPACK: 'OFF',
});

export const SUNDIALS_KLU_CMAKE_DEFINITIONS = Object.freeze({
  ...SUNDIALS_CMAKE_DEFINITIONS,
  SUNDIALS_ENABLE_KLU: 'ON',
  SUNDIALS_ENABLE_KLU_CHECKS: 'ON',
});

const BOOL_DEFINITIONS = new Set([
  ...Object.keys(SUITESPARSE_CMAKE_DEFINITIONS).filter((name) => (
    name !== 'CMAKE_BUILD_TYPE'
      && name !== 'CMAKE_INSTALL_LIBDIR'
      && name !== 'SUITESPARSE_ENABLE_PROJECTS'
  )),
  ...Object.keys(SUNDIALS_KLU_CMAKE_DEFINITIONS).filter((name) => (
    name !== 'CMAKE_BUILD_TYPE'
      && name !== 'SUNDIALS_PRECISION'
      && name !== 'SUNDIALS_INDEX_SIZE'
  )),
]);

const SUITESPARSE_SELECTED_PREFIXES = Object.freeze([
  'SuiteSparse_config/', 'AMD/', 'BTF/', 'COLAMD/', 'KLU/',
]);
export const SUITESPARSE_NO_BLAS_INITIAL_CACHE = [
  '# Closed initial cache: selected KLU components do not consume BLAS.',
  'set(BLAS_LIBRARIES "" CACHE STRING "No BLAS library in the curated KLU build")',
  'set(BLAS_INCLUDE_DIRS "" CACHE STRING "No BLAS include path in the curated KLU build")',
  'set(CMAKE_FIND_USE_PACKAGE_REGISTRY OFF CACHE BOOL "Disable user package registry")',
  'set(CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY OFF CACHE BOOL "Disable system package registry")',
  '',
].join('\n');
const SUITESPARSE_REQUIRED_FILES = Object.freeze([
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
]);
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const SUNDIALS_DEPENDENCY_PRUNED_OPTIONS = new Set([
  'SUNDIALS_ENABLE_ADIAK',
  'SUNDIALS_ENABLE_CALIPER',
  'SUNDIALS_ENABLE_CUDA_EXAMPLES',
  'SUNDIALS_ENABLE_FORTRAN_EXAMPLES',
]);
const SUNDIALS_ALLOWED_ON_OPTIONS = new Set([
  'SUNDIALS_ENABLE_IDA',
  'SUNDIALS_ENABLE_ERROR_CHECKS',
  'SUNDIALS_ENABLE_KLU',
  'SUNDIALS_ENABLE_SUNLINSOL_KLU',
  // Upstream configure-test toggles, not backend enablements. Their matching
  // TPL switches remain locked OFF; only the KLU check is exercised.
  'SUNDIALS_ENABLE_ADIAK_CHECKS',
  'SUNDIALS_ENABLE_CALIPER_CHECKS',
  'SUNDIALS_ENABLE_GINKGO_CHECKS',
  'SUNDIALS_ENABLE_HYPRE_CHECKS',
  'SUNDIALS_ENABLE_KLU_CHECKS',
  'SUNDIALS_ENABLE_KOKKOS_CHECKS',
  'SUNDIALS_ENABLE_KOKKOS_KERNELS_CHECKS',
  'SUNDIALS_ENABLE_LAPACK_CHECKS',
  'SUNDIALS_ENABLE_MAGMA_CHECKS',
  'SUNDIALS_ENABLE_ONEMKL_CHECKS',
  'SUNDIALS_ENABLE_OPENMP_DEVICE_CHECKS',
  'SUNDIALS_ENABLE_PETSC_CHECKS',
  'SUNDIALS_ENABLE_SUPERLUDIST_CHECKS',
  'SUNDIALS_ENABLE_SUPERLUMT_CHECKS',
  'SUNDIALS_ENABLE_XBRAID_CHECKS',
]);

export class SundialsKluNativeBuildError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SundialsKluNativeBuildError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new SundialsKluNativeBuildError(code, message, details);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function canonicalLockBytes(path, label) {
  const raw = readFileSync(path, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail('klu.source_lock.noncanonical', `${label} source lock is not valid JSON: ${error.message}`);
  }
  if (raw !== `${JSON.stringify(value, null, 2)}\n`) {
    fail(
      'klu.source_lock.noncanonical',
      `${label} source lock must be exact canonical JSON without duplicate keys or trailing data`,
    );
  }
  return Buffer.from(raw, 'utf8');
}

function exactKeys(value, expected, location, code = 'klu.output.receipt_shape') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${location} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(code, `${location} keys must be exactly ${wanted.join(', ')}; received ${actual.join(', ')}`);
  }
}

function safeToolchainIdentity(value) {
  return typeof value === 'string' && value.length > 0 && !/["\\\0-\x1f]/u.test(value);
}

function normalizedSuiteSparsePath(rawPath, archiveRoot) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    fail('klu.archive.path_empty', 'archive entry path must not be empty');
  }
  if (Buffer.byteLength(rawPath) > SUITESPARSE_ARCHIVE_LIMITS.pathBytes) {
    fail('klu.archive.path_too_long', 'archive entry path exceeds the bounded path length');
  }
  if (/[\\\0-\x1f\x7f]/u.test(rawPath)) {
    fail('klu.archive.path_unsafe', `archive entry path contains a control or backslash: ${JSON.stringify(rawPath)}`);
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:/u.test(rawPath)) {
    fail('klu.archive.path_absolute', `archive entry path is absolute: ${rawPath}`);
  }
  const withoutTrailingSlash = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('klu.archive.path_traversal', `archive entry path is not canonical: ${rawPath}`);
  }
  if (segments[0] !== archiveRoot) {
    fail('klu.archive.root_mismatch', `archive entry is outside ${archiveRoot}: ${rawPath}`);
  }
  return withoutTrailingSlash;
}

function isSelectedSuiteSparsePath(relative) {
  return relative === 'CMakeLists.txt'
    || SUITESPARSE_SELECTED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

export function validateSuiteSparseArchiveEntries(
  entries,
  lock = SUITESPARSE_SOURCE_LOCK,
  { exactInventory = false } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('klu.archive.empty', 'SuiteSparse archive has no entries');
  }
  if (entries.length > SUITESPARSE_ARCHIVE_LIMITS.entries) {
    fail('klu.archive.too_many_entries', 'SuiteSparse archive has too many entries');
  }
  const root = lock.sourceArchive.archiveRoot;
  const seen = new Set();
  let expandedBytes = 0;
  let selectedEntries = 0;
  let selectedExpandedBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      fail('klu.archive.entry_invalid', 'archive entry metadata must be an object');
    }
    const path = normalizedSuiteSparsePath(entry.path, root);
    if (seen.has(path)) fail('klu.archive.path_duplicate', `duplicate archive entry: ${path}`);
    seen.add(path);
    if (entry.type !== '-' && entry.type !== 'd') {
      fail('klu.archive.type_unsafe', `archive entry is not a regular file or directory: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      fail('klu.archive.size_invalid', `archive entry has an invalid size: ${entry.path}`);
    }
    if (entry.type === 'd' && entry.sizeBytes !== 0) {
      fail('klu.archive.directory_size', `archive directory has non-zero size: ${entry.path}`);
    }
    if (entry.sizeBytes > SUITESPARSE_ARCHIVE_LIMITS.regularFileBytes) {
      fail('klu.archive.file_too_large', `archive entry exceeds the per-file limit: ${entry.path}`);
    }
    expandedBytes += entry.sizeBytes;
    if (!Number.isSafeInteger(expandedBytes)
        || expandedBytes > SUITESPARSE_ARCHIVE_LIMITS.expandedBytes) {
      fail('klu.archive.expanded_too_large', 'SuiteSparse archive exceeds the expansion limit');
    }
    const relative = path === root ? '' : path.slice(root.length + 1);
    if (isSelectedSuiteSparsePath(relative)) {
      selectedEntries += 1;
      selectedExpandedBytes += entry.sizeBytes;
    }
  }
  for (const required of SUITESPARSE_REQUIRED_FILES) {
    if (!seen.has(`${root}/${required}`)) {
      fail('klu.archive.required_file_missing', `archive is missing ${root}/${required}`);
    }
  }
  if (exactInventory && (
    entries.length !== lock.sourceArchive.entries
      || expandedBytes !== lock.sourceArchive.expandedBytes
      || selectedEntries !== lock.selectedSource.entries
      || selectedExpandedBytes !== lock.selectedSource.expandedBytes
  )) {
    fail('klu.archive.inventory_drift', 'SuiteSparse archive inventory does not match the closed lock');
  }
  return Object.freeze({
    entries: entries.length,
    expandedBytes,
    selectedEntries,
    selectedExpandedBytes,
    archiveRoot: root,
  });
}

export function parseSuiteSparseTarInventory(namesOutput, verboseOutput) {
  const names = namesOutput.split('\n').filter(Boolean);
  const verboseLines = verboseOutput.split('\n').filter(Boolean);
  if (names.length !== verboseLines.length) {
    fail('klu.archive.inventory_mismatch', 'tar name and metadata inventories differ in length');
  }
  return names.map((path, index) => {
    const match = /^(\S+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s([\s\S]+)$/u.exec(verboseLines[index]);
    if (!match || match[3] !== path) {
      fail('klu.archive.inventory_unparseable', `cannot safely parse tar metadata for ${JSON.stringify(path)}`);
    }
    return { path, type: match[1][0], sizeBytes: Number(match[2]) };
  });
}

function printCommandOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function runCommand(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    windowsHide: true,
  });
  if (options.echo !== false) printCommandOutput(result);
  if (result.error) {
    fail('klu.command.spawn_failed', `${command} could not run: ${result.error.message}`, {
      command, arguments: arguments_, cause: result.error.code,
    });
  }
  if (result.status !== 0) {
    fail('klu.command.failed', `${command} exited with status ${result.status}`, {
      command, arguments: arguments_, status: result.status,
      output: `${result.stdout}\n${result.stderr}`.slice(-16_384),
    });
  }
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
}

function inspectArchive(archivePath, validator, lock, exactInventory) {
  const common = [
    '--list', '--gzip', '--file', archivePath, '--numeric-owner', '--quoting-style=escape',
  ];
  const names = runCommand('tar', common, { echo: false });
  const verbose = runCommand('tar', [...common, '--verbose', '--full-time'], { echo: false });
  return validator(parseSuiteSparseTarInventory(names.stdout, verbose.stdout), lock, { exactInventory });
}

function assertCacheValue(cache, name, expectedType, value) {
  const actual = cache.get(name);
  const types = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!actual || !types.includes(actual.type) || actual.value !== value) {
    fail(
      'klu.cmake.cache_drift',
      `CMake cache drift for ${name}: expected ${types.join('|')}=${value}, received ${actual ? `${actual.type}=${actual.value}` : 'no entry'}`,
    );
  }
}

function rejectUntypedCache(cache) {
  for (const [name, entry] of cache) {
    if (entry.type === 'UNINITIALIZED') {
      fail('klu.cmake.unused_variable', `CMake left ${name} untyped and unused`);
    }
  }
}

function assertNoUnusedCmakeVariables(output, phase) {
  if (/Manually-specified variables were not used by the project/iu.test(output)) {
    fail('klu.cmake.unused_variables', `${phase} reported unused manually specified variables`);
  }
}

function pathInside(path, roots) {
  const absolute = resolve(path);
  return roots.some((root) => absolute === resolve(root) || absolute.startsWith(`${resolve(root)}${sep}`));
}

function auditDependencyPaths(cache, pattern, allowedRoots, label) {
  for (const [name, entry] of cache) {
    if (!pattern.test(name) || !entry.value) continue;
    for (const value of entry.value.split(';')) {
      if (!value.startsWith('/')) continue;
      if (!pathInside(value, allowedRoots)) {
        fail('klu.cmake.path_escape', `${label} cache entry ${name} escaped private roots: ${value}`);
      }
    }
  }
}

export function auditSuiteSparseCmakeCache(
  cacheText,
  configureOutput,
  { sourceDirectory, buildDirectory, installDirectory },
) {
  assertNoUnusedCmakeVariables(configureOutput, 'SuiteSparse configuration');
  const cache = parseCmakeCache(cacheText);
  rejectUntypedCache(cache);
  assertCacheValue(cache, 'CMAKE_BUILD_TYPE', 'STRING', 'Release');
  assertCacheValue(cache, 'CMAKE_INSTALL_PREFIX', 'PATH', resolve(installDirectory));
  assertCacheValue(cache, 'CMAKE_INSTALL_LIBDIR', ['PATH', 'STRING'], 'lib');
  assertCacheValue(cache, 'BLAS_LIBRARIES', 'STRING', '');
  assertCacheValue(cache, 'BLAS_INCLUDE_DIRS', 'STRING', '');
  assertCacheValue(cache, 'CMAKE_FIND_USE_PACKAGE_REGISTRY', 'BOOL', 'OFF');
  assertCacheValue(cache, 'CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY', 'BOOL', 'OFF');
  for (const [name, value] of Object.entries(SUITESPARSE_CMAKE_DEFINITIONS)) {
    if (name === 'CMAKE_BUILD_TYPE' || name === 'CMAKE_INSTALL_LIBDIR') continue;
    assertCacheValue(cache, name, BOOL_DEFINITIONS.has(name) ? 'BOOL' : 'STRING', value);
  }
  auditDependencyPaths(
    cache,
    /^(?:KLU|AMD|BTF|COLAMD|SuiteSparse_config).*?(?:DIR|LIBRARY|INCLUDE)/u,
    [sourceDirectory, buildDirectory, installDirectory],
    'SuiteSparse',
  );
  return cache;
}

export function auditSundialsKluCmakeCache(
  cacheText,
  configureOutput,
  { installDirectory, suiteSparseDirectory, kluPaths = null },
) {
  assertNoUnusedCmakeVariables(configureOutput, 'SUNDIALS KLU configuration');
  const cache = parseCmakeCache(cacheText);
  rejectUntypedCache(cache);
  assertCacheValue(cache, 'CMAKE_BUILD_TYPE', 'STRING', 'Release');
  assertCacheValue(cache, 'CMAKE_INSTALL_PREFIX', 'PATH', resolve(installDirectory));
  assertCacheValue(cache, 'CMAKE_FIND_USE_PACKAGE_REGISTRY', 'BOOL', 'OFF');
  assertCacheValue(cache, 'CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY', 'BOOL', 'OFF');
  for (const [name, value] of Object.entries(SUNDIALS_KLU_CMAKE_DEFINITIONS)) {
    if (SUNDIALS_DEPENDENCY_PRUNED_OPTIONS.has(name) && !cache.has(name)) continue;
    const type = name === 'SUNDIALS_PRECISION' || name === 'SUNDIALS_INDEX_SIZE'
      || name === 'CMAKE_BUILD_TYPE' ? 'STRING' : 'BOOL';
    assertCacheValue(cache, name, type, value);
  }
  assertCacheValue(cache, 'KLU_ROOT', 'PATH', resolve(suiteSparseDirectory));
  assertCacheValue(cache, 'SUNDIALS_ENABLE_SUNLINSOL_KLU', 'BOOL', 'ON');
  if (kluPaths) {
    assertCacheValue(cache, 'KLU_INCLUDE_DIR', 'PATH', resolve(kluPaths.include));
    assertCacheValue(cache, 'KLU_LIBRARY_DIR', 'PATH', resolve(kluPaths.libraryDirectory));
    for (const [name, path] of Object.entries(kluPaths.libraries)) {
      assertCacheValue(cache, name, 'FILEPATH', resolve(path));
    }
  }
  auditDependencyPaths(
    cache,
    /^(?:KLU|AMD|BTF|COLAMD|SUITESPARSECONFIG|SuiteSparse_config).*?(?:DIR|LIBRARY|INCLUDE|ROOT)/u,
    [suiteSparseDirectory],
    'SUNDIALS KLU',
  );
  for (const [name, entry] of cache) {
    const unexpected = name.startsWith('SUNDIALS_ENABLE_') && entry.value === 'ON'
      && !SUNDIALS_ALLOWED_ON_OPTIONS.has(name);
    if (unexpected) fail('klu.cmake.unexpected_enable', `unexpected SUNDIALS enable: ${name}`);
  }
  return cache;
}

export function auditKluDynamicDependencies(lddOutput) {
  if (typeof lddOutput !== 'string') {
    fail('klu.probe.dynamic_dependencies_invalid', 'ldd output must be text');
  }
  const forbidden = /(?:^|[/\s])(?:libsundials|libklu|libamd|libbtf|libcolamd|libsuitesparseconfig|libgomp|libomp|libblas|libopenblas|libatlas|libmkl|liblapack)(?:[_\-.]|$)/iu;
  const dependency = lddOutput.split(/\r?\n/u).find((line) => forbidden.test(line));
  if (dependency) {
    fail('klu.probe.dynamic_dependency', `probe has a forbidden dynamic dependency: ${dependency.trim()}`);
  }
  return Object.freeze({ forbiddenDynamicDependencies: 0 });
}

export function auditKluLinkSymbols(nmOutput) {
  if (typeof nmOutput !== 'string') fail('klu.probe.symbols_invalid', 'nm output must be text');
  for (const symbol of ['SUNLinSol_KLU', 'klu_l_factor', 'SuiteSparse_version']) {
    if (!new RegExp(`^\\s*[0-9a-fA-F]+\\s+T\\s+${symbol}\\s*$`, 'mu').test(nmOutput)) {
      fail('klu.probe.symbol_missing', `probe is missing statically linked symbol ${symbol}`);
    }
  }
  if (/(?:^|\s)cholmod_[A-Za-z0-9_]+(?:$|\s)/mu.test(nmOutput)) {
    fail('klu.probe.cholmod_symbol', 'probe unexpectedly contains a CHOLMOD symbol');
  }
  return Object.freeze({ requiredSymbols: 3, cholmodSymbols: 0 });
}

function requireMacro(text, macro, expected, path) {
  const escaped = macro.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const value = expected === null ? '(?:\\s*(?://.*)?)?'
    : `\\s+${String(expected).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\s*(?://.*)?)?`;
  if (!new RegExp(`^\\s*#\\s*define\\s+${escaped}${value}\\s*$`, 'mu').test(text)) {
    fail(
      'klu.output.header_contract',
      `${path} does not define ${macro}${expected === null ? '' : ` as ${expected}`}`,
    );
  }
}

function requireSundialsConfigContract(config, path) {
  requireMacro(config, 'SUNDIALS_VERSION', '"7.8.0"', path);
  requireMacro(config, 'SUNDIALS_VERSION_MAJOR', 7, path);
  requireMacro(config, 'SUNDIALS_VERSION_MINOR', 8, path);
  requireMacro(config, 'SUNDIALS_VERSION_PATCH', 0, path);
  requireMacro(config, 'SUNDIALS_DOUBLE_PRECISION', 1, path);
  requireMacro(config, 'SUNDIALS_INT64_T', 1, path);
  requireMacro(config, 'SUNDIALS_MPI_ENABLED', 0, path);
  requireMacro(config, 'SUNDIALS_ENABLE_ERROR_CHECKS', null, path);
  requireMacro(config, 'SUNDIALS_KLU_ENABLED', null, path);
}

const SUITESPARSE_HEADER_CONTRACTS = Object.freeze({
  'include/suitesparse/SuiteSparse_config.h': Object.freeze([
    ['SUITESPARSE_MAIN_VERSION', 7],
    ['SUITESPARSE_SUB_VERSION', 7],
    ['SUITESPARSE_SUBSUB_VERSION', 0],
  ]),
  'include/suitesparse/amd.h': Object.freeze([
    ['AMD_MAIN_VERSION', 3], ['AMD_SUB_VERSION', 3], ['AMD_SUBSUB_VERSION', 2],
  ]),
  'include/suitesparse/btf.h': Object.freeze([
    ['BTF_MAIN_VERSION', 2], ['BTF_SUB_VERSION', 3], ['BTF_SUBSUB_VERSION', 2],
  ]),
  'include/suitesparse/colamd.h': Object.freeze([
    ['COLAMD_MAIN_VERSION', 3], ['COLAMD_SUB_VERSION', 3], ['COLAMD_SUBSUB_VERSION', 3],
  ]),
  'include/suitesparse/klu.h': Object.freeze([
    ['KLU_MAIN_VERSION', 2], ['KLU_SUB_VERSION', 3], ['KLU_SUBSUB_VERSION', 3],
  ]),
});

async function requireRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail('klu.output.file_missing', `${label} is missing: ${error.message}`, { path });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('klu.output.file_unsafe', `${label} must be a regular file`, { path });
  }
  return metadata;
}

function componentVersions() {
  return Object.fromEntries(
    Object.entries(SUITESPARSE_COMPONENT_CONTRACT).map(([name, value]) => [name, value.version]),
  );
}

export function expectedKluBuildReceipt({ root, toolchain }) {
  if (typeof root !== 'string') fail('klu.output.receipt_root', 'receipt root must be explicit');
  exactKeys(
    toolchain,
    ['cmake', 'cCompiler', 'cxxCompiler', 'archiver', 'linker'],
    'toolchain input',
  );
  for (const [name, value] of Object.entries(toolchain)) {
    if (!safeToolchainIdentity(value)) {
      fail('klu.output.receipt_toolchain', `toolchain identity ${name} is unsafe`);
    }
  }
  const installRoot = resolve(root);
  return {
    format: 'battery-design/native-dae-klu-build-receipt@2',
    backend: 'SUNDIALS/IDA+SuiteSparse/KLU',
    sources: {
      sundials: {
        lockFormat: SUNDIALS_SOURCE_LOCK.format,
        lockSha256: sha256File(SUNDIALS_SOURCE_LOCK_PATH),
        version: SUNDIALS_SOURCE_LOCK.version,
        commitSha: SUNDIALS_SOURCE_LOCK.commitSha,
        archiveSha256: SUNDIALS_SOURCE_LOCK.sourceArchive.sha256,
      },
      suitesparse: {
        lockFormat: SUITESPARSE_SOURCE_LOCK.format,
        lockSha256: sha256File(SUITESPARSE_SOURCE_LOCK_PATH),
        version: SUITESPARSE_SOURCE_LOCK.version,
        commitSha: SUITESPARSE_SOURCE_LOCK.commitSha,
        archiveSha256: SUITESPARSE_SOURCE_LOCK.sourceArchive.sha256,
      },
    },
    build: {
      linkage: 'static',
      precision: 'double',
      indexBits: 64,
      mpi: false,
      openmp: false,
      klu: true,
      kluChecks: true,
      cholmod: false,
      blas: false,
    },
    components: componentVersions(),
    artifacts: Object.fromEntries(
      KLU_PUBLISHED_ARCHIVES.map((name) => [name, sha256File(join(installRoot, 'lib', name))]),
    ),
    headers: Object.fromEntries(
      KLU_CRITICAL_HEADERS.map((relative) => [relative, sha256File(join(installRoot, relative))]),
    ),
    licenses: Object.fromEntries(
      KLU_PUBLISHED_LICENSES.map((relative) => [relative, sha256File(join(installRoot, relative))]),
    ),
    toolchain: { ...toolchain },
  };
}

function requireReceiptShape(receipt) {
  exactKeys(receipt, [
    'format', 'backend', 'sources', 'build', 'components', 'artifacts', 'headers',
    'licenses', 'toolchain',
  ], '$');
  exactKeys(receipt.sources, ['sundials', 'suitesparse'], '$.sources');
  for (const name of ['sundials', 'suitesparse']) {
    exactKeys(
      receipt.sources[name],
      ['lockFormat', 'lockSha256', 'version', 'commitSha', 'archiveSha256'],
      `$.sources.${name}`,
    );
  }
  exactKeys(receipt.build, [
    'linkage', 'precision', 'indexBits', 'mpi', 'openmp', 'klu', 'kluChecks',
    'cholmod', 'blas',
  ], '$.build');
  exactKeys(receipt.components, Object.keys(SUITESPARSE_COMPONENT_CONTRACT), '$.components');
  exactKeys(receipt.artifacts, KLU_PUBLISHED_ARCHIVES, '$.artifacts');
  exactKeys(receipt.headers, KLU_CRITICAL_HEADERS, '$.headers');
  exactKeys(receipt.licenses, KLU_PUBLISHED_LICENSES, '$.licenses');
  exactKeys(
    receipt.toolchain,
    ['cmake', 'cCompiler', 'cxxCompiler', 'archiver', 'linker'],
    '$.toolchain',
  );
}

export function validateKluReceiptShape(receipt) {
  requireReceiptShape(receipt);
  for (const [name, value] of Object.entries(receipt.toolchain)) {
    if (!safeToolchainIdentity(value)) {
      fail('klu.output.receipt_toolchain', `receipt toolchain identity ${name} is unsafe`);
    }
  }
  return Object.freeze({ format: receipt.format, artifactCount: KLU_PUBLISHED_ARCHIVES.length });
}

async function exactStaticLibrarySurface(root) {
  const libraryDirectory = join(root, 'lib');
  let entries;
  try {
    entries = await readdir(libraryDirectory, { withFileTypes: true });
  } catch (error) {
    fail('klu.output.library_unreadable', `cannot inspect curated lib: ${error.message}`);
  }
  if (entries.some((entry) => entry.isSymbolicLink())) {
    fail('klu.output.archive_unsafe', 'curated lib must not contain symbolic links');
  }
  const names = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile())
      || JSON.stringify(names) !== JSON.stringify(KLU_PUBLISHED_ARCHIVES)) {
    fail(
      'klu.output.archive_surface',
      `curated lib must contain exactly ${KLU_PUBLISHED_ARCHIVES.join(', ')}; received ${names.join(', ')}`,
    );
  }
  for (const name of KLU_PUBLISHED_ARCHIVES) {
    const metadata = await requireRegularFile(join(libraryDirectory, name), `curated archive ${name}`);
    if (metadata.size === 0) fail('klu.output.archive_empty', `curated archive ${name} is empty`);
  }
}

export async function verifyPublishedKluInstall(output) {
  const root = resolve(output);
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    fail('klu.output.missing', `curated install does not exist: ${error.message}`, { root });
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('klu.output.root_unsafe', 'curated install must be a real directory', { root });
  }

  const installedLocks = [
    [PUBLISHED_SUNDIALS_LOCK, SUNDIALS_SOURCE_LOCK_PATH, 'SUNDIALS'],
    [PUBLISHED_SUITESPARSE_LOCK, SUITESPARSE_SOURCE_LOCK_PATH, 'SuiteSparse'],
  ];
  for (const [installedName, repositoryPath, label] of installedLocks) {
    const installedPath = join(root, installedName);
    await requireRegularFile(installedPath, `curated ${label} source lock`);
    const repository = canonicalLockBytes(repositoryPath, label);
    if (!readFileSync(installedPath).equals(repository)) {
      fail('klu.output.source_lock_mismatch', `curated ${label} source lock drifted`);
    }
  }

  await exactStaticLibrarySurface(root);
  for (const relative of [...KLU_CRITICAL_HEADERS, ...KLU_PUBLISHED_LICENSES]) {
    await requireRegularFile(join(root, relative), `curated file ${relative}`);
  }

  const sundialsLicenseContract = [
    [KLU_PUBLISHED_LICENSES[0], SUNDIALS_SOURCE_LOCK.license.licenseFile],
    [KLU_PUBLISHED_LICENSES[1], SUNDIALS_SOURCE_LOCK.license.noticeFile],
  ];
  for (const [relative, expected] of sundialsLicenseContract) {
    const path = join(root, relative);
    const metadata = await lstat(path);
    if (metadata.size !== expected.sizeBytes || sha256File(path) !== expected.sha256) {
      fail('klu.output.license_mismatch', `${relative} does not match the SUNDIALS lock`);
    }
  }
  for (const [name, component] of Object.entries(SUITESPARSE_SOURCE_LOCK.components)) {
    const lockedFiles = [[`share/licenses/suitesparse/${name}.txt`, component.licenseFile]];
    if (component.licenseTextFile) {
      lockedFiles.push([
        `share/licenses/suitesparse/${name}-LGPL-2.1.txt`,
        component.licenseTextFile,
      ]);
    }
    for (const [relative, expected] of lockedFiles) {
      const path = join(root, relative);
      const metadata = await lstat(path);
      if (metadata.size !== expected.sizeBytes || sha256File(path) !== expected.sha256) {
        fail('klu.output.license_mismatch', `${relative} does not match the SuiteSparse lock`);
      }
    }
  }

  const sundialsConfigPath = join(root, 'include/sundials/sundials_config.h');
  requireSundialsConfigContract(readFileSync(sundialsConfigPath, 'utf8'), sundialsConfigPath);
  for (const [relative, contract] of Object.entries(SUITESPARSE_HEADER_CONTRACTS)) {
    const path = join(root, relative);
    const text = readFileSync(path, 'utf8');
    for (const [macro, expected] of contract) requireMacro(text, macro, expected, path);
  }

  const receiptPath = join(root, KLU_BUILD_RECEIPT);
  await requireRegularFile(receiptPath, 'curated @2 build receipt');
  const raw = readFileSync(receiptPath, 'utf8');
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (error) {
    fail('klu.output.receipt_invalid', `curated @2 receipt is invalid JSON: ${error.message}`);
  }
  validateKluReceiptShape(receipt);
  const expected = expectedKluBuildReceipt({ root, toolchain: receipt.toolchain });
  if (raw !== `${JSON.stringify(receipt, null, 2)}\n`
      || JSON.stringify(receipt) !== JSON.stringify(expected)) {
    fail('klu.output.receipt_mismatch', 'curated @2 receipt is not exact and canonical for this root');
  }
  return Object.freeze({
    root,
    sundialsLockSha256: expected.sources.sundials.lockSha256,
    suiteSparseLockSha256: expected.sources.suitesparse.lockSha256,
    artifacts: Object.freeze({ ...expected.artifacts }),
  });
}

async function assertPrivateExtractedRoot(extractDirectory, sourceDirectory, label) {
  const extractReal = await realpath(extractDirectory);
  const metadata = await lstat(sourceDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('klu.archive.root_unsafe', `${label} extracted root is not a real directory`);
  }
  const sourceReal = await realpath(sourceDirectory);
  if (!sourceReal.startsWith(`${extractReal}${sep}`)) {
    fail('klu.archive.root_escape', `${label} extracted root escaped its private directory`);
  }
}

function definitionType(name) {
  if (BOOL_DEFINITIONS.has(name)
      || name.startsWith('CMAKE_FIND_USE_')
      || name === 'CMAKE_FIND_PACKAGE_NO_PACKAGE_REGISTRY') return 'BOOL';
  if (name.endsWith('_LIBRARY')) return 'FILEPATH';
  if (name.endsWith('_ROOT') || name.endsWith('_DIR')
      || name === 'CMAKE_INSTALL_PREFIX' || name === 'CMAKE_PREFIX_PATH') return 'PATH';
  return 'STRING';
}

function definitionsToArguments(definitions) {
  return Object.entries(definitions).map(
    ([name, value]) => `-D${name}:${definitionType(name)}=${value}`,
  );
}

async function pathMetadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('klu.output.unreadable', `cannot inspect ${path}: ${error.message}`);
  }
}

function firstOutputLine(result, label) {
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean);
  if (!safeToolchainIdentity(line)) {
    fail('klu.toolchain.identity_invalid', `${label} returned an unsafe identity`);
  }
  return line;
}

function cachePath(cache, name, label) {
  const entry = cache.get(name);
  if (!entry || !entry.value || !entry.value.startsWith('/')) {
    fail('klu.toolchain.path_missing', `${label} was not recorded as an absolute CMake path`);
  }
  return entry.value;
}

function findInstalledLibraryDirectory(installDirectory, requiredArchive, label) {
  for (const relative of ['lib', 'lib64']) {
    const candidate = join(installDirectory, relative);
    try {
      readFileSync(join(candidate, requiredArchive), { flag: 'r' });
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        fail('klu.output.archive_unreadable', `cannot inspect ${candidate}: ${error.message}`);
      }
    }
  }
  fail('klu.output.archive_missing', `${label} install is missing ${requiredArchive}`);
}

function suiteSparseCmakePackageDirectory(suiteInstall, packageName) {
  for (const lib of ['lib', 'lib64']) {
    const candidate = join(suiteInstall, lib, 'cmake', packageName);
    try {
      if (readFileSync(join(candidate, `${packageName}Config.cmake`), { flag: 'r' })) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        fail('klu.output.package_unreadable', `cannot inspect ${candidate}: ${error.message}`);
      }
    }
  }
  fail('klu.output.package_missing', `SuiteSparse install is missing ${packageName}Config.cmake`);
}

function sundialsCmakePackageDirectory(sundialsInstall) {
  for (const lib of ['lib', 'lib64']) {
    for (const relative of ['cmake/sundials', 'cmake/SUNDIALS']) {
      const candidate = join(sundialsInstall, lib, relative);
      try {
        const names = readFileSync(join(candidate, 'SUNDIALSConfig.cmake'), { flag: 'r' });
        if (names) return candidate;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          fail('klu.output.package_unreadable', `cannot inspect ${candidate}: ${error.message}`);
        }
      }
    }
  }
  fail('klu.output.package_missing', 'SUNDIALS install is missing SUNDIALSConfig.cmake');
}

function requirePrivateCachePath(cache, names, allowedRoot, label) {
  for (const name of names) {
    const entry = cache.get(name);
    if (!entry || !entry.value || !pathInside(entry.value, [allowedRoot])) {
      fail('klu.probe.package_escape', `${label} did not resolve ${name} below its private prefix`);
    }
  }
}

function curatedLinkArguments(root, output) {
  return [
    '-std=c11',
    '-O2',
    '-I', join(root, 'include'),
    '-I', join(root, 'include/suitesparse'),
    join(SUNDIALS_IDA_KLU_PROBE_DIRECTORY, 'main.c'),
    '-L', join(root, 'lib'),
    '-Wl,--start-group',
    '-lsundials_ida',
    '-lsundials_sunlinsolklu',
    '-lsundials_core',
    '-lklu',
    '-lamd',
    '-lcolamd',
    '-lbtf',
    '-lsuitesparseconfig',
    '-Wl,--end-group',
    '-lm',
    '-o', output,
  ];
}

export function canonicalKluLinkOrder() {
  return Object.freeze([
    'libsundials_ida.a',
    'libsundials_sunlinsolklu.a',
    'libsundials_core.a',
    'libklu.a',
    'libamd.a',
    'libcolamd.a',
    'libbtf.a',
    'libsuitesparseconfig.a',
  ]);
}

async function runCuratedSparseProbe(root, compiler = process.env.CC || 'cc') {
  const workspace = await mkdtemp(join(tmpdir(), 'battery-design-klu-curated-probe-'));
  await chmod(workspace, 0o700);
  const executable = join(workspace, SUNDIALS_IDA_KLU_PROBE_TARGET);
  try {
    runCommand(compiler, curatedLinkArguments(root, executable));
    runCommand(executable, []);
    const dynamic = runCommand('ldd', [executable]);
    auditKluDynamicDependencies(`${dynamic.stdout}\n${dynamic.stderr}`);
    const symbols = runCommand('nm', ['-g', executable]);
    auditKluLinkSymbols(`${symbols.stdout}\n${symbols.stderr}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function toolchainIdentities(suiteCache, sundialsCache) {
  const compiler = cachePath(sundialsCache, 'CMAKE_C_COMPILER', 'C compiler');
  const cxxCompiler = cachePath(suiteCache, 'CMAKE_CXX_COMPILER', 'C++ compiler');
  const archiver = cachePath(sundialsCache, 'CMAKE_AR', 'archiver');
  const linker = cachePath(sundialsCache, 'CMAKE_LINKER', 'linker');
  return Object.freeze({
    paths: Object.freeze({ compiler, cxxCompiler, archiver, linker }),
    receipt: Object.freeze({
      cmake: firstOutputLine(runCommand('cmake', ['--version'], { echo: false }), 'cmake'),
      cCompiler: firstOutputLine(runCommand(compiler, ['--version'], { echo: false }), 'C compiler'),
      cxxCompiler: firstOutputLine(runCommand(cxxCompiler, ['--version'], { echo: false }), 'C++ compiler'),
      archiver: firstOutputLine(runCommand(archiver, ['--version'], { echo: false }), 'archiver'),
      linker: firstOutputLine(runCommand(linker, ['--version'], { echo: false }), 'linker'),
    }),
  });
}

async function copyClosedFile(source, destination, label) {
  await requireRegularFile(source, label);
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
}

async function publishCuratedKluInstall({
  output,
  sundialsSource,
  suiteSparseSource,
  sundialsInstall,
  suiteSparseInstall,
  toolchain,
  compilerPath,
}) {
  const outputParent = dirname(output);
  const outputName = basename(output);
  await mkdir(outputParent, { recursive: true });
  const publishWorkspace = await mkdtemp(join(outputParent, `.${outputName}.publish-`));
  await chmod(publishWorkspace, 0o700);
  const staged = join(publishWorkspace, 'root');
  try {
    await mkdir(join(staged, 'lib'), { recursive: true });
    await mkdir(join(staged, 'share/licenses/sundials'), { recursive: true });
    await mkdir(join(staged, 'share/licenses/suitesparse'), { recursive: true });
    await cp(join(sundialsInstall, 'include'), join(staged, 'include'), {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });
    await cp(join(suiteSparseInstall, 'include/suitesparse'), join(staged, 'include/suitesparse'), {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });

    const sundialsLibrary = findInstalledLibraryDirectory(
      sundialsInstall,
      'libsundials_ida.a',
      'SUNDIALS',
    );
    const suiteSparseLibrary = findInstalledLibraryDirectory(
      suiteSparseInstall,
      'libklu.a',
      'SuiteSparse',
    );
    for (const name of KLU_PUBLISHED_ARCHIVES) {
      const sourceDirectory = name.startsWith('libsundials_')
        ? sundialsLibrary : suiteSparseLibrary;
      await copyClosedFile(
        join(sourceDirectory, name),
        join(staged, 'lib', name),
        `private build archive ${name}`,
      );
    }

    await copyClosedFile(
      join(sundialsSource, SUNDIALS_SOURCE_LOCK.license.licenseFile.path),
      join(staged, KLU_PUBLISHED_LICENSES[0]),
      'SUNDIALS LICENSE',
    );
    await copyClosedFile(
      join(sundialsSource, SUNDIALS_SOURCE_LOCK.license.noticeFile.path),
      join(staged, KLU_PUBLISHED_LICENSES[1]),
      'SUNDIALS NOTICE',
    );
    for (const [name, component] of Object.entries(SUITESPARSE_SOURCE_LOCK.components)) {
      await copyClosedFile(
        join(suiteSparseSource, component.licenseFile.path),
        join(staged, `share/licenses/suitesparse/${name}.txt`),
        `${name} license notice`,
      );
      if (component.licenseTextFile) {
        await copyClosedFile(
          join(suiteSparseSource, component.licenseTextFile.path),
          join(staged, `share/licenses/suitesparse/${name}-LGPL-2.1.txt`),
          `${name} full LGPL-2.1 text`,
        );
      }
    }
    await copyClosedFile(
      SUNDIALS_SOURCE_LOCK_PATH,
      join(staged, PUBLISHED_SUNDIALS_LOCK),
      'repository SUNDIALS source lock',
    );
    await copyClosedFile(
      SUITESPARSE_SOURCE_LOCK_PATH,
      join(staged, PUBLISHED_SUITESPARSE_LOCK),
      'repository SuiteSparse source lock',
    );

    const receipt = expectedKluBuildReceipt({ root: staged, toolchain });
    await writeFile(join(staged, KLU_BUILD_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o644,
    });
    await verifyPublishedKluInstall(staged);
    await runCuratedSparseProbe(staged, compilerPath);

    runCommand('mv', ['--no-target-directory', '--no-clobber', staged, output], { echo: false });
    if (await pathMetadata(staged)) {
      fail('klu.output.publish_collision', `refusing to overwrite output that appeared: ${output}`);
    }
    await verifyPublishedKluInstall(output);
    return output;
  } finally {
    await rm(publishWorkspace, { recursive: true, force: true });
  }
}

function parseCli(arguments_) {
  const options = { sundialsArchive: null, suiteSparseArchive: null, output: null };
  const mappings = Object.freeze({
    '--sundials-archive': 'sundialsArchive',
    '--suitesparse-archive': 'suiteSparseArchive',
    '--output': 'output',
  });
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const key = mappings[option];
    if (!key) fail('klu.cli.unknown_option', `unknown option: ${option}`);
    if (options[key] !== null) fail(`klu.cli.duplicate_${key}`, `${option} may appear only once`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) fail(`klu.cli.${key}_required`, `${option} requires a path`);
    options[key] = resolve(value);
    index += 1;
  }
  for (const [key, label] of [
    ['sundialsArchive', '--sundials-archive'],
    ['suiteSparseArchive', '--suitesparse-archive'],
    ['output', '--output'],
  ]) {
    if (options[key] === null) {
      fail(`klu.cli.${key}_required`, `${label} is required; source downloads are external to this helper`);
    }
  }
  if (options.output === resolve(sep)) fail('klu.cli.output_unsafe', '--output must not be filesystem root');
  return Object.freeze(options);
}

function suiteSparseExtractionArguments(archive, destination, root) {
  return [
    '--extract', '--gzip', '--file', archive,
    '--directory', destination,
    '--no-same-owner', '--no-same-permissions', '--delay-directory-restore',
    '--wildcards', '--anchored',
    `${root}/CMakeLists.txt`,
    `${root}/SuiteSparse_config/*`,
    `${root}/AMD/*`,
    `${root}/BTF/*`,
    `${root}/COLAMD/*`,
    `${root}/KLU/*`,
  ];
}

function explicitKluPaths(suiteInstall) {
  const libraryDirectory = findInstalledLibraryDirectory(suiteInstall, 'libklu.a', 'SuiteSparse');
  return Object.freeze({
    include: join(suiteInstall, 'include/suitesparse'),
    libraryDirectory,
    libraries: Object.freeze({
      KLU_LIBRARY: join(libraryDirectory, 'libklu.a'),
      AMD_LIBRARY: join(libraryDirectory, 'libamd.a'),
      COLAMD_LIBRARY: join(libraryDirectory, 'libcolamd.a'),
      BTF_LIBRARY: join(libraryDirectory, 'libbtf.a'),
      SUITESPARSECONFIG_LIBRARY: join(libraryDirectory, 'libsuitesparseconfig.a'),
    }),
  });
}

async function runInstalledCmakeProbe({ sundialsInstall, suiteInstall, buildDirectory }) {
  const sundialsDir = sundialsCmakePackageDirectory(sundialsInstall);
  const kluDir = suiteSparseCmakePackageDirectory(suiteInstall, 'KLU');
  const configured = runCommand('cmake', [
    '-S', SUNDIALS_IDA_KLU_PROBE_DIRECTORY,
    '-B', buildDirectory,
    '-G', 'Unix Makefiles',
    '-DCMAKE_BUILD_TYPE:STRING=Release',
    '-DCMAKE_FIND_USE_PACKAGE_REGISTRY:BOOL=OFF',
    '-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY:BOOL=OFF',
    `-DCMAKE_PREFIX_PATH:PATH=${sundialsInstall};${suiteInstall}`,
    `-DSUNDIALS_DIR:PATH=${sundialsDir}`,
    `-DKLU_DIR:PATH=${kluDir}`,
  ]);
  const configureOutput = `${configured.stdout}\n${configured.stderr}`;
  assertNoUnusedCmakeVariables(configureOutput, 'installed KLU probe configuration');
  const cache = parseCmakeCache(readFileSync(join(buildDirectory, 'CMakeCache.txt'), 'utf8'));
  rejectUntypedCache(cache);
  requirePrivateCachePath(cache, ['SUNDIALS_DIR'], sundialsInstall, 'installed KLU probe');
  requirePrivateCachePath(
    cache,
    ['KLU_DIR', 'AMD_DIR', 'BTF_DIR', 'COLAMD_DIR', 'SuiteSparse_config_DIR'],
    suiteInstall,
    'installed KLU probe',
  );
  runCommand('cmake', [
    '--build', buildDirectory,
    '--target', SUNDIALS_IDA_KLU_PROBE_TARGET,
    '--config', 'Release',
    '--parallel', '2',
  ]);
  runCommand('ctest', [
    '--test-dir', buildDirectory,
    '--build-config', 'Release',
    '--output-on-failure',
  ]);
  const executable = join(buildDirectory, SUNDIALS_IDA_KLU_PROBE_TARGET);
  const dynamic = runCommand('ldd', [executable]);
  auditKluDynamicDependencies(`${dynamic.stdout}\n${dynamic.stderr}`);
  const symbols = runCommand('nm', ['-g', executable]);
  auditKluLinkSymbols(`${symbols.stdout}\n${symbols.stderr}`);
}

export async function buildAndProbeSundialsIdaKlu({
  sundialsArchive,
  suiteSparseArchive,
  output,
}) {
  if (typeof sundialsArchive !== 'string'
      || typeof suiteSparseArchive !== 'string'
      || typeof output !== 'string') {
    fail('klu.cli.paths_required', 'both source archives and output must be explicit paths');
  }
  sundialsArchive = resolve(sundialsArchive);
  suiteSparseArchive = resolve(suiteSparseArchive);
  output = resolve(output);
  if (output === resolve(sep)) fail('klu.cli.output_unsafe', 'output must not be filesystem root');
  if (SUNDIALS_SOURCE_LOCK.version !== '7.8.0'
      || SUITESPARSE_SOURCE_LOCK.version !== '7.7.0') {
    fail('klu.lock.version_unsupported', 'this build boundary requires SUNDIALS 7.8.0 and SuiteSparse 7.7.0');
  }

  canonicalLockBytes(SUNDIALS_SOURCE_LOCK_PATH, 'SUNDIALS');
  canonicalLockBytes(SUITESPARSE_SOURCE_LOCK_PATH, 'SuiteSparse');
  await Promise.all([
    verifySundialsArchive(sundialsArchive, SUNDIALS_SOURCE_LOCK),
    verifySuiteSparseArchive(suiteSparseArchive, SUITESPARSE_SOURCE_LOCK),
  ]);

  const existing = await pathMetadata(output);
  if (existing) {
    try {
      await verifyPublishedKluInstall(output);
      await runCuratedSparseProbe(output);
    } catch (error) {
      fail(
        'klu.output.exists_unverified',
        `refusing to overwrite or trust existing output ${output}: ${error.message}`,
      );
    }
    const sundialsInventory = inspectArchive(
      sundialsArchive,
      validateSundialsArchiveEntries,
      SUNDIALS_SOURCE_LOCK,
      false,
    );
    const suiteSparseInventory = inspectArchive(
      suiteSparseArchive,
      validateSuiteSparseArchiveEntries,
      SUITESPARSE_SOURCE_LOCK,
      true,
    );
    return Object.freeze({
      sundialsVersion: SUNDIALS_SOURCE_LOCK.version,
      suiteSparseVersion: SUITESPARSE_SOURCE_LOCK.version,
      sundialsEntries: sundialsInventory.entries,
      suiteSparseEntries: suiteSparseInventory.entries,
      selectedSuiteSparseEntries: suiteSparseInventory.selectedEntries,
      output,
      probe: SUNDIALS_IDA_KLU_PROBE_TARGET,
      reused: true,
    });
  }

  const workspace = await mkdtemp(join(tmpdir(), 'battery-design-sundials-klu-'));
  await chmod(workspace, 0o700);
  const stagedSundialsArchive = join(workspace, SUNDIALS_SOURCE_LOCK.sourceArchive.fileName);
  const stagedSuiteSparseArchive = join(workspace, SUITESPARSE_SOURCE_LOCK.sourceArchive.fileName);
  const sundialsExtract = join(workspace, 'sundials-source');
  const suiteSparseExtract = join(workspace, 'suitesparse-source');
  const suiteSparseBuild = join(workspace, 'suitesparse-build');
  const suiteSparseInstall = join(workspace, 'suitesparse-install');
  const sundialsBuild = join(workspace, 'sundials-build');
  const sundialsInstall = join(workspace, 'sundials-install');
  const probeBuild = join(workspace, 'installed-probe-build');
  try {
    copyFileSync(sundialsArchive, stagedSundialsArchive, fsConstants.COPYFILE_EXCL);
    copyFileSync(suiteSparseArchive, stagedSuiteSparseArchive, fsConstants.COPYFILE_EXCL);
    await Promise.all([
      chmod(stagedSundialsArchive, 0o400),
      chmod(stagedSuiteSparseArchive, 0o400),
    ]);
    await Promise.all([
      verifySundialsArchive(stagedSundialsArchive, SUNDIALS_SOURCE_LOCK),
      verifySuiteSparseArchive(stagedSuiteSparseArchive, SUITESPARSE_SOURCE_LOCK),
    ]);
    const sundialsInventory = inspectArchive(
      stagedSundialsArchive,
      validateSundialsArchiveEntries,
      SUNDIALS_SOURCE_LOCK,
      false,
    );
    const suiteSparseInventory = inspectArchive(
      stagedSuiteSparseArchive,
      validateSuiteSparseArchiveEntries,
      SUITESPARSE_SOURCE_LOCK,
      true,
    );

    await mkdir(suiteSparseExtract, { mode: 0o700 });
    runCommand('tar', suiteSparseExtractionArguments(
      stagedSuiteSparseArchive,
      suiteSparseExtract,
      SUITESPARSE_SOURCE_LOCK.sourceArchive.archiveRoot,
    ));
    const suiteSparseSource = join(
      suiteSparseExtract,
      SUITESPARSE_SOURCE_LOCK.sourceArchive.archiveRoot,
    );
    await assertPrivateExtractedRoot(suiteSparseExtract, suiteSparseSource, 'SuiteSparse');
    await verifySuiteSparseLicenseFiles(suiteSparseSource, SUITESPARSE_SOURCE_LOCK);

    const suiteDefinitions = {
      ...SUITESPARSE_CMAKE_DEFINITIONS,
      CMAKE_INSTALL_PREFIX: suiteSparseInstall,
    };
    const suiteInitialCache = join(workspace, 'suitesparse-no-blas-initial-cache.cmake');
    await writeFile(suiteInitialCache, SUITESPARSE_NO_BLAS_INITIAL_CACHE, {
      encoding: 'utf8', flag: 'wx', mode: 0o400,
    });
    const suiteConfigured = runCommand('cmake', [
      '-C', suiteInitialCache,
      '-S', suiteSparseSource,
      '-B', suiteSparseBuild,
      '-G', 'Unix Makefiles',
      ...definitionsToArguments(suiteDefinitions),
    ]);
    const suiteCache = auditSuiteSparseCmakeCache(
      readFileSync(join(suiteSparseBuild, 'CMakeCache.txt'), 'utf8'),
      `${suiteConfigured.stdout}\n${suiteConfigured.stderr}`,
      {
        sourceDirectory: suiteSparseSource,
        buildDirectory: suiteSparseBuild,
        installDirectory: suiteSparseInstall,
      },
    );
    runCommand('cmake', [
      '--build', suiteSparseBuild,
      '--target', 'install',
      '--config', 'Release',
      '--parallel', '2',
    ]);
    const kluPaths = explicitKluPaths(suiteSparseInstall);

    await mkdir(sundialsExtract, { mode: 0o700 });
    runCommand('tar', [
      '--extract', '--gzip', '--file', stagedSundialsArchive,
      '--directory', sundialsExtract,
      '--no-same-owner', '--no-same-permissions', '--delay-directory-restore',
    ]);
    const sundialsSource = join(sundialsExtract, SUNDIALS_SOURCE_LOCK.sourceArchive.archiveRoot);
    await assertPrivateExtractedRoot(sundialsExtract, sundialsSource, 'SUNDIALS');
    await verifySundialsLicenseFiles(sundialsSource, SUNDIALS_SOURCE_LOCK);

    const sundialsDefinitions = {
      ...SUNDIALS_KLU_CMAKE_DEFINITIONS,
      CMAKE_INSTALL_PREFIX: sundialsInstall,
      CMAKE_INSTALL_LIBDIR: 'lib',
      CMAKE_FIND_USE_PACKAGE_REGISTRY: 'OFF',
      CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY: 'OFF',
      KLU_ROOT: suiteSparseInstall,
      KLU_INCLUDE_DIR: kluPaths.include,
      KLU_LIBRARY_DIR: kluPaths.libraryDirectory,
      ...kluPaths.libraries,
    };
    const sundialsConfigured = runCommand('cmake', [
      '-S', sundialsSource,
      '-B', sundialsBuild,
      '-G', 'Unix Makefiles',
      ...definitionsToArguments(sundialsDefinitions),
    ]);
    const sundialsCache = auditSundialsKluCmakeCache(
      readFileSync(join(sundialsBuild, 'CMakeCache.txt'), 'utf8'),
      `${sundialsConfigured.stdout}\n${sundialsConfigured.stderr}`,
      {
        installDirectory: sundialsInstall,
        suiteSparseDirectory: suiteSparseInstall,
        kluPaths,
      },
    );
    runCommand('cmake', [
      '--build', sundialsBuild,
      '--target', 'install',
      '--config', 'Release',
      '--parallel', '2',
    ]);

    await runInstalledCmakeProbe({
      sundialsInstall,
      suiteInstall: suiteSparseInstall,
      buildDirectory: probeBuild,
    });
    const identities = toolchainIdentities(suiteCache, sundialsCache);
    await publishCuratedKluInstall({
      output,
      sundialsSource,
      suiteSparseSource,
      sundialsInstall,
      suiteSparseInstall,
      toolchain: identities.receipt,
      compilerPath: identities.paths.compiler,
    });

    return Object.freeze({
      sundialsVersion: SUNDIALS_SOURCE_LOCK.version,
      suiteSparseVersion: SUITESPARSE_SOURCE_LOCK.version,
      sundialsEntries: sundialsInventory.entries,
      suiteSparseEntries: suiteSparseInventory.entries,
      selectedSuiteSparseEntries: suiteSparseInventory.selectedEntries,
      output,
      probe: SUNDIALS_IDA_KLU_PROBE_TARGET,
      reused: false,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof SundialsKluNativeBuildError ? error.code : 'unexpected';
    console.error(`SUNDIALS IDA+KLU native build: ${error.message} [${code}]`);
    process.exitCode = 2;
    return;
  }
  const result = await buildAndProbeSundialsIdaKlu(options);
  if (result.reused) {
    console.log(`reusing verified SUNDIALS/IDA+KLU install: ${result.output}`);
  } else {
    console.log(
      `SUNDIALS ${result.sundialsVersion} IDA + SuiteSparse ${result.suiteSparseVersion} KLU static sparse factor/solve probe passed (${result.suiteSparseEntries} archive entries, ${result.selectedSuiteSparseEntries} selected); curated CI-only install: ${result.output}`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof SundialsKluNativeBuildError ? error.code : (error.code ?? 'unexpected');
    console.error(`SUNDIALS IDA+KLU native build failed [${code}]: ${error.message}`);
    process.exitCode = 1;
  });
}
