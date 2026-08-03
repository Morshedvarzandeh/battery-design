// Conductor sizing: the rule of thumb, the heat balance, and where they part.
//
// The value of this module is entirely in the cases where the two methods
// disagree, so most of these tests are exactly those cases. The rest guard
// the arithmetic that got it wrong the first time: a model that ignored
// conduction out of the ends returned 3429 °C for an ordinary busbar, and a
// study that summed the drop across every run counted the same volts once per
// module.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  INSTALLATIONS, RULE_OF_THUMB_ADENSITY, temperatureRise, requiredAreaMm2,
  assessRun, wiringStudy,
} from '../js/wiring.js';
import { buildTopology } from '../js/topology.js';
import { resistivityAt } from '../js/materials.js';
import { designFromSpec } from '../js/api.js';
import { cellById } from '../js/cells.js';

const run = (over = {}) => ({
  id: 'r1', materialId: 'copper', lengthMm: 200, areaMm2: 35, carriesA: 150, ...over,
});

test('the heat balance is I²R against both cooling paths, not just convection', () => {
  const t = temperatureRise({ materialId: 'copper', lengthMm: 200, areaMm2: 35, currentA: 150 });
  // R = ρL/A at the settled temperature, and the heat is I²R by definition.
  near(t.resistanceOhm, (resistivityAt('copper', t.tempC) * 0.2) / 35e-6, 1e-9, 'R = ρ(T)·L/A');
  near(t.heatW, 150 * 150 * t.resistanceOhm, 1e-9, 'heat is I²R');
  near(t.dropV, 150 * t.resistanceOhm, 1e-9, 'drop is IR');
  // The balance itself: everything made is everything shed.
  near(t.heatW, t.conductanceWK.total * t.riseK, 1e-6, 'I²R = ΣhA·ΔT — nothing is lost or invented');
  // Both paths are present, and for a short run the ends dominate. This is
  // the term whose absence returned temperatures in the thousands.
  ok(t.conductanceWK.endConduction > 0, 'conduction out through the ends is counted');
  ok(t.conductanceWK.endConduction > t.conductanceWK.convective,
    'and on a 200 mm run it is the larger of the two — the reason a short busbar stays cool');
  ok(t.tempC > 25 && t.tempC < 60, `an ordinary 35 mm² run at 150 A lands in a believable place (${t.tempC.toFixed(0)} °C)`);
});

test('a longer run of the same section runs hotter, and a bigger one cooler', () => {
  const base = { materialId: 'copper', areaMm2: 35, currentA: 150 };
  const short = temperatureRise({ ...base, lengthMm: 100 });
  const long = temperatureRise({ ...base, lengthMm: 1000 });
  ok(long.tempC > short.tempC, 'length is what the rule of thumb ignores and the physics does not');
  const fat = temperatureRise({ ...base, lengthMm: 1000, areaMm2: 70 });
  ok(fat.tempC < long.tempC, 'doubling the section cools it');
});

test('installation changes the answer, in the order the physics demands', () => {
  const at = (installation) => temperatureRise({ materialId: 'copper', lengthMm: 1200, areaMm2: 50, currentA: 200, installation }).tempC;
  ok(at('plate-bonded') < at('free-air'), 'a cold plate beats still air');
  ok(at('free-air') < at('bundled'), 'free air beats a loom');
  ok(at('bundled') < at('potted'), 'a loom beats being potted');
  // Every declared installation is usable and ordered by its coefficient.
  for (const [id, inst] of Object.entries(INSTALLATIONS)) {
    ok(inst.hWm2K > 0 && inst.name && inst.what, `${id} is a complete installation`);
    ok(temperatureRise({ materialId: 'copper', lengthMm: 300, areaMm2: 50, currentA: 200, installation: id }) != null,
      `${id} produces an answer`);
  }
});

test('a conductor with no steady state is reported as such, not as a number', () => {
  // 0.3 mm² nickel at 60 A is 200 A/mm². Resistance climbs faster than the
  // strip can shed the heat, so there is no temperature at which it settles.
  const a = assessRun({ id: 'n1', materialId: 'nickel', lengthMm: 30, areaMm2: 0.3, carriesA: 60 });
  ok(a.verdict === 'not-workable', 'the verdict is refusal');
  ok(a.thermal.stable === false, 'and it is flagged as divergent rather than converged');
  ok(a.thermal.loopGain >= 1, 'because the resistance-heat loop gain reaches unity');
  ok(a.thermal.tempC === Infinity, 'so no temperature is quoted — there is not one');
  ok(/no steady state/i.test(a.why), 'the reason says what actually happens');
  ok(/wrong size entirely/i.test(a.why), 'and that this is not a margin problem');

  // The criterion is exact, so a run just the other side of it settles.
  const fine = assessRun({ id: 'n2', materialId: 'nickel', lengthMm: 30, areaMm2: 3, carriesA: 60 });
  ok(fine.thermal.stable && fine.thermal.loopGain < 1, 'ten times the section is comfortably stable');
  ok(isFinite(fine.thermal.tempC), 'and has a temperature');
});

