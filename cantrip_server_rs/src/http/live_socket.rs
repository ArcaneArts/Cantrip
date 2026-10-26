//! Native application-live transport. Reads, serial protocol processing and
//! FIFO writes progress independently, so database reads cannot stall close ACKs.
use super::{
    middleware::{self, Context},
    websocket::{self, WebSocket},
};
use crate::{
    auth::service::AuthService,
    live::{Frame, Socket, TransportLifetime},
};
use anyhow::{Result, bail};
use axum::{
    Extension, Router,
    extract::{Request, State},
    response::Response,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use tungstenite::{Message, protocol::CloseFrame};

enum Outgoing {
    Text(Arc<str>),
    Close(u16, String),
    Flush,
}
struct Peer {
    open: AtomicBool,
    buffered: AtomicUsize,
    queue: Mutex<mpsc::UnboundedSender<Outgoing>>,
    deadline: watch::Sender<Option<tokio::time::Instant>>,
}
impl Socket for Peer {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::Acquire)
    }
    fn send(&self, text: Arc<str>) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if !self.is_open() {
            bail!("Live socket is closed");
        }
        let bytes = text.len();
        self.buffered.fetch_add(bytes, Ordering::AcqRel);
        if queue.send(Outgoing::Text(text)).is_err() {
            self.buffered.fetch_sub(bytes, Ordering::AcqRel);
            bail!("Live socket transport stopped");
        }
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        let queue = self.queue.lock().unwrap();
        if self.open.swap(false, Ordering::AcqRel) {
            self.deadline
                .send_replace(Some(tokio::time::Instant::now() + Duration::from_secs(30)));
            // Preserve a final protocol error queued immediately before Close.
            let _ = queue.send(Outgoing::Close(code, reason.into()));
        }
    }
}
async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let origin = middleware::value(request.headers(), "origin");
    let lifetime = service.live.transports.begin();
    websocket::upgrade(
        request,
        service.config.websocket_max_payload_bytes as usize,
        move |socket, _| run(socket, service, ctx, origin, lifetime),
    )
}
async fn run(
    mut socket: WebSocket,
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    origin: Option<String>,
    lifetime: TransportLifetime,
) {
    let (sender, mut outgoing) = mpsc::unbounded_channel();
    let deadline = socket.close_deadline_signal();
    let mut closing = deadline.subscribe();
    let forced = socket.force_close_signal();
    let peer = Arc::new(Peer {
        open: AtomicBool::new(true),
        buffered: AtomicUsize::new(0),
        queue: Mutex::new(sender),
        deadline,
    });
    lifetime.attach(peer.clone());
    socket.on_closed(move || drop(lifetime));
    let mut attachment = None;
    if !origin.is_some_and(|value| service.config.app_origins.contains(&value)) {
        peer.close(1008, "Origin is not allowed");
    } else if let Some(user) = &ctx.principal.user {
        if let Some(registration) = service.live.sessions.register(
            peer.clone(),
            &user.id,
            ctx.principal.session_id.as_deref(),
        ) {
            let hub = service.live.hub.clone();
            attachment = hub.attach(
                peer.clone(),
                service
                    .live
                    .context(user.id.clone(), ctx.principal.session_id.clone()),
            );
            let identity = attachment;
            socket.on_closed(move || {
                if let Some(identity) = identity {
                    hub.disconnect(identity);
                }
                drop(registration);
            });
        }
    } else {
        peer.close(1008, "Authentication is required");
    }
    let (mut output, mut input) = socket.split();
    let (incoming, mut frames) = mpsc::unbounded_channel();
    let reader = async {
        while let Some(result) = input.next().await {
            match result {
                Ok(Message::Text(text)) => {
                    let _ = incoming.send(Frame::Text(text.to_string()));
                }
                Ok(Message::Binary(bytes)) => {
                    let _ = incoming.send(Frame::Binary(bytes.to_vec()));
                }
                Ok(Message::Ping(_)) => {
                    let _ = peer.queue.lock().unwrap().send(Outgoing::Flush);
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(error) => {
                    let code = match error {
                        tungstenite::Error::Utf8(..) => Some(1007),
                        tungstenite::Error::Capacity(..) => Some(1009),
                        tungstenite::Error::Protocol(..) => Some(1002),
                        _ => None,
                    };
                    if let Some(code) = code {
                        peer.close(code, "");
                        // The parser cannot continue. Let the writer deliver
                        // its close, then bounded raw IO cleanup drains TCP.
                        futures::future::pending::<()>().await;
                    }
                    break;
                }
            }
        }
    };
    let processing = async {
        while let Some(frame) = frames.recv().await {
            if let Some(identity) = attachment {
                service.live.hub.frame(identity, frame).await;
            }
        }
    };
    let writer = async {
        while let Some(message) = outgoing.recv().await {
            let result = match message {
                Outgoing::Text(text) => {
                    let bytes = text.len();
                    let result = output.send(Message::Text(text.to_string().into())).await;
                    peer.buffered.fetch_sub(bytes, Ordering::AcqRel);
                    result
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
        _=reader=>{},
        _=processing=>{},
        _=writer=>{},
        _=expiration=>{ forced.store(true,Ordering::Release); },
    }
    peer.open.store(false, Ordering::Release);
    // Dropping both split halves hands the original socket to its bounded
    // cleanup. Its completion callback owns the account/session registration.
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/live", get(connect))
}
