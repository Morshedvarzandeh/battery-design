#!/usr/bin/env node

// Generate every engineering number used by the second Battery Design teaser.
//
// This file intentionally imports the product engine rather than carrying a
// second set of equations. The advertisement can round values for display, but
// it cannot invent a pack, mission, thermal trace, threshold, or improvement.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CELL_LIST_VERSION, cellById } from '../../../js/cells.js';
import { optimizeSpace } from '../../../js/optimizer.js';
import { layoutPack, summarize } from '../../../js/pack-engine.js';
import {
  driveCyclePower,
  rangeKm,
  traceForApp,
  vehicleDefaultsFor,
} from '../../../js/vehicle.js';
import { defaultParams, simulate } from '../../../js/sim2.js';
import { buildThermalSystem, COOLANT } from '../../../js/btms.js';

const BAY_MM = Object.freeze({ x: 1800, y: 1400, z: 150 });
const TARGET_VOLTAGE_V = 400;
const TARGET_ENERGY_KWH = 60;
const AMBIENT_C = 40;
const START_SOC = 0.90;
const GRADE_PCT = 3;
const MODULES = 10;
const COMPACT_STRIDE = 4; // native trace is 5 s; teaser data is every 20 s

const cell = required(cellById('lg-inr18650-mj1'), 'LG INR18650-MJ1 cell');
const CELL_MIN_CAPACITY_AH = 3.35;
const CELL_MAX_DIMENSIONS_MM = Object.freeze({ d: 18.65, h: 65.3 });
const layoutCell = Object.freeze({
  ...cell,
  dims: CELL_MAX_DIMENSIONS_MM,
});
// Topology is computed from the declared nominal targets and the selected
// cell's nominal values. The resulting energy is a nominal-capacity result,
// not a guaranteed minimum-capacity production value.
const SERIES = Math.max(1, Math.round(TARGET_VOLTAGE_V / cell.nominalV));
const PARALLEL = Math.max(1, Math.ceil(
  TARGET_ENERGY_KWH * 1000 / (SERIES * cell.nominalV * cell.capacityAh),
));
ensure(SERIES % MODULES === 0,
  'computed series count must divide evenly across the declared thermal nodes');
const SERIES_PER_MODULE = SERIES / MODULES;

// Ten millimetres are reserved below the cells for the cold-plate/TIM zone.
// Among layouts within 1% of the minimum volume, select the most balanced
// footprint. This keeps the choice reproducible and avoids selecting a long,
// narrow pack merely because it saves a fraction of a litre.
const layoutOptions = Object.freeze({
  spacingMm: 1,
  layerGapMm: 2,
  wallMm: 2,
  headroomMm: 8,
  underMm: 10,
  rowExtraMm: 0,
});

const optimized = optimizeSpace(layoutCell, SERIES, PARALLEL, layoutOptions, BAY_MM, 160);
const fittingUprightLayouts = optimized.filter((candidate) =>
  candidate.fits
  && candidate.arrangement === 'hex'
  && candidate.orientation === 'upright'
  && candidate.nz === 1);
required(fittingUprightLayouts.length, 'a one-layer upright layout that fits the bay');

const minimumVolumeL = Math.min(...fittingUprightLayouts.map((candidate) => candidate.volumeL));
const nearMinimumLayouts = fittingUprightLayouts
  .filter((candidate) => candidate.volumeL <= minimumVolumeL * 1.01)
  .sort((a, b) => footprintImbalance(a) - footprintImbalance(b));
const chosenSpace = required(nearMinimumLayouts[0], 'balanced near-minimum-volume layout');
const layout = required(layoutPack(layoutCell, SERIES, PARALLEL, chosenSpace.opts), 'pack layout');
const pack = summarize(layoutCell, SERIES, PARALLEL, layout);

ensure(pack.dims.x <= BAY_MM.x && pack.dims.y <= BAY_MM.y && pack.dims.z <= BAY_MM.z,
  'optimized pack must fit inside the declared bay');
ensure(pack.energyWh >= TARGET_ENERGY_KWH * 1000,
  'computed topology must meet the declared nominal-energy target');

// The product's synthesized WLTP Class 3 structure is a public-aggregate-based
// representative mission, not a homologation trace. Sport mode and the 3%
// sustained grade are explicit stress-case inputs shared by both simulations.
const trace = required(traceForApp('ev'), 'representative EV trace');
const vehicle = required(vehicleDefaultsFor('ev'), 'EV vehicle defaults');
const drive = required(driveCyclePower({
  trace,
  vehicle,
  mode: 'sport',
  packMassKg: pack.massKg,
  gradePct: GRADE_PCT,
}), 'computed EV mission');

