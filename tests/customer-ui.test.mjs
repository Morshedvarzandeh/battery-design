import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applySwap } from '../js/garage.js';
import { designFromSpec, resolveMarineSizing } from '../js/api.js';
import { marineDuty } from '../js/marine.js';
import { batteryProfileForPolicy } from '../js/operating-policy.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

test('quick sizing is the default surface and engineering depth is deliberate', () => {
  assert.match(html, /<body class="customer-view">/);
  assert.match(html, /id="btnAudience">Engineering workbench/);
  assert.match(html, /body\.customer-view \.engineering-nav/);
  assert.match(app, /setAudienceMode\('engineering'\)/);
});

test('guided start asks for the job before space and recommendation', () => {
  const family = app.indexOf('function wizardStepApplication');
  const job = app.indexOf('function wizardStepJob');
  const boundary = app.indexOf('function wizardStepBoundaries');
  const result = app.indexOf('function wizardStepRecommendation');
  assert.ok(family > 0 && family < job && job < boundary && boundary < result);
  assert.match(app, /I don't know yet/);
  assert.doesNotMatch(app, /Best overall balance/);
});

test('the customer result makes RTE an energy-and-loss answer', () => {
  assert.match(html, /id="customerResult"/);
  assert.match(html, /id="customerResultReport"/);
  assert.match(app, /Round-trip efficiency/);
  assert.match(app, /Charge for \$\{fWh\(rte\.deliveredWh\)\}/);
  assert.match(app, /Loss per cycle/);
});

test('application changes clear state that belongs to the previous machine', () => {
  assert.match(app, /state\.vehicleRoute = null; state\.busLoad = 'typical'/);
  assert.match(app, /state\.energyPolicyId = null; state\.driveMode = 'normal'/);
  assert.match(app, /state\.cellId = nextCell\.id/);
});

test('the browser promotes marine work to Vessel Twin and forwards the authoritative voyage', () => {
  assert.match(app, /state\.marine = marineInputsForVessel/);
  assert.match(app, /marine: \{ \.\.\.state\.marine \}/);
  assert.match(app, /state\.presetId === 'marine' \? 'Vessel Twin' : 'Garage'/);
  assert.match(app, /design\.application\?\.id === 'marine' \|\| !!knownRunner\(\)/);
  assert.match(app, /View selected vessel in 3D/);
  assert.match(app, /garage\?\.refresh\(\)/,
    'a second voyage adjustment must build on the vessel that was just fitted');
});

test('a browser vessel switch cannot merge the previous asset evidence back in', () => {
  const ferry = {
    application: 'marine', policyId: 'marine-full-electric',
    marine: {
      vesselId: 'ntnu-milliampere1',
      twinEvidence: { assetId: 'FERRY-1', calibrationTrialId: 'ferry-cal' },
      replaySamples: [{ tS: 0 }],
    },
  };
  const gunnerus = applySwap(ferry, { part: 'marine:vesselId', value: 'ntnu-gunnerus' });
  assert.equal(gunnerus.marine.vesselId, 'ntnu-gunnerus');
  assert.equal(gunnerus.marine.twinEvidence, undefined);
  assert.equal(gunnerus.marine.replaySamples, undefined);
  assert.match(app, /const vesselChanged = next\.marine\.vesselId !== state\.marine\?\.vesselId/);
  assert.match(app, /state\.marine = vesselChanged\s*\? \{ \.\.\.next\.marine \}/,
    'the app must replace the nested mission when identity changes, preserving applySwap deletions');
});

test('marine sizing energy follows the active voyage and PMS trace with usable-DoD reserve', () => {
  const requiredWh = (durationH) => {
    const duty = marineDuty({ vesselId: 'ntnu-gunnerus', durationH });
    const profile = batteryProfileForPolicy('marine-load-levelling', { demandProfile: duty.profile });
    const scaleW = duty.scaleW * profile.sourceScaleFactor;
    let cumulativeWh = 0;
    let lowWh = 0;
    let highWh = 0;
    for (const fraction of profile.p) {
      cumulativeWh += fraction * scaleW * profile.dtS / 3600;
      lowWh = Math.min(lowWh, cumulativeWh);
      highWh = Math.max(highWh, cumulativeWh);
    }
    return (highWh - lowWh) / 0.8;
  };

  const oneHour = requiredWh(1);
  const twoHours = requiredWh(2);
  assert.ok(oneHour > 200_000, 'Gunnerus load-levelling cannot remain the 24 kWh ferry preset');
  assert.ok(twoHours > oneHour * 1.9, 'voyage duration must scale the sizing energy');
  assert.match(app, /profileEnergyWindowWh\(prof, state\.profileScaleW\)/);
  assert.match(app, /\$\('rqWh'\)\.value = Math\.ceil\(missionEnergyWh \/ currentDod\(\)\)/,
    'browser requirements include the declared unusable reserve');

  const canonical = resolveMarineSizing({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus', durationH: 1 },
  });
  const headless = designFromSpec({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus', durationH: 1 },
  });
  assert.equal(headless.spec.resolved.sizing.requiredEnergyWh, canonical.requiredEnergyWh);
  assert.deepEqual(headless.spec.resolved.sizing.traceIdentity, canonical.traceIdentity);
  assert.match(app, /return resolveMarineSizing\(\{/,
    'the browser uses the same canonical marine resolver as the headless engine');
  const resolverStart = app.indexOf('function marineProfileForState()');
  const resolverEnd = app.indexOf('function currentProfile()', resolverStart);
  assert.doesNotMatch(app.slice(resolverStart, resolverEnd), /marine-full-electric/,
    'browser marine policy resolution has no hidden ferry fallback');
});

test('marine engineering profile state cannot disagree with the PMS trace being run', () => {
  assert.match(app, /if \(policy\) state\.energyPolicyId = value;\s*else if \(state\.presetId === 'marine'\) state\.energyPolicyId = null/,
    'None and raw profiles clear the previous PMS policy');
  assert.match(app, /if \(state\.presetId === 'marine'\) state\.energyPolicyId = null;\s*state\.profileScaleW = customProfile\.uploadedPeakW/,
    'an uploaded measured profile also clears the PMS transform');
  assert.match(app, /PMS operating goals for \$\{appName\}/,
    'the engineering selector contains the policy ids it can execute');
  assert.match(app, /\$\('selProfile'\)\.value = next\.policyId/,
    'a Vessel Twin PMS fit synchronizes the engineering selector');

  const rebuildStart = app.indexOf('function rebuildProfileSelect(appId)');
  const rebuildEnd = app.indexOf('function selectProfile(value)', rebuildStart);
  const rebuild = app.slice(rebuildStart, rebuildEnd);
  assert.match(rebuild, /if \(appId !== 'marine'\) opt\(null, '', 'None/,
    'marine cannot display None while silently executing the vessel default PMS');
  assert.match(rebuild, /appId && appId !== 'marine' \? profilesForApp\(appId\) : \[\]/,
    'marine policies are not duplicated as recommended profiles');
  assert.match(rebuild, /!operatingPolicyById\(pr\.id\)/,
    'foreign policy outputs are excluded from generic profile shapes');

  const selectStart = app.indexOf('function selectProfile(value)');
  const selectEnd = app.indexOf('function bindProfileControls()', selectStart);
  const select = app.slice(selectStart, selectEnd);
  assert.match(select, /policy\.appId !== state\.presetId/,
    'a policy owned by another application is refused before state changes');
  assert.match(select, /state\.presetId === 'marine' && !value[\s\S]*resolveMarineSizing/,
    'a programmatic empty marine selection is normalized to the visible vessel default');
});

test('new customer interactions are keyboard-visible and semantic', () => {
  assert.match(html, /:focus-visible/);
  assert.match(html, /<button type="button" id="wzBack"/);
  assert.match(html, /<button type="button" id="wzSkip"/);
  assert.match(app, /b\.className = 'wz-opt'/);
});

test('UI, report, AI brief and JSON export share one canonical design snapshot', () => {
  assert.match(html, /id="btnVisualRep"/);
  assert.match(app, /buildVisualReportHTML\(R\)/);
  const reportStart = app.indexOf('function currentReportData()');
  const reportEnd = app.indexOf('function currentReportHTML()', reportStart);
  const report = app.slice(reportStart, reportEnd);
  assert.equal((report.match(/designFromSpec\(/g) || []).length, 0,
    'current report never creates an independent engineering result');
  assert.match(report, /const design = currentDesignSnapshot\(\)/);
  assert.match(report, /semantics: design\.semantics/);
  assert.match(report, /semanticBinding: \{/);
  assert.match(report, /outerDimensionsMm: summary\.dims/);
  assert.match(report, /scene: canonicalLayout\s*\? buildScene\(\{ design, layout: canonicalLayout, showHost: true \}\) : null/,
    'the visual report receives the canonical design and its resolved layout');
  assert.match(report, /sizing: design\.spec\.resolved\.sizing/,
    'report data carries the resolved policy, profile and trace identity');

  const recomputeStart = app.indexOf('function recompute()');
  const recomputeEnd = app.indexOf('// ---------------------------------------------------------------------------\n// Sensors', recomputeStart);
  const recompute = app.slice(recomputeStart, recomputeEnd);
  assert.equal((recompute.match(/designFromSpec\(/g) || []).length, 1,
    'one canonical engine run owns each UI recompute');
  for (const projection of ['lastDesign = design', 'lastSummary = design.pack',
    'lastAnalysis = design.analysis', 'lastArch = design.architecture',
    'lastTherm = design.thermal', 'lastCharging = design.charging',
    'lastVehicle = design.vehicle', 'lastSim = design.simulation']) {
    assert.ok(recompute.includes(projection), `UI projection is hydrated from snapshot: ${projection}`);
  }

  const briefStart = app.indexOf('function aiBriefData(R)');
  const briefEnd = app.indexOf('function currentGridFactor()', briefStart);
  assert.match(app.slice(briefStart, briefEnd), /semantics: R\.semantics/,
    'the AI brief carries the report snapshot instead of creating another graph');

  const exportStart = app.indexOf('function exportJSON()');
  const exportEnd = app.indexOf('function saveHash()', exportStart);
  const exported = app.slice(exportStart, exportEnd);
  assert.equal((exported.match(/designFromSpec\(/g) || []).length, 0,
    'JSON export never creates an independent engineering result');
  assert.match(exported, /const design = currentDesignSnapshot\(\)/);
  assert.match(exported, /semantics: design\.semantics/);
  assert.match(exported, /sizing: design\.spec\.resolved\.sizing/,
    'JSON export carries the same resolved sizing identity');
});

test('browser and advanced desktop requests preserve governed marine profile identity', () => {
  const specStart = app.indexOf('function currentSpec()');
  const specEnd = app.indexOf('// ---------------------------------------------------------------------------\n// The fault study', specStart);
  const spec = app.slice(specStart, specEnd);
  assert.match(spec, /profileId: state\.profileId \|\| undefined/);
  assert.match(spec, /profileTrace: profileTrace \|\| undefined/);
  for (const field of ['arrangement', 'orientation', 'spacingMm', 'wallMm', 'headroomMm', 'layerGapMm', 'nx', 'nz']) {
    assert.match(spec, new RegExp(`${field}: state\\.${field}`), `report semantics carry the visible ${field}`);
  }
  assert.match(spec, /underMm: cool\.bottom/);
  assert.match(spec, /rowExtraMm: cool\.rowGap/);
  assert.match(spec, /bay: state\.appliedBay \|\| undefined/);

  const traceStart = app.indexOf('function profileTraceForState()');
  const traceEnd = app.indexOf('function marineProfileForState()', traceStart);
  const trace = app.slice(traceStart, traceEnd);
  assert.match(trace, /dtS: customProfile\.dtS/);
  assert.match(trace, /p: \[\.\.\.customProfile\.p\]/);
  assert.match(trace, /scaleW: customProfile\.uploadedPeakW/);

  const runnerStart = app.indexOf("$('btnAdvModel').onclick");
  const runnerEnd = app.indexOf("$('btnFmuExport').onclick", runnerStart);
  const runner = app.slice(runnerStart, runnerEnd);
  assert.match(runner, /profile: governedProfile/);
  assert.match(runner, /profile\.p\.map\(\(fraction\) => fraction \* state\.profileScaleW\)/,
    'advanced desktop execution receives the exact resolved browser power trace');
});

test('browser EU passport controls feed the same API specification and evaluator inputs', () => {
  assert.match(html, /id="euCategory"/);
  assert.match(html, /id="euDate"/);
  assert.doesNotMatch(html, /id="euDate"[^>]*value=/,
    'the HTML does not duplicate the ontology-governed effective date');
  assert.match(app, /EU_BATTERY_PASSPORT_EFFECTIVE_DATE/,
    'the browser initializes the assessment date from the governed rule');
  assert.match(app, /batteryCategory: state\.batteryCategory,/);
  assert.match(app, /evaluationDate: state\.evaluationDate,/);
  const specStart = app.indexOf('function currentSpec()');
  const specEnd = app.indexOf('// ---------------------------------------------------------------------------\n// The fault study', specStart);
  const spec = app.slice(specStart, specEnd);
  assert.match(spec, /batteryCategory: state\.batteryCategory \|\| undefined/);
  assert.match(spec, /evaluationDate: state\.evaluationDate/);
  assert.match(app, /\$\('euCategory'\)\.onchange/);
  assert.match(app, /\$\('euDate'\)\.onchange/);
});
