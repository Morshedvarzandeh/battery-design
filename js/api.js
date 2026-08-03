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
import { simulateMission, compareCells } from './sim1d.js';
import { profileForApp, profileById, profileStats } from './loadprofiles.js';
import { releaseChecklist, appClassOf } from './markets.js';
import { co2Model } from './report.js';
import { appNeeds } from './knowledge.js';
import { DEFAULTS_BY_FORM, componentById } from './components.js';
import {
  vehicleDefaultsFor, traceForApp, driveCyclePower, rangeKm, massShare, modeComparison,
} from './vehicle.js';

export const API_VERSION = '1.0';

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
  vehicle: 'overrides for the vehicle model: { curbKg, payloadKg, cd, frontalAreaM2, crr, driveEff, regenFrac, auxW }',
  driveMode: 'eco | normal | sport (default normal)',
  gradePct: 'route gradient in percent (default 0)',
  profileId: 'load profile id, or "vehicle" to derive it from the vehicle model',
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
 * The whole designer in one call. Returns plain data — no classes, no DOM
 * nodes, nothing that cannot be JSON.stringify'd.
 */
export function designFromSpec(spec = {}) {
  const warnings = [];
  const preset = PRESETS.find((p) => p.id === spec.application) || null;
  if (spec.application && !preset) {
    warnings.push(`Unknown application "${spec.application}" — falling back to generic defaults. Use listApplications() for the real ids.`);
  }
  const cell = (spec.cell ? cellById(spec.cell) : null) || defaultCellFor(preset || { preferredChemistries: [] });
  if (spec.cell && !cellById(spec.cell)) {
    warnings.push(`Unknown cell "${spec.cell}" — using ${cell.id} instead. Use listCells() for the real ids.`);
  }
  const { s, p } = deriveSP(cell, preset, spec, warnings);
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
  const arrangement = spec.arrangement || defaultArrangement(cell);
  const layout = layoutPack(cell, s, p, { arrangement, spacingMm: 1, wallMm: 2, headroomMm: 8 });
  const summary = summarize(cell, s, p, layout);
  const pack = {
    nominalV: summary.nominalV, vMax: summary.vMax, vMin: summary.vMin,
    capacityAh: summary.capacityAh, energyWh: summary.energyWh, massKg: summary.massKg,
    massCellsKg: summary.massCellsKg, cellCount: summary.cellCount,
    maxContCurrentA: summary.maxContCurrentA, maxContPowerW: summary.maxContPowerW,
    dcirMOhm: summary.dcirMOhm, dims: summary.dims, volumeL: summary.volumeL,
  };

  // 2 · The four engineering perspectives and the standards audit.
  const selection = Object.fromEntries(
    Object.entries(DEFAULTS_BY_FORM[cell.form] || {}).map(([k, id]) => [k, componentById(id) || null]));
  const usage = {
    application: appId,
    contPowerW: preset?.contPowerW ?? null, peakPowerW: preset?.peakPowerW ?? null,
    chargeRateC: preset?.chargeRateC ?? null, envTempC: ambientC,
  };
  const stdCtx = {
    cell, s, p, pack,
    layout: { spacingMm: 1, arrangement, wallMm: 2 },
    usage,
  };
  const findings = runChecks(stdCtx);
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
  const sensors = buildSensorPlan({
    cell, s, p, summary, partition: architecture.partition, bms: architecture.bms,
    therm: thermal, selection,
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

  // 5 · The vehicle, when this machine drives.
  let vehicle = null;
  const vehBase = vehicleDefaultsFor(appId);
  if (vehBase) {
    const veh = { ...vehBase, ...(spec.vehicle || {}) };
    const trace = traceForApp(appId);
    const gradePct = spec.gradePct ?? 0;
    const regenCapW = charging.packChargeKW != null ? charging.packChargeKW * 1000 : null;
    const drive = driveCyclePower({
      trace, vehicle: veh, mode: spec.driveMode || 'normal',
      packMassKg: summary.massKg, gradePct, regenCapW,
    });
    if (drive) {
      vehicle = {
        vehicle: veh, trace: { id: trace.id, name: trace.name, note: trace.note },
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

  // 6 · The mission over time.
  const profile = spec.profileId === 'vehicle' && vehicle
    ? driveCyclePower({
      trace: traceForApp(appId), vehicle: { ...vehBase, ...(spec.vehicle || {}) },
      mode: spec.driveMode || 'normal', packMassKg: summary.massKg, gradePct: spec.gradePct ?? 0,
    }).profile
    : (spec.profileId ? profileById(spec.profileId) : profileForApp(appId));
  let simulation = null;
  if (profile) {
    const scaleW = spec.profileId === 'vehicle' && vehicle
      ? vehicle.drive.peakW
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
      profile: { id: profile.id, name: profile.name, dtS: profile.dtS, note: profile.note },
      stats: profileStats(profile, scaleW),
    };
  }

  // 7 · Money, carbon, and what release will ask for.
  const cost = costModel(cell, summary.cellCount, summary.energyWh, usageCtx);
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
    spec: { ...spec, resolved: { application: appId, cell: cell.id, s, p, market, dod } },
    application: preset ? { id: preset.id, name: preset.name, class: appClassOf(appId) } : null,
    cell: listCells().find((c) => c.id === cell.id) || { id: cell.id, name: cell.name },
    pack: summary,
    findings: [
      ...findings,
      ...['mechanical', 'thermal', 'electrical', 'safety']
        .flatMap((k) => analysis?.perspectives?.[k] || []),
      ...(simulation?.findings || []),
    ],
    analysis: analysis ? { totals: analysis.totals, disclaimer: analysis.disclaimer } : null,
    architecture, thermal, sensors, charging, v2x, vehicle, simulation,
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
