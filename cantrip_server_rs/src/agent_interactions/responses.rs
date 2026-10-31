use super::*;
use std::collections::HashSet;

pub(super) fn validate(payload: &Value, response: &Value) -> Result<()> {
    if payload["kind"] != response["kind"] {
        return Err(conflict(
            "Response kind does not match the pending request.",
        ));
    }
    if payload["kind"] == "commandExecution" {
        if truthy(payload.get("availableDecisions"))
            && !payload["availableDecisions"]
                .as_array()
                .context("Command decisions")?
                .contains(&response["decision"])
        {
            return Err(conflict(
                "Command response is not one of the available decisions.",
            ));
        }
        if response["decision"] == "acceptWithExecpolicyAmendment"
            && !truthy(response.get("execpolicyAmendment"))
        {
            return Err(conflict(
                "An execpolicy amendment is required for this decision.",
            ));
        }
        if response["decision"] == "applyNetworkPolicyAmendment"
            && !truthy(response.get("networkPolicyAmendment"))
        {
            return Err(conflict(
                "A network policy amendment is required for this decision.",
            ));
        }
    }
    if payload["kind"] == "userInput" {
        let questions: HashSet<_> = payload["questions"]
            .as_array()
            .context("Interaction questions")?
            .iter()
            .map(|q| {
                q["id"]
                    .as_js_string()
                    .expect("validated question ID")
                    .clone()
            })
            .collect();
        let answers = response["answers"]
            .as_object()
            .context("Interaction answers")?;
        if answers.len() != questions.len() || answers.keys().any(|key| !questions.contains(key)) {
            return Err(conflict(
                "User input responses must answer each requested question exactly once.",
            ));
        }
    }
    if payload["kind"] == "permissions"
        && !subset(&response["permissions"], &payload["requestedPermissions"])
    {
        return Err(conflict(
            "Granted permissions must be a subset of the requested permissions.",
        ));
    }
    Ok(())
}
fn subset(granted: &Value, requested: &Value) -> bool {
    // Avoid request-controlled recursive Rust futures/stacks. Array membership
    // deliberately compares JSON.stringify, including object property order.
    let empty = Value::object([] as [(&str, Value); 0]);
    let mut pending = vec![(granted, requested)];
    while let Some((granted, requested)) = pending.pop() {
        match granted {
            Value::Array(candidates) => {
                let Some(allowed) = requested.as_array() else {
                    return false;
                };
                if !candidates
                    .iter()
                    .all(|v| allowed.iter().any(|a| a.stringify() == v.stringify()))
                {
                    return false;
                }
            }
            Value::Object(fields) => {
                let Some(allowed) = requested.as_object() else {
                    return false;
                };
                for (key, value) in fields {
                    if let Some(wanted) = allowed.get(key) {
                        pending.push((value, wanted));
                    } else if key.as_str() == Some("__proto__") {
                        pending.push((value, &empty));
                    } else {
                        return false;
                    }
                }
            }
            Value::Number(number) => {
                let Some(other) = requested.as_f64() else {
                    return false;
                };
                if !(number.is_nan() && other.is_nan()) && number.to_bits() != other.to_bits() {
                    return false;
                }
            }
            _ => {
                if granted != requested {
                    return false;
                }
            }
        }
    }
    true
}
pub(super) fn stored(payload: &Value, response: &Value) -> Result<Value> {
    if payload["kind"] != "userInput" || response["kind"] != "userInput" {
        return Ok(response.clone());
    }
    let secrets: HashSet<_> = payload["questions"]
        .as_array()
        .context("Interaction questions")?
        .iter()
        .filter(|q| truthy(q.get("isSecret")))
        .map(|q| {
            q["id"]
                .as_js_string()
                .expect("validated question ID")
                .clone()
        })
        .collect();
    let mut result = response.clone();
    let Value::Object(answers) = &mut result["answers"] else {
        anyhow::bail!("Interaction answers");
    };
    for (key, answer) in answers {
        if secrets.contains(key) {
            *answer = json!({"answers":["[redacted]"]});
        }
    }
    Ok(result)
}
