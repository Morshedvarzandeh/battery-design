// api.js — the designer without a browser.
//
// Everything the tool knows lives in pure modules; only the panels needed a
// DOM. This file assembles those modules into ONE call that takes a design
// specification and returns the whole answer as plain data:
//
//   designFromSpec({ application: 'ev', energyWh: 60000, ... }) -> { ... }
//
// That single entry point is what makes the rest possible:
//  · the desktop runner can compute things a browser tab should not (sweeps,
//    long missions, many cells) — same modules, no rewrite, no drift;
//  · an AI agent can drive the designer over MCP without screen-scraping;
//  · the result is JSON, so it diffs, it stores, and it can be regenerated.
//
// Runs unchanged in a browser and in Node. No DOM, no filesystem, no network.

import { CELLS, cellById, provenance } from './cells.js';
import { clampPack, clampSteps } from './limits.js';
import { PRESETS } from './presets.js';
import { layoutPack, summarize, defaultArrangement } from './pack-engine.js';
import { costModel } from './optimizer.js';
import { analyze } from './engineering.js';
import { runChecks } from './standards.js';
import { buildArchitecture, DEFAULT_ROAD_ISOLATION_CONTEXT } from './architecture.js';
import { buildThermalSystem } from './btms.js';
import { buildSensorPlan } from './sensors.js';
import { buildChargingPlan } from './charging.js';
import { v2xPlan } from './v2x.js';
import { shortCircuitStudy } from './shortcircuit.js';
import { prechargeStudy, shuntStudy, fastProtectionStudy } from './electrical-protection.js';
import { simulateMission, compareCells } from './sim1d.js';
import { profileForApp, profileById, profileStats } from './loadprofiles.js';
import { releaseChecklist, appClassOf } from './markets.js';
import { co2Model } from './report.js';
import {
  batteryCategoryForApplication, EU_BATTERY_PASSPORT_EFFECTIVE_DATE, euChecks,
} from './eurules.js';
import {
  appNeeds, needed, primarySizingDecision, sizingOptionsFor, defaultSizingOption, sizingInputsForApp,
} from './knowledge.js';
import {
  COMPONENTS, COMPONENT_CATEGORIES, DEFAULTS_BY_FORM, componentById,
} from './components.js';
import {
  vehicleDefaultsFor, traceForApp, driveCyclePower, rangeKm, massShare, modeComparison,
} from './vehicle.js';
import { buildRoute, routeToTrace, validateRoute } from './route.js';
import { batteryProfileForPolicy, operatingPolicyById } from './operating-policy.js';
import { marineDuty } from './marine.js';
import {
  VESSEL_MODELS, assessVoyageReplay, twinReadiness, twinShipArchitecture,
} from './marine-workspace.js';
import { flightDuty } from './flight.js';
import { roundTripPlan } from './efficiency.js';
import { buildEngineeringDiagnostics } from './diagnostics.js';
import {
  buildArchitectureSemanticGraph, buildDesignSemanticGraph, describeOntology, querySemanticGraph,
  semanticDigest, semanticGraphSummary, toJsonLd, toNeo4jProjection, traceSemanticPath,
} from './ontology.js';

export const API_VERSION = '1.3';

// What a specification may contain. Everything except `application` has a
// defensible default, so the smallest useful call is one field.
export const SPEC_FIELDS = {
  application: 'preset id — see listApplications()',
  cell: 'cell id (default: the preset\'s first preferred chemistry match)',
  s: 'cells in series (default: derived from the preset\'s typical voltage)',
  p: 'cells in parallel (default: derived from the energy target)',
  energyWh: 'energy target used to derive p when s/p are not given',
  market: 'eu | us | cn | intl (default eu)',
  batteryCategory: 'Regulation (EU) 2023/1542 category: ev | lmt | industrial | portable | sli; required when application identity does not determine EV/LMT',
  evaluationDate: `YYYY-MM-DD date for time-gated regulatory rules (deterministic default: ${EU_BATTERY_PASSPORT_EFFECTIVE_DATE})`,
  dod: 'usable depth of discharge, 0–1 (default 0.8)',
  cyclesPerYear: 'duty for the cost model (default: the preset\'s)',
  targetYears: 'service life for the cost model (default: the preset\'s)',
  ambientC: '[low, high] design ambient (default: the preset\'s)',
  v2xPolicy: 'off | v2l | v2h | v2g | v2v (default off)',
  isolationStandard: 'named UN R100 topology context: un-r100-separate-dc (default) | un-r100-separate-ac | un-r100-connected-ac-dc | un-r100-connected-ac-dc-protected (legacy aliases remain reproducible)',
  components: '{ busbar, spacer, vent, cooling, tim, housing } — component ids from listComponents(); anything omitted takes the default for the cell format',
  vehicle: 'overrides for the vehicle model: { curbKg, payloadKg, cd, frontalAreaM2, crr, driveEff, regenFrac, auxW }',
  driveMode: 'eco | normal | sport (default normal)',
  policyId: 'EMS/PMS operating policy id for applications that expose one; converted to a battery sizing profile',
  diagnostics: '{ rest, pulse, relaxation, thermal, aging } booleans describing available battery-model measurements',
  electricalProtection: '{ precharge, shunt, fast } supplier ratings, evidence and duty overrides for the HV startup/current-measurement protection studies',
  conditionMonitoring: '{ baselineWindows, operatingModes, samplingHz } for engineering vibration anomaly monitoring',
  vesselId: 'marine vessel model id — see listVessels(); top-level alias for marine.vesselId and ignored outside the marine application',
  marine: 'vessel mission and TwinShip inputs: voyage fields; governed shoreConnection equipment/evidence; twinEvidence { powerBasis, assetEvidence, modelEvidence, calibrationEvidence, validationEvidence, replayEvidence }; aligned replaySamples and replayOptions',
  twinShip: 'optional top-level alias: { readiness: { powerBasis, assetEvidence, modelEvidence, calibrationEvidence, validationEvidence, replayEvidence }, replay: { samples, options } }; evidence must be vessel/asset/model-bound and content-addressed, and raw evidence is never copied into output',
  flight: 'multirotor mission overrides: { emptyMassKg, payloadKg, rotorCount, rotorDiameterM, flightMinutes, cruiseSpeedMps, headwindMps, altitudeM, temperatureC, propulsiveEfficiency, auxiliaryW, hoverFraction }',
  efficiency: 'round-trip chain overrides: { chargeEff, batteryEff, dischargeEff, auxiliaryW, cycleHours }; all efficiencies are 0–1',
  gradePct: 'route gradient in percent (default 0)',
  route: '{ points: [{ lat, lon, eleM?, tS? }], name?, targetKph? } — local or client-supplied route for road sizing',
  profileId: 'battery/load profile id, or "vehicle" to derive it from vehicle physics (kept for backward compatibility)',
  profileTrace: 'governed custom battery/load trace: { id, name?, revision?, dtS, p, scaleW, note? }; p is normalized to ±1 and the resolved result is content-addressed',
  mission: '{ passes, startSoC, ambientC, charge: { mode, powerW, minutes } }',
  compareCellIds: 'cell ids to run against the same mission for comparison',
};

export function listApplications() {
  return PRESETS.map((p) => ({
    id: p.id, name: p.name, description: p.desc,
    class: appClassOf(p.id),
    typicalEnergyWh: p.typicalEnergyWh, typicalV: p.typicalV,
    contPowerW: p.contPowerW, peakPowerW: p.peakPowerW,
    preferredChemistries: p.preferredChemistries,
    concepts: appNeeds(p.id),
    sizing: {
      decision: primarySizingDecision(p.id),
      defaultPolicyId: defaultSizingOption(p.id, 'energy-policy'),
      policyIds: sizingOptionsFor(p.id, 'energy-policy'),
      driveModes: sizingOptionsFor(p.id, 'driving-mode'),
      profileIds: sizingOptionsFor(p.id, 'load-profile'),
      inputs: sizingInputsForApp(p.id),
    },
  }));
}

