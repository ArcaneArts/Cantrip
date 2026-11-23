//! Physical socket buffering and close deadlines mirror the existing ws carrier.
use super::Connection;
use crate::{
    live::{self, Socket as _},
    workers::output::{Buffered, Queued, framed_size},
};
use anyhow::{Result, bail};
use futures::{SinkExt, StreamExt};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{mpsc, watch};
use tungstenite::{Message, protocol::CloseFrame};

pub(super) enum Outgoing {
    Text(Queued<String>),
    Binary(Queued<Arc<[u8]>>),
    Flush,
    Close(u16, String),
}
pub(super) struct Peer {
    pub open: AtomicBool,
    pub buffered: Buffered,
    pub queue: Mutex<mpsc::UnboundedSender<Outgoing>>,
    pub deadline: watch::Sender<Option<tokio::time::Instant>>,
    pub forced: Arc<AtomicBool>,
}
impl live::Socket for Peer {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.bytes()
    }
    fn send(&self, text: Arc<str>) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if !self.is_open() {
            bail!("Remote Surface socket is closed")
        }
        queue.send(Outgoing::Text(
            self.buffered
                .reserve(text.to_string(), framed_size(text.len())),
        ))?;
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        let queue = self.queue.lock().unwrap();
        if self.open.swap(false, Ordering::AcqRel) {
            self.deadline.send_replace(Some(
                tokio::time::Instant::now() + std::time::Duration::from_secs(30),
            ));
            let _ = queue.send(Outgoing::Close(code, reason.into()));
        }
    }
}
impl Peer {
    pub fn binary(&self, data: Arc<[u8]>) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if !self.is_open() {
            bail!("Remote Surface socket is closed")
        }
        let size = framed_size(data.len());
        queue.send(Outgoing::Binary(self.buffered.reserve(data, size)))?;
        Ok(())
    }
}
pub(super) async fn pump(
    socket: super::websocket::WebSocket,
    peer: Arc<Peer>,
    connection: Option<Arc<Connection>>,
    mut outgoing: mpsc::UnboundedReceiver<Outgoing>,
) {
    let mut closing = peer.deadline.subscribe();
    let (mut output, mut input) = socket.split();
    let reader = async {
        while let Some(message) = input.next().await {
            match message {
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(_)) => {
                    let _ = peer.queue.lock().unwrap().send(Outgoing::Flush);
                }
                Ok(Message::Binary(bytes)) => {
                    if let Some(connection) = &connection {
                        connection.message(bytes.as_ref(), true)?;
                    }
                }
                Ok(Message::Text(text)) => {
                    if let Some(connection) = &connection {
                        connection.message(text.as_bytes(), false)?;
                    }
                }
                Ok(_) => {}
                Err(cause) => {
                    let code = match cause {
                        tungstenite::Error::Utf8(..) => Some(1007),
                        tungstenite::Error::Capacity(..) => Some(1009),
                        tungstenite::Error::Protocol(..) => Some(1002),
                        _ => None,
                    };
                    if let Some(code) = code {
                        peer.close(code, "");
                        futures::future::pending::<()>().await;
                    }
                    break;
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    let writer = async {
        while let Some(message) = outgoing.recv().await {
            let result = match message {
                Outgoing::Text(mut value) => output.send(Message::Text(value.take().into())).await,
                Outgoing::Binary(mut value) => {
                    output
                        .send(Message::Binary(value.take().as_ref().to_vec().into()))
                        .await
                }
                Outgoing::Flush => output.flush().await,
                Outgoing::Close(code, reason) => {
                    let _ = output
                        .send(Message::Close((code != 1005).then_some(CloseFrame {
                            code: code.into(),
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            };
            if result.is_err() {
                break;
            }
        }
    };
    let expiration = async {
        loop {
            let at = *closing.borrow_and_update();
            if let Some(at) = at {
                tokio::time::sleep_until(at).await;
                break;
            }
            if closing.changed().await.is_err() {
                break;
            }
        }
    };
    tokio::select! {_=reader=>{},_=writer=>{},_=expiration=>{peer.forced.store(true,Ordering::Release);}}
    peer.open.store(false, Ordering::Release);
}
