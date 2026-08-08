use battery_design_dae_service::protocol::{
    decode_request_frame, encode_frame, encode_request_frame, F64BlockError, F64BlockWire,
    FrameDecoder, FrameError, FrameKind, FrameSection, NativeDaeBackendWire,
    NativeDaeEventPolicyWire, NativeDaeRequestFormatWire, NativeDaeRequestWire, ProtocolError,
    RequestF64Field, FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, REQUEST_FRAME_MAGIC,
};

fn request() -> NativeDaeRequestWire {
    NativeDaeRequestWire {
        format: NativeDaeRequestFormatWire::V1,
        backend: NativeDaeBackendWire::Klu,
        graph_transport: F64BlockWire::from_values(&[-0.0, 1.25, f64::MIN_POSITIVE])
            .expect("fixture graph block"),
        output_times: F64BlockWire::from_values(&[0.5, 1.0]).expect("fixture output block"),
        max_order: 5,
        suppress_algebraic_error: true,
        event_policy: NativeDaeEventPolicyWire::Restart { max_restarts: 2 },
    }
}

fn frame() -> Vec<u8> {
    encode_request_frame(&request()).expect("fixture request frame")
}

fn header(payload_len: u32) -> [u8; FRAME_HEADER_BYTES] {
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    header[..4].copy_from_slice(&REQUEST_FRAME_MAGIC);
    header[4..].copy_from_slice(&payload_len.to_le_bytes());
    header
}

fn assert_block_rejected_on_encode_and_decode(
    invalid: &NativeDaeRequestWire,
    expected: ProtocolError,
) {
    assert_eq!(encode_request_frame(invalid), Err(expected.clone()));
    let payload = serde_json::to_vec(invalid).expect("serialize deliberately invalid wire request");
    let framed =
        encode_frame(FrameKind::Request, &payload).expect("frame invalid request directly");
    assert_eq!(decode_request_frame(&framed), Err(expected));
}

#[test]
fn framing_canonical_request_round_trips_as_one_frame() {
    let original = request();
    assert_eq!(
        original.graph_transport.data,
        "AAAAAAAAAIAAAAAAAAD0PwAAAAAAABAA"
    );
    let framed = encode_request_frame(&original).expect("encode canonical request");
    assert_eq!(&framed[..4], b"BDQ1");
    assert_eq!(
        u32::from_le_bytes(framed[4..8].try_into().expect("fixed header")) as usize,
        framed.len() - FRAME_HEADER_BYTES,
    );

    let decoded = decode_request_frame(&framed).expect("decode canonical request");
    assert_eq!(decoded, original);
    let graph = decoded
        .graph_transport
        .decode_values()
        .expect("decode f64 block");
    assert_eq!(graph[0].to_bits(), (-0.0_f64).to_bits());
    assert_eq!(graph[1].to_bits(), 1.25_f64.to_bits());
    assert_eq!(graph[2].to_bits(), f64::MIN_POSITIVE.to_bits());

    let finite_boundaries = [f64::MAX, -f64::MAX, f64::from_bits(1)];
    let mut boundary_request = decoded.clone();
    boundary_request.graph_transport =
        F64BlockWire::from_values(&finite_boundaries).expect("encode finite boundary bits");
    let boundary_frame =
        encode_request_frame(&boundary_request).expect("accept finite boundary request");
    let boundary_values = decode_request_frame(&boundary_frame)
        .expect("decode finite boundary request")
        .graph_transport
        .decode_values()
        .expect("decode finite boundary block");
    assert_eq!(
        boundary_values
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        finite_boundaries
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
    );

    let payload = &framed[FRAME_HEADER_BYTES..];
    let mut value: serde_json::Value = serde_json::from_slice(payload).expect("request JSON");
    value
        .as_object_mut()
        .expect("request object")
        .insert("unexpected".to_string(), serde_json::Value::Bool(true));
    assert!(serde_json::from_value::<NativeDaeRequestWire>(value).is_err());

    let mut invalid_base64 = original.clone();
    invalid_base64.graph_transport.data = "$$$$".to_string();
    assert_block_rejected_on_encode_and_decode(
        &invalid_base64,
        ProtocolError::InvalidF64Block {
            field: RequestF64Field::GraphTransport,
            source: F64BlockError::NonCanonicalBase64,
        },
    );

    let mut noncanonical_padding = original.clone();
    noncanonical_padding.graph_transport.data = "AB==".to_string();
    assert_block_rejected_on_encode_and_decode(
        &noncanonical_padding,
        ProtocolError::InvalidF64Block {
            field: RequestF64Field::GraphTransport,
            source: F64BlockError::NonCanonicalBase64,
        },
    );

    let mut count_mismatch = original.clone();
    count_mismatch.output_times.count += 1;
    assert_block_rejected_on_encode_and_decode(
        &count_mismatch,
        ProtocolError::InvalidF64Block {
            field: RequestF64Field::OutputTimes,
            source: F64BlockError::ByteLengthMismatch {
                expected: 24,
                actual: 16,
            },
        },
    );

    let mut nonfinite_graph = original.clone();
    nonfinite_graph.graph_transport =
        F64BlockWire::from_values(&[0.0, f64::NAN]).expect("encode NaN bits for rejection");
    assert_block_rejected_on_encode_and_decode(
        &nonfinite_graph,
        ProtocolError::InvalidF64Block {
            field: RequestF64Field::GraphTransport,
            source: F64BlockError::NonFiniteValue { index: 1 },
        },
    );

    for infinity in [f64::INFINITY, f64::NEG_INFINITY] {
        let mut nonfinite_output = original.clone();
        nonfinite_output.output_times =
            F64BlockWire::from_values(&[infinity]).expect("encode infinity bits for rejection");
        assert_block_rejected_on_encode_and_decode(
            &nonfinite_output,
            ProtocolError::InvalidF64Block {
                field: RequestF64Field::OutputTimes,
                source: F64BlockError::NonFiniteValue { index: 0 },
            },
        );
    }
}

