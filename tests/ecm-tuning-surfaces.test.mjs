import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeCalibrationDataset } from '../js/calibration-dataset.js';
import { cellById } from '../js/cells.js';
import {
  ECM_TUNING_ACCEPTANCE_FIELDS, ECM_TUNING_GROUPS, ECM_TUNING_PLAN_FORMAT,
} from '../js/ecm-tuning.js';
import { ECM_TUNING_RESULT_FORMAT } from '../js/ecm-tuning-executor.js';
import { semanticDigest } from '../js/ontology.js';
import { defaultParams, simulate } from '../js/sim2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'desktop', 'bd.mjs');
const TOKEN = '0123456789abcdef'.repeat(4);
const TOKEN_HEADER = 'X-Battery-Design-Token';
const REQUEST_FORMAT = 'battery-design/ecm-tuning-request@1';
const RUN_FORMAT = 'battery-design/ecm-tuning-run@1';
const CELL = cellById('samsung-inr21700-50e');
const MODEL_DEPENDENCIES = [
  'js/ecm-tuning.js',
  'js/ecm-tuning-executor.js',
  'js/calibration-dataset.js',
  'js/sim2.js',
  'js/sim1d.js',
  'js/cells.js',
];
const ACCEPTANCE_FIELDS = [
  'maxVoltageRmseMvPerCell',
  'maxVoltageMaxAbsMvPerCell',
  'maxTemperatureRmseC',
  'maxTemperatureMaxAbsC',
  'minValidationDatasets',
  'minIncludedSamplesPerDataset',
  'requiredModes',
  'requireNoHoldoutRegression',
  'requireNoFittedParameterAtBound',
];

function acceptance(overrides = {}) {
  return {
    maxVoltageRmseMvPerCell: 100,
    maxVoltageMaxAbsMvPerCell: 200,
    maxTemperatureRmseC: null,
    maxTemperatureMaxAbsC: null,
    minValidationDatasets: 1,
    minIncludedSamplesPerDataset: 20,
    requiredModes: ['dynamic'],
    requireNoHoldoutRegression: true,
    requireNoFittedParameterAtBound: true,
    ...overrides,
  };
}

