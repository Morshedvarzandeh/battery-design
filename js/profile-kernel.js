// @ts-check
// The reference implementation for profile aggregation. Rust/Wasm must match
// this object exactly; it remains the fallback for Node, old browsers and any
// host that blocks WebAssembly.

/**
 * @param {{ dtS: number, p: readonly number[] }} profile
 * @param {number} peakScaleW
 */
export function profileStatsKernel(profile, peakScaleW) {
  const p = profile.p;
  const dt = profile.dtS;
  const n = p.length;
  const durationS = n * dt;
  let peakW = 0;
  let sumPos = 0;
  let sumSq = 0;
  let regenWh = 0;
  let peakChargeW = 0;
  let energyWh = 0;
  for (const value of p) {
    const watts = value * peakScaleW;
    peakW = Math.max(peakW, watts);
    sumSq += watts * watts;
    if (watts > 0) {
      sumPos += watts;
      energyWh += (watts * dt) / 3600;
    } else {
      peakChargeW = Math.max(peakChargeW, -watts);
      regenWh += (-watts * dt) / 3600;
    }
  }
  const meanW = n ? sumPos / n : 0;
  return {
    durationS,
    peakW,
    meanW,
    rmsW: n ? Math.sqrt(sumSq / n) : 0,
    energyPerPassWh: energyWh,
    regenWh,
    peakChargeW: peakChargeW || null,
    crestFactor: meanW > 0 ? peakW / meanW : null,
  };
}

