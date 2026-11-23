//! Secret-authenticated legacy tunnel WebSocket and owned initialization.
mod initialize;
mod peer;
use super::{
    middleware,
    websocket::{self, WebSocket},
};
use crate::{
    auth::service::AuthService,
    live::{Registration, Socket as _, TransportLifetime},
    tunnels::runtime::Handle,
};
use axum::{
    Router,
    extract::{Path, Request, State},
    http::{HeaderValue, Method, header},
    response::Response,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use initialize::{First, InitialFrame};
use peer::{Outgoing, Peer};
use std::sync::{Arc, Mutex, atomic::Ordering};
use tungstenite::{Message, protocol::CloseFrame};
#[derive(Default)]
struct StateData {
    closed: bool,
    handle: Option<Handle>,
    registration: Option<Registration>,
}
struct Connection {
    state: Mutex<StateData>,
    first: Arc<First>,
}
impl Connection {
    fn attach(&self, handle: Handle) {
        let closed = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                true
            } else {
                state.handle = Some(handle.clone());
                false
            }
        };
        if closed {
            handle.disconnected();
        }
    }
    fn register(&self, registration: Registration) {
        let mut state = self.state.lock().unwrap();
        if !state.closed {
            state.registration = Some(registration);
        }
    }
    fn handle(&self) -> Option<Handle> {
        self.state.lock().unwrap().handle.clone()
    }
    fn close(&self) {
        let (handle, registration) = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            (state.handle.take(), state.registration.take())
        };
        self.first
            .finish(Err(anyhow::anyhow!("Tunnel attachment disconnected.")));
        if let Some(handle) = handle {
            handle.disconnected();
        }
        drop(registration);
    }
}
async fn connect(
    State(service): State<Arc<AuthService>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if request.method() == Method::HEAD {
        // Fastify's automatic HEAD route invokes the legacy socket handler as
        // an HTTP handler and returns its normal internal-error envelope.
        let context = request
            .extensions()
            .get::<Arc<middleware::Context>>()
            .unwrap();
        let mut response = middleware::internal_error(&context.id);
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        response
            .extensions_mut()
            .insert(hyper::ext::PreserveConnectionHeader);
        return response;
    }
    let authorization = middleware::value(request.headers(), "authorization");
    let secret = authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            middleware::value(request.headers(), "sec-websocket-protocol")
                .unwrap_or_default()
                .split(',')
                .map(crate::text::trim)
                .find_map(|value| value.strip_prefix("cantrip-tunnel-v1."))
                .unwrap_or("")
                .to_owned()
        });
    let lifetime = service.live.transports.begin();
    websocket::upgrade(
        request,
        service.config.websocket_max_payload_bytes as usize,
        move |socket, _| run(socket, service, id, secret, lifetime),
    )
}
async fn run(
    mut socket: WebSocket,
    service: Arc<AuthService>,
    id: String,
    secret: String,
    lifetime: TransportLifetime,
) {
    let (send, mut outgoing) = tokio::sync::mpsc::unbounded_channel();
    let deadline = socket.close_deadline_signal();
    let mut closing = deadline.subscribe();
    let forced = socket.force_close_signal();
    let peer = Peer::new(send, deadline);
    lifetime.attach(peer.clone());
    let (first, initialized) = First::new();
    let connection = Arc::new(Connection {
        state: Mutex::new(StateData::default()),
        first,
    });
    let (retained, endpoint, attached) = (service.clone(), peer.clone(), connection.clone());
    service.worker_maintenance.spawn_child(async move {
        initialize::start(retained, endpoint, attached, secret, id, initialized).await;
        Ok(())
    });
    let attached = connection.clone();
    socket.on_closed(move || {
        attached.close();
        drop(lifetime);
    });
    let (mut output, mut input) = socket.split();
    let reader = async {
        while let Some(message) = input.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    if !connection.first.finish(Ok(InitialFrame {
                        bytes: text.as_bytes().to_vec(),
                        binary: false,
                    })) && let Some(handle) = connection.handle()
                    {
                        handle.receive(text.as_bytes(), false);
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    if !connection.first.finish(Ok(InitialFrame {
                        bytes: bytes.to_vec(),
                        binary: true,
                    })) && let Some(handle) = connection.handle()
                    {
                        handle.receive(&bytes, true);
                    }
                }
                Ok(Message::Pong(bytes)) => {
                    if let Some(handle) = connection.handle() {
                        handle.pong(&bytes);
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
                Outgoing::Binary(mut frame) => {
                    output
                        .send(Message::Binary(frame.take().bytes().to_vec().into()))
                        .await
                }
                Outgoing::Ping(mut bytes) => output.send(Message::Ping(bytes.take().into())).await,
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
                Outgoing::Terminate => {
                    forced.store(true, Ordering::Release);
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
    peer.state.store(3, Ordering::Release);
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(
        "/api/tunnel-attachments/{attachmentId}/connect",
        get(connect),
    )
}
