import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUNDIALS_SOURCE_LOCK,
  SUNDIALS_SOURCE_LOCK_FORMAT,
  SundialsSourceVerificationError,
  validateSundialsSourceLock,
  verifySundialsArchive,
  verifySundialsLicenseFiles,
} from '../tools/verify-sundials-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('SUNDIALS source lock pins one exact official release artifact and notices', () => {
  assert.deepEqual(validateSundialsSourceLock(SUNDIALS_SOURCE_LOCK), []);
  assert.equal(SUNDIALS_SOURCE_LOCK.format, SUNDIALS_SOURCE_LOCK_FORMAT);
  assert.deepEqual({
    version: SUNDIALS_SOURCE_LOCK.version,
    tag: SUNDIALS_SOURCE_LOCK.releaseTag,
    published: SUNDIALS_SOURCE_LOCK.releasePublishedAt,
    tagObject: SUNDIALS_SOURCE_LOCK.tagObjectSha,
    commit: SUNDIALS_SOURCE_LOCK.commitSha,
    archiveName: SUNDIALS_SOURCE_LOCK.sourceArchive.fileName,
    archiveRoot: SUNDIALS_SOURCE_LOCK.sourceArchive.archiveRoot,
    archiveBytes: SUNDIALS_SOURCE_LOCK.sourceArchive.sizeBytes,
    archiveSha256: SUNDIALS_SOURCE_LOCK.sourceArchive.sha256,
    license: SUNDIALS_SOURCE_LOCK.license.spdx,
  }, {
    version: '7.8.0',
    tag: 'v7.8.0',
    published: '2026-06-25T19:33:06Z',
    tagObject: 'ac6903fe8d21cad8ba51b61c81c31d230c353ddf',
    commit: 'aedc088437064dd55b35c000145f7f5db6ee49e3',
    archiveName: 'ida-7.8.0.tar.gz',
    archiveRoot: 'ida-7.8.0',
    archiveBytes: 5022403,
    archiveSha256: 'fceb9704259952d371877e8f9c2e2758c4a51751907ad5ab13e38c2bcf140c9d',
    license: 'BSD-3-Clause',
  });
  assertDeepFrozen(SUNDIALS_SOURCE_LOCK);
});

test('source lock is closed and rejects drift between version, tag, file and URL', () => {
  const cases = [
    (value) => { value.unreviewedMirror = 'https://example.invalid/source.tgz'; },
    (value) => { value.releaseTag = 'v7.7.0'; },
    (value) => { value.sourceArchive.fileName = 'sundials-latest.tar.gz'; },
    (value) => { value.sourceArchive.archiveRoot = 'sundials-7.8.0'; },
    (value) => { value.sourceArchive.url = 'https://example.invalid/sundials.tar.gz'; },
    (value) => { value.sourceArchive.sha256 = 'A'.repeat(64); },
    (value) => { value.license.licenseFile.path = '../LICENSE'; },
  ];
  for (const mutate of cases) {
    const candidate = clone(SUNDIALS_SOURCE_LOCK);
    mutate(candidate);
    const first = validateSundialsSourceLock(candidate);
    const second = validateSundialsSourceLock(candidate);
    assert.ok(first.length > 0);
    assert.deepEqual(first, second);
    assertDeepFrozen(first);
  }
});

test('archive verifier checks regular-file identity before accepting bytes', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-sundials-lock-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const archive = join(temporary, 'source.tar.gz');
  const bytes = Buffer.from('pinned fixture bytes');
  writeFileSync(archive, bytes);
  const lock = clone(SUNDIALS_SOURCE_LOCK);
  lock.sourceArchive.sizeBytes = bytes.length;
  lock.sourceArchive.sha256 = digest(bytes);
  const verified = await verifySundialsArchive(archive, lock);
  assert.deepEqual({ sizeBytes: verified.sizeBytes, sha256: verified.sha256 }, {
    sizeBytes: bytes.length,
    sha256: digest(bytes),
  });
  assertDeepFrozen(verified);

  lock.sourceArchive.sizeBytes += 1;
  await assert.rejects(
    verifySundialsArchive(archive, lock),
    (error) => error instanceof SundialsSourceVerificationError
      && error.code === 'sundials.source_file.size_mismatch',
  );
  lock.sourceArchive.sizeBytes -= 1;
  lock.sourceArchive.sha256 = '0'.repeat(64);
  await assert.rejects(
    verifySundialsArchive(archive, lock),
    (error) => error instanceof SundialsSourceVerificationError
      && error.code === 'sundials.source_file.digest_mismatch',
  );
});

test('archive verifier rejects a symbolic-link substitution', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-sundials-link-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const target = join(temporary, 'target.tar.gz');
  const link = join(temporary, 'source.tar.gz');
  const bytes = Buffer.from('link target');
  writeFileSync(target, bytes);
  symlinkSync(target, link);
  const lock = clone(SUNDIALS_SOURCE_LOCK);
  lock.sourceArchive.sizeBytes = bytes.length;
  lock.sourceArchive.sha256 = digest(bytes);
  await assert.rejects(
    verifySundialsArchive(link, lock),
    (error) => error instanceof SundialsSourceVerificationError
      && error.code === 'sundials.source_file.not_regular',
  );
});

test('license verifier binds both required notice files', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-sundials-license-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const licenseBytes = Buffer.from('BSD fixture');
  const noticeBytes = Buffer.from('notice fixture');
  writeFileSync(join(temporary, 'LICENSE'), licenseBytes);
  writeFileSync(join(temporary, 'NOTICE'), noticeBytes);
  const lock = clone(SUNDIALS_SOURCE_LOCK);
  lock.license.licenseFile.sizeBytes = licenseBytes.length;
  lock.license.licenseFile.sha256 = digest(licenseBytes);
  lock.license.noticeFile.sizeBytes = noticeBytes.length;
  lock.license.noticeFile.sha256 = digest(noticeBytes);
  const result = await verifySundialsLicenseFiles(temporary, lock);
  assert.equal(result.spdx, 'BSD-3-Clause');
  assert.equal(result.license.sha256, digest(licenseBytes));
  assert.equal(result.notice.sha256, digest(noticeBytes));
  assertDeepFrozen(result);
});

test('lock-only CLI is deterministic and does not download or build SUNDIALS', () => {
  const run = spawnSync(process.execPath, [
    'tools/verify-sundials-source.mjs', '--lock-only',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, 'SUNDIALS 7.8.0 source lock verified\n');

  const cargo = readFileSync(join(ROOT, 'rust-core', 'Cargo.toml'), 'utf8');
  assert.doesNotMatch(cargo, /sundials|ida|klu/i);
  const lockfile = readFileSync(join(ROOT, 'rust-core', 'Cargo.lock'), 'utf8');
  assert.doesNotMatch(lockfile, /sundials|ida|klu/i);
});

test('checked-in third-party notices preserve the locked upstream text', () => {
  const directory = join(ROOT, 'native-backends', 'sundials');
  const license = readFileSync(join(directory, 'LICENSE'));
  const notice = readFileSync(join(directory, 'NOTICE'));
  assert.equal(digest(license), SUNDIALS_SOURCE_LOCK.license.licenseFile.sha256);
  assert.equal(
    digest(notice.subarray(0, notice.at(-1) === 0x0a ? notice.length - 1 : notice.length)),
    SUNDIALS_SOURCE_LOCK.license.noticeFile.sha256,
    'Git-normalized final newline is the only permitted difference from upstream NOTICE',
  );
});
