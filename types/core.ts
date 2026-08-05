export type ChemistryId = 'NMC' | 'NCA' | 'LFP' | 'LTO' | 'LCO' | 'NAION';
export type CellForm = 'cylindrical' | 'prismatic' | 'pouch';
export type DataBasis =
  | 'contrib'
  | 'external_datasheet'
  | 'teardown'
  | 'trade_press'
  | 'composite'
  | 'recalled';

export interface CylindricalDimensions {
  d: number;
  h: number;
}

export interface RectangularDimensions {
  w: number;
  t: number;
  h: number;
}

export type CellDimensions = CylindricalDimensions | RectangularDimensions;

interface BatteryCellBase {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  formFactor: string;
  chemistry: ChemistryId;
  massG: number;
  capacityAh: number;
  nominalV: number;
  vMax: number;
  vMin: number;
  maxContDischargeA: number;
  maxPulseDischargeA: number | null;
  maxContChargeA: number;
  dcirMOhm: number | null;
  cycleLife: number | null;
  tempDischargeC: readonly [number, number];
  tempChargeC: readonly [number, number];
  priceUSD: number | null;
  basis: DataBasis;
  contribUid: string | null;
  inferredFields: readonly string[];
  sourceNote: string;
}

export interface CylindricalCell extends BatteryCellBase {
  form: 'cylindrical';
  dims: CylindricalDimensions;
}

export interface RectangularCell extends BatteryCellBase {
  form: 'prismatic' | 'pouch';
  dims: RectangularDimensions;
}

export type BatteryCell = CylindricalCell | RectangularCell;

export type Arrangement = 'grid' | 'hex' | 'stack';
export type Orientation = 'upright' | 'lying' | 'flat';

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface LayoutOptions {
  arrangement?: Arrangement;
  orientation?: Orientation;
  spacingMm?: number;
  layerGapMm?: number;
  wallMm?: number;
  headroomMm?: number;
  underMm?: number;
  rowExtraMm?: number;
  nx?: number;
  nz?: number;
}

export interface CellPosition extends Vector3 {
  sIndex: number;
  pIndex: number;
  layer: number;
}

export interface PackLayout {
  cell: BatteryCell;
  s: number;
  p: number;
  N: number;
  arrangement: Arrangement;
  orientation: Orientation;
  spacingMm: number;
  layerGapMm: number;
  wallMm: number;
  headroomMm: number;
  underMm: number;
  rowExtraMm: number;
  nx: number;
  ny: number;
  nz: number;
  positions: CellPosition[];
  cellFootprint: {
    fx: number;
    fy: number;
    fz: number;
    round: boolean;
    axis: 'x' | 'y' | 'z';
  };
  inner: Vector3;
  outer: Vector3;
  volumeL: number;
  packingEfficiency: number;
}

export interface ElectricalSummary {
  s: number;
  p: number;
  cellCount: number;
  nominalV: number;
  vMax: number;
  vMin: number;
  capacityAh: number;
  energyWh: number;
  massCellsKg: number;
  maxContCurrentA: number;
  maxPulseCurrentA: number | null;
  maxContPowerW: number;
  maxContPowerAtVMinW: number;
  maxChargeCurrentA: number;
  dcirMOhm: number | null;
  sagVAtMaxCont: number | null;
}

export interface PackSummary extends ElectricalSummary {
  massKg: number;
  enclosureKg: number | null;
  dims: Vector3 | null;
  volumeL: number | null;
  whPerKg: number | null;
  whPerL: number | null;
  packingEfficiency: number | null;
}

export interface PowerProfile {
  dtS: number;
  p: readonly number[];
}

export type ChargeMode = 'none' | 'topup' | 'base';

export interface ChargeCommand {
  mode: ChargeMode;
  powerW: number;
  minutes?: number;
}

