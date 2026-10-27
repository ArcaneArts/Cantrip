//! Stack-safe execution of the protocol's explicitly registered recursive JSON schemas.
use super::{JsString, Parsed, Value, value::Object};

struct ParsedJson {
    value: Option<Value>,
    issues: Vec<Value>,
}
enum Frame<'a> {
    Array {
        remaining: std::iter::Enumerate<std::slice::Iter<'a, Value>>,
        index: usize,
        output: Vec<Value>,
        issues: Vec<Value>,
    },
    Object {
        remaining: std::vec::IntoIter<(&'a JsString, &'a Value)>,
        key: JsString,
        output: Object,
        issues: Vec<Value>,
    },
}
fn string(value: impl Into<JsString>) -> Value {
    Value::String(value.into())
}
fn invalid_type(expected: &str, received: &str, nonfinite: bool) -> Value {
    let mut issue = Value::object([
        ("expected", string(expected)),
        ("code", string("invalid_type")),
    ]);
    if expected == "number" && nonfinite {
        issue["received"] = string("Infinity");
    }
    issue["path"] = Value::Array(Vec::new());
    issue["message"] = string(format!(
        "Invalid input: expected {expected}, received {received}"
    ));
    issue
}
fn union_issue(received: &str, mut nested: Option<Vec<Value>>, nonfinite: bool) -> Value {
    let errors = ["string", "number", "boolean", "null", "array", "record"]
        .into_iter()
        .map(|expected| {
            Value::Array(
                if expected == received || (expected == "record" && received == "object") {
                    nested
                        .take()
                        .unwrap_or_else(|| vec![invalid_type(expected, received, nonfinite)])
                } else {
                    vec![invalid_type(expected, received, nonfinite)]
                },
            )
        })
        .collect();
    Value::object([
        ("code", string("invalid_union")),
        ("errors", Value::Array(errors)),
        ("path", Value::Array(Vec::new())),
        ("message", string("Invalid input")),
    ])
}
fn finish(received: &str, output: Value, issues: Vec<Value>) -> ParsedJson {
    if issues.is_empty() {
        ParsedJson {
            value: Some(output),
            issues,
        }
    } else {
        ParsedJson {
            value: None,
            issues: vec![union_issue(received, Some(issues), false)],
        }
    }
}
fn normalize(input: Option<&Value>) -> ParsedJson {
    let Some(input) = input else {
        return ParsedJson {
            value: None,
            issues: vec![union_issue("undefined", None, false)],
        };
    };
    let mut frames = Vec::new();
    let mut next = Some(input);
    let mut completed = None;
    loop {
        if let Some(input) = next.take() {
            match input {
                Value::Array(items) => {
                    let mut remaining = items.iter().enumerate();
                    if let Some((index, first)) = remaining.next() {
                        frames.push(Frame::Array {
                            remaining,
                            index,
                            output: Vec::with_capacity(items.len()),
                            issues: Vec::new(),
                        });
                        next = Some(first);
                        continue;
                    }
                    completed = Some(ParsedJson {
                        value: Some(Value::Array(Vec::new())),
                        issues: Vec::new(),
                    });
                }
                Value::Object(items) => {
                    let mut remaining = super::coercion::keys(items)
                        .into_iter()
                        .filter(|key| key.as_str() != Some("__proto__"))
                        .map(|key| (key, &items[key]))
                        .collect::<Vec<_>>()
                        .into_iter();
                    if let Some((key, first)) = remaining.next() {
                        frames.push(Frame::Object {
                            remaining,
                            key: key.clone(),
                            output: Object::new(),
                            issues: Vec::new(),
                        });
                        next = Some(first);
                        continue;
                    }
                    completed = Some(ParsedJson {
                        value: Some(Value::Object(Object::new())),
                        issues: Vec::new(),
                    });
                }
                Value::Number(number) if !number.is_finite() => {
                    completed = Some(ParsedJson {
                        value: None,
                        issues: vec![union_issue("number", None, true)],
                    });
                }
                other => {
                    completed = Some(ParsedJson {
                        value: Some(other.clone()),
                        issues: Vec::new(),
                    })
                }
            }
        }
        let mut child = completed.take().expect("completed JSON node");
        match frames.last_mut() {
            Some(Frame::Array {
                remaining,
                index,
                output,
                issues,
            }) => {
                if let Some(value) = child.value {
                    output.push(value);
                }
                for mut issue in child.issues.drain(..) {
                    issue["path"] = Value::Array(vec![Value::Number(*index as f64)]);
                    issues.push(issue);
                }
                if let Some((following_index, item)) = remaining.next() {
                    *index = following_index;
                    next = Some(item);
                } else if let Some(Frame::Array { output, issues, .. }) = frames.pop() {
                    completed = Some(finish("array", Value::Array(output), issues));
                }
            }
            Some(Frame::Object {
                remaining,
                key,
                output,
                issues,
            }) => {
                if let Some(value) = child.value {
                    output.insert(key.clone(), value);
                }
                for mut issue in child.issues.drain(..) {
                    issue["path"] = Value::Array(vec![string(key.clone())]);
                    issues.push(issue);
                }
                if let Some((name, item)) = remaining.next() {
                    *key = name.clone();
                    next = Some(item);
                } else if let Some(Frame::Object { output, issues, .. }) = frames.pop() {
                    completed = Some(finish("object", Value::Object(output), issues));
                }
            }
            None => return child,
        }
    }
}

