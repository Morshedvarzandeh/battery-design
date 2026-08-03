// Pool — using the cores the machine already has.
//
// The reason this is worth testing rather than trusting: a parallel answer
// that differs from the serial one is worse than a slow answer. These check
// the two properties that make the speedup safe to rely on — identical rows,
// and input order preserved however the threads finish — plus the judgement
// that a small job should NOT be parallelised, because starting workers costs
// more than the designs it would have saved.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { runPool, coreCount, PARALLEL_THRESHOLD } from '../desktop/pool.mjs';
import { runJobs, summaryRow } from '../desktop/rows.mjs';
import { CELLS } from '../js/cells.js';
import { designFromSpec } from '../js/api.js';

// A spread of real work: different cells and different energy targets, so the
// jobs genuinely differ in cost the way a real sweep does.
const makeJobs = (n) => Array.from({ length: n }, (_, i) => ({
  index: i,
  variable: 'cell×energy',
  value: `${CELLS[i % CELLS.length].id} @ ${20 + i} kWh`,
  meta: { targetWh: (20 + i) * 1000 },
  spec: { application: 'ev', cell: CELLS[i % CELLS.length].id, energyWh: (20 + i) * 1000 },
}));

test('a small job stays on one thread on purpose', async () => {
  const r = await runPool(makeJobs(12));
  ok(r.mode === 'serial' && r.workers === 1,
    'twelve designs are not worth a worker — startup would cost more than the work');
  ok(r.rows.length === 12, 'and it still answers');
  ok(PARALLEL_THRESHOLD > 100, 'the threshold is set from measurement, not optimism');
  const forcedSerial = await runPool(makeJobs(400), { jobs: 1 });
  ok(forcedSerial.mode === 'serial', '--jobs 1 always means one thread, whatever the size');
});

test('parallel and serial return exactly the same rows', async () => {
  // The property everything else depends on: using more cores may not change
  // a single number. Forced parallel on a small job so the test stays quick.
  const jobs = makeJobs(40);
  const serial = await runPool(jobs, { jobs: 1 });
  const parallel = await runPool(jobs, { jobs: 4, force: true });
  ok(parallel.mode === 'parallel' && parallel.workers > 1, `it really did fan out (${parallel.workers} threads)`);
  ok(JSON.stringify(serial.rows) === JSON.stringify(parallel.rows),
    'row for row, byte for byte, identical to the single-threaded answer');
});

test('results come back in the order they were asked for', async () => {
  const jobs = makeJobs(40);
  const { rows } = await runPool(jobs, { jobs: 4, force: true });
  ok(rows.every((r, i) => r.index === i), 'never in whichever order the threads happened to finish');
  ok(rows.every((r, i) => r.value === jobs[i].value), 'and each row still belongs to its own job');
  ok(rows.every((r) => r.targetWh === jobs[r.index].meta.targetWh), 'job metadata survives the trip');
});

test('nonsense series/parallel counts are corrected out loud, not silently', async () => {
  // Found by this suite: -1S-1P was clamped to 1S1P and returned as if it
  // were the design asked for. The engine warns about unknown ids; it has to
  // warn about this too.
  const d = designFromSpec({ application: 'ev', s: -1, p: -1 });
  ok(d.pack.s === 1 && d.pack.p === 1, 'clamped to something buildable');
  ok(d.warnings.some((w) => /corrected to 1S1P/.test(w)), 'and it says so');
  ok(designFromSpec({ application: 'ev', s: 96, p: 4 }).warnings.length === 0,
    'a sane spec is not nagged at');
});

test('one impossible design does not lose the other nine hundred', async () => {
  const jobs = makeJobs(6);
  jobs[2] = { index: 2, variable: 'cell', value: 'broken', spec: { application: 'ev', isolationStandard: 'no-such-standard' } };
  const { rows } = await runPool(jobs, { jobs: 1 });
  ok(rows.length === 6, 'every job still reports');
  ok(rows[2].error && typeof rows[2].error === 'string', 'the failure is carried as a row, not thrown away');
  ok(rows.filter((r) => !r.error).length === 5, 'and the rest are unaffected');
  // Same behaviour across threads.
  const par = await runPool(makeJobs(40).map((j, i) => i === 7
    ? { index: 7, variable: 'cell', value: 'broken', spec: { application: 'ev', isolationStandard: 'no-such-standard' } } : j),
  { jobs: 4, force: true });
  ok(par.rows[7].error && par.rows.filter((r) => !r.error).length === 39,
    'a worker that meets an impossible design reports it and carries on');
});

test('the row is the same shape whoever built it', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const row = summaryRow({ variable: 'cell', value: 'x', design: d });
  for (const k of ['cell', 'kWh', 'massKg', 'cellCount', 'usdPerKWhDelivered', 'fails', 'warns']) {
    ok(k in row, `the row carries ${k}`);
  }
  ok(runJobs([{ index: 0, variable: 'v', value: 'x', spec: { application: 'ebike' } }])[0].kWh > 0,
    'runJobs is the same path the workers use');
  ok(coreCount() >= 1, 'the core count is known');
});