function protocol(amplitudeA = 8) {
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

function governedDataset({
  id,
  purpose,
  currentA,
  truth,
  startSoC = 0.6,
  ambientC = 25,
  moduleCount = 1,
  samplePeriodS = 1,
  withTemperature = false,
  voltageOffsetV = 0,
} = {}) {
  const simulated = simulate({
    cell: CELL,
    s: 1,
    p: 1,
    nModules: moduleCount,
    params: truth,
    profile: { dtS: samplePeriodS, i: currentA },
    startSoC,
    ambientC,
  });
  return materializeCalibrationDataset({
    id,
    kind: 'synthetic',
    purpose,
    source: {
      tool: 'ECM tuning surface fixture',
      toolVersion: '1.0.0',
      model: 'sim2-truth',
      runId: id,
      generatedAt: null,
      mediaType: 'application/json',
      rawSha256: semanticDigest(`raw:${id}`),
    },
    binding: {
      cellId: CELL.id,
      seriesCells: 1,
      parallelCells: 1,
      startSoC,
      ambientC,
      moduleCount,
      initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'canonical-json',
      adapterVersion: '1.0.0',
      mappingChecksum: semanticDigest(`mapping:${id}`),
      sourceUnits: {
        time: 's', current: 'A', voltage: 'V',
        temperature: withTemperature ? 'degC' : null,
      },
      sourceCurrentPositive: 'discharge',
      sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal',
      sourceTemperatureLocation: withTemperature ? 'module-maximum' : null,
      sourceSampleAlignment: 'end-of-step',
      sourceFirstSampleTimeS: samplePeriodS,
      sourceResetTimeS: 0,
      timeHandling: 'validated-uniform',
      originalSampleCount: currentA.length,
    },
    samplePeriodS,
    signals: {
      currentA,
      voltageV: simulated.series.v.map((value) => value + voltageOffsetV),
      temperatureC: withTemperature ? simulated.series.tMax : null,
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
      firstSampleOffsetS: samplePeriodS,
      sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold',
      currentPositive: 'discharge',
      currentScope: 'pack',
      voltageLocation: 'pack-terminal',
      temperatureLocation: withTemperature ? 'module-maximum' : null,
    },
  });
}

function capDataset({ id, purpose, samples, moduleCount = 1 }) {
  return materializeCalibrationDataset({
    id,
    kind: 'synthetic',
    purpose,
    source: {
      tool: 'ECM cap fixture', toolVersion: '1.0.0', model: 'constant', runId: id,
      generatedAt: null, mediaType: 'application/json', rawSha256: semanticDigest(`raw:${id}`),
    },
    binding: {
      cellId: CELL.id, seriesCells: 1, parallelCells: 1, startSoC: 0.6,
      ambientC: 25, moduleCount, initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1',
      adapter: 'canonical-json', adapterVersion: '1.0.0',
      mappingChecksum: semanticDigest(`mapping:${id}`),
      sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: null },
      sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal', sourceTemperatureLocation: null,
      sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: 1,
      sourceResetTimeS: 0, timeHandling: 'validated-uniform',
      originalSampleCount: samples,
    },
    samplePeriodS: 1,
    signals: {
      currentA: Array(samples).fill(0),
      voltageV: Array(samples).fill(4),
      temperatureC: null,
    },
    segments: [{
      id: 'complete', startIndex: 0, endIndexExclusive: samples,
      mode: 'dynamic', include: true,
    }],
    conventions: {
      timeBasis: 'uniform-sample-period', timeOrigin: 'trial-reset',
      firstSampleOffsetS: 1, sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold', currentPositive: 'discharge',
      currentScope: 'pack', voltageLocation: 'pack-terminal', temperatureLocation: null,
    },
  });
}

