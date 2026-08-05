// Sim (level 1) — the mission simulation: equivalent-circuit electrical
// model + lumped thermal, hand-checked against closed-form physics, and the
// violation findings that make it useful (empty pack, voltage cutoff,
// over-temperature, winter charge inhibit, lost regen).
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { simulateMission, ocvCell, OCV_SHAPES, SHAPE_OF_CHEMISTRY } from '../js/sim1d.js';

// A synthetic cell with round numbers so the physics is checkable by hand.
const CELL = {
  name: 'test-cell', chemistry: 'NMC', vMin: 3.0, vMax: 4.2, capacityAh: 30,
  dcirMOhm: 10, massG: 200, tempChargeC: [0, 45], tempDischargeC: [-20, 60],
};
const flat = (n, v = 1) => Array.from({ length: n }, () => v);

test('OCV: anchored to the window, monotonic, LFP flatter than NMC', () => {
  ok(Math.abs(ocvCell(CELL, 0) - CELL.vMin) < 1e-9, 'OCV(0) = vMin');
  ok(Math.abs(ocvCell(CELL, 1) - CELL.vMax) < 1e-9, 'OCV(1) = vMax');
  for (let x = 0.05; x <= 1; x += 0.05) {
    ok(ocvCell(CELL, x) >= ocvCell(CELL, x - 0.05) - 1e-12, `OCV monotonic at ${x.toFixed(2)}`);
  }
  const lfp = cellById('eve-lf280k');
  const nmcSpread = (ocvCell(CELL, 0.85) - ocvCell(CELL, 0.25)) / (CELL.vMax - CELL.vMin);
  const lfpSpread = (ocvCell(lfp, 0.85) - ocvCell(lfp, 0.25)) / (lfp.vMax - lfp.vMin);
  ok(lfpSpread < nmcSpread / 2, `LFP plateau is FLAT (spread ${lfpSpread.toFixed(3)} vs NMC ${nmcSpread.toFixed(3)})`);
  ok(Object.keys(SHAPE_OF_CHEMISTRY).every((c) => OCV_SHAPES[SHAPE_OF_CHEMISTRY[c]]),
    'every chemistry maps to a real shape');
});

test('energy books: constant power with R=0 integrates exactly', () => {
  // 100 W for 1 h through a lossless pack: exactly 100 Wh out, SoC drop = E/E_pack.
  const c = { ...CELL, dcirMOhm: 0 };
  const r = simulateMission({
    cell: c, s: 10, p: 1, profile: { dtS: 60, p: flat(60) }, scaleW: 100,
    ambientC: 25, resistanceMOhm: 0,
  });
  ok(!r.unavailable, 'runs');
  near(r.summary.energyOutWh, 100, 1e-6, 'energy out = P × t');
  near(r.summary.lossWh, 0, 1e-9, 'no loss at R = 0');
  ok(r.summary.endSoC < 1 && r.summary.endSoC > 0.85, `SoC drop plausible (${(r.summary.endSoC * 100).toFixed(1)}%)`);
  ok(r.findings.some((f) => f.severity === 'pass' && /Mission completes/.test(f.title)), 'clean mission passes');
});

test('sag: terminal voltage = OCV − I·R and the demand is met exactly', () => {
  const r = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 1, p: [1] }, scaleW: 500,
    ambientC: 25, resistanceMOhm: 100,
  });
  const v0 = r.trace.vPack[0], i0 = r.trace.iA[0];
  const ocv0 = 10 * ocvCell(CELL, 1);
  near(v0, ocv0 - i0 * 0.1, 1e-9, 'V = OCV − I·R');
  near(v0 * i0, 500, 1e-6, 'delivered power equals the demand');
  ok(v0 < ocv0, 'sag is real');
});

test('the pack runs empty mid-mission: FAIL with the unmet energy', () => {
  // 3.6 kW from a ~1.1 kWh pack for 2 h — exhausts partway.
  const r = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 60, p: flat(120) }, scaleW: 3600,
    ambientC: 25, resistanceMOhm: 10,
  });
  ok(r.findings.some((f) => f.severity === 'fail' && /runs EMPTY/.test(f.title)), 'empty-pack FAIL raised');
  ok(r.summary.unmetWh > 100, `unmet demand booked (${r.summary.unmetWh.toFixed(0)} Wh)`);
  ok(r.summary.endSoC === 0, 'ends at 0% SoC');
});

