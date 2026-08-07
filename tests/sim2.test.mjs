// Sim2 — the parameterised, correctable model.
//
// The claim this module makes is strong: every coefficient is yours to change,
// and given your measurements the model will correct itself to match them. So
// the tests check the physics against closed-form answers where they exist,
// and check the calibrator by generating data from KNOWN parameters and asking
// it to find them again. A fitter that cannot recover parameters it was shown
// is a fitter that is guessing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, near } from './helpers.mjs';
import { readFileSync } from 'fs';
import {
  PARAM_SPEC, PARAM_BY_ID, defaultParams, validateParams,
  simulate, estimateSim2Work, calibrate, calibrateDatasets, agingEstimate, rmse, R_GAS,
  CALIBRATION_FIT_ELIGIBLE, MAX_CALIBRATION_DATASETS, SIM2_SUPPORTED_INITIAL_STATE,
} from '../js/sim2.js';
import { materializeCalibrationDataset } from '../js/calibration-dataset.js';
import { cellById } from '../js/cells.js';
import { ocvCell } from '../js/sim1d.js';

const CELL = cellById('samsung-inr21700-50e');
const flat = (n, amps, dtS = 1) => ({ dtS, i: Array(n).fill(amps) });
const exactTemporalWork = ({
  s = 1, p = 1, nModules = 1, params = {}, dtS, i,
}) => estimateSim2Work({
  cell: CELL, s, p, nModules,
  params: { ...defaultParams(CELL), ...params }, profile: { dtS, i },
}).integrationStepCount;

function calibrationDataset({
  id = 'sim2-synthetic-1', n = 12, purpose = 'calibration', cellId = CELL.id,
  s = 1, p = 1, startSoC = 0.8, ambientC = 25, moduleCount = 1,
  temperatureLocation = 'module-maximum', temperature = true, segments = null,
  voltageOffset = 0,
} = {}) {
  const currentA = Array.from({ length: n }, (_, index) => index % 4 < 2 ? 10 : 0);
  const voltageV = Array.from({ length: n }, (_, index) => 3.75 - currentA[index] * 0.002 + index * 0.001 + voltageOffset);
  const temperatureC = temperature ? Array.from({ length: n }, (_, index) => 25 + index * 0.01) : null;
  return materializeCalibrationDataset({
    id, kind: 'synthetic', purpose,
    source: {
      tool: 'P2D synthetic reference', toolVersion: '1.0', model: 'reference-cell',
      runId: id, generatedAt: '2026-08-07T10:30:00Z', mediaType: 'application/json',
      rawSha256: 'a'.repeat(64),
    },
    binding: {
      cellId, seriesCells: s, parallelCells: p, startSoC, ambientC, moduleCount,
      initialState: 'rested-equilibrium-at-ambient',
    },
    normalization: {
      format: 'battery-design/calibration-normalization@1', adapter: 'canonical-json',
      adapterVersion: '1.0.0', mappingChecksum: 'b'.repeat(64),
      sourceUnits: { time: 's', current: 'A', voltage: 'V', temperature: temperature ? 'degC' : null },
      sourceCurrentPositive: 'discharge', sourceCurrentScope: 'pack',
      sourceVoltageLocation: 'pack-terminal',
      sourceTemperatureLocation: temperature ? temperatureLocation : null,
      sourceSampleAlignment: 'end-of-step', sourceFirstSampleTimeS: 0,
      sourceResetTimeS: -1,
      timeHandling: 'validated-uniform', originalSampleCount: n,
    },
    samplePeriodS: 1,
    signals: { currentA, voltageV, temperatureC },
    segments: segments || [{ id: 'all', startIndex: 0, endIndexExclusive: n, mode: 'dynamic', include: true }],
    conventions: {
      timeBasis: 'uniform-sample-period', timeOrigin: 'trial-reset',
      firstSampleOffsetS: 1, sampleAlignment: 'end-of-step',
      currentHold: 'zero-order-hold', currentPositive: 'discharge', currentScope: 'pack',
      voltageLocation: 'pack-terminal', temperatureLocation: temperature ? temperatureLocation : null,
    },
  });
}

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

