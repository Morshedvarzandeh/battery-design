// lca.js — the whole footprint, and an honest account of how well it is known.
//
// The tool already had half of this: a manufacturing figure per kWh and a CO₂
// payback point. What it did not have was the OTHER phases, or any statement
// of how much each one is worth trusting — and a footprint quoted to four
// figures with no error bar is the most misleading number a tool can produce.
//
// Four phases, and they are not equally knowable:
//
//   MATERIALS      The cells, and everything bolted to them. The cells are
//                  the answer — on a 60 kWh pack they are about 98% of the
//                  embodied footprint and the conductors are a rounding
//                  error. Worth knowing before anyone spends a month
//                  optimising busbar mass for carbon reasons.
//   ASSEMBLY       Genuinely unknown. It depends on the factory, its grid and
//                  its yield, and nobody publishes it per pack. Stated as
//                  unknown rather than invented.
//   USE            What the pack costs to run and what it displaces. This is
//                  where the sign of the answer is decided, and where the
//                  usual model is quietly wrong — see below.
//   END OF LIFE    Recycling returns some of the material footprint. How much
//                  is a policy and process question, so it is a range.
//
// THE PART MOST TOOLS GET WRONG. "Avoided emissions" assumes the energy the
// pack delivers displaces grid generation. That is right for a machine that
// would otherwise draw from the grid. It is WRONG for an electric vehicle,
// which displaces petrol, not generation — and it is wrong in the other
// direction for stationary storage, which CONSUMES grid energy and only comes
// out ahead if it shifts clean generation into a dirty hour. This module picks
// the basis from what the machine is, says which one it used, and refuses to
// present a displacement number when the honest answer depends on something
// the customer has not told it.
//
// NOT AN LCA IN THE ISO SENSE. A declared footprint under ISO 14040/14044 or
// the EU Battery Regulation is an audited study with supplier-specific data.
// This is a screening estimate: enough to know which decisions matter and
// roughly where you will land, not enough to declare. It says so everywhere.
//
// Pure math, no DOM.

import { materialById } from './materials.js';
import { materialBreakdown } from './topology.js';
import { CO2_MFG_PER_KWH } from './report.js';
import { appClassOf } from './markets.js';

// How the delivered energy should be compared, by what the machine is. The
// basis changes the answer's SIGN for some applications, so it is chosen
// explicitly rather than defaulted to "grid" for everything.
export const DISPLACEMENT_BASIS = {
  vehicle: {
    id: 'fuel', name: 'The fuel it replaces',
    what: 'An electric vehicle displaces petrol or diesel, not grid generation. Comparing its energy against a grid factor answers a question nobody asked.',
    needs: 'What the vehicle replaces, and its consumption — a 6 L/100 km petrol car is about 140 g CO₂e/km at the tailpipe, before fuel production.',
  },
  grid: {
    id: 'grid', name: 'Grid generation it displaces',
    what: 'A machine that would otherwise draw from the grid at the moment of use. The grid factor is the right comparison here.',
    needs: 'The grid factor where and when the machine runs.',
  },
  shifting: {
    id: 'shifting', name: 'The difference between two hours of grid',
    what: 'Stationary storage does not generate. It CONSUMES energy — round-trip losses and all — and only comes out ahead if it moves clean generation into a dirty hour. Charged from a dirty grid and discharged into the same one, it is a net emitter.',
    needs: 'The grid factor when it charges AND when it discharges. The difference between them is the whole answer.',
  },
};

export function basisFor(applicationId) {
  const cls = appClassOf(applicationId);
  if (cls === 'vehicle' || cls === 'lmt' || cls === 'marine') return DISPLACEMENT_BASIS.vehicle;
  if (cls === 'stationary' || cls === 'grid' || cls === 'auxiliary') return DISPLACEMENT_BASIS.shifting;
  return DISPLACEMENT_BASIS.grid;
}

