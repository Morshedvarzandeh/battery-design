import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('new customer interactions are keyboard-visible and semantic', () => {
  assert.match(html, /:focus-visible/);
  assert.match(html, /<button type="button" id="wzBack"/);
  assert.match(html, /<button type="button" id="wzSkip"/);
  assert.match(app, /b\.className = 'wz-opt'/);
});
