//! Exact one-shot framing and request wire types for the native DAE service.

use serde::{Deserialize, Serialize};
use std::fmt;

pub const FRAME_HEADER_BYTES: usize = 8;
pub const MAX_FRAME_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
pub const REQUEST_FRAME_MAGIC: [u8; 4] = *b"BDQ1";
pub const RESPONSE_FRAME_MAGIC: [u8; 4] = *b"BDR1";
pub const NATIVE_DAE_REQUEST_FORMAT: &str = "battery-design/native-dae-request@1";
pub const F64_BLOCK_FORMAT: &str = "battery-design/f64-le-base64@1";

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    Request,
    Response,
}

impl FrameKind {
    fn magic(self) -> [u8; 4] {
        match self {
            Self::Request => REQUEST_FRAME_MAGIC,
            Self::Response => RESPONSE_FRAME_MAGIC,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameSection {
    Header,
    Payload,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameError {
    BadMagic {
        actual: [u8; 4],
    },
    UnsupportedVersion {
        actual: u8,
    },
    WrongMessageKind {
        expected: FrameKind,
        actual: FrameKind,
    },
    ZeroPayloadLength,
    PayloadTooLarge {
        declared: usize,
        maximum: usize,
    },
    PayloadAllocationFailed {
        requested: usize,
    },
    TrailingBytes {
        count: usize,
    },
    UnexpectedEof {
        section: FrameSection,
        expected: usize,
        actual: usize,
    },
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadMagic { actual } => write!(formatter, "invalid DAE frame magic {actual:?}"),
            Self::UnsupportedVersion { actual } => {
                write!(formatter, "unsupported DAE frame version byte {actual}")
            }
            Self::WrongMessageKind { expected, actual } => write!(
                formatter,
                "expected a {expected:?} DAE frame but received {actual:?}",
            ),
            Self::ZeroPayloadLength => formatter.write_str("DAE frame payload must not be empty"),
            Self::PayloadTooLarge { declared, maximum } => write!(
                formatter,
                "DAE frame declares {declared} payload bytes; the limit is {maximum}",
            ),
            Self::PayloadAllocationFailed { requested } => {
                write!(
                    formatter,
                    "could not reserve {requested} DAE frame payload bytes"
                )
            }
            Self::TrailingBytes { count } => {
                write!(
                    formatter,
                    "DAE frame has {count} bytes after its declared payload"
                )
            }
            Self::UnexpectedEof {
                section,
                expected,
                actual,
            } => write!(
                formatter,
                "DAE frame ended during {section:?}: expected {expected} bytes, received {actual}",
            ),
        }
    }
}

impl std::error::Error for FrameError {}

/// Incrementally receives one frame but releases its payload only after EOF.
/// This makes a second frame or any trailing byte an error rather than data a
/// caller could accidentally ignore.
#[derive(Debug)]
pub struct FrameDecoder {
    expected_kind: FrameKind,
    header: [u8; FRAME_HEADER_BYTES],
    header_len: usize,
    declared_payload_len: Option<usize>,
    payload: Vec<u8>,
    failure: Option<FrameError>,
}

impl FrameDecoder {
    pub fn new(expected_kind: FrameKind) -> Self {
        Self {
            expected_kind,
            header: [0; FRAME_HEADER_BYTES],
            header_len: 0,
            declared_payload_len: None,
            payload: Vec::new(),
            failure: None,
        }
    }

    pub fn push(&mut self, mut bytes: &[u8]) -> Result<(), FrameError> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }

        if self.declared_payload_len == Some(self.payload.len()) {
            if bytes.is_empty() {
                return Ok(());
            }
            return self.fail(FrameError::TrailingBytes { count: bytes.len() });
        }

        if self.header_len < FRAME_HEADER_BYTES {
            let count = (FRAME_HEADER_BYTES - self.header_len).min(bytes.len());
            self.header[self.header_len..self.header_len + count].copy_from_slice(&bytes[..count]);
            self.header_len += count;
            bytes = &bytes[count..];
            if self.header_len < FRAME_HEADER_BYTES {
                return Ok(());
            }
            if let Err(error) = self.accept_header() {
                return self.fail(error);
            }
        }

        let declared = self
            .declared_payload_len
            .expect("a complete accepted header declares its payload length");
        let remaining = declared - self.payload.len();
        let count = remaining.min(bytes.len());
        self.payload.extend_from_slice(&bytes[..count]);
        bytes = &bytes[count..];
        if bytes.is_empty() {
            Ok(())
        } else {
            self.fail(FrameError::TrailingBytes { count: bytes.len() })
        }
    }

