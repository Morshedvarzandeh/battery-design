import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUITESPARSE_COMPONENT_CONTRACT,
  SUITESPARSE_SOURCE_LOCK,
  SUITESPARSE_SOURCE_LOCK_FORMAT,
  SuiteSparseSourceVerificationError,
  validateSuiteSparseSourceLock,
  verifySuiteSparseArchive,
  verifySuiteSparseLicenseFiles,
} from '../tools/verify-suitesparse-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function temporary(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureLockWithArchive(bytes) {
  const lock = clone(SUITESPARSE_SOURCE_LOCK);
  lock.sourceArchive.sizeBytes = bytes.length;
  lock.sourceArchive.sha256 = digest(bytes);
  return lock;
}

function fixtureSource(directory, lock = clone(SUITESPARSE_SOURCE_LOCK)) {
  for (const component of Object.values(lock.components)) {
    const bytes = Buffer.from(`fixture:${component.licenseFile.path}`);
    component.licenseFile.sizeBytes = bytes.length;
    component.licenseFile.sha256 = digest(bytes);
    const path = join(directory, component.licenseFile.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    if (component.licenseTextFile) {
      const licenseBytes = Buffer.from(`fixture:${component.licenseTextFile.path}`);
      component.licenseTextFile.sizeBytes = licenseBytes.length;
      component.licenseTextFile.sha256 = digest(licenseBytes);
      const licensePath = join(directory, component.licenseTextFile.path);
      mkdirSync(dirname(licensePath), { recursive: true });
      writeFileSync(licensePath, licenseBytes);
    }
  }
  return lock;
}

test('SuiteSparse lock pins the reviewed official release and measured archive bytes', () => {
  assert.deepEqual(validateSuiteSparseSourceLock(SUITESPARSE_SOURCE_LOCK), []);
  assert.deepEqual({
    format: SUITESPARSE_SOURCE_LOCK.format,
    repository: SUITESPARSE_SOURCE_LOCK.repository,
    version: SUITESPARSE_SOURCE_LOCK.version,
    tag: SUITESPARSE_SOURCE_LOCK.releaseTag,
    published: SUITESPARSE_SOURCE_LOCK.releasePublishedAt,
    tagRef: SUITESPARSE_SOURCE_LOCK.tagRefSha,
    commit: SUITESPARSE_SOURCE_LOCK.commitSha,
    immutable: SUITESPARSE_SOURCE_LOCK.releaseImmutable,
    upstreamChecksum: SUITESPARSE_SOURCE_LOCK.upstreamChecksumPublished,
    archiveBytes: SUITESPARSE_SOURCE_LOCK.sourceArchive.sizeBytes,
    archiveSha256: SUITESPARSE_SOURCE_LOCK.sourceArchive.sha256,
  }, {
    format: SUITESPARSE_SOURCE_LOCK_FORMAT,
    repository: 'https://github.com/DrTimothyAldenDavis/SuiteSparse',
    version: '7.7.0',
    tag: 'v7.7.0',
    published: '2024-03-26T21:21:44Z',
    tagRef: '13806726cbf470914d012d132a85aea1aff9ee77',
    commit: '13806726cbf470914d012d132a85aea1aff9ee77',
    immutable: false,
    upstreamChecksum: false,
    archiveBytes: 85876065,
    archiveSha256: '529b067f5d80981f45ddf6766627b8fc5af619822f068f342aab776e683df4f3',
  });
});

test('SuiteSparse lock and component contract are recursively immutable', () => {
  assertDeepFrozen(SUITESPARSE_SOURCE_LOCK);
  assertDeepFrozen(SUITESPARSE_COMPONENT_CONTRACT);
});

test('five checked-in component notices and two full LGPL texts have closed identities', () => {
  for (const [name, component] of Object.entries(SUITESPARSE_SOURCE_LOCK.components)) {
    const checked = readFileSync(join(ROOT, 'native-backends/suitesparse/licenses', `${name}.txt`));
    const exact = digest(checked) === component.licenseFile.sha256;
    const normalizedFinalBlank = digest(Buffer.concat([checked, Buffer.from('\n')]))
      === component.licenseFile.sha256;
    assert.ok(exact || normalizedFinalBlank, `${name} notice drifted beyond final-newline normalization`);
    if (component.licenseTextFile) {
      assert.equal(component.licenseTextFile.path, `${name}/Doc/lesser.txt`);
      const licenseText = readFileSync(
        join(ROOT, 'native-backends/suitesparse/licenses', `${name}-LGPL-2.1.txt`),
      );
      assert.equal(licenseText.length, component.licenseTextFile.sizeBytes);
      assert.equal(digest(licenseText), component.licenseTextFile.sha256);
    }
  }
});

test('lock-only CLI is deterministic and performs no download or build', () => {
  const run = spawnSync(process.execPath, ['tools/verify-suitesparse-source.mjs', '--lock-only'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, 'SuiteSparse 7.7.0 source lock verified\n');
  const source = readFileSync(join(ROOT, 'tools/verify-suitesparse-source.mjs'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|\bcurl\b|\bwget\b/u);
});

test('archive verifier accepts an exact regular-file fixture', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-archive-');
  const archive = join(directory, 'SuiteSparse.tar.gz');
  const bytes = Buffer.from('exact SuiteSparse archive fixture');
  writeFileSync(archive, bytes);
  const verified = await verifySuiteSparseArchive(archive, fixtureLockWithArchive(bytes));
  assert.deepEqual({ size: verified.sizeBytes, sha256: verified.sha256 }, {
    size: bytes.length, sha256: digest(bytes),
  });
  assertDeepFrozen(verified);
});

test('archive verifier rejects a size mismatch before hashing acceptance', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-size-');
  const archive = join(directory, 'source.tar.gz');
  const bytes = Buffer.from('size fixture');
  writeFileSync(archive, bytes);
  const lock = fixtureLockWithArchive(bytes);
  lock.sourceArchive.sizeBytes += 1;
  await assert.rejects(verifySuiteSparseArchive(archive, lock), (error) => (
    error instanceof SuiteSparseSourceVerificationError
      && error.code === 'suitesparse.source_file.size_mismatch'
  ));
});

test('archive verifier rejects digest drift at the exact accepted size', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-digest-');
  const archive = join(directory, 'source.tar.gz');
  const bytes = Buffer.from('digest fixture');
  writeFileSync(archive, bytes);
  const lock = fixtureLockWithArchive(bytes);
  lock.sourceArchive.sha256 = '0'.repeat(64);
  await assert.rejects(verifySuiteSparseArchive(archive, lock), (error) => (
    error instanceof SuiteSparseSourceVerificationError
      && error.code === 'suitesparse.source_file.digest_mismatch'
  ));
});

