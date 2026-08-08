use battery_design_core::equations::{EquationError, SolverSettings};
use battery_design_core::graph_transport::{
    GraphTransportError, GRAPH_TRANSPORT_BLOCK_LENGTH, GRAPH_TRANSPORT_MAGIC,
    GRAPH_TRANSPORT_VERSION,
};
use battery_design_dae_native::{
    IdaEventPolicy, NATIVE_IDA_BACKEND_ID, NATIVE_IDA_KLU_BACKEND_ID, REQUIRED_FEATURE,
    REQUIRED_KLU_FEATURE,
};
use battery_design_dae_service::admission::{
    admit_request_frame, AdmissionError, AdmissionLimit, AdmittedDaePlan, AdmittedNativeSettings,
    NativeExecutionAvailability, OutputGridError, MAX_ALGEBRAIC_ITERATIONS,
    MAX_CYCLIC_ALGEBRAIC_VARIABLES, MAX_DENSE_DIMENSION, MAX_EVENT_RESTARTS,
    MAX_GRAPH_TRANSPORT_VALUES, MAX_IMPLICIT_ITERATIONS, MAX_INTERNAL_STEPS, MAX_KLU_DIMENSION,
    MAX_KLU_JACOBIAN_ENTRY_WORK, MAX_KLU_JACOBIAN_EVALUATIONS, MAX_KLU_KNOWN_CSC_BYTES,
    MAX_KLU_NONZEROS, MAX_OUTPUT_ROWS, MAX_RESULT_VALUES, MAX_SUM_FAN_IN, MAX_TOTAL_INPUT_SLOTS,
};
use battery_design_dae_service::protocol::{
    encode_frame, encode_request_frame, F64BlockWire, FrameDecoder, FrameError, FrameKind,
    NativeDaeBackendWire, NativeDaeEventPolicyWire, NativeDaeRequestFormatWire,
    NativeDaeRequestWire, ProtocolError, RequestF64Field, FRAME_HEADER_BYTES,
    MAX_FRAME_PAYLOAD_BYTES, REQUEST_FRAME_MAGIC,
};

fn graph_header(blocks: usize, connections: usize) -> Vec<f64> {
    let defaults = SolverSettings::default();
    vec![
        GRAPH_TRANSPORT_MAGIC as f64,
        GRAPH_TRANSPORT_VERSION as f64,
        blocks as f64,
        connections as f64,
        0.0,
        defaults.start_s,
        1.0,
        defaults.initial_step_s,
        defaults.min_step_s,
        defaults.max_step_s,
        defaults.relative_tolerance,
        defaults.absolute_tolerance,
        defaults.max_steps as f64,
        defaults.algebraic_tolerance,
        defaults.algebraic_max_iterations as f64,
        defaults.implicit_tolerance,
        defaults.implicit_max_iterations as f64,
    ]
}

fn constant_record(value: f64) -> [f64; GRAPH_TRANSPORT_BLOCK_LENGTH] {
    [0.0, 0.0, value, 0.0, 0.0, 0.0]
}

fn gain_record(gain: f64) -> [f64; GRAPH_TRANSPORT_BLOCK_LENGTH] {
    [2.0, 0.0, gain, 0.0, 0.0, 0.0]
}

fn sum_record(inputs: usize) -> [f64; GRAPH_TRANSPORT_BLOCK_LENGTH] {
    [3.0, 0.0, inputs as f64, 0.0, 0.0, 0.0]
}

fn constant_graph(blocks: usize) -> Vec<f64> {
    let mut values = graph_header(blocks, 0);
    for index in 0..blocks {
        values.extend_from_slice(&constant_record(index as f64));
    }
    values
}

fn cyclic_gain_graph(blocks: usize) -> Vec<f64> {
    let mut values = graph_header(blocks, blocks);
    for _ in 0..blocks {
        values.extend_from_slice(&gain_record(0.0));
    }
    for target in 0..blocks {
        values.extend_from_slice(&[((target + blocks - 1) % blocks) as f64, target as f64, 0.0]);
    }
    values
}

