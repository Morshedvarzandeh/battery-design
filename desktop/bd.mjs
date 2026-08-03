#!/usr/bin/env node
// bd.mjs — the battery designer on your own machine.
//
// The web app is deliberately a small thing: one browser tab, instant answers,
// nothing to install. That ceiling is real, though. Searching a thousand
// designs, running a mission at one-second resolution for eight hours, or
// sweeping every cell in the library against your duty is work a browser tab
// should not be asked to do while you wait.
//
// This is the same designer with the ceiling removed. Identical modules —
// there is no second implementation to drift — driven from the command line,
// with the results written out as JSON you can keep, diff and re-run.
//
// Zero dependencies. Node 18+. Nothing leaves your machine.
//
//   node desktop/bd.mjs design --app ev --energy 60000
//   node desktop/bd.mjs sweep  --app ev --energy 60000 --vary cell
//   node desktop/bd.mjs sweep  --app ev --vary mass --from 1200 --to 2200 --step 100
//   node desktop/bd.mjs mission --app ebus --passes 6 --charge base --minutes 120
//   node desktop/bd.mjs serve  --port 8080
//   node desktop/bd.mjs apps | node desktop/bd.mjs cells --chemistry LFP

import { createReadStream, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  designFromSpec, briefFromDesign, listApplications, listCells, API_VERSION,
} from '../js/api.js';
import { CELLS } from '../js/cells.js';
import { vehicleDefaultsFor, traceForApp, driveCyclePower, rangeKm } from '../js/vehicle.js';
import { runPool, coreCount, PARALLEL_THRESHOLD } from './pool.mjs';
import { simulate, calibrate, defaultParams, PARAM_SPEC, PARAM_BY_ID } from '../js/sim2.js';
import { cellById } from '../js/cells.js';
import { profileById } from '../js/loadprofiles.js';
import { buildFmu } from '../js/fmi.js';
import { buildTopology, jointCompatibility, billOfMaterials, materialBreakdown } from '../js/topology.js';
import { wiringStudy, INSTALLATIONS } from '../js/wiring.js';
import { groundingStudy, faultFromShortCircuit } from '../js/grounding.js';
import { designBrief } from '../js/brief.js';
import { materialById } from '../js/materials.js';
import { ADDONS, addonsFor, capabilityReport } from '../js/addons.js';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- argument parsing, the smallest thing that works ------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
const num = (v, fb = null) => { const n = parseFloat(v); return isFinite(n) ? n : fb; };

function specFrom(args) {
  const spec = {
    application: args.app || args.application,
    cell: args.cell,
    market: args.market,
    v2xPolicy: args.v2x,
    driveMode: args.mode,
  };
  if (args.energy != null) spec.energyWh = num(args.energy);
  if (args.s != null) spec.s = num(args.s);
  if (args.p != null) spec.p = num(args.p);
  if (args.dod != null) spec.dod = num(args.dod) > 1 ? num(args.dod) / 100 : num(args.dod);
  if (args.grade != null) spec.gradePct = num(args.grade);
  if (args.profile != null) spec.profileId = args.profile;
  if (args.mass != null || args.payload != null) {
    spec.vehicle = {};
    if (args.mass != null) spec.vehicle.curbKg = num(args.mass);
    if (args.payload != null) spec.vehicle.payloadKg = num(args.payload);
  }
  if (args.passes != null || args.charge != null || args.soc != null) {
    spec.mission = {};
    if (args.passes != null) spec.mission.passes = num(args.passes);
    if (args.soc != null) spec.mission.startSoC = num(args.soc) > 1 ? num(args.soc) / 100 : num(args.soc);
    if (args.charge != null) {
      spec.mission.charge = {
        mode: args.charge === true ? 'base' : args.charge,
        powerW: num(args.chargeW, 11000),
        minutes: num(args.minutes, 60),
      };
    }
  }
  for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
  return spec;
}

function emit(args, data, humanLines) {
  if (args.json || args.out) {
    const text = JSON.stringify(data, null, 2);
    if (args.out) { writeFileSync(args.out, text); console.log(`Written: ${args.out}`); }
    else console.log(text);
    return;
  }
  console.log(humanLines);
}

