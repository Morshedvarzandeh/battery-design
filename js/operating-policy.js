// operating-policy.js — supervisory control choices that turn external
// demand into the battery power trace used for sizing.
//
// A load profile says what the site, vessel or route demands. An operating
// policy says which part of that demand the battery handles. Keeping the two
// separate prevents "peak shaving" from pretending to be a measured load
// profile while still giving the sizing and simulation engines the same
// small, plain profile object they already consume.

const seg = (value, count) => Array(count).fill(value);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const OPERATING_POLICY_MODEL_VERSION = '2026.08.1';

const screeningEvidence = (releaseRequirement) => Object.freeze({
  kind: 'provisional-engineering-assumption',
  status: 'unverified',
  source: 'Repository screening default; no vessel-specific commissioned PMS settings were supplied.',
  releaseRequirement,
});

const parameterModel = (basis, definitions, releaseRequirement) => Object.freeze({
  version: OPERATING_POLICY_MODEL_VERSION,
  basis,
  evidence: screeningEvidence(releaseRequirement),
  definitions: Object.freeze(Object.fromEntries(Object.entries(definitions).map(([key, value]) => [
    key, Object.freeze(value),
  ]))),
});

// Public and versioned: these numbers used to be anonymous literals inside
// map callbacks. They are normalized screening assumptions, not commissioned
// PMS set-points, and every generated profile carries the resolved values.
export const POLICY_PARAMETER_MODELS = Object.freeze({
  'marine-load-levelling': parameterModel(
    'The generator baseline is a fraction of the source demand profile peak; battery power is demand minus that fixed normalized baseline.',
    { baselineFraction: { value: 0.52, min: 0, max: 1, unit: 'fraction-of-source-peak' } },
    'Replace baselineFraction with the approved generator loading set-point and validate it against the vessel power plant.',
  ),
  'marine-boost': parameterModel(
    'Discharge and charge thresholds are fractions of the source demand profile peak. Charge gain scales the low-demand recharge request.',
    {
      dischargeThresholdFraction: { value: 0.72, min: 0, max: 1, unit: 'fraction-of-source-peak' },
      chargeThresholdFraction: { value: 0.30, min: 0, max: 1, unit: 'fraction-of-source-peak' },
      chargeGain: { value: 0.70, min: 0, max: 1, unit: 'ratio' },
    },
    'Replace thresholds and charge gain with approved propulsion, generator and battery limits before control release.',
  ),
  'marine-peak-shaving': parameterModel(
    'The battery discharges above and recharges below thresholds expressed as fractions of normalized source-demand peak; charge gain scales the low-demand recharge request.',
    {
      dischargeThresholdFraction: { value: 0.68, min: 0, max: 1, unit: 'fraction-of-source-peak' },
      chargeThresholdFraction: { value: 0.25, min: 0, max: 1, unit: 'fraction-of-source-peak' },
      chargeGain: { value: 0.45, min: 0, max: 1, unit: 'ratio' },
    },
    'Replace thresholds and charge gain with the approved generator-start and battery-dispatch settings.',
  ),
  'marine-ramp-support': parameterModel(
    'Generator response is limited per elapsed second as a fraction of source-profile peak; the 0.007/s default preserves the former 0.07 step on the 10 s reference demand.',
    { generatorRampFractionPerSecond: { value: 0.007, min: 0.0001, max: 1, unit: 'fraction-of-source-peak-per-second' } },
    'Replace the ramp rate with measured or supplier-declared generator response and validate the resulting battery transient.',
  ),
  'marine-spinning-reserve': parameterModel(
    'The declared duration time-scales a versioned contingency-event template; it is independent of normal voyage duration.',
    { eventDurationS: { value: 285, min: 30, max: 3600, unit: 's' } },
    'Replace the reference event with the approved protected-load list, trip sequence and reserve-duration requirement.',
  ),
  'marine-load-smoothing': parameterModel(
    'The declared duration tiles a versioned fast-fluctuation template without changing its 0.25 s sample period.',
    { eventDurationS: { value: 8, min: 1, max: 600, unit: 's' } },
    'Replace the reference event with measured high-rate bus or shaft-power data and the approved filtering target.',
  ),
});

