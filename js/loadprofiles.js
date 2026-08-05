// loadprofiles.js — time-series load profiles. Two scalar numbers (cont W,
// peak W) hide what really sizes a pack: the SHAPE of the demand over time.
// The same average power delivered as WLTP driving, as power-tool trigger
// bursts, or as a UPS standby-then-surge produces different RMS heating,
// different peak currents, different regen charging and different depth of
// discharge per pass. Every application therefore carries its own
// characteristic default shape — deliberately NOT similar to each other —
// and the customer can upload their measured profile as CSV.
//
// Profiles are stored normalized: power as a fraction of the profile's peak
// (+1 = peak discharge, negative = charging/regen), with a fixed time step.
// The absolute scale comes from the application's peak power. All defaults
// are class-representative shapes, not measured traces — the WLTP entry is a
// coarse power-shape derived from the public WLTP-3 velocity trace for a
// mid-size EV, flagged as such. Pure data + math, no DOM.

function seg(value, seconds, dtS) {
  return Array(Math.max(1, Math.round(seconds / dtS))).fill(value);
}

// ---------------------------------------------------------------------------
export const LOAD_PROFILES = [
  {
    id: 'wltp-ev',
    name: 'WLTP-shaped drive cycle (EV)',
    appIds: ['ev'],
    dtS: 20,
    note: 'Coarse power shape following the WLTP Class 3 phases (Low/Medium/High/Extra-High) with regenerative braking dips; scaled by your peak power. Representative, not the homologation trace.',
    // ~30 min in 20 s steps. Low (urban stop-go) → Medium → High → Extra-High.
    p: [
      // Low: stop-and-go, modest peaks, frequent regen
      0.10, 0.25, 0.05, -0.10, 0.20, 0.30, -0.12, 0.15, 0.05, -0.08,
      0.22, 0.28, 0.10, -0.10, 0.18, 0.02, 0.25, -0.15, 0.12, 0.06,
      // Medium: suburban
      0.30, 0.38, 0.20, 0.42, -0.15, 0.35, 0.25, 0.45, -0.10, 0.30,
      0.40, 0.22, 0.48, 0.35, -0.18, 0.28, 0.42, 0.30, 0.20, -0.12,
      // High: rural
      0.50, 0.62, 0.45, 0.68, 0.55, -0.20, 0.60, 0.52, 0.70, 0.48,
      0.65, 0.58, -0.15, 0.62, 0.55, 0.68, 0.50, 0.60, -0.22, 0.45,
      // Extra-High: motorway, sustained high power, hard final regen
      0.75, 0.85, 0.80, 0.92, 0.88, 1.00, 0.90, 0.95, 0.85, 0.92,
      0.88, 0.96, 0.90, 0.85, 0.80, 0.70, 0.50, -0.30, -0.25, -0.15,
    ],
  },
  {
    id: 'ebike-assist',
    name: 'Pedal-assist ride (rolling terrain)',
    appIds: ['ebike'],
    dtS: 10,
    note: 'Assist power follows terrain: climbs at full assist, flats at partial, descents near zero. No regen (rare on e-bikes).',
    p: [
      ...seg(0.35, 60, 10), ...seg(0.90, 90, 10), ...seg(0.20, 40, 10),
      ...seg(0.05, 50, 10), ...seg(0.65, 70, 10), ...seg(1.00, 60, 10),
      ...seg(0.15, 40, 10), ...seg(0.45, 80, 10), ...seg(0.85, 50, 10),
      ...seg(0.05, 60, 10),
    ],
  },
  {
    id: 'escooter-urban',
    name: 'Urban stop-and-go (launch peaks)',
    appIds: ['escooter'],
    dtS: 5,
    note: 'Repeated launches to full power, short cruises, coasts to stops — the crest factor is what stresses the cells.',
    p: [
      ...seg(1.00, 10, 5), ...seg(0.40, 30, 5), ...seg(0.05, 15, 5),
      ...seg(0.95, 10, 5), ...seg(0.35, 40, 5), ...seg(0.05, 20, 5),
      ...seg(1.00, 10, 5), ...seg(0.45, 25, 5), ...seg(0.05, 15, 5),
      ...seg(0.90, 10, 5), ...seg(0.40, 35, 5), ...seg(0.05, 20, 5),
    ],
  },
  {
    id: 'drone-mission',
    name: 'Multirotor mission (hover-heavy)',
    appIds: ['drone'],
    dtS: 5,
    note: 'Takeoff surge, sustained hover/cruise near 70–80% of peak, maneuver spikes, landing burst. Almost no rest — RMS sits close to peak, unlike ground vehicles.',
    p: [
      ...seg(1.00, 15, 5), ...seg(0.75, 120, 5), ...seg(0.95, 10, 5),
      ...seg(0.78, 100, 5), ...seg(0.92, 10, 5), ...seg(0.72, 90, 5),
      ...seg(1.00, 15, 5), ...seg(0.40, 20, 5),
    ],
  },
  {
    id: 'powertool-bursts',
    name: 'Trigger bursts (low duty factor)',
    appIds: ['powertool'],
    dtS: 2,
    note: 'Seconds of full power, long pauses: enormous peak-to-mean ratio. Peak capability and voltage sag matter far more than energy.',
    p: [
      ...seg(1.00, 6, 2), ...seg(0.0, 20, 2), ...seg(0.95, 4, 2), ...seg(0.0, 30, 2),
      ...seg(1.00, 8, 2), ...seg(0.0, 25, 2), ...seg(0.90, 4, 2), ...seg(0.0, 40, 2),
      ...seg(1.00, 6, 2), ...seg(0.0, 20, 2),
    ],
  },
  {
    id: 'ess-daily',
    name: 'Daily solar cycle (charge midday, discharge evening)',
    appIds: ['solar-ess'],
    suitableFor: ['rv', 'powerstation'],
    dtS: 3600,
    note: '24 h at 1 h steps: overnight trickle, midday solar CHARGING (negative), evening discharge plateau. One pass = one calendar day.',
    p: [
      0.10, 0.08, 0.08, 0.08, 0.10, 0.15, 0.20, 0.10, -0.30, -0.60,
      -0.80, -0.90, -0.85, -0.70, -0.45, -0.20, 0.15, 0.45, 0.80, 1.00,
      0.90, 0.60, 0.30, 0.15,
    ],
  },
  {
    id: 'ebus-route',
    name: 'City bus route (stop–go, heavy regen, layover)',
    appIds: ['ebus'],
    suitableFor: ['ev'],
    dtS: 10,
    note: 'Repeated stop-go: launch to high power, cruise, hard regenerative stop (negative), dwell at the stop; a terminus layover ends the pass. Regen is far deeper than a passenger car.',
    p: [
      ...seg(0.85, 20, 10), ...seg(0.45, 40, 10), ...seg(-0.60, 10, 10), ...seg(0.05, 20, 10),
      ...seg(0.90, 20, 10), ...seg(0.50, 50, 10), ...seg(-0.65, 10, 10), ...seg(0.05, 20, 10),
      ...seg(1.00, 20, 10), ...seg(0.48, 40, 10), ...seg(-0.70, 10, 10), ...seg(0.05, 30, 10),
      ...seg(0.80, 20, 10), ...seg(0.42, 50, 10), ...seg(-0.60, 10, 10), ...seg(0.03, 60, 10),
    ],
  },
  {
    id: 'rv-house',
    name: 'RV / van day (cooking peaks, charging while driving)',
    appIds: ['rv'],
    dtS: 3600,
    note: '24 h at 1 h steps: overnight fridge/heater base, morning cooking peak, alternator + solar CHARGING while driving midday (negative), evening cooking and lights. A vehicle house bank, not a rooftop solar plant.',
    p: [
      0.12, 0.10, 0.10, 0.10, 0.12, 0.15, 0.55, 1.00, 0.35, -0.45,
      -0.75, -0.85, -0.80, -0.60, -0.35, 0.12, 0.20, 0.60, 0.95, 0.85,
      0.50, 0.30, 0.18, 0.12,
    ],
  },
  {
    id: 'powerstation-trip',
    name: 'Portable power box (appliance bursts, idle between)',
    appIds: ['powerstation'],
    suitableFor: ['ups'],
    dtS: 60,
    note: 'Kettle/tool bursts at full inverter power, fridge cycling, long light-load stretches — the inverter rating sets the peaks, the fridge sets the energy.',
    p: [
      ...seg(0.05, 900, 60), ...seg(1.00, 240, 60), ...seg(0.08, 1200, 60),
      ...seg(0.30, 600, 60), ...seg(0.06, 900, 60), ...seg(0.95, 180, 60),
      ...seg(0.08, 1500, 60), ...seg(0.28, 600, 60), ...seg(0.05, 900, 60),
    ],
  },
  {
    id: 'ups-standby',
    name: 'Standby with rare full-load event',
    appIds: ['ups'],
    dtS: 60,
    note: 'Near-zero float for hours, then one full-power mains-failure event. Sizing is the event, aging is the calendar — the shape shows why.',
    p: [
      ...seg(0.02, 3600, 60), ...seg(1.00, 600, 60), ...seg(0.02, 1800, 60),
    ],
  },
  {
    id: 'robot-shift',
    name: 'AGV / lift truck shift (move–lift–return, opportunity charge)',
    appIds: ['robot'],
    suitableFor: ['humanoid', 'robovac'],
    dtS: 10,
    note: 'Repetitive move–lift–return cycle with a short opportunity-charge dip at the station (negative), the LTO/LFP use case. Lift trucks add the lift peaks; AMRs flatten them.',
    p: [
      ...seg(0.55, 40, 10), ...seg(0.90, 20, 10), ...seg(0.50, 40, 10),
      ...seg(0.15, 20, 10), ...seg(-0.70, 30, 10),
      ...seg(0.60, 40, 10), ...seg(0.95, 20, 10), ...seg(0.45, 40, 10),
      ...seg(0.15, 20, 10), ...seg(-0.70, 30, 10),
    ],
  },
  {
    id: 'humanoid-locomotion',
    name: 'Humanoid robot (balance base + joint bursts)',
    appIds: ['humanoid'],
    dtS: 2,
    note: 'Continuous balance/compute base load with walking bursts and manipulation spikes — a humanoid never rests while standing, so the base never drops to zero.',
    p: [
      ...seg(0.30, 20, 2), ...seg(0.65, 30, 2), ...seg(0.35, 16, 2),
      ...seg(1.00, 6, 2), ...seg(0.60, 24, 2), ...seg(0.30, 20, 2),
      ...seg(0.90, 8, 2), ...seg(0.55, 30, 2), ...seg(0.32, 20, 2),
      ...seg(0.95, 6, 2), ...seg(0.62, 26, 2), ...seg(0.30, 24, 2),
    ],
  },
  {
    id: 'wearable-day',
    name: 'Wearable gadget day (milliwatt base, burst peaks, dock charge)',
    appIds: ['wearable'],
    dtS: 3600,
    note: '24 h at 1 h steps: milliwatt sensor/display base, a GPS workout hour and an evening burst hour at full radio+haptics power, overnight dock CHARGING (negative). One pass = one day on the wrist.',
    p: [
      -0.50, -0.50, 0.03, 0.03, 0.03, 0.03, 0.05, 0.70, 0.10, 0.05,
      0.05, 0.08, 0.06, 0.05, 0.05, 0.06, 0.05, 0.08, 0.30, 1.00,
      0.10, 0.05, 0.04, 0.03,
    ],
  },
  {
    id: 'quadruped-patrol',
    name: 'Quadruped patrol (stand, trot, obstacle, jump)',
    appIds: ['cyberdog'],
    dtS: 5,
    note: 'A robot dog spends most of its time standing still holding its own weight — cheap but never zero — then trots, climbs an obstacle, and occasionally jumps. The jump is milliseconds of kilowatts: it sizes the pack\'s peak current, while the standing and trotting size its energy.',
    p: [
      ...seg(0.06, 40, 5),                    // standing, servos holding posture
      ...seg(0.30, 60, 5),                    // trot out
      ...seg(0.55, 30, 5),                    // faster gait
      ...seg(0.30, 45, 5),
      1.00, 0.85,                             // jump: 10 s of near-peak draw
      ...seg(0.35, 40, 5),                    // recover, keep moving
      ...seg(0.70, 25, 5),                    // stairs / obstacle climb
      ...seg(0.25, 50, 5),
      ...seg(0.06, 35, 5),                    // stand and observe
      ...seg(0.40, 55, 5),                    // trot home
      1.00,                                   // final hop onto the dock
      ...seg(0.06, 30, 5),
    ],
  },
  {
    id: 'robovac-clean',
    name: 'Robot vacuum run (steady suction, dock recharge)',
    appIds: ['robovac'],
    dtS: 60,
    note: 'Near-constant suction/drive load with carpet-boost spikes, then return to dock and a CHARGING tail (negative). One pass = one cleaning run.',
    p: [
      ...seg(0.60, 600, 60), ...seg(1.00, 120, 60), ...seg(0.58, 600, 60),
      ...seg(0.95, 120, 60), ...seg(0.55, 600, 60), ...seg(0.20, 120, 60),
      ...seg(-0.55, 1200, 60),
    ],
  },
  {
    id: 'marine-full-electric',
    name: 'Full electric',
    appIds: ['marine'],
    family: 'marine-operation',
    description: 'The battery supplies the complete propulsion and auxiliary demand during the electric operating period.',
    dtS: 10,
    note: 'Battery duty for a fully electric vessel: the battery follows the complete demand, including propulsion plateaus and auxiliary loads. Use a measured vessel trace when available.',
    p: [
      ...seg(0.18, 60, 10), 0.35, 0.55, 0.75, 1.00, ...seg(0.92, 120, 10),
      0.75, 0.50, ...seg(0.28, 90, 10), 0.40, 0.55, ...seg(0.62, 120, 10),
    ],
  },
  {
    id: 'marine-load-levelling',
    name: 'Load levelling',
    appIds: ['marine'],
    family: 'marine-operation',
    description: 'Keep the genset at a stable set load: discharge the battery above it and charge below it.',
    dtS: 10,
    note: 'Battery duty for load levelling. Positive power supports demand above the genset setpoint; negative power charges the battery when demand is below it.',
    p: [
      ...seg(-0.40, 60, 10), -0.15, 0.30, 0.75, 1.00, ...seg(0.78, 100, 10),
      0.35, -0.10, ...seg(-0.55, 100, 10), ...seg(-0.25, 60, 10),
    ],
  },
  {
    id: 'marine-boost',
    name: 'Boost function',
    appIds: ['marine'],
    family: 'marine-operation',
    description: 'Add battery power above the propulsion system’s maximum continuous rating, then recharge at lower demand.',
    dtS: 10,
    note: 'Battery duty for boost operation. The battery is idle below the boost threshold, discharges while demand exceeds genset/engine MCR, then recharges when demand falls.',
    p: [
      ...seg(0.00, 60, 10), 0.25, 0.60, 1.00, ...seg(0.85, 100, 10),
      0.45, 0.10, ...seg(-0.40, 100, 10), ...seg(-0.20, 60, 10),
    ],
  },
  {
    id: 'marine-spinning-reserve',
    name: 'Spinning reserve',
    appIds: ['marine'],
    family: 'marine-operation',
    description: 'Hold the battery ready to take load immediately after a genset trip or sudden loss of generation.',
    dtS: 5,
    note: 'Battery duty for spinning reserve. The battery remains ready with near-zero power, then instantaneously carries the protected load after a representative genset trip.',
    p: [
      ...seg(0.00, 90, 5), ...seg(1.00, 60, 5), 0.85, 0.70, 0.55,
      ...seg(0.45, 120, 5),
    ],
  },
  {
    id: 'marine-peak-shaving',
    name: 'Peak shaving',
    appIds: ['marine'],
    family: 'marine-operation',
    description: 'Cover sudden short peaks and bridge the time needed to start or ramp another generator.',
    dtS: 2,
    note: 'Battery duty for peak shaving. A short discharge pulse removes the abrupt peak from the genset, followed by controlled recharge after the event.',
    p: [
      ...seg(0.00, 40, 2), ...seg(1.00, 8, 2), 0.85, 0.65, 0.45, 0.25,
      ...seg(-0.35, 20, 2), ...seg(-0.15, 20, 2), ...seg(0.00, 30, 2),
    ],
  },
  {
    id: 'marine-load-smoothing',
    name: 'Load smoothing',
    appIds: ['marine'],
    family: 'marine-operation',
    description: 'Filter rapid load fluctuations so the genset sees a steadier power demand.',
    dtS: 0.25,
    note: 'Battery duty for load smoothing above 1 Hz. Positive samples supply fast demand excursions; negative samples absorb the matching valleys around a steady genset setpoint.',
    p: [
      0.20, -0.35, 0.55, -0.50, 0.65, -0.30, 0.45, -0.70,
      0.80, -0.40, 1.00, -0.85, 0.45, -0.55, 0.70, -0.60,
      0.55, -0.45, 0.65, -0.55, 0.50, -0.35, 0.85, -0.30,
      0.75, -0.50, 0.65, -0.40, 0.55, -0.65, 0.70, -0.45,
    ],
  },
  {
    id: 'marine-ramp-support',
    name: 'Ramp support',
    appIds: ['marine'],
    family: 'marine-operation',
    description: 'Fill the genset response delay during fast demand ramps and absorb surplus while it ramps down.',
    dtS: 5,
    note: 'Battery duty for ramp support. Discharge closes the gap while the genset ramps up; charging absorbs the surplus while the genset ramps down more slowly than demand.',
    p: [
      ...seg(0.00, 30, 5), 1.00, 0.85, 0.70, 0.55, 0.40, 0.25, 0.10,
      ...seg(0.00, 60, 5), -0.15, -0.30, -0.45, -0.60, -0.75, -0.90,
      ...seg(0.00, 30, 5),
    ],
  },
];

