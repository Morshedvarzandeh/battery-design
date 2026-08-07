import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  OPTIONAL_RUNTIME_ENTRIES,
  REQUIRED_RUNTIME_ENTRIES,
  stageApplication,
} from '../desktop-app/prepare.mjs';
import { materializeCalibrationDataset } from '../js/calibration-dataset.js';
import { cellById } from '../js/cells.js';
import { semanticDigest } from '../js/ontology.js';
import { defaultParams, simulate } from '../js/sim2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUST_SHIP = Object.freeze([
  'index.html', 'cosim.html', 'cosim.css', 'js', 'knowledge', 'wasm', 'vendor',
  'assets', 'assets3d', 'profiles', 'desktop',
]);

function packagedCalibrationDataset() {
  return materializeCalibrationDataset({
    id: 'packaged-runner-smoke',
    kind: 'synthetic',
    purpose: 'calibration',
    source: {
      tool: 'battery-design packaged smoke',
      toolVersion: null,
      model: null,
      runId: null,
      generatedAt: null,
      mediaType: 'application/json',
      rawSha256: 'a'.repeat(64),
    },
    binding: {
      cellId: 'samsung-inr21700-50e',
      seriesCells: 1,
      parallelCells: 1,
      startSoC: 0.8,
      ambientC: 25,
      moduleCount: 1,
      initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'canonical-json',
      adapterVersion: '1.0.0',
      mappingChecksum: 'b'.repeat(64),
      sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: null },
      sourceCurrentPositive: 'discharge',
      sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal',
      sourceTemperatureLocation: null,
      sourceSampleAlignment: 'end-of-step',
      sourceFirstSampleTimeS: 0,
      sourceResetTimeS: -1,
      timeHandling: 'validated-uniform',
      originalSampleCount: 3,
    },
    samplePeriodS: 1,
    signals: {
      currentA: [0, 1, 0],
      voltageV: [3.75, 3.74, 3.75],
      temperatureC: null,
    },
    segments: [
      { id: 'all', startIndex: 0, endIndexExclusive: 3, mode: 'dynamic', include: true },
    ],
    conventions: {
      timeBasis: 'uniform-sample-period',
      timeOrigin: 'trial-reset',
      firstSampleOffsetS: 1,
      sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold',
      currentPositive: 'discharge',
      currentScope: 'pack',
      voltageLocation: 'pack-terminal',
      temperatureLocation: null,
    },
  });
}

function packagedTuningProtocol(amplitudeA) {
  return [
    ...Array(10).fill(0),
    ...Array(12).fill(amplitudeA),
    ...Array(10).fill(0),
    ...Array(12).fill(-amplitudeA),
    ...Array(10).fill(0),
    ...Array(12).fill(amplitudeA * 0.7),
    ...Array(10).fill(0),
  ];
}

function packagedTuningDataset({ id, purpose, amplitudeA, startSoC, truth }) {
  const cell = cellById('samsung-inr21700-50e');
  const currentA = packagedTuningProtocol(amplitudeA);
  const simulated = simulate({
    cell,
    s: 1,
    p: 1,
    nModules: 1,
    params: truth,
    profile: { dtS: 1, i: currentA },
    startSoC,
    ambientC: 25,
  });
  return materializeCalibrationDataset({
    id,
    kind: 'synthetic',
    purpose,
    source: {
      tool: 'battery-design packaged tuning smoke',
      toolVersion: '1.0.0',
      model: 'sim2-governed-fixture',
      runId: id,
      generatedAt: null,
      mediaType: 'application/json',
      rawSha256: semanticDigest(`raw:${id}`),
    },
    binding: {
      cellId: cell.id,
      seriesCells: 1,
      parallelCells: 1,
      startSoC,
      ambientC: 25,
      moduleCount: 1,
      initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'canonical-json',
      adapterVersion: '1.0.0',
      mappingChecksum: semanticDigest(`mapping:${id}`),
      sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: null },
      sourceCurrentPositive: 'discharge',
      sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal',
      sourceTemperatureLocation: null,
      sourceSampleAlignment: 'end-of-step',
      sourceFirstSampleTimeS: 1,
      sourceResetTimeS: 0,
      timeHandling: 'validated-uniform',
      originalSampleCount: currentA.length,
    },
    samplePeriodS: 1,
    signals: {
      currentA,
      voltageV: simulated.series.v,
      temperatureC: null,
    },
    segments: [{
      id: 'complete',
      startIndex: 0,
      endIndexExclusive: currentA.length,
      mode: 'dynamic',
      include: true,
    }],
    conventions: {
      timeBasis: 'uniform-sample-period',
      timeOrigin: 'trial-reset',
      firstSampleOffsetS: 1,
      sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold',
      currentPositive: 'discharge',
      currentScope: 'pack',
      voltageLocation: 'pack-terminal',
      temperatureLocation: null,
    },
  });
}

