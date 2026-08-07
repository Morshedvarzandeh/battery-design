#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFile, cp, lstat, mkdtemp, readFile, readdir, rm, symlink,
  unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'tools/build-sundials-ida-klu.mjs');
const RECEIPT = 'battery-design-native-dae-klu-build.json';
const SUNDIALS_LOCK = 'battery-design-sundials-source-lock.json';
const SUITESPARSE_LOCK = 'battery-design-suitesparse-source-lock.json';
const TIMEOUT_MS = 90_000;
const MAX_BUFFER = 16 * 1024 * 1024;

function parseCli(arguments_) {
  const values = { sundialsArchive: null, suiteSparseArchive: null, root: null };
  const options = {
    '--sundials-archive': 'sundialsArchive',
    '--suitesparse-archive': 'suiteSparseArchive',
    '--root': 'root',
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const key = options[option];
    if (!key) throw new Error(`unknown option: ${option}`);
    if (values[key] !== null) throw new Error(`${option} may appear only once`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a path`);
    values[key] = resolve(value);
    index += 1;
  }
  if (Object.values(values).some((value) => value === null)) {
    throw new Error(
      'usage: node tools/test-native-dae-klu-build.mjs --sundials-archive ARCHIVE --suitesparse-archive ARCHIVE --root GENUINE_ROOT',
    );
  }
  if (values.root === resolve(sep)) throw new Error('--root must not be filesystem root');
  return Object.freeze(values);
}

function runHelper(options, output) {
  return spawnSync(process.execPath, [
    HELPER,
    '--sundials-archive', options.sundialsArchive,
    '--suitesparse-archive', options.suiteSparseArchive,
    '--output', output,
  ], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
}

function boundedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .trim()
    .split(/\r?\n/u)
    .slice(-50)
    .join('\n');
}

function requireSuccess(label, result) {
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message ?? result.signal ?? result.status}\n${boundedOutput(result)}`);
  }
}

function requireClosedFailure(label, result) {
  if (result.error || result.signal || typeof result.status !== 'number') {
    throw new Error(`${label} did not exit normally: ${result.error?.message ?? result.signal}`);
  }
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded\n${boundedOutput(result)}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /refusing to overwrite or trust existing output/u,
    `${label} failed outside the governed reuse boundary`,
  );
  console.log(`ok - ${label}`);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function snapshotTree(root) {
  const records = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = join(relativeDirectory, entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`genuine root contains symlink ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const metadata = await lstat(absolute);
        records.push([
          relative.split(sep).join('/'), metadata.size, metadata.mode & 0o777,
          await sha256(absolute),
        ]);
      } else {
        throw new Error(`genuine root contains unsupported entry ${relative}`);
      }
    }
  }
  await visit(root, '');
  return JSON.stringify(records);
}

async function copyRoot(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: false,
    errorOnExist: true,
    force: false,
  });
}

async function receipt(root) {
  return JSON.parse(await readFile(join(root, RECEIPT), 'utf8'));
}

async function writeReceipt(root, value) {
  await writeFile(join(root, RECEIPT), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function updateArtifactHash(root, name) {
  const value = await receipt(root);
  value.artifacts[name] = await sha256(join(root, 'lib', name));
  await writeReceipt(root, value);
}

function replaceExactlyOnce(text, needle, replacement, label) {
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label} expected exactly one ${JSON.stringify(needle)}`);
  }
  return `${text.slice(0, first)}${replacement}${text.slice(first + needle.length)}`;
}

