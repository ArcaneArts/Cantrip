use super::{aad, authenticate, open_field, seal_field};
use crate::{checked, decryption_error, encode};
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const REPOSITORY_OPERATION_BYTES_LIMIT: usize = 16 * 1024 * 1024;

/// packages/crypto/src/repository-operation.ts. The routing context, including
/// direction, is authenticated independently from the encrypted request body.
pub fn repository_operation_associated_data(context: &Value) -> Result<Value> {
    let binding = checked("repositoryOperationContextSchema", &context["context"])?;
    let server = binding["serverId"].as_js_string().unwrap().lossy();
    let row = Value::Array(vec![
        json!(encode(&Sha256::digest(server.as_bytes()))),
        binding["projectId"].clone(),
        binding["worktreeId"].clone(),
        binding["operationId"].clone(),
        binding["direction"].clone(),
    ])
    .stringify();
    aad(
        context,
        &json!("repository-content"),
        &json!("protocol:repository-operation"),
        &json!(row),
        &json!("protected_repository_operation"),
    )
}

pub fn encrypt_repository_operation(
    key: &[u8],
    context: &Value,
    plaintext: &[u8],
) -> Result<Value> {
    checked("repositoryOperationContextSchema", &context["context"])?;
    if plaintext.len() > REPOSITORY_OPERATION_BYTES_LIMIT {
        bail!("Protected repository operation content is too large.");
    }
    let envelope = seal_field(
        key,
        &repository_operation_associated_data(context)?,
        plaintext,
    )?;
    checked(
        "repositoryOperationOpaqueSchema",
        &json!({"formatVersion":1,"keyRevision":context["keyRevision"],"envelope":envelope}),
    )
}

pub fn decrypt_repository_operation(
    key: &[u8],
    context: &Value,
    opaque: &Value,
) -> Result<Zeroizing<Vec<u8>>> {
    authenticate(|| {
        checked("repositoryOperationContextSchema", &context["context"])?;
        let opaque = checked("repositoryOperationOpaqueSchema", opaque)?;
        if opaque["formatVersion"] != 1
            || opaque["keyRevision"] != context["keyRevision"]
            || opaque["envelope"]["keyRevision"] != context["keyRevision"]
        {
            return Err(decryption_error());
        }
        let plaintext = open_field(
            key,
            &repository_operation_associated_data(context)?,
            &opaque["envelope"],
        )?;
        if plaintext.len() > REPOSITORY_OPERATION_BYTES_LIMIT {
            return Err(decryption_error());
        }
        Ok(plaintext)
    })
}