// What recycling returns, as a fraction of the material's embodied footprint.
// A range, because it is set by process and policy rather than by physics —
// the EU Battery Regulation's recovery targets are one end of it.
export const RECOVERY = {
  cells: { low: 0.20, high: 0.50, what: 'Hydrometallurgical recovery of nickel, cobalt, copper and lithium. The metals come back; the cell manufacturing energy does not.' },
  conductor: { low: 0.60, high: 0.90, what: 'Copper and aluminium are recycled at high rates and low energy — this is the part of the pack that genuinely comes back.' },
  structural: { low: 0.50, high: 0.85, what: 'Steel and aluminium housings recycle well where they can be separated from the cells.' },
  plating: { low: 0, high: 0.20, what: 'Thin platings are usually lost in the recycling of what they coat.' },
};

const quality = (label, why) => ({ label, why });

/**
 * The whole life-cycle footprint of one design.
 *
 * Every phase carries its own data quality, because they differ by more than
 * an order of magnitude in how well they are known, and an unqualified total
 * hides that completely.
 */
export function lifeCycle({
  pack, cell, topology = null, application = null,
  gridGPerKWh = null, chargeGPerKWh = null,
  cyclesPerYear = null, targetYears = null, dod = 0.8,
  roundTripEff = 0.92, enclosureMaterial = 'aluminium-housing',
}) {
  if (!pack?.energyWh || !cell) return null;
  const capacityKWh = pack.energyWh / 1000;
  const phases = [];

  // --- Materials -----------------------------------------------------------
  // Cells first, and they are almost the whole answer. The per-kWh factors are
  // chemistry-class literature values with a wide real spread, so the range is
  // carried rather than collapsed to the midpoint.
  const cellFactor = CO2_MFG_PER_KWH[cell.chemistry] ?? 80;
  const cellsKg = capacityKWh * cellFactor;
  phases.push({
    id: 'cells', phase: 'materials', name: 'Cells',
    kgCO2e: cellsKg, lowKg: capacityKWh * cellFactor * 0.6, highKg: capacityKWh * cellFactor * 1.5,
    basis: `${cellFactor} kg CO₂e/kWh for ${cell.chemistry}, × ${capacityKWh.toFixed(1)} kWh`,
    quality: quality('literature-class', 'Varies by factory, grid and year by more than the difference between chemistries. Good for comparing options, not for declaring a number.'),
  });

  const conductors = topology ? materialBreakdown(topology) : [];
  const conductorKg = conductors.reduce((s, m) => s + (m.co2Kg || 0), 0);
  if (conductors.length) {
    phases.push({
      id: 'conductors', phase: 'materials', name: 'Conductors',
      kgCO2e: conductorKg, lowKg: conductorKg * 0.5, highKg: conductorKg * 2,
      basis: conductors.map((m) => `${m.massKg.toFixed(1)} kg ${m.name}`).join(', '),
      quality: quality('material-class', 'Primary versus recycled metal spans several times this, and the route is rarely known at design time.'),
    });
  }

  const enclosureKg = pack.enclosureKg || 0;
  const encMat = materialById(enclosureMaterial);
  const enclosureCO2 = encMat ? enclosureKg * encMat.co2PerKg : 0;
  if (enclosureCO2 > 0) {
    phases.push({
      id: 'enclosure', phase: 'materials', name: 'Enclosure',
      kgCO2e: enclosureCO2, lowKg: enclosureCO2 * 0.4, highKg: enclosureCO2 * 1.8,
      basis: `${enclosureKg.toFixed(1)} kg ${encMat.name}`,
      quality: quality('material-class', 'Recycled aluminium is a fraction of primary. Which one you buy moves this more than the design does.'),
    });
  }

  // --- Assembly ------------------------------------------------------------
  // Not estimated. Nobody publishes it per pack, and a plausible-looking
  // invented number would be indistinguishable from the ones above.
  phases.push({
    id: 'assembly', phase: 'assembly', name: 'Pack assembly',
    kgCO2e: null, lowKg: null, highKg: null,
    basis: 'Not estimated — it depends on your factory, its grid and its yield.',
    quality: quality('unknown', 'Usually small beside the cells, but "usually small" is not a number. Your plant can measure it; no library value can stand in for that.'),
  });

  // --- Use -----------------------------------------------------------------
  const perCycleKWh = (pack.energyWh * dod) / 1000;
  const cycleLife = cell.cycleLife ?? null;
  const deliveredKWh = cycleLife != null ? cycleLife * perCycleKWh : null;
  // The pack loses energy every round trip, and that loss is charged at
  // whatever it charges from. This is a real emission the payback model
  // never counted.
  const lossKWh = deliveredKWh != null ? deliveredKWh * (1 / roundTripEff - 1) : null;
  const chargeG = chargeGPerKWh ?? gridGPerKWh;
  const lossKg = lossKWh != null && chargeG != null ? (lossKWh * chargeG) / 1000 : null;
  phases.push({
    id: 'losses', phase: 'use', name: 'Round-trip losses over life',
    kgCO2e: lossKg, lowKg: lossKg, highKg: lossKg,
    basis: lossKWh != null
      ? `${lossKWh.toFixed(0)} kWh lost at ${(roundTripEff * 100).toFixed(0)}% round-trip${chargeG != null ? `, charged at ${chargeG} g/kWh` : ' — no charging grid factor given'}`
      : 'Needs a cycle life to know how much energy passes through the pack.',
    quality: quality('derived', 'Follows from the efficiency and the energy delivered. Solid once both are known.'),
  });

  // --- End of life ---------------------------------------------------------
  // A credit, not a cost, and a range because it is set by policy.
  const recoverable = [
    { kg: cellsKg, r: RECOVERY.cells },
    { kg: conductorKg, r: RECOVERY.conductor },
    { kg: enclosureCO2, r: RECOVERY.structural },
  ].filter((x) => x.kg > 0);
  const eolLow = -recoverable.reduce((s, x) => s + x.kg * x.r.low, 0);
  const eolHigh = -recoverable.reduce((s, x) => s + x.kg * x.r.high, 0);
  phases.push({
    id: 'eol', phase: 'end-of-life', name: 'Recycling recovery',
    kgCO2e: (eolLow + eolHigh) / 2, lowKg: eolHigh, highKg: eolLow,   // more negative is better
    basis: `${(RECOVERY.cells.low * 100).toFixed(0)}–${(RECOVERY.cells.high * 100).toFixed(0)}% of the cell material footprint and ${(RECOVERY.conductor.low * 100).toFixed(0)}–${(RECOVERY.conductor.high * 100).toFixed(0)}% of the conductors returned`,
    quality: quality('policy-dependent', 'A credit only if the pack actually reaches a recycler. The metals come back; the energy that turned them into cells does not.'),
  });

  // --- Totals --------------------------------------------------------------
  const known = phases.filter((p) => p.kgCO2e != null);
  const cradleToGate = phases
    .filter((p) => p.phase === 'materials' && p.kgCO2e != null)
    .reduce((s, p) => s + p.kgCO2e, 0);
  const totalKg = known.reduce((s, p) => s + p.kgCO2e, 0);
  const lowKg = known.reduce((s, p) => s + (p.lowKg ?? p.kgCO2e), 0);
  const highKg = known.reduce((s, p) => s + (p.highKg ?? p.kgCO2e), 0);
  const gateLowKg = phases.filter((p) => p.phase === 'materials' && p.lowKg != null).reduce((s, p) => s + p.lowKg, 0);
  const gateHighKg = phases.filter((p) => p.phase === 'materials' && p.highKg != null).reduce((s, p) => s + p.highKg, 0);
  const unknownPhases = phases.filter((p) => p.kgCO2e == null).map((p) => p.name);

  // Share of the embodied footprint, which is the number that tells you where
  // design effort is worth spending.
  for (const p of phases) {
    p.shareOfMaterials = p.phase === 'materials' && cradleToGate > 0 && p.kgCO2e != null
      ? p.kgCO2e / cradleToGate : null;
  }

  const basis = basisFor(application);
  const findings = [];

  const cellShare = cradleToGate > 0 ? cellsKg / cradleToGate : null;
  if (cellShare != null) {
    findings.push({
      severity: 'info', category: 'economics',
      title: `The cells are ${(cellShare * 100).toFixed(0)}% of the embodied footprint`,
      detail: `${cellsKg.toFixed(0)} kg CO₂e of ${cradleToGate.toFixed(0)} kg before the pack has delivered anything. `
        + `Everything else you can change — busbar material, enclosure, plating — shares the remaining ${(100 - cellShare * 100).toFixed(0)}%. `
        + `Chemistry and cell count move this; conductor optimisation does not, and it is worth knowing that before spending a month on it.`,
    });
  }
  // The correction that matters most: say when the displacement question has
  // been answered with the wrong comparison.
  findings.push({
    severity: basis.id === 'grid' ? 'info' : 'warn', category: 'economics',
    title: `Compare the delivered energy against ${basis.name.toLowerCase()}`,
    detail: `${basis.what} ${basis.needs}`
      + (basis.id !== 'grid'
        ? ' The CO₂ payback figure elsewhere in the tool uses a grid factor, which is the wrong comparison for this machine — treat it as a placeholder until you supply the right one.'
        : ''),
  });
  if (cell.cycleLife == null) {
    findings.push({
      severity: 'warn', category: 'economics',
      title: 'No cycle life, so nothing can be amortised',
      detail: 'Without a cycle life there is no delivered energy to spread the embodied footprint over, and the per-kWh figure — the only one that compares designs fairly — cannot be computed at all.',
    });
  }

  return {
    capacityKWh, basis,
    phases,
    totals: {
      cradleToGateKg: cradleToGate, gateLowKg, gateHighKg,
      totalKg, lowKg, highKg,
      kgPerKWhCapacity: capacityKWh > 0 ? cradleToGate / capacityKWh : null,
      gPerKWhDelivered: deliveredKWh > 0 ? (totalKg / deliveredKWh) * 1000 : null,
      deliveredKWh, unknownPhases,
    },
    headline: `About ${cradleToGate.toFixed(0)} kg CO₂e to build this pack — ${gateLowKg.toFixed(0)}–${gateHighKg.toFixed(0)} kg on the spread of the underlying factors — `
      + `of which the cells are ${cellShare != null ? `${(cellShare * 100).toFixed(0)}%` : 'most'}. `
      + (deliveredKWh > 0
        ? `Over a life of ${deliveredKWh.toFixed(0)} kWh delivered, and counting round-trip losses and recycling recovery, that works out at ${((totalKg / deliveredKWh) * 1000).toFixed(0)} g CO₂e per kWh through the pack.`
        : 'Without a cycle life there is no delivered energy to spread it over.'),
    findings,
    assumptions: [
      'A SCREENING estimate, not a declaration. A footprint declared under ISO 14040/14044 or the EU Battery Regulation is an audited study built on supplier-specific data — this is enough to see which decisions matter and roughly where you will land, and not enough to put on a document.',
      `Cell manufacturing at ${cellFactor} kg CO₂e/kWh for ${cell.chemistry}, carried as a 0.6–1.5× range because factory, grid and year move it more than chemistry does.`,
      'Pack assembly is NOT estimated. It is usually small beside the cells, but "usually small" is not a number, and inventing one would make it indistinguishable from the figures that are grounded.',
      'Recycling is a credit only if the pack reaches a recycler. The metals come back; the energy that turned them into cells does not.',
      'Transport, capital equipment and the balance of plant around the pack are outside this boundary entirely.',
    ],
  };
}
