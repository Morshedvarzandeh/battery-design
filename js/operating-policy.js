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

function normalize(p) {
  const peak = Math.max(...p.map(Math.abs), 1e-9);
  return p.map((v) => v / peak);
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
    apply: (d) => d.map((v) => v - 0.52),
  },
  {
    id: 'marine-boost', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Boost',
    description: 'Add battery power above the propulsion system’s continuous capability.',
    sizingFocus: 'Peak discharge power',
    apply: (d) => d.map((v) => v > 0.72 ? v - 0.72 : (v < 0.30 ? -(0.30 - v) * 0.7 : 0)),
  },
  {
    id: 'marine-spinning-reserve', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Spinning reserve',
    description: 'Hold the battery ready to take protected load immediately after a genset trip.',
    sizingFocus: 'Contingency power and reserve energy',
    // Reserve is an event, not a transform of normal demand. The reference
    // event stays here in the policy layer for that reason.
    reference: { dtS: 5, p: [...seg(0, 18), ...seg(1, 12), 0.85, 0.70, 0.55, ...seg(0.45, 24)] },
  },
  {
    id: 'marine-peak-shaving', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Peak shaving',
    description: 'Cover short demand peaks so another generator does not need to start or oversize.',
    sizingFocus: 'Short-duration peak power',
    apply: (d) => d.map((v) => v > 0.68 ? v - 0.68 : (v < 0.25 ? -(0.25 - v) * 0.45 : 0)),
  },
  {
    id: 'marine-load-smoothing', appId: 'marine', demandId: 'marine-vessel-duty',
    name: 'Load smoothing',
    description: 'Filter rapid fluctuations so the genset sees a steadier demand.',
    sizingFocus: 'Fast bidirectional power',
    reference: {
      dtS: 0.25,
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
    apply: (d) => {
      let generator = d[0];
      return d.map((v) => {
        generator += clamp(v - generator, -0.07, 0.07);
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
export function batteryProfileForPolicy(id, { demandProfile = null } = {}) {
  const policy = operatingPolicyById(id);
  if (!policy) return null;
  const demand = demandProfile || demandById(policy.demandId);
  const raw = policy.reference?.p || policy.apply?.(demand?.p || []);
  if (!raw?.length) return null;
  const sourceScaleFactor = Math.max(...raw.map(Math.abs), 1e-9);
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    family: 'operating-policy',
    kind: 'policy-output',
    policyId: policy.id,
    sourceProfileId: demand?.id || policy.demandId,
    sourceScaleFactor,
    dtS: policy.reference?.dtS || demand.dtS,
    note: `${policy.description} Sizing focus: ${policy.sizingFocus}. ${demandProfile ? 'Generated from the current mission inputs.' : 'Representative result; use measured demand for final engineering.'}`,
    p: normalize(raw),
  };
}

export const POLICY_PROFILES = OPERATING_POLICIES.map((p) => batteryProfileForPolicy(p.id));
