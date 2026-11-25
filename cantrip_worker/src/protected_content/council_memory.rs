use crate::encryption::BoundComponentKey;
use anyhow::{Result, ensure};
use cantrip_crypto::{Zeroizing, decrypt_payload, derive_field_key, encrypt_payload};
use cantrip_wire::{Value, value::json};

const BYTE_LIMIT: usize = 8 * 1024;

fn associated_data(grant: &BoundComponentKey, agent: &Value) -> Value {
    json!({
        "ownerId": grant.owner_id, "component":"chat-content", "table":"council_agents",
        "rowId":agent, "field":"memory", "formatVersion":1,
        "keyRevision":grant.component.key_revision,
    })
}

pub(crate) fn seal(grant: &BoundComponentKey, agent: &Value, text: &str) -> Result<Value> {
    ensure!(
        text.len() <= BYTE_LIMIT,
        "Council memory is limited to 8 KiB."
    );
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    let aad = associated_data(grant, agent);
    let key = derive_field_key(&grant.component.key, &aad)?;
    Ok(encrypt_payload(&key, text.as_bytes(), &aad)?)
}

pub(crate) fn open(
    grant: &BoundComponentKey,
    agent: &Value,
    envelope: &Value,
) -> Result<Zeroizing<Vec<u8>>> {
    let aad = associated_data(grant, agent);
    let key = derive_field_key(&grant.component.key, &aad)?;
    let text = decrypt_payload(&key, envelope, &aad)?;
    ensure!(
        text.len() <= BYTE_LIMIT,
        "Council memory is limited to 8 KiB."
    );
    Ok(text)
}