export function listCells({ chemistry = null, form = null } = {}) {
  return CELLS
    .filter((c) => (!chemistry || c.chemistry === chemistry) && (!form || c.form === form))
    .map((c) => {
      // Provenance is not decoration: an agent quoting these numbers has to be
      // able to say which are datasheet values and which were worked out.
      const prov = provenance(c);
      return {
        id: c.id, name: c.name, chemistry: c.chemistry, form: c.form,
        nominalV: c.nominalV, capacityAh: c.capacityAh, energyWh: c.nominalV * c.capacityAh,
        massG: c.massG, priceUSD: c.priceUSD, cycleLife: c.cycleLife,
        maxContDischargeA: c.maxContDischargeA, maxContChargeA: c.maxContChargeA,
        dataQuality: prov.label, dataBasis: prov.basis,
        estimatedFields: prov.inferredAll ? ['ALL'] : prov.inferred,
        sourceNote: prov.detail,
      };
    });
}

export function listComponents({ category = null, form = null } = {}) {
  return Object.entries(COMPONENTS)
    .filter(([cat]) => !category || cat === category)
    .flatMap(([cat, list]) => list
      .filter((c) => !form || c.forms.includes(form))
      .map((c) => ({
        id: c.id, category: cat, name: c.name, kind: c.kind, forms: c.forms,
        suppliers: c.suppliers, dataQuality: c.dataQuality,
        defaultFor: Object.entries(DEFAULTS_BY_FORM)
          .filter(([, d]) => d[cat] === c.id).map(([f]) => f),
      })));
}

// The named marine models are discoverable without shipping their complete
// renderer geometry through every software client. Published facts stay
// separate from provisional mission inputs, and the evidence boundary travels
// with each choice.
export function listVessels() {
  return VESSEL_MODELS.map((vessel) => ({
    id: vessel.id,
    name: vessel.name,
    shortName: vessel.shortName,
    segment: vessel.segment,
    description: vessel.description,
    dimensionsM: vessel.dimensionsM,
    published: vessel.published,
    missionDefaults: vessel.missionDefaults,
    policyId: vessel.policyId,
    mounting: vessel.mounting,
    evidence: vessel.evidence,
    boundary: vessel.boundary,
  }));
}

// Evidence may change a readiness verdict, but raw trials and physical-asset
// identifiers do not belong in the portable design specification returned by
// the API.  The evaluated TwinShip result below carries boolean checks,
// maturity and residual summaries; callers retain their governed source data.
function portableSpec(spec) {
  // Semantic claims are outputs of the governed ontology builder.  Keeping
  // caller-supplied lookalikes in the portable spec would let an input such
  // as `{ semantics: { conforms: true } }` masquerade as evaluated evidence.
  const {
    twinShip: _privateTwinShip,
    profileTrace: _privateProfileTrace,
    ontology: _callerOntology,
    semantics: _callerSemantics,
    ...portable
  } = spec;
  if (portable.marine && typeof portable.marine === 'object' && !Array.isArray(portable.marine)) {
    const {
      twinEvidence: _privateTwinEvidence,
      replaySamples: _privateReplaySamples,
      ...marine
    } = portable.marine;
    portable.marine = marine;
  }
  return portable;
}

function portableTwinReadiness(readiness) {
  if (!readiness) return readiness;
  const { evidence, ...summary } = readiness;
  const assetBindingDigest = evidence?.asset ? semanticDigest({
    assetId: evidence.asset.assetId,
    vesselId: evidence.asset.vesselId,
  }) : null;
  const modelBindingDigest = evidence?.model && assetBindingDigest ? semanticDigest({
    assetBindingDigest,
    artifactId: evidence.model.artifactId,
    version: evidence.model.version,
    sha256: evidence.model.sha256,
  }) : null;
  // These controlled identifiers and timestamps are release metadata, not
  // physical-asset identity. Preserve only the fields needed to validate the
  // evidence chain; raw asset/model ids, dataset hashes and measurements stay
  // behind the portable boundary and are represented by opaque digests.
  const safeMetadata = (kind, record, recordDigest) => {
    const metadata = {};
    if (kind === 'asset' && record.revision != null) metadata.revision = record.revision;
    if (kind === 'model' && record.version != null) metadata.revision = record.version;
    // Trial/replay identifiers can expose private project naming. Their
    // content digest is the portable, immutable record version instead.
    if (metadata.revision == null) metadata.revision = recordDigest;
    const issuedAt = record.issuedAt ?? record.completedAt ?? record.recordedAt ?? null;
    if (issuedAt != null) metadata.issuedAt = issuedAt;
    if (kind === 'validation' && record.result != null) metadata.result = record.result;
    if (kind === 'replay') metadata.result = summary.replay?.status || 'unproven';
    return metadata;
  };
  const safeEvidence = Object.fromEntries(Object.entries(evidence || {}).map(([kind, record]) => {
    if (!record) return [kind, null];
    const recordDigest = semanticDigest(record);
    return [kind, {
      recordDigest,
      assetBindingDigest,
      modelBindingDigest,
      ...safeMetadata(kind, record, recordDigest),
    }];
  }));
  const result = {
    ...summary,
    evidenceAccepted: evidence ? Object.fromEntries(
      Object.entries(evidence).map(([kind, record]) => [kind, record != null]),
    ) : {},
    evidenceBindings: safeEvidence,
  };
  return result;
}

// DEFAULTS_BY_FORM picks by cell FORMAT and knows nothing about scale, which
// is fine for the machines each part was catalogued from and wrong at the
// extremes. A 1.3 g wearable pouch cell and a 5 kg EV pouch cell are both
// "pouch", so the wearable was being fitted with a laser-welded pouch tab
// interconnect board at 25 g per cell — twenty times the mass of the cell it
// serves — and a pumped glycol cold plate. The 25 g figure is right for the
// EV modules that entry describes; applying it to a smartwatch is a category
// error in the picker, not a bad number in the database.
//
// Two rules catch it, both grounded rather than tuned:
//
//   HARDWARE THAT SERVES A CELL WEIGHS LESS THAN THE CELL. A busbar or holder
//   heavier than the cell it connects is from another weight class.
//
//   A PUMPED LOOP IS NOT A DEFAULT FOR A MACHINE THAT HAS NO LOOP. The
//   knowledge graph already says which applications carry one; it is asked
//   rather than second-guessed.
//
// Both apply ONLY to defaults. An explicitly requested part is always fitted:
// substituting what the customer asked for is the one thing worse than
// fitting something odd, because they would read the answer as their design.
// Returns null when the part suits this pack, or the reason it does not —
// the reason travels with the answer so the warning says which rule fired
// rather than guessing. A cold plate refused for needing a pump must not be
// reported as being too heavy for the cell.
function outOfScale(part, key, cell, appId) {
  if (!part) return 'no part';
  if (['busbar', 'spacer'].includes(key) && part.massGPerCell != null && cell.massG != null
      && part.massGPerCell > cell.massG) {
    return `it is catalogued at ${part.massGPerCell} g per cell, more than the ${cell.massG} g cell it would serve`;
  }
  if (key === 'cooling' && part.needsPump && !needed(appId, 'btms-loop')) {
    return 'it needs a pumped coolant loop, which this machine does not carry';
  }
  return null;
}

