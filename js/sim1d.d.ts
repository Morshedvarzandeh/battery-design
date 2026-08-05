import type {
  BatteryCell,
  MissionComparisonInput,
  MissionComparisonResult,
  MissionInput,
  MissionOutcome,
} from '../types/core.js';

export const OCV_SHAPES: Record<string, readonly (readonly [number, number])[]>;
export const SHAPE_OF_CHEMISTRY: Record<BatteryCell['chemistry'], string>;
export function ocvCell(cell: BatteryCell, soc: number): number;
export function simulateMission(input: MissionInput): MissionOutcome;
export function compareCells(input: MissionComparisonInput): MissionComparisonResult;
