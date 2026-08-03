// wiring.js — is every conductor big enough for what it carries?
//
// The connection graph knows each run's material, length, section and current.
// This asks the question that follows: does it survive that current, and what
// does it cost in voltage and heat if it does?
//
// Two ways to answer, and the tool uses both because they fail differently:
//
//   CURRENT DENSITY is the rule of thumb every engineer carries — around
//   5 A/mm² for copper in free air. Fast, and wrong at the extremes: it takes
//   no account of length, of how well the run can shed heat, or of whether it
//   is buried in a loom at 60 °C.
//
//   TEMPERATURE RISE is the real question. A conductor heats until what it
//   loses to its surroundings equals I²R. Solve that balance and you get the
//   number that actually matters: how hot this piece of metal gets. It is the
//   answer that catches the classic cylindrical-pack failure — nickel strip
//   sized by habit, running at 90 °C beside cells rated to 60.
//
// Both are reported. Where they disagree the temperature answer wins, and the
// tool says which rule flagged it, because an engineer who is used to the rule
// of thumb deserves to know why the tool disagrees with them. On a real EV
// pack they disagree in BOTH directions, which is the point: a 20 mm nickel
// interconnect at 5 A/mm² is fine, and a 1.25 m copper busbar at 4 A/mm² —
// comfortably inside the rule — reaches 86 °C.
//
// Pure math, no DOM.

import { materialById, resistivityAt } from './materials.js';

// How a run sheds heat. This is a design fact, not a constant, so it is an
// input — the same busbar in still air and in a potted module are different
// problems, and pretending otherwise is how conductors get undersized.
export const INSTALLATIONS = {
  'free-air': { hWm2K: 12, name: 'Free air', what: 'Open busbar with air moving around it. The best case, and the one datasheet ampacity tables assume.' },
  bundled: { hWm2K: 7, name: 'Bundled / loomed', what: 'Cables tied together or in a conduit: each one heats its neighbours, so all of them derate.' },
  potted: { hWm2K: 4, name: 'Potted or enclosed', what: 'Encapsulated or inside a sealed housing with no airflow. Heat leaves only by conduction into whatever surrounds it.' },
  'plate-bonded': { hWm2K: 45, name: 'Bonded to a cold plate', what: 'In thermal contact with the cooling system. The best case there is, and worth designing for on the runs that carry the most.' },
};

// The rule-of-thumb densities, kept so the tool can say when it disagrees
// with them. A/mm², free air, moderate temperature rise.
export const RULE_OF_THUMB_ADENSITY = { copper: 5, aluminium: 3.5, nickel: 2.5, 'nickel-plated-copper': 5, tin: 2.5 };

/**
 * Steady-state temperature rise of a run.
 *
 * The balance is I²·R = h·A·ΔT: the heat made equals the heat shed. But R
 * itself rises as the conductor warms, so the two sides chase each other and
 * solving once at 20 °C understates exactly the runs that matter.
 *
 * Writing ρ(T) = ρ₂₀·(1 + α(T−20)) into the balance gives a fixed point that
 * closes in one line rather than needing iteration:
 *
 *     T = (ambient + k(1 − 20α)) / (1 − kα),    k = I²·ρ₂₀·L / (A·G)
 *
 * where G is the total conductance out. That form is worth having for its
 * DENOMINATOR: when k·α reaches 1, the extra heat from the extra resistance
 * exactly pays for itself and there is no temperature at which the run
 * settles. So thermal runaway in a conductor is not a number the model gives
 * up at — it is a condition the model can state exactly.
 */
