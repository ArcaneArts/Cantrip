//! Binary frames retain their validated bytes. Queued forwarding never rebuilds
//! JSON headers or lends a mutable caller buffer to another transport.
use super::{Error, Result, checked};
use crate::wire::Value;
use std::{ops::Range, sync::Arc};

pub const MAX_HEADER_BYTES: usize = 8 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 8 + 8 * 1024 + 64 * 1024 + 16;
pub const REMOTE_CHUNK_HEADER_BYTES: usize = 16;
pub const REMOTE_CHUNK_PAYLOAD_BYTES: usize = MAX_PAYLOAD_BYTES - REMOTE_CHUNK_HEADER_BYTES;
pub const REMOTE_MAX_FRAME_BYTES: usize = 8 + 64 * 1024 + 4 * 1024 * 1024;
const MAGIC: &[u8; 4] = b"CWLK";
const REMOTE_MAGIC: &[u8; 4] = b"CTRL";
fn invalid(message: &str) -> Error {
    anyhow::anyhow!("{message}").into()
}

#[derive(Clone)]
pub struct Frame {
    header: Value,
    bytes: Arc<[u8]>,
    payload: Range<usize>,
}
impl Frame {
    pub fn header(&self) -> &Value {
        &self.header
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn payload(&self) -> &[u8] {
        &self.bytes[self.payload.clone()]
    }
}
impl AsRef<[u8]> for Frame {
    fn as_ref(&self) -> &[u8] {
        self.bytes()
    }
}
pub fn is_frame(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}
fn validate_payload(header: &Value, payload: &[u8]) -> Result<()> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(invalid("WorkerLink payload exceeds the protocol limit."));
    }
    if header["kind"] == "data" && payload.is_empty() {
        return Err(invalid("WorkerLink data frames require a payload."));
    }
    if header["kind"] != "data" && !payload.is_empty() {
        return Err(invalid(
            "WorkerLink control frames cannot contain a payload.",
        ));
    }
    Ok(())
}
pub fn create(header: Value, payload: &[u8]) -> Result<Frame> {
    let header = checked("workerLinkFrameHeaderSchema", header)?;
    validate_payload(&header, payload)?;
    let encoded = header.stringify();
    if encoded.len() > MAX_HEADER_BYTES {
        return Err(invalid("WorkerLink header exceeds the protocol limit."));
    }
    let mut bytes = Vec::with_capacity(8 + encoded.len() + payload.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
    bytes.extend_from_slice(encoded.as_bytes());
    let start = bytes.len();
    bytes.extend_from_slice(payload);
    let end = bytes.len();
    Ok(Frame {
        header,
        bytes: bytes.into(),
        payload: start..end,
    })
}
pub fn decode(bytes: Arc<[u8]>) -> Result<Frame> {
    if bytes.len() < 8 || !is_frame(&bytes) {
        return Err(invalid("WorkerLink frame has an invalid magic value."));
    }
    let length = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if !(1..=MAX_HEADER_BYTES).contains(&length) {
        return Err(invalid("WorkerLink frame header length is invalid."));
    }
    let start = 8 + length;
    if start > bytes.len() {
        return Err(invalid("WorkerLink frame header is truncated."));
    }
    // WHATWG TextDecoder replaces malformed UTF-8 and consumes an initial BOM.
    let text = String::from_utf8_lossy(&bytes[8..start]);
    let value: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|_| invalid("WorkerLink frame header is not valid JSON."))?;
    let header = checked("workerLinkFrameHeaderSchema", value)?;
    validate_payload(&header, &bytes[start..])?;
    let end = bytes.len();
    Ok(Frame {
        header,
        bytes,
        payload: start..end,
    })
}

pub struct Chunk<'a> {
    pub frame_id: u64,
    pub frame_length: u64,
    pub offset: u64,
    pub payload: &'a [u8],
}
fn validate_chunk(chunk: &Chunk<'_>) -> Result<()> {
    if chunk.frame_id > u64::from(u32::MAX)
        || !(1..=REMOTE_MAX_FRAME_BYTES as u64).contains(&chunk.frame_length)
        || chunk.offset >= chunk.frame_length
        || chunk.payload.is_empty()
        || chunk.payload.len() > REMOTE_CHUNK_PAYLOAD_BYTES
        || chunk.offset + chunk.payload.len() as u64 > chunk.frame_length
    {
        return Err(invalid("WorkerLink Remote Surface chunk is out of bounds."));
    }
    Ok(())
}
pub fn encode_chunk(chunk: &Chunk<'_>) -> Result<Vec<u8>> {
    validate_chunk(chunk)?;
    let mut bytes = Vec::with_capacity(REMOTE_CHUNK_HEADER_BYTES + chunk.payload.len());
    bytes.extend_from_slice(REMOTE_MAGIC);
    for value in [chunk.frame_id, chunk.frame_length, chunk.offset] {
        bytes.extend_from_slice(&(value as u32).to_be_bytes());
    }
    bytes.extend_from_slice(chunk.payload);
    Ok(bytes)
}
pub fn decode_chunk(bytes: &[u8]) -> Result<Chunk<'_>> {
    if bytes.len() <= REMOTE_CHUNK_HEADER_BYTES
        || bytes.len() > MAX_PAYLOAD_BYTES
        || !bytes.starts_with(REMOTE_MAGIC)
    {
        return Err(invalid("WorkerLink Remote Surface chunk is invalid."));
    }
    let read = |at| u64::from(u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()));
    let chunk = Chunk {
        frame_id: read(4),
        frame_length: read(8),
        offset: read(12),
        payload: &bytes[16..],
    };
    validate_chunk(&chunk)?;
    Ok(chunk)
}
struct ActiveFrame {
    bytes: Vec<u8>,
    frame_id: u64,
    offset: usize,
}
pub struct Assembler {
    active: Option<ActiveFrame>,
    replace_incomplete: bool,
}
impl Assembler {
    pub fn new(replace_incomplete: bool) -> Self {
        Self {
            active: None,
            replace_incomplete,
        }
    }
    pub fn reset(&mut self) {
        self.active = None;
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>> {
        let chunk = decode_chunk(bytes)?;
        if chunk.offset == 0 {
            if self.active.is_some() && !self.replace_incomplete {
                return Err(invalid(
                    "WorkerLink Remote Surface frame restarted before completion.",
                ));
            }
            self.active = Some(ActiveFrame {
                bytes: vec![0; chunk.frame_length as usize],
                frame_id: chunk.frame_id,
                offset: 0,
            });
        }
        let active = self
            .active
            .as_mut()
            .filter(|active| {
                active.frame_id == chunk.frame_id
                    && active.bytes.len() as u64 == chunk.frame_length
                    && active.offset as u64 == chunk.offset
            })
            .ok_or_else(|| invalid("WorkerLink Remote Surface chunks are not contiguous."))?;
        let end = active.offset + chunk.payload.len();
        active.bytes[active.offset..end].copy_from_slice(chunk.payload);
        active.offset = end;
        if end != active.bytes.len() {
            return Ok(None);
        }
        Ok(Some(self.active.take().unwrap().bytes))
    }
}
