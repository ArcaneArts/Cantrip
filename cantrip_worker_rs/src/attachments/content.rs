//! Worker attachment-content grants are deliberately separate from chat-content.
use crate::{
    encryption::Service,
    native_items::{checked, obj, s},
};
use anyhow::{Result, bail};
use cantrip_crypto::content as attachments;
use cantrip_history::content::Material;
use cantrip_wire::{JsString, Value};
use std::sync::Arc;

pub trait Keys: Send + Sync {
    fn attachment_identity(&self) -> Result<(JsString, JsString)>;
    fn attachment_material(&self) -> Result<Material>;
}
pub struct ServiceKeys(pub Arc<Service>);
impl Keys for ServiceKeys {
    fn attachment_identity(&self) -> Result<(JsString, JsString)> {
        let (owner, server) = self.0.bound_identity()?;
        Ok((
            owner,
            server
                .as_js_string()
                .ok_or_else(|| anyhow::anyhow!("Native history has no verified server identity."))?
                .clone(),
        ))
    }
    fn attachment_material(&self) -> Result<Material> {
        let grant = self.0.bound_component("attachment-content", None)?;
        Ok(Material {
            owner_id: grant.owner_id,
            server_id: grant
                .server_id
                .as_js_string()
                .ok_or_else(|| anyhow::anyhow!("Native history has no verified server identity."))?
                .clone(),
            key_revision: grant.component.key_revision,
            key: grant.component.key,
        })
    }
}
fn context(material: &Material, chat: &Value, id: &Value) -> Value {
    obj([
        ("ownerId", s(material.owner_id.clone())),
        ("chatId", chat.clone()),
        ("attachmentId", id.clone()),
        ("keyRevision", Value::Number(material.key_revision as f64)),
    ])
}
pub fn protect(keys: &dyn Keys, chat: &Value, id: &Value, metadata: &Value) -> Result<Value> {
    let material = keys.attachment_material()?;
    attachments::encrypt_attachment_metadata(&material.key, &context(&material, chat, id), metadata)
}
pub fn open(keys: &dyn Keys, raw: &Value) -> Result<Value> {
    open_for(keys, raw, None)
}

pub(crate) fn open_for(
    keys: &dyn Keys,
    raw: &Value,
    binding: Option<(&JsString, &JsString)>,
) -> Result<Value> {
    let value = checked("chatAttachmentOpaqueSummarySchema", raw)?;
    let material = keys.attachment_material()?;
    if binding
        .is_some_and(|(owner, server)| &material.owner_id != owner || &material.server_id != server)
    {
        bail!("The worker binding changed while opening protected attachment metadata.");
    }
    if value["protectedMetadata"]["keyRevision"].as_u64() != Some(material.key_revision) {
        bail!("The attachment encryption key revision is unavailable.");
    }
    let metadata = attachments::decrypt_attachment_metadata(
        &material.key,
        &context(&material, &value["chatId"], &value["id"]),
        &value["protectedMetadata"],
    )?;
    if (value["status"].as_str() == Some("ready") && !metadata["error"].is_null())
        || (value["status"].as_str() == Some("failed") && metadata["error"].is_null())
    {
        bail!("Attachment status and protected metadata do not agree.");
    }
    let mut result = checked(
        "chatAttachmentSummarySchema",
        &obj([
            ("id", value["id"].clone()),
            ("chatId", value["chatId"].clone()),
            ("fileName", metadata["fileName"].clone()),
            ("mimeType", metadata["mimeType"].clone()),
            ("sizeBytes", value["sizeBytes"].clone()),
            ("kind", metadata["kind"].clone()),
            ("source", metadata["source"].clone()),
            ("status", value["status"].clone()),
            (
                "previewText",
                if metadata["error"].is_null() {
                    metadata["previewText"].clone()
                } else {
                    metadata["error"].clone()
                },
            ),
            ("createdAt", value["createdAt"].clone()),
        ]),
    )?;
    result["sha256"] = metadata["sha256"].clone();
    Ok(result)
}
