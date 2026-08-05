// Compile-only contract test. A breaking change in cells, the pack engine, or
// either simulation now fails `npm run typecheck` before it can reach users.

import { CELLS } from '../js/cells.js';
import { electrical, layoutPack, summarize } from '../js/pack-engine.js';
import { simulateMission } from '../js/sim1d.js';
import { defaultParams, simulate as simulateAdvanced } from '../js/sim2.js';
import type {
  AdvancedSimulationResult,
  BatteryCell,
  MissionOutcome,
  PackSummary,
} from './core.js';

const cell: BatteryCell = CELLS[0]!;
const layout = layoutPack(cell, 16, 4, { arrangement: 'hex', orientation: 'upright' });
const pack: PackSummary = summarize(cell, 16, 4, layout);
const electricalResult = electrical(cell, 16, 4);

const mission: MissionOutcome = simulateMission({
  cell,
  s: 16,
  p: 4,
  profile: { dtS: 1, p: [0.2, 0.8, -0.1] },
  scaleW: 5_000,
});

const advanced: AdvancedSimulationResult | null = simulateAdvanced({
  cell,
  s: 16,
  p: 4,
  params: defaultParams(cell),
  profile: { dtS: 1, i: [5, 10, -2] },
});

void [pack, electricalResult, mission, advanced];