test('a runaway run is left out of the totals rather than poisoning them', () => {
  const topo = {
    edges: [
      { id: 'ok1', materialId: 'copper', lengthMm: 200, areaMm2: 35, carriesA: 150, inSeriesPath: true },
      { id: 'bad', materialId: 'nickel', lengthMm: 30, areaMm2: 0.3, carriesA: 60, inSeriesPath: true },
    ],
    totals: {},
  };
  const study = wiringStudy({ topology: topo, packV: 400, maxTempC: 60 });
  ok(study.totals.runaway === 1, 'the runaway run is counted');
  ok(isFinite(study.totals.totalHeatW) && study.totals.totalHeatW > 0, 'and the heat total stays a real number');
  ok(isFinite(study.totals.seriesDropV), 'as does the drop');
  ok(isFinite(study.totals.hottestC), 'the hottest figure is the hottest run that HAS a temperature');
  ok(/no steady state/i.test(study.headline), 'and the headline leads with the runs that have none');
  ok(study.verdict === 'not-workable', 'the verdict is not softened by the totals looking fine');
});

test('the rule of thumb and the physics disagree in BOTH directions', () => {
  // Short and over the rule: 20 mm of nickel strip at 6 A/mm² is fine,
  // because it conducts its heat straight out into the cell cans.
  const short = assessRun({ id: 's', materialId: 'nickel', lengthMm: 20, areaMm2: 1, carriesA: 6 });
  ok(short.overRule, '6 A/mm² is above the 2.5 A/mm² nickel rule of thumb');
  ok(short.verdict === 'workable', 'but it passes on the heat balance');
  ok(/rule of thumb/i.test(short.why), 'and the answer says why the tool disagrees with the rule');

  // Long and under the rule: 1.25 m of copper at 4 A/mm² is inside the
  // 5 A/mm² rule and still reaches the high eighties.
  const long = assessRun({ id: 'l', materialId: 'copper', lengthMm: 1250, areaMm2: 107.5, carriesA: 430 }, { maxTempC: 60 });
  ok(!long.overRule, '4 A/mm² is inside the copper rule of thumb');
  ok(long.thermal.tempC > 80, `and it still reaches ${long.thermal.tempC.toFixed(0)} °C`);
  ok(long.verdict !== 'workable', 'so the temperature answer wins');
});

test('inside the limit but only just is not called comfortable', () => {
  const a = assessRun(run({ lengthMm: 1250, areaMm2: 107.5, carriesA: 430 }), { maxTempC: 90 });
  ok(a.verdict === 'workable', '86 °C against a 90 °C limit passes');
  ok(/only just|margin/i.test(a.why), 'but the wording says the margin is nearly gone, not that it is comfortable');
  const easy = assessRun(run(), { maxTempC: 90 });
  ok(/comfortable/i.test(easy.why), 'a genuinely easy run is allowed to say so');
});

test('the required section is solved against the model, not fitted to it', () => {
  const r = run({ lengthMm: 1250, areaMm2: 107.5, carriesA: 430 });
  const need = requiredAreaMm2(r, { maxTempC: 60 });
  ok(need > r.areaMm2, 'an over-temperature run needs more metal');
  // The answer must actually hold the limit when you build it.
  const at = temperatureRise({ materialId: r.materialId, lengthMm: r.lengthMm, areaMm2: need, currentA: r.carriesA });
  ok(at.tempC <= 60 + 0.5, `${need.toFixed(0)} mm² really does hold 60 °C (${at.tempC.toFixed(1)} °C)`);
  // And it must be the smallest such section, not a comfortable overshoot.
  const under = temperatureRise({ materialId: r.materialId, lengthMm: r.lengthMm, areaMm2: need * 0.9, currentA: r.carriesA });
  ok(under.tempC > 60, 'ten percent less metal does not hold it');
  ok(requiredAreaMm2(run(), { maxTempC: 90 }) === null, 'a run that already passes needs nothing');
});

