// @ts-check
// simulation-jobs.js — one dispatch boundary shared by browser workers and
// deterministic Node tests. The physics remains in sim1d.js / sim2.js; this
// module only defines the serialisable messages that are allowed to cross a
// worker boundary.

import { compareCells, simulateMission } from './sim1d.js';
import { simulate as simulateAdvanced } from './sim2.js';

/**
 * Execute one simulation job. Keeping this pure makes worker and main-thread
 * results directly comparable and prevents a second copy of the model from
 * drifting away from the validated engine.
 *
 * @param {import('../types/core.ts').SimulationJob} job
 */
export function runSimulationJob(job) {
  if (!job || typeof job !== 'object') throw new TypeError('A simulation job is required.');
  if (job.kind === 'mission') {
    return {
      mission: simulateMission(job.input),
      comparison: job.compareInput ? compareCells(job.compareInput) : null,
    };
  }
  if (job.kind === 'advanced') return simulateAdvanced(job.input);
  throw new TypeError('Unknown simulation job kind.');
}
