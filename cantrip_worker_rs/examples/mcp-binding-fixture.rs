//! Drives the native binding lifecycle for the local MCP smoke test.
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::mcp::bindings::{Activation, Broker, Server};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key]
        .as_str()
        .with_context(|| format!("Missing {key}"))
}

fn decode(line: &str) -> Result<Value> {
    parse_json_text(line).map_err(|error| anyhow!("{}", error.lossy()))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let start = decode(&input.next_line().await?.context("Missing setup")?)?;
    let identity = Arc::new(Mutex::new((
        text(&start, "owner")?.into(),
        text(&start, "serverId")?.into(),
    )));
    let credential = text(&start, "credential")?.to_owned();
    let server = Server::new(
        text(&start, "url")?,
        Arc::new(move || Ok(credential.clone())),
    )?;
    let broker = Broker::start(
        Path::new(text(&start, "directory")?),
        text(&start, "worker")?.into(),
        {
            let identity = identity.clone();
            Arc::new(move || Ok(identity.lock().unwrap().clone()))
        },
        server,
    )
    .await?;
    let mut activations = Vec::<Option<Activation>>::new();
    while let Some(line) = input.next_line().await? {
        let request = decode(&line)?;
        let result: Result<Value> = async {
            Ok(match text(&request, "op")? {
                "prepare" => {
                    let attachment = broker.prepare(request["claims"].clone(), request.get("legacyRoot").cloned()).await?;
                    json!({
                        "path":attachment.connection_path.to_str(),
                        "configuration":attachment.codex_configuration(Path::new(text(&request, "worker")?))?,
                    })
                }
                "activate" => match broker.activate(&request["claims"])? {
                    Some(lease) => {
                        let index = activations.len();
                        activations.push(Some(lease));
                        json!(index)
                    }
                    None => Value::Null,
                },
                "release" => {
                    let index = request["index"].as_u64().context("Missing activation")? as usize;
                    json!(activations[index].take().is_some_and(Activation::release))
                }
                "owner" => {
                    identity.lock().unwrap().0 = text(&request, "owner")?.into();
                    Value::Null
                }
                "revoke" => json!(broker.revoke(&text(&request, "bindingId")?.into())?),
                _ => bail!("Unknown fixture operation"),
            })
        }.await;
        let reply = match result {
            Ok(result) => json!({"result":result}),
            Err(error) => json!({"error":error.to_string()}),
        };
        output.write_all(reply.stringify().as_bytes()).await?;
        output.write_all(b"\n").await?;
        output.flush().await?;
    }
    broker.close().await
}
