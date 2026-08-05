// @ts-check
// simulation-client.js — latest-request-wins browser worker controller.
// Small calculations stay synchronous because worker startup would cost more
// than the calculation. Long profiles leave the UI thread, and changing an
// input terminates stale work immediately instead of queuing obsolete runs.

export const BROWSER_WORKER_THRESHOLD = 20_000;

/** @param {import('../types/core.ts').MissionInput} input */
export function estimateMissionSteps(input) {
  const profileSteps = input?.profile?.p?.length || 0;
  const passes = Math.max(1, Math.floor(input?.passes ?? 1));
  const charge = input?.charge;
  const chargeSteps = charge?.mode && charge.mode !== 'none' && charge.powerW > 0
    ? Math.max(1, Math.round(((charge.minutes ?? 15) * 60) / Math.max(0.001, input.profile?.dtS ?? 1)))
    : 0;
  const perPassCharge = charge?.mode === 'topup' ? chargeSteps : 0;
  const baseCharge = charge?.mode === 'base' ? chargeSteps : 0;
  return passes * (profileSteps + perPassCharge) + baseCharge;
}

/**
 * @param {import('../types/core.ts').MissionInput} input
 * @param {number} [comparisonCount]
 * @param {number} [threshold]
 */
export function shouldUseSimulationWorker(
  input,
  comparisonCount = 0,
  threshold = BROWSER_WORKER_THRESHOLD,
) {
  return estimateMissionSteps(input) * Math.max(1, comparisonCount + 1) >= threshold;
}

export class SimulationWorkerClient {
  /**
   * @param {{ WorkerCtor?: typeof Worker | null, workerUrl?: URL }} [options]
   */
  constructor(options = {}) {
    this.WorkerCtor = options.WorkerCtor === undefined ? globalThis.Worker : options.WorkerCtor;
    this.workerUrl = options.workerUrl ?? new URL('./simulation-worker.js', import.meta.url);
    this.nextId = 1;
    this.active = null;
  }

  get available() {
    return typeof this.WorkerCtor === 'function';
  }

  cancel() {
    if (!this.active) return;
    this.active.worker.terminate();
    const error = new Error('Simulation superseded by a newer request.');
    error.name = 'AbortError';
    this.active.reject(error);
    this.active = null;
  }

  /**
   * Run one job away from the UI thread. There is intentionally only one
   * active request: design controls are interactive, so old answers have no
   * value after a customer changes an input.
   *
   * @param {import('../types/core.ts').SimulationJob} job
   * @returns {Promise<unknown>}
   */
  runLatest(job) {
    const WorkerClass = this.WorkerCtor;
    if (typeof WorkerClass !== 'function') return Promise.reject(new Error('Browser workers are unavailable.'));
    this.cancel();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const worker = new WorkerClass(this.workerUrl, { type: 'module', name: 'battery-simulation' });
      this.active = { id, worker, reject };
      worker.onmessage = (event) => {
        const reply = event.data;
        if (!this.active || reply?.id !== id) return;
        this.active = null;
        worker.terminate();
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error || 'Simulation worker failed.'));
      };
      worker.onerror = (event) => {
        if (!this.active || this.active.id !== id) return;
        this.active = null;
        worker.terminate();
        reject(new Error(event?.message || 'Simulation worker failed.'));
      };
      worker.postMessage({ id, job });
    });
  }
}
