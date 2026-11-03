use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !tag.starts_with("mcp-") {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    match tag {
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
        "mcp-arguments-size" => {
            if value.as_object().is_some_and(|v| v.len() > 32) {
                result.issues.push(json!({"code":"custom","path":path,"message":"Cantrip agent operations accept at most 32 arguments."}));
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
