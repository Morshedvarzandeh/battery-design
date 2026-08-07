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
  SUNDIALS_SOURCE_LOCK,
  SUNDIALS_SOURCE_LOCK_PATH,
  verifySundialsArchive,
  verifySundialsLicenseFiles,
} from './verify-sundials-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SUNDIALS_IDA_PROBE_DIRECTORY = resolve(ROOT, 'tools/sundials-ida-probe');
export const SUNDIALS_IDA_PROBE_TARGET = 'sundials_ida_lifecycle_probe';
export const SUNDIALS_PUBLISHED_SOURCE_LOCK = 'battery-design-sundials-source-lock.json';
export const SUNDIALS_BUILD_RECEIPT = 'battery-design-sundials-build.json';

const PUBLISHED_ARCHIVES = Object.freeze([
  'libsundials_core.a',
  'libsundials_ida.a',
]);
const PUBLISHED_HEADERS = Object.freeze([
  'include/sundials/sundials_config.h',
  'include/ida/ida.h',
  'include/ida/ida_ls.h',
  'include/nvector/nvector_serial.h',
  'include/sunmatrix/sunmatrix_dense.h',
  'include/sunlinsol/sunlinsol_dense.h',
]);
const PUBLISHED_LICENSES = Object.freeze([
  'share/licenses/sundials/LICENSE',
  'share/licenses/sundials/NOTICE',
]);

export const ARCHIVE_LIMITS = Object.freeze({
  entries: 20_000,
  pathBytes: 4_096,
  regularFileBytes: 64 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
});

const OFF_OPTIONS = [
  // Parallel, accelerator, and threading backends.
  'SUNDIALS_ENABLE_MPI',
  'SUNDIALS_ENABLE_OPENMP',
  'SUNDIALS_ENABLE_OPENMP_DEVICE',
  'SUNDIALS_ENABLE_PTHREAD',
  'SUNDIALS_ENABLE_CUDA',
  'SUNDIALS_ENABLE_HIP',
  'SUNDIALS_ENABLE_SYCL',

  // Third-party libraries.
  'SUNDIALS_ENABLE_LAPACK',
  'SUNDIALS_ENABLE_GINKGO',
  'SUNDIALS_ENABLE_MAGMA',
  'SUNDIALS_ENABLE_SUPERLUDIST',
  'SUNDIALS_ENABLE_SUPERLUMT',
  'SUNDIALS_ENABLE_KLU',
  'SUNDIALS_ENABLE_HYPRE',
  'SUNDIALS_ENABLE_PETSC',
  'SUNDIALS_ENABLE_RAJA',
  'SUNDIALS_ENABLE_TRILINOS',
  'SUNDIALS_ENABLE_XBRAID',
  'SUNDIALS_ENABLE_ONEMKL',
  'SUNDIALS_ENABLE_CALIPER',
  'SUNDIALS_ENABLE_ADIAK',
  'SUNDIALS_ENABLE_KOKKOS',
  'SUNDIALS_ENABLE_KOKKOS_KERNELS',

  // Bindings, examples, benchmarks, and optional instrumentation.
  'SUNDIALS_ENABLE_FORTRAN',
  'SUNDIALS_ENABLE_PYTHON',
  'SUNDIALS_ENABLE_C_EXAMPLES',
  'SUNDIALS_ENABLE_CXX_EXAMPLES',
  'SUNDIALS_ENABLE_FORTRAN_EXAMPLES',
  'SUNDIALS_ENABLE_CUDA_EXAMPLES',
  'SUNDIALS_ENABLE_EXAMPLES_INSTALL',
  'SUNDIALS_ENABLE_BENCHMARKS',
  'SUNDIALS_ENABLE_EXTERNAL_ADDONS',
  'SUNDIALS_ENABLE_PROFILING',
  'SUNDIALS_ENABLE_MONITORING',

  // The only optional, dependency-free native vector module in this release.
  'SUNDIALS_ENABLE_NVECTOR_MANYVECTOR',
];

export const SUNDIALS_CMAKE_DEFINITIONS = Object.freeze({
  CMAKE_BUILD_TYPE: 'Release',
  BUILD_STATIC_LIBS: 'ON',
  BUILD_SHARED_LIBS: 'OFF',
  SUNDIALS_PRECISION: 'DOUBLE',
  SUNDIALS_INDEX_SIZE: '64',
  SUNDIALS_ENABLE_IDA: 'ON',
  SUNDIALS_ENABLE_ERROR_CHECKS: 'ON',
  USE_XSDK_DEFAULTS: 'OFF',
  ...Object.fromEntries(OFF_OPTIONS.map((name) => [name, 'OFF'])),
});

