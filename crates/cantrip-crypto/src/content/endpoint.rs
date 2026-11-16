use super::{aad, authenticate, open_field, seal_field};
use crate::{checked, decryption_error, encode};
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
/// packages/protocol/src/endpoint-content.ts.
pub const ENDPOINT_BYTES_LIMIT: usize = 16 * 1024 * 1024;
pub fn endpoint_associated_data(context: &Value) -> Result<Value> {
    let binding = checked("endpointContentContextSchema", &context["context"])?;
    let server = binding["serverId"].as_js_string().unwrap().lossy();
    let row = Value::Array(vec![
        json!(encode(&Sha256::digest(server.as_bytes()))),
        binding["workerId"].clone(),
        binding["scopeId"].clone(),
        binding["operationId"].clone(),
        binding["operation"].clone(),
        binding["direction"].clone(),
        binding["sequence"].clone(),
    ])
    .stringify();
    aad(
        context,
        &binding["domain"],
        &json!(format!("protocol:{}", binding["domain"].as_str().unwrap())),
        &json!(row),
        &json!("protected_endpoint_content"),
    )
}
pub fn encrypt_endpoint(key: &[u8], context: &Value, plaintext: &[u8]) -> Result<Value> {
    let binding = checked("endpointContentContextSchema", &context["context"])?;
    if plaintext.len() > ENDPOINT_BYTES_LIMIT {
        bail!("Protected endpoint content is too large.");
    }
    let aad = endpoint_associated_data(context)?;
    let envelope = seal_field(key, &aad, plaintext)?;
    checked(
        "endpointContentOpaqueSchema",
        &json!({"formatVersion":1,"domain":binding["domain"],"keyRevision":context["keyRevision"],"envelope":envelope}),
    )
}
pub fn decrypt_endpoint(key: &[u8], context: &Value, opaque: &Value) -> Result<Zeroizing<Vec<u8>>> {
    authenticate(|| {
        let binding = checked("endpointContentContextSchema", &context["context"])?;
        let opaque = checked("endpointContentOpaqueSchema", opaque)?;
        if opaque["formatVersion"] != 1
            || opaque["domain"] != binding["domain"]
            || opaque["keyRevision"] != context["keyRevision"]
            || opaque["envelope"]["keyRevision"] != context["keyRevision"]
        {
            return Err(decryption_error());
        }
        let plaintext = open_field(
            key,
            &endpoint_associated_data(context)?,
            &opaque["envelope"],
        )?;
        if plaintext.len() > ENDPOINT_BYTES_LIMIT {
            return Err(decryption_error());
        }
        Ok(plaintext)
    })
}