fn bipartite_graph(constants: usize, sums: usize, edges: usize) -> Vec<f64> {
    assert!(constants > 0 && sums > 0);
    assert!(edges >= sums && edges <= constants * sums);
    let mut fan_ins = vec![edges / sums; sums];
    for fan_in in fan_ins.iter_mut().take(edges % sums) {
        *fan_in += 1;
    }
    assert!(fan_ins
        .iter()
        .all(|count| *count > 0 && *count <= constants));

    let mut values = graph_header(constants + sums, edges);
    for index in 0..constants {
        values.extend_from_slice(&constant_record(index as f64));
    }
    for &fan_in in &fan_ins {
        values.extend_from_slice(&sum_record(fan_in));
    }
    for (sum_index, fan_in) in fan_ins.into_iter().enumerate() {
        for source in 0..fan_in {
            values.extend_from_slice(&[
                source as f64,
                (constants + sum_index) as f64,
                source as f64,
            ]);
        }
    }
    assert!(values.len() <= MAX_GRAPH_TRANSPORT_VALUES);
    values
}

fn graph_with_declared_sums(fan_ins: &[usize]) -> Vec<f64> {
    let mut values = graph_header(fan_ins.len(), 0);
    for &fan_in in fan_ins {
        values.extend_from_slice(&sum_record(fan_in));
    }
    values
}

fn request(
    backend: NativeDaeBackendWire,
    graph: Vec<f64>,
    output_times: Vec<f64>,
) -> NativeDaeRequestWire {
    NativeDaeRequestWire {
        format: NativeDaeRequestFormatWire::V1,
        backend,
        graph_transport: F64BlockWire::from_values(&graph).expect("graph block"),
        output_times: F64BlockWire::from_values(&output_times).expect("output block"),
        max_order: 5,
        suppress_algebraic_error: true,
        event_policy: NativeDaeEventPolicyWire::Reject,
    }
}

fn unchecked_frame(request: &NativeDaeRequestWire) -> Vec<u8> {
    let payload = serde_json::to_vec(request).expect("serialize request wire");
    encode_frame(FrameKind::Request, &payload).expect("frame request payload")
}

fn admitted(
    backend: NativeDaeBackendWire,
    graph: Vec<f64>,
    output_times: Vec<f64>,
) -> Result<AdmittedDaePlan, AdmissionError> {
    let frame =
        encode_request_frame(&request(backend, graph, output_times)).expect("request frame");
    admit_request_frame(&frame)
}

fn raw_json_frame(payload: &[u8]) -> Vec<u8> {
    encode_frame(FrameKind::Request, payload).expect("raw request frame")
}

fn assert_limit(error: AdmissionError, limit: AdmissionLimit, actual: usize, maximum: usize) {
    assert!(matches!(
        error,
        AdmissionError::LimitExceeded {
            limit: actual_limit,
            actual: actual_value,
            maximum: actual_maximum,
            ..
        } if actual_limit == limit
            && actual_value == actual as u128
            && actual_maximum == maximum as u128
    ));
}

#[test]
fn admission_invalid_utf8_is_rejected_before_request_construction() {
    let invalid = raw_json_frame(&[b'{', b'"', b'x', b'"', b':', 0xff, b'}']);
    assert_eq!(
        admit_request_frame(&invalid).unwrap_err(),
        AdmissionError::InvalidUtf8 {
            valid_up_to: 5,
            error_len: Some(1),
        },
    );

    fn move_owned(plan: AdmittedDaePlan) -> AdmittedDaePlan {
        plan
    }
    let plan = move_owned(
        admitted(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0])
            .expect("valid owned plan"),
    );
    assert_eq!(
        plan.relower()
            .expect("relower moved plan")
            .variables()
            .len(),
        1
    );
}

