// marine-workspace.js — the dedicated Vessel Twin workspace contract.
//
// NTNU TwinShip is used here for the architecture it actually demonstrated:
// independently developed vessel, controller, thruster and power-plant models
// composed through FMI/SSP; recorded vessel data replayed against speed,
// heading and power predictions; and a path from design to operation and
// maintenance.  It is not treated as a downloadable production ship model.
//
// The browser ships a transparent battery/voyage SCREENING model.  A true
// digital twin requires an identified physical vessel, governed replay/live
// data, calibrated component models and separate validation evidence.  This
// module makes that difference queryable instead of burying it in a footnote.

import { VESSEL_MODELS, defaultVesselModel, vesselModelById } from './vessels.js';
import { maturityFromChecks } from './ontology.js';

export const TWINSHIP_REFERENCE = Object.freeze({
  project: 'MAROFF KPN: Digital Twins for Vessel Life Cycle Service (TwinShip)',
  projectUrl: 'https://intelligentsystemslab.org.ntnu.no/project/twinship.html',
  paper: 'Co-simulation as a Fundamental Technology for Twin Ships',
  paperUrl: 'https://www.mic-journal.no/PDF/2020/MIC-2020-4-2.pdf',
  statement: 'Architecture reference and research demonstrator; not a certified battery model or a complete live digital twin supplied by this project.',
});

export const TWIN_MATURITY = Object.freeze([
  Object.freeze({ id: 'screening', label: 'Screening model', requirement: 'Transparent class or published-point assumptions.' }),
  Object.freeze({ id: 'vessel-model', label: 'Vessel model', requirement: 'Identified vessel plus supplied resistance, shaft-power or DC-bus evidence.' }),
  Object.freeze({ id: 'calibrated', label: 'Calibrated model', requirement: 'A versioned, vessel-bound model artifact fitted against one governed trial.' }),
  Object.freeze({ id: 'validated', label: 'Validated model', requirement: 'Declared accuracy limits passed on a separate governed trial.' }),
  Object.freeze({ id: 'digital-twin', label: 'Digital twin', requirement: 'The validated artifact is bound to an evidenced physical asset and a current, representative replay that passes the governed residual limits.' }),
]);

// Same logical families as the Gunnerus case study, with the battery-specific
// component added.  "available" means the current repository can produce a
// result; it does not mean an FMU with vessel-grade fidelity is present.
export const TWINSHIP_COMPONENTS = Object.freeze([
  Object.freeze({ id: 'vessel-data', name: 'Vessel data / replay', role: 'source', implementation: 'customer-data', browser: 'import/review', desktop: 'replay/live adapter' }),
  Object.freeze({ id: 'speed-controller', name: 'Speed controller', role: 'control', implementation: 'external-model', browser: 'contract only', desktop: 'FMU required' }),
  Object.freeze({ id: 'heading-controller', name: 'Heading controller', role: 'control', implementation: 'external-model', browser: 'contract only', desktop: 'FMU required' }),
  Object.freeze({ id: 'thruster-drive', name: 'Thruster drives', role: 'propulsion', implementation: 'external-model', browser: 'rated-power boundary', desktop: 'FMU required' }),
  Object.freeze({ id: 'azimuth-thruster', name: 'Azimuth thrusters', role: 'hydrodynamics', implementation: 'external-model', browser: 'published rating only', desktop: 'FMU required' }),
  Object.freeze({ id: 'vessel-model', name: 'Vessel dynamics / hull', role: 'hydrodynamics', implementation: 'screening-model', browser: 'first-order mission', desktop: 'calibrated FMU required' }),
  Object.freeze({ id: 'power-plant', name: 'Power plant and PMS', role: 'electrical', implementation: 'screening-model', browser: 'seven policy studies', desktop: 'equipment model required' }),
  Object.freeze({ id: 'battery-pack', name: 'Battery pack, BMS and thermal model', role: 'electrical', implementation: 'available', browser: 'mission simulation', desktop: 'FMI 2.0 source FMU' }),
  Object.freeze({ id: 'observer', name: 'Prediction observer / residuals', role: 'diagnostics', implementation: 'available', browser: 'replay residuals', desktop: 'high-rate monitoring' }),
]);

