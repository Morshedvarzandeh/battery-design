import type {
  AdvancedModelParams,
  BatteryCell,
} from '../types/core.js';
import type {
  EcmTuningPlan,
  GovernedEcmTuningDataset,
} from './ecm-tuning.js';

export const ECM_TUNING_RESULT_FORMAT: 'battery-design/ecm-tuning-result@1';

export interface EcmTuningExecutionPolicy {
  readonly id: 'battery-design/ecm-tuning-execution';
  readonly version: '1.0.0';
  readonly optimizer: 'sim2-constrained-nelder-mead';
  readonly candidatePolicy: 'ordered-rc-v1';
  readonly calibrationGrid: 'versioned-deterministic-preprocessing';
  readonly validationGrid: 'original-full-rate-included-segments';
  readonly sensitivity: {
    readonly method: 'forward-or-backward-finite-difference-prediction-jacobian-with-deterministic-pivoted-mgs';
    readonly normalizedParameterStep: number;
    readonly minimumUsableNormalizedParameterStep: number;
    readonly minimumColumnRmsMvPerCell: number;
    readonly relativePivotRankTolerance: number;
    readonly maximumAbsoluteColumnCorrelation: number;
  };
  readonly numericalAcceptanceTolerance: number;
  readonly workAccounting: string;
  readonly adoption: 'caller-predeclared-plan-acceptance-only';
  readonly traceRetention: 'checksums-and-scalar-diagnostics-only';
  readonly checksum: string;
}

export const ECM_TUNING_EXECUTION_POLICY: Readonly<EcmTuningExecutionPolicy>;

export interface EcmTuningExecutionInput {
  plan: EcmTuningPlan;
  cell: BatteryCell;
  calibrationDatasets: GovernedEcmTuningDataset | readonly GovernedEcmTuningDataset[];
  validationDatasets: GovernedEcmTuningDataset | readonly GovernedEcmTuningDataset[];
}

export interface EcmTuningScalarMetric {
  readonly sampleCount: number;
  readonly rmse: number;
  readonly maxAbs: number;
  readonly meanBias: number;
  readonly unit: 'mV-per-cell' | 'degC';
}

export interface EcmTuningTrialScore {
  readonly id: string;
  readonly datasetChecksum: string;
  readonly trialContentChecksum: string;
  readonly sampleGrid: 'prepared-optimizer-grid' | 'original-full-rate';
  readonly voltage: EcmTuningScalarMetric;
  readonly temperature: EcmTuningScalarMetric | null;
  readonly segments: readonly {
    readonly segmentId: string;
    readonly mode: string;
    readonly sampleCount: number;
    readonly voltage: EcmTuningScalarMetric;
    readonly temperature: EcmTuningScalarMetric | null;
  }[];
}

export interface EcmTuningScoreSet {
  readonly sampleGrid: 'prepared-optimizer-grid' | 'original-full-rate';
  readonly perTrial: readonly EcmTuningTrialScore[];
  readonly pooled: {
    readonly voltage: EcmTuningScalarMetric;
    readonly temperature: EcmTuningScalarMetric | null;
  };
  readonly checksum: string;
}

export interface EcmTuningSensitivityEvidence {
  readonly status: 'pass' | 'fail';
  readonly method: string;
  readonly predictionSampleCount: number;
  readonly probeEvaluations: number;
  readonly reservedProbeEvaluations: number;
  readonly parameterCount: number;
  readonly numericalRank: number;
  readonly requiredRank: number;
  readonly minimumColumnRmsMvPerCell: number;
  readonly minimumAllowedColumnRmsMvPerCell: number;
  readonly maximumAbsoluteColumnCorrelation: number;
  readonly maximumAllowedAbsoluteColumnCorrelation: number;
  readonly maximumCorrelationPair: readonly [string, string] | null;
  readonly pivotOrder: readonly (keyof AdvancedModelParams)[];
  readonly columns: readonly {
    readonly parameter: keyof AdvancedModelParams;
    readonly rmsMvPerCell: number;
    readonly direction: 'increase' | 'decrease' | null;
    readonly normalizedDelta: number | null;
    readonly absoluteParameterDelta: number | null;
    readonly probeStatus: 'evaluated' | 'unavailable';
  }[];
  readonly detail: string;
}

export interface EcmTuningCompletedStageEvidence {
  readonly id: string;
  readonly status: 'completed';
  readonly kind: 'group' | 'joint';
  readonly groups: readonly string[];
  readonly fit: readonly (keyof AdvancedModelParams)[];
  readonly calibrationTrialContentChecksums: readonly string[];
  readonly paramsBeforeChecksum: string;
  readonly paramsAfterChecksum: string;
  readonly sensitivity: EcmTuningSensitivityEvidence;
  readonly optimizer: {
    readonly terminationReason: string;
    readonly iterations: number;
    readonly proposalEvaluations: number;
    readonly uniqueEvaluations: number;
    readonly simulatedEvaluations: number;
    readonly cacheHitProposals: number;
    readonly rejectedConstraintProposals: number;
    readonly evaluationBudget: number;
    readonly temporalIntegrationSteps: number;
    readonly moduleWeightedIntegrationSteps: number;
    readonly workPerSimulatedCandidate: number;
    readonly moduleWeightedWorkPerSimulatedCandidate: number;
    readonly voltageRmseBeforeV: number;
    readonly voltageRmseAfterV: number;
    readonly improvementPct: number;
    readonly finalRcTimeConstantRatio: number;
    readonly minimumProposedRcTimeConstantRatio: number;
    readonly candidatePolicy: 'ordered-rc-v1';
  };
  readonly checksum: string;
}

