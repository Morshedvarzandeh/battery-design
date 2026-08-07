#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMAND_TIMEOUT_MS = 180_000;
const HELPER_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const INSTALLED_LOCK = 'battery-design-sundials-source-lock.json';
const BUILD_RECEIPT = 'battery-design-sundials-build.json';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const helperPath = path.join(repositoryRoot, 'tools/build-sundials-ida.mjs');
const verifierPath = path.join(repositoryRoot, 'tools/verify-sundials-source.mjs');
const repositoryLockPath = path.join(
  repositoryRoot,
  'native-backends/sundials/source-lock.json',
);
const manifestPath = path.join(repositoryRoot, 'rust-dae-native/Cargo.toml');

const cliArguments = process.argv.slice(2);
const cliOptions = { archive: null, root: null };
for (let index = 0; index < cliArguments.length; index += 1) {
  const argument = cliArguments[index];
  if (argument !== '--archive' && argument !== '--root') {
    console.error(`unknown option: ${argument}`);
    process.exit(2);
  }
  const key = argument === '--archive' ? 'archive' : 'root';
  if (cliOptions[key] !== null) {
    console.error(`${argument} may be supplied only once`);
    process.exit(2);
  }
  const value = cliArguments[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${argument} requires a path`);
    process.exit(2);
  }
  cliOptions[key] = path.resolve(value);
  index += 1;
}
if (cliOptions.archive === null || cliOptions.root === null) {
  console.error('usage: node tools/test-native-dae-build.mjs --archive ARCHIVE --root GENUINE_SUNDIALS_INSTALL');
  process.exit(2);
}

function commandText(command, args) {
  return [command, ...args].map((value) => JSON.stringify(value)).join(' ');
}

function boundedOutput(result) {
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const lines = combined.split('\n');
  return lines.slice(-80).join('\n');
}

function run(command, args, { env = {}, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: timeoutMs,
  });
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutMs} ms`
      : result.error.message;
    throw new Error(`${commandText(command, args)} ${reason}\n${boundedOutput(result)}`);
  }
  if (result.signal || typeof result.status !== 'number') {
    throw new Error(
      `${commandText(command, args)} did not exit normally (signal ${result.signal ?? 'unknown'})\n${boundedOutput(result)}`,
    );
  }
  return result;
}

function requireSuccess(label, command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit ${result.status}: ${commandText(command, args)}\n${boundedOutput(result)}`,
    );
  }
  return result;
}

function requireFailure(label, command, args, patterns, options) {
  const result = run(command, args, options);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (result.status === 0) {
    throw new Error(`${label} unexpectedly succeeded: ${commandText(command, args)}\n${boundedOutput(result)}`);
  }
  if (!patterns.some((pattern) => pattern.test(output))) {
    throw new Error(
      `${label} failed for an unexpected reason (exit ${result.status}): ${commandText(command, args)}\n${boundedOutput(result)}`,
    );
  }
  console.log(`ok - ${label}`);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

async function canonicalJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const value = JSON.parse(raw);
  return { raw, value, canonical: `${JSON.stringify(value, null, 2)}\n` };
}

async function writeCanonicalJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label}: expected exactly one ${JSON.stringify(needle)}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
}

async function snapshotTree(root) {
  const records = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`verified install copy unexpectedly contains symlink ${relative}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`verified install copy contains unsupported entry ${relative}`);
      }
      const metadata = await lstat(absolute);
      records.push([
        relative.split(path.sep).join('/'),
        metadata.size,
        metadata.mode & 0o777,
        await sha256File(absolute),
      ]);
    }
  }
  await visit(root, '');
  return JSON.stringify(records);
}

function cargoEnvironment(installRoot, targetDirectory) {
  return {
    CARGO_INCREMENTAL: '0',
    CARGO_TARGET_DIR: targetDirectory,
    CARGO_TERM_COLOR: 'never',
    DAE_SUNDIALS_ROOT: installRoot,
    RUSTFLAGS: '-Dwarnings',
  };
}

const backendIdentityArguments = [
  'test',
  '--locked',
  '--manifest-path',
  manifestPath,
  '--features',
  'sundials-ida',
  '--test',
  'backend_identity',
  '--',
  '--test-threads=1',
];

function requireBackendIdentitySuccess(label, installRoot, targetDirectory) {
  requireSuccess(label, 'cargo', backendIdentityArguments, {
    env: cargoEnvironment(installRoot, targetDirectory),
  });
  console.log(`ok - ${label}`);
}

function requireBackendIdentityFailure(label, installRoot, targetDirectory, patterns) {
  requireFailure(label, 'cargo', backendIdentityArguments, patterns, {
    env: cargoEnvironment(installRoot, targetDirectory),
  });
}

async function copyInstall(genuineRoot, caseDirectory) {
  const installRoot = path.join(caseDirectory, 'install');
  await mkdir(caseDirectory, { recursive: false });
  await cp(genuineRoot, installRoot, {
    recursive: true,
    dereference: true,
    preserveTimestamps: false,
  });
  return installRoot;
}

function helperArguments(archive, installRoot) {
  return [helperPath, '--archive', archive, '--output', installRoot];
}