export function profileForApp(appId) {
  return LOAD_PROFILES.find((pr) => pr.appIds.includes(appId)) || null;
}

// Every application gets a CHOICE of profiles, not a single locked default:
// first the profiles designed for it (appIds — the first is the default),
// then the ones marked suitable as alternates. The customer can still pick
// any shape, or upload their own.
export function profilesForApp(appId) {
  return [
    ...LOAD_PROFILES.filter((pr) => pr.appIds.includes(appId)),
    ...LOAD_PROFILES.filter((pr) => !pr.appIds.includes(appId) && (pr.suitableFor || []).includes(appId)),
  ];
}

export function profileById(id) {
  return LOAD_PROFILES.find((pr) => pr.id === id) || null;
}

// ---------------------------------------------------------------------------
// Profile mathematics — all on the scaled (absolute-W) profile.
// ---------------------------------------------------------------------------
export function profileStats(profile, peakScaleW) {
  const p = profile.p.map((v) => v * peakScaleW);
  const dt = profile.dtS;
  const n = p.length;
  const durationS = n * dt;
  let peakW = 0, sumPos = 0, sumSq = 0, sumChargeWh = 0, peakChargeW = 0, energyWh = 0;
  for (const w of p) {
    peakW = Math.max(peakW, w);
    sumSq += w * w;
    if (w > 0) { sumPos += w; energyWh += (w * dt) / 3600; }
    else { peakChargeW = Math.max(peakChargeW, -w); sumChargeWh += (-w * dt) / 3600; }
  }
  const meanW = sumPos / n;               // mean of demand (charging excluded)
  const rmsW = Math.sqrt(sumSq / n);      // heating-equivalent power
  return {
    durationS, peakW, meanW, rmsW,
    energyPerPassWh: energyWh,            // discharge energy in one pass
    regenWh: sumChargeWh,
    peakChargeW: peakChargeW || null,
    crestFactor: meanW > 0 ? peakW / meanW : null,
  };
}

