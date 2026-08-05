import type { BatteryCell, ChemistryId } from '../types/core.js';

export const CELL_LIST_VERSION: string;
export const CELLS: BatteryCell[];
export const CHEMISTRIES: Record<ChemistryId, {
  key: ChemistryId;
  name: string;
  nominalV: number;
  vMaxTyp: number;
  vMinTyp: number;
  whKgCell: readonly [number, number];
  cycleLifeTyp: readonly [number, number];
  maxChargeCTyp: number;
  thermalRisk: string;
  color: string;
  notes: string;
}>;
export function cellById(id: string): BatteryCell | undefined;
export function cellFind(id: string): BatteryCell | undefined;
export function provenance(cell: BatteryCell): {
  label: string;
  tone: string;
  blurb: string;
  inferred: readonly string[];
};
