// Charging — the AC side, round one: the per-application charging
// architecture (an OBC is not bolted onto everything), hand-checked
// charge-time math with the CC-CV taper and the named bottleneck, the AC
// interface per market, strategies, mission charge segments in the
// simulation, and the knowledge-graph gating that keeps gadgets away from
// charger classes.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import {
  OBC_CLASSES, OBC_EFFICIENCY, obcById, acInterfaceFor, chargingArchitectureFor,
  CHARGE_STRATEGIES, strategiesFor, chargeTime, buildChargingPlan,
  CV_KNEE_SOC, CV_TAPER,
} from '../js/charging.js';
import { simulateMission } from '../js/sim1d.js';
import { needed } from '../js/knowledge.js';
import { PRESETS } from '../js/presets.js';

test('the charging architecture follows the application — no OBC bolted onto everything', () => {
  ok(chargingArchitectureFor('ev').kind === 'obc', 'EV carries a real on-board charger');
  ok(chargingArchitectureFor('rv').kind === 'obc', 'RV: shore-power inverter/charger');
  ok(chargingArchitectureFor('ebike').kind === 'external', 'e-bike: the charger is an external brick');
  ok(chargingArchitectureFor('wearable').kind === 'host', 'wearable: the host device owns charging');
  ok(chargingArchitectureFor('solar-ess').kind === 'pcs', 'storage: the PCS IS the AC side, no "OBC"');
  ok(chargingArchitectureFor('robovac').kind === 'dock', 'robot vacuum: the dock converts AC to DC');
  ok(/pantograph|depot/i.test(chargingArchitectureFor('ebus').note), 'e-bus honesty: DC depot/pantograph, OBC optional');
  // Every preset resolves to SOME architecture with a real note.
  for (const pr of PRESETS) {
    const a = chargingArchitectureFor(pr.id);
    ok(['obc', 'external', 'pcs', 'dock', 'host'].includes(a.kind) && a.note.length > 20,
      `${pr.id}: charging architecture stated (${a.kind})`);
  }
});

test('charge-time math, hand-checked: CC phase, CV tail, and the named bottleneck', () => {
  // 60 kWh pack on an 11 kW OBC at 93%: 20→80% is pure CC.
  // t = 36 kWh / 10.23 kW = 3.519 h.
  const t = chargeTime({ energyWh: 60000, socFrom: 0.2, socTo: 0.8, sourceKW: 11, efficiency: OBC_EFFICIENCY });
  near(t.hours, 36 / (11 * OBC_EFFICIENCY), 1e-9, '20→80% = E / (P·η), no CV inside the knee');
  ok(t.cvHours === 0, 'no CV below the knee');
  // 10→100%: CC covers 10→80 (42 kWh), CV covers 80→100 (12 kWh at taper).
  const tf = chargeTime({ energyWh: 60000, socFrom: 0.1, socTo: 1.0, sourceKW: 11, efficiency: OBC_EFFICIENCY });
  near(tf.ccHours, 42 / (11 * OBC_EFFICIENCY), 1e-9, 'CC portion');
  near(tf.cvHours, 12 / (11 * OBC_EFFICIENCY * CV_TAPER), 1e-9, 'CV tail at the taper factor');
  ok(tf.hours > tf.ccHours, 'the last 20% costs disproportionate time — the CV story');
  // The bottleneck is NAMED: a pack that only accepts 5 kW beats a 22 kW OBC.
  const lim = chargeTime({ energyWh: 60000, socFrom: 0.2, socTo: 0.8, sourceKW: 22, efficiency: OBC_EFFICIENCY, packChargeKW: 5 });
  ok(lim.limitedBy === 'pack' && /bottleneck/.test(lim.note), 'pack-limited case named');
  near(lim.hours, 36 / 5, 1e-9, 'time follows the pack limit, not the charger');
  const lim2 = chargeTime({ energyWh: 60000, socFrom: 0.2, socTo: 0.8, sourceKW: 3.6, efficiency: OBC_EFFICIENCY, packChargeKW: 30 });
  ok(lim2.limitedBy === 'source', 'charger-limited case named');
  ok(chargeTime({ energyWh: 0, sourceKW: 11 }) === null, 'null-safe');
  ok(CV_KNEE_SOC === 0.8, 'knee documented at 80%');
});

test('AC interface follows the target market', () => {
  ok(/Type 2/.test(acInterfaceFor('eu').connector) && /62196/.test(acInterfaceFor('eu').connector), 'EU: Type 2 / IEC 62196');
  ok(/J1772|NACS/.test(acInterfaceFor('us').connector), 'US: J1772 / NACS');
  ok(/GB\/T 20234/.test(acInterfaceFor('cn').connector), 'China: GB/T 20234');
  ok(/27930/.test(acInterfaceFor('cn').comms), 'China: GB/T 27930 comms');
  ok(acInterfaceFor('nowhere').connector.length > 0, 'unknown market falls back honestly');
});

test('strategies belong to the applications that really use them', () => {
  for (const st of CHARGE_STRATEGIES) {
    ok(st.pros?.length >= 2 && st.cons?.length >= 1 && st.appIds.length >= 1, `${st.id}: complete entry`);
  }
  const ebus = strategiesFor('ebus');
  ok(ebus.some((x) => x.id === 'depot-overnight') && ebus.some((x) => x.id === 'opportunity'),
    'e-bus gets the depot-vs-opportunity decision');
  ok(ebus.find((x) => x.id === 'opportunity').cons.some((c) => /C-rate|cycle/i.test(c)),
    'opportunity charging carries its cycle/thermal cost');
  ok(strategiesFor('ev').some((x) => x.id === 'public-dc'), 'EV gets DC fast charging');
  ok(strategiesFor('solar-ess').some((x) => x.id === 'tariff-window'), 'storage charges by dispatch');
  ok(!strategiesFor('wearable').some((x) => x.id === 'opportunity'), 'no pantographs on a wristwatch');
});

