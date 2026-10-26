use super::{json_response, middleware::value};
use crate::wire::{JsString, Value as JsValue};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use serde_json::{Value, json};

fn parser_error(code: u16, key: &str, message: &str) -> Response {
    json_response(
        StatusCode::from_u16(code).unwrap(),
        json!({"statusCode":code,"code":key,"error":if code==415{"Unsupported Media Type"}else if code==413{"Payload Too Large"}else{"Bad Request"},"message":message}),
    )
}
fn invalid_json() -> Response {
    parser_error(
        400,
        "FST_ERR_CTP_INVALID_JSON_BODY",
        "Body is not valid JSON but content-type is set to 'application/json'",
    )
}
fn poisoned(value: &JsValue) -> bool {
    match value {
        JsValue::Object(object) => {
            object.contains_key("__proto__")
                || object
                    .get("constructor")
                    .is_some_and(|v| v.as_object().is_some_and(|o| o.contains_key("prototype")))
                || object.values().any(poisoned)
        }
        JsValue::Array(array) => array.iter().any(poisoned),
        _ => false,
    }
}

pub(super) async fn parse_js(request: Request, limit: u64) -> Result<Option<JsValue>, Response> {
    let content_type = value(request.headers(), "content-type");
    let bytes = to_bytes(request.into_body(), limit as usize)
        .await
        .map_err(|_| {
            parser_error(
                413,
                "FST_ERR_CTP_BODY_TOO_LARGE",
                "Request body is too large",
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
                "Body cannot be empty when content-type is set to 'application/json'",
            ));
        }
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let value: JsValue = serde_json::from_str(text).map_err(|_| invalid_json())?;
        if poisoned(&value) {
            return Err(invalid_json());
        }
        Ok(Some(value))
    } else if kind == "text/plain" {
        Ok(Some(JsValue::String(JsString::from(
            String::from_utf8_lossy(&bytes).into_owned(),
        ))))
    } else if kind.is_empty() && bytes.is_empty() {
        Ok(None)
    } else {
        Err(parser_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
        ))
    }
}

// Retain the existing auth handler's text-boundary conversion while those
// handlers transition to the shared native contracts. New APIs use parse_js.
fn legacy_auth_value(value: JsValue) -> Value {
    match value {
        JsValue::Null => Value::Null,
        JsValue::Bool(value) => json!(value),
        JsValue::Number(value) => {
            let mut buffer = ryu_js::Buffer::new();
            serde_json::from_str(if value.is_infinite() {
                if value.is_sign_negative() {
                    "-1e999"
                } else {
                    "1e999"
                }
            } else {
                buffer.format_finite(value)
            })
            .expect("JSON numeric literal")
        }
        JsValue::String(value) => json!(value.lossy()),
        JsValue::Array(values) => Value::Array(values.into_iter().map(legacy_auth_value).collect()),
        JsValue::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key.lossy().into_owned(), legacy_auth_value(value)))
                .collect(),
        ),
    }
}
pub(super) async fn parse(request: Request, limit: u64) -> Result<Option<Value>, Response> {
    Ok(parse_js(request, limit).await?.map(legacy_auth_value))
}