#[test]
fn admission_malformed_or_trailing_json_is_rejected_atomically() {
    for payload in [
        b"{".as_slice(),
        b"[] {}".as_slice(),
        b"null trailing".as_slice(),
    ] {
        assert!(matches!(
            admit_request_frame(&raw_json_frame(payload)),
            Err(AdmissionError::Protocol(ProtocolError::Json(_)))
        ));
    }

    let canonical = request(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0]);
    let mut trailing = serde_json::to_vec(&canonical).expect("canonical JSON");
    trailing.extend_from_slice(b" []");
    assert!(matches!(
        admit_request_frame(&raw_json_frame(&trailing)),
        Err(AdmissionError::Protocol(ProtocolError::Json(_)))
    ));
}

#[test]
fn admission_duplicate_keys_and_unknown_fields_fail_closed() {
    let canonical = request(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0]);
    let json = serde_json::to_string(&canonical).expect("canonical JSON");
    let top_duplicate = json.replacen("\"maxOrder\":5", "\"maxOrder\":5,\"maxOrder\":5", 1);
    let nested_duplicate = json.replacen("\"count\":23", "\"count\":23,\"count\":23", 1);
    for duplicate in [top_duplicate, nested_duplicate] {
        assert!(matches!(
            admit_request_frame(&raw_json_frame(duplicate.as_bytes())),
            Err(AdmissionError::Protocol(ProtocolError::Json(ref message)))
                if message.contains("duplicate JSON object key")
        ));
    }

    for field in [
        "wallTimeMs",
        "cpuSeconds",
        "memoryBytes",
        "maxGraphTransportValues",
        "maxDenseDimension",
        "maxKluNonzeros",
    ] {
        let mut value = serde_json::to_value(&canonical).expect("request value");
        value
            .as_object_mut()
            .expect("request object")
            .insert(field.to_string(), serde_json::json!(u64::MAX));
        let payload = serde_json::to_vec(&value).expect("unknown-field JSON");
        assert!(matches!(
            admit_request_frame(&raw_json_frame(&payload)),
            Err(AdmissionError::Protocol(ProtocolError::Json(_)))
        ));
    }
}

#[test]
fn admission_missing_or_mismatched_contract_identity_fails_closed() {
    let canonical = request(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0]);
    let mut missing = serde_json::to_value(&canonical).expect("request value");
    missing
        .as_object_mut()
        .expect("request object")
        .remove("format");
    assert!(matches!(
        admit_request_frame(&raw_json_frame(
            &serde_json::to_vec(&missing).expect("missing-format JSON")
        )),
        Err(AdmissionError::Protocol(ProtocolError::Json(_)))
    ));

    let mismatched = serde_json::to_string(&canonical)
        .expect("request JSON")
        .replace(
            "battery-design/native-dae-request@1",
            "battery-design/native-dae-request@2",
        );
    assert!(matches!(
        admit_request_frame(&raw_json_frame(mismatched.as_bytes())),
        Err(AdmissionError::Protocol(ProtocolError::Json(_)))
    ));

    for (index, expected) in [(0, "magic"), (1, "version")] {
        let mut graph = constant_graph(1);
        graph[index] += 1.0;
        assert_eq!(
            admitted(NativeDaeBackendWire::Dense, graph, vec![1.0]).unwrap_err(),
            AdmissionError::GraphTransport(GraphTransportError::Malformed(expected)),
        );
    }
    for method in [1.0, 2.0] {
        let mut graph = constant_graph(1);
        graph[4] = method;
        assert!(matches!(
            admitted(NativeDaeBackendWire::Dense, graph, vec![1.0]),
            Err(AdmissionError::NonNeutralGraphMethod { .. })
        ));
    }
}

