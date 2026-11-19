//! Serve the existing direct/v1 WebSocket handshake and admitted traffic.
use super::{Broker, Control, Coordinator, Frame, Opened, Queued, Session, checked, now};
use cantrip_framing::{tunnel, worker_link};
use cantrip_wire::{parse_json_text, value::json};
use futures::{SinkExt, StreamExt};
use std::{
    future::pending,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{mpsc, watch},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};

const INITIALIZE: Duration = Duration::from_secs(5);
const WRITE: Duration = Duration::from_secs(10);
const MAX_MESSAGE: usize = 8 + worker_link::MAX_HEADER_BYTES + worker_link::MAX_PAYLOAD_BYTES;
type Socket = WebSocketStream<TcpStream>;
type Close = (CloseCode, String);

pub(super) async fn accept(broker: Arc<Broker>, gateway: Weak<Coordinator>, stream: TcpStream) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let upgrade = accept_hdr_async_with_config(
        stream,
        |request: &Request, response: Response| {
            if request
                .uri()
                .path_and_query()
                .is_some_and(|uri| uri.as_str() == "/direct/v1")
            {
                Ok(response)
            } else {
                let mut error = ErrorResponse::new(None);
                *error.status_mut() = hyper::StatusCode::NOT_FOUND;
                Err(error)
            }
        },
        Some(config),
    );
    let Ok(Ok(mut socket)) = timeout(INITIALIZE, upgrade).await else {
        return;
    };
    let init = match timeout(INITIALIZE, initialize(&mut socket, &broker)).await {
        Ok(Ok(opened)) => opened,
        Ok(Err(reason)) => return close(&mut socket, (CloseCode::Policy, reason.into())).await,
        Err(_) => {
            return close(
                &mut socket,
                (CloseCode::Policy, "Direct initialization timed out".into()),
            )
            .await;
        }
    };
    let Opened {
        key,
        session,
        mut outgoing,
        ready,
    } = init;
    let mut control = session.control.subscribe();
    let connected = async {
        if !write(&mut socket, Message::Text(ready.stringify().into())).await {
            return None;
        }
        broker.logs.event(
            "info",
            "Direct capability connected",
            session.event("direct.capability.connected", "connect", "completed"),
        );
        serve(&mut socket, &gateway, &session, &mut outgoing).await
    };
    let ended = tokio::select! {
        biased;
        reason = wait_until_retired(&mut control) => Some((CloseCode::Policy, reason)),
        result = connected => result,
    };
    broker.release(&key, &session);
    if let Some(ended) = ended {
        close(&mut socket, ended).await;
    }
    broker.logs.event(
        "info",
        "Direct capability connection closed",
        session.event("direct.capability.disconnected", "connect", "completed"),
    );
}

async fn initialize(socket: &mut Socket, broker: &Broker) -> Result<Opened, &'static str> {
    while let Some(message) = socket.next().await {
        let request = match message {
            Ok(Message::Text(text)) => {
                parse_json_text(text.as_str()).map_err(|_| "Direct initialization is invalid")?
            }
            Ok(Message::Binary(_)) => return Err("Direct initialization must be JSON"),
            Ok(Message::Ping(_)) => {
                socket
                    .flush()
                    .await
                    .map_err(|_| "Direct initialization is invalid")?;
                continue;
            }
            Ok(Message::Pong(_)) => continue,
            _ => break,
        };
        let request = checked("directBrokerInitializeSchema", &request)
            .map_err(|_| "Direct initialization is invalid")?;
        return broker
            .initialize(&request)
            .map_err(|_| "Direct capability authentication failed");
    }
    Err("Direct initialization is invalid")
}

async fn serve(
    socket: &mut Socket,
    gateway: &Weak<Coordinator>,
    session: &Session,
    outgoing: &mut Option<mpsc::UnboundedReceiver<Queued<Frame>>>,
) -> Option<Close> {
    loop {
        tokio::select! {
            inbound = socket.next() => match inbound {
                Some(Ok(Message::Binary(bytes))) => {
                    let Some(tunnel) = &session.tunnel else {
                        return Some((CloseCode::Policy, "Direct tunnel channel is not authorized".into()));
                    };
                    let gateway = gateway.upgrade()?;
                    if tunnel::decode(bytes.as_ref().into()).and_then(|frame| tunnel.receive(&gateway, frame)).is_err() {
                        return Some((CloseCode::Unsupported, "Invalid direct tunnel frame".into()));
                    }
                }
                Some(Ok(Message::Text(_))) => return Some((CloseCode::Unsupported, "Direct data frames must be binary".into())),
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Ping(_))) => {
                    if !matches!(timeout(WRITE, socket.flush()).await, Ok(Ok(()))) {
                        return None;
                    }
                }
                Some(Ok(Message::Close(_))) => {
                    let _ = timeout(WRITE, socket.flush()).await;
                    return None;
                }
                _ => return None,
            },
            outbound = async {
                match outgoing {
                    Some(queue) => queue.recv().await,
                    None => pending().await,
                }
            } => {
                let outbound = outbound?;
                if !write(socket, Message::Binary(outbound.bytes().to_vec().into())).await {
                    return None;
                }
                drop(outbound);
                session.tunnel.as_ref().expect("direct tunnel carrier").writable();
            }
        }
    }
}

async fn wait_until_retired(control: &mut watch::Receiver<Control>) -> String {
    loop {
        let observed = control.borrow_and_update().clone();
        match observed {
            Control::Retired(reason) => return reason,
            Control::Live(lease) => {
                let remaining = lease.at - now();
                if remaining <= 0 {
                    return "Direct lease expired".into();
                }
                tokio::select! {
                    biased;
                    change = control.changed() => {
                        if change.is_err() { return "Direct connection closed".into() }
                    }
                    _ = sleep(Duration::from_millis(remaining as u64)) => {}
                }
            }
        }
    }
}

async fn write(socket: &mut Socket, frame: Message) -> bool {
    matches!(timeout(WRITE, socket.send(frame)).await, Ok(Ok(())))
}

async fn close(socket: &mut Socket, (code, reason): Close) {
    let end = reason.floor_char_boundary(reason.len().min(123));
    let frame = Message::Close(Some(CloseFrame {
        code,
        reason: reason[..end].into(),
    }));
    let _ = timeout(Duration::from_secs(1), socket.send(frame)).await;
}

impl Session {
    fn event(&self, event: &str, operation: &str, status: &str) -> cantrip_wire::Value {
        let mut context = json!({
            "event":event,"subsystem":"direct-broker","operation":operation,"status":status,
            "resourceKind":self.binding["resourceKind"],"attachmentId":self.binding["attachmentId"],
        });
        if let Some(trace) = &self.trace {
            context["diagnosticTraceId"] = trace.clone();
        }
        context
    }
}
