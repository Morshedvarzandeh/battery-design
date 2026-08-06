import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { briefFromDesign, designFromSpec } from '../js/api.js';

test('invalid DoD can never inflate or reverse vehicle range', () => {
  const base = designFromSpec({ application: 'ev', energyWh: 60_000, dod: 0.8 });
  for (const dod of [99, -1, 0, NaN, Infinity]) {
    const design = designFromSpec({ application: 'ev', energyWh: 60_000, dod });
    ok(design.spec.dod > 0 && design.spec.dod <= 1,
      `resolved DoD remains physical for ${String(dod)} (${design.spec.dod})`);
    near(design.vehicle.range, base.vehicle.range, 1e-9,
      `invalid DoD ${String(dod)} uses the safe default rather than changing range`);
    ok(design.warnings.some((warning) => /depth of discharge/i.test(warning)),
      `the repair for ${String(dod)} is visible to the caller`);
  }
});

test('human brief reports modeled peak temperature, not the cell rating', () => {
  const design = designFromSpec({ application: 'ev', energyWh: 60_000, dod: 0.8 });
  const summary = design.simulation?.summary;
  ok(summary && summary.maxT != null && summary.tempMaxC != null,
    'the selected mission has a modeled peak and a separate rating');
  ok(Math.abs(summary.maxT - summary.tempMaxC) > 1,
    'fixture separates modeled temperature from the rating');
  const brief = briefFromDesign(design);
  ok(brief.includes(`peak cell ${summary.maxT.toFixed(1)} °C`),
    'brief contains the modeled maximum');
  ok(!brief.includes(`peak cell ${summary.tempMaxC.toFixed(1)} °C`),
    'brief does not relabel the rating as a result');
});