export function temperatureRise({ materialId, lengthMm, areaMm2, currentA, ambientC = 25, installation = 'free-air' }) {
  const inst = INSTALLATIONS[installation] || INSTALLATIONS['free-air'];
  if (!(areaMm2 > 0) || !(lengthMm > 0) || !(currentA > 0)) return null;
  const lengthM = lengthMm / 1000;
  // Surface area of a run, treated as a square section: perimeter × length.
  const sideMm = Math.sqrt(areaMm2);
  const surfaceM2 = (4 * sideMm / 1000) * lengthM;
  // A short run does not cool itself by convection — it conducts its heat out
  // through both ends into whatever it is bolted or welded to. For a 20 mm
  // busbar that path is hundreds of times the convective one, and a model
  // that ignores it returns temperatures in the thousands. Both paths are
  // included, in parallel, as conductances in W/K.
  const mat = materialById(materialId);
  const convectiveWK = inst.hWm2K * surfaceM2;
  const endConductionWK = mat?.thermalWmK
    ? (4 * mat.thermalWmK * areaMm2 * 1e-6) / lengthM   // both ends, half-length each
    : 0;
  const totalWK = convectiveWK + endConductionWK;
  if (!(totalWK > 0) || !mat) return null;

  const alpha = mat.tempCoPerK;
  // k is the rise this run would reach if its resistance never changed.
  const k = (currentA * currentA * mat.resistivityOhmM * lengthM) / (areaMm2 * 1e-6 * totalWK);
  // k·α is the gain of the resistance-heat feedback loop. At or above 1 there
  // is no steady state — the run is not undersized by a margin, it is the
  // wrong size entirely, and no temperature can be quoted for it.
  const stable = k * alpha < 1;
  const tempC = stable ? (ambientC + k * (1 - 20 * alpha)) / (1 - k * alpha) : Infinity;
  const rOhm = stable
    ? (resistivityAt(materialId, tempC) * lengthM) / (areaMm2 * 1e-6)
    : Infinity;
  return {
    tempC, riseK: tempC - ambientC, resistanceOhm: rOhm,
    heatW: stable ? currentA * currentA * rOhm : Infinity,
    dropV: stable ? currentA * rOhm : Infinity,
    surfaceM2, installation: inst.name, stable, loopGain: k * alpha,
    conductanceWK: { convective: convectiveWK, endConduction: endConductionWK, total: totalWK },
  };
}

/**
 * How much section this run actually needs to stay inside the limit.
 *
 * Not a closed-form answer: the two cooling paths scale differently with area
 * — convection with its square root, end conduction with the area itself —
 * so doubling the section does not halve anything cleanly. Rather than fit a
 * formula to that, the same heat balance is solved again at trial sections
 * until one passes. It is a handful of arithmetic and it cannot drift from
 * the model it is answering for.
 *
 * Returns null when the run already passes, or when even 20× the section
 * cannot get there — at which point the answer is not a bigger bar.
 */
export function requiredAreaMm2(run, { ambientC = 25, installation = 'free-air', maxTempC = 90 } = {}) {
  const base = { materialId: run.materialId, lengthMm: run.lengthMm, currentA: run.carriesA, ambientC, installation };
  const at = (areaMm2) => temperatureRise({ ...base, areaMm2 })?.tempC ?? Infinity;
  if (at(run.areaMm2) <= maxTempC) return null;
  let lo = run.areaMm2, hi = run.areaMm2 * 2;
  for (let i = 0; i < 8 && at(hi) > maxTempC; i++) { lo = hi; hi *= 2; }
  if (at(hi) > maxTempC) return null;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > maxTempC) lo = mid; else hi = mid;
  }
  return hi;
}

/**
 * Assess one run. `maxTempC` is what the surroundings tolerate — next to
 * cells that is the cell's own rating, not the copper's melting point.
 */
