use super::{authentication_error, context, decode_content, encode_content};
use crate::encryption::{BoundComponentKey, Service};
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::{
    checked,
    content::{decrypt_repository_operation, encrypt_repository_operation},
};
use cantrip_wire::Value;
use indexmap::IndexMap;

fn material(
    service: &Service,
    revision: Option<u64>,
    historical: bool,
) -> Result<BoundComponentKey> {
    let grant = service
        .bound_component(
            "repository-content",
            if historical { revision } else { None },
        )
        .map_err(|_| anyhow!("Repository content encryption is unavailable."))?;
    if revision.is_some_and(|revision| revision != grant.component.key_revision) {
        bail!("Protected repository content uses a stale key.");
    }
    Ok(grant)
}

pub fn protect_repository_content(
    service: &Service,
    binding: &Value,
    content: &Value,
    schema: &str,
) -> Result<Value> {
    let grant = material(service, None, false)?;
    let plaintext = encode_content(schema, content)?;
    encrypt_repository_operation(&grant.component.key, &context(&grant, binding), &plaintext)
}

/// Historical revisions require the caller's durable server-owned admission.
/// Ordinary repository commands always select the latest active revision.
pub fn open_repository_content(
    service: &Service,
    binding: &Value,
    opaque: &Value,
    schema: &str,
    allow_historical: bool,
) -> Result<Value> {
    let opaque = checked("repositoryOperationOpaqueSchema", opaque)?;
    let grant = material(service, opaque["keyRevision"].as_u64(), allow_historical)?;
    let plaintext =
        decrypt_repository_operation(&grant.component.key, &context(&grant, binding), &opaque)
            .map_err(|error| {
                authentication_error(
                    error,
                    "Protected repository content could not be authenticated.",
                )
            })?;
    decode_content(schema, &plaintext)
}

/// A reservation is consumed before opening. Failed authentication or dispatch
/// never releases it. The owning worker runtime retains this across reconnects.
#[derive(Default)]
pub struct RepositoryOperationReplayGuard {
    completed: IndexMap<String, ()>,
}
impl RepositoryOperationReplayGuard {
    pub fn reserve(&mut self, context: &Value) -> Result<()> {
        let key = Value::Array(vec![
            context["serverId"].clone(),
            context["projectId"].clone(),
            context["worktreeId"].clone(),
            context["operationId"].clone(),
        ])
        .stringify();
        if self.completed.contains_key(&key) {
            bail!("Protected repository operation was already completed.");
        }
        self.completed.insert(key, ());
        if self.completed.len() > 10_000 {
            self.completed.shift_remove_index(0);
        }
        Ok(())
    }
}