export const TWINSHIP_CONNECTIONS = Object.freeze([
  Object.freeze({ from: 'vessel-data', to: 'speed-controller', signal: 'speed setpoint and measured speed' }),
  Object.freeze({ from: 'vessel-data', to: 'heading-controller', signal: 'heading setpoint and measured heading' }),
  Object.freeze({ from: 'speed-controller', to: 'thruster-drive', signal: 'force command' }),
  Object.freeze({ from: 'heading-controller', to: 'thruster-drive', signal: 'azimuth command' }),
  Object.freeze({ from: 'thruster-drive', to: 'azimuth-thruster', signal: 'shaft speed and angle' }),
  Object.freeze({ from: 'azimuth-thruster', to: 'vessel-model', signal: 'surge, sway and yaw force' }),
  Object.freeze({ from: 'vessel-model', to: 'observer', signal: 'predicted pose, course and speed' }),
  Object.freeze({ from: 'vessel-data', to: 'observer', signal: 'measured pose, course, speed and weather' }),
  Object.freeze({ from: 'power-plant', to: 'thruster-drive', signal: 'available electrical power' }),
  Object.freeze({ from: 'battery-pack', to: 'power-plant', signal: 'voltage, SoC, temperature and limits' }),
  Object.freeze({ from: 'power-plant', to: 'battery-pack', signal: 'battery current / power request' }),
]);

export const TWINSHIP_TOPOLOGY_BOUNDARY = Object.freeze({
  kind: 'logical-family-abstraction',
  logicalConnections: TWINSHIP_CONNECTIONS.length,
  publishedVariableConnections: 48,
  source: TWINSHIP_REFERENCE.paperUrl,
  note: 'These links show the battery-relevant component and signal families. They are not a reproduction of the paper\'s SSP graph or its 48 variable connections.',
});

export function twinShipArchitecture(vesselId = null) {
  const vessel = vesselModelById(vesselId) || defaultVesselModel();
  return {
    schema: 'battery-design/marine-twin@1',
    reference: TWINSHIP_REFERENCE,
    vessel: {
      id: vessel.id, name: vessel.name, segment: vessel.segment,
      dimensionsM: vessel.dimensionsM, evidence: vessel.evidence,
      boundary: vessel.boundary,
    },
    components: TWINSHIP_COMPONENTS.map((component) => ({ ...component })),
    connections: TWINSHIP_CONNECTIONS.map((connection) => ({ ...connection })),
    topologyBoundary: { ...TWINSHIP_TOPOLOGY_BOUNDARY },
  };
}

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;
const MODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const EARLIEST_EVIDENCE_MS = Date.parse('2000-01-01T00:00:00Z');
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_REPRESENTATIVE_SAMPLES = 10;
const MIN_REPRESENTATIVE_DURATION_S = 60;
const MIN_MODE_SAMPLES = 2;
const MAX_REPLAY_SPEED_KN = 100;
const MAX_REPLAY_ABS_POWER_W = 100_000_000;
const REPLAY_DATASET_FORMAT = 'battery-design/voyage-replay-dataset@1';
const REPLAY_SAMPLE_FIELDS = Object.freeze([
  'tS',
  'actualSpeedKn', 'predictedSpeedKn',
  'actualCourseDeg', 'predictedCourseDeg',
  'actualPowerW', 'predictedPowerW',
]);

// Small synchronous SHA-256 implementation so the same content-addressing
// contract runs in the browser and Node without trusting a platform-specific
// file hash. The digest covers only the governed replay schema, in a fixed
// field order, plus an optional operating-mode label.
const SHA256_WORDS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value, places) => (value >>> places) | (value << (32 - places));

