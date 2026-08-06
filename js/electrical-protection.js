// electrical-protection.js — the high-voltage startup and measurement path.
//
// This module turns the electrical architecture's one-line precharge estimate
// into three reviewable engineering studies:
//
//   1. RC precharge sizing and a time-domain startup simulation,
//   2. current-shunt electrical, accuracy and thermal selection,
//   3. shunt-triggered fast-fault protection coordination.
//
// The equations and product-family reference data are taken from official
// Sensata documents. Product data is deliberately separated from design
// inputs: an archived Sensata part can reproduce a published example, but it
// cannot become approved hardware merely because the arithmetic passes.
//
// Pure math + data. No DOM.

export const SENSATA_ELECTRICAL_SOURCES = Object.freeze({
  precharge: {
    title: 'How to Design a Precharge Circuit for Hybrid and Electric Vehicle Applications',
    revision: 'WP-00012, 12 November 2020',
    url: 'https://www.sensata.com/sites/default/files/a/sensata-how-to-design-precharge-circuits-evs-whitepaper.pdf',
  },
  contactors: {
    title: 'Sensata | GIGAVAC Contactors Selection Guide',
    revision: 'accessed 2026-08-06',
    url: 'https://www.sensata.com/sites/default/files/a/sensata-gigavac-contactors-selection-guide.pdf',
  },
  shunt: {
    title: 'SFP200MOD Precision Current Measurement Module Datasheet',
    revision: 'Preliminary Rev 1.7',
    url: 'https://www.sensata.com/sites/default/files/a/sensata-sfp200-current-and-voltage-module-datasheet.pdf',
  },
  shuntLifecycle: {
    title: 'Sensata SFP200 Current Sensor (Obsolete)',
    revision: 'product status accessed 2026-08-06',
    url: 'https://www.sensata.com/products/current-voltage-sensing/sfp200',
  },
  pyrofuse: {
    title: 'Maximizing Circuit Protection for Enhanced EV Safety',
    revision: '2025',
    url: 'https://www.sensata.com/sites/default/files/a/sensata-el-ev-pyrofuse-whitepaper.pdf',
  },
});

// The selection guide calls out the P series for precharge duty. These values
// are catalogue-screening values only: Sensata's precharge paper separately
// requires the peak make-current capability and switching life to be checked
// in the actual part datasheet.
export const PRECHARGE_CONTACTOR_REFERENCES = Object.freeze([
  { id: 'p105', part: 'P105', voltageV: 1200, continuousA: 50, contact: 'SPST-NO' },
  { id: 'p115', part: 'P115', voltageV: 1500, continuousA: 50, contact: 'SPST-NO' },
  { id: 'p125', part: 'P125', voltageV: 1200, continuousA: 30, contact: 'SPST-NO' },
  { id: 'p195', part: 'P195', voltageV: 1500, continuousA: 80, contact: 'SPST-NO' },
]);

const sfpRth108 = 100 / (600 * 600 * 18e-6);
const sfpTau108 = -20 / Math.log(1 - 60 / (3000 * 3000 * 18e-6 * sfpRth108));
const sfpRth53 = 100 / (380 * 380 * 18e-6);
const sfpTau53 = -8 / Math.log(1 - 80 / (3000 * 3000 * 18e-6 * sfpRth53));

// This archived reference reproduces two published termination cases. Sensata
// now labels SFP200 and SFP203 obsolete, so lifecycle='obsolete' is a safety
// invariant, not presentation text that a caller can forget to render.
export const SHUNT_REFERENCES = Object.freeze([
  {
    id: 'sensata-sfp200-108',
    manufacturer: 'Sensata / Sendyne', part: 'SFP200MOD', lifecycle: 'obsolete',
    evidence: SENSATA_ELECTRICAL_SOURCES.shunt,
    resistanceUOhm: 18, resistanceTolerancePct: 11.12,
    continuousA: 600, peakA: 1500, peakDurationS: 70,
    conductorAreaMm2: 108, maxOperatingC: 125,
    gainErrorPct: 1, offsetErrorA: 0.05, noiseErrorA: 0.05,
    thermalResistanceKPerW: sfpRth108, thermalTimeConstantS: sfpTau108,
    note: 'Published 108 mm² busbar case: 600 A continuous with less than 100 K rise; the thermal constants are a first-order fit to that limit and the published 3000 A / 20 s / 60 K anchor.',
  },
  {
    id: 'sensata-sfp200-1-0-awg',
    manufacturer: 'Sensata / Sendyne', part: 'SFP200MOD', lifecycle: 'obsolete',
    evidence: SENSATA_ELECTRICAL_SOURCES.shunt,
    resistanceUOhm: 18, resistanceTolerancePct: 11.12,
    continuousA: 380, peakA: 1500, peakDurationS: 70,
    conductorAreaMm2: 53.5, maxOperatingC: 125,
    gainErrorPct: 1, offsetErrorA: 0.05, noiseErrorA: 0.05,
    thermalResistanceKPerW: sfpRth53, thermalTimeConstantS: sfpTau53,
    note: 'Published 1/0 AWG cable case: only 380 A continuous with less than 100 K rise; the thermal constants are a first-order fit to that limit and the published 3000 A / 8 s / 80 K anchor.',
  },
]);