function normalize(p) {
  const peak = Math.max(...p.map(Math.abs), 1e-9);
  return p.map((v) => v / peak);
}

function resolveParameters(policy, overrides) {
  if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
    throw new TypeError('Operating-policy parameters must be an object.');
  }
  const supplied = overrides || {};
  const model = policy.parameterModel || null;
  const definitions = model?.definitions || {};
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const unknown = Object.keys(supplied).filter((key) => !hasOwn(definitions, key));
  if (unknown.length) {
    throw new RangeError(`${policy.id} does not define parameter(s): ${unknown.join(', ')}.`);
  }
  const resolved = {};
  for (const [key, definition] of Object.entries(definitions)) {
    const value = hasOwn(supplied, key) ? supplied[key] : definition.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`${policy.id} ${key} must be a finite number.`);
    }
    if (value < definition.min || value > definition.max) {
      throw new RangeError(`${policy.id} ${key} must be between ${definition.min} and ${definition.max}.`);
    }
    resolved[key] = value;
  }
  return resolved;
}

function referenceTrace(reference, parameters) {
  const durationS = parameters.eventDurationS;
  const sampleCount = durationS / reference.dtS;
  if (!Number.isInteger(sampleCount)) {
    throw new RangeError(`${reference.id} eventDurationS must be a multiple of its ${reference.dtS} s sample period.`);
  }
  const count = Math.max(4, sampleCount);
  if (reference.durationMode === 'tile') {
    return Array.from({ length: count }, (_, index) => reference.p[index % reference.p.length]);
  }
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = count === 1
      ? 0
      : Math.round(index * (reference.p.length - 1) / (count - 1));
    return reference.p[sourceIndex];
  });
}

// Representative external demand. These are deliberately separate from the
// generated battery traces below. Measured customer data can replace either
// trace later without changing the policy or sizing interfaces.
export const POLICY_DEMANDS = [
  {
    id: 'marine-vessel-duty',
    name: 'Representative vessel demand',
    dtS: 10,
    note: 'Representative propulsion and auxiliary demand before PMS dispatch. Replace with measured vessel demand for final sizing.',
    p: [
      ...seg(0.18, 6), 0.35, 0.55, 0.75, 1.00, ...seg(0.92, 12),
      0.75, 0.50, ...seg(0.28, 9), 0.40, 0.55, ...seg(0.62, 12),
    ],
  },
  {
    id: 'grid-site-net-day',
    name: 'Representative site net demand',
    dtS: 3600,
    note: 'Representative site demand minus local generation before EMS dispatch. Negative midday values indicate surplus generation.',
    p: [
      0.22, 0.18, 0.16, 0.15, 0.18, 0.28, 0.45, 0.62,
      0.48, 0.20, -0.20, -0.55, -0.70, -0.62, -0.38, -0.10,
      0.30, 0.65, 0.92, 1.00, 0.86, 0.62, 0.42, 0.30,
    ],
  },
];

const demandById = (id) => POLICY_DEMANDS.find((d) => d.id === id) || null;

