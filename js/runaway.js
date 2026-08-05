// runaway.js — one cell goes. How much does each design decision help?
//
// READ THIS FIRST, BECAUSE IT DECIDES WHAT THE MODULE IS FOR.
//
// Real propagation is driven mostly by what a venting cell THROWS: hot gas,
// burning electrolyte, molten ejecta, and flame that finds whatever channel
// exists. None of that is here. This has conduction through the gap,
// radiation across it, and conduction along the interconnect — the three
// paths computable from geometry.
//
// Those three are not a small part of the answer. Run this against a 1 mm
// air-gapped 18650 NMC module, which in a real test propagates, and the model
// says the neighbour peaks 46 K BELOW onset — and it says so across every
// plausible value of its own uncertain coefficients. The omission is not a
// correction, it is most of the energy transfer.
//
// So this module does not predict whether a pack propagates, and it will
// never tell you a design is safe. What it does is COMPARE:
//
//   · Which barrier buys the most margin, and how much more than the next.
//   · What a millimetre of extra spacing is worth.
//   · How much energy one cell releases, and how much a module holds — the
//     number that sizes venting and suppression, and that nothing else in
//     the tool provides.
//
// Relative ordering is trustworthy where absolute prediction is not: every
// option is wrong by the same missing physics, so the ranking survives what
// the magnitude does not. That is the whole claim, and it is enough to make
// the decisions this informs.
//
// UL 9540A and GB 38031-2025 exist because propagation is settled by burning
// a real pack. Nothing here substitutes for that.
//
// Pure math, no DOM.

import { runawayOnsetC } from './shortcircuit.js';
import { MAX_SIM_STEPS } from './limits.js';
import { componentById } from './components.js';

// Stefan-Boltzmann, and the emissivity of a cell can — a painted or wrapped
// steel can is close to a black body, which is why radiation dominates once a
// neighbour is glowing.
const SIGMA = 5.67e-8;
const EMISSIVITY = 0.8;

// What sits between the cells. This is THE design decision the module exists
// to inform, so it is an input with real alternatives rather than a constant.
// A barrier sits INSIDE the gap, in series with whatever air is left beside
// it. That distinction is not pedantry: modelled as a replacement for the gap,
// a 0.5 mm mica sheet looks worse than a 1 mm air gap — it conducts twenty
// times more per millimetre — and the tool would tell you to remove it. In
// series, the same sheet conducts about twice as much as the air it displaces
// and blocks the ~14 W of radiation that actually carries the event. That is
// the trade, and it only appears if the geometry is right.
export const AIR_K = 0.03;
export const BARRIERS = {
  none: {
    kWmK: AIR_K, blocksRadiation: false, name: 'Air gap only',
    what: 'Nothing between the cells but air. Air conducts poorly, which feels like protection until you remember it is transparent — radiation crosses it unimpeded, and above about 300 °C that is the larger path by far.',
  },
  mica: {
    kWmK: 0.3, blocksRadiation: true, name: 'Mica sheet',
    what: 'The usual answer: thin, cheap, survives well past 900 °C, and opaque. It conducts a little more than the air it displaces and kills the radiative path, which is the trade that wins almost every time.',
  },
  aerogel: {
    kWmK: 0.02, blocksRadiation: true, name: 'Aerogel blanket',
    what: 'Lower conduction than air AND opaque. The best of both, at a price and a thickness penalty.',
  },
  potting: {
    kWmK: 0.3, blocksRadiation: true, name: 'Potting compound',
    what: 'Fills the gap entirely. Blocks radiation and adds thermal mass, but couples the cells conductively and makes the pack unserviceable.',
  },
  contact: {
    kWmK: 15, blocksRadiation: true, name: 'Cells touching',
    what: 'No gap at all. Best for volumetric density, and it hands every neighbour a direct conduction path — which is why it keeps getting chosen and keeps needing a barrier added later.',
  },
};

