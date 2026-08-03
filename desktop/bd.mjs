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

import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  designFromSpec, briefFromDesign, listApplications, listCells, API_VERSION,
} from '../js/api.js';
import { CELLS } from '../js/cells.js';
import { vehicleDefaultsFor, traceForApp, driveCyclePower, rangeKm } from '../js/vehicle.js';
import { runPool, coreCount, PARALLEL_THRESHOLD } from './pool.mjs';

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
      // The one endpoint the served page gains over the public site: the full
      // engine, computed here rather than in the tab.
      if (url === '/api/design' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const d = designFromSpec(JSON.parse(body || '{}'));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(d));
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
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
      console.log('Offline, on your machine. Nothing is sent anywhere. Ctrl-C to stop.');
    });
  },

  help() { console.log(HELP); },
};

const pad = (v, n) => String(v ?? '—').padEnd(n);

const HELP = `battery-design — desktop runner (API v${API_VERSION})

  design    one design, fully worked           --app ev --energy 60000 [--cell ID] [--s N --p N]
  mission   the design driven through time     --app ebus --passes 6 [--charge base --minutes 120]
  sweep     one variable across a range        --vary cell|mass|payload|energy [--from --to --step]
  search    the whole design space, ranked     --app ev --rank cost|range|mass|density|upfront [--top N]
  range     drive-cycle study, mass × mode     --app ev --energy 60000 [--from --to --step]
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