function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + s1 + choose + SHA256_WORDS[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function canonicalReplayDataset(samples) {
  if (!Array.isArray(samples)) return null;
  return JSON.stringify({
    format: REPLAY_DATASET_FORMAT,
    samples: samples.map((sample) => [
      ...REPLAY_SAMPLE_FIELDS.map((field) => sample?.[field] ?? null),
      Object.hasOwn(sample || {}, 'operatingMode') ? sample.operatingMode : null,
    ]),
  });
}

/** SHA-256 of the exact replay fields consumed by assessVoyageReplay(). */
export function replayDatasetSha256(samples) {
  const canonical = canonicalReplayDataset(samples);
  return canonical == null ? null : sha256Hex(canonical);
}

const validId = (value) => hasText(value) && ID_PATTERN.test(value.trim());
const validModeId = (value) => hasText(value) && MODE_PATTERN.test(value.trim());
const validSha256 = (value) => hasText(value) && SHA256_PATTERN.test(value.trim());

function instant(value, nowMs, { maxAgeDays = null } = {}) {
  const match = hasText(value) ? ISO_INSTANT_PATTERN.exec(value.trim()) : null;
  if (!match) {
    return { pass: false, detail: 'Use a full ISO-8601 timestamp with timezone.' };
  }
  const [date, timeAndZone] = value.trim().split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, rawSecond] = timeAndZone.slice(0, 8).split(':').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
      || hour > 23 || minute > 59 || rawSecond > 59) {
    return { pass: false, detail: 'The timestamp contains an impossible calendar date or clock time.' };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < EARLIEST_EVIDENCE_MS) {
    return { pass: false, detail: 'The timestamp is invalid or predates this evidence contract.' };
  }
  if (ms > nowMs + FUTURE_CLOCK_SKEW_MS) {
    return { pass: false, detail: 'The timestamp is in the future beyond the five-minute clock allowance.' };
  }
  if (maxAgeDays != null && nowMs - ms > maxAgeDays * 86400000) {
    return { pass: false, detail: `The replay is older than its declared ${maxAgeDays}-day freshness window.` };
  }
  return { pass: true, ms, value: new Date(ms).toISOString() };
}

function assetEvidenceState(record, vesselId, nowMs) {
  const timestamp = instant(record?.issuedAt, nowMs);
  const pass = isObject(record)
    && validId(record.assetId)
    && record.vesselId === vesselId
    && validId(record.evidenceId)
    && validId(record.revision)
    && validSha256(record.sha256)
    && timestamp.pass;
  return {
    pass,
    detail: pass
      ? 'The asset registry evidence is content-addressed and bound to the selected vessel.'
      : `Provide assetEvidence with matching assetId/vesselId, evidenceId, revision, SHA-256 and issuedAt. ${timestamp.detail || ''}`.trim(),
  };
}

function modelEvidenceState(record, asset, vesselId) {
  const pass = isObject(record)
    && validId(record.artifactId)
    && hasText(record.version) && VERSION_PATTERN.test(record.version.trim())
    && validSha256(record.sha256)
    && record.vesselId === vesselId
    && validId(record.assetId) && record.assetId === asset?.assetId;
  return {
    pass,
    detail: pass
      ? 'The exact versioned model artifact is bound to the selected physical asset.'
      : 'Provide modelEvidence with a semantic version, artifactId, SHA-256, and matching vesselId/assetId.',
  };
}

function trialEvidenceState(record, { asset, model, vesselId, nowMs }) {
  const timestamp = instant(record?.completedAt, nowMs);
  const pass = isObject(record)
    && validId(record.trialId)
    && record.vesselId === vesselId
    && record.assetId === asset?.assetId
    && validSha256(record.datasetSha256)
    && record.modelArtifactSha256 === model?.sha256
    && timestamp.pass;
  return { pass, timestamp };
}

const METRIC_KEYS = Object.freeze(['speedRmsKn', 'courseRmsDeg', 'powerRmsFraction']);
const LIMIT_MAX = Object.freeze({ speedRmsKn: 10, courseRmsDeg: 180, powerRmsFraction: 1 });

function validationResultState(record) {
  if (!isObject(record) || record.result !== 'pass' || !isObject(record.metrics) || !isObject(record.limits)) {
    return { pass: false, detail: 'Validation must declare result="pass", numeric metrics and numeric acceptance limits.' };
  }
  for (const key of METRIC_KEYS) {
    const metric = record.metrics[key];
    const limit = record.limits[key];
    if (!Number.isFinite(metric) || metric < 0 || !Number.isFinite(limit) || limit <= 0 || limit > LIMIT_MAX[key]) {
      return { pass: false, detail: `Validation ${key} and its limit must be finite, non-negative engineering values within the supported range.` };
    }
    if (metric > limit) {
      return { pass: false, detail: `Validation ${key}=${metric} exceeds the declared limit ${limit}.` };
    }
  }
  return { pass: true, detail: 'All declared validation metrics are within their acceptance limits.' };
}