    pub fn finish(self) -> Result<Vec<u8>, FrameError> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.header_len < FRAME_HEADER_BYTES {
            return Err(FrameError::UnexpectedEof {
                section: FrameSection::Header,
                expected: FRAME_HEADER_BYTES,
                actual: self.header_len,
            });
        }
        let declared = self
            .declared_payload_len
            .expect("a complete accepted header declares its payload length");
        if self.payload.len() != declared {
            return Err(FrameError::UnexpectedEof {
                section: FrameSection::Payload,
                expected: declared,
                actual: self.payload.len(),
            });
        }
        Ok(self.payload)
    }

    pub fn buffered_payload_len(&self) -> usize {
        self.payload.len()
    }

    pub fn buffered_payload_capacity(&self) -> usize {
        self.payload.capacity()
    }

    fn accept_header(&mut self) -> Result<(), FrameError> {
        let actual_magic = [
            self.header[0],
            self.header[1],
            self.header[2],
            self.header[3],
        ];
        if actual_magic[0..2] != *b"BD" || !matches!(actual_magic[2], b'Q' | b'R') {
            return Err(FrameError::BadMagic {
                actual: actual_magic,
            });
        }
        let actual_kind = if actual_magic[2] == b'Q' {
            FrameKind::Request
        } else {
            FrameKind::Response
        };
        if actual_magic[3] != b'1' {
            return Err(FrameError::UnsupportedVersion {
                actual: actual_magic[3],
            });
        }
        if actual_kind != self.expected_kind {
            return Err(FrameError::WrongMessageKind {
                expected: self.expected_kind,
                actual: actual_kind,
            });
        }

        let declared = u32::from_le_bytes([
            self.header[4],
            self.header[5],
            self.header[6],
            self.header[7],
        ]) as usize;
        if declared == 0 {
            return Err(FrameError::ZeroPayloadLength);
        }
        if declared > MAX_FRAME_PAYLOAD_BYTES {
            return Err(FrameError::PayloadTooLarge {
                declared,
                maximum: MAX_FRAME_PAYLOAD_BYTES,
            });
        }
        self.payload.try_reserve_exact(declared).map_err(|_| {
            FrameError::PayloadAllocationFailed {
                requested: declared,
            }
        })?;
        self.declared_payload_len = Some(declared);
        Ok(())
    }

    fn fail(&mut self, error: FrameError) -> Result<(), FrameError> {
        self.failure = Some(error.clone());
        Err(error)
    }
}