export function assessRun(run, { ambientC = 25, installation = 'free-air', maxTempC = 90, packV = null, dropLimitPct = 2 } = {}) {
  const currentA = run.carriesA;
  if (!(currentA > 0)) return null;
  const thermal = temperatureRise({
    materialId: run.materialId, lengthMm: run.lengthMm, areaMm2: run.areaMm2,
    currentA, ambientC, installation,
  });
  if (!thermal) return null;
  const density = currentA / run.areaMm2;
  const ruleLimit = RULE_OF_THUMB_ADENSITY[run.materialId] ?? 4;
  const overRule = density > ruleLimit;
  const overTemp = thermal.tempC > maxTempC;
  const dropPct = packV > 0 ? (thermal.dropV / packV) * 100 : null;
  // A verdict reached from a guessed length is still a verdict, but the
  // customer is owed the difference between "your busbar is too small" and
  // "a busbar this long would be too small, and we guessed the length".
  const fromEstimate = run.estimated
    ? ` This run's ${run.lengthMm.toFixed(0)} mm length is estimated from the pack envelope, not measured — give the real length and this answer sharpens or goes away.`
    : '';
  const common = {
    runId: run.id, materialId: run.materialId, currentA, areaMm2: run.areaMm2,
    lengthMm: run.lengthMm, estimated: !!run.estimated, inSeriesPath: run.inSeriesPath !== false,
    densityAmm2: density, ruleLimit, overRule, thermal, dropPct,
  };

  if (!thermal.stable) {
    return {
      ...common,
      verdict: 'not-workable', needAreaMm2: null,
      why: `No steady state at ${currentA.toFixed(0)} A through ${run.areaMm2.toFixed(1)} mm² `
        + `(${density.toFixed(1)} A/mm²): the heat it makes raises its resistance faster than it can shed it, `
        + `so the temperature runs away rather than settling. This conductor is not undersized by a margin — `
        + `it is the wrong size entirely.${fromEstimate}`,
    };
  }

  let verdict = 'workable', why, needAreaMm2 = null;
  if (overTemp) {
    verdict = thermal.tempC > maxTempC * 1.3 ? 'not-workable' : 'workable-with-costs';
    needAreaMm2 = requiredAreaMm2(run, { ambientC, installation, maxTempC });
    const fix = needAreaMm2
      ? `It needs about ${needAreaMm2.toFixed(0)} mm² to hold ${maxTempC} °C`
      : `No practical section fixes this on its own`;
    why = `Reaches ${thermal.tempC.toFixed(0)} °C against a ${maxTempC} °C limit, carrying ${currentA.toFixed(0)} A `
      + `through ${run.areaMm2.toFixed(1)} mm² (${density.toFixed(1)} A/mm²) over ${run.lengthMm.toFixed(0)} mm. `
      + `${fix} — or a shorter route, better cooling, or less current through this path.${fromEstimate}`;
  } else if (overRule) {
    // The interesting case: hot by the rule of thumb, fine by the physics.
    why = `${density.toFixed(1)} A/mm² is above the ${ruleLimit} A/mm² rule of thumb, but at ${run.lengthMm.toFixed(0)} mm `
      + `${(INSTALLATIONS[installation]?.name || 'installed').toLowerCase()} it settles at ${thermal.tempC.toFixed(0)} °C — inside the ${maxTempC} °C limit. `
      + `The rule of thumb assumes a long run in free air; this one is short enough to shed the heat.`;
  } else if (thermal.riseK > 0.85 * (maxTempC - ambientC)) {
    // Inside the limit is not the same as safe in it. A run at 96% of what its
    // surroundings tolerate passes today and fails on a warm day, and calling
    // that "comfortable" is how margin disappears without anyone deciding to
    // spend it.
    why = `${density.toFixed(1)} A/mm², reaching ${thermal.tempC.toFixed(0)} °C — inside the ${maxTempC} °C limit, but only just. `
      + `There is ${(maxTempC - thermal.tempC).toFixed(0)} °C of margin left, so a warmer day or a hotter neighbour takes it over.`;
  } else {
    why = `${density.toFixed(1)} A/mm², reaching ${thermal.tempC.toFixed(0)} °C against a ${maxTempC} °C limit — comfortable on both the rule of thumb and the heat balance.`;
  }
  if (dropPct != null && dropPct > dropLimitPct && verdict === 'workable') {
    verdict = 'workable-with-costs';
    why += ` It also drops ${thermal.dropV.toFixed(2)} V on its own, which is ${dropPct.toFixed(1)}% of pack voltage against a ${dropLimitPct}% budget for the whole path.`;
  }
  return { ...common, verdict, needAreaMm2, why };
}

// Ten module busbars that are the same metal, the same section and the same
// length are one problem, not ten. Grouping on those three is what turns a
// wall of findings into the two sentences an engineer can act on.
const shapeKey = (r) => `${r.materialId}|${r.areaMm2.toFixed(1)}|${r.lengthMm.toFixed(0)}`;

function groupRuns(runs) {
  const byShape = new Map();
  for (const r of runs) {
    const k = shapeKey(r);
    const g = byShape.get(k) || { key: k, count: 0, runs: [], worst: r };
    g.count += 1; g.runs.push(r);
    if (r.thermal.tempC > g.worst.thermal.tempC) g.worst = r;
    byShape.set(k, g);
  }
  return [...byShape.values()].sort((a, b) => b.worst.thermal.tempC - a.worst.thermal.tempC);
}

/**
 * The whole wiring study over a topology.
 *
 * Two totals, and they are not the same number. HEAT sums every run, because
 * every run that carries current genuinely makes its own heat. VOLTAGE DROP
 * sums only the runs the topology marks as being in series along the pack's
 * current path — adding a module's terminal tap to the pack total would count
 * the same volts once per module.
 */