// A mechanical holder is not the same thing as a thermal barrier. It occupies
// only part of the facing area and therefore forms a PARALLEL heat bridge
// around the air/barrier stack. Conductivity comes from the component library;
// contact fraction and path length are visible geometry assumptions. "None"
// is a thermal reference only, not a mechanically buildable recommendation.
const spacerPath = (componentId, name, contactFraction, pathLengthMm, what) => ({
  componentId, name, contactFraction, pathLengthMm,
  kWmK: componentId ? componentById('spacer', componentId)?.thermalCondWmK : 0,
  what,
});
export const SPACERS = {
  none: spacerPath(null, 'No structural bridge (thermal reference)', 0, 1,
    'Reference case with no holder touching both cells. It is not a mechanical design.'),
  'pp-holder': spacerPath('pp-honeycomb-holder', 'Molded PP holder', 0.03, 2,
    'Small PP ribs bridge about 3% of the facing wall while fixing the cell pitch.'),
  'silicone-pad': spacerPath('silicone-spacer-pad', 'Silicone spacer pad', 0.15, 1,
    'A compliant pad touches more area than a holder rib and becomes a larger parallel heat path.'),
  'compression-pad': spacerPath('compression-foam-pad', 'Compression foam pad', 0.35, 2,
    'A broad low-conductivity pad maintains pouch-stack pressure while bridging a substantial face area.'),
  'structural-adhesive': spacerPath('direct-bond-none', 'Structural adhesive / direct bond', 1, 0.5,
    'A full-area direct bond is the strongest structural heat bridge and removes the benefit of a free gap.'),
};

// How much heat a cell in runaway actually releases, as a multiple of the
// electrical energy it stores. No datasheet publishes this, it depends
// strongly on state of charge, and it varies more between cell designs than
// between chemistries — so it is a class figure with the range carried.
export const RELEASE_MULTIPLE = {
  LFP: 0.8, LTO: 0.5, 'Na-ion': 1.0,
  NMC: 2.0, NCA: 2.2, LCO: 2.2, LiPo: 2.2,
};
export const releaseMultiple = (chemistry) => RELEASE_MULTIPLE[chemistry] ?? 1.8;

// How long one cell takes to dump that energy. Venting is violent and short;
// the thermal event around it is longer.
export const RELEASE_SECONDS = 45;

/**
 * Who is next to whom, from the layout the pack engine already produced.
 *
 * Neighbours are found geometrically rather than assumed from the grid, so a
 * hex layout gets six and a square grid gets four without either being
 * special-cased. Only the nearest ring matters: a cell two rows away is
 * shielded by the one between them.
 */
export function neighbours(positions, cellDiameterMm, reach = 1.35) {
  const cut = cellDiameterMm * reach;
  const out = positions.map(() => []);
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i], b = positions[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
      if (d <= cut && d > 0) {
        out[i].push({ index: j, distanceMm: d });
        out[j].push({ index: i, distanceMm: d });
      }
    }
  }
  return out;
}

/**
 * Does it spread?
 *
 * A lumped thermal node per cell, stepped in time. One cell is triggered; any
 * cell that reaches its onset temperature starts releasing too. The answer is
 * how many go, and how long the pack has.
 */
