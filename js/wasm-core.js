// @ts-check
// Optional Rust/WebAssembly acceleration. The public API is synchronous after
// one asynchronous preload, which lets existing sizing code keep its simple
// call graph. Any load or ABI failure leaves the reference JavaScript kernel
// in place.

import { profileStatsKernel } from './profile-kernel.js';

const PROFILE_STATS_LEN = 7;
export const WASM_PROFILE_THRESHOLD = 256;
/** @typedef {{
 * memory: WebAssembly.Memory,
 * bd_alloc_f64: (len: number) => number,
 * bd_free_f64: (pointer: number, capacity: number) => void,
 * bd_profile_stats: (pointer: number, len: number, dtS: number, scaleW: number, output: number) => number,
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