test('every simulator sample is the physically aligned end of its declared interval', () => {
  const params = {
    ...defaultParams(CELL), r0Ref: 20, rc1R: 0, rc2R: 0, r0EaJ: 0,
    r0SocRise: 1, hystV: 0, entropyVK: 0, uaAmbWK: 0, hCoolWK: 0,
    currentImbalance: 1, maxDtS: 60,
  };
  const dtS = 2, currentA = 100, parallelCells = 100, startSoC = 0.8;
  const result = simulate({
    cell: CELL, s: 1, p: parallelCells, params,
    profile: { dtS, i: [currentA, currentA] },
    nModules: 1, ambientC: 25, startSoC,
  });
  const packResistanceOhm = params.r0Ref / 1000 / parallelCells;
  const capacityAh = CELL.capacityAh * parallelCells;
  const expectedFirstSoC = startSoC - currentA * dtS / 3600 / capacityAh;
  const moduleHeatCapacity = (CELL.massG / 1000) * parallelCells * params.cpCellJkgK;
  const expectedFirstTempC = 25 + currentA ** 2 * packResistanceOhm * dtS / moduleHeatCapacity;
  const expectedFirstVoltage = ocvCell(CELL, expectedFirstSoC) - currentA * packResistanceOhm;

  assert.deepEqual(result.series.t, [2, 4], 'sample k is stamped at (k+1)dt, never at the interval start');
  near(result.series.soc[0], expectedFirstSoC, 1e-14, 'sample SoC is the transitioned end state');
  near(result.series.tMax[0], expectedFirstTempC, 1e-12, 'sample temperature is the transitioned end state');
  near(result.series.v[0], expectedFirstVoltage, 1e-12,
    'terminal voltage uses the same end-of-step SoC and electrical state');
  assert.equal(result.series.t.at(-1), result.summary.durationS);
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
  const fracAt = (timeS) => {
    const index = r.series.t.indexOf(timeS);
    assert.notEqual(index, -1, `trace contains ${timeS} s`);
    return (overpotential(index) - I * r0Ohm) / full;
  };
  near(fracAt(tau), -Math.expm1(-1), 1e-10, 'one time constant is the exact exponential 63.2%');
  near(fracAt(2 * tau), -Math.expm1(-2), 1e-10, 'two time constants are the exact exponential 86.5%');
  near(fracAt(3 * tau), -Math.expm1(-3), 1e-10, 'three time constants are the exact exponential 95.0%');
});