test('archive verifier rejects symbolic-link substitution', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-link-');
  const target = join(directory, 'target.tar.gz');
  const link = join(directory, 'source.tar.gz');
  const bytes = Buffer.from('link fixture');
  writeFileSync(target, bytes);
  symlinkSync(target, link);
  await assert.rejects(verifySuiteSparseArchive(link, fixtureLockWithArchive(bytes)), (error) => (
    error instanceof SuiteSparseSourceVerificationError
      && error.code === 'suitesparse.source_file.not_regular'
  ));
});

test('component notice verifier accepts all five exact files and freezes evidence', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-licenses-');
  const lock = fixtureSource(directory);
  const verified = await verifySuiteSparseLicenseFiles(directory, lock);
  assert.deepEqual(Object.keys(verified.components), Object.keys(SUITESPARSE_COMPONENT_CONTRACT));
  assertDeepFrozen(verified);
});

test('component notice verifier rejects a missing required notice', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-license-missing-');
  const lock = fixtureSource(directory);
  unlinkSync(join(directory, lock.components.KLU.licenseFile.path));
  await assert.rejects(verifySuiteSparseLicenseFiles(directory, lock), (error) => (
    error instanceof SuiteSparseSourceVerificationError
      && error.code === 'suitesparse.source_file.unreadable'
  ));
});

test('component notice verifier rejects same-size component drift', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-license-digest-');
  const lock = fixtureSource(directory);
  const path = join(directory, lock.components.BTF.licenseFile.path);
  const bytes = readFileSync(path);
  writeFileSync(path, Buffer.alloc(bytes.length, 0x78));
  await assert.rejects(verifySuiteSparseLicenseFiles(directory, lock), (error) => (
    error instanceof SuiteSparseSourceVerificationError
      && error.code === 'suitesparse.source_file.digest_mismatch'
  ));
});

test('component notice verifier rejects symbolic-link substitution', async (t) => {
  const directory = temporary(t, 'battery-design-suitesparse-license-link-');
  const lock = fixtureSource(directory);
  const path = join(directory, lock.components.KLU.licenseFile.path);
  const target = `${path}.target`;
  writeFileSync(target, readFileSync(path));
  unlinkSync(path);
  symlinkSync(target, path);
  await assert.rejects(verifySuiteSparseLicenseFiles(directory, lock), (error) => (
    error instanceof SuiteSparseSourceVerificationError
      && error.code === 'suitesparse.source_file.not_regular'
  ));
});

