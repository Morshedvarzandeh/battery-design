// Release wiring is part of the FMU contract: the downloadable file must be
// the exact two-platform artifact that native jobs inspected and host-tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('the reusable FMU workflow builds one exact Linux/Windows release artifact', () => {
  const workflow = read('.github/workflows/fmu.yml');
  assert.match(workflow, /workflow_call:[\s\S]*?ref:[\s\S]*?required: true/);
  assert.match(workflow, /manylinux2014_x86_64:2026\.08\.05-1@sha256:5573110c10bbea40239d80e449f4a02d2773c5d2c0edc27c17307c421816b760/);
  assert.match(workflow, /inspect --tree "\$FMI_TREE" --platform linux64 --max-glibc 2\.17 --record/);
  assert.match(workflow, /--platform win64 --reproducible/);
  assert.match(workflow, /FMI_VCVARS64=[\s\S]*?call "\$env:FMI_VCVARS64"[\s\S]*?fmu-build\.mjs package/,
    'Windows packaging re-enters the MSVC environment needed for dumpbin reinspection');
  assert.equal((workflow.match(/include-hidden-files: true/g) || []).length, 2,
    'both native jobs preserve their hidden inspection records');
  assert.match(workflow, /BATTERY_DESIGN_SOURCE_REVISION/);
  assert.match(workflow, /--require-platforms linux64,win64 --max-glibc 2\.17/);
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
  assert.match(readme, /desktop GUI, CLI and local API continue to export an editable source-FMU/);
  assert.match(acceptance, /Open-source validation is not vendor certification/);
  for (const host of ['ANSYS Twin Builder', 'MATLAB/Simulink', 'GT-SUITE']) {
    assert.match(acceptance, new RegExp(host.replace('/', '\\/')));
  }
  assert.equal((acceptance.match(/Not run/g) || []).length, 4,
    'no proprietary host is silently promoted to accepted');
});