const REQUIRED_ARCHIVE_FILES = Object.freeze([
  'CMakeLists.txt',
  'LICENSE',
  'NOTICE',
  'src/ida/CMakeLists.txt',
  'src/ida/ida.c',
]);
const SOLVER_DIRECTORIES = Object.freeze([
  'arkode', 'cvode', 'cvodes', 'ida', 'idas', 'kinsol',
]);
const DEPENDENCY_PRUNED_CACHE_OPTIONS = new Set([
  'SUNDIALS_ENABLE_ADIAK',
  'SUNDIALS_ENABLE_CALIPER',
  'SUNDIALS_ENABLE_CUDA_EXAMPLES',
  'SUNDIALS_ENABLE_FORTRAN_EXAMPLES',
]);
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;

export class SundialsNativeBuildError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SundialsNativeBuildError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new SundialsNativeBuildError(code, message, details);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function canonicalSourceLockBytes() {
  const raw = readFileSync(SUNDIALS_SOURCE_LOCK_PATH, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail('sundials.source_lock.noncanonical', `SUNDIALS source lock is not valid JSON: ${error.message}`);
  }
  if (raw !== `${JSON.stringify(value, null, 2)}\n`) {
    fail(
      'sundials.source_lock.noncanonical',
      'SUNDIALS source lock must be exact canonical JSON without duplicate keys or trailing data',
    );
  }
  return Buffer.from(raw, 'utf8');
}

