// Release wiring is part of the FMU contract: the downloadable file must be
// the exact two-platform artifact that native jobs inspected and host-tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { designFromSpec } from '../js/api.js';
import {
  DESIGN_SPEC_SCHEMA_VERSION, normalizeDesignSpec, validateDesignSpec,
} from '../js/design-spec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const RELEASE_SPEC_PATH = 'fmi/battery-design-ev.design-spec.json';

test('checked-in EV DesignSpec is strict, warning-free and pins the reference topology', () => {
  const input = JSON.parse(read(RELEASE_SPEC_PATH));
  assert.equal(input.schemaVersion, DESIGN_SPEC_SCHEMA_VERSION);
  assert.deepEqual({
    nominalV: input.nominalV,
    continuousPowerW: input.contPowerW,
    peakPowerW: input.peakPowerW,
    chargeRateC: input.chargeRateC,
    ambientC: input.ambientC,
    deliveredWh: input.deliveredWh,
    linkFuseA: input.linkFuseA,
    cyclesPerYear: input.cyclesPerYear,
    targetYears: input.targetYears,
  }, {
    nominalV: 400,
    continuousPowerW: 50_000,
    peakPowerW: 150_000,
    chargeRateC: 0.48,
    ambientC: [-20, 50],
    deliveredWh: 48_000,
    linkFuseA: 15,
    cyclesPerYear: 100,
    targetYears: 10,
  }, 'release-critical preset requirements are explicit rather than inherited');
  assert.deepEqual({
    cooling: input.components.cooling,
    tim: input.components.tim,
    thermalLoop: input.thermal.loopOverride,
    rowExtraMm: input.layout.rowExtraMm,
  }, {
    cooling: 'serpentine-ribbon',
    tim: 'thermal-epoxy',
    thermalLoop: 'liquid-chiller',
    rowExtraMm: 2,
  }, 'the checked design pairs its liquid loop with hardware that physically fits');
  const validation = validateDesignSpec(input, { closed: true });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.throws(
    () => normalizeDesignSpec({ ...input, enrgyWh: 60_000 }, { strict: true, closed: true }),
    /\$\.enrgyWh: Field is not declared by the governed DesignSpec schema/,
    'a governed top-level typo cannot silently select an energy default',
  );
  assert.throws(
    () => normalizeDesignSpec({
      ...input, layout: { ...input.layout, arrangment: 'hex' },
    }, { strict: true, closed: true }),
    /\$\.layout\.arrangment: Field is not declared by the governed DesignSpec schema/,
    'a governed nested typo cannot silently select a layout default',
  );
  assert.doesNotThrow(
    () => normalizeDesignSpec({ ...input, customerExtension: { id: 'retained' } }, { strict: true }),
    'ordinary strict validation remains extension-tolerant for backwards compatibility',
  );
  const spec = normalizeDesignSpec(input, { strict: true, closed: true });
  const design = designFromSpec(spec);
  assert.deepEqual(design.warnings, []);
  assert.deepEqual(design.findings.filter(({ severity }) => severity === 'fail'), [],
    'the pinned interoperability reference contains no known physical blocker');
  assert.equal(design.cell.id, 'lg-inr18650-mj1');
  assert.equal(design.pack.s, 110);
  assert.equal(design.pack.p, 43);
  assert.equal(design.pack.cellCount, 4730);
  assert.ok(Math.abs(design.pack.energyWh - 60_177.425) < 1e-9);
  assert.ok(Math.abs(design.pack.massKg - 297.16) < 1e-9);
  assert.deepEqual(design.pack.dims, {
    x: 1254.3,
    y: 1394.8651768395218,
    z: 77,
  });
  assert.equal(design.architecture.partition.sMod, 11);
  assert.equal(design.architecture.partition.nModules, 10);
  assert.equal(design.thermal.loopId, 'liquid-chiller');
  assert.equal(design.charging.obc.id, 'obc-22k');
  assert.equal(design.spec.resolved.sizing.profileId, 'wltp-ev');
  assert.equal(design.spec.resolved.layout.arrangement, 'hex');
});

