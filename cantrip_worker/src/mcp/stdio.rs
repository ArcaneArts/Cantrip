use super::{
    broker::Broker,
    cua,
    rpc::{self, initialize, result, rpc_error},
};
use anyhow::{Result, bail};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::collections::HashMap;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::mpsc,
    task::{AbortHandle, JoinSet},
};

// Beyond the largest supported arguments (including escaped UTF-16).
const MAXIMUM_LINE: usize = 8 * 1024 * 1024;

/// Bound framing separately from asynchronous calls. Requests can complete in
/// any order. Cancelling one request drops only its broker HTTP exchange.
pub(super) async fn serve(
    broker: Broker,
    profile: &str,
    unicode_scalars: bool,
    input: impl AsyncRead + Unpin + Send + 'static,
    mut output: impl AsyncWrite + Unpin,
) -> Result<()> {
    let standalone = matches!(profile, "standalone-web" | "council");
    let is_cua = profile == "cua";
    let profile = &rpc::catalog()["profiles"][profile];
    let (sender, mut frames) = mpsc::channel(16);
    let maximum_line = if is_cua {
        cua::MAXIMUM_REQUEST
    } else {
        MAXIMUM_LINE
    };
    let mut reader = tokio::spawn(read_frames(BufReader::new(input), sender, maximum_line));
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
                        write_frame(&mut output, rpc_error(id, -32600, "Duplicate pending request ID"), unicode_scalars).await?;
                        continue;
                    }
                    let reply = match method {
                        "initialize" => initialize(id, params, profile),
                        "ping" => result(id, json!({})),
                        "tools/list" => result(id, json!({"tools":profile["tools"]})),
                        "tools/call" => {
                            let Some(name) = params["name"].as_str() else {
                                write_frame(&mut output, rpc_error(id, -32602, "Invalid tool call parameters"), unicode_scalars).await?;
                                continue;
                            };
                            let name = name.to_owned();
                            let arguments = params.get("arguments").cloned();
                            let metadata = is_cua.then(|| params["_meta"].clone());
                            let broker = broker.clone();
                            let id = id.clone();
                            let correlation = key.clone();
                            let handle = calls.spawn(async move {
                                let reply = if let Some(metadata) = metadata {
                                    cua::bounded_result(&id, cua::call(&broker, &name, arguments.as_ref(), &metadata).await)
                                } else {
                                    let payload = rpc::call(
                                        async |operation, args| broker.call(operation, args).await.map_err(|error| error.to_string().into()),
                                        |name| profile["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == name),
                                        standalone, &name, arguments.as_ref(),
                                    ).await;
                                    result(&id, payload)
                                };
                                (correlation, reply)
                            });
                            pending.insert(key, handle);
                            continue;
                        }
                        _ => rpc_error(id, -32601, "Method not found"),
                    };
                    write_frame(&mut output, reply, unicode_scalars).await?;
                }
                completed = calls.join_next_with_id(), if !calls.is_empty() => {
                    match completed {
                        Some(Ok((task, (key, reply)))) => {
                            if pending.get(&key).is_some_and(|handle| handle.id() == task) {
                                pending.remove(&key);
                                write_frame(&mut output, reply, unicode_scalars).await?;
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

pub(super) async fn read_frames(
    mut input: BufReader<impl AsyncRead + Unpin>,
    frames: mpsc::Sender<Value>,
    maximum_line: usize,
) -> Result<()> {
    let mut line = Vec::new();
    loop {
        let chunk = input.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(());
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let len = newline.unwrap_or(chunk.len());
        if len > maximum_line - line.len() {
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

pub(super) async fn write_frame(
    output: &mut (impl AsyncWrite + Unpin),
    frame: Value,
    unicode_scalars: bool,
) -> Result<()> {
    let mut frame = if unicode_scalars {
        frame.stringify_unicode_scalars()
    } else {
        frame.stringify()
    };
    frame.push('\n');
    output.write_all(frame.as_bytes()).await?;
    output.flush().await?;
    Ok(())
}