const profile = Object.freeze({ dtS: drive.dtS, w: drive.w });
const sharedParams = Object.freeze({
  ...defaultParams(cell),
  kCondWK: 4,
  uaAmbWK: 1.5,
  // The ten groups are electrically in series and therefore carry the same
  // pack current. Module resistance/heat-spread uncertainty needs a separate
  // calibrated model and is not invented for this publication screen.
  currentImbalance: 1.0,
});

// Baseline: the pack begins heat-soaked at the 40 C ambient. It has only a
// reduced-flow, ambient-temperature liquid path. This is a disclosed degraded
// cooling case, not the product's default and not a claim about an OEM car.
const baselineParams = Object.freeze({
  ...sharedParams,
  hCoolWK: 2,
  mdotKgS: 0.005,
  coolantInC: AMBIENT_C,
});
const baseline = runSimulation(baselineParams);

// Size the active loop from the baseline mission's positive 95th-percentile
// heat generation. The BTMS engine supplies coolant flow, chiller duty and
// compressor load using its declared 50/50 water-glycol and COP assumptions.
const positiveHeatW = baseline.series.heatW.filter((value) => value > 0);
const heatP95W = percentile(positiveHeatW, 0.95);
const coldPlate = Object.freeze({
  name: 'bottom liquid cold-plate concept',
  kind: 'liquid-cold-plate',
  needsPump: true,
  viz: 'bottom',
});
const baselineArchitecture = buildThermalSystem({
  heatContW: heatP95W,
  ambientC: [0, AMBIENT_C],
  cooling: coldPlate,
  cell,
  override: 'liquid',
  appId: 'ev',
});
const improvedArchitecture = buildThermalSystem({
  heatContW: heatP95W,
  ambientC: [0, AMBIENT_C],
  cooling: coldPlate,
  cell,
  override: 'liquid-chiller',
  appId: 'ev',
});
ensure(improvedArchitecture.flowLpm > 0, 'BTMS must return a positive liquid-loop flow');

// Convert the BTMS flow back to the mass-flow unit sim2 consumes. Only the
// cooling path changes: cell/ECM values, mission, pack, start state, ambient,
// module count, conduction, enclosure UA and current imbalance stay identical.
const improvedFlowKgS = improvedArchitecture.flowLpm * COOLANT.rhoKgPerL / 60;
const improvedParams = Object.freeze({
  ...sharedParams,
  hCoolWK: 25,
  mdotKgS: improvedFlowKgS,
  coolantInC: 24,
});
const improved = runSimulation(improvedParams);

ensure(baseline.summary.unmetWh === 0 && improved.summary.unmetWh === 0,
  'both scenarios must complete the same demanded mission');
ensure(baseline.summary.maxTempC <= cell.tempDischargeC[1],
  'baseline must not be presented as breaching a limit when it does not');
ensure(improved.summary.maxTempC <= cell.tempDischargeC[1],
  'improved case must remain within the cell discharge-temperature limit');

const baselineEndTempC = last(baseline.series.tMax);
const improvedEndTempC = last(improved.series.tMax);
const endTemperatureReductionC = baselineEndTempC - improvedEndTempC;
ensure(endTemperatureReductionC >= 5,
  'computed cooling change must create a useful, visible temperature reduction');

const limitC = cell.tempDischargeC[1];
const packPowerMarginKW = (pack.maxContPowerAtVMinW - drive.peakW) / 1000;
const indices = compactIndices(baseline.series.t.length, COMPACT_STRIDE);

