import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  FMI_IO_CONTRACT,
  FMI_IO_CONTRACT_CHECKSUM,
  FMI_IO_CONTRACT_VERSION,
} from '../js/fmi-signal-map.js';
import {
  FMI_HOST_MAPPING_FORMAT,
  generatedFmiCommercialAcceptanceMarkdown,
  generatedFmiSignalMapMarkdown,
  validatePublishedFmiSignalDocs,
} from '../tools/generate-fmi-signal-docs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

test('published FMI signal documents are exact deterministic projections of the canonical contract', () => {
  assert.equal(read('docs/FMI_SIGNAL_MAP.md'), generatedFmiSignalMapMarkdown());
  assert.equal(read('docs/FMI_COMMERCIAL_ACCEPTANCE.md'), generatedFmiCommercialAcceptanceMarkdown());
  assert.deepEqual(validatePublishedFmiSignalDocs(), []);

  assert.deepEqual(validatePublishedFmiSignalDocs({
    signalMapText: generatedFmiSignalMapMarkdown().replace('`I_pack`', '`pack_current`'),
    acceptanceText: generatedFmiCommercialAcceptanceMarkdown(),
  }), [
    'docs/FMI_SIGNAL_MAP.md drifted from js/fmi-signal-map.js; run node tools/generate-fmi-signal-docs.mjs --write',
  ]);
});

test('generated enterprise table publishes every exact VR, unit, start policy and sign convention', () => {
  const signalMap = generatedFmiSignalMapMarkdown();
  assert.match(signalMap, new RegExp(FMI_IO_CONTRACT_CHECKSUM));
  assert.ok(signalMap.includes(`Scalar contract version: \`${FMI_IO_CONTRACT_VERSION}\``));

  for (const variable of FMI_IO_CONTRACT) {
    const line = signalMap.split('\n').find((candidate) => (
      candidate.startsWith('|')
      && candidate.includes(`| ${variable.valueReference} |`)
      && candidate.includes(`\`${variable.role}\``)
      && candidate.includes(`\`${variable.name}\``)
    ));
    assert.ok(line, `published row exists for ${variable.name}`);
    assert.ok(line.includes(`\`${variable.unit}\``), `${variable.name} publishes exact unit`);
    if (variable.displayUnit != null) {
      assert.ok(line.includes(`\`${variable.displayUnit}\``), `${variable.name} publishes exact display unit`);
    }
    assert.ok(line.includes(variable.signConvention), `${variable.name} publishes exact sign convention`);
    if (variable.startPolicy === 'resolved') assert.ok(line.includes('design-bound'));
    if (variable.startPolicy === 'calculated') assert.ok(line.includes('calculated'));
    if (variable.startPolicy === 'declared') assert.ok(line.includes(`\`${variable.start}\``));
  }
});

test('host map is versioned, separates static design provenance and preserves evidence truth', () => {
  const signalMap = generatedFmiSignalMapMarkdown();
  const acceptance = generatedFmiCommercialAcceptanceMarkdown();
  const runtime = FMI_IO_CONTRACT.filter(({ causality }) => causality !== 'parameter');

  assert.match(signalMap, new RegExp(FMI_HOST_MAPPING_FORMAT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(signalMap, /Static design\/layout data is not a runtime port/);
  assert.match(signalMap, /is not updated while the\s+component steps/);
  assert.match(signalMap, /reduced plant: linear cell OCV[\s\S]*R0 plus one RC polarization branch/);
  assert.match(signalMap, /h_cool_WK[\s\S]*total pack-to-coolant conductance/);
  for (const variable of runtime) {
    assert.match(signalMap, new RegExp(`runtime\\.${variable.role.replaceAll('.', '\\.')}`));
  }

  for (const host of ['ANSYS Twin Builder', 'MATLAB/Simulink', 'GT-SUITE']) {
    assert.match(acceptance, new RegExp(`\\| ${host.replace('/', '\\/')} \\|[^\n]*\\| Not run \\|`));
  }
  assert.equal((acceptance.match(/Not run/g) || []).length, 4);
  assert.doesNotMatch(acceptance, /\| Accepted \|/);
  assert.match(acceptance, /static design\/layout[\s\S]*not live FMI telemetry/);
});

test('documentation validator has a strict, scriptable check mode', () => {
  const check = spawnSync(process.execPath, ['tools/generate-fmi-signal-docs.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  assert.equal(check.stdout, 'FMI signal-map documentation is current.\n');

  const invalid = spawnSync(process.execPath, ['tools/generate-fmi-signal-docs.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Usage:/);
});