test('FMU CLI accepts one strict spec, rejects ambiguous merges, and preserves legacy flags', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-fmu-spec-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const specOutput = join(temporary, 'from-spec');
  const specRun = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--spec', RELEASE_SPEC_PATH, '--out', specOutput,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(specRun.status, 0, `${specRun.stdout}\n${specRun.stderr}`);
  assert.ok(existsSync(join(specOutput, 'modelDescription.xml')));
  assert.match(specRun.stdout, /110S43P/);
  assert.match(specRun.stdout, /complete design binding/);
  assert.equal(JSON.parse(readFileSync(join(
    specOutput, 'resources', 'battery-design-design.json'), 'utf8')).snapshot.source.complete, true);

  const conflictOutput = join(temporary, 'conflict');
  const conflict = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--spec', RELEASE_SPEC_PATH, '--energy', '60000',
    '--out', conflictOutput,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /--spec cannot be combined with design-shaping flags: --energy/);
  assert.equal(existsSync(conflictOutput), false, 'conflict fails before writing an export tree');

  const invalidPath = join(temporary, 'invalid.design-spec.json');
  writeFileSync(invalidPath, JSON.stringify({
    schemaVersion: DESIGN_SPEC_SCHEMA_VERSION, application: 'ev', s: '110',
  }));
  const invalid = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--spec', invalidPath, '--out', join(temporary, 'invalid'),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /DesignSpec is invalid:[\s\S]*\$\.s/);

  const warningPath = join(temporary, 'warning.design-spec.json');
  writeFileSync(warningPath, JSON.stringify({
    ...JSON.parse(read(RELEASE_SPEC_PATH)), cell: 'misspelled-cell-id',
  }));
  const warning = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--spec', warningPath, '--out', join(temporary, 'warning'),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(warning.status, 2);
  assert.match(warning.stderr, /governed DesignSpec did not resolve exactly:[\s\S]*Unknown cell/);

  const unknownOption = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--spec', RELEASE_SPEC_PATH, '--enrgy', '999999',
    '--out', join(temporary, 'unknown-option'),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(unknownOption.status, 2);
  assert.match(unknownOption.stderr, /fmu does not accept option\(s\): --enrgy/);
  assert.equal(existsSync(join(temporary, 'unknown-option')), false);

  const duplicateOption = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--spec', RELEASE_SPEC_PATH, '--name', 'First',
    '--name', 'Second', '--out', join(temporary, 'duplicate-option'),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(duplicateOption.status, 2);
  assert.match(duplicateOption.stderr, /fmu option\(s\) may be supplied only once: --name/);
  assert.equal(existsSync(join(temporary, 'duplicate-option')), false);

  const legacyParamsPath = join(temporary, 'legacy-params.json');
  writeFileSync(legacyParamsPath, JSON.stringify({ rc2R: 123, typo: 1 }));
  const governedParams = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--spec', RELEASE_SPEC_PATH, '--params', legacyParamsPath,
    '--out', join(temporary, 'governed-unmapped-params'),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(governedParams.status, 2);
  assert.match(governedParams.stderr,
    /parameter overrides are not represented by the reduced one-RC component: rc2R, typo/);
  assert.equal(existsSync(join(temporary, 'governed-unmapped-params')), false);

  const legacyOutput = join(temporary, 'legacy');
  const legacy = spawnSync(process.execPath, [
    'desktop/bd.mjs', 'fmu', '--app', 'ev', '--energy', '60000',
    '--params', legacyParamsPath, '--out', legacyOutput,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(legacy.status, 0, `${legacy.stdout}\n${legacy.stderr}`);
  assert.ok(existsSync(join(legacyOutput, 'modelDescription.xml')));
  assert.match(legacy.stdout, /110S43P/);
  assert.match(legacy.stdout, /legacy incomplete provenance/);
  assert.match(legacy.stdout, /warning: rc2R: ignored because it is not represented/);
  assert.match(legacy.stdout, /warning: typo: ignored because it is not represented/);
  assert.equal(JSON.parse(readFileSync(join(
    legacyOutput, 'resources', 'battery-design-design.json'), 'utf8')).snapshot.source.complete, false,
    'legacy flags remain numerical but cannot satisfy the governed complete-design binding gate');
});