function exactKeys(value, expected, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('sundials.output.receipt_shape', `${location} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(
      'sundials.output.receipt_shape',
      `${location} keys must be exactly ${wanted.join(', ')}; received ${actual.join(', ')}`,
    );
  }
}

function safeToolchainIdentity(value) {
  return typeof value === 'string' && value.length > 0 && !/["\\\0-\x1f]/u.test(value);
}

function expectedBuildReceipt({ idaArchive, coreArchive, cmake, cCompiler }) {
  return {
    format: 'battery-design/sundials-build-receipt@1',
    sourceLockFormat: SUNDIALS_SOURCE_LOCK.format,
    sourceLockSha256: sha256File(SUNDIALS_SOURCE_LOCK_PATH),
    solver: SUNDIALS_SOURCE_LOCK.project,
    version: SUNDIALS_SOURCE_LOCK.version,
    backend: 'IDA',
    releaseTag: SUNDIALS_SOURCE_LOCK.releaseTag,
    tagObjectSha: SUNDIALS_SOURCE_LOCK.tagObjectSha,
    commitSha: SUNDIALS_SOURCE_LOCK.commitSha,
    sourceSizeBytes: SUNDIALS_SOURCE_LOCK.sourceArchive.sizeBytes,
    sourceSha256: SUNDIALS_SOURCE_LOCK.sourceArchive.sha256,
    build: {
      linkage: 'static',
      precision: 'double',
      indexBits: 64,
      mpi: false,
      klu: false,
      errorChecks: true,
    },
    artifacts: {
      idaArchiveSha256: sha256File(idaArchive),
      coreArchiveSha256: sha256File(coreArchive),
    },
    toolchain: { cmake, cCompiler },
  };
}

async function requireRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail('sundials.output.file_missing', `${label} is missing: ${error.message}`, { path });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('sundials.output.file_unsafe', `${label} must be a regular file`, { path });
  }
  return metadata;
}

function requireConfigContract(config, path) {
  const required = [
    '#define SUNDIALS_VERSION "7.8.0"',
    '#define SUNDIALS_VERSION_MAJOR 7',
    '#define SUNDIALS_VERSION_MINOR 8',
    '#define SUNDIALS_VERSION_PATCH 0',
    '#define SUNDIALS_DOUBLE_PRECISION 1',
    '#define SUNDIALS_INT64_T 1',
    '#define SUNDIALS_MPI_ENABLED 0',
    '#define SUNDIALS_ENABLE_ERROR_CHECKS',
  ];
  for (const line of required) {
    if (!config.split(/\r?\n/u).some((candidate) => candidate.trim() === line)) {
      fail('sundials.output.config_drift', `${path} is missing required build contract ${line}`);
    }
  }
  if (config.split(/\r?\n/u).some((line) => line.trim() === '#define SUNDIALS_KLU_ENABLED')) {
    fail('sundials.output.config_drift', `${path} unexpectedly enables KLU`);
  }
}

export async function verifyPublishedSundialsInstall(output) {
  const root = resolve(output);
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    fail('sundials.output.missing', `published install does not exist: ${error.message}`, { root });
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('sundials.output.root_unsafe', 'published install must be a real directory', { root });
  }

  const sourceLockPath = join(root, SUNDIALS_PUBLISHED_SOURCE_LOCK);
  await requireRegularFile(sourceLockPath, 'published SUNDIALS source lock');
  const repositoryLockBytes = canonicalSourceLockBytes();
  const installedLockBytes = readFileSync(sourceLockPath);
  if (!installedLockBytes.equals(repositoryLockBytes)) {
    fail(
      'sundials.output.source_lock_mismatch',
      'published SUNDIALS source lock does not exactly match the repository lock',
    );
  }

  for (const relative of [...PUBLISHED_HEADERS, ...PUBLISHED_LICENSES]) {
    await requireRegularFile(join(root, relative), `published file ${relative}`);
  }
  const licenseMetadata = await lstat(join(root, PUBLISHED_LICENSES[0]));
  const noticeMetadata = await lstat(join(root, PUBLISHED_LICENSES[1]));
  if (
    licenseMetadata.size !== SUNDIALS_SOURCE_LOCK.license.licenseFile.sizeBytes
    || sha256File(join(root, PUBLISHED_LICENSES[0]))
      !== SUNDIALS_SOURCE_LOCK.license.licenseFile.sha256
    || noticeMetadata.size !== SUNDIALS_SOURCE_LOCK.license.noticeFile.sizeBytes
    || sha256File(join(root, PUBLISHED_LICENSES[1]))
      !== SUNDIALS_SOURCE_LOCK.license.noticeFile.sha256
  ) {
    fail('sundials.output.license_mismatch', 'published SUNDIALS license or NOTICE identity drifted');
  }

  const libraryDirectory = join(root, 'lib');
  let archiveNames;
  try {
    const archiveEntries = (await readdir(libraryDirectory, { withFileTypes: true }))
      .filter((entry) => entry.name.endsWith('.a'));
    if (archiveEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      fail('sundials.output.archive_unsafe', 'published static archives must be regular files');
    }
    archiveNames = archiveEntries
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    fail('sundials.output.library_unreadable', `cannot inspect published libraries: ${error.message}`);
  }
  if (JSON.stringify(archiveNames) !== JSON.stringify(PUBLISHED_ARCHIVES)) {
    fail(
      'sundials.output.archive_surface',
      `published lib must contain exactly ${PUBLISHED_ARCHIVES.join(' and ')}; received ${archiveNames.join(', ')}`,
    );
  }
  const coreArchive = join(libraryDirectory, 'libsundials_core.a');
  const idaArchive = join(libraryDirectory, 'libsundials_ida.a');
  await requireRegularFile(coreArchive, 'published SUNDIALS core archive');
  await requireRegularFile(idaArchive, 'published SUNDIALS IDA archive');

  const configPath = join(root, 'include/sundials/sundials_config.h');
  requireConfigContract(readFileSync(configPath, 'utf8'), configPath);

  const receiptPath = join(root, SUNDIALS_BUILD_RECEIPT);
  await requireRegularFile(receiptPath, 'published SUNDIALS build receipt');
  const receiptRaw = readFileSync(receiptPath, 'utf8');
  let receipt;
  try {
    receipt = JSON.parse(receiptRaw);
  } catch (error) {
    fail('sundials.output.receipt_invalid', `published build receipt is invalid JSON: ${error.message}`);
  }
  exactKeys(receipt, [
    'format', 'sourceLockFormat', 'sourceLockSha256', 'solver', 'version', 'backend',
    'releaseTag', 'tagObjectSha', 'commitSha', 'sourceSizeBytes', 'sourceSha256',
    'build', 'artifacts', 'toolchain',
  ], '$');
  exactKeys(receipt.build, [
    'linkage', 'precision', 'indexBits', 'mpi', 'klu', 'errorChecks',
  ], '$.build');
  exactKeys(receipt.artifacts, ['idaArchiveSha256', 'coreArchiveSha256'], '$.artifacts');
  exactKeys(receipt.toolchain, ['cmake', 'cCompiler'], '$.toolchain');
  if (!safeToolchainIdentity(receipt.toolchain.cmake)
      || !safeToolchainIdentity(receipt.toolchain.cCompiler)) {
    fail('sundials.output.receipt_toolchain', 'build receipt toolchain identities are unsafe');
  }
  const expected = expectedBuildReceipt({
    idaArchive,
    coreArchive,
    cmake: receipt.toolchain.cmake,
    cCompiler: receipt.toolchain.cCompiler,
  });
  const canonical = `${JSON.stringify(receipt, null, 2)}\n`;
  if (receiptRaw !== canonical || JSON.stringify(receipt) !== JSON.stringify(expected)) {
    fail(
      'sundials.output.receipt_mismatch',
      'published build receipt is not the exact closed canonical receipt for this install',
    );
  }
  return Object.freeze({
    root,
    sourceLockSha256: expected.sourceLockSha256,
    idaArchiveSha256: expected.artifacts.idaArchiveSha256,
    coreArchiveSha256: expected.artifacts.coreArchiveSha256,
  });
}

function normalizedArchivePath(rawPath, archiveRoot) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    fail('sundials.archive.path_empty', 'archive entry path must not be empty');
  }
  if (Buffer.byteLength(rawPath) > ARCHIVE_LIMITS.pathBytes) {
    fail('sundials.archive.path_too_long', `archive entry path exceeds ${ARCHIVE_LIMITS.pathBytes} bytes`);
  }
  if (/[\\\0-\x20\x7f]/u.test(rawPath)) {
    fail('sundials.archive.path_unsafe', `archive entry path contains a control, space, or backslash: ${JSON.stringify(rawPath)}`);
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:/u.test(rawPath)) {
    fail('sundials.archive.path_absolute', `archive entry path is absolute: ${rawPath}`);
  }

  const withoutTrailingSlash = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('sundials.archive.path_traversal', `archive entry path is not canonical: ${rawPath}`);
  }
  if (segments[0] !== archiveRoot) {
    fail('sundials.archive.root_mismatch', `archive entry is outside ${archiveRoot}: ${rawPath}`);
  }
  return withoutTrailingSlash;
}

/**
 * Validate the complete entry inventory produced by GNU tar before extraction.
 * Each entry must have the shape { path, type, sizeBytes }, where type is the
 * first character from tar's verbose mode ("-" or "d").
 */
export function validateArchiveEntries(entries, lock = SUNDIALS_SOURCE_LOCK) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('sundials.archive.empty', 'archive has no entries');
  }
  if (entries.length > ARCHIVE_LIMITS.entries) {
    fail('sundials.archive.too_many_entries', `archive has more than ${ARCHIVE_LIMITS.entries} entries`);
  }

  const root = lock.sourceArchive.archiveRoot;
  const seen = new Set();
  let expandedBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      fail('sundials.archive.entry_invalid', 'archive entry metadata must be an object');
    }
    const path = normalizedArchivePath(entry.path, root);
    if (seen.has(path)) {
      fail('sundials.archive.path_duplicate', `archive entry path is duplicated: ${path}`);
    }
    seen.add(path);
    if (entry.type !== '-' && entry.type !== 'd') {
      fail('sundials.archive.type_unsafe', `archive entry is not a regular file or directory: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      fail('sundials.archive.size_invalid', `archive entry has an invalid size: ${entry.path}`);
    }
    if (entry.type === 'd' && entry.sizeBytes !== 0) {
      fail('sundials.archive.directory_size', `archive directory has a non-zero size: ${entry.path}`);
    }
    if (entry.sizeBytes > ARCHIVE_LIMITS.regularFileBytes) {
      fail('sundials.archive.file_too_large', `archive entry exceeds the per-file limit: ${entry.path}`);
    }
    expandedBytes += entry.sizeBytes;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > ARCHIVE_LIMITS.expandedBytes) {
      fail('sundials.archive.expanded_too_large', `archive exceeds the ${ARCHIVE_LIMITS.expandedBytes}-byte expansion limit`);
    }
  }

  for (const required of REQUIRED_ARCHIVE_FILES) {
    if (!seen.has(`${root}/${required}`)) {
      fail('sundials.archive.required_file_missing', `archive is missing ${root}/${required}`);
    }
  }
  const includedSolvers = SOLVER_DIRECTORIES.filter((solver) => (
    [...seen].some((path) => path === `${root}/src/${solver}` || path.startsWith(`${root}/src/${solver}/`))
  ));
  if (includedSolvers.length !== 1 || includedSolvers[0] !== 'ida') {
    fail('sundials.archive.solver_scope', `expected only the IDA solver sources; found: ${includedSolvers.join(', ') || 'none'}`);
  }

  return Object.freeze({ entries: entries.length, expandedBytes, archiveRoot: root });
}

