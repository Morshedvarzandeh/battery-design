// Load profiles — per-application defaults, profile math, pack checks and
// the CSV upload path.
import { test } from 'node:test';
import { ok, throws } from './helpers.mjs';
import { PRESETS } from '../js/presets.js';
import {
  LOAD_PROFILES, profileForApp, profilesForApp, profileStats, profileChecks, parseProfileCSV,
} from '../js/loadprofiles.js';
import { sizingOptionsFor } from '../js/knowledge.js';

test('every application preset has its own default profile', () => {
  for (const pr of PRESETS) {
    ok(profileForApp(pr.id) != null, `preset ${pr.id} maps to a load profile`);
  }
});

test('vehicle-class systems never default to the rooftop-solar cycle', () => {
  ok(profileForApp('rv')?.id === 'rv-house', `RV defaults to rv-house (got ${profileForApp('rv')?.id})`);
  ok(profileForApp('powerstation')?.id === 'powerstation-trip', 'power station defaults to its own shape');
  ok(profileForApp('solar-ess')?.id === 'grid-self-consumption', 'grid storage defaults to a stated EMS goal');
  ok(profileForApp('robot')?.id === 'robot-shift', 'AGV/lift truck keeps the shift cycle');
  ok(profileForApp('humanoid')?.id === 'humanoid-locomotion', 'humanoid has its own profile');
  ok(profileForApp('robovac')?.id === 'robovac-clean', 'robot vacuum has its own profile');
});

test('the per-application choice list is a shortlist, default first', () => {
  const rv = profilesForApp('rv');
  ok(rv[0]?.id === 'rv-house', 'rv choice list starts with its default');
  ok(rv.some((p) => p.id === 'grid-site-net-day'), 'site net-demand day offered as an RV alternate');
  ok(rv.length < LOAD_PROFILES.length, 'recommended list is a shortlist, not everything');
  const hum = profilesForApp('humanoid');
  ok(hum[0]?.id === 'humanoid-locomotion' && hum.some((p) => p.id === 'robot-shift'),
    'humanoid: own default + industrial alternate');
  ok(profilesForApp('nonexistent-app').length === 0, 'unknown app gets no fake recommendations');
});

test('marine exposes exactly the seven graph-scoped battery operating modes', () => {
  const marine = profilesForApp('marine');
  const ids = marine.map((p) => p.id);
  ok(profileForApp('marine')?.id === 'marine-full-electric', 'full electric is the marine default');
  ok(marine.length === 7, `marine has seven relevant choices (got ${marine.length})`);
  for (const id of [
    'marine-full-electric', 'marine-load-levelling', 'marine-boost',
    'marine-spinning-reserve', 'marine-peak-shaving',
    'marine-load-smoothing', 'marine-ramp-support',
  ]) ok(ids.includes(id), `${id} is available to marine`);
  ok(marine.every((p) => p.family === 'operating-policy' && p.kind === 'policy-output'),
    'all seven are generated policy outputs, not raw load profiles');
  ok(marine.every((p) => p.sourceProfileId === 'marine-vessel-duty'),
    'all seven trace back to the external vessel demand');
});

test('the knowledge graph is the only application-to-choice map', () => {
  for (const pr of PRESETS) {
    const ids = profilesForApp(pr.id).map((p) => p.id);
    const expected = sizingOptionsFor(pr.id, 'energy-policy').length
      ? sizingOptionsFor(pr.id, 'energy-policy')
      : sizingOptionsFor(pr.id, 'load-profile');
    ok(ids.join('|') === expected.join('|'), `${pr.id}: visible choices exactly match the graph`);
  }
  ok(LOAD_PROFILES.every((p) => p.appIds == null && p.suitableFor == null),
    'profile data carries no second application mapping that can drift');
});

test('the shapes behave like their machines', () => {
  const p = (id) => LOAD_PROFILES.find((x) => x.id === id);
  ok(p('robovac-clean').p.some((v) => v < 0), 'robovac has the dock-charging tail');
  ok(p('rv-house').p.some((v) => v < 0), 'rv day includes charging while driving');
  ok(p('humanoid-locomotion').p.every((v) => v > 0), 'humanoid base load never drops to zero');
  ok(Math.min(...p('humanoid-locomotion').p) >= 0.25, 'humanoid balance/compute base is substantial');
  ok(p('marine-full-electric').p.every((v) => v >= 0), 'full electric supplies the complete positive demand');
  ok(p('marine-load-levelling').p.some((v) => v > 0) && p('marine-load-levelling').p.some((v) => v < 0),
    'load levelling both discharges above and charges below the genset setpoint');
  ok(p('marine-spinning-reserve').p.some((v) => v === 0) && p('marine-spinning-reserve').p.some((v) => v > 0),
    'spinning reserve waits before taking the load');
  ok(p('marine-load-smoothing').dtS <= 0.5, 'load smoothing represents fluctuations above 1 Hz');
  ok(p('marine-ramp-support').p.some((v) => v > 0) && p('marine-ramp-support').p.some((v) => v < 0),
    'ramp support discharges on ramp-up and charges on ramp-down');
});

