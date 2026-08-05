//! Versioned numeric transport for browser-authored equation graphs.
//!
//! JavaScript owns names and canvas positions.  Rust receives only the
//! canonical block order, exact quantities, numerical parameters,
//! connections and solver settings it needs to compile an authoritative run.
//! Keeping this transport numeric avoids a JSON parser and preserves the
//! dependency-free WebAssembly boundary.

use crate::equations::{
    Block, BlockKind, CompiledGraph, EquationError, EquationGraph, IntegrationMethod, Quantity,
    SimulationResult, SolverDecisionReason, SolverSettings,
};

pub const GRAPH_TRANSPORT_MAGIC: u64 = 0x4244_4731; // "BDG1"
pub const GRAPH_TRANSPORT_VERSION: usize = 1;
pub const GRAPH_TRANSPORT_HEADER_LENGTH: usize = 17;
pub const GRAPH_TRANSPORT_BLOCK_LENGTH: usize = 6;
pub const GRAPH_TRANSPORT_CONNECTION_LENGTH: usize = 3;
pub const GRAPH_RUN_META_LENGTH: usize = 10;

#[derive(Clone, Debug, PartialEq)]
pub enum GraphTransportError {
    Malformed(&'static str),
    Equation(EquationError),
}

impl From<EquationError> for GraphTransportError {
    fn from(value: EquationError) -> Self {
        Self::Equation(value)
    }
}

impl GraphTransportError {
    pub fn diagnostic_number(&self) -> u32 {
        match self {
            Self::Malformed(_) => 1,
            Self::Equation(error) => equation_diagnostic_number(error),
        }
    }
}

#[derive(Debug)]
pub struct DecodedGraph {
    pub graph: CompiledGraph,
    pub settings: SolverSettings,
}

fn integer(value: f64, name: &'static str) -> Result<usize, GraphTransportError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > usize::MAX as f64 {
        return Err(GraphTransportError::Malformed(name));
    }
    Ok(value as usize)
}

fn quantity(value: f64) -> Result<Quantity, GraphTransportError> {
    Ok(match integer(value, "quantity")? {
        0 => Quantity::Dimensionless,
        1 => Quantity::Fraction,
        2 => Quantity::FractionPerSecond,
        3 => Quantity::VoltageV,
        4 => Quantity::CurrentA,
        5 => Quantity::PowerW,
        6 => Quantity::EnergyJ,
        7 => Quantity::TemperatureK,
        8 => Quantity::TemperatureRateKPerSecond,
        9 => Quantity::HeatFlowW,
        10 => Quantity::SpeedRadPerSecond,
        11 => Quantity::TorqueNm,
        _ => return Err(GraphTransportError::Malformed("quantity")),
    })
}

fn method(value: f64) -> Result<IntegrationMethod, GraphTransportError> {
    Ok(match integer(value, "integration method")? {
        0 => IntegrationMethod::Auto,
        1 => IntegrationMethod::DormandPrince45,
        2 => IntegrationMethod::BackwardEuler,
        _ => return Err(GraphTransportError::Malformed("integration method")),
    })
}

fn block_kind(record: &[f64], output: Quantity) -> Result<BlockKind, GraphTransportError> {
    let code = integer(record[0], "block kind")?;
    Ok(match code {
        0 => BlockKind::Constant { value: record[2] },
        1 => BlockKind::StepSource {
            before: record[2], after: record[3], at_s: record[4],
        },
        2 => BlockKind::Gain { gain: record[2], input: quantity(record[3])? },
        3 => BlockKind::Sum { inputs: integer(record[2], "sum input count")? },
        4 => BlockKind::Product {
            scale: record[2], left: quantity(record[3])?, right: quantity(record[4])?,
        },
        5 => BlockKind::Limit { min: record[2], max: record[3] },
        6 => BlockKind::Integrator {
            initial: record[2], rate: quantity(record[3])?, gain: record[4],
        },
        7 => BlockKind::FirstOrder { tau_s: record[2], initial: record[3] },
        8 => {
            if output != Quantity::TemperatureRateKPerSecond {
                return Err(GraphTransportError::Malformed("thermal output quantity"));
            }
            BlockKind::ThermalRate {
                heat_capacity_j_per_k: record[2], conductance_w_per_k: record[3],
            }
        }
        _ => return Err(GraphTransportError::Malformed("block kind")),
    })
}

