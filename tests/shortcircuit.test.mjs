// Short circuit — the fault study.
//
// Every other test here asks whether the pack does its job. These ask what it
// does when something goes wrong, so they are checked against closed-form
// answers wherever one exists: Ohm's law for the prospective current, the L/R
// time constant for how fast it arrives, and the adiabatic I²t rule for what
// survives it.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { readFileSync } from 'fs';
import {
  FAULT_KINDS, faultKindById, K_ADIABATIC, RUNAWAY_ONSET_C, runawayOnsetC,
  simulateExternalShort, internalShortInGroup, shortCircuitStudy,
} from '../js/shortcircuit.js';
import { cellById } from '../js/cells.js';
import { ocvCell } from '../js/sim1d.js';
import { designFromSpec } from '../js/api.js';

const CELL = cellById('samsung-inr21700-50e');

test('the prospective current is Ohm\'s law, and the model gets there', () => {
  const s = 96, p = 44, busbarMOhm = 0.5, contactorMOhm = 0.2;
  const r = simulateExternalShort({ cell: CELL, s, p, faultMOhm: 0, busbarMOhm, contactorMOhm, fuseI2t: null, maxTimeS: 0.05 });
  const expectedR = (CELL.dcirMOhm / 1000) * s / p + (busbarMOhm + contactorMOhm) / 1000;
  near(r.totalROhm, expectedR, 1e-12, 'the circuit resistance is cells in series/parallel plus the fixed path');
  near(r.prospectiveA, (ocvCell(CELL, 1) * s) / expectedR, 1e-6, 'and I = V/R');
  ok(r.peakA > 0.9 * r.prospectiveA, `the transient reaches most of the prospective current (${(r.peakA / 1000).toFixed(1)} kA of ${(r.prospectiveA / 1000).toFixed(1)} kA)`);
  ok(r.peakA <= r.prospectiveA * 1.001, 'and never exceeds it — there is no source of extra energy');
});

test('inductance is what gives a fuse time to act', () => {
  const base = { cell: CELL, s: 96, p: 44, fuseI2t: null, maxTimeS: 0.02 };
  const slow = simulateExternalShort({ ...base, loopInductanceUH: 10 });
  const fast = simulateExternalShort({ ...base, loopInductanceUH: 0.1 });
  near(slow.timeConstantS / fast.timeConstantS, 100, 1e-6, 'the time constant is L/R, so 100× the inductance is 100× the time');
  ok(slow.peakAtS > fast.peakAtS, 'more inductance means the current takes longer to arrive');
  // The rise must BE the exponential i(t) = I·(1 − e^(−t/τ)), not merely
  // rise. Compared at the sampled instants, so the check is independent of
  // how finely the run happened to be sampled.
  const r = simulateExternalShort({ ...base, loopInductanceUH: 10, maxTimeS: 0.05 });
  let worst = 0;
  for (let k = 1; k < 8; k++) {
    const analytic = 1 - Math.exp(-r.series.t[k] / r.timeConstantS);
    worst = Math.max(worst, Math.abs(r.series.i[k] / r.prospectiveA - analytic));
  }
  ok(worst < 0.035, `the transient follows I·(1 − e^(−t/τ)) to within ${(worst * 100).toFixed(1)} percentage points`);
});

test('a bigger busbar survives more, exactly as I²t ≤ (k·A)² says', () => {
  const run = (busbarAreaMm2) => simulateExternalShort({
    cell: CELL, s: 96, p: 44, busbarAreaMm2, busbarK: K_ADIABATIC['xlpe-insulated'],
    fuseI2t: null, maxTimeS: 0.2,
  });
  const thin = run(10), thick = run(200);
  near(thick.busbarI2tLimit / thin.busbarI2tLimit, 400, 1e-9, 'the limit goes with the SQUARE of the area: 20× wider is 400× the I²t');
  ok(thin.busbarFailedAtS != null, 'a 10 mm² busbar cannot hold a multi-kiloamp fault');
  ok(thick.busbarFailedAtS == null || thick.busbarFailedAtS > thin.busbarFailedAtS,
    'and a 200 mm² one lasts far longer, or survives outright');
  ok(K_ADIABATIC['bare-copper'] > K_ADIABATIC['xlpe-insulated'] && K_ADIABATIC['xlpe-insulated'] > K_ADIABATIC['pvc-insulated'],
    'the k factor rises as the thing touching the busbar tolerates more heat');
});

test('a fuse that clears sooner is the whole point', () => {
  const base = { cell: CELL, s: 96, p: 44, busbarAreaMm2: 50, maxTimeS: 0.3 };
  const quick = simulateExternalShort({ ...base, fuseI2t: 5e4 });
  const slow = simulateExternalShort({ ...base, fuseI2t: 5e6 });
  ok(quick.fuseClearedAtS < slow.fuseClearedAtS, 'a lower melting I²t clears earlier');
  ok(quick.i2t >= 5e4 * 0.99 && quick.i2t <= 5e4 * 1.05, 'and it clears when the accumulated I²t reaches the rating');
  const never = simulateExternalShort({ ...base, fuseI2t: 1e12 });
  ok(never.fuseClearedAtS === null, 'an absurdly large fuse never clears, and the model says so rather than inventing a time');
});

