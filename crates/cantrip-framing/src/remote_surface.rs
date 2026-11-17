//! Legacy CTRS carrier used independently of WorkerLink's framed transport.
use anyhow::{Result, bail};
use cantrip_protocol::{self as wire, Value};
use std::{ops::Range, sync::Arc};
pub const MAX_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
pub const PROTECTED_HEADER_BYTES: usize = 21;
pub const PROTECTED_TAG_BYTES: usize = 16;
pub const MAX_PROTECTED_PLAINTEXT_BYTES: usize =
    MAX_PAYLOAD_BYTES - PROTECTED_HEADER_BYTES - PROTECTED_TAG_BYTES;

/// Borrowed parts of the existing binary endpoint-encrypted payload. This
/// framing validates metadata and lengths; it provides no authentication.
pub struct ProtectedPayload<'a> {
    pub key_revision: u64,
    pub nonce: &'a [u8],
    pub ciphertext: &'a [u8],
}
pub fn encode_protected_payload(input: ProtectedPayload<'_>) -> Result<Vec<u8>> {
    wire::response::parse_response(
        "encryptionKeyRevisionSchema",
        Some(&wire::value::json!(input.key_revision)),
    )?;
    if input.nonce.len() != 12 {
        bail!("Remote Surface protected payload nonce is invalid.");
    }
    if input.ciphertext.len() < PROTECTED_TAG_BYTES {
        bail!("Remote Surface protected payload ciphertext is invalid.");
    }
    if input.ciphertext.len() - PROTECTED_TAG_BYTES > MAX_PROTECTED_PLAINTEXT_BYTES {
        bail!("Remote Surface protected payload is too large.");
    }
    let mut bytes = Vec::with_capacity(PROTECTED_HEADER_BYTES + input.ciphertext.len());
    bytes.push(1);
    bytes.extend_from_slice(&input.key_revision.to_be_bytes());
    bytes.extend_from_slice(input.nonce);
    bytes.extend_from_slice(input.ciphertext);
    Ok(bytes)
}
pub fn decode_protected_payload(bytes: &[u8]) -> Result<ProtectedPayload<'_>> {
    if bytes.len() < PROTECTED_HEADER_BYTES + PROTECTED_TAG_BYTES {
        bail!("Remote Surface protected payload is truncated.");
    }
    if bytes[0] != 1 {
        bail!("Remote Surface protected payload version is unsupported.");
    }
    let key_revision = u64::from_be_bytes(bytes[1..9].try_into().unwrap());
    if key_revision > 9_007_199_254_740_991 {
        bail!("Remote Surface protected payload revision is invalid.");
    }
    wire::response::parse_response(
        "encryptionKeyRevisionSchema",
        Some(&wire::value::json!(key_revision)),
    )?;
    if bytes.len() > MAX_PAYLOAD_BYTES {
        bail!("Remote Surface protected payload is too large.");
    }
    Ok(ProtectedPayload {
        key_revision,
        nonce: &bytes[9..PROTECTED_HEADER_BYTES],
        ciphertext: &bytes[PROTECTED_HEADER_BYTES..],
    })
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
pub fn create(header: Value, payload: &[u8]) -> Result<Frame> {
    let header = cantrip_protocol::response::parse_response(
        "remoteSurfaceFrameHeaderSchema",
        Some(&header),
    )?;
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
    let header =
        cantrip_protocol::response::parse_response("remoteSurfaceFrameHeaderSchema", Some(&value))?;
    Ok(Frame {
        header,
        bytes,
        payload: start..end,
    })
}