function replayDurationS(replay) {
  const rows = Array.isArray(replay?.rows) ? replay.rows : [];
  if (rows.length < 2 || rows.length !== replay.samples) return null;
  let previous = -Infinity;
  for (const row of rows) {
    if (!isObject(row) || !Number.isFinite(row.tS) || !(row.tS > previous)
        || ![row.speedKn, row.courseDeg, row.powerW, row.powerFraction].every(Number.isFinite)) return null;
    previous = row.tS;
  }
  return rows[rows.length - 1].tS - rows[0].tS;
}

function replayEvidenceState(record, replay, {
  asset, model, calibration, validation, vesselId, nowMs, samples, modeCoverage,
}) {
  const maxAgeDaysValid = Number.isInteger(record?.maxAgeDays)
    && record.maxAgeDays >= 1 && record.maxAgeDays <= 365;
  const timestamp = instant(record?.recordedAt, nowMs, {
    maxAgeDays: maxAgeDaysValid ? record.maxAgeDays : null,
  });
  const durationS = replayDurationS(replay);
  const declaredCoverage = Number.isInteger(record?.minSamples)
    && record.minSamples >= MIN_REPRESENTATIVE_SAMPLES
    && Number.isFinite(record?.minDurationS)
    && record.minDurationS >= MIN_REPRESENTATIVE_DURATION_S;
  const computedDatasetSha256 = replayDatasetSha256(samples);
  const declaredDatasetSha256 = validSha256(record?.datasetSha256)
    ? record.datasetSha256.toLowerCase() : null;
  const calibrationDatasetSha256 = validSha256(calibration?.datasetSha256)
    ? calibration.datasetSha256.toLowerCase() : null;
  const validationDatasetSha256 = validSha256(validation?.datasetSha256)
    ? validation.datasetSha256.toLowerCase() : null;
  const digestMatches = validSha256(record?.datasetSha256)
    && declaredDatasetSha256 === computedDatasetSha256;
  const bound = isObject(record)
    && validId(record.replayId)
    && record.vesselId === vesselId
    && record.assetId === asset?.assetId
    && digestMatches
    && declaredDatasetSha256 !== calibrationDatasetSha256
    && declaredDatasetSha256 !== validationDatasetSha256
    && record.modelArtifactSha256 === model?.sha256;
  const current = maxAgeDaysValid && timestamp.pass
    && validation?.completedAt && timestamp.ms >= Date.parse(validation.completedAt);
  const representative = bound && current && declaredCoverage
    && Number.isInteger(replay?.samples) && replay.samples >= record.minSamples
    && Number.isFinite(durationS) && durationS >= record.minDurationS
    && modeCoverage.pass;
  return {
    bound, current, representative, durationS, digestMatches, computedDatasetSha256,
    detail: representative
      ? 'The current replay digest matches its raw samples, meets its declared coverage, and is bound to this asset and model artifact.'
      : `Provide a replay whose declared SHA-256 matches the canonical raw samples, bound to this vessel, asset and model, recorded after validation, with maxAgeDays 1–365, at least ${MIN_REPRESENTATIVE_SAMPLES} samples and ${MIN_REPRESENTATIVE_DURATION_S} s coverage. ${timestamp.detail || ''}`.trim(),
  };
}

