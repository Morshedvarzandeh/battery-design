// Host evidence must be deterministic, role-discovered, and honest about what
// open-source runners do (and do not) prove about proprietary importers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { cellById } from '../js/cells.js';
import { buildFmu } from '../js/fmi.js';
import { compileNativeBinary, packageFmu } from '../tools/fmu-build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const nativePrerequisites = ['cc', 'nm', 'file', 'ldd', 'python3']
  .every((command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
const canRunNative = process.platform === 'linux' && nativePrerequisites;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('host trajectory gates discover the contract by stable roles and cover all signed boundaries', () => {
  const nativeSmoke = read('tools/fmu-smoke.py');
  const fmpySmoke = read('tools/fmpy-smoke.py');
  const evidence = read('tools/fmu_host_evidence.py');
  for (const script of [nativeSmoke, fmpySmoke]) {
    assert.match(script, /SIGNAL_ROLES/);
    assert.match(script, /"id": "idle"/);
    assert.match(script, /"id": "discharge"/);
    assert.match(script, /"id": "charge-after-discharge-preconditioning"/);
    assert.match(script, /"id": "thermal-coolant-boundary"/);
    assert.match(script, /negative_current_increases_soc/);
    assert.match(script, /positive_flow_reduces_temperature/);
  }
  assert.doesNotMatch(fmpySmoke, /["']I_pack["']|["']V_pack["']|["']SoC["']|["']T_cell["']/,
    'the independent host trajectory must resolve actual variable names from packaged roles');
  assert.match(evidence, /battery-design\/fmi-host-trajectory-evidence@1/);
  assert.match(evidence, /unverified-manifest-claim/);
  assert.match(evidence, /not certification or an acceptance/);
  assert.match(evidence, /BATTERY_DESIGN_SOURCE_REVISION/);
});

test('JSON and CSV evidence are deterministic, checksummed, and repeat release identities', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-host-evidence-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const firstJson = join(temporary, 'first.json');
  const firstCsv = join(temporary, 'first.csv');
  const secondJson = join(temporary, 'second.json');
  const secondCsv = join(temporary, 'second.csv');
  const run = spawnSync('python3', ['-c', `
from pathlib import Path
import sys
sys.path.insert(0, str(Path.cwd() / 'tools'))
from fmu_host_evidence import SIGNAL_ROLES, build_evidence, invariant, write_evidence
roles = {}
for index, role in enumerate(SIGNAL_ROLES.values(), start=1):
    roles[role] = {'causality': 'output', 'name': f'v{index}', 'unit': '1', 'valueReference': index}
contract = {
    'artifact': {
        'fmiVersion': '2.0',
        'fmuSha256': 'a' * 64,
        'guid': '{11111111-1111-1111-1111-111111111111}',
        'ioContractChecksum': 'b' * 64,
        'modelIdentifier': 'BatteryPack',
        'modelRevision': 'battery-plant-1rc-v1',
        'sourceRevision': 'c' * 40,
        'sourceRevisionVerification': {'basis': 'trusted-expected-revision', 'verified': True},
    },
    'roles': roles,
}
scenarios = []
for scenario_id in ('idle', 'discharge', 'charge-after-discharge-preconditioning', 'thermal-coolant-boundary'):
    scenarios.append({
        'id': scenario_id,
        'invariants': [invariant(f'{scenario_id}.proof', 'proof', {'value': 1.25})],
        'verdict': 'pass',
    })
evidence = build_evidence(
    contract=contract, host_name='FMPy', host_version='0.3.30', host_platform='linux',
    scenarios=scenarios, roles=list(SIGNAL_ROLES.values()),
)
write_evidence(evidence, Path(sys.argv[1]), Path(sys.argv[2]))
write_evidence(evidence, Path(sys.argv[3]), Path(sys.argv[4]))
`, firstJson, firstCsv, secondJson, secondCsv], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(readFileSync(firstJson), readFileSync(secondJson));
  assert.deepEqual(readFileSync(firstCsv), readFileSync(secondCsv));

  const parsed = JSON.parse(readFileSync(firstJson, 'utf8'));
  const { evidenceChecksum, ...payload } = parsed;
  assert.equal(evidenceChecksum, createHash('sha256').update(canonical(payload)).digest('hex'));
  assert.equal(parsed.artifact.sourceRevisionVerification.verified, true);
  assert.equal(parsed.artifact.fmuSha256, 'a'.repeat(64));
  assert.equal(parsed.artifact.ioContractChecksum, 'b'.repeat(64));
  assert.deepEqual(parsed.scenarios.map(({ id }) => id), [
    'idle', 'discharge', 'charge-after-discharge-preconditioning', 'thermal-coolant-boundary',
  ]);
  const csv = readFileSync(firstCsv, 'utf8');
  assert.match(csv, /source_revision_verified,source_revision_verification_basis/);
  assert.equal(csv.trimEnd().split('\n').length, 5, 'one deterministic CSV row is emitted per invariant');
  assert.equal((csv.match(new RegExp(evidenceChecksum, 'g')) || []).length, 4);
});

test('host evidence fails closed for empty, malformed, or contradictory invariant results', () => {
  const run = spawnSync('python3', ['-c', `
from pathlib import Path
import sys
sys.path.insert(0, str(Path.cwd() / 'tools'))
from fmu_host_evidence import build_evidence, invariant

contract = {
    'artifact': {'fmuSha256': 'a' * 64},
    'roles': {'proof': {
        'causality': 'output', 'name': 'proof', 'unit': '1', 'valueReference': 1,
    }},
}
valid = {
    'id': 'scenario',
    'invariants': [invariant('scenario.proof', 'proof', {'value': 1})],
    'verdict': 'pass',
}
invalid_scenarios = [
    [],
    [None],
    [{'id': '', 'invariants': valid['invariants'], 'verdict': 'pass'}],
    [{'id': 'scenario', 'invariants': [], 'verdict': 'pass'}],
    [{'id': 'scenario', 'invariants': [None], 'verdict': 'pass'}],
    [{'id': 'scenario', 'invariants': [{
        'id': 'scenario.proof', 'description': 'proof', 'observed': {'value': 0},
        'passed': False,
    }], 'verdict': 'pass'}],
    [{'id': 'scenario', 'invariants': [{
        'id': 'scenario.proof', 'description': 'proof', 'observed': {'value': 1},
        'passed': 1,
    }], 'verdict': 'pass'}],
]
for index, scenarios in enumerate(invalid_scenarios):
    try:
        build_evidence(
            contract=contract, host_name='host', host_version='1', host_platform='test',
            scenarios=scenarios, roles=['proof'],
        )
    except RuntimeError:
        continue
    raise AssertionError(f'invalid scenario case {index} emitted passing evidence')
`], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('a packaged native FMU emits archive-bound evidence through the real lifecycle host',
  { skip: !canRunNative }, (t) => {
    const temporary = mkdtempSync(join(tmpdir(), 'battery-design-native-host-evidence-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const tree = join(temporary, 'tree');
    const built = buildFmu({ cell: cellById('lg-inr18650-mj1'), s: 110, p: 43 });
    for (const [relativePath, content] of Object.entries(built.files)) {
      const path = join(tree, ...relativePath.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    compileNativeBinary({ tree, platform: 'linux64', reproducible: true, maxGlibc: '99.0' });
    const expectedSourceRevision = 'd'.repeat(40);
    const previousSourceRevision = process.env.BATTERY_DESIGN_SOURCE_REVISION;
    process.env.BATTERY_DESIGN_SOURCE_REVISION = expectedSourceRevision;
    t.after(() => {
      if (previousSourceRevision == null) delete process.env.BATTERY_DESIGN_SOURCE_REVISION;
      else process.env.BATTERY_DESIGN_SOURCE_REVISION = previousSourceRevision;
    });
    const archive = join(temporary, 'battery-design-ev.fmu');
    packageFmu({ tree, output: archive, requiredPlatforms: ['linux64'], maxGlibc: '99.0' });
    const jsonPath = join(temporary, 'native.json');
    const csvPath = join(temporary, 'native.csv');
    const smoke = spawnSync('python3', [
      join(ROOT, 'tools', 'fmu-smoke.py'), archive, '--platform', 'linux64',
      '--evidence-json', jsonPath, '--evidence-csv', csvPath,
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
    const summary = JSON.parse(smoke.stdout);
    const evidence = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(summary.evidenceChecksum, evidence.evidenceChecksum);
    assert.equal(evidence.artifact.sourceRevision, expectedSourceRevision);
    assert.deepEqual(evidence.artifact.sourceRevisionVerification,
      { basis: 'trusted-expected-revision', verified: true });
    assert.equal(evidence.artifact.fmuSha256,
      createHash('sha256').update(readFileSync(archive)).digest('hex'));
    assert.deepEqual(evidence.scenarios.map(({ id }) => id), [
      'idle', 'discharge', 'charge-after-discharge-preconditioning', 'thermal-coolant-boundary',
    ]);
    assert.match(readFileSync(csvPath, 'utf8'), new RegExp(evidence.artifact.ioContractChecksum));
    const mismatch = spawnSync('python3', ['-c', `
from pathlib import Path
import sys
sys.path.insert(0, str(Path.cwd() / 'tools'))
from fmu_host_evidence import read_archive_contract
read_archive_contract(Path(sys.argv[1]))
`, archive], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, BATTERY_DESIGN_SOURCE_REVISION: 'e'.repeat(40) },
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match the trusted expected revision/);
  });

test('workflow preserves verified Windows and Linux host-contract evidence without replacing gates', () => {
  const workflow = read('.github/workflows/fmu.yml');
  assert.match(workflow, /fmusim-win64\.csv[\s\S]*?fmpy-smoke\.py \$env:WIN_FMU/);
  assert.match(workflow, /--evidence-json \(Join-Path \$evidenceDirectory 'fmpy-win64\.json'\)/);
  assert.match(workflow, /name: fmu-host-contract-evidence-win64/);
  assert.match(workflow,
    /fmu-smoke\.py dist\/battery-design-ev\.fmu --platform linux64[\s\S]*?native-linux64\.json/);
  assert.match(workflow,
    /fmpy-smoke\.py dist\/battery-design-ev\.fmu[\s\S]*?fmpy-linux64\.json/);
  assert.match(workflow, /name: fmu-host-contract-evidence\n/);
  assert.equal((workflow.match(/FMUSIM_EXE"? validate/g) || []).length, 2,
    'both existing fmusim validation gates remain present');
  assert.equal((workflow.match(/tools\/fmpy-smoke\.py/g) || []).length, 2,
    'both matching-OS FMPy gates remain present');
});