function fixture(t, {
  acceptanceOverrides = {},
  withTemperature = false,
  validationVoltageOffsetV = 0,
  validationSameTrial = false,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'battery-design-ecm-tuning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = defaultParams(CELL);
  const truth = { ...initial, r0Ref: initial.r0Ref * 1.35 };
  const calibrationDatasets = [governedDataset({
    id: 'surface-calibration', purpose: 'calibration', currentA: protocol(8),
    truth, startSoC: 0.6, withTemperature,
  })];
  const validationDatasets = [governedDataset({
    id: 'surface-validation', purpose: 'validation',
    currentA: validationSameTrial ? protocol(8) : protocol(7.3),
    truth,
    startSoC: validationSameTrial ? 0.6 : 0.65,
    withTemperature,
    voltageOffsetV: validationVoltageOffsetV,
  })];
  const policy = acceptance({
    ...(withTemperature
      ? { maxTemperatureRmseC: 5, maxTemperatureMaxAbsC: 10 }
      : {}),
    ...acceptanceOverrides,
  });
  const files = {
    calibration: path.join(dir, 'calibration.json'),
    validation: path.join(dir, 'validation.json'),
    acceptance: path.join(dir, 'acceptance.json'),
    params: path.join(dir, 'initial-params.json'),
  };
  writeFileSync(files.calibration, JSON.stringify(calibrationDatasets));
  writeFileSync(files.validation, JSON.stringify(validationDatasets));
  writeFileSync(files.acceptance, JSON.stringify(policy));
  writeFileSync(files.params, JSON.stringify(initial));
  return {
    dir, files, initial, truth, policy, calibrationDatasets, validationDatasets,
  };
}

function baseCliArgs(prepared) {
  return [
    '--calibration', prepared.files.calibration,
    '--validation', prepared.files.validation,
    '--acceptance', prepared.files.acceptance,
    '--params', prepared.files.params,
    '--groups', 'ohmic',
    '--max-evaluations', '24',
    '--max-module-work', '200000',
    '--max-samples', '5000',
  ];
}

function runCommand(command, args, timeout = 30_000) {
  return spawnSync(process.execPath, [RUNNER, command, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout,
  });
}

function runTune(prepared, extra = [], timeout = 30_000) {
  return runCommand('tune-ecm', [...baseCliArgs(prepared), ...extra], timeout);
}

function apiRequest(prepared, overrides = {}) {
  return {
    format: REQUEST_FORMAT,
    calibrationDatasets: prepared.calibrationDatasets,
    validationDatasets: prepared.validationDatasets,
    acceptance: prepared.policy,
    params: prepared.initial,
    groups: ['ohmic'],
    maxEvaluations: 24,
    maxModuleWeightedIntegrationSteps: 200_000,
    maxSamplesPerDataset: 5_000,
    ...overrides,
  };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return port;
}

async function startRunner(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [
    RUNNER, 'serve', '--port', String(port), '--token', TOKEN,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    if (child.exitCode == null) await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) {
      throw new Error(`runner exited ${child.exitCode}: ${stderr || stdout}`);
    }
    try {
      const response = await fetch(`${base}/api/capabilities`, {
        headers: { [TOKEN_HEADER]: TOKEN },
      });
      if (response.ok) return base;
    } catch { /* runner is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`runner did not start: ${stderr || stdout}`);
}

async function postTune(base, body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers[TOKEN_HEADER] = token;
  return fetch(`${base}/api/tune-ecm`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

function checksumBody(value) {
  const body = { ...value };
  delete body.checksum;
  return body;
}

function containsRawSeries(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'signals') return true;
    if (['currentA', 'voltageV', 'temperatureC'].includes(key) && Array.isArray(child)) {
      return true;
    }
    if (containsRawSeries(child)) return true;
  }
  return false;
}

test('CLI writes an accepted immutable run and always writes the adopted parameters separately', (t) => {
  const prepared = fixture(t);
  const runFile = path.join(prepared.dir, 'run.json');
  const paramsFile = path.join(prepared.dir, 'adopted.json');
  const completed = runTune(prepared, ['--out', runFile, '--params-out', paramsFile]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  const adopted = JSON.parse(readFileSync(paramsFile, 'utf8'));
  assert.equal(run.format, RUN_FORMAT);
  assert.equal(run.plan.format, ECM_TUNING_PLAN_FORMAT);
  assert.equal(run.result.format, ECM_TUNING_RESULT_FORMAT);
  assert.equal(run.result.callerPolicyVerdict.accepted, true);
  assert.deepEqual(adopted, run.result.adoptedParams);
  assert.equal(run.model.id, 'battery-design/staged-ecm-arrhenius-tuning');
  assert.equal(run.model.version, '1.0.0');
  assert.equal(run.surfaceLimits.maxPreprocessedSamplesPerDataset, 20_000);
  assert.equal(run.surfaceLimits.appliedMaxPreprocessedSamplesPerDataset, 5_000);
  assert.equal(containsRawSeries(run), false);
});

test('CLI rejection artifact preserves the exact initial parameters as the adopted params-out', (t) => {
  const prepared = fixture(t, {
    acceptanceOverrides: {
      maxVoltageRmseMvPerCell: 1e-9,
      maxVoltageMaxAbsMvPerCell: 1e-9,
    },
  });
  const runFile = path.join(prepared.dir, 'rejected-run.json');
  const paramsFile = path.join(prepared.dir, 'rejected-adopted.json');
  const completed = runTune(prepared, ['--out', runFile, '--params-out', paramsFile]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  const adopted = JSON.parse(readFileSync(paramsFile, 'utf8'));
  assert.equal(run.result.callerPolicyVerdict.accepted, false);
  assert.deepEqual(run.result.adoptedParams, run.result.initialParams);
  assert.deepEqual(adopted, run.result.initialParams);
  assert.notEqual(run.result.candidateParams.r0Ref, run.result.initialParams.r0Ref);
});

test('human output labels mV per cell and degrees Celsius and explains accepted and rejected adoption', (t) => {
  const acceptedFixture = fixture(t, { withTemperature: true });
  const accepted = runTune(acceptedFixture);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, /ECM tuning ACCEPTED/);
  assert.match(accepted.stdout, /mV\/cell/);
  assert.match(accepted.stdout, /°C/);
  assert.match(accepted.stdout, /Parameter groups/);
  assert.match(accepted.stdout, /ohmic: active — executed/);
  assert.match(accepted.stdout, /fast-rc: not requested/);
  assert.match(accepted.stdout, /passed the caller-predeclared acceptance policy/);

  const rejectedFixture = fixture(t, {
    acceptanceOverrides: {
      maxVoltageRmseMvPerCell: 1e-9,
      maxVoltageMaxAbsMvPerCell: 1e-9,
    },
  });
  const rejected = runTune(rejectedFixture);
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.match(rejected.stdout, /ECM tuning REJECTED/);
  assert.match(rejected.stdout, /adopted parameter set remains the exact initial parameters/);
});

test('human auto-group summary carries the planner exact skip reasons instead of a generic omission', (t) => {
  const prepared = fixture(t);
  const args = baseCliArgs(prepared);
  args[args.indexOf('--groups') + 1] = 'auto';
  const completed = runCommand('tune-ecm', args);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.match(completed.stdout,
    /fast-rc: skipped — .*resolve rc1TauS.*pulse\/rest windows/s);
  assert.match(completed.stdout,
    /soc-dependence: skipped — .*three distinguishable symmetric SoC-basis levels/s);
  assert.match(completed.stdout,
    /arrhenius: skipped — .*three near-isothermal cell-average trials spanning 20 K/s);
  assert.match(completed.stdout,
    /hysteresis: skipped — .*Charge and discharge excitation must overlap/s);
});

test('CLI grammar is closed against raw flags, duplicates, positionals and valued booleans', (t) => {
  const prepared = fixture(t);
  const cases = [
    { extra: ['--data', 'raw.csv'], pattern: /does not accept option.*--data/s },
    { extra: ['--groups', 'ohmic'], pattern: /may be supplied only once.*--groups/s },
    { extra: ['unexpected.json'], pattern: /does not accept positional arguments/ },
    { extra: ['--json', 'yes'], pattern: /--json is a boolean flag/ },
  ];
  for (const { extra, pattern } of cases) {
    const completed = runTune(prepared, extra);
    assert.equal(completed.status, 2, `${completed.stderr}\n${completed.stdout}`);
    assert.match(completed.stderr, pattern);
  }
});

test('CLI refuses canonical and inode-equivalent output collisions before overwriting input', (t) => {
  const prepared = fixture(t);
  const originalAcceptance = readFileSync(prepared.files.acceptance);
  const alias = path.join(prepared.dir, 'acceptance-alias.json');
  symlinkSync(prepared.files.acceptance, alias);
  const inputCollision = runTune(prepared, ['--out', alias]);
  assert.equal(inputCollision.status, 2, inputCollision.stderr || inputCollision.stdout);
  assert.match(inputCollision.stderr, /--out must not resolve to the same path as --acceptance/);
  assert.deepEqual(readFileSync(prepared.files.acceptance), originalAcceptance);

  const shared = path.join(prepared.dir, 'same-output.json');
  const outputCollision = runTune(prepared, ['--out', shared, '--params-out', shared]);
  assert.equal(outputCollision.status, 2, outputCollision.stderr || outputCollision.stdout);
  assert.match(outputCollision.stderr, /--out must not resolve to the same path as --params-out/);
  assert.equal(Buffer.compare(readFileSync(prepared.files.acceptance), originalAcceptance), 0);
});

test('CLI caps use strict decimal parsing and reject excessive work before execution', (t) => {
  const prepared = fixture(t);
  const cases = [
    ['--max-evaluations', '24x'],
    ['--max-evaluations', '501'],
    ['--max-module-work', '2000001'],
    ['--max-samples', '20001'],
  ];
  for (const extra of cases) {
    const args = baseCliArgs(prepared);
    const index = args.indexOf(extra[0]);
    args.splice(index, 2, ...extra);
    const completed = runCommand('tune-ecm', args);
    assert.equal(completed.status, 2, `${extra.join(' ')}\n${completed.stderr}`);
    assert.match(completed.stderr, /must be a .*number from|must be a .*decimal number from/);
  }
});

test('authenticated capabilities advertise exact tuning formats, groups and API ceilings', async (t) => {
  const base = await startRunner(t);
  const response = await fetch(`${base}/api/capabilities`, {
    headers: { [TOKEN_HEADER]: TOKEN },
  });
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.ok(capabilities.endpoints.includes('/api/tune-ecm'));
  assert.equal(capabilities.tuningLimits.requestFormat, REQUEST_FORMAT);
  assert.equal(capabilities.tuningLimits.runFormat, RUN_FORMAT);
  assert.equal(capabilities.tuningLimits.planFormat, ECM_TUNING_PLAN_FORMAT);
  assert.equal(capabilities.tuningLimits.resultFormat, ECM_TUNING_RESULT_FORMAT);
  assert.equal(capabilities.tuningLimits.maxCombinedInputSamples, 20_000);
  assert.equal(capabilities.tuningLimits.maxModules, 64);
  assert.equal(capabilities.tuningLimits.maxPreprocessedSamplesPerDataset, 5_000);
  assert.equal(capabilities.tuningLimits.maxEvaluations, 500);
  assert.equal(capabilities.tuningLimits.maxModuleWeightedIntegrationSteps, 2_000_000);
  assert.equal(capabilities.tuningLimits.temporalCeilingDerivation,
    'floor(maxModuleWeightedIntegrationSteps / maximum governed moduleCount)');
  assert.deepEqual(capabilities.tuningLimits.groups, ECM_TUNING_GROUPS.map(({ id }) => id));
});

test('all tuning API reads and writes require the loopback runner token', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const missing = await postTune(base, apiRequest(prepared), null);
  assert.equal(missing.status, 401);
  const invalid = await postTune(base, apiRequest(prepared), `${TOKEN}x`);
  assert.equal(invalid.status, 401);
  const capabilityMissing = await fetch(`${base}/api/capabilities`);
  assert.equal(capabilityMissing.status, 401);
});

test('API executes a closed canonical request and returns a private scalar-only run', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const response = await postTune(base, apiRequest(prepared));
  assert.equal(response.status, 200, await response.clone().text());
  const run = await response.json();
  assert.equal(run.format, RUN_FORMAT);
  assert.equal(run.result.callerPolicyVerdict.accepted, true);
  assert.equal(run.surfaceLimits.surface, 'local-api');
  assert.equal(run.surfaceLimits.maxInputSamples, 20_000);
  assert.equal(run.surfaceLimits.maxPreprocessedSamplesPerDataset, 5_000);
  assert.equal(run.surfaceLimits.appliedMaxPreprocessedSamplesPerDataset, 5_000);
  assert.equal(containsRawSeries(run), false);
});

test('API body is exact-versioned and rejects cell, path, URL, raw and data escape hatches', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  for (const field of ['cell', 'path', 'url', 'raw', 'data']) {
    const response = await postTune(base, { ...apiRequest(prepared), [field]: 'forbidden' });
    assert.equal(response.status, 400, `${field}: ${await response.clone().text()}`);
    const body = await response.json();
    assert.match(body.error, new RegExp(`unsupported field\\(s\\): ${field}`));
  }
  const wrongVersion = await postTune(base, {
    ...apiRequest(prepared), format: 'battery-design/ecm-tuning-request@2',
  });
  assert.equal(wrongVersion.status, 400);
  assert.match((await wrongVersion.json()).error, /format must equal/);
});

test('API rejects numeric strings and every advertised evaluation, module-work and preprocessing cap', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const cases = [
    { maxEvaluations: '24' },
    { maxEvaluations: 501 },
    { maxModuleWeightedIntegrationSteps: 2_000_001 },
    { maxSamplesPerDataset: 5_001 },
  ];
  for (const overrides of cases) {
    const response = await postTune(base, apiRequest(prepared, overrides));
    assert.equal(response.status, 400, `${JSON.stringify(overrides)}: ${await response.text()}`);
  }
});

test('API rejects more than 20k combined samples and more than 64 modeled modules', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const tooManySamples = await postTune(base, apiRequest(prepared, {
    calibrationDatasets: [capDataset({
      id: 'cap-calibration', purpose: 'calibration', samples: 10_001,
    })],
    validationDatasets: [capDataset({
      id: 'cap-validation', purpose: 'validation', samples: 10_000,
    })],
  }));
  assert.equal(tooManySamples.status, 400);
  assert.match((await tooManySamples.json()).error, /20,001 total samples.*20,000/);

  const tooManyModules = await postTune(base, apiRequest(prepared, {
    calibrationDatasets: [capDataset({
      id: 'module-cap-calibration', purpose: 'calibration', samples: 76, moduleCount: 65,
    })],
    validationDatasets: [capDataset({
      id: 'module-cap-validation', purpose: 'validation', samples: 76, moduleCount: 65,
    })],
  }));
  assert.equal(tooManyModules.status, 400);
  assert.match((await tooManyModules.json()).error, /65 modules.*at most 64/);
});

test('API rejects a purpose-renamed calibration trial as holdout leakage', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t, { validationSameTrial: true });
  const response = await postTune(base, apiRequest(prepared));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /Validation dataset .* reuses calibration .*Checksum/);
});

test('CLI and API preserve byte-equivalent plan, result and implementation identity cores', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const cli = runTune(prepared, ['--json']);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const cliRun = JSON.parse(cli.stdout);
  const response = await postTune(base, apiRequest(prepared));
  assert.equal(response.status, 200, await response.clone().text());
  const apiRun = await response.json();
  assert.deepEqual(apiRun.plan, cliRun.plan);
  assert.deepEqual(apiRun.result, cliRun.result);
  assert.deepEqual(apiRun.model, cliRun.model);
  assert.deepEqual(apiRun.inputEvidence, cliRun.inputEvidence);
  assert.notEqual(apiRun.checksum, cliRun.checksum, 'surface ceilings remain authenticated');
});

test('implementation identity hashes exactly the six declared model dependencies', (t) => {
  const prepared = fixture(t);
  const cli = runTune(prepared, ['--json']);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const run = JSON.parse(cli.stdout);
  const expected = Object.fromEntries(MODEL_DEPENDENCIES.map((relative) => [
    relative,
    createHash('sha256').update(readFileSync(path.join(ROOT, relative))).digest('hex'),
  ]));
  assert.deepEqual(run.model.dependencies, MODEL_DEPENDENCIES);
  assert.deepEqual(run.model.dependencySha256, expected);
  assert.equal(run.model.implementationChecksum, semanticDigest(expected));
  assert.equal(run.model.cellChecksum, semanticDigest(CELL));
  assert.equal(run.cellChecksum, run.model.cellChecksum);
});

test('outer, plan and result checksums bind the run while no raw trace arrays escape', (t) => {
  const prepared = fixture(t);
  const first = runTune(prepared, ['--json']);
  const second = runTune(prepared, ['--json']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const run = JSON.parse(first.stdout);
  assert.deepEqual(JSON.parse(second.stdout), run, 'the same CLI request is deterministic');
  assert.equal(run.checksum, semanticDigest(checksumBody(run)));
  assert.equal(run.plan.checksum, semanticDigest(checksumBody(run.plan)));
  assert.equal(run.result.checksum, semanticDigest(checksumBody(run.result)));
  assert.match(run.checksumSemantics, /do not authenticate a producer/);
  assert.equal(containsRawSeries(run), false);
  assert.doesNotMatch(JSON.stringify(run), /"(?:signals|currentA|voltageV|temperatureC)"\s*:/);
});

test('CLI cell is only an exact cross-check against immutable dataset binding', (t) => {
  const prepared = fixture(t);
  const completed = runTune(prepared, ['--cell', 'lfp-18650-1500']);
  assert.equal(completed.status, 2, completed.stderr || completed.stdout);
  assert.match(completed.stderr, /does not match immutable dataset binding\.cellId/);
});

test('Action 1 calibrate CLI remains available with its original result contract', (t) => {
  const prepared = fixture(t);
  const completed = runCommand('calibrate', [
    '--dataset', prepared.files.calibration,
    '--cell', CELL.id,
    '--params', prepared.files.params,
    '--fit', 'r0Ref',
    '--iter', '1',
    '--max-evaluations', '4',
    '--max-module-work', '200000',
    '--max-samples', '76',
    '--json',
  ]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.format, 'battery-design/calibration-result@1');
  assert.equal(result.request.format, 'battery-design/calibration-request@1');
  assert.equal(result.surfaceLimits.surface, 'cli');
  assert.equal(result.model.id, 'battery-design/sim2-ecm-2rc-thermal-chain');
});

test('one exact frozen acceptance contract drives core capability discovery and honest help syntax', async (t) => {
  assert.deepEqual(ECM_TUNING_ACCEPTANCE_FIELDS, ACCEPTANCE_FIELDS);
  assert.equal(Object.isFrozen(ECM_TUNING_ACCEPTANCE_FIELDS), true);
  assert.throws(() => ECM_TUNING_ACCEPTANCE_FIELDS.push('extra'), TypeError);

  const base = await startRunner(t);
  const response = await fetch(`${base}/api/capabilities`, {
    headers: { [TOKEN_HEADER]: TOKEN },
  });
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.deepEqual(capabilities.tuningLimits.acceptanceFields, ACCEPTANCE_FIELDS);

  const help = runCommand('help', []);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /--groups auto\|ID\[,ID\.\.\.\]/);
  assert.ok(help.stdout.includes(
    `group IDs: ${ECM_TUNING_GROUPS.map(({ id }) => id).join(', ')}`,
  ));
});

test('acceptance normalization rejects both missing and unknown fields before tuning work', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const missing = { ...prepared.policy };
  delete missing.maxVoltageRmseMvPerCell;
  const missingResponse = await postTune(base, apiRequest(prepared, { acceptance: missing }));
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).error,
    /acceptance is missing required field\(s\): maxVoltageRmseMvPerCell/);

  const unknownResponse = await postTune(base, apiRequest(prepared, {
    acceptance: { ...prepared.policy, inventedTolerance: 1 },
  }));
  assert.equal(unknownResponse.status, 400);
  assert.match((await unknownResponse.json()).error,
    /acceptance contains unsupported field\(s\): inventedTolerance/);
});

test('acceptance safety invariants cannot be disabled and temperature limits must be paired', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const cases = [
    {
      policy: { ...prepared.policy, requireNoHoldoutRegression: false },
      error: /requireNoHoldoutRegression must be true/,
    },
    {
      policy: { ...prepared.policy, requireNoFittedParameterAtBound: false },
      error: /requireNoFittedParameterAtBound must be true/,
    },
    {
      policy: {
        ...prepared.policy,
        maxTemperatureRmseC: 1,
        maxTemperatureMaxAbsC: null,
      },
      error: /must both be null or both be finite positive limits/,
    },
  ];
  for (const { policy, error } of cases) {
    const response = await postTune(base, apiRequest(prepared, { acceptance: policy }));
    assert.equal(response.status, 400, await response.clone().text());
    assert.match((await response.json()).error, error);
  }
});

test('group selection rejects unknown, duplicate and mistyped identifiers without fallback', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const cases = [
    { value: ['unknown'], error: /groups\[0\] must be one of/ },
    { value: ['ohmic', 'ohmic'], error: /duplicate group "ohmic"/ },
    { value: 'ohmic', error: /groups must equal "auto" or contain/ },
    { value: [1], error: /groups\[0\] must be one of/ },
  ];
  for (const { value, error } of cases) {
    const response = await postTune(base, apiRequest(prepared, { groups: value }));
    assert.equal(response.status, 400, await response.clone().text());
    assert.match((await response.json()).error, error);
  }
});

test('the eight-dataset ceiling is enforced independently on both tuning partitions', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const cases = [
    {
      overrides: { calibrationDatasets: Array(9).fill(prepared.calibrationDatasets[0]) },
      error: /calibrationDatasets must contain 1 to 8 canonical datasets/,
    },
    {
      overrides: { validationDatasets: Array(9).fill(prepared.validationDatasets[0]) },
      error: /validationDatasets must contain 1 to 8 canonical datasets/,
    },
  ];
  for (const { overrides, error } of cases) {
    const response = await postTune(base, apiRequest(prepared, overrides));
    assert.equal(response.status, 400, await response.clone().text());
    assert.match((await response.json()).error, error);
  }
});

test('API rejected candidates remain evidence-only and return the exact initial adopted parameters', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t, {
    acceptanceOverrides: {
      maxVoltageRmseMvPerCell: 1e-9,
      maxVoltageMaxAbsMvPerCell: 1e-9,
    },
  });
  const response = await postTune(base, apiRequest(prepared));
  assert.equal(response.status, 200, await response.clone().text());
  const run = await response.json();
  assert.equal(run.result.callerPolicyVerdict.accepted, false);
  assert.deepEqual(run.result.adoptedParams, run.result.initialParams);
  assert.notDeepEqual(run.result.candidateParams, run.result.adoptedParams);
});

test('tuning route enforces same-origin, JSON content type and its exact HTTP method', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const foreignOrigin = await fetch(`${base}/api/tune-ecm`, {
    method: 'POST',
    headers: {
      [TOKEN_HEADER]: TOKEN,
      'content-type': 'application/json',
      origin: 'https://attacker.invalid',
    },
    body: JSON.stringify(apiRequest(prepared)),
  });
  assert.equal(foreignOrigin.status, 403);

  const wrongType = await fetch(`${base}/api/tune-ecm`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'text/plain' },
    body: JSON.stringify(apiRequest(prepared)),
  });
  assert.equal(wrongType.status, 415);

  const get = await fetch(`${base}/api/tune-ecm`, {
    headers: { [TOKEN_HEADER]: TOKEN },
  });
  assert.equal(get.status, 404);
  const remove = await fetch(`${base}/api/tune-ecm`, {
    method: 'DELETE', headers: { [TOKEN_HEADER]: TOKEN },
  });
  assert.equal(remove.status, 405);
});

test('omitted tuning defaults are byte-equivalent to the same explicit governed values', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const common = {
    format: REQUEST_FORMAT,
    calibrationDatasets: prepared.calibrationDatasets,
    validationDatasets: prepared.validationDatasets,
    acceptance: prepared.policy,
  };
  const implicitResponse = await postTune(base, common);
  assert.equal(implicitResponse.status, 200, await implicitResponse.clone().text());
  const explicitResponse = await postTune(base, {
    ...common,
    params: prepared.initial,
    groups: 'auto',
    maxEvaluations: 500,
    maxModuleWeightedIntegrationSteps: 2_000_000,
    maxSamplesPerDataset: 5_000,
  });
  assert.equal(explicitResponse.status, 200, await explicitResponse.clone().text());
  assert.deepEqual(await explicitResponse.json(), await implicitResponse.json());
});

test('work preflight fails before simulation and leaves the authenticated runner healthy', async (t) => {
  const base = await startRunner(t);
  const prepared = fixture(t);
  const response = await postTune(base, apiRequest(prepared, {
    maxModuleWeightedIntegrationSteps: 10,
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /preflight failed before simulation/);

  const health = await fetch(`${base}/api/capabilities`, {
    headers: { [TOKEN_HEADER]: TOKEN },
  });
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).tuningLimits.acceptanceFields, ACCEPTANCE_FIELDS);
});