export const shuntReferenceById = (id) => SHUNT_REFERENCES.find((x) => x.id === id) || null;
export const prechargeContactorById = (id) => PRECHARGE_CONTACTOR_REFERENCES.find((x) => x.id === id) || null;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const positive = (v) => finite(v) && Number(v) > 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function diagnostic(code, severity, title, detail, action, source = null) {
  return { code, severity, title, detail, action, source };
}

const statusFrom = (diagnostics) => diagnostics.some((d) => d.severity === 'fail')
  ? 'fail'
  : diagnostics.some((d) => d.severity === 'review') ? 'review' : 'pass';

function linspace(end, count = 161) {
  if (!(end > 0)) return [0];
  return Array.from({ length: count }, (_, i) => (end * i) / (count - 1));
}

/**
 * Closed-form RC precharge with an optional constant downstream load.
 *
 * dVc/dt = (((Vs - Vc) / R) - Iload) / C
 * Vc(t) = Vss + (V0 - Vss)e^(-t/RC), Vss = Vs - Iload R
 */
export function simulatePrecharge({
  supplyV, capacitanceF, resistanceOhm, initialV = 0, loadCurrentA = 0,
  closeGapV = null, targetRatio = 0.993, maxTimeS = null, samples = 161,
}) {
  if (!positive(supplyV) || !positive(capacitanceF) || !positive(resistanceOhm)) {
    throw new Error('simulatePrecharge requires positive supplyV, capacitanceF and resistanceOhm.');
  }
  const v = Number(supplyV), c = Number(capacitanceF), r = Number(resistanceOhm);
  const v0 = clamp(Number(initialV) || 0, 0, v);
  const iLoad = Math.max(0, Number(loadCurrentA) || 0);
  const gap = positive(closeGapV) ? Number(closeGapV) : v * (1 - clamp(Number(targetRatio) || 0.993, 0.5, 0.9999));
  const targetV = v - gap;
  const tauS = r * c;
  const rawSteadyV = v - iLoad * r;
  const steadyV = Math.max(0, rawSteadyV);
  let timeToTargetS = null;
  if (targetV <= v0) timeToTargetS = 0;
  else if (targetV < steadyV && steadyV > v0) {
    timeToTargetS = -tauS * Math.log((targetV - steadyV) / (v0 - steadyV));
  }
  const durationS = positive(maxTimeS)
    ? Number(maxTimeS)
    : Math.max(5 * tauS, timeToTargetS != null ? timeToTargetS * 1.15 : 5 * tauS);
  const t = linspace(durationS, Math.max(21, Math.round(samples)));
  const rawVoltageAt = (time) => rawSteadyV + (v0 - rawSteadyV) * Math.exp(-time / tauS);
  const voltageV = t.map((time) => Math.max(0, rawVoltageAt(time)));
  const currentA = voltageV.map((vc) => Math.max(0, (v - vc) / r));
  const capacitorCurrentA = currentA.map((i, index) => voltageV[index] > 0 ? i - iLoad : 0);
  const powerW = currentA.map((i) => i * i * r);
  // Exact integral of R·(Iload + A·e^(-t/tau))². Using the analytic value
  // keeps the energy result independent of how many points the chart draws.
  const a = (rawSteadyV - v0) / r;
  const energyBeforeClamp = (endS) => r * (
    iLoad * iLoad * endS
    + 2 * iLoad * a * tauS * (1 - Math.exp(-endS / tauS))
    + a * a * tauS * 0.5 * (1 - Math.exp(-2 * endS / tauS))
  );
  let clampAtS = Infinity;
  if (rawSteadyV < 0) {
    const ratio = -rawSteadyV / (v0 - rawSteadyV);
    clampAtS = ratio >= 1 ? 0 : -tauS * Math.log(ratio);
  }
  const activeS = Math.min(durationS, clampAtS);
  const energyJ = energyBeforeClamp(activeS)
    + Math.max(0, durationS - activeS) * (v * v / r);
  return {
    tauS, targetV, closeGapV: gap, steadyV, reachesTarget: timeToTargetS != null,
    timeToTargetS, durationS, peakCurrentA: currentA[0], peakPowerW: powerW[0], energyJ,
    trace: { tS: t, voltageV, currentA, capacitorCurrentA, powerW },
  };
}