// What is actually fitted. Every category is defaulted from the cell format,
// and a spec may name any of them.
//
// Naming a part that does not exist — or one that is not made for this cell
// format — is reported rather than quietly ignored. The caller would
// otherwise read the answer as the pack they asked for, and a design whose
// cooling system was silently swapped is worse than one that refused.
function resolveComponents(cell, appId, spec, warnings) {
  const defaults = DEFAULTS_BY_FORM[cell.form] || {};
  const asked = spec.components && typeof spec.components === 'object' ? spec.components : {};
  const out = {};
  for (const { key } of COMPONENT_CATEGORIES) {
    const wanted = asked[key];
    let part = wanted ? componentById(key, wanted) : null;
    if (wanted && !part) {
      warnings.push(`Unknown ${key} "${wanted}" — fitting the default for a ${cell.form} cell instead. `
        + 'Use listComponents() for the real ids.');
    } else if (part && !part.forms.includes(cell.form)) {
      warnings.push(`${part.name} is not made for ${cell.form} cells — fitting the default ${key} instead.`);
      part = null;
    }
    if (part) { out[key] = part; continue; }                 // asked for, and real: fitted as asked

    let fallback = componentById(key, defaults[key]) || null;
    const why = fallback ? outOfScale(fallback, key, cell, appId) : null;
    if (why) {
      const alt = (COMPONENTS[key] || [])
        .filter((c) => c.forms.includes(cell.form) && !outOfScale(c, key, cell, appId))
        .sort((a, b) => (a.massGPerCell ?? 0) - (b.massGPerCell ?? 0))[0] || null;
      warnings.push(alt
        ? `${fallback.name} is the usual default for a ${cell.form} cell, but ${why} — fitting ${alt.name} instead. `
          + `Name a ${key} explicitly to override this.`
        : `No ${key} in the database suits this pack: the default is ruled out because ${why}, and every other `
          + `${cell.form} option is too. None is fitted, so its mass is missing — treat the pack mass as a floor.`);
      fallback = alt;
    }
    out[key] = fallback;
  }
  return out;
}

// Pick a cell the preset would actually accept, so a one-field spec still
// produces a sensible design instead of an arbitrary one.
// Prefer a cell that can answer the whole question: without a price AND a
// cycle life there is no cost per kWh delivered and no V2G wear floor, and a
// design whose economics are silently null is a worse default than a slightly
// different chemistry.
function defaultCellFor(preset) {
  const chems = preset.preferredChemistries || [];
  const complete = (c) => c.priceUSD != null && c.cycleLife != null;
  for (const chem of chems) {
    const hit = CELLS.find((c) => c.chemistry === chem && complete(c));
    if (hit) return hit;
  }
  for (const chem of chems) {
    const hit = CELLS.find((c) => c.chemistry === chem && c.priceUSD != null);
    if (hit) return hit;
  }
  return CELLS.find(complete) || CELLS[0];
}

function governedProfileTrace(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('profileTrace must be an object.');
  }
  const id = String(input.id || '').trim();
  if (!id) throw new RangeError('profileTrace.id must be a non-empty stable identifier.');
  const dtS = Number(input.dtS);
  const scaleW = Number(input.scaleW ?? input.uploadedPeakW);
  if (!(dtS > 0) || !Number.isFinite(dtS)) {
    throw new RangeError('profileTrace.dtS must be a positive finite number.');
  }
  if (!(scaleW > 0) || !Number.isFinite(scaleW)) {
    throw new RangeError('profileTrace.scaleW must be a positive finite number.');
  }
  if (!Array.isArray(input.p) || input.p.length < 2 || input.p.length > 500
      || input.p.some((value) => !Number.isFinite(value) || Math.abs(value) > 1 + 1e-9)) {
    throw new RangeError('profileTrace.p must contain 2–500 finite samples normalized to ±1.');
  }
  const revision = input.revision == null ? null : String(input.revision).trim() || null;
  return {
    profile: {
      id,
      name: String(input.name || id),
      family: 'custom-trace', kind: 'governed-custom-trace',
      policyId: null, sourceProfileId: id,
      dtS, p: [...input.p],
      note: String(input.note || 'Caller-supplied normalized trace; content identity is recorded in the resolved sizing contract.'),
      ...(revision ? { revision } : {}),
    },
    scaleW,
  };
}

function traceEnergyWindowWh(profile, scaleW) {
  let cumulativeWh = 0;
  let lowWh = 0;
  let highWh = 0;
  for (const fraction of profile?.p || []) {
    cumulativeWh += (fraction * scaleW * profile.dtS) / 3600;
    lowWh = Math.min(lowWh, cumulativeWh);
    highWh = Math.max(highWh, cumulativeWh);
  }
  return highWh - lowWh;
}

function traceIdentity(profile, scaleW) {
  if (!profile) return null;
  return {
    id: profile.id,
    checksum: semanticDigest({
      format: 'battery-power-trace/v1', id: profile.id,
      kind: profile.kind || 'duty', policyId: profile.policyId || null,
      sourceProfileId: profile.sourceProfileId || null,
      revision: profile.revision || null,
      dtS: profile.dtS, scaleW, p: profile.p,
    }),
  };
}

// One canonical marine sizing seam for browser, API and desktop consumers.
// It binds the selected vessel to its default PMS, applies that policy to the
// actual voyage (or a governed caller trace), and gives the pack-sizing energy
// as the cumulative trace excursion divided by usable DoD.
export function resolveMarineSizing(spec = {}) {
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('Marine sizing specification must be an object.');
  }
  const warnings = [];
  const marineSpec = spec.marine && typeof spec.marine === 'object' && !Array.isArray(spec.marine)
    ? spec.marine : {};
  const requestedVesselId = marineSpec.vesselId ?? spec.vesselId ?? null;
  if (requestedVesselId && !VESSEL_MODELS.some((vessel) => vessel.id === requestedVesselId)) {
    warnings.push(`Unknown vesselId "${requestedVesselId}" — using ${VESSEL_MODELS[0].id} instead. Use listVessels() for the real ids.`);
  }
  const {
    twinEvidence: _twinEvidence,
    replaySamples: _replaySamples,
    replayOptions: _replayOptions,
    ...marineDutyInput
  } = marineSpec;
  const marine = marineDuty({ ...marineDutyInput, vesselId: requestedVesselId });
  const allowedPolicies = sizingOptionsFor('marine', 'energy-policy');
  const profileIdPolicy = allowedPolicies.includes(spec.profileId) ? spec.profileId : null;
  let policyId = spec.policyId || profileIdPolicy || null;
  let rejectedPolicyId = null;
  if (policyId && !allowedPolicies.includes(policyId)) {
    rejectedPolicyId = policyId;
    policyId = null;
  }

  const custom = governedProfileTrace(spec.profileTrace);
  let sourceProfile = custom?.profile || null;
  let sourceScaleW = custom?.scaleW || null;
  if (!sourceProfile && spec.profileId && !profileIdPolicy) {
    const foreignPolicy = operatingPolicyById(spec.profileId);
    sourceProfile = foreignPolicy
      ? null
      : (spec.profileId === 'marine-physics' ? marine.profile : profileById(spec.profileId));
    if (foreignPolicy) {
      warnings.push(`Policy profile "${spec.profileId}" belongs to ${foreignPolicy.appId}, not marine; it was refused.`);
    } else if (!sourceProfile) {
      warnings.push(`Profile "${spec.profileId}" is not available; using the selected vessel PMS default instead.`);
    } else {
      sourceScaleW = marine.scaleW;
    }
  }

  if (rejectedPolicyId) {
    warnings.push(sourceProfile
      ? `Policy "${rejectedPolicyId}" is not available for marine; using profile "${sourceProfile.id}" without that policy.`
      : `Policy "${rejectedPolicyId}" is not available for marine; using the selected vessel default instead.`);
  }

  const vessel = VESSEL_MODELS.find((candidate) => candidate.id === marine.vessel.id);
  if (!policyId && !sourceProfile) policyId = vessel?.policyId || null;
  let profile;
  let scaleW;
  if (policyId) {
    const demandProfile = sourceProfile || marine.profile;
    const demandScaleW = sourceScaleW || marine.scaleW;
    profile = batteryProfileForPolicy(policyId, { demandProfile });
    scaleW = demandScaleW * (profile?.sourceScaleFactor || 1);
  } else {
    profile = sourceProfile || marine.profile;
    scaleW = sourceScaleW || marine.scaleW;
  }
  if (!profile) throw new RangeError('The selected marine policy did not produce a battery trace.');

  const energyWindowWh = traceEnergyWindowWh(profile, scaleW);
  const dod = Number.isFinite(spec.dod) && spec.dod > 0 ? spec.dod : 0.8;
  const identity = traceIdentity(profile, scaleW);
  const resolved = {
    marine,
    policyId: profile.policyId || policyId || null,
    profileId: profile.id,
    profile,
    scaleW,
    energyWindowWh,
    requiredEnergyWh: energyWindowWh / dod,
    traceIdentity: identity,
    warnings,
  };
  marine.policyId = resolved.policyId;
  marine.profileId = resolved.profileId;
  marine.traceIdentity = { ...identity };
  marine.energyWindowWh = energyWindowWh;
  marine.requiredPackEnergyWh = resolved.requiredEnergyWh;
  return resolved;
}

