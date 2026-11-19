//! Existing protected content formats. Authorization, replay and resource
//! lifetime policies remain in the owning worker adapters.
mod attachments;
mod communication;
mod endpoint;
mod labels;
mod native_command;
mod native_resources;
mod private_state;
mod repository;
mod secrets;
mod streams;
mod tunnel;
use crate::{checked, decrypt_payload, decryption_error, derive_field_key, encrypt_payload};
use anyhow::{Result, bail};
pub use attachments::*;
use cantrip_wire::{Value, parse_json_text, value::json};
pub use communication::*;
pub use endpoint::*;
pub use labels::*;
pub use native_command::{
    protect_native_command_request, protect_native_command_result,
    protect_native_command_terminal_result, protect_native_settings_evidence,
};
pub use native_resources::{NativeResourceComponent, open_native_resources, seal_native_resources};
pub use private_state::*;
pub use repository::*;
pub use secrets::*;
pub use streams::*;
pub use tunnel::*;
use zeroize::Zeroizing;

pub(crate) fn aad(
    context: &Value,
    component: &Value,
    table: &Value,
    row: &Value,
    field: &Value,
) -> Result<Value> {
    checked(
        "encryptionAssociatedDataSchema",
        &json!({"ownerId":context.get("ownerId"),"component":component,"table":table,"rowId":row,"field":field,"formatVersion":1,"keyRevision":context.get("keyRevision")}),
    )
}
pub(crate) fn encode_json(
    schema: &str,
    content: &Value,
    limit: usize,
    message: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    let bytes = Zeroizing::new(checked(schema, content)?.stringify().into_bytes());
    if bytes.len() > limit {
        bail!("{message}");
    }
    Ok(bytes)
}
pub(crate) fn decode_json(schema: &str, bytes: &[u8], limit: usize) -> Result<Value> {
    authenticate(|| {
        if bytes.len() > limit {
            return Err(decryption_error());
        }
        let text = std::str::from_utf8(bytes)?;
        // TextDecoder fatal UTF-8 still strips its first BOM by default.
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let value = parse_json_text(text).map_err(|_| decryption_error())?;
        checked(schema, &value)
    })
}
pub(crate) fn seal_field(component_key: &[u8], context: &Value, bytes: &[u8]) -> Result<Value> {
    let field_key = derive_field_key(component_key, context)?;
    encrypt_payload(&field_key, bytes, context)
}
pub(crate) fn open_field(
    component_key: &[u8],
    context: &Value,
    envelope: &Value,
) -> Result<Zeroizing<Vec<u8>>> {
    let field_key = derive_field_key(component_key, context)?;
    decrypt_payload(&field_key, envelope, context)
}
pub(crate) fn authenticate<T>(read: impl FnOnce() -> Result<T>) -> Result<T> {
    read().map_err(|_| decryption_error())
}
pub(crate) fn revision(envelope: &Value, context: &Value) -> Result<()> {
    if envelope["keyRevision"] != context["keyRevision"] {
        return Err(decryption_error());
    }
    Ok(())
}