function replayOperatingModeState(samples) {
  if (!Array.isArray(samples)) return { applicable: false, pass: true, modes: [], detail: 'No raw replay samples were supplied.' };
  const applicable = samples.some((sample) => isObject(sample) && Object.hasOwn(sample, 'operatingMode'));
  if (!applicable) {
    return { applicable: false, pass: true, modes: [], detail: 'The replay does not expose an operating-mode channel.' };
  }
  if (!samples.every((sample) => isObject(sample) && validModeId(sample.operatingMode))) {
    return { applicable: true, pass: false, modes: [], detail: 'When one sample exposes operatingMode, every sample must carry a valid operating-mode id.' };
  }
  const coverage = new Map();
  for (const sample of samples) {
    const mode = sample.operatingMode.trim();
    const current = coverage.get(mode) || { samples: 0, durationS: 0 };
    current.samples++;
    coverage.set(mode, current);
  }
  for (let index = 1; index < samples.length; index++) {
    const prior = samples[index - 1], sample = samples[index];
    if (prior.operatingMode.trim() === sample.operatingMode.trim()
        && Number.isFinite(prior.tS) && Number.isFinite(sample.tS) && sample.tS > prior.tS) {
      coverage.get(sample.operatingMode.trim()).durationS += sample.tS - prior.tS;
    }
  }
  const modes = [...coverage.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, values]) => ({ id, ...values }));
  const pass = modes.every((mode) => mode.samples >= MIN_MODE_SAMPLES && mode.durationS > 0);
  return {
    applicable: true, pass, modes,
    detail: pass
      ? `Every exposed operating mode has at least ${MIN_MODE_SAMPLES} samples and a positive observed duration.`
      : `Every exposed operating mode needs at least ${MIN_MODE_SAMPLES} samples and a positive same-mode duration.`,
  };
}

function replayCoherenceState(replay) {
  const durationS = replayDurationS(replay);
  const thresholdsValid = isObject(replay?.thresholds)
    && replayThresholdState(replay.thresholds, replay?.samples).pass;
  const clean = replay?.status === 'within-declared-thresholds'
    && Array.isArray(replay?.alarms) && replay.alarms.length === 0
    && Array.isArray(replay?.diagnostics) && replay.diagnostics.length === 0;
  return {
    pass: thresholdsValid && clean && Number.isFinite(durationS),
    detail: thresholdsValid && clean
      ? 'The representative replay is coherent with the declared residual thresholds.'
      : 'Replay is missing, invalid, under review, or inconsistent with its declared residual thresholds.',
  };
}

/**
 * Grade a vessel model against content-addressed, mutually bound evidence.
 * `options.nowMs` exists only to make freshness checks deterministic in tests;
 * callers should normally let the function use the current system clock.
 */
