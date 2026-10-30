//! The installed protocol's Zod 4.4 intersects strict-object key sets: a key
//! recognized by either side is accepted. Preserve issue and output order.
use super::{Contracts, JsString, Node, Parsed, ValidationError, Value, value::json};

fn merge(left: Option<&Value>, right: Option<&Value>) -> Result<Option<Value>, ValidationError> {
    if left == right {
        return Ok(left.cloned());
    }
    match (left, right) {
        (Some(Value::Object(left)), Some(Value::Object(right))) => {
            let mut value = left.clone();
            for (key, item) in right {
                let merged = if let Some(previous) = left.get(key) {
                    merge(Some(previous), Some(item))?.ok_or(ValidationError::Operation)?
                } else {
                    item.clone()
                };
                value.insert(key.clone(), merged);
            }
            Ok(Some(Value::Object(value)))
        }
        (Some(Value::Array(left)), Some(Value::Array(right))) if left.len() == right.len() => {
            Ok(Some(Value::Array(
                left.iter()
                    .zip(right)
                    .map(|(left, right)| {
                        merge(Some(left), Some(right))?.ok_or(ValidationError::Operation)
                    })
                    .collect::<Result<_, _>>()?,
            )))
        }
        _ => Err(ValidationError::Operation),
    }
}
impl Contracts {
    pub(super) fn intersection(
        &self,
        node: &Node,
        input: Option<&Value>,
        path: &[Value],
    ) -> Result<Parsed, ValidationError> {
        let left = self.run(node.left.expect("intersection left"), input, path)?;
        let right = self.run(node.right.expect("intersection right"), input, path)?;
        let mut result = Parsed::new(input.cloned());
        let mut keys: Vec<JsString> = Vec::new();
        let mut right_keys: Vec<JsString> = Vec::new();
        let mut first = None;
        for (side, parsed) in [(false, &left), (true, &right)] {
            for issue in &parsed.issues {
                if issue["code"] == "unrecognized_keys" {
                    if !side && first.is_none() {
                        first = Some(issue.clone());
                    }
                    let into = if side { &mut right_keys } else { &mut keys };
                    for key in issue["keys"].as_array().ok_or(ValidationError::Operation)? {
                        let key = key.as_js_string().ok_or(ValidationError::Operation)?;
                        if !into.contains(key) {
                            into.push(key.clone());
                        }
                    }
                } else {
                    result.issues.push(issue.clone());
                }
            }
            result.aborted_other |= parsed.aborted_other;
        }
        keys.retain(|key| right_keys.contains(key));
        result.aborted = result.aborted_other;
        if !keys.is_empty()
            && let Some(mut issue) = first
        {
            issue["keys"] = json!(keys);
            issue["message"] = json!(JsString::join_quoted(
                if keys.len() == 1 {
                    "Unrecognized key: "
                } else {
                    "Unrecognized keys: "
                },
                &keys.iter().collect::<Vec<_>>()
            ));
            result.issues.push(issue);
            result.aborted = true;
        }
        if !result.aborted {
            result.value = merge(left.value.as_ref(), right.value.as_ref())?;
        }
        Ok(result)
    }
}
