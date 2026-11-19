//! Open the existing policy field format at the endpoint using a verified grant.
use crate::encryption::Service;
use anyhow::{Context, Result};
use cantrip_crypto::content::decrypt_secret;
use cantrip_wire::{Value, value::json};

pub(crate) fn open_policy_summary(
    encryption: &Service,
    id: &Value,
    opaque: &Value,
) -> Result<Value> {
    open_policy(
        encryption,
        id,
        opaque,
        "protected_summary",
        "policyProtectedSummaryContentSchema",
        8 * 1024,
    )
}

pub(crate) fn open_policy_body(encryption: &Service, id: &Value, opaque: &Value) -> Result<Value> {
    open_policy(
        encryption,
        id,
        opaque,
        "protected_body",
        "policyProtectedBodyContentSchema",
        128 * 1024,
    )
}

fn open_policy(
    encryption: &Service,
    id: &Value,
    opaque: &Value,
    field: &str,
    schema: &str,
    limit: usize,
) -> Result<Value> {
    let revision = opaque["keyRevision"]
        .as_u64()
        .context("Policy key revision")?;
    let grant = encryption.bound_component("policy-content", Some(revision))?;
    let binding = json!({
        "ownerId":grant.owner_id, "component":"policy-content", "table":"policies",
        "rowId":id, "field":field, "keyRevision":grant.component.key_revision,
    });
    decrypt_secret(&grant.component.key, &binding, opaque, schema, Some(limit))
}
