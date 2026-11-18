use super::aad;
use crate::{derive_field_key, encrypt_payload};
use anyhow::Result;
use cantrip_wire::{Value, value::json};
use hkdf::hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Bind the opaque RPC receipt to its exact command and logical server. The
/// keyed digest preserves replay identity without exposing guessable RPC text.
pub fn protect_native_command_result(
    component_key: &[u8],
    context: &Value,
    content: &Value,
) -> Result<(Value, String)> {
    let row = Sha256::digest(
        json!([
            context["serverId"].clone(),
            context["chatId"].clone(),
            context["operationId"].clone()
        ])
        .stringify()
        .as_bytes(),
    );
    let row: String = row.iter().map(|byte| format!("{byte:02x}")).collect();
    let associated = aad(
        context,
        &json!("chat-content"),
        &json!("native-command-admission"),
        &json!(row),
        &json!("result"),
    )?;
    let key = derive_field_key(component_key, &associated)?;
    let bytes = Zeroizing::new(content.stringify().into_bytes());
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&key).expect("32-byte HMAC key");
    mac.update(associated.stringify().as_bytes());
    mac.update(&bytes);
    let digest = mac.finalize().into_bytes();
    let digest = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((encrypt_payload(&key, &bytes, &associated)?, digest))
}
