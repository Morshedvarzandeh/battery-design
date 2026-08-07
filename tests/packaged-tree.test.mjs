import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import {
  OPTIONAL_RUNTIME_ENTRIES,
  REQUIRED_RUNTIME_ENTRIES,
  stageApplication,
} from '../desktop-app/prepare.mjs';
import { materializeCalibrationDataset } from '../js/calibration-dataset.js';

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
      'js/sim2.js',
    ]) {
      assert.ok(existsSync(path.join(staged, relative)), `calibration runtime dependency was not staged: ${relative}`);
    }

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
