import type {
  Arrangement,
  BatteryCell,
  ElectricalSummary,
  LayoutOptions,
  Orientation,
  PackLayout,
  PackSummary,
} from '../types/core.js';

export const ARRANGEMENTS_BY_FORM: Record<BatteryCell['form'], readonly Arrangement[]>;
export function electrical(cell: BatteryCell, s: number, p: number): ElectricalSummary;
export function defaultArrangement(cell: BatteryCell): Arrangement;
export function gridDims(
  cell: BatteryCell,
  cellCount: number,
  nx: number,
  nz: number,
  arrangement: Arrangement,
  spacingMm: number,
  layerGapMm: number,
  orientation: Orientation,
  rowExtraMm?: number,
): null | {
  nx: number;
  ny: number;
  nz: number;
  innerX: number;
  innerY: number;
  innerZ: number;
  perLayer: number;
  od: Record<string, number | string | boolean>;
};
export function autoNx(
  cell: BatteryCell,
  cellCount: number,
  nz: number,
  arrangement: Arrangement,
  spacingMm: number,
  orientation: Orientation,
): number;
export function layoutPack(
  cell: BatteryCell,
  s: number,
  p: number,
  options?: LayoutOptions,
): PackLayout | null;
export function summarize(
  cell: BatteryCell,
  s: number,
  p: number,
  layout: PackLayout | null,
): PackSummary;