// Series/parallel from intent: series follows the voltage window, parallel
// follows the energy target. Exactly the arithmetic the UI does.
function deriveSP(cell, preset, spec, warnings) {
  const targetV = spec.nominalV ?? preset?.typicalV ?? 48;
  const targetWh = spec.energyWh ?? preset?.typicalEnergyWh ?? 1000;
  const targetS = spec.s ?? Math.max(1, Math.round(targetV / cell.nominalV));
  const perStringWh = targetV > 0 ? targetS * cell.nominalV * cell.capacityAh : 0;
  const wanted = {
    s: targetS,
    // An energy target is a minimum requirement. Whole-cell sizing therefore
    // rounds parallel strings up; rounding to nearest can undersize the
    // declared mission by almost half a string.
    p: spec.p ?? Math.max(1, Math.ceil(targetWh / (perStringWh || 1))),
  };
  // A pack cannot have half a cell or minus one. Clamping is right — doing it
  // silently is not, since the caller would read the answer as the design
  // they asked for. Unknown ids already say so; so does this.
  const s = Math.max(1, Math.round(wanted.s));
  const p = Math.max(1, Math.round(wanted.p));
  if (s !== wanted.s || p !== wanted.p) {
    warnings.push(`Series/parallel counts must be whole numbers of at least 1: `
      + `${wanted.s}S${wanted.p}P was corrected to ${s}S${p}P.`);
  }
  return { s, p };
}

/**
 * The geometry behind a finished design.
 *
 * designFromSpec deliberately does not return cell positions: a 250 kWh bus
 * is fifteen thousand of them, and every caller would carry that whether or
 * not it ever draws anything. This rebuilds them from the design's OWN
 * resolved spec — same cell, same counts, same space taken by the cooling
 * system it actually fitted — so a renderer never has to guess at an
 * arrangement or re-derive a gap and end up drawing a different pack from
 * the one the audit is about.
 */
export function layoutForDesign(design) {
  const r = design?.spec?.resolved;
  if (!r) return null;
  const cell = cellById(r.cell);
  if (!cell) return null;
  const space = componentById('cooling', r.components?.cooling)?.spaceMm
    || { bottom: 0, side: 0, rowGap: 0 };
  return layoutPack(cell, r.s, r.p, {
    arrangement: design.spec?.arrangement || defaultArrangement(cell),
    spacingMm: 1, wallMm: 2, headroomMm: 8,
    underMm: space.bottom, rowExtraMm: space.rowGap,
  });
}

/**
 * The series/parallel counts an application implies for a given cell.
 *
 * Exported so the panels can start from the same pack the headless engine
 * would build, rather than a second guess at the same arithmetic.
 */
export function suggestSP(cell, preset, spec = {}) {
  const { s, p } = deriveSP(cell, preset, spec, []);
  const bounded = clampPack(s, p);
  return { s: bounded.s, p: bounded.p };
}

/**
 * The whole designer in one call. Returns plain data — no classes, no DOM
 * nodes, nothing that cannot be JSON.stringify'd.
 */