#[test]
fn admission_request_byte_limit_reaches_decode_exactly_and_plus_one_fails_preallocation() {
    let exact_payload = vec![b' '; MAX_FRAME_PAYLOAD_BYTES];
    let exact_frame = raw_json_frame(&exact_payload);
    assert!(matches!(
        admit_request_frame(&exact_frame),
        Err(AdmissionError::Protocol(ProtocolError::Json(_)))
    ));

    let declared = u32::try_from(MAX_FRAME_PAYLOAD_BYTES + 1).expect("frame cap fits u32");
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    header[..4].copy_from_slice(&REQUEST_FRAME_MAGIC);
    header[4..].copy_from_slice(&declared.to_le_bytes());
    assert_eq!(
        admit_request_frame(&header).unwrap_err(),
        AdmissionError::Protocol(ProtocolError::Frame(FrameError::PayloadTooLarge {
            declared: MAX_FRAME_PAYLOAD_BYTES + 1,
            maximum: MAX_FRAME_PAYLOAD_BYTES,
        })),
    );
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert!(matches!(
        decoder.push(&header),
        Err(FrameError::PayloadTooLarge { .. })
    ));
    assert_eq!(decoder.buffered_payload_capacity(), 0);

    let mut tiny_count = request(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0]);
    tiny_count.graph_transport.count = 1;
    tiny_count.graph_transport.data = "A".repeat(MAX_FRAME_PAYLOAD_BYTES / 2);
    assert_eq!(
        admit_request_frame(&unchecked_frame(&tiny_count)).unwrap_err(),
        AdmissionError::EncodedLengthMismatch {
            field: RequestF64Field::GraphTransport,
            expected_encoded_bytes: 12,
            actual_encoded_bytes: MAX_FRAME_PAYLOAD_BYTES / 2,
        },
    );

    for (field, count, limit) in [
        (
            RequestF64Field::GraphTransport,
            MAX_GRAPH_TRANSPORT_VALUES + 1,
            AdmissionLimit::GraphTransportValues,
        ),
        (
            RequestF64Field::OutputTimes,
            MAX_OUTPUT_ROWS + 1,
            AdmissionLimit::OutputRows,
        ),
    ] {
        let mut over = request(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0]);
        let block = match field {
            RequestF64Field::GraphTransport => &mut over.graph_transport,
            RequestF64Field::OutputTimes => &mut over.output_times,
        };
        block.count = count as u32;
        block.data.clear();
        assert_limit(
            admit_request_frame(&unchecked_frame(&over)).unwrap_err(),
            limit,
            count,
            count - 1,
        );
    }
}

#[test]
fn admission_dense_dimension_limit_passes_exactly_and_plus_one_fails() {
    let plan = admitted(
        NativeDaeBackendWire::Dense,
        constant_graph(MAX_DENSE_DIMENSION),
        vec![1.0],
    )
    .expect("exact dense dimension");
    assert_eq!(plan.accounting().dimension, MAX_DENSE_DIMENSION);
    assert_eq!(plan.accounting().result_values, MAX_DENSE_DIMENSION);
    assert_eq!(
        plan.availability(),
        NativeExecutionAvailability::Unavailable {
            backend: NATIVE_IDA_BACKEND_ID,
            required_feature: REQUIRED_FEATURE,
        },
    );
    assert!(matches!(
        plan.native_settings(),
        AdmittedNativeSettings::Dense(_)
    ));
    assert_eq!(
        plan.relower()
            .expect("relower dense boundary")
            .variables()
            .len(),
        MAX_DENSE_DIMENSION
    );

    let over = graph_header(MAX_DENSE_DIMENSION + 1, 0);
    assert_limit(
        admitted(NativeDaeBackendWire::Dense, over, vec![1.0]).unwrap_err(),
        AdmissionLimit::DenseDimension,
        MAX_DENSE_DIMENSION + 1,
        MAX_DENSE_DIMENSION,
    );
    let empty = graph_header(0, 0);
    assert!(matches!(
        admitted(NativeDaeBackendWire::Dense, empty, vec![1.0]),
        Err(AdmissionError::BelowMinimum {
            limit: AdmissionLimit::DenseDimension,
            actual: 0,
            minimum: 1,
            ..
        })
    ));
}