export const OPERATING_POLICIES = [
  {
    id: 'marine-full-electric', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Full electric',
    description: 'The battery supplies propulsion and onboard demand for the electric operating period.',
    sizingFocus: 'Energy and sustained power',
    apply: (d) => d,
  },
  {
    id: 'marine-load-levelling', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Load levelling',
    description: 'Keep the genset near a steady load; the battery handles the difference.',
    sizingFocus: 'Energy throughput and bidirectional power',
    parameterModel: POLICY_PARAMETER_MODELS['marine-load-levelling'],
    apply: (d, p) => d.map((v) => v - p.baselineFraction),
  },
  {
    id: 'marine-boost', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Boost',
    description: 'Add battery power above the propulsion system’s continuous capability.',
    sizingFocus: 'Peak discharge power',
    parameterModel: POLICY_PARAMETER_MODELS['marine-boost'],
    apply: (d, p) => d.map((v) => (v > p.dischargeThresholdFraction
      ? v - p.dischargeThresholdFraction
      : (v < p.chargeThresholdFraction ? -(p.chargeThresholdFraction - v) * p.chargeGain : 0))),
  },
  {
    id: 'marine-spinning-reserve', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Spinning reserve',
    description: 'Hold the battery ready to take protected load immediately after a genset trip.',
    sizingFocus: 'Contingency power and reserve energy',
    parameterModel: POLICY_PARAMETER_MODELS['marine-spinning-reserve'],
    // Reserve is an event, not a transform of normal demand. Its versioned
    // reference event remains separate and is never relabelled as a voyage.
    reference: {
      id: 'marine-spinning-reserve-event-v1',
      name: 'Versioned genset-trip reserve event',
      version: OPERATING_POLICY_MODEL_VERSION,
      dtS: 5,
      durationMode: 'scale',
      basis: 'A 90 s armed period, 60 s full takeover, 15 s transition and 120 s sustained tail form a provisional 285 s normalized reserve event.',
      evidence: POLICY_PARAMETER_MODELS['marine-spinning-reserve'].evidence,
      p: [...seg(0, 18), ...seg(1, 12), 0.85, 0.70, 0.55, ...seg(0.45, 24)],
    },
  },
  {
    id: 'marine-peak-shaving', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Peak shaving',
    description: 'Cover short demand peaks so another generator does not need to start or oversize.',
    sizingFocus: 'Short-duration peak power',
    parameterModel: POLICY_PARAMETER_MODELS['marine-peak-shaving'],
    apply: (d, p) => d.map((v) => (v > p.dischargeThresholdFraction
      ? v - p.dischargeThresholdFraction
      : (v < p.chargeThresholdFraction ? -(p.chargeThresholdFraction - v) * p.chargeGain : 0))),
  },
  {
    id: 'marine-load-smoothing', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Load smoothing',
    description: 'Filter rapid fluctuations so the genset sees a steadier demand.',
    sizingFocus: 'Fast bidirectional power',
    parameterModel: POLICY_PARAMETER_MODELS['marine-load-smoothing'],
    reference: {
      id: 'marine-load-smoothing-event-v1',
      name: 'Versioned high-rate fluctuation event',
      version: OPERATING_POLICY_MODEL_VERSION,
      dtS: 0.25,
      durationMode: 'tile',
      basis: 'An 8 s normalized bidirectional fluctuation template at 0.25 s resolution; it is a screening event, not measured Gunnerus or milliAmpere1 data.',
      evidence: POLICY_PARAMETER_MODELS['marine-load-smoothing'].evidence,
      p: [
        0.20, -0.35, 0.55, -0.50, 0.65, -0.30, 0.45, -0.70,
        0.80, -0.40, 1.00, -0.85, 0.45, -0.55, 0.70, -0.60,
        0.55, -0.45, 0.65, -0.55, 0.50, -0.35, 0.85, -0.30,
        0.75, -0.50, 0.65, -0.40, 0.55, -0.65, 0.70, -0.45,
      ],
    },
  },
  {
    id: 'marine-ramp-support', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Ramp support',
    description: 'Fill the genset response gap during fast demand changes.',
    sizingFocus: 'Ramp power and short energy bursts',
    parameterModel: POLICY_PARAMETER_MODELS['marine-ramp-support'],
    apply: (d, p, context) => {
      let generator = d[0];
      const maxStep = p.generatorRampFractionPerSecond * context.dtS;
      return d.map((v) => {
        generator += clamp(v - generator, -maxStep, maxStep);
        return v - generator;
      });
    },
  },
  {
    id: 'grid-self-consumption', appId: 'solar-ess', demandId: 'grid-site-net-day',
    name: 'Use more solar',
    description: 'Store local surplus and use it later instead of exporting and buying it back.',
    sizingFocus: 'Daily energy shifting',
    apply: (d) => d,
  },
  {
    id: 'grid-peak-shaving', appId: 'solar-ess', demandId: 'grid-site-net-day',
    name: 'Reduce peak demand',
    description: 'Discharge above the site limit and recharge from surplus or during low demand.',
    sizingFocus: 'Peak power and peak duration',
    apply: (d) => d.map((v) => v < 0 ? v : (v > 0.58 ? v - 0.58 : 0)),
  },
  {
    id: 'grid-load-shifting', appId: 'solar-ess', demandId: 'grid-site-net-day',
    name: 'Shift energy in time',
    description: 'Charge in the low-cost or surplus window and discharge in the high-cost window.',
    sizingFocus: 'Usable energy and charge window',
    apply: (d) => d.map((v, hour) => {
      if (hour >= 9 && hour <= 15) return -Math.max(0.25, -v);
      if (hour >= 17 && hour <= 21) return Math.max(0.35, v);
      return 0;
    }),
  },
];

