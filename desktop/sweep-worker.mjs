// sweep-worker.mjs — a worker thread that designs its share of the packs.
//
// Each worker loads the same modules the main process does and returns plain
// rows. Nothing is shared between threads but the job list and the results,
// so there is no locking to get wrong and no state to corrupt.

import { parentPort, workerData } from 'node:worker_threads';
import { runJobs } from './rows.mjs';

parentPort.postMessage(runJobs(workerData.jobs));
