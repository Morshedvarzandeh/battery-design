import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeCalibrationDataset } from '../js/calibration-dataset.js';
import {
  importCalibrationDataset, materializeCalibrationImportMapping,
} from '../js/calibration-import.js';
import { semanticDigest } from '../js/ontology.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'desktop', 'bd.mjs');
const TOKEN = '0123456789abcdef'.repeat(4);
const TOKEN_HEADER = 'X-Battery-Design-Token';
const REQUEST_FORMAT = 'battery-design/calibration-request@1';
const RESULT_FORMAT = 'battery-design/calibration-result@1';
const CELL_ID = 'samsung-inr21700-50e';

function dataset({
  id = 'synthetic-run-1', purpose = 'calibration', cellId = CELL_ID,
  samples = 4, moduleCount = 1, samplePeriodS = 1, withTemperature = false,
  seriesCells = moduleCount, parallelCells = 1,
} = {}) {
  return materializeCalibrationDataset({
    id,
    kind: 'synthetic',
    purpose,
    source: {
      tool: 'External solver fixture', toolVersion: '1.0', model: 'cell-model',
      runId: id, generatedAt: '2026-08-07T12:00:00Z',
      mediaType: 'application/json', rawSha256: semanticDigest(`raw:${id}`),
    },
    binding: {
      cellId, seriesCells, parallelCells, startSoC: 0.9,
      ambientC: 25, moduleCount, initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'canonical-json', adapterVersion: '1.0.0',
      mappingChecksum: semanticDigest({ fixture: id }),
      sourceUnits: {
        time: 's', current: 'A', voltage: 'V',
        temperature: withTemperature ? 'degC' : null,
      },
      sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal',
      sourceTemperatureLocation: withTemperature ? 'module-maximum' : null,
      sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: 0,
      sourceResetTimeS: -samplePeriodS, timeHandling: 'validated-uniform',
      originalSampleCount: samples,
    },
    samplePeriodS,
    signals: {
      currentA: Array.from({ length: samples }, (_, index) => index % 3 === 0 ? 0 : 1),
      voltageV: Array.from({ length: samples }, (_, index) => 4.1 - (index % 100) * 0.0001),
      temperatureC: withTemperature
        ? Array.from({ length: samples }, (_, index) => 25 + index * 0.2)
        : null,
    },
    segments: [{
      id: 'full', startIndex: 0, endIndexExclusive: samples,
      mode: 'dynamic', include: true,
    }],
    conventions: {
      timeBasis: 'uniform-sample-period', timeOrigin: 'trial-reset',
      firstSampleOffsetS: samplePeriodS, sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold', currentPositive: 'discharge', currentScope: 'pack',
      voltageLocation: 'pack-terminal',
      temperatureLocation: withTemperature ? 'module-maximum' : null,
    },
  });
}

function mapping() {
  return materializeCalibrationImportMapping({
    adapter: 'delimited-columns', delimiter: ',',
    dataset: { id: 'mapped-synthetic-run', kind: 'synthetic', purpose: 'calibration' },
    source: {
      tool: 'GT-compatible synthetic fixture', toolVersion: '1.0',
      model: 'cell-model', runId: 'mapped-run', generatedAt: '2026-08-07T12:00:00Z',
    },
    binding: {
      cellId: CELL_ID, seriesCells: 1, parallelCells: 1,
      startSoC: 0.9, ambientC: 25, moduleCount: 1,
      initialState: 'rested-equilibrium-at-ambient',
    },
    columns: { time: 'solver_time', current: 'pack_i', voltage: 'pack_v', temperature: null },
    units: { time: 's', current: 'A', voltage: 'V', temperature: null },
    sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
    sourceVoltageLocation: 'pack-terminal', sourceTemperatureLocation: null,
    sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: 0,
    timeToleranceS: 0,
    segments: null,
  });
}

