// rows.mjs — one design reduced to one comparable row.
//
// Shared by the main process and the worker threads so a parallel run and a
// serial run produce byte-identical rows. If this lived in two places, "same
// answer whether you used one core or eight" would be a hope rather than a
// property.

import { designFromSpec } from '../js/api.js';

export function summaryRow({ variable, value, design }) {
  return {
    variable, value,
    cell: design.cell.id,
    kWh: design.pack.energyWh / 1000,
    massKg: design.pack.massKg,
    cellCount: design.pack.cellCount,
    upfrontUSD: design.cost?.upfrontUSD ?? null,
    usdPerKWhDelivered: design.cost?.usdPerKWhDelivered ?? null,
    whPerKg: design.pack.whPerKg ?? null,
    whPerKm: design.vehicle?.drive?.whPerKm ?? null,
    rangeKm: design.vehicle?.range ?? null,
    fails: design.findings.filter((f) => f.severity === 'fail').length,
    warns: design.findings.filter((f) => f.severity === 'warn').length,
  };
}

// One unit of work. A design that throws becomes a row carrying its error
// rather than killing the run — a sweep of a thousand designs must not be
// lost because one combination is impossible.
export function runJob(job) {
  try {
    return {
      index: job.index, ...job.meta,
      ...summaryRow({ variable: job.variable, value: job.value, design: designFromSpec(job.spec) }),
    };
  } catch (e) {
    return { index: job.index, ...job.meta, variable: job.variable, value: job.value, error: e.message };
  }
}

export function runJobs(jobs) {
  return jobs.map(runJob);
}
