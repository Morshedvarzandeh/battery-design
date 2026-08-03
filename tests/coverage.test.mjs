// Coverage — the tests that exist so nothing gets lost.
//
// The knowledge graph was built early and is meant to be the one place that
// answers "which applications need this". Then eighteen months of modules
// were added without edges, and by the time anyone looked, eight modules and
// eleven add-ons were invisible to it — so `addonsFor()` could not filter
// them and they were offered to every application, including a route
// simulation for a wearable.
//
// Nothing failed. That is the point: a graph silently ceasing to cover the
// tool produces no error, just quietly wrong answers. These tests are the
// alarm that was missing, and they are deliberately structural rather than
// example-based — they check that every capability HAS a place, not that
// particular ones do.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPTS, NEEDS, needed, appNeeds, validateGraph } from '../js/knowledge.js';
import { ADDONS, addonsFor, validateAddonConcepts } from '../js/addons.js';
import { PRESETS } from '../js/presets.js';
import { appClassOf } from '../js/markets.js';


// Comments and string literals are prose, not behaviour. Testing raw source
// made "temperature window." in a finding read as DOM access and the camera's
// own pitch read as a cell pitch — false alarms that would have trained the
// next person to delete the check.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/^\s*#[^\n]*/gm, ' ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the graph is internally consistent', () => {
  ok(validateGraph().length === 0, `graph valid: ${validateGraph().join('; ')}`);
  for (const [id, c] of Object.entries(CONCEPTS)) {
    ok(c.label && c.why, `${id} says what it is and what knowing it buys`);
    ok(NEEDS[id], `${id} has an edge — a concept nothing points at is invisible`);
  }
  for (const id of Object.keys(NEEDS)) {
    ok(CONCEPTS[id], `edge "${id}" names a concept that exists`);
  }
});

test('every add-on is findable in the graph', () => {
  // The check that would have caught the drift. It is not about any one
  // add-on: it is that a capability with no concept cannot be filtered, so
  // it leaks to every application by default.
  const errors = validateAddonConcepts(CONCEPTS);
  ok(errors.length === 0, `every add-on declares a real concept: ${errors.join('; ')}`);
  for (const a of ADDONS) {
    ok(a.concepts[0], `${a.id} has a defining concept`);
    ok(CONCEPTS[a.concepts[0]], `${a.id}'s defining concept "${a.concepts[0]}" is in the graph`);
  }
});

test('a specialised add-on cannot smuggle itself in on a universal concept', () => {
  // The bug this pins: gating on ANY concept meant crush — which declares
  // ['crush', 'spaces-why'] — reached a wearable, because every application
  // needs spaces-why. An add-on is defined by the one thing it is for.
  ok(!needed('wearable', 'crush'), 'a wearable does not need crush simulation');
  const offered = addonsFor('wearable').map((a) => a.id);
  ok(!offered.includes('crush'), 'and it is not offered one');
  ok(!offered.includes('vibration'), 'nor vibration, which it also does not need');
  // But it still gets the things it does need.
  ok(offered.includes('pack') && offered.includes('audit'), 'core add-ons always survive filtering');
  // And a machine that DOES need crush is offered it.
  ok(addonsFor('ev').map((a) => a.id).includes('crush'), 'a road vehicle is');
});

test('how a machine moves is one domain, never borrowed from another', () => {
  // A ship is not a slow car. Each application gets the physics that matches
  // how it actually moves, and a shared node would let road assumptions —
  // gradient, rolling resistance — reach a boat.
  const domains = ['route-road', 'terrain', 'hull-resistance', 'flight-weather', 'legged-gait'];
  const of = (app) => domains.filter((d) => needed(app, d));

  ok(of('marine').includes('hull-resistance'), 'a boat gets hull resistance');
  ok(!of('marine').includes('route-road') && !of('marine').includes('terrain'),
    'and no road physics at all — resistance rises with the cube of speed, not with a gradient');
  ok(of('drone').includes('flight-weather'), 'a drone gets flight and weather');
  ok(!of('drone').includes('terrain') && !of('drone').includes('route-road'), 'and nothing that touches the ground');
  ok(of('humanoid').includes('legged-gait') && !of('humanoid').includes('route-road'),
    'a humanoid walks rather than rolls');
  ok(of('ev').includes('route-road'), 'a car gets a road route');
  ok(of('solar-ess').length === 0, 'and a stationary pack gets none of it, because it does not travel');
});

test('every application has an answer for every concept', () => {
  // Not that it needs everything — that the graph has an opinion either way.
  // A concept with no edge defaults to "needed", which is how an unfiltered
  // capability reaches everyone without anyone deciding it should.
  for (const p of PRESETS) {
    ok(appClassOf(p.id), `${p.id} belongs to a class, or no edge can reach it`);
    const mine = appNeeds(p.id);
    ok(mine.length > 0, `${p.id} needs at least something`);
    ok(mine.length < Object.keys(CONCEPTS).length,
      `${p.id} does NOT need everything — a graph that says yes to all is not filtering`);
  }
});

