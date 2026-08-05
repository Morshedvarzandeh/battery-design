// Operating policies — external demand is kept separate from the battery
// trace produced for sizing.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import {
  POLICY_DEMANDS, OPERATING_POLICIES, operatingPolicyById, batteryProfileForPolicy,
} from '../js/operating-policy.js';

test('every policy produces a normalized, traceable battery profile', () => {
  for (const policy of OPERATING_POLICIES) {
    const out = batteryProfileForPolicy(policy.id);
    ok(out?.kind === 'policy-output', `${policy.id}: typed as a policy output`);
    ok(out.policyId === policy.id && out.sourceProfileId === policy.demandId,
      `${policy.id}: records policy and source demand`);
    ok(out.p.length >= 4 && Math.max(...out.p.map(Math.abs)) <= 1.0000001,
      `${policy.id}: normalized sizing profile`);
  }
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
