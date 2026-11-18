//! Codex diagnostic redaction and bounded subprocess failures. Raw RPC payloads
//! do not enter this surface; private execution settlement remains separate.
use crate::native_items::replace;
use cantrip_wire::{JsString, Value};
use regress::Regex;
use std::sync::LazyLock;
static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]").unwrap()
});
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r#"\bBearer\s+[^\s"']+"#, "iu").unwrap());
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags(r#"((?:[\w.-]*(?:access[_ -]?token|api[_ -]?key|authorization|credential|id[_ -]?token|password|refresh[_ -]?token|secret|token)[\w.-]*|"(?:access[_ -]?token|api[_ -]?key|authorization|credential|id[_ -]?token|password|refresh[_ -]?token|secret|token)")\s*(?::|=)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)"#,"iu").unwrap()
});
static ARGUMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags(r#"((?:--|/)(?:access[_ -]?token|api[_ -]?key|authorization|credential|id[_ -]?token|password|refresh[_ -]?token|secret|token)(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)"#,"iu").unwrap()
});
static USER: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"([a-z][a-z0-9+.-]*://)[^/@\s]+@", "iu").unwrap());
pub fn strip_controls(value: &JsString) -> JsString {
    replace(value, &ANSI, |_, _| Vec::new())
}
fn redact_string(value: &JsString, secrets: &[JsString]) -> JsString {
    let mut value = replace(value, &BEARER, |_, _| {
        "Bearer [REDACTED]".encode_utf16().collect()
    });
    for secret in secrets.iter().filter(|v| !v.is_empty()) {
        let input = value.units();
        let needle = secret.units();
        let mut out = Vec::new();
        let mut at = 0;
        while at < input.len() {
            if input[at..].starts_with(needle) {
                out.extend("[REDACTED]".encode_utf16());
                at += needle.len();
            } else {
                out.push(input[at]);
                at += 1;
            }
        }
        value = JsString::new(out);
    }
    value
}
pub fn redact(value: &Value, secrets: &[JsString], depth: usize) -> Value {
    if depth > 20 {
        return Value::String("[TRUNCATED]".into());
    }
    match value {
        Value::String(value) => Value::String(redact_string(value, secrets)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|v| redact(v, secrets, depth + 1))
                .collect(),
        ),
        Value::Object(fields) => Value::object(fields.iter().map(|(key, value)| {
            let normalized = key
                .lowercase()
                .units()
                .iter()
                .filter(|u| matches!(**u, 97..=122))
                .map(|u| char::from_u32(*u as u32).unwrap())
                .collect::<String>();
            (
                key.clone(),
                if matches!(
                    normalized.as_str(),
                    "accesstoken"
                        | "authorization"
                        | "credentialenvelope"
                        | "idtoken"
                        | "refreshtoken"
                        | "token"
                ) {
                    Value::String("[REDACTED]".into())
                } else {
                    redact(value, secrets, depth + 1)
                },
            )
        })),
        value => value.clone(),
    }
}
pub fn exit_message(code: i32, tail: &JsString) -> JsString {
    exit_with_status(&format!("code {code}"), tail)
}
pub fn exit_with_status(status: &str, tail: &JsString) -> JsString {
    let diagnostic = tail
        .units()
        .split(|u| *u == 10)
        .map(|v| strip_controls(&JsString::new(v.to_vec())).trim())
        .rfind(|v| !v.is_empty());
    let mut result = format!("Codex app-server exited ({status})")
        .encode_utf16()
        .collect::<Vec<_>>();
    if let Some(diagnostic) = diagnostic {
        let mut value = redact_string(&diagnostic, &[]);
        for expression in [&*ASSIGNMENT, &*ARGUMENT] {
            value = replace(&value, expression, |found, units| {
                let mut out = units[found.group(1).unwrap()].to_vec();
                out.extend("[REDACTED]".encode_utf16());
                out
            });
        }
        value = replace(&value, &USER, |found, units| {
            let mut out = units[found.group(1).unwrap()].to_vec();
            out.extend("[REDACTED]@".encode_utf16());
            out
        });
        result.extend(": ".encode_utf16());
        result.extend(value.units().iter().take(2000));
    } else {
        result.push(46);
    }
    JsString::new(result)
}