test('the reusable FMU workflow builds one exact Linux/Windows release artifact', () => {
  const workflow = read('.github/workflows/fmu.yml');
  assert.match(workflow, /workflow_call:[\s\S]*?ref:[\s\S]*?required: true/);
  assert.match(workflow,
    /node desktop\/bd\.mjs fmu --spec fmi\/battery-design-ev\.design-spec\.json --out "\$FMI_TREE"/);
  assert.doesNotMatch(workflow, /desktop\/bd\.mjs fmu --app ev --energy 60000/);
  assert.match(workflow, /manylinux2014_x86_64:2026\.08\.05-1@sha256:5573110c10bbea40239d80e449f4a02d2773c5d2c0edc27c17307c421816b760/);
  assert.match(workflow, /inspect --tree "\$FMI_TREE" --platform linux64 --max-glibc 2\.17 --record/);
  assert.match(workflow, /--platform win64 --reproducible/);
  assert.equal((workflow.match(/fmu-build\.mjs package[^\n]*--require-complete-design/g) || []).length, 3,
    'every Windows and final release package rejects legacy cell/S/P provenance');
  assert.equal((workflow.match(/fmu-build\.mjs package[^\n]*--require-source-revision/g) || []).length, 3,
    'every Windows and final release package requires the trusted checked-out commit SHA');
  assert.match(workflow, /FMI_VCVARS64=[\s\S]*?call "\$env:FMI_VCVARS64"[\s\S]*?fmu-build\.mjs package/,
    'Windows packaging re-enters the MSVC environment needed for dumpbin reinspection');
  assert.equal((workflow.match(/include-hidden-files: true/g) || []).length, 2,
    'both native jobs preserve their hidden inspection records');
  assert.match(workflow, /BATTERY_DESIGN_SOURCE_REVISION/);
  assert.match(workflow,
    /--require-platforms linux64,win64 --max-glibc 2\.17 --require-complete-design --require-source-revision/);
  assert.match(workflow, /cmp "\$first" dist\/battery-design-ev\.fmu/);
  assert.match(workflow, /\(cd dist && sha256sum battery-design-ev\.fmu > battery-design-ev\.fmu\.sha256\)/);
  assert.match(workflow, /name: battery-design-ev-fmu/);
  assert.doesNotMatch(workflow, /aarch64-darwin/);
  for (const [, action] of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
    assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40}$/,
      `third-party workflow action must be pinned by commit: ${action}`);
  }
});

