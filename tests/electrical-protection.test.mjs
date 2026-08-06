import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import {
  PRECHARGE_CONTACTOR_REFERENCES, SHUNT_REFERENCES,
  simulatePrecharge, prechargeStudy, selectPrechargeContactor,
  shuntStudy, fastProtectionStudy,
} from '../js/electrical-protection.js';
import { simulateExternalShort } from '../js/shortcircuit.js';
import { cellById } from '../js/cells.js';
import { designFromSpec } from '../js/api.js';

const CELL = cellById('samsung-inr21700-50e');

test('precharge follows the closed-form RC voltage, current and energy', () => {
  const r = simulatePrecharge({ supplyV: 400, capacitanceF: 0.006, resistanceOhm: 50, closeGapV: 400 * Math.exp(-5) });
  near(r.tauS, 0.3, 1e-12, 'tau = RC');
  near(r.timeToTargetS, 1.5, 1e-9, 'five time constants reach the target');
  near(r.peakCurrentA, 8, 1e-12, 'initial current = V/R');
  near(r.peakPowerW, 3200, 1e-9, 'initial power = V²/R');
  near(r.energyJ, 480, 0.1, 'resistor energy approaches 1/2 CV²');
  const end = r.trace.voltageV.at(-1);
  ok(end > 0.99 * 400, 'the link charges to more than 99%');
});

test('a downstream load can make the precharge target physically unreachable', () => {
  const r = simulatePrecharge({ supplyV: 400, capacitanceF: 0.006, resistanceOhm: 50, loadCurrentA: 1, closeGapV: 10 });
  near(r.steadyV, 350, 1e-9, 'load current creates the expected I*R drop');
  ok(r.reachesTarget === false && r.timeToTargetS === null, '390 V target is unreachable');
  const study = prechargeStudy({ supplyV: 400, capacitanceUF: 6000, targetTimeS: 1.5, resistanceOhm: 50, loadCurrentA: 1 });
  ok(study.status === 'fail', 'the integrated study fails');
  ok(study.diagnostics.some((d) => d.code === 'PRECHARGE_TARGET_UNREACHABLE'), 'with a stable diagnostic code');
  const overloaded = simulatePrecharge({
    supplyV: 400, capacitanceF: 0.006, resistanceOhm: 50,
    loadCurrentA: 10, closeGapV: 10, maxTimeS: 1,
  });
  near(overloaded.trace.voltageV.at(-1), 0, 1e-12, 'a load above source capability does not drive the capacitor negative');
  near(overloaded.energyJ, 3200, 1e-6, 'resistor energy is limited by the actual 8 A source current, not the requested 10 A load');
});

test('precharge hardware remains review-required until real ratings are entered', () => {
  const open = prechargeStudy({ supplyV: 400, capacitanceUF: 6000, targetTimeS: 1.5 });
  near(open.resistanceOhm, (1.5 / Math.log(400 / open.closeGapV)) / 0.006, 1e-9, 'resistor is derived from the target');
  ok(open.status === 'review', 'missing supplier ratings never produce green');
  for (const code of ['PRECHARGE_RESISTOR_VOLTAGE_UNPROVEN', 'PRECHARGE_RESISTOR_ENERGY_UNPROVEN',
    'PRECHARGE_CONTACTOR_MAKE_UNPROVEN', 'PRECHARGE_SUPPLIER_EVIDENCE_MISSING']) {
    ok(open.diagnostics.some((d) => d.code === code), `${code} is exposed`);
  }
  const rated = prechargeStudy({
    supplyV: 400, capacitanceUF: 6000, targetTimeS: 1.5, designMarginPct: 20,
    resistorVoltageRatingV: 1000, resistorPulseEnergyJ: 1000,
    resistorPulsePowerW: 5000, resistorContinuousPowerW: 100,
    contactorMakeA: 20, contactorMechanicalCycles: 100000,
    supplierEvidence: { part: 'R-50', revision: 'A', date: '2026-01-01' },
  });
  ok(rated.status === 'pass', `complete qualified inputs pass (${rated.diagnostics.map((d) => d.code).join(', ')})`);
});

test('the GIGAVAC P-series screen is voltage and current only', () => {
  ok(PRECHARGE_CONTACTOR_REFERENCES.length === 4, 'the documented normally-open P-series choices are present');
  const s = selectPrechargeContactor({ supplyV: 800, peakCurrentA: 35 });
  ok(s.selected?.part === 'P105', 'the smallest voltage/current candidate is selected deterministically');
  ok(s.screenedOnly && /make current/i.test(s.note), 'screen never claims final qualification');
  ok(selectPrechargeContactor({ supplyV: 1600, peakCurrentA: 1 }).selected === null, 'out-of-range voltage returns no candidate');
});

test('shunt voltage drop, loss and total error are explicit', () => {
  const r = shuntStudy({
    resistanceUOhm: 50, resistanceTolerancePct: 1,
    continuousRatingA: 500, peakRatingA: 1000, peakDurationRatingS: 10,
    conductorAreaMm2: 100, maxOperatingC: 150,
    gainErrorPct: 0.5, offsetErrorA: 0.02, noiseErrorA: 0.03,
    thermalResistanceKPerW: 2, thermalTimeConstantS: 100,
    continuousA: 200, peakA: 500, peakDurationS: 2,
    requiredAccuracyPct: 1,
    supplier: { part: 'CUSTOM-50' }, evidence: { revision: 'B', date: '2026-02-01' },
  });
  near(r.electrical.continuousDropMV, 10, 1e-9, 'V = IR');
  near(r.electrical.continuousLossW, 2, 1e-9, 'P = I²R');
  near(r.accuracy.atContinuous.absoluteA, 1.05, 1e-9, 'gain + offset + noise error');
  near(r.accuracy.atContinuous.percent, 0.525, 1e-9, 'current error percentage');
  ok(r.status === 'pass', `qualified custom shunt passes (${r.diagnostics.map((d) => d.code).join(', ')})`);
});

