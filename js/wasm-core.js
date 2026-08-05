// @ts-check
// Optional Rust/WebAssembly acceleration. The public API is synchronous after
// one asynchronous preload, which lets existing sizing code keep its simple
// call graph. Any load or ABI failure leaves the reference JavaScript kernel
// in place.

import { profileStatsKernel } from './profile-kernel.js';
import { encodeGraphTransport } from './cosim-graph.js';

const PROFILE_STATS_LEN = 7;
export const WASM_PROFILE_THRESHOLD = 256;
/** @typedef {{
 * memory: WebAssembly.Memory,
 * bd_alloc_f64: (len: number) => number,
 * bd_free_f64: (pointer: number, capacity: number) => void,
 * bd_profile_stats: (pointer: number, len: number, dtS: number, scaleW: number, output: number) => number,
 * bd_graph_simulate?: (pointer: number, len: number) => number,
 * bd_graph_run_meta?: (handle: number, output: number, outputLen: number) => number,
 * bd_graph_run_values?: (handle: number, output: number, outputLen: number) => number,
 * bd_graph_run_free?: (handle: number) => void,
 * }} BatteryCoreExports */
/** @type {BatteryCoreExports | null} */
let core = null;
/** @type {Promise<boolean> | null} */
let loading = null;

/**
 * @param {WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource} result
 * @returns {BatteryCoreExports}
 */
function exportsFrom(result) {
  const candidate = result instanceof WebAssembly.Instance ? result.exports : result?.instance?.exports;
  if (!candidate
      || !(candidate.memory instanceof WebAssembly.Memory)
      || typeof candidate.bd_alloc_f64 !== 'function'
      || typeof candidate.bd_free_f64 !== 'function'
      || typeof candidate.bd_profile_stats !== 'function') {
    throw new TypeError('The battery-design WebAssembly module has an incompatible ABI.');
  }
  return /** @type {BatteryCoreExports} */ (candidate);
}

/**
 * Preload the Rust core. `bytes` exists for deterministic Node/CI parity
 * tests; browsers use the generated public asset.
 *
 * @param {{ bytes?: BufferSource, url?: URL, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<boolean>}
 */
