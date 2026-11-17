use super::{aad, authenticate, open_field, seal_field};
use crate::{checked, decode, decryption_error, encode};
use anyhow::{Result, bail};
use cantrip_framing::remote_surface::{self, ProtectedPayload};
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const SURFACE_STREAM_BYTES_LIMIT: usize = 4 * 1024 * 1024;
pub use cantrip_framing::remote_surface::MAX_PROTECTED_PLAINTEXT_BYTES as REMOTE_STREAM_BYTES_LIMIT;

pub fn surface_stream_associated_data(context: &Value) -> Result<Value> {
    let binding = checked("surfaceStreamContextSchema", &context["context"])?;
    stream_aad(context, &binding, false)
}
pub fn remote_stream_associated_data(context: &Value) -> Result<Value> {
    let binding = checked("remoteSurfaceStreamContextSchema", &context["context"])?;
    stream_aad(context, &binding, true)
}
fn stream_aad(context: &Value, binding: &Value, remote: bool) -> Result<Value> {
    let server = binding["serverId"].as_js_string().unwrap().lossy();
    let mut row = vec![
        json!(encode(&Sha256::digest(server.as_bytes()))),
        binding["surfaceId"].clone(),
        binding[if remote {
            "attachmentId"
        } else {
            "operationId"
        }]
        .clone(),
        binding["direction"].clone(),
    ];
    if remote {
        row.push(binding["channel"].clone());
    }
    row.push(binding["sequence"].clone());
    let kind = binding["surfaceKind"].as_str().unwrap();
    aad(
        context,
        &json!("surface-private-state"),
        &json!(format!(
            "protocol:{}{kind}-stream",
            if remote { "remote-" } else { "" }
        )),
        &json!(Value::Array(row).stringify()),
        &json!(if remote {
            "protected_remote_surface_payload"
        } else {
            "protected_surface_stream"
        }),
    )
}
pub fn encrypt_surface_stream(key: &[u8], context: &Value, plaintext: &[u8]) -> Result<Value> {
    checked("surfaceStreamContextSchema", &context["context"])?;
    if plaintext.len() > SURFACE_STREAM_BYTES_LIMIT {
        bail!("Protected surface stream content is too large.");
    }
    let envelope = seal_field(key, &surface_stream_associated_data(context)?, plaintext)?;
    checked(
        "surfaceStreamOpaqueSchema",
        &json!({"formatVersion":1,"keyRevision":context["keyRevision"],"envelope":envelope}),
    )
}
pub fn decrypt_surface_stream(
    key: &[u8],
    context: &Value,
    opaque: &Value,
) -> Result<Zeroizing<Vec<u8>>> {
    let opaque = authenticate(|| {
        checked("surfaceStreamContextSchema", &context["context"])?;
        let opaque = checked("surfaceStreamOpaqueSchema", opaque)?;
        if opaque["keyRevision"] != context["keyRevision"]
            || opaque["envelope"]["keyRevision"] != context["keyRevision"]
        {
            return Err(decryption_error());
        }
        Ok(opaque)
    })?;
    // Unlike the binary remote-surface API, the reference exposes AAD/derivation
    // validation errors after its outer context/envelope authentication boundary.
    let plaintext = open_field(
        key,
        &surface_stream_associated_data(context)?,
        &opaque["envelope"],
    )?;
    if plaintext.len() > SURFACE_STREAM_BYTES_LIMIT {
        return Err(decryption_error());
    }
    Ok(plaintext)
}
pub fn encrypt_remote_stream(key: &[u8], context: &Value, plaintext: &[u8]) -> Result<Vec<u8>> {
    checked("remoteSurfaceStreamContextSchema", &context["context"])?;
    if plaintext.len() > REMOTE_STREAM_BYTES_LIMIT {
        bail!("Remote Surface stream content is too large.");
    }
    let envelope = seal_field(key, &remote_stream_associated_data(context)?, plaintext)?;
    let nonce = decode(envelope["nonce"].as_str().unwrap())?;
    let ciphertext = decode(envelope["ciphertext"].as_str().unwrap())?;
    remote_surface::encode_protected_payload(ProtectedPayload {
        key_revision: context["keyRevision"].as_u64().unwrap(),
        nonce: &nonce,
        ciphertext: &ciphertext,
    })
}
pub fn decrypt_remote_stream(
    key: &[u8],
    context: &Value,
    payload: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    authenticate(|| {
        checked("remoteSurfaceStreamContextSchema", &context["context"])?;
        let protected = remote_surface::decode_protected_payload(payload)?;
        if json!(protected.key_revision) != context["keyRevision"] {
            return Err(decryption_error());
        }
        let envelope = json!({"version":1,"algorithm":"AES-256-GCM","keyRevision":protected.key_revision,"nonce":encode(protected.nonce),"ciphertext":encode(protected.ciphertext)});
        let plaintext = open_field(key, &remote_stream_associated_data(context)?, &envelope)?;
        if plaintext.len() > REMOTE_STREAM_BYTES_LIMIT {
            return Err(decryption_error());
        }
        Ok(plaintext)
    })
}
