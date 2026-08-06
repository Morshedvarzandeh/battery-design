// FMI 2.0 contract tests: pin the standard inputs, bind XML and C defaults,
// and compile both source/static and shared-library ABIs with strict warnings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { cellById } from '../js/cells.js';
import {
  buildFmu, FMI2_REQUIRED_CO_SIMULATION_SYMBOLS, FMI_STANDARD_VERSION,
  FMU_PARAMETERS, FMU_VARIABLES,
} from '../js/fmi.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDARD_ROOT = join(ROOT, 'third_party', `fmi-${FMI_STANDARD_VERSION}`);
const CELL = cellById('lg-inr18650-mj1');
const CUSTOM_PARAMS = { r0Ref: 42.5, rc1R: 13.25, rc1TauS: 27, r0EaJ: 23456 };

test('official FMI 2.0.5 headers and schemas stay pinned byte for byte', () => {
  const manifest = readFileSync(join(STANDARD_ROOT, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(manifest.length, 10);
  for (const line of manifest) {
    const match = /^([a-f0-9]{64})  ([^\\]+)$/.exec(line);
    assert.ok(match, `valid SHA256SUMS line: ${line}`);
    const file = resolve(STANDARD_ROOT, match[2]);
    assert.ok(file.startsWith(`${STANDARD_ROOT}/`), 'manifest path remains inside the pin');
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(digest, match[1], match[2]);
  }
});

test('modelDescription declares a complete scalar co-simulation contract', () => {
  const built = buildFmu({ cell: CELL, s: 110, p: 43, params: CUSTOM_PARAMS });
  const xml = built.files['modelDescription.xml'];
  assert.match(xml, /<CoSimulation[\s\S]*<SourceFiles>\s*<File name="BatteryPack\.c"\/>\s*<\/SourceFiles>/);
  assert.match(xml, /<DefaultExperiment startTime="0" stopTime="10" tolerance="0\.0001" stepSize="0\.1"\/>/);

  const outputBlock = xml.match(/<Outputs>([\s\S]*?)<\/Outputs>/)?.[1] || '';
  const initialBlock = xml.match(/<InitialUnknowns>([\s\S]*?)<\/InitialUnknowns>/)?.[1] || '';
  const expectedOutputs = FMU_VARIABLES.filter((variable) => variable.causality === 'output').length;
  assert.equal((outputBlock.match(/<Unknown index=/g) || []).length, expectedOutputs);
  assert.equal((initialBlock.match(/<Unknown index=/g) || []).length, expectedOutputs);
  assert.deepEqual(
    [...outputBlock.matchAll(/index="(\d+)"/g)].map((match) => match[1]),
    [...initialBlock.matchAll(/index="(\d+)"/g)].map((match) => match[1]),
  );

  assert.match(xml, /<Unit name="degC"><BaseUnit K="1" offset="273\.15"\/><\/Unit>/);
  assert.match(xml, /<Unit name="mOhm"><BaseUnit kg="1" m="2" s="-3" A="-2" factor="0\.001"\/><\/Unit>/);
  assert.match(xml, /name="r0_mOhm"[\s\S]*?<Real start="42\.5" unit="mOhm"\/>/);
  for (const variable of [...FMU_PARAMETERS, ...FMU_VARIABLES]) {
    assert.doesNotMatch(variable.name, /[.\[\]]/, `${variable.name} remains portable to strict commercial hosts`);
  }
});

test('one immutable defaults object binds XML, C, reset and content identity', () => {
  const built = buildFmu({ cell: CELL, s: 110, p: 43, params: CUSTOM_PARAMS });
  const same = buildFmu({ cell: CELL, s: 110, p: 43, params: { ...CUSTOM_PARAMS } });
  const calibrated = buildFmu({ cell: CELL, s: 110, p: 43, params: { ...CUSTOM_PARAMS, r0Ref: 42.6 } });
  const renamed = buildFmu({ cell: CELL, s: 110, p: 43, params: CUSTOM_PARAMS, modelName: 'BatteryPlant' });
  assert.ok(Object.isFrozen(built.defaults));
  assert.equal(built.defaults.cells_series, 110);
  assert.equal(built.defaults.cells_parallel, 43);
  assert.equal(built.defaults.capacity_Ah, CELL.capacityAh);
  assert.equal(built.defaults.r0_mOhm, 42.5);
  assert.equal(built.guid, same.guid, 'identical binary contracts reproduce their GUID');
  assert.notEqual(built.guid, calibrated.guid, 'a calibrated coefficient changes the GUID');
  assert.notEqual(built.guid, renamed.guid, 'the model identifier changes the GUID');
  assert.match(built.guid, /^\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/);

  const source = built.files['sources/BatteryPack.c'];
  assert.match(source, /#define DEFAULT_S\s+110\.0/);
  assert.match(source, /#define DEFAULT_P\s+43\.0/);
  assert.match(source, /#define DEFAULT_CAP_AH\s+3\.5/);
  assert.match(source, /#define DEFAULT_R0_MOHM\s+42\.5/);
  assert.match(source, /restore_start_values\(m\)/);
  assert.match(source, /#define FMI2_FUNCTION_PREFIX BatteryPack_/);
  for (const symbol of FMI2_REQUIRED_CO_SIMULATION_SYMBOLS) {
    assert.match(source, new RegExp(`\\b${symbol}\\b`), `${symbol} is implemented`);
  }
});

const ccProbe = spawnSync(process.env.CC || 'cc', ['--version'], { encoding: 'utf8' });
const nmProbe = spawnSync('nm', ['--version'], { encoding: 'utf8' });
const canCompile = process.platform === 'linux' && ccProbe.status === 0 && nmProbe.status === 0;

test('generated C compiles with strict warnings and both FMI naming modes', { skip: !canCompile }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-design-fmi-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'BatteryPack.c');
  const objectPath = join(dir, 'BatteryPack.o');
  const libraryPath = join(dir, 'BatteryPack.so');
  const headers = join(STANDARD_ROOT, 'headers');
  const built = buildFmu({ cell: CELL, s: 110, p: 43, params: CUSTOM_PARAMS });
  writeFileSync(sourcePath, built.files['sources/BatteryPack.c']);

  const common = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', `-I${headers}`];
  const sourceBuild = spawnSync(process.env.CC || 'cc', [...common, '-c', sourcePath, '-o', objectPath], { encoding: 'utf8' });
  assert.equal(sourceBuild.status, 0, `${sourceBuild.stdout}\n${sourceBuild.stderr}`);
  const sourceSymbols = spawnSync('nm', ['--defined-only', objectPath], { encoding: 'utf8' });
  assert.equal(sourceSymbols.status, 0, sourceSymbols.stderr);
  assert.match(sourceSymbols.stdout, /\bBatteryPack_fmi2Instantiate\b/,
    'source/static ABI uses the modelIdentifier prefix');

  const binaryBuild = spawnSync(process.env.CC || 'cc', [
    ...common, '-fPIC', '-fvisibility=hidden', '-shared', '-DFMI2_OVERRIDE_FUNCTION_PREFIX',
    sourcePath, '-Wl,--no-undefined', '-Wl,--build-id=none', '-o', libraryPath, '-lm',
  ], { encoding: 'utf8' });
  assert.equal(binaryBuild.status, 0, `${binaryBuild.stdout}\n${binaryBuild.stderr}`);
  const binarySymbols = spawnSync('nm', ['-D', '--defined-only', libraryPath], { encoding: 'utf8' });
  assert.equal(binarySymbols.status, 0, binarySymbols.stderr);
  const exported = new Set(binarySymbols.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).at(-1)));
  for (const symbol of FMI2_REQUIRED_CO_SIMULATION_SYMBOLS) assert.ok(exported.has(symbol), symbol);
  assert.ok(![...exported].some((symbol) => symbol.startsWith('BatteryPack_fmi2')),
    'shared-library ABI is unprefixed');
});