test('the orchestrated plan: OBC auto-choice and honest per-class output', () => {
  const c = cellById('samsung-inr21700-50e'); // rated charge 2.45 A on 4.9 Ah = 0.5C
  const ev = buildChargingPlan({ appId: 'ev', marketId: 'eu', energyWh: 60000, vNomV: 350, cell: c });
  ok(ev.obc != null, 'EV auto-selects an OBC');
  near(ev.chargeC, 0.5, 1e-9, 'charge C-rate derived from the datasheet current');
  near(ev.packChargeKW, 30, 1e-6, 'pack acceptance = C × energy');
  // 30 kW acceptance: even 22 kW AC is below it → auto lands on the largest class.
  ok(ev.obc.id === 'obc-22k', `auto lands on the largest class for a 60 kWh/0.5C pack (got ${ev.obc.id})`);
  ok(ev.t2080 && ev.t2080.limitedBy === 'source', 'and says the charger is the bottleneck');
  const small = buildChargingPlan({ appId: 'ev', marketId: 'eu', energyWh: 8000, vNomV: 350, cell: { ...c, maxContChargeA: 0.98 } });
  ok(small.obc.acKW * OBC_EFFICIENCY >= small.packChargeKW, 'auto: smallest non-bottleneck class');
  const forced = buildChargingPlan({ appId: 'ev', marketId: 'eu', energyWh: 60000, vNomV: 350, cell: c, obcOverride: 'obc-3k6' });
  ok(forced.obc.id === 'obc-3k6' && forced.t2080.hours > ev.t2080.hours, 'override honored, time follows');
  const ess = buildChargingPlan({ appId: 'solar-ess', marketId: 'eu', energyWh: 30000, vNomV: 48, cell: c });
  ok(ess.obc === null && ess.arch.kind === 'pcs', 'storage never gets an OBC — the PCS framing instead');
  const brick = buildChargingPlan({ appId: 'ebike', marketId: 'eu', energyWh: 500, vNomV: 36, cell: c });
  ok(brick.obc === null && brick.arch.kind === 'external', 'e-bike: external brick, nothing to select');
});

test('mission charge segments: top-ups and base charging change the outcome', () => {
  const CELL = {
    name: 't', chemistry: 'NMC', vMin: 3.0, vMax: 4.2, capacityAh: 30,
    dcirMOhm: 10, massG: 200, tempChargeC: [0, 45], tempDischargeC: [-20, 60],
  };
  const drain = { dtS: 60, p: Array.from({ length: 30 }, () => 0.8) }; // heavy half-hour
  const base = { cell: CELL, s: 10, p: 1, profile: drain, scaleW: 2000, passes: 2, ambientC: 25, resistanceMOhm: 100 };
  const none = simulateMission({ ...base });
  const topup = simulateMission({ ...base, charge: { mode: 'topup', powerW: 15000, minutes: 20 } });
  const atBase = simulateMission({ ...base, charge: { mode: 'base', powerW: 15000, minutes: 120 } });
  ok(topup.summary.minSoC > none.summary.minSoC, 'top-ups keep the minimum SoC higher');
  ok(atBase.summary.endSoC > none.summary.endSoC, 'base charge refills at the end');
  ok(topup.summary.chargedWh > 0 && atBase.summary.chargedWh > 0, 'commanded charge is booked separately');
  ok(atBase.summary.chargeMode === 'base', 'mode recorded');
  // A commanded charge that fills the pack is completion, not "regen lost".
  const overfill = simulateMission({ ...base, passes: 1, startSoC: 0.9, scaleW: 100, charge: { mode: 'base', powerW: 20000, minutes: 240 } });
  ok(overfill.summary.endSoC >= 0.999, 'charges to full');
  ok(!overfill.findings.some((f) => /regen lost/.test(f.title)), 'no lost-regen warning for a finished charge');
  // Winter depot charge without a heater is refused — the physics carries over.
  const cold = simulateMission({ ...base, passes: 1, ambientC: -10, uaWK: 50, thermalMassJK: 5000, startSoC: 0.5, charge: { mode: 'base', powerW: 15000, minutes: 60 } });
  ok(cold.summary.chargeRefusedWh > 0 && cold.findings.some((f) => /Charging inhibited/.test(f.title)),
    'sub-zero base charge inhibited without the heater branch');
});

test('the knowledge graph keeps charger classes away from gadgets', () => {
  ok(needed('ev', 'ac-side') && needed('rv', 'ac-side') && needed('solar-ess', 'ac-side'),
    'vehicles, RVs and storage get the AC-side concept');
  ok(needed('powerstation', 'ac-side'), 'power stations too — they truly carry a charger');
  ok(!needed('wearable', 'ac-side') && !needed('powertool', 'ac-side') && !needed('robovac', 'ac-side'),
    'gadgets and docked robots never meet OBC classes in training');
  ok(needed('ebus', 'charging-strategy') && needed('robot', 'charging-strategy'),
    'fleets get the strategy decision');
  ok(!needed('wearable', 'charging-strategy'), 'a watch has no charging strategy to choose');
});

test('OBC table sanity', () => {
  ok(OBC_CLASSES.length === 4 && OBC_CLASSES.every((o) => o.acKW > 0 && o.phases >= 1 && o.when),
    'OBC classes complete');
  ok(obcById('obc-11k').phases === 3 && obcById('nope') === null, 'lookup');
  ok(OBC_EFFICIENCY > 0.85 && OBC_EFFICIENCY < 1, 'efficiency is a stated class estimate');
});
