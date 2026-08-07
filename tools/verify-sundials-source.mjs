#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUNDIALS_SOURCE_LOCK_FORMAT = 'battery-design/sundials-source-lock@1';
export const SUNDIALS_SOURCE_LOCK_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../native-backends/sundials/source-lock.json',
);

const ROOT_KEYS = [
  'format', 'project', 'repository', 'version', 'releaseTag', 'releasePublishedAt',
  'tagObjectSha', 'commitSha', 'sourceArchive', 'license',
];
const ARCHIVE_KEYS = ['fileName', 'archiveRoot', 'url', 'sizeBytes', 'sha256'];
const LICENSE_KEYS = ['spdx', 'licenseFile', 'noticeFile'];
const FILE_KEYS = ['path', 'sizeBytes', 'sha256'];
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

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

function validateFileLock(value, expectedPath, path, issues) {
  if (!exactKeys(value, FILE_KEYS, path, issues)) return;
  if (value.path !== expectedPath) {
    issues.push(issue(`${path}/path`, 'value', `must be ${expectedPath}`));
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) {
    issues.push(issue(`${path}/sizeBytes`, 'range', 'must be a positive safe integer'));
  }
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    issues.push(issue(`${path}/sha256`, 'format', 'must be a lowercase SHA-256 digest'));
  }
}

export function validateSundialsSourceLock(value) {
  const issues = [];
  if (!exactKeys(value, ROOT_KEYS, '$', issues)) return deepFreeze(issues);

  if (value.format !== SUNDIALS_SOURCE_LOCK_FORMAT) {
    issues.push(issue('$/format', 'value', `must be ${SUNDIALS_SOURCE_LOCK_FORMAT}`));
  }
  if (value.project !== 'SUNDIALS') {
    issues.push(issue('$/project', 'value', 'must be SUNDIALS'));
  }
  if (value.repository !== 'https://github.com/LLNL/sundials') {
    issues.push(issue('$/repository', 'value', 'must identify the official LLNL repository'));
  }
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) {
    issues.push(issue('$/version', 'format', 'must be a three-part numeric release version'));
  }
  if (value.releaseTag !== `v${value.version}`) {
    issues.push(issue('$/releaseTag', 'binding', 'must equal v followed by version'));
  }
  if (typeof value.releasePublishedAt !== 'string'
      || Number.isNaN(Date.parse(value.releasePublishedAt))
      || !value.releasePublishedAt.endsWith('Z')) {
    issues.push(issue('$/releasePublishedAt', 'format', 'must be an RFC 3339 UTC timestamp'));
  }
  for (const field of ['tagObjectSha', 'commitSha']) {
    if (typeof value[field] !== 'string' || !GIT_SHA.test(value[field])) {
      issues.push(issue(`$/${field}`, 'format', 'must be a lowercase 40-character Git SHA'));
    }
  }

  if (exactKeys(value.sourceArchive, ARCHIVE_KEYS, '$/sourceArchive', issues)) {
    const expectedName = `ida-${value.version}.tar.gz`;
    const expectedRoot = `ida-${value.version}`;
    const expectedUrl = `${value.repository}/releases/download/${value.releaseTag}/${expectedName}`;
    if (value.sourceArchive.fileName !== expectedName) {
      issues.push(issue('$/sourceArchive/fileName', 'binding', `must be ${expectedName}`));
    }
    if (value.sourceArchive.url !== expectedUrl) {
      issues.push(issue('$/sourceArchive/url', 'binding', 'must be the official release asset URL'));
    }
    if (value.sourceArchive.archiveRoot !== expectedRoot) {
      issues.push(issue('$/sourceArchive/archiveRoot', 'binding', `must be ${expectedRoot}`));
    }
    if (!Number.isSafeInteger(value.sourceArchive.sizeBytes)
        || value.sourceArchive.sizeBytes <= 0) {
      issues.push(issue('$/sourceArchive/sizeBytes', 'range', 'must be a positive safe integer'));
    }
    if (typeof value.sourceArchive.sha256 !== 'string'
        || !SHA256.test(value.sourceArchive.sha256)) {
      issues.push(issue('$/sourceArchive/sha256', 'format', 'must be a lowercase SHA-256 digest'));
    }
  }

  if (exactKeys(value.license, LICENSE_KEYS, '$/license', issues)) {
    if (value.license.spdx !== 'BSD-3-Clause') {
      issues.push(issue('$/license/spdx', 'value', 'must be BSD-3-Clause'));
    }
    validateFileLock(value.license.licenseFile, 'LICENSE', '$/license/licenseFile', issues);
    validateFileLock(value.license.noticeFile, 'NOTICE', '$/license/noticeFile', issues);
  }
  return deepFreeze(issues);
}

