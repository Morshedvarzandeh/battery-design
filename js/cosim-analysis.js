// Specialized simulations attached to a governed equation graph.  These do
// not masquerade as scalar Rust blocks: each names its own solver, inputs,
// evidence and limitations in the returned result.

import { cellById } from './cells.js';
import { layoutPack } from './pack-engine.js';
import { propagation, propagationStudy, releaseMultiple } from './runaway.js';
import { sizeEmergencyVent } from './venting.js';
import { selectVentHardwareLayout, ventMarketProfile } from './vent-layout.js';
import { ANALYSIS_MODULE_CATALOG } from './cosim-graph.js';

export const RUNAWAY_CHEMISTRY_BEHAVIOR = Object.freeze({
  NMC: Object.freeze({
    label: 'NMC', tone: 'Higher propagation challenge',
    explanation: 'Lower class onset and higher heat release make early isolation, opaque barriers and directed venting especially important.',
  }),
  LFP: Object.freeze({
    label: 'LFP', tone: 'Later onset, lower release',
    explanation: 'Higher class onset and lower heat release usually buy more time than NMC, but a triggered LFP cell can still propagate and must never be called safe from chemistry alone.',
  }),
  LTO: Object.freeze({
    label: 'LTO', tone: 'Highest onset in this comparison',
    explanation: 'The highest class onset and lowest heat-release multiple provide the strongest thermal margin here; energy density, cost and actual-cell abuse data remain separate decisions.',
  }),
});

function compareRunawayChemistries({ layout, cell, parameters }) {
  return Object.entries(RUNAWAY_CHEMISTRY_BEHAVIOR).map(([chemistry, behavior]) => {
    const result = propagation({
      layout, cell, chemistry, barrier: parameters.barrier,
      barrierThicknessMm: parameters.barrierThicknessMm,
      spacer: parameters.spacer,
      soc: parameters.soc, ambientC: parameters.ambientC,
    });
    return {
      chemistry,
      ...behavior,
      onsetC: result.onsetC,
      releaseMultiple: releaseMultiple(chemistry),
      releasePerCellMJ: result.energy.perCellJ / 1e6,
      triggeredCells: result.gone,
      modelledCells: result.modelled,
      secondsToSecondCell: result.secondsToSecondCell,
      peakNeighbourC: result.peakNeighbourC,
      outcome: result.spread ? 'fail' : 'unproven',
    };
  });
}

export function runRunawayPropagationModule(module) {
  if (module?.type !== 'runaway-propagation') throw new TypeError('Expected a runaway-propagation module.');
  const p = module.parameters || {};
  const cell = cellById(p.cellId);
  if (!cell) throw new RangeError(`Unknown cell for runaway study: ${p.cellId}`);
  const layout = layoutPack(cell, p.series, p.parallel, { spacingMm: p.spacingMm });
  const result = propagationStudy({
    layout, cell, barrier: p.barrier, barrierThicknessMm: p.barrierThicknessMm,
    spacer: p.spacer,
    soc: p.soc, ambientC: p.ambientC,
  });
  if (!result) throw new Error('The runaway propagation study could not be initialized.');
  const manifest = ANALYSIS_MODULE_CATALOG[module.type];
  const chemistryComparison = compareRunawayChemistries({ layout, cell, parameters: p });
  return {
    moduleId: module.id,
    type: module.type,
    solver: manifest.solver,
    status: result.spread ? 'fail' : 'unproven',
    headline: result.headline,
    limitations: [manifest.limitation, ...result.assumptions],
    evidence: {
      modelledCells: result.modelled,
      triggeredCells: result.gone,
      secondsToSecondCell: result.secondsToSecondCell,
      peakNeighbourC: result.peakNeighbourC,
      onsetC: result.onsetC,
      containmentMJ: result.containment.moduleMJ,
      rankedBarriers: result.ranked,
      rankedSpacers: result.spacerRanked,
      heatPaths: {
        gapWPerK: result.coupling.gapWK,
        spacerWPerK: result.coupling.spacerWK,
        interconnectWPerK: result.coupling.interconnectWK,
        totalWPerK: result.coupling.conductionWK,
        spacer: result.coupling.spacer,
        spacerContactFraction: result.coupling.spacerContactFraction,
        spacerLengthMm: result.coupling.spacerLengthMm,
        radiationActive: result.coupling.radiates,
      },
      equations: result.equations,
      kineticsBoundary: result.kineticsBoundary,
      chemistryComparison,
      chemistryComparisonBasis: 'Controlled comparison: identical cell geometry, mass, stored electrical energy, spacing, barrier, ambient and state of charge; only the chemistry-class onset and release multiple change.',
      seedCellIndex: result.seedCellIndex,
      gasSourceMm: result.gasSourceMm,
      enclosureMm: result.enclosureMm,
      history: result.history,
    },
    findings: result.findings,
  };
}

const missingValue = (value) => value == null || String(value).trim() === '';
const splitList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

