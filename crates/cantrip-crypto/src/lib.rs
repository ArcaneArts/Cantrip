//! Endpoint cryptography; no network, server, database, or process-global keys.
//! Protocol validation is shared; cryptographic operations execute natively.
mod derivation;
mod hpke;
mod payload;

pub use derivation::{blind_lookup_tag, derive_component_key, derive_field_key, derive_lookup_key};
pub use hpke::{
    HpkeKeyPair, unwrap_component_key, unwrap_key, worker_grant_aad, wrap_component_key, wrap_key,
};
pub use payload::{decrypt_payload, encrypt_payload, parse_payload, serialize_payload};
pub use zeroize::Zeroizing;

use anyhow::{Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_wire::{Value, value::json};

pub const DECRYPTION_ERROR: &str = "Encrypted material could not be authenticated.";

pub fn checked(schema: &str, input: &Value) -> Result<Value> {
    cantrip_protocol::parse(schema, Some(input)).map_err(cantrip_protocol::response::response_error)
}
pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn decode(value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| anyhow!("Value is not canonical unpadded base64url."))
}
pub fn require_length(bytes: &[u8], length: usize, label: &str) -> Result<()> {
    if bytes.len() != length {
        bail!("{label} must contain exactly {length} bytes.");
    }
    Ok(())
}
pub fn random_bytes(length: usize) -> Result<Zeroizing<Vec<u8>>> {
    if !(1..=65_536).contains(&length) {
        bail!("Secure random byte length is out of range.");
    }
    let mut bytes = Zeroizing::new(vec![0; length]);
    getrandom::fill(&mut bytes).map_err(|_| anyhow!("Secure random bytes are unavailable."))?;
    Ok(bytes)
}
/// Schema validation followed by the exact field order used by TextEncoder in
/// packages/crypto. stringify escapes lone UTF-16 surrogates before UTF-8 encoding.
pub fn associated_data(input: &Value) -> Result<Vec<u8>> {
    let v = checked("encryptionAssociatedDataSchema", input)?;
    Ok(json!({"component":v["component"],"field":v["field"],"formatVersion":v["formatVersion"],"keyRevision":v["keyRevision"],"ownerId":v["ownerId"],"rowId":v["rowId"],"table":v["table"]}).stringify().into_bytes())
}
pub(crate) fn encoded_field(value: &Value, field: &str) -> Result<Vec<u8>> {
    decode(
        value[field]
            .as_str()
            .ok_or_else(|| anyhow!("Expected encoded bytes."))?,
    )
}
