//! Legacy terminal socket lifetime and session/account registration.
use super::{
    account,
    middleware::{self, Context},
    websocket::{self, WebSocket},
};
use crate::{
    auth::service::AuthService,
    live::{self, Socket as _, TransportLifetime},
    terminals::relay::Relay,
    wire::{Value, coercion::truthy},
    workers::output::{Buffered, Queued, framed_size},
};
use anyhow::{Result, bail};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use tungstenite::{Message, protocol::CloseFrame};

enum Outgoing {
    Text(Queued<String>),
    Flush,
    Close(u16, String),
}
struct Peer {
    open: AtomicBool,
    buffered: Buffered,
    queue: Mutex<mpsc::UnboundedSender<Outgoing>>,
    deadline: watch::Sender<Option<tokio::time::Instant>>,
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
            bail!("Terminal socket is closed")
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
            self.deadline
                .send_replace(Some(tokio::time::Instant::now() + Duration::from_secs(30)));
            let _ = queue.send(Outgoing::Close(code, reason.into()));
        }
    }
}
async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(terminal): Path<String>,
    request: Request,
) -> Response {
    let origin = middleware::value(request.headers(), "origin");
    let operation = account::query(request.uri()).get("operationId").cloned();
    let lifetime = service.live.transports.begin();
    websocket::upgrade(
        request,
        service.config.websocket_max_payload_bytes as usize,
        move |socket, _| run(socket, service, ctx, origin, operation, terminal, lifetime),
    )
}
async fn run(
    mut socket: WebSocket,
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    origin: Option<String>,
    operation: Option<Value>,
    terminal: String,
    lifetime: TransportLifetime,
) {
    let (send, mut outgoing) = mpsc::unbounded_channel();
    let deadline = socket.close_deadline_signal();
    let mut closing = deadline.subscribe();
    let forced = socket.force_close_signal();
    let peer = Arc::new(Peer {
        open: AtomicBool::new(true),
        buffered: Buffered::default(),
        queue: Mutex::new(send),
        deadline,
    });
    lifetime.attach(peer.clone());
    let mut registration = None;
    let mut relay = None;
    if !origin.is_some_and(|origin| service.config.app_origins.contains(&origin)) {
        peer.close(1008, "Origin not allowed");
    } else if let Some(user) = ctx.principal.user.as_ref() {
        registration = service.live.sessions.register(
            peer.clone(),
            &user.id,
            ctx.principal.session_id.as_deref(),
        );
        if registration.is_some() {
            let too_long = operation.as_ref().is_some_and(|v| {
                v.as_js_string().is_some_and(|s| s.units().len() > 200)
                    || v.as_array().is_some_and(|a| a.len() > 200)
            });
            if !truthy(operation.as_ref()) || too_long {
                peer.close(1008, "Terminal stream operation is required");
            } else {
                relay = Some(Relay::attach(
                    service.clone(),
                    user.id.clone(),
                    operation.unwrap(),
                    terminal,
                    peer.clone(),
                ));
            }
        }
    } else {
        peer.close(1008, "Authentication is required");
    }
    let retained = relay.clone();
    socket.on_closed(move || {
        if let Some(relay) = retained {
            relay.close();
        }
        drop(registration);
        drop(lifetime);
    });
    let (mut output, mut input) = socket.split();
    let reader = async {
        while let Some(message) = input.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    if let Some(relay) = &relay {
                        relay.receive(text.as_bytes());
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    if let Some(relay) = &relay {
                        relay.receive(&bytes);
                    }
                }
                Ok(Message::Ping(_)) => {
                    let _ = peer.queue.lock().unwrap().send(Outgoing::Flush);
                }
                Ok(Message::Close(_)) => break,
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
    };
    let writer = async {
        while let Some(message) = outgoing.recv().await {
            let result = match message {
                Outgoing::Text(mut text) => output.send(Message::Text(text.take().into())).await,
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
            let deadline = *closing.borrow_and_update();
            if let Some(deadline) = deadline {
                tokio::time::sleep_until(deadline).await;
                break;
            }
            if closing.changed().await.is_err() {
                break;
            }
        }
    };
    tokio::select! {_=reader=>{},_=writer=>{},_=expiration=>{forced.store(true,Ordering::Release);}}
    peer.open.store(false, Ordering::Release);
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/terminals/{terminalId}/connect", get(connect))
}
