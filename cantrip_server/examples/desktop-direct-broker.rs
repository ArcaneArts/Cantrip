//! Exercise the desktop's production verifier without a Tauri/WebView runtime.
//! Tickets and frame payloads stay on stdin; stdout never includes ticket secrets.
extern crate desktop_tokio_tungstenite as tokio_tungstenite;
// The desktop crate owns this shared source's Rust 2021 formatting. CI checks
// that file separately rather than rewriting it with this crate's 2024 style.
#[path = "../../cantrip_app/src-tauri/src/direct_probe_connection.rs"]
#[rustfmt::skip]
mod direct;

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead, Write};
use tokio_tungstenite::tungstenite::Message;
use zeroize::Zeroizing;

#[derive(Deserialize)]
struct Initialize {
    kind: String,
    ticket: direct::DirectProbeRequest,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Input {
    Send { bytes: String },
    Close,
}
fn output(value: serde_json::Value) -> Result<()> {
    println!("{value}");
    io::stdout().flush()?;
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let (send, mut input) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if send.send(line).is_err() {
                break;
            }
        }
    });
    let first = Zeroizing::new(
        input
            .recv()
            .await
            .context("Broker initialization is required")??,
    );
    let request: Initialize = serde_json::from_str(&first)?;
    drop(first);
    if request.kind == "probe" {
        let result = direct::probe_direct_worker(request.ticket).await;
        return output(json!({"event":"probe","result":result}));
    }
    anyhow::ensure!(request.kind == "connect", "Unknown native broker request");
    let mut connection = match direct::connect_verified(request.ticket).await {
        Ok(connection) => connection,
        Err(reason) => return output(json!({"event":"rejected","reason":reason})),
    };
    output(
        json!({"event":"verified","workerId":connection.worker_id,"brokerInstanceId":connection.broker_instance_id,"latencyMs":connection.latency_ms}),
    )?;
    loop {
        tokio::select! {
            line = input.recv() => {
                let Some(line) = line else { let _ = connection.socket.close(None).await; return Ok(()); };
                let line = Zeroizing::new(line?);
                match serde_json::from_str::<Input>(&line)? {
                    Input::Send { bytes } => connection.socket.send(Message::Binary(URL_SAFE_NO_PAD.decode(bytes)?.into())).await?,
                    Input::Close => { connection.socket.close(None).await?; return Ok(()); }
                }
            }
            frame = connection.socket.next() => {
                match frame {
                    Some(Ok(Message::Binary(bytes))) => output(json!({"event":"frame","bytes":URL_SAFE_NO_PAD.encode(bytes)}))?,
                    Some(Ok(Message::Text(text))) => output(json!({"event":"text","text":text.as_str()}))?,
                    Some(Ok(Message::Ping(_))) => connection.socket.flush().await?,
                    Some(Ok(Message::Close(frame))) => {
                        output(json!({"event":"closed","code":frame.as_ref().map(|f|u16::from(f.code)).unwrap_or(1005),"reason":frame.map(|f|f.reason.to_string()).unwrap_or_default()}))?;
                        let _ = connection.socket.flush().await;
                        return Ok(());
                    }
                    Some(Ok(_)) => {},
                    Some(Err(cause)) => return Err(cause.into()),
                    None => { output(json!({"event":"closed","code":1006,"reason":""}))?; return Ok(()); },
                }
            }
        }
    }
}
