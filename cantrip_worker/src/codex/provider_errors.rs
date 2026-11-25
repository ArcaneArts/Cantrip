//! Provider-facing errors and endpoint-safe diagnostics from the worker boundary.
use super::diagnostics;
use cantrip_wire::{JsString, Value, value::json};
use regress::Regex;
use std::sync::LazyLock;
macro_rules! expression {
    ($text:literal, $flags:literal) => {{
        static VALUE: LazyLock<Regex> = LazyLock::new(|| Regex::with_flags($text, $flags).unwrap());
        &*VALUE
    }};
}
fn test(value: &JsString, regex: &Regex) -> bool {
    regex.find_from_utf16(value.units(), 0).next().is_some()
}
fn capture(value: &JsString, regex: &Regex) -> Option<JsString> {
    let found = regex.find_from_utf16(value.units(), 0).next()?;
    Some(JsString::new(value.units()[found.group(1)?].to_vec()))
}
pub(super) fn surround(prefix: &str, value: &JsString, suffix: &str) -> JsString {
    JsString::new(
        prefix
            .encode_utf16()
            .chain(value.units().iter().copied())
            .chain(suffix.encode_utf16())
            .collect(),
    )
}
#[derive(Clone, Default)]
pub struct Policy {
    pub secrets: Vec<JsString>,
    pub refreshed_secrets: std::sync::Arc<std::sync::Mutex<Vec<JsString>>>,
    pub zai: bool,
    pub endpoint: bool,
}
impl Policy {
    pub fn remember_secret(&self, secret: JsString) {
        let mut secrets = self.refreshed_secrets.lock().unwrap();
        if !secrets.contains(&secret) {
            secrets.push(secret);
        }
    }

    pub fn redact(&self, value: &Value) -> Value {
        let mut secrets = self.secrets.clone();
        secrets.extend(self.refreshed_secrets.lock().unwrap().iter().cloned());
        diagnostics::redact(value, &secrets, 0)
    }

