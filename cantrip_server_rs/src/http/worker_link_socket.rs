//! Authenticated WorkerLink binary relay with actual queued/in-flight byte
//! accounting and cleanup tied to the upgraded transport's lifetime.
use super::{
    account,
    middleware::{self, Context},
    settings::error,
    websocket::{self, WebSocket},
};
use crate::{
    auth::service::AuthService,
    live::{self, TransportLifetime},
    wire::Value,
    worker_links::{frame::Frame, relay},
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
    Binary(Queued<Frame>),
    Flush,
    Close(u16, String),
}
struct Peer {
    open: AtomicBool,
    buffered: Buffered,
    queue: Mutex<mpsc::UnboundedSender<Outgoing>>,
    deadline: watch::Sender<Option<tokio::time::Instant>>,
}
impl Peer {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
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
impl live::Socket for Peer {
    fn is_open(&self) -> bool {
        self.is_open()
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.bytes()
    }
    fn send(&self, text: Arc<str>) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if !self.is_open() {
            bail!("WorkerLink socket is closed");
        }
        queue.send(Outgoing::Text(
            self.buffered
                .reserve(text.to_string(), framed_size(text.len())),
        ))?;
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        self.close(code, reason);
    }
}
impl relay::Socket for Peer {
    fn is_open(&self) -> bool {
        self.is_open()
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.bytes()
    }
    fn send(&self, frame: Frame) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if !self.is_open() {
            bail!("WorkerLink socket is closed");
        }
        let bytes = framed_size(frame.bytes().len());
        queue.send(Outgoing::Binary(self.buffered.reserve(frame, bytes)))?;
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        self.close(code, reason);
    }
}
fn authorized(service: &AuthService, ctx: &Context, session: &str, query: &Value) -> Option<Value> {
    let session = super::worker_links::authorized(service, ctx, session)?;
    (query["clientInstanceId"] == session["identity"]["clientInstanceId"]
        && query
            .get("routeGeneration")
            .is_none_or(|v| v.as_str() == Some(session["routeGeneration"].stringify().as_str())))
    .then_some(session)
}
async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(session): Path<String>,
    request: Request,
) -> Response {
    let origin = middleware::value(request.headers(), "origin");
    if !origin
        .as_ref()
        .is_some_and(|origin| service.config.app_origins.contains(origin))
    {
        return error(403, "Origin not allowed.");
    }
    let query = account::query(request.uri());
    let Some(current) = super::worker_links::authorized(&service, &ctx, &session) else {
        return error(404, "WorkerLink session is unavailable.");
    };
    if query["clientInstanceId"] != current["identity"]["clientInstanceId"] {
        return error(404, "WorkerLink session is unavailable.");
    }
    if query
        .get("routeGeneration")
        .is_some_and(|v| v.as_str() != Some(current["routeGeneration"].stringify().as_str()))
    {
        return error(409, "WorkerLink route generation is stale.");
    }
    let lifetime = service.live.transports.begin();
    websocket::upgrade(
        request,
        service.config.websocket_max_payload_bytes as usize,
        move |socket, _| run(socket, service, ctx, session, query, lifetime),
    )
}
async fn run(
    mut socket: WebSocket,
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    session: String,
    query: Value,
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
    let user = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated WorkerLink client");
    let registration =
        service
            .live
            .sessions
            .register(peer.clone(), &user.id, ctx.principal.session_id.as_deref());
    let connection = if registration.is_some() {
        match authorized(&service, &ctx, &session, &query) {
            Some(session) => service.worker_links.relay.attach(session, peer.clone()),
            None => {
                peer.close(1008, "WorkerLink session is unavailable");
                None
            }
        }
    } else {
        None
    };
    let relay = service.worker_links.relay.clone();
    let retained = connection.clone();
    socket.on_closed(move || {
        if let Some(connection) = retained {
            relay.retire(&connection);
        }
        drop(registration);
        drop(lifetime);
    });
    let (mut output, mut input) = socket.split();
    let reader = async {
        while let Some(message) = input.next().await {
            match message {
                Ok(Message::Binary(bytes)) => {
                    if let Some(c) = &connection {
                        service
                            .worker_links
                            .relay
                            .receive_client(c, bytes.to_vec().into(), true);
                    }
                }
                Ok(Message::Text(text)) => {
                    if let Some(c) = &connection {
                        service
                            .worker_links
                            .relay
                            .receive_client(c, text.as_bytes().into(), false);
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
                Outgoing::Text(mut value) => output.send(Message::Text(value.take().into())).await,
                Outgoing::Binary(mut value) => {
                    output
                        .send(Message::Binary(tungstenite::Bytes::from_owner(
                            value.take(),
                        )))
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
    tokio::select! {
        _=reader=>{}, _=writer=>{},
        _=expiration=>{ forced.store(true, Ordering::Release); },
    }
    peer.open.store(false, Ordering::Release);
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/worker-links/{sessionId}/connect", get(connect))
}
