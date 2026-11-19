//! MCP schemas and JSON-RPC replies shared by the stdio and HTTP transports.
use cantrip_protocol::{ValidationError, mcp_host};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{io::Read, sync::OnceLock};

pub(super) fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let mut bytes = String::new();
        flate2::read::GzDecoder::new(&include_bytes!("catalog.json.gz")[..])
            .read_to_string(&mut bytes)
            .expect("embedded Cantrip MCP catalog");
        parse_json_text(&bytes).expect("generated Cantrip MCP catalog")
    })
}

pub(super) fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

pub(super) fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":json!({"code":code,"message":message})})
}

pub(super) fn initialize(id: &Value, params: &Value, profile: &Value) -> Value {
    let Some(version) = params["protocolVersion"].as_str() else {
        return rpc_error(id, -32602, "Invalid initialize parameters");
    };
    if !params["capabilities"].is_object()
        || !params["clientInfo"]["name"].is_string()
        || !params["clientInfo"]["version"].is_string()
    {
        return rpc_error(id, -32602, "Invalid initialize parameters");
    }
    let protocol = &catalog()["protocol"];
    let version = if protocol["supported"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == version)
    {
        json!(version)
    } else {
        protocol["latest"].clone()
    };
    let mut server = profile["serverInfo"].clone();
    server["version"] = crate::version::value()["version"].clone();
    result(
        id,
        json!({
            "protocolVersion":version,
            "capabilities":profile["capabilities"],"serverInfo":server,"instructions":profile["instructions"],
        }),
    )
}

fn tool_error(message: impl Into<JsString>) -> Value {
    let message = message.into();
    json!({"content":vec![json!({"type":"text","text":message})],"isError":true})
}

fn tool_result(payload: Value) -> Value {
    json!({"content":vec![json!({"type":"text","text":payload["summary"]})],"structuredContent":payload})
}

fn help(arguments: &Value) -> Value {
    let (tool, alias) = (arguments["tool"].as_str(), arguments["toolName"].as_str());
    let Some(selected) = tool.or(alias) else {
        return input_error(
            "tool_help",
            custom_issue(
                "tool",
                r#"Provide either "tool" or its compatibility alias "toolName"."#,
            ),
        );
    };
    if tool.is_some() && alias.is_some() && tool != alias {
        return input_error(
            "tool_help",
            custom_issue(
                "toolName",
                r#"The "tool" and "toolName" values must match."#,
            ),
        );
    }
    tool_result(catalog()["help"][selected].clone())
}

fn custom_issue(field: &str, message: &str) -> Value {
    json!(vec![
        json!({"code":"custom","message":message,"path":vec![field]})
    ])
}

fn input_error(tool: &str, issues: Value) -> Value {
    tool_error(format!(
        "MCP error -32602: Input validation error: Invalid arguments for tool {tool}: {}",
        issues.stringify_pretty()
    ))
}

pub(super) async fn call(
    invoke: impl AsyncFnOnce(&str, Value) -> Result<Value, JsString>,
    tool_enabled: impl Fn(&str) -> bool,
    standalone: bool,
    name: &str,
    arguments: Option<&Value>,
) -> Value {
    let Some(operation) = catalog()["operations"][name].as_str() else {
        return tool_error(format!("MCP error -32602: Tool {name} not found"));
    };
    if !tool_enabled(name) {
        return tool_error(format!("MCP error -32602: Tool {name} disabled"));
    }
    let schema = if name == "tool_help" && standalone {
        "mcpStdioStandaloneToolHelpInput".to_owned()
    } else {
        format!("mcpStdioInput/{name}")
    };
    let arguments = match mcp_host::parse(&schema, arguments) {
        Ok(arguments) => arguments,
        Err(ValidationError::Invalid(issues)) => return input_error(name, Value::Array(issues)),
        Err(ValidationError::Operation) => {
            return tool_error("Cantrip MCP argument validation failed.");
        }
    };
    if name == "tool_help" {
        if let Some(tool) = arguments["tool"]
            .as_str()
            .or(arguments["toolName"].as_str())
            && !tool_enabled(tool)
        {
            return tool_error("That tool is unavailable in this Cantrip MCP profile.");
        }
        return help(&arguments);
    }
    let payload = match invoke(operation, arguments).await {
        Ok(payload) => payload,
        Err(message) => {
            return tool_error(JsString::new(
                message.units().iter().copied().take(2_000).collect(),
            ));
        }
    };
    match mcp_host::parse(&format!("mcpStdioOutput/{name}"), Some(&payload)) {
        Ok(payload) => tool_result(payload),
        Err(_) => tool_error("Cantrip MCP result validation failed."),
    }
}