function prechargeCorner({ supplyV, capacitanceF, resistanceOhm, tolerancePct, loadCurrentA, closeGapV, durationS }) {
  const tol = Math.max(0, Number(tolerancePct) || 0) / 100;
  const values = [
    ['low resistance', resistanceOhm * (1 - tol)],
    ['nominal', resistanceOhm],
    ['high resistance', resistanceOhm * (1 + tol)],
  ].filter(([, r]) => r > 0);
  return values.map(([label, r]) => ({
    label, resistanceOhm: r,
    ...simulatePrecharge({ supplyV, capacitanceF, resistanceOhm: r, loadCurrentA, closeGapV, maxTimeS: durationS }),
  }));
}

export function selectPrechargeContactor({ supplyV, peakCurrentA }) {
  const candidates = PRECHARGE_CONTACTOR_REFERENCES
    .filter((x) => x.voltageV >= supplyV && x.continuousA >= peakCurrentA)
    .sort((a, b) => a.voltageV - b.voltageV || a.continuousA - b.continuousA);
  return {
    candidates,
    selected: candidates[0] || null,
    screenedOnly: true,
    note: 'Catalogue voltage and continuous-current screening only. Peak make current, pulse duration, coil drive, switching life and environmental rating still require the actual part datasheet.',
  };
}

