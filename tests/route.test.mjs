// Routes and terrain — a real journey instead of a synthetic cycle.
//
// Three bugs were found building this, and all three understated energy in a
// confident direction, which is the dangerous kind. Each has a test here that
// fails if it comes back:
//
//   · smoothing height by FIX COUNT rather than by distance flattened a
//     238 m climb to 103 m and lost the descent entirely;
//   · the trace convention is km/h and the route emitted m/s, which would
//     have understated every speed 3.6x and every aerodynamic term ~13x;
//   · a terrain penalty approximated from the Crr ratio disagreed with the
//     simulation beside it by 50% on sand.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  haversineM, bearingDeg, buildRoute, parseGpx, routeToTrace, validateRoute,
} from '../js/route.js';
import {
  TERRAINS, terrainById, terrainIds, isOffRoad, vehicleOnTerrain, terrainPenalty,
} from '../js/terrain.js';
import { vehicleDefaultsFor, driveCyclePower, traceForApp, rangeKm } from '../js/vehicle.js';
import { designFromSpec } from '../js/api.js';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><name>Alpine test climb</name><trkseg>
<trkpt lat="46.5197" lon="6.6323"><ele>372</ele><time>2026-01-01T08:00:00Z</time></trkpt>
<trkpt lat="46.5250" lon="6.6400"><ele>390</ele><time>2026-01-01T08:00:40Z</time></trkpt>
<trkpt lat="46.5310" lon="6.6500"><ele>445</ele><time>2026-01-01T08:01:30Z</time></trkpt>
<trkpt lat="46.5380" lon="6.6600"><ele>520</ele><time>2026-01-01T08:02:40Z</time></trkpt>
<trkpt lat="46.5450" lon="6.6700"><ele>610</ele><time>2026-01-01T08:04:00Z</time></trkpt>
<trkpt lat="46.5500" lon="6.6800"><ele>580</ele><time>2026-01-01T08:05:00Z</time></trkpt>
</trkseg></trk></gpx>`;

test('distance and bearing are spherical, not flat-earth', () => {
  // One degree of latitude is ~111.2 km anywhere on the globe.
  near(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195, 200, 'a degree of latitude');
  // A degree of longitude shrinks with the cosine of latitude — the whole
  // reason the flat-earth shortcut fails, and marine legs are long enough
  // for it to matter.
  const atEquator = haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  const atSixty = haversineM({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
  near(atSixty / atEquator, 0.5, 0.01, 'a degree of longitude at 60N is half what it is at the equator');
  near(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 0.5, 'due north');
  near(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 0.5, 'due east');
});

test('height is smoothed over DISTANCE, so a sparse route keeps its mountain', () => {
  // The bug: averaging a fixed number of fixes. GPS height error is per-fix
  // and a few metres wide, so five fixes is right at 1 Hz and catastrophic
  // when the fixes are a kilometre apart.
  const r = parseGpx(GPX);
  near(r.totals.climbM, 238, 1, 'the full 238 m climb survives, not the 103 m a fix-count window left');
  near(r.totals.descentM, 30, 1, 'and the descent is not lost entirely');

  // Dense data with per-fix noise is the case smoothing exists for: without
  // it the noise is differentiated into climb that was never ridden.
  const pts = [];
  let lat = 46.5;
  for (let i = 0; i < 200; i++) { lat += 0.00009; pts.push({ lat, lon: 6.63, eleM: 400 + i * 0.2 + Math.sin(i * 2.7) * 3, tS: i }); }
  const smoothed = buildRoute({ points: pts, name: 'dense' });
  const raw = buildRoute({ points: pts, name: 'raw', smoothMetres: 0 });
  ok(raw.totals.climbM > smoothed.totals.climbM * 4,
    `unsmoothed noise inflates the climb ${(raw.totals.climbM / smoothed.totals.climbM).toFixed(1)}x`);
  ok(smoothed.totals.climbM < 100, 'and smoothing brings a ~40 m real climb back to the right order');
  // The unsmoothed gradient is kept so the smoothing can be checked.
  ok(smoothed.segments.some((s) => s.rawGradePct != null), 'the raw gradient is retained per segment');
});

test('GPX is read, and a track beats a plan', () => {
  const r = parseGpx(GPX);
  ok(r.name === 'Alpine test climb' && r.timed && r.hasElevation, 'name, timing and height all read');
  ok(r.totals.pointCount === 6 && r.segments.length === 5, 'six points make five segments');
  near(r.totals.durationS, 300, 1, 'five minutes of recording');
  ok(validateRoute(r).length === 0, 'and it validates');
  ok(parseGpx('not gpx') === null && parseGpx(null) === null, 'nonsense in, null out');
  // A file with no height still works; every gradient is zero and it says so.
  const flat = buildRoute({ points: [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 }] });
  ok(!flat.hasElevation && flat.totals.climbM === null, 'no height, no climb claimed');
  ok(flat.notes.some((n) => /understates the energy/.test(n)), 'and it says what that costs');
});

test('the trace it produces is km/h, which is what the model expects', () => {
  // The bug: emitting m/s into a model that divides by 3.6. Every speed would
  // have been understated 3.6x and every aerodynamic term about thirteen —
  // which reads as an efficient vehicle rather than as a mistake.
  const r = parseGpx(GPX);
  const trace = routeToTrace(r);
  const avgKph = trace.v.reduce((s, v) => s + v, 0) / trace.v.length;
  near(avgKph, r.totals.avgSpeedKph, 5, 'the trace average matches the route average IN km/h');
  ok(avgKph > 40, `${avgKph.toFixed(0)} km/h, not the ~17 that an m/s trace would imply`);
  ok(trace.grade?.length === trace.v.length, 'a gradient accompanies every step');
  ok(!trace.estimated, 'a timed route is not flagged as estimated');
  const untimed = buildRoute({ points: r.points.map(({ lat, lon, eleM }) => ({ lat, lon, eleM })) });
  ok(routeToTrace(untimed, { targetKph: 50 }).estimated, 'an untimed one is');
});

test('the gradient reaches the physics, and it costs what it should', () => {
  const r = parseGpx(GPX);
  const trace = routeToTrace(r);
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const veh = vehicleDefaultsFor('ev');
  const flat = driveCyclePower({ trace: { ...trace, grade: null }, vehicle: veh, packMassKg: d.pack.massKg });
  const real = driveCyclePower({ trace, vehicle: veh, packMassKg: d.pack.massKg });
  ok(real.whPerKm > flat.whPerKm * 2,
    `a 238 m climb over 5 km costs far more than the flat version (${real.whPerKm.toFixed(0)} vs ${flat.whPerKm.toFixed(0)} Wh/km)`);
  ok(rangeKm({ energyWh: d.pack.energyWh, whPerKm: real.whPerKm })
    < rangeKm({ energyWh: d.pack.energyWh, whPerKm: flat.whPerKm }) / 2, 'and less than half the range');
  // A per-step gradient must beat a scalar, or the route bought nothing.
  const scalar = driveCyclePower({ trace: { ...trace, grade: null }, vehicle: veh, packMassKg: d.pack.massKg, gradePct: 4.8 });
  ok(Math.abs(scalar.whPerKm - real.whPerKm) / real.whPerKm < 0.35,
    'a constant gradient at the route average lands in the same region, so the per-step path is consistent rather than exotic');
});

test('terrain changes three things at once, in the right directions', () => {
  const veh = vehicleDefaultsFor('ev');
  for (const id of terrainIds()) {
    const t = terrainById(id);
    ok(t.crr > 0 && t.speedScale > 0 && t.speedScale <= 1, `${id}: sane coefficients`);
    ok(t.regenScale > 0 && t.regenScale <= 1, `${id}: regeneration never exceeds tarmac`);
    ok(t.name && t.what, `${id}: says what it is`);
    const on = vehicleOnTerrain(veh, id);
    ok(on.crr === t.crr, `${id}: rolling resistance applied`);
    ok(on.regenFrac <= veh.regenFrac + 1e-9, `${id}: regeneration derated, never raised`);
  }
  // Mutating the source vehicle would leak one segment's surface into the next.
  vehicleOnTerrain(veh, 'sand');
  ok(veh.crr !== TERRAINS.sand.crr, 'the source vehicle is left alone');
  ok(isOffRoad('sand') && !isOffRoad('tarmac'), 'and the tool knows which is which');
});

test('sand really is the hard case, and the penalty comes from the model', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const veh = vehicleDefaultsFor('ev');
  const base = traceForApp('ev');
  const run = (id) => {
    const t = terrainById(id);
    return driveCyclePower({
      trace: { ...base, v: base.v.map((v) => v * t.speedScale) },
      vehicle: vehicleOnTerrain(veh, id), packMassKg: d.pack.massKg,
    });
  };
  const tarmac = run('tarmac').whPerKm;
  const sand = run('sand').whPerKm;
  const gravel = run('gravel').whPerKm;
  ok(gravel > tarmac && sand > gravel, 'the ordering follows the surfaces');
  ok(sand > tarmac * 4, `sand costs ${(sand / tarmac).toFixed(1)}x tarmac`);

  // The bug: an analytical shortcut said 9.1x where the model said 6.1x,
  // because the rolling share is not a constant. The penalty now reports the
  // model rather than approximating it.
  const p = terrainPenalty({ terrainId: 'sand', baseWhPerKm: tarmac, terrainWhPerKm: sand });
  near(p.factor, sand / tarmac, 1e-9, 'the reported factor IS the measured one');
  near(p.rangeFactor, tarmac / sand, 1e-9, 'and the range factor is its reciprocal');
  ok(p.assumptions.some((a) => /run twice/.test(a)), 'and it says both figures came from the same model');
  ok(p.assumptions.some((a) => /[Tt]raction is not modelled/.test(a)),
    'while admitting it says nothing about whether you get through at all');
  // With nothing measured it refuses to invent a factor.
  ok(terrainPenalty({ terrainId: 'sand' }).factor === null, 'no measurement, no number');
});

test('it refuses routes that are not one journey', () => {
  // Two cities in one file is the commonest bad input: a dropped signal, or
  // two drives concatenated. Simulating it as one is nonsense.
  const jumped = buildRoute({ points: [{ lat: 46.5, lon: 6.6 }, { lat: 48.8, lon: 2.3 }] });
  ok(validateRoute(jumped).some((e) => /jump/.test(e)), 'a 500 km hop between fixes is caught');
  ok(buildRoute({ points: [{ lat: 1, lon: 1 }] }) === null, 'one point is not a route');
  ok(buildRoute({ points: [] }) === null && buildRoute({ points: null }) === null, 'null-safe');
  // Duplicate fixes are common and must not become zero-length segments.
  const dup = buildRoute({ points: [{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1.01, lon: 1 }] });
  ok(dup.segments.every((s) => s.lengthM > 0), 'duplicate fixes are dropped, not kept as zero-length');
});
