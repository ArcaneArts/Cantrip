//! Worker-authenticated legacy CLI context and command semantics.
pub mod context;
pub mod repository;
pub mod selectors;
#[cfg(test)]
mod tests;

use crate::wire::{JsString, Value, coercion};

#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub code: &'static str,
    pub message: JsString,
}
impl Error {
    pub fn new(status: u16, code: &'static str, message: impl Into<JsString>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for Error {}

pub fn is_mutation(command: &str) -> bool {
    matches!(
        command,
        "worktree.create"
            | "worktree.switch"
            | "worktree.release"
            | "worktree.remove"
            | "run.create"
            | "run.update"
            | "run.delete"
            | "run.start"
            | "run.restart"
            | "run.stop"
            | "run.secret-set"
            | "explorer.write"
            | "terminal.send"
            | "terminal.restart"
            | "browser.create"
            | "browser.open"
    )
}
pub fn concat(parts: &[Value]) -> JsString {
    JsString::new(
        parts
            .iter()
            .flat_map(|part| {
                coercion::string(part)
                    .expect("CLI primitive text")
                    .units()
                    .to_vec()
            })
            .collect(),
    )
}
pub fn required(arguments: &Value, key: &str) -> anyhow::Result<Value> {
    arguments
        .get(key)
        .and_then(Value::as_js_string)
        .map(|s| Value::String(s.trim()))
        .filter(|v| !v.as_js_string().unwrap().is_empty())
        .ok_or_else(|| Error::new(400, "invalid", format!("{key} is required.")).into())
}
pub fn optional(arguments: &Value, key: &str) -> anyhow::Result<Option<Value>> {
    let Some(value) = arguments.get(key).filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let text = value
        .as_js_string()
        .ok_or_else(|| Error::new(400, "invalid", format!("{key} must be a string.")))?
        .trim();
    Ok((!text.is_empty()).then_some(Value::String(text)))
}
pub fn require_chat_lane(context: &Value) -> anyhow::Result<()> {
    if !coercion::truthy(context.get("chatId")) || !coercion::truthy(context.get("executionLaneId"))
    {
        return Err(Error::new(
            409,
            "conflict",
            "This operation needs an active Cantrip chat. Run it from Codex in that chat.",
        )
        .into());
    }
    Ok(())
}