function requireHelperReuseFailure(label, archive, installRoot) {
  requireFailure(
    `${label} is refused by helper reuse`,
    process.execPath,
    helperArguments(archive, installRoot),
    [/refusing to overwrite an existing unverified output/u],
    { timeoutMs: HELPER_TIMEOUT_MS },
  );
}

async function proveGenuineHelperReuse(archive, genuineRoot, temporaryRoot) {
  const caseDirectory = path.join(temporaryRoot, '00-genuine-reuse');
  const installRoot = await copyInstall(genuineRoot, caseDirectory);
  const before = await snapshotTree(installRoot);
  const result = requireSuccess(
    'verified helper reuse',
    process.execPath,
    helperArguments(archive, installRoot),
    { timeoutMs: HELPER_TIMEOUT_MS },
  );
  assert.match(
    result.stdout,
    new RegExp(`^reusing verified SUNDIALS/IDA install: ${escapeRegExp(installRoot)}\\n$`, 'u'),
  );
  const after = await snapshotTree(installRoot);
  assert.equal(after, before, 'verified helper reuse changed install bytes or modes');
  console.log('ok - verified helper reuse is mutation-free');

  requireBackendIdentitySuccess(
    'genuine copied install links and reports backend identity',
    installRoot,
    path.join(caseDirectory, 'target'),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function proveDuplicateRepositoryLockRejected(archive, temporaryRoot) {
  const copiedRepository = path.join(temporaryRoot, '01-duplicate-repository-lock');
  const copiedHelper = path.join(copiedRepository, 'tools/build-sundials-ida.mjs');
  const copiedVerifier = path.join(copiedRepository, 'tools/verify-sundials-source.mjs');
  const copiedLock = path.join(
    copiedRepository,
    'native-backends/sundials/source-lock.json',
  );
  await mkdir(path.dirname(copiedHelper), { recursive: true });
  await mkdir(path.dirname(copiedLock), { recursive: true });
  await copyFile(helperPath, copiedHelper);
  await copyFile(verifierPath, copiedVerifier);
  await copyFile(repositoryLockPath, copiedLock);
  const lockRaw = await readFile(copiedLock, 'utf8');
  const needle = '  "project": "SUNDIALS",\n';
  await writeFile(
    copiedLock,
    replaceExactlyOnce(lockRaw, needle, `${needle}${needle}`, 'duplicate repository lock'),
    'utf8',
  );

  requireFailure(
    'duplicate-key repository lock is rejected before build or reuse',
    process.execPath,
    [
      copiedHelper,
      '--archive', archive,
      '--output', path.join(copiedRepository, 'must-not-be-created'),
    ],
    [/SUNDIALS source lock must be exact canonical JSON without duplicate keys or trailing data/u],
    { timeoutMs: HELPER_TIMEOUT_MS },
  );
}

const receiptRejected = [
  /cannot read pinned SUNDIALS build receipt/u,
  /is missing string key/u,
  /repeats string key/u,
  /is not the exact closed canonical SUNDIALS build receipt/u,
];

const attacks = [
  {
    slug: 'missing-installed-lock',
    label: 'missing installed lock',
    mutate: async (root) => unlink(path.join(root, INSTALLED_LOCK)),
    cargoDiagnostics: [/cannot read pinned SUNDIALS source lock/u],
  },
  {
    slug: 'replaced-installed-lock',
    label: 'replaced installed lock',
    mutate: async (root) => writeFile(path.join(root, INSTALLED_LOCK), 'replacement lock\n', 'utf8'),
    cargoDiagnostics: [/does not exactly match the repository SUNDIALS source lock/u],
  },
  {
    slug: 'missing-receipt',
    label: 'missing build receipt',
    mutate: async (root) => unlink(path.join(root, BUILD_RECEIPT)),
    cargoDiagnostics: [/cannot read pinned SUNDIALS build receipt/u],
  },
  {
    slug: 'replaced-receipt',
    label: 'replaced build receipt',
    mutate: async (root) => writeFile(path.join(root, BUILD_RECEIPT), '{"format":"replacement"}\n', 'utf8'),
    cargoDiagnostics: receiptRejected,
  },
  {
    slug: 'unknown-receipt-field',
    label: 'unknown receipt field',
    mutate: async (root) => {
      const receiptPath = path.join(root, BUILD_RECEIPT);
      const { value } = await canonicalJson(receiptPath);
      value.unexpected = 'must be rejected';
      await writeCanonicalJson(receiptPath, value);
    },
    cargoDiagnostics: receiptRejected,
  },
  {
    slug: 'duplicate-receipt-key',
    label: 'duplicate receipt key',
    mutate: async (root) => {
      const receiptPath = path.join(root, BUILD_RECEIPT);
      const raw = await readFile(receiptPath, 'utf8');
      const needle = '  "solver": "SUNDIALS",\n';
      await writeFile(
        receiptPath,
        replaceExactlyOnce(raw, needle, `${needle}${needle}`, 'duplicate receipt'),
        'utf8',
      );
    },
    cargoDiagnostics: receiptRejected,
  },
  {
    slug: 'wrong-nested-receipt',
    label: 'wrong-nested receipt artifacts',
    mutate: async (root) => {
      const receiptPath = path.join(root, BUILD_RECEIPT);
      const { value } = await canonicalJson(receiptPath);
      value.build.artifacts = value.artifacts;
      delete value.artifacts;
      await writeCanonicalJson(receiptPath, value);
    },
    cargoDiagnostics: receiptRejected,
  },
  {
    slug: 'trailing-receipt-data',
    label: 'trailing receipt data',
    mutate: async (root) => appendFile(path.join(root, BUILD_RECEIPT), '{}\n', 'utf8'),
    cargoDiagnostics: receiptRejected,
  },
  {
    slug: 'extra-archive',
    label: 'extra static archive',
    mutate: async (root) => writeFile(
      path.join(root, 'lib/libsundials_unapproved.a'),
      Buffer.from('!<arch>\n', 'ascii'),
    ),
    cargoDiagnostics: [/must contain exactly libsundials_core\.a and libsundials_ida\.a/u],
  },
  {
    slug: 'changed-archive',
    label: 'changed IDA archive with stale receipt',
    mutate: async (root) => appendFile(
      path.join(root, 'lib/libsundials_ida.a'),
      Buffer.from([0]),
    ),
    cargoDiagnostics: receiptRejected,
  },
  {
    slug: 'self-consistent-empty-ida',
    label: 'self-consistent empty IDA archive fails the real backend identity link',
    helperMustReject: false,
    mutate: async (root) => {
      const idaArchive = path.join(root, 'lib/libsundials_ida.a');
      await writeFile(idaArchive, Buffer.from('!<arch>\n', 'ascii'));
      const receiptPath = path.join(root, BUILD_RECEIPT);
      const { value } = await canonicalJson(receiptPath);
      value.artifacts.idaArchiveSha256 = await sha256File(idaArchive);
      await writeCanonicalJson(receiptPath, value);
    },
    cargoDiagnostics: [
      /undefined reference to [`'](?:IDACreate|IDAInit|SUNContext_Create|SUNDIALSGetVersion)/u,
      /(?:IDACreate|IDAInit|SUNContext_Create|SUNDIALSGetVersion).*undefined reference/u,
    ],
  },
];

async function runAttackMatrix(archive, genuineRoot, temporaryRoot) {
  let index = 2;
  for (const attack of attacks) {
    const caseDirectory = path.join(
      temporaryRoot,
      `${String(index).padStart(2, '0')}-${attack.slug}`,
    );
    index += 1;
    const installRoot = await copyInstall(genuineRoot, caseDirectory);
    await attack.mutate(installRoot);
    if (attack.helperMustReject !== false) {
      requireHelperReuseFailure(attack.label, archive, installRoot);
    }
    requireBackendIdentityFailure(
      attack.label,
      installRoot,
      path.join(caseDirectory, 'target'),
      attack.cargoDiagnostics,
    );
  }
}

async function removeTemporaryRoot(temporaryRoot) {
  const realTemporaryParent = await realpath(tmpdir());
  const realTemporaryRoot = await realpath(temporaryRoot);
  if (
    path.dirname(realTemporaryRoot) !== realTemporaryParent
    || !path.basename(realTemporaryRoot).startsWith('battery-design-native-dae-')
  ) {
    throw new Error(`refusing to remove unexpected temporary root ${realTemporaryRoot}`);
  }
  await rm(realTemporaryRoot, { recursive: true, force: false });
}

async function main() {
  const archive = await realpath(cliOptions.archive);
  if (!(await stat(archive)).isFile()) {
    throw new Error(`genuine archive is not a file: ${archive}`);
  }
  const genuineRoot = await realpath(cliOptions.root);
  if (!(await stat(genuineRoot)).isDirectory()) {
    throw new Error(`genuine install is not a directory: ${genuineRoot}`);
  }
  for (const relative of [
    INSTALLED_LOCK,
    BUILD_RECEIPT,
    'lib/libsundials_ida.a',
    'lib/libsundials_core.a',
  ]) {
    if (!(await stat(path.join(genuineRoot, relative))).isFile()) {
      throw new Error(`genuine install is missing ${relative}`);
    }
  }

  const repositoryLock = await canonicalJson(repositoryLockPath);
  assert.equal(
    repositoryLock.raw,
    repositoryLock.canonical,
    'repository SUNDIALS source lock is not exact canonical JSON',
  );

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-design-native-dae-'));
  try {
    if (
      temporaryRoot === genuineRoot
      || temporaryRoot.startsWith(`${genuineRoot}${path.sep}`)
    ) {
      throw new Error(
        `genuine install must not contain the harness temporary root: ${genuineRoot}`,
      );
    }
    await proveGenuineHelperReuse(archive, genuineRoot, temporaryRoot);
    await proveDuplicateRepositoryLockRejected(archive, temporaryRoot);
    await runAttackMatrix(archive, genuineRoot, temporaryRoot);
    console.log(
      `native DAE provenance harness passed: helper reuse, source-lock canonicality, and ${attacks.length} install attacks`,
    );
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
