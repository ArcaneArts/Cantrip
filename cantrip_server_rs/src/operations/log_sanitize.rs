//! The shared service-log text and JSON context boundary, retaining UTF-16.
use crate::wire::{JsString, Value, coercion};
use regress::{Match, Regex};
use std::sync::OnceLock;

struct Patterns {
    camel: Regex,
    separators: Regex,
    secret: Regex,
    signed: Regex,
    control: Regex,
    auth_header: Regex,
    auth_value: Regex,
    named: Regex,
    provider: Regex,
    url: Regex,
}
fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let regex = |pattern: &str, flags| Regex::with_flags(pattern, flags).expect("service-log expression");
        Patterns {
            camel: regex(r"([a-z0-9])([A-Z])", "u"),
            separators: regex(r"[_.\s]+", "u"),
            secret: regex(r"^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|passphrase|secret|client-secret|api-key|apikey|token|access-token|refresh-token|id-token|bearer-token|provider-token|private-key|credential|csrf|csrf-token|xsrf-token|device-code|oauth-code|pairing-code|enrollment-code|signed-url)$", "iu"),
            signed: regex(r"^(?:signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$", "iu"),
            control: regex(r"(?:\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f])", "u"),
            auth_header: regex(r"\bauthorization(\s*[=:]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+", "iu"),
            auth_value: regex(r"\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+", "iu"),
            named: regex(r#"\b(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|provider[_-]?token|private[_-]?key|credential|csrf(?:[_-]?token)?|xsrf[_-]?token|device[_-]?code|oauth[_-]?code|pairing[_-]?code|enrollment[_-]?code|signed[_-]?url)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)"#, "iu"),
            provider: regex(r"\b(?:sk|gh[opusr]|xox[baprs]|pat)[-_][A-Za-z0-9_-]{8,}\b", "u"),
            url: regex(r#"https?://[^\s"'<>]+"#, "iu"),
        }
    })
}
fn replace(
    input: &JsString,
    regex: &Regex,
    replacement: impl Fn(&Match, &[u16]) -> Vec<u16>,
) -> JsString {
    let units = input.units();
    let mut output = Vec::new();
    let mut from = 0;
    for found in regex.find_from_utf16(units, 0) {
        output.extend_from_slice(&units[from..found.start()]);
        output.extend(replacement(&found, units));
        from = found.end();
    }
    output.extend_from_slice(&units[from..]);
    JsString::new(output)
}
fn literal(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
fn group(found: &Match, units: &[u16], index: usize) -> Vec<u16> {
    found
        .group(index)
        .map(|range| units[range].to_vec())
        .unwrap_or_default()
}
pub fn secret_field(key: &JsString) -> bool {
    let p = patterns();
    let camel = replace(key, &p.camel, |m, u| {
        let mut value = group(m, u, 1);
        value.push(45);
        value.extend(group(m, u, 2));
        value
    });
    let normalized = replace(&camel, &p.separators, |_, _| literal("-")).lowercase();
    p.secret
        .find_from_utf16(normalized.units(), 0)
        .next()
        .is_some()
}
fn redact_url(candidate: &JsString) -> JsString {
    let Ok(mut url) = url::Url::parse(&candidate.lossy()) else {
        return candidate.clone();
    };
    if !url.username().is_empty() || url.password().is_some_and(|v| !v.is_empty()) {
        let _ = url.set_username("redacted");
        let _ = url.set_password(Some("redacted"));
    }
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let keys: Vec<_> = pairs.iter().map(|(key, _)| key.clone()).collect();
    let signed = keys.iter().any(|key| {
        patterns()
            .signed
            .find_from_utf16(JsString::from(key.clone()).units(), 0)
            .next()
            .is_some()
    });
    let mut changed = false;
    for key in keys {
        if signed || secret_field(&JsString::from(key.clone())) {
            let mut first = true;
            pairs.retain_mut(|(known, value)| {
                if *known != key {
                    return true;
                }
                if !first {
                    return false;
                }
                first = false;
                *value = "[REDACTED]".into();
                true
            });
            changed = true;
        }
    }
    if changed {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        url.set_query(Some(&query));
    }
    JsString::from(url.to_string())
}
pub fn text(value: &JsString) -> JsString {
    let p = patterns();
    let value = replace(value, &p.control, |_, _| Vec::new());
    let value = replace(&value, &p.auth_header, |m, u| {
        let mut out = literal("Authorization");
        out.extend(group(m, u, 1));
        out.extend(literal("[REDACTED]"));
        out
    });
    let value = replace(&value, &p.auth_value, |m, u| {
        let matched = &u[m.range()];
        let end = matched
            .iter()
            .position(|c| char::from_u32(u32::from(*c)).is_some_and(crate::text::whitespace))
            .unwrap_or(matched.len());
        let mut out = matched[..end].to_vec();
        out.extend(literal(" [REDACTED]"));
        out
    });
    let value = replace(&value, &p.named, |m, u| {
        let mut out = group(m, u, 1);
        out.extend(group(m, u, 2));
        out.extend(literal("[REDACTED]"));
        out
    });
    let value = replace(&value, &p.provider, |_, _| literal("[REDACTED]"));
    let value = replace(&value, &p.url, |m, u| {
        redact_url(&JsString::new(u[m.range()].to_vec()))
            .units()
            .to_vec()
    });
    if value.len() > 16_384 {
        let mut units = value.units()[..16_383].to_vec();
        units.push(0x2026);
        JsString::new(units)
    } else {
        value
    }
}
pub fn context(value: &Value) -> Value {
    fn sanitize(value: &Value, depth: usize) -> Value {
        match value {
            Value::String(value) => Value::String(text(value)),
            Value::Null | Value::Number(_) | Value::Bool(_) => value.clone(),
            _ if depth >= 6 => Value::String("[Truncated]".into()),
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .take(100)
                    .map(|v| sanitize(v, depth + 1))
                    .collect(),
            ),
            Value::Object(object) => Value::object(
                coercion::keys(object)
                    .into_iter()
                    .take(100)
                    .filter(|key| key.as_str() != Some("__proto__"))
                    .map(|key| {
                        (
                            key.clone(),
                            if secret_field(key) {
                                Value::String("[REDACTED]".into())
                            } else {
                                sanitize(&object[key], depth + 1)
                            },
                        )
                    }),
            ),
        }
    }
    sanitize(value, 0)
}
/// Error fields are normalized before entering JSON log contexts. Stacks and
/// causes never enter the operational record or remote log boundary.
pub fn error(value: Option<&Value>) -> Value {
    let mut output = Value::object([
        (
            "name",
            Value::String(text(
                value
                    .and_then(|v| v["name"].as_js_string())
                    .unwrap_or(&JsString::from("Error")),
            )),
        ),
        (
            "message",
            Value::String(text(&match value {
                Some(Value::Object(_) | Value::Array(_)) => value
                    .and_then(|v| v["message"].as_js_string())
                    .cloned()
                    .unwrap_or_else(|| "Unknown error".into()),
                None => "Unknown error".into(),
                Some(value) => coercion::string(value).expect("JSON error value"),
            })),
        ),
    ]);
    if let Some(code) = value
        .and_then(|v| v.get("code"))
        .filter(|v| matches!(v, Value::String(_) | Value::Number(_)))
    {
        let code = text(&coercion::string(code).expect("Error code primitive"));
        if !code.is_empty() {
            output["code"] = Value::String(code);
        }
    }
    output
}