function runCli(args, timeout = 15_000) {
  return spawnSync(process.execPath, [RUNNER, 'calibrate', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout,
  });
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRunner(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [RUNNER, 'serve', '--port', String(port), '--token', TOKEN], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    if (child.exitCode == null) await Promise.race([
      once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) throw new Error(`runner exited ${child.exitCode}: ${stderr || stdout}`);
    try {
      const response = await fetch(`${base}/api/capabilities`, { headers: { [TOKEN_HEADER]: TOKEN } });
      if (response.ok) return base;
    } catch { /* runner is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`runner did not start: ${stderr || stdout}`);
}

async function api(base, body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers[TOKEN_HEADER] = token;
  return fetch(`${base}/api/calibrate`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

function request(datasets, overrides = {}) {
  return {
    format: REQUEST_FORMAT,
    datasets,
    fit: ['r0Ref'],
    maxIter: 1,
    maxEvaluations: 4,
    maxModuleWeightedIntegrationSteps: 100_000,
    maxSamplesPerDataset: 8,
    ...overrides,
  };
}

function containsRawCalibrationSeries(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (['signals', 'currentA', 'voltageV'].includes(key)) return true;
    if (key === 'temperatureC' && Array.isArray(child)) return true;
    if (containsRawCalibrationSeries(child)) return true;
  }
  return false;
}

test('CLI normalizes exact source bytes, emits reusable canonical data and separates params from evidence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'battery-design-calibration-cli-'));
  try {
    const sourceFile = path.join(dir, 'solver.csv');
    const mappingFile = path.join(dir, 'mapping.json');
    const datasetOut = path.join(dir, 'canonical.json');
    const evidenceOut = path.join(dir, 'evidence.json');
    const paramsOut = path.join(dir, 'params.json');
    const source = '\uFEFFsolver_time,pack_i,pack_v\r\n0,0,4.1\r\n1,1,4.095\r\n2,1,4.09\r\n3,0,4.085';
    const importMap = mapping();
    writeFileSync(sourceFile, source);
    writeFileSync(mappingFile, JSON.stringify(importMap));

    const run = runCli([
      '--data', sourceFile, '--mapping', mappingFile, '--cell', CELL_ID,
      '--fit', 'r0Ref', '--iter', '1', '--max-evaluations', '4',
      '--max-module-work', '100000', '--max-samples', '8',
      '--dataset-out', datasetOut, '--out', evidenceOut, '--params-out', paramsOut,
    ]);
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const expectedDataset = importCalibrationDataset(source, importMap);
    const canonical = JSON.parse(readFileSync(datasetOut, 'utf8'));
    const evidence = JSON.parse(readFileSync(evidenceOut, 'utf8'));
    const params = JSON.parse(readFileSync(paramsOut, 'utf8'));
    assert.deepEqual(canonical, expectedDataset, 'dataset-out is the exact reusable canonical import');
    assert.equal(canonical.source.rawSha256,
      createHash('sha256').update(readFileSync(sourceFile)).digest('hex'),
      'source custody hashes the exact valid UTF-8 file bytes, including its BOM and CRLF');
    assert.equal(evidence.format, RESULT_FORMAT);
    assert.deepEqual(evidence.datasetChecksums, [canonical.checksum]);
    assert.deepEqual(evidence.request.datasetChecksums, [canonical.checksum]);
    assert.deepEqual(evidence.request.fit, ['r0Ref']);
    assert.equal(evidence.request.maxIter, 1);
    assert.equal(evidence.request.weightTemp, 0);
    assert.deepEqual(evidence.fit, evidence.request.fit);
    assert.equal(evidence.maxIter, evidence.request.maxIter);
    assert.equal(evidence.weightTemp, evidence.request.weightTemp);
    assert.equal(evidence.algorithm.id, 'bounded-nelder-mead');
    assert.match(evidence.model.implementationChecksum, /^[0-9a-f]{64}$/);
    assert.match(evidence.model.cellChecksum, /^[0-9a-f]{64}$/);
    assert.equal(evidence.requestChecksum, semanticDigest(evidence.request));
    const evidenceBody = { ...evidence };
    delete evidenceBody.checksum;
    assert.equal(evidence.checksum, semanticDigest(evidenceBody));
    assert.match(evidence.checksumSemantics, /identify exact canonical content.*do not authenticate/);
    assert.deepEqual(params, evidence.params, 'params-out contains the directly loadable parameter object only');
    const simulation = spawnSync(process.execPath, [
      RUNNER, 'sim2', '--app', 'ev', '--params', paramsOut, '--json',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
    assert.equal(simulation.status, 0, simulation.stderr || simulation.stdout);
    assert.equal(JSON.parse(simulation.stdout).params.r0Ref, params.r0Ref,
      'params-out is directly consumable by sim2 without extracting evidence fields');
    assert.equal(evidence.preprocessing[0].checksum, canonical.checksum);
    assert.ok(evidence.evaluationCount <= evidence.maxEvaluations);
    assert.ok(evidence.moduleWeightedIntegrationStepCount <= evidence.maxModuleWeightedIntegrationSteps);
    assert.equal(containsRawCalibrationSeries(evidence), false,
      'full evidence contains scalar initial-state provenance and work, never raw signal arrays');

    const canonicalRun = runCli([
      '--dataset', datasetOut, '--fit', 'r0Ref', '--iter', '1',
      '--max-evaluations', '4', '--max-module-work', '100000',
      '--max-samples', '8', '--json',
    ]);
    assert.equal(canonicalRun.status, 0, canonicalRun.stderr || canonicalRun.stdout);
    const canonicalEvidence = JSON.parse(canonicalRun.stdout);
    assert.deepEqual(canonicalEvidence.datasetChecksums, evidence.datasetChecksums,
      'source-import and canonical-file modes fit the same immutable dataset');
    assert.deepEqual(canonicalEvidence.params, evidence.params,
      'source-import and canonical-file modes are numerically identical');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI keeps physical RMSE units separate from a weighted temperature objective', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'battery-design-calibration-weighted-cli-'));
  try {
    const canonicalFile = path.join(dir, 'canonical.json');
    writeFileSync(canonicalFile, JSON.stringify(dataset({
      id: 'weighted-temperature-cli', samples: 8, withTemperature: true,
    })));
    const args = [
      '--dataset', canonicalFile, '--fit', 'r0Ref', '--iter', '1',
      '--weight-temp', '0.5', '--max-evaluations', '4',
      '--max-module-work', '100000', '--max-samples', '8',
    ];
    const machineRun = runCli([...args, '--json']);
    assert.equal(machineRun.status, 0, machineRun.stderr || machineRun.stdout);
    const evidence = JSON.parse(machineRun.stdout);
    assert.equal(evidence.weightTemp, 0.5);
    assert.notEqual(evidence.rmseBefore, evidence.voltageRmseBefore,
      'the fixture exercises a real voltage-plus-temperature objective');

    const humanRun = runCli(args);
    assert.equal(humanRun.status, 0, humanRun.stderr || humanRun.stdout);
    assert.match(humanRun.stdout, new RegExp(
      `^  Voltage RMSE ${evidence.voltageRmseBefore.toFixed(4)} V → ${evidence.voltageRmseAfter.toFixed(4)} V$`, 'm',
    ));
    assert.match(humanRun.stdout, new RegExp(
      `^  Temperature RMSE ${evidence.temperatureRmseBefore.toFixed(4)} °C → ${evidence.temperatureRmseAfter.toFixed(4)} °C$`, 'm',
    ));
    const scoreLine = humanRun.stdout.split('\n')
      .find((line) => line.startsWith('  Weighted objective score '));
    assert.equal(
      scoreLine,
      `  Weighted objective score ${evidence.rmseBefore.toFixed(4)} → ${evidence.rmseAfter.toFixed(4)} (temperature weight 0.5; ${evidence.improvementPct.toFixed(1)}% objective improvement, ${evidence.iterations} iterations)`,
    );
    assert.doesNotMatch(scoreLine, /(?:\sV\b|°C)/,
      'the mixed-unit weighted score is never labeled as volts or degrees Celsius');
    assert.doesNotMatch(humanRun.stdout, /^\s*RMSE .* V/m,
      'the old ambiguous combined-RMSE-as-volts line is absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI is closed, preserves its inputs and rejects unknown binding or invalid UTF-8', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'battery-design-calibration-cli-reject-'));
  try {
    const sourceFile = path.join(dir, 'solver.csv');
    const invalidFile = path.join(dir, 'invalid.csv');
    const mappingFile = path.join(dir, 'mapping.json');
    const canonicalFile = path.join(dir, 'unknown-cell.json');
    const knownFile = path.join(dir, 'known.json');
    const sameOutput = path.join(dir, 'same.json');
    const source = 'solver_time,pack_i,pack_v\n0,0,4.1\n1,1,4.0\n2,0,4.05';
    writeFileSync(sourceFile, source);
    writeFileSync(invalidFile, Buffer.from([0x73, 0x6f, 0x6c, 0x76, 0x65, 0x72, 0xff, 0x0a]));
    writeFileSync(mappingFile, JSON.stringify(mapping()));
    writeFileSync(canonicalFile, JSON.stringify(dataset({ cellId: 'not-a-library-cell' })));
    writeFileSync(knownFile, JSON.stringify(dataset()));

    const alias = runCli(['--data', sourceFile, '--map', mappingFile]);
    assert.equal(alias.status, 2);
    assert.match(alias.stderr, /--mapping MAP\.json; --map is not an alias/);

    const collision = runCli([
      '--data', sourceFile, '--mapping', mappingFile, '--dataset-out', sourceFile,
    ]);
    assert.equal(collision.status, 2);
    assert.match(collision.stderr, /same path as --data/);
    assert.equal(readFileSync(sourceFile, 'utf8'), source, 'a rejected output collision does not overwrite source custody');

    const same = runCli([
      '--dataset', knownFile, '--out', sameOutput, '--params-out', sameOutput,
    ]);
    assert.equal(same.status, 2);
    assert.match(same.stderr, /--out must not resolve to the same path as --params-out/);

    const invalid = runCli(['--data', invalidFile, '--mapping', mappingFile]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /must be valid UTF-8; invalid bytes are never replaced/);

    const unknown = runCli(['--dataset', canonicalFile]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /not in the shipped cell library/);

    const wrongCrossCheck = runCli([
      '--dataset', knownFile, '--cell', 'lg-m50lt',
    ]);
    assert.equal(wrongCrossCheck.status, 2);
    assert.match(wrongCrossCheck.stderr, /does not match immutable dataset binding\.cellId/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI and authenticated API return deterministic numerical evidence for one canonical input', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'battery-design-calibration-parity-'));
  try {
    const canonical = dataset({ id: 'surface-parity-run', samples: 8, moduleCount: 2 });
    const datasetFile = path.join(dir, 'canonical.json');
    writeFileSync(datasetFile, JSON.stringify(canonical));
    const cliArgs = [
      '--dataset', datasetFile,
      '--fit', 'r0Ref',
      '--iter', '3',
      '--max-evaluations', '6',
      '--max-module-work', '100000',
      '--max-samples', '8',
      '--json',
    ];
    const runCliOnce = () => {
      const run = runCli(cliArgs);
      assert.equal(run.status, 0, run.stderr || run.stdout);
      return JSON.parse(run.stdout);
    };
    const cliFirst = runCliOnce();
    const cliSecond = runCliOnce();
    assert.deepEqual(cliSecond, cliFirst,
      'repeating the CLI command produces byte-equivalent parsed evidence');

    const base = await startRunner(t);
    const apiBody = request([canonical], {
      maxIter: 3,
      maxEvaluations: 6,
      maxModuleWeightedIntegrationSteps: 100_000,
      maxSamplesPerDataset: 8,
    });
    const runApiOnce = async () => {
      const response = await api(base, apiBody);
      const evidence = await response.json();
      assert.equal(response.status, 200, evidence.error);
      return evidence;
    };
    const apiFirst = await runApiOnce();
    const apiSecond = await runApiOnce();
    assert.deepEqual(apiSecond, apiFirst,
      'repeating the authenticated API request produces identical evidence');

    const withoutSurfaceEvidence = (evidence) => {
      const result = structuredClone(evidence);
      delete result.surfaceLimits;
      delete result.checksum;
      return result;
    };
    assert.deepEqual(withoutSurfaceEvidence(apiFirst), withoutSurfaceEvidence(cliFirst),
      'CLI and API expose the identical calibration parameters, metrics, work and provenance');
    assert.equal(cliFirst.requestChecksum, apiFirst.requestChecksum,
      'the same governed numerical request has one identity across execution surfaces');
    assert.notEqual(cliFirst.checksum, apiFirst.checksum,
      'complete result identity includes the surface-specific execution evidence');
    assert.equal(cliFirst.surfaceLimits.surface, 'cli');
    assert.equal(apiFirst.surfaceLimits.surface, 'local-api');
    assert.notEqual(cliFirst.surfaceLimits.maxInputSamples, apiFirst.surfaceLimits.maxInputSamples,
      'only the intentionally different surface input ceilings remain distinct');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authenticated local API is versioned, canonical-only, bounded and does not echo raw traces', async (t) => {
  const base = await startRunner(t);
  const canonical = dataset();

  const unauthenticated = await api(base, request(canonical), null);
  assert.equal(unauthenticated.status, 401, 'calibration remains behind the per-launch token');

  const capabilitiesResponse = await fetch(`${base}/api/capabilities`, {
    headers: { [TOKEN_HEADER]: TOKEN },
  });
  const capabilities = await capabilitiesResponse.json();
  assert.ok(capabilities.localApiCapabilities.some(({ id }) => id === 'calibration'));
  assert.ok(capabilities.cliCapabilities.some(({ id }) => id === 'calibration'));
  assert.ok(!capabilities.capabilities.some(({ id }) => id === 'calibration'));
  assert.ok(!capabilities.mcpCapabilities.some(({ id }) => id === 'calibration'),
    'calibration is advertised only on the two surfaces that implement it');
  assert.deepEqual(capabilities.calibrationLimits, {
    requestFormat: REQUEST_FORMAT,
    resultFormat: RESULT_FORMAT,
    maxBodyBytes: 4 * 1024 * 1024,
    maxDatasets: 8,
    maxInputSamples: 20_000,
    maxModules: 64,
    maxPreprocessedSamplesPerDataset: 5_000,
    maxEvaluations: 500,
    maxModuleWeightedIntegrationSteps: 2_000_000,
  });

  const accepted = await api(base, request([canonical]));
  const result = await accepted.json();
  assert.equal(accepted.status, 200, result.error);
  assert.equal(result.format, RESULT_FORMAT);
  assert.equal(result.cell, CELL_ID, 'cell selection derives from immutable dataset binding');
  assert.deepEqual(result.datasetChecksums, [canonical.checksum]);
  assert.equal(result.requestChecksum, semanticDigest(result.request));
  const resultBody = { ...result };
  delete resultBody.checksum;
  assert.equal(result.checksum, semanticDigest(resultBody));
  assert.deepEqual(result.request.fit, ['r0Ref']);
  assert.equal(result.request.maxIter, 1);
  assert.equal(result.request.weightTemp, 0);
  assert.deepEqual(result.fit, result.request.fit);
  assert.equal(result.maxIter, result.request.maxIter);
  assert.equal(result.weightTemp, result.request.weightTemp);
  assert.match(result.model.implementationChecksum, /^[0-9a-f]{64}$/);
  assert.equal(result.preprocessing[0].checksum, canonical.checksum);
  assert.ok(result.evaluationCount <= result.maxEvaluations);
  assert.equal(result.moduleWeightedIntegrationStepCount,
    result.integrationStepCount * canonical.binding.moduleCount,
    'surface evidence projects the core exact cumulative adaptive thermal-node counter');
  assert.equal(result.moduleWeightedWorkPerEvaluation,
    result.workPerEvaluation * canonical.binding.moduleCount,
    'per-evaluation module work includes every adaptive temporal microstep');
  assert.ok(result.moduleWeightedIntegrationStepCount <= result.maxModuleWeightedIntegrationSteps);
  assert.doesNotMatch(JSON.stringify(result), /"(?:datasets|dataset|measured)"\s*:/);
  assert.equal(containsRawCalibrationSeries(result), false,
    'API response returns checksum/preprocessing/work evidence without raw request channels');

  const changedRequestResponse = await api(base, request(canonical, { weightTemp: 999_999 }));
  const changedRequest = await changedRequestResponse.json();
  assert.equal(changedRequestResponse.status, 200, changedRequest.error);
  assert.equal(changedRequest.request.weightTemp, 999_999);
  assert.notEqual(changedRequest.requestChecksum, result.requestChecksum,
    'a different governed objective weight always has a different request identity');
  assert.notEqual(changedRequest.checksum, result.checksum,
    'result evidence remains distinguishable even when absent temperature makes fitted numbers equal');
  assert.deepEqual(changedRequest.params, result.params);

  for (const [body, expected] of [
    [{ ...request(canonical), formt: REQUEST_FORMAT }, /unsupported field\(s\): formt/],
    [{ ...request(canonical), cell: CELL_ID }, /unsupported field\(s\): cell/],
    [{ ...request(canonical), sourceUrl: 'https:\/\/example.invalid\/trace.csv' }, /unsupported field\(s\): sourceUrl/],
    [{ ...request(canonical), path: '/tmp/trace.json' }, /unsupported field\(s\): path/],
    [{ ...request(canonical), format: 'battery-design/calibration-request@2' }, /format must equal/],
  ]) {
    const response = await api(base, body);
    const rejected = await response.json();
    assert.equal(response.status, 400);
    assert.match(rejected.error, expected);
  }

  const validationOnly = await api(base, request(dataset({
    id: 'validation-only', purpose: 'validation',
  })));
  assert.equal(validationOnly.status, 400);
  assert.match((await validationOnly.json()).error, /purpose "validation"; calibration purpose is required/);

  const unknownCell = await api(base, request(dataset({
    id: 'unknown-cell', cellId: 'not-a-library-cell',
  })));
  assert.equal(unknownCell.status, 400);
  assert.match((await unknownCell.json()).error, /not in the shipped cell library/);

  const tooManySamples = await api(base, request(dataset({
    id: 'over-api-sample-cap', samples: 20_001,
  })));
  assert.equal(tooManySamples.status, 400);
  assert.match((await tooManySamples.json()).error, /20,001 total samples; the surface limit is 20,000/);

  const tooManyModules = await api(base, request(dataset({
    id: 'over-module-cap', moduleCount: 65,
  })));
  assert.equal(tooManyModules.status, 400);
  assert.match((await tooManyModules.json()).error, /allow at most 64/);

  const costlyModules = await api(base, request(dataset({
    id: 'module-weighted-budget', samples: 3, moduleCount: 64, samplePeriodS: 3_600,
  }), {
    params: { maxDtS: 0.5 }, maxEvaluations: 2,
    maxModuleWeightedIntegrationSteps: 2_000_000,
  }));
  assert.equal(costlyModules.status, 400);
  assert.match((await costlyModules.json()).error, /exceeds the applied 2,000,000 module-weighted integration-step budget/);

  const adaptiveThermalWork = await api(base, request(dataset({
    id: 'adaptive-thermal-module-budget', samples: 3, samplePeriodS: 60,
    seriesCells: 64, parallelCells: 1, moduleCount: 64,
  }), {
    params: {
      cpCellJkgK: 300, kCondWK: 200, hCoolWK: 500, uaAmbWK: 200,
      mdotKgS: 5, cpCoolJkgK: 4200, maxDtS: 60,
    },
    maxEvaluations: 2,
    maxModuleWeightedIntegrationSteps: 2_000_000,
  }));
  const adaptiveThermalError = await adaptiveThermalWork.json();
  assert.equal(adaptiveThermalWork.status, 400);
  assert.match(adaptiveThermalError.error,
    /exceeds the applied 2,000,000 module-weighted integration-step budget/);
  assert.match(adaptiveThermalError.error, /initial simplex \(780,192 steps\)/,
    'calibration budgets exact adaptive temporal microsteps before multiplying by the governed 64-module topology');
});