export function operatingPolicyById(id) {
  return OPERATING_POLICIES.find((p) => p.id === id) || null;
}

// The boundary used by the sizing engine: regardless of how the policy is
// implemented, callers receive the same profile shape as measured data and
// vehicle physics. Positive = battery discharge; negative = charging.
export function batteryProfileForPolicy(id, { demandProfile = null, parameters = null } = {}) {
  const policy = operatingPolicyById(id);
  if (!policy) return null;
  const demand = demandProfile || demandById(policy.demandId);
  const resolvedParameters = resolveParameters(policy, parameters);
  const reference = policy.reference || null;
  const raw = reference
    ? referenceTrace(reference, resolvedParameters)
    : policy.apply?.(demand?.p || [], resolvedParameters, { dtS: demand?.dtS || 1 });
  if (!raw?.length) return null;
  const sourceScaleFactor = Math.max(...raw.map(Math.abs), 1e-9);
  const dtS = reference?.dtS || demand.dtS;
  const sourceProfileId = reference?.id || demand?.id || policy.demandId;
  const contextProfileId = reference ? (demand?.id || policy.demandId) : sourceProfileId;
  const traceBasis = reference ? 'versioned-reference-event' : 'demand-transform';
  const sourceStatement = reference
    ? `Generated from ${reference.name} (${reference.id}), not from the current mission. ${demandProfile ? `The supplied mission ${contextProfileId}` : `Representative demand ${contextProfileId}`} is context only and does not reshape this event unless its explicit eventDurationS parameter is changed.`
    : (demandProfile
      ? `Generated by applying the versioned policy to current mission demand ${sourceProfileId}.`
      : `Generated by applying the versioned policy to representative demand ${sourceProfileId}; use measured demand for final engineering.`);
  const parameterContract = policy.parameterModel ? {
    version: policy.parameterModel.version,
    basis: policy.parameterModel.basis,
    evidence: { ...policy.parameterModel.evidence },
    values: { ...resolvedParameters },
    units: Object.fromEntries(Object.entries(policy.parameterModel.definitions)
      .map(([key, definition]) => [key, definition.unit])),
  } : null;
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    family: 'operating-policy',
    kind: 'policy-output',
    policyId: policy.id,
    policyModelVersion: OPERATING_POLICY_MODEL_VERSION,
    traceBasis,
    sourceProfileId,
    contextProfileId,
    sourceScaleFactor,
    sourceDurationS: raw.length * dtS,
    dtS,
    parameters: { ...resolvedParameters },
    parameterContract,
    referenceEvent: reference ? {
      id: reference.id,
      name: reference.name,
      version: reference.version,
      basis: reference.basis,
      evidence: { ...reference.evidence },
      durationMode: reference.durationMode,
      durationS: raw.length * dtS,
    } : null,
    note: `${policy.description} Sizing focus: ${policy.sizingFocus}. ${sourceStatement}`,
    p: normalize(raw),
  };
}

export const POLICY_PROFILES = OPERATING_POLICIES.map((p) => batteryProfileForPolicy(p.id));
