use super::{json_response, middleware::value};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use serde_json::{Value, json};

// Auth schemas consume text through UTF-8 password hashing or PostgreSQL text
// parameters. Node replaces unpaired UTF-16 surrogates at those boundaries.
// Preserve valid pairs and literal backslashes while applying that conversion
// to JSON escapes that serde_json cannot represent in a Rust String.
fn auth_json(input: &str) -> String {
    fn code(bytes: &[u8]) -> Option<u16> {
        if bytes.len() < 6 || &bytes[..2] != b"\\u" {
            return None;
        }
        bytes[2..6].iter().try_fold(0_u16, |value, ch| {
            Some(value * 16 + (*ch as char).to_digit(16)? as u16)
        })
    }
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    let mut quoted = false;
    while offset < bytes.len() {
        if quoted && bytes[offset] == b'\\' {
            if let Some(high) = code(&bytes[offset..]) {
                if (0xd800..=0xdbff).contains(&high)
                    && code(&bytes[offset + 6..])
                        .is_some_and(|low| (0xdc00..=0xdfff).contains(&low))
                {
                    output.extend_from_slice(&bytes[offset..offset + 12]);
                    offset += 12;
                    continue;
                }
                if (0xd800..=0xdfff).contains(&high) {
                    output.extend_from_slice(b"\\ufffd");
                    offset += 6;
                    continue;
                }
            }
            let end = (offset + 2).min(bytes.len());
            output.extend_from_slice(&bytes[offset..end]);
            offset = end;
            continue;
        }
        if bytes[offset] == b'"' {
            quoted = !quoted;
        }
        output.push(bytes[offset]);
        offset += 1;
    }
    String::from_utf8(output).expect("JSON UTF-8 retained")
}

fn parser_error(code: u16, key: &str, message: String) -> Response {
    json_response(
        StatusCode::from_u16(code).unwrap(),
        json!({"statusCode":code,"code":key,"error":if code==415{"Unsupported Media Type"}else if code==413{"Payload Too Large"}else{"Bad Request"},"message":message}),
    )
}
pub(super) async fn parse(request: Request, limit: u64) -> Result<Option<Value>, Response> {
    let content_type = value(request.headers(), "content-type");
    let bytes = to_bytes(request.into_body(), limit as usize)
        .await
        .map_err(|_| {
            parser_error(
                413,
                "FST_ERR_CTP_BODY_TOO_LARGE",
                "Request body is too large".into(),
            )
        })?;
    let kind = content_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if kind == "application/json" {
        if bytes.is_empty() {
            return Err(parser_error(
                400,
                "FST_ERR_CTP_EMPTY_JSON_BODY",
                "Body cannot be empty when content-type is set to 'application/json'".into(),
            ));
        }
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let value: Value = serde_json::from_str(&auth_json(text)).map_err(|_| {
            parser_error(
                400,
                "FST_ERR_CTP_INVALID_JSON_BODY",
                "Body is not valid JSON but content-type is set to 'application/json'".into(),
            )
        })?;
        fn poisoned(value: &Value) -> bool {
            match value {
                Value::Object(object) => {
                    object.contains_key("__proto__")
                        || object.get("constructor").is_some_and(|v| {
                            v.as_object().is_some_and(|o| o.contains_key("prototype"))
                        })
                        || object.values().any(poisoned)
                }
                Value::Array(array) => array.iter().any(poisoned),
                _ => false,
            }
        }
        if poisoned(&value) {
            return Err(parser_error(
                400,
                "FST_ERR_CTP_INVALID_JSON_BODY",
                "Body is not valid JSON but content-type is set to 'application/json'".into(),
            ));
        }
        Ok(Some(value))
    } else if kind == "text/plain" {
        Ok(Some(json!(String::from_utf8_lossy(&bytes))))
    } else if kind.is_empty() && bytes.is_empty() {
        Ok(None)
    } else {
        Err(parser_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type".into(),
        ))
    }
}
