//! Legacy CTRS carrier used independently of WorkerLink's framed transport.
use crate::wire::{self, Value};
use anyhow::{Result, bail};
use std::{ops::Range, sync::Arc};
pub const MAX_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
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
pub fn create(header: Value, payload: &[u8]) -> Result<Frame> {
    let header = crate::settings::parse_response("remoteSurfaceFrameHeaderSchema", Some(&header))?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        bail!("Remote Surface payload exceeds the protocol limit.");
    }
    let encoded = header.stringify();
    if encoded.len() > MAX_HEADER_BYTES {
        bail!("Remote Surface header exceeds the protocol limit.");
    }
    let mut bytes = Vec::with_capacity(8 + encoded.len() + payload.len());
    bytes.extend_from_slice(b"CTRS");
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
    if bytes.len() < 8 {
        bail!("Remote Surface frame is truncated.");
    }
    if &bytes[..4] != b"CTRS" {
        bail!("Remote Surface frame has an invalid magic value.");
    }
    let length = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if !(1..=MAX_HEADER_BYTES).contains(&length) {
        bail!("Remote Surface frame header length is invalid.");
    }
    let start = 8 + length;
    let end = bytes.len();
    if start > end {
        bail!("Remote Surface frame header is truncated.");
    }
    if end - start > MAX_PAYLOAD_BYTES {
        bail!("Remote Surface payload exceeds the protocol limit.");
    }
    let raw = String::from_utf8_lossy(&bytes[8..start]);
    let value = wire::parse_json_text(raw.strip_prefix('\u{feff}').unwrap_or(&raw))
        .map_err(|_| anyhow::anyhow!("Remote Surface frame header is not valid JSON."))?;
    let header = crate::settings::parse_response("remoteSurfaceFrameHeaderSchema", Some(&value))?;
    Ok(Frame {
        header,
        bytes,
        payload: start..end,
    })
}