const attacks = [
  {
    slug: 'missing-sundials-lock', label: 'missing installed SUNDIALS lock',
    mutate: (root) => unlink(join(root, SUNDIALS_LOCK)),
  },
  {
    slug: 'changed-sundials-lock', label: 'changed installed SUNDIALS lock',
    mutate: (root) => writeFile(join(root, SUNDIALS_LOCK), '{}\n'),
  },
  {
    slug: 'missing-suitesparse-lock', label: 'missing installed SuiteSparse lock',
    mutate: (root) => unlink(join(root, SUITESPARSE_LOCK)),
  },
  {
    slug: 'symlink-suitesparse-lock', label: 'symlinked installed SuiteSparse lock',
    mutate: async (root) => {
      const path = join(root, SUITESPARSE_LOCK);
      await unlink(path);
      await symlink(SUNDIALS_LOCK, path);
    },
  },
  {
    slug: 'missing-receipt', label: 'missing @2 receipt',
    mutate: (root) => unlink(join(root, RECEIPT)),
  },
  {
    slug: 'malformed-receipt', label: 'malformed @2 receipt',
    mutate: (root) => writeFile(join(root, RECEIPT), '{'),
  },
  {
    slug: 'unknown-receipt-field', label: 'unknown @2 receipt root field',
    mutate: async (root) => {
      const value = await receipt(root); value.unreviewed = true; await writeReceipt(root, value);
    },
  },
  {
    slug: 'duplicate-receipt-key', label: 'duplicate @2 receipt key',
    mutate: async (root) => {
      const path = join(root, RECEIPT);
      const raw = await readFile(path, 'utf8');
      const needle = '  "backend": "SUNDIALS/IDA+SuiteSparse/KLU",\n';
      await writeFile(path, replaceExactlyOnce(raw, needle, `${needle}${needle}`, 'receipt duplicate'));
    },
  },
  {
    slug: 'trailing-receipt-data', label: 'trailing @2 receipt data',
    mutate: (root) => appendFile(join(root, RECEIPT), '\n'),
  },
  {
    slug: 'backend-drift', label: 'receipt backend drift',
    mutate: async (root) => {
      const value = await receipt(root); value.backend = 'dense'; await writeReceipt(root, value);
    },
  },
  {
    slug: 'source-digest-drift', label: 'receipt source digest drift',
    mutate: async (root) => {
      const value = await receipt(root);
      value.sources.suitesparse.archiveSha256 = '0'.repeat(64);
      await writeReceipt(root, value);
    },
  },
  {
    slug: 'klu-disabled-receipt', label: 'receipt KLU disablement',
    mutate: async (root) => {
      const value = await receipt(root); value.build.klu = false; await writeReceipt(root, value);
    },
  },
  {
    slug: 'component-version-drift', label: 'receipt KLU component drift',
    mutate: async (root) => {
      const value = await receipt(root); value.components.KLU = '2.3.4'; await writeReceipt(root, value);
    },
  },
  {
    slug: 'missing-artifact-identity', label: 'missing receipt artifact identity',
    mutate: async (root) => {
      const value = await receipt(root); delete value.artifacts['libklu.a']; await writeReceipt(root, value);
    },
  },
  {
    slug: 'extra-header-identity', label: 'extra receipt header identity',
    mutate: async (root) => {
      const value = await receipt(root); value.headers['include/extra.h'] = '0'.repeat(64); await writeReceipt(root, value);
    },
  },
  {
    slug: 'unsafe-toolchain', label: 'unsafe receipt toolchain identity',
    mutate: async (root) => {
      const value = await receipt(root); value.toolchain.linker = 'ld\nforged'; await writeReceipt(root, value);
    },
  },
  {
    slug: 'reintroduced-nvecserial-archive', label: 'reintroduced redundant nvecserial archive',
    mutate: (root) => writeFile(join(root, 'lib/libsundials_nvecserial.a'), '!<arch>\n'),
  },
  {
    slug: 'missing-klu-archive', label: 'missing KLU archive',
    mutate: (root) => unlink(join(root, 'lib/libklu.a')),
  },
  {
    slug: 'changed-amd-archive', label: 'changed AMD archive',
    mutate: (root) => appendFile(join(root, 'lib/libamd.a'), 'drift'),
  },
  {
    slug: 'symlinked-btf-archive', label: 'symlinked BTF archive',
    mutate: async (root) => {
      const path = join(root, 'lib/libbtf.a'); await unlink(path); await symlink('libamd.a', path);
    },
  },
  {
    slug: 'self-consistent-empty-klu', label: 'self-consistent empty KLU archive',
    mutate: async (root) => {
      await writeFile(join(root, 'lib/libklu.a'), '!<arch>\n'); await updateArtifactHash(root, 'libklu.a');
    },
  },
  {
    slug: 'self-consistent-empty-sunlinsolklu',
    label: 'self-consistent empty SUNDIALS KLU adapter archive',
    mutate: async (root) => {
      await writeFile(join(root, 'lib/libsundials_sunlinsolklu.a'), '!<arch>\n');
      await updateArtifactHash(root, 'libsundials_sunlinsolklu.a');
    },
  },
  {
    slug: 'changed-klu-header', label: 'changed KLU header',
    mutate: (root) => appendFile(join(root, 'include/suitesparse/klu.h'), '\n/* drift */\n'),
  },
  {
    slug: 'missing-sundials-config', label: 'missing SUNDIALS config header',
    mutate: (root) => unlink(join(root, 'include/sundials/sundials_config.h')),
  },
  {
    slug: 'changed-sundials-license', label: 'changed SUNDIALS license',
    mutate: (root) => appendFile(join(root, 'share/licenses/sundials/LICENSE'), '\ndrift\n'),
  },
  {
    slug: 'missing-klu-lgpl', label: 'missing KLU full LGPL text',
    mutate: (root) => unlink(join(root, 'share/licenses/suitesparse/KLU-LGPL-2.1.txt')),
  },
  {
    slug: 'symlinked-btf-lgpl', label: 'symlinked BTF full LGPL text',
    mutate: async (root) => {
      const path = join(root, 'share/licenses/suitesparse/BTF-LGPL-2.1.txt');
      await unlink(path); await symlink('KLU-LGPL-2.1.txt', path);
    },
  },
  {
    slug: 'reintroduced-sunmatrixsparse-archive',
    label: 'reintroduced redundant sunmatrixsparse archive',
    mutate: (root) => writeFile(join(root, 'lib/libsundials_sunmatrixsparse.a'), '!<arch>\n'),
  },
];

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  assert.ok(attacks.length >= 22, 'attack campaign must contain at least 22 cases');
  const workspace = await mkdtemp(join(tmpdir(), 'battery-design-klu-attacks-'));
  try {
    const genuineCopy = join(workspace, '00-genuine');
    await copyRoot(options.root, genuineCopy);
    const before = await snapshotTree(genuineCopy);
    const positive = runHelper(options, genuineCopy);
    requireSuccess('verified helper reuse', positive);
    assert.equal(await snapshotTree(genuineCopy), before, 'helper reuse mutated genuine install');
    assert.match(positive.stdout, /^reusing verified SUNDIALS\/IDA\+KLU install:/mu);
    console.log('ok - verified @2 helper reuse is mutation-free and reruns the sparse probe');

    for (let index = 0; index < attacks.length; index += 1) {
      const attack = attacks[index];
      const install = join(workspace, `${String(index + 1).padStart(2, '0')}-${attack.slug}`);
      await copyRoot(options.root, install);
      await attack.mutate(install);
      requireClosedFailure(attack.label, runHelper(options, install));
    }
    console.log(`SUNDIALS/IDA+KLU governed attack campaign passed: ${attacks.length} attacks`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`SUNDIALS/IDA+KLU attack campaign failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