export function propagation({
  layout, cell, chemistry = null, barrier = 'none',
  barrierThicknessMm = 0.5, ambientC = 25, soc = 1,
  spacer = 'none', interconnectWK = 0.02, maxCells = 400, dtS = 0.05,
  couplingFrac = 0.2, releaseSeconds = RELEASE_SECONDS,
  surfaceFrac = 0.15, coreToSurfaceWK = 0.5,
}) {
  const positions = layout?.positions;
  if (!positions?.length || !cell) return null;
  const chem = chemistry || cell.chemistry;
  const onsetC = runawayOnsetC(chem);
  const bar = BARRIERS[barrier] || BARRIERS.none;
  const spacerPath = SPACERS[spacer] || SPACERS.none;

  // A propagation study is a MODULE question, not a pack question — the
  // answer is decided by the first few rings of neighbours, and stepping
  // 5,000 cells to learn the same thing is waste. Truncated honestly.
  const modelled = Math.min(positions.length, maxCells);
  const pos = positions.slice(0, modelled);
  const truncated = modelled < positions.length;

  const dMm = cell.form === 'cylindrical' ? cell.dims.d : Math.max(cell.dims.w, cell.dims.t);
  const hMm = cell.form === 'cylindrical' ? cell.dims.h : cell.dims.h;
  const nb = neighbours(pos, dMm);

  // Thermal mass: cells are about 1000 J/(kg·K) as a lump, the same figure
  // the fault study uses. One number, used consistently.
  const massKg = (cell.massG || 0) / 1000;
  const cthJK = massKg * 1000;
  if (!(cthJK > 0)) return null;

  // Energy one cell releases, scaled by state of charge — a cell at 30% has
  // far less to give than a full one, which is why storage sites keep the
  // state of charge down when nobody is watching.
  const storedJ = (cell.nominalV * cell.capacityAh * 3600) * soc;
  const releaseJ = storedJ * releaseMultiple(chem);
  const releaseW = releaseJ / releaseSeconds;

  // The conduction path between two neighbours. The gap comes from the
  // LAYOUT — it is a geometric fact, not a choice the barrier gets to make —
  // and the barrier occupies part of it, in series with the air beside it.
  const nearest = Math.min(...nb.flatMap((l) => l.map((n) => n.distanceMm)).filter((d) => d > 0));
  const gapMm = Math.max(0.05, (isFinite(nearest) ? nearest : dMm * 1.05) - dMm);
  const barMm = barrier === 'none' ? 0 : Math.min(barrierThicknessMm || 0, gapMm);
  const airMm = Math.max(0, gapMm - barMm);
  const faceAreaM2 = (dMm * hMm * couplingFrac) * 1e-6;
  // Series resistances, which is what "a sheet inside a gap" actually is.
  const rBar = barMm > 0 ? (barMm / 1000) / (bar.kWmK * faceAreaM2) : 0;
  const rAir = airMm > 0 ? (airMm / 1000) / (AIR_K * faceAreaM2) : 0;
  const gapWK = rBar + rAir > 0 ? 1 / (rBar + rAir) : (bar.kWmK * faceAreaM2) / 0.00005;
  // The holder/pad touches only part of the face and conducts in parallel
  // with the air/barrier path, rather than replacing either one.
  const spacerAreaM2 = faceAreaM2 * spacerPath.contactFraction;
  const spacerLengthM = Math.max(0.05, spacerPath.pathLengthMm) / 1000;
  const spacerWK = spacerPath.kWmK > 0
    ? (spacerPath.kWmK * spacerAreaM2) / spacerLengthM : 0;
  // Plus the interconnect, which is a heat bridge whether or not it was
  // thought of as one.
  const conductionWK = gapWK + spacerWK + interconnectWK;
  // A barrier only blocks radiation if one is actually there.
  const radiates = !(barMm > 0 && bar.blocksRadiation);

  // Ambient loss, so an isolated hot cell can actually cool down. Without
  // this every pack propagates eventually, which would be a model artefact
  // rather than a finding.
  const surfaceM2 = (Math.PI * dMm * hMm) * 1e-6;
  const ambientWK = 10 * surfaceM2;

  // TWO nodes per cell, not one. A single lump cannot propagate correctly:
  // radiation and gap conduction land on a thin outer shell, and it is the
  // SHELL that reaches onset while the core is still cool. Averaging the
  // arriving heat over the whole cell mass understates the neighbour's
  // surface by roughly the mass ratio — about sevenfold — and that error is
  // the difference between "spreads" and "does not".
  const cCoreJK = cthJK * (1 - surfaceFrac);
  const cSurfJK = cthJK * surfaceFrac;
  const T = new Array(modelled).fill(ambientC);          // surface node
  const Tc = new Array(modelled).fill(ambientC);         // core node
  const triggeredAt = new Array(modelled).fill(null);
  const releasedJ = new Array(modelled).fill(0);
  // The trigger is the most-enclosed cell — the one with the most neighbours
  // — because that is the worst case and the one worth designing against.
  const seed = nb.reduce((best, list, i) => (list.length > nb[best].length ? i : best), 0);
  triggeredAt[seed] = 0;

  let t = 0, peakC = ambientC, peakNeighbourC = ambientC;
  const steps = Math.min(MAX_SIM_STEPS, Math.ceil((releaseSeconds * 30) / dtS));
  const history = [];
  let quietFor = 0;

  for (let step = 0; step < steps; step++) {
    const dTs = new Array(modelled).fill(0);
    const dTc = new Array(modelled).fill(0);
    for (let i = 0; i < modelled; i++) {
      // The release happens in the jellyroll — the core — and reaches the
      // outside world only through the can.
      let qc = 0;
      if (triggeredAt[i] != null && releasedJ[i] < releaseJ) {
        qc += releaseW;
        releasedJ[i] += releaseW * dtS;
      }
      const coreToSurf = coreToSurfaceWK * (Tc[i] - T[i]);
      qc -= coreToSurf;

      // Everything from outside arrives at the surface.
      let qs = coreToSurf;
      for (const n of nb[i]) {
        qs += conductionWK * (T[n.index] - T[i]);
        // Radiation, computed rather than linearised, because the whole
        // question is what happens at 800 °C where it dominates.
        if (radiates) {
          const a = T[i] + 273.15, b = T[n.index] + 273.15;
          qs += EMISSIVITY * SIGMA * faceAreaM2 * (b * b * b * b - a * a * a * a);
        }
      }
      qs -= ambientWK * (T[i] - ambientC);
      dTc[i] = (qc / cCoreJK) * dtS;
      dTs[i] = (qs / cSurfJK) * dtS;
    }
    let newlyTriggered = 0;
    for (let i = 0; i < modelled; i++) {
      Tc[i] = Math.min(1000, Tc[i] + dTc[i]);
      T[i] = Math.min(1000, T[i] + dTs[i]);
      if (T[i] > peakC) peakC = T[i];
      if (i !== seed && T[i] > peakNeighbourC) peakNeighbourC = T[i];
      // Externally heated cells run away from the outside in, so onset is
      // judged on the surface — the part that actually gets hot first.
      if (triggeredAt[i] == null && T[i] >= onsetC) { triggeredAt[i] = t; newlyTriggered++; }
    }
    t += dtS;
    if (step % Math.round(1 / dtS) === 0) {
      history.push({ t, gone: triggeredAt.filter((x) => x != null).length, hottestC: Math.max(...T) });
    }
    // Stop when it is over: either everything has gone, or nothing new has
    // happened for long enough that nothing will.
    quietFor = newlyTriggered ? 0 : quietFor + dtS;
    if (triggeredAt.every((x) => x != null)) break;
    if (quietFor > releaseSeconds * 3 && releasedJ.every((r, i) => triggeredAt[i] == null || r >= releaseJ)) break;
  }

  const gone = triggeredAt.filter((x) => x != null).length;
  const spread = gone > 1;
  const secondAt = triggeredAt.filter((x) => x != null && x > 0).sort((a, b) => a - b)[0] ?? null;
  const fraction = gone / modelled;

  // The vocabulary is deliberately asymmetric: this model can refuse a
  // design, and it can NEVER clear one. Given that it under-predicts by a
  // wide margin, 'spread' here means the design fails even the optimistic
  // case — which is about as strong a finding as a simulation can give.
  const verdict = spread ? 'not-workable' : 'unproven';

  const findings = [];
  if (spread) {
    findings.push({
      severity: 'fail', category: 'safety',
      title: `Runaway spreads even on the optimistic paths: ${gone} of ${modelled} cells go`,
      detail: `The first neighbour reaches ${onsetC} °C ${secondAt != null ? `${secondAt.toFixed(0)} s` : 'shortly'} after the trigger, and it cascades to `
        + `${(fraction * 100).toFixed(0)}% of the modelled cells. This model counts only conduction, radiation and the interconnect, and it UNDER-predicts propagation badly — `
        + `so a design that spreads here spreads in reality by a wide margin. The levers are the gap (${gapMm.toFixed(1)} mm now), what fills it (${bar.name.toLowerCase()}), and the state of charge the pack sits at.`,
    });
  }
  if (radiates) {
    findings.push({
      severity: 'warn', category: 'safety',
      title: 'An air gap does not stop radiation',
      detail: 'Air conducts poorly, which makes a gap feel like protection. But air is transparent, and a cell at 800 °C radiates straight through it — above roughly 300 °C that path is the larger one. '
        + 'An opaque sheet of the same thickness conducts a little more and still loses far less overall, which is why mica is in almost every pack that has been through a propagation test.',
    });
  }
  if (truncated) {
    findings.push({
      severity: 'info', category: 'safety',
      title: `Modelled ${modelled} cells of ${positions.length}`,
      detail: 'Propagation is decided by the first rings of neighbours around the trigger, so the study runs on a module-sized neighbourhood rather than the whole pack.',
    });
  }

  return {
    verdict, spread, gone, modelled, truncated, fraction,
    onsetC, peakC, peakNeighbourC,
    // How close the nearest neighbour came to going. This is a COMPARATIVE
    // figure, not a safety margin — see propagationStudy().
    marginK: onsetC - peakNeighbourC,
    secondsToSecondCell: secondAt,
    totalSeconds: t,
    energy: { perCellJ: releaseJ, storedJ, multiple: releaseMultiple(chem), releaseW, moduleJ: releaseJ * modelled },
    coupling: {
      gapMm, barrier: bar.name, spacer: spacerPath.name,
      conductionWK, gapWK, spacerWK, interconnectWK, radiates,
      barrierMm: barMm, airMm, spacerAreaM2, spacerLengthMm: spacerPath.pathLengthMm,
      spacerContactFraction: spacerPath.contactFraction,
    },
    equations: {
      scope: 'post-trigger propagation: the seed cell is triggered at t=0; actual-cell ARC/DSC kinetics are not inferred',
      release: 'Q_release = E_electrical × SoC × chemistry_release_multiple; q_release = Q_release / release_time',
      gap: 'G_gap = 1 / (L_barrier/(k_barrier·A_face) + L_air/(k_air·A_face))',
      spacer: 'G_spacer = k_spacer·(contact_fraction·A_face) / L_spacer',
      totalConduction: 'G_between = G_gap + G_spacer + G_interconnect',
      radiation: 'q_radiation = ε·σ·A_face·(T_neighbour⁴ − T_surface⁴), unless an opaque barrier blocks it',
      core: 'C_core·dT_core/dt = q_release − G_core-shell·(T_core − T_surface)',
      surface: 'C_surface·dT_surface/dt = q_core-shell + q_between + q_radiation − G_ambient·(T_surface − T_ambient)',
      trigger: 'trigger the next cell when T_surface ≥ chemistry-class runaway onset',
    },
    kineticsBoundary: {
      model: 'bounded chemistry-class heat release after trigger',
      requiredForMeasuredKinetics: ['actual-cell ARC onset', 'total heat release', 'heat-release rate versus temperature/time', 'state-of-charge dependence'],
    },
    history,
    headline: spread
      ? `One cell takes ${gone === modelled ? 'the whole module' : `${gone} of ${modelled} cells`} with it, the second going ${secondAt != null ? `${secondAt.toFixed(0)} s` : 'soon'} after the first — and this model under-predicts, so the real case is worse.`
      : `On conduction and radiation alone the nearest neighbour peaks at ${peakNeighbourC.toFixed(0)} °C, ${(onsetC - peakNeighbourC).toFixed(0)} K under the ${onsetC} °C onset. That is NOT a safety margin — it is a comparison figure, because the mechanisms that actually carry propagation are not in this model.`,
    findings,
    assumptions: ASSUMPTIONS(chem, onsetC, releaseJ, soc, releaseSeconds, couplingFrac, spacerPath),
  };
}

