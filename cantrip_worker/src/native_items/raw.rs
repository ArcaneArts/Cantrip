//! Worker-side trajectory capture. This redaction policy intentionally matches
//! Codex raw-capture.ts, independently of diagnostic log minimization.
use super::*;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
static KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags(r"(?:authorization|cookie|credential|password|secret|token|api[-_]?key|access[-_]?key|refresh[-_]?token)","iu").unwrap()
});
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", "iu").unwrap());
static ASSIGNED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags(r#"\b(authorization|cookie|password|secret|token|api[-_]?key|access[-_]?key|refresh[-_]?token)(\s*[:=]\s*)([^\s,;"']+)"#,"iu").unwrap()
});
static PROVIDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b", "u").unwrap());
static IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"^image/[a-z0-9.+-]{1,100}$", "iu").unwrap());
pub fn redact(value: &JsString) -> JsString {
    let value = replace(value, &BEARER, |_, _| {
        "Bearer [REDACTED]".encode_utf16().collect()
    });
    let value = replace(&value, &ASSIGNED, |found, units| {
        let mut r = units[found.group(1).unwrap()].to_vec();
        r.extend_from_slice(&units[found.group(2).unwrap()]);
        r.extend("[REDACTED]".encode_utf16());
        r
    });
    replace(&value, &PROVIDER, |_, _| {
        "[REDACTED]".encode_utf16().collect()
    })
}
fn redacted(value: &Value, depth: usize) -> Value {
    if depth > 20 {
        return s("[OMITTED: maximum nesting depth]");
    }
    match value {
        Value::String(value) => s(redact(value)),
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| redacted(v, depth + 1)).collect())
        }
        Value::Object(_) if value["type"] == "image" => obj([
            ("type", s("image")),
            (
                "mimeType",
                value["mimeType"]
                    .as_js_string()
                    .filter(|v| has(&IMAGE, v))
                    .map_or(Value::Null, |v| s(v.clone())),
            ),
            (
                "encodedBytes",
                value["data"]
                    .as_js_string()
                    .map_or(Value::Null, |v| Value::Number(v.lossy().len() as f64)),
            ),
            (
                "omittedReason",
                s("Image content is not embedded in trajectory capture."),
            ),
        ]),
        Value::Object(fields) => Value::object(
            cantrip_wire::coercion::entries(fields)
                .into_iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if has(&KEY, k) {
                            s("[REDACTED]")
                        } else {
                            redacted(v, depth + 1)
                        },
                    )
                }),
        ),
        _ => value.clone(),
    }
}
fn bounded_utf8(value: &JsString, limit: usize) -> Value {
    let text = value.lossy();
    let bytes = text.as_bytes();
    // Under the limit TextEncoder measures replacements but the original JS
    // string (including unpaired UTF-16) is retained in the document.
    let result = if bytes.len() <= limit {
        value.clone()
    } else {
        let decoded = String::from_utf8_lossy(&bytes[..limit]);
        // TextDecoder's default BOM handling applies only on this truncation
        // path; untruncated documents retain the caller's original string.
        let mut decoded = JsString::from(decoded.strip_prefix('\u{feff}').unwrap_or(&decoded));
        while decoded.lossy().len() > limit {
            decoded = slice(&decoded, 0, decoded.len() - 1);
        }
        decoded
    };
    obj([
        ("text", s(result)),
        ("originalBytes", Value::Number(bytes.len() as f64)),
        ("truncated", Value::Bool(bytes.len() > limit)),
    ])
}
pub enum Input<'a> {
    Json(&'a Value),
    Bytes(&'a [u8]),
}
pub fn document(input: Input<'_>, request: bool) -> Result<Value> {
    let schema = if request {
        "agentActivityRawRequestDocumentSchema"
    } else {
        "agentActivityRawResponseDocumentSchema"
    };
    let value = match input {
        Input::Bytes(bytes) => obj([
            ("mediaType", s("application/octet-stream")),
            ("text", Value::Null),
            ("originalBytes", Value::Number(bytes.len() as f64)),
            ("truncated", Value::Bool(false)),
            (
                "digest",
                s(format!(
                    "sha256:{}",
                    Sha256::digest(bytes)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                )),
            ),
            (
                "omittedReason",
                s("Binary content is not embedded in trajectory capture."),
            ),
        ]),
        Input::Json(value) => {
            let (media, text) = if let Some(value) = value.as_js_string() {
                ("text/plain; charset=utf-8", redact(value))
            } else {
                (
                    "application/json",
                    JsString::from(redacted(value, 0).stringify_pretty()),
                )
            };
            let bounded = bounded_utf8(&text, if request { 64 * 1024 } else { 256 * 1024 });
            let mut value = obj([("mediaType", s(media))]);
            copy(
                &mut value,
                &bounded,
                &["text", "originalBytes", "truncated"],
            );
            value
        }
    };
    checked(schema, &value)
}
pub fn envelope(
    request: Option<Input<'_>>,
    response: Option<Input<'_>>,
    metadata: &Value,
) -> Result<Value> {
    let mut entries = Vec::new();
    if let Some(fields) = metadata.as_object() {
        for (key, value) in cantrip_wire::coercion::entries(fields).into_iter().take(32) {
            let value =
                if has(&KEY, key) {
                    "[REDACTED]".into()
                } else if value.is_null() {
                    "".into()
                } else {
                    redact(&cantrip_wire::coercion::string(value).map_err(|_| {
                        anyhow!("Native capture metadata cannot be converted to text.")
                    })?)
                };
            entries.push((slice(key, 0, 100), s(slice(&value, 0, 4000))));
        }
    }
    checked(
        "agentActivityRawEnvelopeSchema",
        &obj([
            ("schemaVersion", Value::Number(1.)),
            (
                "request",
                request
                    .map(|v| document(v, true))
                    .transpose()?
                    .unwrap_or(Value::Null),
            ),
            (
                "response",
                response
                    .map(|v| document(v, false))
                    .transpose()?
                    .unwrap_or(Value::Null),
            ),
            ("metadata", Value::object(entries)),
        ]),
    )
}
