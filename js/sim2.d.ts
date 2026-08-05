import type {
  AdvancedModelParams,
  AdvancedSimulationInput,
  AdvancedSimulationResult,
  BatteryCell,
} from '../types/core.js';

export const R_GAS: number;
export const T0_K: number;
export const PARAM_SPEC: readonly {
  id: keyof AdvancedModelParams;
  group: string;
  label: string;
  unit: string;
  def: number | null;
  min: number;
  max: number;
  why: string;
  source: string;
}[];
export const PARAM_BY_ID: Partial<Record<keyof AdvancedModelParams, (typeof PARAM_SPEC)[number]>>;
export function defaultParams(cell?: BatteryCell | null): AdvancedModelParams;
export function validateParams(params: Partial<AdvancedModelParams>): {
  params: AdvancedModelParams;
  notes: string[];
};
export function simulate(input: AdvancedSimulationInput): AdvancedSimulationResult | null;
export function agingEstimate(input: Record<string, unknown>): Record<string, unknown>;
export function rmse(a: readonly number[], b: readonly number[]): number;
export function calibrate(input: Record<string, unknown>): Record<string, unknown>;
