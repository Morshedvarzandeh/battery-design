// shortcircuit.js — what happens in the first few milliseconds of a fault.
//
// Everything else in this tool answers "will the pack do the job?". This
// answers the other question, the one that decides whether a pack is allowed
// to exist: WHEN IT FAILS, DOES IT FAIL SAFELY?
//
// A pack shorted at its terminals is a voltage source with milliohms of
// internal resistance. Kiloamps arrive within microseconds, and three clocks
// then run at once:
//
//   · the FUSE heating toward its melting point,
//   · the BUSBAR heating toward the temperature that destroys it,
//   · the CELLS heating toward thermal-runaway onset.
//
// The design is safe only if the fuse wins that race. This module runs the
// race and says who wins, in milliseconds, with the margin.
//
// It answers four faults, because they are genuinely different problems:
//   1. a hard short across the pack terminals (the certification test case),
//   2. a short after the contactor, where the contactor must interrupt it,
//   3. a short across one module,
//   4. an INTERNAL short in a single cell — where the danger is not the
//      external circuit at all, but the parallel neighbours emptying
//      themselves into their faulted sibling.
//
// Modelled as a lumped R-L circuit with adiabatic heating: over the few
// milliseconds a fault lasts, nothing has time to cool, which makes adiabatic
// the correct assumption rather than a convenient one.
//
// Pure math, no DOM.

import { ocvCell } from './sim1d.js';

// Copper, the material every pack busbar is made of.
export const CU_RESISTIVITY = 1.72e-8;   // Ω·m at 20 °C
export const CU_TEMPCO = 0.00393;        // per K
export const CU_DENSITY = 8960;          // kg/m³
export const CU_CP = 385;                // J/(kg·K)

// Thermal-runaway onset by chemistry: the cell temperature past which
// self-heating outruns any cooling and the outcome is no longer in the
// designer's hands. Class values (§8) — exposed so they can be replaced with
// ARC data for the actual cell.
export const RUNAWAY_ONSET_C = {
  NMC: 135, NCA: 130, LCO: 130, LFP: 190, LTO: 220, 'Na-ion': 160, LiPo: 130,
};
export const runawayOnsetC = (chemistry) => RUNAWAY_ONSET_C[chemistry] ?? 140;

// Adiabatic conductor constant k, in A·√s/mm²: a conductor survives a fault
// if I²t ≤ (k·A)². The value depends on what is touching the busbar, which is
// a design choice, so it is an input rather than a constant.
//
// These are the published COPPER values, kept because they are what an
// engineer recognises. The temperature pair is what each one encodes — the
// limit is set by whatever is touching the conductor, not by the copper. For
// any other metal use `adiabaticK()` in materials.js, which derives k from
// the material's own properties and reproduces all three of these exactly.
export const K_ADIABATIC = {
  'pvc-insulated': 115,   // copper, 70 → 160 °C — the PVC is the limit
  'xlpe-insulated': 143,  // copper, 90 → 250 °C — the XLPE is the limit
  'bare-copper': 226,     // copper, 30 → 500 °C — nothing meltable nearby
};

export const FAULT_KINDS = [
  {
    id: 'terminal', name: 'Dead short across the pack terminals',
    what: 'A spanner across the terminals, or a crushed cable. The whole pack drives the fault through its own resistance and the busbars.',
    faultMOhm: 0,
    standard: 'The condition UN 38.3 T5 and UL 2580 test for.',
  },
  {
    id: 'test-100', name: 'Certification short (≤ 100 mΩ external)',
    what: 'The external short-circuit test in UN 38.3 T5: the pack is shorted through a total external resistance of less than 100 mΩ and must not catch fire or explode.',
    faultMOhm: 100,
    standard: 'UN 38.3 T5 external short circuit.',
  },
  {
    id: 'post-contactor', name: 'Short downstream of the contactor',
    what: 'A fault in the vehicle harness after the main contactor. Here the contactor is asked to interrupt the fault current — which it can only do below its rated breaking capacity.',
    faultMOhm: 5,
    standard: 'The case that decides the contactor breaking rating.',
  },
  {
    id: 'module', name: 'Short across one module',
    what: 'A fault confined to one module: fewer cells in series, so less voltage, but the same low resistance and no main fuse necessarily in the path.',
    faultMOhm: 0,
    standard: 'Drives module-level fusing and internal segmentation.',
  },
];

