//! RawValue validates JSON syntax once. Build its tree iteratively rather than
//! recursively reparsing every subtree (which also rescanned nested input).
use super::{JsString, Object, Value};

enum Container {
    Array(Vec<Value>),
    Object(Object, Option<JsString>),
}

fn string(raw: &str, at: &mut usize) -> Result<JsString, serde_json::Error> {
    let start = *at;
    *at += 1;
    loop {
        match raw.as_bytes()[*at] {
            b'\\' => *at += 2,
            b'"' => {
                *at += 1;
                return serde_json::from_str(&raw[start..*at]);
            }
            _ => *at += 1,
        }
    }
}

// Only called on a complete, syntactically validated serde_json RawValue.
pub(super) fn parse(raw: &str) -> Result<Value, serde_json::Error> {
    let mut stack = Vec::new();
    let mut at = 0;
    loop {
        let value = match raw.as_bytes()[at] {
            b' ' | b'\t' | b'\r' | b'\n' | b',' | b':' => {
                at += 1;
                continue;
            }
            b'[' => {
                stack.push(Container::Array(Vec::new()));
                at += 1;
                continue;
            }
            b'{' => {
                stack.push(Container::Object(Object::new(), None));
                at += 1;
                continue;
            }
            b']' | b'}' => {
                at += 1;
                match stack.pop().expect("validated container") {
                    Container::Array(values) => Value::Array(values),
                    Container::Object(values, _) => Value::Object(values),
                }
            }
            b'"' => {
                let text = string(raw, &mut at)?;
                if let Some(Container::Object(_, key @ None)) = stack.last_mut() {
                    *key = Some(text);
                    continue;
                }
                Value::String(text)
            }
            b'n' => {
                at += 4;
                Value::Null
            }
            b't' => {
                at += 4;
                Value::Bool(true)
            }
            b'f' => {
                at += 5;
                Value::Bool(false)
            }
            _ => {
                let start = at;
                while at < raw.len()
                    && matches!(
                        raw.as_bytes()[at],
                        b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'
                    )
                {
                    at += 1;
                }
                Value::Number(raw[start..at].parse().map_err(serde::de::Error::custom)?)
            }
        };
        match stack.last_mut() {
            Some(Container::Array(values)) => values.push(value),
            Some(Container::Object(values, key)) => {
                values.insert(key.take().expect("validated object key"), value);
            }
            None => return Ok(value),
        }
    }
}
