// Sim2 — the parameterised, correctable model.
//
// The claim this module makes is strong: every coefficient is yours to change,
// and given your measurements the model will correct itself to match them. So
// the tests check the physics against closed-form answers where they exist,
// and check the calibrator by generating data from KNOWN parameters and asking
// it to find them again. A fitter that cannot recover parameters it was shown
// is a fitter that is guessing.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { readFileSync } from 'fs';
import {
  PARAM_SPEC, PARAM_BY_ID, defaultParams, validateParams,
  simulate, calibrate, agingEstimate, rmse, R_GAS,
} from '../js/sim2.js';
import { cellById } from '../js/cells.js';
import { ocvCell } from '../js/sim1d.js';

const CELL = cellById('samsung-inr21700-50e');
const flat = (n, amps, dtS = 1) => ({ dtS, i: Array(n).fill(amps) });

test('every parameter is documented well enough to be argued with', () => {
  ok(PARAM_SPEC.length >= 25, `the model exposes its coefficients (${PARAM_SPEC.length})`);
  for (const s of PARAM_SPEC) {
    ok(s.id && s.label && s.unit, `${s.id}: named and given units`);
    ok(s.min < s.max, `${s.id}: has real bounds`);
    ok(s.why?.length > 25, `${s.id}: says what it does`);
    ok(s.source?.length > 5, `${s.id}: says where the default came from`);
    ok(['electrical', 'thermal', 'aging', 'solver'].includes(s.group), `${s.id}: grouped`);
  }
  // The cell-dependent defaults must actually come from the cell.
  const a = defaultParams(cellById('eve-lf280k'));
  const b = defaultParams(CELL);
  ok(a.r0Ref !== b.r0Ref, 'R0 starts from each cell\'s own DCIR, not one number for everything');
  ok(a.hystV > 0 && b.hystV === 0, 'LFP gets hysteresis, sloped chemistries do not');
});

test('a value out of bounds is corrected and reported, never used quietly', () => {
  const { params, notes } = validateParams({ ...defaultParams(CELL), r0EaJ: 1e9, cpCellJkgK: -5 });
  ok(params.r0EaJ === PARAM_BY_ID.r0EaJ.max, 'clamped to the maximum');
  ok(params.cpCellJkgK === PARAM_BY_ID.cpCellJkgK.min, 'and to the minimum');
  ok(notes.length === 2 && notes.every((n) => /above|below/.test(n)), 'both corrections are reported');
  ok(validateParams(defaultParams(CELL)).notes.length === 0, 'sane parameters are left alone');
  const missing = validateParams({ ...defaultParams(CELL), rc1TauS: undefined });
  ok(missing.params.rc1TauS === PARAM_BY_ID.rc1TauS.def && /missing/.test(missing.notes[0]),
    'a missing parameter falls back to its default, out loud');
});

test('the RC branch behaves like an RC branch — checked against the analytic step', () => {
  // v_RC(t) = I·R·(1 − e^(−t/τ)). To see that and nothing else, the pack is
  // made large enough that SoC barely moves over the test, so OCV drift does
  // not contaminate the measurement.
  const p = {
    ...defaultParams(CELL), rc1R: 10, rc2R: 0, r0Ref: 1, rc1TauS: 50,
    r0EaJ: 0, hystV: 0, entropyVK: 0, r0SocRise: 1,
  };
  const s = 100, par = 200, I = 40, tau = 50;
  const r = simulate({ cell: CELL, s, p: par, params: p, profile: flat(200, I), nModules: 1, ambientC: 25, startSoC: 0.5 });
  // The overpotential is OCV minus terminal voltage, so subtracting the OCV
  // the model itself reports removes SoC drift exactly, leaving I·R0 + v_RC.
  const overpotential = (k) => ocvCell(CELL, r.series.soc[k]) * s - r.series.v[k];
  const r0Ohm = (1 / 1000) * s / par;
  const full = I * (10 / 1000) * s / par;
  const frac = (k) => (overpotential(k) - I * r0Ohm) / full;
  ok(Math.abs(frac(tau) - 0.632) < 0.08, `one time constant reaches 63% (got ${(frac(tau) * 100).toFixed(0)}%)`);
  ok(Math.abs(frac(2 * tau) - 0.865) < 0.06, `two reach 86% (got ${(frac(2 * tau) * 100).toFixed(0)}%)`);
  ok(Math.abs(frac(3 * tau) - 0.950) < 0.05, `three reach 95% (got ${(frac(3 * tau) * 100).toFixed(0)}%)`);
});