// Profile-specific audit of a pack: the checks scalars can't do.
export function profileChecks(profile, peakScaleW, pack, cell) {
  const st = profileStats(profile, peakScaleW);
  const out = [];
  const push = (id, severity, title, detail) => out.push({ id, severity, title, detail, ref: 'load profile', category: 'application' });
  const iRms = st.rmsW / pack.nominalV;
  const iPeak = st.peakW / pack.nominalV;
  const contA = pack.maxContCurrentA;
  const pulseA = pack.maxPulseCurrentA ?? contA;

  if (iRms > contA) {
    push('lp-rms', 'fail', 'RMS current above continuous rating',
      `The profile's heating-equivalent (RMS) draw is ${iRms.toFixed(1)} A against a ${contA.toFixed(0)} A continuous rating — the pack overheats even though the average may look fine.`);
  } else {
    push('lp-rms', iRms > 0.7 * contA ? 'warn' : 'pass', 'RMS current within continuous rating',
      `Heating-equivalent draw ${iRms.toFixed(1)} A vs ${contA.toFixed(0)} A continuous (${Math.round((iRms / contA) * 100)}% utilization). RMS, not average, is what sizes the thermal path for this shape.`);
  }
  if (iPeak > pulseA) {
    push('lp-peak', 'fail', 'Profile peak exceeds pulse rating',
      `Peak draw ${iPeak.toFixed(1)} A vs ${pulseA.toFixed(0)} A pulse capability.`);
  } else {
    push('lp-peak', 'pass', 'Profile peak within pulse rating',
      `Peak draw ${iPeak.toFixed(1)} A vs ${pulseA.toFixed(0)} A (crest factor ${st.crestFactor ? st.crestFactor.toFixed(1) : '—'}).`);
  }
  if (st.peakChargeW) {
    const iChg = st.peakChargeW / pack.nominalV;
    if (iChg > pack.maxChargeCurrentA) {
      push('lp-regen', 'warn', 'Regen/charge peaks exceed charge rating',
        `The profile charges at up to ${iChg.toFixed(1)} A but the pack accepts ${pack.maxChargeCurrentA.toFixed(0)} A — regen must be curtailed (or braking blended) beyond that.`);
    } else {
      push('lp-regen', 'pass', 'Regen/charge peaks accepted',
        `Charging peaks of ${iChg.toFixed(1)} A within the ${pack.maxChargeCurrentA.toFixed(0)} A charge rating.`);
    }
  }
  const dodPct = pack.energyWh > 0 ? (st.energyPerPassWh / pack.energyWh) * 100 : null;
  if (dodPct != null) {
    push('lp-dod', dodPct > 90 ? 'warn' : 'info', 'Depth of discharge per pass',
      `One pass of this profile uses ${st.energyPerPassWh.toFixed(0)} Wh = ${dodPct.toFixed(0)}% of the pack. ` +
      (dodPct > 90 ? 'Nearly a full cycle each pass — cycle life will be consumed at full speed.'
        : `≈ ${(100 / Math.max(dodPct, 1e-9)).toFixed(1)} passes per equivalent full cycle.`));
  }
  return { stats: st, findings: out };
}

