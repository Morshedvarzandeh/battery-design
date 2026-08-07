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

export type CalibrationDatasetKind = 'synthetic' | 'measured';
export type CalibrationDatasetPurpose = 'calibration' | 'validation';
export type CalibrationTemperatureLocation =
  | 'cell-average'
  | 'cell-core'
  | 'cell-surface'
  | 'coolant-outlet'
  | 'module-maximum';
export type CalibrationSegmentMode =
  | 'charge'
  | 'discharge'
  | 'dynamic'
  | 'pulse'
  | 'rest'
  | 'thermal-soak'
  | 'other';

export interface CalibrationDatasetPayload {
  id: string;
  kind: CalibrationDatasetKind;
  purpose: CalibrationDatasetPurpose;
  source: {
    tool: string;
    toolVersion: string | null;
    model: string | null;
    runId: string | null;
    generatedAt: string | null;
    mediaType: string;
    rawSha256: string;
  };
  binding: {
    cellId: string | null;
    seriesCells: number;
    parallelCells: number;
    startSoC: number;
    ambientC: number;
    moduleCount: number;
    initialState: 'rested-equilibrium-at-ambient';
  };
  normalization: {
    format: 'battery-design/calibration-normalization@1';
    adapter: 'canonical-json' | 'delimited-columns';
    adapterVersion: string;
    mappingChecksum: string;
    sourceUnits: {
      time: string;
      current: string;
      voltage: string;
      temperature: string | null;
    };
    sourceCurrentPositive: 'charge' | 'discharge';
    sourceCurrentScope: 'cell' | 'pack';
    sourceVoltageLocation: 'cell-terminal' | 'pack-terminal';
    sourceTemperatureLocation: CalibrationTemperatureLocation | null;
    sourceSampleAlignment: 'end-of-step';
    sourceFirstSampleTimeS: number;
    sourceResetTimeS: number;
    timeHandling: 'validated-uniform';
    originalSampleCount: number;
  };
  samplePeriodS: number;
  signals: {
    currentA: readonly number[];
    voltageV: readonly number[];
    temperatureC: readonly number[] | null;
  };
  segments: readonly {
    id: string;
    startIndex: number;
    endIndexExclusive: number;
    mode: CalibrationSegmentMode;
    include: boolean;
  }[];
  conventions: {
    timeBasis: 'uniform-sample-period';
    timeOrigin: 'trial-reset';
    firstSampleOffsetS: number;
    sampleAlignment: 'end-of-step';
    currentHold: 'zero-order-hold';
    currentPositive: 'discharge';
    currentScope: 'pack';
    voltageLocation: 'pack-terminal';
    temperatureLocation: CalibrationTemperatureLocation | null;
  };
}

export interface CalibrationDataset extends CalibrationDatasetPayload {
  format: 'battery-design/calibration-dataset@1';
  schemaVersion: '1.0.0';
  checksum: string;
}

