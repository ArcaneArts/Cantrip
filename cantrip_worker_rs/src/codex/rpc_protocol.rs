//! Managed execution RPC envelopes, distinct from the simple stdio client.
use super::diagnostics::strip_controls;
use cantrip_wire::{JsString, Value, parse_json_text};
use regress::Regex;
use std::sync::LazyLock;

pub fn parse(raw: &JsString) -> Option<Value> {
    let mut text = String::new();
    let mut slashes = 0;
    for unit in char::decode_utf16(raw.units().iter().copied()) {
        match unit {
            Ok(ch) => {
                text.push(ch);
                slashes = if ch == '\\' { slashes + 1 } else { 0 };
            }
            Err(unit) => {
                if slashes % 2 == 1 {
                    return None;
                }
                text.push_str(&format!("\\u{:04x}", unit.unpaired_surrogate()));
                slashes = 0;
            }
        }
    }
    validate(parse_json_text(&text).ok()?)
}
fn validate(value: Value) -> Option<Value> {
    if !value.is_object()
        || value
            .get("id")
            .is_some_and(|v| !v.is_number() && !v.is_string())
        || value.get("method").is_some_and(|v| !v.is_string())
        || value.get("id").is_none() && value.get("method").is_none()
        || value
            .get("error")
            .is_some_and(|v| !v.is_object() || !v["code"].is_number() || !v["message"].is_string())
    {
        return None;
    }
    Some(value)
}
pub fn parse_text(raw: &str) -> Option<Value> {
    validate(parse_json_text(raw).ok()?)
}
pub fn endpoint(line: &JsString) -> Option<JsString> {
    static ANNOUNCED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*listening on:\s+(ws://\S+)\s*$").unwrap());
    let line = strip_controls(line);
    let found = ANNOUNCED.find_from_utf16(line.units(), 0).next()?;
    Some(JsString::new(line.units()[found.group(1)?].to_vec()))
}
pub fn startup_exit(status: &str, stderr: &[JsString]) -> JsString {
    let diagnostic = stderr
        .iter()
        .map(|line| strip_controls(line).trim())
        .rfind(|v| !v.is_empty());
    let mut message = format!("Codex app-server exited before listening ({status})")
        .encode_utf16()
        .collect::<Vec<_>>();
    if let Some(line) = diagnostic {
        message.extend(": ".encode_utf16());
        message.extend(line.units().iter().take(2000));
    } else {
        message.push(46);
    }
    JsString::new(message)
}