/** Full precharge calculator, hardware checks and tolerance-corner traces. */
export function prechargeStudy({
  supplyV, capacitanceUF, targetTimeS = 0.5, closeGapV = null,
  resistanceOhm = null, resistanceTolerancePct = 5, loadCurrentA = 0,
  startsPerHour = 4, designMarginPct = 20,
  resistorVoltageRatingV = null, resistorPulseEnergyJ = null,
  resistorPulsePowerW = null, resistorContinuousPowerW = null,
  contactorId = 'auto', contactorMakeA = null, contactorMechanicalCycles = null,
  supplierEvidence = null,
}) {
  if (!positive(supplyV) || !positive(capacitanceUF) || !positive(targetTimeS)) {
    throw new Error('prechargeStudy requires positive supplyV, capacitanceUF and targetTimeS.');
  }
  const v = Number(supplyV), c = Number(capacitanceUF) * 1e-6;
  const gap = positive(closeGapV) ? Number(closeGapV) : Math.max(1, v * 0.0067);
  const autoR = (Number(targetTimeS) / Math.log(v / gap)) / c;
  const r = positive(resistanceOhm) ? Number(resistanceOhm) : autoR;
  const nominal = simulatePrecharge({
    supplyV: v, capacitanceF: c, resistanceOhm: r,
    loadCurrentA, closeGapV: gap,
    maxTimeS: Math.max(Number(targetTimeS) * 1.25, 5 * r * c),
  });
  const corners = prechargeCorner({
    supplyV: v, capacitanceF: c, resistanceOhm: r,
    tolerancePct: resistanceTolerancePct, loadCurrentA, closeGapV: gap,
    durationS: nominal.durationS,
  });
  const lowR = corners.find((x) => x.label === 'low resistance') || nominal;
  const highR = corners.find((x) => x.label === 'high resistance') || nominal;
  const worstEnergyJ = Math.max(...corners.map((x) => x.energyJ));
  const worstPeakPowerW = Math.max(...corners.map((x) => x.peakPowerW));
  const starts = Math.max(0, Number(startsPerHour) || 0);
  const equivalentContinuousW = worstEnergyJ * starts / 3600;
  const margin = 1 + Math.max(0, Number(designMarginPct) || 0) / 100;
  const required = {
    voltageV: v * margin,
    pulseEnergyJ: worstEnergyJ * margin,
    pulsePowerW: worstPeakPowerW * margin,
    equivalentContinuousW: equivalentContinuousW * margin,
    contactorMakeA: lowR.peakCurrentA * margin,
  };
  const screening = selectPrechargeContactor({ supplyV: v, peakCurrentA: lowR.peakCurrentA });
  const chosen = contactorId && contactorId !== 'auto'
    ? prechargeContactorById(contactorId)
    : screening.selected;
  const diagnostics = [];

  if (!nominal.reachesTarget || !highR.reachesTarget) {
    diagnostics.push(diagnostic(
      'PRECHARGE_TARGET_UNREACHABLE', 'fail', 'The DC link cannot reach the closing threshold',
      `The stated ${Number(loadCurrentA) || 0} A downstream load leaves a steady DC-link voltage of ${nominal.steadyV.toFixed(1)} V; the main contactor target is ${nominal.targetV.toFixed(1)} V.`,
      'Turn downstream loads off during precharge, reduce leakage/soft-short current, or redesign the precharge path.',
      SENSATA_ELECTRICAL_SOURCES.precharge,
    ));
  }
  const times = corners.filter((x) => x.timeToTargetS != null).map((x) => x.timeToTargetS);
  if (times.length && (Math.min(...times) < targetTimeS * 0.8 || Math.max(...times) > targetTimeS * 1.2)) {
    diagnostics.push(diagnostic(
      'PRECHARGE_TOLERANCE_WINDOW', 'review', 'Resistance tolerance materially moves the closing time',
      `The tolerance corners reach the threshold in ${Math.min(...times).toFixed(3)}–${Math.max(...times).toFixed(3)} s against the ${Number(targetTimeS).toFixed(3)} s target.`,
      'Program upper and lower voltage-versus-time envelopes from the validated corners; do not close the main contactor from a timer alone.',
      SENSATA_ELECTRICAL_SOURCES.precharge,
    ));
  }

  const checks = [
    ['PRECHARGE_RESISTOR_VOLTAGE', resistorVoltageRatingV, required.voltageV, 'voltage rating', 'V'],
    ['PRECHARGE_RESISTOR_ENERGY', resistorPulseEnergyJ, required.pulseEnergyJ, 'pulse-energy rating', 'J'],
    ['PRECHARGE_RESISTOR_PEAK_POWER', resistorPulsePowerW, required.pulsePowerW, 'pulse-power rating', 'W'],
    ['PRECHARGE_RESISTOR_DUTY', resistorContinuousPowerW, required.equivalentContinuousW, 'continuous/repetition rating', 'W'],
  ];
  for (const [code, available, needed, label, unit] of checks) {
    if (!positive(available)) {
      diagnostics.push(diagnostic(
        `${code}_UNPROVEN`, 'review', `Resistor ${label} is not evidenced`,
        `The calculated requirement with the visible ${designMarginPct}% margin is ${needed.toFixed(2)} ${unit}, but no supplier rating was entered.`,
        'Enter the current datasheet rating and evidence revision; then validate the complete power curve with the resistor supplier.',
        SENSATA_ELECTRICAL_SOURCES.precharge,
      ));
    } else if (Number(available) < needed) {
      diagnostics.push(diagnostic(
        `${code}_TOO_LOW`, 'fail', `Resistor ${label} is too low`,
        `${Number(available).toFixed(2)} ${unit} available versus ${needed.toFixed(2)} ${unit} required with margin.`,
        'Select a resistor with a higher documented rating or change the precharge time/resistance and rerun every corner.',
        SENSATA_ELECTRICAL_SOURCES.precharge,
      ));
    }
  }

  if (!chosen) {
    diagnostics.push(diagnostic(
      'PRECHARGE_CONTACTOR_NO_CATALOGUE_MATCH', 'fail', 'No listed P-series contactor passes the basic screen',
      `${v.toFixed(0)} V and ${lowR.peakCurrentA.toFixed(1)} A initial current exceed the voltage/current screen represented here.`,
      'Use a documented alternative and enter its actual make-current and life data.',
      SENSATA_ELECTRICAL_SOURCES.contactors,
    ));
  }
  if (!positive(contactorMakeA)) {
    diagnostics.push(diagnostic(
      'PRECHARGE_CONTACTOR_MAKE_UNPROVEN', 'review', 'Contactor make-current capability is not evidenced',
      `The low-resistance corner requires ${required.contactorMakeA.toFixed(1)} A with margin. Catalogue continuous current is not a substitute for make-current capability.`,
      'Enter the selected part datasheet make-current rating for the applicable voltage and pulse duration.',
      SENSATA_ELECTRICAL_SOURCES.precharge,
    ));
  } else if (Number(contactorMakeA) < required.contactorMakeA) {
    diagnostics.push(diagnostic(
      'PRECHARGE_CONTACTOR_MAKE_TOO_LOW', 'fail', 'Contactor make-current capability is too low',
      `${Number(contactorMakeA).toFixed(1)} A available versus ${required.contactorMakeA.toFixed(1)} A required with margin.`,
      'Choose a higher-rated contactor or increase resistance and revalidate the startup time.',
      SENSATA_ELECTRICAL_SOURCES.precharge,
    ));
  }
  if (!positive(contactorMechanicalCycles)) {
    diagnostics.push(diagnostic(
      'PRECHARGE_CONTACTOR_LIFE_UNPROVEN', 'review', 'Contactor switching life is not evidenced',
      'Precharge makes under load on every startup, so catalogue voltage/current alone does not establish lifetime.',
      'Enter switching-life evidence at the actual make current, voltage, coil drive and environment.',
      SENSATA_ELECTRICAL_SOURCES.precharge,
    ));
  }
  if (!supplierEvidence?.part || !supplierEvidence?.revision || !supplierEvidence?.date) {
    diagnostics.push(diagnostic(
      'PRECHARGE_SUPPLIER_EVIDENCE_MISSING', 'review', 'Hardware evidence is incomplete',
      'A supplier part number, document revision and evidence date are required before this calculator can support release.',
      'Attach the selected resistor and contactor datasheets with stable part/revision identifiers.',
    ));
  }

  return {
    status: statusFrom(diagnostics), source: SENSATA_ELECTRICAL_SOURCES.precharge,
    resistanceOhm: r, resistanceWasCalculated: !positive(resistanceOhm),
    capacitanceF: c, targetTimeS: Number(targetTimeS), closeGapV: gap,
    nominal, corners, required, selectedContactor: chosen, contactorScreening: screening,
    startsPerHour: starts, diagnostics,
    sequence: [
      'Verify both main contactors and downstream voltage feedback.',
      'Close the main negative contactor.',
      'Close the precharge contactor.',
      'Require the measured DC-link voltage to stay inside the validated upper/lower envelope.',
      'Close the main positive contactor only after the voltage threshold is reached.',
      'Open the precharge contactor so a later main-contactor opening cannot overload the resistor.',
    ],
  };
}

