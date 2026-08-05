import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELLS } from '../js/cells.js';
import { PRESETS } from '../js/presets.js';
import { suggestDesigns } from '../js/optimizer.js';
import { assessSizingCandidate, customerReadiness } from '../js/customer-experience.js';

const cell = CELLS.find((c) => c.id === 'catl-302ah-lfp');
const candidate = {
  cell, s: 192, p: 4,
  summary: { nominalV: 618.24, energyWh: 746_956.8, massKg: 4_300 },
  best: { fits: true },
};

test('hard requirements are gates, not weighted preferences', () => {
  const good = assessSizingCandidate(candidate, {
    application: 'ebus', market: 'eu', vRange: [500, 750], energyWh: 250_000,
    contPowerW: 60_000, peakPowerW: 250_000, maxMassKg: 5_000,
    preferredChemistries: ['LFP', 'LTO'],
  });
  assert.equal(good.eligible, true);

  const lowEnergy = assessSizingCandidate({
    ...candidate, summary: { ...candidate.summary, energyWh: 100_000 },
  }, { application: 'ebus', market: 'eu', vRange: [500, 750], energyWh: 250_000 });
  assert.equal(lowEnergy.eligible, false);
  assert.match(lowEnergy.blockers.join(' '), /below the 250,000 Wh target/i);
});

test('market blockers make a candidate non-eligible before ranking', () => {
  const nmc = CELLS.find((c) => c.chemistry === 'NMC');
  const result = assessSizingCandidate({
    cell: nmc, s: 170, p: 100,
    summary: { nominalV: 170 * nmc.nominalV, energyWh: 300_000, massKg: 2_000 },
    best: { fits: true },
  }, {
    application: 'ebus', market: 'cn', vRange: [500, 750], energyWh: 250_000,
    contPowerW: 60_000, peakPowerW: 250_000, maxMassKg: 2_500,
  });
  assert.equal(result.eligible, false);
  assert.match(result.blockers.join(' '), /excluded|catalogue/i);
});

test('optimizer puts every eligible sizing match ahead of ineligible scores', () => {
  const preset = PRESETS.find((p) => p.id === 'ebus');
  const results = suggestDesigns({
    application: preset.id, market: 'cn', vRange: preset.systemV,
    energyWh: preset.typicalEnergyWh, contPowerW: preset.contPowerW,
    peakPowerW: preset.peakPowerW, maxMassKg: preset.maxMassKg,
    preferredChemistries: preset.preferredChemistries,
    cyclesPerYear: preset.cyclesPerYear, targetYears: preset.targetYears,
  }, CELLS, 30);
  const firstIneligible = results.findIndex((r) => !r.eligibility.eligible);
  assert.ok(results.some((r) => r.eligibility.eligible));
  if (firstIneligible >= 0) {
    assert.ok(results.slice(firstIneligible).every((r) => !r.eligibility.eligible));
  }
});

test('small products use packaging reserves at their own physical scale', () => {
  const preset = PRESETS.find((p) => p.id === 'wearable');
  const results = suggestDesigns({
    application: preset.id, market: 'eu', vRange: preset.systemV,
    energyWh: preset.typicalEnergyWh, contPowerW: preset.contPowerW,
    peakPowerW: preset.peakPowerW, maxMassKg: preset.maxMassKg,
    preferredChemistries: preset.preferredChemistries,
  }, CELLS, 20);
  assert.ok(results.some((r) => r.eligibility.eligible), 'a typical wearable has an eligible starting point');
  assert.ok(results.find((r) => r.eligibility.eligible).summary.massKg < preset.maxMassKg);
});

test('customer readiness uses one stable three-state vocabulary', () => {
  assert.equal(customerReadiness([]).label, 'Suitable');
  assert.equal(customerReadiness([{ severity: 'warn', title: 'Confirm price' }]).label, 'Suitable with conditions');
  assert.equal(customerReadiness([{ severity: 'fail', title: 'Too hot' }]).label, 'Not yet suitable');
  assert.equal(customerReadiness([], ['Does not fit']).label, 'Not yet suitable');
});