pub fn encode_frame(kind: FrameKind, payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.is_empty() {
        return Err(FrameError::ZeroPayloadLength);
    }
    if payload.len() > MAX_FRAME_PAYLOAD_BYTES {
        return Err(FrameError::PayloadTooLarge {
            declared: payload.len(),
            maximum: MAX_FRAME_PAYLOAD_BYTES,
        });
    }
    let payload_len = u32::try_from(payload.len()).map_err(|_| FrameError::PayloadTooLarge {
        declared: payload.len(),
        maximum: MAX_FRAME_PAYLOAD_BYTES,
    })?;
    let frame_len =
        FRAME_HEADER_BYTES
            .checked_add(payload.len())
            .ok_or(FrameError::PayloadTooLarge {
                declared: payload.len(),
                maximum: MAX_FRAME_PAYLOAD_BYTES,
            })?;
    let mut frame = Vec::new();
    frame
        .try_reserve_exact(frame_len)
        .map_err(|_| FrameError::PayloadAllocationFailed {
            requested: frame_len,
        })?;
    frame.extend_from_slice(&kind.magic());
    frame.extend_from_slice(&payload_len.to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum NativeDaeRequestFormatWire {
    #[serde(rename = "battery-design/native-dae-request@1")]
    V1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum NativeDaeBackendWire {
    #[serde(rename = "sundials-ida-dense")]
    Dense,
    #[serde(rename = "sundials-ida-klu")]
    Klu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum F64BlockFormatWire {
    #[serde(rename = "battery-design/f64-le-base64@1")]
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct F64BlockWire {
    pub format: F64BlockFormatWire,
    pub count: u32,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum F64BlockError {
    ValueCountOverflow { actual: usize },
    ByteCountOverflow,
    ByteLengthMismatch { expected: usize, actual: usize },
    NonCanonicalBase64,
    NonFiniteValue { index: usize },
    AllocationFailed { requested: usize },
}

impl fmt::Display for F64BlockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ValueCountOverflow { actual } => {
                write!(
                    formatter,
                    "f64 block contains {actual} values, beyond its wire count"
                )
            }
            Self::ByteCountOverflow => formatter.write_str("f64 block byte count overflowed"),
            Self::ByteLengthMismatch { expected, actual } => write!(
                formatter,
                "f64 block declares {expected} decoded bytes but contains {actual}",
            ),
            Self::NonCanonicalBase64 => {
                formatter.write_str("f64 block is not canonical standard base64")
            }
            Self::NonFiniteValue { index } => {
                write!(formatter, "f64 block value {index} is not finite")
            }
            Self::AllocationFailed { requested } => {
                write!(
                    formatter,
                    "could not reserve {requested} bytes for an f64 block"
                )
            }
        }
    }
}

impl std::error::Error for F64BlockError {}

impl F64BlockWire {
    pub fn from_values(values: &[f64]) -> Result<Self, F64BlockError> {
        let count = u32::try_from(values.len()).map_err(|_| F64BlockError::ValueCountOverflow {
            actual: values.len(),
        })?;
        let byte_count = values
            .len()
            .checked_mul(std::mem::size_of::<f64>())
            .ok_or(F64BlockError::ByteCountOverflow)?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(byte_count)
            .map_err(|_| F64BlockError::AllocationFailed {
                requested: byte_count,
            })?;
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        Ok(Self {
            format: F64BlockFormatWire::V1,
            count,
            data: encode_base64(&bytes)?,
        })
    }

    pub fn decode_values(&self) -> Result<Vec<f64>, F64BlockError> {
        let bytes = decode_base64(&self.data)?;
        let count = self.count as usize;
        let expected = count
            .checked_mul(std::mem::size_of::<f64>())
            .ok_or(F64BlockError::ByteCountOverflow)?;
        if bytes.len() != expected {
            return Err(F64BlockError::ByteLengthMismatch {
                expected,
                actual: bytes.len(),
            });
        }
        let mut values = Vec::new();
        values
            .try_reserve_exact(count)
            .map_err(|_| F64BlockError::AllocationFailed {
                requested: expected,
            })?;
        for bytes in bytes.chunks_exact(std::mem::size_of::<f64>()) {
            values.push(f64::from_le_bytes(
                bytes.try_into().expect("chunks_exact yields eight bytes"),
            ));
        }
        Ok(values)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum NativeDaeEventPolicyWire {
    Reject,
    Restart {
        #[serde(rename = "maxRestarts")]
        max_restarts: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDaeRequestWire {
    pub format: NativeDaeRequestFormatWire,
    pub backend: NativeDaeBackendWire,
    pub graph_transport: F64BlockWire,
    pub output_times: F64BlockWire,
    pub max_order: u8,
    pub suppress_algebraic_error: bool,
    pub event_policy: NativeDaeEventPolicyWire,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestF64Field {
    GraphTransport,
    OutputTimes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    Frame(FrameError),
    Json(String),
    InvalidF64Block {
        field: RequestF64Field,
        source: F64BlockError,
    },
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Frame(error) => error.fmt(formatter),
            Self::Json(error) => write!(formatter, "invalid native DAE request JSON: {error}"),
            Self::InvalidF64Block { field, source } => {
                write!(formatter, "invalid native DAE request {field:?}: {source}")
            }
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<FrameError> for ProtocolError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

pub fn encode_request_frame(request: &NativeDaeRequestWire) -> Result<Vec<u8>, ProtocolError> {
    validate_request_blocks(request)?;
    let payload =
        serde_json::to_vec(request).map_err(|error| ProtocolError::Json(error.to_string()))?;
    encode_frame(FrameKind::Request, &payload).map_err(Into::into)
}

pub fn decode_request_frame(frame: &[u8]) -> Result<NativeDaeRequestWire, ProtocolError> {
    let mut decoder = FrameDecoder::new(FrameKind::Request);
    decoder.push(frame)?;
    let payload = decoder.finish()?;
    let request: NativeDaeRequestWire =
        serde_json::from_slice(&payload).map_err(|error| ProtocolError::Json(error.to_string()))?;
    validate_request_blocks(&request)?;
    Ok(request)
}

fn validate_request_blocks(request: &NativeDaeRequestWire) -> Result<(), ProtocolError> {
    for (field, block) in [
        (RequestF64Field::GraphTransport, &request.graph_transport),
        (RequestF64Field::OutputTimes, &request.output_times),
    ] {
        let values = block
            .decode_values()
            .map_err(|source| ProtocolError::InvalidF64Block { field, source })?;
        if let Some(index) = values.iter().position(|value| !value.is_finite()) {
            return Err(ProtocolError::InvalidF64Block {
                field,
                source: F64BlockError::NonFiniteValue { index },
            });
        }
    }
    Ok(())
}

fn encode_base64(bytes: &[u8]) -> Result<String, F64BlockError> {
    let groups = bytes
        .len()
        .checked_add(2)
        .ok_or(F64BlockError::ByteCountOverflow)?
        / 3;
    let output_len = groups
        .checked_mul(4)
        .ok_or(F64BlockError::ByteCountOverflow)?;
    let mut output = String::new();
    output
        .try_reserve_exact(output_len)
        .map_err(|_| F64BlockError::AllocationFailed {
            requested: output_len,
        })?;
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(BASE64_ALPHABET[(first >> 2) as usize] as char);
        output.push(BASE64_ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(BASE64_ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(BASE64_ALPHABET[(third & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
    }
    Ok(output)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, F64BlockError> {
    if input.is_empty() {
        return Ok(Vec::new());
    }
    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(F64BlockError::NonCanonicalBase64);
    }
    let capacity = (bytes.len() / 4)
        .checked_mul(3)
        .ok_or(F64BlockError::ByteCountOverflow)?;
    let mut decoded = Vec::new();
    decoded
        .try_reserve_exact(capacity)
        .map_err(|_| F64BlockError::AllocationFailed {
            requested: capacity,
        })?;

    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let first = base64_value(chunk[0]).ok_or(F64BlockError::NonCanonicalBase64)?;
        let second = base64_value(chunk[1]).ok_or(F64BlockError::NonCanonicalBase64)?;
        decoded.push((first << 2) | (second >> 4));
        match (chunk[2], chunk[3]) {
            (b'=', b'=') if last && second & 0x0f == 0 => {}
            (third, b'=') if last => {
                let third = base64_value(third).ok_or(F64BlockError::NonCanonicalBase64)?;
                if third & 0x03 != 0 {
                    return Err(F64BlockError::NonCanonicalBase64);
                }
                decoded.push((second << 4) | (third >> 2));
            }
            (third, fourth) if third != b'=' && fourth != b'=' => {
                let third = base64_value(third).ok_or(F64BlockError::NonCanonicalBase64)?;
                let fourth = base64_value(fourth).ok_or(F64BlockError::NonCanonicalBase64)?;
                decoded.push((second << 4) | (third >> 2));
                decoded.push((third << 6) | fourth);
            }
            _ => return Err(F64BlockError::NonCanonicalBase64),
        }
    }
    if encode_base64(&decoded)? != input {
        return Err(F64BlockError::NonCanonicalBase64);
    }
    Ok(decoded)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}
