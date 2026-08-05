import test from 'node:test';
import assert from 'node:assert/strict';

import { CELLS } from '../js/cells.js';
import { simulateMission } from '../js/sim1d.js';
import { simulate as simulateAdvanced } from '../js/sim2.js';
import { runSimulationJob } from '../js/simulation-jobs.js';
import {
  BROWSER_WORKER_THRESHOLD,
  estimateMissionSteps,
  shouldUseSimulationWorker,
  SimulationWorkerClient,
} from '../js/simulation-client.js';

const cell = CELLS.find((candidate) => candidate.dcirMOhm != null);
const missionInput = {
  cell,
  s: 16,
  p: 4,
  profile: { dtS: 1, p: [0.2, 0.8, -0.1, 0.4] },
  scaleW: 5_000,
  passes: 2,
  ambientC: 25,
};

test('worker dispatcher returns the identical level-1 simulation', () => {
  const direct = simulateMission(missionInput);
  const dispatched = runSimulationJob({ kind: 'mission', input: missionInput });
  assert.deepEqual(dispatched, { mission: direct, comparison: null });
});

test('worker dispatcher returns the identical advanced simulation', () => {
  const input = {
    cell,
    s: 16,
    p: 4,
    profile: { dtS: 1, i: [5, 10, -2, 3] },
    nModules: 2,
  };
  assert.deepEqual(
    runSimulationJob({ kind: 'advanced', input }),
    simulateAdvanced(input),
  );
});

test('worker threshold counts profile, passes, charging and comparisons', () => {
  const withCharging = {
    ...missionInput,
    passes: 3,
    charge: { mode: 'topup', powerW: 2_000, minutes: 1 },
  };
  assert.equal(estimateMissionSteps(withCharging), 3 * (4 + 60));
  assert.equal(shouldUseSimulationWorker(missionInput, 0), false);
  assert.equal(
    shouldUseSimulationWorker(missionInput, 3, estimateMissionSteps(missionInput) * 4),
    true,
  );
  assert.ok(BROWSER_WORKER_THRESHOLD > 0);
});

test('worker client cancels stale work and accepts only the latest answer', async () => {
  class ControlledWorker {
    static instances = [];
    constructor() {
      this.terminated = false;
      ControlledWorker.instances.push(this);
    }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated = true; }
    answer(result) {
      this.onmessage({ data: { id: this.request.id, ok: true, result } });
    }
  }

  const client = new SimulationWorkerClient({ WorkerCtor: ControlledWorker, workerUrl: new URL('file:///worker.js') });
  const first = client.runLatest({ kind: 'mission', input: missionInput });
  const firstWorker = ControlledWorker.instances[0];
  const second = client.runLatest({ kind: 'mission', input: missionInput });
  const secondWorker = ControlledWorker.instances[1];

  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.equal(firstWorker.terminated, true);
  secondWorker.answer({ mission: { unavailable: true, why: 'test' }, comparison: null });
  assert.deepEqual(await second, { mission: { unavailable: true, why: 'test' }, comparison: null });
  assert.equal(secondWorker.terminated, true);
});

test('worker client reports an explicit unavailable fallback boundary', async () => {
  const client = new SimulationWorkerClient({ WorkerCtor: null });
  assert.equal(client.available, false);
  await assert.rejects(
    client.runLatest({ kind: 'mission', input: missionInput }),
    /workers are unavailable/i,
  );
});