/// Decode and compile one complete graph.  Exact record length is required so
/// a future schema cannot be interpreted accidentally as this one.
pub fn decode_graph_transport(values: &[f64]) -> Result<DecodedGraph, GraphTransportError> {
    if values.len() < GRAPH_TRANSPORT_HEADER_LENGTH {
        return Err(GraphTransportError::Malformed("header length"));
    }
    if integer(values[0], "magic")? as u64 != GRAPH_TRANSPORT_MAGIC {
        return Err(GraphTransportError::Malformed("magic"));
    }
    if integer(values[1], "version")? != GRAPH_TRANSPORT_VERSION {
        return Err(GraphTransportError::Malformed("version"));
    }
    let block_count = integer(values[2], "block count")?;
    let connection_count = integer(values[3], "connection count")?;
    let expected = GRAPH_TRANSPORT_HEADER_LENGTH
        .checked_add(block_count.checked_mul(GRAPH_TRANSPORT_BLOCK_LENGTH)
            .ok_or(GraphTransportError::Malformed("block count"))?)
        .and_then(|length| length.checked_add(
            connection_count.checked_mul(GRAPH_TRANSPORT_CONNECTION_LENGTH)?,
        ))
        .ok_or(GraphTransportError::Malformed("record length"))?;
    if values.len() != expected {
        return Err(GraphTransportError::Malformed("record length"));
    }
    let settings = SolverSettings {
        method: method(values[4])?, start_s: values[5], end_s: values[6],
        initial_step_s: values[7], min_step_s: values[8], max_step_s: values[9],
        relative_tolerance: values[10], absolute_tolerance: values[11],
        max_steps: integer(values[12], "maximum steps")?, algebraic_tolerance: values[13],
        algebraic_max_iterations: integer(values[14], "algebraic iterations")?,
        implicit_tolerance: values[15],
        implicit_max_iterations: integer(values[16], "implicit iterations")?,
    };

    let mut graph = EquationGraph::new();
    let block_start = GRAPH_TRANSPORT_HEADER_LENGTH;
    for index in 0..block_count {
        let start = block_start + index * GRAPH_TRANSPORT_BLOCK_LENGTH;
        let record = &values[start..start + GRAPH_TRANSPORT_BLOCK_LENGTH];
        let output = quantity(record[1])?;
        graph.add_block(Block::new(
            format!("block-{index}"), output, block_kind(record, output)?,
        ))?;
    }
    let connections_start = block_start + block_count * GRAPH_TRANSPORT_BLOCK_LENGTH;
    for index in 0..connection_count {
        let start = connections_start + index * GRAPH_TRANSPORT_CONNECTION_LENGTH;
        graph.connect(
            integer(values[start], "source block")?,
            integer(values[start + 1], "target block")?,
            integer(values[start + 2], "target port")?,
        )?;
    }
    Ok(DecodedGraph { graph: graph.compile()?, settings })
}

pub fn equation_diagnostic_number(error: &EquationError) -> u32 {
    match error.code() {
        "graph.empty" => 10,
        "graph.duplicate_block_name" => 11,
        "graph.unknown_block" => 12,
        "connection.invalid_port" => 20,
        "connection.duplicate_input" => 21,
        "connection.missing_input" => 22,
        "connection.quantity_mismatch" => 23,
        "block.invalid_parameter" => 30,
        "solver.invalid_settings" => 40,
        "solver.state_size" => 41,
        "solver.non_finite_value" => 42,
        "solver.singular_algebraic_loop" => 43,
        "solver.algebraic_non_convergence" => 44,
        "solver.implicit_non_convergence" => 45,
        "solver.implicit_state_limit" => 46,
        "solver.step_underflow" => 47,
        "solver.max_steps_exceeded" => 48,
        _ => 99,
    }
}

fn selected_method_number(result: &SimulationResult) -> u32 {
    match result.solver.selected {
        IntegrationMethod::Auto => 0,
        IntegrationMethod::DormandPrince45 => 1,
        IntegrationMethod::BackwardEuler => 2,
    }
}

fn decision_reason_number(result: &SimulationResult) -> u32 {
    match result.solver.reason {
        SolverDecisionReason::UserSelected => 0,
        SolverDecisionReason::NoContinuousStates => 1,
        SolverDecisionReason::NonStiffTimeScales => 2,
        SolverDecisionReason::SeparatedTimeScales => 3,
        SolverDecisionReason::FastStateForRequestedHorizon => 4,
    }
}

/// Opaque result owned by Rust until `bd_graph_run_free` is called.
pub struct GraphRun {
    meta: [f64; GRAPH_RUN_META_LENGTH],
    values: Vec<f64>,
}

impl GraphRun {
    fn failure(error: GraphTransportError) -> Self {
        let mut meta = [0.0; GRAPH_RUN_META_LENGTH];
        meta[1] = error.diagnostic_number() as f64;
        Self { meta, values: Vec::new() }
    }

    fn success(result: SimulationResult) -> Self {
        let blocks = result.summary.blocks;
        let mut values = Vec::with_capacity(result.points.len() * (blocks + 1));
        for point in &result.points {
            values.push(point.time_s);
            values.extend_from_slice(&point.values);
        }
        let meta = [
            1.0,
            0.0,
            result.points.len() as f64,
            blocks as f64,
            result.accepted_steps as f64,
            result.rejected_steps as f64,
            result.nonlinear_iterations as f64,
            selected_method_number(&result) as f64,
            decision_reason_number(&result) as f64,
            values.len() as f64,
        ];
        Self { meta, values }
    }
}

