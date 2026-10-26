//! Native upgraded transport with bounded cleanup after protocol errors.
//! The reference ws server drains TCP after rejecting a frame. Dropping a
//! socket with an unread oversized payload can reset TCP and lose its close
//! frame; retain raw IO so rejection never requires allocating that payload.
use super::middleware::value;
use axum::{
    body::Body,
    extract::Request,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use futures::{Sink, SinkExt, Stream};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use std::{
    collections::HashSet,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::WebSocketStream;
use tungstenite::{
    Error, Message,
    handshake::derive_accept_key,
    protocol::{Role, WebSocketConfig},
};

type NativeSocket = WebSocketStream<TokioIo<Upgraded>>;
#[derive(Default)]
struct Completion(Option<Box<dyn FnOnce() + Send>>);
impl Drop for Completion {
    fn drop(&mut self) {
        if let Some(completed) = self.0.take() {
            completed();
        }
    }
}
pub(super) struct WebSocket {
    socket: Option<NativeSocket>,
    completed: Completion,
    force_close: Arc<AtomicBool>,
    close_deadline: tokio::sync::watch::Sender<Option<tokio::time::Instant>>,
}
impl WebSocket {
    pub async fn recv(&mut self) -> Option<Result<Message, Error>> {
        futures::StreamExt::next(self).await
    }
    pub fn on_closed(&mut self, completed: impl FnOnce() + Send + 'static) {
        let previous = std::mem::take(&mut self.completed);
        self.completed = Completion(Some(Box::new(move || {
            completed();
            drop(previous);
        })));
    }
    pub fn force_close_signal(&self) -> Arc<AtomicBool> {
        self.force_close.clone()
    }
    pub fn close_deadline_signal(
        &self,
    ) -> tokio::sync::watch::Sender<Option<tokio::time::Instant>> {
        self.close_deadline.clone()
    }
}
impl Stream for WebSocket {
    type Item = Result<Message, Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(self.socket.as_mut().unwrap()).poll_next(cx)
    }
}
impl Sink<Message> for WebSocket {
    type Error = Error;
    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Pin::new(self.socket.as_mut().unwrap()).poll_ready(cx)
    }
    fn start_send(mut self: Pin<&mut Self>, message: Message) -> Result<(), Error> {
        Pin::new(self.socket.as_mut().unwrap()).start_send(message)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Pin::new(self.socket.as_mut().unwrap()).poll_flush(cx)
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Pin::new(self.socket.as_mut().unwrap()).poll_close(cx)
    }
}
impl Drop for WebSocket {
    fn drop(&mut self) {
        let Some(socket) = self.socket.take() else {
            return;
        };
        let completed = std::mem::take(&mut self.completed);
        let deadline = self
            .close_deadline
            .borrow()
            .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(30));
        if self.force_close.load(Ordering::Acquire) {
            drop(socket);
            drop(completed);
            return;
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let mut socket = socket;
                let _ = tokio::time::timeout_at(deadline, async {
                    // Reading a client Close queues its automatic ACK even
                    // when a subsequent explicit Close cannot be written.
                    let _ = socket.flush().await;
                    let mut io = socket.into_inner();
                    // send() has flushed any close frame. Half-close writing,
                    // then discard remaining bytes without parsing/allocating.
                    let _ = io.shutdown().await;
                    let mut discard = [0; 16 * 1024];
                    while io.read(&mut discard).await.is_ok_and(|bytes| bytes > 0) {}
                })
                .await;
                drop(completed);
            });
        } else {
            drop(socket);
            drop(completed);
        }
    }
}
#[derive(Clone)]
pub(super) struct RawUpgradeResponse;
fn rejected(message: &str, version: bool) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header(header::CONNECTION, "close")
        .header(header::CONTENT_TYPE, "text/html")
        .header(header::CONTENT_LENGTH, message.len());
    if version {
        response = response.header(header::SEC_WEBSOCKET_VERSION, "13, 8");
    }
    let mut response = response.body(Body::from(message.to_owned())).unwrap();
    response.extensions_mut().insert(RawUpgradeResponse);
    response
}
pub(super) fn upgrade<F, Fut>(mut request: Request, limit: usize, callback: F) -> Response
where
    F: FnOnce(WebSocket, Option<String>) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let headers = request.headers();
    if !headers.contains_key(header::UPGRADE)
        || !value(headers, "connection").is_some_and(|s| {
            s.split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
        || request
            .extensions()
            .get::<hyper::upgrade::OnUpgrade>()
            .is_none()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !value(headers, "upgrade").is_some_and(|s| s.eq_ignore_ascii_case("websocket")) {
        return rejected("Invalid Upgrade header", false);
    }
    let key = value(headers, "sec-websocket-key").unwrap_or_default();
    if key.len() != 24
        || !key.ends_with("==")
        || !key.as_bytes()[..22]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
    {
        return rejected("Missing or invalid Sec-WebSocket-Key header", false);
    }
    let version =
        value(headers, "sec-websocket-version").map(|s| crate::wire::Value::String(s.into()));
    if !crate::wire::coercion::number(version.as_ref()).is_ok_and(|v| v == 13.0 || v == 8.0) {
        return rejected("Missing or invalid Sec-WebSocket-Version header", true);
    }
    let mut protocols = Vec::new();
    if let Some(raw) = value(headers, "sec-websocket-protocol") {
        let mut unique = HashSet::new();
        for protocol in raw.split(',').map(|s| s.trim_matches([' ', '\t'])) {
            if protocol.is_empty()
                || !protocol
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                || !unique.insert(protocol.to_owned())
            {
                return rejected("Invalid Sec-WebSocket-Protocol header", false);
            }
            protocols.push(protocol.to_owned());
        }
    }
    let worker_route = request.uri().path() == "/api/internal/workers/connect";
    let selected = worker_route
        .then(|| {
            [
                "cantrip-worker-auth-ready-v2",
                "cantrip-worker-auth-ready-v1",
            ]
            .into_iter()
            .find(|name| protocols.iter().any(|s| s == name))
            .map(String::from)
        })
        .flatten()
        .or_else(|| protocols.first().cloned());
    let on_upgrade = hyper::upgrade::on(&mut request);
    let mut response = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(
            header::SEC_WEBSOCKET_ACCEPT,
            derive_accept_key(key.as_bytes()),
        );
    if let Some(selected) = &selected {
        response = response.header(header::SEC_WEBSOCKET_PROTOCOL, selected);
    }
    tokio::spawn(async move {
        if let Ok(io) = on_upgrade.await {
            let config = WebSocketConfig::default()
                .max_message_size(Some(limit))
                .max_frame_size(Some(limit));
            let socket =
                WebSocketStream::from_raw_socket(TokioIo::new(io), Role::Server, Some(config))
                    .await;
            callback(
                WebSocket {
                    socket: Some(socket),
                    completed: Completion::default(),
                    force_close: Arc::new(AtomicBool::new(false)),
                    close_deadline: tokio::sync::watch::channel(None).0,
                },
                selected,
            )
            .await;
        }
    });
    let mut response = response.body(Body::empty()).unwrap();
    response.extensions_mut().insert(RawUpgradeResponse);
    response
}