export interface MissionInput {
  cell: BatteryCell;
  s: number;
  p: number;
  profile: PowerProfile | null;
  scaleW: number;
  passes?: number;
  startSoC?: number;
  ambientC?: number;
  resistanceMOhm?: number;
  uaWK?: number | null;
  thermalMassJK?: number;
  hasHeater?: boolean;
  charge?: ChargeCommand;
}

export type FindingSeverity = 'pass' | 'warn' | 'fail' | 'info';

export interface Finding {
  id?: string;
  severity: FindingSeverity;
  category?: string;
  title: string;
  detail: string;
  ref?: string;
}

export interface MissionTrace {
  tS: number[];
  soc: number[];
  vPack: number[];
  pW: number[];
  tC: Array<number | null>;
  iA: number[];
}

export interface MissionUnavailable {
  unavailable: true;
  why: string;
}

export interface MissionResult {
  unavailable?: false;
  passes: number;
  durationS: number;
  ambientC: number;
  trace: MissionTrace;
  findings: Finding[];
  assumptions: string[];
  summary: Record<string, number | string | boolean | null>;
}

export type MissionOutcome = MissionUnavailable | MissionResult;

export interface MissionComparisonRow {
  cell: BatteryCell;
  s: number;
  p: number;
  energyWh: number;
  massKg: number;
  resistanceMOhm: number | null;
  notes: string[];
  sim: MissionOutcome;
  current: boolean;
  verdict: 'unavailable' | 'fail' | 'warn' | 'pass';
}

export interface MissionComparisonResult {
  rows: MissionComparisonRow[];
  basis: string;
}

export interface RcBranch {
  rMOhm: number;
  tauS: number;
}

export interface AdvancedModelParams {
  r0Ref: number;
  r0EaJ: number;
  r0SocRise: number;
  rc1R: number;
  rc1TauS: number;
  rc2R: number;
  rc2TauS: number;
  hystV: number;
  coulombEff: number;
  cpCellJkgK: number;
  entropyVK: number;
  kCondWK: number;
  hCoolWK: number;
  uaAmbWK: number;
  mdotKgS: number;
  cpCoolJkgK: number;
  coolantInC: number;
  currentImbalance: number;
  calA: number;
  calEaJ: number;
  calSocK: number;
  cycA: number;
  cycEaJ: number;
  cycCrateK: number;
  resGrowthK: number;
  tRefC: number;
  maxDtS: number;
}

export interface CurrentProfile {
  dtS: number;
  i?: readonly number[];
  w?: readonly number[];
}

export interface AdvancedSimulationInput {
  cell: BatteryCell;
  s: number;
  p: number;
  params?: Partial<AdvancedModelParams>;
  profile: CurrentProfile;
  nModules?: number;
  ambientC?: number;
  startSoC?: number;
  seriesPerModule?: number | null;
  years?: number;
  cyclesPerYear?: number;
}

export interface AdvancedSimulationResult {
  series: {
    t: number[];
    v: number[];
    i: number[];
    soc: number[];
    tMax: number[];
    tMin: number[];
    tCoolOut: number[];
    heatW: number[];
  };
  findings: Finding[];
  summary: Record<string, number | null>;
  aging: Record<string, unknown>;
  params: AdvancedModelParams;
  paramNotes: string[];
  assumptions: string[];
}

export interface MissionComparisonInput {
  cells: readonly BatteryCell[];
  targetVNom: number;
  targetEnergyWh: number;
  profile: PowerProfile;
  scaleW: number;
  passes?: number;
  startSoC?: number;
  ambientC?: number;
  interconnectMOhm?: number;
  uaWK?: number | null;
  hasHeater?: boolean;
  currentId?: string | null;
}

export type SimulationJob =
  | { kind: 'mission'; input: MissionInput; compareInput?: MissionComparisonInput | null }
  | { kind: 'advanced'; input: AdvancedSimulationInput };

export interface WorkerRequest {
  id: number;
  job: SimulationJob;
}

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
