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
import { buildArchitecture } from './architecture.js';
import { buildThermalSystem } from './btms.js';
import { buildSensorPlan } from './sensors.js';
import { buildChargingPlan } from './charging.js';
import { v2xPlan } from './v2x.js';
import { shortCircuitStudy } from './shortcircuit.js';
import { simulateMission, compareCells } from './sim1d.js';
import { profileForApp, profileById, profileStats } from './loadprofiles.js';
import { releaseChecklist, appClassOf } from './markets.js';
import { co2Model } from './report.js';
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
import { batteryProfileForPolicy } from './operating-policy.js';
import { marineDuty } from './marine.js';
import { flightDuty } from './flight.js';
import { roundTripPlan } from './efficiency.js';
import { buildEngineeringDiagnostics } from './diagnostics.js';

export const API_VERSION = '1.1';

// What a specification may contain. Everything except `application` has a
// defensible default, so the smallest useful call is one field.
export const SPEC_FIELDS = {
  application: 'preset id — see listApplications()',
  cell: 'cell id (default: the preset\'s first preferred chemistry match)',
  s: 'cells in series (default: derived from the preset\'s typical voltage)',
  p: 'cells in parallel (default: derived from the energy target)',
  energyWh: 'energy target used to derive p when s/p are not given',
  market: 'eu | us | cn | intl (default eu)',
  dod: 'usable depth of discharge, 0–1 (default 0.8)',
  cyclesPerYear: 'duty for the cost model (default: the preset\'s)',
  targetYears: 'service life for the cost model (default: the preset\'s)',
  ambientC: '[low, high] design ambient (default: the preset\'s)',
  v2xPolicy: 'off | v2l | v2h | v2g | v2v (default off)',
  isolationStandard: 'ece-r100 | iso-6469-dc — the sources conflict, so this is stated, never averaged (default ece-r100)',
  components: '{ busbar, spacer, vent, cooling, tim, housing } — component ids from listComponents(); anything omitted takes the default for the cell format',
  vehicle: 'overrides for the vehicle model: { curbKg, payloadKg, cd, frontalAreaM2, crr, driveEff, regenFrac, auxW }',
  driveMode: 'eco | normal | sport (default normal)',
  policyId: 'EMS/PMS operating policy id for applications that expose one; converted to a battery sizing profile',
  diagnostics: '{ rest, pulse, relaxation, thermal, aging } booleans describing available battery-model measurements',
  conditionMonitoring: '{ baselineWindows, operatingModes, samplingHz } for engineering vibration anomaly monitoring',
  marine: 'vessel mission overrides: { referenceMassKg, payloadKg, designSpeedKn, serviceSpeedKn, headCurrentKn, headwindKn, propulsionAtDesignW, hotelW, durationH, seaState }',
  flight: 'multirotor mission overrides: { emptyMassKg, payloadKg, rotorCount, rotorDiameterM, flightMinutes, cruiseSpeedMps, headwindMps, altitudeM, temperatureC, propulsiveEfficiency, auxiliaryW, hoverFraction }',
  efficiency: 'round-trip chain overrides: { chargeEff, batteryEff, dischargeEff, auxiliaryW, cycleHours }; all efficiencies are 0–1',
  gradePct: 'route gradient in percent (default 0)',
  route: '{ points: [{ lat, lon, eleM?, tS? }], name?, targetKph? } — local or client-supplied route for road sizing',
  profileId: 'battery/load profile id, or "vehicle" to derive it from vehicle physics (kept for backward compatibility)',
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

// Series/parallel from intent: series follows the voltage window, parallel
// follows the energy target. Exactly the arithmetic the UI does.
function deriveSP(cell, preset, spec, warnings) {
  const targetV = spec.nominalV ?? preset?.typicalV ?? 48;
  const targetWh = spec.energyWh ?? preset?.typicalEnergyWh ?? 1000;
  const perStringWh = targetV > 0 ? Math.max(1, Math.round(targetV / cell.nominalV)) * cell.nominalV * cell.capacityAh : 0;
  const wanted = {
    s: spec.s ?? Math.max(1, Math.round(targetV / cell.nominalV)),
    p: spec.p ?? Math.max(1, Math.round(targetWh / (perStringWh || 1))),
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
  const preset = PRESETS.find((p) => p.id === spec.application) || null;
  if (spec.application && !preset) {
    warnings.push(`Unknown application "${spec.application}" — falling back to generic defaults. Use listApplications() for the real ids.`);
  }
  const cell = (spec.cell ? cellById(spec.cell) : null) || defaultCellFor(preset || { preferredChemistries: [] });
  if (spec.cell && !cellById(spec.cell)) {
    warnings.push(`Unknown cell "${spec.cell}" — using ${cell.id} instead. Use listCells() for the real ids.`);
  }
  const derived = deriveSP(cell, preset, spec, warnings);
  // Guard rails before any geometry is attempted: a slipped keystroke must
  // not become ten billion cells and a frozen application.
  const bounded = clampPack(derived.s, derived.p);
  warnings.push(...bounded.notes);
  const { s, p } = bounded;
  const appId = preset?.id || 'custom';
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
  const pack = {
    nominalV: summary.nominalV, vMax: summary.vMax, vMin: summary.vMin,
    capacityAh: summary.capacityAh, energyWh: summary.energyWh, massKg: summary.massKg,
    massCellsKg: summary.massCellsKg, cellCount: summary.cellCount,
    maxContCurrentA: summary.maxContCurrentA, maxContPowerW: summary.maxContPowerW,
    dcirMOhm: summary.dcirMOhm, dims: summary.dims, volumeL: summary.volumeL,
  };

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
      usage: usageCtx, selection,
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
    usage,
  };
  const findings = runChecks(stdCtx);

  // 3 · Architecture, thermal system, sensors.
  // The isolation standard is never defaulted silently — ECE R100 and
  // ISO 6469 disagree (500 Ω/V vs 100 Ω/V) and the module rightly refuses to
  // average them. The spec states it; the answer records which one was used.
  const isolationStandard = spec.isolationStandard || 'ece-r100';
  const architecture = buildArchitecture({
    cell, s, p, summary, options: { appId, isolationStandard },
  });
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
  });

  // 4 · The AC side, and what feeding power back would cost.
  const charging = buildChargingPlan({
    appId, marketId: market, energyWh: summary.energyWh,
    vNomV: summary.nominalV, cell, obcOverride: 'auto',
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
  const marine = appId === 'marine' ? marineDuty(spec.marine || {}) : null;
  const flight = appId === 'drone' ? flightDuty(spec.flight || {}) : null;

  // 6 · The mission over time.
  let policyProfileId = null;
  if (spec.policyId) {
    const allowed = sizingOptionsFor(appId, 'energy-policy');
    if (allowed.includes(spec.policyId)) policyProfileId = spec.policyId;
    else warnings.push(`Policy "${spec.policyId}" is not available for ${appId}; using the knowledge-graph default instead.`);
  }
  const defaultPolicyId = defaultSizingOption(appId, 'energy-policy');
  const selectedProfileId = policyProfileId || spec.profileId;
  const generatedPolicyId = policyProfileId || (!spec.profileId ? defaultPolicyId : null);
  const profile = selectedProfileId === 'vehicle' && vehicle
    ? driveCyclePower({
      trace: vehicleTrace || traceForApp(appId), vehicle: { ...vehBase, ...(spec.vehicle || {}) },
      mode: spec.driveMode || 'normal', packMassKg: summary.massKg, gradePct: spec.gradePct ?? 0,
    }).profile
    : generatedPolicyId && marine
      ? batteryProfileForPolicy(generatedPolicyId, { demandProfile: marine.profile })
      : (!spec.profileId && flight)
        ? flight.profile
        : (selectedProfileId ? profileById(selectedProfileId) : profileForApp(appId));
  let simulation = null;
  if (profile) {
    const scaleW = selectedProfileId === 'vehicle' && vehicle
      ? vehicle.drive.peakW
      : generatedPolicyId && marine
        ? marine.scaleW * (profile.sourceScaleFactor || 1)
        : (!spec.profileId && flight)
          ? flight.scaleW
          : (preset?.peakPowerW ?? summary.maxContPowerW);
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
      },
      stats: profileStats(profile, scaleW),
    };
  }

  // 7 · Money, carbon, and what release will ask for.
  const cost = costModel(cell, summary.cellCount, summary.energyWh, usageCtx);
  const energyPerformance = roundTripPlan({
    application: appId,
    deliveredWh: spec.deliveredWh ?? spec.energyWh ?? preset?.typicalEnergyWh ?? summary.energyWh * dod,
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

  // 8 · Comparison against other cells on the same mission.
  let comparison = null;
  if (spec.compareCellIds?.length && profile) {
    const cells = [cell, ...spec.compareCellIds.map(cellById).filter(Boolean)]
      .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);
    comparison = compareCells({
      cells, targetVNom: summary.nominalV, targetEnergyWh: summary.energyWh,
      profile, scaleW: preset?.peakPowerW ?? summary.maxContPowerW,
      ambientC: ambientC[1], uaWK: 3, currentId: cell.id,
    });
  }

  return {
    apiVersion: API_VERSION,
    spec: {
      ...spec,
      resolved: {
        application: appId, cell: cell.id, s, p, market, dod,
        sizing: {
          decision: primarySizingDecision(appId),
          profileId: profile?.id || null,
          policyId: profile?.policyId || null,
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
      ...findings,
      ...['mechanical', 'thermal', 'electrical', 'safety']
        .flatMap((k) => analysis?.perspectives?.[k] || []),
      ...(simulation?.findings || []),
      ...(shortCircuit?.findings || []),
    ],
    analysis: analysis ? { totals: analysis.totals, disclaimer: analysis.disclaimer } : null,
    architecture, thermal, sensors, diagnostics, charging, v2x, vehicle, marine, flight,
    energyPerformance, simulation, shortCircuit,
    cost, co2, checklist, comparison,
    concepts: appNeeds(appId),
    warnings,
  };
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