export const faultKindById = (id) => FAULT_KINDS.find((f) => f.id === id) || FAULT_KINDS[0];

/**
 * The external fault: an R-L circuit discharging a stiff source.
 *
 * Current rises with the loop time constant L/R and then falls as the cells
 * heat and their resistance climbs. Meanwhile the fuse accumulates I²t.
 */
export function simulateExternalShort({
  cell, s, p, faultMOhm = 0,
  busbarMOhm = 0.5, contactorMOhm = 0.2, loopInductanceUH = 1.0,
  startSoC = 1.0, startTempC = 25,
  fuseI2t = null, fuseRatingA = null,
  busbarAreaMm2 = 50, busbarK = K_ADIABATIC['xlpe-insulated'],
  dtS = 5e-6, maxTimeS = 0.5,
}) {
  const ocv0 = ocvCell(cell, startSoC) * s;
  const cellROhm = ((cell.dcirMOhm ?? 20) / 1000) * s / p;
  const fixedROhm = (busbarMOhm + contactorMOhm + faultMOhm) / 1000;
  const L = loopInductanceUH * 1e-6;
  const massCellKg = (cell.massG || 50) / 1000;
  const cthCellJK = massCellKg * 1000;      // J/K per cell, ~1000 J/(kg·K)

  let i = 0, t = 0, i2t = 0, tempC = startTempC, soc = startSoC;
  let peakA = 0, peakAtS = 0;
  let fuseClearedAtS = null, busbarFailedAtS = null, runawayAtS = null;
  const onsetC = runawayOnsetC(cell.chemistry);
  const busbarI2tLimit = Math.pow(busbarK * busbarAreaMm2, 2);
  const series = { t: [], i: [], v: [], tempC: [] };
  const sampleEvery = Math.max(1, Math.round(maxTimeS / dtS / 400));
  let step = 0;

  while (t < maxTimeS) {
    // Cell resistance climbs as the pack heats — copper-like coefficient is
    // wrong for a cell, but resistance definitely rises, and ignoring it
    // would overstate the current late in the fault.
    const rCells = cellROhm * (1 + 0.004 * (tempC - 25));
    const rTotal = rCells + fixedROhm;
    const ocv = ocvCell(cell, soc) * s;
    // di/dt = (V − i·R)/L — the inductance is what stops the current being
    // instantaneous, and it is the reason a fuse ever gets time to act.
    i += ((ocv - i * rTotal) / L) * dtS;
    if (i < 0) i = 0;
    if (i > peakA) { peakA = i; peakAtS = t; }
    i2t += i * i * dtS;

    // Adiabatic heating of the cells by their own share of the loss.
    const qCellW = (i / p) * (i / p) * ((cell.dcirMOhm ?? 20) / 1000);
    tempC += (qCellW / cthCellJK) * dtS;
    soc = Math.max(0, soc - (i * dtS / 3600) / (cell.capacityAh * p));

    if (step % sampleEvery === 0) {
      series.t.push(t); series.i.push(i);
      series.v.push(ocv - i * rCells); series.tempC.push(tempC);
    }

    if (fuseClearedAtS == null && fuseI2t != null && i2t >= fuseI2t) {
      fuseClearedAtS = t;
      break; // the fuse opens: the fault is over
    }
    if (busbarFailedAtS == null && i2t >= busbarI2tLimit) busbarFailedAtS = t;
    if (runawayAtS == null && tempC >= onsetC) runawayAtS = t;
    t += dtS; step++;
  }

  return {
    ocv0, prospectiveA: ocv0 / (cellROhm + fixedROhm),
    peakA, peakAtS, i2t, durationS: t,
    cellROhm, fixedROhm, totalROhm: cellROhm + fixedROhm,
    timeConstantS: L / (cellROhm + fixedROhm),
    finalTempC: tempC, runawayOnsetC: onsetC,
    fuseClearedAtS, busbarFailedAtS, runawayAtS,
    busbarI2tLimit, busbarAreaMm2, busbarK,
    perCellA: peakA / p, series,
  };
}