const schemaCases = [
  ['unknown root field', (v) => { v.unreviewed = true; }],
  ['wrong format', (v) => { v.format = 'battery-design/suitesparse-source-lock@2'; }],
  ['wrong project', (v) => { v.project = 'KLU'; }],
  ['unofficial repository', (v) => { v.repository = 'https://example.invalid/SuiteSparse'; }],
  ['unsupported meta version', (v) => { v.version = '7.12.2'; }],
  ['tag/version drift', (v) => { v.releaseTag = 'v7.6.1'; }],
  ['release timestamp drift', (v) => { v.releasePublishedAt = '2024-03-26T21:14:00Z'; }],
  ['uppercase tag SHA', (v) => { v.tagRefSha = v.tagRefSha.toUpperCase(); }],
  ['tag/commit drift', (v) => { v.commitSha = '0'.repeat(40); }],
  ['false immutable status removed', (v) => { v.releaseImmutable = true; }],
  ['unpublished checksum represented as published', (v) => { v.upstreamChecksumPublished = true; }],
  ['unknown archive field', (v) => { v.sourceArchive.etag = 'not-a-lock'; }],
  ['archive filename drift', (v) => { v.sourceArchive.fileName = 'SuiteSparse-latest.tar.gz'; }],
  ['archive root drift', (v) => { v.sourceArchive.archiveRoot = 'SuiteSparse-dev'; }],
  ['archive URL drift', (v) => { v.sourceArchive.url = 'https://example.invalid/source.tar.gz'; }],
  ['zero archive size', (v) => { v.sourceArchive.sizeBytes = 0; }],
  ['uppercase archive digest', (v) => { v.sourceArchive.sha256 = 'A'.repeat(64); }],
  ['zero archive entries', (v) => { v.sourceArchive.entries = 0; }],
  ['negative archive expansion', (v) => { v.sourceArchive.expandedBytes = -1; }],
  ['unknown selected-source field', (v) => { v.selectedSource.path = 'all'; }],
  ['selected inventory not smaller', (v) => { v.selectedSource.entries = v.sourceArchive.entries; }],
  ['selected expansion not smaller', (v) => { v.selectedSource.expandedBytes = v.sourceArchive.expandedBytes; }],
  ['unknown component', (v) => { v.components.CHOLMOD = clone(v.components.KLU); }],
  ['missing KLU component', (v) => { delete v.components.KLU; }],
  ['unknown KLU field', (v) => { v.components.KLU.dynamic = false; }],
  ['KLU version drift', (v) => { v.components.KLU.version = '2.3.4'; }],
  ['KLU SPDX drift', (v) => { v.components.KLU.spdx = 'BSD-3-Clause'; }],
  ['KLU notice traversal', (v) => { v.components.KLU.licenseFile.path = '../License.txt'; }],
  ['KLU notice zero size', (v) => { v.components.KLU.licenseFile.sizeBytes = 0; }],
  ['KLU notice uppercase digest', (v) => { v.components.KLU.licenseFile.sha256 = 'B'.repeat(64); }],
  ['BTF version drift', (v) => { v.components.BTF.version = '2.3.1'; }],
  ['AMD SPDX drift', (v) => { v.components.AMD.spdx = 'MIT'; }],
  ['COLAMD notice path drift', (v) => { v.components.COLAMD.licenseFile.path = 'License.txt'; }],
  ['SuiteSparse_config version drift', (v) => { v.components.SuiteSparse_config.version = '7.6.1'; }],
  ['component notice unknown field', (v) => { v.components.AMD.licenseFile.url = 'mirror'; }],
  ['component notice digest too short', (v) => { v.components.BTF.licenseFile.sha256 = '0'.repeat(63); }],
];

for (const [name, mutate] of schemaCases) {
  test(`closed SuiteSparse lock rejects ${name}`, () => {
    assert.equal(schemaCases.length, 36);
    const candidate = clone(SUITESPARSE_SOURCE_LOCK);
    mutate(candidate);
    const first = validateSuiteSparseSourceLock(candidate);
    const second = validateSuiteSparseSourceLock(candidate);
    assert.ok(first.length > 0);
    assert.deepEqual(first, second);
    assertDeepFrozen(first);
  });
}