const output = {
  schemaVersion: 1,
  provenance: {
    generator: 'reports/examples/visual-decision-report/generate-data.mjs',
    cellListVersion: CELL_LIST_VERSION,
    engineModules: [
      'js/cells.js',
      'js/optimizer.js',
      'js/pack-engine.js',
      'js/vehicle.js',
      'js/sim2.js',
      'js/btms.js',
    ],
    claimBoundary: 'Computed concept-screening values; equivalent-circuit and lumped-node thermal model, not homologation, CFD, certification, or an OEM vehicle claim.',
  },
  inputs: {
    cellId: cell.id,
    topology: { series: SERIES, parallel: PARALLEL },
    targets: {
      nominalVoltageV: TARGET_VOLTAGE_V,
      nominalEnergyKWh: TARGET_ENERGY_KWH,
      energyBasis: 'Nominal cell voltage and nominal cell capacity',
    },
    bayMm: BAY_MM,
    layoutOptions,
    mission: {
      traceId: trace.id,
      traceName: trace.name,
      traceNote: trace.note,
      drivingMode: drive.mode.id,
      sustainedGradePct: GRADE_PCT,
      ambientC: AMBIENT_C,
      startSoCPct: START_SOC * 100,
    },
  },
  cell: {
    id: cell.id,
    name: cell.name,
    manufacturer: cell.manufacturer,
    chemistry: cell.chemistry,
    capacityAh: cell.capacityAh,
    minimumCapacityAh: CELL_MIN_CAPACITY_AH,
    nominalV: cell.nominalV,
    catalogDimensionsMm: cell.dims,
    layoutDimensionsMm: CELL_MAX_DIMENSIONS_MM,
    layoutDimensionBasis: 'Manufacturer maximum: 18.65 mm diameter and 65.3 mm height',
    specificationUrl: 'https://power.tenergy.com/content/datasheet/30708_datasheet.pdf',
    dcirMOhm: cell.dcirMOhm,
    dischargeTemperatureC: cell.tempDischargeC,
    basis: cell.basis,
    inferredFields: cell.inferredFields,
    sourceNote: cell.sourceNote,
  },
  pack: {
    topology: `${SERIES}S x ${PARALLEL}P`,
    metrics: {
      cellCount: pack.cellCount,
      nominalVoltageV: round(pack.nominalV, 2),
      voltageWindowV: [round(pack.vMin, 1), round(pack.vMax, 1)],
      capacityAh: round(pack.capacityAh, 1),
      energyKWh: round(pack.energyWh / 1000, 3),
      minimumCapacityBasisEnergyKWh: round(
        SERIES * PARALLEL * cell.nominalV * CELL_MIN_CAPACITY_AH / 1000,
        3,
      ),
      massKg: round(pack.massKg, 1),
      cellMassKg: round(pack.massCellsKg, 1),
      volumeL: round(pack.volumeL, 1),
      gravimetricEnergyWhKg: round(pack.whPerKg, 1),
      volumetricEnergyWhL: round(pack.whPerL, 1),
      maxContinuousCurrentA: round(pack.maxContCurrentA, 1),
      maxContinuousPowerAtMinimumVoltageKW: round(pack.maxContPowerAtVMinW / 1000, 2),
      cellsOnlyDcirMOhm: round(pack.dcirMOhm, 2),
    },
    layout: {
      arrangement: layout.arrangement,
      orientation: layout.orientation,
      grid: { nx: layout.nx, ny: layout.ny, nz: layout.nz },
      dimensionsMm: mapRound(pack.dims, 1),
      bayMm: BAY_MM,
      clearanceMm: {
        x: round(BAY_MM.x - pack.dims.x, 1),
        y: round(BAY_MM.y - pack.dims.y, 1),
        z: round(BAY_MM.z - pack.dims.z, 1),
      },
      coldPlateReserveMm: layout.underMm,
      cellDimensionBasis: 'LG MJ1 manufacturer maximum dimensions',
      packingEfficiencyPct: round(layout.packingEfficiency * 100, 1),
      selectionRule: 'Most balanced footprint among fitting one-layer upright hex layouts within 1% of the optimizer minimum volume.',
      minimumOptimizerVolumeL: round(minimumVolumeL, 3),
      selectedVolumeAboveMinimumPct: round((chosenSpace.volumeL / minimumVolumeL - 1) * 100, 3),
    },
  },
  mission: {
    durationS: drive.durationS,
    durationMin: round(drive.durationS / 60, 2),
    distanceKm: round(drive.distanceKm, 2),
    vehicleMassKg: round(drive.massKg, 1),
    energyKWh: round(drive.energyWh / 1000, 3),
    consumptionWhKm: round(drive.whPerKm, 1),
    peakPowerKW: round(drive.peakW / 1000, 2),
    peakRegenKW: round(drive.minW / 1000, 2),
    rmsPowerKW: round(drive.rmsW / 1000, 2),
    missionEquivalentRangeKmAt80PctDoD: round(rangeKm({
      energyWh: pack.energyWh,
      dod: 0.8,
      whPerKm: drive.whPerKm,
    }), 1),
    powerMarginAtMinimumPackVoltageKW: round(packPowerMarginKW, 2),
    energyBreakdownWh: mapRound(drive.breakdown, 1),
  },
  thermal: {
    shared: {
      ambientC: AMBIENT_C,
      startTemperatureC: AMBIENT_C,
      startSoCPct: START_SOC * 100,
      modules: MODULES,
      seriesPerModule: SERIES_PER_MODULE,
      kCondWK: sharedParams.kCondWK,
      uaAmbWK: sharedParams.uaAmbWK,
      currentImbalance: sharedParams.currentImbalance,
      cellDischargeLimitC: limitC,
      heatP95W: round(heatP95W, 1),
      missionPeakHeatW: round(Math.max(...baseline.series.heatW), 1),
    },
    baseline: {
      id: 'hot-day-reduced-flow',
      label: 'Hot-day / reduced-cooling baseline',
      description: 'Heat-soaked pack; ambient-temperature coolant, strongly reduced flow, and a weak plate-to-coolant path. This is a declared degraded case.',
      hardware: 'Reserved bottom thermal zone with reduced-flow liquid path; no active chilling.',
      params: thermalParams(baseline.params),
      results: thermalResults(baseline, limitC),
      engineFindings: baseline.findings,
      architectureAssessment: {
        loopId: baselineArchitecture.loopId,
        verdict: baselineArchitecture.assessment.verdict,
        why: baselineArchitecture.assessment.why,
      },
    },
    improved: {
      id: 'liquid-cold-plate-chiller',
      label: 'Liquid cold plate + chiller',
      description: 'Same hot-start mission and pack; effective bottom cold plate, BTMS-sized water-glycol flow, and 24 C coolant supplied by the vehicle chiller.',
      hardware: improvedArchitecture.coolantSide.concat(improvedArchitecture.refrigerantSide),
      params: thermalParams(improved.params),
      results: thermalResults(improved, limitC),
      engineFindings: improved.findings,
      architecture: {
        loopId: improvedArchitecture.loopId,
        loopName: improvedArchitecture.loop.name,
        verdict: improvedArchitecture.assessment.verdict,
        why: improvedArchitecture.assessment.why,
        flowLpm: round(improvedArchitecture.flowLpm, 2),
        chillerDutyKW: round(improvedArchitecture.chillerKW, 2),
        compressorPowerKW: round(improvedArchitecture.compressorKW, 2),
        chillerCop: improvedArchitecture.chillerCOP,
        heatBasis: 'Positive 95th-percentile baseline mission heat',
      },
    },
    comparison: {
      baselineEndMaxTempC: round(baselineEndTempC, 2),
      improvedEndMaxTempC: round(improvedEndTempC, 2),
      endTemperatureReductionC: round(endTemperatureReductionC, 2),
      baselineEndMarginToLimitC: round(limitC - baselineEndTempC, 2),
      improvedEndMarginToLimitC: round(limitC - improvedEndTempC, 2),
      additionalEndMarginC: round(endTemperatureReductionC, 2),
      thresholdBreached: false,
      honestClaim: `Mission-end hottest-module temperature falls by ${round(endTemperatureReductionC, 1)} C; neither scenario breaches the ${limitC} C cell discharge limit.`,
    },
    modelBoundary: baseline.assumptions,
  },
  series: {
    sampleEveryS: drive.dtS * COMPACT_STRIDE,
    sourceStepS: drive.dtS,
    timeS: pick(baseline.series.t, indices, 1),
    speedKmh: indices.map((index) => round(trace.v[index] * drive.mode.speedScale, 1)),
    powerKW: pick(drive.w, indices, 1000),
    baseline: {
      voltageV: pick(baseline.series.v, indices, 1),
      currentA: pick(baseline.series.i, indices, 1),
      socPct: pick(baseline.series.soc, indices, 0.01),
      maxTempC: pick(baseline.series.tMax, indices, 1),
      minTempC: pick(baseline.series.tMin, indices, 1),
      coolantOutC: pick(baseline.series.tCoolOut, indices, 1),
      heatKW: pick(baseline.series.heatW, indices, 1000),
    },
    improved: {
      voltageV: pick(improved.series.v, indices, 1),
      currentA: pick(improved.series.i, indices, 1),
      socPct: pick(improved.series.soc, indices, 0.01),
      maxTempC: pick(improved.series.tMax, indices, 1),
      minTempC: pick(improved.series.tMin, indices, 1),
      coolantOutC: pick(improved.series.tCoolOut, indices, 1),
      heatKW: pick(improved.series.heatW, indices, 1000),
    },
  },
  findings: [
    {
      id: 'pack-fit',
      severity: 'pass',
      title: 'Nominal-energy cell layout fits the declared example bay',
      detail: `${SERIES}S x ${PARALLEL}P produces ${round(pack.energyWh / 1000, 1)} kWh nominal and the cell-level layout fits at ${dims(pack.dims)} mm, including a ${layout.underMm} mm bottom thermal-system reserve. Module housings and production hardware are outside this fit screen.`,
      source: 'optimizeSpace + layoutPack + summarize',
    },
    {
      id: 'mission-power',
      severity: packPowerMarginKW >= 0 ? 'pass' : 'fail',
      title: packPowerMarginKW >= 0 ? 'Mission power is inside the continuous screen' : 'Mission power exceeds the continuous screen',
      detail: `${round(drive.peakW / 1000, 1)} kW mission peak versus ${round(pack.maxContPowerAtVMinW / 1000, 1)} kW cells-only continuous capability at minimum pack voltage.`,
      source: 'driveCyclePower + summarize',
    },
    {
      id: 'baseline-margin',
      severity: 'info',
      title: 'Reduced-flow reference remains inside the modeled cell limit',
      detail: `The hottest modeled bulk node finishes at ${round(baselineEndTempC, 1)} C, leaving ${round(limitC - baselineEndTempC, 1)} C to the MJ1 cell discharge operating maximum. No limit is breached.`,
      source: 'sim2',
    },
    {
      id: 'cooling-decision',
      severity: 'pass',
      title: 'Cooling concept changes the modeled response',
      detail: `Under the declared 24 C inlet and 25 W/K-per-node assumptions, the identical mission finishes at ${round(improvedEndTempC, 1)} C, a computed ${round(endTemperatureReductionC, 1)} C reduction. This is a concept comparison, not hardware verification.`,
      source: 'sim2 + buildThermalSystem',
    },
    {
      id: 'model-boundary',
      severity: 'info',
      title: 'Concept-screening result, not certification',
      detail: 'The mission is a synthesized WLTP-structured trace, and sim2 is an equivalent-circuit plus ten-node lumped thermal network. Calibrate it to measurements before engineering release.',
      source: 'engine assumptions',
    },
  ],
  blockValues: {
    sizingInput: {
      eyebrow: '01 / SIZE',
      title: 'Define the battery around the mission.',
      voltage: `${TARGET_VOLTAGE_V} V`,
      energy: `${TARGET_ENERGY_KWH} kWh`,
      space: `${BAY_MM.x} x ${BAY_MM.y} x ${BAY_MM.z} mm`,
      cell: cell.name,
    },
    sizingResult: {
      topology: `${SERIES}S x ${PARALLEL}P`,
      energy: `${round(pack.energyWh / 1000, 1)} kWh`,
      voltage: `${round(pack.nominalV, 1)} V`,
      mass: `${round(pack.massKg, 0)} kg`,
      dimensions: `${dims(pack.dims)} mm`,
      cells: `${pack.cellCount.toLocaleString('en-US')} cells`,
    },
    mission: {
      eyebrow: '02 / SIMULATE',
      title: 'Run the same pack through a demanding real calculation.',
      scenario: `${round(drive.durationS / 60, 1)} min Sport cycle / ${GRADE_PCT}% grade / ${AMBIENT_C} C`,
      distance: `${round(drive.distanceKm, 1)} km`,
      peakPower: `${round(drive.peakW / 1000, 1)} kW`,
      consumption: `${round(drive.whPerKm, 0)} Wh/km`,
    },
    baseline: {
      label: 'Reduced cooling',
      endTemperature: `${round(baselineEndTempC, 1)} C`,
      margin: `${round(limitC - baselineEndTempC, 1)} C margin`,
      flow: `${round(baseline.params.mdotKgS / COOLANT.rhoKgPerL * 60, 2)} L/min`,
      status: 'Inside modeled cell operating limit',
    },
    improved: {
      label: 'Cold plate + chiller',
      endTemperature: `${round(improvedEndTempC, 1)} C`,
      reduction: `-${round(endTemperatureReductionC, 1)} C`,
      margin: `${round(limitC - improvedEndTempC, 1)} C margin`,
      flow: `${round(improvedArchitecture.flowLpm, 1)} L/min`,
      chiller: `${round(improvedArchitecture.chillerKW, 1)} kW thermal`,
      compressor: `${round(improvedArchitecture.compressorKW, 1)} kW electrical`,
      status: 'Same-trace concept rerun complete',
    },
    decision: {
      eyebrow: '03 / DECIDE',
      title: 'Do not discover the cooling architecture in hardware.',
      primaryMetric: `${round(endTemperatureReductionC, 1)} C cooler at mission end`,
      supportingMetric: `${round(limitC - improvedEndTempC, 1)} C to the cell limit`,
      note: 'No threshold was falsified: both runs are shown, the inputs differ only in the disclosed cooling path, and the model boundary travels with the result.',
    },
  },
};