/**
 * The internal short — the fault that fusible links exist for.
 *
 * One cell in a parallel group develops an internal short. The external
 * circuit is irrelevant: the danger is its own P−1 neighbours, which see a
 * near-zero-resistance path and empty themselves into it. This is why a large
 * parallel group without per-cell fusing is a different risk from a small one.
 */
export function internalShortInGroup({
  cell, p, shortMOhm = 5, linkFuseA = null, startSoC = 1.0, startTempC = 25,
}) {
  const ocv = ocvCell(cell, startSoC);
  const cellROhm = (cell.dcirMOhm ?? 20) / 1000;
  const neighbours = Math.max(0, p - 1);
  // Each neighbour drives the fault through its own resistance plus the short.
  const pathROhm = cellROhm + shortMOhm / 1000;
  const perNeighbourA = neighbours > 0 ? ocv / pathROhm : 0;
  const totalIntoFaultA = perNeighbourA * neighbours + ocv / (cellROhm + shortMOhm / 1000);
  const faultPowerW = totalIntoFaultA * totalIntoFaultA * (shortMOhm / 1000);
  const massCellKg = (cell.massG || 50) / 1000;
  const cthJK = massCellKg * 1000;
  const onsetC = runawayOnsetC(cell.chemistry);
  const secondsToOnset = faultPowerW > 0 ? ((onsetC - startTempC) * cthJK) / faultPowerW : Infinity;

  // A fusible link opens when its own current exceeds its fusing point. The
  // question is only ever whether that happens before the cell is gone.
  let linkOpensAtS = null;
  if (linkFuseA != null && perNeighbourA > linkFuseA) {
    // Thin wire bonds are fast: approximate melting time from the square-law
    // overload, floored at the ~100 µs it physically takes to vaporise.
    linkOpensAtS = Math.max(1e-4, 0.01 * Math.pow(linkFuseA / perNeighbourA, 2));
  }

  const protectedByLinks = linkOpensAtS != null && linkOpensAtS < secondsToOnset;
  return {
    neighbours, perNeighbourA, totalIntoFaultA, faultPowerW,
    secondsToOnset, onsetC, linkOpensAtS, protectedByLinks,
    energyToOnsetJ: (onsetC - startTempC) * cthJK,
    verdict: neighbours === 0 ? 'workable'
      : protectedByLinks ? 'workable'
        : linkFuseA == null ? 'not-workable' : 'workable-with-costs',
    why: neighbours === 0
      ? 'A single cell per group has no neighbours to feed a fault: an internal short discharges only that cell.'
      : protectedByLinks
        ? `Each of the ${neighbours} neighbours drives about ${Math.round(perNeighbourA)} A into the faulted cell, which opens a ${linkFuseA} A fusible link in roughly ${(linkOpensAtS * 1000).toFixed(1)} ms — comfortably before the ${(secondsToOnset * 1000).toFixed(0)} ms it would take to reach ${onsetC} °C. The group isolates its own casualty.`
        : linkFuseA == null
          ? `Nothing limits the ${Math.round(totalIntoFaultA)} A that ${neighbours} neighbours drive into one faulted cell. At ${Math.round(faultPowerW)} W into a single can, ${onsetC} °C arrives in about ${(secondsToOnset * 1000).toFixed(0)} ms, and the neighbours keep feeding it. This is the mechanism behind propagating pack fires, and per-cell fusible links are the accepted answer.`
          : `A ${linkFuseA} A link does not open fast enough: ${(linkOpensAtS * 1000).toFixed(0)} ms against ${(secondsToOnset * 1000).toFixed(0)} ms to onset. Use a lower-rated link or fewer cells per group.`,
  };
}