function parseTarInventory(namesOutput, verboseOutput) {
  const names = namesOutput.split('\n').filter(Boolean);
  const verboseLines = verboseOutput.split('\n').filter(Boolean);
  if (names.length !== verboseLines.length) {
    fail('sundials.archive.inventory_mismatch', 'tar name and metadata inventories differ in length');
  }
  return names.map((path, index) => {
    const fields = verboseLines[index].trim().split(/\s+/u);
    if (fields.length < 6 || fields[5] !== path) {
      fail('sundials.archive.inventory_unparseable', `cannot safely parse tar metadata for ${JSON.stringify(path)}`);
    }
    const type = fields[0][0];
    const sizeBytes = Number(fields[2]);
    return { path, type, sizeBytes };
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
    fail('sundials.command.spawn_failed', `${command} could not run: ${result.error.message}`, {
      command, arguments: arguments_, cause: result.error.code,
    });
  }
  if (result.status !== 0) {
    fail('sundials.command.failed', `${command} exited with status ${result.status}`, {
      command, arguments: arguments_, status: result.status,
    });
  }
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
}

function inspectArchive(archivePath, lock = SUNDIALS_SOURCE_LOCK) {
  const common = [
    '--list', '--gzip', '--file', archivePath, '--numeric-owner', '--quoting-style=escape',
  ];
  const names = runCommand('tar', common, { echo: false });
  const verbose = runCommand('tar', [...common, '--verbose', '--full-time'], { echo: false });
  const entries = parseTarInventory(names.stdout, verbose.stdout);
  return validateArchiveEntries(entries, lock);
}

export function parseCmakeCache(text) {
  const cache = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const match = /^([^:=]+):([^=]+)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, name, type, value] = match;
    if (cache.has(name)) {
      fail('sundials.cmake.cache_duplicate', `CMake cache contains duplicate entry ${name}`);
    }
    cache.set(name, Object.freeze({ type, value }));
  }
  return cache;
}

