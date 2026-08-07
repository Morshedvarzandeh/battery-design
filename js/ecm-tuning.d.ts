import type {
  AdvancedModelParams,
  BatteryCell,
  CalibrationDataset,
} from '../types/core.js';
import type { CalibrationPreprocessingEvidence } from './calibration-dataset.js';

export const ECM_TUNING_PLAN_FORMAT: 'battery-design/ecm-tuning-plan@1';
export const ECM_TUNING_ACCEPTANCE_FIELDS: readonly [
  'maxVoltageRmseMvPerCell',
  'maxVoltageMaxAbsMvPerCell',
  'maxTemperatureRmseC',
  'maxTemperatureMaxAbsC',
  'minValidationDatasets',
  'minIncludedSamplesPerDataset',
  'requiredModes',
  'requireNoHoldoutRegression',
  'requireNoFittedParameterAtBound',
];

export type EcmTuningGroupId =
  | 'ohmic'
  | 'fast-rc'
  | 'slow-rc'
  | 'soc-dependence'
  | 'arrhenius'
  | 'hysteresis';

export interface EcmTuningStrategyIdentity {
  readonly id: 'battery-design/staged-ecm-arrhenius';
  readonly version: '1.0.0';
  readonly optimizerExecution: 'not-in-plan';
  readonly modelOrder: string;
  readonly stageOrder: readonly string[];
  readonly checksum: string;
}

export interface EcmTuningAcceptancePolicy {
  readonly id: 'battery-design/ecm-tuning-acceptance';
  readonly version: '1.0.0';
  readonly calibrationRule: string;
  readonly validationRule: string;
  readonly excitationRule: string;
  readonly constraintRule: string;
  readonly workRule: string;
  readonly adoptionWithoutValidation: 'rejected';
  readonly rawTraceEvidence: string;
  readonly checksum: string;
}

export interface EcmTuningGatePolicy {
  readonly id: 'battery-design/ecm-tuning-excitation-gates';
  readonly version: '1.0.0';
  readonly restCurrentCRateMax: number;
  readonly minimumStepCRate: number;
  readonly minimumOhmicEdges: number;
  readonly maximumOcvResidualVPerCell: number;
  readonly maximumFastSampleTauFraction: number;
  readonly minimumFastPulseTauMultiples: number;
  readonly minimumFastRestTauMultiples: number;
  readonly maximumSlowSampleTauFraction: number;
  readonly minimumSlowPulseTauMultiples: number;
  readonly minimumSlowRestTauMultiples: number;
  readonly minimumRcTimeConstantSeparationRatio: number;
  readonly minimumSocBasisBins: number;
  readonly minimumSocBasisSpan: number;
  readonly maximumMidSocBasis: number;
  readonly minimumExtremeSocBasis: number;
  readonly minimumAmbientPoints: number;
  readonly minimumAmbientSpanK: number;
  readonly referenceTemperatureToleranceK: number;
  readonly requiredArrheniusTemperatureLocation: 'cell-average';
  readonly maximumIsothermalDepartureK: number;
  readonly minimumHysteresisSocOverlap: number;
  readonly minimumHysteresisStateExcursion: number;
  readonly checksum: string;
}

export const ECM_TUNING_STRATEGY: EcmTuningStrategyIdentity;
export const ECM_TUNING_ACCEPTANCE_POLICY: EcmTuningAcceptancePolicy;
export const ECM_TUNING_GATE_POLICY: EcmTuningGatePolicy;
export const ECM_TUNING_GROUP_CONTRACT_CHECKSUM: string;
export const ECM_TUNING_GROUPS: readonly {
  readonly id: EcmTuningGroupId;
  readonly parameters: readonly (keyof AdvancedModelParams)[];
  readonly requiredForCore: boolean;
  readonly description: string;
}[];

export type GovernedEcmTuningDataset = CalibrationDataset & {
  readonly source: CalibrationDataset['source'] & {
    readonly tool: string;
    readonly toolVersion: string;
    readonly model: string;
    readonly runId: string;
  };
};

