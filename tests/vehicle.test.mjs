// Vehicle — road load, driving modes and range. The demand is DERIVED from
// the machine instead of typed, so these tests check the physics itself: the
// force terms against hand calculations, the energy ledger against the total
// it claims to explain, the synthesized WLTP trace against the published
// phase aggregates, and the mass spiral (a heavier pack costs range).
import { test } from 'node:test';
import { readFileSync } from 'fs';
import { ok, near } from './helpers.mjs';
import {
  G, AIR_DENSITY_KGM3, VEHICLE_DEFAULTS, vehicleDefaultsFor, DRIVING_MODES,
  drivingModeById, WLTP3_PHASES, SPEED_TRACES, traceForApp, roadLoadN,
  driveCyclePower, rangeKm, totalMassKg, massShare, modeComparison,
} from '../js/vehicle.js';
import { needed } from '../js/knowledge.js';
import { buildReportHTML } from '../js/report.js';
import { cellById } from '../js/cells.js';
import { costModel } from '../js/optimizer.js';
import { co2Model } from '../js/report.js';

const EV = () => vehicleDefaultsFor('ev');

test('road load, hand-checked term by term', () => {
  // 1500 kg, Crr 0.01, level ground, standing still except for the terms asked.
  const v = { crr: 0.01, cd: 0.30, frontalAreaM2: 2.0, rotatingMass: 0.05 };
  const at20 = roadLoadN({ vMs: 20, aMs2: 0, massKg: 1500, vehicle: v, gradePct: 0 });
  near(at20.roll, 0.01 * 1500 * G, 1e-9, 'rolling = Crr·m·g on the flat');
  near(at20.aero, 0.5 * AIR_DENSITY_KGM3 * 0.30 * 2.0 * 400, 1e-9, 'aero = ½ρCdAv²');
  near(at20.grade, 0, 1e-9, 'no grade term on level ground');
  near(at20.inertia, 0, 1e-9, 'no inertia at constant speed');
  // Aerodynamic drag is quadratic — double the speed, quadruple the force.
  const at40 = roadLoadN({ vMs: 40, massKg: 1500, vehicle: v });
  near(at40.aero / at20.aero, 4, 1e-9, 'drag quadruples with doubled speed');
  // Acceleration carries the rotating-mass penalty.
  const acc = roadLoadN({ vMs: 20, aMs2: 2, massKg: 1500, vehicle: v });
  near(acc.inertia, 1500 * 1.05 * 2, 1e-9, 'inertia = m·(1+ε)·a');
  // A 10% climb is m·g·sin(atan(0.1)).
  const climb = roadLoadN({ vMs: 20, massKg: 1500, vehicle: v, gradePct: 10 });
  near(climb.grade, 1500 * G * Math.sin(Math.atan(0.1)), 1e-9, 'grade = m·g·sin θ');
  ok(climb.grade > 1400, 'a 10% climb costs well over a kilonewton on this car');
  // Rolling resistance switches off when the vehicle is stopped.
  ok(roadLoadN({ vMs: 0, massKg: 1500, vehicle: v }).roll === 0, 'no rolling drag at rest');
});

test('the energy ledger explains the whole number, not part of it', () => {
  const r = driveCyclePower({ trace: traceForApp('ev'), vehicle: EV(), packMassKg: 400 });
  const b = r.breakdown;
  const sum = b.rolling + b.aero + b.grade + b.accel + b.aux + b.recovered;
  near(sum, r.energyWh, 1e-6, 'the buckets sum exactly to the energy drawn');
  ok(b.recovered < 0, 'regen is booked as a credit, not a cost');
  ok(b.rolling > 0 && b.aero > 0 && b.aux > 0, 'the real costs are all present');
  ok(b.grade === 0, 'no gradient claimed on a level route');
  ok(r.whPerKm > 100 && r.whPerKm < 200, `a C-segment EV lands in class (${r.whPerKm.toFixed(0)} Wh/km)`);
  ok(r.profile.p.length === r.w.length && Math.max(...r.profile.p) <= 1.0000001,
    'the normalized profile is the same length and peaks at 1');
  near(Math.max(...r.w), r.scaleW, 1e-9, 'the scale IS the peak watt figure');
});