function assertCacheValue(cache, name, type, value, allowAbsent = false) {
  const actual = cache.get(name);
  if (!actual && allowAbsent) return;
  if (!actual || actual.type !== type || actual.value !== value) {
    fail('sundials.cmake.cache_drift', `CMake cache drift for ${name}: expected ${type}=${value}, received ${actual ? `${actual.type}=${actual.value}` : 'no entry'}`);
  }
}

export function auditSundialsCmakeCache(cacheText, configureOutput, installPrefix) {
  if (/Manually-specified variables were not used by the project/iu.test(configureOutput)) {
    fail('sundials.cmake.unused_variables', 'CMake reported unused manually specified variables');
  }
  const cache = parseCmakeCache(cacheText);
  for (const [name, entry] of cache) {
    if (entry.type === 'UNINITIALIZED') {
      fail('sundials.cmake.unused_variable', `CMake left ${name} untyped and unused`);
    }
  }

  assertCacheValue(cache, 'CMAKE_BUILD_TYPE', 'STRING', 'Release');
  assertCacheValue(cache, 'CMAKE_INSTALL_PREFIX', 'PATH', resolve(installPrefix));
  assertCacheValue(cache, 'BUILD_STATIC_LIBS', 'BOOL', 'ON');
  assertCacheValue(cache, 'BUILD_SHARED_LIBS', 'BOOL', 'OFF');
  assertCacheValue(cache, 'SUNDIALS_PRECISION', 'STRING', 'DOUBLE');
  assertCacheValue(cache, 'SUNDIALS_INDEX_SIZE', 'STRING', '64');
  assertCacheValue(cache, 'SUNDIALS_ENABLE_IDA', 'BOOL', 'ON');
  assertCacheValue(cache, 'SUNDIALS_ENABLE_ERROR_CHECKS', 'BOOL', 'ON');
  assertCacheValue(cache, 'USE_XSDK_DEFAULTS', 'BOOL', 'OFF');
  for (const name of OFF_OPTIONS) {
    assertCacheValue(cache, name, 'BOOL', 'OFF', DEPENDENCY_PRUNED_CACHE_OPTIONS.has(name));
  }

  for (const [name, entry] of cache) {
    const unexpectedEnable = name.startsWith('SUNDIALS_ENABLE_')
      && entry.value === 'ON'
      && name !== 'SUNDIALS_ENABLE_IDA'
      && name !== 'SUNDIALS_ENABLE_ERROR_CHECKS'
      && !name.endsWith('_CHECKS');
    if (unexpectedEnable) {
      fail('sundials.cmake.unexpected_enable', `unexpected enabled SUNDIALS feature in CMake cache: ${name}`);
    }
  }
  return cache;
}

