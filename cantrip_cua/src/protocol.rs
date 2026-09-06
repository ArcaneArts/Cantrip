//! Private framed transport between the worker and its computer-use process.
//!
//! Each frame has an eight-byte prefix containing big-endian header and payload
//! lengths, followed by a JSON header and optional unencoded image bytes.

use std::io::{self, Read, Write};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{error::CuaError, target::MAX_SEQUENCE};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_HEADER_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub header: Header,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub version: u32,
    pub message: Message,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Message {
    Request {
        #[serde(deserialize_with = "deserialize_sequence")]
        request_id: u64,
        operation: Value,
    },
    Response {
        #[serde(deserialize_with = "deserialize_sequence")]
        request_id: u64,
        result: Outcome,
    },
    Event {
        #[serde(deserialize_with = "deserialize_sequence")]
        sequence: u64,
        session_id: Option<String>,
        event: Value,
    },
    Cancel {
        #[serde(deserialize_with = "deserialize_sequence")]
        request_id: u64,
    },
    HostCall {
        #[serde(deserialize_with = "deserialize_sequence")]
        evaluation_request_id: u64,
        #[serde(deserialize_with = "deserialize_sequence")]
        call_id: u64,
        action: Value,
    },
    HostResult {
        #[serde(deserialize_with = "deserialize_sequence")]
        evaluation_request_id: u64,
        #[serde(deserialize_with = "deserialize_sequence")]
        call_id: u64,
        result: Outcome,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum Outcome {
    Ok { data: Value },
    Error { error: CuaError },
}

fn deserialize_sequence<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if (1..=MAX_SEQUENCE).contains(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "Invalid CUA request identifier or sequence.",
        ))
    }
}

fn validate_header(header: &Header, payload_len: usize, kind: io::ErrorKind) -> io::Result<()> {
    if header.version != PROTOCOL_VERSION {
        return Err(io::Error::new(kind, "Unsupported CUA protocol version."));
    }
    let sequence = match &header.message {
        Message::Request { request_id, .. }
        | Message::Response { request_id, .. }
        | Message::Cancel { request_id } => *request_id,
        Message::Event { sequence, .. } => *sequence,
        Message::HostCall {
            evaluation_request_id,
            ..
        }
        | Message::HostResult {
            evaluation_request_id,
            ..
        } => *evaluation_request_id,
    };
    if !(1..=MAX_SEQUENCE).contains(&sequence) {
        return Err(io::Error::new(
            kind,
            "Invalid CUA request identifier or sequence.",
        ));
    }
    if let Message::HostCall { call_id, .. } | Message::HostResult { call_id, .. } = &header.message
        && !(1..=MAX_SEQUENCE).contains(call_id)
    {
        return Err(io::Error::new(kind, "Invalid CUA host call identifier."));
    }
    if payload_len > MAX_PAYLOAD_BYTES {
        return Err(io::Error::new(kind, "CUA payload exceeds its byte limit."));
    }
    if payload_len != 0
        && !matches!(
            header.message,
            Message::Response {
                result: Outcome::Ok { .. },
                ..
            }
        )
    {
        return Err(io::Error::new(
            kind,
            "Only successful CUA responses may carry a payload.",
        ));
    }
    Ok(())
}

/// Reads one frame. EOF is clean only before any byte of the next frame arrives.
pub fn read_frame(mut reader: impl Read) -> io::Result<Option<Frame>> {
    let mut prefix = [0; 8];
    loop {
        match reader.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut prefix[1..])?;
    let header_len = u32::from_be_bytes(prefix[..4].try_into().unwrap()) as usize;
    let payload_len = u32::from_be_bytes(prefix[4..].try_into().unwrap()) as usize;
    if header_len == 0 || header_len > MAX_HEADER_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid CUA header length.",
        ));
    }
    if payload_len > MAX_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "CUA payload exceeds its byte limit.",
        ));
    }

    let mut header_bytes = vec![0; header_len];
    reader.read_exact(&mut header_bytes)?;
    let header: Header = serde_json::from_slice(&header_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid CUA frame header."))?;
    // Validate before reading or allocating the payload: requests, events, and
    // cancellation frames cannot make the process buffer screenshot-sized data.
    validate_header(&header, payload_len, io::ErrorKind::InvalidData)?;
    let mut payload = vec![0; payload_len];
    reader.read_exact(&mut payload)?;
    Ok(Some(Frame { header, payload }))
}

struct HeaderBuffer(Vec<u8>);

