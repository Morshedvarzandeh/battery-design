// @ts-check
// simulation-worker.js — browser-only execution shell for the pure engines.
// It deliberately owns no model logic; simulation-jobs.js is also exercised
// under Node so a worker can never become an untested second implementation.

import { runSimulationJob } from './simulation-jobs.js';

globalThis.addEventListener('message', (event) => {
  const request = event.data;
  try {
    const result = runSimulationJob(request.job);
    globalThis.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    globalThis.postMessage({
      id: request?.id ?? -1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
