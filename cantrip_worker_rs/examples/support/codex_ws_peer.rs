//! Controlled native process and WebSocket peer. No provider or inference calls.
use super::*;
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
pub async fn run() -> Result<()> {
    let config = parse_json_text(
        &std::env::var("CANTRIP_CODEX_SESSION_FIXTURE").unwrap_or_else(|_| "{}".into()),
    )
    .unwrap_or(json!({}));
    #[cfg(unix)]
    if config["ignoreInterrupt"] == true {
        unsafe {
            libc::signal(libc::SIGINT, libc::SIG_IGN);
        }
    }
    if let Some(lines) = config["stderr"].as_array() {
        for line in lines {
            eprintln!("{}", line.as_str().unwrap());
        }
    }
    if let Some(code) = config["exitBeforeListening"].as_i64() {
        std::process::exit(code as i32);
    }
    if config["noEndpoint"] == true {
        std::future::pending::<()>().await;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("listening on: ws://{}", listener.local_addr()?);
    let endpoint = if config["colored"] == true {
        format!("\x1b[2m{endpoint}\x1b[0m")
    } else {
        endpoint
    };
    if config["endpointOnStderr"] == true {
        eprintln!("{endpoint}");
    } else {
        println!("{endpoint}");
    }
    if config["closeBeforeHandshake"] == true {
        drop(listener);
        return std::future::pending::<Result<()>>().await;
    }
    let (stream, _) = listener.accept().await?;
    let mut socket = tokio_tungstenite::accept_async(stream).await?;
    let mut held = Vec::new();
    let mut received = Vec::new();
    while let Some(message) = socket.next().await {
        let message = message?;
        if message.is_close() {
            break;
        }
        if !message.is_text() {
            continue;
        }
        let frame = parse_json_text(message.to_text()?).map_err(|e| anyhow!("{}", e.lossy()))?;
        if frame.get("id").is_none() || frame.get("method").is_none() {
            received.push(frame);
            continue;
        }
        let id = frame["id"].clone();
        let params = &frame["params"];
        let method = frame["method"].as_str().unwrap();
        let result = match method {
            "initialize" => {
                json!({"userAgent":"native-fixture/0.166.0","platformFamily":"unix","platformOs":"macos","observedCapabilities":params["capabilities"]})
            }
            "fixture/echo" | "cantrip/inference" => {
                let mut reply = json!({"id":id});
                if let Some(error) = params.get("error") {
                    reply["error"] = error.clone();
                } else if let Some(value) = params.get("value") {
                    reply["result"] = value.clone();
                }
                if params["hold"] == true {
                    held.push(reply);
                    continue;
                }
                socket.send(Message::Text(reply.stringify().into())).await?;
                continue;
            }
            "fixture/release" => {
                for reply in held.drain(..).rev() {
                    socket.send(Message::Text(reply.stringify().into())).await?;
                }
                json!(true)
            }
            "fixture/invalid" => {
                for raw in params["frames"].as_array().unwrap() {
                    socket
                        .send(Message::Text(raw.as_str().unwrap().into()))
                        .await?;
                }
                json!(true)
            }
            "fixture/notify" => {
                for notice in params["notices"].as_array().unwrap() {
                    socket
                        .send(Message::Text(notice.stringify().into()))
                        .await?;
                }
                json!(true)
            }
            "fixture/server" => {
                socket.send(Message::Text(json!({"id":"server-one","method":"fixture/serverRequested","params":params}).stringify().into())).await?;
                json!(true)
            }
            "fixture/received" => {
                let result = json!(received);
                received.clear();
                result
            }
            "fixture/close" => {
                socket.close(None).await?;
                if let Some(path) = config["exitReleaseFile"].as_str() {
                    while tokio::fs::metadata(path).await.is_err() {
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                }
                tokio::time::sleep(Duration::from_millis(
                    config["exitDelayMs"].as_u64().unwrap_or(0),
                ))
                .await;
                std::process::exit(0);
            }
            "fixture/exit" => std::process::exit(params["code"].as_i64().unwrap_or(1) as i32),
            _ => {
                socket.send(Message::Text(json!({"id":id,"error":json!({"code":-32601,"message":"Method not found"})}).stringify().into())).await?;
                continue;
            }
        };
        socket
            .send(Message::Text(
                json!({"id":id,"result":result}).stringify().into(),
            ))
            .await?;
    }
    Ok(())
}