test('cold cells have more resistance, by the Arrhenius law exactly', () => {
  // Only R0 is left active, the pack is huge so SoC does not move, and it is
  // pinned to ambient — so the IR drop below OCV is purely R0(T).
  const p = {
    ...defaultParams(CELL), r0Ref: 20, r0EaJ: 30000, uaAmbWK: 1e5, hCoolWK: 0,
    rc1R: 0, rc2R: 0, r0SocRise: 1, entropyVK: 0, hystV: 0,
  };
  const ocv = ocvCell(CELL, 0.6);
  const dropAt = (ambientC) => {
    const r = simulate({ cell: CELL, s: 1, p: 4000, params: p, profile: flat(5, 100), nModules: 1, ambientC, startSoC: 0.6 });
    return ocv - r.series.v[0];
  };
  const predicted = Math.exp((30000 / R_GAS) * (1 / 263.15 - 1 / 298.15));
  ok(predicted > 4.5 && predicted < 5.5, `Arrhenius predicts a ${predicted.toFixed(2)}× rise in R0 at −10 °C`);
  const ratio = dropAt(-10) / dropAt(25);
  ok(Math.abs(ratio - predicted) / predicted < 0.02,
    `and the model delivers exactly that (${ratio.toFixed(2)}× vs ${predicted.toFixed(2)}× predicted)`);
  ok(dropAt(45) < dropAt(25), 'a warm pack sags less');
});

test('reversible heat changes sign with the current — the term lumped models omit', () => {
  const p = { ...defaultParams(CELL), entropyVK: -0.0004 };
  const dis = simulate({ cell: CELL, s: 96, p: 4, params: p, profile: flat(300, 60), nModules: 1, ambientC: 25, startSoC: 0.9 });
  const chg = simulate({ cell: CELL, s: 96, p: 4, params: p, profile: flat(300, -60), nModules: 1, ambientC: 25, startSoC: 0.3 });
  ok(dis.summary.reversibleHeatWh > 0, 'discharge is warmed by the entropic term');
  ok(chg.summary.reversibleHeatWh < 0, 'charge is cooled by it');
  // Not exactly equal: the term is I·T·dU/dT, and the discharging pack is
  // warmer than the charging one, so T differs. Within a few percent.
  const asym = Math.abs(Math.abs(dis.summary.reversibleHeatWh) / Math.abs(chg.summary.reversibleHeatWh) - 1);
  ok(asym < 0.05, `magnitudes match to within ${(asym * 100).toFixed(1)}% at equal current — the rest is the T in I·T·dU/dT`);
  const none = simulate({ cell: CELL, s: 96, p: 4, params: { ...p, entropyVK: 0 }, profile: flat(300, 60), nModules: 1, ambientC: 25, startSoC: 0.9 });
  ok(Math.abs(none.summary.reversibleHeatWh) < 1e-9, 'set it to zero and the term disappears');
});

test('the thermal network is a network, not one lumped mass', () => {
  const base = { ...defaultParams(CELL), hCoolWK: 3, kCondWK: 0.5, currentImbalance: 1.3 };
  const hot = simulate({ cell: CELL, s: 96, p: 20, params: base, profile: flat(900, 150), nModules: 6, ambientC: 30, startSoC: 0.9 });
  ok(hot.summary.tempSpreadK > 0.1, `modules reach different temperatures (${hot.summary.tempSpreadK.toFixed(2)} K apart)`);
  // Conduction between modules must reduce the spread — that is what it is for.
  const bonded = simulate({ cell: CELL, s: 96, p: 20, params: { ...base, kCondWK: 60 }, profile: flat(900, 150), nModules: 6, ambientC: 30, startSoC: 0.9 });
  ok(bonded.summary.tempSpreadK < hot.summary.tempSpreadK, 'spreading heat between modules narrows the spread');
  // The coolant is a stream with finite capacity, so both limits must be
  // right. This is the bug these tests caught: modelled as a fixed-temperature
  // sink, a STOPPED PUMP cooled exactly as well as a fast one, and a
  // failed-pump study would have come back healthy.
  const run = (mdotKgS) => simulate({ cell: CELL, s: 96, p: 20, params: { ...base, mdotKgS }, profile: flat(900, 150), nModules: 6, ambientC: 30, startSoC: 0.9 });
  const stopped = run(0), trickle = run(0.005), fast = run(0.5);
  ok(stopped.summary.maxTempC > trickle.summary.maxTempC + 1,
    `no flow means no cooling: ${stopped.summary.maxTempC.toFixed(1)} °C against ${trickle.summary.maxTempC.toFixed(1)} °C with a trickle`);
  ok(stopped.summary.coolantOutC === 25, 'and a stopped stream carries nothing away, so it leaves at inlet temperature');
  ok(trickle.summary.coolantOutC > fast.summary.coolantOutC + 5,
    'a slow stream leaves much hotter than a fast one — same heat, less mass to carry it');
  ok(Math.abs(fast.summary.maxTempC - trickle.summary.maxTempC) < 0.5,
    'past a point more flow stops helping: the plate conductance is the limit, not the pump');
  ok(trickle.summary.coolantOutC > 25, 'coolant always leaves warmer than it arrived');
  ok(hot.findings.some((f) => /spread/i.test(f.title)) === (hot.summary.tempSpreadK > 5),
    'a spread worth warning about is warned about, and one that is not, is not');
});

