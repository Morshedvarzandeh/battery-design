import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

test('calibration documentation names the exact contracts and artifact boundaries', () => {
  const guide = read('docs/SYNTHETIC_CALIBRATION.md');
  const desktop = read('desktop/README.md');
  for (const text of [guide, desktop]) {
    assert.match(text, /battery-design\/calibration-dataset@1/);
    assert.match(text, /--params-out/);
    assert.match(text, /--out[^\n]*(?:complete|evidence)|complete[^\n]*--out/is);
  }
  assert.match(guide, /battery-design\/calibration-request@1/);
  assert.match(guide, /maxModuleWeightedIntegrationSteps/);
  assert.match(guide, /source\.rawSha256/);
  assert.match(guide, /mappingChecksum/);
  assert.match(guide, /sourceCurrentScope/);
  assert.match(guide, /sourceSampleAlignment/);
  assert.match(guide, /sourceFirstSampleTimeS/);
  assert.match(guide, /rested-equilibrium-at-ambient/);
  assert.match(guide, /requestChecksum/);
  assert.match(guide, /model\s+implementation checksum/i);
  assert.match(guide, /does not authenticate/i);
  assert.match(guide, /weighted score is not a voltage/i);
  assert.match(guide, /URL[\s\S]*filesystem path[\s\S]*no network fetch/i);
});

test('product messaging keeps implemented surfaces and proprietary evidence separate', () => {
  const guide = read('docs/SYNTHETIC_CALIBRATION.md');
  const readme = read('README.md');
  const desktop = read('desktop/README.md');
  for (const text of [guide, readme, desktop]) {
    assert.match(text, /GT-AutoLion/);
    assert.match(text, /(?:Simcenter )?Amesim/);
    assert.match(text, /Not run/i);
  }
  assert.match(guide, /optimizer regression, not independent model validation/i);
  assert.match(readme, /no calibration tool is shipped/i);
  assert.match(desktop, /not a desktop-GUI button or MCP tool/i);
  assert.match(readme, /do not install a stable[\s\S]*shell command/i);
  assert.match(guide, /not an installed shell-command\s+contract/i);
  assert.doesNotMatch(readme, /calibration[^\n]{0,80}(?:CLI\/API\/MCP|through[^\n]*MCP)/i);
});

test('the next calibration action is not described as completed', () => {
  const guide = read('docs/SYNTHETIC_CALIBRATION.md');
  assert.match(guide, /does not[\s\S]*vendor-specific calibration recipe/i);
  assert.match(guide, /does not[\s\S]*multi-temperature Arrhenius workflow/i);
  assert.match(guide, /require their own[\s\S]*commits/i);
});
