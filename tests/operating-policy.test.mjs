// Operating policies — external demand is kept separate from the battery
// trace produced for sizing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './helpers.mjs';
import {
  OPERATING_POLICY_MODEL_VERSION, POLICY_DEMANDS, OPERATING_POLICIES,
  POLICY_PARAMETER_MODELS, operatingPolicyById, batteryProfileForPolicy,
} from '../js/operating-policy.js';

test('every policy produces a normalized, traceable battery profile', () => {
  for (const policy of OPERATING_POLICIES) {
    const out = batteryProfileForPolicy(policy.id);
    ok(out?.kind === 'policy-output', `${policy.id}: typed as a policy output`);
    const expectedSource = policy.reference?.id || policy.demandId;
    ok(out.policyId === policy.id && out.sourceProfileId === expectedSource,
      `${policy.id}: records policy and actual trace source`);
    ok(out.contextProfileId === policy.demandId,
      `${policy.id}: records the external-demand context separately`);
    ok(out.policyModelVersion === OPERATING_POLICY_MODEL_VERSION,
      `${policy.id}: records policy model version`);
    ok(out.p.length >= 4 && Math.max(...out.p.map(Math.abs)) <= 1.0000001,
      `${policy.id}: normalized sizing profile`);
    ok(out.sourceDurationS === out.p.length * out.dtS,
      `${policy.id}: source duration is explicit`);
  }
});

test('marine PMS numeric assumptions are versioned, evidenced and emitted with each result', () => {
  const expected = {
    'marine-load-levelling': { baselineFraction: 0.52 },
    'marine-boost': {
      dischargeThresholdFraction: 0.72, chargeThresholdFraction: 0.30, chargeGain: 0.70,
    },
    'marine-peak-shaving': {
      dischargeThresholdFraction: 0.68, chargeThresholdFraction: 0.25, chargeGain: 0.45,
    },
    'marine-ramp-support': { generatorRampFractionPerSecond: 0.007 },
  };
  for (const [id, values] of Object.entries(expected)) {
    const model = POLICY_PARAMETER_MODELS[id];
    const out = batteryProfileForPolicy(id);
    assert.equal(model.version, OPERATING_POLICY_MODEL_VERSION, `${id}: version`);
    assert.match(model.basis, /fraction/i, `${id}: normalization basis`);
    assert.equal(model.evidence.kind, 'provisional-engineering-assumption', `${id}: evidence kind`);
    assert.equal(model.evidence.status, 'unverified', `${id}: evidence status`);
    assert.match(model.evidence.releaseRequirement, /replace/i, `${id}: release requirement`);
    assert.deepEqual(out.parameters, values, `${id}: resolved defaults`);
    assert.deepEqual(out.parameterContract.values, values, `${id}: values travel with trace`);
    assert.equal(out.parameterContract.version, OPERATING_POLICY_MODEL_VERSION, `${id}: output version`);
    assert.match(out.parameterContract.evidence.source, /no vessel-specific commissioned PMS/i,
      `${id}: output does not imply commissioned settings`);
  }
});

test('demand-transform policies retain mission duration and respond to declared parameters', () => {
  const shortMission = { id: 'mission-short', dtS: 10, p: [0.1, 0.4, 0.8, 1.0] };
  const longMission = { id: 'mission-long', dtS: 10, p: [...shortMission.p, ...shortMission.p] };
  const short = batteryProfileForPolicy('marine-load-levelling', { demandProfile: shortMission });
  const long = batteryProfileForPolicy('marine-load-levelling', { demandProfile: longMission });
  assert.equal(short.p.length, 4);
  assert.equal(short.sourceDurationS, 40);
  assert.equal(long.p.length, 8);
  assert.equal(long.sourceDurationS, 80);
  assert.equal(short.traceBasis, 'demand-transform');
  assert.match(short.note, /current mission demand mission-short/i);

  const cases = [
    ['marine-load-levelling', { baselineFraction: 0.35 }],
    ['marine-boost', { dischargeThresholdFraction: 0.55 }],
    ['marine-peak-shaving', { dischargeThresholdFraction: 0.50 }],
    ['marine-ramp-support', { generatorRampFractionPerSecond: 0.02 }],
  ];
  for (const [id, parameters] of cases) {
    const base = batteryProfileForPolicy(id, { demandProfile: longMission });
    const changed = batteryProfileForPolicy(id, { demandProfile: longMission, parameters });
    assert.notEqual(changed.p.join('|'), base.p.join('|'), `${id}: declared parameter changes the trace`);
    for (const [key, value] of Object.entries(parameters)) {
      assert.equal(changed.parameters[key], value, `${id}: changed ${key} remains visible`);
    }
  }
});

test('ramp support uses elapsed time rather than a hidden per-sample step', () => {
  const demand10s = { id: 'ramp-10s', dtS: 10, p: [0, 1, 1, 0] };
  const demand20s = { id: 'ramp-20s', dtS: 20, p: [0, 1, 1, 0] };
  const at10s = batteryProfileForPolicy('marine-ramp-support', { demandProfile: demand10s });
  const at20s = batteryProfileForPolicy('marine-ramp-support', { demandProfile: demand20s });
  assert.equal(at10s.parameters.generatorRampFractionPerSecond, 0.007);
  assert.ok(Math.abs(at10s.sourceScaleFactor - 0.93) < 1e-12,
    '10 s permits the documented 0.07 normalized ramp');
  assert.ok(Math.abs(at20s.sourceScaleFactor - 0.86) < 1e-12,
    '20 s permits a 0.14 normalized ramp');
  assert.notEqual(at10s.p.join('|'), at20s.p.join('|'), 'sample period changes the time-based response');
});