function packagedTuningRequest() {
  const cell = cellById('samsung-inr21700-50e');
  const initial = defaultParams(cell);
  const truth = { ...initial, r0Ref: initial.r0Ref * 1.2 };
  const calibrationDataset = packagedTuningDataset({
    id: 'packaged-tuning-calibration',
    purpose: 'calibration',
    amplitudeA: 8,
    startSoC: 0.6,
    truth,
  });
  const validationDataset = packagedTuningDataset({
    id: 'packaged-tuning-validation',
    purpose: 'validation',
    amplitudeA: 7.3,
    startSoC: 0.65,
    truth,
  });
  return {
    calibrationDataset,
    validationDataset,
    body: {
      format: 'battery-design/ecm-tuning-request@1',
      calibrationDatasets: [calibrationDataset],
      validationDatasets: [validationDataset],
      params: null,
      groups: ['ohmic'],
      maxEvaluations: 8,
      maxModuleWeightedIntegrationSteps: 10_000,
      maxSamplesPerDataset: 80,
      acceptance: {
        maxVoltageRmseMvPerCell: 100,
        maxVoltageMaxAbsMvPerCell: 200,
        maxTemperatureRmseC: null,
        maxTemperatureMaxAbsC: null,
        minValidationDatasets: 1,
        minIncludedSamplesPerDataset: 20,
        requiredModes: ['dynamic'],
        requireNoHoldoutRegression: true,
        requireNoFittedParameterAtBound: true,
      },
    },
  };
}

function containsRawTrace(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (['signals', 'currentA', 'voltageV', 'residuals', 'predictions',
      'datasets', 'calibrationDatasets', 'validationDatasets'].includes(key)) return true;
    if (key === 'temperatureC' && Array.isArray(child)) return true;
    if (containsRawTrace(child)) return true;
  }
  return false;
}

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForRunner({ child, url, token, output }) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`packaged runner exited ${child.exitCode} before startup\n${output()}`);
    }
    try {
      const response = await fetch(`${url}/api/capabilities`, {
        headers: { 'X-Battery-Design-Token': token },
      });
      if (response.ok) return response.json();
    } catch {
      // The process may not have bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`packaged runner did not answer within 20 seconds\n${output()}`);
}

test('staging refuses repository children and arbitrary existing directories', () => {
  assert.throws(
    () => stageApplication({ output: path.join(ROOT, 'js', '__package-output-test') }),
    /unsafe output directory/,
  );
  const arbitrary = mkdtempSync(path.join(os.tmpdir(), 'battery-design-not-staging-'));
  try {
    assert.throws(
      () => stageApplication({ output: arbitrary }),
      /not created by this script/,
    );
  } finally {
    rmSync(arbitrary, { recursive: true, force: true });
  }
});

