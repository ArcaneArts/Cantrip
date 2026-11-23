//! The legacy terminal WebSocket lives inside its authenticated CTTN stream.
use super::{Adapter, LinkTarget, LinkedTerminal, checked, client_message, exit_message};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use futures::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::{
    io::DuplexStream,
    sync::{Semaphore, mpsc, oneshot},
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};

const MAX_MESSAGE: usize = 200_000;
const HANDSHAKE: Duration = Duration::from_secs(60);
const WRITE: Duration = Duration::from_secs(10);
type Socket = WebSocketStream<DuplexStream>;

pub(in crate::worker_link) struct DirectTerminal {
    terminal: Value,
    server: Value,
    owner: Value,
    upgrade: Semaphore,
}

impl DirectTerminal {
    pub fn new(target: &Value, owner: Value) -> Self {
        Self {
            terminal: target["resourceId"].clone(),
            server: target["serverId"].clone(),
            owner,
            upgrade: Semaphore::new(1),
        }
    }

    pub fn claimed(&self) -> bool {
        self.upgrade.available_permits() == 0
    }

    async fn upgrade(&self, pipe: DuplexStream) -> Option<(Socket, JsString)> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let mut operation = None;
        let handshake = accept_hdr_async_with_config(
            pipe,
            |request: &Request, response: Response| {
                let uri = request.uri();
                let id = uri
                    .query()
                    .filter(|_| uri.path() == "/terminal")
                    .and_then(|query| {
                        url::form_urlencoded::parse(query.as_bytes())
                            .find(|(key, _)| key == "operationId")
                            .map(|(_, value)| JsString::from(value.as_ref()))
                    })
                    .filter(|id| !id.units().is_empty() && id.units().len() <= 200)
                    .ok_or_else(|| rejected(hyper::StatusCode::BAD_REQUEST))?;
                let permit = self
                    .upgrade
                    .try_acquire()
                    .map_err(|_| rejected(hyper::StatusCode::CONFLICT))?;
                operation = Some((id, permit));
                Ok(response)
            },
            Some(config),
        );
        let socket = timeout(HANDSHAKE, handshake).await.ok()?.ok()?;
        let (operation, permit) = operation.expect("terminal WebSocket operation");
        // A failed handshake drops the permit. Only a connected view spends it.
        permit.forget();
        Some((socket, operation))
    }
}

impl Adapter {
    pub fn check_direct(&self, terminal: &Value) -> Result<()> {
        ensure!(
            !self.runs.owns_terminal(terminal),
            "Run configuration terminals are read-only."
        );
        Ok(())
    }

    pub async fn serve_direct(&self, route: &DirectTerminal, pipe: DuplexStream) {
        let Some((mut socket, operation)) = route.upgrade(pipe).await else {
            return;
        };
        let (events, mut output) = mpsc::channel(256);
        let (complete, finish) = oneshot::channel();
        let attached: Result<_> = async {
            self.check_direct(&route.terminal)?;
            let target = LinkTarget::direct(
                &route.owner,
                &route.terminal,
                &route.server,
                operation,
                &self.encryption,
            )?;
            let view = self
                .shells
                .attach_link(&target, self.encryption.clone(), events, complete)
                .await?;
            Ok((target, view))
        }
        .await;
        let (target, mut view) = match attached {
            Ok((target, LinkedTerminal::Attached(view))) => (target, Some(view)),
            Ok((target, LinkedTerminal::Exited(result))) => {
                if !send(&mut socket, exit_message(result)).await {
                    return;
                }
                (target, None)
            }
            Err(error) => {
                if send(&mut socket, error_message(&error.to_string())).await {
                    write(
                        &mut socket,
                        Message::Close(Some(CloseFrame {
                            code: CloseCode::Error,
                            reason: "Terminal is unavailable".into(),
                        })),
                    )
                    .await;
                }
                return;
            }
        };
        let mut finish = Some(finish);
        loop {
            tokio::select! {
                next = output.recv(), if view.is_some() => {
                    let message = if let Some(message) = next {
                        message
                    } else {
                        view.take();
                        match finish.take().expect("one terminal completion").await {
                            Ok(Ok(result)) if result["status"] == "exited" => exit_message(result),
                            _ => error_message("Terminal disconnected."),
                        }
                    };
                    if !send(&mut socket, message).await {
                        return;
                    }
                }
                next = socket.next() => match next {
                    Some(Ok(Message::Text(text))) => {
                        let mut accepted = false;
                        if let Some(message) = client_message(text.as_str())
                            && self.check_direct(&route.terminal).is_ok()
                        {
                            accepted = self.shells.write_link(&target, &message, &self.encryption).await.is_ok();
                        }
                        if !accepted && !send(&mut socket, error_message("Invalid protected terminal message.")).await {
                            return;
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        if !send(&mut socket, error_message("Terminal messages must be text.")).await {
                            return;
                        }
                    }
                    Some(Ok(Message::Ping(_))) => {
                        if !matches!(timeout(WRITE, socket.flush()).await, Ok(Ok(()))) {
                            return;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) => {
                        let _ = timeout(WRITE, socket.flush()).await;
                        return;
                    }
                    _ => return,
                }
            }
        }
    }
}

fn rejected(status: hyper::StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = status;
    response
}

fn error_message(message: &str) -> Value {
    json!({"type":"error","message":message})
}

async fn send(socket: &mut Socket, message: Value) -> bool {
    match checked("terminalServerMessageSchema", &message) {
        Ok(message) => write(socket, Message::Text(message.stringify().into())).await,
        Err(_) => false,
    }
}

async fn write(socket: &mut Socket, message: Message) -> bool {
    matches!(timeout(WRITE, socket.send(message)).await, Ok(Ok(())))
}