const ASSUMPTIONS = (chem, onsetC, releaseJ, soc, releaseSeconds, couplingFrac, spacerPath) => [
  'CONDUCTION, RADIATION AND THE INTERCONNECT ONLY. Hot gas, burning electrolyte, flame and ejecta — the mechanisms that dominate a real event — are NOT modelled. Against a module that propagates in a real test, this model reports the neighbour peaking tens of kelvin BELOW onset, and it does so across every plausible value of its own coefficients. Use it to rank options, never to clear one.',
  `Onset at ${onsetC} °C for ${chem}, a chemistry-class figure that depends on state of charge and cell design. Replace it with ARC data for your actual cell before relying on any number here.`,
  `Heat release taken as ${releaseMultiple(chem)}x the stored electrical energy (${(releaseJ / 1000).toFixed(0)} kJ per cell at ${(soc * 100).toFixed(0)}% SoC), spread over ${releaseSeconds} s. No datasheet publishes this; it varies more between cell designs than between chemistries.`,
  `Two thermal nodes per cell — a core holding the mass and a thin shell that outside heat arrives at. One node per cell cannot propagate correctly, because it averages the arriving heat over a mass roughly seven times the shell that actually reaches onset first.`,
  `Neighbour coupling over ${(couplingFrac * 100).toFixed(0)}% of the facing wall. Cylinders touch along a line rather than a face, so this is a class estimate and it scales the whole conduction path.`,
  `${spacerPath.name}: thermal conductivity ${spacerPath.kWmK} W/mK from the component library, modelled over ${(spacerPath.contactFraction * 100).toFixed(0)}% contact area and ${spacerPath.pathLengthMm} mm path length. Confirm both geometry assumptions against the actual holder drawing.`,
  'Passing this is not passing a test. UL 9540A and GB 38031-2025 exist because propagation is settled by burning a real pack.',
];

