//! Separate generated graph for the native MCP child. Ordinary server and
//! worker requests do not load the tool input and output schemas.
use super::{Contracts, ValidationError, Value, parsed_value};
use std::sync::OnceLock;

pub fn parse(name: &str, input: Option<&Value>) -> Result<Value, ValidationError> {
    static MCP: OnceLock<Contracts> = OnceLock::new();
    let contracts = MCP.get_or_init(|| {
        let mut graph: Contracts = serde_json::from_str(include_str!("../contracts/mcp-host.json"))
            .expect("embedded MCP host contracts");
        graph.compile_patterns();
        graph
    });
    let root = contracts
        .roots
        .get(name)
        .ok_or(ValidationError::Operation)?;
    parsed_value(contracts.run(*root, input, &[])?)
}

pub(super) fn refine(
    tag: &str,
    result: &mut super::Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if !tag.starts_with("stdio-mcp-") {
        return Ok(false);
    }
    use super::{coercion::truthy, value::json};
    use std::collections::HashSet;
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let issue = |at: &[Value], message: &str| {
        let at = path
            .iter()
            .cloned()
            .chain(at.iter().cloned())
            .collect::<Vec<_>>();
        if matches!(
            tag,
            "stdio-mcp-domain-overlap" | "stdio-mcp-web-read-source" | "stdio-mcp-browser-session"
        ) {
            json!({"code":"custom","message":message,"path":at})
        } else {
            json!({"code":"custom","path":at,"message":message})
        }
    };
    let invalid = |text| issue(&[], message.unwrap_or(text));
    match tag {
        "stdio-mcp-policy-keys" => {
            let policies = value.as_array().ok_or(ValidationError::Operation)?;
            let mut keys = HashSet::new();
            if policies
                .iter()
                .any(|policy| !keys.insert(policy["key"].as_js_string()))
            {
                result
                    .issues
                    .push(invalid("Effective policies cannot contain duplicate keys."));
            }
        }
        "stdio-mcp-domain-overlap" => {
            let included = value["includeDomains"]
                .as_array()
                .ok_or(ValidationError::Operation)?;
            let excluded = value["excludeDomains"]
                .as_array()
                .ok_or(ValidationError::Operation)?;
            for (index, domain) in excluded.iter().enumerate() {
                if included.contains(domain) {
                    result.issues.push(issue(
                        &[json!("excludeDomains"), json!(index)],
                        "A domain cannot be both included and excluded.",
                    ));
                }
            }
        }
        "stdio-mcp-web-read-source" => {
            let count = usize::from(truthy(value.get("url")))
                + usize::from(truthy(value.get("searchResultId")));
            if truthy(value.get("cursor")) {
                if count != 0 {
                    result.issues.push(issue(
                        &[json!("cursor")],
                        "A continuation cursor cannot be combined with a URL or search result ID.",
                    ));
                }
            } else if count != 1 {
                result
                    .issues
                    .push(issue(&[], "Provide exactly one of url or searchResultId."));
            }
        }
        "stdio-mcp-browser-session" => {
            if truthy(value.get("sessionId")) && truthy(value.get("browserTarget")) {
                result.issues.push(issue(
                    &[json!("browserTarget")],
                    "A resumed session already has a fixed profile target.",
                ));
            }
        }
        "stdio-mcp-pointer" => {
            if (value["action"] == "drag") != truthy(value.get("to")) {
                result.issues.push(issue(
                    &[json!("to")],
                    "Only drag requires a destination point.",
                ));
            }
        }
        "stdio-mcp-secret-nul" => {
            if value
                .as_js_string()
                .is_some_and(|value| value.units().contains(&0))
            {
                result
                    .issues
                    .push(invalid("Secret values cannot contain NUL characters."));
            }
        }
        "stdio-mcp-browser-url" => {
            if value.as_js_string().is_some_and(|url| {
                let url = url.lossy();
                !url.starts_with("http://") && !url.starts_with("https://")
            }) {
                result
                    .issues
                    .push(invalid("Browser URLs must use HTTP or HTTPS."));
            }
        }
        "stdio-mcp-client-mutation" => {
            if value["mutated"].as_bool() != Some(value["data"]["status"] == "applied") {
                result.issues.push(issue(
                    &[json!("mutated")],
                    "Client-control mutation state must match its applied status.",
                ));
            }
        }
        _ => return Err(ValidationError::Operation),
    }
    Ok(true)
}