/// Compile and simulate a transported graph.  Errors still return a handle so
/// JavaScript can read a stable diagnostic number instead of parsing text.
#[no_mangle]
pub unsafe extern "C" fn bd_graph_simulate(values: *const f64, len: usize) -> *mut GraphRun {
    let run = if values.is_null() && len > 0 {
        GraphRun::failure(GraphTransportError::Malformed("input pointer"))
    } else {
        let input = if len == 0 { &[] } else { std::slice::from_raw_parts(values, len) };
        match decode_graph_transport(input)
            .and_then(|decoded| decoded.graph.simulate(decoded.settings).map_err(Into::into))
        {
            Ok(result) => GraphRun::success(result),
            Err(error) => GraphRun::failure(error),
        }
    };
    Box::into_raw(Box::new(run))
}

/// Copy the fixed ten-number run summary into caller-owned Wasm memory.
#[no_mangle]
pub unsafe extern "C" fn bd_graph_run_meta(
    run: *const GraphRun,
    output: *mut f64,
    output_len: usize,
) -> u32 {
    if run.is_null() || output.is_null() || output_len < GRAPH_RUN_META_LENGTH {
        return 0;
    }
    std::ptr::copy_nonoverlapping((*run).meta.as_ptr(), output, GRAPH_RUN_META_LENGTH);
    1
}

/// Copy flattened `[time, block0, block1, ...]` trace rows.
#[no_mangle]
pub unsafe extern "C" fn bd_graph_run_values(
    run: *const GraphRun,
    output: *mut f64,
    output_len: usize,
) -> usize {
    if run.is_null() || ((*run).values.len() > 0 && output.is_null())
        || output_len < (*run).values.len()
    {
        return 0;
    }
    std::ptr::copy_nonoverlapping((*run).values.as_ptr(), output, (*run).values.len());
    (*run).values.len()
}

#[no_mangle]
pub unsafe extern "C" fn bd_graph_run_free(run: *mut GraphRun) {
    if !run.is_null() {
        drop(Box::from_raw(run));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_energy_transport() -> Vec<f64> {
        vec![
            GRAPH_TRANSPORT_MAGIC as f64, 1.0, 2.0, 1.0,
            0.0, 0.0, 2.0, 0.01, 1e-9, 0.25, 1e-6, 1e-9, 100_000.0,
            1e-10, 30.0, 1e-10, 20.0,
            // Constant 100 W
            0.0, 5.0, 100.0, 0.0, 0.0, 0.0,
            // Energy integrator, dx/dt = power
            6.0, 6.0, 0.0, 5.0, 1.0, 0.0,
            // block 0 -> block 1, input 0
            0.0, 1.0, 0.0,
        ]
    }

    #[test]
    fn transported_graph_compiles_and_reaches_the_analytical_energy() {
        let decoded = decode_graph_transport(&simple_energy_transport()).unwrap();
        let result = decoded.graph.simulate(decoded.settings).unwrap();
        assert!((result.last_value(1).unwrap() - 200.0).abs() < 1e-7);
        assert_eq!(result.summary.blocks, 2);
    }

    #[test]
    fn transport_rejects_wrong_versions_and_trailing_records() {
        let mut wrong_version = simple_energy_transport();
        wrong_version[1] = 2.0;
        assert_eq!(decode_graph_transport(&wrong_version).unwrap_err(), GraphTransportError::Malformed("version"));

        let mut trailing = simple_energy_transport();
        trailing.push(0.0);
        assert_eq!(decode_graph_transport(&trailing).unwrap_err(), GraphTransportError::Malformed("record length"));
    }

    #[test]
    fn wasm_handle_reports_success_and_trace_shape() {
        let input = simple_energy_transport();
        let handle = unsafe { bd_graph_simulate(input.as_ptr(), input.len()) };
        let mut meta = [0.0; GRAPH_RUN_META_LENGTH];
        assert_eq!(unsafe { bd_graph_run_meta(handle, meta.as_mut_ptr(), meta.len()) }, 1);
        assert_eq!(meta[0], 1.0);
        assert_eq!(meta[3], 2.0);
        let mut values = vec![0.0; meta[9] as usize];
        assert_eq!(unsafe { bd_graph_run_values(handle, values.as_mut_ptr(), values.len()) }, values.len());
        assert_eq!(values.len(), meta[2] as usize * 3);
        unsafe { bd_graph_run_free(handle) };
    }

    #[test]
    fn wasm_handle_returns_a_stable_compile_diagnostic() {
        let mut input = simple_energy_transport();
        input[17 + GRAPH_TRANSPORT_BLOCK_LENGTH + 3] = 4.0; // integrator now requires current
        let handle = unsafe { bd_graph_simulate(input.as_ptr(), input.len()) };
        let mut meta = [0.0; GRAPH_RUN_META_LENGTH];
        assert_eq!(unsafe { bd_graph_run_meta(handle, meta.as_mut_ptr(), meta.len()) }, 1);
        assert_eq!(meta[0], 0.0);
        assert_eq!(meta[1], 23.0);
        unsafe { bd_graph_run_free(handle) };
    }
}
