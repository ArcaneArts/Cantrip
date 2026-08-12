use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTunnelForwardRequest {
    pub attachment_id: String,
    pub client_id: String,
    pub connect_path: String,
    pub expires_at: String,
    pub preferred_local_port: Option<u16>,
    pub secret: String,
    pub secret_expires_at_epoch_ms: u64,
    pub server_url: String,
    pub tunnel_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelForwardSummary {
    pub attachment_id: String,
    pub expires_at: String,
    pub local_host: &'static str,
    pub local_port: u16,
    pub tunnel_id: String,
}

pub struct TunnelForwards {
    #[cfg(desktop)]
    forwards: Mutex<HashMap<String, desktop::ForwardHandle>>,
    #[cfg(mobile)]
    _unavailable: Mutex<()>,
}

impl Default for TunnelForwards {
    fn default() -> Self {
        Self {
            #[cfg(desktop)]
            forwards: Mutex::new(HashMap::new()),
            #[cfg(mobile)]
            _unavailable: Mutex::new(()),
        }
    }
}

impl TunnelForwards {
    pub fn cleanup(&self) {
        #[cfg(desktop)]
        if let Ok(mut forwards) = self.forwards.lock() {
            for (_, mut forward) in forwards.drain() {
                if let Some(stop) = forward.stop.take() {
                    let _ = stop.send(());
                }
                forward.task.abort();
            }
        }
    }
}

#[tauri::command]
pub async fn start_tunnel_forward(
    state: State<'_, TunnelForwards>,
    request: StartTunnelForwardRequest,
) -> Result<TunnelForwardSummary, String> {
    #[cfg(desktop)]
    return desktop::start(&state, request).await;
    #[cfg(mobile)]
    {
        let _ = (state, request);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn stop_tunnel_forward(
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
) -> Result<bool, String> {
    #[cfg(desktop)]
    return desktop::stop(&state, &tunnel_id);
    #[cfg(mobile)]
    {
        let _ = (state, tunnel_id);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn list_tunnel_forwards(
    state: State<'_, TunnelForwards>,
) -> Result<Vec<TunnelForwardSummary>, String> {
    #[cfg(desktop)]
    return desktop::list(&state);
    #[cfg(mobile)]
    {
        let _ = state;
        Ok(Vec::new())
    }
}

#[cfg(desktop)]
mod desktop {
    use super::{StartTunnelForwardRequest, TunnelForwardSummary, TunnelForwards};
    use futures_util::{SinkExt, StreamExt};
    use serde::{Deserialize, Serialize};
    use std::cmp::min;
    use std::collections::HashMap;
    use std::convert::TryFrom;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::async_runtime::JoinHandle as TauriJoinHandle;
    use tauri::State;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot};
    use tokio::task::JoinHandle;
    use tokio::time::{interval, sleep, timeout};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue};
    use tokio_tungstenite::tungstenite::Message;
    use url::Url;
    use uuid::Uuid;
    use zeroize::Zeroizing;

    const MAGIC: [u8; 4] = [0x43, 0x54, 0x54, 0x4e];
    const MAX_HEADER_BYTES: usize = 8 * 1024;
    const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
    const INITIAL_CREDIT_BYTES: u64 = 1024 * 1024;
    const MAX_CREDIT_BYTES: u64 = 8 * 1024 * 1024;
    const OUTBOUND_QUEUE: usize = 256;
    const CONNECTION_QUEUE: usize = 64;

    pub struct ForwardHandle {
        pub stop: Option<oneshot::Sender<()>>,
        summary: TunnelForwardSummary,
        pub task: TauriJoinHandle<()>,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FrameBase {
        protocol_version: u8,
        tunnel_id: String,
        attachment_id: String,
        source_endpoint_id: String,
        destination_endpoint_id: String,
        connection_id: String,
        sequence: u64,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    enum Direction {
        #[serde(rename = "source-to-destination")]
        SourceToDestination,
        #[serde(rename = "destination-to-source")]
        DestinationToSource,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(tag = "kind")]
    enum FrameHeader {
        #[serde(rename = "open")]
        Open {
            #[serde(flatten)]
            base: FrameBase,
            #[serde(rename = "initialCreditBytes")]
            initial_credit_bytes: u64,
        },
        #[serde(rename = "connect")]
        Connect {
            #[serde(flatten)]
            base: FrameBase,
            target: serde_json::Value,
            #[serde(rename = "initialCreditBytes")]
            initial_credit_bytes: u64,
        },
        #[serde(rename = "accepted")]
        Accepted {
            #[serde(flatten)]
            base: FrameBase,
            #[serde(rename = "initialCreditBytes")]
            initial_credit_bytes: u64,
        },
        #[serde(rename = "rejected")]
        Rejected {
            #[serde(flatten)]
            base: FrameBase,
            code: String,
            message: String,
        },
        #[serde(rename = "data")]
        Data {
            #[serde(flatten)]
            base: FrameBase,
            direction: Direction,
        },
        #[serde(rename = "credit")]
        Credit {
            #[serde(flatten)]
            base: FrameBase,
            direction: Direction,
            bytes: u64,
        },
        #[serde(rename = "half-close")]
        HalfClose {
            #[serde(flatten)]
            base: FrameBase,
            direction: Direction,
        },
        #[serde(rename = "close")]
        Close {
            #[serde(flatten)]
            base: FrameBase,
            code: String,
            message: Option<String>,
        },
        #[serde(rename = "error")]
        Error {
            #[serde(flatten)]
            base: FrameBase,
            code: String,
            message: String,
        },
    }

    impl FrameHeader {
        fn base(&self) -> &FrameBase {
            match self {
                Self::Open { base, .. }
                | Self::Connect { base, .. }
                | Self::Accepted { base, .. }
                | Self::Rejected { base, .. }
                | Self::Data { base, .. }
                | Self::Credit { base, .. }
                | Self::HalfClose { base, .. }
                | Self::Close { base, .. }
                | Self::Error { base, .. } => base,
            }
        }
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Ready {
        r#type: String,
        attachment_id: String,
        tunnel_id: String,
        source_endpoint_id: String,
        destination_endpoint_id: String,
        expires_at: String,
    }

    #[derive(Clone)]
    struct RouteIdentity {
        attachment_id: String,
        destination_endpoint_id: String,
        source_endpoint_id: String,
        tunnel_id: String,
    }

    impl RouteIdentity {
        fn base(&self, connection_id: &str, sequence: u64) -> FrameBase {
            FrameBase {
                protocol_version: 1,
                tunnel_id: self.tunnel_id.clone(),
                attachment_id: self.attachment_id.clone(),
                source_endpoint_id: self.source_endpoint_id.clone(),
                destination_endpoint_id: self.destination_endpoint_id.clone(),
                connection_id: connection_id.into(),
                sequence,
            }
        }
    }

    type OutboundFrame = (FrameHeader, Vec<u8>);
    type InboundFrame = (FrameHeader, Vec<u8>);

    pub async fn start(
        state: &State<'_, TunnelForwards>,
        request: StartTunnelForwardRequest,
    ) -> Result<TunnelForwardSummary, String> {
        validate_identifiers(&request)?;
        let web_socket_url = web_socket_url(&request.server_url, &request.connect_path)?;
        stop(state, &request.tunnel_id)?;
        let listener = bind_listener(request.preferred_local_port).await?;
        let local_port = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the local tunnel listener: {error}"))?
            .port();
        let summary = TunnelForwardSummary {
            attachment_id: request.attachment_id.clone(),
            expires_at: request.expires_at.clone(),
            local_host: "127.0.0.1",
            local_port,
            tunnel_id: request.tunnel_id.clone(),
        };
        let tunnel_id = request.tunnel_id.clone();
        let (stop_sender, stop_receiver) = oneshot::channel();
        let (ready_sender, ready_receiver) = oneshot::channel();
        let task = tauri::async_runtime::spawn(run_forward(
            listener,
            local_port,
            request,
            web_socket_url,
            stop_receiver,
            ready_sender,
        ));
        match timeout(Duration::from_secs(15), ready_receiver).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => {
                task.abort();
                return Err(error);
            }
            Ok(Err(_)) => {
                task.abort();
                return Err("The local tunnel stopped during startup.".into());
            }
            Err(_) => {
                task.abort();
                return Err("The local tunnel did not become ready in time.".into());
            }
        }
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        forwards.insert(
            tunnel_id,
            ForwardHandle {
                stop: Some(stop_sender),
                summary: summary.clone(),
                task,
            },
        );
        Ok(summary)
    }

    pub fn stop(state: &State<'_, TunnelForwards>, tunnel_id: &str) -> Result<bool, String> {
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        let Some(mut forward) = forwards.remove(tunnel_id) else {
            return Ok(false);
        };
        if let Some(stop) = forward.stop.take() {
            let _ = stop.send(());
        }
        forward.task.abort();
        Ok(true)
    }

    pub fn list(state: &State<'_, TunnelForwards>) -> Result<Vec<TunnelForwardSummary>, String> {
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        forwards.retain(|_, forward| !forward.task.inner().is_finished());
        let mut summaries = forwards
            .values()
            .map(|forward| forward.summary.clone())
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| left.tunnel_id.cmp(&right.tunnel_id));
        Ok(summaries)
    }

    fn validate_identifiers(request: &StartTunnelForwardRequest) -> Result<(), String> {
        for (label, value) in [
            ("tunnel", request.tunnel_id.as_str()),
            ("attachment", request.attachment_id.as_str()),
            ("client", request.client_id.as_str()),
        ] {
            if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
                return Err(format!("The {label} identity is invalid."));
            }
        }
        if request.secret.len() < 32 || request.secret.len() > 512 {
            return Err("The tunnel attachment credential is invalid.".into());
        }
        Ok(())
    }

    fn web_socket_url(server_url: &str, connect_path: &str) -> Result<Url, String> {
        let mut url = Url::parse(server_url)
            .map_err(|_| "The active Cantrip Server URL is invalid.".to_string())?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("The active Cantrip Server URL cannot be used for a tunnel.".into());
        }
        if !connect_path.starts_with('/')
            || connect_path.contains('?')
            || connect_path.contains('#')
            || !connect_path.starts_with("/api/tunnel-attachments/")
            || !connect_path.ends_with("/connect")
        {
            return Err("The tunnel attachment path is invalid.".into());
        }
        url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
            .map_err(|_| "The tunnel WebSocket scheme is invalid.".to_string())?;
        url.set_path(connect_path);
        Ok(url)
    }

    async fn bind_listener(preferred_port: Option<u16>) -> Result<TcpListener, String> {
        let port = preferred_port.unwrap_or(0);
        TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
            .await
            .map_err(|error| {
                if preferred_port.is_some() {
                    format!("Local port {port} is unavailable: {error}")
                } else {
                    format!("Could not allocate a local tunnel port: {error}")
                }
            })
    }

    fn unix_epoch_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    async fn run_forward(
        listener: TcpListener,
        local_port: u16,
        mut request: StartTunnelForwardRequest,
        web_socket_url: Url,
        mut stop: oneshot::Receiver<()>,
        ready: oneshot::Sender<Result<(), String>>,
    ) {
        let secret = Zeroizing::new(std::mem::take(&mut request.secret));
        let mut ready = Some(ready);
        let mut retry_delay = Duration::from_millis(250);
        loop {
            if unix_epoch_ms() >= request.secret_expires_at_epoch_ms {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Err("The tunnel attachment credential expired.".into()));
                }
                return;
            }
            let connected =
                connect_attachment(&web_socket_url, &secret, &request, local_port).await;
            let (web_socket, identity) = match connected {
                Ok(connected) => connected,
                Err(error) => {
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Err(error));
                        return;
                    }
                    tokio::select! {
                        _ = &mut stop => return,
                        _ = sleep(retry_delay) => {}
                    }
                    retry_delay = min(retry_delay * 2, Duration::from_secs(5));
                    continue;
                }
            };
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok(()));
            }
            retry_delay = Duration::from_millis(250);
            match run_session(&listener, web_socket, identity, &mut stop).await {
                Ok(true) => return,
                Ok(false) | Err(_) => {}
            }
        }
    }

    async fn connect_attachment(
        url: &Url,
        secret: &str,
        request: &StartTunnelForwardRequest,
        local_port: u16,
    ) -> Result<
        (
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
            RouteIdentity,
        ),
        String,
    > {
        let mut web_socket_request = url
            .as_str()
            .into_client_request()
            .map_err(|_| "Could not create the tunnel WebSocket request.".to_string())?;
        let authorization = Zeroizing::new(format!("Bearer {secret}"));
        web_socket_request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&authorization)
                .map_err(|_| "The tunnel attachment credential is invalid.".to_string())?,
        );
        let (mut web_socket, _) =
            timeout(Duration::from_secs(10), connect_async(web_socket_request))
                .await
                .map_err(|_| "Connecting the tunnel attachment timed out.".to_string())?
                .map_err(|_| "Could not connect the tunnel attachment.".to_string())?;
        let initialize = serde_json::json!({
            "type": "initialize",
            "clientId": request.client_id,
            "localHost": "127.0.0.1",
            "localPort": local_port,
        });
        web_socket
            .send(Message::Text(initialize.to_string().into()))
            .await
            .map_err(|_| "Could not initialize the tunnel attachment.".to_string())?;
        let message = timeout(Duration::from_secs(10), web_socket.next())
            .await
            .map_err(|_| "The tunnel attachment handshake timed out.".to_string())?
            .ok_or_else(|| "The tunnel attachment closed during handshake.".to_string())?
            .map_err(|_| "The tunnel attachment handshake failed.".to_string())?;
        let Message::Text(text) = message else {
            return Err("The tunnel attachment returned an invalid handshake.".into());
        };
        let ready: Ready = serde_json::from_str(&text)
            .map_err(|_| "The tunnel attachment returned an invalid handshake.".to_string())?;
        if ready.r#type != "ready"
            || ready.attachment_id != request.attachment_id
            || ready.tunnel_id != request.tunnel_id
        {
            return Err("The tunnel attachment handshake identity did not match.".into());
        }
        let _ = ready.expires_at;
        Ok((
            web_socket,
            RouteIdentity {
                attachment_id: ready.attachment_id,
                destination_endpoint_id: ready.destination_endpoint_id,
                source_endpoint_id: ready.source_endpoint_id,
                tunnel_id: ready.tunnel_id,
            },
        ))
    }

    async fn run_session(
        listener: &TcpListener,
        mut web_socket: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<TcpStream>,
        >,
        identity: RouteIdentity,
        stop: &mut oneshot::Receiver<()>,
    ) -> Result<bool, String> {
        let (outbound_sender, mut outbound_receiver) =
            mpsc::channel::<OutboundFrame>(OUTBOUND_QUEUE);
        let (completed_sender, mut completed_receiver) = mpsc::channel::<String>(256);
        let mut connections: HashMap<String, (mpsc::Sender<InboundFrame>, JoinHandle<()>)> =
            HashMap::new();
        let mut heartbeat = interval(Duration::from_secs(20));
        let result = loop {
            tokio::select! {
                _ = &mut *stop => break Ok(true),
                accepted = listener.accept() => {
                    let (stream, _) = accepted.map_err(|error| format!("The local tunnel listener failed: {error}"))?;
                    let connection_id = Uuid::new_v4().to_string();
                    let (sender, receiver) = mpsc::channel(CONNECTION_QUEUE);
                    let task = tokio::spawn(run_connection(
                        stream,
                        identity.clone(),
                        connection_id.clone(),
                        outbound_sender.clone(),
                        receiver,
                        completed_sender.clone(),
                    ));
                    connections.insert(connection_id, (sender, task));
                }
                outbound = outbound_receiver.recv() => {
                    let Some((header, payload)) = outbound else { break Ok(false) };
                    let frame = encode_frame(&header, &payload)?;
                    web_socket.send(Message::Binary(frame.into())).await
                        .map_err(|_| "The tunnel WebSocket disconnected.".to_string())?;
                }
                incoming = web_socket.next() => {
                    let Some(incoming) = incoming else { break Ok(false) };
                    match incoming.map_err(|_| "The tunnel WebSocket disconnected.".to_string())? {
                        Message::Binary(frame) => {
                            let (header, payload) = decode_frame(&frame)?;
                            let connection_id = header.base().connection_id.clone();
                            if let Some((sender, _)) = connections.get(&connection_id) {
                                sender.try_send((header, payload)).map_err(|_| "A local tunnel connection became congested.".to_string())?;
                            }
                        }
                        Message::Ping(payload) => {
                            web_socket.send(Message::Pong(payload)).await.map_err(|_| "The tunnel WebSocket disconnected.".to_string())?;
                        }
                        Message::Close(_) => break Ok(false),
                        Message::Text(_) | Message::Pong(_) | Message::Frame(_) => {}
                    }
                }
                completed = completed_receiver.recv() => {
                    if let Some(connection_id) = completed {
                        connections.remove(&connection_id);
                    }
                }
                _ = heartbeat.tick() => {
                    web_socket.send(Message::Ping(Vec::new().into())).await
                        .map_err(|_| "The tunnel WebSocket disconnected.".to_string())?;
                }
            }
        };
        for (_, (_, task)) in connections.drain() {
            task.abort();
        }
        result
    }

    enum ConnectionEvent {
        Local(std::io::Result<usize>),
        Remote(Option<InboundFrame>),
    }

    async fn run_connection(
        stream: TcpStream,
        identity: RouteIdentity,
        connection_id: String,
        outbound: mpsc::Sender<OutboundFrame>,
        mut inbound: mpsc::Receiver<InboundFrame>,
        completed: mpsc::Sender<String>,
    ) {
        let (mut reader, mut writer) = stream.into_split();
        let mut source_sequence = 1_u64;
        let mut destination_sequence = 0_u64;
        let mut source_credit = 0_u64;
        let mut local_eof = false;
        let mut buffer = vec![0_u8; MAX_PAYLOAD_BYTES];
        if outbound
            .try_send((
                FrameHeader::Open {
                    base: identity.base(&connection_id, 0),
                    initial_credit_bytes: INITIAL_CREDIT_BYTES,
                },
                Vec::new(),
            ))
            .is_err()
        {
            let _ = completed.try_send(connection_id);
            return;
        }
        loop {
            let event = if !local_eof && source_credit > 0 {
                let read_size = min(
                    MAX_PAYLOAD_BYTES,
                    usize::try_from(source_credit).unwrap_or(MAX_PAYLOAD_BYTES),
                );
                tokio::select! {
                    read = reader.read(&mut buffer[..read_size]) => ConnectionEvent::Local(read),
                    remote = inbound.recv() => ConnectionEvent::Remote(remote),
                }
            } else {
                ConnectionEvent::Remote(inbound.recv().await)
            };
            match event {
                ConnectionEvent::Local(Ok(0)) => {
                    local_eof = true;
                    if send_source(
                        &outbound,
                        FrameHeader::HalfClose {
                            base: identity.base(&connection_id, source_sequence),
                            direction: Direction::SourceToDestination,
                        },
                        Vec::new(),
                    )
                    .is_err()
                    {
                        break;
                    }
                    source_sequence += 1;
                }
                ConnectionEvent::Local(Ok(size)) => {
                    source_credit = source_credit.saturating_sub(size as u64);
                    if send_source(
                        &outbound,
                        FrameHeader::Data {
                            base: identity.base(&connection_id, source_sequence),
                            direction: Direction::SourceToDestination,
                        },
                        buffer[..size].to_vec(),
                    )
                    .is_err()
                    {
                        break;
                    }
                    source_sequence += 1;
                }
                ConnectionEvent::Local(Err(_)) | ConnectionEvent::Remote(None) => break,
                ConnectionEvent::Remote(Some((header, payload))) => {
                    let base = header.base();
                    if base.sequence != destination_sequence
                        || base.tunnel_id != identity.tunnel_id
                        || base.attachment_id != identity.attachment_id
                        || base.source_endpoint_id != identity.source_endpoint_id
                        || base.destination_endpoint_id != identity.destination_endpoint_id
                        || base.connection_id != connection_id
                    {
                        break;
                    }
                    destination_sequence += 1;
                    match header {
                        FrameHeader::Accepted {
                            initial_credit_bytes,
                            ..
                        } if payload.is_empty() => {
                            source_credit = min(initial_credit_bytes, MAX_CREDIT_BYTES);
                        }
                        FrameHeader::Data {
                            direction: Direction::DestinationToSource,
                            ..
                        } if !payload.is_empty() => {
                            if writer.write_all(&payload).await.is_err() {
                                break;
                            }
                            if send_source(
                                &outbound,
                                FrameHeader::Credit {
                                    base: identity.base(&connection_id, source_sequence),
                                    direction: Direction::DestinationToSource,
                                    bytes: payload.len() as u64,
                                },
                                Vec::new(),
                            )
                            .is_err()
                            {
                                break;
                            }
                            source_sequence += 1;
                        }
                        FrameHeader::Credit {
                            direction: Direction::SourceToDestination,
                            bytes,
                            ..
                        } if payload.is_empty() => {
                            source_credit =
                                min(MAX_CREDIT_BYTES, source_credit.saturating_add(bytes));
                        }
                        FrameHeader::HalfClose {
                            direction: Direction::DestinationToSource,
                            ..
                        } if payload.is_empty() => {
                            let _ = writer.shutdown().await;
                        }
                        FrameHeader::Rejected { .. }
                        | FrameHeader::Close { .. }
                        | FrameHeader::Error { .. } => break,
                        _ => break,
                    }
                }
            }
        }
        let _ = outbound.try_send((
            FrameHeader::Close {
                base: identity.base(&connection_id, source_sequence),
                code: "normal".into(),
                message: None,
            },
            Vec::new(),
        ));
        let _ = completed.try_send(connection_id);
    }

    fn send_source(
        outbound: &mpsc::Sender<OutboundFrame>,
        header: FrameHeader,
        payload: Vec<u8>,
    ) -> Result<(), ()> {
        outbound.try_send((header, payload)).map_err(|_| ())
    }

    fn encode_frame(header: &FrameHeader, payload: &[u8]) -> Result<Vec<u8>, String> {
        if payload.len() > MAX_PAYLOAD_BYTES
            || (matches!(header, FrameHeader::Data { .. }) != !payload.is_empty())
        {
            return Err("A tunnel frame payload is invalid.".into());
        }
        let encoded_header = serde_json::to_vec(header)
            .map_err(|_| "Could not encode a tunnel frame.".to_string())?;
        if encoded_header.is_empty() || encoded_header.len() > MAX_HEADER_BYTES {
            return Err("A tunnel frame header is invalid.".into());
        }
        let mut frame = Vec::with_capacity(8 + encoded_header.len() + payload.len());
        frame.extend_from_slice(&MAGIC);
        frame.extend_from_slice(&(encoded_header.len() as u32).to_be_bytes());
        frame.extend_from_slice(&encoded_header);
        frame.extend_from_slice(payload);
        Ok(frame)
    }

    fn decode_frame(frame: &[u8]) -> Result<(FrameHeader, Vec<u8>), String> {
        if frame.len() < 8 || frame[..4] != MAGIC {
            return Err("The tunnel frame magic is invalid.".into());
        }
        let header_length = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
        if header_length == 0 || header_length > MAX_HEADER_BYTES || 8 + header_length > frame.len()
        {
            return Err("The tunnel frame header is invalid.".into());
        }
        let header: FrameHeader = serde_json::from_slice(&frame[8..8 + header_length])
            .map_err(|_| "The tunnel frame header is invalid.".to_string())?;
        let payload = frame[8 + header_length..].to_vec();
        if payload.len() > MAX_PAYLOAD_BYTES
            || (matches!(header, FrameHeader::Data { .. }) != !payload.is_empty())
        {
            return Err("The tunnel frame payload is invalid.".into());
        }
        Ok((header, payload))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio_tungstenite::accept_hdr_async;

        #[test]
        fn rejects_credentialed_or_non_http_server_urls() {
            assert!(
                web_socket_url("ftp://example.test", "/api/tunnel-attachments/a/connect").is_err()
            );
            assert!(web_socket_url(
                "https://user@example.test",
                "/api/tunnel-attachments/a/connect"
            )
            .is_err());
            assert!(web_socket_url(
                "https://example.test?secret=x",
                "/api/tunnel-attachments/a/connect"
            )
            .is_err());
        }

        #[test]
        fn tunnel_frames_round_trip_binary_payloads() {
            let identity = RouteIdentity {
                attachment_id: "attachment".into(),
                destination_endpoint_id: "worker:one".into(),
                source_endpoint_id: "desktop:one:attachment".into(),
                tunnel_id: "tunnel".into(),
            };
            let header = FrameHeader::Data {
                base: identity.base("connection", 4),
                direction: Direction::SourceToDestination,
            };
            let encoded = encode_frame(&header, &[0, 1, 2, 255]).unwrap();
            let (decoded, payload) = decode_frame(&encoded).unwrap();
            assert_eq!(decoded.base().sequence, 4);
            assert_eq!(payload, vec![0, 1, 2, 255]);
        }

        #[tokio::test]
        async fn preferred_port_conflicts_do_not_fall_back() {
            let listener = bind_listener(None).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            assert!(bind_listener(Some(port)).await.is_err());
        }

        #[tokio::test]
        async fn relays_local_http_bytes_over_an_authenticated_web_socket() {
            let secret = "test-secret-that-is-long-enough-for-attachment-auth";
            let authenticated = Arc::new(AtomicBool::new(false));
            let authenticated_by_server = authenticated.clone();
            let server_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let server_port = server_listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = server_listener.accept().await.unwrap();
                let mut web_socket = accept_hdr_async(
                    stream,
                    |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                     response| {
                        authenticated_by_server.store(
                            request
                                .headers()
                                .get(AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                == Some(&format!("Bearer {secret}")),
                            Ordering::SeqCst,
                        );
                        Ok(response)
                    },
                )
                .await
                .unwrap();
                let initialize = web_socket.next().await.unwrap().unwrap();
                assert!(matches!(initialize, Message::Text(_)));
                web_socket
                    .send(Message::Text(
                        serde_json::json!({
                            "type": "ready",
                            "attachmentId": "attachment",
                            "tunnelId": "tunnel",
                            "sourceEndpointId": "desktop:client:attachment",
                            "destinationEndpointId": "worker:worker-b",
                            "expiresAt": "2099-01-01T00:00:00.000Z"
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .unwrap();

                let open = web_socket.next().await.unwrap().unwrap();
                let Message::Binary(open) = open else {
                    panic!("expected an open frame")
                };
                let (header, _) = decode_frame(&open).unwrap();
                let FrameHeader::Open { base, .. } = header else {
                    panic!("expected an open frame")
                };
                web_socket
                    .send(Message::Binary(
                        encode_frame(
                            &FrameHeader::Accepted {
                                base: FrameBase {
                                    sequence: 0,
                                    ..base.clone()
                                },
                                initial_credit_bytes: INITIAL_CREDIT_BYTES,
                            },
                            &[],
                        )
                        .unwrap()
                        .into(),
                    ))
                    .await
                    .unwrap();

                let data = web_socket.next().await.unwrap().unwrap();
                let Message::Binary(data) = data else {
                    panic!("expected a data frame")
                };
                let (header, payload) = decode_frame(&data).unwrap();
                assert!(matches!(header, FrameHeader::Data { .. }));
                web_socket
                    .send(Message::Binary(
                        encode_frame(
                            &FrameHeader::Data {
                                base: FrameBase {
                                    sequence: 1,
                                    ..base.clone()
                                },
                                direction: Direction::DestinationToSource,
                            },
                            &payload,
                        )
                        .unwrap()
                        .into(),
                    ))
                    .await
                    .unwrap();

                loop {
                    let message = web_socket.next().await.unwrap().unwrap();
                    let Message::Binary(frame) = message else {
                        continue;
                    };
                    let (header, _) = decode_frame(&frame).unwrap();
                    if matches!(header, FrameHeader::HalfClose { .. }) {
                        web_socket
                            .send(Message::Binary(
                                encode_frame(
                                    &FrameHeader::HalfClose {
                                        base: FrameBase {
                                            sequence: 2,
                                            ..base.clone()
                                        },
                                        direction: Direction::DestinationToSource,
                                    },
                                    &[],
                                )
                                .unwrap()
                                .into(),
                            ))
                            .await
                            .unwrap();
                        break;
                    }
                }
            });

            let listener = bind_listener(None).await.unwrap();
            let local_port = listener.local_addr().unwrap().port();
            let request = StartTunnelForwardRequest {
                attachment_id: "attachment".into(),
                client_id: "client".into(),
                connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                preferred_local_port: None,
                secret: secret.into(),
                secret_expires_at_epoch_ms: u64::MAX,
                server_url: format!("http://127.0.0.1:{server_port}"),
                tunnel_id: "tunnel".into(),
            };
            let url = web_socket_url(&request.server_url, &request.connect_path).unwrap();
            let (web_socket, identity) = connect_attachment(&url, secret, &request, local_port)
                .await
                .unwrap();
            let (stop_sender, mut stop_receiver) = oneshot::channel();
            let session = tokio::spawn(async move {
                run_session(&listener, web_socket, identity, &mut stop_receiver).await
            });

            let mut local = TcpStream::connect((Ipv4Addr::LOCALHOST, local_port))
                .await
                .unwrap();
            let request_bytes = b"GET /hmr HTTP/1.1\r\nHost: localhost\r\n\r\n";
            local.write_all(request_bytes).await.unwrap();
            local.shutdown().await.unwrap();
            let mut echoed = Vec::new();
            timeout(Duration::from_secs(5), local.read_to_end(&mut echoed))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(echoed, request_bytes);
            assert!(authenticated.load(Ordering::SeqCst));

            let _ = stop_sender.send(());
            let _ = session.await.unwrap();
            server.await.unwrap();
        }
    }
}
