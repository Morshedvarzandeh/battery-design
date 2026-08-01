// Regressions for load profiles: per-application defaults, profile math,
// pack checks and the CSV upload path.
import { PRESETS } from '../js/presets.js';
import {
  LOAD_PROFILES, profileForApp, profileStats, profileChecks, parseProfileCSV,
} from '../js/loadprofiles.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } };

// Every application preset has its own default profile.
for (const pr of PRESETS) {
  ok(profileForApp(pr.id) != null, `preset ${pr.id} maps to a load profile`);
}

// Hand-checked math on a square wave: 1,0,1,0 at dt=10s, scale 100 W.
{
  const prof = { dtS: 10, p: [1, 0, 1, 0] };
  const st = profileStats(prof, 100);
  ok(st.peakW === 100 && st.meanW === 50, 'peak/mean on square wave');
  ok(Math.abs(st.rmsW - 100 / Math.SQRT2) < 1e-9, 'RMS = peak/sqrt(2) at 50% duty');
  ok(Math.abs(st.energyPerPassWh - (2 * 100 * 10) / 3600) < 1e-9, 'energy per pass');
  ok(Math.abs(st.crestFactor - 2) < 1e-9, 'crest factor');
}

// The shapes are genuinely different — that is the whole point.
{
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
}

// Pack checks: an RMS-hot profile fails even when the mean looks fine.
{
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
}

// CSV upload: two-column, one-column, decimation, and honest failures.
{
  const two = parseProfileCSV('0,100\n1,200\n2,-50\n3,150\n4,80\n');
  ok(two.uploadedPeakW === 200 && two.p.length === 5, 'two-column CSV parsed');
  ok(Math.abs(Math.min(...two.p) + 0.25) < 1e-9, 'regen normalized');
  const one = parseProfileCSV('10\n20\n30\n40\n');
  ok(one.p.length === 4 && one.uploadedPeakW === 40, 'one-column CSV parsed');
  const big = parseProfileCSV(Array.from({ length: 1500 }, (_, i) => `${i},${100 + (i % 7)}`).join('\n'));
  ok(big.p.length <= 500, `long upload decimated to ${big.p.length}`);
  let threw = false;
  try { parseProfileCSV('1,0\n2,0\n3,0\n4,0\n'); } catch { threw = true; }
  ok(threw, 'all-zero profile rejected');
}

console.log(fails === 0 ? 'LOAD-PROFILE REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
