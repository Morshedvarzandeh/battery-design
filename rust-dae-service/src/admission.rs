//! Pure, source-only admission for a future isolated native DAE worker.
//!
//! This module decodes and preflights a request. It does not construct a
//! native backend, call FFI, start a process, or solve a system.

use crate::protocol::{
    F64BlockError, F64BlockWire, FrameDecoder, FrameKind, NativeDaeBackendWire,
    NativeDaeEventPolicyWire, NativeDaeRequestWire, ProtocolError, RequestF64Field,
};
use battery_design_core::dae::{DaeError, DaeResidualSystem};
use battery_design_core::equations::{CompiledGraph, IntegrationMethod, SolverSettings};
use battery_design_core::graph_transport::{
    decode_graph_transport, GraphTransportError, GRAPH_TRANSPORT_BLOCK_LENGTH,
    GRAPH_TRANSPORT_CONNECTION_LENGTH, GRAPH_TRANSPORT_HEADER_LENGTH, GRAPH_TRANSPORT_MAGIC,
    GRAPH_TRANSPORT_VERSION,
};
use battery_design_dae_native::{
    IdaAbsoluteTolerance, IdaError, IdaEventPolicy, IdaInitialConditionPolicy, IdaKluSettings,
    IdaSettings, MAX_DENSE_DIMENSION as NATIVE_MAX_DENSE_DIMENSION,
    MAX_EVENT_RESTARTS as NATIVE_MAX_EVENT_RESTARTS,
    MAX_INTERNAL_STEPS as NATIVE_MAX_INTERNAL_STEPS, MAX_KLU_DIMENSION as NATIVE_MAX_KLU_DIMENSION,
    MAX_KLU_JACOBIAN_ENTRY_WORK as NATIVE_MAX_KLU_JACOBIAN_ENTRY_WORK,
    MAX_KLU_JACOBIAN_EVALUATIONS as NATIVE_MAX_KLU_JACOBIAN_EVALUATIONS,
    MAX_KLU_KNOWN_CSC_BYTES as NATIVE_MAX_KLU_KNOWN_CSC_BYTES,
    MAX_KLU_NONZEROS as NATIVE_MAX_KLU_NONZEROS,
    MAX_KLU_RESULT_VALUES as NATIVE_MAX_KLU_RESULT_VALUES,
    MAX_OUTPUT_POINTS as NATIVE_MAX_OUTPUT_POINTS, MAX_RESULT_VALUES as NATIVE_MAX_RESULT_VALUES,
    NATIVE_IDA_BACKEND_ID, NATIVE_IDA_KLU_BACKEND_ID, REQUIRED_FEATURE, REQUIRED_KLU_FEATURE,
};
use serde::de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use std::collections::HashSet;
use std::fmt;

pub const MAX_GRAPH_TRANSPORT_VALUES: usize = 100_000;
pub const MAX_OUTPUT_ROWS: usize = 50_000;
pub const MAX_RESULT_VALUES: usize = 250_000;
pub const MAX_INTERNAL_STEPS: usize = 1_000_000;
pub const MAX_EVENT_RESTARTS: usize = 1_000;
pub const MAX_DENSE_DIMENSION: usize = 256;
pub const MAX_KLU_DIMENSION: usize = 10_000;
pub const MAX_KLU_NONZEROS: usize = 30_000;
pub const MAX_KLU_KNOWN_CSC_BYTES: usize = 720 * 1024;
pub const MAX_KLU_JACOBIAN_EVALUATIONS: u64 = 100_000;
pub const MAX_KLU_JACOBIAN_ENTRY_WORK: u64 = 1_000_000_000;
pub const MAX_SUM_FAN_IN: usize = 4_096;
pub const MAX_TOTAL_INPUT_SLOTS: usize = 100_000;
pub const MAX_ALGEBRAIC_ITERATIONS: usize = 100;
pub const MAX_IMPLICIT_ITERATIONS: usize = 100;
pub const MAX_CYCLIC_ALGEBRAIC_VARIABLES: usize = 256;

const CANONICAL_INITIAL_STEP_S: f64 = 0.01;
const CANONICAL_MIN_STEP_S: f64 = 1.0e-9;
const CANONICAL_MAX_STEP_S: f64 = 0.25;
const CANONICAL_IMPLICIT_TOLERANCE: f64 = 1.0e-10;

