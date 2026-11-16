use super::{authenticate, decode_json, encode_json, open_field, seal_field};
use crate::{checked, decryption_error};
use anyhow::Result;
use cantrip_wire::{Value, value::json};
pub const LABEL_BYTES_LIMIT: usize = 4 * 1024;
pub fn private_label_associated_data(context: &Value) -> Result<Value> {
    let table = match context["recordKind"].as_str() {
        Some("project") => Some("projects"),
        Some("chat") => Some("chats"),
        Some("terminal") => Some("terminals"),
        Some("explorer") => Some("explorers"),
        Some("code-tab") => Some("code_tabs"),
        Some("browser") => Some("browsers"),
        Some("remote-surface") => Some("remote_surfaces"),
        Some("project-view") => Some("project_views"),
        Some("tab-group") => Some("tab_groups"),
        _ => None,
    };
    // An unknown kind has no table in the reference mapping.
    let value = json!({"ownerId":context.get("ownerId"),"component":"private-surface-metadata","table":table,"rowId":context.get("rowId"),"field":"protected_label","formatVersion":1,"keyRevision":context.get("keyRevision")});
    checked("encryptionAssociatedDataSchema", &value)
}
pub fn encrypt_private_label(key: &[u8], context: &Value, label: &Value) -> Result<Value> {
    let content = checked(
        "privateDisplayLabelProtectedContentSchema",
        &json!({"version":1,"classification":json!({"recordKind":context["recordKind"]}),"label":label}),
    )?;
    let plaintext = encode_json(
        "privateDisplayLabelProtectedContentSchema",
        &content,
        LABEL_BYTES_LIMIT,
        "Protected display label exceeds its encoded byte limit.",
    )?;
    let envelope = seal_field(key, &private_label_associated_data(context)?, &plaintext)?;
    checked(
        "privateDisplayLabelOpaqueSchema",
        &json!({"classification":content["classification"],"protectedLabel":json!({"formatVersion":1,"keyRevision":context["keyRevision"],"envelope":envelope})}),
    )
}
pub fn decrypt_private_label(key: &[u8], context: &Value, opaque: &Value) -> Result<Value> {
    let opaque = authenticate(|| {
        let opaque = checked("privateDisplayLabelOpaqueSchema", opaque)?;
        if opaque["protectedLabel"]["keyRevision"] != context["keyRevision"]
            || opaque["classification"]["recordKind"] != context["recordKind"]
        {
            return Err(decryption_error());
        }
        Ok(opaque)
    })?;
    let aad = private_label_associated_data(context)?;
    let plaintext = open_field(key, &aad, &opaque["protectedLabel"]["envelope"])?;
    let content = decode_json(
        "privateDisplayLabelProtectedContentSchema",
        &plaintext,
        LABEL_BYTES_LIMIT,
    )?;
    if content["classification"]["recordKind"] != opaque["classification"]["recordKind"] {
        return Err(decryption_error());
    }
    Ok(content["label"].clone())
}