/**
 * The whole study: run every fault the application can meet, decide who wins
 * each race, and produce ONE sentence a customer can act on.
 */
export function shortCircuitStudy({
  cell, s, p, summary = null,
  busbarMOhm = 0.5, contactorMOhm = 0.2, loopInductanceUH = 1.0,
  fuseRatingA = null, fuseI2t = null, contactorBreakingA = null,
  busbarAreaMm2 = 50, busbarKind = 'xlpe-insulated',
  linkFuseA = null, internalShortMOhm = 5, startSoC = 1.0,
}) {
  const busbarK = K_ADIABATIC[busbarKind] ?? K_ADIABATIC['xlpe-insulated'];
  // A fuse with no stated I²t is sized by the class rule of thumb: melting
  // I²t of a fast pack fuse is roughly (10·In)²·0.01 s. Stated, not hidden.
  const ratedA = fuseRatingA ?? (summary?.maxContCurrentA ? Math.ceil(summary.maxContCurrentA * 1.5) : null);
  const i2tRating = fuseI2t ?? (ratedA != null ? Math.pow(10 * ratedA, 2) * 0.01 : null);

  const faults = FAULT_KINDS.map((kind) => {
    const sEff = kind.id === 'module' ? Math.max(1, Math.round(s / 4)) : s;
    const r = simulateExternalShort({
      cell, s: sEff, p, faultMOhm: kind.faultMOhm,
      busbarMOhm, contactorMOhm, loopInductanceUH, startSoC,
      fuseI2t: kind.id === 'module' ? null : i2tRating,
      busbarAreaMm2, busbarK,
    });
    // Who won the race?
    const cleared = r.fuseClearedAtS;
    const busbarGone = r.busbarFailedAtS;
    const runaway = r.runawayAtS;
    let verdict = 'workable', why;
    if (cleared != null && (busbarGone == null || cleared < busbarGone) && (runaway == null || cleared < runaway)) {
      verdict = 'workable';
      why = `The fuse clears in ${(cleared * 1000).toFixed(2)} ms at a peak of ${(r.peakA / 1000).toFixed(1)} kA — before the busbar or the cells are in trouble.`;
    } else if (cleared == null && busbarGone == null && runaway == null) {
      verdict = i2tRating == null ? 'unproven' : 'workable-with-costs';
      why = i2tRating == null
        ? `Peak ${(r.peakA / 1000).toFixed(1)} kA, and no fuse is specified — nothing in this design interrupts the fault.`
        : `Peak ${(r.peakA / 1000).toFixed(1)} kA sustained: the fuse does not reach its melting I²t within ${(r.durationS * 1000).toFixed(0)} ms. It will clear eventually, but nothing here proves it happens in time.`;
    } else if (runaway != null && (cleared == null || runaway < cleared)) {
      verdict = 'not-workable';
      why = `Cells reach ${r.runawayOnsetC} °C in ${(runaway * 1000).toFixed(1)} ms — ${cleared == null ? 'and the fuse never clears' : `before the fuse clears at ${(cleared * 1000).toFixed(1)} ms`}. This is a fire, not a fault.`;
    } else {
      verdict = 'not-workable';
      why = `The busbar reaches its adiabatic limit in ${(busbarGone * 1000).toFixed(2)} ms — ${cleared == null ? 'the fuse never clears' : `the fuse needs ${(cleared * 1000).toFixed(2)} ms`}. A ${busbarAreaMm2} mm² conductor cannot survive ${(r.peakA / 1000).toFixed(1)} kA for that long; widen it or fuse faster.`;
    }
    // The contactor only has to interrupt the faults that reach it.
    let contactor = null;
    if (kind.id === 'post-contactor' && contactorBreakingA != null) {
      const canBreak = r.peakA <= contactorBreakingA;
      contactor = {
        canBreak, requiredA: r.peakA, ratedA: contactorBreakingA,
        note: canBreak
          ? `The contactor is rated to break ${(contactorBreakingA / 1000).toFixed(1)} kA and the fault peaks at ${(r.peakA / 1000).toFixed(1)} kA — it can open the circuit itself.`
          : `The fault peaks at ${(r.peakA / 1000).toFixed(1)} kA against a ${(contactorBreakingA / 1000).toFixed(1)} kA breaking rating. Asked to open this, the contactor welds shut. The fuse must clear it, and the contactor must never be commanded open into a fault above its rating.`,
      };
      if (!canBreak && verdict === 'workable') verdict = 'workable-with-costs';
    }
    return { kind, result: r, verdict, why, contactor };
  });

  const internal = internalShortInGroup({ cell, p, shortMOhm: internalShortMOhm, linkFuseA, startSoC });
  const worst = ['not-workable', 'unproven', 'workable-with-costs', 'workable']
    .find((v) => faults.some((f) => f.verdict === v) || internal.verdict === v);
  const terminal = faults.find((f) => f.kind.id === 'terminal');

  return {
    faults, internal, verdict: worst,
    fuse: { ratedA, i2tRating, assumed: fuseI2t == null },
    busbar: { areaMm2: busbarAreaMm2, kind: busbarKind, k: busbarK },
    // The one sentence. Everything above is why it is true.
    headline: `A dead short at the terminals draws about ${(terminal.result.peakA / 1000).toFixed(1)} kA`
      + (terminal.result.fuseClearedAtS != null
        ? `, cleared by the fuse in ${(terminal.result.fuseClearedAtS * 1000).toFixed(2)} ms.`
        : ` and nothing here is shown to clear it.`),
    findings: [
      ...faults.filter((f) => f.verdict === 'not-workable').map((f) => ({
        severity: 'fail', category: 'safety',
        title: `Short circuit: ${f.kind.name.toLowerCase()}`, detail: f.why,
      })),
      ...faults.filter((f) => f.verdict === 'workable-with-costs' || f.verdict === 'unproven').map((f) => ({
        severity: 'warn', category: 'safety',
        title: `Short circuit: ${f.kind.name.toLowerCase()}`, detail: f.why,
      })),
      ...(internal.verdict === 'not-workable' ? [{
        severity: 'fail', category: 'safety',
        title: `Internal cell short: ${internal.neighbours} neighbours feed the fault`, detail: internal.why,
      }] : internal.verdict === 'workable-with-costs' ? [{
        severity: 'warn', category: 'safety',
        title: 'Internal cell short: fusible links too slow', detail: internal.why,
      }] : []),
    ],
    assumptions: [
      `Lumped R-L circuit: ${(terminal.result.cellROhm * 1000).toFixed(2)} mΩ of cells plus ${(terminal.result.fixedROhm * 1000).toFixed(2)} mΩ of busbar, contactor and fault, with ${loopInductanceUH} µH of loop inductance (the only thing making the current take time to arrive).`,
      'Adiabatic heating throughout: over a few milliseconds nothing has time to cool, which makes adiabatic correct rather than merely convenient.',
      `Busbar survival by the adiabatic rule I²t ≤ (k·A)², k = ${busbarK} A·√s/mm² for ${busbarKind.replace('-', ' ')} copper.`,
      `Thermal-runaway onset taken as ${runawayOnsetC(cell.chemistry)} °C for ${cell.chemistry} — a class value; replace it with ARC data for the actual cell (§8).`,
      i2tRating != null && fuseI2t == null
        ? `Fuse melting I²t assumed as (10 × ${ratedA} A)² × 10 ms because none was given — put your fuse's real datasheet I²t in and this number changes.`
        : 'Fuse melting I²t taken from the value supplied.',
      'No arc modelling: after the fuse element melts, arcing energy adds to the total. This model reports the melting instant, which is the earlier one.',
    ],
  };
}