test('power-limited pack: voltage cutoff FAIL, not an energy problem', () => {
  // High resistance: the sag hits the 30 V cutoff under peak while charge remains.
  const r = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 10, p: flat(30) }, scaleW: 4000,
    ambientC: 25, resistanceMOhm: 800,
  });
  ok(r.findings.some((f) => f.severity === 'fail' && /Voltage cutoff/.test(f.title)), 'cutoff FAIL raised');
  ok(r.summary.minV >= r.summary.vMinPack - 1e-9, 'the boundary is held, not crossed');
  ok(r.summary.endSoC > 0.5, 'plenty of charge remains — power-limited, not energy-limited');
});

test('lumped thermal: steady state lands at ambient + Q/UA', () => {
  // ~10 A through 100 mΩ ≈ 10 W; UA 2 W/K → ΔT_ss ≈ 5 K, τ = C/UA = 1000 s.
  const r = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 50, p: flat(100) }, scaleW: 370,
    ambientC: 25, resistanceMOhm: 100, uaWK: 2, thermalMassJK: 2000,
  });
  const dtSS = r.summary.avgHeatW / 2;
  ok(Math.abs(r.summary.maxT - (25 + dtSS)) < 0.15 * dtSS + 0.3,
    `T settles near ambient + Q/UA (${r.summary.maxT.toFixed(1)} vs ${(25 + dtSS).toFixed(1)} °C)`);
  ok(r.summary.maxT < 25 + dtSS * 1.1, 'sub-stepped Euler does not overshoot');
});

test('over-temperature: FAIL when the cooling cannot hold the mission', () => {
  const r = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 50, p: flat(100) }, scaleW: 2000,
    ambientC: 40, resistanceMOhm: 400, uaWK: 0.5, thermalMassJK: 2000,
  });
  ok(r.findings.some((f) => f.severity === 'fail' && /Temperature exceeds/.test(f.title)),
    'over-temp FAIL raised');
  ok(r.summary.maxT > r.summary.tempMaxC, 'T really crossed the rating');
});

test('winter: charging inhibited below the floor — unless the heater exists', () => {
  const mission = { dtS: 60, p: [0.5, -0.6, 0.5, -0.6, 0.5, -0.6] };
  const cold = simulateMission({
    cell: CELL, s: 10, p: 1, profile: mission, scaleW: 500,
    ambientC: -10, resistanceMOhm: 100, uaWK: 5, thermalMassJK: 50000, startSoC: 0.7,
  });
  ok(cold.summary.chargeInhibitS > 0, 'sub-zero pack refuses charge');
  ok(cold.findings.some((f) => /Charging inhibited/.test(f.title)), 'inhibit warned with the reason');
  const heated = simulateMission({
    cell: CELL, s: 10, p: 1, profile: mission, scaleW: 500,
    ambientC: -10, resistanceMOhm: 100, uaWK: 5, thermalMassJK: 50000, startSoC: 0.7, hasHeater: true,
  });
  ok(heated.summary.chargeInhibitS === 0 && heated.summary.energyInWh > 0,
    'the heater branch keeps the charge window open');
});

test('regen against a full battery is lost, and says so', () => {
  const r = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 60, p: [-0.8, -0.8, 0.3, 0.3] }, scaleW: 500,
    ambientC: 25, resistanceMOhm: 100, startSoC: 1,
  });
  ok(r.summary.regenLostWh > 0, 'regen at 100% SoC has nowhere to go');
  ok(r.findings.some((f) => /regen lost/.test(f.title)), 'lost regen warned');
  const half = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 60, p: [-0.8, -0.8, 0.3, 0.3] }, scaleW: 500,
    ambientC: 25, resistanceMOhm: 100, startSoC: 0.5,
  });
  ok(half.summary.energyInWh > 0 && half.summary.regenLostWh < r.summary.regenLostWh,
    'starting below full recovers the energy instead');
});

test('honest unavailability: no profile, or no resistance to model with', () => {
  const none = simulateMission({ cell: CELL, s: 10, p: 1, profile: null, scaleW: 100 });
  ok(none.unavailable && /sizing duty/.test(none.why), 'no profile → unavailable with the reason');
  const noR = simulateMission({
    cell: { ...CELL, dcirMOhm: null }, s: 10, p: 1,
    profile: { dtS: 60, p: flat(10) }, scaleW: 100,
  });
  ok(noR.unavailable && noR.why.includes('test-cell'), 'no DCIR → unavailable, names the cell');
});