export function auditProbeDynamicDependencies(lddOutput) {
  if (typeof lddOutput !== 'string') {
    fail('sundials.probe.dynamic_dependencies_invalid', 'ldd output must be text');
  }
  const sundialsDependency = lddOutput.split(/\r?\n/u).find((line) => (
    /(?:^|[/\s])libsundials(?:[_\-.]|$)/iu.test(line)
  ));
  if (sundialsDependency) {
    fail(
      'sundials.probe.dynamic_sundials',
      `probe has a dynamic SUNDIALS dependency: ${sundialsDependency.trim()}`,
    );
  }
  return Object.freeze({ sundialsDynamicDependencies: 0 });
}

function assertNoUnusedCmakeVariables(output, phase) {
  if (/Manually-specified variables were not used by the project/iu.test(output)) {
    fail('sundials.cmake.unused_variables', `${phase} reported unused manually specified variables`);
  }
}

async function assertPrivateExtractedRoot(extractDirectory, sourceDirectory) {
  const extractReal = await realpath(extractDirectory);
  const sourceMetadata = await lstat(sourceDirectory);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    fail('sundials.archive.root_unsafe', 'extracted archive root is not a real directory');
  }
  const sourceReal = await realpath(sourceDirectory);
  if (!sourceReal.startsWith(`${extractReal}${sep}`)) {
    fail('sundials.archive.root_escape', 'extracted archive root escaped the private extraction directory');
  }
}

function definitionsToArguments(definitions) {
  return Object.entries(definitions).map(([name, value]) => `-D${name}=${value}`);
}

async function pathMetadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('sundials.output.unreadable', `cannot inspect output path ${path}: ${error.message}`);
  }
}

function firstOutputLine(result, label) {
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean);
  if (!safeToolchainIdentity(line)) {
    fail('sundials.toolchain.identity_invalid', `${label} returned an unsafe identity`);
  }
  return line;
}

function installedLibraryDirectory(installDirectory) {
  for (const relative of ['lib', 'lib64']) {
    const candidate = join(installDirectory, relative);
    try {
      readFileSync(join(candidate, 'libsundials_ida.a'), { flag: 'r' });
      readFileSync(join(candidate, 'libsundials_core.a'), { flag: 'r' });
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        fail('sundials.output.archive_unreadable', `cannot inspect ${candidate}: ${error.message}`);
      }
    }
  }
  fail(
    'sundials.output.archive_missing',
    'audited CMake install is missing libsundials_ida.a or libsundials_core.a',
  );
}

async function publishCuratedInstall({
  output,
  sourceDirectory,
  installDirectory,
  cmakeIdentity,
  compilerIdentity,
}) {
  const outputParent = dirname(output);
  const outputName = basename(output);
  await mkdir(outputParent, { recursive: true });
  const publishWorkspace = await mkdtemp(join(outputParent, `.${outputName}.publish-`));
  await chmod(publishWorkspace, 0o700);
  const stagedInstall = join(publishWorkspace, 'root');
  try {
    await mkdir(join(stagedInstall, 'lib'), { recursive: true });
    await mkdir(join(stagedInstall, 'share/licenses/sundials'), { recursive: true });
    await cp(join(installDirectory, 'include'), join(stagedInstall, 'include'), {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });

    const sourceLibraryDirectory = installedLibraryDirectory(installDirectory);
    const idaArchive = join(stagedInstall, 'lib/libsundials_ida.a');
    const coreArchive = join(stagedInstall, 'lib/libsundials_core.a');
    copyFileSync(
      join(sourceLibraryDirectory, 'libsundials_ida.a'),
      idaArchive,
      fsConstants.COPYFILE_EXCL,
    );
    copyFileSync(
      join(sourceLibraryDirectory, 'libsundials_core.a'),
      coreArchive,
      fsConstants.COPYFILE_EXCL,
    );
    copyFileSync(
      join(sourceDirectory, 'LICENSE'),
      join(stagedInstall, PUBLISHED_LICENSES[0]),
      fsConstants.COPYFILE_EXCL,
    );
    copyFileSync(
      join(sourceDirectory, 'NOTICE'),
      join(stagedInstall, PUBLISHED_LICENSES[1]),
      fsConstants.COPYFILE_EXCL,
    );
    copyFileSync(
      SUNDIALS_SOURCE_LOCK_PATH,
      join(stagedInstall, SUNDIALS_PUBLISHED_SOURCE_LOCK),
      fsConstants.COPYFILE_EXCL,
    );

    const receipt = expectedBuildReceipt({
      idaArchive,
      coreArchive,
      cmake: cmakeIdentity,
      cCompiler: compilerIdentity,
    });
    await writeFile(
      join(stagedInstall, SUNDIALS_BUILD_RECEIPT),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o644 },
    );
    await verifyPublishedSundialsInstall(stagedInstall);

    runCommand('mv', [
      '--no-target-directory', '--no-clobber', stagedInstall, output,
    ], { echo: false });
    if (await pathMetadata(stagedInstall)) {
      fail(
        'sundials.output.publish_collision',
        `output appeared during atomic publication; refusing to overwrite ${output}`,
      );
    }
    await verifyPublishedSundialsInstall(output);
    return output;
  } finally {
    await rm(publishWorkspace, { recursive: true, force: true });
  }
}

