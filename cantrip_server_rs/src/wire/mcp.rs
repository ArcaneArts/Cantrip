use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn compatible_call(result: &mut Parsed) -> Result<(), ValidationError> {
    let Value::Object(call) = result.value.as_mut().ok_or(ValidationError::Operation)? else {
        return Err(ValidationError::Operation);
    };
    let Some(Value::Object(binding)) = call.get_mut("binding") else {
        return Err(ValidationError::Operation);
    };
    binding.shift_remove("canonicalRoot");
    let operations = binding
        .shift_remove("allowedOperations")
        .ok_or(ValidationError::Operation)?;
    let operations = operations.as_array().ok_or(ValidationError::Operation)?;
    if !binding.contains_key("contextKind") {
        binding.insert("contextKind".into(), json!("project"));
    }
    if !binding.contains_key("scratchRootId") {
        binding.insert("scratchRootId".into(), Value::Null);
    }
    binding.insert(
        "allowedOperations".into(),
        Value::Array(
            operations
                .iter()
                .filter(|operation| {
                    super::parse("cantripAgentOperationNameSchema", Some(operation)).is_ok()
                })
                .cloned()
                .collect(),
        ),
    );
    Ok(())
}
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !tag.starts_with("mcp-") && tag != "cli-arguments-size" {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    match tag {
        "mcp-run-update" => {
            if value["configurationId"] != value["document"]["id"] {
                let mut at = path.to_vec();
                at.extend([json!("document"), json!("id")]);
                result.issue(
                    json!({"code":"custom"}),
                    &at,
                    "The requested and document configuration IDs must match.".into(),
                    false,
                );
            }
        }
        "mcp-binding-dates" => {
            let issue = |message: &str| {
                let mut at = path.to_vec();
                at.push(json!("expiresAt"));
                json!({"code":"custom","path":at,"message":message})
            };
            let issued = value["issuedAt"]
                .as_js_string()
                .and_then(super::date_milliseconds);
            let expires = value["expiresAt"]
                .as_js_string()
                .and_then(super::date_milliseconds);
            if let (Some(a), Some(b)) = (issued, expires) {
                if b <= a {
                    result.issues.push(issue(
                        "Cantrip MCP bindings must expire after they are issued.",
                    ));
                }
                if b - a > 24 * 60 * 60 * 1000 {
                    result.issues.push(issue(
                        "Cantrip MCP bindings cannot live longer than 24 hours.",
                    ));
                }
            }
        }
        "mcp-arguments-size" | "cli-arguments-size" => {
            let (maximum, message) = if tag == "cli-arguments-size" {
                (20, "Cantrip CLI commands accept at most 20 arguments.")
            } else {
                (32, "Cantrip agent operations accept at most 32 arguments.")
            };
            if value.as_object().is_some_and(|v| v.len() > maximum) {
                result
                    .issues
                    .push(json!({"code":"custom","path":path,"message":message}));
            }
        }
        "mcp-discovery-worker" => {
            if !super::coercion::truthy(value["configuration"].get("workerId")) {
                let mut at = path.to_vec();
                at.extend([json!("configuration"), json!("workerId")]);
                result.issues.push(json!({"code":"custom","message":"Discovered MCP servers must be bound to their worker.","path":at}));
            }
        }
        _ => return Err(ValidationError::Operation),
    }
    Ok(true)
}