export function twinReadiness(input = {}, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const selected = vesselModelById(input.vesselId);
  const vessel = selected || defaultVesselModel();
  const asset = input.assetEvidence;
  const model = input.modelEvidence;
  const calibration = input.calibrationEvidence;
  const validation = input.validationEvidence;
  // Public trust boundary: never accept a caller-authored replay verdict.
  // Status, residuals and energy are always recomputed from the raw samples.
  const replay = assessVoyageReplay(input.replaySamples, input.replayOptions);
  const modeCoverage = replayOperatingModeState(input.replaySamples);

  const assetState = assetEvidenceState(asset, vessel.id, nowMs);
  const modelState = modelEvidenceState(model, asset, vessel.id);
  const calibrationState = trialEvidenceState(calibration, { asset, model, vesselId: vessel.id, nowMs });
  const validationTrialState = trialEvidenceState(validation, { asset, model, vesselId: vessel.id, nowMs });
  const independentValidation = validationTrialState.pass && calibrationState.pass
    && validation.trialId !== calibration.trialId
    && validation.datasetSha256 !== calibration.datasetSha256
    && validationTrialState.timestamp.ms > calibrationState.timestamp.ms;
  const validationResult = validationResultState(validation);
  const replayState = replayEvidenceState(input.replayEvidence, replay, {
    asset, model, calibration, validation, vesselId: vessel.id, nowMs,
    samples: input.replaySamples, modeCoverage,
  });
  const coherence = replayCoherenceState(replay);

  const checks = [
    { id: 'identified-vessel', pass: !!selected, label: 'Identified vessel model', detail: selected ? 'The selected vessel id is in the governed vessel catalog.' : 'Select a governed vessel id; fallback geometry is not identity evidence.' },
    { id: 'power-basis', pass: ['dc-bus-trace', 'shaft-power-curve', 'resistance-curve'].includes(input.powerBasis), label: 'Measured or supplied vessel power basis', detail: 'Declare the measured DC-bus trace, shaft-power curve or resistance curve used by the model.' },
    { id: 'asset-binding', pass: assetState.pass, label: 'Vessel-bound physical asset evidence', detail: assetState.detail },
    { id: 'model-version', pass: modelState.pass, label: 'Versioned, content-addressed model artifact', detail: modelState.detail },
    { id: 'calibration-trial', pass: calibrationState.pass, label: 'Governed calibration trial', detail: calibrationState.pass ? 'Calibration data are bound to this vessel, asset and model artifact.' : 'Provide a governed calibration record with distinct data SHA-256 and completion time.' },
    { id: 'validation-trial', pass: independentValidation, label: 'Independent validation trial', detail: independentValidation ? 'Validation uses later, separately content-addressed data.' : 'Validation must use a later trial and a different dataset from calibration.' },
    { id: 'validation-result', pass: validationResult.pass, label: 'Validation metrics within declared limits', detail: validationResult.detail },
    { id: 'current-data', pass: replayState.current, label: 'Current replay/live data', detail: replayState.detail },
    { id: 'replay-content-address', pass: replayState.digestMatches, label: 'Replay digest bound to raw samples', detail: replayState.digestMatches ? 'The declared replay SHA-256 matches the canonical raw sample dataset.' : 'Recompute datasetSha256 from the unmodified raw replay samples.' },
    { id: 'replay-representative', pass: replayState.representative, label: 'Representative vessel replay evidence', detail: replayState.detail },
    { id: 'replay-mode-coverage', pass: modeCoverage.pass, label: 'Representative operating-mode coverage', detail: modeCoverage.detail },
    { id: 'replay-coherent', pass: coherence.pass, label: 'Replay within governed residual thresholds', detail: coherence.detail },
  ];
  const passed = Object.fromEntries(checks.map((check) => [check.id, check.pass]));
  const maturityEvaluation = maturityFromChecks('twinShip', passed);
  const maturity = maturityEvaluation.id;
  const level = TWIN_MATURITY.find((entry) => entry.id === maturity);
  return {
    vessel: { id: vessel.id, name: vessel.name },
    maturity, label: level.label, maturityScheme: maturityEvaluation.scheme,
    checks,
    missing: checks.filter((check) => !check.pass).map((check) => check.label),
    evidence: {
      asset: assetState.pass ? { assetId: asset.assetId, vesselId: asset.vesselId, evidenceId: asset.evidenceId, revision: asset.revision, sha256: asset.sha256, issuedAt: asset.issuedAt } : null,
      model: modelState.pass ? { artifactId: model.artifactId, version: model.version, sha256: model.sha256 } : null,
      calibration: calibrationState.pass ? { trialId: calibration.trialId, datasetSha256: calibration.datasetSha256, completedAt: calibration.completedAt } : null,
      validation: independentValidation ? { trialId: validation.trialId, datasetSha256: validation.datasetSha256, completedAt: validation.completedAt, result: validation.result, metrics: { ...validation.metrics }, limits: { ...validation.limits } } : null,
      replay: replayState.bound ? { replayId: input.replayEvidence.replayId, datasetSha256: input.replayEvidence.datasetSha256, recordedAt: input.replayEvidence.recordedAt, maxAgeDays: input.replayEvidence.maxAgeDays, minSamples: input.replayEvidence.minSamples, minDurationS: input.replayEvidence.minDurationS } : null,
    },
    replay: {
      status: replay?.status || 'unproven', samples: replay?.samples || 0,
      durationS: replayState.durationS, representative: replayState.representative,
      coherent: coherence.pass, datasetDigestVerified: replayState.digestMatches,
      operatingModes: modeCoverage.modes,
    },
    statement: maturity === 'digital-twin'
      ? 'The bound evidence, independent validation result and current representative replay satisfy this software contract for a governed vessel twin; evidence authenticity remains external, and class or safety approval remains separate.'
      : `${level.label}: ${level.requirement} Do not present this result as a live or validated vessel digital twin.`,
  };
}

const angleResidual = (actual, predicted) => {
  const raw = ((actual - predicted + 540) % 360) - 180;
  return raw === -180 ? 180 : raw;
};

