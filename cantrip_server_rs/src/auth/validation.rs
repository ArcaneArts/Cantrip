use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
        Some(Value::String(_)) => "string",
    }
}
fn invalid_type(
    issues: &mut Vec<Value>,
    name: Option<&str>,
    expected: &str,
    value: Option<&Value>,
) {
    issues.push(json!({"expected":expected,"code":"invalid_type","path":name.map_or_else(Vec::<Value>::new,|v|vec![json!(v)]),"message":format!("Invalid input: expected {expected}, received {}",received(value))}));
}

// Zod's length checks have their own `when`: they also run after a string
// type error when JSON input has a length property (notably arrays).
fn length_checks(
    issues: &mut Vec<Value>,
    name: &str,
    value: &Value,
    minimum: usize,
    maximum: usize,
) {
    let (length, origin) = match value {
        Value::String(value) => (crate::text::length(value) as f64, "string"),
        Value::Array(value) => (value.len() as f64, "array"),
        Value::Object(value) => {
            let Some(length) = value.get("length") else {
                return;
            };
            let number = match length {
                Value::Null => 0.0,
                Value::Bool(value) => {
                    if *value {
                        1.0
                    } else {
                        0.0
                    }
                }
                // JSON.parse accepts overflowing numeric literals as infinities.
                // Retain their comparison behavior without panicking on a
                // serde_json arbitrary-precision value outside f64's range.
                Value::Number(value) => value.to_string().parse().unwrap_or(f64::NAN),
                Value::String(value) => {
                    let value = crate::text::trim(value);
                    if value.is_empty() {
                        0.0
                    } else {
                        value.parse().unwrap_or(f64::NAN)
                    }
                }
                _ => f64::NAN,
            };
            (number, "unknown")
        }
        _ => return,
    };
    for (failed, code, key, bound, adjective, operator) in [
        (
            minimum > 0 && (length.is_nan() || length < minimum as f64),
            "too_small",
            "minimum",
            minimum,
            "small",
            ">=",
        ),
        (
            maximum != usize::MAX && (length.is_nan() || length > maximum as f64),
            "too_big",
            "maximum",
            maximum,
            "big",
            "<=",
        ),
    ] {
        if failed {
            let sizing = match origin {
                "string" => "have",
                "array" => "have",
                _ => "be",
            };
            let unit = match origin {
                "string" => " characters",
                "array" => " items",
                _ => "",
            };
            let mut issue = json!({"origin":origin,"code":code,"inclusive":true,"path":[name],"message":format!("Too {adjective}: expected {origin} to {sizing} {operator}{bound}{unit}")});
            issue[key] = json!(bound);
            issues.push(issue);
        }
    }
}
fn string(
    issues: &mut Vec<Value>,
    object: &Map<String, Value>,
    name: &str,
    minimum: usize,
    maximum: usize,
    trim: bool,
    optional: bool,
) -> Option<String> {
    let value = object.get(name);
    if optional && value.is_none() {
        return None;
    }
    let Some(value) = value.and_then(Value::as_str) else {
        invalid_type(issues, Some(name), "string", value);
        if let Some(value) = value {
            length_checks(issues, name, value, minimum, maximum);
        }
        return None;
    };
    let value = if trim {
        crate::text::trim(value)
    } else {
        value
    };
    length_checks(issues, name, &json!(value), minimum, maximum);
    Some(value.into())
}
fn email(issues: &mut Vec<Value>, object: &Map<String, Value>, optional: bool) -> Option<String> {
    let value = object.get("email");
    if optional && value.is_none() {
        return None;
    }
    let Some(value) = value.and_then(Value::as_str) else {
        invalid_type(issues, Some("email"), "string", value);
        if let Some(value) = value {
            length_checks(issues, "email", value, 0, 320);
        }
        return None;
    };
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(
            r"\A[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}\z",
        )
        .unwrap()
    });
    let input = value;
    if input.starts_with('.') || input.contains("..") || !pattern.is_match(input) {
        issues.push(json!({"origin":"string","code":"invalid_format","format":"email","pattern":r"/^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/","path":["email"],"message":"Invalid email address"}));
    }
    if crate::text::length(value) > 320 {
        issues.push(json!({"origin":"string","code":"too_big","maximum":320,"inclusive":true,"path":["email"],"message":"Too big: expected string to have <=320 characters"}));
    }
    Some(value.into())
}

pub fn validate(kind: &str, body: Option<&Value>) -> Result<Value, Value> {
    let mut issues = Vec::new();
    let Some(object) = body.and_then(Value::as_object) else {
        invalid_type(&mut issues, None, "object", body);
        return Err(json!({"error":"Invalid request body","issues":issues}));
    };
    let mut result = Map::new();
    match kind {
        "register" => {
            if let Some(value) = string(&mut issues, object, "displayName", 1, 120, true, false) {
                result.insert("displayName".into(), json!(value));
            }
            if let Some(value) = email(&mut issues, object, false) {
                result.insert("email".into(), json!(value));
            }
            if let Some(value) = string(&mut issues, object, "password", 12, 1024, false, false) {
                result.insert("password".into(), json!(value));
            }
        }
        "login" | "reauthenticate" => {
            if kind == "login"
                && let Some(value) = email(&mut issues, object, true)
            {
                result.insert("email".into(), json!(value));
            }
            if let Some(value) = string(&mut issues, object, "password", 1, 1024, false, false) {
                result.insert("password".into(), json!(value));
            }
            if kind == "reauthenticate" {
                let mut keys: Vec<_> = object
                    .keys()
                    .filter(|k| k.as_str() != "password")
                    .cloned()
                    .collect();
                // ECMAScript enumerates array-index keys before string keys.
                keys.sort_by_key(|key| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|n| *n < u32::MAX && n.to_string() == *key)
                        .map_or((1, 0), |n| (0, n))
                });
                if !keys.is_empty() {
                    issues.push(json!({"code":"unrecognized_keys","keys":keys,"path":[],"message":format!("Unrecognized {}: {}",if keys.len()==1{"key"}else{"keys"},keys.iter().map(|k|format!("\"{k}\"")).collect::<Vec<_>>().join(", "))}));
                }
            }
        }
        "exchange" => {
            if let Some(value) = string(&mut issues, object, "code", 0, usize::MAX, false, false) {
                if value.len() != 37
                    || !value.starts_with("ctms_")
                    || !value[5..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                {
                    issues.push(json!({"origin":"string","code":"invalid_format","format":"regex","pattern":"/^ctms_[A-Za-z0-9_-]{32}$/u","path":["code"],"message":"Invalid string: must match pattern /^ctms_[A-Za-z0-9_-]{32}$/u"}));
                }
                result.insert("code".into(), json!(value));
            }
        }
        _ => unreachable!("unknown auth validation schema"),
    }
    if issues.is_empty() {
        Ok(Value::Object(result))
    } else {
        Err(json!({"error":"Invalid request body","issues":issues}))
    }
}