#[test]
fn admission_klu_dimension_nonzero_and_known_csc_limits_are_independent() {
    let scale = admitted(
        NativeDaeBackendWire::Klu,
        constant_graph(MAX_KLU_DIMENSION),
        vec![1.0],
    )
    .expect("acyclic exact KLU dimension");
    assert_eq!(scale.accounting().dimension, MAX_KLU_DIMENSION);
    assert_eq!(scale.accounting().nonzeros, MAX_KLU_DIMENSION);
    assert_eq!(
        scale.accounting().applied_jacobian_evaluations,
        MAX_KLU_JACOBIAN_EVALUATIONS
    );
    assert_eq!(
        scale.availability(),
        NativeExecutionAvailability::Unavailable {
            backend: NATIVE_IDA_KLU_BACKEND_ID,
            required_feature: REQUIRED_KLU_FEATURE,
        },
    );
    assert!(matches!(
        scale.native_settings(),
        AdmittedNativeSettings::Klu(_)
    ));

    assert_limit(
        admitted(
            NativeDaeBackendWire::Klu,
            graph_header(MAX_KLU_DIMENSION + 1, 0),
            vec![1.0],
        )
        .unwrap_err(),
        AdmissionLimit::KluDimension,
        MAX_KLU_DIMENSION + 1,
        MAX_KLU_DIMENSION,
    );

    let exact_nonzeros = admitted(
        NativeDaeBackendWire::Klu,
        bipartite_graph(175, 175, 29_650),
        vec![1.0],
    )
    .expect("exact KLU nonzero boundary");
    assert_eq!(exact_nonzeros.accounting().nonzeros, MAX_KLU_NONZEROS);
    assert!(exact_nonzeros.accounting().known_csc_bytes < MAX_KLU_KNOWN_CSC_BYTES);
    assert_eq!(
        exact_nonzeros.accounting().applied_jacobian_evaluations,
        MAX_KLU_JACOBIAN_ENTRY_WORK / MAX_KLU_NONZEROS as u64,
    );
    assert_limit(
        admitted(
            NativeDaeBackendWire::Klu,
            bipartite_graph(175, 175, 29_651),
            vec![1.0],
        )
        .unwrap_err(),
        AdmissionLimit::KluNonzeros,
        MAX_KLU_NONZEROS + 1,
        MAX_KLU_NONZEROS,
    );

    let exact_known = admitted(
        NativeDaeBackendWire::Klu,
        bipartite_graph(1_501, 1_501, 26_717),
        vec![1.0],
    )
    .expect("exact known-CSC byte boundary");
    assert_eq!(exact_known.accounting().nonzeros, 29_719);
    assert_eq!(
        exact_known.accounting().known_csc_bytes,
        MAX_KLU_KNOWN_CSC_BYTES
    );
    assert_limit(
        admitted(
            NativeDaeBackendWire::Klu,
            bipartite_graph(1_500, 1_500, 26_800),
            vec![1.0],
        )
        .unwrap_err(),
        AdmissionLimit::KluKnownCscBytes,
        739_208,
        MAX_KLU_KNOWN_CSC_BYTES,
    );
}