/**
 * The comparison the module is actually good for.
 *
 * Runs the same geometry against every barrier option and reports which buys
 * the most margin. Every option carries the same missing physics, so the
 * ORDER survives even though the magnitudes do not — and the order is what
 * the decision needs.
 */
export function propagationStudy({ layout, cell, options = null, spacerOptions = null, ...rest }) {
  const base = propagation({ layout, cell, ...rest });
  if (!base) return null;
  const trials = options || [
    { barrier: 'none', label: 'Air gap only' },
    { barrier: 'mica', barrierThicknessMm: 0.5, label: 'Mica sheet, 0.5 mm' },
    { barrier: 'aerogel', barrierThicknessMm: 1, label: 'Aerogel, 1 mm' },
    { barrier: 'potting', label: 'Potted' },
  ];
  const ranked = trials
    .map((o) => {
      const r = propagation({ layout, cell, ...rest, ...o });
      return r && {
        label: o.label || o.barrier, barrier: o.barrier,
        marginK: r.marginK, peakNeighbourC: r.peakNeighbourC,
        spread: r.spread, conductionWK: r.coupling.conductionWK, radiates: r.coupling.radiates,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.marginK - a.marginK);

  const spacerTrials = spacerOptions || [
    { spacer: 'none', label: 'No holder bridge (reference only)' },
    { spacer: 'pp-holder', label: 'Molded PP holder' },
    { spacer: 'silicone-pad', label: 'Silicone spacer pad' },
    { spacer: 'compression-pad', label: 'Compression foam pad' },
    { spacer: 'structural-adhesive', label: 'Structural adhesive / direct bond' },
  ];
  const spacerRanked = spacerTrials
    .map((o) => {
      const r = propagation({ layout, cell, ...rest, ...o });
      return r && {
        label: o.label || o.spacer, spacer: o.spacer,
        marginK: r.marginK, spread: r.spread,
        spacerWK: r.coupling.spacerWK, totalConductionWK: r.coupling.conductionWK,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.marginK - a.marginK);

  const best = ranked[0], worst = ranked[ranked.length - 1];
  const moduleMJ = base.energy.moduleJ / 1e6;

  return {
    ...base,
    ranked,
    spacerRanked,
    headline: `${best.label} buys ${(best.marginK - worst.marginK).toFixed(0)} K more margin than ${worst.label.toLowerCase()} on this geometry. `
      + `That ORDERING is the usable result; the absolute numbers are not, because the mechanisms that carry real propagation are missing from all of them.`,
    containment: {
      perCellMJ: base.energy.perCellJ / 1e6,
      moduleMJ,
      note: `One cell releases about ${(base.energy.perCellJ / 1e6).toFixed(2)} MJ. If the whole modelled group goes, that is ${moduleMJ.toFixed(1)} MJ — `
        + `the number that sizes venting area, enclosure strength and any suppression, and the one figure here that does not depend on the propagation model being right.`,
    },
    findings: [
      ...base.findings,
      {
        severity: 'info', category: 'safety',
        title: `Barrier choice is worth ${(best.marginK - worst.marginK).toFixed(0)} K on this geometry`,
        detail: ranked.map((r) => `${r.label}: ${r.marginK.toFixed(0)} K under onset${r.radiates ? ' (radiation not blocked)' : ''}`).join(' · ')
          + '. Compare these against each other, not against zero.',
      },
      {
        severity: 'warn', category: 'safety',
        title: `Plan to contain ${moduleMJ.toFixed(1)} MJ`,
        detail: `One cell releases about ${(base.energy.perCellJ / 1e6).toFixed(2)} MJ at ${((rest.soc ?? 1) * 100).toFixed(0)}% state of charge. `
          + `If the group goes, the enclosure has to survive ${moduleMJ.toFixed(1)} MJ and vent what comes with it. `
          + `This figure follows from the cell's own energy and does not depend on whether the propagation model above is right — it is the most trustworthy number in this study.`,
      },
    ],
  };
}