/// Union alternatives keep their own relative issue paths. Only the outer
/// recursive JSON issue receives the enclosing object's path.
pub(super) fn parse(input: Option<&Value>, path: &[Value]) -> Parsed {
    let ParsedJson { value, mut issues } = normalize(input);
    for issue in &mut issues {
        issue["path"] = Value::Array(path.to_vec());
    }
    Parsed {
        value,
        aborted: !issues.is_empty(),
        issues,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{Context, Result};
    use std::{path::PathBuf, process::Command};

    fn outcome(parsed: Parsed) -> Value {
        if parsed.issues.is_empty() {
            Value::object([("ok", parsed.value.unwrap())])
        } else {
            Value::object([("issues", Value::Array(parsed.issues))])
        }
    }

    #[test]
    fn recursive_json_matches_actual_protocol_values_and_issue_paths() -> Result<()> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let output = Command::new("node")
            .args([
                "scripts/server-rust/worker-wire-oracle.mjs",
                "--json-vectors",
            ])
            .current_dir(root)
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "JSON oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let vectors: Value = serde_json::from_slice(&output.stdout)?;
        let cases = vectors.as_array().context("JSON oracle cases")?;
        for (index, case) in cases.iter().enumerate() {
            let input = case
                .get("raw")
                .and_then(Value::as_str)
                .map(serde_json::from_str::<Value>)
                .transpose()?;
            assert_eq!(
                outcome(parse(input.as_ref(), &[])),
                case["outcome"],
                "bare JSON case {index}"
            );
            assert_eq!(
                outcome(parse(
                    input.as_ref(),
                    &[Value::String("requestedPermissions".into())]
                )),
                case["nestedOutcome"],
                "nested JSON case {index}"
            );
        }
        println!(
            "{} actual recursive JSON value/error comparisons matched",
            cases.len() * 2
        );
        Ok(())
    }

    #[test]
    fn recursive_json_normalization_and_errors_use_a_bounded_call_stack() -> Result<()> {
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                for raw in [
                    "[".repeat(32768) + "0" + &"]".repeat(32768),
                    "{\"x\":[".repeat(12000) + "0" + &"]}".repeat(12000),
                ] {
                    let input: Value = serde_json::from_str(&raw).unwrap();
                    let parsed = parse(Some(&input), &[]);
                    assert!(parsed.issues.is_empty());
                    assert_eq!(parsed.value.unwrap().stringify(), raw);
                }
                let raw = "[".repeat(2048) + "1e400" + &"]".repeat(2048);
                let input: Value = serde_json::from_str(&raw).unwrap();
                let parsed = parse(Some(&input), &[]);
                assert!(parsed.aborted);
                assert_eq!(parsed.issues.len(), 1);
                assert!(Value::Array(parsed.issues).stringify().len() > 1_000_000);
                let ignored = "{\"__proto__\":".to_owned() + &raw + ",\"safe\":2}";
                let input: Value = serde_json::from_str(&ignored).unwrap();
                let parsed = parse(Some(&input), &[]);
                assert!(parsed.issues.is_empty());
                assert_eq!(parsed.value.unwrap().stringify(), "{\"safe\":2}");
            })?
            .join()
            .map_err(|_| anyhow::anyhow!("small-stack recursive JSON test panicked"))?;
        Ok(())
    }
}