test('exact RC updates and heat remain finite at every tau/maxDt bound combination', () => {
  for (const tauS of [PARAM_BY_ID.rc1TauS.min, PARAM_BY_ID.rc1TauS.max]) {
    for (const maxDtS of [PARAM_BY_ID.maxDtS.min, PARAM_BY_ID.maxDtS.max]) {
      const params = {
        ...defaultParams(CELL), r0Ref: PARAM_BY_ID.r0Ref.min, rc1R: 10, rc2R: 0,
        rc1TauS: tauS, r0EaJ: 0, r0SocRise: 1, hystV: 0, entropyVK: 0,
        uaAmbWK: 0, hCoolWK: 0, maxDtS,
      };
      const currentA = 10;
      const result = simulate({
        cell: CELL, s: 1, p: 1, params,
        profile: { dtS: maxDtS, i: [currentA] },
        nModules: 1, ambientC: 25, startSoC: 0.8,
      });
      const r0Ohm = params.r0Ref / 1000;
      const rcOhm = params.rc1R / 1000;
      const overpotential = ocvCell(CELL, result.series.soc[0]) - result.series.v[0];
      const fraction = (overpotential - currentA * r0Ohm) / (currentA * rcOhm);
      const expected = -Math.expm1(-maxDtS / tauS);
      const tolerance = Math.max(1e-10, expected * 1e-6);
      near(fraction, expected, tolerance, `tau=${tauS}, maxDt=${maxDtS}: exact stable RC fraction`);
      assert.ok(Number.isFinite(result.series.heatW[0]) && result.series.heatW[0] >= 0,
        `tau=${tauS}, maxDt=${maxDtS}: instantaneous heat is finite and non-negative`);
      assert.ok(Number.isFinite(result.summary.lossWh) && result.summary.lossWh >= 0,
        `tau=${tauS}, maxDt=${maxDtS}: integrated irreversible heat is finite`);
    }
  }
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

test('stability-limited thermal microsteps bound the exact legal stiff one-node repro', () => {
  const params = {
    ...defaultParams(CELL), hCoolWK: 500, maxDtS: 60,
    cpCellJkgK: 300, uaAmbWK: 200,
  };
  const input = {
    cell: CELL, s: 1, p: 1, nModules: 1, params,
    ambientC: 35, startSoC: 0.8, profile: { dtS: 60, i: [1, 1, 1] },
  };
  const result = simulate(input);
  assert.deepEqual(result.series.t, [60, 120, 180]);
  for (const channel of ['v', 'soc', 'tMax', 'tMin', 'tCoolOut', 'heatW']) {
    assert.ok(result.series[channel].every(Number.isFinite), `${channel} remains finite`);
  }
  assert.ok(result.series.tMax.every((value) => value > 25 && value < 35),
    `stiff cooling converges inside its physical boundary: ${result.series.tMax.join(', ')}`);
  assert.ok(result.summary.maxTempC < 35 && result.summary.maxTempC > 25);

  const capRateWK = params.mdotKgS * params.cpCoolJkgK;
  const coolingConductanceWK = capRateWK * -Math.expm1(-params.hCoolWK / capRateWK);
  const heatCapacityJK = (CELL.massG / 1000) * params.cpCellJkgK;
  const thermalSubsteps = Math.ceil(60 / (0.02 * heatCapacityJK
    / (coolingConductanceWK + params.uaAmbWK)));
  const expectedWorkPerEvaluation = input.profile.i.length * thermalSubsteps;
  const estimate = estimateSim2Work(input);
  assert.ok(Object.isFrozen(estimate), 'the public preflight plan is immutable');
  assert.equal(estimate.integrationStepCount, expectedWorkPerEvaluation,
    'the exported estimator uses the exact electrical×thermal plan executed by simulate');
  assert.equal(estimate.thermalNodeUpdateCount, expectedWorkPerEvaluation,
    'node work is the temporal plan multiplied by the resolved module count');
  const measured = { dtS: 60, i: input.profile.i, v: result.series.v };
  const calibrated = calibrate({
    ...input, measured, fit: ['r0Ref'], maxEvaluations: 2,
    maxIntegrationSteps: expectedWorkPerEvaluation * 2,
  });
  assert.equal(calibrated.workPerEvaluation, expectedWorkPerEvaluation,
    'work includes every electrical×thermal temporal substep');
  assert.equal(calibrated.integrationStepCount, expectedWorkPerEvaluation * 2);
  assert.equal(calibrated.nodeWorkPerEvaluation, expectedWorkPerEvaluation);
  assert.equal(calibrated.thermalNodeUpdateCount, expectedWorkPerEvaluation * 2,
    'calibration evidence charges every adaptive thermal node update');
  assert.throws(() => calibrate({
    ...input, measured, fit: ['r0Ref'], maxEvaluations: 2,
    maxIntegrationSteps: expectedWorkPerEvaluation * 2 - 1,
  }), /maxIntegrationSteps must allow.*initial simplex/,
  'the complete initial work is rejected before any candidate simulation');
});

test('thermal accuracy resolves a closed-form one-time-constant cooling decay', () => {
  const params = {
    ...defaultParams(CELL), r0Ref: PARAM_BY_ID.r0Ref.min, rc1R: 0, rc2R: 0,
    r0EaJ: 0, r0SocRise: 1, hystV: 0, entropyVK: 0, kCondWK: 0,
    hCoolWK: 500, mdotKgS: 5, cpCoolJkgK: 4200, coolantInC: 0,
    uaAmbWK: 0, cpCellJkgK: 300, maxDtS: 60,
  };
  const heatCapacityJK = (CELL.massG / 1000) * params.cpCellJkgK;
  const capRateWK = params.mdotKgS * params.cpCoolJkgK;
  const coolingConductanceWK = capRateWK * -Math.expm1(-params.hCoolWK / capRateWK);
  const timeConstantS = heatCapacityJK / coolingConductanceWK;
  const result = simulate({
    cell: CELL, s: 1, p: 1, nModules: 1, params,
    ambientC: 25, startSoC: 0.8, profile: { dtS: timeConstantS, i: [0] },
  });
  const expectedC = 25 / Math.E;
  near(result.series.tMax[0], expectedC, expectedC * 0.011,
    '50+ accuracy-limited Euler microsteps reproduce exp(-1) to about 1%');
  const plan = estimateSim2Work({
    cell: CELL, s: 1, p: 1, nModules: 1, params,
    profile: { dtS: timeConstantS, i: [0] },
  });
  assert.ok(plan.thermalSubstepsPerElectricalStep >= 50,
    'the fastest local thermal time constant receives at least 50 microsteps');
});

test('thermal heat shares conserve energy and coolant output uses the final node state', () => {
  const oneNodeParams = {
    ...defaultParams(CELL), r0Ref: 20, rc1R: 0, rc2R: 0, r0EaJ: 0,
    r0SocRise: 1, hystV: 0, entropyVK: 0, kCondWK: 0, hCoolWK: 0,
    uaAmbWK: 0, cpCellJkgK: 300, currentImbalance: 1.8, maxDtS: 60,
  };
  const currentA = 10, dtS = 10, ambientC = 25;
  const one = simulate({
    cell: CELL, s: 1, p: 1, nModules: 1, params: oneNodeParams,
    ambientC, startSoC: 0.8, profile: { dtS, i: [currentA] },
  });
  const oneHeatCapacity = (CELL.massG / 1000) * oneNodeParams.cpCellJkgK;
  const oneHeatW = currentA ** 2 * oneNodeParams.r0Ref / 1000;
  near(one.series.tMax[0] - ambientC, oneHeatW * dtS / oneHeatCapacity, 1e-12,
    'one node receives exactly qTotal, never currentImbalance×qTotal');

  const multiParams = { ...oneNodeParams, currentImbalance: 1.6 };
  const multi = simulate({
    cell: CELL, s: 4, p: 1, nModules: 4, params: multiParams,
    ambientC, startSoC: 0.8, profile: { dtS, i: [currentA] },
  });
  const moduleHeatCapacity = (CELL.massG / 1000) * multiParams.cpCellJkgK;
  const storedHeatJ = moduleHeatCapacity * (
    multi.series.tMax[0] - ambientC + 3 * (multi.series.tMin[0] - ambientC)
  );
  const packHeatW = currentA ** 2 * multiParams.r0Ref * 4 / 1000;
  near(storedHeatJ, packHeatW * dtS, 1e-9,
    'all module imbalance weights sum to the one generated pack heat');

  const phaseParams = {
    ...oneNodeParams, r0Ref: PARAM_BY_ID.r0Ref.min, hCoolWK: 500,
    mdotKgS: 5, cpCoolJkgK: 4200, coolantInC: 0,
  };
  const phaseDtS = ((CELL.massG / 1000) * phaseParams.cpCellJkgK) / phaseParams.hCoolWK;
  const phase = simulate({
    cell: CELL, s: 1, p: 1, nModules: 1, params: phaseParams,
    ambientC, startSoC: 0.8, profile: { dtS: phaseDtS, i: [0] },
  });
  const phaseCapRate = phaseParams.mdotKgS * phaseParams.cpCoolJkgK;
  const phaseEffectiveness = -Math.expm1(-phaseParams.hCoolWK / phaseCapRate);
  const expectedOutletC = phaseParams.coolantInC
    + phaseEffectiveness * (phase.series.tMax[0] - phaseParams.coolantInC);
  near(phase.series.tCoolOut[0], expectedOutletC, 1e-12,
    'reported coolant outlet is reevaluated from the final end-of-step node temperature');
});

test('module defaults and direct-work guards keep topology and node work bounded', () => {
  const oneCell = simulate({
    cell: CELL, s: 1, p: 1, profile: flat(3, 0), ambientC: 25,
  });
  assert.equal(oneCell.summary.nModules, 1, 'omitted modules resolve to the available one-cell topology');
  const normalPack = simulate({
    cell: CELL, s: 96, p: 4, profile: flat(3, 0), ambientC: 25,
  });
  assert.equal(normalPack.summary.nModules, 4, 'normal packs retain the four-module default');
  assert.throws(() => simulate({
    cell: CELL, s: 1, p: 1, nModules: 2, profile: flat(3, 0),
  }), /nModules.*cannot exceed.*modeled cells/);
  assert.throws(() => calibrate({
    cell: CELL, s: 1, p: 1, nModules: 2,
    measured: { dtS: 1, i: [0, 0, 0], v: [3.7, 3.7, 3.7] },
    fit: ['r0Ref'], maxEvaluations: 2,
  }), /nModules.*cannot exceed.*modeled cells/);
  const stiffLarge = {
    cell: CELL, s: 10_000, p: 1, nModules: 10_000,
    params: {
      ...defaultParams(CELL), cpCellJkgK: 300, kCondWK: 200,
      hCoolWK: 500, uaAmbWK: 200, mdotKgS: 5, cpCoolJkgK: 4200,
      maxDtS: 60,
    },
    profile: { dtS: 60, i: [0, 0, 0, 0, 0] },
  };
  const stiffLargePlan = estimateSim2Work(stiffLarge);
  assert.ok(stiffLargePlan.thermalNodeUpdateCount > 100_000_000);
  assert.throws(() => simulate(stiffLarge), /thermal node updates/,
    'direct simulation rejects excessive node work during preflight, before entering the integration loop');
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

test('calibration boundary rejects malformed traces before optimization', () => {
  const valid = { dtS: 1, i: [1, 2, 3], v: [3.7, 3.6, 3.5] };
  const input = (measured) => ({ cell: CELL, s: 1, p: 1, measured, fit: ['r0Ref'], maxEvaluations: 2 });

  for (const dtS of [0, -1, 3_600.0001, 1e308, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => calibrate(input({ ...valid, dtS })), /measured\.dtS/);
  }
  assert.throws(() => calibrate(input({ ...valid, i: [1, 2] })), /at least 3/);
  assert.throws(() => calibrate(input({ ...valid, v: [3.7, 3.6, 3.5, 3.4] })), /exactly 3/);
  assert.throws(() => calibrate(input({ ...valid, t: [25, 26] })), /measured\.t.*exactly 3/);
  assert.throws(() => calibrate(input({ ...valid, i: [1, Number.NaN, 3] })), /measured\.i\[1\].*finite/);
  assert.throws(() => calibrate(input({ ...valid, v: [3.7, Number.POSITIVE_INFINITY, 3.5] })), /measured\.v\[1\].*finite/);
  assert.throws(() => calibrate(input({ ...valid, t: [25, Number.NaN, 25] })), /measured\.t\[1\].*finite/);

  assert.equal(rmse([1, 2, 3], [1, 2, 3]), 0);
  assert.throws(() => rmse([1, 2, 3], [1, 2]), /equal lengths/);
  assert.throws(() => rmse([1, Number.NaN], [1, 2]), /index 1.*finite/);
  assert.throws(() => rmse([1, 2], [1, Number.POSITIVE_INFINITY]), /index 1.*finite/);
});

test('only unique, known electrical and thermal parameters are fit-eligible', () => {
  const measured = { dtS: 1, i: [1, 2, 3], v: [3.7, 3.6, 3.5] };
  const run = (fit) => calibrate({ cell: CELL, s: 1, p: 1, measured, fit, maxEvaluations: Math.max(2, fit.length + 1) });
  assert.throws(() => run([]), /1 to 8/);
  assert.throws(() => run(CALIBRATION_FIT_ELIGIBLE.slice(0, 9)), /1 to 8/);
  assert.throws(() => run(['r0Ref', 'r0Ref']), /duplicate.*r0Ref/);
  assert.throws(() => run(['r0Ref', 42]), /fit\[1\].*string/);
  assert.throws(() => run(['madeUp']), /not parameters/i);
  assert.throws(() => run(['calA']), /aging.*including maxDtS/);
  assert.throws(() => run(['tRefC']), /solver.*including maxDtS/);
  assert.throws(() => run(['maxDtS']), /solver.*including maxDtS/);
  assert.ok(CALIBRATION_FIT_ELIGIBLE.every((name) => ['electrical', 'thermal'].includes(PARAM_BY_ID[name].group)));
});

test('partial parameter overrides merge over complete cell defaults and never repair caller errors', () => {
  const measured = { dtS: 1, i: [1, 2, 3], v: [3.7, 3.6, 3.5] };
  const common = { cell: CELL, s: 1, p: 1, measured, fit: ['r0Ref'], maxEvaluations: 2 };
  const work = exactTemporalWork({ params: { rc1TauS: 20 }, dtS: measured.dtS, i: measured.i });
  const output = calibrate({ ...common, params: { rc1TauS: 20 }, maxIntegrationSteps: work * 2 });
  assert.equal(output.params.rc1TauS, 20);
  assert.equal(output.fitted.r0Ref.from, defaultParams(CELL).r0Ref);
  assert.equal(output.params.rc1R, defaultParams(CELL).rc1R);
  assert.equal(Object.keys(output.params).length, PARAM_SPEC.length);
  assert.ok(Object.values(output.params).every(Number.isFinite), 'dependent defaults are resolved before partial overrides');

  assert.throws(() => calibrate({ ...common, params: { typoResistance: 2 } }), /Unknown calibration parameter override.*typoResistance/);
  assert.throws(() => calibrate({ ...common, params: { r0Ref: -1 } }), /does not clamp overrides/);
  assert.throws(() => calibrate({ ...common, params: { r0Ref: undefined } }), /does not repair missing values/);
});

test('evaluation and immutable-maxDt integration budgets count every executed objective exactly', () => {
  const measured = { dtS: 1, i: [1, 2, 3], v: [3.7, 3.6, 3.5] };
  const common = {
    cell: CELL, s: 1, p: 1, measured, fit: ['r0Ref'], params: { maxDtS: 0.5 },
    maxIter: 100,
  };
  const work = exactTemporalWork({ params: common.params, dtS: measured.dtS, i: measured.i });
  const evaluationBound = calibrate({ ...common, maxEvaluations: 2, maxIntegrationSteps: work * 3 });
  assert.equal(evaluationBound.terminationReason, 'max-evaluations');
  assert.equal(evaluationBound.evaluationCount, 2);
  assert.equal(evaluationBound.workPerEvaluation, work);
  assert.equal(evaluationBound.integrationStepCount, work * 2);
  assert.equal(evaluationBound.integrationStepCount,
    evaluationBound.evaluationCount * evaluationBound.workPerEvaluation);

  const workBound = calibrate({ ...common, maxEvaluations: 3, maxIntegrationSteps: work * 2 });
  assert.equal(workBound.terminationReason, 'max-integration-steps');
  assert.equal(workBound.evaluationCount, 2);
  assert.equal(workBound.integrationStepCount, work * 2);
  assert.ok(workBound.rmseBefore >= 0 && workBound.rmseAfter >= 0,
    'baseline and selected final result came from accounted cached evaluations, not uncounted reruns');
});

test('bound evidence recognizes both signed entropy limits without flagging an interior value', () => {
  for (const [entropyVK, expectedAtBound] of [
    [PARAM_BY_ID.entropyVK.min, true],
    [PARAM_BY_ID.entropyVK.max, true],
    [-0.001, false],
  ]) {
    const params = { ...defaultParams(CELL), entropyVK };
    const current = Array.from({ length: 12 }, (_, index) => index < 6 ? 20 : -10);
    const input = {
      cell: CELL, s: 1, p: 20, nModules: 1, params,
      ambientC: 25, startSoC: 0.8, profile: { dtS: 1, i: current },
    };
    const synthetic = simulate(input);
    const work = estimateSim2Work(input).integrationStepCount;
    const result = calibrate({
      ...input,
      measured: {
        dtS: 1, i: current, v: synthetic.series.v, t: synthetic.series.tMax,
      },
      fit: ['entropyVK'], weightTemp: 1, maxEvaluations: 2,
      maxIntegrationSteps: work * 2,
    });
    assert.equal(result.fitted.entropyVK.to, entropyVK);
    assert.equal(result.fitted.entropyVK.atBound, expectedAtBound,
      `${entropyVK} uses span/absolute distance from both signed bounds`);
  }
});

test('the initial simplex stays full-rank when every fitted value starts on its upper bound', () => {
  const truth = { ...defaultParams(CELL), r0Ref: 80, rc1R: 40, r0EaJ: 0 };
  const current = Array.from({ length: 30 }, (_, index) => index < 10 ? 0 : index < 20 ? 20 : 5);
  const synthetic = simulate({
    cell: CELL, s: 1, p: 1, params: truth,
    profile: { dtS: 1, i: current }, nModules: 1, ambientC: 25, startSoC: 0.8,
  });
  const result = calibrate({
    cell: CELL, s: 1, p: 1,
    measured: { dtS: 1, i: current, v: synthetic.series.v },
    params: { r0Ref: PARAM_BY_ID.r0Ref.max, rc1R: PARAM_BY_ID.rc1R.max },
    fit: ['r0Ref', 'rc1R'], nModules: 1, ambientC: 25, startSoC: 0.8,
    maxIter: 100, maxEvaluations: 3,
    maxIntegrationSteps: exactTemporalWork({
      params: { r0Ref: PARAM_BY_ID.r0Ref.max, rc1R: PARAM_BY_ID.rc1R.max },
      dtS: 1, i: current,
    }) * 3,
  });

  assert.equal(result.evaluationCount, 3, 'x0 plus one distinct independent vertex per axis are evaluated');
  assert.equal(result.terminationReason, 'max-evaluations');
  assert.ok(result.rmseAfter < result.rmseBefore,
    'a bound does not collapse the simplex to duplicate x0 vertices');
  assert.ok(result.fitted.r0Ref.to < PARAM_BY_ID.r0Ref.max
    || result.fitted.rc1R.to < PARAM_BY_ID.rc1R.max,
  'at least one independent inward axis step is selectable');
});

test('governed dataset calibration enforces purpose and exact model binding', () => {
  const valid = calibrationDataset();
  const options = { cell: CELL, datasets: valid, fit: ['r0Ref'], maxEvaluations: 2 };
  assert.doesNotThrow(() => calibrateDatasets(options));
  assert.throws(() => calibrateDatasets({ ...options, datasets: calibrationDataset({ purpose: 'validation' }) }),
    /purpose "validation".*calibration purpose/);
  assert.throws(() => calibrateDatasets({ ...options, datasets: calibrationDataset({ cellId: null }) }),
    /bound to cell "null"/);
  assert.throws(() => calibrateDatasets({ ...options, datasets: calibrationDataset({ cellId: 'another-cell' }) }),
    /another-cell.*rather than/);
  const contexts = calibrateDatasets({
    ...options,
    datasets: [valid, calibrationDataset({
      id: 'different-context', startSoC: 0.7, ambientC: 5, voltageOffset: 0.01,
    })],
  });
  assert.equal(contexts.preprocessing[0].binding.startSoC, 0.8);
  assert.equal(contexts.preprocessing[0].binding.ambientC, 25);
  assert.equal(contexts.preprocessing[1].binding.startSoC, 0.7);
  assert.equal(contexts.preprocessing[1].binding.ambientC, 5);
  assert.throws(() => calibrateDatasets({
    ...options,
    datasets: [valid, calibrationDataset({ id: 'different-pack', s: 2, voltageOffset: 0.01 })],
  }), /incompatible binding\.seriesCells/);
  assert.throws(() => calibrateDatasets({ ...options, datasets: Array(MAX_CALIBRATION_DATASETS + 1).fill(valid) }),
    /1 to 8/);

  const tampered = structuredClone(valid);
  tampered.signals.voltageV[0] += 0.01;
  assert.throws(() => calibrateDatasets({ ...options, datasets: tampered }), /checksum.*canonical dataset content/);
});

test('rested initial state is explicit in simulation and calibration evidence', () => {
  const simulated = simulate({
    cell: CELL, s: 1, p: 2, profile: flat(3, 0), nModules: 2,
    ambientC: 17, startSoC: 0.8,
  });
  assert.deepEqual(simulated.initialStateAssumptions, [{
    kind: SIM2_SUPPORTED_INITIAL_STATE,
    datasetId: null,
    rcPolarizationV: [0, 0],
    hysteresisState: 0,
    thermalNodes: { count: 2, temperatureC: 17 },
  }]);
  assert.match(simulated.assumptions[0], /rested-equilibrium-at-ambient.*RC polarization.*hysteresis.*thermal nodes/i);

  const dataset = calibrationDataset({
    id: 'rested-state-evidence', p: 2, ambientC: 17, moduleCount: 2,
  });
  const calibrated = calibrateDatasets({
    cell: CELL, datasets: dataset, fit: ['r0Ref'], maxEvaluations: 2,
  });
  assert.deepEqual(calibrated.initialStateAssumptions, [{
    kind: SIM2_SUPPORTED_INITIAL_STATE,
    datasetId: dataset.id,
    rcPolarizationV: [0, 0],
    hysteresisState: 0,
    thermalNodes: { count: 2, temperatureC: 17 },
  }]);

  for (const mutate of [
    (value) => { delete value.binding.initialState; },
    (value) => { value.binding.initialState = 'unknown-warm-start'; },
  ]) {
    const unsupported = structuredClone(dataset);
    mutate(unsupported);
    assert.throws(() => calibrateDatasets({
      cell: CELL, datasets: unsupported, fit: ['r0Ref'], maxEvaluations: 2,
    }), /binding\.initialState|initialState/i,
    'a canonical trial must explicitly declare the one supported rested state');
  }
});

test('joint calibration objective includes every dataset with exact sample weighting', () => {
  const first = calibrationDataset({ id: 'joint-objective-first' });
  const second = calibrationDataset({ id: 'joint-objective-second', voltageOffset: 0.4 });
  const run = (datasets) => {
    const list = Array.isArray(datasets) ? datasets : [datasets];
    const budget = list.reduce((sum, dataset) => sum + exactTemporalWork({
      s: dataset.binding.seriesCells, p: dataset.binding.parallelCells,
      nModules: dataset.binding.moduleCount, dtS: dataset.samplePeriodS,
      i: dataset.signals.currentA,
    }), 0) * 2;
    return calibrateDatasets({
      cell: CELL,
      datasets,
      fit: ['r0Ref'],
      maxEvaluations: 2,
      maxIntegrationSteps: budget,
      maxSamplesPerDataset: 12,
    });
  };
  const firstOnly = run(first);
  const secondOnly = run(second);
  const joint = run([first, second]);
  const expectedJointRmse = Math.sqrt((
    firstOnly.voltageRmseBefore ** 2 * firstOnly.voltageSampleCount
    + secondOnly.voltageRmseBefore ** 2 * secondOnly.voltageSampleCount
  ) / (firstOnly.voltageSampleCount + secondOnly.voltageSampleCount));

  near(joint.voltageRmseBefore, expectedJointRmse, 1e-12,
    'joint voltage RMSE is the sample-weighted objective from both datasets');
  assert.equal(joint.voltageSampleCount,
    firstOnly.voltageSampleCount + secondOnly.voltageSampleCount);
  assert.equal(joint.workPerEvaluation,
    firstOnly.workPerEvaluation + secondOnly.workPerEvaluation);
  assert.notEqual(joint.voltageRmseBefore, firstOnly.voltageRmseBefore,
    'changing only dataset two materially changes the joint objective');
  assert.deepEqual(joint.datasetChecksums, [first.checksum, second.checksum]);
});

test('joint calibration rejects a duplicated canonical dataset identity', () => {
  const dataset = calibrationDataset({ id: 'duplicate-canonical-dataset' });
  assert.throws(() => calibrateDatasets({
    cell: CELL,
    datasets: [dataset, dataset],
    fit: ['r0Ref'],
    maxEvaluations: 2,
  }), /checksum .* is duplicated/);
});

test('joint calibration rejects every incompatible pack topology dimension', () => {
  const first = calibrationDataset({ id: 'topology-reference' });
  for (const [key, overrides] of [
    ['parallelCells', { p: 2 }],
    ['moduleCount', { moduleCount: 2 }],
  ]) {
    const incompatible = calibrationDataset({
      id: `topology-mismatch-${key}`,
      voltageOffset: 0.01,
      ...overrides,
    });
    assert.throws(() => calibrateDatasets({
      cell: CELL,
      datasets: [first, incompatible],
      fit: ['r0Ref'],
      maxEvaluations: 2,
    }), new RegExp(`incompatible binding\\.${key}`));
  }
});

test('preprocessing refuses objectives with fewer than three fully included points', () => {
  const sparse = calibrationDataset({
    id: 'too-few-scored-points',
    n: 12,
    segments: [
      { id: 'score-two', startIndex: 0, endIndexExclusive: 2, mode: 'pulse', include: true },
      { id: 'exclude-rest', startIndex: 2, endIndexExclusive: 12, mode: 'rest', include: false },
    ],
  });
  assert.throws(() => calibrateDatasets({
    cell: CELL,
    datasets: sparse,
    fit: ['r0Ref'],
    maxEvaluations: 2,
    maxSamplesPerDataset: 12,
  }), /leaves only 2 included points.*at least 3/);
});

test('dataset temperature is compared only at module maximum, otherwise explicitly excluded', () => {
  const cellCore = calibrationDataset({ temperatureLocation: 'cell-core' });
  const ignored = calibrateDatasets({ cell: CELL, datasets: cellCore, fit: ['r0Ref'], maxEvaluations: 2 });
  assert.equal(ignored.temperatureSampleCount, 0);
  assert.match(ignored.notes.join(' '), /ignored cell-core temperature.*module-maximum/);
  assert.throws(() => calibrateDatasets({
    cell: CELL, datasets: cellCore, fit: ['r0Ref'], maxEvaluations: 2, weightTemp: 0.1,
  }), /cell-core.*weightTemp requires module-maximum/);

  const moduleMaximum = calibrationDataset();
  const used = calibrateDatasets({
    cell: CELL, datasets: moduleMaximum, fit: ['r0Ref'], maxEvaluations: 2, weightTemp: 0.1,
  });
  assert.equal(used.temperatureSampleCount, moduleMaximum.signals.temperatureC.length);
});

test('included segments and deterministic block means remain bounded, aligned and traceable', () => {
  const dataset = calibrationDataset({
    id: 'large-segmented-trace', n: 120,
    segments: [
      { id: 'include-a', startIndex: 0, endIndexExclusive: 31, mode: 'pulse', include: true },
      { id: 'exclude', startIndex: 31, endIndexExclusive: 59, mode: 'rest', include: false },
      { id: 'include-b', startIndex: 59, endIndexExclusive: 120, mode: 'dynamic', include: true },
    ],
  });
  const result = calibrateDatasets({
    cell: CELL, datasets: dataset, fit: ['r0Ref'], weightTemp: 0.1,
    maxSamplesPerDataset: 20, maxEvaluations: 3,
    maxIntegrationSteps: exactTemporalWork({
      dtS: 6,
      i: Array.from({ length: 20 }, (_, block) => (
        dataset.signals.currentA.slice(block * 6, block * 6 + 6)
          .reduce((sum, value) => sum + value, 0) / 6
      )),
    }) * 2,
  });
  const prep = result.preprocessing[0];
  assert.equal(prep.method, 'block-mean-current-end-sample');
  assert.equal(prep.factor, 6);
  assert.equal(prep.originalSamples, 120);
  assert.equal(prep.usedSamples, 20);
  assert.deepEqual(prep.channelLengths, { current: 20, voltage: 20, temperature: 20 });
  assert.equal(prep.originalSamplePeriodS, 1);
  assert.equal(prep.usedSamplePeriodS, 6);
  assert.equal(prep.originalIncludedSamples, 92);
  assert.equal(prep.representedIncludedSamples, 90);
  assert.equal(prep.unrepresentedIncludedSamples, 2);
  assert.equal(prep.mixedBoundaryBlocks, 2, 'blocks crossing include/exclude boundaries are fail-closed and unscored');
  assert.equal(prep.usedIncludedSamples, 15);
  assert.equal(result.voltageSampleCount, 15, 'include=false samples do not enter the objective');
  assert.equal(result.temperatureSampleCount, 15);
  assert.deepEqual(result.datasetChecksums, [dataset.checksum]);
  assert.equal(prep.checksum, dataset.checksum);
  assert.equal(prep.rawSha256, dataset.source.rawSha256);
  assert.equal(prep.sourceTool, dataset.source.tool);
  assert.match(result.checksumSemantics, /identify exact canonical content.*do not authenticate/);
  assert.equal(result.evaluationCount, 2);
  const expectedWork = exactTemporalWork({
    dtS: 6,
    i: Array.from({ length: 20 }, (_, block) => (
      dataset.signals.currentA.slice(block * 6, block * 6 + 6)
        .reduce((sum, value) => sum + value, 0) / 6
    )),
  });
  assert.equal(result.workPerEvaluation, expectedWork,
    'work uses every electrical step and accuracy-limited thermal microstep');
  assert.equal(result.integrationStepCount, expectedWork * 2);
  assert.equal(result.terminationReason, 'max-integration-steps');
});

test('preprocessing preserves end-of-step voltage and temperature phase', () => {
  const dataset = calibrationDataset({ id: 'end-sample-ramp', n: 12 });
  const blockCurrent = Array.from({ length: 6 }, (_, block) => (
    dataset.signals.currentA[block * 2] + dataset.signals.currentA[block * 2 + 1]
  ) / 2);
  const result = calibrateDatasets({
    cell: CELL, datasets: dataset, fit: ['kCondWK'], weightTemp: 0.1,
    maxSamplesPerDataset: 8, maxEvaluations: 2,
    maxIntegrationSteps: exactTemporalWork({ dtS: 2, i: blockCurrent }) * 2,
  });
  const factor = 2;
  const prediction = simulate({
    cell: CELL, s: 1, p: 1, profile: { dtS: 2, i: blockCurrent },
    startSoC: 0.8, ambientC: 25, nModules: 1,
  });
  const endVoltage = Array.from({ length: 6 }, (_, block) => dataset.signals.voltageV[block * factor + 1]);
  const meanVoltage = Array.from({ length: 6 }, (_, block) => (
    dataset.signals.voltageV[block * factor] + dataset.signals.voltageV[block * factor + 1]
  ) / factor);
  const endTemperature = Array.from({ length: 6 }, (_, block) => dataset.signals.temperatureC[block * factor + 1]);
  const meanTemperature = Array.from({ length: 6 }, (_, block) => (
    dataset.signals.temperatureC[block * factor] + dataset.signals.temperatureC[block * factor + 1]
  ) / factor);

  near(result.voltageRmseBefore, rmse(prediction.series.v, endVoltage), 1e-12,
    'voltage observations remain at the block end');
  near(result.temperatureRmseBefore, rmse(prediction.series.tMax, endTemperature), 1e-12,
    'temperature observations remain at the block end');
  assert.notEqual(result.voltageRmseBefore, rmse(prediction.series.v, meanVoltage));
  assert.notEqual(result.temperatureRmseBefore, rmse(prediction.series.tMax, meanTemperature));
  assert.equal(result.preprocessing[0].method, 'block-mean-current-end-sample');
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