// --- commands ---------------------------------------------------------------
const COMMANDS = {
  design(args) {
    const d = designFromSpec(specFrom(args));
    emit(args, d, briefFromDesign(d));
  },

  // Everything the browser should not do while you wait: change one thing at
  // a time across a range and report what it did to the answers that matter.
  async sweep(args) {
    const base = specFrom(args);
    const vary = args.vary || 'cell';
    const jobs = [];
    const add = (value, spec) => jobs.push({ index: jobs.length, variable: vary, value, spec });
    if (vary === 'cell') {
      // Every cell in the library, on the same duty, sized to the same energy.
      const pool = args.chemistry ? CELLS.filter((c) => c.chemistry === args.chemistry) : CELLS;
      for (const c of pool) add(c.id, { ...base, cell: c.id });
    } else if (vary === 'mass' || vary === 'payload') {
      const from = num(args.from, 1000), to = num(args.to, 2500), step = num(args.step, 100);
      const field = vary === 'mass' ? 'curbKg' : 'payloadKg';
      for (let v = from; v <= to; v += step) add(v, { ...base, vehicle: { ...(base.vehicle || {}), [field]: v } });
    } else if (vary === 'energy') {
      const from = num(args.from, 10000), to = num(args.to, 100000), step = num(args.step, 10000);
      for (let v = from; v <= to; v += step) add(v, { ...base, energyWh: v });
    } else {
      console.error(`Unknown --vary "${vary}". Supported: cell, mass, payload, energy.`);
      process.exit(2);
    }
    const t0 = Date.now();
    const { rows, workers, mode } = await runPool(jobs, { jobs: args.jobs != null ? num(args.jobs) : null });
    const ms = Date.now() - t0;
    if (vary === 'cell') rows.sort((a, b) => (a.usdPerKWhDelivered ?? 1e9) - (b.usdPerKWhDelivered ?? 1e9));
    const table = [
      `Sweep over ${vary} — ${rows.length} designs, same duty, same application`
      + `  [${ms} ms, ${mode}${mode === 'parallel' ? ` on ${workers} threads` : ''}]`,
      pad('value', 26) + pad('kWh', 9) + pad('kg', 8) + pad('$/kWh del.', 12) + pad('Wh/km', 9) + pad('range km', 10) + 'audit',
      ...rows.map((r) => r.error
        ? pad(String(r.value), 26) + `error: ${r.error}`
        : pad(String(r.value), 26) + pad(r.kWh?.toFixed(2), 9) + pad(r.massKg?.toFixed(1), 8)
          + pad(r.usdPerKWhDelivered != null ? r.usdPerKWhDelivered.toFixed(3) : '—', 12)
          + pad(r.whPerKm != null ? r.whPerKm.toFixed(1) : '—', 9)
          + pad(r.rangeKm != null ? Math.round(r.rangeKm) : '—', 10)
          + `${r.fails} fail / ${r.warns} warn`),
    ].join('\n');
    emit(args, { apiVersion: API_VERSION, sweep: vary, rows }, table);
  },

  mission(args) {
    const spec = specFrom(args);
    spec.mission = spec.mission || {};
    if (spec.mission.passes == null) spec.mission.passes = 3;
    const d = designFromSpec(spec);
    if (!d.simulation) { console.error('No load profile for this application.'); process.exit(2); }
    const s = d.simulation.summary;
    const lines = [
      briefFromDesign(d), '',
      `Mission detail (${d.simulation.profile.name}, ${spec.mission.passes} passes)`,
      `  SoC        ${Math.round(s.startSoC * 100)}% → ${Math.round(s.endSoC * 100)}% (minimum ${Math.round(s.minSoC * 100)}%)`,
      `  Energy     ${s.energyOutWh.toFixed(0)} Wh out, ${s.energyInWh.toFixed(0)} Wh recovered, ${s.lossWh.toFixed(0)} Wh lost (${s.efficiencyPct.toFixed(1)}% efficient)`,
      `  Thermal    peak ${s.tempMaxC?.toFixed(1)} °C, ${s.peakHeatW.toFixed(0)} W peak heat, ${s.avgHeatW.toFixed(0)} W average`,
      `  Voltage    ${s.vMinPack.toFixed(1)}–${s.vMaxPack.toFixed(1)} V`,
      ...(s.unmetWh > 0 ? [`  UNMET      ${s.unmetWh.toFixed(0)} Wh — the pack ran out before the mission ended`] : []),
      ...(s.chargedWh > 0 ? [`  Charged    ${s.chargedWh.toFixed(0)} Wh accepted${s.chargeRefusedWh > 0 ? `, ${s.chargeRefusedWh.toFixed(0)} Wh refused (too cold)` : ''}`] : []),
      '', 'Assumptions:', ...d.simulation.assumptions.map((a) => `  · ${a}`),
    ];
    emit(args, d, lines.join('\n'));
  },

  // A drive-cycle study at full resolution: what mass and driving style cost,
  // across the whole range, in one pass.
  range(args) {
    const appId = args.app || 'ev';
    const veh = vehicleDefaultsFor(appId);
    if (!veh) { console.error(`"${appId}" is not a machine that drives.`); process.exit(2); }
    const trace = traceForApp(appId);
    const energyWh = num(args.energy, 60000);
    const dod = num(args.dod, 0.8) > 1 ? num(args.dod) / 100 : num(args.dod, 0.8);
    const packMassKg = num(args.packmass, energyWh / 1000 * 6); // ~6 kg/kWh pack class
    const from = num(args.from, veh.curbKg), to = num(args.to, veh.curbKg + 800), step = num(args.step, 100);
    const rows = [];
    for (let m = from; m <= to; m += step) {
      for (const mode of ['eco', 'normal', 'sport']) {
        const r = driveCyclePower({ trace, vehicle: { ...veh, curbKg: m }, mode, packMassKg });
        rows.push({
          curbKg: m, mode, whPerKm: r.whPerKm, peakKW: r.peakW / 1000,
          rangeKm: rangeKm({ energyWh, dod, whPerKm: r.whPerKm }),
        });
      }
    }
    const table = [
      `Range study — ${appId}, ${(energyWh / 1000).toFixed(1)} kWh pack at ${Math.round(dod * 100)}% DoD, ${trace.name}`,
      pad('curb kg', 10) + pad('mode', 9) + pad('Wh/km', 9) + pad('peak kW', 10) + 'range km',
      ...rows.map((r) => pad(r.curbKg, 10) + pad(r.mode, 9) + pad(r.whPerKm.toFixed(1), 9)
        + pad(r.peakKW.toFixed(1), 10) + Math.round(r.rangeKm)),
      '', trace.note,
    ].join('\n');
    emit(args, { apiVersion: API_VERSION, application: appId, energyWh, dod, rows }, table);
  },

  // The job the desktop tier exists for: not one design, but the whole space
  // of them. Every cell against every energy target, each one fully worked —
  // geometry, architecture, thermal, audit, cost, mission — then ranked by
  // what you actually care about. Thousands of complete designs, which is
  // where using all the cores stops being a nicety.
  async search(args) {
    const base = specFrom(args);
    const pool = args.chemistry ? CELLS.filter((c) => c.chemistry === args.chemistry) : CELLS;
    const from = num(args.from, 20000), to = num(args.to, 100000), step = num(args.step, 2000);
    const jobs = [];
    for (const c of pool) {
      for (let e = from; e <= to; e += step) {
        jobs.push({
          index: jobs.length, variable: 'cell×energy',
          value: `${c.id} @ ${(e / 1000).toFixed(0)} kWh`,
          meta: { targetWh: e },
          spec: { ...base, cell: c.id, energyWh: e },
        });
      }
    }
    const rank = args.rank || 'cost';
    const KEYS = {
      cost: ['usdPerKWhDelivered', 1, '$/kWh delivered'],
      range: ['rangeKm', -1, 'range km'],
      mass: ['massKg', 1, 'kg'],
      density: ['whPerKg', -1, 'Wh/kg'],
      upfront: ['upfrontUSD', 1, '$ upfront'],
    };
    if (!KEYS[rank]) { console.error(`Unknown --rank "${rank}". Supported: ${Object.keys(KEYS).join(', ')}.`); process.exit(2); }
    const [key, dir, unit] = KEYS[rank];
    console.error(`Searching ${jobs.length.toLocaleString()} complete designs (${pool.length} cells × ${Math.floor((to - from) / step) + 1} energy targets) on ${coreCount()} cores…`);
    const t0 = Date.now();
    const { rows, workers, mode } = await runPool(jobs, { jobs: args.jobs != null ? num(args.jobs) : null });
    const ms = Date.now() - t0;
    const ok = rows.filter((r) => !r.error && r[key] != null);
    // A pack is built from whole cells, so it lands NEAR a target, never on
    // it. But a 302 Ah cell asked for 20 kWh returns 120 kWh — one series
    // string already overshoots — and ranking that as the cheapest design is
    // meaningless: it is not the pack anyone asked for. Designs that miss the
    // target by more than the tolerance are excluded and counted, because
    // "this cell cannot build a pack that small at this voltage" is a real
    // answer worth seeing.
    const tol = num(args.tol, 0.2);
    const onTarget = ok.filter((r) => r.targetWh > 0 && Math.abs(r.kWh * 1000 - r.targetWh) / r.targetWh <= tol);
    const missed = ok.length - onTarget.length;
    // A design with a FAIL finding is not a candidate, whatever it scores.
    const scored = args.all ? onTarget : onTarget.filter((r) => r.fails === 0);
    scored.sort((a, b) => (a[key] - b[key]) * dir);
    // Neighbouring targets round to the SAME whole-cell pack, so an
    // undeduplicated top-10 is often one design listed ten times. Keep the
    // first (best-ranked) instance of each distinct pack, so "top 10" means
    // ten different answers.
    const seen = new Set();
    const viable = scored.filter((r) => {
      const id = `${r.cell}|${r.cellCount}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const top = viable.slice(0, num(args.top, 12));
    const table = [
      `Design search — ${rows.length.toLocaleString()} designs in ${(ms / 1000).toFixed(1)} s `
      + `(${mode}${mode === 'parallel' ? `, ${workers} threads` : ''}, ${(ms / rows.length).toFixed(2)} ms each)`,
      `${missed.toLocaleString()} missed their energy target by more than ${Math.round(tol * 100)}% (whole cells only — the cell is too big or too small for that target)`,
      `${viable.length.toLocaleString()} distinct viable packs${args.all ? '' : ' (designs with a FAIL finding excluded — --all to include)'} — best ${rank} first:`,
      '',
      pad('cell', 30) + pad('cells', 8) + pad('kWh', 8) + pad('kg', 8) + pad(unit, 16) + 'audit',
      ...top.map((r) => pad(r.cell.slice(0, 29), 30) + pad(r.cellCount, 8)
        + pad(r.kWh?.toFixed(1), 8) + pad(r.massKg?.toFixed(1), 8)
        + pad(typeof r[key] === 'number' ? (r[key] < 10 ? r[key].toFixed(3) : Math.round(r[key])) : '—', 16)
        + `${r.fails} fail / ${r.warns} warn`),
      ...(top.length ? [] : ['', 'Nothing met the target within tolerance. Widen it with --tol 0.4, or check the energy range.']),
    ].join('\n');
    emit(args, {
      apiVersion: API_VERSION, rank, searched: rows.length, missedTarget: missed,
      viable: viable.length, tolerance: tol, ms, workers, rows: top,
    }, table);
  },

  // The level-2 model: every coefficient exposed, nothing hard-coded behind
  // the user's back.
  sim2(args) {
    const spec = specFrom(args);
    const d = designFromSpec(spec);
    const cell = cellById(d.cell.id);
    const params = args.params ? loadParams(args.params) : null;
    // Drive it with the vehicle's own physics where there is a vehicle,
    // otherwise the application's load profile.
    let profile;
    if (d.vehicle) {
      const veh = { ...vehicleDefaultsFor(spec.application), ...(spec.vehicle || {}) };
      const drive = driveCyclePower({ trace: traceForApp(spec.application), vehicle: veh, mode: spec.driveMode || 'normal', packMassKg: d.pack.massKg });
      profile = { dtS: drive.dtS, w: drive.w };
    } else if (d.simulation) {
      const pr = profileById(d.simulation.profile.id);
      const scale = num(args.scale, d.pack.maxContPowerW);
      profile = { dtS: pr.dtS, w: pr.p.map((x) => x * scale) };
    } else { console.error('No load profile for this application — give --profile or --scale.'); process.exit(2); }
    const r = simulate({
      cell, s: d.pack.s, p: d.pack.p, params, profile,
      startSoC: num(args.soc, 1) > 1 ? num(args.soc) / 100 : num(args.soc, 1),
      ambientC: num(args.ambient, 25), nModules: num(args.modules, 4),
      years: num(args.years, spec.targetYears ?? 8), cyclesPerYear: num(args.cycles, spec.cyclesPerYear ?? 250),
    });
    const q = r.summary;
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}, ${(d.pack.energyWh / 1000).toFixed(1)} kWh, ${q.nModules} modules`,
      '',
      'Electrical',
      `  SoC          ${(q.startSoC * 100).toFixed(0)}% → ${(q.endSoC * 100).toFixed(1)}% (minimum ${(q.minSoC * 100).toFixed(1)}%)`,
      `  Voltage      minimum ${q.minV.toFixed(1)} V under load`,
      `  Energy       ${q.energyOutWh.toFixed(0)} Wh out, ${q.energyInWh.toFixed(0)} Wh recovered, ${q.lossWh.toFixed(0)} Wh lost (${q.efficiencyPct?.toFixed(1)}% efficient)`,
      ...(q.unmetWh > 0 ? [`  UNMET        ${q.unmetWh.toFixed(0)} Wh — the pack could not follow the demand`] : []),
      '',
      'Thermal',
      `  Peak module  ${q.maxTempC.toFixed(1)} °C`,
      `  Spread       ${q.tempSpreadK.toFixed(2)} K between hottest and coldest module`,
      `  Coolant      out at ${q.coolantOutC.toFixed(1)} °C`,
      `  Reversible   ${q.reversibleHeatWh.toFixed(1)} Wh of entropic heat (negative = the pack cooled itself)`,
      '',
      'Aging',
      ...(r.aging.schedule.length
        ? [...r.aging.schedule.filter((x) => x.year % Math.max(1, Math.round(r.aging.schedule.length / 5)) === 0 || x.year === 1)
          .map((x) => `  year ${String(x.year).padStart(2)}      ${x.remainingPct.toFixed(1)}% capacity, +${x.resistanceGrowthPct.toFixed(1)}% resistance`),
        `  reaches 80% ${r.aging.yearsTo80Pct ? `in year ${r.aging.yearsTo80Pct}` : 'beyond the horizon simulated'}`]
        : ['  (give --years and --cycles for an aging estimate)']),
      '',
      ...(r.findings.length ? ['Findings', ...r.findings.map((f) => `  ${f.severity.toUpperCase()}: ${f.title} — ${f.detail}`), ''] : []),
      'Assumptions',
      ...r.assumptions.map((a) => `  · ${a}`),
      ...(r.paramNotes.length ? ['', 'Parameters adjusted:', ...r.paramNotes.map((n) => `  · ${n}`)] : []),
    ];
    emit(args, { apiVersion: API_VERSION, design: { cell: d.cell.id, s: d.pack.s, p: d.pack.p }, ...r }, lines.join('\n'));
  },

  // Correct the model against your own measurements. This is the command
  // that turns a class-typical model into a model of YOUR cell.
  calibrate(args) {
    if (!args.data) { console.error('Give --data FILE.csv with columns: time_s,current_A,voltage_V[,temp_C]'); process.exit(2); }
    const measured = readMeasuredCsv(args.data);
    const cell = cellById(args.cell || 'samsung-inr21700-50e');
    if (!cell) { console.error(`Unknown cell "${args.cell}". Use: cells`); process.exit(2); }
    const fit = (args.fit === true || !args.fit ? 'r0Ref,rc1R,rc1TauS' : args.fit).split(',').map((x) => x.trim());
    const unknown = fit.filter((f) => !PARAM_BY_ID[f]);
    if (unknown.length) { console.error(`Not parameters: ${unknown.join(', ')}. Run: params`); process.exit(2); }
    const out = calibrate({
      cell, s: num(args.s, 1), p: num(args.p, 1), measured,
      params: args.params ? loadParams(args.params) : null,
      fit, startSoC: num(args.soc, 1) > 1 ? num(args.soc) / 100 : num(args.soc, 1),
      ambientC: num(args.ambient, 25), nModules: num(args.modules, 1),
      maxIter: num(args.iter, 300),
    });
    const lines = [
      `Calibrated ${cell.name} against ${measured.i.length} measured points (${args.data})`,
      `  RMSE ${out.rmseBefore.toFixed(4)} V → ${out.rmseAfter.toFixed(4)} V  (${out.improvementPct.toFixed(1)}% closer, ${out.iterations} iterations)`,
      '',
      pad('parameter', 14) + pad('default', 12) + pad('fitted', 12) + pad('change', 12) + 'unit',
      ...Object.entries(out.fitted).map(([k, f]) => pad(k, 14) + pad(f.from?.toFixed(3), 12) + pad(f.to?.toFixed(3), 12)
        + pad(f.changedPct != null ? `${f.changedPct > 0 ? '+' : ''}${f.changedPct.toFixed(1)}%` : '—', 12)
        + f.unit + (f.atBound ? '   ← AT ITS LIMIT' : '')),
      '',
      out.note,
      '',
      `Save these with --out params.json, then use them everywhere: sim2 --params params.json`,
    ];
    emit(args, { apiVersion: API_VERSION, cell: cell.id, ...out }, lines.join('\n'));
  },

  // Every knob, what it means, and what it is allowed to be.
  params(args) {
    const cell = args.cell ? cellById(args.cell) : null;
    const defs = defaultParams(cell);
    if (args.json || args.out) { emit(args, defs, ''); return; }
    let group = null;
    const lines = [`Model parameters${cell ? ` for ${cell.name}` : ' (generic defaults)'} — every one of these is yours to change:`];
    for (const s of PARAM_SPEC) {
      if (s.group !== group) { group = s.group; lines.push('', group.toUpperCase()); }
      lines.push(`  ${pad(s.id, 17)}${pad(defs[s.id], 11)}${pad(s.unit, 26)}${s.min}…${s.max}`);
      lines.push(`  ${' '.repeat(17)}${s.why}`);
      lines.push(`  ${' '.repeat(17)}source: ${s.source}`);
    }
    lines.push('', 'Dump them with --json --out params.json, edit, then: sim2 --params params.json');
    lines.push('Or let your own measurements set them: calibrate --data test.csv --fit r0Ref,rc1R,rc1TauS');
    console.log(lines.join('\n'));
  },

  // Export the pack as an FMI 2.0 co-simulation FMU, so the rest of the
  // toolchain — ANSYS Twin Builder, Simulink, GT-SUITE, Dymola — can drive it.
  fmu(args) {
    const spec = specFrom(args);
    const d = designFromSpec(spec);
    const cell = cellById(d.cell.id);
    const dir = args.out === true || !args.out ? './fmu' : args.out;
    const built = buildFmu({
      cell, s: d.pack.s, p: d.pack.p,
      params: args.params ? loadParams(args.params) : null,
      modelName: args.name || 'BatteryPack',
    });
    for (const [rel, content] of Object.entries(built.files)) {
      const full = path.join(dir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    console.log([
      `FMI 2.0 co-simulation FMU for ${d.pack.s}S${d.pack.p}P ${cell.name}`,
      `  written to ${dir}/`,
      ...Object.keys(built.files).map((f) => `    ${f}`),
      `  model ${built.modelName}, guid ${built.guid}`,
      '',
      built.note,
      `Build it with the command in ${dir}/README.md, then load the .fmu in your host tool.`,
    ].join('\n'));
  },

  // What can this thing do? Including what it cannot do yet.
  addons(args) {
    const rep = capabilityReport(args.app || null);
    if (args.json || args.out) { emit(args, rep, ''); return; }
    const line = (a) => `  ${a.status === 'shipped' ? '✓' : '·'} ${pad(a.id, 14)}${pad(a.tier, 9)}${a.name}`
      + `\n      ${a.what}`
      + (a.status === 'planned' ? `\n      NOT BUILT YET — ${a.why}` : '');
    console.log([
      rep.note, '',
      'CORE — always present', ...rep.addons.filter((a) => a.tier === 'core').map(line), '',
      'IN THE PAGE', ...rep.addons.filter((a) => a.tier === 'browser').map(line), '',
      'DESKTOP RUNNER', ...rep.addons.filter((a) => a.tier === 'desktop').map(line),
      ...(rep.notRelevant.length ? ['', `NOT FOR THIS APPLICATION: ${rep.notRelevant.map((a) => a.id).join(', ')}`] : []),
    ].join('\n'));
  },

  // Wiring, joints and the bill of materials the customer receives.
  bom(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({
      summary: d.pack, partition: d.architecture.partition, cellForm: cell.form,
      busbarMaterial: args.busbar, cableMaterial: args.cable || 'copper',
      plating: args.plating || 'tin',
      lengths: {
        groupPitchMm: num(args.pitch), moduleRunMm: num(args.modrun), packRunMm: num(args.packrun),
      },
    });
    const env = args.env || 'normal';
    const joints = jointCompatibility(topo, env);
    const failing = joints.filter((j) => !j.risk.ok);
    const bom = billOfMaterials({ topology: topo, summary: d.pack, cell, selection: {} });
    // The temperature limit is what the SURROUNDINGS tolerate, not what the
    // copper survives. Beside cells that is the cell's own upper discharge
    // temperature, which the library already knows — so the default is the
    // right number without anyone being asked for it.
    const maxTempC = num(args.maxtemp) ?? cell.tempDischargeC?.[1] ?? 90;
    const install = args.install || 'free-air';
    const study = wiringStudy({
      topology: topo, packV: d.pack.nominalV, ambientC: num(args.ambient, 25),
      installation: install, maxTempC, dropLimitPct: num(args.droplimit, 2),
    });
    const t = topo.totals;
    const w = study.totals;
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}`,
      '',
      'WIRING',
      `  Interconnect      ${t.interconnectMOhm.toFixed(2)} mΩ total through ${topo.edges.length} runs`,
      `  At ${Math.round(d.pack.maxContCurrentA)} A continuous   ${w.seriesDropV.toFixed(2)} V dropped, ${w.totalHeatW.toFixed(0)} W lost in the conductors`,
      `  Conductor mass    ${t.conductorMassKg.toFixed(2)} kg`,
      ...(topo.estimated ? [`  NOTE  ${topo.notes[0]}`] : []),
      '',
      `CONDUCTOR SIZING (${(INSTALLATIONS[install]?.name || install).toLowerCase()}, ${maxTempC} °C limit, ${num(args.ambient, 25)} °C ambient)`,
      `  ${study.headline}`,
      `  ${w.runsChecked} runs checked · ${w.failing} undersized · ${w.costly} hot or dropping voltage`,
      ...(study.findings.length
        ? study.findings.map((f) => `  ${f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '!' : 'i'} ${f.title}\n${wrap(f.detail, 6)}`)
        : ['  ✓ Every conductor stays inside the limit on both the rule of thumb and the heat balance.']),
      '',
      `JOINTS (${env} environment)`,
      `  ${joints.length} joints, ${failing.length} needing attention`,
      ...failing.slice(0, 4).map((j) => `  ✗ ${j.id}: ${j.risk.why}`),
      ...(failing.length === 0 ? ['  ✓ Every joint is galvanically compatible in this environment.'] : []),
      '',
      'BILL OF MATERIALS',
      pad('  group', 14) + pad('item', 34) + pad('qty', 9) + pad('mass kg', 10) + 'cost',
      ...bom.lines.map((l) => pad('  ' + l.group, 14) + pad(l.item.slice(0, 32), 34)
        + pad(`${l.qty} ${l.unit}`, 9) + pad(l.massKg != null ? l.massKg.toFixed(2) : '—', 10)
        + (l.totalCost != null ? `$${Math.round(l.totalCost).toLocaleString()}` : '—')),
      `  ${'-'.repeat(60)}`,
      pad('  TOTAL', 48) + pad(bom.totals.massKg.toFixed(1), 10) + `$${Math.round(bom.totals.knownCost).toLocaleString()} of ${bom.totals.pricedLines} priced lines`,
      '',
      `  ${bom.note}`,
    ];
    emit(args, {
      apiVersion: API_VERSION,
      topology: { totals: topo.totals, estimated: topo.estimated },
      wiring: { verdict: study.verdict, totals: study.totals, findings: study.findings, assumptions: study.assumptions, runs: study.runs },
      joints, bom,
    }, lines.join('\n'));
  },

  // Bonding: what happens after isolation has already failed.
  ground(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({
      summary: d.pack, partition: d.architecture.partition, cellForm: cell.form,
      busbarMaterial: args.busbar, cableMaterial: args.cable || 'copper',
    });
    // The fault current comes from the short-circuit study the design already
    // ran. Asking for it twice would let the two answers drift apart.
    const fault = faultFromShortCircuit(d.shortCircuit) || {};
    const study = groundingStudy({
      topology: topo, application: d.spec?.application || args.app,
      packVMax: d.pack.vMax, isolation: d.architecture?.isolation,
      faultA: num(args.fault) ?? fault.faultA,
      clearingS: num(args.clearing) ?? fault.clearingS,
      faultBasis: fault.basis,
      finish: args.finish || 'bare',
      method: args.bond || 'bolt-serrated',
      strapMaterial: args.strap || 'copper',
      bonds: args.strapmm2 || args.straplen
        ? [{
          id: 'bond-enclosure', from: 'Pack enclosure', to: 'Chassis / vehicle earth',
          materialId: args.strap || 'copper',
          lengthMm: num(args.straplen, 250), areaMm2: num(args.strapmm2, 16),
          finish: args.finish || 'bare', method: args.bond || 'bolt-serrated',
        }]
        : null,
    });
    const iso = d.architecture?.isolation;
    const lines = [
      `${d.application?.name || 'Custom'} — ${d.pack.s}S${d.pack.p}P ${cell.name}, ${d.pack.vMax.toFixed(0)} V max`,
      '',
      'ISOLATION — keeping fault current off the case',
      ...(iso
        ? [`  ${iso.floorKOhm.toFixed(0)} kΩ floor at ${iso.ohmsPerVolt} Ω/V (${iso.standardLabel})`,
          `  ${wrap(iso.oemPracticeNote, 2).trimStart()}`]
        : ['  Below 60 V DC — no isolation-monitoring burden.']),
      '',
      'BONDING — what happens when isolation has already failed',
      `  ${wrap(study.headline, 2).trimStart()}`,
      study.ungrounded
        ? `  ${plural(study.totals.pathsChecked, 'path')} measured, against a rule that does not govern this machine`
        : `  ${plural(study.totals.pathsChecked, 'path')} checked · ${study.totals.failing} inadequate · ${study.totals.costly} marginal`,
      ...(study.findings.length
        ? study.findings.map((f) => `  ${f.severity === 'fail' ? '✗' : f.severity === 'warn' ? '!' : 'i'} ${f.title}\n${wrap(f.detail, 6)}`)
        : ['  ✓ Every bonding path is inside the limit and survives the fault.']),
      '',
      'PATHS',
      pad('  id', 20) + pad('material', 24) + pad('mΩ', 9) + pad('touch V', 10) + 'verdict',
      ...study.paths.map((b) => pad('  ' + b.id, 20)
        + pad((materialById(b.materialId)?.name || b.materialId).slice(0, 22), 24)
        + pad((b.resistanceOhm * 1000).toFixed(2), 9)
        + pad(b.touchV != null ? b.touchV.toFixed(1) : '—', 10) + b.verdict),
      '',
      'ASSUMPTIONS',
      ...study.assumptions.map((a) => bullet(a)),
    ];
    emit(args, { apiVersion: API_VERSION, isolation: iso || null, grounding: study }, lines.join('\n'));
  },

  // Everything the tool knows about one design, in one prioritised list —
  // including the wiring and grounding studies the browser tier does not run.
  brief(args) {
    const d = designFromSpec(specFrom(args));
    const cell = cellById(d.cell.id);
    const topo = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cell.form });
    const wiring = wiringStudy({
      topology: topo, packV: d.pack.nominalV, ambientC: num(args.ambient, 25),
      installation: args.install || 'free-air',
      maxTempC: num(args.maxtemp) ?? cell.tempDischargeC?.[1] ?? 90,
    });
    const fault = faultFromShortCircuit(d.shortCircuit) || {};
    const grounding = groundingStudy({
      topology: topo, application: d.spec?.application || args.app, packVMax: d.pack.vMax,
      isolation: d.architecture?.isolation,
      faultA: fault.faultA, clearingS: fault.clearingS, faultBasis: fault.basis,
      finish: args.finish || 'bare', method: args.bond || 'bolt-serrated',
    });
    const b = designBrief(d, { wiring, grounding });
    const mark = { fail: '✗', warn: '!', info: 'i', pass: '✓' };
    const show = num(args.top, 12);
    const lines = [
      `${b.pack.application || 'Custom'} — ${b.pack.s}S${b.pack.p}P ${b.pack.cell}, ${(b.pack.energyWh / 1000).toFixed(1)} kWh`,
      '',
      wrap(b.headline),
      `${b.counts.fail} must fix · ${b.counts.warn} worth knowing · ${b.counts.info} noted · ${b.counts.total} checks reported`,
      '',
      `WHAT MATTERS, IN ORDER${b.counts.total > show ? ` (top ${show} of ${b.counts.total})` : ''}`,
      ...b.findings.slice(0, show).flatMap((f) => [
        `  ${mark[f.severity] || '·'} ${f.title}   [${f.sources.join(' + ')}${f.ref ? ` · ${f.ref}` : ''}]`,
        wrap(f.detail, 6),
      ]),
      '',
      'WHAT WOULD CHANGE THE ANSWER — questions for you',
      ...(b.questions.length
        ? b.questions.flatMap((q) => [`  ? ${q.asks}`, wrap(q.why, 6), wrap(`→ ${q.how}`, 6)])
        : ['  Nothing material is being guessed.']),
      '',
      'NOT CHECKED',
      ...b.notChecked.map((n) => bullet(n)),
    ];
    emit(args, { apiVersion: API_VERSION, brief: b }, lines.join('\n'));
  },

  apps(args) {
    const list = listApplications();
    emit(args, list, list.map((a) =>
      `${pad(a.id, 14)}${pad(a.class, 12)}${pad((a.typicalEnergyWh / 1000).toFixed(1) + ' kWh', 11)}${a.name}`).join('\n'));
  },

  cells(args) {
    const list = listCells({ chemistry: args.chemistry, form: args.form });
    emit(args, list, list.map((c) =>
      `${pad(c.id, 30)}${pad(c.chemistry, 8)}${pad(c.form, 13)}${pad(c.energyWh.toFixed(1) + ' Wh', 10)}${c.priceUSD != null ? '$' + c.priceUSD : '—'}`).join('\n'));
  },

  // The web UI, served from your own machine — offline, no CDN, no telemetry.
  serve(args) {
    const port = num(args.port, 8080);
    const MIME = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
      '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
    };
    const server = createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // Read a JSON body, then hand it to a handler. Every desktop endpoint
      // answers with either a result or a readable reason — never a stack.
      const withBody = (handler) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try { json(200, handler(JSON.parse(body || '{}'))); }
          catch (e) { json(400, { error: e.message }); }
        });
      };

      // The page asks this first. Its answer is what turns the desktop
      // capabilities on in the interface: same UI, ceiling removed.
      if (url === '/api/capabilities') {
        return json(200, {
          runner: 'battery-design desktop', apiVersion: API_VERSION,
          cores: coreCount(),
          capabilities: ADDONS.filter((a) => a.tier === 'desktop' && a.status === 'shipped')
            .map((a) => ({ id: a.id, name: a.name, what: a.what })),
          endpoints: ['/api/design', '/api/sim2', '/api/calibrate', '/api/search', '/api/fmu'],
        });
      }
      if (url === '/api/design' && req.method === 'POST') return withBody((spec) => designFromSpec(spec));

      // The advanced electro-thermal model — the one the browser cannot
      // reasonably run, now reachable from the same panel it belongs in.
      if (url === '/api/sim2' && req.method === 'POST') {
        return withBody((body) => {
          const d = designFromSpec(body.spec || {});
          const cell = cellById(d.cell.id);
          // Where the load comes from, in order of how much it knows:
          // what the caller sent, then the vehicle's own physics, then the
          // application's characteristic profile. Only if all three are
          // absent is there genuinely nothing to simulate.
          const prof = body.profile || (() => {
            const app = d.spec.resolved.application;
            const veh = vehicleDefaultsFor(app);
            if (veh) {
              const drive = driveCyclePower({
                trace: traceForApp(app), vehicle: veh,
                mode: body.driveMode || 'normal', packMassKg: d.pack.massKg,
              });
              return { dtS: drive.dtS, w: drive.w };
            }
            if (d.simulation?.profile?.id) {
              const pr = profileById(d.simulation.profile.id);
              if (pr) {
                const scale = body.scaleW || d.pack.maxContPowerW || 1000;
                return { dtS: pr.dtS, w: pr.p.map((x) => x * scale) };
              }
            }
            throw new Error('Nothing to simulate: pick an application on the Usage tab, or send a profile of your own.');
          })();
          const r = simulate({
            cell, s: d.pack.s, p: d.pack.p, params: body.params || null, profile: prof,
            startSoC: body.startSoC ?? 1, ambientC: body.ambientC ?? 25,
            nModules: body.nModules ?? 4,
            years: body.years ?? 8, cyclesPerYear: body.cyclesPerYear ?? 250,
          });
          // The full series would be megabytes over the wire for no gain.
          return { ...r, series: undefined, seriesLength: r.series.t.length };
        });
      }

      // Correct the model against measured data, from the browser.
      if (url === '/api/calibrate' && req.method === 'POST') {
        return withBody((body) => {
          const cell = cellById(body.cell) || cellById('samsung-inr21700-50e');
          return calibrate({
            cell, s: body.s ?? 1, p: body.p ?? 1, measured: body.measured,
            params: body.params || null, fit: body.fit || ['r0Ref', 'rc1R', 'rc1TauS'],
            startSoC: body.startSoC ?? 1, ambientC: body.ambientC ?? 25,
            nModules: body.nModules ?? 1,
          });
        });
      }

      // Design-space search across every core.
      if (url === '/api/search' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          try {
            const b = JSON.parse(body || '{}');
            const pool = b.chemistry ? CELLS.filter((c) => c.chemistry === b.chemistry) : CELLS;
            const from = b.from ?? 20000, to = b.to ?? 100000, step = b.step ?? 5000;
            const jobs = [];
            for (const c of pool) {
              for (let e = from; e <= to; e += step) {
                jobs.push({
                  index: jobs.length, variable: 'cell×energy', value: `${c.id} @ ${(e / 1000).toFixed(0)} kWh`,
                  meta: { targetWh: e }, spec: { ...(b.spec || {}), cell: c.id, energyWh: e },
                });
              }
            }
            const { rows, workers, mode } = await runPool(jobs);
            json(200, { searched: rows.length, workers, mode, rows: rows.filter((r) => !r.error) });
          } catch (e) { json(400, { error: e.message }); }
        });
        return;
      }

      // Co-simulation export: the FMU as files the page can offer as a download.
      if (url === '/api/fmu' && req.method === 'POST') {
        return withBody((body) => {
          const d = designFromSpec(body.spec || {});
          const cell = cellById(d.cell.id);
          return buildFmu({ cell, s: d.pack.s, p: d.pack.p, params: body.params || null,
            modelName: body.modelName || 'BatteryPack' });
        });
      }
      let file = path.join(ROOT, url);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      createReadStream(file).pipe(res);
    });
    server.listen(port, () => {
      console.log(`Battery designer running at http://localhost:${port}`);
      console.log(`The full interface, with the desktop capabilities unlocked: `
        + ADDONS.filter((a) => a.tier === 'desktop' && a.status === 'shipped').map((a) => a.name).join(', ') + '.');
      console.log(`Using ${coreCount()} cores. Offline, on your machine. Nothing is sent anywhere. Ctrl-C to stop.`);
    });
  },

  help() { console.log(HELP); },
};

