use super::{JsString, Value, value::Object};
use std::sync::OnceLock;

pub(crate) fn number(value: Option<&Value>) -> Result<f64, ()> {
    Ok(match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(value)) => *value,
        Some(value) => {
            let text = string(value)?;
            let Some(text) = text.as_str() else {
                return Ok(f64::NAN);
            };
            let text = crate::text::trim(text);
            if text.is_empty() {
                return Ok(0.0);
            }
            for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
                if let Some(digits) = text.to_ascii_lowercase().strip_prefix(prefix) {
                    if digits.is_empty() {
                        return Ok(f64::NAN);
                    }
                    return Ok(digits
                        .chars()
                        .try_fold(0.0, |value, ch| {
                            ch.to_digit(radix)
                                .map(|digit| value * f64::from(radix) + f64::from(digit))
                        })
                        .unwrap_or(f64::NAN));
                }
            }
            static DECIMAL: OnceLock<regex::Regex> = OnceLock::new();
            if !DECIMAL.get_or_init(||regex::Regex::new(r"\A[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)\z").unwrap()).is_match(text){return Ok(f64::NAN)}
            text.parse().unwrap_or(f64::NAN)
        }
    })
}
pub(super) fn string(value: &Value) -> Result<JsString, ()> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string().into(),
        Value::Number(value) => ryu_js::Buffer::new().format(*value).into(),
        Value::String(value) => value.clone(),
        Value::Array(values) => {
            let mut units = Vec::new();
            for (i, value) in values.iter().enumerate() {
                if i > 0 {
                    units.push(44)
                }
                if !value.is_null() {
                    units.extend(string(value)?.units().iter().copied());
                }
            }
            JsString::new(units)
        }
        Value::Object(object) => {
            if object.contains_key("toString") {
                return Err(());
            }
            "[object Object]".into()
        }
    })
}
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(v)) => *v,
        Some(Value::String(v)) => !v.is_empty(),
        Some(Value::Number(v)) => *v != 0.0 && !v.is_nan(),
        _ => true,
    }
}
pub(super) fn json_number(value: f64) -> Value {
    Value::Number(value)
}
pub(super) fn keys(object: &Object) -> Vec<&JsString> {
    let mut keys: Vec<_> = object.keys().collect();
    keys.sort_by_key(|key| {
        key.as_str()
            .and_then(|s| {
                s.parse::<u32>()
                    .ok()
                    .filter(|n| *n < u32::MAX && n.to_string() == s)
            })
            .map_or((1, 0), |n| (0, n))
    });
    keys
}
pub(super) struct Length {
    pub number: f64,
    pub numeric: bool,
    pub origin: &'static str,
}
pub(super) fn length(value: Option<&Value>) -> Result<Option<Length>, ()> {
    Ok(match value {
        Some(Value::String(value)) => Some(Length {
            number: value.len() as f64,
            numeric: true,
            origin: "string",
        }),
        Some(Value::Array(value)) => Some(Length {
            number: value.len() as f64,
            numeric: true,
            origin: "array",
        }),
        Some(Value::Object(value)) => match value.get("length") {
            Some(value) => Some(Length {
                number: number(Some(value))?,
                numeric: value.is_number(),
                origin: "unknown",
            }),
            None => None,
        },
        _ => None,
    })
}