const _: () = {
    assert!(MAX_OUTPUT_ROWS <= NATIVE_MAX_OUTPUT_POINTS);
    assert!(MAX_RESULT_VALUES <= NATIVE_MAX_RESULT_VALUES);
    assert!(MAX_RESULT_VALUES <= NATIVE_MAX_KLU_RESULT_VALUES);
    assert!(MAX_INTERNAL_STEPS as u64 <= NATIVE_MAX_INTERNAL_STEPS);
    assert!(MAX_EVENT_RESTARTS <= NATIVE_MAX_EVENT_RESTARTS);
    assert!(MAX_DENSE_DIMENSION <= NATIVE_MAX_DENSE_DIMENSION);
    assert!(MAX_KLU_DIMENSION <= NATIVE_MAX_KLU_DIMENSION);
    assert!(MAX_KLU_NONZEROS <= NATIVE_MAX_KLU_NONZEROS);
    assert!(MAX_KLU_KNOWN_CSC_BYTES <= NATIVE_MAX_KLU_KNOWN_CSC_BYTES);
    assert!(MAX_KLU_JACOBIAN_EVALUATIONS <= NATIVE_MAX_KLU_JACOBIAN_EVALUATIONS);
    assert!(MAX_KLU_JACOBIAN_ENTRY_WORK <= NATIVE_MAX_KLU_JACOBIAN_ENTRY_WORK);
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionLimit {
    GraphTransportValues,
    OutputRows,
    ResultValues,
    InternalSteps,
    EventRestarts,
    DenseDimension,
    KluDimension,
    KluNonzeros,
    KluKnownCscBytes,
    SumFanIn,
    TotalInputSlots,
    AlgebraicIterations,
    ImplicitIterations,
    CyclicAlgebraicVariables,
    MaxOrder,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OutputGridError {
    Empty,
    NotAfterStart {
        index: usize,
        value: f64,
        start: f64,
    },
    NotStrictlyIncreasing {
        index: usize,
        previous: f64,
        value: f64,
    },
    DoesNotEndAtGraphEnd {
        actual: f64,
        required: f64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum AdmissionError {
    Protocol(ProtocolError),
    GraphTransport(GraphTransportError),
    Lowering(DaeError),
    NativePreflight {
        backend: NativeDaeBackendWire,
        source: IdaError,
    },
    LimitExceeded {
        limit: AdmissionLimit,
        actual: u128,
        maximum: u128,
        block_index: Option<usize>,
    },
    BelowMinimum {
        limit: AdmissionLimit,
        actual: u128,
        minimum: u128,
        block_index: Option<usize>,
    },
    WorkOverflow {
        limit: AdmissionLimit,
    },
    InvalidUtf8 {
        valid_up_to: usize,
        error_len: Option<usize>,
    },
    EncodedLengthMismatch {
        field: RequestF64Field,
        expected_encoded_bytes: usize,
        actual_encoded_bytes: usize,
    },
    OutputGrid(OutputGridError),
    NonNeutralGraphMethod {
        actual: IntegrationMethod,
    },
    NonCanonicalGraphSetting {
        field: &'static str,
        actual_bits: u64,
        required_bits: u64,
    },
}

impl fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "native DAE request admission failed: {self:?}")
    }
}

impl std::error::Error for AdmissionError {}

impl From<ProtocolError> for AdmissionError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeExecutionAvailability {
    Unavailable {
        backend: &'static str,
        required_feature: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum AdmittedNativeSettings {
    Dense(IdaSettings),
    Klu(IdaKluSettings),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdmissionAccounting {
    pub graph_transport_values: usize,
    pub output_rows: usize,
    pub result_values: usize,
    pub dimension: usize,
    pub nonzeros: usize,
    pub known_csc_bytes: usize,
    pub total_input_slots: usize,
    pub applied_jacobian_evaluations: u64,
}

#[derive(Debug)]
pub struct AdmittedDaePlan {
    graph: CompiledGraph,
    transport_settings: SolverSettings,
    native_settings: AdmittedNativeSettings,
    availability: NativeExecutionAvailability,
    accounting: AdmissionAccounting,
}

impl AdmittedDaePlan {
    pub fn graph(&self) -> &CompiledGraph {
        &self.graph
    }

    pub fn transport_settings(&self) -> &SolverSettings {
        &self.transport_settings
    }

    pub fn native_settings(&self) -> &AdmittedNativeSettings {
        &self.native_settings
    }

    pub fn availability(&self) -> NativeExecutionAvailability {
        self.availability
    }

    pub fn accounting(&self) -> AdmissionAccounting {
        self.accounting
    }

    pub fn relower(&self) -> Result<DaeResidualSystem<'_>, DaeError> {
        DaeResidualSystem::lower(
            &self.graph,
            self.transport_settings.start_s,
            &self.transport_settings,
        )
    }
}

pub fn admit_request_frame(frame: &[u8]) -> Result<AdmittedDaePlan, AdmissionError> {
    let request = decode_strict_request(frame)?;
    check_range(
        AdmissionLimit::MaxOrder,
        request.max_order as usize,
        1,
        5,
        None,
    )?;
    let event_policy = admitted_event_policy(request.event_policy.clone())?;
    check_declared_block(&request.graph_transport, RequestF64Field::GraphTransport)?;
    check_declared_block(&request.output_times, RequestF64Field::OutputTimes)?;
    let graph_values =
        decode_finite_block(&request.graph_transport, RequestF64Field::GraphTransport)?;
    let output_times = decode_finite_block(&request.output_times, RequestF64Field::OutputTimes)?;
    let shape = preflight_graph_transport(&graph_values, request.backend)?;
    let decoded = decode_graph_transport(&graph_values).map_err(AdmissionError::GraphTransport)?;
    check_transport_settings(&decoded.settings)?;
    validate_output_grid(
        &output_times,
        decoded.settings.start_s,
        decoded.settings.end_s,
    )?;

    let summary = decoded.graph.summary();
    if summary.has_algebraic_loop {
        check_limit(
            AdmissionLimit::CyclicAlgebraicVariables,
            summary.algebraic_variables,
            MAX_CYCLIC_ALGEBRAIC_VARIABLES,
            None,
        )?;
    }
    let result_values =
        output_times
            .len()
            .checked_mul(summary.blocks)
            .ok_or(AdmissionError::WorkOverflow {
                limit: AdmissionLimit::ResultValues,
            })?;
    check_limit(
        AdmissionLimit::ResultValues,
        result_values,
        MAX_RESULT_VALUES,
        None,
    )?;

    let system =
        DaeResidualSystem::lower(&decoded.graph, decoded.settings.start_s, &decoded.settings)
            .map_err(AdmissionError::Lowering)?;
    let dimension = system.variables().len();
    let nonzeros = system.csc_pattern().nonzero_count();
    let known_csc_bytes = IdaKluSettings::known_csc_bytes(dimension, nonzeros).ok_or(
        AdmissionError::WorkOverflow {
            limit: AdmissionLimit::KluKnownCscBytes,
        },
    )?;
    let max_steps =
        u64::try_from(decoded.settings.max_steps).map_err(|_| AdmissionError::WorkOverflow {
            limit: AdmissionLimit::InternalSteps,
        })?;

    let (native_settings, availability, applied_jacobian_evaluations) = match request.backend {
        NativeDaeBackendWire::Dense => {
            let settings = IdaSettings {
                initial_time_s: decoded.settings.start_s,
                output_times_s: output_times,
                relative_tolerance: decoded.settings.relative_tolerance,
                absolute_tolerance: IdaAbsoluteTolerance::Scalar(
                    decoded.settings.absolute_tolerance,
                ),
                max_order: request.max_order,
                max_steps,
                max_dense_dimension: MAX_DENSE_DIMENSION,
                suppress_algebraic_error: request.suppress_algebraic_error,
                initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
                event_policy,
            };
            settings
                .validate_for(&system)
                .map_err(|source| AdmissionError::NativePreflight {
                    backend: NativeDaeBackendWire::Dense,
                    source,
                })?;
            (
                AdmittedNativeSettings::Dense(settings),
                NativeExecutionAvailability::Unavailable {
                    backend: NATIVE_IDA_BACKEND_ID,
                    required_feature: REQUIRED_FEATURE,
                },
                0,
            )
        }
        NativeDaeBackendWire::Klu => {
            check_limit(
                AdmissionLimit::KluNonzeros,
                nonzeros,
                MAX_KLU_NONZEROS,
                None,
            )?;
            check_limit(
                AdmissionLimit::KluKnownCscBytes,
                known_csc_bytes,
                MAX_KLU_KNOWN_CSC_BYTES,
                None,
            )?;
            let nonzeros_u64 =
                u64::try_from(nonzeros).map_err(|_| AdmissionError::WorkOverflow {
                    limit: AdmissionLimit::KluNonzeros,
                })?;
            let applied_jacobian_evaluations = MAX_KLU_JACOBIAN_EVALUATIONS.min(
                MAX_KLU_JACOBIAN_ENTRY_WORK
                    .checked_div(nonzeros_u64)
                    .unwrap_or(0),
            );
            let settings = IdaKluSettings {
                initial_time_s: decoded.settings.start_s,
                output_times_s: output_times,
                relative_tolerance: decoded.settings.relative_tolerance,
                absolute_tolerance: IdaAbsoluteTolerance::Scalar(
                    decoded.settings.absolute_tolerance,
                ),
                max_order: request.max_order,
                max_steps,
                max_dimension: MAX_KLU_DIMENSION,
                max_nonzeros: MAX_KLU_NONZEROS,
                max_known_csc_bytes: MAX_KLU_KNOWN_CSC_BYTES,
                max_jacobian_evaluations: applied_jacobian_evaluations,
                max_jacobian_entry_work: MAX_KLU_JACOBIAN_ENTRY_WORK,
                max_result_values: MAX_RESULT_VALUES,
                suppress_algebraic_error: request.suppress_algebraic_error,
                initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
                event_policy,
            };
            settings
                .validate_for(&system)
                .map_err(|source| AdmissionError::NativePreflight {
                    backend: NativeDaeBackendWire::Klu,
                    source,
                })?;
            (
                AdmittedNativeSettings::Klu(settings),
                NativeExecutionAvailability::Unavailable {
                    backend: NATIVE_IDA_KLU_BACKEND_ID,
                    required_feature: REQUIRED_KLU_FEATURE,
                },
                applied_jacobian_evaluations,
            )
        }
    };
    drop(system);

    Ok(AdmittedDaePlan {
        graph: decoded.graph,
        transport_settings: decoded.settings,
        native_settings,
        availability,
        accounting: AdmissionAccounting {
            graph_transport_values: graph_values.len(),
            output_rows: request.output_times.count as usize,
            result_values,
            dimension,
            nonzeros,
            known_csc_bytes,
            total_input_slots: shape.total_input_slots,
            applied_jacobian_evaluations,
        },
    })
}

fn decode_strict_request(frame: &[u8]) -> Result<NativeDaeRequestWire, AdmissionError> {
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    decoder
        .push(frame)
        .map_err(|error| ProtocolError::Frame(error))?;
    let payload = decoder
        .finish()
        .map_err(|error| ProtocolError::Frame(error))?;
    let text = std::str::from_utf8(&payload).map_err(|error| AdmissionError::InvalidUtf8 {
        valid_up_to: error.valid_up_to(),
        error_len: error.error_len(),
    })?;
    let mut duplicate_check = serde_json::Deserializer::from_str(text);
    NoDuplicateValue
        .deserialize(&mut duplicate_check)
        .map_err(|error| ProtocolError::Json(error.to_string()))?;
    duplicate_check
        .end()
        .map_err(|error| ProtocolError::Json(error.to_string()))?;
    serde_json::from_str(text)
        .map_err(|error| ProtocolError::Json(error.to_string()))
        .map_err(Into::into)
}

struct NoDuplicateValue;

impl<'de> DeserializeSeed<'de> for NoDuplicateValue {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(NoDuplicateVisitor)
    }
}

struct NoDuplicateVisitor;

impl<'de> Visitor<'de> for NoDuplicateVisitor {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("one JSON value with unique object keys")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        NoDuplicateValue.deserialize(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element_seed(NoDuplicateValue)?.is_some() {}
        Ok(())
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(A::Error::custom(format!(
                    "duplicate JSON object key {key:?}"
                )));
            }
            map.next_value_seed(NoDuplicateValue)?;
        }
        Ok(())
    }
}

