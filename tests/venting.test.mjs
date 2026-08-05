import test from 'node:test';
import assert from 'node:assert/strict';
import { near } from './helpers.mjs';
import { compressibleMassFlux, sizeEmergencyVent } from '../js/venting.js';

const SCENARIO = {
  ventingCells: 4,
  gasVolumeLowLPerCell: 8,
  gasVolumeHighLPerCell: 16,
  releaseDurationLowS: 2,
  releaseDurationHighS: 4,
  gasDataBasis: 'Module abuse test TR-17 at 100% SOC',
  allowableGaugePressureKPa: 10,
  ambientPressureKPa: 101.325,
  ventGasTemperatureC: 400,
  referenceTemperatureC: 20,
  referencePressureKPa: 101.325,
  dischargeCoefficient: 0.7,
  specificGasConstantJPerKgK: 287,
  gamma: 1.3,
};

test('compressible mass flux chooses subcritical and choked regimes from pressure ratio', () => {
  const common = {
    downstreamPa: 100_000, temperatureK: 600, dischargeCoefficient: 0.7,
    specificGasConstantJPerKgK: 287, gamma: 1.3,
  };
  assert.equal(compressibleMassFlux({ upstreamPa: 110_000, ...common }).regime, 'subcritical');
  assert.equal(compressibleMassFlux({ upstreamPa: 250_000, ...common }).regime, 'choked');
});

test('vent area follows ideal-gas mass, release time and compressible opening flow', () => {
  const result = sizeEmergencyVent(SCENARIO);
  assert.equal(result.status, 'conditional');
  assert.ok(result.high.areaM2 > result.low.areaM2);
  near(result.high.gasMassKg, 2 * result.low.gasMassKg, 1e-12, 'twice the gas volume is twice the gas mass');
  near(result.high.massFlowKgPerS, 4 * result.low.massFlowKgPerS, 1e-12,
    'twice the gas in half the time is four times the mass flow');
  near(result.high.areaM2, 4 * result.low.areaM2, 1e-12,
    'identical pressure/temperature makes free area proportional to mass flow');
  near(result.high.equivalentDiameterMm / result.low.equivalentDiameterMm, 2, 1e-12,
    'diameter follows the square root of area');
  assert.match(result.equations.subcriticalFlux, /γ/);
  assert.match(result.limitations.join(' '), /not NFPA 68/i);
  assert.ok(result.requiredTests.length >= 4);
});

test('vent sizing sensitivities move in the physically conservative direction', () => {
  const base = sizeEmergencyVent(SCENARIO);
  const moreCells = sizeEmergencyVent({ ...SCENARIO, ventingCells: 8 });
  const morePressure = sizeEmergencyVent({ ...SCENARIO, allowableGaugePressureKPa: 30 });
  assert.ok(moreCells.high.areaM2 > base.high.areaM2, 'more venting cells need more free area');
  assert.ok(morePressure.high.areaM2 < base.high.areaM2, 'more allowed pressure raises opening mass flux');
});

test('gas evidence is mandatory and invalid ranges stop before calculation', () => {
  assert.throws(() => sizeEmergencyVent({ ...SCENARIO, gasDataBasis: '' }), /basis/i);
  assert.throws(() => sizeEmergencyVent({
    ...SCENARIO, gasVolumeLowLPerCell: 20, gasVolumeHighLPerCell: 10,
  }), /high gas volume/i);
  assert.throws(() => sizeEmergencyVent({ ...SCENARIO, dischargeCoefficient: 1.2 }), /cannot exceed one/i);
});