export function designFromSpec(spec = {}) {
  // A null spec is a caller's mistake, not a reason to throw at them.
  if (spec == null || typeof spec !== 'object') spec = {};
  const warnings = [];
  if (Object.prototype.hasOwnProperty.call(spec, 'ontology')
      || Object.prototype.hasOwnProperty.call(spec, 'semantics')) {
    warnings.push('Caller-supplied ontology or semantics were ignored; semantic claims are generated and validated by the architecture ontology.');
  }
  const preset = PRESETS.find((p) => p.id === spec.application) || null;
  if (spec.application && !preset) {
    warnings.push(`Unknown application "${spec.application}" — falling back to generic defaults. Use listApplications() for the real ids.`);
  }
  const appId = preset?.id || 'custom';
  const cell = (spec.cell ? cellById(spec.cell) : null) || defaultCellFor(preset || { preferredChemistries: [] });
  if (spec.cell && !cellById(spec.cell)) {
    warnings.push(`Unknown cell "${spec.cell}" — using ${cell.id} instead. Use listCells() for the real ids.`);
  }
  const marineSizing = appId === 'marine' ? resolveMarineSizing(spec) : null;
  if (marineSizing) warnings.push(...marineSizing.warnings);
  // Series and parallel are independent choices. An explicit series count
  // must not suppress voyage-energy sizing of an omitted parallel count.
  const explicitMarineParallelTarget = marineSizing && (spec.p != null || spec.energyWh != null);
  const sizingSpec = marineSizing && !explicitMarineParallelTarget && marineSizing.requiredEnergyWh > 0
    ? { ...spec, energyWh: marineSizing.requiredEnergyWh }
    : spec;
  const derived = deriveSP(cell, preset, sizingSpec, warnings);
  // Guard rails before any geometry is attempted: a slipped keystroke must
  // not become ten billion cells and a frozen application.
  const bounded = clampPack(derived.s, derived.p);
  warnings.push(...bounded.notes);
  const { s, p } = bounded;
  const market = spec.market || 'eu';
  const dod = spec.dod ?? 0.8;
  const usageCtx = {
    cyclesPerYear: spec.cyclesPerYear ?? preset?.cyclesPerYear ?? null,
    targetYears: spec.targetYears ?? preset?.targetYears ?? null,
    dod,
  };
  const ambientC = spec.ambientC || preset?.envTempC || [0, 40];

  // 1 · Geometry and the pack itself.
  //
  // The parts are chosen BEFORE the box is sized, because some of them take
  // space: a bottom cold plate wants 10 mm under the cells and a serpentine
  // ribbon widens every row gap. Sizing the enclosure first and picking the
  // cooling afterwards produces a pack the cooling does not fit inside.
  const selection = resolveComponents(cell, appId, spec, warnings);
  const space = selection.cooling?.spaceMm || { bottom: 0, side: 0, rowGap: 0 };
  const arrangement = spec.arrangement || defaultArrangement(cell);
  const layout = layoutPack(cell, s, p, {
    arrangement, spacingMm: 1, wallMm: 2, headroomMm: 8,
    underMm: space.bottom, rowExtraMm: space.rowGap,
  });
  const summary = summarize(cell, s, p, layout);
  const marineTraceTargetMet = !marineSizing || explicitMarineParallelTarget
    ? null
    : summary.energyWh + 1e-9 >= marineSizing.requiredEnergyWh;
  if (marineSizing && !explicitMarineParallelTarget && !marineTraceTargetMet) {
    warnings.push(`Marine policy trace requires ${Math.ceil(marineSizing.requiredEnergyWh)} Wh, but the bounded pack provides ${Math.round(summary.energyWh)} Wh; automatic trace sizing is unmet.`);
  }
  const pack = {
    nominalV: summary.nominalV, vMax: summary.vMax, vMin: summary.vMin,
    capacityAh: summary.capacityAh, energyWh: summary.energyWh, massKg: summary.massKg,
    massCellsKg: summary.massCellsKg, cellCount: summary.cellCount,
    maxContCurrentA: summary.maxContCurrentA, maxContPowerW: summary.maxContPowerW,
    dcirMOhm: summary.dcirMOhm, dims: summary.dims, volumeL: summary.volumeL,
  };

  // Resolve the electrical-isolation context once, before any engineering
  // consumer runs. Standards, engineering, sensors and the architecture
  // report all receive this same governed result, so their findings cannot
  // drift because each inferred a different bus topology.
  const isolationStandard = spec.isolationStandard || DEFAULT_ROAD_ISOLATION_CONTEXT;
  const architecture = buildArchitecture({
    cell, s, p, summary, options: { appId, isolationStandard },
  });
  const isolationResolution = architecture.isolation || architecture.isolationReview || null;

  // 2 · The four engineering perspectives and the standards audit.
  const usage = {
    application: appId,
    contPowerW: preset?.contPowerW ?? null, peakPowerW: preset?.peakPowerW ?? null,
    chargeRateC: preset?.chargeRateC ?? null, envTempC: ambientC,
  };
  let analysis = null;
  try {
    analysis = analyze({
      cell, s, p, pack,
      layout: {
        arrangement, orientation: 'upright', spacingMm: 1, wallMm: 2,
        inner: layout.inner, outer: layout.outer, nx: layout.nx, ny: layout.ny, nz: layout.nz,
      },
      usage: usageCtx, selection, isolationResolution,
    });
  } catch (e) {
    warnings.push(`Engineering analysis unavailable: ${e.message}`);
  }

  // The mass the pack actually has, now that the parts are known.
  //
  // summarize() carries a placeholder — 8% on the cells for interconnect plus
  // an aluminium box — because it runs before anything has been chosen. Once
  // real busbars, holders, a cooling system and an enclosure are fitted, their
  // masses are known, so the placeholder is REPLACED rather than added to.
  // Everything downstream reads this figure: the lifting verdict, the range,
  // the mass share of the vehicle. It has to be one number, not two.
  const withParts = analysis?.totals?.packMassWithComponentsKg;
  if (withParts != null && withParts > 0) {
    summary.massKg = withParts;
    summary.whPerKg = summary.energyWh > 0 ? summary.energyWh / withParts : null;
    pack.massKg = withParts;
  }

  const stdCtx = {
    cell, s, p, pack,
    layout: { spacingMm: 1, arrangement, wallMm: 2 },
    usage, isolationResolution,
  };
  const findings = runChecks(stdCtx);

  // 3 · Architecture, thermal system, sensors.
  // UN R100 contains different topology cases, not competing values to
  // average. The product default is the ordinary separate DC traction-bus
  // context; a connected AC/DC topology must be selected explicitly. The
  // resolved architecture records that choice. Non-road applications receive
  // a review boundary, not this vehicle calculation.
  const thermal = buildThermalSystem({
    heatContW: analysis?.totals?.heatContW ?? null,
    ambientC, cooling: selection.cooling || null, cell, override: 'auto', appId,
  });
  const diagnostics = buildEngineeringDiagnostics({
    appId, chemistry: cell.chemistry,
    measurements: spec.diagnostics || {},
    conditionMonitoring: spec.conditionMonitoring || {},
  });
  const sensors = buildSensorPlan({
    cell, s, p, summary, partition: architecture.partition, bms: architecture.bms,
    therm: thermal, selection, conditionMonitoring: diagnostics.conditionMonitoring,
    isolationMonitoring: architecture.isolationMonitoring,
  });

  // 4 · The AC side, and what feeding power back would cost.
  const charging = buildChargingPlan({
    appId, marketId: market, energyWh: summary.energyWh,
    vNomV: summary.nominalV, cell, obcOverride: 'auto',
    shoreConnection: appId === 'marine' ? spec.marine?.shoreConnection : null,
  });
  const v2x = v2xPlan({
    appId, cell, cellCount: summary.cellCount, energyWh: summary.energyWh, dod,
    policy: spec.v2xPolicy || 'off',
    powerKW: charging.obc?.acKW ?? charging.packChargeKW ?? null,
  });

  // 4b · What happens when it fails: the fault study.
  const shortCircuit = shortCircuitStudy({
    cell, s, p, summary,
    busbarMOhm: spec.busbarMOhm ?? 0.5,
    contactorMOhm: spec.contactorMOhm ?? 0.2,
    fuseRatingA: spec.fuseRatingA ?? architecture.contactors?.fuseA ?? null,
    fuseI2t: spec.fuseI2t ?? null,
    contactorBreakingA: spec.contactorBreakingA ?? null,
    busbarAreaMm2: spec.busbarAreaMm2 ?? 50,
    busbarKind: spec.busbarKind ?? 'xlpe-insulated',
    linkFuseA: spec.linkFuseA ?? null,
  });

  // 4c · The HV startup and current-measurement protection chain. The
  // Sensata records are reference cases, not invisible approvals: an archived
  // shunt can reproduce its published electrical/thermal behavior while its
  // lifecycle diagnostic still prevents it becoming release hardware.
  const ep = spec.electricalProtection || {};
  const epPre = ep.precharge || {};
  const epShunt = ep.shunt || {};
  const epFast = ep.fast || {};
  const protectionApplies = summary.vMax > 60;
  const protectionContinuousA = epShunt.continuousA ?? summary.maxContCurrentA;
  const protectionPeakA = epShunt.peakA
    ?? Math.max(protectionContinuousA, (preset?.peakPowerW || summary.maxContPowerW) / Math.max(summary.vMin, 1));
  const protectionPeakS = epShunt.peakDurationS ?? 5;
  const protectionPrecharge = architecture.precharge ? prechargeStudy({
    supplyV: summary.vMax,
    capacitanceUF: epPre.capacitanceUF ?? architecture.precharge.linkCapUF,
    targetTimeS: epPre.targetTimeS ?? architecture.precharge.timeToCloseS,
    closeGapV: epPre.closeGapV ?? architecture.precharge.closeGapV,
    resistanceOhm: epPre.resistanceOhm ?? null,
    resistanceTolerancePct: epPre.resistanceTolerancePct ?? 5,
    loadCurrentA: epPre.loadCurrentA ?? 0,
    startsPerHour: epPre.startsPerHour ?? architecture.precharge.prechargesPerHour,
    designMarginPct: epPre.designMarginPct ?? 20,
    resistorVoltageRatingV: epPre.resistorVoltageRatingV ?? null,
    resistorPulseEnergyJ: epPre.resistorPulseEnergyJ ?? null,
    resistorPulsePowerW: epPre.resistorPulsePowerW ?? null,
    resistorContinuousPowerW: epPre.resistorContinuousPowerW ?? null,
    contactorId: epPre.contactorId ?? 'auto',
    contactorMakeA: epPre.contactorMakeA ?? null,
    contactorMechanicalCycles: epPre.contactorMechanicalCycles ?? null,
    supplierEvidence: epPre.supplierEvidence ?? null,
  }) : null;
  const shuntResistanceWasDefaulted = epShunt.referenceId == null && epShunt.resistanceUOhm == null;
  const protectionShunt = protectionApplies ? shuntStudy({
    referenceId: epShunt.referenceId ?? null,
    supplier: epShunt.supplier ?? null,
    resistanceUOhm: epShunt.resistanceUOhm ?? 18,
    resistanceTolerancePct: epShunt.resistanceTolerancePct ?? null,
    continuousRatingA: epShunt.continuousRatingA ?? null,
    peakRatingA: epShunt.peakRatingA ?? null,
    peakDurationRatingS: epShunt.peakDurationRatingS ?? null,
    conductorAreaMm2: epShunt.conductorAreaMm2 ?? null,
    maxOperatingC: epShunt.maxOperatingC ?? null,
    gainErrorPct: epShunt.gainErrorPct ?? null,
    offsetErrorA: epShunt.offsetErrorA ?? null,
    noiseErrorA: epShunt.noiseErrorA ?? null,
    thermalResistanceKPerW: epShunt.thermalResistanceKPerW ?? null,
    thermalTimeConstantS: epShunt.thermalTimeConstantS ?? null,
    ambientC: epShunt.ambientC ?? ambientC[1],
    continuousA: protectionContinuousA,
    peakA: protectionPeakA,
    peakDurationS: protectionPeakS,
    currentSegments: epShunt.currentSegments ?? null,
    tempcoPpmPerK: epShunt.tempcoPpmPerK ?? 0,
    requiredAccuracyPct: epShunt.requiredAccuracyPct ?? 1,
    evidence: epShunt.evidence ?? null,
  }) : null;
  if (protectionShunt && shuntResistanceWasDefaulted) {
    protectionShunt.diagnostics.push({
      code: 'SHUNT_RESISTANCE_PROVISIONAL', severity: 'review',
      title: 'Shunt resistance is provisional',
      detail: 'The unconfigured calculation uses 18 µΩ only as the documented Sensata SFP200MOD reference value; no production shunt has been selected.',
      action: 'Select a current supplier part and enter its resistance, ratings, error terms, installed thermal evidence and document revision.',
    });
    protectionShunt.status = 'review';
  }
  const terminalFault = shortCircuit.faults?.find((f) => f.kind.id === 'terminal')?.result;
  let protectionFast = protectionApplies && protectionShunt && terminalFault ? fastProtectionStudy({
    faultResult: terminalFault,
    thresholdA: epFast.thresholdA ?? Math.max(1, protectionContinuousA * 2),
    totalDelayMs: epFast.totalDelayMs ?? 5,
    shuntPeakRangeA: epFast.shuntPeakRangeA ?? protectionShunt.ratings.peakA,
    shuntErrorA: epFast.shuntErrorA ?? protectionShunt.accuracy.atPeak.absoluteA,
    interrupterVoltageRatingV: epFast.interrupterVoltageRatingV ?? null,
    interrupterCurrentRatingA: epFast.interrupterCurrentRatingA ?? null,
    evidence: epFast.evidence ?? null,
  }) : null;
  if (protectionFast && epFast.thresholdA == null) {
    protectionFast.diagnostics.push({
      code: 'FAST_PROTECTION_THRESHOLD_PROVISIONAL', severity: 'review',
      title: 'Overcurrent threshold is provisional',
      detail: `The automatic screen uses 2× continuous current (${protectionFast.thresholdA.toFixed(0)} A); no supplier or safety requirement establishes it as the production threshold.`,
      action: 'Enter the fault-discrimination threshold and validate nuisance-trip and missed-fault cases.',
    });
    if (protectionFast.status === 'pass') protectionFast.status = 'review';
  }
  const electricalProtection = {
    precharge: protectionPrecharge,
    shunt: protectionShunt,
    fast: protectionFast,
  };
  const protectionFindings = [
    ...(protectionPrecharge?.diagnostics || []).map((d) => ({ ...d, id: d.code, severity: d.severity === 'review' ? 'warn' : d.severity, category: 'electrical', ref: d.source?.title || 'Sensata precharge study' })),
    ...(protectionShunt?.diagnostics || []).map((d) => ({ ...d, id: d.code, severity: d.severity === 'review' ? 'warn' : d.severity, category: 'electrical', ref: d.source?.title || 'current-shunt selection' })),
    ...(protectionFast?.diagnostics || []).map((d) => ({ ...d, id: d.code, severity: d.severity === 'review' ? 'warn' : d.severity, category: 'protection', ref: d.source?.title || 'fast-fault coordination' })),
  ];

  // 5 · The vehicle, when this machine drives.
  let vehicle = null;
  let vehicleTrace = null;
  let routeSummary = null;
  const vehBase = vehicleDefaultsFor(appId);
  if (vehBase) {
    const veh = { ...vehBase, ...(spec.vehicle || {}) };
    let route = null;
    if (spec.route?.points) {
      route = buildRoute({ points: spec.route.points, name: spec.route.name || 'Selected route' });
      const routeErrors = validateRoute(route);
      if (!route || routeErrors.length) {
        warnings.push(`Route could not be used${routeErrors.length ? `: ${routeErrors.join(' ')}` : '.'}`);
        route = null;
      }
    }
    const routeTargetKph = { ebike: 20, escooter: 25, robot: 15, ebus: 30, ev: 50 }[appId] || 50;
    const fromRoute = route
      ? routeToTrace(route, {
        targetKph: spec.route.targetKph ?? routeTargetKph, dtS: 5,
        speedTrace: traceForApp(appId),
      })
      : null;
    const trace = fromRoute ? { ...fromRoute, note: route.notes.join(' ') } : traceForApp(appId);
    vehicleTrace = trace;
    routeSummary = route ? { name: route.name, ...route.totals, estimated: !route.timed } : null;
    const gradePct = spec.gradePct ?? 0;
    const regenCapW = charging.packChargeKW != null ? charging.packChargeKW * 1000 : null;
    const drive = driveCyclePower({
      trace, vehicle: veh, mode: spec.driveMode || 'normal',
      packMassKg: summary.massKg, gradePct, regenCapW,
    });
    if (drive) {
      vehicle = {
        vehicle: veh, trace: { id: trace.id, name: trace.name, note: trace.note }, route: routeSummary,
        drive: { ...drive, w: undefined, profile: undefined }, // the trace itself stays out of the summary
        packMassKg: summary.massKg, gradePct, dod,
        range: rangeKm({ energyWh: summary.energyWh, dod, whPerKm: drive.whPerKm }),
        share: massShare({ vehicle: veh, packMassKg: summary.massKg }),
        modes: modeComparison({
          trace, vehicle: veh, packMassKg: summary.massKg, gradePct,
          energyWh: summary.energyWh, dod, regenCapW,
        }),
      };
    }
  }

  // The two other movement domains. They deliberately do not pass through
  // vehicle.js: a hull works against water and a multirotor must continuously
  // buy lift. Both still end at the same profile seam as every other duty.
  //
  // Existing callers keep the complete voyage under `marine`; the top-level
  // alias is useful to generic clients that select the host before exposing
  // domain inputs. If both are supplied, the established nested value wins.
  const marineSpec = spec.marine && typeof spec.marine === 'object' ? spec.marine : {};
  const {
    twinEvidence: nestedTwinEvidence,
    replaySamples: nestedReplaySamples,
    replayOptions: nestedReplayOptions,
  } = marineSpec;
  const marine = marineSizing?.marine || null;

  // TwinShip is an evidence contract layered over the transparent mission
  // model. Architecture is always inspectable for a marine design; maturity
  // and replay are evaluated only from evidence the caller supplies. An empty
  // replay therefore returns `unproven`, never a synthetic clean result.
  const twinInput = spec.twinShip && typeof spec.twinShip === 'object' ? spec.twinShip : {};
  const readinessInput = nestedTwinEvidence && typeof nestedTwinEvidence === 'object'
    ? nestedTwinEvidence
    : (twinInput.readiness && typeof twinInput.readiness === 'object'
      ? twinInput.readiness
      : (twinInput.evidence && typeof twinInput.evidence === 'object' ? twinInput.evidence : {}));
  const replayInput = Array.isArray(twinInput.replay)
    ? { samples: twinInput.replay }
    : (twinInput.replay && typeof twinInput.replay === 'object' ? twinInput.replay : {});
  const replaySamples = Array.isArray(nestedReplaySamples) ? nestedReplaySamples : replayInput.samples;
  const replayOptions = nestedReplayOptions && typeof nestedReplayOptions === 'object'
    ? nestedReplayOptions
    : (replayInput.options && typeof replayInput.options === 'object'
      ? replayInput.options
      : (replayInput.thresholds && typeof replayInput.thresholds === 'object' ? replayInput.thresholds : {}));
  const replayResult = marine ? assessVoyageReplay(replaySamples, replayOptions) : null;
  const evaluatedReadiness = marine ? twinReadiness({
      ...readinessInput,
      vesselId: marine.vessel.id,
      replaySamples,
      replayOptions,
    }) : null;
  const twinShip = marine ? {
    architecture: twinShipArchitecture(marine.vessel.id),
    readiness: portableTwinReadiness(evaluatedReadiness),
    replay: replayResult,
  } : null;
  const flight = appId === 'drone' ? flightDuty(spec.flight || {}) : null;

  // 6 · The mission over time.
  let policyProfileId = null;
  if (!marine && spec.policyId) {
    const allowed = sizingOptionsFor(appId, 'energy-policy');
    if (allowed.includes(spec.policyId)) policyProfileId = spec.policyId;
    else warnings.push(`Policy "${spec.policyId}" is not available for ${appId}; using the selected design default instead.`);
  }
  const defaultPolicyId = defaultSizingOption(appId, 'energy-policy');
  const selectedProfileId = marineSizing?.profileId || policyProfileId || spec.profileId;
  const generatedPolicyId = marineSizing?.policyId
    ?? (policyProfileId || (!spec.profileId ? defaultPolicyId : null));
  const profile = marineSizing?.profile || (selectedProfileId === 'vehicle' && vehicle
    ? driveCyclePower({
      trace: vehicleTrace || traceForApp(appId), vehicle: { ...vehBase, ...(spec.vehicle || {}) },
      mode: spec.driveMode || 'normal', packMassKg: summary.massKg, gradePct: spec.gradePct ?? 0,
    }).profile
    : (!spec.profileId && flight)
      ? flight.profile
      : (generatedPolicyId
        ? batteryProfileForPolicy(generatedPolicyId)
        : (selectedProfileId ? profileById(selectedProfileId) : profileForApp(appId))));
  let simulation = null;
  let missionScaleW = null;
  if (profile) {
    const scaleW = marineSizing?.scaleW ?? (selectedProfileId === 'vehicle' && vehicle
      ? vehicle.drive.peakW
      : (!spec.profileId && flight)
        ? flight.scaleW
        : (preset?.peakPowerW ?? summary.maxContPowerW));
    missionScaleW = scaleW;
    const m = spec.mission || {};
    const sim = simulateMission({
      cell, s, p, profile, scaleW,
      passes: m.passes ?? 1, startSoC: m.startSoC ?? 1.0,
      ambientC: m.ambientC ?? ambientC[1],
      resistanceMOhm: architecture.resistance?.totalMOhm ?? undefined,
      uaWK: analysis?.totals?.heatContW > 0 && analysis?.totals?.tempRiseContC > 0
        ? analysis.totals.heatContW / analysis.totals.tempRiseContC : undefined,
      charge: m.charge || undefined,
    });
    simulation = {
      summary: sim.summary, findings: sim.findings, assumptions: sim.assumptions,
      profile: {
        id: profile.id, name: profile.name, dtS: profile.dtS, note: profile.note,
        kind: profile.kind || 'duty', policyId: profile.policyId || null,
        sourceProfileId: profile.sourceProfileId || null,
        scaleW,
        traceIdentity: marineSizing?.traceIdentity || traceIdentity(profile, scaleW),
      },
      stats: profileStats(profile, scaleW),
    };
  }

  // 7 · Money, carbon, and what release will ask for.
  const cost = costModel(cell, summary.cellCount, summary.energyWh, usageCtx);
  const energyPerformance = roundTripPlan({
    application: appId,
    deliveredWh: spec.deliveredWh ?? spec.energyWh ?? marineSizing?.requiredEnergyWh
      ?? preset?.typicalEnergyWh ?? summary.energyWh * dod,
    ...(spec.efficiency || {}),
  });
  const co2 = co2Model({
    cell, energyWh: summary.energyWh,
    cyclesPerYear: usageCtx.cyclesPerYear, targetYears: usageCtx.targetYears,
    gridGPerKWh: 440,
  });
  const checklist = releaseChecklist({
    market, application: appId, chemistry: cell.chemistry, v2x: spec.v2xPolicy || 'off',
  });
  const evaluationDate = spec.evaluationDate || EU_BATTERY_PASSPORT_EFFECTIVE_DATE;
  const batteryCategory = batteryCategoryForApplication(appId, spec.batteryCategory ?? null);
  const euFindings = euChecks({
    energyWh: summary.energyWh,
    application: appId,
    chemistry: cell.chemistry,
    commsPrimary: architecture.comms?.primary,
    batteryCategory: spec.batteryCategory ?? null,
    evaluationDate,
  });

  // 8 · Comparison against other cells on the same mission.
  let comparison = null;
  if (spec.compareCellIds?.length && profile) {
    const cells = [cell, ...spec.compareCellIds.map(cellById).filter(Boolean)]
      .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);
    comparison = compareCells({
      cells, targetVNom: summary.nominalV, targetEnergyWh: summary.energyWh,
      profile, scaleW: missionScaleW ?? summary.maxContPowerW,
      ambientC: ambientC[1], uaWK: 3, currentId: cell.id,
    });
    comparison.mission = {
      profileId: profile.id,
      policyId: profile.policyId || null,
      traceIdentity: marineSizing?.traceIdentity || traceIdentity(profile, missionScaleW ?? summary.maxContPowerW),
      scaleW: missionScaleW ?? summary.maxContPowerW,
      targetEnergyWh: summary.energyWh,
    };
  }

  // This rule is part of the semantic input, so it must exist before the
  // first conformance graph is built. Its evaluated presentation is filled
  // below, then a final authoritative graph is rebuilt from the final result.
  const ontologyRule = {
    code: 'ONTOLOGY-CONFORMANCE', scope: 'review',
    title: 'Architecture ontology conformance',
    note: 'Ontology conformance is pending graph evaluation.',
  };
  checklist.rules.unshift(ontologyRule);

  const result = {
    apiVersion: API_VERSION,
    spec: {
      ...portableSpec(spec),
      resolved: {
        application: appId, cell: cell.id, s, p, market, dod,
        isolationContext: architecture.isolation?.contextId || architecture.isolationReview?.contextId || null,
        isolationStatus: architecture.isolation?.status || architecture.isolationReview?.status || 'not-applicable',
        vesselId: marine?.vessel?.id || null,
        sizing: {
          decision: primarySizingDecision(appId),
          profileId: marineSizing?.profileId || profile?.id || null,
          policyId: marineSizing?.policyId ?? profile?.policyId ?? null,
          traceIdentity: marineSizing?.traceIdentity || (profile ? traceIdentity(profile, missionScaleW) : null),
          scaleW: missionScaleW,
          energyWindowWh: marineSizing?.energyWindowWh ?? null,
          requiredEnergyWh: marineSizing?.requiredEnergyWh ?? null,
          autoSizedFromTrace: !!marineSizing && !explicitMarineParallelTarget && marineTraceTargetMet,
          traceSizingStatus: !marineSizing || explicitMarineParallelTarget
            ? 'explicit-or-not-applicable'
            : (marineTraceTargetMet ? 'met' : 'unmet-bounded-pack'),
          driveMode: vehicle ? (spec.driveMode || 'normal') : null,
        },
        components: Object.fromEntries(
          Object.entries(selection).map(([k, c]) => [k, c?.id ?? null])),
      },
    },
    application: preset ? { id: preset.id, name: preset.name, class: appClassOf(appId) } : null,
    cell: listCells().find((c) => c.id === cell.id) || { id: cell.id, name: cell.name },
    pack: summary,
    findings: [
      ...(marineSizing && !explicitMarineParallelTarget && !marineTraceTargetMet ? [{
        id: 'MARINE_TRACE_ENERGY_UNMET', severity: 'fail', category: 'application',
        title: 'Bounded pack cannot meet the marine policy trace energy',
        detail: `The governed trace requires ${Math.ceil(marineSizing.requiredEnergyWh)} Wh but the bounded pack provides ${Math.round(summary.energyWh)} Wh. Increase the pack limits or revise the governed mission; automatic sizing is not complete.`,
      }] : []),
      ...findings,
      ...['mechanical', 'thermal', 'electrical', 'safety']
        .flatMap((k) => analysis?.perspectives?.[k] || []),
      ...(simulation?.findings || []),
      ...(shortCircuit?.findings || []),
      ...protectionFindings,
      ...euFindings,
    ],
    analysis: analysis ? { totals: analysis.totals, disclaimer: analysis.disclaimer } : null,
    architecture, thermal, sensors, diagnostics, charging, v2x, vehicle, marine, twinShip, flight,
    energyPerformance, simulation, shortCircuit, electricalProtection,
    cost, co2, checklist, comparison,
    eu: { batteryCategory, evaluationDate, findings: euFindings },
    concepts: appNeeds(appId),
    warnings,
  };
  const evaluatedGraph = buildDesignSemanticGraph(result);
  const evaluatedSemantics = semanticGraphSummary(evaluatedGraph);
  ontologyRule.scope = evaluatedSemantics.conforms ? 'pass' : 'blocker';
  ontologyRule.note = evaluatedSemantics.conforms
    ? `The generated graph conforms to ontology ${evaluatedSemantics.ontology.version}; engineering evidence and approval gates remain separate.`
    : 'Release is blocked until the generated semantic graph validates against the versioned ontology contract.';
  // Semantic integrity is a release invariant, not a cosmetic report field.
  // Normal generated graphs conform; if a future ontology/schema regression
  // does not, the ordinary audit and market-release seam both fail closed.
  if (!evaluatedSemantics.conforms) {
    result.findings.push({
      id: 'ONTOLOGY_GRAPH_INVALID', severity: 'fail', category: 'governance',
      title: 'Architecture ontology graph is invalid',
      detail: `${evaluatedSemantics.issues.length} semantic validation issue(s) prevent a traceable release.`,
      ref: `battery-design ontology ${evaluatedSemantics.ontology.version}`,
    });
  }
  const semanticGraph = buildDesignSemanticGraph(result);
  result.semantics = {
    ...semanticGraphSummary(semanticGraph),
    graph: semanticGraph,
  };
  return result;
}