export interface EcmTuningPlanInput {
  cell: BatteryCell;
  calibrationDatasets: GovernedEcmTuningDataset | readonly GovernedEcmTuningDataset[];
  validationDatasets: GovernedEcmTuningDataset | readonly GovernedEcmTuningDataset[];
  params?: Partial<AdvancedModelParams> | null;
  groups?: 'auto' | readonly EcmTuningGroupId[];
  maxEvaluations?: number;
  maxIntegrationSteps?: number;
  maxModuleWeightedIntegrationSteps?: number;
  /** Deterministic post-preprocessing sample ceiling, not a raw-dataset size limit. */
  maxSamplesPerDataset?: number;
  acceptance: EcmTuningAcceptanceThresholds;
}

export interface EcmTuningAcceptanceThresholdBase {
  maxVoltageRmseMvPerCell: number;
  maxVoltageMaxAbsMvPerCell: number;
  minValidationDatasets: number;
  minIncludedSamplesPerDataset: number;
  requiredModes: readonly CalibrationDataset['segments'][number]['mode'][];
  requireNoHoldoutRegression: true;
  requireNoFittedParameterAtBound: true;
}

export type EcmTuningAcceptanceThresholds = EcmTuningAcceptanceThresholdBase & (
  | { maxTemperatureRmseC: null; maxTemperatureMaxAbsC: null }
  | { maxTemperatureRmseC: number; maxTemperatureMaxAbsC: number }
);

export interface EcmTuningGateEvidence {
  readonly id: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
  readonly metrics: Readonly<Record<string, unknown>>;
}

export interface EcmTuningTrialEvidence {
  readonly id: string;
  readonly purpose: 'calibration' | 'validation';
  readonly datasetChecksum: string;
  readonly observationChecksum: string;
  readonly trialContentChecksum: string;
  readonly electricalHistoryChecksum: string;
  readonly scoredElectricalObservationChecksum: string;
  readonly preparedElectricalObservationChecksum: string;
  readonly rawSha256: string;
  readonly sourceIdentityChecksum: string;
  readonly samples: number;
  readonly samplePeriodS: number;
  readonly preprocessing: Readonly<Pick<CalibrationPreprocessingEvidence,
    | 'method'
    | 'factor'
    | 'usedSamples'
    | 'usedSamplePeriodS'
    | 'usedIncludedSamples'
    | 'mixedBoundaryBlocks'
    | 'droppedTailSamples'> & {
      readonly policyChecksum: string;
      readonly representedModes: readonly CalibrationDataset['segments'][number]['mode'][];
    }>;
  readonly binding: CalibrationDataset['binding'];
  readonly protocolChecksums: {
    readonly varyingStartSoC: string;
    readonly varyingAmbientC: string;
  };
  readonly metrics: Readonly<Record<string, unknown>>;
}

export interface EcmTuningRequestEvidence {
  readonly strategyChecksum: string;
  readonly acceptancePolicyChecksum: string;
  readonly acceptanceChecksum: string;
  readonly gatePolicyChecksum: string;
  readonly groupContractChecksum: string;
  readonly preprocessingPolicyChecksum: string;
  readonly cell: string;
  readonly cellChecksum: string;
  readonly initialParamsChecksum: string;
  readonly requestedGroups: 'auto' | readonly EcmTuningGroupId[];
  readonly calibrationIdentities: readonly Readonly<Record<string, string>>[];
  readonly validationIdentities: readonly Readonly<Record<string, string>>[];
  readonly maxEvaluations: number;
  readonly maxIntegrationSteps: number;
  readonly maxModuleWeightedIntegrationSteps: number;
  readonly maxSamplesPerDataset: number;
}

export interface EcmTuningBudgets {
  readonly maxEvaluations: number;
  readonly allocatedEvaluations: number;
  readonly reservedSensitivityProbeEvaluations: number;
  readonly reservedInitialSimplexEvaluations: number;
  readonly reservedPreflightEvaluations: number;
  readonly maxIntegrationSteps: number;
  readonly allocatedIntegrationSteps: number;
  readonly maxModuleWeightedIntegrationSteps: number;
  readonly allocatedModuleWeightedIntegrationSteps: number;
  readonly maxPreprocessedSamplesPerDataset: number;
  readonly allocationPolicy: string;
}