impl Write for HeaderBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_HEADER_BYTES - self.0.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "CUA header exceeds its byte limit.",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Writes one frame without flushing; the owner controls its transport lifetime.
pub fn write_frame(mut writer: impl Write, frame: &Frame) -> io::Result<()> {
    validate_header(
        &frame.header,
        frame.payload.len(),
        io::ErrorKind::InvalidInput,
    )?;
    let mut header = HeaderBuffer(Vec::new());
    serde_json::to_writer(&mut header, &frame.header).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CUA header exceeds its byte limit.",
        )
    })?;
    writer.write_all(&(header.0.len() as u32).to_be_bytes())?;
    writer.write_all(&(frame.payload.len() as u32).to_be_bytes())?;
    writer.write_all(&header.0)?;
    writer.write_all(&frame.payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use serde_json::json;
    use std::io::Cursor;

    fn response(payload: Vec<u8>) -> Frame {
        Frame {
            header: Header {
                version: PROTOCOL_VERSION,
                message: Message::Response {
                    request_id: 1,
                    result: Outcome::Ok {
                        data: json!({"mediaType": "image/png"}),
                    },
                },
            },
            payload,
        }
    }

    fn encode(frame: &Frame) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, frame).unwrap();
        bytes
    }

    fn raw_frame(header: &[u8], payload_len: u32) -> Vec<u8> {
        let mut bytes = (header.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&payload_len.to_be_bytes());
        bytes.extend_from_slice(header);
        bytes
    }

    #[test]
    fn host_rendezvous_frames_are_exact_bounded_control_only() {
        for message in [
            Message::HostCall {
                evaluation_request_id: 1,
                call_id: 1,
                action: json!({"operation":"state"}),
            },
            Message::HostResult {
                evaluation_request_id: MAX_SEQUENCE,
                call_id: MAX_SEQUENCE,
                result: Outcome::Ok {
                    data: json!({"targets":[]}),
                },
            },
        ] {
            let mut frame = Frame {
                header: Header {
                    version: PROTOCOL_VERSION,
                    message,
                },
                payload: vec![],
            };
            assert_eq!(
                read_frame(Cursor::new(encode(&frame))).unwrap(),
                Some(frame.clone())
            );
            frame.payload.push(1);
            assert!(write_frame(io::sink(), &frame).is_err());
            let raw = raw_frame(&serde_json::to_vec(&frame.header).unwrap(), 1);
            let error = read_frame(Cursor::new(raw)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }
        for kind in ["hostCall", "hostResult"] {
            for field in ["evaluationRequestId", "callId"] {
                for invalid in [
                    json!(0),
                    json!(-1),
                    json!(1.25),
                    Value::Null,
                    json!(MAX_SEQUENCE + 1),
                    json!("1"),
                ] {
                    let mut message = json!({"kind":kind,"evaluationRequestId":1,"callId":1});
                    message[field] = invalid;
                    if kind == "hostCall" {
                        message["action"] = json!({"operation":"state"});
                    } else {
                        message["result"] = json!({"status":"ok","data":null});
                    }
                    let raw = raw_frame(
                        &serde_json::to_vec(&json!({"version":1,"message":message})).unwrap(),
                        0,
                    );
                    assert!(read_frame(Cursor::new(raw)).is_err());
                }
            }
        }
    }

    #[test]
    fn round_trip_keeps_raw_binary_and_frame_boundaries() {
        let first = response(vec![0, 255, 0, b'\n', b'{', 128]);
        let second = Frame {
            header: Header {
                version: 1,
                message: Message::Cancel {
                    request_id: MAX_SEQUENCE,
                },
            },
            payload: vec![],
        };
        let mut bytes = encode(&first);
        bytes.extend(encode(&second));
        let mut reader = Cursor::new(bytes);
        assert_eq!(read_frame(&mut reader).unwrap(), Some(first));
        assert_eq!(read_frame(&mut reader).unwrap(), Some(second));
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }

    struct Fragmented<R> {
        reader: R,
        interrupted: bool,
    }
    impl<R: Read> Read for Fragmented<R> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.interrupted = !self.interrupted;
            if self.interrupted {
                return Err(io::ErrorKind::Interrupted.into());
            }
            let length = buffer.len().min(1);
            self.reader.read(&mut buffer[..length])
        }
    }

    #[test]
    fn fragmented_and_interrupted_reads_work() {
        let frame = response(vec![0, 128, 255]);
        let reader = Fragmented {
            reader: Cursor::new(encode(&frame)),
            interrupted: false,
        };
        assert_eq!(read_frame(reader).unwrap(), Some(frame));
    }

    #[test]
    fn only_eof_before_a_frame_is_clean() {
        assert_eq!(read_frame(&[][..]).unwrap(), None);
        let encoded = encode(&response(vec![1, 2, 3]));
        for length in 1..encoded.len() {
            let error = read_frame(&encoded[..length]).unwrap_err();
            assert_eq!(
                error.kind(),
                io::ErrorKind::UnexpectedEof,
                "truncated at {length}"
            );
        }
    }

    #[test]
    fn impossible_lengths_fail_before_reading_header_or_payload() {
        for (header_len, payload_len) in [
            (0, 0),
            (MAX_HEADER_BYTES as u32 + 1, 0),
            (u32::MAX, 0),
            (1, MAX_PAYLOAD_BYTES as u32 + 1),
            (1, u32::MAX),
        ] {
            let mut prefix = header_len.to_be_bytes().to_vec();
            prefix.extend(payload_len.to_be_bytes());
            assert_eq!(
                read_frame(&prefix[..]).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn maximum_lengths_are_accepted() {
        let mut header = serde_json::to_vec(&response(vec![]).header).unwrap();
        header.resize(MAX_HEADER_BYTES, b' ');
        let mut bytes = raw_frame(&header, MAX_PAYLOAD_BYTES as u32);
        bytes.resize(bytes.len() + MAX_PAYLOAD_BYTES, 0xA5);
        let frame = read_frame(&bytes[..]).unwrap().unwrap();
        assert_eq!(frame.payload.len(), MAX_PAYLOAD_BYTES);
        assert!(frame.payload.iter().all(|byte| *byte == 0xA5));
    }

    #[test]
    fn unsupported_version_is_rejected_before_payload_read() {
        let mut frame = response(vec![]);
        frame.header.version = 2;
        let header = serde_json::to_vec(&frame.header).unwrap();
        let bytes = raw_frame(&header, MAX_PAYLOAD_BYTES as u32);
        let error = read_frame(&bytes[..]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "Unsupported CUA protocol version.");
        assert_eq!(
            write_frame(Vec::new(), &frame).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn identifiers_require_positive_exact_javascript_integers() {
        for kind in ["request", "response", "cancel", "event"] {
            let key = if kind == "event" {
                "sequence"
            } else {
                "requestId"
            };
            for invalid in [
                "0",
                "-1",
                "1.0",
                "1e0",
                "null",
                "\"1\"",
                "9007199254740992",
                "18446744073709551616",
            ] {
                let extra = match kind {
                    "request" => ",\"operation\":{}",
                    "response" => ",\"result\":{\"status\":\"ok\",\"data\":{}}",
                    "event" => ",\"event\":{}",
                    _ => "",
                };
                let header = format!(
                    "{{\"version\":1,\"message\":{{\"kind\":\"{kind}\",\"{key}\":{invalid}{extra}}}}}"
                );
                let bytes = raw_frame(header.as_bytes(), 0);
                assert_eq!(
                    read_frame(&bytes[..]).unwrap_err().kind(),
                    io::ErrorKind::InvalidData,
                    "{kind} {invalid}"
                );
            }
        }
    }

    #[test]
    fn illegal_payloads_are_rejected_without_reading_bytes() {
        for message in [
            Message::Request {
                request_id: 1,
                operation: json!({}),
            },
            Message::Cancel { request_id: 1 },
            Message::Event {
                sequence: 1,
                session_id: None,
                event: json!({}),
            },
            Message::Response {
                request_id: 1,
                result: Outcome::Error {
                    error: CuaError::new(ErrorCode::Cancelled, "Cancelled."),
                },
            },
        ] {
            let frame = Frame {
                header: Header {
                    version: 1,
                    message,
                },
                payload: vec![1],
            };
            let bytes = raw_frame(
                &serde_json::to_vec(&frame.header).unwrap(),
                MAX_PAYLOAD_BYTES as u32,
            );
            assert_eq!(
                read_frame(&bytes[..]).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            let mut output = Vec::new();
            assert_eq!(
                write_frame(&mut output, &frame).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
            assert!(output.is_empty());
        }
    }

    #[test]
    fn unknown_fields_and_malformed_json_are_rejected() {
        for header in [
            r#"{"version":1,"message":{"kind":"cancel","requestId":1},"extra":true}"#,
            r#"{"version":1,"message":{"kind":"cancel","requestId":1,"extra":true}}"#,
            r#"{"version":1,"message":{"kind":"response","requestId":1,"result":{"status":"ok","data":{},"extra":true}}}"#,
            r#"{"version":1,"message":{"kind":"cancel","requestId":1,"requestId":2}}"#,
            r#"{"version":1,"message":{"kind":"unknown"}}"#,
            r#"{"version":1,"message":{"kind":"cancel","request_id":1}}"#,
            r#"{"version":1,"message":{"kind":"cancel","requestId":1}} trailing"#,
            "null",
            "[]",
            "{",
        ] {
            let bytes = raw_frame(header.as_bytes(), 0);
            assert_eq!(
                read_frame(&bytes[..]).unwrap_err().kind(),
                io::ErrorKind::InvalidData,
                "{header}"
            );
        }
        let bytes = raw_frame(&[0xFF, 0xFE], 0);
        assert_eq!(
            read_frame(&bytes[..]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn writer_rejects_invalid_ids_and_oversized_frames_before_output() {
        for id in [0, MAX_SEQUENCE + 1, u64::MAX] {
            let frame = Frame {
                header: Header {
                    version: 1,
                    message: Message::Cancel { request_id: id },
                },
                payload: vec![],
            };
            let mut output = Vec::new();
            assert_eq!(
                write_frame(&mut output, &frame).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
            assert!(output.is_empty());
        }
        let mut frame = response(vec![]);
        frame.header.message = Message::Response {
            request_id: 1,
            result: Outcome::Ok {
                data: json!("x".repeat(MAX_HEADER_BYTES)),
            },
        };
        let mut output = Vec::new();
        assert_eq!(
            write_frame(&mut output, &frame).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(output.is_empty());
        frame = response(vec![0; MAX_PAYLOAD_BYTES + 1]);
        assert_eq!(
            write_frame(&mut output, &frame).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(output.is_empty());
    }
}
