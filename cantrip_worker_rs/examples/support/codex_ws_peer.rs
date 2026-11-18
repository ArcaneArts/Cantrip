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
    let catalog = config["catalog"].as_object().and_then(|catalog| {
        let home = std::env::var("CODEX_HOME").ok()?;
        let key = std::path::Path::new(&home).file_name()?.to_str()?;
        catalog.get(key).cloned()
    });
    let observation = config["observation"].as_object().and_then(|observations| {
        let home = std::env::var("CODEX_HOME").ok()?;
        let key = std::path::Path::new(&home).file_name()?.to_str()?;
        observations.get(key).cloned()
    });
    if let Some(route) = &observation {
        assert_eq!(
            std::env::var("CANTRIP_CODEX_USER_CONFIG_FILE")
                .ok()
                .as_deref(),
            route["configuration"].as_str(),
        );
    }
    let mut awaiting_metadata_retry = None;
    let mut portable = false;
    let mut quota_waiting_for_refresh = None;
    let mut refresh_probed = false;
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
        if frame["id"] == "catalog-refresh" && frame.get("method").is_none() {
            let id = quota_waiting_for_refresh
                .take()
                .expect("pending quota fixture request");
            assert_eq!(frame["error"]["code"], json!(-32602));
            assert_eq!(
                frame["error"]["message"],
                "Cantrip could not refresh the ChatGPT access lease."
            );
            let quota = &catalog.as_ref().unwrap()["quota"];
            socket
                .send(Message::Text(
                    json!({"id":id,"result":quota}).stringify().into(),
                ))
                .await?;
            continue;
        }
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
            "thread/read" if observation.is_some() => {
                let thread = params["threadId"].as_str().expect("native thread ID");
                let spec = &observation.as_ref().unwrap()["threads"][thread];
                assert!(!spec.is_null(), "unexpected observation for {thread}");
                assert_eq!(params["includeTurns"], true);
                match params.get("includeHistoryMetadata") {
                    Some(value) => {
                        assert_eq!(*value, true);
                        assert!(awaiting_metadata_retry.is_none());
                        let message = if spec["metadataUnsupported"] == true {
                            awaiting_metadata_retry = Some(thread.to_owned());
                            Some("Unknown field includeHistoryMetadata")
                        } else {
                            spec["error"].as_str()
                        };
                        if let Some(message) = message {
                            socket
                                .send(Message::Text(
                                    json!({
                                        "id":id,"error":json!({"code":-32602,"message":message})
                                    })
                                    .stringify()
                                    .into(),
                                ))
                                .await?;
                            continue;
                        }
                    }
                    None => assert_eq!(awaiting_metadata_retry.take().as_deref(), Some(thread)),
                }
                json!({"thread":spec["thread"]})
            }
            method if observation.is_some() && method.starts_with("thread/") => {
                bail!("A read-only observation called {method}.");
            }
            "skills/extraRoots/set" if catalog.is_some() || observation.is_some() => {
                assert_eq!(params["extraRoots"].as_array().unwrap().len(), 1);
                if let Some(observation) = &observation {
                    assert!(observation["threads"]["standalone-thread"].is_null());
                }
                json!({})
            }
            "account/login/start" if catalog.is_some() => {
                let expected = &catalog.as_ref().unwrap()["login"];
                if expected.is_null() || params != expected {
                    bail!("The catalog fixture received a mismatched account login.");
                }
                portable = true;
                json!({"type":"chatgptAuthTokens"})
            }
            "model/list" if catalog.is_some() => {
                let catalog = catalog.as_ref().unwrap();
                if portable == catalog["login"].is_null()
                    || params["includeHidden"] != true
                    || params["limit"] != json!(100)
                {
                    bail!(
                        "The catalog fixture received an unauthorized or malformed model request."
                    );
                }
                if params["cursor"].is_null() {
                    assert!(params.get("cursor").is_some());
                    catalog["firstPage"].clone()
                } else if params["cursor"] == "next-page" {
                    catalog["secondPage"].clone()
                } else {
                    bail!("The catalog fixture received an unexpected cursor.");
                }
            }
            "account/rateLimits/read" if catalog.is_some() => {
                let catalog = catalog.as_ref().unwrap();
                assert!(frame.get("params").is_none());
                if portable && catalog["probeRefresh"] == true && !refresh_probed {
                    refresh_probed = true;
                    quota_waiting_for_refresh = Some(id);
                    socket.send(Message::Text(json!({"id":"catalog-refresh","method":"account/chatgptAuthTokens/refresh",
                        "params":json!({"reason":"unauthorized","previousAccountId":catalog["login"]["chatgptAccountId"]})
                    }).stringify().into())).await?;
                    continue;
                }
                if catalog["quotaError"] == true {
                    socket.send(Message::Text(json!({"id":id,"error":json!({"code":-32000,"message":"Quota unavailable"})}).stringify().into())).await?;
                    continue;
                }
                catalog["quota"].clone()
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
            "thread/managedExecution/inferenceClaim" | "thread/managedExecution/resolve" => {
                let attempt = params["attemptId"].as_str().unwrap();
                let claim = method.ends_with("/inferenceClaim");
                let allow = params["allow"] == true;
                received.push(frame.clone());
                let key = if claim {
                    "claim"
                } else if allow {
                    "allow"
                } else {
                    "deny"
                };
                let reply = &config["inference"][attempt][key];
                if let Some(error) = reply.get("error") {
                    socket
                        .send(Message::Text(
                            json!({"id":id,"error":error}).stringify().into(),
                        ))
                        .await?;
                    continue;
                }
                let result = reply.get("result").cloned().unwrap_or_else(|| {
                    if claim {
                        json!({"claimed":true})
                    } else {
                        json!({"accepted":true})
                    }
                });
                if reply["hold"] == true {
                    held.push(json!({"id":id,"result":result}));
                    continue;
                }
                result
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