test('the profile library on disk matches its manifest', () => {
  // The library is data now, so the failure mode moved: a profile can be
  // present and unlisted, or listed and missing, and neither would surface
  // until someone picked it.
  const dir = path.join(ROOT, 'profiles');
  ok(existsSync(dir), 'the profile library exists');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  ok(manifest.profiles.length > 0, 'the manifest lists profiles');
  ok(manifest.schema, 'and documents the shape, so a contributor does not have to read code');

  const onDisk = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  ok(onDisk.length === manifest.profiles.length,
    `every file is listed and every listing has a file (${onDisk.length} files, ${manifest.profiles.length} listed)`);

  for (const entry of manifest.profiles) {
    const file = path.join(dir, entry.file);
    ok(existsSync(file), `${entry.id}: the file the manifest names exists`);
    const p = JSON.parse(readFileSync(file, 'utf8'));
    ok(p.id === entry.id, `${entry.id}: the file agrees with the manifest about its own id`);
    ok(p.dtS > 0, `${entry.id}: has a time step`);
    ok(Array.isArray(p.p) && p.p.length > 0, `${entry.id}: has samples`);
    ok(p.p.every((v) => Number.isFinite(v) && v >= -1.5 && v <= 1.5),
      `${entry.id}: samples are normalised, +1 = peak discharge`);
    ok(p.note, `${entry.id}: says what it represents`);
    for (const a of p.appIds || []) {
      ok(PRESETS.some((x) => x.id === a), `${entry.id}: names a real application "${a}"`);
    }
  }
});

test('a shipped add-on names a module that is actually there', () => {
  // "Shipped" is a claim, and a claim about a file is cheap to check.
  for (const a of ADDONS.filter((x) => x.status === 'shipped')) {
    ok(!/^planned/.test(a.module), `${a.id} says shipped, so it must not say planned`);
    // The module field may name several files, or a directory path.
    for (const f of a.module.split(/\s*\+\s*/)) {
      const rel = f.trim();
      if (!rel.endsWith('.js') && !rel.endsWith('.mjs')) continue;
      const candidates = [path.join(ROOT, 'js', rel), path.join(ROOT, rel)];
      ok(candidates.some((c) => existsSync(c)), `${a.id}: ${rel} exists`);
    }
  }
});

test('the engine never depends on the panels', () => {
  // Modularity, enforced rather than asserted in a README.
  //
  // Every module in js/ is either ENGINE (it computes) or SURFACE (it draws).
  // The rule is one-directional: surface may import engine, engine may never
  // import surface. It is what makes the headless API, the desktop runner,
  // the MCP server and now a renderer in another language all the same
  // designer rather than four that agree by luck.
  //
  // It is also the rule that rots first, because importing a formatter from
  // app.js to print one number is always the shortest path.
  const SURFACE = new Set([
    'app.js', 'viewer2d.js', 'viewer3d.js', 'garage-ui.js', 'garage3d-host.js',
    'cell-picker.js', 'radar.js', 'bay-import.js', 'training.js', 'excel.js',
    'desktop-link.js',
    // Browser-only by requirement, not by accident: a customer's own cell data
    // is stored in THEIR browser and nowhere else, so this module cannot be
    // made to run headless without breaking the promise that keeps it private.
    'mycells.js',
  ]);
  const files = readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    if (SURFACE.has(f)) continue;
    const src = readFileSync(path.join(ROOT, 'js', f), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s+'\.\/([^']+)'/gm)].map((m) => m[1]);
    for (const dep of imports) {
      ok(!SURFACE.has(dep), `${f} imports ${dep}, which draws — the engine must not depend on a panel`);
    }
    ok(!/\b(?:document|localStorage|sessionStorage)\.[a-zA-Z]|\bwindow\.(?:addEventListener|document|location)/
      .test(strip(src)),
    `${f} touches the DOM — it would stop running in Node, the desktop runner and the tests`);
  }
});

test('the 3D renderer is a face, not a second opinion', () => {
  // The whole safety case for embedding a game engine. GDScript has no access
  // to the design modules and cannot be tested by this suite, so the boundary
  // is what gets checked: the renderer may only be handed data, and the file
  // that hands it over may not compute any of it.
  const gd = readFileSync(path.join(ROOT, 'garage3d', 'garage.gd'), 'utf8');
  // Arithmetic that would mean the renderer is deriving pack geometry rather
  // than reading it. Unit conversion (MM) and camera maths are allowed and
  // named; anything reaching for a cell pitch, a gap or a count is not.
  // Terms that could only mean the renderer is deriving pack geometry or
  // electrical quantities rather than reading them. Deliberately specific:
  // camera "pitch" and Godot's own "light_energy" are legitimate, and a list
  // blunt enough to catch those is a list someone will delete.
  const code = strip(gd);
  for (const banned of ['spacing_mm', 'wall_mm', 'cell_pitch', 'energy_wh', 'capacity_ah',
    'nominal_v', 'wh_per', 'series_count', 'parallel_count']) {
    ok(!code.toLowerCase().includes(banned),
      `garage.gd computes with "${banned}" — geometry and quantities come from the payload, never from here`);
  }
  ok(/scene\.get\(|parsed\.get\(|\.get\("/.test(gd), 'it reads the payload');

  const host = readFileSync(path.join(ROOT, 'js', 'garage3d-host.js'), 'utf8');
  ok(!/designFromSpec|layoutPack|summarize|analyze/.test(host),
    'the host posts scenes and nothing else — it must not build one');
});