test('installed-package smoke canonicalizes artifact paths before apt sees Tauri filenames', () => {
  const smoke = readFileSync(path.join(ROOT, 'tools', 'smoke-installed-linux.sh'), 'utf8');
  const canonicalize = smoke.indexOf('deb_path=$(realpath -- "$deb_path")');
  const install = smoke.indexOf('sudo apt-get install -y "$deb_path"');
  assert.ok(canonicalize >= 0, 'the .deb path is canonicalized');
  assert.ok(install > canonicalize, 'apt receives an absolute local path even when the filename contains spaces');
  assert.match(smoke, /appimage_path=\$\(realpath -- "\$appimage_path"\)/);
});

test('installed-package smoke launches the Cargo GUI instead of an arbitrary sidecar', () => {
  const smoke = readFileSync(path.join(ROOT, 'tools', 'smoke-installed-linux.sh'), 'utf8');
  const cargo = readFileSync(path.join(ROOT, 'desktop-app', 'src-tauri', 'Cargo.toml'), 'utf8');
  const packageName = cargo.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(packageName, 'the Tauri Cargo package declares its default binary name');
  assert.ok(
    smoke.includes(`deb_binary=/usr/bin/${packageName}`),
    'the installed smoke launches the default Cargo GUI binary',
  );
  assert.match(smoke, /dpkg -L "\$deb_package" \| grep -Fx "\$deb_binary"/);
  assert.doesNotMatch(
    smoke,
    /deb_binary=.*dpkg -L/,
    'package member order must not choose between the GUI and bd-runner sidecar',
  );
});