function currentSegmentsOrDefault(continuousA, peakA, peakDurationS) {
  const cont = Math.max(0, Number(continuousA) || 0);
  const peak = Math.max(cont, Number(peakA) || cont);
  const pulse = Math.max(0.001, Number(peakDurationS) || 5);
  return [
    { label: 'continuous before pulse', currentA: cont, durationS: Math.min(60, Math.max(10, pulse)) },
    { label: 'peak pulse', currentA: peak, durationS: pulse },
    { label: 'continuous after pulse', currentA: cont, durationS: Math.min(120, Math.max(20, pulse * 2)) },
  ];
}

/** Shunt electrical, accuracy and first-order thermal simulation. */
export function shuntStudy({
  referenceId = null, supplier = null,
  resistanceUOhm = null, resistanceTolerancePct = null,
  continuousRatingA = null, peakRatingA = null, peakDurationRatingS = null,
  conductorAreaMm2 = null, maxOperatingC = null,
  gainErrorPct = null, offsetErrorA = null, noiseErrorA = null,
  thermalResistanceKPerW = null, thermalTimeConstantS = null,
  ambientC = 25, continuousA, peakA, peakDurationS = 5, currentSegments = null,
  tempcoPpmPerK = 0, requiredAccuracyPct = 1,
  evidence = null,
}) {
  const ref = shuntReferenceById(referenceId);
  const pick = (value, key) => finite(value) ? Number(value) : (ref?.[key] ?? null);
  const rU = pick(resistanceUOhm, 'resistanceUOhm');
  if (!positive(rU)) throw new Error('shuntStudy requires a positive shunt resistance.');
  const r0 = rU * 1e-6;
  const tolPct = Math.max(0, pick(resistanceTolerancePct, 'resistanceTolerancePct') || 0);
  const contRating = pick(continuousRatingA, 'continuousA');
  const peakRating = pick(peakRatingA, 'peakA');
  const peakRatingS = pick(peakDurationRatingS, 'peakDurationS');
  const area = pick(conductorAreaMm2, 'conductorAreaMm2');
  const maxC = pick(maxOperatingC, 'maxOperatingC');
  const gainPct = Math.max(0, pick(gainErrorPct, 'gainErrorPct') || 0);
  const offsetA = Math.max(0, pick(offsetErrorA, 'offsetErrorA') || 0);
  const noiseA = Math.max(0, pick(noiseErrorA, 'noiseErrorA') || 0);
  const rth = pick(thermalResistanceKPerW, 'thermalResistanceKPerW');
  const tau = pick(thermalTimeConstantS, 'thermalTimeConstantS');
  const tempco = (Number(tempcoPpmPerK) || 0) * 1e-6;
  const segments = currentSegments?.length
    ? currentSegments.map((s) => ({ ...s, currentA: Number(s.currentA) || 0, durationS: Math.max(0, Number(s.durationS) || 0) }))
    : currentSegmentsOrDefault(continuousA, peakA, peakDurationS);
  const trace = { tS: [0], currentA: [segments[0]?.currentA || 0], voltageDropMV: [0], powerW: [0], tempC: [Number(ambientC)] };
  let time = 0, tempC = Number(ambientC), energyJ = 0, maxTempCSeen = tempC;
  let peakDropMV = 0, peakPowerW = 0;
  for (const segment of segments) {
    const count = Math.max(3, Math.min(120, Math.ceil(segment.durationS / Math.max(0.02, segment.durationS / 40))));
    const dt = segment.durationS / count;
    for (let k = 0; k < count; k++) {
      const r = r0 * (1 + tempco * (tempC - 25));
      const current = segment.currentA;
      const power = current * current * r;
      if (positive(rth) && positive(tau)) {
        const equilibriumC = Number(ambientC) + power * rth;
        tempC = equilibriumC + (tempC - equilibriumC) * Math.exp(-dt / tau);
      }
      time += dt; energyJ += power * dt;
      const dropMV = current * r * 1000;
      peakDropMV = Math.max(peakDropMV, Math.abs(dropMV));
      peakPowerW = Math.max(peakPowerW, power);
      maxTempCSeen = Math.max(maxTempCSeen, tempC);
      trace.tS.push(time); trace.currentA.push(current); trace.voltageDropMV.push(dropMV);
      trace.powerW.push(power); trace.tempC.push(tempC);
    }
  }
  const cont = Math.max(0, Number(continuousA) || 0);
  const peak = Math.max(cont, Number(peakA) || cont);
  const errorAt = (currentA) => ({
    absoluteA: Math.abs(currentA) * gainPct / 100 + offsetA + noiseA,
    percent: currentA !== 0 ? (Math.abs(currentA) * gainPct / 100 + offsetA + noiseA) / Math.abs(currentA) * 100 : Infinity,
  });
  const diagnostics = [];
  if (!positive(contRating) || !positive(peakRating) || !positive(peakRatingS)) {
    diagnostics.push(diagnostic(
      'SHUNT_CURRENT_RATINGS_UNPROVEN', 'review', 'Shunt current ratings are incomplete',
      'Continuous current, peak current and peak duration all need supplier evidence.',
      'Enter the current datasheet ratings for the actual termination and cooling arrangement.',
      ref?.evidence || null,
    ));
  } else {
    if (cont > contRating) diagnostics.push(diagnostic(
      'SHUNT_CONTINUOUS_OVERLOAD', 'fail', 'Continuous current exceeds the shunt rating',
      `${cont.toFixed(1)} A required versus ${contRating.toFixed(1)} A rated.`,
      'Select a higher-current shunt or change the architecture; do not infer extra rating from a larger measurement range.',
      ref?.evidence || null,
    ));
    if (peak > peakRating || Number(peakDurationS) > peakRatingS) diagnostics.push(diagnostic(
      'SHUNT_PEAK_OVERLOAD', 'fail', 'Peak current pulse is outside the shunt rating',
      `${peak.toFixed(1)} A for ${Number(peakDurationS).toFixed(2)} s required versus ${peakRating.toFixed(1)} A for ${peakRatingS.toFixed(2)} s rated.`,
      'Use the supplier transient curve for the actual busbar/cable termination and select a qualified part.',
      ref?.evidence || null,
    ));
  }
  if (!positive(area)) diagnostics.push(diagnostic(
    'SHUNT_TERMINATION_UNPROVEN', 'review', 'Termination cross-section is not evidenced',
    'The conductor is part of the shunt thermal system; the same sensing element has different continuous ratings with different terminations.',
    'Enter the actual conductor cross-section and validate it against the supplier thermal case.',
    ref?.evidence || null,
  ));
  if (!positive(rth) || !positive(tau)) diagnostics.push(diagnostic(
    'SHUNT_THERMAL_MODEL_UNPROVEN', 'review', 'Transient shunt temperature is not calculated',
    'Thermal resistance and time constant, or an equivalent supplier pulse curve, are missing.',
    'Fit the thermal model to supplier curves or measured current/temperature data for the installed conductor and cooling.',
    ref?.evidence || null,
  ));
  else if (positive(maxC) && maxTempCSeen > maxC) diagnostics.push(diagnostic(
    'SHUNT_TEMPERATURE_LIMIT', 'fail', 'Shunt temperature exceeds its operating limit',
    `${maxTempCSeen.toFixed(1)} °C simulated versus ${maxC.toFixed(1)} °C rated.`,
    'Reduce current/duration, improve termination and cooling, or select a qualified shunt.',
    ref?.evidence || null,
  ));
  const contError = errorAt(cont);
  const peakError = errorAt(peak);
  const accuracyTermsKnown = [
    [gainErrorPct, 'gainErrorPct'],
    [offsetErrorA, 'offsetErrorA'],
    [noiseErrorA, 'noiseErrorA'],
  ].every(([value, key]) => finite(value) || finite(ref?.[key]));
  if (!accuracyTermsKnown) diagnostics.push(diagnostic(
    'SHUNT_ACCURACY_UNPROVEN', 'review', 'Current-measurement accuracy is incomplete',
    'Gain, offset and noise terms are all needed; the Sensata total-error method adds these contributions.',
    'Enter end-of-life, full-temperature-range accuracy terms from the selected sensor datasheet.',
    ref?.evidence || null,
  ));
  else if (cont > 0 && contError.percent > Number(requiredAccuracyPct)) diagnostics.push(diagnostic(
    'SHUNT_ACCURACY_MISSED', 'fail', 'Current accuracy misses the stated requirement',
    `Worst-case error is ±${contError.absoluteA.toFixed(2)} A (${contError.percent.toFixed(2)}%) at ${cont.toFixed(1)} A; requirement is ${Number(requiredAccuracyPct).toFixed(2)}%.`,
    'Choose a more accurate measurement chain or relax the requirement through the documented safety process.',
    ref?.evidence || null,
  ));
  if (ref?.lifecycle === 'obsolete') diagnostics.push(diagnostic(
    'SHUNT_REFERENCE_OBSOLETE', 'review', `${ref.part} is an archived reference, not a release candidate`,
    'Sensata currently marks SFP200 and SFP203 obsolete. The model is retained to reproduce documented behavior and teach the selection method.',
    'Select a current supplier part and replace every rating, error term, thermal curve and evidence identifier.',
    SENSATA_ELECTRICAL_SOURCES.shuntLifecycle,
  ));
  const evidenceUsed = evidence || ref?.evidence || null;
  if (!ref && (!supplier?.part || !evidenceUsed?.revision || !evidenceUsed?.date)) diagnostics.push(diagnostic(
    'SHUNT_SUPPLIER_EVIDENCE_MISSING', 'review', 'Shunt supplier evidence is incomplete',
    'A current part number, document revision and evidence date are required for release.',
    'Attach the current datasheet and installed-termination thermal evidence.',
  ));

  return {
    status: statusFrom(diagnostics), reference: ref, supplier,
    resistanceUOhm: rU, resistanceTolerancePct: tolPct,
    continuousA: cont, peakA: peak, peakDurationS: Number(peakDurationS),
    ratings: { continuousA: contRating, peakA: peakRating, peakDurationS: peakRatingS, conductorAreaMm2: area, maxOperatingC: maxC },
    electrical: {
      continuousDropMV: cont * r0 * 1000,
      continuousLossW: cont * cont * r0,
      peakDropMV, peakPowerW, energyJ,
    },
    accuracy: { gainErrorPct: gainPct, offsetErrorA: offsetA, noiseErrorA: noiseA, atContinuous: contError, atPeak: peakError },
    thermal: { calculated: positive(rth) && positive(tau), maxTempC: maxTempCSeen, thermalResistanceKPerW: rth, thermalTimeConstantS: tau },
    trace, diagnostics, evidence: evidenceUsed,
  };
}

