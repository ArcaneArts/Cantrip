use super::{aad, authenticate, decode_json, encode_json, open_field, revision, seal_field};
use crate::{checked, decryption_error};
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
pub const ATTACHMENT_METADATA_LIMIT: usize = 32 * 1024;
pub const ATTACHMENT_CHUNK_LIMIT: usize = 256 * 1024;
pub fn attachment_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn attachment_metadata_associated_data(context: &Value) -> Result<Value> {
    let row = Value::Array(vec![
        context["chatId"].clone(),
        context["attachmentId"].clone(),
    ])
    .stringify();
    aad(
        context,
        &json!("attachment-content"),
        &json!("chat_attachments"),
        &json!(row),
        &json!("protected_metadata"),
    )
}
pub fn attachment_chunk_associated_data(
    context: &Value,
    size: &Value,
    eof: &Value,
) -> Result<Value> {
    let row = Value::Array(vec![
        context["chatId"].clone(),
        context["attachmentId"].clone(),
        context["operationId"].clone(),
        context["direction"].clone(),
        context["sequence"].clone(),
        size.clone(),
        eof.clone(),
    ])
    .stringify();
    aad(
        context,
        &json!("attachment-content"),
        &json!("protocol:attachment-stream"),
        &json!(row),
        &json!("protected_chunk"),
    )
}
pub fn encrypt_attachment_metadata(key: &[u8], context: &Value, content: &Value) -> Result<Value> {
    let plaintext = encode_json(
        "attachmentMetadataProtectedContentSchema",
        content,
        ATTACHMENT_METADATA_LIMIT,
        "Protected attachment metadata exceeds its byte limit.",
    )?;
    let envelope = seal_field(
        key,
        &attachment_metadata_associated_data(context)?,
        &plaintext,
    )?;
    checked(
        "attachmentProtectedMetadataSchema",
        &json!({"formatVersion":1,"keyRevision":context["keyRevision"],"envelope":envelope}),
    )
}
pub fn decrypt_attachment_metadata(
    key: &[u8],
    context: &Value,
    encrypted: &Value,
) -> Result<Value> {
    let encrypted = authenticate(|| {
        let value = checked("attachmentProtectedMetadataSchema", encrypted)?;
        revision(&value, context)?;
        Ok(value)
    })?;
    let plaintext = open_field(
        key,
        &attachment_metadata_associated_data(context)?,
        &encrypted["envelope"],
    )?;
    decode_json(
        "attachmentMetadataProtectedContentSchema",
        &plaintext,
        ATTACHMENT_METADATA_LIMIT,
    )
}
pub fn encrypt_attachment_chunk(key: &[u8], context: &Value, plaintext: &[u8]) -> Result<Value> {
    if plaintext.len() > ATTACHMENT_CHUNK_LIMIT {
        bail!("Attachment chunk exceeds its byte limit.");
    }
    let envelope = seal_field(
        key,
        &attachment_chunk_associated_data(context, &json!(plaintext.len()), &context["eof"])?,
        plaintext,
    )?;
    checked(
        "attachmentChunkOpaqueSchema",
        &json!({"sequence":context["sequence"],"plaintextBytes":plaintext.len(),"eof":context["eof"],"envelope":envelope}),
    )
}
pub fn decrypt_attachment_chunk(
    key: &[u8],
    context: &Value,
    encrypted: &Value,
) -> Result<Zeroizing<Vec<u8>>> {
    let encrypted = authenticate(|| {
        let value = checked("attachmentChunkOpaqueSchema", encrypted)?;
        if value["sequence"] != context["sequence"]
            || value["envelope"]["keyRevision"] != context["keyRevision"]
        {
            return Err(decryption_error());
        }
        Ok(value)
    })?;
    let aad =
        attachment_chunk_associated_data(context, &encrypted["plaintextBytes"], &encrypted["eof"])?;
    let plaintext = open_field(key, &aad, &encrypted["envelope"])?;
    if plaintext.len() as u64 != encrypted["plaintextBytes"].as_u64().unwrap()
        || plaintext.len() > ATTACHMENT_CHUNK_LIMIT
    {
        return Err(decryption_error());
    }
    Ok(plaintext)
}