test('staged desktop tree imports and starts from an isolated output', { timeout: 30_000 }, async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'battery-design-package-'));
  const staged = path.join(temporary, 'runner');
  const token = 'packaged-tree-smoke-token-0000000000000001';
  let child = null;
  let stdout = '';
  let stderr = '';

  try {
    const result = stageApplication({ output: staged });
    assert.equal(result.output, staged);
    for (const entry of REQUIRED_RUNTIME_ENTRIES) {
      assert.ok(existsSync(path.join(staged, entry)), `required runtime entry was not staged: ${entry}`);
    }
    for (const entry of MUST_SHIP) {
      assert.ok(REQUIRED_RUNTIME_ENTRIES.includes(entry), `runtime manifest dropped required entry: ${entry}`);
      assert.ok(existsSync(path.join(staged, entry)), `runtime tree dropped required entry: ${entry}`);
    }
    assert.ok(OPTIONAL_RUNTIME_ENTRIES.includes('garage3d/build'), 'generated Godot export is no longer staged');
    for (const entry of OPTIONAL_RUNTIME_ENTRIES) {
      if (existsSync(path.join(ROOT, entry))) {
        assert.ok(existsSync(path.join(staged, entry)), `generated runtime entry was not staged: ${entry}`);
      }
    }

    const manifest = JSON.parse(readFileSync(path.join(staged, 'PACKAGED.json'), 'utf8'));
    assert.deepEqual(manifest.requiredEntries, [...REQUIRED_RUNTIME_ENTRIES]);
    for (const relative of [
      'js/calibration-dataset.js',
      'js/calibration-import.js',
      'js/ecm-tuning.js',
      'js/ecm-tuning-executor.js',
      'js/sim2.js',
    ]) {
      assert.ok(existsSync(path.join(staged, relative)), `model runtime dependency was not staged: ${relative}`);
    }

    const tuningModuleUrls = ['js/ecm-tuning.js', 'js/ecm-tuning-executor.js']
      .map((relative) => pathToFileURL(path.join(staged, relative)).href);
    const importedTuning = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `await Promise.all(${JSON.stringify(tuningModuleUrls)}.map((url) => import(url)));`,
    ], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(importedTuning.status, 0, importedTuning.stderr || importedTuning.stdout);

    // bd.mjs resolves every static import before dispatching the command. This
    // catches missing JS/data libraries even if a direct UI path is not used
    // during the startup probe (the historical assets3d omission fails here).
    const imported = spawnSync(process.execPath, [path.join(staged, 'desktop', 'bd.mjs'), 'help'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    assert.match(imported.stdout, /battery-design.*desktop runner/is);

    const port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
      path.join(staged, 'desktop', 'bd.mjs'),
      'serve', '--port', String(port), '--token', token,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const capabilities = await waitForRunner({
      child,
      url: baseUrl,
      token,
      output: () => `${stdout}\n${stderr}`,
    });
    assert.equal(capabilities.runner, 'battery-design desktop');
    assert.ok(
      capabilities.localApiCapabilities.some(({ id }) => id === 'calibration'),
      'the staged runner advertises its governed local-API calibration surface',
    );
    assert.ok(
      !capabilities.capabilities.some(({ id }) => id === 'calibration'),
      'the staged runner does not claim a calibration GUI that is not implemented',
    );
    assert.ok(
      capabilities.localApiCapabilities.some(({ id }) => id === 'ecm-tuning'),
      'the staged runner advertises its governed local-API ECM tuning surface',
    );
    assert.ok(capabilities.endpoints.includes('/api/tune-ecm'));
    assert.equal(capabilities.tuningLimits.requestFormat, 'battery-design/ecm-tuning-request@1');
    assert.equal(capabilities.tuningLimits.runFormat, 'battery-design/ecm-tuning-run@1');
    assert.equal(capabilities.tuningLimits.planFormat, 'battery-design/ecm-tuning-plan@1');
    assert.equal(capabilities.tuningLimits.resultFormat, 'battery-design/ecm-tuning-result@1');
    assert.deepEqual(capabilities.tuningLimits.acceptanceFields, [
      'maxVoltageRmseMvPerCell',
      'maxVoltageMaxAbsMvPerCell',
      'maxTemperatureRmseC',
      'maxTemperatureMaxAbsC',
      'minValidationDatasets',
      'minIncludedSamplesPerDataset',
      'requiredModes',
      'requireNoHoldoutRegression',
      'requireNoFittedParameterAtBound',
    ], 'the package advertises the exact ordered caller-owned acceptance contract');
    assert.deepEqual({
      maxBodyBytes: capabilities.tuningLimits.maxBodyBytes,
      maxDatasetsPerPartition: capabilities.tuningLimits.maxDatasetsPerPartition,
      maxCombinedInputSamples: capabilities.tuningLimits.maxCombinedInputSamples,
      maxModules: capabilities.tuningLimits.maxModules,
      maxPreprocessedSamplesPerDataset:
        capabilities.tuningLimits.maxPreprocessedSamplesPerDataset,
      maxEvaluations: capabilities.tuningLimits.maxEvaluations,
      maxModuleWeightedIntegrationSteps:
        capabilities.tuningLimits.maxModuleWeightedIntegrationSteps,
    }, {
      maxBodyBytes: 4 * 1024 * 1024,
      maxDatasetsPerPartition: 8,
      maxCombinedInputSamples: 20_000,
      maxModules: 64,
      maxPreprocessedSamplesPerDataset: 5_000,
      maxEvaluations: 500,
      maxModuleWeightedIntegrationSteps: 2_000_000,
    });
    assert.ok(
      !capabilities.capabilities.some(({ id }) => id === 'ecm-tuning')
        && !capabilities.mcpCapabilities.some(({ id }) => id === 'ecm-tuning'),
      'the staged runner does not claim unimplemented GUI or MCP ECM tuning surfaces',
    );

    const dataset = packagedCalibrationDataset();
    const calibrationResponse = await fetch(`${baseUrl}/api/calibrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Battery-Design-Token': token,
      },
      body: JSON.stringify({
        format: 'battery-design/calibration-request@1',
        datasets: dataset,
        params: null,
        fit: ['r0Ref'],
        maxIter: 1,
        weightTemp: 0,
        maxEvaluations: 2,
        maxModuleWeightedIntegrationSteps: 36,
        maxSamplesPerDataset: 8,
      }),
    });
    const calibration = await calibrationResponse.json();
    assert.equal(calibrationResponse.status, 200, calibration.error);
    assert.equal(calibration.format, 'battery-design/calibration-result@1');
    assert.deepEqual(calibration.datasetChecksums, [dataset.checksum]);
    assert.equal(calibration.evaluationCount, 2);
    assert.equal(calibration.moduleWeightedIntegrationStepCount, 36,
      'the isolated package executes the exact adaptive work plan budgeted by the request');
    assert.doesNotMatch(JSON.stringify(calibration), /"signals"\s*:/,
      'the packaged API returns governed evidence, not the source trace');

    const tuningFixture = packagedTuningRequest();
    const tuningResponse = await fetch(`${baseUrl}/api/tune-ecm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Battery-Design-Token': token,
      },
      body: JSON.stringify(tuningFixture.body),
    });
    const tuning = await tuningResponse.json();
    assert.equal(tuningResponse.status, 200, tuning.error);
    assert.equal(tuning.format, 'battery-design/ecm-tuning-run@1');
    assert.equal(tuning.plan.format, 'battery-design/ecm-tuning-plan@1');
    assert.equal(tuning.result.format, 'battery-design/ecm-tuning-result@1');
    assert.equal(tuning.model.id, 'battery-design/staged-ecm-arrhenius-tuning');
    assert.match(tuning.model.implementationChecksum, /^[a-f0-9]{64}$/);
    assert.ok(tuning.model.dependencies.includes('js/ecm-tuning.js'));
    assert.ok(tuning.model.dependencies.includes('js/ecm-tuning-executor.js'));
    assert.equal(tuning.surfaceLimits.surface, 'local-api');
    const tuningBody = { ...tuning };
    delete tuningBody.checksum;
    assert.equal(tuning.checksum, semanticDigest(tuningBody));
    assert.equal(tuning.result.planChecksum, tuning.plan.checksum);
    assert.deepEqual(
      tuning.plan.request.calibrationIdentities.map(({ datasetChecksum }) => datasetChecksum),
      [tuningFixture.calibrationDataset.checksum],
    );
    assert.deepEqual(
      tuning.plan.request.validationIdentities.map(({ datasetChecksum }) => datasetChecksum),
      [tuningFixture.validationDataset.checksum],
    );
    assert.equal(tuning.result.metrics.before.validation.sampleGrid, 'original-full-rate');
    assert.equal(tuning.result.metrics.after.validation.sampleGrid, 'original-full-rate');
    assert.equal(tuning.result.readiness.validationRole,
      'fixed-full-rate-score-only-never-an-optimizer-input');
    assert.equal(tuning.result.adoptedParamsChecksum, semanticDigest(tuning.result.adoptedParams));
    assert.equal(tuning.result.work.candidateEvaluations, 8);
    assert.equal(tuning.result.work.moduleWeightedIntegrationSteps, 5_472,
      'the deterministic staged fixture executes the exact preflighted simulator work');
    assert.equal(
      tuning.result.work.moduleWeightedIntegrationSteps,
      tuning.result.workPreflight.projectedCeilings.moduleWeightedIntegrationSteps,
    );
    assert.ok(tuning.result.work.moduleWeightedIntegrationSteps
      <= tuning.result.work.limits.moduleWeightedIntegrationSteps);
    assert.ok(tuning.result.work.moduleWeightedIntegrationSteps
      <= capabilities.tuningLimits.maxModuleWeightedIntegrationSteps);
    assert.equal(containsRawTrace(tuning), false,
      'the packaged tuning response retains checksums and scalar evidence without source traces');

    for (const pathname of [
      '/index.html',
      '/cosim.html',
      '/cosim.css',
      '/assets3d/catalog.js',
      '/profiles/index.json',
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        headers: { 'X-Battery-Design-Token': token },
      });
      assert.equal(response.status, 200, `${pathname} was not served from the staged tree`);
      assert.ok((await response.arrayBuffer()).byteLength > 0, `${pathname} was empty`);
    }
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      let stopTimer;
      await Promise.race([
        exited,
        new Promise((resolve) => { stopTimer = setTimeout(resolve, 2_000); }),
      ]);
      clearTimeout(stopTimer);
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});
