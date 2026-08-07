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
  const tuning = read('docs/ECM_TUNING.md');
  const readme = read('README.md');
  const desktop = read('desktop/README.md');
  for (const text of [guide, tuning, readme, desktop]) {
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

test('Action 1 ingestion and Action 2 automatic tuning remain separate contracts', () => {
  const ingestion = read('docs/SYNTHETIC_CALIBRATION.md');
  const tuning = read('docs/ECM_TUNING.md');
  assert.match(ingestion, /Action 1[\s\S]*governed trace ingestion[\s\S]*manual/i);
  assert.match(ingestion, /Action 2[\s\S]*separately shipped[\s\S]*fixed\s+full-rate holdout/i);
  assert.match(ingestion, /Action 2 does not ingest raw[\s\S]*vendor files/i);
  assert.match(tuning, /Action 1 and Action 2 are different/i);
  assert.match(tuning, /Action 1: ingestion and manual fitting[\s\S]*Action 2: staged ECM tuning/i);
  assert.match(tuning, /No raw importer and no vendor-specific tuning recipe/i);
  assert.match(tuning, /battery-design\/calibration-dataset@1/);
});

test('staged tuning documentation pins only the shipped CLI and local API surfaces', () => {
  const tuning = read('docs/ECM_TUNING.md');
  assert.match(tuning, /source\/staged Node runner CLI and the authenticated[\s\S]*local API/i);
  assert.match(tuning, /not a desktop-GUI button or MCP tool/i);
  assert.match(tuning, /do not install a stable customer-facing shell wrapper/i);
  assert.match(tuning, /node desktop\/bd\.mjs tune-ecm/);
  assert.match(tuning, /POST \/api\/tune-ecm/);
  assert.match(tuning, /battery-design\/ecm-tuning-request@1/);
  assert.match(tuning, /battery-design\/ecm-tuning-run@1/);
  assert.match(tuning, /battery-design\/ecm-tuning-plan@1/);
  assert.match(tuning, /battery-design\/ecm-tuning-result@1/);
  assert.doesNotMatch(tuning, /(?:GUI|MCP)[^\n]{0,40}(?:runs?|executes?|supports?) (?:automatic )?(?:ECM )?tuning/i);
});

test('staged tuning documentation preserves group gates and identifiability limits', () => {
  const tuning = read('docs/ECM_TUNING.md');
  for (const group of [
    'ohmic', 'fast-rc', 'slow-rc', 'soc-dependence', 'arrhenius', 'hysteresis', 'joint-refinement',
  ]) assert.match(tuning, new RegExp(`\\b${group}\\b`));
  assert.match(tuning, /groups: "auto"[\s\S]*recorded as `skipped` with exact reasons/i);
  assert.match(tuning, /explicit group list[\s\S]*blocks planning/i);
  assert.match(tuning, /normalized finite-difference prediction Jacobian/i);
  assert.match(tuning, /weak[\s\S]*rank[\s\S]*correlation/i);
  assert.match(tuning, /local sensitivity\/confounding screen, not a claim of globally unique/i);
  assert.match(tuning, /rc2TauS >= 3 \* rc1TauS[\s\S]*every sensitivity probe and optimizer candidate/i);
});

test('staged tuning documentation makes holdout and adoption fail closed', () => {
  const tuning = read('docs/ECM_TUNING.md');
  assert.match(tuning, /Only calibration-purpose trials enter[\s\S]*optimizer/i);
  assert.match(tuning, /Validation observations never select or fit a candidate/i);
  assert.match(tuning, /fixed validation trials at their original, full sample rate/i);
  assert.match(tuning, /pooled validation evidence[\s\S]*every validation trial[\s\S]*every included validation segment/i);
  assert.match(tuning, /candidateParams[\s\S]*diagnostic parameter map/i);
  assert.match(tuning, /`adoptedParams` equals that candidate only when every[\s\S]*Otherwise `adoptedParams` equals[\s\S]*initial/i);
  assert.match(tuning, /short\s+bad segment[\s\S]*cannot be hidden/i);
});

test('staged tuning documentation states exact work, privacy and checksum limits', () => {
  const tuning = read('docs/ECM_TUNING.md');
  assert.match(tuning, /preflights fixed initial\/final calibration and validation scoring/i);
  assert.match(tuning, /temporal integration steps and module-weighted thermal[\s\S]*safe-integer/i);
  assert.match(tuning, /Counters are cumulative\s+across stages/i);
  assert.match(tuning, /Both partitions may use[\s\S]*planning identities and coverage[\s\S]*maxSamplesPerDataset/i);
  assert.match(tuning, /prepared calibration grid also drives the optimizer/i);
  assert.match(tuning, /Validation scoring is[\s\S]*never downsampled[\s\S]*original full rate/i);
  assert.match(tuning, /Prepared planning\/optimizer-grid samples per dataset \(both partitions as applicable\)/i);
  assert.match(tuning, /Raw\s+current, voltage and temperature arrays and raw Jacobian vectors are not copied/i);
  assert.match(tuning, /checksum stored beside mutable content is not a signature/i);
  assert.match(tuning, /does not authenticate[\s\S]*statistically independent[\s\S]*model accuracy/i);
  assert.match(tuning, /exact duplicate\/leakage guards only/i);
  assert.match(tuning, /250,000[\s\S]*20,000[\s\S]*500[\s\S]*2,000,000/i);
});

test('staged tuning evidence table leaves proprietary work explicitly not run', () => {
  const tuning = read('docs/ECM_TUNING.md');
  for (const claim of [
    /GT-AutoLion export import or tuning \| \*\*Not run\*\*/,
    /Simcenter Amesim export import or tuning \| \*\*Not run\*\*/,
    /Accuracy against a proprietary high-fidelity model \| \*\*Not run\*\*/,
    /Compatibility with a proprietary application or file format \| \*\*Not run\*\*/,
  ]) assert.match(tuning, claim);
  assert.match(tuning, /automated fixtures are generated from battery-design's own equations/i);
  assert.match(tuning, /not[\s\S]*independent physics accuracy/i);
});