#[test]
fn framing_header_split_at_every_byte_boundary_reassembles_once() {
    let framed = frame();
    for split in 0..=FRAME_HEADER_BYTES {
        let mut decoder = FrameDecoder::new(FrameKind::Request);
        decoder
            .push(&framed[..split])
            .expect("first header fragment");
        decoder.push(&framed[split..]).expect("remaining frame");
        let payload = decoder.finish().expect("one complete frame at EOF");
        assert_eq!(payload, framed[FRAME_HEADER_BYTES..]);
    }
}

#[test]
fn framing_payload_split_at_every_byte_boundary_reassembles_once() {
    let framed = frame();
    let payload_len = framed.len() - FRAME_HEADER_BYTES;
    for split in 0..=payload_len {
        let boundary = FRAME_HEADER_BYTES + split;
        let mut decoder = FrameDecoder::new(FrameKind::Request);
        decoder
            .push(&framed[..boundary])
            .expect("header and first payload fragment");
        decoder
            .push(&framed[boundary..])
            .expect("remaining payload fragment");
        assert_eq!(
            decoder.finish().expect("one complete frame at EOF"),
            framed[FRAME_HEADER_BYTES..],
        );
    }
}

#[test]
fn framing_extra_bytes_or_second_frame_fail_closed() {
    let framed = frame();
    let mut with_extra = framed.clone();
    with_extra.push(0);
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert_eq!(
        decoder.push(&with_extra),
        Err(FrameError::TrailingBytes { count: 1 }),
    );
    assert_eq!(
        decoder.push(&[]),
        Err(FrameError::TrailingBytes { count: 1 }),
        "a framing failure remains latched",
    );

    let mut two_frames = framed.clone();
    two_frames.extend_from_slice(&framed);
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert_eq!(
        decoder.push(&two_frames),
        Err(FrameError::TrailingBytes {
            count: framed.len(),
        }),
    );

    let mut decoder = FrameDecoder::new(FrameKind::Request);
    decoder.push(&framed).expect("first frame bytes");
    assert_eq!(
        decoder.push(b"second"),
        Err(FrameError::TrailingBytes { count: 6 }),
    );
}

#[test]
fn framing_bad_magic_is_rejected_before_payload_read() {
    let mut framed = frame();
    framed[0] = b'X';
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert_eq!(
        decoder.push(&framed),
        Err(FrameError::BadMagic {
            actual: [b'X', b'D', b'Q', b'1'],
        }),
    );
    assert_eq!(decoder.buffered_payload_len(), 0);
    assert_eq!(decoder.buffered_payload_capacity(), 0);
}

#[test]
fn framing_unknown_version_or_wrong_message_kind_fail_closed() {
    let mut unknown_version = frame();
    unknown_version[3] = b'2';
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert_eq!(
        decoder.push(&unknown_version),
        Err(FrameError::UnsupportedVersion { actual: b'2' }),
    );
    assert_eq!(decoder.buffered_payload_capacity(), 0);

    let response = encode_frame(FrameKind::Response, b"{}").expect("response fixture");
    assert_eq!(&response[..4], b"BDR1");
    assert_eq!(&response[4..FRAME_HEADER_BYTES], &2_u32.to_le_bytes());
    assert_eq!(&response[FRAME_HEADER_BYTES..], b"{}");
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert_eq!(
        decoder.push(&response),
        Err(FrameError::WrongMessageKind {
            expected: FrameKind::Request,
            actual: FrameKind::Response,
        }),
    );
    assert_eq!(decoder.buffered_payload_capacity(), 0);
}

#[test]
fn framing_zero_length_is_rejected_before_json_decode() {
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert_eq!(decoder.push(&header(0)), Err(FrameError::ZeroPayloadLength),);
    assert_eq!(decoder.buffered_payload_len(), 0);
    assert_eq!(decoder.buffered_payload_capacity(), 0);
}

#[test]
fn framing_over_limit_length_is_rejected_before_payload_allocation() {
    let declared = u32::try_from(MAX_FRAME_PAYLOAD_BYTES + 1).expect("4 MiB ceiling fits u32");
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    assert_eq!(
        decoder.push(&header(declared)),
        Err(FrameError::PayloadTooLarge {
            declared: MAX_FRAME_PAYLOAD_BYTES + 1,
            maximum: MAX_FRAME_PAYLOAD_BYTES,
        }),
    );
    assert_eq!(decoder.buffered_payload_len(), 0);
    assert_eq!(decoder.buffered_payload_capacity(), 0);
}

#[test]
fn framing_eof_during_header_or_payload_emits_no_frame() {
    let framed = frame();
    for received in 0..FRAME_HEADER_BYTES {
        let mut decoder = FrameDecoder::new(FrameKind::Request);
        decoder
            .push(&framed[..received])
            .expect("partial header accepted");
        assert_eq!(
            decoder.finish(),
            Err(FrameError::UnexpectedEof {
                section: FrameSection::Header,
                expected: FRAME_HEADER_BYTES,
                actual: received,
            }),
        );
    }

    let payload_len = framed.len() - FRAME_HEADER_BYTES;
    for received in 0..payload_len {
        let end = FRAME_HEADER_BYTES + received;
        let mut decoder = FrameDecoder::new(FrameKind::Request);
        decoder
            .push(&framed[..end])
            .expect("partial payload accepted");
        assert_eq!(
            decoder.finish(),
            Err(FrameError::UnexpectedEof {
                section: FrameSection::Payload,
                expected: payload_len,
                actual: received,
            }),
        );
    }
}