test('the archived SFP200 models reproduce published termination behavior', () => {
  ok(SHUNT_REFERENCES.every((x) => x.lifecycle === 'obsolete'), 'archived lifecycle is carried in data');
  const busbar = shuntStudy({ referenceId: 'sensata-sfp200-108', continuousA: 600, peakA: 1500, peakDurationS: 10 });
  near(busbar.electrical.continuousLossW, 6.48, 1e-9, '600 A through 18 micro-ohm shunt');
  ok(busbar.thermal.calculated, 'published anchors produce a thermal trace');
  ok(!busbar.diagnostics.some((d) => d.code === 'SHUNT_ACCURACY_UNPROVEN'),
    'accuracy terms supplied by the archived reference are recognized');
  ok(busbar.diagnostics.some((d) => d.code === 'SHUNT_REFERENCE_OBSOLETE'), 'obsolete part cannot silently pass');
  const cable = shuntStudy({ referenceId: 'sensata-sfp200-1-0-awg', continuousA: 500, peakA: 1000, peakDurationS: 5 });
  ok(cable.status === 'fail', '500 A fails the documented 380 A cable-termination case');
  ok(cable.diagnostics.some((d) => d.code === 'SHUNT_CONTINUOUS_OVERLOAD'), 'termination-limited overload is named');
});

test('missing custom shunt thermal and evidence data stay unproven', () => {
  const r = shuntStudy({ resistanceUOhm: 25, continuousA: 100, peakA: 200, peakDurationS: 1 });
  ok(r.status === 'review');
  for (const code of ['SHUNT_CURRENT_RATINGS_UNPROVEN', 'SHUNT_TERMINATION_UNPROVEN',
    'SHUNT_THERMAL_MODEL_UNPROVEN', 'SHUNT_SUPPLIER_EVIDENCE_MISSING']) {
    ok(r.diagnostics.some((d) => d.code === code), `${code} is exposed`);
  }
});

test('fast protection uses the actual R-L fault crossing and stays conditional', () => {
  const fault = simulateExternalShort({ cell: CELL, s: 96, p: 44, maxTimeS: 0.05, fuseI2t: null });
  const p = fastProtectionStudy({
    faultResult: fault, thresholdA: 1000, totalDelayMs: 5,
    shuntPeakRangeA: 1500, shuntErrorA: 10,
  });
  ok(p.crossingS != null && p.interruptS > p.crossingS, 'threshold crossing precedes interruption');
  near(p.interruptS - p.crossingS, 0.005, 1e-12, 'visible total delay is applied');
  ok(p.currentAtInterruptA > 0 && p.inductiveEnergyJ > 0, 'interruption current and stored magnetic energy are calculated');
  ok(p.status === 'review' && p.diagnostics.some((d) => d.code === 'FAST_PROTECTION_INTERRUPTER_UNPROVEN'),
    'unnamed interrupter cannot become approved');
  const clipped = fastProtectionStudy({ faultResult: fault, thresholdA: 1000, totalDelayMs: 5, shuntPeakRangeA: 900 });
  ok(clipped.status === 'fail' && clipped.diagnostics.some((d) => d.code === 'FAST_PROTECTION_SHUNT_CLIPS'),
    'a sensor that clips before threshold fails');
});

test('official Sensata evidence is registered in the repository', () => {
  const refs = readFileSync(new URL('../REFERENCES.md', import.meta.url), 'utf8');
  ok(/Sensata.*precharge/i.test(refs), 'precharge white paper is cited');
  ok(/SFP200MOD/i.test(refs), 'shunt datasheet is cited');
  ok(/PyroFuse/i.test(refs), 'fast protection paper is cited');
});

test('the headless electrical result carries all three coordinated studies', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  ok(d.apiVersion === '1.2', 'the API contract version records the new result');
  ok(d.electricalProtection.precharge?.nominal.trace.tS.length > 20, 'precharge time simulation is present');
  ok(d.electricalProtection.shunt?.trace.tempC.length > 20, 'shunt thermal duty simulation is present');
  ok(d.electricalProtection.fast?.crossingS != null, 'fault threshold is coordinated with the R-L trace');
  ok(d.findings.some((f) => f.id === 'SHUNT_RESISTANCE_PROVISIONAL'),
    'an unconfigured design does not silently select an archived product');
  const archived = designFromSpec({
    application: 'ev', energyWh: 60000,
    electricalProtection: { shunt: { referenceId: 'sensata-sfp200-108' } },
  });
  ok(archived.findings.some((f) => f.id === 'SHUNT_REFERENCE_OBSOLETE'),
    'explicitly selecting the archived reference visibly blocks it from release');
  const lv = designFromSpec({ application: 'wearable' });
  ok(lv.electricalProtection.precharge === null && lv.electricalProtection.shunt === null,
    'the high-voltage package is not forced onto low-voltage products');
});

test('the browser exposes the calculators, supplier evidence and simulation charts', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['prechargeCalcBody', 'prechargeCalcCanvas', 'shuntCalcBody', 'shuntCalcCanvas', 'fastProtectionBody']) {
    ok(html.includes(`id="${id}"`), `${id} is visible in the electrical analysis`);
  }
  ok(/archived/i.test(html) && /supplier evidence/i.test(html),
    'the browser distinguishes teaching references from current supplier evidence');
});