export function runVentSizingModule(module, context = {}) {
  if (module?.type !== 'vent-sizing') throw new TypeError('Expected a vent-sizing module.');
  const p = module.parameters || {};
  const manifest = ANALYSIS_MODULE_CATALOG[module.type];
  const required = [
    ['gasVolumeLowLPerCell', 'Low gas volume per cell'],
    ['gasVolumeHighLPerCell', 'High gas volume per cell'],
    ['releaseDurationLowS', 'Minimum release duration'],
    ['releaseDurationHighS', 'Maximum release duration'],
    ['gasDataBasis', 'Gas data measurement or scenario basis'],
  ];
  const missingInputs = required.filter(([key]) => missingValue(p[key]))
    .map(([, label]) => label);
  if (missingInputs.length) return {
    moduleId: module.id, type: module.type, solver: manifest.solver,
    status: 'needs-input', headline: 'Vent area is not calculated until gas-release evidence is entered.',
    missingInputs, limitations: [manifest.limitation],
    findings: [{ level: 'review', text: 'Use representative cell/module abuse-test gas volume and release-rate data; do not infer it from NMC, LFP or LTO alone.' }],
  };
  const result = sizeEmergencyVent(p);
  const profile = context.market ? ventMarketProfile(context.market, context.segment ?? null) : null;
  const geometry = context.runawayEvidence ? {
    enclosure: context.runawayEvidence.enclosureMm,
    source: context.runawayEvidence.gasSourceMm,
  } : null;
  const hardwareRequired = [
    ['ventUnitId', 'Supplier vent record id'],
    ['ventUnitName', 'Supplier vent name'],
    ['ventSupplier', 'Vent supplier'],
    ['ventPartNumber', 'Vent part number'],
    ['ventUnitFreeAreaCm2', 'Supplier-declared unobstructed free area'],
    ['ventUnitWidthMm', 'Vent footprint width'],
    ['ventUnitHeightMm', 'Vent footprint height'],
    ['ventUnitMechanism', 'Vent mechanism'],
    ['ventUnitMarketProfiles', 'Supplier-declared market profiles'],
    ['ventUnitEvidenceBasis', 'Supplier part evidence'],
    ['allowedVentFaces', 'Human-screened discharge faces'],
    ['edgeClearanceMm', 'Vent-to-edge clearance'],
    ['minimumVentSpacingMm', 'Minimum inter-vent spacing'],
  ];
  const missingHardwareInputs = hardwareRequired.filter(([key]) => missingValue(p[key]))
    .map(([, label]) => label);
  if (!profile) missingHardwareInputs.push('Graph market and Grid segment');
  if (!geometry?.enclosure || !geometry?.source) missingHardwareInputs.push('Runaway enclosure and gas-source geometry');
  if (missingHardwareInputs.length) return {
    moduleId: module.id, type: module.type, solver: manifest.solver,
    status: 'needs-hardware',
    headline: `${result.headline}; supplier vent selection and placement need more input.`,
    missingHardwareInputs,
    limitations: [manifest.limitation, ...result.limitations],
    evidence: result,
    findings: [
      { level: 'review', text: `The declared gas case needs at least ${result.high.areaCm2.toFixed(1)} cm² unobstructed free area.` },
      { level: 'review', text: 'Enter a supplier-verified vent unit, allowed discharge faces and physical clearances before hardware quantity or placement is shown.' },
    ],
  };
  const layout = selectVentHardwareLayout({
    market: context.market,
    segment: context.segment ?? null,
    requiredFreeAreaCm2: result.high.areaCm2,
    enclosure: geometry.enclosure,
    source: geometry.source,
    allowedFaces: splitList(p.allowedVentFaces),
    preferredFace: String(p.preferredVentFace || '').trim() || null,
    edgeClearanceMm: p.edgeClearanceMm,
    minimumSpacingMm: p.minimumVentSpacingMm,
    maxVentCount: p.maxVentCount ?? 128,
    unit: {
      id: p.ventUnitId,
      name: p.ventUnitName,
      supplier: p.ventSupplier,
      partNumber: p.ventPartNumber,
      freeAreaCm2: p.ventUnitFreeAreaCm2,
      widthMm: p.ventUnitWidthMm,
      heightMm: p.ventUnitHeightMm,
      mechanism: p.ventUnitMechanism,
      marketProfiles: splitList(p.ventUnitMarketProfiles),
      evidenceBasis: p.ventUnitEvidenceBasis,
    },
  });
  const placementLimitation = 'Vent coordinates are a geometric screening result on human-permitted faces; CAD structure, external safe discharge, obstructions, ducts, opening dynamics and installed-system tests remain required.';
  return {
    moduleId: module.id, type: module.type, solver: manifest.solver,
    status: layout.status === 'blocked' ? 'fail' : result.status,
    headline: `${result.headline}; ${layout.headline}`,
    limitations: [manifest.limitation, placementLimitation, ...result.limitations],
    evidence: { ...result, hardwareLayout: layout },
    findings: layout.status === 'blocked' ? [
      { level: 'fail', text: layout.headline },
      ...layout.correctiveActions.map((text) => ({ level: 'review', text })),
      { level: 'review', text: `Gas-data basis: ${result.inputs.gasDataBasis}` },
    ] : [
      { level: 'review', text: `Use ${layout.requiredQuantity} supplier-declared vent unit${layout.requiredQuantity === 1 ? '' : 's'} providing ${layout.totalDeclaredFreeAreaCm2.toFixed(1)} cm² total free area, then validate the installed layout by test.` },
      { level: 'review', text: `Gas-data basis: ${result.inputs.gasDataBasis}` },
    ],
  };
}

export function runAttachedAnalysisModules(graph) {
  const results = [];
  let runawayResult = null;
  for (const module of (graph.analysisModules || []).filter((item) => item.enabled !== false)) {
    if (module.type === 'runaway-propagation') {
      runawayResult = runRunawayPropagationModule(module);
      results.push(runawayResult);
      continue;
    }
    if (module.type === 'vent-sizing') {
      results.push(runVentSizingModule(module, {
        market: graph.market,
        segment: graph.segment,
        runawayEvidence: runawayResult?.evidence || null,
      }));
      continue;
    }
    throw new RangeError(`No solver is registered for analysis module: ${module.type}`);
  }
  return results;
}