fn check_declared_block(
    block: &F64BlockWire,
    field: RequestF64Field,
) -> Result<(), AdmissionError> {
    let (limit, maximum) = match field {
        RequestF64Field::GraphTransport => (
            AdmissionLimit::GraphTransportValues,
            MAX_GRAPH_TRANSPORT_VALUES,
        ),
        RequestF64Field::OutputTimes => (AdmissionLimit::OutputRows, MAX_OUTPUT_ROWS),
    };
    check_range(limit, block.count as usize, 1, maximum, None)?;
    let raw_bytes = (block.count as usize)
        .checked_mul(std::mem::size_of::<f64>())
        .ok_or(AdmissionError::WorkOverflow { limit })?;
    let encoded_bytes = raw_bytes
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .ok_or(AdmissionError::WorkOverflow { limit })?;
    if block.data.len() != encoded_bytes {
        return Err(AdmissionError::EncodedLengthMismatch {
            field,
            expected_encoded_bytes: encoded_bytes,
            actual_encoded_bytes: block.data.len(),
        });
    }
    Ok(())
}

fn decode_finite_block(
    block: &F64BlockWire,
    field: RequestF64Field,
) -> Result<Vec<f64>, AdmissionError> {
    let values = block
        .decode_values()
        .map_err(|source| ProtocolError::InvalidF64Block { field, source })?;
    if let Some(index) = values.iter().position(|value| !value.is_finite()) {
        return Err(ProtocolError::InvalidF64Block {
            field,
            source: F64BlockError::NonFiniteValue { index },
        }
        .into());
    }
    Ok(values)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GraphShape {
    total_input_slots: usize,
}

fn preflight_graph_transport(
    values: &[f64],
    backend: NativeDaeBackendWire,
) -> Result<GraphShape, AdmissionError> {
    if values.len() < GRAPH_TRANSPORT_HEADER_LENGTH {
        return Err(AdmissionError::GraphTransport(
            GraphTransportError::Malformed("header length"),
        ));
    }
    if transport_integer(values[0], "magic")? as u64 != GRAPH_TRANSPORT_MAGIC {
        return Err(AdmissionError::GraphTransport(
            GraphTransportError::Malformed("magic"),
        ));
    }
    if transport_integer(values[1], "version")? != GRAPH_TRANSPORT_VERSION {
        return Err(AdmissionError::GraphTransport(
            GraphTransportError::Malformed("version"),
        ));
    }
    let block_count = transport_integer(values[2], "block count")?;
    let connection_count = transport_integer(values[3], "connection count")?;
    let method = transport_integer(values[4], "integration method")?;
    if method != 0 {
        let actual = match method {
            1 => IntegrationMethod::DormandPrince45,
            2 => IntegrationMethod::BackwardEuler,
            _ => {
                return Err(AdmissionError::GraphTransport(
                    GraphTransportError::Malformed("integration method"),
                ))
            }
        };
        return Err(AdmissionError::NonNeutralGraphMethod { actual });
    }
    match backend {
        NativeDaeBackendWire::Dense => check_range(
            AdmissionLimit::DenseDimension,
            block_count,
            1,
            MAX_DENSE_DIMENSION,
            None,
        )?,
        NativeDaeBackendWire::Klu => check_range(
            AdmissionLimit::KluDimension,
            block_count,
            1,
            MAX_KLU_DIMENSION,
            None,
        )?,
    }
    let expected = GRAPH_TRANSPORT_HEADER_LENGTH
        .checked_add(
            block_count
                .checked_mul(GRAPH_TRANSPORT_BLOCK_LENGTH)
                .ok_or(AdmissionError::GraphTransport(
                    GraphTransportError::Malformed("block count"),
                ))?,
        )
        .and_then(|length| {
            connection_count
                .checked_mul(GRAPH_TRANSPORT_CONNECTION_LENGTH)
                .and_then(|connections| length.checked_add(connections))
        })
        .ok_or(AdmissionError::GraphTransport(
            GraphTransportError::Malformed("record length"),
        ))?;
    if values.len() != expected {
        return Err(AdmissionError::GraphTransport(
            GraphTransportError::Malformed("record length"),
        ));
    }
    let mut total_input_slots = 0_usize;
    for block_index in 0..block_count {
        let start = GRAPH_TRANSPORT_HEADER_LENGTH + block_index * GRAPH_TRANSPORT_BLOCK_LENGTH;
        let record = &values[start..start + GRAPH_TRANSPORT_BLOCK_LENGTH];
        let kind = transport_integer(record[0], "block kind")?;
        let inputs = match kind {
            0 | 1 => 0,
            2 | 5 | 6 | 7 => 1,
            3 => {
                let fan_in = transport_integer(record[2], "sum input count")?;
                check_range(
                    AdmissionLimit::SumFanIn,
                    fan_in,
                    1,
                    MAX_SUM_FAN_IN,
                    Some(block_index),
                )?;
                fan_in
            }
            4 => 2,
            8 => 3,
            _ => {
                return Err(AdmissionError::GraphTransport(
                    GraphTransportError::Malformed("block kind"),
                ))
            }
        };
        total_input_slots =
            total_input_slots
                .checked_add(inputs)
                .ok_or(AdmissionError::WorkOverflow {
                    limit: AdmissionLimit::TotalInputSlots,
                })?;
        check_range(
            AdmissionLimit::TotalInputSlots,
            total_input_slots,
            0,
            MAX_TOTAL_INPUT_SLOTS,
            None,
        )?;
    }
    Ok(GraphShape { total_input_slots })
}

fn transport_integer(value: f64, name: &'static str) -> Result<usize, AdmissionError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > usize::MAX as f64 {
        return Err(AdmissionError::GraphTransport(
            GraphTransportError::Malformed(name),
        ));
    }
    Ok(value as usize)
}