export interface EcmTuningReadiness {
  readonly optimizerExecution: 'not-started';
  readonly structuralPlanReady: true;
  readonly executionReady: false;
  readonly workPreflight: 'required-before-first-candidate';
  readonly preprocessing: 'executor-must-deterministically-limit-each-dataset-to-maxPreprocessedSamplesPerDataset';
  readonly coverageQualification: 'protocol-gates-passed-for-planned-groups';
  readonly numericalSensitivity: 'required-before-fit-activation';
  readonly candidateConstraintEnforcement: 'required-during-every-stage-and-final-adoption';
  readonly identifiabilityClaim: 'not-established-by-this-plan';
  readonly holdoutIndependenceClaim: 'not-established; exact-disjoint caller declarations only';
  readonly acceptanceEligibility: 'pending-executor-preflight-and-fixed-parameter-holdout-evaluation';
  readonly activeGroups: readonly EcmTuningGroupId[];
  readonly skippedGroups: readonly { readonly id: EcmTuningGroupId; readonly reasons: readonly string[] }[];
  readonly blockedGroups: readonly { readonly id: EcmTuningGroupId; readonly reasons: readonly string[] }[];
}

export interface EcmTuningPlan {
  readonly format: typeof ECM_TUNING_PLAN_FORMAT;
  readonly strategy: EcmTuningStrategyIdentity;
  readonly acceptancePolicy: EcmTuningAcceptancePolicy;
  readonly acceptance: Readonly<EcmTuningAcceptanceThresholds>;
  readonly acceptanceChecksum: string;
  readonly gatePolicy: EcmTuningGatePolicy;
  readonly preprocessingPolicy: Readonly<Record<string, string>>;
  readonly groupContractChecksum: string;
  readonly request: Readonly<EcmTuningRequestEvidence>;
  readonly requestChecksum: string;
  readonly cell: string;
  readonly cellChecksum: string;
  readonly topology: {
    readonly seriesCells: number;
    readonly parallelCells: number;
    readonly moduleCount: number;
  };
  readonly initialParams: Readonly<AdvancedModelParams>;
  readonly initialParamsChecksum: string;
  readonly candidateConstraints: Readonly<{
    rcTimeConstantOrdering: Readonly<{
      rule: 'rc2TauS-must-remain-at-least-minimumRatio-times-rc1TauS';
      minimumRatio: number;
      enforcement: 'required-for-every-stage-candidate-and-final-adoption';
    }>;
  }>;
  readonly trials: {
    readonly calibration: readonly EcmTuningTrialEvidence[];
    readonly validation: readonly EcmTuningTrialEvidence[];
    readonly splitPolicy: 'whole-trial-only';
    readonly leakagePolicy: 'reject-shared-observation-trial-content-raw-or-preprocessed-scored-electrical-raw-source-or-declared-source-run-identity';
    readonly independenceLimit: string;
  };
  readonly groups: readonly {
    readonly id: EcmTuningGroupId;
    readonly parameters: readonly (keyof AdvancedModelParams)[];
    readonly requiredForCore: boolean;
    readonly description: string;
    readonly requested: boolean;
    readonly status: 'active' | 'skipped' | 'blocked' | 'not-requested';
    readonly qualification: 'protocol-coverage-only; numerical-sensitivity-pending' | 'not-qualified';
    readonly gates: readonly EcmTuningGateEvidence[];
    readonly reasons: readonly string[];
    readonly calibrationTrialContentChecksums: readonly string[];
  }[];
  readonly stages: readonly {
    readonly id: EcmTuningGroupId | 'joint-refinement';
    readonly kind: 'group' | 'joint';
    readonly groups: readonly EcmTuningGroupId[];
    readonly fit: readonly (keyof AdvancedModelParams)[];
    readonly calibrationTrialContentChecksums: readonly string[];
    readonly sensitivityProbeEvaluations: number;
    readonly initialSimplexEvaluations: number;
    readonly minimumEvaluationReservation: number;
    readonly evaluationBudget: number;
    readonly integrationStepBudget: number;
    readonly moduleWeightedIntegrationStepBudget: number;
  }[];
  readonly budgets: Readonly<EcmTuningBudgets>;
  readonly readiness: Readonly<EcmTuningReadiness>;
  readonly checksum: string;
}

export function planEcmTuning(input: EcmTuningPlanInput): EcmTuningPlan;