export function initializeWasmCore(options = {}) {
  if (core) return Promise.resolve(true);
  if (loading) return loading;
  if (typeof WebAssembly !== 'object') return Promise.resolve(false);

  loading = (async () => {
    try {
      let result;
      if (options.bytes) {
        result = await WebAssembly.instantiate(options.bytes, {});
      } else {
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') return false;
        const url = options.url ?? new URL('../wasm/battery_design_core.wasm', import.meta.url);
        const response = await fetchImpl(url);
        if (!response.ok) return false;
        const bytes = await response.arrayBuffer();
        result = await WebAssembly.instantiate(bytes, {});
      }
      core = exportsFrom(result);
      return true;
    } catch (error) {
      console.warn('Rust calculation core unavailable; using JavaScript.', error);
      return false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function wasmCoreReady() {
  return core != null;
}

export function equationGraphWasmReady() {
  return core != null
    && typeof core.bd_graph_simulate === 'function'
    && typeof core.bd_graph_run_meta === 'function'
    && typeof core.bd_graph_run_values === 'function'
    && typeof core.bd_graph_run_free === 'function';
}

export function resetWasmCoreForTest() {
  core = null;
  loading = null;
}

/**
 * @param {{ dtS: number, p: readonly number[] }} profile
 * @param {number} peakScaleW
 */
export function acceleratedProfileStats(profile, peakScaleW) {
  if (!core || profile.p.length < WASM_PROFILE_THRESHOLD) {
    return profileStatsKernel(profile, peakScaleW);
  }

  const inputLength = profile.p.length;
  const inputPointer = core.bd_alloc_f64(inputLength);
  const outputPointer = core.bd_alloc_f64(PROFILE_STATS_LEN);
  try {
    new Float64Array(core.memory.buffer, inputPointer, inputLength).set(profile.p);
    const ok = core.bd_profile_stats(
      inputPointer,
      inputLength,
      profile.dtS,
      peakScaleW,
      outputPointer,
    );
    if (ok !== 1) throw new Error('Rust profile calculation rejected its memory contract.');
    const output = new Float64Array(core.memory.buffer, outputPointer, PROFILE_STATS_LEN);
    const durationS = output[0] ?? 0;
    const peakW = output[1] ?? 0;
    const meanW = output[2] ?? 0;
    const rmsW = output[3] ?? 0;
    const energyPerPassWh = output[4] ?? 0;
    const regenWh = output[5] ?? 0;
    const peakChargeW = output[6] ?? 0;
    return {
      durationS,
      peakW,
      meanW,
      rmsW,
      energyPerPassWh,
      regenWh,
      peakChargeW: peakChargeW || null,
      crestFactor: meanW > 0 ? peakW / meanW : null,
    };
  } catch (error) {
    console.warn('Rust profile calculation failed; using JavaScript.', error);
    return profileStatsKernel(profile, peakScaleW);
  } finally {
    core.bd_free_f64(inputPointer, inputLength);
    core.bd_free_f64(outputPointer, PROFILE_STATS_LEN);
  }
}

const GRAPH_META_LENGTH = 10;
/** @type {Readonly<Record<number, string>>} */
const GRAPH_DIAGNOSTICS = Object.freeze({
  1: 'transport.malformed', 10: 'graph.empty', 11: 'graph.duplicate_block_name',
  12: 'graph.unknown_block', 20: 'connection.invalid_port',
  21: 'connection.duplicate_input', 22: 'connection.missing_input',
  23: 'connection.quantity_mismatch', 30: 'block.invalid_parameter',
  40: 'solver.invalid_settings', 41: 'solver.state_size',
  42: 'solver.non_finite_value', 43: 'solver.singular_algebraic_loop',
  44: 'solver.algebraic_non_convergence', 45: 'solver.implicit_non_convergence',
  46: 'solver.implicit_state_limit', 47: 'solver.step_underflow',
  48: 'solver.max_steps_exceeded', 99: 'solver.unknown',
});
const GRAPH_METHODS = ['auto', 'dormand-prince-45', 'backward-euler'];
const GRAPH_REASONS = [
  'user-selected', 'no-continuous-states', 'non-stiff-time-scales',
  'separated-time-scales', 'fast-state-for-requested-horizon',
];

/**
 * Compile and solve a canonical equation graph in the Rust/Wasm core.
 * There is deliberately no JavaScript solver fallback: an unavailable Rust
 * engine is shown as unavailable, never replaced by a second numerical truth.
 *
 * @param {any} graph
 */
export function simulateEquationGraph(graph) {
  const loaded = core;
  if (!loaded
      || typeof loaded.bd_graph_simulate !== 'function'
      || typeof loaded.bd_graph_run_meta !== 'function'
      || typeof loaded.bd_graph_run_values !== 'function'
      || typeof loaded.bd_graph_run_free !== 'function') {
    const error = /** @type {Error & { code?: string }} */ (new Error('The authoritative Rust equation engine is not loaded.'));
    error.code = 'runtime.rust_unavailable';
    throw error;
  }
  const encoded = encodeGraphTransport(graph);
  const inputLength = encoded.values.length;
  const inputPointer = loaded.bd_alloc_f64(inputLength);
  let handle = 0;
  let metaPointer = 0;
  let valuesPointer = 0;
  let valuesLength = 0;
  try {
    new Float64Array(loaded.memory.buffer, inputPointer, inputLength).set(encoded.values);
    handle = loaded.bd_graph_simulate(inputPointer, inputLength);
    if (!handle) throw new Error('Rust could not allocate a graph-run result.');
    metaPointer = loaded.bd_alloc_f64(GRAPH_META_LENGTH);
    if (loaded.bd_graph_run_meta(handle, metaPointer, GRAPH_META_LENGTH) !== 1) {
      throw new Error('Rust rejected the graph-run metadata buffer.');
    }
    const meta = [...new Float64Array(loaded.memory.buffer, metaPointer, GRAPH_META_LENGTH)];
    if (meta[0] !== 1) {
      const error = /** @type {Error & { code?: string }} */ (new Error('The Rust equation engine rejected this graph.'));
      error.code = GRAPH_DIAGNOSTICS[Number(meta[1] ?? 99)] || 'solver.unknown';
      throw error;
    }
    const pointCount = Math.trunc(meta[2] ?? 0);
    const blockCount = Math.trunc(meta[3] ?? 0);
    valuesLength = Math.trunc(meta[9] ?? 0);
    if (valuesLength !== pointCount * (blockCount + 1)) {
      throw new Error('Rust returned an inconsistent graph trace shape.');
    }
    valuesPointer = loaded.bd_alloc_f64(valuesLength);
    if (loaded.bd_graph_run_values(handle, valuesPointer, valuesLength) !== valuesLength) {
      throw new Error('Rust could not copy the graph trace.');
    }
    const flat = new Float64Array(loaded.memory.buffer, valuesPointer, valuesLength);
    const points = Array.from({ length: pointCount }, (_, pointIndex) => {
      const offset = pointIndex * (blockCount + 1);
      return {
        timeS: flat[offset] ?? 0,
        values: Object.fromEntries(encoded.blockIds.map((id, blockIndex) => [id, flat[offset + 1 + blockIndex]])),
      };
    });
    return {
      points,
      blockIds: encoded.blockIds,
      acceptedSteps: Math.trunc(meta[4] ?? 0), rejectedSteps: Math.trunc(meta[5] ?? 0),
      nonlinearIterations: Math.trunc(meta[6] ?? 0),
      solver: {
        method: GRAPH_METHODS[Math.trunc(meta[7] ?? 0)] || 'unknown',
        reason: GRAPH_REASONS[Math.trunc(meta[8] ?? 0)] || 'unknown',
      },
    };
  } finally {
    if (valuesPointer) loaded.bd_free_f64(valuesPointer, valuesLength);
    if (metaPointer) loaded.bd_free_f64(metaPointer, GRAPH_META_LENGTH);
    if (handle) loaded.bd_graph_run_free(handle);
    loaded.bd_free_f64(inputPointer, inputLength);
  }
}
