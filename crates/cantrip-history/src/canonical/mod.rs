//! Complete worker evidence and canonical content preparation, never input dispatch.
mod turns;
use crate::{checked, content::Encryption, parse, source_digest};
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::{
    Zeroizing,
    content::{Communication, decrypt_communication, encrypt_communication},
    decrypt_payload, derive_field_key, encrypt_payload,
};
use cantrip_wire::{Value, value::json};
pub use turns::*;

fn field_material(
    service: &dyn Encryption,
    row: Value,
    table: &str,
    field: &str,
    key_revision: Option<u64>,
) -> Result<(Value, Zeroizing<Vec<u8>>)> {
    let grant = service.material(key_revision)?;
    let mut row = row.as_array().unwrap().clone();
    row.insert(0, Value::String(grant.server_id));
    let aad = checked(
        "encryptionAssociatedDataSchema",
        &json!({"ownerId":grant.owner_id,"component":"chat-content","table":table,"rowId":source_digest(&Value::Array(row)),"field":field,"formatVersion":1,"keyRevision":grant.key_revision}),
    )?;
    let key = derive_field_key(&grant.key, &aad)?;
    Ok((aad, key))
}
fn open_json(key: &[u8], aad: &Value, envelope: &Value) -> Result<Value> {
    let plaintext = decrypt_payload(key, envelope, aad)?;
    let text = std::str::from_utf8(&plaintext)
        .map_err(|_| anyhow!("The encoded data was not valid for encoding utf-8"))?;
    parse(text.strip_prefix('\u{feff}').unwrap_or(text))
}
fn json_content(raw: &Value) -> Result<Value> {
    checked("historyContentJsonSchema", raw)
}
fn seal_json(key: &[u8], aad: &Value, value: &Value) -> Result<Value> {
    let plaintext = Zeroizing::new(value.stringify().into_bytes());
    encrypt_payload(key, &plaintext, aad)
}
fn source_item(raw: &Value, identity: &Value) -> Result<Value> {
    let source = checked("nativeHistoryStateItemSchema", raw)?;
    if source["id"] != identity["itemId"] || source["identityKind"] != identity["identityKind"] {
        bail!("Native item evidence does not match its historical identity.");
    }
    Ok(source)
}
fn item_material(
    service: &dyn Encryption,
    binding: &Value,
    identity: &Value,
    revision: &Value,
    key_revision: Option<u64>,
) -> Result<(Value, Zeroizing<Vec<u8>>)> {
    let identity = checked("nativeHistoryItemIdentitySchema", identity)?;
    if identity["threadId"] != binding["threadId"] {
        bail!("Native item evidence belongs to another history binding.");
    }
    if !revision
        .as_f64()
        .is_some_and(|v| v >= 1.0 && v.fract() == 0.0 && v <= 9007199254740991.0)
    {
        bail!("Native item evidence requires a positive safe revision.");
    }
    let row = json!([
        binding["workerId"].clone(),
        binding["chatId"].clone(),
        binding["id"].clone(),
        identity["threadId"].clone(),
        identity["turnId"].clone(),
        identity["itemId"].clone(),
        identity["identityKind"].clone(),
        identity["component"].clone(),
        revision.clone()
    ]);
    field_material(
        service,
        row,
        "native-history-items",
        "source-evidence",
        key_revision,
    )
}
pub fn protect_item(
    service: &dyn Encryption,
    binding: &Value,
    identity: &Value,
    revision: &Value,
    source: &Value,
) -> Result<Value> {
    let source = source_item(source, identity)?;
    let (aad, key) = item_material(service, binding, identity, revision, None)?;
    let content = seal_json(&key, &aad, &source)?;
    checked(
        "nativeHistoryItemEvidenceSchema",
        &json!({"version":1,"bindingId":binding["id"],"workerId":binding["workerId"],"revision":revision,"content":content}),
    )
}
pub fn open_item(
    service: &dyn Encryption,
    binding: &Value,
    identity: &Value,
    raw: &Value,
) -> Result<Value> {
    let evidence = checked("nativeHistoryItemEvidenceSchema", raw)?;
    if evidence["bindingId"] != binding["id"] || evidence["workerId"] != binding["workerId"] {
        bail!("Archived native evidence belongs to another source binding.");
    }
    let (aad, key) = item_material(
        service,
        binding,
        identity,
        &evidence["revision"],
        evidence["content"]["keyRevision"].as_u64(),
    )?;
    source_item(&open_json(&key, &aad, &evidence["content"])?, identity)
}
pub fn protect_message(service: &dyn Encryption, id: &Value, raw: &Value) -> Result<Value> {
    let content = checked("chatMessageContentSchema", &raw["content"])?;
    let grant = service.material(None)?;
    let ids = content
        .as_array()
        .unwrap()
        .iter()
        .filter(|part| part["type"] == "attachment")
        .map(|part| part["attachment"]["id"].clone())
        .collect::<Vec<_>>();
    let classification = json!({"role":raw["role"],"mode":raw.get("mode").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!("default")),"attachmentIds":ids});
    let context = json!({"ownerId":grant.owner_id,"messageId":id,"keyRevision":grant.key_revision});
    let protected = encrypt_communication(
        Communication::Message,
        &grant.key,
        &context,
        &json!({"version":1,"classification":classification,"content":content}),
    )?;
    checked(
        "chatMessageOpaqueContentSchema",
        &json!({"id":id,"classification":classification,"protectedContent":protected,"reasoningEffort":raw.get("reasoningEffort").filter(|v|!v.is_null()).cloned().unwrap_or(Value::Null),"idempotencyKey":raw.get("idempotencyKey")}),
    )
}
/// Source openMessage receives a selected component key, including legacy callers
/// that deliberately select their current key before opening the entire transcript.
pub fn open_message(component_key: &[u8], owner: &Value, message: &Value) -> Result<Value> {
    let classification=message.get("classification").cloned().unwrap_or_else(||json!({"role":message.get("role"),"mode":message.get("mode"),"attachmentIds":message.get("attachmentIds")}));
    let context = json!({"ownerId":owner,"messageId":message.get("id"),"keyRevision":message["protectedContent"]["keyRevision"]});
    let opened = decrypt_communication(
        Communication::Message,
        component_key,
        &context,
        &message["protectedContent"],
        Some(&classification),
    )?;
    checked("chatMessageContentSchema", &opened["content"])
}
pub fn prepare_item(
    service: &dyn Encryption,
    binding: &Value,
    rendered: &Value,
    mapping: &Value,
    revision: &Value,
    order: &Value,
    attachments: &Value,
) -> Result<Value> {
    let identity = checked("nativeHistoryItemIdentitySchema", &rendered["identity"])?;
    let mapped = checked("nativeHistoryItemIdentitySchema", &mapping["identity"])?;
    if identity.stringify() != mapped.stringify() {
        bail!("Native history preparation received an unrelated item mapping.");
    }
    let evidence = protect_item(service, binding, &identity, revision, &rendered["source"])?;
    let message = match mapping.get("preservedInput").filter(|v| !v.is_null()) {
        Some(message) => message.clone(),
        None => {
            let mut message = rendered["message"].clone();
            message["idempotencyKey"] = mapping["idempotencyKey"].clone();
            protect_message(service, &mapping["messageId"], &message)?
        }
    };
    if message["id"] != mapping["messageId"]
        || message["idempotencyKey"] != mapping["idempotencyKey"]
    {
        bail!("Preserved native input does not match its canonical message mapping.");
    }
    let prepared = checked(
        "nativeHistoryPreparedBatchSchema",
        &json!({"items":vec![json!({"identity":identity,"revision":revision,"state":rendered["source"]["lifecycle"],"order":order,"attachments":attachments,"message":message,"evidence":evidence})],"turns":Vec::<Value>::new()}),
    )?;
    Ok(prepared["items"].as_array().unwrap()[0].clone())
}