// ---------------------------------------------------------------------------
// Custom profile upload: CSV "time_s,power_W" (or one power column at 1 s).
// Normalizes to peak=1 and returns a profile object usable everywhere.
// ---------------------------------------------------------------------------
export function parseProfileCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const nums = (line.match(/[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || []).map(Number);
    if (nums.length >= 2) rows.push([nums[0], nums[1]]);
    else if (nums.length === 1) rows.push([rows.length, nums[0]]);
  }
  if (rows.length < 4) throw new Error('Need at least 4 samples of "time_s,power_W" (or one power column at 1 s steps).');
  const dts = [];
  for (let i = 1; i < rows.length; i++) dts.push(rows[i][0] - rows[i - 1][0]);
  const dtS = dts.length ? Math.max(0.1, median(dts)) : 1;
  const powers = rows.map((r) => r[1]);
  const peak = Math.max(...powers.map((v) => Math.abs(v)));
  if (!(peak > 0)) throw new Error('All power samples are zero.');
  let p = powers.map((v) => v / peak);
  while (p.length > 500) p = p.filter((_, i) => i % 2 === 0); // keep it light
  return {
    id: 'custom',
    name: 'Customer load profile (uploaded)',
    appIds: [],
    dtS: p.length < powers.length ? dtS * Math.round(powers.length / p.length) : dtS,
    note: `Uploaded profile: ${rows.length} samples, peak ${Math.round(peak)} W (used as the scale).`,
    p,
    uploadedPeakW: peak,
  };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
