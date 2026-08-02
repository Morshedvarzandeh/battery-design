// Markets — the release checklist (standards per application class and
// market, chemistry-market gates like China's e-bus rule), the e-bus
// preset/profile/comms, and the training tracks.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { PRESETS } from '../js/presets.js';
import { MARKETS, releaseChecklist } from '../js/markets.js';
import { profileForApp, LOAD_PROFILES, profileStats } from '../js/loadprofiles.js';
import { commsForApp } from '../js/architecture.js';
import { euChecks } from '../js/eurules.js';
import { TRAINING_TRACKS } from '../js/training.js';

test('the exact customer case: no NMC buses in China', () => {
  const nmc = releaseChecklist({ market: 'cn', application: 'ebus', chemistry: 'NMC' });
  ok(nmc.rules.some((r) => r.scope === 'blocker' && /excluded/.test(r.title)),
    'China + e-bus + NMC raises a blocker');
  ok(nmc.rules.some((r) => /MIIT/.test(r.code)), 'the blocker names its source (catalogue practice)');
  ok(nmc.rules.some((r) => /[Vv]erify/.test(r.note)), 'the blocker says verify the current catalogue — honesty');
  const lfp = releaseChecklist({ market: 'cn', application: 'ebus', chemistry: 'LFP' });
  ok(lfp.rules.some((r) => r.scope === 'pass'), 'LFP e-bus in China passes the chemistry gate');
  ok(!lfp.rules.some((r) => r.scope === 'blocker'), 'no blocker for LFP');
  const eu = releaseChecklist({ market: 'eu', application: 'ebus', chemistry: 'NMC' });
  ok(!eu.rules.some((r) => r.scope === 'blocker'), 'the China rule does not leak into the EU list');
});

test('checklist coverage: every application × every market', () => {
  for (const pr of PRESETS) {
    for (const m of MARKETS) {
      const cl = releaseChecklist({ market: m.id, application: pr.id, chemistry: 'LFP' });
      ok(cl.items.length > 0, `${pr.id} × ${m.id} has checklist items`);
      ok(cl.items.some((i) => i.code === 'UN 38.3'), `${pr.id} × ${m.id} always includes UN 38.3 transport`);
      ok(cl.items.every((i) => ['mandatory', 'expected', 'practice'].includes(i.scope)),
        `${pr.id} × ${m.id} scopes valid`);
    }
  }
  const ev = releaseChecklist({ market: 'eu', application: 'ev', chemistry: 'NMC' });
  ok(ev.items.some((i) => /R100/.test(i.code)), 'EU vehicle: ECE R100 present');
  ok(ev.items.some((i) => /2023\/1542/.test(i.code)), 'EU vehicle: battery regulation present');
  const ess = releaseChecklist({ market: 'us', application: 'solar-ess', chemistry: 'LFP' });
  ok(ess.items.some((i) => /9540/.test(i.code)) && ess.items.some((i) => /NFPA 855/.test(i.code)),
    'US stationary: UL 9540 + NFPA 855');
  const agv = releaseChecklist({ market: 'eu', application: 'robot', chemistry: 'LTO' });
  ok(agv.items.some((i) => /1175|3691/.test(i.code)), 'EU industrial truck: EN 1175 / ISO 3691-4');
});

test('e-bus: preset, route profile, J1939, EU treatment as an EV battery', () => {
  const ebus = PRESETS.find((p) => p.id === 'ebus');
  ok(ebus && ebus.preferredChemistries[0] === 'LFP', 'e-bus preset exists, LFP-first');
  ok(/NMC|ternary/i.test(ebus.notes), 'e-bus preset notes carry the China chemistry warning');
  ok(profileForApp('ebus')?.id === 'ebus-route', 'e-bus has its own route profile');
  const prof = LOAD_PROFILES.find((p) => p.id === 'ebus-route');
  ok(prof.p.some((v) => v < -0.5), 'bus route has deep regen');
  const st = profileStats(prof, 250000);
  ok(st.regenWh > 0 && st.crestFactor > 1.5, 'bus stats: regen present, stop-go crest');
  ok(/J1939/.test(commsForApp('ebus').primary), 'e-bus communication: SAE J1939 primary');
  const eu = euChecks({ energyWh: 250000, application: 'ebus', chemistry: 'LFP', commsPrimary: commsForApp('ebus').alternates.join(' ') });
  ok(eu.some((f) => /passport/i.test(f.title) && f.severity === 'warn'), 'e-bus treated as EV battery under 2023/1542');
});

test('training tracks: real tabs, real explanations, right ordering', () => {
  const validTabs = new Set(['design', 'usage', 'fit', 'comp', 'analysis', 'therm', 'eu', 'results']);
  for (const [id, track] of Object.entries(TRAINING_TRACKS)) {
    ok(track.steps.length >= 5, `${id} track has a real sequence`);
    for (const st of track.steps) {
      ok(validTabs.has(st.tab), `${id}: step "${st.title}" targets a real tab (${st.tab})`);
      ok(st.title && st.text.length > 40, `${id}: step "${st.title}" explains, not labels`);
    }
  }
  ok(TRAINING_TRACKS.simple.steps.length < TRAINING_TRACKS.advanced.steps.length,
    'simple track is genuinely shorter');
  ok(TRAINING_TRACKS.advanced.steps.some((s) => /swell|crash|ECE R100/i.test(s.text)),
    'advanced track teaches why the spaces exist');
  ok(TRAINING_TRACKS.advanced.steps.some((s) => s.tab === 'eu'), 'advanced track covers the rules tab');
});