function stats(values) {
  if (!values.length) return { mean: null, meanAbs: null, rms: null, maxAbs: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanAbs = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
  const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  const maxAbs = values.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  return { mean, meanAbs, rms, maxAbs };
}

const DEFAULT_REPLAY_THRESHOLDS = Object.freeze({
  speedKn: 0.5,
  courseDeg: 10,
  powerFraction: 0.15,
  consecutive: 3,
});

function replayThresholdState(options = {}, sampleCount = null) {
  const validContainer = isObject(options);
  const source = validContainer ? options : {};
  const thresholds = {
    speedKn: source.speedKn ?? DEFAULT_REPLAY_THRESHOLDS.speedKn,
    courseDeg: source.courseDeg ?? DEFAULT_REPLAY_THRESHOLDS.courseDeg,
    powerFraction: source.powerFraction ?? DEFAULT_REPLAY_THRESHOLDS.powerFraction,
    consecutive: source.consecutive
      ?? (Number.isInteger(sampleCount)
        ? Math.min(DEFAULT_REPLAY_THRESHOLDS.consecutive, sampleCount)
        : DEFAULT_REPLAY_THRESHOLDS.consecutive),
  };
  const reasons = validContainer ? [] : ['threshold options must be an object'];
  if (!Number.isFinite(thresholds.speedKn) || thresholds.speedKn <= 0 || thresholds.speedKn > 10) {
    reasons.push('speedKn must be a finite number greater than 0 and no more than 10 kn');
  }
  if (!Number.isFinite(thresholds.courseDeg) || thresholds.courseDeg <= 0 || thresholds.courseDeg > 180) {
    reasons.push('courseDeg must be a finite number greater than 0 and no more than 180 degrees');
  }
  if (!Number.isFinite(thresholds.powerFraction)
      || thresholds.powerFraction <= 0 || thresholds.powerFraction > 1) {
    reasons.push('powerFraction must be a finite fraction greater than 0 and no more than 1');
  }
  if (!Number.isInteger(thresholds.consecutive) || thresholds.consecutive < 1
      || (Number.isInteger(sampleCount) && thresholds.consecutive > sampleCount)) {
    reasons.push('consecutive must be an integer from 1 through the supplied sample count');
  }
  return { pass: reasons.length === 0, thresholds, reasons };
}

/**
 * Compare recorded and predicted vessel outputs at already-aligned times.
 *
 * Samples are deliberately not auto-aligned or interpolated here: power must
 * not be interpolated casually because doing so can change energy.  A caller
 * has to provide one governed, common time base and gets an explicit refusal
 * when it does not.
 */
export function assessVoyageReplay(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { status: 'unproven', diagnostics: [{ code: 'replay.samples_required', severity: 'fail', detail: 'At least two aligned samples are required.' }] };
  }
  const thresholdState = replayThresholdState(options, samples.length);
  if (!thresholdState.pass) {
    return {
      status: 'invalid',
      diagnostics: [{
        code: 'replay.invalid_thresholds', severity: 'fail',
        detail: `Replay thresholds were refused: ${thresholdState.reasons.join('; ')}. Values are not coerced.`,
      }],
    };
  }
  const thresholds = thresholdState.thresholds;
  const diagnostics = [];
  const modeExposed = samples.some((sample) => isObject(sample) && Object.hasOwn(sample, 'operatingMode'));
  if (modeExposed && !samples.every((sample) => isObject(sample) && validModeId(sample.operatingMode))) {
    diagnostics.push({
      code: 'replay.invalid_operating_mode', severity: 'fail',
      detail: 'When operatingMode is exposed, every aligned sample must carry a valid operating-mode id.',
    });
  }
  let previous = -Infinity;
  for (let index = 0; index < samples.length; index++) {
    const sample = isObject(samples[index]) ? samples[index] : {};
    const values = [sample.tS, sample.actualSpeedKn, sample.predictedSpeedKn,
      sample.actualCourseDeg, sample.predictedCourseDeg, sample.actualPowerW, sample.predictedPowerW];
    if (!values.every(Number.isFinite)) diagnostics.push({
      code: 'replay.invalid_sample', severity: 'fail', index,
      detail: 'Time, speed, course and power must all be finite numbers on both sides.',
    });
    for (const field of ['actualSpeedKn', 'predictedSpeedKn']) {
      if (Number.isFinite(sample[field]) && (sample[field] < 0 || sample[field] > MAX_REPLAY_SPEED_KN)) diagnostics.push({
        code: 'replay.physical_range', severity: 'fail', index, field,
        detail: `${field} must be from 0 through ${MAX_REPLAY_SPEED_KN} kn.`,
      });
    }
    for (const field of ['actualCourseDeg', 'predictedCourseDeg']) {
      if (Number.isFinite(sample[field]) && (sample[field] < 0 || sample[field] >= 360)) diagnostics.push({
        code: 'replay.physical_range', severity: 'fail', index, field,
        detail: `${field} must use the [0, 360) degree course convention.`,
      });
    }
    for (const field of ['actualPowerW', 'predictedPowerW']) {
      if (Number.isFinite(sample[field]) && Math.abs(sample[field]) > MAX_REPLAY_ABS_POWER_W) diagnostics.push({
        code: 'replay.physical_range', severity: 'fail', index, field,
        detail: `${field} magnitude exceeds the supported ${MAX_REPLAY_ABS_POWER_W} W replay boundary.`,
      });
    }
    if (Number.isFinite(sample.tS) && sample.tS < 0) diagnostics.push({
      code: 'replay.negative_time', severity: 'fail', index,
      detail: 'Replay time must start at or after zero on its governed relative time base.',
    });
    if (Number.isFinite(sample.tS) && !(sample.tS > previous)) diagnostics.push({
      code: 'replay.time_not_increasing', severity: 'fail', index,
      detail: 'Replay timestamps must be strictly increasing on the shared time base.',
    });
    if (Number.isFinite(sample.tS)) previous = sample.tS;
  }
  if (diagnostics.length) return { status: 'invalid', diagnostics };

  const rows = samples.map((sample) => {
    const speedKn = sample.actualSpeedKn - sample.predictedSpeedKn;
    const courseDeg = angleResidual(sample.actualCourseDeg, sample.predictedCourseDeg);
    const powerW = sample.actualPowerW - sample.predictedPowerW;
    const powerFraction = Math.abs(powerW) / Math.max(Math.abs(sample.actualPowerW), 1);
    return { tS: sample.tS, speedKn, courseDeg, powerW, powerFraction };
  });
  const flags = rows.map((row) => ({
    speed: Math.abs(row.speedKn) > thresholds.speedKn,
    course: Math.abs(row.courseDeg) > thresholds.courseDeg,
    power: row.powerFraction > thresholds.powerFraction,
  }));
  const sustained = {};
  for (const key of ['speed', 'course', 'power']) {
    let run = 0;
    sustained[key] = false;
    for (const flag of flags) {
      run = flag[key] ? run + 1 : 0;
      if (run >= thresholds.consecutive) sustained[key] = true;
    }
  }
  const speed = stats(rows.map((row) => row.speedKn));
  const course = stats(rows.map((row) => row.courseDeg));
  const power = stats(rows.map((row) => row.powerW));
  const actualEnergyWh = samples.slice(1).reduce((sum, sample, index) => {
    const prior = samples[index];
    return sum + ((sample.actualPowerW + prior.actualPowerW) / 2) * (sample.tS - prior.tS) / 3600;
  }, 0);
  const predictedEnergyWh = samples.slice(1).reduce((sum, sample, index) => {
    const prior = samples[index];
    return sum + ((sample.predictedPowerW + prior.predictedPowerW) / 2) * (sample.tS - prior.tS) / 3600;
  }, 0);
  const alarms = Object.entries(sustained).filter(([, value]) => value).map(([signal]) => ({
    code: `replay.${signal}_residual_sustained`, severity: 'warn', signal,
    detail: `${signal} residual exceeded its declared threshold for at least ${thresholds.consecutive} consecutive samples. Inspect data quality, environmental forces and model calibration; this does not diagnose a component by itself.`,
  }));
  return {
    status: alarms.length ? 'review' : 'within-declared-thresholds',
    thresholds, samples: samples.length, rows,
    residuals: { speedKn: speed, courseDeg: course, powerW: power },
    energy: {
      actualWh: actualEnergyWh, predictedWh: predictedEnergyWh,
      differenceWh: actualEnergyWh - predictedEnergyWh,
    },
    alarms,
    diagnostics,
    limitation: 'Residuals are early-warning evidence, not fault isolation. A named failure requires a validated diagnostic model and physical inspection.',
  };
}

export { VESSEL_MODELS };