export function wiringStudy({ topology, packV = null, ambientC = 25, installation = 'free-air', maxTempC = 90, dropLimitPct = 2 }) {
  if (!topology) return null;
  const runs = topology.edges
    .map((e) => assessRun(e, { ambientC, installation, maxTempC, packV, dropLimitPct }))
    .filter(Boolean);
  const worst = runs.slice().sort((a, b) => b.thermal.tempC - a.thermal.tempC)[0] || null;
  const failing = runs.filter((r) => r.verdict === 'not-workable');
  const costly = runs.filter((r) => r.verdict === 'workable-with-costs');
  // A run with no steady state has no temperature, no drop and no heat to
  // add — quoting one would be inventing it. The totals are over the runs
  // that settle, and the count of those that do not is reported beside them
  // so the sums are never mistaken for the whole picture.
  const settled = runs.filter((r) => r.thermal.stable);
  const runaway = runs.length - settled.length;
  const seriesDropV = settled.filter((r) => r.inSeriesPath).reduce((s, r) => s + r.thermal.dropV, 0);
  const totalHeatW = settled.reduce((s, r) => s + r.thermal.heatW, 0);
  const dropPct = packV > 0 ? (seriesDropV / packV) * 100 : null;
  const hottest = settled.slice().sort((a, b) => b.thermal.tempC - a.thermal.tempC)[0] || null;
  const overBudget = dropPct != null && dropPct > dropLimitPct;
  const verdict = failing.length ? 'not-workable' : (costly.length || overBudget) ? 'workable-with-costs' : 'workable';

  const inst = INSTALLATIONS[installation] || INSTALLATIONS['free-air'];
  const findings = [];
  for (const g of groupRuns(failing)) {
    const r = g.worst;
    findings.push({
      severity: 'fail', category: 'electrical',
      title: g.count > 1
        ? `${g.count} conductors of ${r.areaMm2.toFixed(0)} mm² ${materialById(r.materialId)?.name || r.materialId} are undersized`
        : `Conductor ${r.runId} is undersized`,
      detail: g.count > 1 ? `${g.count} runs share this problem — ${g.runs.map((x) => x.runId).slice(0, 6).join(', ')}${g.count > 6 ? '…' : ''}. ${r.why}` : r.why,
    });
  }
  for (const g of groupRuns(costly).slice(0, 3)) {
    const r = g.worst;
    findings.push({
      severity: 'warn', category: 'electrical',
      title: g.count > 1 ? `${g.count} conductors run hot or drop voltage` : `Conductor ${r.runId} runs hot or drops voltage`,
      detail: r.why,
    });
  }
  if (overBudget) {
    findings.push({
      severity: 'warn', category: 'electrical',
      title: `The current path drops ${dropPct.toFixed(1)}% of pack voltage`,
      detail: `${seriesDropV.toFixed(2)} V is lost in the conductors between the cells and the pack terminals, against a ${dropLimitPct}% budget. `
        + `That is ${totalHeatW.toFixed(0)} W turned into heat inside the enclosure at continuous current, and range or runtime the machine never sees.`,
    });
  }
  if (runs.some((r) => r.estimated)) {
    findings.push({
      severity: 'info', category: 'electrical',
      title: 'Some run lengths are estimated, not measured',
      detail: 'Lengths were taken from the pack envelope because the real routing is not known yet. They are the one input that moves every number here — resistance, heat, drop and mass all scale with length — so measuring them on the layout is the cheapest accuracy available.',
    });
  }

  return {
    runs, worst, verdict, groups: groupRuns(runs),
    totals: {
      runsChecked: runs.length, failing: failing.length, costly: costly.length, runaway,
      seriesDropV, totalHeatW, dropPct, dropLimitPct,
      hottestC: hottest?.thermal.tempC ?? null,
      conductorMassKg: topology.totals?.conductorMassKg ?? null,
    },
    headline: runaway
      ? `${runaway} of ${runs.length} conductors have no steady state at this current — they heat until something gives, so there is no temperature to quote for them. `
        + `Of the rest, the hottest reaches ${hottest ? `${hottest.thermal.tempC.toFixed(0)} °C` : 'no measured temperature'}.`
      : hottest
        ? `The hottest conductor reaches ${hottest.thermal.tempC.toFixed(0)} °C; the current path drops ${seriesDropV.toFixed(2)} V and the wiring turns ${totalHeatW.toFixed(0)} W into heat at continuous current.`
        : 'No current-carrying runs to check.',
    findings,
    assumptions: [
      `Steady-state heat balance I²R = h·A·ΔT with h = ${inst.hWm2K} W/(m²·K) for ${inst.name.toLowerCase()}, in parallel with conduction out through both ends, and resistance iterated as the conductor warms.`,
      'Conductor section treated as square, which is the worst case for cooling: a square has the least surface of any shape at a given area, so a flat busbar of the same section runs cooler than this says.',
      'Radiation is not counted. Above about 80 °C a dark or oxidised surface sheds a useful further fraction, so hot runs have a little more margin than shown.',
      `The ${maxTempC} °C limit is what the SURROUNDINGS tolerate, not what the metal can survive: next to cells it should be the cell's own rating.`,
      'Steady state only: a short overload can be survived that this would refuse, and the fault study covers the millisecond end.',
    ],
  };
}
