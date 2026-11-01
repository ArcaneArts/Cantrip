//! Match the bounded public failure category using ECMAScript regex semantics.
use crate::wire::{JsString, Value};
use std::sync::OnceLock;
pub fn classify(error: &Value) -> &'static str {
    if error["name"] == "ModelConfigurationResolutionError" {
        if error["failure"]["code"] == "worker-offline" {
            return "connection";
        }
        return if error["failure"]["retryable"] == true {
            "runtime"
        } else {
            "configuration"
        };
    }
    let mut units = Vec::new();
    let mut first = true;
    for value in [
        error.get("code"),
        error.get("reasonCode"),
        error.get("name"),
        error.get("message"),
        error.as_js_string().map(|_| error),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(s) = value.as_js_string() {
            if !first {
                units.push(32);
            }
            first = false;
            units.extend_from_slice(s.units());
        }
    }
    let text = JsString::new(units);
    static PATTERNS: OnceLock<Vec<(&'static str, regress::Regex)>> = OnceLock::new();
    let patterns=PATTERNS.get_or_init(||[
        ("explicit",r"(?:task-goal-start-|implementation-|task-)(timeout|capacity|rate-limit|connection|runtime|needs-input|configuration|usage-limit|budget-limit)\b","u"),
        ("budget-limit",r"budget.?limit|token budget","i"),("usage-limit",r"usage.?limit|insufficient.quota|quota.exceeded","i"),
        ("needs-input",r"goal-blocked|needs.?input|user.?input.?required","i"),
        ("configuration",r"unauth|forbidden|permission.denied|invalid.api.key|model.*not.found|no.*models?.*config|route.*no.longer.available","i"),
        ("timeout",r"timeout|timed.?out|deadline","i"),("capacity",r"server.?overloaded|at.capacity|over.capacity|\b503\b|overloaded|task-capacity","i"),
        ("rate-limit",r"rate.?limit|too.many.requests|\b429\b","i"),("connection",r"offline|disconnect|connection|econn|socket|network|fetch.failed","i"),
    ].into_iter().map(|(kind,pattern,flags)|(kind,regress::Regex::with_flags(pattern,flags).expect("Task failure pattern"))).collect());
    for (kind, regex) in patterns {
        if let Some(found) = regex.find_from_utf16(text.units(), 0).next() {
            if *kind != "explicit" {
                return kind;
            }
            if let Some(Some(range)) = found.captures.first() {
                let code = String::from_utf16_lossy(&text.units()[range.clone()]);
                return match code.as_str() {
                    "timeout" => "timeout",
                    "capacity" => "capacity",
                    "rate-limit" => "rate-limit",
                    "connection" => "connection",
                    "needs-input" => "needs-input",
                    "configuration" => "configuration",
                    "usage-limit" => "usage-limit",
                    "budget-limit" => "budget-limit",
                    _ => "runtime",
                };
            }
        }
    }
    "runtime"
}
pub fn for_error(error: &anyhow::Error) -> &'static str {
    use crate::wire::value::json;
    use crate::{operations::shared_failure::downcast_ref, workers::command_bus::CommandFailure};
    if let Some(error) = crate::operations::shared_failure::downcast_ref::<
        crate::settings::reasoning::ConfigurationFailure,
    >(error)
    {
        return classify(&json!({"name":"ModelConfigurationResolutionError","failure":error.0}));
    }
    let mut value = json!({"message":crate::settings::operation_error_message(error)});
    if let Some(CommandFailure::Owner(error)) = downcast_ref::<CommandFailure>(error) {
        return for_error(error);
    }
    let bridge = match downcast_ref::<CommandFailure>(error) {
        Some(CommandFailure::Bridge(e)) => Some(e),
        _ => downcast_ref::<crate::workers::bridge::CommandError>(error),
    };
    if let Some(error) = bridge {
        value["code"] = error.code.as_ref().map(|v| json!(v)).unwrap_or(Value::Null);
    }
    if let Some(error) = downcast_ref::<crate::native_commands::CommandError>(error) {
        value["code"] = json!(error.code);
    }
    classify(&value)
}