test('voltage drop is summed along the series path, not across every run', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const topo = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cellById(d.cell.id).form });
  const study = wiringStudy({ topology: topo, packV: d.pack.nominalV, maxTempC: 60 });

  // The module terminal runs carry current and make heat, but they are taps:
  // adding all ten to the pack's drop would count the same volts ten times.
  const everyRun = study.runs.reduce((s, r) => s + r.thermal.dropV, 0);
  ok(study.totals.seriesDropV < everyRun, 'the pack drop is less than the sum of all runs');
  ok(study.runs.some((r) => !r.inSeriesPath), 'because some runs are off the series path');
  // The one cross-check that matters: topology computes the same path cold,
  // the study computes it at temperature, so the study must be a little more.
  ok(study.totals.seriesDropV > topo.totals.dropAtContV,
    'and it exceeds the cold-resistance figure, because hot copper resists more');
  ok(study.totals.seriesDropV < topo.totals.dropAtContV * 1.5,
    'but only by the temperature coefficient, not by a different model');

  // Heat is the opposite case: every run genuinely makes its own.
  near(study.totals.totalHeatW, study.runs.reduce((s, r) => s + r.thermal.heatW, 0), 1e-6,
    'heat sums every run, because every run really does dissipate it');
});

test('identical runs become one finding, not one per run', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const topo = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cellById(d.cell.id).form });
  const study = wiringStudy({ topology: topo, packV: d.pack.nominalV, installation: 'bundled', maxTempC: 60 });
  ok(study.totals.failing > 4, `this design has ${study.totals.failing} undersized runs`);
  const fails = study.findings.filter((f) => f.severity === 'fail');
  ok(fails.length < study.totals.failing, 'but far fewer findings than failures');
  ok(fails.some((f) => /^\d+ conductors/.test(f.title)), 'and a grouped finding says how many share the problem');
});

test('a verdict reached from a guessed length says so', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const cellForm = cellById(d.cell.id).form;
  const guessed = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm });
  const study = wiringStudy({ topology: guessed, packV: d.pack.nominalV, maxTempC: 60 });
  ok(study.runs.every((r) => r.estimated), 'nothing was measured');
  ok(study.findings.some((f) => f.severity === 'info' && /estimated/i.test(f.title)),
    'so the study says the lengths are estimates before anyone acts on a failure');
  ok(study.findings.filter((f) => f.severity === 'fail').every((f) => /estimated/i.test(f.detail)),
    'and every failure repeats it where the customer will read it');

  // Real routing is shorter than half a pack diagonal, and it changes the
  // answer — which is the whole reason the estimate is flagged.
  const measured = buildTopology({
    summary: d.pack, partition: d.architecture.partition, cellForm,
    lengths: { groupPitchMm: 25, moduleRunMm: 300, packRunMm: 400 },
  });
  const real = wiringStudy({ topology: measured, packV: d.pack.nominalV, maxTempC: 60 });
  ok(real.runs.every((r) => !r.estimated), 'measured lengths are not flagged');
  ok(real.totals.failing === 0, 'and with real routing this pack passes');
  ok(real.totals.hottestC < study.totals.hottestC, 'shorter runs are cooler');
});

test('the study answers for a whole pack without inventing anything', () => {
  const d = designFromSpec({ application: 'ebike' });
  const topo = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cellById(d.cell.id).form });
  const study = wiringStudy({ topology: topo, packV: d.pack.nominalV, maxTempC: 60 });
  ok(study.totals.runsChecked === topo.edges.length, 'every run in the graph is assessed');
  ok(['workable', 'workable-with-costs', 'not-workable'].includes(study.verdict), 'the verdict is house vocabulary');
  ok(study.headline.includes('°C'), 'the headline leads with the temperature');
  ok(study.assumptions.length >= 4, 'and the assumptions are stated rather than buried');
  ok(study.assumptions.some((a) => /square/i.test(a)), 'including the conservative section shape');
  ok(study.assumptions.some((a) => /radiation/i.test(a)), 'and what is deliberately left out');
  ok(study.totals.hottestC > 0 && study.totals.totalHeatW >= 0, 'the totals are real numbers');
  ok(wiringStudy({ topology: null }) === null, 'and no topology gives no answer');
});

test('every rule-of-thumb density belongs to a real conductor', () => {
  for (const id of Object.keys(RULE_OF_THUMB_ADENSITY)) {
    ok(RULE_OF_THUMB_ADENSITY[id] > 0, `${id} has a positive density limit`);
    ok(temperatureRise({ materialId: id, lengthMm: 100, areaMm2: 10, currentA: 20 }) != null,
      `${id} is a material the heat balance can solve`);
  }
  // Nonsense in, nothing out — never a made-up number.
  ok(temperatureRise({ materialId: 'copper', lengthMm: 0, areaMm2: 10, currentA: 20 }) === null, 'zero length is refused');
  ok(temperatureRise({ materialId: 'copper', lengthMm: 100, areaMm2: 0, currentA: 20 }) === null, 'zero area is refused');
  ok(assessRun(run({ carriesA: 0 })) === null, 'a run carrying nothing is not assessed');
});