export interface CalibrationDatasetValidationIssue {
  path: string;
  code: string;
  message: string;
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

// Product governance is deliberately separate from the numerical model. The
// same design can be shown through a guided, engineering, expert or API view,
// but it keeps one approval state and one immutable history underneath.
export type ProductRole =
  | 'manager'
  | 'application-engineer'
  | 'simulation-specialist'
  | 'integration-client';

export type AudienceMode = 'guided' | 'engineering' | 'expert' | 'integration';
export type ProductDomain =
  | 'road'
  | 'grid'
  | 'marine'
  | 'aerial'
  | 'robotics'
  | 'light-mobility'
  | 'portable'
  | 'auxiliary';
export type GridCustomerSegment = 'home' | 'small-company' | 'industrial';

export interface ProjectScope {
  readonly application: string;
  readonly domain: ProductDomain;
  readonly gridSegment?: GridCustomerSegment;
}

export interface GridCustomerQuestion {
  readonly id: string;
  readonly label: string;
  readonly why: string;
}

export type ActorKind = 'human' | 'ai' | 'system';
export type WorkflowAuthority = 'validate' | 'review' | 'approve' | 'release' | 'edit-graph';

export interface WorkflowActor {
  readonly id: string;
  readonly kind: ActorKind;
  readonly role: string;
  readonly organization: string;
  readonly marketAccess: readonly ProductDomain[];
  readonly authorities?: readonly WorkflowAuthority[];
}

export type DesignState = 'draft' | 'validated' | 'reviewed' | 'approved' | 'released';
export type DesignHistoryAction = 'created' | 'validated' | 'reviewed' | 'approved' | 'released' | 'material-change';

export interface DesignHistoryEvent {
  readonly id: string;
  readonly action: DesignHistoryAction;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly actorRole: string;
  readonly actorOrganization: string;
  readonly actorAuthorities: readonly WorkflowAuthority[];
  readonly fromState: DesignState | null;
  readonly toState: DesignState;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly reason: string;
  readonly at: string;
  readonly evidence: string | null;
}

export interface DesignRecord {
  readonly projectId: string;
  readonly scope: ProjectScope;
  readonly state: DesignState;
  readonly version: string;
  readonly history: readonly DesignHistoryEvent[];
}

// Co-Simulation Studio graph contract. Canvas positions travel with the file
// for human readability, while Rust receives the canonical block order,
// numerical parameters, typed connections and solver settings only.
export type EquationQuantity =
  | 'dimensionless' | 'fraction' | 'fraction-per-second'
  | 'voltage' | 'current' | 'power' | 'energy'
  | 'temperature' | 'temperature-rate' | 'heat' | 'speed' | 'torque';
export type EquationBlockType =
  | 'constant' | 'step' | 'gain' | 'sum' | 'product' | 'limit'
  | 'integrator' | 'first-order' | 'thermal-rate';
export type StudioMode = 'guided' | 'manual' | 'automatic';

export interface EquationBlockNode {
  id: string;
  type: EquationBlockType;
  name: string;
  outputQuantity: EquationQuantity;
  parameters: Record<string, number | EquationQuantity>;
  position: { x: number; y: number };
}

export interface EquationConnection {
  id: string;
  from: string;
  to: string;
  toPort: number;
}

export interface EquationSolverSettings {
  method: 'auto' | 'dormand-prince-45' | 'backward-euler';
  startS: number;
  endS: number;
  initialStepS: number;
  minStepS: number;
  maxStepS: number;
  relativeTolerance: number;
  absoluteTolerance: number;
  maxSteps: number;
  algebraicTolerance: number;
  algebraicMaxIterations: number;
  implicitTolerance: number;
  implicitMaxIterations: number;
}

export interface EquationAnalysisModule {
  id: string;
  type: 'runaway-propagation' | 'vent-sizing';
  enabled: boolean;
  parameters: Record<string, string | number | null>;
}

export interface SilExpectedValue {
  readonly outputPath: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
}

export interface SilTestCase {
  readonly id: string;
  readonly purpose: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly runOptions: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<SilExpectedValue>;
  readonly repeat: boolean;
}

export interface SilTestPlan {
  readonly schema: 'battery-design/sil-test-plan@2';
  readonly modelId: string;
  readonly modelVersion: string;
  readonly graphChecksum: string;
  readonly solver: string;
  readonly deterministicSeed: number;
  readonly cases: readonly SilTestCase[];
  readonly requiredCalculationTests: readonly string[];
  readonly checksum: string;
}

export interface SilTestChecks {
  readonly identity: boolean;
  readonly range: boolean;
  readonly unit: boolean;
  readonly repeatability: boolean;
}

export interface SilTestCaseResult {
  readonly id: string;
  readonly purpose: string;
  readonly status: 'pass' | 'fail';
  readonly actual?: unknown;
  readonly actualUnit?: string | null;
  readonly expected?: Readonly<SilExpectedValue>;
  readonly checks?: Readonly<SilTestChecks>;
  readonly error?: string;
}

export interface SilTestResult {
  readonly schema: 'battery-design/sil-test-result@1';
  readonly kind: 'software-in-the-loop';
  readonly status: 'pass' | 'fail';
  readonly planSchema: 'battery-design/sil-test-plan@2';
  readonly planChecksum: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly graphChecksum: string;
  readonly solver: string;
  readonly cases: readonly SilTestCaseResult[];
  readonly checksum: string;
}

export interface HilChannel {
  readonly id: string;
  readonly quantity: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly safeValue?: number;
}

export interface HilTestContract {
  readonly schema: 'battery-design/hil-test-contract@2';
  readonly targetId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly graphChecksum: string;
  readonly samplePeriodUs: number;
  readonly durationS: number;
  readonly inputs: readonly HilChannel[];
  readonly outputs: readonly HilChannel[];
  readonly overrun: Readonly<{ maxConsecutive: number; action: string }>;
  readonly requiredFaults: readonly string[];
  readonly status: 'contract-ready-hardware-run-required';
  readonly checksum: string;
}

export interface HilTestChecks {
  readonly identity: boolean;
  readonly timing: boolean;
  readonly io: boolean;
  readonly faults: boolean;
  readonly safeState: boolean;
  readonly overrun: boolean;
}

export interface HilTestResult {
  readonly schema: 'battery-design/hil-test-result@1';
  readonly kind: 'hardware-in-the-loop';
  readonly status: 'unproven' | 'pass' | 'fail';
  readonly contractSchema: 'battery-design/hil-test-contract@2';
  readonly contractChecksum: string;
  readonly targetId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly graphChecksum: string;
  readonly checks: Readonly<HilTestChecks> | null;
  readonly maxCycleTimeUs: number | null;
  readonly requiredCycleCount: number;
  readonly observedCycleCount: number;
  readonly samplePeriodUs: number;
  readonly headline: string;
  readonly checksum: string;
}

export interface EquationGraphDocument {
  schema: 'battery-design/equation-graph@1';
  catalogVersion: string;
  id: string;
  title: string;
  market: 'road' | 'grid';
  segment: GridCustomerSegment | null;
  mode: StudioMode;
  version: string;
  nodes: EquationBlockNode[];
  connections: EquationConnection[];
  analysisModules: EquationAnalysisModule[];
  settings: EquationSolverSettings;
  history: Array<Record<string, unknown>>;
}
