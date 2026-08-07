//! Lumped thermal node model.
//!
//! Single-node thermal model with heat capacity, thermal resistance to ambient,
//! and power input. Uses the exact exponential solution for each timestep,
//! which is unconditionally stable and exact for constant inputs.

/// Error type for thermal model validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThermalError {
    /// Heat capacity must be positive and finite.
    InvalidHeatCapacity,
    /// Thermal resistance must be positive and finite.
    InvalidThermalResistance,
    /// Timestep must be positive and finite.
    InvalidTimestep,
    /// Temperature inputs must be finite.
    InvalidTemperature,
    /// Power input must be finite.
    InvalidPower,
}

impl std::fmt::Display for ThermalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidHeatCapacity => write!(f, "heat capacity must be positive and finite"),
            Self::InvalidThermalResistance => {
                write!(f, "thermal resistance must be positive and finite")
            }
            Self::InvalidTimestep => write!(f, "timestep must be positive and finite"),
            Self::InvalidTemperature => write!(f, "temperature must be finite"),
            Self::InvalidPower => write!(f, "power input must be finite"),
        }
    }
}

impl std::error::Error for ThermalError {}

/// Advance a lumped thermal node by one timestep using the exact exponential solution.
///
/// The model equation is:
///
/// ```text
/// dT/dt = (Q - (T - T_amb) / R) / C
/// ```
///
/// where:
/// - T is the node temperature \[K\]
/// - Q is the power input (heat generation) \[W\]
/// - T\_amb is the ambient temperature \[K\]
/// - R is the thermal resistance to ambient \[K/W\]
/// - C is the heat capacity \[J/K\]
///
/// # Method
///
/// Uses the exact exponential solution rather than explicit Euler because:
/// 1. Unconditionally stable regardless of timestep size
/// 2. Exact when power input is constant during the timestep
/// 3. Better accuracy for the same computational cost
///
/// The steady-state temperature is `T_steady = T_amb + Q * R`, and the solution is:
///
/// ```text
/// T(t) = T_steady + (T_0 - T_steady) * exp(-t / τ)
/// ```
///
/// where `τ = R * C` is the thermal time constant.
pub fn thermal_node_step(
    temperature_k: f64,
    heat_capacity_j_per_k: f64,
    thermal_resistance_k_per_w: f64,
    power_input_w: f64,
    ambient_temperature_k: f64,
    dt_s: f64,
) -> Result<f64, ThermalError> {
    if !heat_capacity_j_per_k.is_finite() || heat_capacity_j_per_k <= 0.0 {
        return Err(ThermalError::InvalidHeatCapacity);
    }
    if !thermal_resistance_k_per_w.is_finite() || thermal_resistance_k_per_w <= 0.0 {
        return Err(ThermalError::InvalidThermalResistance);
    }
    if !dt_s.is_finite() || dt_s <= 0.0 {
        return Err(ThermalError::InvalidTimestep);
    }
    if !temperature_k.is_finite() || !ambient_temperature_k.is_finite() {
        return Err(ThermalError::InvalidTemperature);
    }
    if !power_input_w.is_finite() {
        return Err(ThermalError::InvalidPower);
    }

    let tau_s = thermal_resistance_k_per_w * heat_capacity_j_per_k;
    let steady_state_k = ambient_temperature_k + power_input_w * thermal_resistance_k_per_w;
    let decay = (-dt_s / tau_s).exp();
    let new_temperature_k = steady_state_k + (temperature_k - steady_state_k) * decay;

    Ok(new_temperature_k)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected} within {tolerance}"
        );
    }

    #[test]
    fn steady_state_temperature_equals_ambient_plus_power_times_resistance() {
        let mut temp = 300.0;
        let capacity = 100.0;
        let resistance = 5.0;
        let power = 10.0;
        let ambient = 298.15;
        let dt = 1.0;

        let expected_steady = ambient + power * resistance;

        for _ in 0..10000 {
            temp = thermal_node_step(temp, capacity, resistance, power, ambient, dt).unwrap();
        }

        near(temp, expected_steady, 1e-7);
    }

    #[test]
    fn step_response_follows_exponential_decay() {
        let capacity = 100.0;
        let resistance = 5.0;
        let power = 10.0;
        let ambient = 300.0;
        let tau = capacity * resistance;
        let steady = ambient + power * resistance;

        let dt = 10.0;
        let mut temp = ambient;

        temp = thermal_node_step(temp, capacity, resistance, power, ambient, dt).unwrap();
        let expected_1 = steady + (ambient - steady) * (-dt / tau).exp();
        near(temp, expected_1, 1e-12);

        for _ in 0..9 {
            temp = thermal_node_step(temp, capacity, resistance, power, ambient, dt).unwrap();
        }
        let expected_100 = steady + (ambient - steady) * (-100.0 / tau).exp();
        near(temp, expected_100, 1e-10);
    }

    #[test]
    fn invalid_parameters_return_appropriate_errors() {
        let t = 300.0;
        let c = 100.0;
        let r = 5.0;
        let q = 10.0;
        let a = 300.0;
        let dt = 1.0;

        assert_eq!(
            thermal_node_step(t, 0.0, r, q, a, dt),
            Err(ThermalError::InvalidHeatCapacity)
        );
        assert_eq!(
            thermal_node_step(t, -10.0, r, q, a, dt),
            Err(ThermalError::InvalidHeatCapacity)
        );
        assert_eq!(
            thermal_node_step(t, f64::NAN, r, q, a, dt),
            Err(ThermalError::InvalidHeatCapacity)
        );
        assert_eq!(
            thermal_node_step(t, f64::INFINITY, r, q, a, dt),
            Err(ThermalError::InvalidHeatCapacity)
        );

        assert_eq!(
            thermal_node_step(t, c, 0.0, q, a, dt),
            Err(ThermalError::InvalidThermalResistance)
        );
        assert_eq!(
            thermal_node_step(t, c, -1.0, q, a, dt),
            Err(ThermalError::InvalidThermalResistance)
        );

        assert_eq!(
            thermal_node_step(t, c, r, q, a, 0.0),
            Err(ThermalError::InvalidTimestep)
        );
        assert_eq!(
            thermal_node_step(t, c, r, q, a, -1.0),
            Err(ThermalError::InvalidTimestep)
        );

        assert_eq!(
            thermal_node_step(f64::NAN, c, r, q, a, dt),
            Err(ThermalError::InvalidTemperature)
        );
        assert_eq!(
            thermal_node_step(t, c, r, q, f64::INFINITY, dt),
            Err(ThermalError::InvalidTemperature)
        );

        assert_eq!(
            thermal_node_step(t, c, r, f64::NAN, a, dt),
            Err(ThermalError::InvalidPower)
        );
    }
}