function parseCli(arguments_) {
  const options = { archive: null, output: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== '--archive' && argument !== '--output') {
      fail('sundials.cli.unknown_option', `unknown option: ${argument}`);
    }
    const key = argument === '--archive' ? 'archive' : 'output';
    if (options[key] !== null) {
      fail(`sundials.cli.duplicate_${key}`, `${argument} may be supplied only once`);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`sundials.cli.${key}_required`, `${argument} requires a path`);
    }
    options[key] = resolve(value);
    index += 1;
  }
  if (options.archive === null) {
    fail('sundials.cli.archive_required', '--archive is required; download the locked source archive separately');
  }
  if (options.output === null) {
    fail('sundials.cli.output_required', '--output is required for the curated native adapter install');
  }
  if (options.output === resolve(sep)) {
    fail('sundials.cli.output_unsafe', '--output must not name the filesystem root');
  }
  return Object.freeze(options);
}

export async function buildAndProbeSundialsIda({ archive, output }) {
  const lock = SUNDIALS_SOURCE_LOCK;
  if (lock.version !== '7.8.0') {
    fail('sundials.lock.version_unsupported', `this build contract requires SUNDIALS 7.8.0, not ${lock.version}`);
  }
  if (typeof archive !== 'string' || typeof output !== 'string') {
    fail('sundials.cli.paths_required', 'archive and output must be explicit paths');
  }
  archive = resolve(archive);
  output = resolve(output);
  if (output === resolve(sep)) {
    fail('sundials.cli.output_unsafe', 'output must not name the filesystem root');
  }
  canonicalSourceLockBytes();
  await verifySundialsArchive(archive, lock);
  const existingOutput = await pathMetadata(output);
  if (existingOutput) {
    try {
      await verifyPublishedSundialsInstall(output);
    } catch (error) {
      fail(
        'sundials.output.exists_unverified',
        `refusing to overwrite an existing unverified output ${output}: ${error.message}`,
      );
    }
    const inventory = inspectArchive(archive, lock);
    return Object.freeze({
      version: lock.version,
      archiveSha256: lock.sourceArchive.sha256,
      entries: inventory.entries,
      expandedBytes: inventory.expandedBytes,
      probe: SUNDIALS_IDA_PROBE_TARGET,
      output,
      reused: true,
    });
  }

  const workspace = await mkdtemp(join(tmpdir(), 'battery-design-sundials-ida-'));
  await chmod(workspace, 0o700);
  const stagedArchive = join(workspace, basename(lock.sourceArchive.fileName));
  const extractDirectory = join(workspace, 'source');
  const buildDirectory = join(workspace, 'build');
  const installDirectory = join(workspace, 'install');
  const probeBuildDirectory = join(workspace, 'probe-build');
  try {
    copyFileSync(archive, stagedArchive, fsConstants.COPYFILE_EXCL);
    await chmod(stagedArchive, 0o400);
    await verifySundialsArchive(stagedArchive, lock);
    const inventory = inspectArchive(stagedArchive, lock);

    await mkdir(extractDirectory, { mode: 0o700 });
    runCommand('tar', [
      '--extract', '--gzip', '--file', stagedArchive,
      '--directory', extractDirectory,
      '--no-same-owner', '--no-same-permissions', '--delay-directory-restore',
    ]);
    const sourceDirectory = join(extractDirectory, lock.sourceArchive.archiveRoot);
    await assertPrivateExtractedRoot(extractDirectory, sourceDirectory);
    await verifySundialsLicenseFiles(sourceDirectory, lock);

    const definitions = {
      ...SUNDIALS_CMAKE_DEFINITIONS,
      CMAKE_INSTALL_PREFIX: installDirectory,
    };
    const configured = runCommand('cmake', [
      '-S', sourceDirectory,
      '-B', buildDirectory,
      '-G', 'Unix Makefiles',
      ...definitionsToArguments(definitions),
    ]);
    const configureOutput = `${configured.stdout}\n${configured.stderr}`;
    const cachePath = join(buildDirectory, 'CMakeCache.txt');
    const sundialsCache = auditSundialsCmakeCache(
      readFileSync(cachePath, 'utf8'),
      configureOutput,
      installDirectory,
    );

    runCommand('cmake', [
      '--build', buildDirectory,
      '--target', 'install',
      '--config', 'Release',
      '--parallel', '2',
    ]);

    const probeConfigured = runCommand('cmake', [
      '-S', SUNDIALS_IDA_PROBE_DIRECTORY,
      '-B', probeBuildDirectory,
      '-G', 'Unix Makefiles',
      '-DCMAKE_BUILD_TYPE:STRING=Release',
      `-DCMAKE_PREFIX_PATH:PATH=${installDirectory}`,
    ]);
    assertNoUnusedCmakeVariables(`${probeConfigured.stdout}\n${probeConfigured.stderr}`, 'probe configuration');
    const probeCache = parseCmakeCache(readFileSync(join(probeBuildDirectory, 'CMakeCache.txt'), 'utf8'));
    for (const [name, entry] of probeCache) {
      if (entry.type === 'UNINITIALIZED') {
        fail('sundials.cmake.unused_variable', `probe CMake left ${name} untyped and unused`);
      }
    }
    const packageDirectory = probeCache.get('SUNDIALS_DIR');
    if (!packageDirectory || !resolve(packageDirectory.value).startsWith(`${resolve(installDirectory)}${sep}`)) {
      fail('sundials.probe.package_escape', 'probe did not resolve SUNDIALS from the private install prefix');
    }

    runCommand('cmake', [
      '--build', probeBuildDirectory,
      '--target', SUNDIALS_IDA_PROBE_TARGET,
      '--config', 'Release',
      '--parallel', '2',
    ]);
    runCommand('ctest', [
      '--test-dir', probeBuildDirectory,
      '--build-config', 'Release',
      '--output-on-failure',
    ]);
    const probeExecutable = join(probeBuildDirectory, SUNDIALS_IDA_PROBE_TARGET);
    const linkedLibraries = runCommand('ldd', [probeExecutable]);
    auditProbeDynamicDependencies(`${linkedLibraries.stdout}\n${linkedLibraries.stderr}`);

    const compiler = sundialsCache.get('CMAKE_C_COMPILER');
    if (!compiler || !compiler.value) {
      fail('sundials.toolchain.compiler_missing', 'CMake cache did not identify its C compiler');
    }
    const cmakeIdentity = firstOutputLine(
      runCommand('cmake', ['--version'], { echo: false }),
      'cmake --version',
    );
    const compilerIdentity = firstOutputLine(
      runCommand(compiler.value, ['--version'], { echo: false }),
      'C compiler --version',
    );
    await publishCuratedInstall({
      output,
      sourceDirectory,
      installDirectory,
      cmakeIdentity,
      compilerIdentity,
    });

    return Object.freeze({
      version: lock.version,
      archiveSha256: lock.sourceArchive.sha256,
      entries: inventory.entries,
      expandedBytes: inventory.expandedBytes,
      probe: SUNDIALS_IDA_PROBE_TARGET,
      output,
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
    const code = error instanceof SundialsNativeBuildError ? error.code : 'unexpected';
    console.error(`SUNDIALS IDA native build: ${error.message} [${code}]`);
    process.exitCode = 2;
    return;
  }
  const result = await buildAndProbeSundialsIda(options);
  if (result.reused) {
    console.log(`reusing verified SUNDIALS/IDA install: ${result.output}`);
  } else {
    console.log(`SUNDIALS ${result.version} static IDA build and lifecycle probe passed (${result.entries} verified archive entries); curated install: ${result.output}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof SundialsNativeBuildError ? error.code : (error.code ?? 'unexpected');
    console.error(`SUNDIALS IDA native build failed [${code}]: ${error.message}`);
    process.exitCode = 1;
  });
}
