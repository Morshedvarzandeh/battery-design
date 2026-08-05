//! Numerical kernels shared by the browser and native battery-design builds.
//!
//! The crate deliberately has no dependencies. Its public Rust functions are
//! ordinary, safe functions that native code can call directly. The small C
//! ABI at the bottom is the same implementation exposed to WebAssembly.

pub mod equations;
pub mod graph_transport;

/// Stable ABI order returned by `profile_stats` and `bd_profile_stats`:
/// duration_s, peak_w, mean_w, rms_w, discharge_wh, regen_wh, peak_charge_w.
pub const PROFILE_STATS_LEN: usize = 7;

/// Aggregate one normalised power profile after applying its absolute scale.
/// Positive samples discharge the battery; negative samples are charge/regen.
pub fn profile_stats(samples: &[f64], dt_s: f64, scale_w: f64) -> [f64; PROFILE_STATS_LEN] {
    let duration_s = samples.len() as f64 * dt_s;
    if samples.is_empty() {
        return [duration_s, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    }

    let mut peak_w = 0.0_f64;
    let mut positive_sum_w = 0.0_f64;
    let mut square_sum_w2 = 0.0_f64;
    let mut discharge_wh = 0.0_f64;
    let mut regen_wh = 0.0_f64;
    let mut peak_charge_w = 0.0_f64;

    for normalised in samples {
        let watts = normalised * scale_w;
        peak_w = peak_w.max(watts);
        square_sum_w2 += watts * watts;
        if watts > 0.0 {
            positive_sum_w += watts;
            discharge_wh += watts * dt_s / 3600.0;
        } else {
            let charge_w = -watts;
            peak_charge_w = peak_charge_w.max(charge_w);
            regen_wh += charge_w * dt_s / 3600.0;
        }
    }

    [
        duration_s,
        peak_w,
        positive_sum_w / samples.len() as f64,
        (square_sum_w2 / samples.len() as f64).sqrt(),
        discharge_wh,
        regen_wh,
        peak_charge_w,
    ]
}

/// Reserve `len` f64 slots in WebAssembly linear memory. JavaScript fills the
/// returned region, calls a kernel, then releases it with `bd_free_f64`.
#[no_mangle]
pub extern "C" fn bd_alloc_f64(len: usize) -> *mut f64 {
    let mut values = Vec::<f64>::with_capacity(len);
    let pointer = values.as_mut_ptr();
    std::mem::forget(values);
    pointer
}

/// Release a region created by `bd_alloc_f64`.
///
/// # Safety
/// `pointer` and `capacity` must be the unchanged values from `bd_alloc_f64`.
#[no_mangle]
pub unsafe extern "C" fn bd_free_f64(pointer: *mut f64, capacity: usize) {
    if pointer.is_null() || capacity == 0 {
        return;
    }
    drop(Vec::from_raw_parts(pointer, 0, capacity));
}

/// WebAssembly ABI for `profile_stats`. Returns 1 on success and writes seven
/// f64 values to `output`; invalid pointers return 0 without touching memory.
///
/// # Safety
/// `samples` must address `len` readable f64 values and `output` must address
/// `PROFILE_STATS_LEN` writable f64 values in this module's linear memory.
#[no_mangle]
pub unsafe extern "C" fn bd_profile_stats(
    samples: *const f64,
    len: usize,
    dt_s: f64,
    scale_w: f64,
    output: *mut f64,
) -> u32 {
    if output.is_null() || (len > 0 && samples.is_null()) {
        return 0;
    }
    let input = if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(samples, len)
    };
    let result = profile_stats(input, dt_s, scale_w);
    std::ptr::copy_nonoverlapping(result.as_ptr(), output, PROFILE_STATS_LEN);
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
    }

    #[test]
    fn square_wave_matches_the_hand_calculation() {
        let stats = profile_stats(&[1.0, 0.0, 1.0, 0.0], 10.0, 100.0);
        near(stats[0], 40.0);
        near(stats[1], 100.0);
        near(stats[2], 50.0);
        near(stats[3], 100.0 / 2.0_f64.sqrt());
        near(stats[4], 2000.0 / 3600.0);
        near(stats[5], 0.0);
        near(stats[6], 0.0);
    }

    #[test]
    fn charge_and_discharge_stay_separate() {
        let stats = profile_stats(&[0.5, -1.0, 0.25, -0.5], 60.0, 1000.0);
        near(stats[1], 500.0);
        near(stats[4], 750.0 / 60.0);
        near(stats[5], 1500.0 / 60.0);
        near(stats[6], 1000.0);
    }

    #[test]
    fn an_empty_profile_is_finite() {
        assert_eq!(profile_stats(&[], 1.0, 1000.0), [0.0; PROFILE_STATS_LEN]);
    }
}
