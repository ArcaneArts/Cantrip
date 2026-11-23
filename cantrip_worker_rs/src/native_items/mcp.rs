//! Existing nested MCP failure selection and protected CodeGraph text.
use super::*;
use std::sync::LazyLock;
fn nullish<'a>(body: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| body.get(key).filter(|v| !v.is_null()))
}
fn candidate(value: &Value, depth: usize) -> Option<Value> {
    if depth > 8 || value.is_null() {
        return None;
    }
    if let Some(value) = value.as_js_string() {
        let trimmed = value.trim();
        let units = trimmed.units();
        let parsed = if (units.first() == Some(&123) && units.last() == Some(&125))
            || (units.first() == Some(&91) && units.last() == Some(&93))
        {
            cantrip_wire::parse_json_text(&trimmed.lossy()).ok()
        } else {
            None
        };
        return if let Some(parsed) = parsed.filter(|v| !v.is_null()) {
            candidate(&parsed, depth + 1)
        } else if trimmed.is_empty() {
            None
        } else {
            Some(obj([("message", s(value.clone()))]))
        };
    }
    if let Some(values) = value.as_array() {
        return values.iter().find_map(|v| candidate(v, depth + 1));
    }
    if !value.is_object() {
        return None;
    }
    let code = nullish(value, &["code", "errorCode"]);
    let retry = nullish(value, &["retryable", "willRetry", "canRetry"]);
    let direct = if value["message"].is_string() {
        Some(&value["message"])
    } else {
        value.get("error").filter(|v| v.is_string())
    };
    if let Some(message) = direct.filter(|v| !text(v).unwrap().trim().is_empty()) {
        let mut result = obj([("message", message.clone())]);
        if let Some(v) = code {
            result["code"] = v.clone();
        }
        if let Some(v) = retry {
            result["retryable"] = v.clone();
        }
        return Some(result);
    }
    let mut nested = ["error", "result", "structuredContent", "data", "cause"]
        .iter()
        .find_map(|key| candidate(&value[key], depth + 1));
    if nested.is_none() {
        nested = value["content"].as_array().and_then(|parts| {
            parts
                .iter()
                .filter(|p| p["text"].is_string())
                .find_map(|p| candidate(&p["text"], depth + 1))
        });
    }
    nested.map(|mut nested| {
        if nested["code"].is_null()
            && let Some(code) = code
        {
            nested["code"] = code.clone();
        }
        if nested["retryable"].is_null()
            && let Some(retry) = retry
        {
            nested["retryable"] = retry.clone();
        }
        nested
    })
}
fn primitive_code(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if value.as_f64().is_some_and(f64::is_finite) {
        return Some(s(cantrip_wire::coercion::string(value).ok()?));
    }
    let code = raw::redact(value.as_js_string()?).trim();
    (!code.is_empty() && code.len() <= 200).then(|| s(code))
}
pub(super) fn failure(item: &Value) -> Result<Option<Value>> {
    if item["status"] != "failed"
        && !cantrip_wire::coercion::truthy(item.get("error"))
        && item["result"]["isError"] != true
        && item["result"]["status"] != "failed"
    {
        return Ok(None);
    }
    let result = candidate(&item["result"], 0);
    let explicit = cantrip_wire::coercion::truthy(item.get("error")).then(|| item["error"].clone());
    static GENERIC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::with_flags(r"^(?:(?:mcp|tool)\s+)?(?:tool\s+)?call failed[.!]?$", "iu").unwrap()
    });
    let selected = if result.is_some()
        && (explicit.is_none()
            || has(
                &GENERIC,
                &text(&explicit.as_ref().unwrap()["message"])?.trim(),
            )) {
        result.as_ref()
    } else {
        explicit.as_ref().or(result.as_ref())
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let message = raw::redact(text(&selected["message"])?).trim();
    let message = bounded(Some(&s(message)), 4000)?;
    if text(&message)?.is_empty() {
        return Ok(None);
    }
    let mut code = None;
    for value in [Some(selected), explicit.as_ref(), result.as_ref()]
        .into_iter()
        .flatten()
    {
        if let Some(found) = primitive_code(value.get("code")) {
            code = Some(found);
            break;
        }
    }
    if code.is_none() {
        static CODES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
            [r"\bMCP error\s+(-?\d+)\b", r"\bHTTP\s+(\d{3})\b"]
                .iter()
                .map(|p| Regex::with_flags(p, "iu").unwrap())
                .collect()
        });
        for regex in CODES.iter() {
            if let Some(found) = regex.find_from_utf16(text(&message)?.units(), 0).next() {
                code = found.group(1).map(|range| {
                    s(JsString::new(
                        text(&message).unwrap().units()[range].to_vec(),
                    ))
                });
                break;
            }
        }
    }
    let retry = [Some(selected), explicit.as_ref(), result.as_ref()]
        .into_iter()
        .flatten()
        .find_map(|v| v.get("retryable").filter(|v| v.is_boolean()).cloned())
        .unwrap_or(Value::Null);
    Ok(Some(obj([
        ("code", code.unwrap_or(Value::Null)),
        ("message", message),
        ("retryable", retry),
    ])))
}
fn bounded_json(value: Option<&Value>) -> Result<Value> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(Value::Null);
    };
    bounded(
        Some(&if value.is_string() {
            value.clone()
        } else {
            s(value.stringify_pretty())
        }),
        20_000,
    )
}
pub(super) fn result_text(result: &Value) -> Result<Value> {
    if !cantrip_wire::coercion::truthy(Some(result)) {
        return Ok(Value::Null);
    }
    let parts = if result["content"].is_null() {
        &[][..]
    } else {
        array(&result["content"])?
    };
    let combined = join(
        parts
            .iter()
            .filter_map(|v| v["text"].as_js_string().cloned()),
        "\n\n",
    )
    .trim();
    if !combined.is_empty() {
        return bounded(Some(&s(raw::redact(&combined))), 20_000);
    }
    let serialized = if !result["structuredContent"].is_null() {
        bounded_json(result.get("structuredContent"))?
    } else if !parts.is_empty() {
        bounded_json(result.get("content"))?
    } else {
        Value::Null
    };
    Ok(if cantrip_wire::coercion::truthy(Some(&serialized)) {
        s(raw::redact(text(&serialized)?))
    } else {
        Value::Null
    })
}