const outputUrl = new URL('./report-data.json', import.meta.url);
const serializedOutput = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const committed = await readFile(outputUrl, 'utf8');
  ensure(committed === serializedOutput,
    'Committed report-data.json differs from the engine-generated visual-report fixture.');
} else {
  await writeFile(outputUrl, serializedOutput, 'utf8');
}

console.log(JSON.stringify({
  output: fileURLToPath(outputUrl),
  topology: output.pack.topology,
  pack: output.pack.metrics,
  dimensionsMm: output.pack.layout.dimensionsMm,
  mission: output.mission,
  baseline: output.thermal.baseline.results,
  improved: output.thermal.improved.results,
  comparison: output.thermal.comparison,
}, null, 2));

function runSimulation(params) {
  return required(simulate({
    cell,
    s: SERIES,
    p: PARALLEL,
    params,
    profile,
    startSoC: START_SOC,
    ambientC: AMBIENT_C,
    nModules: MODULES,
    seriesPerModule: SERIES_PER_MODULE,
  }), 'sim2 result');
}

function footprintImbalance(candidate) {
  return Math.abs(Math.log(candidate.outer.x / candidate.outer.y));
}

function thermalParams(params) {
  return {
    coolantInC: round(params.coolantInC, 3),
    coolantMassFlowKgS: round(params.mdotKgS, 5),
    coolantFlowLpm: round(params.mdotKgS / COOLANT.rhoKgPerL * 60, 3),
    moduleToCoolantConductanceWKPerModule: round(params.hCoolWK, 3),
    moduleToModuleConductionWK: round(params.kCondWK, 3),
    packToAmbientConductanceWK: round(params.uaAmbWK, 3),
    coolantSpecificHeatJkgK: round(params.cpCoolJkgK, 1),
    cellSpecificHeatJkgK: round(params.cpCellJkgK, 1),
    currentImbalance: round(params.currentImbalance, 3),
  };
}

