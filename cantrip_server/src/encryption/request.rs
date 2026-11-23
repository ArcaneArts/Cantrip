use crate::wire::{JsString, Value};
use anyhow::Result;

/// These fields cross Node's UTF-8 text/password boundary. Wrapped keys and
/// their authenticated metadata retain exact JSON serialization; they are
/// never recursively converted or decrypted by the server.
pub fn storage_input(mut value: Value) -> Result<serde_json::Value> {
    for name in ["label", "reason", "currentPassword", "newPassword"] {
        if let Some(text) = value.get(name).and_then(Value::as_js_string) {
            let text = JsString::from(text.lossy().into_owned());
            value[name] = Value::String(text);
        }
    }
    if let Some(text) = value
        .get("initialClient")
        .and_then(|v| v.get("label"))
        .and_then(Value::as_js_string)
    {
        let text = JsString::from(text.lossy().into_owned());
        value["initialClient"]["label"] = Value::String(text);
    }
    Ok(serde_json::from_str(&value.stringify())?)
}