export interface EcmTuningBlockedStageEvidence {
  readonly id: string;
  readonly status: 'blocked-sensitivity';
  readonly kind: 'group' | 'joint';
  readonly groups: readonly string[];
  readonly fit: readonly (keyof AdvancedModelParams)[];
  readonly calibrationTrialContentChecksums: readonly string[];
  readonly paramsBeforeChecksum: string;
  readonly paramsAfterChecksum: string;
  readonly sensitivity: EcmTuningSensitivityEvidence;
  readonly optimizer: null;
  readonly checksum: string;
}

export interface EcmTuningNotRunStageEvidence {
  readonly id: string;
  readonly status: 'not-run-after-sensitivity-failure';
  readonly fit: readonly (keyof AdvancedModelParams)[];
  readonly calibrationTrialContentChecksums: readonly string[];
  readonly checksum: string;
}

export type EcmTuningStageEvidence = EcmTuningCompletedStageEvidence
  | EcmTuningBlockedStageEvidence
  | EcmTuningNotRunStageEvidence;

export interface EcmTuningAcceptanceCheck {
  readonly id: string;
  readonly status: 'pass' | 'fail';
  readonly observed: unknown;
  readonly limit: unknown;
  readonly detail: string;
}

export interface EcmTuningCallerPolicyVerdict {
  readonly status: 'accepted' | 'rejected';
  readonly accepted: boolean;
  readonly authority: 'caller-predeclared-plan-acceptance';
  readonly acceptanceChecksum: string;
  readonly numericalTolerance: number;
  readonly checks: readonly EcmTuningAcceptanceCheck[];
  readonly checksum: string;
}

export interface EcmTuningResult {
  readonly format: typeof ECM_TUNING_RESULT_FORMAT;
  readonly executionPolicy: Readonly<EcmTuningExecutionPolicy>;
  readonly request: {
    readonly planChecksum: string;
    readonly executionPolicyChecksum: string;
    readonly cellChecksum: string;
    readonly calibrationTrialContentChecksums: readonly string[];
    readonly validationTrialContentChecksums: readonly string[];
  };
  readonly requestChecksum: string;
  readonly planChecksum: string;
  readonly cell: string;
  readonly cellChecksum: string;
  readonly initialParams: Readonly<AdvancedModelParams>;
  readonly initialParamsChecksum: string;
  readonly candidateParams: Readonly<AdvancedModelParams>;
  readonly candidateParamsChecksum: string;
  readonly adoptedParams: Readonly<AdvancedModelParams>;
  readonly adoptedParamsChecksum: string;
  readonly candidateConstraintEvidence: {
    readonly policy: 'ordered-rc-v1';
    readonly minimumRcTimeConstantRatio: 3;
    readonly initialRcTimeConstantRatio: number;
    readonly finalRcTimeConstantRatio: number;
    readonly minimumProposedRcTimeConstantRatio: number;
    readonly rejectedOptimizerProposals: number;
    readonly optimizerCacheHits: number;
    readonly everySimulatedCandidateEnforced: true;
  };
  readonly workPreflight: {
    readonly status: 'pass';
    readonly performedBeforeFirstSimulation: true;
    readonly fixedScoringWork: Readonly<Record<string, number>>;
    readonly projectedCeilings: Readonly<Record<string, number>>;
    readonly limits: Readonly<Record<string, number>>;
    readonly stages: readonly Readonly<Record<string, string | number>>[];
    readonly checksum: string;
  };
  readonly work: {
    readonly candidateEvaluations: number;
    readonly sensitivityProbeEvaluations: number;
    readonly optimizerProposalEvaluations: number;
    readonly rejectedOptimizerProposals: number;
    readonly optimizerCacheHits: number;
    readonly temporalIntegrationSteps: number;
    readonly moduleWeightedIntegrationSteps: number;
    readonly limits: Readonly<Record<string, number>>;
    readonly countersResetBetweenStages: false;
  };
  readonly stages: readonly EcmTuningStageEvidence[];
  readonly metrics: {
    readonly before: {
      readonly calibration: EcmTuningScoreSet;
      readonly validation: EcmTuningScoreSet;
      readonly checksum: string;
    };
    readonly after: {
      readonly calibration: EcmTuningScoreSet;
      readonly validation: EcmTuningScoreSet;
      readonly checksum: string;
    };
    readonly checksum: string;
  };
  readonly callerPolicyVerdict: EcmTuningCallerPolicyVerdict;
  readonly readiness: {
    readonly optimizerExecution: 'completed' | 'blocked-by-sensitivity';
    readonly validationRole: 'fixed-full-rate-score-only-never-an-optimizer-input';
    readonly numericalSensitivity: 'passed-for-every-stage' | 'failed-closed';
    readonly adoption: 'accepted' | 'rejected';
    readonly holdoutIndependenceClaim: string;
  };
  readonly checksum: string;
}

export function executeEcmTuning(input: EcmTuningExecutionInput): EcmTuningResult;
