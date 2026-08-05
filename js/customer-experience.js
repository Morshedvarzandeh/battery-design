// customer-experience.js — the small promise the customer interface makes.
//
// The engineering workbench has hundreds of checks. The first recommendation
// needs a much smaller, stricter contract: it may rank only designs that meet
// the stated energy, power, voltage, mass, space and market gates. Warnings
// such as estimated commercial data remain visible, but can never outrank a
// hard miss. This module is pure so browser, desktop, API and tests use the
// same meaning of "eligible" and "suitable".

import { releaseChecklist } from './markets.js';

const finite = (v) => Number.isFinite(v) ? v : null;
const fmt = (v) => Number(v).toLocaleString('en-US', {
  maximumFractionDigits: v < 1 ? 3 : 1,
});

/**
 * Assess the non-negotiable sizing gates for either optimizer candidate
 * shape (`suggestDesigns` or `maxFill`).
 */
export function assessSizingCandidate(candidate, req = {}) {
  const cell = candidate?.cell;
  const s = finite(candidate?.s);
  const p = finite(candidate?.p);
  const summary = candidate?.summary || candidate || {};
  const energyWh = finite(summary.energyWh);
  const massKg = finite(summary.massKg);
  const nominalV = finite(summary.nominalV) ?? (cell && s ? s * cell.nominalV : null);
  const vMin = cell && s ? s * cell.vMin : null;
  const contPowerW = cell && p && vMin
    ? vMin * p * cell.maxContDischargeA : finite(summary.maxContPowerAtVMinW);
  const pulseA = cell?.maxPulseDischargeA ?? cell?.maxContDischargeA;
  const peakPowerW = cell && p && vMin && pulseA ? vMin * p * pulseA : contPowerW;
  const blockers = [];
  const conditions = [];

  if (req.vRange && nominalV != null
      && (nominalV < req.vRange[0] - 1e-9 || nominalV > req.vRange[1] + 1e-9)) {
    blockers.push(`Nominal voltage ${fmt(nominalV)} V is outside the ${req.vRange[0]}–${req.vRange[1]} V window.`);
  }
  if (req.energyWh > 0 && energyWh != null && energyWh + 1e-9 < req.energyWh) {
    blockers.push(`Installed energy ${fmt(energyWh)} Wh is below the ${fmt(req.energyWh)} Wh target.`);
  }
  if (req.contPowerW > 0 && contPowerW != null && contPowerW + 1e-9 < req.contPowerW) {
    blockers.push(`Continuous power at minimum voltage is below the ${fmt(req.contPowerW)} W requirement.`);
  }
  if (req.peakPowerW > 0 && peakPowerW != null && peakPowerW + 1e-9 < req.peakPowerW) {
    blockers.push(`Peak power at minimum voltage is below the ${fmt(req.peakPowerW)} W requirement.`);
  }
  if (req.maxMassKg > 0 && massKg != null && massKg > req.maxMassKg + 1e-9) {
    blockers.push(`Pack mass ${fmt(massKg)} kg exceeds the ${fmt(req.maxMassKg)} kg limit.`);
  }
  if (candidate?.best?.fits === false || candidate?.fits === false) {
    blockers.push('The required pack does not fit the stated space in any orientation checked.');
  }

  if (req.application && cell) {
    const rules = releaseChecklist({
      market: req.market || 'eu', application: req.application,
      chemistry: cell.chemistry, v2x: req.v2xPolicy || 'off',
    }).rules || [];
    blockers.push(...rules.filter((r) => r.scope === 'blocker').map((r) => r.title));
  }

  if (req.cyclesPerYear > 0 && req.targetYears > 0 && cell?.cycleLife != null) {
    const needed = req.cyclesPerYear * req.targetYears;
    if (cell.cycleLife < needed) {
      conditions.push(`Cell cycle rating is ${cell.cycleLife.toLocaleString()} versus about ${needed.toLocaleString()} cycles requested.`);
    }
  }
  if (req.preferredChemistries?.length && cell
      && !req.preferredChemistries.includes(cell.chemistry)) {
    conditions.push(`${cell.chemistry} is outside this application's preferred chemistry list.`);
  }
  if (cell?.inferredFields?.includes('ALL')) {
    conditions.push('The cell record is a class estimate; confirm it against a supplier datasheet before release.');
  } else if (['teardown', 'trade_press', 'composite', 'recalled'].includes(cell?.basis)) {
    conditions.push('Some cell values are not manufacturer-datasheet values and need confirmation.');
  }

  return {
    eligible: blockers.length === 0,
    status: blockers.length ? 'not-eligible' : conditions.length ? 'eligible-with-conditions' : 'eligible',
    label: blockers.length ? 'Not eligible' : conditions.length ? 'Sizing match with conditions' : 'Sizing match',
    blockers,
    conditions,
    capabilities: { nominalV, energyWh, massKg, contPowerW, peakPowerW },
  };
}

/** One customer-facing readiness vocabulary for the live design. */
export function customerReadiness(findings = [], sizingBlockers = []) {
  const fails = findings.filter((f) => f?.severity === 'fail');
  const warns = findings.filter((f) => f?.severity === 'warn');
  if (sizingBlockers.length || fails.length) {
    const first = sizingBlockers[0] || fails[0]?.title || 'A blocking engineering check remains.';
    return {
      id: 'not-yet-suitable', label: 'Not yet suitable', tone: 'fail',
      headline: first, failCount: sizingBlockers.length + fails.length, warnCount: warns.length,
    };
  }
  if (warns.length) {
    return {
      id: 'suitable-with-conditions', label: 'Suitable with conditions', tone: 'warn',
      headline: warns[0]?.title || 'Review the stated conditions before release.',
      failCount: 0, warnCount: warns.length,
    };
  }
  return {
    id: 'suitable', label: 'Suitable', tone: 'pass',
    headline: 'Nothing in the checks run so far blocks this design.', failCount: 0, warnCount: 0,
  };
}
