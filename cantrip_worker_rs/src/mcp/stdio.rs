use super::broker::Broker;
use anyhow::{Result, bail};
use cantrip_protocol::{ValidationError, mcp_host};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{collections::HashMap, io::Read, sync::OnceLock};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::mpsc,
    task::{AbortHandle, JoinSet},
};

// Beyond the largest supported arguments (including escaped UTF-16).
const MAXIMUM_LINE: usize = 8 * 1024 * 1024;

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

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":json!({"code":code,"message":message})})
}

fn initialize(id: &Value, params: &Value, profile: &Value) -> Value {
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

fn has_tool(profile: &Value, name: &str) -> bool {
    profile["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == name)
}

async fn call(
    broker: &Broker,
    profile: &Value,
    standalone: bool,
    name: &str,
    arguments: Option<&Value>,
) -> Value {
    let Some(operation) = catalog()["operations"][name].as_str() else {
        return tool_error(format!("MCP error -32602: Tool {name} not found"));
    };
    if !has_tool(profile, name) {
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
        return help(&arguments);
    }
    let payload = match broker.call(operation, arguments).await {
        Ok(payload) => payload,
        Err(error) => {
            let message = error.to_string();
            return tool_error(JsString::new(message.encode_utf16().take(2_000).collect()));
        }
    };
    match mcp_host::parse(&format!("mcpStdioOutput/{name}"), Some(&payload)) {
        Ok(payload) => tool_result(payload),
        Err(_) => tool_error("Cantrip MCP result validation failed."),
    }
}

/// Bound framing separately from asynchronous calls. Requests can complete in
/// any order. Cancelling one request drops only its broker HTTP exchange.
pub(super) async fn serve(
    broker: Broker,
    profile: &str,
    input: impl AsyncRead + Unpin + Send + 'static,
    mut output: impl AsyncWrite + Unpin,
) -> Result<()> {
    let standalone = profile == "standalone-web";
    let profile = &catalog()["profiles"][profile];
    let (sender, mut frames) = mpsc::channel(16);
    let mut reader = tokio::spawn(read_frames(BufReader::new(input), sender));
    let mut calls = JoinSet::new();
    let mut pending = HashMap::<String, AbortHandle>::new();
    let outcome = async {
        loop {
            tokio::select! {
                frame = frames.recv() => {
                    let Some(frame) = frame else { break; };
                    let Some(method) = frame["method"].as_str() else { continue; };
                    let params = &frame["params"];
                    let Some(id) = frame.get("id") else {
                        if method == "notifications/cancelled"
                            && let Some(request_id) = params.get("requestId")
                            && let Some(handle) = pending.remove(&request_id.stringify()) {
                            handle.abort();
                        }
                        continue;
                    };
                    let key = id.stringify();
                    if pending.contains_key(&key) {
                        write_frame(&mut output, rpc_error(id, -32600, "Duplicate pending request ID")).await?;
                        continue;
                    }
                    let reply = match method {
                        "initialize" => initialize(id, params, profile),
                        "ping" => result(id, json!({})),
                        "tools/list" => result(id, json!({"tools":profile["tools"]})),
                        "tools/call" => {
                            let Some(name) = params["name"].as_str() else {
                                write_frame(&mut output, rpc_error(id, -32602, "Invalid tool call parameters")).await?;
                                continue;
                            };
                            let name = name.to_owned();
                            let arguments = params.get("arguments").cloned();
                            let broker = broker.clone();
                            let id = id.clone();
                            let correlation = key.clone();
                            let handle = calls.spawn(async move {
                                let payload = call(&broker, profile, standalone, &name, arguments.as_ref()).await;
                                (correlation, result(&id, payload))
                            });
                            pending.insert(key, handle);
                            continue;
                        }
                        _ => rpc_error(id, -32601, "Method not found"),
                    };
                    write_frame(&mut output, reply).await?;
                }
                completed = calls.join_next_with_id(), if !calls.is_empty() => {
                    match completed {
                        Some(Ok((task, (key, reply)))) => {
                            if pending.get(&key).is_some_and(|handle| handle.id() == task) {
                                pending.remove(&key);
                                write_frame(&mut output, reply).await?;
                            }
                        }
                        Some(Err(error)) if !error.is_cancelled() => return Err(error.into()),
                        _ => {},
                    }
                }
            }
        }
        (&mut reader).await??;
        Ok(())
    }.await;
    reader.abort();
    calls.shutdown().await;
    outcome
}

async fn read_frames(
    mut input: BufReader<impl AsyncRead + Unpin>,
    frames: mpsc::Sender<Value>,
) -> Result<()> {
    let mut line = Vec::new();
    loop {
        let chunk = input.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(());
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let len = newline.unwrap_or(chunk.len());
        if len > MAXIMUM_LINE - line.len() {
            bail!("Cantrip MCP request exceeds the line limit.");
        }
        line.extend_from_slice(&chunk[..len]);
        input.consume(len + usize::from(newline.is_some()));
        if newline.is_some() {
            if let Ok(frame) = parse_json_text(&String::from_utf8_lossy(&line))
                && frame["jsonrpc"] == "2.0"
                && frame["method"].is_string()
                && frame
                    .get("id")
                    .is_none_or(|id| id.is_string() || id.as_i64().is_some())
                && frames.send(frame).await.is_err()
            {
                return Ok(());
            }
            line.clear();
        }
    }
}

async fn write_frame(output: &mut (impl AsyncWrite + Unpin), frame: Value) -> Result<()> {
    let mut frame = frame.stringify();
    frame.push('\n');
    output.write_all(frame.as_bytes()).await?;
    output.flush().await?;
    Ok(())
}
