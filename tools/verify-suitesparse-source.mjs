#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUITESPARSE_SOURCE_LOCK_FORMAT = 'battery-design/suitesparse-source-lock@1';
export const SUITESPARSE_SOURCE_LOCK_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../native-backends/suitesparse/source-lock.json',
);

const ROOT_KEYS = Object.freeze([
  'format', 'project', 'repository', 'version', 'releaseTag', 'releasePublishedAt',
  'tagRefSha', 'commitSha', 'releaseImmutable', 'upstreamChecksumPublished',
  'sourceArchive', 'selectedSource', 'components',
]);
const ARCHIVE_KEYS = Object.freeze([
  'fileName', 'archiveRoot', 'url', 'sizeBytes', 'sha256', 'entries', 'expandedBytes',
]);
const SELECTED_KEYS = Object.freeze(['entries', 'expandedBytes']);
const COMPONENT_KEYS = Object.freeze(['version', 'spdx', 'licenseFile']);
const LGPL_COMPONENT_KEYS = Object.freeze([
  'version', 'spdx', 'licenseFile', 'licenseTextFile',
]);
const FILE_KEYS = Object.freeze(['path', 'sizeBytes', 'sha256']);
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

export const SUITESPARSE_COMPONENT_CONTRACT = Object.freeze({
  SuiteSparse_config: Object.freeze({
    version: '7.7.0', spdx: 'BSD-3-Clause', path: 'SuiteSparse_config/README.txt',
  }),
  AMD: Object.freeze({ version: '3.3.2', spdx: 'BSD-3-Clause', path: 'AMD/Doc/License.txt' }),
  BTF: Object.freeze({
    version: '2.3.2', spdx: 'LGPL-2.1-or-later', path: 'BTF/Doc/License.txt',
    licenseTextPath: 'BTF/Doc/lesser.txt',
  }),
  COLAMD: Object.freeze({
    version: '3.3.3', spdx: 'BSD-3-Clause', path: 'COLAMD/Doc/License.txt',
  }),
  KLU: Object.freeze({
    version: '2.3.3', spdx: 'LGPL-2.1-or-later', path: 'KLU/Doc/License.txt',
    licenseTextPath: 'KLU/Doc/lesser.txt',
  }),
});

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function issue(path, code, message) {
  return Object.freeze({ path, code, message });
}

function exactKeys(value, expected, path, issues) {
  if (!plainObject(value)) {
    issues.push(issue(path, 'type', 'must be a plain object'));
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push(issue(path, 'closed_shape', `keys must be exactly: ${wanted.join(', ')}`));
    return false;
  }
  return true;
}

function positiveInteger(value, path, issues) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    issues.push(issue(path, 'range', 'must be a positive safe integer'));
  }
}

function validateFileLock(value, expectedPath, path, issues) {
  if (!exactKeys(value, FILE_KEYS, path, issues)) return;
  if (value.path !== expectedPath) {
    issues.push(issue(`${path}/path`, 'value', `must be ${expectedPath}`));
  }
  positiveInteger(value.sizeBytes, `${path}/sizeBytes`, issues);
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    issues.push(issue(`${path}/sha256`, 'format', 'must be a lowercase SHA-256 digest'));
  }
}