test('the synthesized WLTP Class 3 trace matches the published phase aggregates', () => {
  const dt = 5;
  for (const ph of WLTP3_PHASES) {
    const durationS = ph.v.length * dt;
    const distanceKm = ph.v.reduce((s, v) => s + (v / 3.6) * dt, 0) / 1000;
    ok(Math.abs(durationS - ph.durationS) <= 3, `${ph.id}: duration ${durationS} s vs published ${ph.durationS} s`);
    ok(Math.abs(distanceKm / ph.distanceKm - 1) < 0.06,
      `${ph.id}: distance ${distanceKm.toFixed(2)} km within 6% of the published ${ph.distanceKm} km`);
    ok(Math.abs(Math.max(...ph.v) - ph.peakKmh) < 2, `${ph.id}: peak speed matches`);
  }
  const tr = traceForApp('ev');
  const total = tr.v.reduce((s, v) => s + (v / 3.6) * dt, 0) / 1000;
  ok(Math.abs(total - 23.27) < 1.0, `whole cycle ${total.toFixed(2)} km vs the published 23.27 km`);
  ok(Math.abs(tr.v.length * dt - 1800) < 15, 'and 1800 s long');
  ok(/not the homologation/i.test(tr.note), 'the trace says plainly what it is not');
});

test('driving mode changes the answer in the direction a driver would expect', () => {
  const base = { trace: traceForApp('ev'), vehicle: EV(), packMassKg: 400 };
  const eco = driveCyclePower({ ...base, mode: 'eco' });
  const normal = driveCyclePower({ ...base, mode: 'normal' });
  const sport = driveCyclePower({ ...base, mode: 'sport' });
  ok(eco.whPerKm < normal.whPerKm && normal.whPerKm < sport.whPerKm,
    `Eco ${eco.whPerKm.toFixed(0)} < Normal ${normal.whPerKm.toFixed(0)} < Sport ${sport.whPerKm.toFixed(0)} Wh/km`);
  ok(sport.peakW > normal.peakW * 1.15, 'Sport demands a materially higher peak — the pack has to deliver it');
  ok(eco.auxW < normal.auxW, 'Eco restrains the climate load too');
  ok(drivingModeById('nonsense').id === 'normal', 'an unknown mode falls back to Normal, never crashes');
  ok(DRIVING_MODES.every((m) => m.what.length > 20), 'every mode explains itself');
});

test('the pack carries its own weight — the mass spiral is visible', () => {
  const light = driveCyclePower({ trace: traceForApp('ev'), vehicle: EV(), packMassKg: 200 });
  const heavy = driveCyclePower({ trace: traceForApp('ev'), vehicle: EV(), packMassKg: 800 });
  ok(heavy.whPerKm > light.whPerKm, 'a heavier pack costs more per km');
  near(heavy.massKg - light.massKg, 600, 1e-9, 'the extra pack mass is really carried');
  // Doubling the pack's energy does NOT double the range, because the pack
  // must carry itself — that is the whole point of modelling mass.
  const r1 = rangeKm({ energyWh: 30000, dod: 0.9, whPerKm: light.whPerKm });
  const r2 = rangeKm({ energyWh: 60000, dod: 0.9, whPerKm: heavy.whPerKm });
  ok(r2 < 2 * r1, `double the kWh buys less than double the range (${r1.toFixed(0)} → ${r2.toFixed(0)} km)`);
  const share = massShare({ vehicle: EV(), packMassKg: 500 });
  ok(share.share > 0.2 && /carrying itself/.test(share.note), 'a fifth of the mass earns the warning');
  ok(massShare({ vehicle: EV(), packMassKg: 50 }).note === null, 'a small pack gets no lecture');
  near(totalMassKg({ vehicle: EV(), packMassKg: 400 }), EV().curbKg + EV().payloadKg + 400, 1e-9, 'mass adds up');
});

test('payload, gradient and regen do what physics says', () => {
  const base = { trace: traceForApp('ev'), packMassKg: 400 };
  const empty = driveCyclePower({ ...base, vehicle: { ...EV(), payloadKg: 0 } });
  const loaded = driveCyclePower({ ...base, vehicle: { ...EV(), payloadKg: 500 } });
  ok(loaded.whPerKm > empty.whPerKm, 'payload costs energy');
  const flat = driveCyclePower({ ...base, vehicle: EV(), gradePct: 0 });
  const uphill = driveCyclePower({ ...base, vehicle: EV(), gradePct: 5 });
  ok(uphill.whPerKm > flat.whPerKm * 1.3 && uphill.breakdown.grade > 0,
    'a sustained 5% climb dominates the ledger');
  const noRegen = driveCyclePower({ ...base, vehicle: { ...EV(), regenFrac: 0 } });
  ok(noRegen.whPerKm > flat.whPerKm && noRegen.breakdown.recovered === 0,
    'switch regen off and consumption rises with nothing recovered');
  // The pack's charge acceptance caps recovery: the same brake, a smaller pack.
  const capped = driveCyclePower({ ...base, vehicle: EV(), regenCapW: 5000 });
  ok(Math.abs(capped.breakdown.recovered) < Math.abs(flat.breakdown.recovered),
    'a pack that will not accept the current cannot recover the energy');
  ok(Math.min(...capped.w) >= -5001, 'and the trace respects the cap');
});

