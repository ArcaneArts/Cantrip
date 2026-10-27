//! Executable native counterparts of the protocol's live custom callbacks.
use super::{JsString, Parsed, ValidationError, Value, value::json};
use std::collections::HashSet;

pub(crate) fn scope_key(scope: &Value) -> JsString {
    let (prefix, field) = match scope["kind"].as_str() {
        Some("project") => ("project:", "projectId"),
        Some("chat") => ("chat:", "chatId"),
        _ => ("current-user", ""),
    };
    let mut units = prefix.encode_utf16().collect::<Vec<_>>();
    if !field.is_empty() {
        units.extend_from_slice(
            scope[field]
                .as_js_string()
                .expect("validated scope identity")
                .units(),
        );
    }
    JsString::new(units)
}
pub(crate) fn datetime_millis(value: &Value) -> Option<i64> {
    super::js_date::parse(value.as_js_string()?)
}
fn bounded_object(
    root: Option<&Value>,
    max_bytes: usize,
    max_string_length: usize,
) -> Option<String> {
    let root = root.filter(|v| v.is_object())?;
    let mut stack = vec![(0, root)];
    let mut nodes = 0;
    while let Some((depth, value)) = stack.pop() {
        nodes += 1;
        if nodes > 10000 {
            return Some("JSON payloads may contain at most 10000 values.".into());
        }
        if depth > 32 {
            return Some("JSON payloads may be nested at most 32 levels.".into());
        }
        match value {
            Value::Number(number) if !number.is_finite() => {
                return Some("JSON numbers must be finite.".into());
            }
            Value::String(text) if text.len() > max_string_length => {
                return Some(format!(
                    "JSON strings may contain at most {max_string_length} characters."
                ));
            }
            Value::Array(values) => {
                if values.len() > 1000 {
                    return Some("JSON arrays may contain at most 1000 items.".into());
                }
                stack.extend(values.iter().map(|v| (depth + 1, v)));
            }
            Value::Object(object) => {
                if object.len() > 1000 {
                    return Some("JSON objects may contain at most 1000 keys.".into());
                }
                for key in super::coercion::keys(object) {
                    if key.is_empty() || key.len() > 256 {
                        return Some("JSON object keys must contain 1-256 characters.".into());
                    }
                    stack.push((depth + 1, &object[key]));
                }
            }
            _ => {}
        }
    }
    if root.stringify().len() > max_bytes {
        Some(format!(
            "JSON payloads may contain at most {max_bytes} encoded bytes."
        ))
    } else {
        None
    }
}
pub(super) fn transform(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<(), ValidationError> {
    let (max_bytes, max_string_length) = match tag {
        "live-json-object" => (768 * 1024, 300000),
        "bounded-json-object" => (1000000, 100000),
        _ => return Err(ValidationError::Operation),
    };
    let error = if !result.value.as_ref().is_some_and(Value::is_object) {
        Some("Expected a JSON object.".into())
    } else {
        bounded_object(result.value.as_ref(), max_bytes, max_string_length)
    };
    if let Some(error) = error {
        result.issue(json!({"code":"custom"}), path, error, true);
    }
    Ok(())
}
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if !tag.starts_with("live-") && tag != "endpoint-protected-bytes" {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut issue = |path: &[Value], message: &str| {
        result.issue(json!({"code":"custom"}), path, message.into(), false)
    };
    match tag {
        "live-control-capabilities-unique" => {
            let mut seen = HashSet::new();
            if value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .any(|v| !seen.insert(v.as_js_string().unwrap().clone()))
            {
                issue(
                    path,
                    message.unwrap_or("Client-control capabilities must be unique."),
                );
            }
        }
        "live-scopes-unique" => {
            let mut seen = HashSet::new();
            for (index, scope) in value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .enumerate()
            {
                if !seen.insert(scope_key(scope)) {
                    let mut at = path.to_vec();
                    at.push(json!(index));
                    issue(&at, "Live subscription scopes must be unique.");
                }
            }
        }
        "live-control-window" => {
            // Invalid datetime-format issues can be continuable. Date.parse
            // yields NaN for unparseable text, so its comparisons are false.
            if let (Some(issued), Some(expiry)) = (
                datetime_millis(&value["issuedAt"]),
                datetime_millis(&value["expiresAt"]),
            ) && (expiry <= issued || expiry - issued > 10000)
            {
                let mut at = path.to_vec();
                at.push(json!("expiresAt"));
                issue(
                    &at,
                    "Client-control requests must expire within ten seconds of issuance.",
                );
            }
        }
        "endpoint-protected-bytes" => {
            if value["envelope"]["ciphertext"]
                .as_js_string()
                .ok_or(ValidationError::Operation)?
                .len()
                > ((16 * 1024 * 1024 + 16) * 4usize).div_ceil(3)
            {
                issue(
                    path,
                    message.unwrap_or("Protected endpoint content exceeds its byte limit."),
                );
            }
        }
        "live-notification-domain" => {
            if value["domain"] != "client-control-content" {
                issue(
                    path,
                    message.unwrap_or(
                        "Client notifications require client-control-content ciphertext.",
                    ),
                );
            }
        }
        "live-payload-bytes" => {
            if value.stringify().len() > 768 * 1024 {
                issue(
                    path,
                    "Live event payloads may contain at most 786432 encoded bytes.",
                );
            }
        }
        _ => return Err(ValidationError::Operation),
    }
    Ok(true)
}