export function validateSuiteSparseSourceLock(value) {
  const issues = [];
  if (!exactKeys(value, ROOT_KEYS, '$', issues)) return deepFreeze(issues);

  if (value.format !== SUITESPARSE_SOURCE_LOCK_FORMAT) {
    issues.push(issue('$/format', 'value', `must be ${SUITESPARSE_SOURCE_LOCK_FORMAT}`));
  }
  if (value.project !== 'SuiteSparse') {
    issues.push(issue('$/project', 'value', 'must be SuiteSparse'));
  }
  if (value.repository !== 'https://github.com/DrTimothyAldenDavis/SuiteSparse') {
    issues.push(issue('$/repository', 'value', 'must identify the official SuiteSparse repository'));
  }
  if (value.version !== '7.7.0' || !VERSION.test(value.version)) {
    issues.push(issue('$/version', 'value', 'must be the reviewed 7.7.0 release'));
  }
  if (value.releaseTag !== `v${value.version}`) {
    issues.push(issue('$/releaseTag', 'binding', 'must equal v followed by version'));
  }
  if (value.releasePublishedAt !== '2024-03-26T21:21:44Z') {
    issues.push(issue('$/releasePublishedAt', 'value', 'must identify the reviewed release timestamp'));
  }
  for (const field of ['tagRefSha', 'commitSha']) {
    if (typeof value[field] !== 'string' || !GIT_SHA.test(value[field])) {
      issues.push(issue(`$/${field}`, 'format', 'must be a lowercase 40-character Git SHA'));
    }
  }
  if (value.tagRefSha !== value.commitSha) {
    issues.push(issue('$/tagRefSha', 'binding', 'the reviewed lightweight tag must equal commitSha'));
  }
  if (value.releaseImmutable !== false) {
    issues.push(issue('$/releaseImmutable', 'value', 'must record that the upstream release is not immutable'));
  }
  if (value.upstreamChecksumPublished !== false) {
    issues.push(issue('$/upstreamChecksumPublished', 'value', 'must record that upstream published no checksum'));
  }

  if (exactKeys(value.sourceArchive, ARCHIVE_KEYS, '$/sourceArchive', issues)) {
    const expectedName = `SuiteSparse-${value.version}.tar.gz`;
    if (value.sourceArchive.fileName !== expectedName) {
      issues.push(issue('$/sourceArchive/fileName', 'binding', `must be ${expectedName}`));
    }
    if (value.sourceArchive.archiveRoot !== `SuiteSparse-${value.version}`) {
      issues.push(issue('$/sourceArchive/archiveRoot', 'binding', 'must bind the codeload archive root'));
    }
    const expectedUrl = `${value.repository}/archive/refs/tags/${value.releaseTag}.tar.gz`;
    if (value.sourceArchive.url !== expectedUrl) {
      issues.push(issue('$/sourceArchive/url', 'binding', 'must be the official tag archive URL'));
    }
    positiveInteger(value.sourceArchive.sizeBytes, '$/sourceArchive/sizeBytes', issues);
    positiveInteger(value.sourceArchive.entries, '$/sourceArchive/entries', issues);
    positiveInteger(value.sourceArchive.expandedBytes, '$/sourceArchive/expandedBytes', issues);
    if (typeof value.sourceArchive.sha256 !== 'string' || !SHA256.test(value.sourceArchive.sha256)) {
      issues.push(issue('$/sourceArchive/sha256', 'format', 'must be a lowercase SHA-256 digest'));
    }
  }

  if (exactKeys(value.selectedSource, SELECTED_KEYS, '$/selectedSource', issues)) {
    positiveInteger(value.selectedSource.entries, '$/selectedSource/entries', issues);
    positiveInteger(value.selectedSource.expandedBytes, '$/selectedSource/expandedBytes', issues);
    if (value.sourceArchive && value.selectedSource.entries >= value.sourceArchive.entries) {
      issues.push(issue('$/selectedSource/entries', 'range', 'must be smaller than the full archive inventory'));
    }
    if (value.sourceArchive && value.selectedSource.expandedBytes >= value.sourceArchive.expandedBytes) {
      issues.push(issue('$/selectedSource/expandedBytes', 'range', 'must be smaller than the full archive expansion'));
    }
  }

  const componentNames = Object.keys(SUITESPARSE_COMPONENT_CONTRACT);
  if (exactKeys(value.components, componentNames, '$/components', issues)) {
    for (const [name, expected] of Object.entries(SUITESPARSE_COMPONENT_CONTRACT)) {
      const component = value.components[name];
      const location = `$/components/${name}`;
      const keys = expected.licenseTextPath ? LGPL_COMPONENT_KEYS : COMPONENT_KEYS;
      if (!exactKeys(component, keys, location, issues)) continue;
      if (component.version !== expected.version) {
        issues.push(issue(`${location}/version`, 'value', `must be ${expected.version}`));
      }
      if (component.spdx !== expected.spdx) {
        issues.push(issue(`${location}/spdx`, 'value', `must be ${expected.spdx}`));
      }
      validateFileLock(component.licenseFile, expected.path, `${location}/licenseFile`, issues);
      if (expected.licenseTextPath) {
        validateFileLock(
          component.licenseTextFile,
          expected.licenseTextPath,
          `${location}/licenseTextFile`,
          issues,
        );
      }
    }
  }
  return deepFreeze(issues);
}

export class SuiteSparseSourceVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SuiteSparseSourceVerificationError';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

