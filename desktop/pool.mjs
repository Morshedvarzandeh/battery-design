// pool.mjs — use the cores the machine already has.
//
// The measured cost of one complete design is well under a millisecond, so
// JavaScript is not the reason a big sweep takes time — the reason is that a
// single thread does ten thousand of them one after another. Spreading them
// over the cores is the cheapest real speedup available, and it costs no new
// language, no second implementation of the physics, and no drift between
// what the web page says and what the desktop runner says.
//
// Two honesty rules are built in:
//  · A small job runs SERIAL. Starting a worker costs tens of milliseconds;
//    paying that to parallelise twenty designs makes the tool slower while
//    looking busy. The threshold below is measured, not guessed.
//  · Results come back in the order they were asked for, whichever thread
//    happened to finish first. A parallel run and a serial run return
//    identical rows — the tests check exactly that.

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { runJobs } from './rows.mjs';

// Measured on this class of machine: a worker takes ~40 ms to start and load
// the modules, while a design takes well under 1 ms. Below a few hundred
// designs the startup cost dominates and serial wins.
export const PARALLEL_THRESHOLD = 250;

export function coreCount() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

// Round-robin, not contiguous blocks: in a sweep the work usually gets
// steadily heavier (bigger packs later), so blocks would leave the first
// threads idle while the last one finishes alone.
function deal(jobs, n) {
  const chunks = Array.from({ length: n }, () => []);
  jobs.forEach((job, i) => chunks[i % n].push(job));
  return chunks.filter((c) => c.length);
}

/**
 * Run design jobs across the available cores.
 * Returns { rows, workers, mode } — rows always in input order.
 */
export async function runPool(jobs, { jobs: requested = null, force = false } = {}) {
  const wanted = requested != null ? Math.max(1, requested) : coreCount();
  if (wanted === 1 || (!force && jobs.length < PARALLEL_THRESHOLD)) {
    return { rows: runJobs(jobs), workers: 1, mode: 'serial' };
  }
  const chunks = deal(jobs, Math.min(wanted, jobs.length));
  const url = new URL('./sweep-worker.mjs', import.meta.url);
  const results = await Promise.all(chunks.map((chunk) => new Promise((resolve, reject) => {
    const w = new Worker(url, { workerData: { jobs: chunk } });
    w.once('message', (rows) => { resolve(rows); w.terminate(); });
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited with code ${code}`)); });
  })));
  // Reassemble by the index each job carried, so the answer never depends on
  // which thread was quickest.
  const rows = new Array(jobs.length);
  for (const chunk of results) for (const row of chunk) rows[row.index] = row;
  return { rows, workers: chunks.length, mode: 'parallel' };
}
