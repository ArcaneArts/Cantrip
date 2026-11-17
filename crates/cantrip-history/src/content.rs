//! Exact history-specific key/AAD domains from native-history-content.ts.
use crate::source_digest;
use anyhow::{Result, anyhow};
use cantrip_crypto::{Zeroizing, checked, decrypt_payload, derive_field_key, encrypt_payload};
use cantrip_wire::{JsString, Value, value::json};

/// A copied atomic grant; secrets are wiped on every success/error path.
pub struct Material {
    pub owner_id: JsString,
    pub server_id: JsString,
    pub key_revision: u64,
    pub key: Zeroizing<Vec<u8>>,
}
/// Supplied by the worker's real authorized encryption service. A journal never
/// refreshes grants or persists plaintext keys. Identity may change/revoke.
pub trait Encryption: Send + Sync {
    fn identity(&self) -> Result<(JsString, JsString)>;
    fn material(&self, revision: Option<u64>) -> Result<Material>;
}
#[derive(Clone, Copy)]
pub enum Field {
    PreparedBatch,
    SourceRecord,
    ProjectionState,
    ProjectionRebase,
    OutboxBaseline,
    OutboxMutation,
}
impl Field {
    pub fn name(self) -> &'static str {
        match self {
            Self::PreparedBatch => "prepared-batch",
            Self::SourceRecord => "source-record",
            Self::ProjectionState => "projection-state",
            Self::ProjectionRebase => "projection-rebase",
            Self::OutboxBaseline => "outbox-baseline",
            Self::OutboxMutation => "outbox-mutation",
        }
    }
    fn table(self) -> &'static str {
        match self {
            Self::SourceRecord => "native-history-source",
            Self::ProjectionState | Self::ProjectionRebase => "native-history-projection",
            _ => "native-history-outbox",
        }
    }
}
fn material(
    service: &dyn Encryption,
    context: &Value,
    revision: Option<u64>,
    field: Field,
) -> Result<(Value, Zeroizing<Vec<u8>>)> {
    let component = service.material(revision)?;
    let row = json!([
        json!(component.server_id),
        context["workerId"].clone(),
        context["chatId"].clone(),
        context["bindingId"].clone(),
        context["streamId"].clone(),
        context["sequence"].clone(),
        context["recordId"].clone(),
        context["previousDigest"].clone()
    ]);
    let aad = checked(
        "encryptionAssociatedDataSchema",
        &json!({"ownerId":component.owner_id,"component":"chat-content","table":field.table(),"rowId":source_digest(&row),"field":field.name(),"formatVersion":1,"keyRevision":component.key_revision}),
    )?;
    let key = derive_field_key(&component.key, &aad)?;
    Ok((aad, key))
}
pub fn protect(
    service: &dyn Encryption,
    context: &Value,
    body: &JsString,
    field: Field,
) -> Result<Value> {
    let (aad, key) = material(service, context, None, field)?;
    let plaintext = Zeroizing::new(body.lossy().as_bytes().to_vec());
    encrypt_payload(&key, &plaintext, &aad)
}
pub fn open(
    service: &dyn Encryption,
    context: &Value,
    envelope: &Value,
    field: Field,
) -> Result<Zeroizing<String>> {
    let (aad, key) = material(service, context, envelope["keyRevision"].as_u64(), field)?;
    let plaintext = decrypt_payload(&key, envelope, &aad)?;
    let text = std::str::from_utf8(&plaintext)
        .map_err(|_| anyhow!("The encoded data was not valid for encoding utf-8"))?;
    Ok(Zeroizing::new(
        text.strip_prefix('\u{feff}').unwrap_or(text).to_owned(),
    ))
}
