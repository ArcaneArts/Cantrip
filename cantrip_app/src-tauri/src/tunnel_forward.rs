use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, State};

use crate::direct_probe::{DirectBrokerAdvertisement, DirectCapabilityBinding};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectTunnelRequest {
    pub broker: DirectBrokerAdvertisement,
    pub binding: DirectCapabilityBinding,
    pub secret: String,
    pub route: DirectTunnelRoute,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectTunnelRoute {
    pub tunnel_id: String,
    pub attachment_id: String,
    pub source_endpoint_id: String,
    pub destination_endpoint_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTunnelForwardRequest {
    pub attachment_id: String,
    pub client_id: String,
    pub data_protection: Option<TunnelDataProtectionRequest>,
    pub diagnostic_trace_id: Option<String>,
    pub direct: Option<DirectTunnelRequest>,
    pub expires_at: String,
    pub preferred_local_port: Option<u16>,
    pub relay: Option<RelayTunnelRequest>,
    pub tunnel_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDataProtectionRequest {
    pub format_version: u8,
    pub algorithm: String,
    pub key_revision: u64,
    pub key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTunnelRequest {
    pub connect_path: String,
    pub secret: String,
    pub secret_expires_at_epoch_ms: u64,
    pub server_url: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelRelayRefreshOutcome {
    Accepted,
    Stale,
    ForwardUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRelayRefreshResult {
    pub outcome: TunnelRelayRefreshOutcome,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelForwardSummary {
    pub attachment_id: String,
    pub diagnostic_trace_id: Option<String>,
    pub expires_at: String,
    pub local_host: &'static str,
    pub local_port: u16,
    pub route_state: &'static str,
    pub relay_fallback_available: bool,
    pub relay_credential_expires_at_epoch_ms: Option<u64>,
    pub direct_capability_id: Option<String>,
    pub direct_fallback_reason: Option<String>,
    pub last_destination_rejection_code: Option<String>,
    pub tunnel_id: String,
    pub bytes_from_local: u64,
    pub bytes_to_local: u64,
    pub connections_closed: u64,
    pub connections_opened: u64,
    pub destination_rejected_count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelForwardTerminalSnapshot {
    pub attachment_id: String,
    pub tunnel_id: String,
    pub direct_capability_id: Option<String>,
    pub bytes_from_local: u64,
    pub bytes_to_local: u64,
    pub connections_closed: u64,
    pub connections_opened: u64,
    pub destination_accepted_count: u64,
    pub destination_rejected_count: u64,
    pub last_destination_rejection_code: Option<String>,
    pub open_queued_count: u64,
    pub open_sent_count: u64,
    pub route_disconnect_count: u64,
    pub route_fallback_count: u64,
    pub route_selection_count: u64,
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
    pub fn cleanup(&self, app: &AppHandle) {
        #[cfg(desktop)]
        if let Ok(mut forwards) = self.forwards.lock() {
            for (_, mut forward) in forwards.drain() {
                desktop::abort_forward(&mut forward);
                desktop::log_forward_stopping(app, &forward, "runtime-shutdown");
            }
        }
    }
}

#[tauri::command]
pub async fn start_tunnel_forward(
    app: AppHandle,
    state: State<'_, TunnelForwards>,
    request: StartTunnelForwardRequest,
) -> Result<TunnelForwardSummary, String> {
    #[cfg(desktop)]
    return desktop::start(&app, &state, request).await;
    #[cfg(mobile)]
    {
        let _ = (app, state, request);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn stop_tunnel_forward(
    app: AppHandle,
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
) -> Result<Option<TunnelForwardTerminalSnapshot>, String> {
    #[cfg(desktop)]
    return desktop::stop(&app, &state, &tunnel_id, "requested").await;
    #[cfg(mobile)]
    {
        let _ = (app, state, tunnel_id);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn force_tunnel_forward_relay(
    app: AppHandle,
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
) -> Result<Option<TunnelForwardSummary>, String> {
    #[cfg(desktop)]
    return desktop::force_relay(&app, &state, &tunnel_id).await;
    #[cfg(mobile)]
    {
        let _ = (app, state, tunnel_id);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn confirm_tunnel_forward_direct_retired(
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
    direct_capability_id: String,
) -> Result<bool, String> {
    #[cfg(desktop)]
    return desktop::confirm_direct_retired(&state, &tunnel_id, &direct_capability_id);
    #[cfg(mobile)]
    {
        let _ = (state, tunnel_id, direct_capability_id);
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

#[tauri::command]
pub fn refresh_tunnel_forward_relay(
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
    expires_at: String,
    relay: RelayTunnelRequest,
) -> Result<TunnelRelayRefreshResult, String> {
    #[cfg(desktop)]
    return desktop::refresh_relay(&state, &tunnel_id, expires_at, relay);
    #[cfg(mobile)]
    {
        let _ = (state, tunnel_id, expires_at, relay);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[cfg(desktop)]
mod desktop {
    use super::{
        RelayTunnelRequest, StartTunnelForwardRequest, TunnelDataProtectionRequest,
        TunnelForwardSummary, TunnelForwardTerminalSnapshot, TunnelForwards,
        TunnelRelayRefreshOutcome, TunnelRelayRefreshResult,
    };
    use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use std::cmp::min;
    use std::collections::HashMap;
    use std::convert::TryFrom;
    use std::future::Future;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::async_runtime::JoinHandle as TauriJoinHandle;
    use tauri::{AppHandle, Manager, State};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot, watch, Notify};
    use tokio::task::{AbortHandle, JoinHandle};
    use tokio::time::{interval, sleep, timeout, Instant};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue};
    use tokio_tungstenite::tungstenite::Message;
    use url::Url;
    use uuid::Uuid;
    use zeroize::Zeroizing;

    use crate::direct_probe::{connect_verified, DirectProbeRequest};
    use crate::local_logs::LocalServiceLogs;

    const MAGIC: [u8; 4] = [0x43, 0x54, 0x54, 0x4e];
    const MAX_HEADER_BYTES: usize = 8 * 1024;
    const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
    const AUTH_TAG_BYTES: usize = 16;
    const MAX_PAYLOAD_BYTES: usize = MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES;
    const INITIAL_CREDIT_BYTES: u64 = 1024 * 1024;
    const MAX_CREDIT_BYTES: u64 = 8 * 1024 * 1024;
    const OUTBOUND_QUEUE: usize = 256;
    const CONNECTION_QUEUE: usize = 64;
    const RELAY_FALLBACK_TIMEOUT: Duration = Duration::from_secs(5);

    pub struct ForwardHandle {
        counters: Arc<ForwardCounters>,
        relay_refresh: watch::Sender<Option<Arc<RelayRoute>>>,
        route_control: mpsc::Sender<RouteControl>,
        pub stop: Option<oneshot::Sender<()>>,
        summary: TunnelForwardSummary,
        pub task: TauriJoinHandle<()>,
    }

    #[derive(Default)]
    struct ForwardCounters {
        bytes_from_local: AtomicU64,
        bytes_to_local: AtomicU64,
        connections_closed: AtomicU64,
        connections_opened: AtomicU64,
        destination_accepted: AtomicU64,
        destination_rejected: AtomicU64,
        last_destination_rejection_code: Mutex<Option<String>>,
        opens_queued: AtomicU64,
        opens_sent: AtomicU64,
        route_disconnects: AtomicU64,
        route_fallbacks: AtomicU64,
        route_selections: AtomicU64,
        route_state: AtomicU8,
        fallback_requested: AtomicBool,
        connections_drained: Notify,
        connection_tasks: Mutex<HashMap<String, AbortHandle>>,
        first_diagnostic_connection_id: Mutex<Option<String>>,
    }

    impl ForwardCounters {
        fn add(counter: &AtomicU64, value: u64) -> u64 {
            counter
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    Some(current.saturating_add(value))
                })
                .unwrap_or_else(|current| current)
        }

        fn register_connection(&self, connection_id: &str) -> bool {
            if Self::add(&self.connections_opened, 1) != 0 {
                return false;
            }
            if let Ok(mut first) = self.first_diagnostic_connection_id.lock() {
                *first = Some(connection_id.to_string());
            }
            true
        }

        fn record_destination_rejection(&self, code: &str) -> bool {
            if let Ok(mut last) = self.last_destination_rejection_code.lock() {
                *last = Some(safe_reason_code(code));
            }
            Self::add(&self.destination_rejected, 1) == 0
        }

        fn record_route_disconnect(&self) -> bool {
            Self::add(&self.route_disconnects, 1) == 0
        }

        fn record_route_fallback(&self) -> bool {
            if self.fallback_requested.swap(true, Ordering::AcqRel) {
                return false;
            }
            Self::add(&self.route_fallbacks, 1);
            true
        }

        fn cancel_route_fallback(&self) {
            if self.fallback_requested.swap(false, Ordering::AcqRel) {
                let _ = self.route_fallbacks.fetch_update(
                    Ordering::AcqRel,
                    Ordering::Acquire,
                    |current| Some(current.saturating_sub(1)),
                );
            }
        }

        fn record_route_selection(&self) -> bool {
            Self::add(&self.route_selections, 1) == 0
        }

        fn is_first_diagnostic_connection(&self, connection_id: &str) -> bool {
            self.first_diagnostic_connection_id
                .lock()
                .ok()
                .and_then(|first| first.clone())
                .as_deref()
                == Some(connection_id)
        }

        fn track_connection_task(&self, connection_id: &str, abort_handle: AbortHandle) {
            if let Ok(mut tasks) = self.connection_tasks.lock() {
                tasks.insert(connection_id.to_string(), abort_handle);
            }
        }

        fn untrack_connection_task(&self, connection_id: &str) {
            if let Ok(mut tasks) = self.connection_tasks.lock() {
                tasks.remove(connection_id);
            }
        }

        fn abort_connection_tasks(&self) {
            if let Ok(mut tasks) = self.connection_tasks.lock() {
                for (_, task) in tasks.drain() {
                    task.abort();
                }
            }
        }

        fn apply(&self, summary: &mut TunnelForwardSummary) {
            summary.bytes_from_local = self.bytes_from_local.load(Ordering::Relaxed);
            summary.bytes_to_local = self.bytes_to_local.load(Ordering::Relaxed);
            summary.connections_closed = self.connections_closed.load(Ordering::Relaxed);
            summary.connections_opened = self.connections_opened.load(Ordering::Relaxed);
            summary.destination_rejected_count = self.destination_rejected.load(Ordering::Relaxed);
            summary.route_state = match self.route_state.load(Ordering::Relaxed) {
                1 => "local-direct",
                2 => "relayed",
                3 => "degraded",
                _ => summary.route_state,
            };
            summary.last_destination_rejection_code = self
                .last_destination_rejection_code
                .lock()
                .ok()
                .and_then(|code| code.clone());
        }

        async fn wait_for_connections_drained(&self) {
            loop {
                let drained = self.connections_drained.notified();
                if self.connections_closed.load(Ordering::Acquire)
                    >= self.connections_opened.load(Ordering::Acquire)
                {
                    return;
                }
                drained.await;
            }
        }

        fn terminal_snapshot(
            &self,
            summary: &TunnelForwardSummary,
        ) -> TunnelForwardTerminalSnapshot {
            TunnelForwardTerminalSnapshot {
                attachment_id: summary.attachment_id.clone(),
                tunnel_id: summary.tunnel_id.clone(),
                direct_capability_id: summary.direct_capability_id.clone(),
                bytes_from_local: self.bytes_from_local.load(Ordering::Acquire),
                bytes_to_local: self.bytes_to_local.load(Ordering::Acquire),
                connections_closed: self.connections_closed.load(Ordering::Acquire),
                connections_opened: self.connections_opened.load(Ordering::Acquire),
                destination_accepted_count: self.destination_accepted.load(Ordering::Acquire),
                destination_rejected_count: self.destination_rejected.load(Ordering::Acquire),
                last_destination_rejection_code: self
                    .last_destination_rejection_code
                    .lock()
                    .ok()
                    .and_then(|code| code.clone()),
                open_queued_count: self.opens_queued.load(Ordering::Acquire),
                open_sent_count: self.opens_sent.load(Ordering::Acquire),
                route_disconnect_count: self.route_disconnects.load(Ordering::Acquire),
                route_fallback_count: self.route_fallbacks.load(Ordering::Acquire),
                route_selection_count: self.route_selections.load(Ordering::Acquire),
            }
        }
    }

    struct OpenConnection {
        app: Option<AppHandle>,
        attachment_id: String,
        close_reason: &'static str,
        connection_id: String,
        counters: Arc<ForwardCounters>,
        diagnostic_trace_id: Option<String>,
        emit_lifecycle_diagnostics: bool,
        tunnel_id: String,
        wire_reason_code: Option<String>,
    }

    impl OpenConnection {
        fn new(
            app: Option<AppHandle>,
            attachment_id: String,
            connection_id: String,
            counters: Arc<ForwardCounters>,
            diagnostic_trace_id: Option<String>,
            emit_lifecycle_diagnostics: bool,
            tunnel_id: String,
        ) -> Self {
            Self {
                app,
                attachment_id,
                close_reason: "task-aborted",
                connection_id,
                counters,
                diagnostic_trace_id,
                emit_lifecycle_diagnostics,
                tunnel_id,
                wire_reason_code: None,
            }
        }

        fn set_close_reason(&mut self, reason: &'static str) {
            self.close_reason = reason;
        }

        fn set_wire_reason_code(&mut self, code: &str) {
            self.wire_reason_code = Some(safe_reason_code(code));
        }
    }

    impl Drop for OpenConnection {
        fn drop(&mut self) {
            ForwardCounters::add(&self.counters.connections_closed, 1);
            self.counters.connections_drained.notify_one();
            if self.emit_lifecycle_diagnostics {
                diagnostic_event(
                    self.app.as_ref(),
                    "info",
                    "Desktop tunnel connection closed",
                    json!({
                        "attachmentId": self.attachment_id,
                        "connectionId": self.connection_id,
                        "diagnosticTraceId": self.diagnostic_trace_id,
                        "event": "desktop.tunnel.connection.closed",
                        "operation": "forward-connection",
                        "reasonCode": self.close_reason,
                        "status": "completed",
                        "subsystem": "tunnel-forward",
                        "tunnelId": self.tunnel_id,
                        "wireReasonCode": self.wire_reason_code,
                    }),
                );
            }
        }
    }

    fn diagnostic_event(
        app: Option<&AppHandle>,
        level: &str,
        message: &'static str,
        mut context: Value,
    ) {
        strip_capability_material(&mut context);
        if context
            .get("diagnosticTraceId")
            .and_then(Value::as_str)
            .is_none()
        {
            return;
        }
        let Some(app) = app else { return };
        app.state::<LocalServiceLogs>()
            .runtime_event(level, message, Some(context));
    }

    fn strip_capability_material(context: &mut Value) {
        if let Some(context) = context.as_object_mut() {
            context.remove("capabilityId");
            context.remove("directCapabilityId");
        }
    }

    fn safe_reason_code(value: &str) -> String {
        match value {
            "target-unavailable"
            | "target-rejected"
            | "limit-exceeded"
            | "unauthorized"
            | "protocol-error"
            | "congested"
            | "normal"
            | "revoked"
            | "endpoint-disconnected"
            | "idle-timeout"
            | "lifetime-expired"
            | "bandwidth-limit"
            | "connection-failed"
            | "io-error"
            | "protected-target-invalid"
            | "protected-record-unavailable"
            | "protected-endpoint-unavailable" => value.to_string(),
            _ => "unknown-code".into(),
        }
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

    impl Direction {
        fn as_str(self) -> &'static str {
            match self {
                Self::SourceToDestination => "source-to-destination",
                Self::DestinationToSource => "destination-to-source",
            }
        }
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FrameProtection {
        format_version: u8,
        algorithm: String,
        key_revision: u64,
        nonce: String,
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
        },
        #[serde(rename = "data")]
        Data {
            #[serde(flatten)]
            base: FrameBase,
            direction: Direction,
            #[serde(skip_serializing_if = "Option::is_none")]
            protection: Option<FrameProtection>,
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
        },
        #[serde(rename = "error")]
        Error {
            #[serde(flatten)]
            base: FrameBase,
            code: String,
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

    struct StartupRoute {
        direct_capability_id: Option<String>,
        direct_fallback_reason: Option<String>,
        state: &'static str,
    }

    struct RelayRoute {
        expires_at_epoch_ms: u64,
        secret: Zeroizing<String>,
        url: Url,
    }

    enum RouteControl {
        ForceRelay {
            completed: oneshot::Sender<Result<(), String>>,
        },
    }

    enum SessionOutcome {
        Disconnected,
        ForceRelay(oneshot::Sender<Result<(), String>>),
        Stopped,
    }

    enum RelayConnectOutcome<T> {
        Connected(T),
        Refreshed,
        Stopped,
    }

    struct DataProtection {
        key_revision: u64,
        key: Zeroizing<Vec<u8>>,
    }

    type OutboundFrame = (FrameHeader, Vec<u8>);
    type InboundFrame = (FrameHeader, Vec<u8>);

    pub async fn start(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        request: StartTunnelForwardRequest,
    ) -> Result<TunnelForwardSummary, String> {
        validate_identifiers(&request)?;
        let relay_fallback_available = request.relay.is_some();
        let _ = stop(app, state, &request.tunnel_id, "replaced").await?;
        let listener = match bind_listener(request.preferred_local_port).await {
            Ok(listener) => listener,
            Err(error) => {
                diagnostic_event(
                    Some(app),
                    "warn",
                    "Desktop tunnel listener failed to bind",
                    json!({
                        "attachmentId": request.attachment_id,
                        "diagnosticTraceId": request.diagnostic_trace_id,
                        "event": "desktop.tunnel.listener.bind-failed",
                        "operation": "bind-listener",
                        "reasonCode": "bind-failed",
                        "status": "failed",
                        "subsystem": "tunnel-forward",
                        "tunnelId": request.tunnel_id,
                    }),
                );
                return Err(error);
            }
        };
        diagnostic_event(
            Some(app),
            "info",
            "Desktop tunnel listener bound",
            json!({
                "attachmentId": request.attachment_id,
                "diagnosticTraceId": request.diagnostic_trace_id,
                "event": "desktop.tunnel.listener.bound",
                "operation": "bind-listener",
                "status": "ready",
                "subsystem": "tunnel-forward",
                "tunnelId": request.tunnel_id,
            }),
        );
        let local_port = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the local tunnel listener: {error}"))?
            .port();
        let summary_identity = (
            request.attachment_id.clone(),
            request.diagnostic_trace_id.clone(),
            request.expires_at.clone(),
            request
                .relay
                .as_ref()
                .map(|relay| relay.secret_expires_at_epoch_ms),
            request.tunnel_id.clone(),
        );
        let tunnel_id = request.tunnel_id.clone();
        let counters = Arc::new(ForwardCounters::default());
        let (stop_sender, stop_receiver) = oneshot::channel();
        let (ready_sender, ready_receiver) = oneshot::channel();
        let (relay_refresh_sender, relay_refresh_receiver) = watch::channel(None);
        let (route_control_sender, route_control_receiver) = mpsc::channel(1);
        let task = tauri::async_runtime::spawn(run_forward(
            Some(app.clone()),
            listener,
            request,
            counters.clone(),
            stop_receiver,
            ready_sender,
            relay_refresh_receiver,
            route_control_receiver,
        ));
        let startup = match timeout(Duration::from_secs(15), ready_receiver).await {
            Ok(Ok(Ok(startup))) => startup,
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
        };
        let summary = TunnelForwardSummary {
            attachment_id: summary_identity.0,
            diagnostic_trace_id: summary_identity.1,
            expires_at: summary_identity.2,
            local_host: "127.0.0.1",
            local_port,
            route_state: startup.state,
            relay_fallback_available,
            relay_credential_expires_at_epoch_ms: summary_identity.3,
            direct_capability_id: startup.direct_capability_id,
            direct_fallback_reason: startup.direct_fallback_reason,
            last_destination_rejection_code: None,
            tunnel_id: summary_identity.4,
            bytes_from_local: 0,
            bytes_to_local: 0,
            connections_closed: 0,
            connections_opened: 0,
            destination_rejected_count: 0,
        };
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        forwards.insert(
            tunnel_id,
            ForwardHandle {
                counters,
                relay_refresh: relay_refresh_sender,
                route_control: route_control_sender,
                stop: Some(stop_sender),
                summary: summary.clone(),
                task,
            },
        );
        Ok(summary)
    }

    pub async fn force_relay(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        tunnel_id: &str,
    ) -> Result<Option<TunnelForwardSummary>, String> {
        let transition_deadline = Instant::now() + RELAY_FALLBACK_TIMEOUT;
        let (route_control, mut summary, counters) = loop {
            let wait_for_transition = {
                let mut forwards = state
                    .forwards
                    .lock()
                    .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
                let Some(forward) = forwards.get_mut(tunnel_id) else {
                    return Ok(None);
                };
                let mut summary = forward.summary.clone();
                forward.counters.apply(&mut summary);
                if summary.route_state == "relayed" {
                    summary.direct_fallback_reason = Some("connected-route-unusable".into());
                    forward.summary.direct_fallback_reason = summary.direct_fallback_reason.clone();
                    forward.summary.route_state = "relayed";
                    return Ok(Some(summary));
                }
                if !summary.relay_fallback_available {
                    return Err("The desktop tunnel cannot switch to its relay.".into());
                }
                if summary.route_state == "degraded" {
                    true
                } else if summary.route_state == "local-direct" {
                    if !forward.counters.record_route_fallback() {
                        return Err("The desktop tunnel relay fallback is already pending.".into());
                    }
                    break (
                        forward.route_control.clone(),
                        summary,
                        forward.counters.clone(),
                    );
                } else {
                    return Err("The desktop tunnel cannot switch to its relay.".into());
                }
            };
            if wait_for_transition {
                if Instant::now() >= transition_deadline {
                    return Err("The desktop tunnel relay fallback timed out.".into());
                }
                sleep(Duration::from_millis(25)).await;
            }
        };

        diagnostic_event(
            Some(app),
            "info",
            "Desktop tunnel relay fallback requested",
            json!({
                "attachmentId": summary.attachment_id,
                "diagnosticTraceId": summary.diagnostic_trace_id,
                "event": "desktop.tunnel.route.fallback-requested",
                "operation": "select-route",
                "reasonCode": "connected-route-unusable",
                "status": "started",
                "subsystem": "tunnel-forward",
                "tunnelId": summary.tunnel_id,
            }),
        );
        let (completed, completion) = oneshot::channel();
        if route_control
            .try_send(RouteControl::ForceRelay { completed })
            .is_err()
        {
            counters.cancel_route_fallback();
            return Err("The desktop tunnel relay fallback could not be queued.".into());
        }
        let completion = match timeout(RELAY_FALLBACK_TIMEOUT, completion).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The desktop tunnel stopped during relay fallback.".into()),
            Err(_) => Err("The desktop tunnel relay fallback timed out.".into()),
        };
        if let Err(error) = completion {
            diagnostic_event(
                Some(app),
                "warn",
                "Desktop tunnel relay fallback failed",
                json!({
                    "attachmentId": summary.attachment_id,
                    "diagnosticTraceId": summary.diagnostic_trace_id,
                    "event": "desktop.tunnel.route.fallback-failed",
                    "operation": "select-route",
                    "reasonCode": "relay-connect-failed",
                    "status": "failed",
                    "subsystem": "tunnel-forward",
                    "tunnelId": summary.tunnel_id,
                }),
            );
            return Err(error);
        }

        counters.apply(&mut summary);
        if summary.route_state != "relayed" {
            return Err("The desktop tunnel did not select its relay.".into());
        }
        summary.direct_fallback_reason = Some("connected-route-unusable".into());
        if let Ok(mut forwards) = state.forwards.lock() {
            if let Some(forward) = forwards.get_mut(tunnel_id) {
                forward.summary.direct_fallback_reason = summary.direct_fallback_reason.clone();
                forward.summary.route_state = "relayed";
            }
        }
        Ok(Some(summary))
    }

    pub fn confirm_direct_retired(
        state: &State<'_, TunnelForwards>,
        tunnel_id: &str,
        direct_capability_id: &str,
    ) -> Result<bool, String> {
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        let Some(forward) = forwards.get_mut(tunnel_id) else {
            return Ok(false);
        };
        Ok(confirm_direct_retired_summary(
            &mut forward.summary,
            direct_capability_id,
        ))
    }

    fn confirm_direct_retired_summary(
        summary: &mut TunnelForwardSummary,
        direct_capability_id: &str,
    ) -> bool {
        if summary.direct_capability_id.as_deref() != Some(direct_capability_id) {
            return false;
        }
        summary.direct_capability_id = None;
        true
    }

    pub fn refresh_relay(
        state: &State<'_, TunnelForwards>,
        tunnel_id: &str,
        expires_at: String,
        relay: RelayTunnelRequest,
    ) -> Result<TunnelRelayRefreshResult, String> {
        let route = Arc::new(relay_route(relay)?);
        let relay_credential_expires_at_epoch_ms = route.expires_at_epoch_ms;
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        let Some(forward) = forwards.get_mut(tunnel_id) else {
            return Ok(TunnelRelayRefreshResult {
                outcome: TunnelRelayRefreshOutcome::ForwardUnavailable,
            });
        };
        let outcome = publish_relay_refresh(
            &forward.relay_refresh,
            forward.summary.relay_credential_expires_at_epoch_ms,
            route,
        );
        if outcome == TunnelRelayRefreshOutcome::Accepted {
            forward.summary.expires_at = expires_at;
            forward.summary.relay_credential_expires_at_epoch_ms =
                Some(relay_credential_expires_at_epoch_ms);
        }
        Ok(TunnelRelayRefreshResult { outcome })
    }

    fn publish_relay_refresh(
        sender: &watch::Sender<Option<Arc<RelayRoute>>>,
        current_expires_at_epoch_ms: Option<u64>,
        route: Arc<RelayRoute>,
    ) -> TunnelRelayRefreshOutcome {
        if current_expires_at_epoch_ms.is_some_and(|current| route.expires_at_epoch_ms <= current) {
            return TunnelRelayRefreshOutcome::Stale;
        }
        if sender.send(Some(route)).is_err() {
            return TunnelRelayRefreshOutcome::ForwardUnavailable;
        }
        TunnelRelayRefreshOutcome::Accepted
    }

    pub async fn stop(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        tunnel_id: &str,
        reason: &'static str,
    ) -> Result<Option<TunnelForwardTerminalSnapshot>, String> {
        let forward = {
            let mut forwards = state
                .forwards
                .lock()
                .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
            forwards.remove(tunnel_id)
        };
        let Some(mut forward) = forward else {
            return Ok(None);
        };
        abort_forward(&mut forward);
        log_forward_stopping(app, &forward, reason);
        let _ = (&mut forward.task).await;
        forward.counters.wait_for_connections_drained().await;
        let snapshot = forward.counters.terminal_snapshot(&forward.summary);
        log_forward_snapshot(app, &forward, &snapshot, reason);
        log_forward_stopped(app, &forward, reason);
        Ok(Some(snapshot))
    }

    pub(super) fn abort_forward(forward: &mut ForwardHandle) {
        if let Some(stop) = forward.stop.take() {
            let _ = stop.send(());
        }
        forward.task.abort();
        forward.counters.abort_connection_tasks();
    }

    pub(super) fn log_forward_stopping(
        app: &AppHandle,
        forward: &ForwardHandle,
        reason: &'static str,
    ) {
        diagnostic_event(
            Some(app),
            "info",
            "Desktop tunnel forward stopping",
            json!({
                "attachmentId": forward.summary.attachment_id,
                "diagnosticTraceId": forward.summary.diagnostic_trace_id,
                "event": "desktop.tunnel.forward.stopping",
                "operation": "stop-forward",
                "reasonCode": reason,
                "status": "started",
                "subsystem": "tunnel-forward",
                "tunnelId": forward.summary.tunnel_id,
            }),
        );
    }

    fn log_forward_snapshot(
        app: &AppHandle,
        forward: &ForwardHandle,
        snapshot: &TunnelForwardTerminalSnapshot,
        reason: &'static str,
    ) {
        diagnostic_event(
            Some(app),
            "info",
            "Desktop tunnel terminal snapshot captured",
            json!({
                "attachmentId": forward.summary.attachment_id,
                "diagnosticTraceId": forward.summary.diagnostic_trace_id,
                "event": "desktop.tunnel.forward.snapshot",
                "lastDestinationRejectionCode": snapshot.last_destination_rejection_code,
                "operation": "stop-forward",
                "reasonCode": reason,
                "routeState": match forward.counters.route_state.load(Ordering::Relaxed) {
                    1 => "local-direct",
                    2 => "relayed",
                    3 => "degraded",
                    _ => forward.summary.route_state,
                },
                "status": "completed",
                "subsystem": "tunnel-forward",
                "tunnelId": forward.summary.tunnel_id,
                "counts": {
                    "bytesFromLocal": snapshot.bytes_from_local,
                    "bytesToLocal": snapshot.bytes_to_local,
                    "connectionsClosed": snapshot.connections_closed,
                    "connectionsOpened": snapshot.connections_opened,
                    "destinationAcceptedCount": snapshot.destination_accepted_count,
                    "destinationRejectedCount": snapshot.destination_rejected_count,
                    "openQueuedCount": snapshot.open_queued_count,
                    "openSentCount": snapshot.open_sent_count,
                    "routeDisconnectCount": snapshot.route_disconnect_count,
                    "routeFallbackCount": snapshot.route_fallback_count,
                    "routeSelectionCount": snapshot.route_selection_count,
                },
            }),
        );
    }

    pub(super) fn log_forward_stopped(
        app: &AppHandle,
        forward: &ForwardHandle,
        reason: &'static str,
    ) {
        diagnostic_event(
            Some(app),
            "info",
            "Desktop tunnel forward stopped",
            json!({
                "attachmentId": forward.summary.attachment_id,
                "diagnosticTraceId": forward.summary.diagnostic_trace_id,
                "event": "desktop.tunnel.forward.stopped",
                "operation": "stop-forward",
                "reasonCode": reason,
                "status": "completed",
                "subsystem": "tunnel-forward",
                "tunnelId": forward.summary.tunnel_id,
            }),
        );
    }

    pub fn list(state: &State<'_, TunnelForwards>) -> Result<Vec<TunnelForwardSummary>, String> {
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        forwards.retain(|_, forward| !forward.task.inner().is_finished());
        let mut summaries = forwards
            .values()
            .map(|forward| {
                let mut summary = forward.summary.clone();
                forward.counters.apply(&mut summary);
                summary
            })
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
        if request
            .diagnostic_trace_id
            .as_deref()
            .is_some_and(|trace_id| Uuid::parse_str(trace_id).is_err())
        {
            return Err("The tunnel diagnostic trace identity is invalid.".into());
        }
        if let Some(relay) = &request.relay {
            validate_relay(relay)?;
        } else if request.direct.is_none() {
            return Err("The tunnel has no authorized data route.".into());
        }
        if let Some(direct) = &request.direct {
            if direct.route.tunnel_id != request.tunnel_id
                || direct.route.attachment_id != request.attachment_id
                || !matches!(
                    direct.binding.resource_kind.as_str(),
                    "tunnel" | "project-share" | "terminal" | "code"
                )
                || (direct.binding.resource_kind == "tunnel"
                    && direct.binding.resource_id != request.tunnel_id)
                || direct.binding.attachment_id != request.attachment_id
                || !direct
                    .binding
                    .channels
                    .iter()
                    .any(|channel| channel == "tunnel-data")
            {
                return Err("The direct tunnel capability identity is invalid.".into());
            }
        }
        Ok(())
    }

    fn validate_relay(relay: &RelayTunnelRequest) -> Result<(), String> {
        if relay.secret.len() < 32 || relay.secret.len() > 512 {
            return Err("The tunnel attachment credential is invalid.".into());
        }
        let _ = web_socket_url(&relay.server_url, &relay.connect_path)?;
        Ok(())
    }

    fn relay_route(mut relay: RelayTunnelRequest) -> Result<RelayRoute, String> {
        validate_relay(&relay)?;
        Ok(RelayRoute {
            expires_at_epoch_ms: relay.secret_expires_at_epoch_ms,
            secret: Zeroizing::new(std::mem::take(&mut relay.secret)),
            url: web_socket_url(&relay.server_url, &relay.connect_path)?,
        })
    }

    fn data_protection(
        input: Option<TunnelDataProtectionRequest>,
    ) -> Result<Option<Arc<DataProtection>>, String> {
        let Some(mut input) = input else {
            return Ok(None);
        };
        if input.format_version != 1
            || input.algorithm != "AES-256-GCM"
            || input.key_revision == 0
            || input.key.len() != 43
        {
            return Err("The tunnel data protection configuration is invalid.".into());
        }
        let encoded_key = Zeroizing::new(std::mem::take(&mut input.key));
        let key = URL_SAFE_NO_PAD
            .decode(encoded_key.as_bytes())
            .map_err(|_| "The tunnel data protection key is invalid.".to_string())?;
        if key.len() != 32 {
            return Err("The tunnel data protection key is invalid.".into());
        }
        Ok(Some(Arc::new(DataProtection {
            key_revision: input.key_revision,
            key: Zeroizing::new(key),
        })))
    }

    fn frame_associated_data(
        base: &FrameBase,
        direction: Direction,
        protection: &FrameProtection,
    ) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&(
            base.protocol_version,
            &base.tunnel_id,
            &base.attachment_id,
            &base.source_endpoint_id,
            &base.destination_endpoint_id,
            &base.connection_id,
            base.sequence,
            "data",
            direction.as_str(),
            protection.format_version,
            &protection.algorithm,
            protection.key_revision,
            &protection.nonce,
        ))
        .map_err(|_| "Could not bind tunnel data to its route identity.".to_string())
    }

    fn seal_data_payload(
        configuration: &DataProtection,
        base: &FrameBase,
        direction: Direction,
        plaintext: &[u8],
    ) -> Result<(FrameProtection, Vec<u8>), String> {
        if plaintext.is_empty() || plaintext.len() > MAX_PLAINTEXT_BYTES {
            return Err("A tunnel plaintext payload is invalid.".into());
        }
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let protection = FrameProtection {
            format_version: 1,
            algorithm: "AES-256-GCM".into(),
            key_revision: configuration.key_revision,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
        };
        let cipher = Aes256Gcm::new_from_slice(configuration.key.as_slice())
            .map_err(|_| "The tunnel data protection key is invalid.".to_string())?;
        let associated_data = frame_associated_data(base, direction, &protection)?;
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &associated_data,
                },
            )
            .map_err(|_| "Could not protect tunnel data.".to_string())?;
        Ok((protection, ciphertext))
    }

    fn open_data_payload(
        configuration: Option<&DataProtection>,
        base: &FrameBase,
        direction: Direction,
        protection: Option<&FrameProtection>,
        payload: &[u8],
    ) -> Result<Vec<u8>, String> {
        match (configuration, protection) {
            (None, None) if payload.len() <= MAX_PLAINTEXT_BYTES => Ok(payload.to_vec()),
            (Some(configuration), Some(protection)) => {
                if protection.format_version != 1
                    || protection.algorithm != "AES-256-GCM"
                    || protection.key_revision != configuration.key_revision
                    || payload.len() <= AUTH_TAG_BYTES
                {
                    return Err("Tunnel data protection metadata is invalid.".into());
                }
                let nonce = URL_SAFE_NO_PAD
                    .decode(protection.nonce.as_bytes())
                    .map_err(|_| "Tunnel data protection nonce is invalid.".to_string())?;
                if nonce.len() != 12 {
                    return Err("Tunnel data protection nonce is invalid.".into());
                }
                let cipher = Aes256Gcm::new_from_slice(configuration.key.as_slice())
                    .map_err(|_| "The tunnel data protection key is invalid.".to_string())?;
                let associated_data = frame_associated_data(base, direction, protection)?;
                cipher
                    .decrypt(
                        Nonce::from_slice(&nonce),
                        Payload {
                            msg: payload,
                            aad: &associated_data,
                        },
                    )
                    .map_err(|_| "Tunnel data authentication failed.".to_string())
            }
            _ => Err("Tunnel data protection does not match this endpoint.".into()),
        }
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

    fn route_connect_failure_reason_code(error: &str) -> &'static str {
        match error {
            "The tunnel attachment credential expired." => "relay-credential-expired",
            "The tunnel attachment credential is invalid." => "relay-credential-invalid",
            "Connecting the tunnel attachment timed out." => "connect-timeout",
            "The tunnel attachment handshake timed out." => "handshake-timeout",
            "Could not initialize the tunnel attachment."
            | "The tunnel attachment closed during handshake."
            | "The tunnel attachment handshake failed."
            | "The tunnel attachment returned an invalid handshake."
            | "The tunnel attachment handshake identity did not match." => "handshake-failed",
            _ => "connect-failed",
        }
    }

    fn relay_credential_state(relay: Option<&RelayRoute>, now_epoch_ms: u64) -> &'static str {
        match relay {
            Some(relay) if now_epoch_ms >= relay.expires_at_epoch_ms => "expired",
            Some(_) => "valid",
            None => "unavailable",
        }
    }

    fn route_connect_failure_context(
        request: &StartTunnelForwardRequest,
        relay: Option<&RelayRoute>,
        error: &str,
        attempt: u64,
        retry_delay: Duration,
        now_epoch_ms: u64,
    ) -> Value {
        json!({
            "attachmentId": request.attachment_id,
            "attempt": attempt,
            "diagnosticTraceId": request.diagnostic_trace_id,
            "event": "desktop.tunnel.route.connect-failed",
            "operation": "connect-route",
            "reasonCode": route_connect_failure_reason_code(error),
            "relayCredentialState": relay_credential_state(relay, now_epoch_ms),
            "retryDelayMs": u64::try_from(retry_delay.as_millis()).unwrap_or(u64::MAX),
            "routeCandidate": "relay",
            "status": "retrying",
            "subsystem": "tunnel-forward",
            "tunnelId": request.tunnel_id,
        })
    }

    async fn run_forward(
        app: Option<AppHandle>,
        listener: TcpListener,
        mut request: StartTunnelForwardRequest,
        counters: Arc<ForwardCounters>,
        mut stop: oneshot::Receiver<()>,
        ready: oneshot::Sender<Result<StartupRoute, String>>,
        mut relay_refreshes: watch::Receiver<Option<Arc<RelayRoute>>>,
        mut route_controls: mpsc::Receiver<RouteControl>,
    ) {
        let diagnostic_trace_id = request.diagnostic_trace_id.clone();
        let protection = match data_protection(request.data_protection.take()) {
            Ok(protection) => protection,
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
        let mut relay = request
            .relay
            .take()
            .and_then(|relay| relay_route(relay).ok())
            .map(Arc::new);
        let mut ready = Some(ready);
        let mut reconnect_attempt = 0_u64;
        let mut retry_delay = Duration::from_millis(250);
        let mut direct = request.direct.take();
        let mut direct_fallback_reason = None;
        let mut pending_relay_fallback: Option<oneshot::Sender<Result<(), String>>> = None;
        loop {
            if direct.is_none() {
                if let Some(latest) = relay_refreshes.borrow_and_update().clone() {
                    relay = Some(latest);
                }
            }
            let direct_capability_id = direct
                .as_ref()
                .map(|candidate| candidate.binding.capability_id.clone());
            let connected = if let Some(candidate) = direct.take() {
                let identity = RouteIdentity {
                    attachment_id: candidate.route.attachment_id,
                    destination_endpoint_id: candidate.route.destination_endpoint_id,
                    source_endpoint_id: candidate.route.source_endpoint_id,
                    tunnel_id: candidate.route.tunnel_id,
                };
                match connect_verified(DirectProbeRequest {
                    broker: candidate.broker,
                    binding: candidate.binding,
                    secret: candidate.secret,
                })
                .await
                {
                    Ok(connection) => Ok((
                        connection.socket,
                        identity,
                        StartupRoute {
                            direct_capability_id,
                            direct_fallback_reason: None,
                            state: "local-direct",
                        },
                    )),
                    Err(reason) => {
                        direct_fallback_reason = Some(reason);
                        connect_relay(relay.as_deref(), &request)
                            .await
                            .map(|(socket, identity)| {
                                (
                                    socket,
                                    identity,
                                    StartupRoute {
                                        direct_capability_id: None,
                                        direct_fallback_reason: direct_fallback_reason.clone(),
                                        state: "relayed",
                                    },
                                )
                            })
                    }
                }
            } else {
                match connect_relay_until_refresh(
                    connect_relay(relay.as_deref(), &request),
                    &mut relay_refreshes,
                    &mut stop,
                )
                .await
                {
                    RelayConnectOutcome::Connected(connected) => {
                        connected.map(|(socket, identity)| {
                            (
                                socket,
                                identity,
                                StartupRoute {
                                    direct_capability_id: None,
                                    direct_fallback_reason: direct_fallback_reason.clone(),
                                    state: "relayed",
                                },
                            )
                        })
                    }
                    RelayConnectOutcome::Refreshed => continue,
                    RelayConnectOutcome::Stopped => return,
                }
            };
            let (web_socket, identity, startup) = match connected {
                Ok(connected) => connected,
                Err(error) => {
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Err(error));
                        return;
                    }
                    if relay.is_none() {
                        return;
                    }
                    counters.route_state.store(3, Ordering::Relaxed);
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    diagnostic_event(
                        app.as_ref(),
                        "warn",
                        "Desktop tunnel route connection failed",
                        route_connect_failure_context(
                            &request,
                            relay.as_deref(),
                            &error,
                            reconnect_attempt,
                            retry_delay,
                            unix_epoch_ms(),
                        ),
                    );
                    tokio::select! {
                        _ = &mut stop => return,
                        changed = relay_refreshes.changed() => {
                            if changed.is_err() { return; }
                            if let Some(latest) = relay_refreshes.borrow_and_update().clone() {
                                relay = Some(latest);
                            }
                        }
                        _ = sleep(retry_delay) => {}
                    }
                    retry_delay = min(retry_delay * 2, Duration::from_secs(5));
                    continue;
                }
            };
            counters.route_state.store(
                if startup.state == "local-direct" {
                    1
                } else {
                    2
                },
                Ordering::Relaxed,
            );
            if startup.state == "relayed" {
                if let Some(completed) = pending_relay_fallback.take() {
                    diagnostic_event(
                        app.as_ref(),
                        "info",
                        "Desktop tunnel relay fallback completed",
                        json!({
                            "attachmentId": request.attachment_id,
                            "diagnosticTraceId": diagnostic_trace_id,
                            "event": "desktop.tunnel.route.fallback-completed",
                            "operation": "select-route",
                            "reasonCode": "connected-route-unusable",
                            "routeState": "relayed",
                            "status": "completed",
                            "subsystem": "tunnel-forward",
                            "tunnelId": request.tunnel_id,
                        }),
                    );
                    let _ = completed.send(Ok(()));
                }
            }
            if counters.record_route_selection() {
                diagnostic_event(
                    app.as_ref(),
                    "info",
                    "Desktop tunnel route selected",
                    json!({
                        "attachmentId": request.attachment_id,
                        "diagnosticTraceId": diagnostic_trace_id,
                        "event": "desktop.tunnel.route.selected",
                        "operation": "select-route",
                        "routeState": startup.state,
                        "status": "completed",
                        "subsystem": "tunnel-forward",
                        "tunnelId": request.tunnel_id,
                    }),
                );
            }
            let session_route_state = startup.state;
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok(startup));
            }
            reconnect_attempt = 0;
            retry_delay = Duration::from_millis(250);
            let session = run_session(
                app.as_ref(),
                diagnostic_trace_id.as_deref(),
                &listener,
                web_socket,
                identity,
                protection.clone(),
                counters.clone(),
                &mut stop,
                &mut route_controls,
            );
            let result =
                run_session_with_relay_refresh(session, &mut relay, &mut relay_refreshes).await;
            match result {
                Ok(SessionOutcome::Stopped) => return,
                Ok(SessionOutcome::ForceRelay(completed)) => {
                    direct_fallback_reason = Some("connected-route-unusable".into());
                    counters.route_state.store(3, Ordering::Relaxed);
                    pending_relay_fallback = Some(completed);
                    continue;
                }
                result => {
                    if session_route_state == "local-direct" && relay.is_some() {
                        counters.route_state.store(3, Ordering::Relaxed);
                        let _ = counters.record_route_fallback();
                        direct_fallback_reason = Some("route-disconnected".into());
                    }
                    let reason_code = match result {
                        Ok(SessionOutcome::Disconnected) => "remote-closed",
                        Ok(SessionOutcome::ForceRelay(_)) | Ok(SessionOutcome::Stopped) => {
                            unreachable!()
                        }
                        Err(_) => "route-error",
                    };
                    if counters.record_route_disconnect() {
                        diagnostic_event(
                            app.as_ref(),
                            "warn",
                            "Desktop tunnel route disconnected",
                            json!({
                                "attachmentId": request.attachment_id,
                                "diagnosticTraceId": diagnostic_trace_id,
                                "event": "desktop.tunnel.route.disconnected",
                                "operation": "forward-route",
                                "reasonCode": reason_code,
                                "status": "degraded",
                                "subsystem": "tunnel-forward",
                                "tunnelId": request.tunnel_id,
                            }),
                        );
                    }
                    counters.route_state.store(3, Ordering::Relaxed);
                }
            }
        }
    }

    async fn connect_relay_until_refresh<F>(
        connect: F,
        relay_refreshes: &mut watch::Receiver<Option<Arc<RelayRoute>>>,
        stop: &mut oneshot::Receiver<()>,
    ) -> RelayConnectOutcome<F::Output>
    where
        F: Future,
    {
        tokio::pin!(connect);
        tokio::select! {
            biased;
            _ = &mut *stop => RelayConnectOutcome::Stopped,
            changed = relay_refreshes.changed() => {
                if changed.is_ok() {
                    RelayConnectOutcome::Refreshed
                } else {
                    RelayConnectOutcome::Stopped
                }
            }
            connected = &mut connect => RelayConnectOutcome::Connected(connected),
        }
    }

    async fn run_session_with_relay_refresh<F>(
        session: F,
        relay: &mut Option<Arc<RelayRoute>>,
        relay_refreshes: &mut watch::Receiver<Option<Arc<RelayRoute>>>,
    ) -> F::Output
    where
        F: Future,
    {
        tokio::pin!(session);
        loop {
            tokio::select! {
                result = &mut session => return result,
                changed = relay_refreshes.changed() => {
                    if changed.is_err() {
                        return (&mut session).await;
                    }
                    if let Some(latest) = relay_refreshes.borrow_and_update().clone() {
                        *relay = Some(latest);
                    }
                }
            }
        }
    }

    async fn connect_relay(
        relay: Option<&RelayRoute>,
        request: &StartTunnelForwardRequest,
    ) -> Result<
        (
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
            RouteIdentity,
        ),
        String,
    > {
        let relay = relay.ok_or_else(|| "The local direct tunnel disconnected.".to_string())?;
        if unix_epoch_ms() >= relay.expires_at_epoch_ms {
            return Err("The tunnel attachment credential expired.".into());
        }
        connect_attachment(&relay.url, &relay.secret, request).await
    }

    async fn connect_attachment(
        url: &Url,
        secret: &str,
        request: &StartTunnelForwardRequest,
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
        let mut initialize = serde_json::json!({
            "type": "initialize",
            "clientId": request.client_id,
        });
        if let Some(diagnostic_trace_id) = request.diagnostic_trace_id.as_deref() {
            initialize["diagnosticTraceId"] = serde_json::json!(diagnostic_trace_id);
        }
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
        app: Option<&AppHandle>,
        diagnostic_trace_id: Option<&str>,
        listener: &TcpListener,
        mut web_socket: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<TcpStream>,
        >,
        identity: RouteIdentity,
        protection: Option<Arc<DataProtection>>,
        counters: Arc<ForwardCounters>,
        stop: &mut oneshot::Receiver<()>,
        route_controls: &mut mpsc::Receiver<RouteControl>,
    ) -> Result<SessionOutcome, String> {
        let (outbound_sender, mut outbound_receiver) =
            mpsc::channel::<OutboundFrame>(OUTBOUND_QUEUE);
        let (completed_sender, mut completed_receiver) = mpsc::channel::<String>(256);
        let mut connections: HashMap<String, (mpsc::Sender<InboundFrame>, JoinHandle<()>)> =
            HashMap::new();
        let mut heartbeat = interval(Duration::from_secs(20));
        let result = loop {
            tokio::select! {
                _ = &mut *stop => break Ok(SessionOutcome::Stopped),
                control = route_controls.recv() => {
                    match control {
                        Some(RouteControl::ForceRelay { completed }) => {
                            break Ok(SessionOutcome::ForceRelay(completed));
                        }
                        None => break Ok(SessionOutcome::Stopped),
                    }
                }
                accepted = listener.accept() => {
                    let (stream, _) = accepted.map_err(|error| format!("The local tunnel listener failed: {error}"))?;
                    let connection_id = Uuid::new_v4().to_string();
                    let emit_lifecycle_diagnostics = counters.register_connection(&connection_id);
                    if emit_lifecycle_diagnostics {
                        diagnostic_event(
                            app,
                            "info",
                            "Desktop tunnel accepted a local connection",
                            json!({
                                "attachmentId": identity.attachment_id,
                                "connectionId": connection_id,
                                "diagnosticTraceId": diagnostic_trace_id,
                                "event": "desktop.tunnel.local-connection.accepted",
                                "operation": "accept-local-connection",
                                "status": "completed",
                                "subsystem": "tunnel-forward",
                                "tunnelId": identity.tunnel_id,
                            }),
                        );
                    }
                    let open_connection = OpenConnection::new(
                        app.cloned(),
                        identity.attachment_id.clone(),
                        connection_id.clone(),
                        counters.clone(),
                        diagnostic_trace_id.map(str::to_string),
                        emit_lifecycle_diagnostics,
                        identity.tunnel_id.clone(),
                    );
                    let (sender, receiver) = mpsc::channel(CONNECTION_QUEUE);
                    let (start_sender, start_receiver) = oneshot::channel();
                    let task_identity = identity.clone();
                    let task_connection_id = connection_id.clone();
                    let task_protection = protection.clone();
                    let task_outbound_sender = outbound_sender.clone();
                    let task_completed_sender = completed_sender.clone();
                    let task = tokio::spawn(async move {
                        if start_receiver.await.is_ok() {
                            run_connection(
                                stream,
                                task_identity,
                                task_connection_id,
                                task_protection,
                                task_outbound_sender,
                                receiver,
                                task_completed_sender,
                                open_connection,
                            )
                            .await;
                        }
                    });
                    counters.track_connection_task(&connection_id, task.abort_handle());
                    connections.insert(connection_id, (sender, task));
                    let _ = start_sender.send(());
                }
                outbound = outbound_receiver.recv() => {
                    let Some((header, payload)) = outbound else { break Ok(SessionOutcome::Disconnected) };
                    let open_connection_id = match &header {
                        FrameHeader::Open { base, .. } => Some(base.connection_id.clone()),
                        _ => None,
                    };
                    let frame = encode_frame(&header, &payload)?;
                    web_socket.send(Message::Binary(frame.into())).await
                        .map_err(|_| "The tunnel WebSocket disconnected.".to_string())?;
                    if let Some(connection_id) = open_connection_id {
                        ForwardCounters::add(&counters.opens_sent, 1);
                        if counters.is_first_diagnostic_connection(&connection_id) {
                            diagnostic_event(
                                app,
                                "info",
                                "Desktop tunnel Open frame sent",
                                json!({
                                    "attachmentId": identity.attachment_id,
                                    "connectionId": connection_id,
                                    "diagnosticTraceId": diagnostic_trace_id,
                                    "event": "desktop.tunnel.open.sent",
                                    "operation": "send-open",
                                    "status": "completed",
                                    "subsystem": "tunnel-forward",
                                    "tunnelId": identity.tunnel_id,
                                }),
                            );
                        }
                    }
                }
                incoming = web_socket.next() => {
                    let Some(incoming) = incoming else { break Ok(SessionOutcome::Disconnected) };
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
                        Message::Close(_) => break Ok(SessionOutcome::Disconnected),
                        Message::Text(_) | Message::Pong(_) | Message::Frame(_) => {}
                    }
                }
                completed = completed_receiver.recv() => {
                    if let Some(connection_id) = completed {
                        connections.remove(&connection_id);
                        counters.untrack_connection_task(&connection_id);
                    }
                }
                _ = heartbeat.tick() => {
                    web_socket.send(Message::Ping(Vec::new().into())).await
                        .map_err(|_| "The tunnel WebSocket disconnected.".to_string())?;
                }
            }
        };
        let tasks = connections
            .drain()
            .map(|(connection_id, (_, task))| {
                counters.untrack_connection_task(&connection_id);
                task.abort();
                task
            })
            .collect::<Vec<_>>();
        for task in tasks {
            let _ = task.await;
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
        protection: Option<Arc<DataProtection>>,
        outbound: mpsc::Sender<OutboundFrame>,
        mut inbound: mpsc::Receiver<InboundFrame>,
        completed: mpsc::Sender<String>,
        mut open_connection: OpenConnection,
    ) {
        let counters = open_connection.counters.clone();
        let (mut reader, mut writer) = stream.into_split();
        let mut source_sequence = 1_u64;
        let mut destination_sequence = 0_u64;
        let mut source_credit = 0_u64;
        let mut local_eof = false;
        let mut buffer = vec![0_u8; MAX_PLAINTEXT_BYTES];
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
            open_connection.set_close_reason("open-queue-full");
            let _ = completed.try_send(connection_id);
            return;
        }
        ForwardCounters::add(&counters.opens_queued, 1);
        if open_connection.emit_lifecycle_diagnostics {
            diagnostic_event(
                open_connection.app.as_ref(),
                "info",
                "Desktop tunnel Open frame queued",
                json!({
                    "attachmentId": open_connection.attachment_id,
                    "connectionId": connection_id,
                    "diagnosticTraceId": open_connection.diagnostic_trace_id,
                    "event": "desktop.tunnel.open.queued",
                    "operation": "queue-open",
                    "status": "completed",
                    "subsystem": "tunnel-forward",
                    "tunnelId": open_connection.tunnel_id,
                }),
            );
        }
        loop {
            let event = if !local_eof && source_credit > 0 {
                let read_size = min(
                    MAX_PLAINTEXT_BYTES,
                    usize::try_from(source_credit).unwrap_or(MAX_PLAINTEXT_BYTES),
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
                        open_connection.set_close_reason("outbound-queue-failed");
                        break;
                    }
                    source_sequence += 1;
                }
                ConnectionEvent::Local(Ok(size)) => {
                    ForwardCounters::add(&counters.bytes_from_local, size as u64);
                    source_credit = source_credit.saturating_sub(size as u64);
                    let base = identity.base(&connection_id, source_sequence);
                    let (frame_protection, payload) = match protection.as_deref() {
                        Some(configuration) => match seal_data_payload(
                            configuration,
                            &base,
                            Direction::SourceToDestination,
                            &buffer[..size],
                        ) {
                            Ok(protected) => (Some(protected.0), protected.1),
                            Err(_) => {
                                open_connection.set_close_reason("data-seal-failed");
                                break;
                            }
                        },
                        None => (None, buffer[..size].to_vec()),
                    };
                    if send_source(
                        &outbound,
                        FrameHeader::Data {
                            base,
                            direction: Direction::SourceToDestination,
                            protection: frame_protection,
                        },
                        payload,
                    )
                    .is_err()
                    {
                        open_connection.set_close_reason("outbound-queue-failed");
                        break;
                    }
                    source_sequence += 1;
                }
                ConnectionEvent::Local(Err(_)) => {
                    open_connection.set_close_reason("local-read-failed");
                    break;
                }
                ConnectionEvent::Remote(None) => {
                    open_connection.set_close_reason("route-session-ended");
                    break;
                }
                ConnectionEvent::Remote(Some((header, payload))) => {
                    let base = header.base();
                    if base.sequence != destination_sequence
                        || base.tunnel_id != identity.tunnel_id
                        || base.attachment_id != identity.attachment_id
                        || base.source_endpoint_id != identity.source_endpoint_id
                        || base.destination_endpoint_id != identity.destination_endpoint_id
                        || base.connection_id != connection_id
                    {
                        open_connection.set_close_reason("invalid-remote-frame");
                        break;
                    }
                    destination_sequence += 1;
                    match header {
                        FrameHeader::Accepted {
                            initial_credit_bytes,
                            ..
                        } if payload.is_empty() => {
                            ForwardCounters::add(&counters.destination_accepted, 1);
                            if open_connection.emit_lifecycle_diagnostics {
                                diagnostic_event(
                                    open_connection.app.as_ref(),
                                    "info",
                                    "Desktop tunnel destination accepted the connection",
                                    json!({
                                        "attachmentId": open_connection.attachment_id,
                                        "connectionId": connection_id,
                                        "diagnosticTraceId": open_connection.diagnostic_trace_id,
                                        "event": "desktop.tunnel.destination.accepted",
                                        "operation": "open-destination",
                                        "status": "completed",
                                        "subsystem": "tunnel-forward",
                                        "tunnelId": open_connection.tunnel_id,
                                    }),
                                );
                            }
                            source_credit = min(initial_credit_bytes, MAX_CREDIT_BYTES);
                        }
                        FrameHeader::Data {
                            base,
                            direction: Direction::DestinationToSource,
                            protection: frame_protection,
                        } if !payload.is_empty() => {
                            let plaintext = match open_data_payload(
                                protection.as_deref(),
                                &base,
                                Direction::DestinationToSource,
                                frame_protection.as_ref(),
                                &payload,
                            ) {
                                Ok(plaintext) => plaintext,
                                Err(_) => {
                                    open_connection.set_close_reason("data-auth-failed");
                                    break;
                                }
                            };
                            if writer.write_all(&plaintext).await.is_err() {
                                open_connection.set_close_reason("local-write-failed");
                                break;
                            }
                            ForwardCounters::add(&counters.bytes_to_local, plaintext.len() as u64);
                            if send_source(
                                &outbound,
                                FrameHeader::Credit {
                                    base: identity.base(&connection_id, source_sequence),
                                    direction: Direction::DestinationToSource,
                                    bytes: plaintext.len() as u64,
                                },
                                Vec::new(),
                            )
                            .is_err()
                            {
                                open_connection.set_close_reason("outbound-queue-failed");
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
                        FrameHeader::Rejected { code, .. } => {
                            let wire_reason_code = safe_reason_code(&code);
                            if counters.record_destination_rejection(&code) {
                                diagnostic_event(
                                    open_connection.app.as_ref(),
                                    "warn",
                                    "Desktop tunnel destination rejected the connection",
                                    json!({
                                        "attachmentId": open_connection.attachment_id,
                                        "connectionId": connection_id,
                                        "diagnosticTraceId": open_connection.diagnostic_trace_id,
                                        "event": "desktop.tunnel.destination.rejected",
                                        "operation": "open-destination",
                                        "reasonCode": wire_reason_code,
                                        "status": "rejected",
                                        "subsystem": "tunnel-forward",
                                        "tunnelId": open_connection.tunnel_id,
                                    }),
                                );
                            }
                            open_connection.set_wire_reason_code(&code);
                            open_connection.set_close_reason("destination-rejected");
                            break;
                        }
                        FrameHeader::Close { code, .. } => {
                            open_connection.set_wire_reason_code(&code);
                            open_connection.set_close_reason("destination-closed");
                            break;
                        }
                        FrameHeader::Error { code, .. } => {
                            open_connection.set_wire_reason_code(&code);
                            open_connection.set_close_reason("destination-error");
                            break;
                        }
                        _ => {
                            open_connection.set_close_reason("unexpected-remote-frame");
                            break;
                        }
                    }
                }
            }
        }
        let _ = outbound.try_send((
            FrameHeader::Close {
                base: identity.base(&connection_id, source_sequence),
                code: "normal".into(),
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

    fn frame_payload_is_valid(header: &FrameHeader, payload: &[u8]) -> bool {
        match header {
            FrameHeader::Data { protection, .. } => {
                !payload.is_empty()
                    && payload.len() <= MAX_PAYLOAD_BYTES
                    && match protection {
                        Some(_) => payload.len() > AUTH_TAG_BYTES,
                        None => payload.len() <= MAX_PLAINTEXT_BYTES,
                    }
            }
            _ => payload.is_empty(),
        }
    }

    fn encode_frame(header: &FrameHeader, payload: &[u8]) -> Result<Vec<u8>, String> {
        if !frame_payload_is_valid(header, payload) {
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
        if !frame_payload_is_valid(&header, &payload) {
            return Err("The tunnel frame payload is invalid.".into());
        }
        Ok((header, payload))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::Value;
        use std::io::{BufRead, BufReader, Write};
        use std::path::PathBuf;
        use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio_tungstenite::accept_hdr_async;

        const LARGE_CODE_RESPONSE_BYTES: usize = 16 * 1_024 * 1_024 + 137;

        fn test_data_protection() -> Arc<DataProtection> {
            Arc::new(DataProtection {
                key_revision: 3,
                key: Zeroizing::new(vec![7; 32]),
            })
        }

        fn publish_test_relay_refresh(
            sender: &watch::Sender<Option<Arc<RelayRoute>>>,
            current_expires_at_epoch_ms: Option<u64>,
            relay: RelayTunnelRequest,
        ) -> TunnelRelayRefreshOutcome {
            publish_relay_refresh(
                sender,
                current_expires_at_epoch_ms,
                Arc::new(relay_route(relay).unwrap()),
            )
        }

        struct CodeTransportHarness {
            child: Child,
            input: ChildStdin,
            output: BufReader<ChildStdout>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CodeTransportHarnessReady {
            broker: Value,
            relay_path: String,
            relay_port: u16,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CodeTransportHarnessSnapshot {
            active_streams: usize,
            hanging_request_closed: bool,
            hanging_request_reached: bool,
            observed_requests: Vec<CodeTransportObservedRequest>,
            relay_stats: CodeTransportRelayStats,
            worker_contexts: Vec<Value>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CodeTransportObservedRequest {
            authenticated: bool,
            forwarded_prefix: Option<String>,
            url: String,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CodeTransportRelayStats {
            active_connections: u64,
            closed_connections: u64,
            opened_connections: u64,
            rejected_connections: u64,
        }

        impl CodeTransportHarness {
            fn start(configuration: &Value) -> (Self, CodeTransportHarnessReady) {
                let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .and_then(|path| path.parent())
                    .expect("repository root")
                    .to_path_buf();
                let executable = repository.join("node_modules/.bin/tsx");
                let fixture =
                    repository.join("cantrip_worker/test/fixtures/code-transport-e2e-harness.ts");
                let mut child = Command::new(executable)
                    .arg(fixture)
                    .current_dir(repository)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .expect("start the real worker transport harness");
                let input = child.stdin.take().expect("harness stdin");
                let output = BufReader::new(child.stdout.take().expect("harness stdout"));
                let mut harness = Self {
                    child,
                    input,
                    output,
                };
                harness.send(configuration);
                let ready = harness.read("CANTRIP_CODE_E2E_READY ");
                (harness, ready)
            }

            fn send(&mut self, value: &Value) {
                writeln!(self.input, "{value}").expect("write harness command");
                self.input.flush().expect("flush harness command");
            }

            fn read<T: serde::de::DeserializeOwned>(&mut self, prefix: &str) -> T {
                let mut line = String::new();
                loop {
                    line.clear();
                    let bytes = self
                        .output
                        .read_line(&mut line)
                        .expect("read harness output");
                    assert!(bytes > 0, "transport harness stopped before {prefix}");
                    if let Some(value) = line.strip_prefix(prefix) {
                        return serde_json::from_str(value).expect("valid harness response");
                    }
                    if let Some(value) = line.strip_prefix("CANTRIP_CODE_E2E_FATAL ") {
                        panic!("transport harness failed: {value}");
                    }
                }
            }

            fn snapshot(&mut self) -> CodeTransportHarnessSnapshot {
                self.send(&json!({ "type": "snapshot" }));
                self.read("CANTRIP_CODE_E2E_SNAPSHOT ")
            }

            fn revoke_direct(&mut self, capability_id: &str) {
                self.send(&json!({
                    "type": "revoke-direct",
                    "capabilityId": capability_id,
                }));
                let response: Value = self.read("CANTRIP_CODE_E2E_DIRECT_REVOKED ");
                assert_eq!(response["capabilityId"], capability_id);
                assert_eq!(response["revoked"], true);
            }

            fn shutdown(mut self) -> CodeTransportHarnessSnapshot {
                self.send(&json!({ "type": "shutdown" }));
                let snapshot = self.read("CANTRIP_CODE_E2E_DONE ");
                let status = self.child.wait().expect("wait for harness shutdown");
                assert!(status.success(), "transport harness shutdown failed");
                snapshot
            }
        }

        impl Drop for CodeTransportHarness {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }

        fn direct_binding(
            configuration: &Value,
            capability_id: &str,
        ) -> crate::direct_probe::DirectCapabilityBinding {
            serde_json::from_value(json!({
                "capabilityId": capability_id,
                "ownerId": configuration["ownerId"],
                "authSessionId": "auth-session-e2e",
                "workerId": configuration["workerId"],
                "resourceKind": "tunnel",
                "resourceId": configuration["tunnelId"],
                "attachmentId": configuration["attachmentId"],
                "channels": ["tunnel-data"],
                "expiresAt": configuration["expiresAt"],
                "leaseExpiresAt": configuration["leaseExpiresAt"],
            }))
            .expect("direct capability binding")
        }

        fn direct_identity(configuration: &Value) -> RouteIdentity {
            let client_id = configuration["clientId"].as_str().unwrap();
            let attachment_id = configuration["attachmentId"].as_str().unwrap();
            let worker_id = configuration["workerId"].as_str().unwrap();
            RouteIdentity {
                attachment_id: attachment_id.into(),
                destination_endpoint_id: format!("worker:{worker_id}"),
                source_endpoint_id: format!("desktop:{client_id}:{attachment_id}"),
                tunnel_id: configuration["tunnelId"].as_str().unwrap().into(),
            }
        }

        async fn local_http(local_port: u16, path: &str) -> Vec<u8> {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, local_port))
                .await
                .expect("connect native loopback listener");
            stream
                .write_all(
                    format!(
                        "GET {path} HTTP/1.1\r\nHost: cantrip-code.local\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("write loopback HTTP request");
            let mut response = Vec::new();
            let read = timeout(Duration::from_secs(30), stream.read_to_end(&mut response))
                .await
                .expect("loopback HTTP response deadline");
            if let Err(error) = read {
                assert_eq!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset,
                    "read loopback HTTP response"
                );
            }
            response
        }

        fn assert_large_code_response(response: &[u8]) {
            let header_end = response
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .expect("large response headers")
                + 4;
            let headers = std::str::from_utf8(&response[..header_end])
                .expect("large response headers are UTF-8");
            assert!(headers.starts_with("HTTP/1.1 200"));
            assert!(headers
                .to_ascii_lowercase()
                .contains(&format!("content-length: {LARGE_CODE_RESPONSE_BYTES}")));
            let body = &response[header_end..];
            assert_eq!(body.len(), LARGE_CODE_RESPONSE_BYTES);
            assert!(
                body.iter()
                    .enumerate()
                    .all(|(index, byte)| *byte == (index % 251) as u8),
                "large response bytes must remain complete and ordered"
            );
        }

        #[tokio::test]
        async fn native_loopback_reaches_real_protected_code_route_and_falls_back_to_relay() {
            let tunnel_id = Uuid::new_v4().to_string();
            let attachment_id = Uuid::new_v4().to_string();
            let worker_id = format!("worker-{}", Uuid::new_v4());
            let client_id = format!("client-{}", Uuid::new_v4());
            let owner_id = format!("owner-{}", Uuid::new_v4());
            let session_id = Uuid::new_v4().to_string();
            let good_capability_id = Uuid::new_v4().to_string();
            let bad_capability_id = Uuid::new_v4().to_string();
            let good_diagnostic_trace_id = Uuid::new_v4().to_string();
            let bad_diagnostic_trace_id = Uuid::new_v4().to_string();
            let good_secret = URL_SAFE_NO_PAD.encode([11_u8; 48]);
            let bad_secret = URL_SAFE_NO_PAD.encode([12_u8; 48]);
            let relay_secret = URL_SAFE_NO_PAD.encode([13_u8; 48]);
            let data_key = URL_SAFE_NO_PAD.encode([14_u8; 32]);
            let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let lease_expires_at = (chrono::Utc::now() + chrono::Duration::seconds(60))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let configuration = json!({
                "attachmentId": attachment_id,
                "badCapabilityId": bad_capability_id,
                "badDiagnosticTraceId": bad_diagnostic_trace_id,
                "badSecret": bad_secret,
                "clientId": client_id,
                "dataProtection": {
                    "formatVersion": 1,
                    "algorithm": "AES-256-GCM",
                    "keyRevision": 1,
                    "key": data_key,
                },
                "expiresAt": expires_at,
                "goodCapabilityId": good_capability_id,
                "goodDiagnosticTraceId": good_diagnostic_trace_id,
                "goodSecret": good_secret,
                "leaseExpiresAt": lease_expires_at,
                "ownerId": owner_id,
                "relaySecret": relay_secret,
                "serverId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "sessionId": session_id,
                "tunnelId": tunnel_id,
                "workerId": worker_id,
            });
            let (mut harness, ready) = CodeTransportHarness::start(&configuration);
            let protection = Arc::new(DataProtection {
                key_revision: 1,
                key: Zeroizing::new(vec![14_u8; 32]),
            });

            // The successful direct pass starts at a real native loopback TCP
            // listener and ends at the worker's OpenVSCode-compatible upstream.
            let broker = serde_json::from_value(ready.broker.clone()).unwrap();
            let good_connection = connect_verified(DirectProbeRequest {
                broker,
                binding: direct_binding(&configuration, &good_capability_id),
                secret: good_secret.clone(),
            })
            .await
            .expect("authenticate the production direct broker");
            let direct_listener = Arc::new(bind_listener(None).await.unwrap());
            let direct_port = direct_listener.local_addr().unwrap().port();
            let direct_counters = Arc::new(ForwardCounters::default());
            let (direct_stop, mut direct_stop_receiver) = oneshot::channel();
            let (_direct_control, mut direct_control_receiver) = mpsc::channel(1);
            let direct_task = {
                let listener = direct_listener.clone();
                let counters = direct_counters.clone();
                let protection = protection.clone();
                let identity = direct_identity(&configuration);
                let trace = good_diagnostic_trace_id.clone();
                tokio::spawn(async move {
                    run_session(
                        None,
                        Some(&trace),
                        listener.as_ref(),
                        good_connection.socket,
                        identity,
                        Some(protection),
                        counters,
                        &mut direct_stop_receiver,
                        &mut direct_control_receiver,
                    )
                    .await
                })
            };
            let direct_response = local_http(
                direct_port,
                "/code/?folder=%2Fworker%2Fescape&preserved=direct",
            )
            .await;
            let direct_text = String::from_utf8(direct_response).unwrap();
            assert!(direct_text.starts_with("HTTP/1.1 200"));
            assert!(direct_text.contains("openvscode-compatible-workbench"));
            let direct_large_response = local_http(direct_port, "/code/large").await;
            assert_large_code_response(&direct_large_response);

            // A second in-flight upstream is cancelled by shutting down the
            // native route. This must close both proxy legs and stream state.
            let mut hanging = TcpStream::connect((Ipv4Addr::LOCALHOST, direct_port))
                .await
                .unwrap();
            hanging
                .write_all(
                    b"GET /code/hang HTTP/1.1\r\nHost: cantrip-code.local\r\nConnection: keep-alive\r\n\r\n",
                )
                .await
                .unwrap();
            sleep(Duration::from_millis(200)).await;
            direct_stop.send(()).unwrap();
            assert!(matches!(
                direct_task.await.unwrap().unwrap(),
                SessionOutcome::Stopped
            ));
            let mut cancelled_response = Vec::new();
            timeout(
                Duration::from_secs(5),
                hanging.read_to_end(&mut cancelled_response),
            )
            .await
            .expect("cancelled local connection deadline")
            .expect("cancelled local connection closed");
            direct_counters.wait_for_connections_drained().await;
            assert_eq!(
                direct_counters.connections_opened.load(Ordering::Acquire),
                3
            );
            assert_eq!(
                direct_counters.connections_closed.load(Ordering::Acquire),
                3
            );

            // The second direct capability authenticates successfully but its
            // protected record is deliberately corrupt. The route stays
            // connected, returns the exact safe rejection code, and is then
            // explicitly switched to the production server relay broker.
            let broker = serde_json::from_value(ready.broker.clone()).unwrap();
            let bad_connection = connect_verified(DirectProbeRequest {
                broker,
                binding: direct_binding(&configuration, &bad_capability_id),
                secret: bad_secret.clone(),
            })
            .await
            .expect("authenticate the connected-but-broken direct route");
            let fallback_listener = Arc::new(bind_listener(None).await.unwrap());
            let fallback_port = fallback_listener.local_addr().unwrap().port();
            let fallback_counters = Arc::new(ForwardCounters::default());
            let (_bad_stop, mut bad_stop_receiver) = oneshot::channel();
            let (bad_control, mut bad_control_receiver) = mpsc::channel(1);
            let bad_task = {
                let listener = fallback_listener.clone();
                let counters = fallback_counters.clone();
                let identity = direct_identity(&configuration);
                let protection = protection.clone();
                let trace = bad_diagnostic_trace_id.clone();
                tokio::spawn(async move {
                    run_session(
                        None,
                        Some(&trace),
                        listener.as_ref(),
                        bad_connection.socket,
                        identity,
                        Some(protection),
                        counters,
                        &mut bad_stop_receiver,
                        &mut bad_control_receiver,
                    )
                    .await
                })
            };
            let rejected = local_http(fallback_port, "/code/_cantrip/health").await;
            assert!(rejected.is_empty());
            assert_eq!(
                fallback_counters
                    .destination_rejected
                    .load(Ordering::Acquire),
                1
            );
            assert_eq!(
                fallback_counters
                    .last_destination_rejection_code
                    .lock()
                    .unwrap()
                    .as_deref(),
                Some("protected-record-unavailable")
            );
            assert!(fallback_counters.record_route_fallback());
            let (fallback_completed, fallback_completion) = oneshot::channel();
            bad_control
                .send(RouteControl::ForceRelay {
                    completed: fallback_completed,
                })
                .await
                .unwrap();
            let SessionOutcome::ForceRelay(fallback_completed) = bad_task.await.unwrap().unwrap()
            else {
                panic!("connected broken direct route did not yield to relay")
            };

            let relay_request = StartTunnelForwardRequest {
                attachment_id: attachment_id.clone(),
                client_id: client_id.clone(),
                data_protection: Some(TunnelDataProtectionRequest {
                    format_version: 1,
                    algorithm: "AES-256-GCM".into(),
                    key_revision: 1,
                    key: data_key.clone(),
                }),
                diagnostic_trace_id: Some(bad_diagnostic_trace_id.clone()),
                direct: None,
                expires_at: expires_at.clone(),
                preferred_local_port: None,
                relay: Some(RelayTunnelRequest {
                    connect_path: ready.relay_path.clone(),
                    secret: relay_secret.clone(),
                    secret_expires_at_epoch_ms: u64::MAX,
                    server_url: format!("http://127.0.0.1:{}", ready.relay_port),
                }),
                tunnel_id: tunnel_id.clone(),
            };
            let relay = relay_request.relay.as_ref().unwrap();
            let relay_url = web_socket_url(&relay.server_url, &relay.connect_path).unwrap();
            let (relay_socket, relay_identity) =
                connect_attachment(&relay_url, &relay_secret, &relay_request)
                    .await
                    .expect("connect the production relay broker");
            fallback_completed.send(Ok(())).unwrap();
            assert!(fallback_completion.await.unwrap().is_ok());
            let (relay_stop, mut relay_stop_receiver) = oneshot::channel();
            let (_relay_control, mut relay_control_receiver) = mpsc::channel(1);
            let relay_task = {
                let listener = fallback_listener.clone();
                let counters = fallback_counters.clone();
                let protection = protection.clone();
                let trace = bad_diagnostic_trace_id.clone();
                tokio::spawn(async move {
                    run_session(
                        None,
                        Some(&trace),
                        listener.as_ref(),
                        relay_socket,
                        relay_identity,
                        Some(protection),
                        counters,
                        &mut relay_stop_receiver,
                        &mut relay_control_receiver,
                    )
                    .await
                })
            };
            let relay_response = local_http(
                fallback_port,
                "/code/?workspace=%2Fworker%2Fescape.code-workspace&preserved=relay",
            )
            .await;
            let relay_text = String::from_utf8(relay_response).unwrap();
            assert!(relay_text.starts_with("HTTP/1.1 200"));
            assert!(relay_text.contains("openvscode-compatible-workbench"));
            let relay_large_response = local_http(fallback_port, "/code/large").await;
            assert_large_code_response(&relay_large_response);
            relay_stop.send(()).unwrap();
            assert!(matches!(
                relay_task.await.unwrap().unwrap(),
                SessionOutcome::Stopped
            ));
            fallback_counters.wait_for_connections_drained().await;
            assert_eq!(
                fallback_counters.connections_opened.load(Ordering::Acquire),
                3
            );
            assert_eq!(
                fallback_counters.connections_closed.load(Ordering::Acquire),
                3
            );
            assert_eq!(fallback_counters.route_fallbacks.load(Ordering::Acquire), 1);

            let snapshot = harness.snapshot();
            assert_eq!(snapshot.active_streams, 0);
            assert!(snapshot.hanging_request_reached);
            assert!(snapshot.hanging_request_closed);
            assert!(snapshot.observed_requests.iter().all(|request| {
                request.authenticated && request.forwarded_prefix.as_deref() == Some("/code")
            }));
            assert!(snapshot.observed_requests.iter().any(|request| {
                request.url
                    == "/?preserved=direct&workspace=%2Fworker%2Fprivate%2Fproject.code-workspace"
            }));
            assert!(snapshot.observed_requests.iter().any(|request| {
                request.url
                    == "/?preserved=relay&workspace=%2Fworker%2Fprivate%2Fproject.code-workspace"
            }));
            assert_eq!(snapshot.relay_stats.opened_connections, 2);
            assert_eq!(snapshot.relay_stats.closed_connections, 2);
            assert_eq!(snapshot.relay_stats.active_connections, 0);
            assert_eq!(snapshot.relay_stats.rejected_connections, 0);
            assert!(snapshot.worker_contexts.iter().any(|context| {
                context["event"] == "tunnel.protected-target.rejected"
                    && context["reasonCode"] == "protected-record-open-failed"
                    && context["diagnosticTraceId"] == bad_diagnostic_trace_id
                    && context["tunnelId"] == tunnel_id
            }));
            assert!(snapshot.worker_contexts.iter().any(|context| {
                context["event"] == "code.direct.http-upstream-responded"
                    && context["diagnosticTraceId"] == good_diagnostic_trace_id
                    && context["tunnelId"] == tunnel_id
            }));
            assert!(snapshot.worker_contexts.iter().any(|context| {
                context["event"] == "code.direct.http-upstream-responded"
                    && context["diagnosticTraceId"] == bad_diagnostic_trace_id
                    && context["tunnelId"] == tunnel_id
            }));
            let diagnostics = serde_json::to_string(&snapshot.worker_contexts).unwrap();
            for secret in [&good_secret, &bad_secret, &relay_secret, &data_key] {
                assert!(!diagnostics.contains(secret));
            }
            assert!(!diagnostics.contains("openvscode-e2e-token-must-stay-private"));
            assert!(!diagnostics.contains("/worker/private/project.code-workspace"));
            let final_snapshot = harness.shutdown();
            assert_eq!(final_snapshot.active_streams, 0);
        }

        #[tokio::test]
        async fn native_route_loop_recovers_on_the_same_listener_after_relay_refresh() {
            let tunnel_id = Uuid::new_v4().to_string();
            let attachment_id = Uuid::new_v4().to_string();
            let worker_id = format!("worker-{}", Uuid::new_v4());
            let client_id = format!("client-{}", Uuid::new_v4());
            let owner_id = format!("owner-{}", Uuid::new_v4());
            let session_id = Uuid::new_v4().to_string();
            let good_capability_id = Uuid::new_v4().to_string();
            let bad_capability_id = Uuid::new_v4().to_string();
            let good_diagnostic_trace_id = Uuid::new_v4().to_string();
            let bad_diagnostic_trace_id = Uuid::new_v4().to_string();
            let good_secret = URL_SAFE_NO_PAD.encode([21_u8; 48]);
            let bad_secret = URL_SAFE_NO_PAD.encode([22_u8; 48]);
            let relay_secret = URL_SAFE_NO_PAD.encode([23_u8; 48]);
            let data_key = URL_SAFE_NO_PAD.encode([24_u8; 32]);
            let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let lease_expires_at = (chrono::Utc::now() + chrono::Duration::seconds(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let configuration = json!({
                "attachmentId": attachment_id,
                "badCapabilityId": bad_capability_id,
                "badDiagnosticTraceId": bad_diagnostic_trace_id,
                "badSecret": bad_secret,
                "clientId": client_id,
                "dataProtection": {
                    "formatVersion": 1,
                    "algorithm": "AES-256-GCM",
                    "keyRevision": 1,
                    "key": data_key,
                },
                "expiresAt": expires_at,
                "goodCapabilityId": good_capability_id,
                "goodDiagnosticTraceId": good_diagnostic_trace_id,
                "goodSecret": good_secret,
                "leaseExpiresAt": lease_expires_at,
                "ownerId": owner_id,
                "relaySecret": relay_secret,
                "serverId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "sessionId": session_id,
                "tunnelId": tunnel_id,
                "workerId": worker_id,
            });
            let (mut harness, ready) = CodeTransportHarness::start(&configuration);
            let listener = bind_listener(None).await.unwrap();
            let local_port = listener.local_addr().unwrap().port();
            let counters = Arc::new(ForwardCounters::default());
            let (stop_sender, stop_receiver) = oneshot::channel();
            let (ready_sender, ready_receiver) = oneshot::channel();
            let (relay_refresh_sender, relay_refresh_receiver) = watch::channel(None);
            let (_route_control_sender, route_control_receiver) = mpsc::channel(1);
            let request = StartTunnelForwardRequest {
                attachment_id: attachment_id.clone(),
                client_id: client_id.clone(),
                data_protection: Some(TunnelDataProtectionRequest {
                    format_version: 1,
                    algorithm: "AES-256-GCM".into(),
                    key_revision: 1,
                    key: data_key.clone(),
                }),
                // The relay harness intentionally binds its route to this trace.
                diagnostic_trace_id: Some(bad_diagnostic_trace_id.clone()),
                direct: Some(super::super::DirectTunnelRequest {
                    broker: serde_json::from_value(ready.broker.clone()).unwrap(),
                    binding: direct_binding(&configuration, &good_capability_id),
                    secret: good_secret.clone(),
                    route: super::super::DirectTunnelRoute {
                        tunnel_id: tunnel_id.clone(),
                        attachment_id: attachment_id.clone(),
                        source_endpoint_id: format!("desktop:{client_id}:{attachment_id}"),
                        destination_endpoint_id: format!("worker:{worker_id}"),
                    },
                }),
                expires_at: expires_at.clone(),
                preferred_local_port: None,
                relay: Some(RelayTunnelRequest {
                    connect_path: ready.relay_path.clone(),
                    secret: relay_secret.clone(),
                    secret_expires_at_epoch_ms: unix_epoch_ms().saturating_sub(1),
                    server_url: format!("http://127.0.0.1:{}", ready.relay_port),
                }),
                tunnel_id: tunnel_id.clone(),
            };
            let forward_counters = counters.clone();
            let forward = tokio::spawn(run_forward(
                None,
                listener,
                request,
                forward_counters,
                stop_receiver,
                ready_sender,
                relay_refresh_receiver,
                route_control_receiver,
            ));

            let startup = timeout(Duration::from_secs(5), ready_receiver)
                .await
                .expect("native route startup deadline")
                .expect("native route startup channel")
                .expect("native direct route startup");
            assert_eq!(startup.state, "local-direct");
            let direct_response = local_http(local_port, "/code/?preserved=direct-loop").await;
            assert!(String::from_utf8(direct_response)
                .unwrap()
                .contains("openvscode-compatible-workbench"));
            assert_eq!(
                publish_test_relay_refresh(
                    &relay_refresh_sender,
                    Some(unix_epoch_ms().saturating_sub(1)),
                    RelayTunnelRequest {
                        connect_path: ready.relay_path.clone(),
                        secret: bad_secret.clone(),
                        secret_expires_at_epoch_ms: u64::MAX - 1,
                        server_url: format!("http://127.0.0.1:{}", ready.relay_port),
                    },
                ),
                TunnelRelayRefreshOutcome::Accepted
            );
            assert_eq!(
                publish_test_relay_refresh(
                    &relay_refresh_sender,
                    Some(u64::MAX - 1),
                    RelayTunnelRequest {
                        connect_path: ready.relay_path,
                        secret: relay_secret.clone(),
                        secret_expires_at_epoch_ms: u64::MAX,
                        server_url: format!("http://127.0.0.1:{}", ready.relay_port),
                    },
                ),
                TunnelRelayRefreshOutcome::Accepted
            );
            let direct_response_after_refresh =
                local_http(local_port, "/code/?preserved=direct-after-refresh").await;
            assert!(String::from_utf8(direct_response_after_refresh)
                .unwrap()
                .contains("openvscode-compatible-workbench"));
            assert_eq!(counters.route_state.load(Ordering::Acquire), 1);
            assert_eq!(counters.route_selections.load(Ordering::Acquire), 1);
            harness.revoke_direct(&good_capability_id);

            timeout(Duration::from_secs(5), async {
                while counters.route_state.load(Ordering::Acquire) != 2 {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("refreshed relay restored the native route");

            let relay_response = local_http(local_port, "/code/?preserved=relay-loop").await;
            assert!(String::from_utf8(relay_response)
                .unwrap()
                .contains("openvscode-compatible-workbench"));
            assert_eq!(counters.route_disconnects.load(Ordering::Acquire), 1);
            assert_eq!(counters.route_fallbacks.load(Ordering::Acquire), 1);
            assert_eq!(counters.route_selections.load(Ordering::Acquire), 2);

            stop_sender.send(()).unwrap();
            timeout(Duration::from_secs(5), forward)
                .await
                .expect("native route shutdown deadline")
                .expect("native route task");
            counters.wait_for_connections_drained().await;
            let final_snapshot = harness.shutdown();
            assert_eq!(final_snapshot.active_streams, 0);
            assert!(final_snapshot.observed_requests.iter().any(|request| {
                request.url
                    == "/?preserved=direct-loop&workspace=%2Fworker%2Fprivate%2Fproject.code-workspace"
            }));
            assert!(final_snapshot.observed_requests.iter().any(|request| {
                request.url
                    == "/?preserved=direct-after-refresh&workspace=%2Fworker%2Fprivate%2Fproject.code-workspace"
            }));
            assert!(final_snapshot.observed_requests.iter().any(|request| {
                request.url
                    == "/?preserved=relay-loop&workspace=%2Fworker%2Fprivate%2Fproject.code-workspace"
            }));
        }

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
                protection: None,
            };
            let encoded = encode_frame(&header, &[0, 1, 2, 255]).unwrap();
            let (decoded, payload) = decode_frame(&encoded).unwrap();
            assert_eq!(decoded.base().sequence, 4);
            assert_eq!(payload, vec![0, 1, 2, 255]);
        }

        #[test]
        fn protected_frames_authenticate_the_full_route_binding() {
            let identity = RouteIdentity {
                attachment_id: "attachment".into(),
                destination_endpoint_id: "worker:one".into(),
                source_endpoint_id: "desktop:one:attachment".into(),
                tunnel_id: "tunnel".into(),
            };
            let base = identity.base("connection", 4);
            let configuration = test_data_protection();
            let plaintext = b"private bytes";
            let (protection, ciphertext) = seal_data_payload(
                &configuration,
                &base,
                Direction::SourceToDestination,
                plaintext,
            )
            .unwrap();
            assert_ne!(ciphertext, plaintext);
            assert_eq!(
                open_data_payload(
                    Some(configuration.as_ref()),
                    &base,
                    Direction::SourceToDestination,
                    Some(&protection),
                    &ciphertext,
                )
                .unwrap(),
                plaintext,
            );
            let mut wrong_base = base.clone();
            wrong_base.sequence += 1;
            assert!(open_data_payload(
                Some(configuration.as_ref()),
                &wrong_base,
                Direction::SourceToDestination,
                Some(&protection),
                &ciphertext,
            )
            .is_err());
            let vector_protection = FrameProtection {
                format_version: 1,
                algorithm: "AES-256-GCM".into(),
                key_revision: 3,
                nonce: "CQkJCQkJCQkJCQkJ".into(),
            };
            let vector_ciphertext = URL_SAFE_NO_PAD
                .decode("RPfr583dsxTOFqJVg8rBpqDVEKBB_3Ez7M0m4OcZVNhpfMk")
                .unwrap();
            assert_eq!(
                open_data_payload(
                    Some(configuration.as_ref()),
                    &base,
                    Direction::SourceToDestination,
                    Some(&vector_protection),
                    &vector_ciphertext,
                )
                .unwrap(),
                b"cross-runtime bytes",
            );
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
            let request_bytes = b"GET /hmr HTTP/1.1\r\nHost: localhost\r\n\r\n";
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
                let Message::Text(initialize) = initialize else {
                    panic!("expected an initialize frame")
                };
                let initialize: Value = serde_json::from_str(&initialize).unwrap();
                assert_eq!(
                    initialize["diagnosticTraceId"],
                    "22222222-2222-4222-8222-222222222222"
                );
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

                let data = loop {
                    let message = web_socket.next().await.unwrap().unwrap();
                    if let Message::Binary(data) = message {
                        break data;
                    }
                };
                let (header, payload) = decode_frame(&data).unwrap();
                assert!(!payload
                    .windows(request_bytes.len())
                    .any(|window| window == request_bytes));
                let FrameHeader::Data {
                    base: data_base,
                    direction: Direction::SourceToDestination,
                    protection: frame_protection,
                } = header
                else {
                    panic!("expected protected source data")
                };
                let server_protection = test_data_protection();
                let plaintext = open_data_payload(
                    Some(server_protection.as_ref()),
                    &data_base,
                    Direction::SourceToDestination,
                    frame_protection.as_ref(),
                    &payload,
                )
                .unwrap();
                assert_eq!(plaintext, request_bytes);
                let response_base = FrameBase {
                    sequence: 1,
                    ..base.clone()
                };
                let (response_protection, response_payload) = seal_data_payload(
                    &server_protection,
                    &response_base,
                    Direction::DestinationToSource,
                    &plaintext,
                )
                .unwrap();
                web_socket
                    .send(Message::Binary(
                        encode_frame(
                            &FrameHeader::Data {
                                base: response_base,
                                direction: Direction::DestinationToSource,
                                protection: Some(response_protection),
                            },
                            &response_payload,
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
                data_protection: None,
                diagnostic_trace_id: Some("22222222-2222-4222-8222-222222222222".into()),
                direct: None,
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                preferred_local_port: None,
                relay: Some(crate::tunnel_forward::RelayTunnelRequest {
                    connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                    secret: secret.into(),
                    secret_expires_at_epoch_ms: u64::MAX,
                    server_url: format!("http://127.0.0.1:{server_port}"),
                }),
                tunnel_id: "tunnel".into(),
            };
            let relay = request.relay.as_ref().unwrap();
            let url = web_socket_url(&relay.server_url, &relay.connect_path).unwrap();
            let (web_socket, identity) = connect_attachment(&url, secret, &request).await.unwrap();
            let (stop_sender, mut stop_receiver) = oneshot::channel();
            let (_route_control_sender, mut route_control_receiver) = mpsc::channel(1);
            let counters = Arc::new(ForwardCounters::default());
            let session_counters = counters.clone();
            let session = tokio::spawn(async move {
                run_session(
                    None,
                    None,
                    &listener,
                    web_socket,
                    identity,
                    Some(test_data_protection()),
                    session_counters,
                    &mut stop_receiver,
                    &mut route_control_receiver,
                )
                .await
            });

            let mut local = TcpStream::connect((Ipv4Addr::LOCALHOST, local_port))
                .await
                .unwrap();
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
            assert_eq!(counters.connections_opened.load(Ordering::Relaxed), 1);
            assert_eq!(counters.connections_closed.load(Ordering::Relaxed), 1);
            assert_eq!(counters.opens_queued.load(Ordering::Relaxed), 1);
            assert_eq!(counters.opens_sent.load(Ordering::Relaxed), 1);
            assert_eq!(counters.destination_accepted.load(Ordering::Relaxed), 1);
            assert_eq!(counters.destination_rejected.load(Ordering::Relaxed), 0);
            assert_eq!(
                counters.bytes_from_local.load(Ordering::Relaxed),
                request_bytes.len() as u64,
            );
            assert_eq!(
                counters.bytes_to_local.load(Ordering::Relaxed),
                request_bytes.len() as u64,
            );
        }

        #[tokio::test]
        async fn run_session_drains_rejected_direct_before_fresh_relay_connection() {
            let secret = "test-secret-that-is-long-enough-for-attachment-auth";
            let request_bytes = b"GET /_cantrip/health HTTP/1.1\r\nHost: localhost\r\n\r\n";
            let listener = Arc::new(bind_listener(None).await.unwrap());
            let local_port = listener.local_addr().unwrap().port();
            let counters = Arc::new(ForwardCounters::default());

            let direct_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let direct_port = direct_listener.local_addr().unwrap().port();
            let (direct_connection_sender, direct_connection_receiver) = oneshot::channel();
            let direct_server = tokio::spawn(async move {
                let (stream, _) = direct_listener.accept().await.unwrap();
                let mut web_socket = accept_hdr_async(
                    stream,
                    |_: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
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
                    panic!("expected a direct open frame")
                };
                let (header, _) = decode_frame(&open).unwrap();
                let FrameHeader::Open { base, .. } = header else {
                    panic!("expected a direct open frame")
                };
                direct_connection_sender
                    .send(base.connection_id.clone())
                    .unwrap();
                web_socket
                    .send(Message::Binary(
                        encode_frame(
                            &FrameHeader::Rejected {
                                base: FrameBase {
                                    sequence: 0,
                                    ..base
                                },
                                code: "protected-endpoint-unavailable".into(),
                            },
                            &[],
                        )
                        .unwrap()
                        .into(),
                    ))
                    .await
                    .unwrap();
                while web_socket.next().await.is_some() {}
            });

            let request = StartTunnelForwardRequest {
                attachment_id: "attachment".into(),
                client_id: "client".into(),
                data_protection: None,
                diagnostic_trace_id: None,
                direct: None,
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                preferred_local_port: None,
                relay: Some(crate::tunnel_forward::RelayTunnelRequest {
                    connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                    secret: secret.into(),
                    secret_expires_at_epoch_ms: u64::MAX,
                    server_url: format!("http://127.0.0.1:{direct_port}"),
                }),
                tunnel_id: "tunnel".into(),
            };
            let direct = request.relay.as_ref().unwrap();
            let direct_url = web_socket_url(&direct.server_url, &direct.connect_path).unwrap();
            let (direct_web_socket, direct_identity) =
                connect_attachment(&direct_url, secret, &request)
                    .await
                    .unwrap();
            let (_direct_stop_sender, mut direct_stop_receiver) = oneshot::channel();
            let (route_control_sender, mut route_control_receiver) = mpsc::channel(1);
            let direct_listener = listener.clone();
            let direct_counters = counters.clone();
            let direct_session = tokio::spawn(async move {
                run_session(
                    None,
                    None,
                    direct_listener.as_ref(),
                    direct_web_socket,
                    direct_identity,
                    None,
                    direct_counters,
                    &mut direct_stop_receiver,
                    &mut route_control_receiver,
                )
                .await
            });

            let mut direct_local = TcpStream::connect((Ipv4Addr::LOCALHOST, local_port))
                .await
                .unwrap();
            direct_local.write_all(request_bytes).await.unwrap();
            direct_local.shutdown().await.unwrap();
            let mut rejected_body = Vec::new();
            timeout(
                Duration::from_secs(5),
                direct_local.read_to_end(&mut rejected_body),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(rejected_body.is_empty());
            let direct_connection_id = direct_connection_receiver.await.unwrap();

            assert!(counters.record_route_fallback());
            assert!(!counters.record_route_fallback());
            let (fallback_completed, mut fallback_completion) = oneshot::channel();
            route_control_sender
                .send(RouteControl::ForceRelay {
                    completed: fallback_completed,
                })
                .await
                .unwrap();
            let outcome = direct_session.await.unwrap().unwrap();
            let SessionOutcome::ForceRelay(fallback_completed) = outcome else {
                panic!("expected the direct session to yield for relay fallback")
            };
            assert!(timeout(Duration::from_millis(10), &mut fallback_completion)
                .await
                .is_err());
            direct_server.await.unwrap();
            assert_eq!(counters.connections_opened.load(Ordering::Relaxed), 1);
            assert_eq!(counters.connections_closed.load(Ordering::Relaxed), 1);

            let relay_authenticated = Arc::new(AtomicBool::new(false));
            let relay_authenticated_by_server = relay_authenticated.clone();
            let relay_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let relay_port = relay_listener.local_addr().unwrap().port();
            let (relay_connection_sender, relay_connection_receiver) = oneshot::channel();
            let relay_server = tokio::spawn(async move {
                let (stream, _) = relay_listener.accept().await.unwrap();
                let mut web_socket = accept_hdr_async(
                    stream,
                    |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                     response| {
                        relay_authenticated_by_server.store(
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
                    panic!("expected a relay open frame")
                };
                let (header, _) = decode_frame(&open).unwrap();
                let FrameHeader::Open { base, .. } = header else {
                    panic!("expected a relay open frame")
                };
                relay_connection_sender
                    .send(base.connection_id.clone())
                    .unwrap();
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
                loop {
                    let Some(message) = web_socket.next().await else {
                        break;
                    };
                    let Ok(message) = message else { break };
                    let Message::Binary(frame) = message else {
                        continue;
                    };
                    let (header, payload) = decode_frame(&frame).unwrap();
                    match header {
                        FrameHeader::Data {
                            base, direction, ..
                        } if direction == Direction::SourceToDestination => {
                            web_socket
                                .send(Message::Binary(
                                    encode_frame(
                                        &FrameHeader::Data {
                                            base: FrameBase {
                                                sequence: 1,
                                                ..base
                                            },
                                            direction: Direction::DestinationToSource,
                                            protection: None,
                                        },
                                        &payload,
                                    )
                                    .unwrap()
                                    .into(),
                                ))
                                .await
                                .unwrap();
                        }
                        FrameHeader::HalfClose { base, .. } => {
                            web_socket
                                .send(Message::Binary(
                                    encode_frame(
                                        &FrameHeader::HalfClose {
                                            base: FrameBase {
                                                sequence: 2,
                                                ..base
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
                        }
                        _ => {}
                    }
                }
            });

            let relay_request = StartTunnelForwardRequest {
                relay: Some(crate::tunnel_forward::RelayTunnelRequest {
                    server_url: format!("http://127.0.0.1:{relay_port}"),
                    ..request.relay.unwrap()
                }),
                ..request
            };
            let relay = relay_request.relay.as_ref().unwrap();
            let relay_url = web_socket_url(&relay.server_url, &relay.connect_path).unwrap();
            let (relay_web_socket, relay_identity) =
                connect_attachment(&relay_url, secret, &relay_request)
                    .await
                    .unwrap();
            assert!(relay_authenticated.load(Ordering::SeqCst));
            fallback_completed.send(Ok(())).unwrap();
            assert!(fallback_completion.await.unwrap().is_ok());

            let (relay_stop_sender, mut relay_stop_receiver) = oneshot::channel();
            let (_relay_control_sender, mut relay_control_receiver) = mpsc::channel(1);
            let relay_listener = listener.clone();
            let relay_counters = counters.clone();
            let relay_session = tokio::spawn(async move {
                run_session(
                    None,
                    None,
                    relay_listener.as_ref(),
                    relay_web_socket,
                    relay_identity,
                    None,
                    relay_counters,
                    &mut relay_stop_receiver,
                    &mut relay_control_receiver,
                )
                .await
            });
            let mut relay_local = TcpStream::connect((Ipv4Addr::LOCALHOST, local_port))
                .await
                .unwrap();
            relay_local.write_all(request_bytes).await.unwrap();
            relay_local.shutdown().await.unwrap();
            let mut response = Vec::new();
            timeout(
                Duration::from_secs(5),
                relay_local.read_to_end(&mut response),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(response, request_bytes);
            let relay_connection_id = relay_connection_receiver.await.unwrap();
            assert_ne!(relay_connection_id, direct_connection_id);
            assert_eq!(counters.route_fallbacks.load(Ordering::Relaxed), 1);
            let _ = relay_stop_sender.send(());
            assert!(matches!(
                relay_session.await.unwrap().unwrap(),
                SessionOutcome::Stopped
            ));
            relay_server.await.unwrap();
            assert_eq!(counters.connections_opened.load(Ordering::Relaxed), 2);
            assert_eq!(counters.connections_closed.load(Ordering::Relaxed), 2);
        }

        #[test]
        fn diagnostic_reason_codes_allow_only_short_stable_tokens() {
            assert_eq!(safe_reason_code("target-rejected"), "target-rejected");
            assert_eq!(safe_reason_code("normal"), "normal");
            assert_eq!(
                safe_reason_code("protected-target-invalid"),
                "protected-target-invalid"
            );
            assert_eq!(
                safe_reason_code("protected-record-unavailable"),
                "protected-record-unavailable"
            );
            assert_eq!(
                safe_reason_code("protected-endpoint-unavailable"),
                "protected-endpoint-unavailable"
            );
            assert_eq!(safe_reason_code("close_unsafe"), "unknown-code");
            assert_eq!(safe_reason_code("contains a path"), "unknown-code");
            assert_eq!(safe_reason_code(&"x".repeat(65)), "unknown-code");
            assert_eq!(safe_reason_code("SuperSecretToken123456"), "unknown-code");
        }

        #[test]
        fn native_diagnostics_strip_capability_material() {
            let mut context = json!({
                "attachmentId": "attachment",
                "capabilityId": "capability",
                "directCapabilityId": "direct-capability",
            });

            strip_capability_material(&mut context);

            assert_eq!(context.get("attachmentId"), Some(&json!("attachment")));
            assert!(context.get("capabilityId").is_none());
            assert!(context.get("directCapabilityId").is_none());
        }

        #[test]
        fn route_connect_failure_diagnostics_are_bounded_and_secret_free() {
            assert_eq!(
                route_connect_failure_reason_code("The tunnel attachment credential expired."),
                "relay-credential-expired"
            );
            assert_eq!(
                route_connect_failure_reason_code("Connecting the tunnel attachment timed out."),
                "connect-timeout"
            );
            assert_eq!(
                route_connect_failure_reason_code("The tunnel attachment handshake timed out."),
                "handshake-timeout"
            );
            assert_eq!(
                route_connect_failure_reason_code(
                    "The tunnel attachment handshake identity did not match."
                ),
                "handshake-failed"
            );
            assert_eq!(
                route_connect_failure_reason_code(
                    "unexpected failure containing super-secret-direct-material"
                ),
                "connect-failed"
            );

            let request = StartTunnelForwardRequest {
                attachment_id: "attachment".into(),
                client_id: "client".into(),
                data_protection: Some(TunnelDataProtectionRequest {
                    format_version: 1,
                    algorithm: "AES-256-GCM".into(),
                    key_revision: 1,
                    key: "super-secret-content-key".into(),
                }),
                diagnostic_trace_id: Some("trace".into()),
                direct: None,
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                preferred_local_port: None,
                relay: None,
                tunnel_id: "tunnel".into(),
            };
            let relay = RelayRoute {
                expires_at_epoch_ms: 1_000,
                secret: Zeroizing::new("super-secret-relay-credential".into()),
                url: Url::parse("wss://cantrip.invalid/api/tunnel-attachments/attachment/connect")
                    .unwrap(),
            };
            assert_eq!(relay_credential_state(Some(&relay), 999), "valid");
            assert_eq!(relay_credential_state(Some(&relay), 1_000), "expired");
            assert_eq!(relay_credential_state(None, 1_000), "unavailable");

            let mut context = route_connect_failure_context(
                &request,
                Some(&relay),
                "The tunnel attachment credential expired.",
                3,
                Duration::from_secs(2),
                1_000,
            );
            strip_capability_material(&mut context);

            assert_eq!(
                context,
                json!({
                    "attachmentId": "attachment",
                    "attempt": 3,
                    "diagnosticTraceId": "trace",
                    "event": "desktop.tunnel.route.connect-failed",
                    "operation": "connect-route",
                    "reasonCode": "relay-credential-expired",
                    "relayCredentialState": "expired",
                    "retryDelayMs": 2_000,
                    "routeCandidate": "relay",
                    "status": "retrying",
                    "subsystem": "tunnel-forward",
                    "tunnelId": "tunnel",
                })
            );
            let encoded = context.to_string();
            assert!(!encoded.contains("super-secret"));
            assert!(!encoded.contains("cantrip.invalid"));
            assert!(!encoded.contains("authorization"));
            assert!(!encoded.contains("capabilityId"));
        }

        #[test]
        fn diagnostic_connection_events_and_rejections_are_bounded() {
            let counters = ForwardCounters::default();

            assert!(counters.register_connection("connection-1"));
            assert!(!counters.register_connection("connection-2"));
            assert!(counters.is_first_diagnostic_connection("connection-1"));
            assert!(!counters.is_first_diagnostic_connection("connection-2"));
            assert!(counters.record_destination_rejection("protected-record-unavailable"));
            assert!(!counters.record_destination_rejection("protected-endpoint-unavailable"));
            assert_eq!(
                counters
                    .last_destination_rejection_code
                    .lock()
                    .unwrap()
                    .as_deref(),
                Some("protected-endpoint-unavailable")
            );
            assert!(counters.record_route_disconnect());
            assert!(!counters.record_route_disconnect());
            assert!(counters.record_route_selection());
            assert!(!counters.record_route_selection());
            assert!(counters.record_route_fallback());
            assert!(!counters.record_route_fallback());
            assert_eq!(counters.route_fallbacks.load(Ordering::Relaxed), 1);
            counters.cancel_route_fallback();
            assert!(!counters.fallback_requested.load(Ordering::Relaxed));
            assert_eq!(counters.route_fallbacks.load(Ordering::Relaxed), 0);
            assert!(counters.record_route_fallback());
        }

        #[tokio::test]
        async fn pending_relay_refresh_is_replaced_by_latest() {
            let (sender, mut receiver) = watch::channel(None);
            let refresh = |secret: char, expires_at_epoch_ms| RelayTunnelRequest {
                connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                secret: secret.to_string().repeat(32),
                secret_expires_at_epoch_ms: expires_at_epoch_ms,
                server_url: "https://cantrip.example".into(),
            };

            assert_eq!(
                publish_test_relay_refresh(&sender, None, refresh('a', 1_000)),
                TunnelRelayRefreshOutcome::Accepted
            );
            assert_eq!(
                publish_test_relay_refresh(&sender, Some(1_000), refresh('b', 2_000)),
                TunnelRelayRefreshOutcome::Accepted
            );

            let latest = receiver.borrow_and_update().clone().unwrap();
            assert_eq!(latest.expires_at_epoch_ms, 2_000);
            assert_eq!(latest.secret.as_str(), "b".repeat(32));
        }

        #[test]
        fn older_relay_refresh_cannot_replace_a_newer_publication() {
            let (sender, mut receiver) = watch::channel(None);
            let refresh = |secret: char, expires_at_epoch_ms| RelayTunnelRequest {
                connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                secret: secret.to_string().repeat(32),
                secret_expires_at_epoch_ms: expires_at_epoch_ms,
                server_url: "https://cantrip.example".into(),
            };

            assert_eq!(
                publish_test_relay_refresh(&sender, Some(1_000), refresh('n', 3_000)),
                TunnelRelayRefreshOutcome::Accepted
            );
            assert_eq!(
                publish_test_relay_refresh(&sender, Some(3_000), refresh('o', 2_000)),
                TunnelRelayRefreshOutcome::Stale
            );

            let latest = receiver.borrow_and_update().clone().unwrap();
            assert_eq!(latest.expires_at_epoch_ms, 3_000);
            assert_eq!(latest.secret.as_str(), "n".repeat(32));
        }

        #[tokio::test]
        async fn relay_refresh_cancels_a_stalled_degraded_connect() {
            struct ConnectDrop(Arc<AtomicBool>);

            impl Drop for ConnectDrop {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Release);
                }
            }

            let (relay_sender, relay_receiver) = watch::channel(None);
            let (_stop_sender, stop_receiver) = oneshot::channel();
            let (started_sender, started_receiver) = oneshot::channel();
            let connect_dropped = Arc::new(AtomicBool::new(false));
            let connect_drop = connect_dropped.clone();
            let waiting = tokio::spawn(async move {
                let mut relay_receiver = relay_receiver;
                let mut stop_receiver = stop_receiver;
                let stalled = async move {
                    let _drop = ConnectDrop(connect_drop);
                    let _ = started_sender.send(());
                    std::future::pending::<()>().await;
                };
                let outcome =
                    connect_relay_until_refresh(stalled, &mut relay_receiver, &mut stop_receiver)
                        .await;
                (outcome, relay_receiver)
            });
            started_receiver.await.unwrap();

            assert_eq!(
                publish_test_relay_refresh(
                    &relay_sender,
                    None,
                    RelayTunnelRequest {
                        connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                        secret: "n".repeat(32),
                        secret_expires_at_epoch_ms: 2_000,
                        server_url: "https://cantrip.example".into(),
                    },
                ),
                TunnelRelayRefreshOutcome::Accepted
            );

            let (outcome, mut relay_receiver) = timeout(Duration::from_millis(250), waiting)
                .await
                .expect("refresh interrupted the stalled connect")
                .unwrap();
            assert!(matches!(outcome, RelayConnectOutcome::Refreshed));
            assert!(connect_dropped.load(Ordering::Acquire));
            assert_eq!(
                relay_receiver
                    .borrow_and_update()
                    .as_ref()
                    .unwrap()
                    .secret
                    .as_str(),
                "n".repeat(32)
            );
        }

        #[tokio::test]
        async fn active_session_drops_a_superseded_relay_without_restarting() {
            let initial = Arc::new(
                relay_route(RelayTunnelRequest {
                    connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                    secret: "i".repeat(32),
                    secret_expires_at_epoch_ms: 1_000,
                    server_url: "https://cantrip.example".into(),
                })
                .unwrap(),
            );
            let initial_weak = Arc::downgrade(&initial);
            let (relay_sender, relay_receiver) = watch::channel(None);
            let (session_stop_sender, session_stop_receiver) = oneshot::channel();
            let session = tokio::spawn(async move {
                let mut relay = Some(initial);
                let mut relay_receiver = relay_receiver;
                let result = run_session_with_relay_refresh(
                    session_stop_receiver,
                    &mut relay,
                    &mut relay_receiver,
                )
                .await;
                (result, relay)
            });

            assert_eq!(
                publish_test_relay_refresh(
                    &relay_sender,
                    Some(1_000),
                    RelayTunnelRequest {
                        connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                        secret: "r".repeat(32),
                        secret_expires_at_epoch_ms: 2_000,
                        server_url: "https://cantrip.example".into(),
                    },
                ),
                TunnelRelayRefreshOutcome::Accepted
            );
            timeout(Duration::from_millis(250), async {
                while initial_weak.upgrade().is_some() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the superseded relay route was dropped");
            assert!(!session.is_finished(), "the active session stayed mounted");

            session_stop_sender.send(()).unwrap();
            let (result, relay) = session.await.unwrap();
            assert!(result.is_ok());
            assert_eq!(relay.unwrap().secret.as_str(), "r".repeat(32));
        }

        #[test]
        fn relay_refresh_reports_a_closed_forward() {
            let (sender, receiver) = watch::channel(None);
            drop(receiver);

            let result = publish_test_relay_refresh(
                &sender,
                None,
                RelayTunnelRequest {
                    connect_path: "/api/tunnel-attachments/attachment/connect".into(),
                    secret: "s".repeat(32),
                    secret_expires_at_epoch_ms: 2_000,
                    server_url: "https://cantrip.example".into(),
                },
            );

            assert_eq!(result, TunnelRelayRefreshOutcome::ForwardUnavailable);
        }

        #[test]
        fn direct_retirement_confirmation_cannot_clear_a_replacement_capability() {
            let mut summary = TunnelForwardSummary {
                attachment_id: "attachment".into(),
                diagnostic_trace_id: None,
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                local_host: "127.0.0.1",
                local_port: 41_234,
                route_state: "relayed",
                relay_fallback_available: true,
                relay_credential_expires_at_epoch_ms: Some(u64::MAX),
                direct_capability_id: Some("replacement-capability".into()),
                direct_fallback_reason: Some("connected-route-unusable".into()),
                last_destination_rejection_code: Some("protected-record-unavailable".into()),
                tunnel_id: "tunnel".into(),
                bytes_from_local: 0,
                bytes_to_local: 0,
                connections_closed: 0,
                connections_opened: 0,
                destination_rejected_count: 1,
            };

            assert!(!confirm_direct_retired_summary(
                &mut summary,
                "stale-capability"
            ));
            assert_eq!(
                summary.direct_capability_id.as_deref(),
                Some("replacement-capability")
            );
            assert!(confirm_direct_retired_summary(
                &mut summary,
                "replacement-capability"
            ));
            assert!(summary.direct_capability_id.is_none());
        }

        #[tokio::test]
        async fn terminal_snapshot_waits_for_aborted_connection_drop_accounting() {
            let counters = Arc::new(ForwardCounters::default());
            assert!(counters.register_connection("connection-1"));
            let connection = OpenConnection::new(
                None,
                "attachment".into(),
                "connection-1".into(),
                counters.clone(),
                None,
                true,
                "tunnel".into(),
            );
            let task = tokio::spawn(async move {
                let _connection = connection;
                std::future::pending::<()>().await;
            });
            tokio::task::yield_now().await;

            task.abort();
            let _ = task.await;
            counters.wait_for_connections_drained().await;

            assert_eq!(counters.connections_opened.load(Ordering::Acquire), 1);
            assert_eq!(counters.connections_closed.load(Ordering::Acquire), 1);
        }
    }
}