// A one-screen answer for a human or an agent: the numbers that decide, in
// the order they get asked about.
export function briefFromDesign(d) {
  const lines = [];
  const mm = (v) => Math.round(v);
  const energy = d.pack.energyWh >= 1000
    ? `${(d.pack.energyWh / 1000).toFixed(2)} kWh` : `${d.pack.energyWh.toFixed(1)} Wh`;
  const mass = d.pack.massKg >= 1
    ? `${d.pack.massKg.toFixed(1)} kg` : `${(d.pack.massKg * 1000).toFixed(0)} g`;
  lines.push(`${d.application?.name || 'Custom design'} — ${d.pack.s}S${d.pack.p}P of ${d.cell.name}`);
  lines.push(`${energy} · ${d.pack.nominalV.toFixed(1)} V nominal · ${d.pack.cellCount} cells · ${mass} · ${mm(d.pack.dims.x)}×${mm(d.pack.dims.y)}×${mm(d.pack.dims.z)} mm`);
  if (d.vehicle) {
    lines.push(`Consumption ${d.vehicle.drive.whPerKm.toFixed(1)} Wh/km in ${d.vehicle.drive.mode.name}${d.vehicle.range != null ? ` → about ${Math.round(d.vehicle.range)} km of range` : ''} (${Math.round(d.vehicle.drive.massKg)} kg moving, ${Math.round(d.vehicle.packMassKg)} kg of it battery)`);
  }
  if (d.marine) {
    lines.push(`${d.marine.vessel.name}: ${d.marine.distanceNm.toFixed(1)} nmi at ${d.marine.metrics.speedGroundKn.toFixed(1)} kn · ${Math.round(d.marine.energyWh / 1000)} kWh mission demand · ${Math.round(d.marine.peakW / 1000)} kW peak · PMS ${d.spec.resolved.sizing.policyId || 'not selected'}`);
  }
  if (d.twinShip) {
    const replay = d.twinShip.replay;
    lines.push(`TwinShip evidence: ${d.twinShip.readiness.label}; replay ${replay.status}${replay.samples ? ` (${replay.samples} aligned samples)` : ''}. ${d.twinShip.readiness.statement}`);
  }
  if (d.semantics) {
    const s = d.semantics;
    lines.push(`Semantic trace: ontology ${s.ontology.version} · ${s.counts.nodes} entities / ${s.counts.edges} relations · ${s.counts.modelRuns} model runs · ${s.conforms ? 'conforms' : 'INVALID — release blocked'}`
      + `${s.unresolvedEvidence.length ? ` · ${s.unresolvedEvidence.length} unresolved evidence requirement(s)` : ''}`);
  }
  if (d.eu && d.spec?.resolved?.market === 'eu') {
    const passport = d.eu.findings?.find((finding) =>
      finding.ontologyRuleId === 'bd:rule/eu-battery-passport');
    lines.push(`EU assessment: category ${d.eu.batteryCategory || 'unresolved'} · ${d.eu.evaluationDate} · ${passport?.title || 'battery-passport applicability not evaluated'}`);
  }
  if (d.charging?.t2080) {
    lines.push(`Charges via ${d.charging.obc ? `${d.charging.obc.acKW} kW on-board charger` : d.charging.arch.name} · 20→80% in ${d.charging.t2080.hours.toFixed(1)} h (${d.charging.t2080.limitedBy === 'pack' ? 'pack-limited' : 'charger-limited'})`);
  }
  if (d.simulation?.summary) {
    const s = d.simulation.summary;
    lines.push(`Mission: ${Math.round(s.startSoC * 100)}% → ${Math.round(s.endSoC * 100)}% SoC, minimum ${Math.round(s.minSoC * 100)}%` +
      (s.tempMaxC != null ? `, peak cell ${s.tempMaxC.toFixed(1)} °C` : '') +
      (s.unmetWh > 0 ? `, ${s.unmetWh.toFixed(1)} Wh of the mission unmet` : ''));
  }
  if (d.cost?.usdPerKWhDelivered != null) {
    lines.push(`Cost: $${Math.round(d.cost.upfrontUSD)} of cells, $${d.cost.usdPerKWhDelivered.toFixed(3)} per kWh delivered over ${d.cell.cycleLife} cycles`);
  }
  if (d.v2x?.applicable && d.v2x.chosen) {
    lines.push(`Feed-back policy ${d.v2x.chosen.name}: ${d.v2x.parts.length} parts added${d.v2x.budget ? `, ${(d.v2x.budget.exportableWh / 1000).toFixed(1)} kWh exportable` : ''}`);
  }
  const fails = d.findings.filter((f) => f.severity === 'fail');
  const warns = d.findings.filter((f) => f.severity === 'warn');
  lines.push(`Audit: ${fails.length} fail, ${warns.length} warn, ${d.findings.length} checks total`);
  for (const f of [...fails, ...warns].slice(0, 5)) lines.push(`  ${f.severity.toUpperCase()}: ${f.title} — ${f.detail}`);
  if (d.warnings.length) lines.push(`Notes: ${d.warnings.join(' ')}`);
  return lines.join('\n');
}

// Product-control API. These are pure projections over the same engineering
// result: market scope, progressive disclosure, and human approval/history.
export {
  AUDIENCES,
  GRID_SEGMENTS,
  audienceFor,
  createDesignRecord,
  gridCustomerQuestions,
  personHistory,
  productSurface,
  projectHistory,
  recordMaterialChange,
  scopeForApplication,
  transitionDesign,
} from './governance.js';

// Semantic-control API. Neo4j remains an offline validated projection; no
// network connection or credentials are used here.
export {
  buildArchitectureSemanticGraph,
  buildDesignSemanticGraph,
  describeOntology,
  querySemanticGraph,
  semanticGraphSummary,
  toJsonLd,
  toNeo4jProjection,
  traceSemanticPath,
};
