use super::{authentication_error, context, decode_content_with_input, encode_content};
use crate::encryption::{BoundComponentKey, Service};
use anyhow::{Result, anyhow, bail, ensure};
use cantrip_crypto::{Zeroizing, checked, content::*};
use cantrip_framing::remote_surface::decode_protected_payload;
use cantrip_wire::{JsString, Value};

fn material(service: &Service, revision: Option<u64>, remote: bool) -> Result<BoundComponentKey> {
    // Surface consumers deliberately use only the latest grant, unlike endpoint
    // consumers which can select an explicitly granted historical revision.
    let grant = service
        .bound_component("surface-private-state", None)
        .map_err(|_| {
            anyhow!(if remote {
                "Remote Surface stream encryption is unavailable."
            } else {
                "Surface stream encryption is unavailable."
            })
        })?;
    if revision.is_some_and(|revision| revision != grant.component.key_revision) {
        bail!(if remote {
            "Protected Remote Surface content uses a stale key."
        } else {
            "Protected surface content uses a stale key revision."
        });
    }
    Ok(grant)
}
pub fn protect_surface_content(
    service: &Service,
    binding: &Value,
    content: &Value,
    schema: &str,
) -> Result<Value> {
    let grant = material(service, None, false)?;
    seal(&grant, binding, content, schema)
}

fn seal(
    grant: &BoundComponentKey,
    binding: &Value,
    content: &Value,
    schema: &str,
) -> Result<Value> {
    let plaintext = encode_content(schema, content)?;
    encrypt_surface_stream(&grant.component.key, &context(grant, binding), &plaintext)
}
pub fn open_surface_content(
    service: &Service,
    binding: &Value,
    opaque: &Value,
    schema: &str,
) -> Result<Value> {
    open_surface_content_with_input(service, binding, opaque, schema).map(|(parsed, _)| parsed)
}
/// Preserve source fields where JavaScript normalization affects later behavior
/// (for example, a trimmed search query's locale-casing path). Both values remain
/// worker-local; consumers must execute only the validated first value.
pub fn open_surface_content_with_input(
    service: &Service,
    binding: &Value,
    opaque: &Value,
    schema: &str,
) -> Result<(Value, Value)> {
    let opaque = checked("surfaceStreamOpaqueSchema", opaque)?;
    let grant = material(service, opaque["keyRevision"].as_u64(), false)?;
    open(&grant, binding, &opaque, schema)
}

fn open(
    grant: &BoundComponentKey,
    binding: &Value,
    opaque: &Value,
    schema: &str,
) -> Result<(Value, Value)> {
    let plaintext = decrypt_surface_stream(&grant.component.key, &context(grant, binding), opaque)
        .map_err(|error| {
            authentication_error(
                error,
                "Protected surface content could not be authenticated.",
            )
        })?;
    decode_content_with_input(schema, &plaintext)
}

pub(crate) struct BoundSurfaceContent<'a> {
    pub service: &'a Service,
    pub owner_id: &'a JsString,
}

impl BoundSurfaceContent<'_> {
    fn grant(&self, binding: &Value, revision: Option<u64>) -> Result<BoundComponentKey> {
        let grant = material(self.service, revision, false)?;
        ensure!(
            grant.owner_id == *self.owner_id && grant.server_id == binding["serverId"],
            "The worker binding changed during protected surface processing."
        );
        Ok(grant)
    }

    pub fn seal(&self, binding: &Value, content: &Value, schema: &str) -> Result<Value> {
        seal(&self.grant(binding, None)?, binding, content, schema)
    }

    pub fn open(&self, binding: &Value, opaque: &Value, schema: &str) -> Result<Value> {
        let opaque = checked("surfaceStreamOpaqueSchema", opaque)?;
        let grant = self.grant(binding, opaque["keyRevision"].as_u64())?;
        open(&grant, binding, &opaque, schema).map(|(parsed, _)| parsed)
    }
}
pub fn protect_remote_surface(
    service: &Service,
    binding: &Value,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let binding = checked("remoteSurfaceStreamContextSchema", binding)?;
    if plaintext.len() > REMOTE_STREAM_BYTES_LIMIT {
        bail!("Remote Surface stream content is too large.");
    }
    let grant = material(service, None, true)?;
    encrypt_remote_stream(&grant.component.key, &context(&grant, &binding), plaintext)
}
pub fn open_remote_surface(
    service: &Service,
    binding: &Value,
    payload: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    let open = || {
        let binding = checked("remoteSurfaceStreamContextSchema", binding)?;
        let protected = decode_protected_payload(payload)?;
        let grant = material(service, Some(protected.key_revision), true)?;
        decrypt_remote_stream(&grant.component.key, &context(&grant, &binding), payload)
    };
    open().map_err(|_| anyhow!("Protected Remote Surface content could not be authenticated."))
}