test('invalid or undeclared PMS parameters are explicitly refused', () => {
  for (const [id, model] of Object.entries(POLICY_PARAMETER_MODELS)) {
    for (const [key, definition] of Object.entries(model.definitions)) {
      for (const value of [NaN, Infinity, '0.5', null, undefined]) {
        assert.throws(() => batteryProfileForPolicy(id, { parameters: { [key]: value } }),
          new RegExp(`${id} ${key} must be a finite number`, 'i'));
      }
      assert.throws(
        () => batteryProfileForPolicy(id, { parameters: { [key]: definition.min - 1 } }),
        new RegExp(`${id} ${key} must be between`, 'i'),
      );
      assert.throws(
        () => batteryProfileForPolicy(id, { parameters: { [key]: definition.max + 1 } }),
        new RegExp(`${id} ${key} must be between`, 'i'),
      );
    }
    assert.throws(() => batteryProfileForPolicy(id, { parameters: { hiddenSetting: 1 } }),
      /does not define parameter/i);
  }
  assert.throws(() => batteryProfileForPolicy('marine-load-levelling', { parameters: 0.4 }),
    /parameters must be an object/i);
});

test('fixed marine reference events identify themselves and never claim current-mission derivation', () => {
  const shortMission = { id: 'current-voyage-short', dtS: 60, p: [0.1, 1] };
  const longMission = { id: 'current-voyage-long', dtS: 30, p: Array(40).fill(0.7) };
  for (const id of ['marine-spinning-reserve', 'marine-load-smoothing']) {
    const policy = operatingPolicyById(id);
    const short = batteryProfileForPolicy(id, { demandProfile: shortMission });
    const long = batteryProfileForPolicy(id, { demandProfile: longMission });
    assert.equal(short.traceBasis, 'versioned-reference-event');
    assert.equal(short.sourceProfileId, policy.reference.id);
    assert.equal(short.contextProfileId, shortMission.id);
    assert.equal(long.contextProfileId, longMission.id);
    assert.equal(short.p.join('|'), long.p.join('|'), `${id}: mission shape does not masquerade as event source`);
    assert.match(short.note, /not from the current mission/i);
    assert.match(short.note, /context only and does not reshape/i);
    assert.doesNotMatch(short.note, /Generated from the current mission inputs/i);
    assert.equal(short.referenceEvent.version, OPERATING_POLICY_MODEL_VERSION);
    assert.match(short.referenceEvent.basis, /provisional|screening/i);
    assert.equal(short.referenceEvent.evidence.status, 'unverified');
  }
});

test('reference-event duration changes only through its explicit governed parameter', () => {
  for (const [id, defaultDurationS, longerDurationS] of [
    ['marine-spinning-reserve', 285, 570],
    ['marine-load-smoothing', 8, 16],
  ]) {
    const base = batteryProfileForPolicy(id);
    const longer = batteryProfileForPolicy(id, { parameters: { eventDurationS: longerDurationS } });
    assert.equal(base.sourceDurationS, defaultDurationS, `${id}: versioned default duration`);
    assert.equal(longer.sourceDurationS, longerDurationS, `${id}: declared duration`);
    assert.equal(longer.p.length, base.p.length * 2, `${id}: duration changes sample count`);
    assert.equal(longer.parameters.eventDurationS, longerDurationS, `${id}: duration is visible`);
    assert.equal(longer.sourceProfileId, base.sourceProfileId, `${id}: event source identity is stable`);
  }
  assert.throws(
    () => batteryProfileForPolicy('marine-spinning-reserve', { parameters: { eventDurationS: 31 } }),
    /must be a multiple of its 5 s sample period/i,
  );
  assert.throws(
    () => batteryProfileForPolicy('marine-load-smoothing', { parameters: { eventDurationS: 1.1 } }),
    /must be a multiple of its 0.25 s sample period/i,
  );
});

test('marine policies transform one demand into different battery duties', () => {
  const demand = POLICY_DEMANDS.find((d) => d.id === 'marine-vessel-duty');
  const before = [...demand.p];
  const full = batteryProfileForPolicy('marine-full-electric');
  const level = batteryProfileForPolicy('marine-load-levelling');
  const peak = batteryProfileForPolicy('marine-peak-shaving');
  ok(full.p.every((v) => v >= 0), 'full electric carries the positive vessel demand');
  ok(level.p.some((v) => v < 0) && level.p.some((v) => v > 0), 'load levelling charges and discharges');
  ok(peak.p.filter((v) => v > 0).length < full.p.filter((v) => v > 0).length,
    'peak shaving carries fewer demand samples than full electric');
  ok(demand.p.join('|') === before.join('|'), 'policy generation never mutates the source demand');
});

test('grid peak shaving and load shifting size different constraints', () => {
  const shave = batteryProfileForPolicy('grid-peak-shaving');
  const shift = batteryProfileForPolicy('grid-load-shifting');
  ok(shave.p.join('|') !== shift.p.join('|'), 'the policies do not collapse into one fixed profile');
  ok(shave.p.some((v) => v > 0) && shave.p.some((v) => v < 0), 'peak shaving includes discharge and recharge');
  ok(shift.p.some((v) => v > 0) && shift.p.some((v) => v < 0), 'load shifting includes discharge and charge windows');
  ok(/Peak power/.test(operatingPolicyById('grid-peak-shaving').sizingFocus), 'peak shaving states its kW focus');
  ok(/energy/i.test(operatingPolicyById('grid-load-shifting').sizingFocus), 'load shifting states its kWh focus');
});
