//! A Redis lookup must not hide socket shutdown or retain early application
//! frames. The reference ws route installs its relay listener after the await.
use super::{CloseFrame, Message, Outgoing, Peer, WebSocket};
use crate::wire::Value;
use anyhow::Result;
use futures::{SinkExt, StreamExt};
use std::{future::Future, sync::Arc};
use tokio::sync::mpsc;

pub(super) async fn wait(
    socket: &mut WebSocket,
    peer: &Arc<Peer>,
    outgoing: &mut mpsc::UnboundedReceiver<Outgoing>,
    lookup: impl Future<Output = Result<Option<Value>>>,
) -> Option<Result<Option<Value>>> {
    tokio::pin!(lookup);
    loop {
        tokio::select! {
            biased;
            result = &mut lookup => return Some(result),
            message = outgoing.recv() => match message {
                Some(Outgoing::Close(code, reason)) => {
                    let _ = socket.send(Message::Close((code != 1005).then_some(CloseFrame {code: code.into(), reason: reason.into()}))).await;
                    return None;
                },
                Some(Outgoing::Flush) => { if socket.flush().await.is_err() { return None; } },
                Some(_) => {},
                None => return None,
            },
            message = socket.next() => match message {
                Some(Ok(Message::Ping(_))) => { if socket.flush().await.is_err() { return None; } },
                Some(Ok(Message::Close(_))) | None => return None,
                Some(Err(cause)) => {
                    let code = match cause {
                        tungstenite::Error::Utf8(..) => Some(1007),
                        tungstenite::Error::Capacity(..) => Some(1009),
                        tungstenite::Error::Protocol(..) => Some(1002),
                        _ => None,
                    };
                    if let Some(code) = code { peer.close(code, ""); }
                    else { return None; }
                },
                // No relay listener is installed until authorization completes.
                Some(Ok(_)) => {},
            },
        }
    }
}
