//! Legacy CTTN frames, separate from the WorkerLink envelope/carrier.
use crate::wire::{self, Value};
use anyhow::{Result, bail};
use std::{ops::Range, sync::Arc};

pub const MAX_HEADER_BYTES: usize = 8 * 1024;
pub const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
pub const AUTH_TAG_BYTES: usize = 16;
pub const MAX_PAYLOAD_BYTES: usize = MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES;
pub const MAX_CREDIT_BYTES: usize = 8 * 1024 * 1024;
const MAGIC: &[u8; 4] = b"CTTN";
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
        bail!("Tunnel data payload exceeds the protocol limit.");
    }
    if header["kind"] == "data" && payload.is_empty() {
        bail!("Tunnel data frames require a payload.");
    }
    if header["kind"] != "data" && !payload.is_empty() {
        bail!("Tunnel control frames cannot contain a payload.");
    }
    if header["kind"] == "data" {
        let protected = header.get("protection").is_some();
        if protected && payload.len() <= AUTH_TAG_BYTES {
            bail!("Protected tunnel data requires ciphertext and an authentication tag.");
        }
        if !protected && payload.len() > MAX_PLAINTEXT_BYTES {
            bail!("Plaintext tunnel data exceeds the protocol limit.");
        }
    }
    Ok(())
}
pub fn create(header: Value, payload: &[u8]) -> Result<Frame> {
    let header =
        crate::settings::parse_response("tunnelDataPlaneFrameHeaderSchema", Some(&header))?;
    validate_payload(&header, payload)?;
    let encoded = header.stringify();
    if encoded.len() > MAX_HEADER_BYTES {
        bail!("Tunnel data header exceeds the protocol limit.");
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
        bail!("Tunnel data frame has an invalid magic value.");
    }
    let length = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if !(1..=MAX_HEADER_BYTES).contains(&length) {
        bail!("Tunnel data frame header length is invalid.");
    }
    let start = 8 + length;
    if start > bytes.len() {
        bail!("Tunnel data frame header is truncated.");
    }
    // WHATWG TextDecoder replaces malformed UTF-8 and consumes an initial BOM.
    // The shared parser retains JS number/string/duplicate-key/deep JSON rules.
    let text = String::from_utf8_lossy(&bytes[8..start]);
    let value = wire::parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|_| anyhow::anyhow!("Tunnel data frame header is not valid JSON."))?;
    let header = crate::settings::parse_response("tunnelDataPlaneFrameHeaderSchema", Some(&value))?;
    validate_payload(&header, &bytes[start..])?;
    let end = bytes.len();
    Ok(Frame {
        header,
        bytes,
        payload: start..end,
    })
}