    pub fn readable(&self, message: &JsString) -> JsString {
        let sanitized = self
            .redact(&Value::String(message.clone()))
            .as_js_string()
            .unwrap()
            .clone();
        if self.endpoint {
            return safe_endpoint(&sanitized);
        }
        if !self.zai {
            return sanitized;
        }
        let status = |code| {
            test(
                &sanitized,
                &Regex::with_flags(&format!(r"(?:HTTP\s+|status\s+)?{code}\b"), "iu").unwrap(),
            )
        };
        if status(401)
            || test(
                &sanitized,
                expression!(
                    r"(?:invalid|missing|rejected).{0,24}(?:api[ -]?key|credential)|unauthori[sz]ed",
                    "iu"
                ),
            )
        {
            return "Z.ai rejected the Coding Plan API key (HTTP 401). Check that the key is current and belongs to the intended Individual or Team Coding Plan.".into();
        }
        if status(403)
            || test(
                &sanitized,
                expression!(r"forbidden|permission denied", "iu"),
            )
        {
            return "Z.ai denied this Coding Plan request (HTTP 403). Check the plan, key scope, and Team membership for this key.".into();
        }
        if status(404) || test(&sanitized, expression!(r"endpoint not found", "iu")) {
            return "Z.ai could not find the Responses endpoint or selected model (HTTP 404). The Coding Plan endpoint must be https://api.z.ai/api/v1 and the model must be available to this plan.".into();
        }
        if status(422) || test(&sanitized, expression!(r"unprocessable entit", "iu")) {
            return "Z.ai rejected this model capability or request option (HTTP 422). Use only the reasoning and tool options advertised for the selected Z.ai model.".into();
        }
        if status(429)
            || test(
                &sanitized,
                expression!(
                    r#"rate[ -]?limit|quota exceeded|(?:business|error|code)["'\s:=]+(?:1305|1308|1310)\b"#,
                    "iu"
                ),
            )
        {
            let hint = capture(&sanitized, expression!(r#"retry-after["']?\s*(?::|=)\s*["']?([^\r\n,;"'}]+)"#, "iu"))
                .map(|v| surround("Retry after ",&v.trim(),"."))
                .or_else(|| capture(&sanitized, expression!(r#"(?:next_flush_time|reset(?:s|\s+at|\s+time)?)\s*(?::|=|\bis\b)?\s*["']?([^\r\n,"'}]+)"#, "iu")).map(|v| surround("Provider reset: ",&v.trim(),".")))
                .unwrap_or_else(|| "Wait for the provider reset and retry.".into());
            return surround("Z.ai Coding Plan rate limit reached. ", &hint, "");
        }
        if test(
            &sanitized,
            expression!(r"stream|connection reset|unexpected eof|timed? out", "iu"),
        ) {
            let mut units = "The Z.ai response stream was interrupted. "
                .encode_utf16()
                .collect::<Vec<_>>();
            units.extend(sanitized.units());
            return JsString::new(units);
        }
        sanitized
    }
    pub fn diagnostic(&self, value: &Value) -> Value {
        let safe = if self.endpoint {
            safe_payload(value, 0)
        } else {
            value.clone()
        };
        self.redact(&safe)
    }
}
pub fn token_expired(message: &JsString) -> bool {
    test(message, expression!(r"(?:HTTP\s+|status\s+)?401\b", "iu"))
        && test(
            message,
            expression!(
                r"token_expired|(?:access|authentication) token (?:has )?(?:is )?expired",
                "iu"
            ),
        )
}
pub(crate) fn context_window_exceeded(message: &JsString) -> bool {
    test(
        message,
        expression!(
            r"context.{0,40}(length|limit|exceed|size)|maximum.{0,20}context",
            "iu"
        ),
    )
}

pub fn safe_endpoint(message: &JsString) -> JsString {
    let status = capture(
        message,
        expression!(
            r"(?:http(?:/[\d.]+)?(?:\s+status)?|status)(?:\s+code)?\s*[:=]?\s*(\d{3})",
            "i"
        ),
    );
    let text = message.lowercase();
    let status = status.as_ref().and_then(JsString::as_str);
    let reason = if matches!(status, Some("401" | "403"))
        || test(
            &text,
            expression!(
                r"unauthorized|forbidden|authentication|invalid.{0,10}api.{0,4}key",
                ""
            ),
        ) {
        "The model server rejected authentication."
    } else if test(
        &text,
        expression!(
            r"model.{0,30}(not found|unavailable|does not exist)|unknown model",
            ""
        ),
    ) {
        "Model not found on the configured server."
    } else if context_window_exceeded(message) {
        "The model rejected the request's context length."
    } else if status == Some("404") {
        "The Responses endpoint or requested model was not found."
    } else if matches!(status, Some("400" | "422")) {
        "The model server rejected request options or tool formatting."
    } else if status == Some("429") || test(&text, expression!(r"rate.limit|quota.exceeded", "")) {
        "The model server rate limit was reached."
    } else if test(&text, expression!(r"econnrefused|connection refused", "")) {
        "The connection was refused."
    } else if test(&text, expression!(r"enotfound|eai_again|dns", "")) {
        "The endpoint hostname could not be resolved."
    } else if test(&text, expression!(r"timed?\s*out|timeout", "")) {
        "The inference request timed out."
    } else if test(&text, expression!(r"certificate|tls|ssl", "")) {
        "The secure connection failed."
    } else if test(&text, expression!(r"cancelled|canceled|interrupted", "")) {
        "Inference was interrupted."
    } else if test(
        &text,
        expression!(r"stream|connection reset|unexpected eof", ""),
    ) {
        "The model response stream was interrupted."
    } else {
        "Model inference failed."
    };
    format!(
        "{reason}{}",
        status.map_or(String::new(), |v| format!(" HTTP {v}."))
    )
    .into()
}
pub fn safe_payload(value: &Value, depth: usize) -> Value {
    if depth > 20 {
        return json!("[TRUNCATED]");
    }
    match value {
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| safe_payload(v, depth + 1)).collect())
        }
        Value::Object(fields) => {
            if value["type"] == "error" && value["message"].is_string() {
                return json!({"type":"error","message":safe_endpoint(value["message"].as_js_string().unwrap())});
            }
            Value::object(fields.iter().map(|(key, value)| {
                let safe = if key.as_str() == Some("error")
                    && value.is_object()
                    && value["message"].is_string()
                {
                    let mut safe = json!({});
                    if value["code"].is_number() {
                        safe["code"] = value["code"].clone();
                    }
                    safe["message"] =
                        Value::String(safe_endpoint(value["message"].as_js_string().unwrap()));
                    safe
                } else {
                    safe_payload(value, depth + 1)
                };
                (key.clone(), safe)
            }))
        }
        value => value.clone(),
    }
}