fn check_transport_settings(settings: &SolverSettings) -> Result<(), AdmissionError> {
    if settings.method != IntegrationMethod::Auto {
        return Err(AdmissionError::NonNeutralGraphMethod {
            actual: settings.method,
        });
    }
    for (field, actual, required) in [
        (
            "initial_step_s",
            settings.initial_step_s,
            CANONICAL_INITIAL_STEP_S,
        ),
        ("min_step_s", settings.min_step_s, CANONICAL_MIN_STEP_S),
        ("max_step_s", settings.max_step_s, CANONICAL_MAX_STEP_S),
        (
            "implicit_tolerance",
            settings.implicit_tolerance,
            CANONICAL_IMPLICIT_TOLERANCE,
        ),
    ] {
        if actual.to_bits() != required.to_bits() {
            return Err(AdmissionError::NonCanonicalGraphSetting {
                field,
                actual_bits: actual.to_bits(),
                required_bits: required.to_bits(),
            });
        }
    }
    check_range(
        AdmissionLimit::InternalSteps,
        settings.max_steps,
        1,
        MAX_INTERNAL_STEPS,
        None,
    )?;
    check_range(
        AdmissionLimit::AlgebraicIterations,
        settings.algebraic_max_iterations,
        1,
        MAX_ALGEBRAIC_ITERATIONS,
        None,
    )?;
    check_range(
        AdmissionLimit::ImplicitIterations,
        settings.implicit_max_iterations,
        1,
        MAX_IMPLICIT_ITERATIONS,
        None,
    )
}

