// Native FMU artifact: compile, inspect, drive through the FMI lifecycle, and
// prove byte-for-byte deterministic packaging without third-party runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { cellById } from '../js/cells.js';
import { buildFmu } from '../js/fmi.js';
import {
  auditFmuTree, compileNativeBinary, packageFmu,
} from '../tools/fmu-build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CELL = cellById('lg-inr18650-mj1');
const pythonAvailable = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const prerequisites = ['cc', 'nm', 'file', 'ldd', 'python3']
  .every((command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
const canRun = process.platform === 'linux' && prerequisites;

function sourceTree(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-native-fmu-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const tree = join(temporary, 'tree');
  const built = buildFmu({
    cell: CELL,
    s: 110,
    p: 43,
    params: { r0Ref: 42.5, rc1R: 13.25, rc1TauS: 27, r0EaJ: 23456 },
  });
  for (const [relativePath, content] of Object.entries(built.files)) {
    const path = join(tree, ...relativePath.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { temporary, tree, built };
}

test('native linux64 FMU builds reproducibly and passes a real consumer lifecycle', { skip: !canRun }, (t) => {
  const { temporary, tree, built } = sourceTree(t);
  const native = compileNativeBinary({
    tree, platform: 'linux64', reproducible: true, maxGlibc: '99.0',
  });
  assert.equal(native.platform, 'linux64');
  assert.ok(native.size > 10_000);
  assert.equal(native.runtime.enforcedGlibcCeiling, '99.0');
  assert.equal(native.symbols.length, 34, 'only the complete public FMI 2.0 Co-Simulation ABI is exported');

  const treeSmoke = spawnSync('python3', [join(ROOT, 'tools', 'fmu-smoke.py'), tree, '--platform', 'linux64'], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(treeSmoke.status, 0, `${treeSmoke.stdout}\n${treeSmoke.stderr}`);
  const lifecycle = JSON.parse(treeSmoke.stdout);
  assert.equal(lifecycle.guid, built.guid);
  assert.equal(lifecycle.parameterStartsChecked, 17);
  assert.ok(lifecycle.discharged.SoC < lifecycle.initial.SoC);
  assert.ok(lifecycle.discharged.V_pack < lifecycle.initial.V_pack);

  const firstPath = join(temporary, 'battery-design-ev.fmu');
  const secondPath = join(temporary, 'battery-design-ev-second.fmu');
  const packageOptions = { requiredPlatforms: ['linux64'], maxGlibc: '99.0' };
  const first = packageFmu({ tree, output: firstPath, ...packageOptions });
  const second = packageFmu({ tree, output: secondPath, ...packageOptions });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(readFileSync(firstPath), readFileSync(secondPath), 'the complete .fmu is byte reproducible');
  assert.deepEqual(first.binaries, ['linux64']);
  assert.ok(first.files.includes('modelDescription.xml'));
  assert.ok(first.files.includes('binaries/linux64/BatteryPack.so'));
  assert.ok(first.files.includes('resources/battery-design-build.json'));
  assert.ok(first.files.includes('documentation/source-build.md'));
  assert.match(readFileSync(join(tree, 'README.md'), 'utf8'), /This is a loadable battery-design FMU/);
  assert.match(readFileSync(join(tree, 'documentation', 'source-build.md'), 'utf8'), /source-FMU build kit/);
  assert.ok(first.files.every((path) => !path.startsWith('tree/') && !path.startsWith('./')),
    'modelDescription.xml and all package directories are at the archive root');
  assert.deepEqual(auditFmuTree(tree).binaries, ['linux64']);
  assert.throws(
    () => packageFmu({ tree, output: join(temporary, 'missing-win64.fmu'), requiredPlatforms: ['linux64', 'win64'] }),
    /missing required native platforms: win64/,
  );

  const archiveSmoke = spawnSync('python3', [join(ROOT, 'tools', 'fmu-smoke.py'), firstPath, '--platform', 'linux64'], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(archiveSmoke.status, 0, `${archiveSmoke.stdout}\n${archiveSmoke.stderr}`);
  assert.equal(JSON.parse(archiveSmoke.stdout).guid, built.guid);

  const binaryPath = join(tree, 'binaries', 'linux64', 'BatteryPack.so');
  const originalBinary = readFileSync(binaryPath);
  const tamperedBinary = Buffer.from(originalBinary);
  tamperedBinary[tamperedBinary.length - 1] ^= 0xff;
  writeFileSync(binaryPath, tamperedBinary);
  assert.throws(
    () => packageFmu({ tree, output: join(temporary, 'tampered.fmu') }),
    /does not match its native inspection record/,
    'packaging revalidates each native-runner inspection hash',
  );
  writeFileSync(binaryPath, originalBinary);
});

test('FMU extraction rejects aliasing paths and excessive member counts', { skip: !pythonAvailable }, (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-malicious-fmu-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const duplicate = join(temporary, 'duplicate.fmu');
  const crowded = join(temporary, 'crowded.fmu');
  const create = spawnSync('python3', ['-c', `
import sys, warnings, zipfile
warnings.simplefilter('ignore')
with zipfile.ZipFile(sys.argv[1], 'w') as package:
    package.writestr('a/b', b'first')
    package.writestr('a//b', b'second')
with zipfile.ZipFile(sys.argv[2], 'w') as package:
    for index in range(257):
        package.writestr(f'f{index}', b'x')
`, duplicate, crowded], { encoding: 'utf8' });
  assert.equal(create.status, 0, `${create.stdout}\n${create.stderr}`);

  const duplicateSmoke = spawnSync('python3', [join(ROOT, 'tools', 'fmu-smoke.py'), duplicate], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.notEqual(duplicateSmoke.status, 0);
  assert.match(duplicateSmoke.stderr, /Unsafe FMU archive member/);

  const crowdedSmoke = spawnSync('python3', [join(ROOT, 'tools', 'fmu-smoke.py'), crowded], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.notEqual(crowdedSmoke.status, 0);
  assert.match(crowdedSmoke.stderr, /more than 256 members/);
});