test('every road machine has credible defaults, and the others have none', () => {
  const expect = {
    ev: [100, 200], ebus: [600, 1600], ebike: [3, 20], escooter: [4, 25], robot: [80, 500],
  };
  for (const [app, [lo, hi]] of Object.entries(expect)) {
    const r = driveCyclePower({ trace: traceForApp(app), vehicle: vehicleDefaultsFor(app), packMassKg: 10 });
    ok(r.whPerKm >= lo && r.whPerKm <= hi, `${app}: ${r.whPerKm.toFixed(1)} Wh/km is in the real-world band`);
    ok(needed(app, 'vehicle-dynamics'), `${app} gets the concept`);
  }
  for (const app of ['wearable', 'solar-ess', 'drone', 'humanoid', 'powerstation', 'ups']) {
    ok(vehicleDefaultsFor(app) === null, `${app}: no vehicle model invented`);
    ok(!needed(app, 'vehicle-dynamics'), `${app}: never meets road load`);
  }
  ok(VEHICLE_DEFAULTS.ebike.regenFrac === 0, 'e-bikes get no imaginary regen');
  ok(/hydraulic/i.test(VEHICLE_DEFAULTS.robot.note), 'the lift truck names the work it does NOT model');
  ok(SPEED_TRACES.every((t) => t.note.length > 30 && t.v.length > 20), 'every trace explains itself');
  ok(driveCyclePower({ trace: null, vehicle: EV() }) === null, 'null-safe without a trace');
  ok(rangeKm({ energyWh: 0, whPerKm: 150 }) === null, 'no pack, no range claim');
});

test('the mode comparison and the report carry the vehicle honestly', () => {
  const cmp = modeComparison({
    trace: traceForApp('ev'), vehicle: EV(), packMassKg: 400, gradePct: 0,
    energyWh: 60000, dod: 0.8,
  });
  ok(cmp.length === 3 && cmp.every((r) => r.rangeKm > 0), 'all three modes priced in range');
  ok(cmp[0].rangeKm > cmp[2].rangeKm, 'Eco goes furthest, Sport least');
  const c = cellById('samsung-inr21700-50e');
  const drive = driveCyclePower({ trace: traceForApp('ev'), vehicle: EV(), packMassKg: 400 });
  const html = buildReportHTML({
    date: '2026-08-03', application: 'ev', cell: c, bayLabel: 'box',
    summary: {
      s: 96, p: 4, cellCount: 384, nominalV: 345.6, vMin: 240, vMax: 403.2,
      capacityAh: 19.6, energyWh: 60000, maxContCurrentA: 39, maxContPowerW: 13478,
      dims: { x: 500, y: 400, z: 100 }, massKg: 400, whPerKg: 205, whPerL: 339,
    },
    cost: costModel(c, 384, 60000, { cyclesPerYear: 250, targetYears: 8 }),
    co2: co2Model({ cell: c, energyWh: 60000, cyclesPerYear: 250, targetYears: 8, gridGPerKWh: 440 }),
    gridLabel: 'World grid average', usage: { cyclesPerYear: 250, targetYears: 8 },
    selection: {}, findings: [], disclaimer: 'test',
    vehicle: {
      vehicle: EV(), trace: traceForApp('ev'), drive, packMassKg: 400, gradePct: 0, dod: 0.8,
      range: rangeKm({ energyWh: 60000, dod: 0.8, whPerKm: drive.whPerKm }),
      share: massShare({ vehicle: EV(), packMassKg: 400 }), modes: cmp,
    },
  });
  ok(/Wh\/km/.test(html) && /range/i.test(html), 'consumption and range reach the customer document');
  ok(/Where the energy goes/.test(html) && /Rolling/.test(html), 'the energy split is shown, not just a total');
  ok(/Driving mode sensitivity/.test(html), 'all three modes are compared in the report');
  ok(!/undefined|NaN/.test(html), 'no leaks');
});

test('the road-load sources are cited', () => {
  const refs = readFileSync(new URL('../REFERENCES.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok(/Gillespie/.test(refs) && /Fundamentals of Vehicle Dynamics/.test(refs), 'the road-load reference is cited');
  ok(/Ehsani/.test(refs), 'the EV drivetrain reference is cited');
  ok(/Global Technical Regulation No\. 15|GTR 15/.test(refs), 'the WLTP structure is sourced');
  ok(/Driving-mode factors/.test(refs) && /rotating-mass|Rotating-mass/.test(refs),
    '§8 owns the class estimates the model cannot source');
});
