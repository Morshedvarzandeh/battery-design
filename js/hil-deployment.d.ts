import type { EquationGraphDocument, HilTestContract } from '../types/core.js';

export const HIL_DEPLOYMENT_SCHEMA: 'battery-design/hil-deployment-plan@1';
export const HIL_RUNTIME_ABI: 'battery-design/hil-runtime-abi@1';

export interface HilTargetProfile {
  readonly id: string;
  readonly platform: string;
  readonly architecture: string;
  readonly driverId: string;
  readonly clockId: string;
}

export interface HilRequestedChannelMapping {
  readonly channelId: string;
  readonly modelPortId: string;
  readonly physicalEndpoint: string;
}

export interface HilDeploymentInputChannel extends HilRequestedChannelMapping {
  readonly quantity: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
}

export interface HilDeploymentOutputChannel extends HilDeploymentInputChannel {
  readonly safeValue: number;
}

export type HilDeploymentFaultId =
  | 'sensor-open'
  | 'sensor-short'
  | 'sensor-stuck'
  | 'out-of-range'
  | 'communication-timeout'
  | 'target-overrun'
  | 'power-cycle'
  | 'emergency-safe-state';

type HilChannelFaultId = 'sensor-open' | 'sensor-short' | 'sensor-stuck' | 'out-of-range';
type HilSchedulerFaultId = 'target-overrun' | 'emergency-safe-state';

type HilChannelFaultRoute = {
  readonly [FaultId in HilChannelFaultId]: {
    readonly faultId: FaultId;
    readonly operation: FaultId;
    readonly injector: 'driver';
    readonly channelId: string;
  };
}[HilChannelFaultId];

type HilSchedulerFaultRoute = {
  readonly [FaultId in HilSchedulerFaultId]: {
    readonly faultId: FaultId;
    readonly operation: FaultId;
    readonly injector: 'scheduler';
    readonly channelId: null;
  };
}[HilSchedulerFaultId];

export type HilDeploymentFaultRoute =
  | HilChannelFaultRoute
  | {
    readonly faultId: 'communication-timeout';
    readonly operation: 'communication-timeout';
    readonly injector: 'driver';
    readonly channelId: null;
  }
  | HilSchedulerFaultRoute
  | {
    readonly faultId: 'power-cycle';
    readonly operation: 'power-cycle';
    readonly injector: 'platform';
    readonly channelId: null;
  };

export interface HilDeploymentSafetyRequest {
  readonly mode: 'latch-declared-safe-outputs';
  readonly trigger: 'overrun-limit-exceeded-or-runtime-failure';
}

export interface HilDeploymentSafety extends HilDeploymentSafetyRequest {
  readonly overrunMissesBeforeLatch: number;
}

export interface HilDeploymentPlanOptions {
  readonly contract: HilTestContract;
  readonly expectedContractChecksum: string;
  readonly graph: EquationGraphDocument;
  readonly target: HilTargetProfile;
  readonly channels: {
    readonly inputs: readonly HilRequestedChannelMapping[];
    readonly outputs: readonly HilRequestedChannelMapping[];
  };
  readonly faults: readonly HilDeploymentFaultRoute[];
  readonly safety: HilDeploymentSafetyRequest;
}

export interface HilDeploymentPlan {
  readonly schema: typeof HIL_DEPLOYMENT_SCHEMA;
  readonly runtimeAbi: typeof HIL_RUNTIME_ABI;
  readonly contractSchema: 'battery-design/hil-test-contract@2';
  readonly contractChecksum: string;
  readonly targetId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly graphChecksum: string;
  readonly graphArtifactSha256: string;
  readonly samplePeriodUs: number;
  readonly durationS: number;
  readonly target: Readonly<HilTargetProfile>;
  readonly channels: {
    readonly inputs: readonly Readonly<HilDeploymentInputChannel>[];
    readonly outputs: readonly Readonly<HilDeploymentOutputChannel>[];
  };
  readonly faults: readonly Readonly<HilDeploymentFaultRoute>[];
  readonly safeOutputs: readonly Readonly<{ channelId: string; value: number }>[];
  readonly safety: Readonly<HilDeploymentSafety>;
  readonly status: 'deployment-plan-ready-runtime-not-qualified';
  readonly checksum: string;
}

export function createHilDeploymentPlan(
  options: HilDeploymentPlanOptions,
): Readonly<HilDeploymentPlan>;

export function verifyHilDeploymentPlan(
  value: unknown,
  options?: { readonly expectedChecksum?: string },
): Readonly<HilDeploymentPlan>;
