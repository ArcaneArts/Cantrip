use super::aad;
use crate::{decrypt_payload, derive_field_key, encrypt_payload, hmac_sha256};
use anyhow::Result;
use cantrip_wire::{Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Bind the opaque RPC receipt to its exact command and logical server. The
/// keyed digest preserves replay identity without exposing guessable RPC text.
pub fn protect_native_command_result(
    component_key: &[u8],
    context: &Value,
    content: &Value,
) -> Result<(Value, String)> {
    protect(component_key, context, "result", content)
}

pub fn protect_native_command_terminal_result(
    component_key: &[u8],
    context: &Value,
    content: &Value,
) -> Result<(Value, String)> {
    protect(component_key, context, "terminal-result", content)
}

pub fn protect_native_command_request(
    component_key: &[u8],
    context: &Value,
    content: &Value,
) -> Result<(Value, String)> {
    protect(component_key, context, "request", content)
}

pub fn open_native_command_result(
    component_key: &[u8],
    context: &Value,
    envelope: &Value,
) -> Result<Value> {
    let associated = associated(context, "result")?;
    let key = derive_field_key(component_key, &associated)?;
    let bytes = decrypt_payload(&key, envelope, &associated)?;
    parse_json_text(&String::from_utf8_lossy(&bytes))
        .map_err(|_| anyhow::anyhow!("Invalid protected native command result."))
}

pub fn protect_native_settings_evidence(
    component_key: &[u8],
    context: &Value,
    content: &Value,
) -> Result<(Value, String)> {
    if context["eventId"].as_str().is_none_or(str::is_empty) {
        anyhow::bail!("Native settings evidence requires its event identity.");
    }
    protect(component_key, context, "settings-evidence", content)
}

fn protect(
    component_key: &[u8],
    context: &Value,
    field: &str,
    content: &Value,
) -> Result<(Value, String)> {
    let associated = associated(context, field)?;
    let key = derive_field_key(component_key, &associated)?;
    let bytes = Zeroizing::new(content.stringify().into_bytes());
    let digest = hmac_sha256(&key, &[associated.stringify().as_bytes(), &bytes])?;
    let digest = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((encrypt_payload(&key, &bytes, &associated)?, digest))
}

fn associated(context: &Value, field: &str) -> Result<Value> {
    let mut identity = vec![
        context["serverId"].clone(),
        context["chatId"].clone(),
        context["operationId"].clone(),
    ];
    if field == "settings-evidence" {
        identity.push(context["eventId"].clone());
    }
    let row = Sha256::digest(Value::Array(identity).stringify().as_bytes());
    let row: String = row.iter().map(|byte| format!("{byte:02x}")).collect();
    aad(
        context,
        &json!("chat-content"),
        &json!("native-command-admission"),
        &json!(row),
        &json!(field),
    )
}
