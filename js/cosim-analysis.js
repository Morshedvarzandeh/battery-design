// Specialized simulations attached to a governed equation graph.  These do
// not masquerade as scalar Rust blocks: each names its own solver, inputs,
// evidence and limitations in the returned result.

import { cellById } from './cells.js';
import { layoutPack } from './pack-engine.js';
import { propagation, propagationStudy, releaseMultiple } from './runaway.js';
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
      chemistryComparison,
      chemistryComparisonBasis: 'Controlled comparison: identical cell geometry, mass, stored electrical energy, spacing, barrier, ambient and state of charge; only the chemistry-class onset and release multiple change.',
      history: result.history,
    },
    findings: result.findings,
  };
}

export function runAttachedAnalysisModules(graph) {
  return (graph.analysisModules || []).filter((module) => module.enabled !== false).map((module) => {
    if (module.type === 'runaway-propagation') return runRunawayPropagationModule(module);
    throw new RangeError(`No solver is registered for analysis module: ${module.type}`);
  });
}