export class SundialsSourceVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SundialsSourceVerificationError';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

export function loadSundialsSourceLock(path = SUNDIALS_SOURCE_LOCK_PATH) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SundialsSourceVerificationError(
      'sundials.source_lock.unreadable',
      `Unable to read the SUNDIALS source lock: ${error.message}`,
    );
  }
  const issues = validateSundialsSourceLock(value);
  if (issues.length > 0) {
    throw new SundialsSourceVerificationError(
      'sundials.source_lock.invalid',
      `SUNDIALS source lock is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      { issues },
    );
  }
  return deepFreeze(value);
}

export const SUNDIALS_SOURCE_LOCK = loadSundialsSourceLock();

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
    throw new SundialsSourceVerificationError(
      'sundials.source_file.unreadable',
      `${label} cannot be read: ${error.message}`,
      { path },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SundialsSourceVerificationError(
      'sundials.source_file.not_regular',
      `${label} must be a regular file, not a directory or symbolic link`,
      { path },
    );
  }
  if (metadata.size !== expected.sizeBytes) {
    throw new SundialsSourceVerificationError(
      'sundials.source_file.size_mismatch',
      `${label} size mismatch: expected ${expected.sizeBytes}, received ${metadata.size}`,
      { path, expectedSizeBytes: expected.sizeBytes, actualSizeBytes: metadata.size },
    );
  }
  const actualSha256 = await sha256(path);
  if (actualSha256 !== expected.sha256) {
    throw new SundialsSourceVerificationError(
      'sundials.source_file.digest_mismatch',
      `${label} SHA-256 mismatch`,
      { path, expectedSha256: expected.sha256, actualSha256 },
    );
  }
  return deepFreeze({ path: resolve(path), sizeBytes: metadata.size, sha256: actualSha256 });
}

export function verifySundialsArchive(path, lock = SUNDIALS_SOURCE_LOCK) {
  const issues = validateSundialsSourceLock(lock);
  if (issues.length > 0) {
    throw new SundialsSourceVerificationError(
      'sundials.source_lock.invalid',
      'Cannot verify an archive against an invalid SUNDIALS source lock',
      { issues },
    );
  }
  return verifyRegularFile(path, lock.sourceArchive, 'SUNDIALS source archive');
}

export async function verifySundialsLicenseFiles(sourceDirectory, lock = SUNDIALS_SOURCE_LOCK) {
  const issues = validateSundialsSourceLock(lock);
  if (issues.length > 0) {
    throw new SundialsSourceVerificationError(
      'sundials.source_lock.invalid',
      'Cannot verify license files against an invalid SUNDIALS source lock',
      { issues },
    );
  }
  const root = resolve(sourceDirectory);
  const license = await verifyRegularFile(
    resolve(root, lock.license.licenseFile.path),
    lock.license.licenseFile,
    'SUNDIALS LICENSE',
  );
  const notice = await verifyRegularFile(
    resolve(root, lock.license.noticeFile.path),
    lock.license.noticeFile,
    'SUNDIALS NOTICE',
  );
  return deepFreeze({ spdx: lock.license.spdx, license, notice });
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
    console.error(`SUNDIALS source verification: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const lock = SUNDIALS_SOURCE_LOCK;
  if (options.archive) await verifySundialsArchive(options.archive, lock);
  if (options.sourceDirectory) await verifySundialsLicenseFiles(options.sourceDirectory, lock);
  console.log([
    `SUNDIALS ${lock.version} source lock verified`,
    options.archive ? 'archive verified' : null,
    options.sourceDirectory ? 'license and notice verified' : null,
  ].filter(Boolean).join(' — '));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof SundialsSourceVerificationError ? error.code : 'unexpected';
    console.error(`SUNDIALS source verification failed [${code}]: ${error.message}`);
    process.exitCode = 1;
  });
}
