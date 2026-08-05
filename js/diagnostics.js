// diagnostics.js — engineering guidance that turns measurements into the
// next useful model or monitoring action. It deliberately does not invent a
// health verdict from missing data and never appears in the quick-sizing UI.

import { needed } from './knowledge.js';

export const DIAGNOSTIC_SOURCES = Object.freeze({
  batteryDebugging: {
    title: 'How to debug your battery design',
    url: 'https://github.com/ionworks/how-to-debug-your-battery',
    use: 'measurement-led separation of OCV, instantaneous resistance and slower relaxation effects',
  },
  anomalyDetection: {
    title: 'TinyML anomaly-detection example',
    url: 'https://github.com/ShawnHymel/tinyml-example-anomaly-detection',
    use: 'normal-operation baselines, simple distance-based detection first, and autoencoders only when the dataset justifies them',
  },
});

const has = (measurements, id) => !!measurements?.[id];

// Ordered on purpose: fitting a slow RC branch before the OCV and ohmic step
// are credible merely lets one wrong parameter hide another.
export function batteryDiagnosticPlan({ measurements = {}, chemistry = null } = {}) {
  const stages = [
    {
      id: 'ocv',
      title: 'Establish the rested voltage baseline',
      ready: has(measurements, 'rest'),
      measurement: 'Low-rate charge/discharge data with rest periods across the intended SoC and temperature window.',
      parameters: ['OCV versus SoC and temperature', ...(chemistry === 'LFP' ? ['charge/discharge hysteresis'] : [])],
      why: 'Every later voltage loss is measured from this baseline.',
    },
    {
      id: 'ohmic',
      title: 'Fit the instantaneous voltage step',
      ready: has(measurements, 'pulse'),
      measurement: 'Current pulses with synchronized cell voltage and temperature at several SoC values.',
      parameters: ['R0', 'cold-temperature resistance rise', 'SoC resistance rise'],
      why: 'The immediate voltage change separates series resistance from slower polarization.',
    },
    {
      id: 'relaxation',
      title: 'Fit the relaxation tail',
      ready: has(measurements, 'relaxation'),
      measurement: 'Voltage recovery for seconds and minutes after each pulse.',
      parameters: ['fast RC branch', 'slow RC branch'],
      why: 'The advanced model uses RC states as observable proxies for polarization and diffusion-scale behaviour.',
    },
    {
      id: 'thermal',
      title: 'Close the thermal balance',
      ready: has(measurements, 'thermal'),
      measurement: 'Cell/module temperatures, ambient or coolant inlet temperature, flow and electrical duty.',
      parameters: ['heat capacity', 'cooling conductance', 'module conduction', 'current imbalance'],
      why: 'Temperature changes resistance and ageing, so an electrical fit at one temperature is not a thermal model.',
    },
    {
      id: 'aging',
      title: 'Validate life with repeated measurements',
      ready: has(measurements, 'aging'),
      measurement: 'Capacity and pulse-resistance checks repeated through calendar and cycling exposure.',
      parameters: ['capacity fade', 'resistance growth'],
      why: 'Warranty predictions require cell- and duty-specific ageing data, not class defaults.',
    },
  ];
  const next = stages.find((stage) => !stage.ready) || null;
  return {
    title: 'Battery model diagnostic ladder',
    status: next ? 'measurement-needed' : 'ready-to-calibrate',
    next,
    stages,
    modelBoundary: 'The shipped advanced model is an equivalent-circuit and lumped thermal model. Its slow RC state is a fitted proxy; it does not resolve electrochemical concentration, particle diffusion or plating.',
    source: DIAGNOSTIC_SOURCES.batteryDebugging,
  };
}

export function conditionMonitoringPlan({
  appId = null,
  baselineWindows = 0,
  operatingModes = [],
  samplingHz = null,
} = {}) {
  const applicable = !!appId && needed(appId, 'vibration');
  if (!applicable) {
    return {
      applicable: false,
      status: 'not-required',
      reason: 'The knowledge graph does not require vibration monitoring for this application.',
      source: DIAGNOSTIC_SOURCES.anomalyDetection,
    };
  }

  const modes = [...new Set((operatingModes || []).filter(Boolean))];
  const baselineReady = Number(baselineWindows) >= 100 && modes.length > 0;
  const autoencoderCandidate = Number(baselineWindows) >= 5000 && modes.length >= 2;
  return {
    applicable: true,
    status: baselineReady ? 'baseline-ready' : 'collect-baseline',
    detector: baselineReady ? 'Mahalanobis distance' : null,
    recommendation: baselineReady
      ? 'Start with a transparent Mahalanobis-distance detector and validate its false-alarm rate on every normal operating mode.'
      : 'Collect vibration from healthy equipment across every normal speed, load and environmental mode before enabling anomaly alerts.',
    features: ['RMS acceleration', 'peak-to-peak', 'crest factor', 'frequency-band energy'],
    inputs: {
      baselineWindows: Number(baselineWindows) || 0,
      operatingModes: modes,
      samplingHz: Number(samplingHz) || null,
    },
    autoencoder: autoencoderCandidate
      ? 'May be evaluated after the simple detector has a measured limitation and a held-out validation set exists.'
      : 'Not recommended yet; the normal-operation dataset is not broad enough to justify a neural model.',
    limitation: 'An anomaly score means the vibration differs from the healthy baseline. It does not identify root cause and is not a battery-safety trip signal.',
    privacy: 'Feature extraction can run locally at the edge; raw route or machine data need not leave the device.',
    source: DIAGNOSTIC_SOURCES.anomalyDetection,
  };
}

export function buildEngineeringDiagnostics({
  appId = null,
  chemistry = null,
  measurements = {},
  conditionMonitoring = {},
} = {}) {
  return {
    batteryModel: batteryDiagnosticPlan({ measurements, chemistry }),
    conditionMonitoring: conditionMonitoringPlan({ appId, ...conditionMonitoring }),
  };
}