function firstCrossing(trace, thresholdA) {
  if (!trace?.tS?.length || !trace?.currentA?.length) return null;
  for (let i = 1; i < trace.tS.length; i++) {
    const a = trace.currentA[i - 1], b = trace.currentA[i];
    if (a >= thresholdA) return trace.tS[i - 1];
    if (b >= thresholdA && b !== a) {
      const f = (thresholdA - a) / (b - a);
      return trace.tS[i - 1] + f * (trace.tS[i] - trace.tS[i - 1]);
    }
  }
  return null;
}

function interpolateTrace(trace, atS) {
  if (!trace?.tS?.length) return null;
  for (let i = 1; i < trace.tS.length; i++) {
    if (trace.tS[i] >= atS) {
      const dt = trace.tS[i] - trace.tS[i - 1];
      const f = dt > 0 ? (atS - trace.tS[i - 1]) / dt : 0;
      return trace.currentA[i - 1] + f * (trace.currentA[i] - trace.currentA[i - 1]);
    }
  }
  return trace.currentA.at(-1);
}

/** Coordinate a shunt threshold with the existing R-L fault trace. */
export function fastProtectionStudy({
  faultResult, thresholdA, totalDelayMs = 5,
  shuntPeakRangeA = null, shuntErrorA = 0,
  interrupterVoltageRatingV = null, interrupterCurrentRatingA = null,
  evidence = null,
}) {
  if (!faultResult?.series) throw new Error('fastProtectionStudy requires an external-short result with a current trace.');
  if (!positive(thresholdA) || !positive(totalDelayMs)) throw new Error('fastProtectionStudy requires positive thresholdA and totalDelayMs.');
  const conservativeThreshold = Number(thresholdA) + Math.max(0, Number(shuntErrorA) || 0);
  const crossingS = firstCrossing({ tS: faultResult.series.t, currentA: faultResult.series.i }, conservativeThreshold);
  const interruptS = crossingS == null ? null : crossingS + Number(totalDelayMs) / 1000;
  const currentAtInterruptA = interruptS == null ? null
    : interpolateTrace({ tS: faultResult.series.t, currentA: faultResult.series.i }, interruptS);
  const loopInductanceH = faultResult.timeConstantS * faultResult.totalROhm;
  const inductiveEnergyJ = currentAtInterruptA == null ? null : 0.5 * loopInductanceH * currentAtInterruptA * currentAtInterruptA;
  const diagnostics = [];
  if (crossingS == null) diagnostics.push(diagnostic(
    'FAST_PROTECTION_THRESHOLD_NOT_REACHED', 'fail', 'Fault threshold is not reached in the simulated window',
    `${conservativeThreshold.toFixed(1)} A including measurement error is above the trace seen by the protection logic.`,
    'Lower the justified threshold or use another independent detection channel; do not assume a PyroFuse will fire without detection.',
    SENSATA_ELECTRICAL_SOURCES.pyrofuse,
  ));
  if (!positive(shuntPeakRangeA)) diagnostics.push(diagnostic(
    'FAST_PROTECTION_SHUNT_RANGE_UNPROVEN', 'review', 'Shunt fault-current range is not evidenced',
    'A protection threshold is meaningful only if the measurement chain remains valid through the detection point.',
    'Enter the sensor/shunt clipping limit and diagnostic behavior beyond range.',
    SENSATA_ELECTRICAL_SOURCES.pyrofuse,
  ));
  else if (Number(shuntPeakRangeA) < conservativeThreshold) diagnostics.push(diagnostic(
    'FAST_PROTECTION_SHUNT_CLIPS', 'fail', 'The current sensor clips before the protection threshold',
    `${Number(shuntPeakRangeA).toFixed(0)} A range versus ${conservativeThreshold.toFixed(0)} A conservative threshold.`,
    'Use a measurement path with enough fault-current range or add a separate fast overcurrent detector.',
    SENSATA_ELECTRICAL_SOURCES.pyrofuse,
  ));
  if (!positive(interrupterVoltageRatingV) || !positive(interrupterCurrentRatingA)) diagnostics.push(diagnostic(
    'FAST_PROTECTION_INTERRUPTER_UNPROVEN', 'review', 'Interrupter capability is not evidenced',
    currentAtInterruptA == null
      ? 'The interruption point could not be calculated.'
      : `The device would be asked to interrupt about ${currentAtInterruptA.toFixed(0)} A with approximately ${inductiveEnergyJ.toFixed(1)} J stored in loop inductance.`,
    'Enter the actual PyroFuse/fuse voltage, current, inductance and arc-energy envelope with part/revision evidence.',
    SENSATA_ELECTRICAL_SOURCES.pyrofuse,
  ));
  else {
    if (Number(interrupterVoltageRatingV) < faultResult.ocv0) diagnostics.push(diagnostic(
      'FAST_PROTECTION_VOLTAGE_TOO_LOW', 'fail', 'Interrupter voltage rating is too low',
      `${Number(interrupterVoltageRatingV).toFixed(0)} V rated versus ${faultResult.ocv0.toFixed(0)} V source.`,
      'Select a device qualified for the full battery voltage and post-interruption isolation requirement.',
      SENSATA_ELECTRICAL_SOURCES.pyrofuse,
    ));
    if (currentAtInterruptA != null && Number(interrupterCurrentRatingA) < currentAtInterruptA) diagnostics.push(diagnostic(
      'FAST_PROTECTION_CURRENT_TOO_LOW', 'fail', 'Interrupter current rating is too low',
      `${Number(interrupterCurrentRatingA).toFixed(0)} A rated versus ${currentAtInterruptA.toFixed(0)} A simulated at interruption.`,
      'Select a qualified interrupter or reduce the total detection/interruption delay.',
      SENSATA_ELECTRICAL_SOURCES.pyrofuse,
    ));
  }
  if (!evidence?.part || !evidence?.revision || !evidence?.date) diagnostics.push(diagnostic(
    'FAST_PROTECTION_EVIDENCE_MISSING', 'review', 'Fast-protection evidence is incomplete',
    'The Sensata 2–5 ms discussion is a system example, not a rating for an unnamed part.',
    'Attach the exact interrupter, driver and sensing-chain evidence and validate it with injected faults.',
    SENSATA_ELECTRICAL_SOURCES.pyrofuse,
  ));
  return {
    status: statusFrom(diagnostics), thresholdA: Number(thresholdA), conservativeThresholdA: conservativeThreshold,
    crossingS, interruptS, currentAtInterruptA, loopInductanceH, inductiveEnergyJ,
    totalDelayMs: Number(totalDelayMs), diagnostics, source: SENSATA_ELECTRICAL_SOURCES.pyrofuse,
  };
}
