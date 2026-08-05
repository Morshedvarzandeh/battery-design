import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { roundTripPlan } from '../js/efficiency.js';
import { marineDuty } from '../js/marine.js';
import { airDensity, flightDuty } from '../js/flight.js';
import { batteryProfileForPolicy } from '../js/operating-policy.js';
import { buildRoute, routeToTrace } from '../js/route.js';
import { traceForApp } from '../js/vehicle.js';

test('RTE counts every conversion stage and auxiliaries', () => {
  const idealAuxFree = roundTripPlan({
    application: 'solar-ess', deliveredWh: 10000,
    chargeEff: 0.97, batteryEff: 0.98, dischargeEff: 0.97,
    auxiliaryW: 0,
  });
  near(idealAuxFree.rte, 0.97 * 0.98 * 0.97, 1e-12, 'the conversion chain multiplies');
  const real = roundTripPlan({ application: 'solar-ess', deliveredWh: 10000 });
  ok(real.rte < real.conversionRte, 'active auxiliaries reduce system RTE');
  ok(real.inputWh > real.deliveredWh && real.lossWh > 0, 'input and loss energy are explicit');
  const worse = roundTripPlan({ application: 'solar-ess', deliveredWh: 10000, dischargeEff: 0.8 });
  ok(worse.inputWh > real.inputWh && worse.rte < real.rte, 'a worse inverter costs energy monotonically');
});

test('vessel payload, current, wind and sea state all move the demand in the hard direction', () => {
  const calm = marineDuty({ payloadKg: 0, headCurrentKn: 0, headwindKn: 0, seaState: 'calm' });
  const loaded = marineDuty({ payloadKg: 1200, headCurrentKn: 0, headwindKn: 0, seaState: 'calm' });
  const weather = marineDuty({ payloadKg: 1200, headCurrentKn: 1.5, headwindKn: 20, seaState: 'rough' });
  ok(loaded.continuousW > calm.continuousW, 'carrying cargo increases propulsion demand');
  ok(weather.continuousW > loaded.continuousW * 2, 'adverse current, wind and waves matter strongly');
  ok(weather.energyWh > loaded.energyWh, 'the harder voyage also needs more energy');
  ok(weather.profile.kind === 'physics-output' && weather.profile.p.length > 100, 'a real time trace is produced');
});

test('marine operating policy transforms the current voyage rather than a hidden fixed trace', () => {
  const voyage = marineDuty({ payloadKg: 900, seaState: 'moderate' });
  const full = batteryProfileForPolicy('marine-full-electric', { demandProfile: voyage.profile });
  const peak = batteryProfileForPolicy('marine-peak-shaving', { demandProfile: voyage.profile });
  ok(full.sourceProfileId === 'marine-physics', 'the source mission remains traceable');
  ok(full.p.length === voyage.profile.p.length && peak.p.length === voyage.profile.p.length,
    'policy output retains the mission time base');
  ok(peak.p.some((v) => v === 0), 'peak shaving carries only the selected part of the demand');
});

test('drone payload, thin air and wind raise flight power', () => {
  ok(airDensity({ altitudeM: 2500, temperatureC: 30 }) < airDensity({ altitudeM: 0, temperatureC: 15 }),
    'hot high-altitude air is thinner');
  const base = flightDuty({ payloadKg: 0.5, headwindMps: 0, altitudeM: 0, temperatureC: 15 });
  const loaded = flightDuty({ payloadKg: 3, headwindMps: 0, altitudeM: 0, temperatureC: 15 });
  const adverse = flightDuty({ payloadKg: 3, headwindMps: 12, altitudeM: 2500, temperatureC: 30 });
  ok(loaded.metrics.hoverW > base.metrics.hoverW, 'payload increases hover power');
  ok(adverse.continuousW > loaded.continuousW, 'wind and thin air increase mission power');
  ok(adverse.energyWh > loaded.energyWh, 'and mission energy follows');
});

test('an untimed bus route keeps the standard stop-go behaviour', () => {
  const route = buildRoute({ points: [
    { lat: 50.85, lon: 4.35 }, { lat: 50.86, lon: 4.37 }, { lat: 50.87, lon: 4.39 },
  ] });
  const trace = routeToTrace(route, { dtS: 5, speedTrace: traceForApp('ebus') });
  ok(trace.speedBasis === 'city-bus' || trace.speedBasis, 'the speed basis is reported');
  ok(trace.v.some((v) => v === 0) && trace.v.some((v) => v > 20), 'stops and moving sections both survive');
});