fn validate_output_grid(output_times: &[f64], start: f64, end: f64) -> Result<(), AdmissionError> {
    let first = *output_times
        .first()
        .ok_or(AdmissionError::OutputGrid(OutputGridError::Empty))?;
    if first <= start {
        return Err(AdmissionError::OutputGrid(OutputGridError::NotAfterStart {
            index: 0,
            value: first,
            start,
        }));
    }
    for (index, pair) in output_times.windows(2).enumerate() {
        if pair[1] <= pair[0] {
            return Err(AdmissionError::OutputGrid(
                OutputGridError::NotStrictlyIncreasing {
                    index: index + 1,
                    previous: pair[0],
                    value: pair[1],
                },
            ));
        }
    }
    let last = *output_times.last().expect("the output grid is nonempty");
    if last.to_bits() != end.to_bits() {
        return Err(AdmissionError::OutputGrid(
            OutputGridError::DoesNotEndAtGraphEnd {
                actual: last,
                required: end,
            },
        ));
    }
    Ok(())
}

fn admitted_event_policy(
    policy: NativeDaeEventPolicyWire,
) -> Result<IdaEventPolicy, AdmissionError> {
    match policy {
        NativeDaeEventPolicyWire::Reject => Ok(IdaEventPolicy::Reject),
        NativeDaeEventPolicyWire::Restart { max_restarts } => {
            check_limit(
                AdmissionLimit::EventRestarts,
                max_restarts as usize,
                MAX_EVENT_RESTARTS,
                None,
            )?;
            Ok(IdaEventPolicy::Restart {
                max_restarts: max_restarts as usize,
            })
        }
    }
}

fn check_limit(
    limit: AdmissionLimit,
    actual: usize,
    maximum: usize,
    block_index: Option<usize>,
) -> Result<(), AdmissionError> {
    if actual > maximum {
        Err(AdmissionError::LimitExceeded {
            limit,
            actual: actual as u128,
            maximum: maximum as u128,
            block_index,
        })
    } else {
        Ok(())
    }
}

fn check_range(
    limit: AdmissionLimit,
    actual: usize,
    minimum: usize,
    maximum: usize,
    block_index: Option<usize>,
) -> Result<(), AdmissionError> {
    if actual < minimum {
        return Err(AdmissionError::BelowMinimum {
            limit,
            actual: actual as u128,
            minimum: minimum as u128,
            block_index,
        });
    }
    check_limit(limit, actual, maximum, block_index)
}