test('matching native hosts and pinned independent validators gate the FMU', () => {
  const workflow = read('.github/workflows/fmu.yml');
  const fmpyLock = read('tools/fmpy-validation-requirements.txt');
  const fmpySmoke = read('tools/fmpy-smoke.py');
  assert.match(workflow, /FMUSIM_LINUX_SHA256: 1854e6ad2b92765db682ba690530d227f0924e14ed12ecb16bd8e06fbe2affa2/);
  assert.match(workflow, /FMUSIM_WINDOWS_SHA256: ffb2a1cb1ba8fb3500244ee3c7646b18b4cabbe0b25a3d08ca9e24a240f50ac9/);
  assert.match(workflow, /package:\n    name: Assemble and independently validate compiled FMU\n    needs: \[source, linux64, win64\][\s\S]*?runs-on: ubuntu-24\.04/,
    'the official Linux fmusim validator runs on its GLIBC 2.39 baseline');
  assert.match(fmpyLock, /FMPy==0\.3\.30[\s\S]*?c2e2e4fb2b78dafcb5c9773f8946fce29f02f5d0f2c61699c249cf0fe8391f93/);
  assert.equal((fmpyLock.match(/^\s*--hash=sha256:/gm) || []).length, 7,
    'every cross-platform FMPy runtime wheel is hash locked');
  assert.equal((workflow.match(/--require-hashes/g) || []).length, 4,
    'both hosts hash-check downloads and install only from the verified wheelhouse');
  assert.match(fmpySmoke, /fmi-2\.0\.5[\s\S]*?fmi2ModelDescription\.xsd[\s\S]*?schema\.assertValid/,
    'the independent host smoke also executes the exact vendored FMI schema');
  assert.equal((workflow.match(/tools\/fmpy-smoke\.py/g) || []).length, 2,
    'FMPy imports and checks the physical trajectory on Windows and Linux');
  assert.equal((workflow.match(/FMUSIM_EXE\"? validate/g) || []).length, 2,
    'fmusim validates the Windows-only and final Linux-loadable archives');
  assert.equal((workflow.match(/--start-value I_pack=100/g) || []).length, 2,
    'both native fmusim runs exercise a non-trivial discharge trajectory');
  assert.match(workflow, /python3? tools\/fmu-smoke\.py "\$FMI_TREE" --platform linux64/);
  assert.match(workflow, /python tools\/fmu-smoke\.py "\$env:FMI_TREE" --platform win64/);
});

test('CI, Pages and releases consume the same gated artifact without regeneration', () => {
  const ci = read('.github/workflows/ci.yml');
  const pages = read('.github/workflows/pages.yml');
  const release = read('.github/workflows/release.yml');
  assert.match(ci, /fmu:[\s\S]*?uses: \.\/\.github\/workflows\/fmu\.yml[\s\S]*?ref: \$\{\{ github\.sha \}\}/);
  assert.match(pages, /workflow_run:[\s\S]*?workflows: \[CI\][\s\S]*?conclusion == 'success'/);
  assert.match(release, /fmu:[\s\S]*?uses: \.\/\.github\/workflows\/fmu\.yml[\s\S]*?ref: \$\{\{ needs\.gates\.outputs\.release_sha \}\}/);
  assert.match(release, /concurrency:[\s\S]*?group: release-\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}[\s\S]*?cancel-in-progress: false/);
  assert.doesNotMatch(release, /fmi-source-kit|battery-design-ev-fmi-source-kit/);
  assert.doesNotMatch(release, /tagName:|releaseDraft:/,
    'the build action cannot create a draft before installed-package smoke passes');
  assert.ok(release.indexOf('Install and launch-smoke both Linux packages')
    < release.indexOf('Preserve only the installed and launch-smoked packages'));
  const finalJob = release.slice(release.indexOf('  create-draft:'));
  assert.doesNotMatch(release.slice(0, release.indexOf('  create-draft:')), /contents: write/,
    'tag-controlled validation and build code receives no repository write token');
  assert.match(finalJob, /needs: \[desktop, fmu\]/);
  assert.match(finalJob, /permissions:[\s\S]*?contents: write/);
  assert.match(finalJob, /name: battery-design-ev-fmu/);
  assert.match(finalJob, /sha256sum --check battery-design-ev\.fmu\.sha256/);
  assert.match(finalJob, /release delete-asset[\s\S]*?published_names/,
    'a retried draft cannot retain stale, unvalidated downloads');
  assert.doesNotMatch(finalJob, /fmu-build\.mjs package/,
    'the release job attaches rather than regenerates the accepted FMU');
});

test('product copy separates the editable source kit from compiled release evidence', () => {
  const readme = read('README.md');
  const acceptance = read('docs/FMI_COMMERCIAL_ACCEPTANCE.md');
  assert.match(readme, /battery-design-ev\.fmu/);
  assert.match(readme, /glibc 2\.17\+ baseline/);
  assert.match(readme, /desktop GUI and local API, plus the source\/staged Node runner CLI, continue\s+to export an editable source-FMU/);
  assert.match(readme, /do not install a stable\s+customer-facing calibration shell command/);
  assert.match(acceptance, /Open-source validation is not vendor certification/);
  for (const host of ['ANSYS Twin Builder', 'MATLAB/Simulink', 'GT-SUITE']) {
    assert.match(acceptance, new RegExp(host.replace('/', '\\/')));
  }
  assert.equal((acceptance.match(/Not run/g) || []).length, 4,
    'no proprietary host is silently promoted to accepted');
});
