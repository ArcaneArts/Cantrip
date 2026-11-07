use crate::wire::{JsString, Value, value::json};

pub fn message(error: &anyhow::Error) -> JsString {
    let message = crate::settings::operation_error_message(error);
    JsString::new(message.units()[..message.len().min(2000)].to_vec())
}
pub fn failure(chat: &Value, error: &anyhow::Error) -> Value {
    let message = message(error);
    // Source truncates before lowercasing and classifying. Unicode case folding
    // in /iu includes ASCII equivalents such as the Kelvin sign and long s.
    let normalized = message.lossy().to_lowercase();
    static PATTERNS: std::sync::OnceLock<Vec<(&str, regex::Regex)>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            (
                "encryption-unavailable",
                r"(?i)encrypt|decrypt|key revision|private label",
            ),
            (
                "target-unavailable",
                r"(?i)external codex home|export target|worktree|worker is offline",
            ),
            (
                "runtime-incompatible",
                r"(?i)codex|thread/(?:start|inject_items|read|name)|runtime",
            ),
        ]
        .into_iter()
        .map(|(code, pattern)| {
            (
                code,
                regex::Regex::new(pattern).expect("Static export error expression"),
            )
        })
        .collect()
    });
    let code = patterns
        .iter()
        .find(|(_, pattern)| pattern.is_match(&normalized))
        .map_or("worker-error", |(code, _)| *code);
    json!({"status":"failed","chatId":chat,"code":code,"message":if message.is_empty() { "Could not export this chat.".into() } else { message }})
}
