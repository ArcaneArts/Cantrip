use super::{json_response, middleware::value};
use crate::wire::{JsString, Value as JsValue};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use serde_json::json;

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
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            JsValue::Object(object) => {
                if object.contains_key("__proto__")
                    || object
                        .get("constructor")
                        .is_some_and(|v| v.as_object().is_some_and(|o| o.contains_key("prototype")))
                {
                    return true;
                }
                pending.extend(object.values());
            }
            JsValue::Array(array) => pending.extend(array),
            _ => {}
        }
    }
    false
}

pub(super) async fn parse_js(request: Request, limit: u64) -> Result<Option<JsValue>, Response> {
    let content_type = value(request.headers(), "content-type");
    let kind = content_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if value(request.headers(), "content-length")
        .and_then(|length| length.trim().parse::<u64>().ok())
        .is_some_and(|length| length > limit)
    {
        // Fastify selects its registered parser before rejecting the advertised
        // length, without waiting for any body bytes. The actual streamed body
        // remains bounded below when no oversized length was advertised.
        return Err(
            if matches!(
                kind.as_str(),
                "application/json" | "text/plain" | "application/octet-stream"
            ) {
                parser_error(
                    413,
                    "FST_ERR_CTP_BODY_TOO_LARGE",
                    "Request body is too large",
                )
            } else {
                parser_error(
                    415,
                    "FST_ERR_CTP_INVALID_MEDIA_TYPE",
                    "Unsupported Media Type",
                )
            },
        );
    }
    let bytes = to_bytes(request.into_body(), limit as usize)
        .await
        .map_err(|_| {
            parser_error(
                413,
                "FST_ERR_CTP_BODY_TOO_LARGE",
                "Request body is too large",
            )
        })?;
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