#[test]
fn admission_output_row_and_result_value_limits_are_independent() {
    let outputs = (1..=MAX_OUTPUT_ROWS)
        .map(|index| index as f64 / MAX_OUTPUT_ROWS as f64)
        .collect::<Vec<_>>();
    let exact = admitted(NativeDaeBackendWire::Dense, constant_graph(5), outputs)
        .expect("exact output and result boundaries");
    assert_eq!(exact.accounting().output_rows, MAX_OUTPUT_ROWS);
    assert_eq!(exact.accounting().result_values, MAX_RESULT_VALUES);

    let over_rows = (1..=MAX_OUTPUT_ROWS + 1)
        .map(|index| index as f64 / (MAX_OUTPUT_ROWS + 1) as f64)
        .collect::<Vec<_>>();
    assert_limit(
        admitted(NativeDaeBackendWire::Dense, constant_graph(1), over_rows).unwrap_err(),
        AdmissionLimit::OutputRows,
        MAX_OUTPUT_ROWS + 1,
        MAX_OUTPUT_ROWS,
    );

    let over_values = (1..=41_667)
        .map(|index| index as f64 / 41_667.0)
        .collect::<Vec<_>>();
    assert_limit(
        admitted(NativeDaeBackendWire::Dense, constant_graph(6), over_values).unwrap_err(),
        AdmissionLimit::ResultValues,
        250_002,
        MAX_RESULT_VALUES,
    );

    for (outputs, expected) in [
        (
            vec![0.0, 1.0],
            OutputGridError::NotAfterStart {
                index: 0,
                value: 0.0,
                start: 0.0,
            },
        ),
        (
            vec![0.5, 0.5, 1.0],
            OutputGridError::NotStrictlyIncreasing {
                index: 1,
                previous: 0.5,
                value: 0.5,
            },
        ),
        (
            vec![0.5, f64::from_bits(1.0_f64.to_bits() - 1)],
            OutputGridError::DoesNotEndAtGraphEnd {
                actual: f64::from_bits(1.0_f64.to_bits() - 1),
                required: 1.0,
            },
        ),
    ] {
        assert_eq!(
            admitted(NativeDaeBackendWire::Dense, constant_graph(1), outputs).unwrap_err(),
            AdmissionError::OutputGrid(expected),
        );
    }
    let mut signed_zero_end = constant_graph(1);
    signed_zero_end[5] = -1.0;
    signed_zero_end[6] = -0.0;
    assert_eq!(
        admitted(NativeDaeBackendWire::Dense, signed_zero_end, vec![0.0]).unwrap_err(),
        AdmissionError::OutputGrid(OutputGridError::DoesNotEndAtGraphEnd {
            actual: 0.0,
            required: -0.0,
        }),
    );
}

