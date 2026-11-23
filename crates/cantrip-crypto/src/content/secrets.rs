use super::{decode_json, encode_json, open_field, revision, seal_field};
use crate::checked;
use anyhow::Result;
use cantrip_wire::{Value, value::json};
/// packages/protocol/src/protected-secrets.ts.
pub const SECRET_BYTES_LIMIT: usize = 2 * 1024 * 1024;
pub fn secret_associated_data(context: &Value) -> Result<Value> {
    checked(
        "encryptionAssociatedDataSchema",
        &json!({"ownerId":context.get("ownerId"),"component":context.get("component"),"table":context.get("table"),"rowId":context.get("rowId"),"field":context.get("field"),"formatVersion":1,"keyRevision":context.get("keyRevision")}),
    )
}
pub fn encrypt_secret(
    key: &[u8],
    context: &Value,
    content: &Value,
    schema: &str,
    maximum: Option<usize>,
) -> Result<Value> {
    let aad = secret_associated_data(context)?;
    let plaintext = encode_json(
        schema,
        content,
        maximum.unwrap_or(SECRET_BYTES_LIMIT),
        "Protected secret exceeds its byte limit.",
    )?;
    let envelope = seal_field(key, &aad, &plaintext)?;
    checked(
        "protectedSecretEnvelopeSchema",
        &json!({"formatVersion":1,"keyRevision":context["keyRevision"],"envelope":envelope}),
    )
}
pub fn decrypt_secret(
    key: &[u8],
    context: &Value,
    encrypted: &Value,
    schema: &str,
    maximum: Option<usize>,
) -> Result<Value> {
    // The reference exposes outer schema/AAD errors and normalizes failures in
    // decrypted material, including invalid UTF-8/JSON/content and byte limits.
    let encrypted = checked("protectedSecretEnvelopeSchema", encrypted)?;
    revision(&encrypted, context)?;
    let aad = secret_associated_data(context)?;
    let plaintext = open_field(key, &aad, &encrypted["envelope"])?;
    decode_json(schema, &plaintext, maximum.unwrap_or(SECRET_BYTES_LIMIT))
}