test('hand-checked math on a square wave', () => {
  const prof = { dtS: 10, p: [1, 0, 1, 0] }; // scale 100 W
  const st = profileStats(prof, 100);
  ok(st.peakW === 100 && st.meanW === 50, 'peak/mean on square wave');
  ok(Math.abs(st.rmsW - 100 / Math.SQRT2) < 1e-9, 'RMS = peak/sqrt(2) at 50% duty');
  ok(Math.abs(st.energyPerPassWh - (2 * 100 * 10) / 3600) < 1e-9, 'energy per pass');
  ok(Math.abs(st.crestFactor - 2) < 1e-9, 'crest factor');
});

test('the shapes are genuinely different — that is the whole point', () => {
  const crest = (id) => {
    const p = LOAD_PROFILES.find((x) => x.id === id);
    return profileStats(p, 1000).crestFactor;
  };
  ok(crest('powertool-bursts') > 3.5, `power tool crest ${crest('powertool-bursts').toFixed(1)} > 3.5`);
  ok(crest('drone-mission') < 1.5, `drone crest ${crest('drone-mission').toFixed(2)} < 1.5 (hover-heavy)`);
  ok(crest('ups-standby') > 5, `UPS crest ${crest('ups-standby').toFixed(1)} > 5 (standby)`);
  const has = (id, pred) => LOAD_PROFILES.find((x) => x.id === id).p.some(pred);
  ok(has('wltp-ev', (v) => v < 0), 'WLTP has regen');
  ok(has('ess-daily', (v) => v < 0), 'solar day has charging');
  ok(!has('ebike-assist', (v) => v < 0), 'e-bike has no regen');
  ok(!has('powertool-bursts', (v) => v < 0), 'power tool has no charging');
});

test('pack checks: an RMS-hot profile fails even when the mean looks fine', () => {
  const prof = { dtS: 5, p: [1, 1, 1, 0.9, 1, 0.95] }; // near-constant full power
  const pack = { nominalV: 36, energyWh: 500, maxContCurrentA: 20, maxPulseCurrentA: 40, maxChargeCurrentA: 10 };
  const { findings } = profileChecks(prof, 1000, pack, {}); // ~27.6 A RMS vs 20 A
  ok(findings.find((f) => f.id === 'lp-rms')?.severity === 'fail', 'RMS overload flagged as fail');
  const regenProf = { dtS: 5, p: [0.5, -0.9, 0.5, -0.9] }; // heavy regen
  const r2 = profileChecks(regenProf, 1000, pack, {});
  ok(r2.findings.find((f) => f.id === 'lp-regen')?.severity === 'warn', 'excess regen flagged');
  const light = profileChecks({ dtS: 5, p: [0.3, 0.2, 0.25, 0.1] }, 1000, pack, {});
  ok(light.findings.find((f) => f.id === 'lp-rms')?.severity === 'pass', 'light profile passes');
  ok(light.findings.find((f) => f.id === 'lp-dod'), 'DoD-per-pass reported');
});

test('CSV upload: two-column, one-column, decimation, honest failures', () => {
  const two = parseProfileCSV('0,100\n1,200\n2,-50\n3,150\n4,80\n');
  ok(two.uploadedPeakW === 200 && two.p.length === 5, 'two-column CSV parsed');
  ok(Math.abs(Math.min(...two.p) + 0.25) < 1e-9, 'regen normalized');
  const one = parseProfileCSV('10\n20\n30\n40\n');
  ok(one.p.length === 4 && one.uploadedPeakW === 40, 'one-column CSV parsed');
  const big = parseProfileCSV(Array.from({ length: 1500 }, (_, i) => `${i},${100 + (i % 7)}`).join('\n'));
  ok(big.p.length <= 500, `long upload decimated to ${big.p.length}`);
  throws(() => parseProfileCSV('1,0\n2,0\n3,0\n4,0\n'), 'all-zero profile rejected');
});
