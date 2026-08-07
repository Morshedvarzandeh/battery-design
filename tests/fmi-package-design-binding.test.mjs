// Packaged FMUs must carry the exact immutable design resource that produced
// their GUID. Official artifacts require a complete immutable design binding,
// while legacy source-kit callers remain packageable only without that gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { designFromSpec } from '../js/api.js';
import { cellById } from '../js/cells.js';
import { normalizeDesignSpec } from '../js/design-spec.js';
import {
  buildFmu, FMI_DESIGN_RESOURCE_FORMAT, FMU_MODEL_REVISION,
  fmuGuid, fmuSourceC, materializeFmiIoMap, modelDescriptionXml,
} from '../js/fmi.js';
import { canonicalJson, semanticDigest } from '../js/ontology.js';
import {
  auditFmuTree, compileNativeBinary, packageFmu,
} from '../tools/fmu-build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_SPEC = join(ROOT, 'fmi', 'battery-design-ev.design-spec.json');
const DESIGN_RESOURCE_PATH = 'resources/battery-design-design.json';
const canRun = process.platform === 'linux' && ['cc', 'nm', 'file', 'ldd', 'python3']
  .every((command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function writeSourceTree(t, built, label) {
  const temporary = mkdtempSync(join(tmpdir(), `battery-design-${label}-`));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const tree = join(temporary, 'tree');
  for (const [relativePath, content] of Object.entries(built.files)) {
    const path = join(tree, ...relativePath.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  compileNativeBinary({ tree, platform: 'linux64', maxGlibc: '99.0' });
  return { temporary, tree };
}

test('package manifest binds the exact complete design snapshot', { skip: !canRun }, (t) => {
  const input = JSON.parse(readFileSync(RELEASE_SPEC, 'utf8'));
  const design = designFromSpec(normalizeDesignSpec(input, { strict: true }));
  const built = buildFmu({ design });
  const { temporary, tree } = writeSourceTree(t, built, 'complete-fmu-binding');
  const output = join(temporary, 'battery-design-ev.fmu');
  const packaged = packageFmu({
    tree,
    output,
    requiredPlatforms: ['linux64'],
    maxGlibc: '99.0',
    requireCompleteDesign: true,
  });
  const repeated = packageFmu({
    tree,
    output: join(temporary, 'battery-design-ev-repeat.fmu'),
    requiredPlatforms: ['linux64'],
    maxGlibc: '99.0',
    requireCompleteDesign: true,
  });
  assert.equal(packaged.sha256, repeated.sha256);
  assert.deepEqual(readFileSync(output), readFileSync(repeated.outputPath),
    'complete design-bound packaging is byte deterministic');

  const resourcePath = join(tree, ...DESIGN_RESOURCE_PATH.split('/'));
  const resourceBytes = readFileSync(resourcePath);
  const resource = JSON.parse(resourceBytes.toString('utf8'));
  const manifestPath = join(tree, 'resources', 'battery-design-build.json');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(resource.format, FMI_DESIGN_RESOURCE_FORMAT);
  assert.equal(resource.guid, built.guid);
  assert.equal(manifest.designResource.path, DESIGN_RESOURCE_PATH);
  assert.equal(manifest.designResource.format, FMI_DESIGN_RESOURCE_FORMAT);
  assert.equal(manifest.designResource.snapshotChecksum, built.designSnapshotChecksum);
  assert.equal(manifest.designResource.sha256, sha256(resourceBytes));
  assert.equal(manifest.designResource.complete, true);
  assert.deepEqual(manifest.designResource.binding, built.designBinding);
  assert.equal(manifest.binaries[0].contractEvidence.guid, built.guid);
  assert.equal(manifest.binaries[0].contractEvidence.contractStartsChecked, 17);
  assert.equal(manifest.binaries[0].contractEvidence.starts.length, 17);
  assert.match(manifest.binaries[0].contractEvidence.evidenceChecksum, /^[a-f0-9]{64}$/);
  assert.equal(manifest.packageFiles.length, 10);
  assert.ok(manifest.packageFiles.every(({ path, size, sha256: digest }) => (
    path !== 'resources/battery-design-build.json'
      && Number.isInteger(size) && size > 0 && /^[a-f0-9]{64}$/.test(digest)
  )));
  assert.deepEqual(packaged.designResource, manifest.designResource);
  const offlineAudit = auditFmuTree(tree, { requireCompleteDesign: true });
  assert.deepEqual(offlineAudit.designResource, manifest.designResource);
  assert.deepEqual(offlineAudit.sourceRevision, {
    value: null, verified: false, basis: 'no-claim',
  });
  assert.deepEqual(auditFmuTree(tree, {
    requireCompleteDesign: true,
    expectedSourceRevision: null,
  }).sourceRevision, {
    value: null, verified: false, basis: 'no-claim',
  });
  assert.throws(
    () => auditFmuTree(tree, {
      requireCompleteDesign: true,
      expectedSourceRevision: null,
      requireVerifiedSourceRevision: true,
    }),
    /null sourceRevision is no provenance claim/,
  );

  const detachedManifest = structuredClone(manifest);
  detachedManifest.designResource.binding.designChecksum = '0'.repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(detachedManifest, null, 2)}\n`);
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /does not bind the model and I\/O contract exactly/,
    'audit rejects a manifest detached from the packaged design binding',
  );
  writeFileSync(manifestPath, manifestBytes);

  const manifestTamperCases = [
    ['artifact kind', (value) => { value.artifactKind = 'source-kit'; }],
    ['FMI version', (value) => { value.fmiVersion = '9.9'; }],
    ['standard patch', (value) => { value.fmiStandardPatch = '9.9.9'; }],
    ['source hash', (value) => { value.sources[0].sha256 = '0'.repeat(64); }],
    ['source list', (value) => { value.sources = []; }],
    ['source revision removal', (value) => { delete value.sourceRevision; }],
    ['binary hash', (value) => { value.binaries[0].sha256 = '0'.repeat(64); }],
    ['binary evidence', (value) => { value.binaries[0].contractEvidence.guid = '{00000000-0000-0000-0000-000000000000}'; }],
    ['binary list', (value) => { value.binaries = []; }],
    ['package file inventory', (value) => { value.packageFiles[0].sha256 = '0'.repeat(64); }],
    ['extra field', (value) => { value.untrusted = true; }],
  ];
  for (const [label, mutate] of manifestTamperCases) {
    const changedManifest = structuredClone(manifest);
    mutate(changedManifest);
    writeFileSync(manifestPath, `${JSON.stringify(changedManifest, null, 2)}\n`);
    assert.throws(
      () => auditFmuTree(tree, { requireCompleteDesign: true }),
      /build manifest|inspection record|contract evidence|native inspection/i,
      `audit rejects changed ${label}`,
    );
  }
  const malformedRevision = structuredClone(manifest);
  malformedRevision.sourceRevision = '../not-a-revision';
  writeFileSync(manifestPath, `${JSON.stringify(malformedRevision, null, 2)}\n`);
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /sourceRevision/,
  );
  writeFileSync(manifestPath, manifestBytes);

  const unverifiedRevisionManifest = structuredClone(manifest);
  unverifiedRevisionManifest.sourceRevision = '0'.repeat(40);
  writeFileSync(manifestPath, `${JSON.stringify(unverifiedRevisionManifest, null, 2)}\n`);
  assert.deepEqual(auditFmuTree(tree, { requireCompleteDesign: true }).sourceRevision, {
    value: '0'.repeat(40), verified: false, basis: 'unverified-manifest-claim',
  });
  assert.throws(
    () => auditFmuTree(tree, {
      requireCompleteDesign: true,
      expectedSourceRevision: '1'.repeat(40),
      requireVerifiedSourceRevision: true,
    }),
    /does not match explicit-expected/,
  );
  assert.throws(
    () => auditFmuTree(tree, {
      requireCompleteDesign: true,
      requireVerifiedSourceRevision: true,
    }),
    /requires expectedSourceRevision|unverified/i,
  );
  writeFileSync(manifestPath, manifestBytes);

  const undeclaredPayload = join(tree, 'resources', 'undeclared-payload.txt');
  writeFileSync(undeclaredPayload, 'must not ship');
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /FMU package path set is not exact.*undeclared-payload/,
  );
  assert.throws(
    () => packageFmu({
      tree,
      output: join(temporary, 'payload-must-not-package.fmu'),
      requiredPlatforms: ['linux64'],
      maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /FMU package path set is not exact.*undeclared-payload/,
  );
  rmSync(undeclaredPayload);

  const outputTarget = join(temporary, 'output-target.txt');
  const outputLink = join(temporary, 'output-link.fmu');
  writeFileSync(outputTarget, 'preserve me');
  symlinkSync(outputTarget, outputLink);
  assert.throws(
    () => packageFmu({
      tree, output: outputLink, requiredPlatforms: ['linux64'], maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /output must not be a symbolic link/,
  );
  assert.equal(readFileSync(outputTarget, 'utf8'), 'preserve me');

  const outputHardLink = join(temporary, 'output-hard-link.fmu');
  linkSync(join(tree, 'README.md'), outputHardLink);
  const readmeBeforeHardLinkAttempt = readFileSync(join(tree, 'README.md'));
  assert.throws(
    () => packageFmu({
      tree, output: outputHardLink, requiredPlatforms: ['linux64'], maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /output must not be a hard-linked file/,
  );
  assert.deepEqual(readFileSync(join(tree, 'README.md')), readmeBeforeHardLinkAttempt);
  rmSync(outputHardLink);

  const externalReadmeLink = join(temporary, 'external-readme-link.txt');
  linkSync(join(tree, 'README.md'), externalReadmeLink);
  assert.throws(
    () => packageFmu({
      tree,
      output: join(temporary, 'input-hard-link-must-not-package.fmu'),
      requiredPlatforms: ['linux64'],
      maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /FMU tree contains a hard-linked file: README\.md/,
  );
  rmSync(externalReadmeLink);

  const internalSymlink = join(tree, '.fmu-build', 'redirect-outside');
  symlinkSync(temporary, internalSymlink);
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /Internal FMU build tree contains a symlink/,
  );
  rmSync(internalSymlink);

  const inspectionPath = join(tree, '.fmu-build', 'inspections', 'linux64.json');
  const externalInspectionLink = join(temporary, 'inspection-hard-link.json');
  linkSync(inspectionPath, externalInspectionLink);
  assert.throws(
    () => packageFmu({
      tree,
      output: join(temporary, 'inspection-hard-link-must-not-package.fmu'),
      requiredPlatforms: ['linux64'],
      maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /Internal FMU build tree contains a hard-linked file/,
  );
  rmSync(externalInspectionLink);

  const xmlPath = join(tree, 'modelDescription.xml');
  const canonicalXml = readFileSync(xmlPath, 'utf8');
  writeFileSync(xmlPath, canonicalXml.replace(
    'canGetAndSetFMUstate="false"', 'canGetAndSetFMUstate="true"',
  ));
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /modelDescription\.xml is not the exact canonical FMI contract/,
  );
  assert.throws(
    () => packageFmu({
      tree,
      output: join(temporary, 'capability-tamper-must-not-package.fmu'),
      requiredPlatforms: ['linux64'],
      maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /modelDescription\.xml is not the exact canonical FMI contract/,
  );
  assert.throws(
    () => compileNativeBinary({ tree, platform: 'linux64', maxGlibc: '99.0' }),
    /modelDescription\.xml is not the exact canonical FMI contract/,
  );
  writeFileSync(xmlPath, canonicalXml.replace(
    'stopTime="10" tolerance="0.0001"', 'stopTime="20" tolerance="0.0001"',
  ));
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /modelDescription\.xml is not the exact canonical FMI contract/,
  );
  writeFileSync(xmlPath, canonicalXml);

  const changedResource = structuredClone(resource);
  changedResource.snapshot.layout.spacingMm += 0.25;
  writeFileSync(resourcePath, `${JSON.stringify(changedResource, null, 2)}\n`);
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /snapshot checksum does not match its content/,
    'audit rejects layout provenance changed after the component GUID was fixed',
  );
  writeFileSync(resourcePath, resourceBytes);
});

test('packaging rejects coordinated metadata tamper when the binary defaults are stale', { skip: !canRun }, (t) => {
  const input = JSON.parse(readFileSync(RELEASE_SPEC, 'utf8'));
  const design = designFromSpec(normalizeDesignSpec(input, { strict: true }));
  const built = buildFmu({ design });
  const { temporary, tree } = writeSourceTree(t, built, 'coordinated-fmu-tamper');
  const resourcePath = join(tree, ...DESIGN_RESOURCE_PATH.split('/'));
  const ioPath = join(tree, 'resources', 'battery-design-io-map.json');
  const xmlPath = join(tree, 'modelDescription.xml');
  const sourcePath = join(tree, 'sources', 'BatteryPack.c');
  const binaryPath = join(tree, 'binaries', 'linux64', 'BatteryPack.so');
  const recordPath = join(tree, '.fmu-build', 'inspections', 'linux64.json');
  const resource = JSON.parse(readFileSync(resourcePath, 'utf8'));
  const originalIo = JSON.parse(readFileSync(ioPath, 'utf8'));
  const defaults = Object.fromEntries(originalIo.variables
    .filter(({ causality }) => causality === 'parameter')
    .map(({ name, start }) => [name, start]));

  defaults.r0_mOhm += 1;
  resource.snapshot.fmi.parameterDefaults.r0_mOhm = defaults.r0_mOhm;
  resource.snapshotChecksum = semanticDigest(resource.snapshot);
  const changedGuid = fmuGuid({
    cell: { id: resource.snapshot.cell.id },
    defaults,
    modelName: 'BatteryPack',
    designSnapshotChecksum: resource.snapshotChecksum,
  });
  resource.guid = changedGuid;
  const ioMap = materializeFmiIoMap({
    parameterValues: defaults,
    modelName: 'BatteryPack',
    modelRevision: FMU_MODEL_REVISION,
    guid: changedGuid,
    fmiStandardVersion: originalIo.fmiStandardPatch,
  });
  const source = fmuSourceC({ modelName: 'BatteryPack', guid: changedGuid, defaults });
  writeFileSync(resourcePath, `${JSON.stringify(resource, null, 2)}\n`);
  writeFileSync(ioPath, `${JSON.stringify(ioMap, null, 2)}\n`);
  writeFileSync(xmlPath, modelDescriptionXml({
    cell: cellById(resource.snapshot.cell.id),
    s: resource.snapshot.pack.seriesCells,
    p: resource.snapshot.pack.parallelCells,
    defaults,
    modelName: 'BatteryPack',
    guid: changedGuid,
  }));
  assert.throws(
    () => packageFmu({
      tree,
      output: join(temporary, 'metadata-only-tamper.fmu'),
      requiredPlatforms: ['linux64'],
      maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /Generated FMI C source does not exactly match/,
    'coordinated resource/XML/map rewrites cannot leave the generated C and binary on the old contract',
  );
  writeFileSync(sourcePath, source);

  // Give the old binary the new same-length GUID while intentionally leaving
  // its compiled r0 default stale. Static symbols and runtime metadata still
  // look valid; only a real FMI instantiate/get probe exposes the mismatch.
  const binary = Buffer.from(readFileSync(binaryPath));
  const oldGuidBytes = Buffer.from(built.guid);
  const changedGuidBytes = Buffer.from(changedGuid);
  let replacements = 0;
  for (let offset = binary.indexOf(oldGuidBytes); offset >= 0; offset = binary.indexOf(oldGuidBytes, offset + changedGuidBytes.length)) {
    changedGuidBytes.copy(binary, offset);
    replacements += 1;
  }
  assert.ok(replacements > 0, 'the native binary contains its compiled GUID');
  writeFileSync(binaryPath, binary);

  const sourceEntry = { path: 'sources/BatteryPack.c', sha256: sha256(Buffer.from(source)) };
  const sourceContractChecksum = sha256(canonicalJson({
    modelIdentifier: 'BatteryPack',
    guid: changedGuid,
    sources: [sourceEntry],
  }));
  const starts = ioMap.variables
    .filter(({ causality, start }) => ['parameter', 'input'].includes(causality) && start != null)
    .map(({ name, valueReference, causality, start }) => ({ name, valueReference, causality, start }));
  const evidenceBody = {
    format: 'battery-design/fmi-native-contract-evidence@1',
    fmiVersion: '2.0',
    modelIdentifier: 'BatteryPack',
    guid: changedGuid,
    platform: 'linux64',
    binarySha256: sha256(binary),
    sourceContractChecksum,
    ioContractChecksum: ioMap.contractChecksum,
    starts,
    startsChecksum: sha256(canonicalJson(starts)),
    contractStartsChecked: starts.length,
  };
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.guid = changedGuid;
  record.sha256 = sha256(binary);
  record.contractEvidence = {
    ...evidenceBody,
    evidenceChecksum: sha256(canonicalJson(evidenceBody)),
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  assert.throws(
    () => packageFmu({
      tree,
      output: join(temporary, 'must-not-package.fmu'),
      requiredPlatforms: ['linux64'],
      maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /Native FMI GUID\/default probe failed/,
    'packaging reruns the native contract instead of trusting coordinated metadata edits',
  );
});

test('legacy cell/S/P trees package only when complete design binding is not required', { skip: !canRun }, (t) => {
  const built = buildFmu({ cell: cellById('lg-inr18650-mj1'), s: 110, p: 43 });
  const { temporary, tree } = writeSourceTree(t, built, 'legacy-fmu-binding');
  const output = join(temporary, 'legacy.fmu');
  const failedOutput = join(temporary, 'must-not-exist.fmu');
  const readmeBeforeFailure = readFileSync(join(tree, 'README.md'));
  assert.throws(
    () => packageFmu({
      tree,
      output: failedOutput,
      requiredPlatforms: ['linux64'],
      maxGlibc: '99.0',
      requireCompleteDesign: true,
    }),
    /a complete design-bound resource is required/,
  );
  assert.equal(existsSync(failedOutput), false);
  assert.equal(existsSync(join(tree, 'resources', 'battery-design-build.json')), false);
  assert.equal(existsSync(join(tree, 'documentation', 'licenses')), false);
  assert.equal(existsSync(join(tree, 'documentation', 'source-build.md')), false);
  assert.deepEqual(readFileSync(join(tree, 'README.md')), readmeBeforeFailure,
    'a failed completeness gate does not mutate package metadata');

  const packaged = packageFmu({
    tree, output, requiredPlatforms: ['linux64'], maxGlibc: '99.0',
  });
  assert.equal(packaged.designResource.complete, false);
  assert.equal(packaged.designResource.binding, null);
  assert.equal(auditFmuTree(tree).designResource.complete, false);
  assert.throws(
    () => auditFmuTree(tree, { requireCompleteDesign: true }),
    /a complete design-bound resource is required/,
  );
  const cli = spawnSync(process.execPath, [
    join(ROOT, 'tools', 'fmu-build.mjs'), 'package',
    '--tree', tree,
    '--output', join(temporary, 'cli-must-not-exist.fmu'),
    '--require-platforms', 'linux64',
    '--max-glibc', '99.0',
    '--require-complete-design',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /a complete design-bound resource is required/,
    'the release-only completeness gate is available through the package CLI');

  const sourceRevisionOutput = join(temporary, 'source-revision-must-not-exist.fmu');
  const sourceRevisionGate = spawnSync(process.execPath, [
    join(ROOT, 'tools', 'fmu-build.mjs'), 'package',
    '--tree', tree,
    '--output', sourceRevisionOutput,
    '--require-source-revision',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(sourceRevisionGate.status, 0);
  assert.match(sourceRevisionGate.stderr, /sourceRevision verification requires|Verified FMU packaging requires/);
  assert.equal(existsSync(sourceRevisionOutput), false);

  const typoOutput = join(temporary, 'typo-must-not-exist.fmu');
  const typo = spawnSync(process.execPath, [
    join(ROOT, 'tools', 'fmu-build.mjs'), 'package',
    '--tree', tree,
    '--output', typoOutput,
    '--require-complete-desgin', 'yes',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(typo.status, 0);
  assert.match(typo.stderr, /Unknown option for package: --require-complete-desgin/);
  assert.equal(existsSync(typoOutput), false);

  const duplicateOutput = join(temporary, 'duplicate-must-not-exist.fmu');
  const duplicate = spawnSync(process.execPath, [
    join(ROOT, 'tools', 'fmu-build.mjs'), 'package',
    '--tree', tree,
    '--output', duplicateOutput,
    '--require-complete-design',
    '--require-complete-design',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Duplicate option: --require-complete-design/);
  assert.equal(existsSync(duplicateOutput), false);
});
