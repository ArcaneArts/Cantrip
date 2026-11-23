//! Pure native item presentation shared by retained history and later live
//! execution adapters. No file reads, identity reservation or input dispatch.
mod capture;
pub mod command_output;
mod mcp;
mod normalization;
mod paths;
pub mod raw;
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value};
pub use normalization::{changed_lines_preview, latest_changed_line, normalize};
use regress::Regex;

pub(crate) fn checked(schema: &str, value: &Value) -> Result<Value> {
    cantrip_protocol::parse(schema, Some(value)).map_err(cantrip_protocol::response::response_error)
}
pub(crate) fn text(value: &Value) -> Result<&JsString> {
    value
        .as_js_string()
        .ok_or_else(|| anyhow!("Native item field is not text."))
}
pub(crate) fn array(value: &Value) -> Result<&[Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| anyhow!("Native item field is not an array."))
}
pub(crate) fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Value::object(pairs)
}
pub(crate) fn s(value: impl Into<JsString>) -> Value {
    Value::String(value.into())
}
pub(crate) fn join(values: impl IntoIterator<Item = JsString>, separator: &str) -> JsString {
    let mut output = Vec::new();
    for (index, value) in values.into_iter().enumerate() {
        if index != 0 {
            output.extend(separator.encode_utf16());
        }
        output.extend_from_slice(value.units());
    }
    JsString::new(output)
}
pub(crate) fn concat(values: &[JsString]) -> JsString {
    join(values.iter().cloned(), "")
}
pub(crate) fn slice(value: &JsString, start: usize, end: usize) -> JsString {
    JsString::new(value.units()[start.min(value.len())..end.min(value.len())].to_vec())
}
pub(crate) fn bounded(value: Option<&Value>, limit: usize) -> Result<Value> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(Value::Null);
    };
    let value = text(value)?;
    Ok(s(if value.len() <= limit {
        value.clone()
    } else {
        concat(&[slice(value, 0, limit), "\n…truncated…".into()])
    }))
}
pub(crate) fn copy(target: &mut Value, source: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = source.get(key) {
            target[key] = value.clone();
        }
    }
}
pub(crate) fn has(regex: &Regex, value: &JsString) -> bool {
    regex.find_from_utf16(value.units(), 0).next().is_some()
}
pub(crate) fn replace(
    value: &JsString,
    regex: &Regex,
    replacement: impl Fn(&regress::Match, &[u16]) -> Vec<u16>,
) -> JsString {
    let units = value.units();
    let mut output = Vec::new();
    let mut at = 0;
    for found in regex.find_from_utf16(units, 0) {
        output.extend_from_slice(&units[at..found.start()]);
        output.extend(replacement(&found, units));
        at = found.end();
    }
    output.extend_from_slice(&units[at..]);
    JsString::new(output)
}

/// Opaque communication takes precedence over any simultaneously supplied text.
pub fn communication(body: &Value) -> Option<Value> {
    if !body["author"].is_string()
        || !body["recipient"].is_string()
        || !body["otherRecipients"]
            .as_array()?
            .iter()
            .all(Value::is_string)
        || !body["triggerTurn"].is_boolean()
        || !body
            .get("text")
            .is_some_and(|v| v.is_null() || v.is_string())
        || !body
            .get("encryptedContent")
            .is_some_and(|v| v.is_null() || v.is_string())
    {
        return None;
    }
    let encrypted = !body["encryptedContent"].is_null();
    let recipients = std::iter::once(body["recipient"].as_js_string()?.clone()).chain(
        body["otherRecipients"]
            .as_array()?
            .iter()
            .map(|v| v.as_js_string().unwrap().clone()),
    );
    Some(obj([
        (
            "title",
            s(concat(&[
                if body["triggerTurn"] == true {
                    "Agent task · ".into()
                } else {
                    "Agent message · ".into()
                },
                body["author"].as_js_string()?.clone(),
                " → ".into(),
                join(recipients, ", "),
            ])),
        ),
        (
            "details",
            if encrypted {
                Value::Null
            } else {
                body["text"].clone()
            },
        ),
        (
            "unavailable",
            if encrypted {
                s("encrypted-agent-communication")
            } else if body["text"].is_null() {
                s("missing-agent-communication-text")
            } else {
                Value::Null
            },
        ),
    ]))
}