test('the internal short: the danger is the neighbours, not the circuit', () => {
  // This is the mechanism behind propagating pack fires, and the reason the
  // audit has always warned about large parallel groups.
  const big = internalShortInGroup({ cell: CELL, p: 44, shortMOhm: 5 });
  const small = internalShortInGroup({ cell: CELL, p: 4, shortMOhm: 5 });
  ok(big.totalIntoFaultA > small.totalIntoFaultA, 'more parallel cells drive more current into their faulted sibling');
  near(big.neighbours, 43, 1e-9, 'every cell in the group but the faulted one feeds it');
  ok(big.verdict === 'not-workable' && /fusible links are the accepted answer/.test(big.why),
    'a large group with no per-cell fusing is called what it is');
  const single = internalShortInGroup({ cell: CELL, p: 1, shortMOhm: 5 });
  ok(single.neighbours === 0 && single.verdict === 'workable',
    'a single cell per group has no neighbours to feed a fault');
  // Fusible links are the fix, and the model has to show them working.
  const linked = internalShortInGroup({ cell: CELL, p: 44, shortMOhm: 5, linkFuseA: 15 });
  ok(linked.protectedByLinks && linked.verdict === 'workable', 'a correctly rated link isolates the casualty');
  ok(linked.linkOpensAtS < linked.secondsToOnset, 'and it opens before runaway onset, which is the only thing that matters');
  const tooBig = internalShortInGroup({ cell: CELL, p: 44, shortMOhm: 5, linkFuseA: 5000 });
  ok(!tooBig.protectedByLinks, 'a link rated above the fault current is decoration');
});

test('runaway onset follows the chemistry, and is named as an estimate', () => {
  ok(runawayOnsetC('LFP') > runawayOnsetC('NMC'), 'LFP tolerates more heat before it runs away than NMC');
  ok(runawayOnsetC('LTO') > runawayOnsetC('LFP'), 'and LTO more still');
  ok(runawayOnsetC('nonsense') > 0, 'an unknown chemistry falls back rather than crashing');
  ok(Object.keys(RUNAWAY_ONSET_C).length >= 6, 'the table covers the chemistries the tool offers');
});

test('the study runs every fault and produces one actionable sentence', () => {
  const st = shortCircuitStudy({
    cell: CELL, s: 96, p: 44, summary: { maxContCurrentA: 660 },
    busbarAreaMm2: 50, contactorBreakingA: 2000, linkFuseA: 15,
  });
  ok(st.faults.length === FAULT_KINDS.length, 'all four fault kinds are studied');
  ok(/kA/.test(st.headline), `the headline states the current (${st.headline})`);
  ok(['workable', 'workable-with-costs', 'unproven', 'not-workable'].includes(st.verdict), 'in the standard vocabulary');
  ok(st.faults.every((f) => f.why.length > 40), 'every fault explains its own verdict');
  // A contactor asked to break more than its rating is called out, because it
  // welds shut and someone has to know that before it happens.
  const weak = shortCircuitStudy({ cell: CELL, s: 96, p: 44, summary: { maxContCurrentA: 660 }, contactorBreakingA: 100 });
  const pc = weak.faults.find((f) => f.kind.id === 'post-contactor');
  ok(pc.contactor && !pc.contactor.canBreak && /welds shut/.test(pc.contactor.note),
    'an under-rated contactor is told it cannot break the fault');
  ok(faultKindById('terminal').faultMOhm === 0 && faultKindById('test-100').faultMOhm === 100,
    'the certification test case carries its own 100 mΩ, per UN 38.3 T5');
  ok(faultKindById('nonsense').id === 'terminal', 'an unknown fault id falls back safely');
  // The assumptions must confess the fuse guess when there was no datasheet.
  ok(st.assumptions.some((a) => /assumed/.test(a)), 'a guessed fuse I²t is admitted');
  ok(shortCircuitStudy({ cell: CELL, s: 96, p: 44, summary: { maxContCurrentA: 660 }, fuseI2t: 1e5 })
    .assumptions.some((a) => /taken from the value supplied/.test(a)), 'and a supplied one is credited');
  ok(st.assumptions.some((a) => /No arc modelling/.test(a)), 'and the missing arc energy is stated');
});

test('the fault study reaches the audit and the engine', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  ok(d.shortCircuit?.headline, 'every design carries its fault study');
  ok(d.findings.some((f) => f.category === 'safety' && /short/i.test(f.title))
    || d.shortCircuit.verdict === 'workable',
  'and its findings join the audit when there is something to say');
  const risky = designFromSpec({ application: 'ev', energyWh: 60000, busbarAreaMm2: 4 });
  ok(risky.shortCircuit.faults.some((f) => f.verdict === 'not-workable'),
    'a 4 mm² busbar on an EV pack is called not workable');
  ok(risky.findings.some((f) => f.severity === 'fail' && /short circuit/i.test(f.title)),
    'and that failure is raised as a FAIL finding, not buried');
});

test('the short-circuit standards and constants are cited', () => {
  const refs = readFileSync(new URL('../REFERENCES.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok(/UN 38\.3/.test(refs), 'the transport short-circuit test is cited');
  ok(/IEC 60949|adiabatic/i.test(refs), 'the adiabatic conductor rule is sourced');
  ok(/runaway onset/i.test(refs), 'and the runaway onset temperatures are registered as estimates');
});
