use super::*;
use crate::{chats::hydration, wire::JsString, workers::command_bus::CommandFailure};
#[cfg(test)]
#[path = "failures_tests.rs"]
mod tests;
#[derive(Debug)]
pub(super) struct Offline;
impl std::fmt::Display for Offline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Worker is unavailable.")
    }
}
impl std::error::Error for Offline {}
pub(crate) fn unavailable(error: &anyhow::Error) -> bool {
    error.is::<Offline>()
        || matches!(error.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(e)) if e.unavailable)
}
pub(super) fn mapped(error: &anyhow::Error) -> Value {
    let message = crate::settings::operation_error_message(error);
    if unavailable(error) {
        return json!({"code":"worker-offline","message":"A required worker is offline. The import will resume after it reconnects.","retryable":true});
    }
    if let Some(hydration) = error.downcast_ref::<hydration::Error>() {
        return json!({"code":if matches!(hydration,hydration::Error::TooManySkills) {"runtime-incompatible"} else {"source-changed"},"message":message,"retryable":false});
    }
    if error.is::<crate::settings::ResponseValidationError>()
        || matches!(error.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(e)) if matches!(e.encoding_error.as_deref(),Some(crate::wire::ValidationError::Invalid(_))))
    {
        return json!({"code":"runtime-incompatible","message":"The source worker returned an unsupported Codex transcript shape.","retryable":false});
    }
    // Unicode simple case folding matches Source's /iu expressions, including
    // the long-s and Kelvin-sign equivalents of ASCII pattern letters.
    static PATTERNS: std::sync::OnceLock<Vec<(&str, regex::Regex)>> = std::sync::OnceLock::new();
    let patterns=PATTERNS.get_or_init(||[
        ("runtime-incompatible",r"(?i)outside Cantrip's tested range|not supported"),
        ("runtime-incompatible",r"(?i)no selected model|no default model|no target model route|model profile was not found|permission profile|required skills|cannot inject"),
        ("project-mismatch",r"(?i)no longer belongs|project match|destination worktree"),
        ("source-changed",r"(?i)identity changed|invalid thread/read|safe to import"),
        ("source-not-found",r"(?i)not found"),
    ].into_iter().map(|(code,pattern)|(code,regex::Regex::new(pattern).expect("Static import error expression"))).collect());
    let text = message.lossy();
    for (code, pattern) in patterns {
        if pattern.is_match(&text) {
            return json!({"code":code,"message":message,"retryable":false});
        }
    }
    let lower = text.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        return json!({"code":"worker-error","message":message,"retryable":true});
    }
    let message = if message.is_empty() {
        "The source worker could not import this chat.".into()
    } else {
        JsString::new(message.units()[..message.len().min(2000)].to_vec())
    };
    json!({"code":"worker-error","message":message,"retryable":true})
}