#[test]
fn admission_sum_fan_in_and_total_input_slot_limits_fail_preallocation() {
    let mut exact_sum = graph_header(2, MAX_SUM_FAN_IN);
    exact_sum.extend_from_slice(&constant_record(1.0));
    exact_sum.extend_from_slice(&sum_record(MAX_SUM_FAN_IN));
    for port in 0..MAX_SUM_FAN_IN {
        exact_sum.extend_from_slice(&[0.0, 1.0, port as f64]);
    }
    let exact_sum_plan = admitted(NativeDaeBackendWire::Dense, exact_sum, vec![1.0])
        .expect("exact Sum fan-in boundary");
    assert_eq!(
        exact_sum_plan.accounting().total_input_slots,
        MAX_SUM_FAN_IN
    );

    assert_limit(
        admitted(
            NativeDaeBackendWire::Dense,
            graph_with_declared_sums(&[MAX_SUM_FAN_IN + 1]),
            vec![1.0],
        )
        .unwrap_err(),
        AdmissionLimit::SumFanIn,
        MAX_SUM_FAN_IN + 1,
        MAX_SUM_FAN_IN,
    );

    let exact_slots = graph_with_declared_sums(&[4_000; 25]);
    assert!(matches!(
        admitted(NativeDaeBackendWire::Klu, exact_slots, vec![1.0]),
        Err(AdmissionError::GraphTransport(
            GraphTransportError::Equation(EquationError::MissingInput { .. })
        ))
    ));
    let mut over_fan_ins = vec![MAX_SUM_FAN_IN; 24];
    over_fan_ins.push(1_697);
    assert_limit(
        admitted(
            NativeDaeBackendWire::Klu,
            graph_with_declared_sums(&over_fan_ins),
            vec![1.0],
        )
        .unwrap_err(),
        AdmissionLimit::TotalInputSlots,
        MAX_TOTAL_INPUT_SLOTS + 1,
        MAX_TOTAL_INPUT_SLOTS,
    );

    let exact_cycle = cyclic_gain_graph(MAX_CYCLIC_ALGEBRAIC_VARIABLES);
    let exact_cycle_plan = admitted(NativeDaeBackendWire::Klu, exact_cycle, vec![1.0])
        .expect("exact cyclic initialization boundary");
    assert_eq!(
        exact_cycle_plan.accounting().dimension,
        MAX_CYCLIC_ALGEBRAIC_VARIABLES
    );
    assert_limit(
        admitted(
            NativeDaeBackendWire::Klu,
            cyclic_gain_graph(MAX_CYCLIC_ALGEBRAIC_VARIABLES + 1),
            vec![1.0],
        )
        .unwrap_err(),
        AdmissionLimit::CyclicAlgebraicVariables,
        MAX_CYCLIC_ALGEBRAIC_VARIABLES + 1,
        MAX_CYCLIC_ALGEBRAIC_VARIABLES,
    );

    for (index, limit, exact, maximum) in [
        (
            12,
            AdmissionLimit::InternalSteps,
            MAX_INTERNAL_STEPS,
            MAX_INTERNAL_STEPS,
        ),
        (
            14,
            AdmissionLimit::AlgebraicIterations,
            MAX_ALGEBRAIC_ITERATIONS,
            MAX_ALGEBRAIC_ITERATIONS,
        ),
        (
            16,
            AdmissionLimit::ImplicitIterations,
            MAX_IMPLICIT_ITERATIONS,
            MAX_IMPLICIT_ITERATIONS,
        ),
    ] {
        let mut graph = constant_graph(1);
        graph[index] = exact as f64;
        admitted(NativeDaeBackendWire::Dense, graph.clone(), vec![1.0])
            .expect("exact work-setting boundary");
        graph[index] = (maximum + 1) as f64;
        assert_limit(
            admitted(NativeDaeBackendWire::Dense, graph, vec![1.0]).unwrap_err(),
            limit,
            maximum + 1,
            maximum,
        );
    }

    let mut zero_steps = constant_graph(1);
    zero_steps[12] = 0.0;
    assert!(matches!(
        admitted(NativeDaeBackendWire::Dense, zero_steps, vec![1.0]),
        Err(AdmissionError::BelowMinimum {
            limit: AdmissionLimit::InternalSteps,
            actual: 0,
            minimum: 1,
            ..
        })
    ));

    for max_order in [0, 6] {
        let mut invalid = request(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0]);
        invalid.max_order = max_order;
        assert!(matches!(
            admit_request_frame(&unchecked_frame(&invalid)),
            Err(AdmissionError::BelowMinimum {
                limit: AdmissionLimit::MaxOrder,
                ..
            }) | Err(AdmissionError::LimitExceeded {
                limit: AdmissionLimit::MaxOrder,
                ..
            })
        ));
    }
    let mut restarts = request(NativeDaeBackendWire::Dense, constant_graph(1), vec![1.0]);
    restarts.event_policy = NativeDaeEventPolicyWire::Restart {
        max_restarts: MAX_EVENT_RESTARTS as u32,
    };
    let exact_restarts =
        admit_request_frame(&unchecked_frame(&restarts)).expect("exact event-restart boundary");
    assert!(matches!(
        exact_restarts.native_settings(),
        AdmittedNativeSettings::Dense(settings)
            if settings.event_policy == IdaEventPolicy::Restart {
                max_restarts: MAX_EVENT_RESTARTS,
            }
    ));
    restarts.event_policy = NativeDaeEventPolicyWire::Restart {
        max_restarts: (MAX_EVENT_RESTARTS + 1) as u32,
    };
    assert_limit(
        admit_request_frame(&unchecked_frame(&restarts)).unwrap_err(),
        AdmissionLimit::EventRestarts,
        MAX_EVENT_RESTARTS + 1,
        MAX_EVENT_RESTARTS,
    );

    let mut noncanonical = constant_graph(1);
    noncanonical[7] = f64::from_bits(noncanonical[7].to_bits() + 1);
    assert!(matches!(
        admitted(NativeDaeBackendWire::Dense, noncanonical, vec![1.0]),
        Err(AdmissionError::NonCanonicalGraphSetting {
            field: "initial_step_s",
            ..
        })
    ));
}
