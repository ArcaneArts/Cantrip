use super::{authentication_error, context, decode_content, encode_content};
use crate::encryption::{BoundComponentKey, Service};
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::{
    Zeroizing, checked,
    content::{decrypt_endpoint, encrypt_endpoint},
};
use cantrip_wire::Value;

fn material(
    service: &Service,
    binding: &Value,
    revision: Option<u64>,
) -> Result<BoundComponentKey> {
    let grant = service
        .bound_component(binding["domain"].as_str().unwrap(), revision)
        .map_err(|_| anyhow!("Endpoint content encryption is unavailable."))?;
    if revision.is_some_and(|revision| revision != grant.component.key_revision) {
        bail!("Protected endpoint content uses a stale key.");
    }
    Ok(grant)
}
pub fn protect_endpoint_bytes(
    service: &Service,
    binding: &Value,
    plaintext: &[u8],
) -> Result<Value> {
    let binding = checked("endpointContentContextSchema", binding)?;
    let grant = material(service, &binding, None)?;
    encrypt_endpoint(&grant.component.key, &context(&grant, &binding), plaintext)
}
pub fn open_endpoint_bytes(
    service: &Service,
    binding: &Value,
    opaque: &Value,
) -> Result<Zeroizing<Vec<u8>>> {
    let binding = checked("endpointContentContextSchema", binding)?;
    let opaque = checked("endpointContentOpaqueSchema", opaque)?;
    let grant = material(service, &binding, opaque["keyRevision"].as_u64())?;
    decrypt_endpoint(&grant.component.key, &context(&grant, &binding), &opaque).map_err(|error| {
        authentication_error(
            error,
            "Protected endpoint content could not be authenticated.",
        )
    })
}
pub fn protect_endpoint_content(
    service: &Service,
    binding: &Value,
    content: &Value,
    schema: &str,
) -> Result<Value> {
    let binding = checked("endpointContentContextSchema", binding)?;
    let grant = material(service, &binding, None)?;
    let plaintext = encode_content(schema, content)?;
    encrypt_endpoint(&grant.component.key, &context(&grant, &binding), &plaintext)
}
pub fn open_endpoint_content(
    service: &Service,
    binding: &Value,
    opaque: &Value,
    schema: &str,
) -> Result<Value> {
    let plaintext = open_endpoint_bytes(service, binding, opaque)?;
    decode_content(schema, &plaintext)
}