test('traces decimate to a chartable size and stay finite', () => {
  const r = simulateMission({
    cell: CELL, s: 10, p: 1, profile: { dtS: 1, p: flat(500, 0.4) }, scaleW: 300,
    passes: 10, ambientC: 25, resistanceMOhm: 100, uaWK: 2,
  });
  ok(r.trace.tS.length <= 600, `decimated (${r.trace.tS.length} points)`);
  for (const k of ['soc', 'vPack', 'pW', 'tC']) {
    ok(r.trace[k].every((v) => v === null || isFinite(v)), `${k} trace finite`);
  }
  ok(r.assumptions.length >= 4, 'the model states its assumptions');
});

test('a real pack end to end: e-bike day on the 50E', () => {
  const c = cellById('samsung-inr21700-50e');
  const profile = { dtS: 30, p: [0.2, 0.6, 1, 0.4, 0.1, 0.7, 0.3, 0.05] };
  const r = simulateMission({
    cell: c, s: 13, p: 4, profile, scaleW: 1200, passes: 3,
    ambientC: 25, uaWK: 3,
  });
  ok(!r.unavailable, 'library cell simulates with its own DCIR fallback');
  near(r.summary.resistanceMOhm, (13 * c.dcirMOhm) / 4, 1e-9, 'fallback R = S·R/P');
  ok(r.summary.efficiencyPct > 90 && r.summary.efficiencyPct < 100,
    `round-trip efficiency plausible (${r.summary.efficiencyPct?.toFixed(1)}%)`);
  ok(r.summary.endSoC < r.summary.startSoC, 'the day costs charge');
});

test('compareCells: equivalent packs for the same job, same mission', async () => {
  const { compareCells } = await import('../js/sim1d.js');
  const { cellById: byId } = await import('../js/cells.js');
  const nmc = byId('samsung-inr21700-50e'); // 3.6 V, 4.9 Ah
  const lfp = byId('eve-lf280k');           // 3.2 V, 280 Ah prismatic
  const profile = { dtS: 30, p: [0.3, 0.8, 1, 0.4, 0.1, 0.6] };
  const cmp = compareCells({
    cells: [nmc, lfp], targetVNom: 46.8, targetEnergyWh: 917,
    profile, scaleW: 1200, ambientC: 25, uaWK: 3, currentId: nmc.id,
  });
  ok(cmp.rows.length === 2, 'one row per compared cell');
  const [rN, rL] = cmp.rows;
  // S from the voltage window: 46.8/3.6 = 13; 46.8/3.2 ≈ 15.
  ok(rN.s === 13, `NMC pack lands at 13S (got ${rN.s}S)`);
  ok(rL.s === Math.round(46.8 / lfp.nominalV), `LFP pack S from its own voltage (got ${rL.s}S)`);
  // P from the energy target — and the honest oversize note for the 280 Ah cell.
  ok(rN.p >= 1 && Math.abs(rN.energyWh - 917) / 917 < 0.35, 'NMC pack lands near the energy target');
  ok(rL.p === 1 && rL.notes.some((n) => /oversized/.test(n)),
    'a 280 Ah cell cannot scale down to 917 Wh — 1P with the oversize note');
  ok(rN.current === true && rL.current === false, 'current design flagged');
  // Same mission ran for both: traces exist, verdicts assigned.
  for (const r of cmp.rows) {
    ok(!r.sim.unavailable && r.sim.trace.tS.length > 0, `${r.cell.id} simulated`);
    ok(['pass', 'warn', 'fail'].includes(r.verdict), `${r.cell.id} verdict assigned (${r.verdict})`);
  }
  ok(/same job|equivalent pack/i.test(cmp.basis), 'the comparison states its basis');
});

test('compareCells: a cell without DCIR gets an honest unavailable row', async () => {
  const { compareCells } = await import('../js/sim1d.js');
  const noR = { name: 'mystery-cell', chemistry: 'NMC', vMin: 3.0, vMax: 4.2, nominalV: 3.6, capacityAh: 5, dcirMOhm: null, massG: 70, tempChargeC: [0, 45], tempDischargeC: [-20, 60] };
  const cmp = compareCells({
    cells: [noR], targetVNom: 36, targetEnergyWh: 500,
    profile: { dtS: 30, p: [0.5, 0.5] }, scaleW: 500, ambientC: 25,
  });
  ok(cmp.rows[0].verdict === 'unavailable' && cmp.rows[0].sim.unavailable,
    'no-DCIR cell: unavailable verdict, not a fake number');
});