const pad = (v, n) => String(v ?? '—').padEnd(n);

// Findings are written as prose because that is what makes them readable.
// Prose in a terminal needs wrapping, or it becomes one line that scrolls.
function wrap(text, indent = 0, width = 92) {
  const pre = ' '.repeat(indent);
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && (line.length + 1 + word.length) > width - indent) { out.push(pre + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(pre + line);
  return out.join('\n');
}

// A wrapped bullet, with its continuation lines indented past the marker so
// the eye can tell one item from the next.
const bullet = (text, indent = 2) => {
  const body = wrap(text, indent + 2);
  return `${' '.repeat(indent)}· ${body.slice(indent + 2)}`;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A parameter file is plain JSON: dump it, edit it in any editor, hand it back.
function loadParams(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Could not read parameters from ${file}: ${e.message}`);
    process.exit(2);
  }
}

// Measured data: time_s, current_A, voltage_V and optionally temp_C. Header
// optional, comma or semicolon or tab, because real exports vary.
function readMeasuredCsv(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(2); }
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/[,;\t]/).map((x) => parseFloat(x)))
    .filter((r) => r.length >= 3 && r.every((x, i) => i > 3 || isFinite(x)));
  if (rows.length < 3) { console.error(`${file}: need at least 3 rows of time_s,current_A,voltage_V`); process.exit(2); }
  const dtS = rows.length > 1 ? (rows[1][0] - rows[0][0]) : 1;
  if (!(dtS > 0)) { console.error(`${file}: the time column must increase.`); process.exit(2); }
  return {
    dtS,
    i: rows.map((r) => r[1]),
    v: rows.map((r) => r[2]),
    t: rows.every((r) => isFinite(r[3])) ? rows.map((r) => r[3]) : null,
  };
}

const HELP = `battery-design — desktop runner (API v${API_VERSION})

  design    one design, fully worked           --app ev --energy 60000 [--cell ID] [--s N --p N]
  mission   the design driven through time     --app ebus --passes 6 [--charge base --minutes 120]
  sim2      the full model: RC dynamics,       --app ev [--modules 8] [--ambient 35] [--params p.json]
            entropic heat, per-module
            temperatures, coolant, aging
  calibrate correct the model against YOUR     --data test.csv --cell ID [--fit r0Ref,rc1R,rc1TauS]
            measurements
  params    every coefficient, with bounds     [--cell ID] [--json --out params.json]
  sweep     one variable across a range        --vary cell|mass|payload|energy [--from --to --step]
  search    the whole design space, ranked     --app ev --rank cost|range|mass|density|upfront [--top N]
  range     drive-cycle study, mass × mode     --app ev --energy 60000 [--from --to --step]
  fmu       export as an FMI 2.0 co-sim FMU    --app ev [--out ./fmu] [--params p.json]
  addons    what this tool can do, and cannot   [--app ev]
  bom       every conductor sized, every       --app ev [--install bundled] [--env harsh]
            joint checked, and the bill of     [--modrun 300 --packrun 400 --pitch 25]
            materials you hand over
  brief     every check in one ordered list,   --app ev --energy 60000 [--top 20]
            plus what the tool is guessing
  ground    isolation, bonding paths and       --app ev [--finish anodised] [--bond bolt-plain]
            whether the bond survives the      [--strap aluminium --strapmm2 25]
            fault it exists for
  apps      the application presets
  cells     the cell library                   [--chemistry LFP] [--form cylindrical]
  serve     the web UI from your own machine   [--port 8080]

Common flags
  --app ID          application preset (see: apps)          --market eu|us|cn|intl
  --cell ID         cell from the library (see: cells)      --v2x off|v2l|v2h|v2g
  --energy WH       energy target                           --mode eco|normal|sport
  --s N --p N       explicit series/parallel                --mass KG --payload KG
  --dod 0.8         usable depth of discharge               --grade PCT   route gradient
  --profile ID      load profile, or "vehicle" for physics  --soc 0.9     mission start SoC
  --json            machine-readable output                 --out FILE    write JSON to a file
  --jobs N          worker threads (default: every core)     --top N       how many results to show
  --chemistry LFP   restrict a sweep or search              --all         include designs that FAIL the audit

Wiring flags (bom)
  --install free-air|bundled|potted|plate-bonded   how the runs are installed; it changes
                                                   how hot they get more than anything else
  --modrun MM --packrun MM --pitch MM              REAL run lengths. Without them the tool
                                                   estimates from the pack envelope and says so
  --maxtemp C       temperature limit (default: the cell's own upper discharge rating)
  --ambient C       ambient the runs sit in (default 25)   --droplimit PCT  voltage budget (default 2)
  --busbar ID --cable ID --plating ID              conductor and plating materials
  --env harsh|normal|dry                           environment for the galvanic check

Grounding flags (ground)
  --finish bare|conversion-coated|anodised|painted  the enclosure surface the bond lands on.
                                                    Anodised and painted do not conduct
  --bond bolt-plain|bolt-serrated|welded|strap-bolted   what makes the connection. Only a
                                                    serrated washer or a weld cuts a coating
  --strap ID --strapmm2 MM2 --straplen MM          the bonding strap itself
  --fault A --clearing S                           override the fault current and clearing
                                                    time (default: from the short-circuit study)

Big runs use every core. Small ones stay on one thread on purpose: starting a
worker costs more than the few designs it would have saved. Serial and
parallel runs return identical rows.

Everything runs locally. No network, no account, no telemetry.`;

// --- entry ------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';
const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`Unknown command "${cmd}".\n`);
  console.log(HELP);
  process.exit(2);
}
// Some commands fan out across worker threads and are therefore async.
await fn(args);