test('aging grows with time, heat, throughput and hard use — never the reverse', () => {
  const P = defaultParams(CELL);
  const at = (o) => agingEstimate({ params: P, tAvgC: 25, meanSoC: 0.6, efc: 1, years: 5, cyclesPerYear: 200, cRate: 0.5, ...o });
  const ref = at({});
  ok(ref.schedule.length === 5 && ref.schedule[4].capacityFadePct > ref.schedule[0].capacityFadePct,
    'capacity keeps falling year on year');
  ok(at({ tAvgC: 45 }).fadePctPerScenario > ref.fadePctPerScenario, 'hotter ages faster');
  ok(at({ cyclesPerYear: 800 }).fadePctPerScenario > ref.fadePctPerScenario, 'more cycling ages faster');
  ok(at({ cRate: 2 }).fadePctPerScenario > ref.fadePctPerScenario, 'harder cycling ages faster at equal throughput');
  ok(at({ meanSoC: 0.95 }).fadePctPerScenario > at({ meanSoC: 0.4 }).fadePctPerScenario,
    'sitting at full ages faster than sitting half empty');
  ok(ref.schedule[4].resistanceGrowthPct > ref.schedule[4].capacityFadePct,
    'resistance rises faster than capacity falls');
  // The square-root law: four times the time is about twice the fade.
  const y1 = at({ years: 1, cyclesPerYear: 0 }).fadePctPerScenario;
  const y4 = at({ years: 4, cyclesPerYear: 0 }).fadePctPerScenario;
  near(y4 / y1, 2, 0.05, 'calendar fade follows √t');
  ok(/class estimates/.test(ref.note) && /fit them/.test(ref.note), 'and it says the coefficients are estimates');
});

test('calibration recovers parameters it was never told — the whole point', () => {
  // Generate measurements from KNOWN truth, then start the fitter from the
  // (wrong) defaults and see whether it finds its way back.
  const truth = { ...defaultParams(CELL), r0Ref: 32, rc1R: 14, rc1TauS: 45 };
  const i = Array.from({ length: 600 }, (_, k) => (k % 120 < 60 ? 40 : 2));
  const synthetic = simulate({ cell: CELL, s: 96, p: 4, params: truth, profile: { dtS: 1, i }, nModules: 1, ambientC: 25 });
  const measured = { dtS: 1, i, v: synthetic.series.v, t: synthetic.series.tMax };

  const out = calibrate({ cell: CELL, s: 96, p: 4, measured, fit: ['r0Ref', 'rc1R', 'rc1TauS'], nModules: 1, ambientC: 25 });
  ok(out.rmseAfter < out.rmseBefore, `the fit improved (${out.rmseBefore.toFixed(3)} → ${out.rmseAfter.toFixed(5)} V)`);
  ok(out.rmseAfter < 0.01, 'and it reproduces the data essentially exactly');
  for (const key of ['r0Ref', 'rc1R', 'rc1TauS']) {
    const err = Math.abs(out.fitted[key].to - truth[key]) / truth[key];
    ok(err < 0.05, `${key} recovered to within 5% (fitted ${out.fitted[key].to.toFixed(2)} vs true ${truth[key]})`);
  }
  ok(Object.values(out.fitted).every((f) => f.unit && f.changedPct != null), 'each fitted value reports its unit and how far it moved');
  ok(/reproduce your measurements more closely/.test(out.note), 'and says plainly that it worked');
});

test('calibration refuses what it cannot do, instead of pretending', () => {
  const measured = { dtS: 1, i: Array(50).fill(10), v: Array(50).fill(3.6) };
  let threw = false;
  try { calibrate({ cell: CELL, s: 1, p: 1, measured, fit: ['not_a_parameter'] }); } catch (e) { threw = /not parameters/i.test(e.message); }
  ok(threw, 'an unknown parameter name is refused with the reason');
  let threw2 = false;
  try { calibrate({ cell: CELL, s: 1, p: 1, measured: { dtS: 1, i: [] }, fit: ['r0Ref'] }); } catch (e) { threw2 = /current and voltage/.test(e.message); }
  ok(threw2, 'and so is missing data');
  ok(rmse([1, 2, 3], [1, 2, 3]) === 0 && rmse([], []) === Infinity, 'the error metric behaves');
});

test('the model states what it does NOT do', () => {
  const r = simulate({ cell: CELL, s: 96, p: 4, profile: flat(60, 50), nModules: 4, ambientC: 25 });
  const text = r.assumptions.join(' ');
  ok(/NOT electrochemical/.test(text), 'it does not let anyone mistake it for a Newman model');
  ok(/NOT 3-D/.test(text), 'nor for CFD');
  ok(/class-typical estimates/.test(text) && /calibrate/.test(text),
    'and it points at the way to make it yours');
  ok(r.summary.efficiencyPct > 0 && r.summary.efficiencyPct <= 100, 'efficiency is a real percentage');
  ok(r.series.v.length === 60 && r.series.tMax.length === 60, 'a series per step, at the profile\'s own resolution');
});

test('the new coefficients are registered as the estimates they are', () => {
  const refs = readFileSync(new URL('../REFERENCES.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok(/equivalent[- ]circuit/i.test(refs), 'the ECM approach is documented');
  ok(/entropic/i.test(refs), 'the entropic heat term is sourced');
  ok(/Nelder[- ]Mead/i.test(refs), 'the fitting method is named');
  ok(/calendar and cycle aging/i.test(refs), 'the aging law is registered');
});