function thermalResults(result, cellLimitC) {
  const endMaxTempC = last(result.series.tMax);
  return {
    startTempC: AMBIENT_C,
    endMaxTempC: round(endMaxTempC, 3),
    endMinTempC: round(last(result.series.tMin), 3),
    peakTempC: round(result.summary.maxTempC, 3),
    maxModuleSpreadK: round(result.summary.tempSpreadK, 3),
    endCoolantOutC: round(result.summary.coolantOutC, 3),
    endSoCPct: round(result.summary.endSoC * 100, 2),
    minimumVoltageV: round(result.summary.minV, 2),
    lossWh: round(result.summary.lossWh, 2),
    unmetWh: round(result.summary.unmetWh, 3),
    endMarginToCellLimitC: round(cellLimitC - endMaxTempC, 3),
    cellLimitBreached: result.summary.maxTempC > cellLimitC,
  };
}

function compactIndices(length, stride) {
  const values = [];
  for (let index = 0; index < length; index += stride) values.push(index);
  if (values.at(-1) !== length - 1) values.push(length - 1);
  return values;
}

function pick(values, indicesToPick, divisor = 1) {
  return indicesToPick.map((index) => round(values[index] / divisor, 3));
}

function percentile(values, fraction) {
  required(values.length, 'values for percentile');
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[at];
}

function dims(value) {
  return `${round(value.x, 0)} x ${round(value.y, 0)} x ${round(value.z, 0)}`;
}

function mapRound(value, digits) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, round(item, digits)]));
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function last(values) {
  return values[values.length - 1];
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function required(value, label) {
  if (value == null || value === false || value === 0) throw new Error(`Missing ${label}`);
  return value;
}