export function loadSuiteSparseSourceLock(path = SUITESPARSE_SOURCE_LOCK_PATH) {
  let raw;
  let value;
  try {
    raw = readFileSync(path, 'utf8');
    value = JSON.parse(raw);
  } catch (error) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_lock.unreadable',
      `Unable to read the SuiteSparse source lock: ${error.message}`,
    );
  }
  if (raw !== `${JSON.stringify(value, null, 2)}\n`) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_lock.noncanonical',
      'SuiteSparse source lock must be exact canonical JSON without duplicate keys or trailing data',
    );
  }
  const issues = validateSuiteSparseSourceLock(value);
  if (issues.length > 0) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_lock.invalid',
      `SuiteSparse source lock is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      { issues },
    );
  }
  return deepFreeze(value);
}

export const SUITESPARSE_SOURCE_LOCK = loadSuiteSparseSourceLock();

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyRegularFile(path, expected, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_file.unreadable', `${label} cannot be read: ${error.message}`, { path },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_file.not_regular', `${label} must be a regular file`, { path },
    );
  }
  if (metadata.size !== expected.sizeBytes) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_file.size_mismatch',
      `${label} size mismatch: expected ${expected.sizeBytes}, received ${metadata.size}`,
      { path, expectedSizeBytes: expected.sizeBytes, actualSizeBytes: metadata.size },
    );
  }
  const actualSha256 = await sha256(path);
  if (actualSha256 !== expected.sha256) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_file.digest_mismatch', `${label} SHA-256 mismatch`,
      { path, expectedSha256: expected.sha256, actualSha256 },
    );
  }
  return deepFreeze({ path: resolve(path), sizeBytes: metadata.size, sha256: actualSha256 });
}

export function verifySuiteSparseArchive(path, lock = SUITESPARSE_SOURCE_LOCK) {
  const issues = validateSuiteSparseSourceLock(lock);
  if (issues.length > 0) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_lock.invalid', 'Cannot verify an archive against an invalid lock', { issues },
    );
  }
  return verifyRegularFile(path, lock.sourceArchive, 'SuiteSparse source archive');
}

export async function verifySuiteSparseLicenseFiles(sourceDirectory, lock = SUITESPARSE_SOURCE_LOCK) {
  const issues = validateSuiteSparseSourceLock(lock);
  if (issues.length > 0) {
    throw new SuiteSparseSourceVerificationError(
      'suitesparse.source_lock.invalid', 'Cannot verify licenses against an invalid lock', { issues },
    );
  }
  const root = resolve(sourceDirectory);
  const components = {};
  for (const [name, component] of Object.entries(lock.components)) {
    const notice = await verifyRegularFile(
      resolve(root, component.licenseFile.path), component.licenseFile, `${name} license notice`,
    );
    let licenseText = null;
    if (component.licenseTextFile) {
      licenseText = await verifyRegularFile(
        resolve(root, component.licenseTextFile.path),
        component.licenseTextFile,
        `${name} full license text`,
      );
    }
    components[name] = deepFreeze({ notice, licenseText });
  }
  return deepFreeze({ components });
}

function parseCli(arguments_) {
  const options = { archive: null, sourceDirectory: null, lockOnly: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--lock-only') {
      if (options.lockOnly) throw new Error('--lock-only may be supplied only once');
      options.lockOnly = true;
    } else if (argument === '--archive' || argument === '--source-dir') {
      const key = argument === '--archive' ? 'archive' : 'sourceDirectory';
      if (options[key] !== null) throw new Error(`${argument} may be supplied only once`);
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      options[key] = value;
      index += 1;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (options.lockOnly && (options.archive || options.sourceDirectory)) {
    throw new Error('--lock-only cannot be combined with file verification options');
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`SuiteSparse source verification: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const lock = SUITESPARSE_SOURCE_LOCK;
  if (options.archive) await verifySuiteSparseArchive(options.archive, lock);
  if (options.sourceDirectory) await verifySuiteSparseLicenseFiles(options.sourceDirectory, lock);
  console.log([
    `SuiteSparse ${lock.version} source lock verified`,
    options.archive ? 'archive verified' : null,
    options.sourceDirectory ? 'component license notices verified' : null,
  ].filter(Boolean).join(' — '));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof SuiteSparseSourceVerificationError ? error.code : 'unexpected';
    console.error(`SuiteSparse source verification failed [${code}]: ${error.message}`);
    process.exitCode = 1;
  });
}
