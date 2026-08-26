use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

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
    #[serde(default)]
    pub code_pool_generation: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareWorkerLinkTunnelForwardRequest {
    pub attachment_id: String,
    pub data_protection: TunnelDataProtectionRequest,
    pub diagnostic_trace_id: Option<String>,
    pub expires_at: String,
    pub preferred_local_port: Option<u16>,
    pub tunnel_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerLinkTunnelBridge {
    pub token: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerLinkTunnelForwardPreparation {
    pub bridge: WorkerLinkTunnelBridge,
    pub forward: TunnelForwardSummary,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeTransportPoolIdentity {
    pub account_id: Option<String>,
    pub client_identity_generation: u64,
    pub client_identity_incarnation_id: String,
    pub connection_id: Option<String>,
    pub protected_key_revision: u64,
    pub security_scope_id: String,
    pub server_control_plane_generation: String,
    pub server_id: String,
    pub server_url: String,
    pub transport_id: String,
    pub user_id: String,
    pub worker_id: String,
    pub worker_process_generation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeTransportClientIdentity {
    pub account_id: Option<String>,
    pub client_identity_incarnation_id: String,
    pub connection_id: Option<String>,
    pub server_id: String,
    pub server_url: String,
    pub user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireCodeTransportForwardRequest {
    pub acquisition_id: String,
    pub consumer_id: String,
    pub identity: CodeTransportPoolIdentity,
    pub window_instance_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state")]
pub enum CodeTransportForwardAcquisition {
    #[serde(rename = "leader")]
    Leader {
        generation: String,
        #[serde(rename = "reservationId")]
        reservation_id: String,
    },
    #[serde(rename = "waiting")]
    Waiting { generation: String },
    #[serde(rename = "ready")]
    Ready {
        forward: TunnelForwardSummary,
        generation: String,
        #[serde(rename = "leaseId")]
        lease_id: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeTransportForwardCompletion {
    pub forward: TunnelForwardSummary,
    pub generation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeTransportForwardRelease {
    pub released: bool,
    pub remaining_leases: usize,
    pub stopped: Option<TunnelForwardTerminalSnapshot>,
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
    pub code_pool_generation: Option<String>,
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

const TUNNEL_FORWARD_TERMINAL_EVENT: &str = "cantrip-tunnel-forward-terminal";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelForwardTerminalEvent {
    attachment_id: String,
    diagnostic_trace_id: Option<String>,
    reason_code: &'static str,
    tunnel_id: String,
}

pub struct TunnelForwards {
    #[cfg(desktop)]
    forwards: Mutex<HashMap<String, desktop::ForwardHandle>>,
    #[cfg(desktop)]
    forward_starts: Mutex<HashMap<String, Option<String>>>,
    #[cfg(desktop)]
    code_pool: Mutex<desktop::CodeTransportPool>,
    #[cfg(desktop)]
    invalidated_code_client_identities: Mutex<HashSet<CodeTransportClientIdentity>>,
    #[cfg(desktop)]
    code_windows: Mutex<HashMap<String, String>>,
    #[cfg(desktop)]
    retired_code_window_instances: Mutex<HashSet<String>>,
    #[cfg(mobile)]
    _unavailable: Mutex<()>,
}

impl Default for TunnelForwards {
    fn default() -> Self {
        Self {
            #[cfg(desktop)]
            forwards: Mutex::new(HashMap::new()),
            #[cfg(desktop)]
            forward_starts: Mutex::new(HashMap::new()),
            #[cfg(desktop)]
            code_pool: Mutex::new(desktop::CodeTransportPool::default()),
            #[cfg(desktop)]
            invalidated_code_client_identities: Mutex::new(HashSet::new()),
            #[cfg(desktop)]
            code_windows: Mutex::new(HashMap::new()),
            #[cfg(desktop)]
            retired_code_window_instances: Mutex::new(HashSet::new()),
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
        #[cfg(desktop)]
        if let Ok(mut starts) = self.forward_starts.lock() {
            starts.clear();
        }
        #[cfg(desktop)]
        if let Ok(mut pool) = self.code_pool.lock() {
            pool.clear();
        }
        #[cfg(desktop)]
        if let Ok(mut invalidated) = self.invalidated_code_client_identities.lock() {
            invalidated.clear();
        }
        #[cfg(desktop)]
        if let Ok(mut windows) = self.code_windows.lock() {
            windows.clear();
        }
        #[cfg(desktop)]
        if let Ok(mut retired) = self.retired_code_window_instances.lock() {
            retired.clear();
        }
    }
}

#[tauri::command]
pub async fn register_code_transport_window_instance(
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    window_instance_id: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let app = window.app_handle().clone();
        let window_label = window.label().to_string();
        let retired = desktop::register_code_transport_window_instance(
            &state,
            &window_label,
            &window_instance_id,
        )?;
        if let Some(retired) = retired {
            desktop::release_code_transport_window(&app, &state, &window_label, &retired).await;
        }
        return Ok(());
    }
    #[cfg(mobile)]
    {
        let _ = (window, state, window_instance_id);
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn invalidate_code_transport_pool(
    app: AppHandle,
    state: State<'_, TunnelForwards>,
    identity: CodeTransportClientIdentity,
) -> Result<(), String> {
    #[cfg(desktop)]
    return desktop::invalidate_code_transport_pool(&app, &state, &identity).await;
    #[cfg(mobile)]
    {
        let _ = (app, state, identity);
        Err("Shared Code transports are only available in the desktop app.".into())
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
pub async fn prepare_worker_link_tunnel_forward(
    app: AppHandle,
    state: State<'_, TunnelForwards>,
    request: PrepareWorkerLinkTunnelForwardRequest,
) -> Result<WorkerLinkTunnelForwardPreparation, String> {
    #[cfg(desktop)]
    return desktop::prepare_worker_link(&app, &state, request).await;
    #[cfg(mobile)]
    {
        let _ = (app, state, request);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn update_worker_link_tunnel_forward_route(
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
    attachment_id: String,
    route: String,
) -> Result<bool, String> {
    #[cfg(desktop)]
    return desktop::update_worker_link_route(&state, &tunnel_id, &attachment_id, &route);
    #[cfg(mobile)]
    {
        let _ = (state, tunnel_id, attachment_id, route);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn refresh_worker_link_tunnel_forward(
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
    attachment_id: String,
    expires_at: String,
) -> Result<bool, String> {
    #[cfg(desktop)]
    return desktop::refresh_worker_link_forward(&state, &tunnel_id, &attachment_id, &expires_at);
    #[cfg(mobile)]
    {
        let _ = (state, tunnel_id, attachment_id, expires_at);
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn acquire_code_transport_forward(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    request: AcquireCodeTransportForwardRequest,
) -> Result<CodeTransportForwardAcquisition, String> {
    #[cfg(desktop)]
    return desktop::acquire_code_transport_forward(&app, &state, window.label(), request);
    #[cfg(mobile)]
    {
        let _ = (app, window, state, request);
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn claim_code_transport_maintenance(
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    transport_id: String,
    generation: String,
    lease_id: String,
    window_instance_id: String,
) -> Result<Option<TunnelForwardSummary>, String> {
    #[cfg(desktop)]
    return desktop::claim_code_transport_maintenance(
        &state,
        window.label(),
        &transport_id,
        &generation,
        &lease_id,
        &window_instance_id,
    );
    #[cfg(mobile)]
    {
        let _ = (
            window,
            state,
            transport_id,
            generation,
            lease_id,
            window_instance_id,
        );
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn wait_code_transport_forward(
    state: State<'_, TunnelForwards>,
    transport_id: String,
    generation: String,
) -> Result<bool, String> {
    #[cfg(desktop)]
    return desktop::wait_code_transport_forward(&state, &transport_id, &generation).await;
    #[cfg(mobile)]
    {
        let _ = (state, transport_id, generation);
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn complete_code_transport_forward(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    transport_id: String,
    generation: String,
    reservation_id: String,
    window_instance_id: String,
    mut request: StartTunnelForwardRequest,
) -> Result<CodeTransportForwardCompletion, String> {
    #[cfg(desktop)]
    {
        request.code_pool_generation = Some(generation.clone());
        return desktop::complete_code_transport_forward(
            &app,
            &state,
            window.label(),
            &transport_id,
            &generation,
            &reservation_id,
            &window_instance_id,
            request,
        )
        .await;
    }
    #[cfg(mobile)]
    {
        let _ = (
            app,
            window,
            state,
            transport_id,
            generation,
            reservation_id,
            window_instance_id,
            request,
        );
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn publish_code_transport_forward(
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    transport_id: String,
    generation: String,
    reservation_id: String,
    window_instance_id: String,
) -> Result<CodeTransportForwardAcquisition, String> {
    #[cfg(desktop)]
    return desktop::publish_code_transport_forward(
        &state,
        window.label(),
        &transport_id,
        &generation,
        &reservation_id,
        &window_instance_id,
    );
    #[cfg(mobile)]
    {
        let _ = (
            window,
            state,
            transport_id,
            generation,
            reservation_id,
            window_instance_id,
        );
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub fn reconcile_code_transport_forward(
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    acquisition_id: String,
    consumer_id: String,
    transport_id: String,
    generation: String,
    reservation_id: String,
    window_instance_id: String,
) -> Result<Option<CodeTransportForwardAcquisition>, String> {
    #[cfg(desktop)]
    return desktop::reconcile_code_transport_forward(
        &state,
        window.label(),
        &acquisition_id,
        &consumer_id,
        &transport_id,
        &generation,
        &reservation_id,
        &window_instance_id,
    );
    #[cfg(mobile)]
    {
        let _ = (
            window,
            state,
            acquisition_id,
            consumer_id,
            transport_id,
            generation,
            reservation_id,
            window_instance_id,
        );
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn fail_code_transport_forward(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    transport_id: String,
    generation: String,
    reservation_id: String,
    window_instance_id: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    return desktop::fail_code_transport_forward(
        &app,
        &state,
        window.label(),
        &transport_id,
        &generation,
        &reservation_id,
        Some(&window_instance_id),
    )
    .await;
    #[cfg(mobile)]
    {
        let _ = (
            app,
            window,
            state,
            transport_id,
            generation,
            reservation_id,
            window_instance_id,
        );
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn release_code_transport_forward(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, TunnelForwards>,
    transport_id: String,
    generation: String,
    lease_id: String,
    window_instance_id: String,
) -> Result<CodeTransportForwardRelease, String> {
    #[cfg(desktop)]
    desktop::validate_code_transport_window_instance(&state, window.label(), &window_instance_id)?;
    return desktop::release_code_transport_forward(
        &app,
        &state,
        &transport_id,
        &generation,
        &lease_id,
    )
    .await;
    #[cfg(mobile)]
    {
        let _ = (
            app,
            window,
            state,
            transport_id,
            generation,
            lease_id,
            window_instance_id,
        );
        Err("Shared Code transports are only available in the desktop app.".into())
    }
}

#[cfg(desktop)]
pub async fn desktop_release_code_transport_window(
    app: &AppHandle,
    state: &TunnelForwards,
    window_label: &str,
    window_instance_id: &str,
) {
    desktop::release_code_transport_window(app, state, window_label, window_instance_id).await;
}

#[cfg(desktop)]
pub fn desktop_retire_code_transport_window(
    state: &TunnelForwards,
    window_label: &str,
) -> Option<String> {
    desktop::retire_code_transport_window_instance(state, window_label)
}

#[tauri::command]
pub async fn stop_tunnel_forward(
    app: AppHandle,
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
    expected_attachment_id: Option<String>,
    expected_diagnostic_trace_id: Option<String>,
    expected_direct_capability_id: Option<String>,
    terminal_reason_code: Option<String>,
) -> Result<Option<TunnelForwardTerminalSnapshot>, String> {
    #[cfg(desktop)]
    let reason = match terminal_reason_code.as_deref() {
        Some("attachment-invalidated") => "attachment-invalidated",
        _ => "requested",
    };
    #[cfg(desktop)]
    return desktop::stop(
        &app,
        &state,
        &tunnel_id,
        expected_attachment_id.as_deref(),
        expected_diagnostic_trace_id.as_deref(),
        expected_direct_capability_id.as_deref(),
        None,
        reason,
    )
    .await;
    #[cfg(mobile)]
    {
        let _ = (
            app,
            state,
            tunnel_id,
            expected_attachment_id,
            expected_diagnostic_trace_id,
            expected_direct_capability_id,
            terminal_reason_code,
        );
        Err("Local tunnel attachments are only available in the desktop app.".into())
    }
}

#[tauri::command]
pub async fn force_tunnel_forward_relay(
    app: AppHandle,
    state: State<'_, TunnelForwards>,
    tunnel_id: String,
    direct_capability_id: Option<String>,
) -> Result<Option<TunnelForwardSummary>, String> {
    #[cfg(desktop)]
    {
        let direct_capability_id = direct_capability_id.ok_or_else(|| {
            "The desktop tunnel capability identity is required for relay fallback.".to_string()
        })?;
        return desktop::force_relay(&app, &state, &tunnel_id, &direct_capability_id).await;
    }
    #[cfg(mobile)]
    {
        let _ = (app, state, tunnel_id, direct_capability_id);
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
        AcquireCodeTransportForwardRequest, CodeTransportClientIdentity,
        CodeTransportForwardAcquisition, CodeTransportForwardCompletion,
        CodeTransportForwardRelease, CodeTransportPoolIdentity,
        PrepareWorkerLinkTunnelForwardRequest, RelayTunnelRequest, StartTunnelForwardRequest,
        TunnelDataProtectionRequest, TunnelForwardSummary, TunnelForwardTerminalEvent,
        TunnelForwardTerminalSnapshot, TunnelForwards, TunnelRelayRefreshOutcome,
        TunnelRelayRefreshResult, WorkerLinkTunnelBridge, WorkerLinkTunnelForwardPreparation,
        TUNNEL_FORWARD_TERMINAL_EVENT,
    };
    use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use std::cmp::min;
    use std::collections::{HashMap, HashSet};
    use std::convert::TryFrom;
    use std::future::Future;
    use std::net::{Ipv4Addr, SocketAddr};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::async_runtime::JoinHandle as TauriJoinHandle;
    use tauri::{AppHandle, Emitter, Manager, State};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot, watch, Notify};
    use tokio::task::{AbortHandle, JoinHandle};
    use tokio::time::{interval_at, sleep, timeout, Instant, Sleep};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue};
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::{accept_async_with_config, connect_async};
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
    const CONNECTION_CANCEL_TIMEOUT: Duration = Duration::from_secs(1);
    const RELAY_FALLBACK_TIMEOUT: Duration = Duration::from_secs(5);
    const SESSION_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
    const SESSION_PONG_TIMEOUT: Duration = Duration::from_secs(10);
    const SESSION_SEND_TIMEOUT: Duration = Duration::from_secs(10);
    const CODE_TRANSPORT_RESERVATION_TIMEOUT: Duration = Duration::from_secs(30);
    const CODE_TRANSPORT_MAINTENANCE_LEASE: Duration = Duration::from_secs(15);
    const CODE_TRANSPORT_TERMINAL_RETENTION: Duration = Duration::from_secs(10 * 60);
    const MAX_TERMINATED_CODE_TRANSPORTS: usize = 256;
    const WORKER_LINK_BRIDGE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
    const WORKER_LINK_BRIDGE_MAX_INVALID_ATTEMPTS: usize = 8;
    const WORKER_LINK_BRIDGE_INVALID_BACKOFF: Duration = Duration::from_secs(1);

    pub struct ForwardHandle {
        code_pool_generation: Option<String>,
        counters: Arc<ForwardCounters>,
        relay_refresh: watch::Sender<Option<Arc<RelayRoute>>>,
        route_control: mpsc::Sender<RouteControl>,
        pub stop: Option<oneshot::Sender<()>>,
        summary: TunnelForwardSummary,
        pub task: TauriJoinHandle<()>,
    }

    struct ForwardStartReservation<'a> {
        code_pool_generation: Option<String>,
        state: &'a TunnelForwards,
        tunnel_id: String,
    }

    impl Drop for ForwardStartReservation<'_> {
        fn drop(&mut self) {
            if let Ok(mut starts) = self.state.forward_starts.lock() {
                if starts.get(&self.tunnel_id) == Some(&self.code_pool_generation) {
                    starts.remove(&self.tunnel_id);
                }
            }
        }
    }

    fn reserve_forward_start<'a>(
        state: &'a TunnelForwards,
        tunnel_id: &str,
        code_pool_generation: Option<&str>,
    ) -> Result<ForwardStartReservation<'a>, String> {
        let mut starts = state
            .forward_starts
            .lock()
            .map_err(|_| "The local tunnel startup registry is unavailable.".to_string())?;
        if starts.contains_key(tunnel_id) {
            return Err("The tunnel already has a forward starting.".into());
        }
        let forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        match code_pool_generation {
            Some(_) if forwards.contains_key(tunnel_id) => {
                return Err("The shared Code transport already has a forward.".into());
            }
            None if forwards
                .get(tunnel_id)
                .is_some_and(|forward| forward.code_pool_generation.is_some()) =>
            {
                return Err(
                    "A shared Code transport cannot be replaced by a generic forward.".into(),
                );
            }
            _ => {}
        }
        drop(forwards);
        let generation = code_pool_generation.map(str::to_string);
        starts.insert(tunnel_id.to_string(), generation.clone());
        Ok(ForwardStartReservation {
            code_pool_generation: generation,
            state,
            tunnel_id: tunnel_id.to_string(),
        })
    }

    struct CodeTransportLease {
        acquisition_id: String,
        consumer_id: String,
        window_label: String,
        window_instance_id: String,
    }

    struct StartingCodeTransport {
        changes: watch::Sender<u64>,
        completing: bool,
        created_at: Instant,
        forward: Option<TunnelForwardSummary>,
        generation: String,
        identity: CodeTransportPoolIdentity,
        leader_acquisition_id: String,
        leader_consumer_id: String,
        leader_window_label: String,
        leader_window_instance_id: String,
        retirement_fence: Arc<ForwardRetirementFence>,
        reservation_id: String,
    }

    struct ActiveCodeTransport {
        changes: watch::Sender<u64>,
        forward: TunnelForwardSummary,
        generation: String,
        identity: CodeTransportPoolIdentity,
        leases: HashMap<String, CodeTransportLease>,
        maintenance: Option<(String, Instant)>,
        publication_acquisition_id: String,
        publication_reservation_id: String,
        retirement_fence: Arc<ForwardRetirementFence>,
    }

    struct StoppingCodeTransport {
        changes: watch::Sender<u64>,
        generation: String,
        identity: CodeTransportPoolIdentity,
    }

    struct TerminatedCodeTransport {
        cleanup: Option<TunnelForwardTerminalSnapshot>,
        created_at: Instant,
        identity: CodeTransportPoolIdentity,
        leases: HashMap<String, CodeTransportLease>,
    }

    enum CodeTransportPoolEntry {
        Starting(StartingCodeTransport),
        Active(ActiveCodeTransport),
        Stopping(StoppingCodeTransport),
    }

    enum CodeTransportReleasePlan {
        Completed(CodeTransportForwardRelease),
        Stop(TunnelForwardSummary),
    }

    #[derive(Default)]
    struct ForwardRetirementFence {
        retiring: AtomicBool,
    }

    impl ForwardRetirementFence {
        fn retire(&self) {
            self.retiring.store(true, Ordering::Release);
        }

        fn is_retiring(&self) -> bool {
            self.retiring.load(Ordering::Acquire)
        }
    }

    #[derive(Default)]
    pub struct CodeTransportPool {
        entries: HashMap<String, CodeTransportPoolEntry>,
        terminated: HashMap<(String, String), TerminatedCodeTransport>,
    }

    impl CodeTransportPool {
        pub fn clear(&mut self) {
            self.entries.clear();
            self.terminated.clear();
        }
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
                    "Desktop tunnel logical stream closed",
                    json!({
                        "attachmentId": self.attachment_id,
                        "connectionScope": "logical-stream",
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

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerLinkBridgeInitialize {
        r#type: String,
        token: String,
        route: String,
        identity: WorkerLinkBridgeRouteIdentity,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerLinkBridgeRouteIdentity {
        attachment_id: String,
        destination_endpoint_id: String,
        source_endpoint_id: String,
        tunnel_id: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerLinkBridgeReady<'a> {
        r#type: &'static str,
        attachment_id: &'a str,
        tunnel_id: &'a str,
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
            deadline: Instant,
        },
    }

    enum SessionOutcome {
        Disconnected,
        ForceRelay(oneshot::Sender<Result<(), String>>),
        Stopped,
    }

    enum ForwardSessionResolution {
        Outcome(Result<SessionOutcome, String>),
        RetirementFenced,
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
    struct ConnectionTask {
        cancellation: watch::Sender<Option<&'static str>>,
        cancellation_requested: bool,
        inbound: mpsc::Sender<InboundFrame>,
        task: JoinHandle<()>,
    }

    type ConnectionTasks = HashMap<String, ConnectionTask>;

    #[derive(Clone, Copy)]
    struct SessionTiming {
        heartbeat_interval: Duration,
        pong_timeout: Duration,
        send_timeout: Duration,
    }

    impl SessionTiming {
        fn production() -> Self {
            Self {
                heartbeat_interval: SESSION_HEARTBEAT_INTERVAL,
                pong_timeout: SESSION_PONG_TIMEOUT,
                send_timeout: SESSION_SEND_TIMEOUT,
            }
        }
    }

    enum InboundDelivery {
        Delivered,
        Missing,
        CancellationRequested { reason: &'static str },
    }

    fn code_transport_client_identity(
        identity: &CodeTransportPoolIdentity,
    ) -> CodeTransportClientIdentity {
        CodeTransportClientIdentity {
            account_id: identity.account_id.clone(),
            client_identity_incarnation_id: identity.client_identity_incarnation_id.clone(),
            connection_id: identity.connection_id.clone(),
            server_id: identity.server_id.clone(),
            server_url: identity.server_url.clone(),
            user_id: identity.user_id.clone(),
        }
    }

    fn validate_code_transport_client_identity(
        identity: &CodeTransportClientIdentity,
    ) -> Result<(), String> {
        Uuid::parse_str(&identity.client_identity_incarnation_id)
            .map_err(|_| "The shared Code client identity incarnation is invalid.".to_string())?;
        for (label, value) in [
            ("account", identity.account_id.as_deref()),
            ("connection", identity.connection_id.as_deref()),
        ] {
            if value.is_some_and(|value| value.is_empty() || value.len() > 2_000) {
                return Err(format!("The shared Code {label} identity is invalid."));
            }
        }
        for (label, value) in [
            ("server", identity.server_id.as_str()),
            ("user", identity.user_id.as_str()),
        ] {
            if value.is_empty() || value.len() > 2_000 {
                return Err(format!("The shared Code {label} identity is invalid."));
            }
        }
        let server_url = Url::parse(&identity.server_url)
            .map_err(|_| "The shared Code server URL is invalid.".to_string())?;
        if !matches!(server_url.scheme(), "http" | "https")
            || server_url.host_str().is_none()
            || !server_url.username().is_empty()
            || server_url.password().is_some()
            || server_url.query().is_some()
            || server_url.fragment().is_some()
        {
            return Err("The shared Code server URL is invalid.".into());
        }
        Ok(())
    }

    fn validate_code_transport_pool_identity(
        identity: &CodeTransportPoolIdentity,
        acquisition_id: &str,
        consumer_id: &str,
    ) -> Result<(), String> {
        validate_code_transport_client_identity(&code_transport_client_identity(identity))?;
        for (label, value) in [
            ("transport", identity.transport_id.as_str()),
            ("security scope", identity.security_scope_id.as_str()),
            (
                "server control-plane generation",
                identity.server_control_plane_generation.as_str(),
            ),
            (
                "worker process generation",
                identity.worker_process_generation.as_str(),
            ),
            ("acquisition", acquisition_id),
            ("consumer", consumer_id),
        ] {
            Uuid::parse_str(value)
                .map_err(|_| format!("The shared Code {label} identity is invalid."))?;
        }
        if identity.client_identity_generation == 0 {
            return Err("The shared Code client identity generation is invalid.".into());
        }
        if identity.protected_key_revision == 0 {
            return Err("The shared Code key revision is invalid.".into());
        }
        for (label, value) in [("worker", identity.worker_id.as_str())] {
            if value.is_empty() || value.len() > 2_000 {
                return Err(format!("The shared Code {label} identity is invalid."));
            }
        }
        Ok(())
    }

    pub fn register_code_transport_window_instance(
        state: &TunnelForwards,
        window_label: &str,
        window_instance_id: &str,
    ) -> Result<Option<String>, String> {
        Uuid::parse_str(window_instance_id)
            .map_err(|_| "The shared Code window instance is invalid.".to_string())?;
        if state
            .retired_code_window_instances
            .lock()
            .map_err(|_| "The shared Code window registry is unavailable.".to_string())?
            .contains(window_instance_id)
        {
            return Err("The shared Code window instance has been retired.".into());
        }
        let mut windows = state
            .code_windows
            .lock()
            .map_err(|_| "The shared Code window registry is unavailable.".to_string())?;
        if let Some(previous) = windows.get(window_label).cloned() {
            if previous == window_instance_id {
                return Ok(None);
            }
            // Hot module replacement preserves and reuses the same exact
            // token and JS lease registry. A different token therefore means
            // the old renderer state is gone and its opaque native ownership
            // must be retired, never silently transferred to a renderer that
            // cannot adopt its lease or reservation ids.
            state
                .retired_code_window_instances
                .lock()
                .map_err(|_| "The shared Code window registry is unavailable.".to_string())?
                .insert(previous);
        }
        let retired = windows.insert(window_label.to_string(), window_instance_id.to_string());
        Ok(retired)
    }

    pub fn validate_code_transport_window_instance(
        state: &TunnelForwards,
        window_label: &str,
        window_instance_id: &str,
    ) -> Result<(), String> {
        if state
            .code_windows
            .lock()
            .map_err(|_| "The shared Code window registry is unavailable.".to_string())?
            .get(window_label)
            .is_some_and(|current| current == window_instance_id)
        {
            Ok(())
        } else {
            Err("The shared Code window instance is no longer active.".into())
        }
    }

    pub fn retire_code_transport_window_instance(
        state: &TunnelForwards,
        window_label: &str,
    ) -> Option<String> {
        let retired_instance = state
            .code_windows
            .lock()
            .ok()
            .and_then(|mut windows| windows.remove(window_label));
        if let Some(retired_instance) = retired_instance.as_ref() {
            if let Ok(mut retired) = state.retired_code_window_instances.lock() {
                retired.insert(retired_instance.clone());
            }
        }
        retired_instance
    }

    fn pool_entry_generation(entry: &CodeTransportPoolEntry) -> &str {
        match entry {
            CodeTransportPoolEntry::Starting(entry) => &entry.generation,
            CodeTransportPoolEntry::Active(entry) => &entry.generation,
            CodeTransportPoolEntry::Stopping(entry) => &entry.generation,
        }
    }

    fn pool_entry_identity(entry: &CodeTransportPoolEntry) -> &CodeTransportPoolIdentity {
        match entry {
            CodeTransportPoolEntry::Starting(entry) => &entry.identity,
            CodeTransportPoolEntry::Active(entry) => &entry.identity,
            CodeTransportPoolEntry::Stopping(entry) => &entry.identity,
        }
    }

    fn same_code_transport_security_identity(
        left: &CodeTransportPoolIdentity,
        right: &CodeTransportPoolIdentity,
    ) -> bool {
        left.account_id == right.account_id
            && left.client_identity_incarnation_id == right.client_identity_incarnation_id
            && left.connection_id == right.connection_id
            && left.protected_key_revision == right.protected_key_revision
            && left.security_scope_id == right.security_scope_id
            && left.server_control_plane_generation == right.server_control_plane_generation
            && left.server_id == right.server_id
            && left.server_url == right.server_url
            && left.transport_id == right.transport_id
            && left.user_id == right.user_id
            && left.worker_id == right.worker_id
            && left.worker_process_generation == right.worker_process_generation
    }

    fn pool_entry_changes(entry: &CodeTransportPoolEntry) -> &watch::Sender<u64> {
        match entry {
            CodeTransportPoolEntry::Starting(entry) => &entry.changes,
            CodeTransportPoolEntry::Active(entry) => &entry.changes,
            CodeTransportPoolEntry::Stopping(entry) => &entry.changes,
        }
    }

    fn signal_pool_change(changes: &watch::Sender<u64>) {
        let next = changes.borrow().saturating_add(1);
        let _ = changes.send(next);
    }

    fn code_transport_pool_for_acquire<'a>(
        state: &'a TunnelForwards,
        client_identity: &CodeTransportClientIdentity,
    ) -> Result<
        (
            MutexGuard<'a, HashSet<CodeTransportClientIdentity>>,
            MutexGuard<'a, CodeTransportPool>,
        ),
        String,
    > {
        let invalidated = state
            .invalidated_code_client_identities
            .lock()
            .map_err(|_| "The shared Code identity registry is unavailable.".to_string())?;
        if invalidated.contains(client_identity) {
            return Err("The shared Code transport security identity was invalidated.".into());
        }
        let pool = state
            .code_pool
            .lock()
            .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
        Ok((invalidated, pool))
    }

    pub fn acquire_code_transport_forward(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        window_label: &str,
        request: AcquireCodeTransportForwardRequest,
    ) -> Result<CodeTransportForwardAcquisition, String> {
        // Hold the live-window fence through the ownership mutation. Window
        // destruction blocks here and then snapshots the committed lease or
        // reservation, so a queued acquire cannot land after cleanup.
        let window_instances = state
            .code_windows
            .lock()
            .map_err(|_| "The shared Code window registry is unavailable.".to_string())?;
        if !window_instances
            .get(window_label)
            .is_some_and(|current| current == &request.window_instance_id)
        {
            return Err("The shared Code window instance is no longer active.".into());
        }
        validate_code_transport_pool_identity(
            &request.identity,
            &request.acquisition_id,
            &request.consumer_id,
        )?;
        let transport_id = request.identity.transport_id.clone();
        let authoritative_forward = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?
            .get(&transport_id)
            .map(|forward| {
                let mut summary = forward.summary.clone();
                forward.counters.apply(&mut summary);
                summary
            });
        // Hold the incarnation tombstone fence until the pool lookup/insert is
        // complete. Invalidation takes these locks in the same order, making
        // its tombstone and selective drain atomic with respect to acquire.
        let client_identity = code_transport_client_identity(&request.identity);
        let (invalidated_incarnations, mut pool) =
            code_transport_pool_for_acquire(state, &client_identity)?;
        if let Some(entry) = pool.entries.get_mut(&transport_id) {
            if !same_code_transport_security_identity(pool_entry_identity(entry), &request.identity)
            {
                return Err(
                    "The shared Code transport belongs to another security identity.".into(),
                );
            }
            return match entry {
                CodeTransportPoolEntry::Starting(entry) => {
                    if entry.created_at.elapsed() > CODE_TRANSPORT_RESERVATION_TIMEOUT
                        && !entry.completing
                        && entry.forward.is_none()
                    {
                        let changes = entry.changes.clone();
                        pool.entries.remove(&transport_id);
                        signal_pool_change(&changes);
                        drop(pool);
                        drop(invalidated_incarnations);
                        drop(window_instances);
                        acquire_code_transport_forward(app, state, window_label, request)
                    } else {
                        Ok(CodeTransportForwardAcquisition::Waiting {
                            generation: entry.generation.clone(),
                        })
                    }
                }
                CodeTransportPoolEntry::Active(entry) => {
                    if authoritative_forward.as_ref().is_some_and(|forward| {
                        forward.code_pool_generation.as_deref() == Some(entry.generation.as_str())
                    }) {
                        entry.forward = authoritative_forward.clone().unwrap();
                    }
                    if let Some((lease_id, _)) = entry.leases.iter().find(|(_, lease)| {
                        lease.acquisition_id == request.acquisition_id
                            && lease.consumer_id == request.consumer_id
                            && lease.window_label == window_label
                            && lease.window_instance_id == request.window_instance_id
                    }) {
                        return Ok(CodeTransportForwardAcquisition::Ready {
                            forward: entry.forward.clone(),
                            generation: entry.generation.clone(),
                            lease_id: lease_id.clone(),
                        });
                    }
                    let lease_id = Uuid::new_v4().to_string();
                    entry.leases.insert(
                        lease_id.clone(),
                        CodeTransportLease {
                            acquisition_id: request.acquisition_id,
                            consumer_id: request.consumer_id,
                            window_label: window_label.to_string(),
                            window_instance_id: request.window_instance_id,
                        },
                    );
                    Ok(CodeTransportForwardAcquisition::Ready {
                        forward: entry.forward.clone(),
                        generation: entry.generation.clone(),
                        lease_id,
                    })
                }
                CodeTransportPoolEntry::Stopping(entry) => {
                    Ok(CodeTransportForwardAcquisition::Waiting {
                        generation: entry.generation.clone(),
                    })
                }
            };
        }

        let (changes, _) = watch::channel(0_u64);
        let generation = Uuid::new_v4().to_string();
        let reservation_id = Uuid::new_v4().to_string();
        pool.entries.insert(
            transport_id.clone(),
            CodeTransportPoolEntry::Starting(StartingCodeTransport {
                changes,
                completing: false,
                created_at: Instant::now(),
                forward: None,
                generation: generation.clone(),
                identity: request.identity,
                leader_acquisition_id: request.acquisition_id,
                leader_consumer_id: request.consumer_id,
                leader_window_label: window_label.to_string(),
                leader_window_instance_id: request.window_instance_id,
                retirement_fence: Arc::new(ForwardRetirementFence::default()),
                reservation_id: reservation_id.clone(),
            }),
        );
        let watchdog_app = app.clone();
        let watchdog_transport_id = transport_id.clone();
        let watchdog_generation = generation.clone();
        tauri::async_runtime::spawn(async move {
            sleep(CODE_TRANSPORT_RESERVATION_TIMEOUT).await;
            let state = watchdog_app.state::<TunnelForwards>();
            let staged = state.code_pool.lock().ok().and_then(|mut pool| {
                let expired = matches!(
                    pool.entries.get(&watchdog_transport_id),
                    Some(CodeTransportPoolEntry::Starting(entry))
                        if entry.generation == watchdog_generation
                            && entry.created_at.elapsed()
                                >= CODE_TRANSPORT_RESERVATION_TIMEOUT
                );
                if !expired {
                    return None;
                }
                match pool.entries.remove(&watchdog_transport_id) {
                    Some(CodeTransportPoolEntry::Starting(entry)) => {
                        signal_pool_change(&entry.changes);
                        entry.forward
                    }
                    _ => None,
                }
            });
            if let Some(forward) = staged {
                let _ = stop(
                    &watchdog_app,
                    &state,
                    &watchdog_transport_id,
                    Some(&forward.attachment_id),
                    forward.diagnostic_trace_id.as_deref(),
                    forward.direct_capability_id.as_deref(),
                    Some(&watchdog_generation),
                    "code-pool-reservation-expired",
                )
                .await;
            }
        });
        Ok(CodeTransportForwardAcquisition::Leader {
            generation,
            reservation_id,
        })
    }

    pub fn claim_code_transport_maintenance(
        state: &State<'_, TunnelForwards>,
        window_label: &str,
        transport_id: &str,
        generation: &str,
        lease_id: &str,
        window_instance_id: &str,
    ) -> Result<Option<TunnelForwardSummary>, String> {
        validate_code_transport_window_instance(state, window_label, window_instance_id)?;
        Uuid::parse_str(lease_id)
            .map_err(|_| "The shared Code transport lease is invalid.".to_string())?;
        let authoritative = {
            let forwards = state
                .forwards
                .lock()
                .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
            let Some(forward) = forwards.get(transport_id) else {
                return Ok(None);
            };
            if forward.code_pool_generation.as_deref() != Some(generation) {
                return Ok(None);
            }
            let mut summary = forward.summary.clone();
            forward.counters.apply(&mut summary);
            summary
        };
        let mut pool = state
            .code_pool
            .lock()
            .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
        let Some(CodeTransportPoolEntry::Active(active)) = pool.entries.get_mut(transport_id)
        else {
            return Ok(None);
        };
        if active.generation != generation
            || !active.leases.get(lease_id).is_some_and(|lease| {
                lease.window_label == window_label && lease.window_instance_id == window_instance_id
            })
        {
            return Ok(None);
        }
        let now = Instant::now();
        if active
            .maintenance
            .as_ref()
            .is_some_and(|(owner, expires_at)| owner != lease_id && *expires_at > now)
        {
            return Ok(None);
        }
        active.maintenance = Some((lease_id.to_string(), now + CODE_TRANSPORT_MAINTENANCE_LEASE));
        active.forward = authoritative.clone();
        Ok(Some(authoritative))
    }

    pub async fn wait_code_transport_forward(
        state: &State<'_, TunnelForwards>,
        transport_id: &str,
        generation: &str,
    ) -> Result<bool, String> {
        let mut changes = {
            let pool = state
                .code_pool
                .lock()
                .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
            let Some(entry) = pool.entries.get(transport_id) else {
                return Ok(true);
            };
            if pool_entry_generation(entry) != generation {
                return Ok(true);
            }
            pool_entry_changes(entry).subscribe()
        };
        Ok(
            timeout(CODE_TRANSPORT_RESERVATION_TIMEOUT, changes.changed())
                .await
                .is_ok(),
        )
    }

    fn validate_code_transport_start_request(
        identity: &CodeTransportPoolIdentity,
        generation: &str,
        request: &StartTunnelForwardRequest,
    ) -> Result<(), String> {
        if request.tunnel_id != identity.transport_id
            || request.code_pool_generation.as_deref() != Some(generation)
            || request
                .data_protection
                .as_ref()
                .map(|protection| protection.key_revision)
                != Some(identity.protected_key_revision)
            || request
                .relay
                .as_ref()
                .map(|relay| relay.server_url.as_str())
                != Some(identity.server_url.as_str())
        {
            return Err("The shared Code forward preparation changed security identity.".into());
        }
        Ok(())
    }

    pub async fn complete_code_transport_forward(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        window_label: &str,
        transport_id: &str,
        generation: &str,
        reservation_id: &str,
        window_instance_id: &str,
        request: StartTunnelForwardRequest,
    ) -> Result<CodeTransportForwardCompletion, String> {
        validate_code_transport_window_instance(state, window_label, window_instance_id)?;
        {
            let mut pool = state
                .code_pool
                .lock()
                .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
            let Some(CodeTransportPoolEntry::Starting(entry)) = pool.entries.get_mut(transport_id)
            else {
                return Err("The shared Code forward reservation is unavailable.".into());
            };
            if entry.generation != generation
                || entry.reservation_id != reservation_id
                || entry.leader_window_label != window_label
                || entry.leader_window_instance_id != window_instance_id
                || entry.completing
                || entry.forward.is_some()
            {
                return Err("The shared Code forward reservation changed.".into());
            }
            validate_code_transport_start_request(&entry.identity, generation, &request)?;
            entry.completing = true;
            signal_pool_change(&entry.changes);
        }

        let started = match start(app, state, request).await {
            Ok(started) => started,
            Err(error) => {
                let mut pool = state
                    .code_pool
                    .lock()
                    .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
                if pool
                    .entries
                    .get(transport_id)
                    .is_some_and(|entry| pool_entry_generation(entry) == generation)
                {
                    if let Some(entry) = pool.entries.remove(transport_id) {
                        signal_pool_change(pool_entry_changes(&entry));
                    }
                }
                return Err(error);
            }
        };

        let window_current =
            validate_code_transport_window_instance(state, window_label, window_instance_id)
                .is_ok();
        let accepted = {
            let mut pool = state
                .code_pool
                .lock()
                .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
            if !window_current {
                let exact = matches!(
                    pool.entries.get(transport_id),
                    Some(CodeTransportPoolEntry::Starting(entry))
                        if entry.generation == generation
                            && entry.reservation_id == reservation_id
                            && entry.leader_window_label == window_label
                            && entry.leader_window_instance_id == window_instance_id
                );
                if exact {
                    if let Some(entry) = pool.entries.remove(transport_id) {
                        signal_pool_change(pool_entry_changes(&entry));
                    }
                }
                false
            } else {
                match pool.entries.get_mut(transport_id) {
                    Some(CodeTransportPoolEntry::Starting(entry))
                        if entry.generation == generation
                            && entry.reservation_id == reservation_id
                            && entry.leader_window_label == window_label
                            && entry.leader_window_instance_id == window_instance_id =>
                    {
                        entry.completing = false;
                        entry.forward = Some(started.clone());
                        signal_pool_change(&entry.changes);
                        true
                    }
                    _ => false,
                }
            }
        };
        if !accepted {
            let _ = stop(
                app,
                state,
                transport_id,
                Some(&started.attachment_id),
                started.diagnostic_trace_id.as_deref(),
                started.direct_capability_id.as_deref(),
                Some(generation),
                "stale-code-pool-completion",
            )
            .await;
            return Err("The shared Code forward completed after its reservation ended.".into());
        }
        Ok(CodeTransportForwardCompletion {
            forward: started,
            generation: generation.to_string(),
        })
    }

    pub fn publish_code_transport_forward(
        state: &TunnelForwards,
        window_label: &str,
        transport_id: &str,
        generation: &str,
        reservation_id: &str,
        window_instance_id: &str,
    ) -> Result<CodeTransportForwardAcquisition, String> {
        let window_instances = state
            .code_windows
            .lock()
            .map_err(|_| "The shared Code window registry is unavailable.".to_string())?;
        if !window_instances
            .get(window_label)
            .is_some_and(|current| current == window_instance_id)
        {
            return Err("The shared Code window instance is no longer active.".into());
        }
        let mut pool = state
            .code_pool
            .lock()
            .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
        if let Some(CodeTransportPoolEntry::Active(active)) = pool.entries.get(transport_id) {
            if active.generation == generation
                && active.publication_reservation_id == reservation_id
            {
                if let Some((lease_id, _)) = active.leases.iter().find(|(_, lease)| {
                    lease.acquisition_id == active.publication_acquisition_id
                        && lease.window_label == window_label
                        && lease.window_instance_id == window_instance_id
                }) {
                    return Ok(CodeTransportForwardAcquisition::Ready {
                        forward: active.forward.clone(),
                        generation: active.generation.clone(),
                        lease_id: lease_id.clone(),
                    });
                }
            }
            return Err("The shared Code forward reservation changed.".into());
        }
        let Some(entry) = pool.entries.remove(transport_id) else {
            return Err("The shared Code forward reservation is unavailable.".into());
        };
        let CodeTransportPoolEntry::Starting(starting) = entry else {
            pool.entries.insert(transport_id.to_string(), entry);
            return Err("The shared Code forward reservation changed.".into());
        };
        if starting.generation != generation
            || starting.reservation_id != reservation_id
            || starting.leader_window_label != window_label
            || starting.leader_window_instance_id != window_instance_id
            || starting.completing
        {
            pool.entries.insert(
                transport_id.to_string(),
                CodeTransportPoolEntry::Starting(starting),
            );
            return Err("The shared Code forward reservation changed.".into());
        }
        let Some(forward) = starting.forward.clone() else {
            pool.entries.insert(
                transport_id.to_string(),
                CodeTransportPoolEntry::Starting(starting),
            );
            return Err("The shared Code forward is not ready to publish.".into());
        };
        let lease_id = Uuid::new_v4().to_string();
        let mut leases = HashMap::new();
        leases.insert(
            lease_id.clone(),
            CodeTransportLease {
                acquisition_id: starting.leader_acquisition_id.clone(),
                consumer_id: starting.leader_consumer_id.clone(),
                window_label: starting.leader_window_label.clone(),
                window_instance_id: starting.leader_window_instance_id.clone(),
            },
        );
        signal_pool_change(&starting.changes);
        pool.entries.insert(
            transport_id.to_string(),
            CodeTransportPoolEntry::Active(ActiveCodeTransport {
                changes: starting.changes,
                forward: forward.clone(),
                generation: starting.generation.clone(),
                identity: starting.identity,
                leases,
                maintenance: None,
                publication_acquisition_id: starting.leader_acquisition_id,
                publication_reservation_id: starting.reservation_id,
                retirement_fence: starting.retirement_fence,
            }),
        );
        Ok(CodeTransportForwardAcquisition::Ready {
            forward,
            generation: generation.to_string(),
            lease_id,
        })
    }

    pub fn reconcile_code_transport_forward(
        state: &TunnelForwards,
        window_label: &str,
        acquisition_id: &str,
        consumer_id: &str,
        transport_id: &str,
        generation: &str,
        reservation_id: &str,
        window_instance_id: &str,
    ) -> Result<Option<CodeTransportForwardAcquisition>, String> {
        for (label, value) in [
            ("acquisition", acquisition_id),
            ("consumer", consumer_id),
            ("transport", transport_id),
            ("generation", generation),
            ("reservation", reservation_id),
            ("window instance", window_instance_id),
        ] {
            Uuid::parse_str(value)
                .map_err(|_| format!("The shared Code {label} identity is invalid."))?;
        }
        validate_code_transport_window_instance(state, window_label, window_instance_id)?;
        let pool = state
            .code_pool
            .lock()
            .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
        let Some(CodeTransportPoolEntry::Active(active)) = pool.entries.get(transport_id) else {
            return Ok(None);
        };
        if active.generation != generation
            || active.publication_reservation_id != reservation_id
            || active.publication_acquisition_id != acquisition_id
        {
            return Ok(None);
        }
        Ok(active
            .leases
            .iter()
            .find(|(_, lease)| {
                lease.acquisition_id == acquisition_id
                    && lease.consumer_id == consumer_id
                    && lease.window_label == window_label
                    && lease.window_instance_id == window_instance_id
            })
            .map(|(lease_id, _)| CodeTransportForwardAcquisition::Ready {
                forward: active.forward.clone(),
                generation: active.generation.clone(),
                lease_id: lease_id.clone(),
            }))
    }

    fn take_failed_code_transport_forward(
        state: &TunnelForwards,
        window_label: &str,
        transport_id: &str,
        generation: &str,
        reservation_id: &str,
        window_instance_id: Option<&str>,
    ) -> Result<Option<TunnelForwardSummary>, String> {
        let mut pool = state
            .code_pool
            .lock()
            .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
        let exact = matches!(
            pool.entries.get(transport_id),
            Some(CodeTransportPoolEntry::Starting(entry))
                if entry.generation == generation
                    && entry.reservation_id == reservation_id
                    && entry.leader_window_label == window_label
                    && window_instance_id.is_none_or(|expected| {
                        entry.leader_window_instance_id == expected
                    })
        );
        if !exact {
            return Ok(None);
        }
        Ok(match pool.entries.remove(transport_id) {
            Some(CodeTransportPoolEntry::Starting(entry)) => {
                signal_pool_change(&entry.changes);
                entry.forward
            }
            _ => None,
        })
    }

    async fn fail_code_transport_forward_exact(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        window_label: &str,
        transport_id: &str,
        generation: &str,
        reservation_id: &str,
        window_instance_id: Option<&str>,
    ) -> Result<(), String> {
        let forward = take_failed_code_transport_forward(
            state,
            window_label,
            transport_id,
            generation,
            reservation_id,
            window_instance_id,
        )?;
        if let Some(forward) = forward {
            let _ = stop(
                app,
                state,
                transport_id,
                Some(&forward.attachment_id),
                forward.diagnostic_trace_id.as_deref(),
                forward.direct_capability_id.as_deref(),
                Some(generation),
                "code-pool-preparation-failed",
            )
            .await;
        }
        Ok(())
    }

    pub async fn fail_code_transport_forward(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        window_label: &str,
        transport_id: &str,
        generation: &str,
        reservation_id: &str,
        window_instance_id: Option<&str>,
    ) -> Result<(), String> {
        if let Some(window_instance_id) = window_instance_id {
            validate_code_transport_window_instance(state, window_label, window_instance_id)?;
        }
        fail_code_transport_forward_exact(
            app,
            state,
            window_label,
            transport_id,
            generation,
            reservation_id,
            window_instance_id,
        )
        .await
    }

    pub async fn release_code_transport_forward(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        transport_id: &str,
        generation: &str,
        lease_id: &str,
    ) -> Result<CodeTransportForwardRelease, String> {
        Uuid::parse_str(lease_id)
            .map_err(|_| "The shared Code transport lease is invalid.".to_string())?;
        let release_plan = {
            let mut pool = state
                .code_pool
                .lock()
                .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
            if let Some(result) = release_terminated_code_transport_lease(
                &mut pool,
                transport_id,
                generation,
                lease_id,
            ) {
                return Ok(result);
            }
            release_code_transport_pool_lease(&mut pool, transport_id, generation, lease_id)
        };
        let stop_identity = match release_plan {
            CodeTransportReleasePlan::Completed(result) => return Ok(result),
            CodeTransportReleasePlan::Stop(forward) => forward,
        };

        let stopped = stop(
            app,
            state,
            transport_id,
            Some(&stop_identity.attachment_id),
            stop_identity.diagnostic_trace_id.as_deref(),
            stop_identity.direct_capability_id.as_deref(),
            Some(generation),
            "last-code-transport-lease-released",
        )
        .await?;
        let mut pool = state
            .code_pool
            .lock()
            .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
        if pool.entries.get(transport_id).is_some_and(|entry| {
            pool_entry_generation(entry) == generation
                && matches!(entry, CodeTransportPoolEntry::Stopping(_))
        }) {
            pool.entries.remove(transport_id);
        }
        Ok(CodeTransportForwardRelease {
            released: true,
            remaining_leases: 0,
            stopped,
        })
    }

    fn release_terminated_code_transport_lease(
        pool: &mut CodeTransportPool,
        transport_id: &str,
        generation: &str,
        lease_id: &str,
    ) -> Option<CodeTransportForwardRelease> {
        let key = (transport_id.to_string(), generation.to_string());
        let replacement_exists = pool
            .entries
            .get(transport_id)
            .is_some_and(|entry| pool_entry_generation(entry) != generation);
        let terminated = pool.terminated.get_mut(&key)?;
        if terminated.leases.remove(lease_id).is_none() {
            return Some(CodeTransportForwardRelease {
                released: false,
                remaining_leases: terminated.leases.len(),
                stopped: None,
            });
        }
        let cleanup = terminated.cleanup.take();
        let result = CodeTransportForwardRelease {
            released: true,
            remaining_leases: terminated.leases.len(),
            // A replacement reuses the same server attachment identity. Never
            // hand old-generation cleanup to JS after that replacement has
            // started: deleting the old attachment would revoke the winner's
            // freshly rotated credential too.
            stopped: if replacement_exists { None } else { cleanup },
        };
        if terminated.leases.is_empty() && terminated.cleanup.is_none() {
            pool.terminated.remove(&key);
        }
        Some(result)
    }

    fn release_code_transport_pool_lease(
        pool: &mut CodeTransportPool,
        transport_id: &str,
        generation: &str,
        lease_id: &str,
    ) -> CodeTransportReleasePlan {
        let Some(entry) = pool.entries.remove(transport_id) else {
            return CodeTransportReleasePlan::Completed(CodeTransportForwardRelease {
                released: false,
                remaining_leases: 0,
                stopped: None,
            });
        };
        let CodeTransportPoolEntry::Active(mut active) = entry else {
            pool.entries.insert(transport_id.to_string(), entry);
            return CodeTransportReleasePlan::Completed(CodeTransportForwardRelease {
                released: false,
                remaining_leases: 0,
                stopped: None,
            });
        };
        if active.generation != generation {
            let remaining_leases = active.leases.len();
            pool.entries.insert(
                transport_id.to_string(),
                CodeTransportPoolEntry::Active(active),
            );
            return CodeTransportReleasePlan::Completed(CodeTransportForwardRelease {
                released: false,
                remaining_leases,
                stopped: None,
            });
        }
        if active.leases.remove(lease_id).is_none() {
            let remaining_leases = active.leases.len();
            pool.entries.insert(
                transport_id.to_string(),
                CodeTransportPoolEntry::Active(active),
            );
            return CodeTransportReleasePlan::Completed(CodeTransportForwardRelease {
                released: false,
                remaining_leases,
                stopped: None,
            });
        }
        if active
            .maintenance
            .as_ref()
            .is_some_and(|(owner, _)| owner == lease_id)
        {
            active.maintenance = None;
        }
        let remaining_leases = active.leases.len();
        if remaining_leases > 0 {
            pool.entries.insert(
                transport_id.to_string(),
                CodeTransportPoolEntry::Active(active),
            );
            return CodeTransportReleasePlan::Completed(CodeTransportForwardRelease {
                released: true,
                remaining_leases,
                stopped: None,
            });
        }
        let forward = active.forward.clone();
        active.retirement_fence.retire();
        signal_pool_change(&active.changes);
        pool.entries.insert(
            transport_id.to_string(),
            CodeTransportPoolEntry::Stopping(StoppingCodeTransport {
                changes: active.changes,
                generation: active.generation,
                identity: active.identity,
            }),
        );
        CodeTransportReleasePlan::Stop(forward)
    }

    fn prune_terminated_code_transports(pool: &mut CodeTransportPool) {
        pool.terminated.retain(|_, terminated| {
            terminated.created_at.elapsed() <= CODE_TRANSPORT_TERMINAL_RETENTION
        });
        while pool.terminated.len() > MAX_TERMINATED_CODE_TRANSPORTS {
            let Some(oldest) = pool
                .terminated
                .iter()
                .min_by_key(|(_, terminated)| terminated.created_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            pool.terminated.remove(&oldest);
        }
    }

    fn code_transport_forward_terminated(
        state: &TunnelForwards,
        transport_id: &str,
        generation: &str,
        cleanup: Option<TunnelForwardTerminalSnapshot>,
    ) {
        if let Ok(mut pool) = state.code_pool.lock() {
            let exact = pool
                .entries
                .get(transport_id)
                .is_some_and(|entry| pool_entry_generation(entry) == generation);
            if exact {
                if let Some(entry) = pool.entries.remove(transport_id) {
                    signal_pool_change(pool_entry_changes(&entry));
                    if let (CodeTransportPoolEntry::Active(active), Some(cleanup)) =
                        (entry, cleanup)
                    {
                        pool.terminated.insert(
                            (transport_id.to_string(), generation.to_string()),
                            TerminatedCodeTransport {
                                cleanup: Some(cleanup),
                                created_at: Instant::now(),
                                identity: active.identity,
                                leases: active.leases,
                            },
                        );
                        prune_terminated_code_transports(&mut pool);
                    }
                }
            }
        }
    }

    fn invalidate_code_transport_incarnation(
        pool: &mut CodeTransportPool,
        client_identity: &CodeTransportClientIdentity,
    ) -> Vec<(String, String, TunnelForwardSummary)> {
        pool.terminated.retain(|_, terminated| {
            code_transport_client_identity(&terminated.identity) != *client_identity
        });
        let transport_ids = pool
            .entries
            .iter()
            .filter(|(_, entry)| {
                code_transport_client_identity(pool_entry_identity(entry)) == *client_identity
            })
            .map(|(transport_id, _)| transport_id.clone())
            .collect::<Vec<_>>();
        transport_ids
            .into_iter()
            .filter_map(|transport_id| {
                let entry = pool.entries.remove(&transport_id)?;
                signal_pool_change(pool_entry_changes(&entry));
                match entry {
                    CodeTransportPoolEntry::Starting(starting) => starting
                        .forward
                        .map(|forward| (transport_id, starting.generation, forward)),
                    CodeTransportPoolEntry::Active(active) => {
                        Some((transport_id, active.generation, active.forward))
                    }
                    CodeTransportPoolEntry::Stopping(_) => None,
                }
            })
            .collect()
    }

    fn tombstone_and_invalidate_code_transport_incarnation(
        state: &TunnelForwards,
        client_identity: &CodeTransportClientIdentity,
    ) -> Result<Vec<(String, String, TunnelForwardSummary)>, String> {
        validate_code_transport_client_identity(client_identity)?;
        // Tombstoning and draining share one lock boundary with acquire's
        // tombstone check and pool mutation. A stale acquire therefore cannot
        // commit after invalidation, while an unrelated fresh identity is
        // never caught in the old identity's drain.
        let mut invalidated = state
            .invalidated_code_client_identities
            .lock()
            .map_err(|_| "The shared Code identity registry is unavailable.".to_string())?;
        let mut pool = state
            .code_pool
            .lock()
            .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
        invalidated.insert(client_identity.clone());
        Ok(invalidate_code_transport_incarnation(
            &mut pool,
            client_identity,
        ))
    }

    pub async fn invalidate_code_transport_pool(
        app: &AppHandle,
        state: &TunnelForwards,
        client_identity: &CodeTransportClientIdentity,
    ) -> Result<(), String> {
        let stops = tombstone_and_invalidate_code_transport_incarnation(state, client_identity)?;
        let mut failures = Vec::new();
        let managed_state = app.state::<TunnelForwards>();
        for (transport_id, generation, forward) in stops {
            if let Err(error) = stop(
                app,
                &managed_state,
                &transport_id,
                Some(&forward.attachment_id),
                forward.diagnostic_trace_id.as_deref(),
                forward.direct_capability_id.as_deref(),
                Some(&generation),
                "attachment-invalidated",
            )
            .await
            {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Could not invalidate every shared Code transport: {}",
                failures.join("; ")
            ))
        }
    }

    fn code_transport_window_actions(
        pool: &CodeTransportPool,
        window_label: &str,
        window_instance_id: &str,
    ) -> Vec<(String, String, Option<String>, Option<String>)> {
        let mut actions = pool
            .entries
            .iter()
            .flat_map(|(transport_id, entry)| match entry {
                CodeTransportPoolEntry::Active(active) => active
                    .leases
                    .iter()
                    .filter(|(_, lease)| {
                        lease.window_label == window_label
                            && lease.window_instance_id == window_instance_id
                    })
                    .map(|(lease_id, _)| {
                        (
                            transport_id.clone(),
                            active.generation.clone(),
                            Some(lease_id.clone()),
                            None,
                        )
                    })
                    .collect::<Vec<_>>(),
                CodeTransportPoolEntry::Starting(starting)
                    if starting.leader_window_label == window_label
                        && starting.leader_window_instance_id == window_instance_id =>
                {
                    vec![(
                        transport_id.clone(),
                        starting.generation.clone(),
                        None,
                        Some(starting.reservation_id.clone()),
                    )]
                }
                _ => Vec::new(),
            })
            .collect::<Vec<_>>();
        actions.extend(pool.terminated.iter().flat_map(
            |((transport_id, generation), terminated)| {
                terminated
                    .leases
                    .iter()
                    .filter(|(_, lease)| {
                        lease.window_label == window_label
                            && lease.window_instance_id == window_instance_id
                    })
                    .map(|(lease_id, _)| {
                        (
                            transport_id.clone(),
                            generation.clone(),
                            Some(lease_id.clone()),
                            None,
                        )
                    })
                    .collect::<Vec<_>>()
            },
        ));
        actions
    }

    pub async fn release_code_transport_window(
        app: &AppHandle,
        state: &TunnelForwards,
        window_label: &str,
        window_instance_id: &str,
    ) {
        // Re-snapshot after every exact cleanup. A completion or publication
        // already queued by the destroyed webview may transition Starting to
        // Active between the snapshot and the command; the next pass catches
        // the resulting lease without touching another window's ownership.
        for _ in 0..8 {
            let actions = state
                .code_pool
                .lock()
                .ok()
                .map(|pool| code_transport_window_actions(&pool, window_label, window_instance_id))
                .unwrap_or_default();
            if actions.is_empty() {
                break;
            }
            for (transport_id, generation, lease_id, reservation_id) in actions {
                let state = app.state::<TunnelForwards>();
                if let Some(lease_id) = lease_id {
                    let _ = release_code_transport_forward(
                        app,
                        &state,
                        &transport_id,
                        &generation,
                        &lease_id,
                    )
                    .await;
                } else if let Some(reservation_id) = reservation_id {
                    // The renderer token was intentionally retired before this
                    // cleanup began. Trust only the exact native owner tuple;
                    // public IPC still requires the token to be current.
                    let _ = fail_code_transport_forward_exact(
                        app,
                        &state,
                        window_label,
                        &transport_id,
                        &generation,
                        &reservation_id,
                        Some(window_instance_id),
                    )
                    .await;
                }
            }
        }
    }

    pub async fn start(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        request: StartTunnelForwardRequest,
    ) -> Result<TunnelForwardSummary, String> {
        validate_identifiers(&request)?;
        let relay_fallback_available = request.relay.is_some();
        let retirement_fence = match request.code_pool_generation.as_deref() {
            Some(generation) => {
                let pool = state
                    .code_pool
                    .lock()
                    .map_err(|_| "The shared Code transport pool is unavailable.".to_string())?;
                let Some(CodeTransportPoolEntry::Starting(starting)) =
                    pool.entries.get(&request.tunnel_id)
                else {
                    return Err("The shared Code forward reservation is unavailable.".into());
                };
                if starting.generation != generation {
                    return Err("The shared Code forward reservation changed.".into());
                }
                starting.retirement_fence.clone()
            }
            None => Arc::new(ForwardRetirementFence::default()),
        };
        let _start_reservation = reserve_forward_start(
            state,
            &request.tunnel_id,
            request.code_pool_generation.as_deref(),
        )?;
        if request.code_pool_generation.is_none() {
            let _ = stop(
                app,
                state,
                &request.tunnel_id,
                None,
                None,
                None,
                None,
                "replaced",
            )
            .await?;
        }
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
        let code_pool_generation = request.code_pool_generation.clone();
        let counters = Arc::new(ForwardCounters::default());
        let (stop_sender, stop_receiver) = oneshot::channel();
        let (ready_sender, ready_receiver) = oneshot::channel();
        let (publication_sender, publication_receiver) = oneshot::channel();
        let (relay_refresh_sender, relay_refresh_receiver) = watch::channel(None);
        let (route_control_sender, route_control_receiver) = mpsc::channel(1);
        let terminal_event = TunnelForwardTerminalEvent {
            attachment_id: request.attachment_id.clone(),
            diagnostic_trace_id: request.diagnostic_trace_id.clone(),
            reason_code: "route-terminated",
            tunnel_id: request.tunnel_id.clone(),
        };
        let terminal_code_pool_generation = code_pool_generation.clone();
        let terminal_summary = Arc::new(Mutex::new(None::<TunnelForwardSummary>));
        let task_terminal_summary = terminal_summary.clone();
        let task_app = app.clone();
        let task_counters = counters.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_forward(
                Some(task_app.clone()),
                listener,
                request,
                task_counters.clone(),
                retirement_fence,
                stop_receiver,
                ready_sender,
                relay_refresh_receiver,
                route_control_receiver,
            )
            .await;
            // Do not race forward termination against insertion into the
            // authoritative map. The starter publishes (or drops) this gate
            // after startup has either committed or failed.
            let _ = publication_receiver.await;
            let removed = task_app
                .state::<TunnelForwards>()
                .forwards
                .lock()
                .ok()
                .is_some_and(|mut forwards| {
                    let exact = forwards
                        .get(&terminal_event.tunnel_id)
                        .is_some_and(|forward| {
                            forward.summary.attachment_id == terminal_event.attachment_id
                                && forward.summary.diagnostic_trace_id
                                    == terminal_event.diagnostic_trace_id
                        });
                    if exact {
                        forwards.remove(&terminal_event.tunnel_id);
                    }
                    exact
                });
            if removed {
                if let Some(generation) = terminal_code_pool_generation.as_deref() {
                    let cleanup = task_terminal_summary
                        .lock()
                        .ok()
                        .and_then(|summary| summary.clone())
                        .map(|summary| task_counters.terminal_snapshot(&summary));
                    code_transport_forward_terminated(
                        &task_app.state::<TunnelForwards>(),
                        &terminal_event.tunnel_id,
                        generation,
                        cleanup,
                    );
                }
                emit_forward_terminal(&task_app, &terminal_event);
            }
        });
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
            code_pool_generation: code_pool_generation.clone(),
        };
        if let Ok(mut published) = terminal_summary.lock() {
            *published = Some(summary.clone());
        }
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        if forwards.contains_key(&tunnel_id) {
            task.abort();
            let _ = publication_sender.send(());
            return Err("The tunnel acquired another forward during startup.".into());
        }
        forwards.insert(
            tunnel_id,
            ForwardHandle {
                code_pool_generation,
                counters,
                relay_refresh: relay_refresh_sender,
                route_control: route_control_sender,
                stop: Some(stop_sender),
                summary: summary.clone(),
                task,
            },
        );
        let _ = publication_sender.send(());
        Ok(summary)
    }

    pub async fn prepare_worker_link(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        request: PrepareWorkerLinkTunnelForwardRequest,
    ) -> Result<WorkerLinkTunnelForwardPreparation, String> {
        validate_worker_link_forward_identifiers(&request)?;
        let PrepareWorkerLinkTunnelForwardRequest {
            attachment_id,
            data_protection: protection_request,
            diagnostic_trace_id,
            expires_at,
            preferred_local_port,
            tunnel_id,
        } = request;
        let protection = data_protection(Some(protection_request))?;
        let _start_reservation = reserve_forward_start(state, &tunnel_id, None)?;
        let _ = stop(app, state, &tunnel_id, None, None, None, None, "replaced").await?;
        let listener = bind_listener(preferred_local_port).await?;
        let local_port = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the local tunnel listener: {error}"))?
            .port();
        let bridge_listener = bind_listener(None).await?;
        let bridge_port = bridge_listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the tunnel bridge listener: {error}"))?
            .port();
        let bridge_token = URL_SAFE_NO_PAD.encode(Aes256Gcm::generate_key(&mut OsRng));
        let task_token = Zeroizing::new(bridge_token.clone());
        let counters = Arc::new(ForwardCounters::default());
        counters.route_state.store(3, Ordering::Relaxed);
        let summary = TunnelForwardSummary {
            attachment_id: attachment_id.clone(),
            diagnostic_trace_id: diagnostic_trace_id.clone(),
            expires_at,
            local_host: "127.0.0.1",
            local_port,
            route_state: "degraded",
            relay_fallback_available: false,
            relay_credential_expires_at_epoch_ms: None,
            direct_capability_id: None,
            direct_fallback_reason: None,
            last_destination_rejection_code: None,
            tunnel_id: tunnel_id.clone(),
            bytes_from_local: 0,
            bytes_to_local: 0,
            connections_closed: 0,
            connections_opened: 0,
            destination_rejected_count: 0,
            code_pool_generation: None,
        };
        let terminal_event = TunnelForwardTerminalEvent {
            attachment_id: attachment_id.clone(),
            diagnostic_trace_id: diagnostic_trace_id.clone(),
            reason_code: "route-terminated",
            tunnel_id: tunnel_id.clone(),
        };
        let (stop_sender, stop_receiver) = oneshot::channel();
        let (publication_sender, publication_receiver) = oneshot::channel();
        let (relay_refresh_sender, _relay_refresh_receiver) = watch::channel(None);
        let (route_control_sender, _route_control_receiver) = mpsc::channel(1);
        let task_app = app.clone();
        let task_counters = counters.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_worker_link_forward(
                Some(task_app.clone()),
                listener,
                bridge_listener,
                task_token,
                attachment_id,
                tunnel_id,
                diagnostic_trace_id,
                protection,
                task_counters,
                stop_receiver,
            )
            .await;
            let _ = publication_receiver.await;
            let removed = task_app
                .state::<TunnelForwards>()
                .forwards
                .lock()
                .ok()
                .is_some_and(|mut forwards| {
                    let exact = forwards
                        .get(&terminal_event.tunnel_id)
                        .is_some_and(|forward| {
                            forward.summary.attachment_id == terminal_event.attachment_id
                                && forward.summary.diagnostic_trace_id
                                    == terminal_event.diagnostic_trace_id
                        });
                    if exact {
                        forwards.remove(&terminal_event.tunnel_id);
                    }
                    exact
                });
            if removed {
                emit_forward_terminal(&task_app, &terminal_event);
            }
        });
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        if forwards.contains_key(&summary.tunnel_id) {
            task.abort();
            let _ = publication_sender.send(());
            return Err("The tunnel acquired another forward during startup.".into());
        }
        forwards.insert(
            summary.tunnel_id.clone(),
            ForwardHandle {
                code_pool_generation: None,
                counters,
                relay_refresh: relay_refresh_sender,
                route_control: route_control_sender,
                stop: Some(stop_sender),
                summary: summary.clone(),
                task,
            },
        );
        drop(forwards);
        let _ = publication_sender.send(());
        diagnostic_event(
            Some(app),
            "info",
            "Desktop WorkerLink tunnel listener bound",
            json!({
                "attachmentId": summary.attachment_id,
                "diagnosticTraceId": summary.diagnostic_trace_id,
                "event": "desktop.tunnel.worker-link-bridge.bound",
                "operation": "bind-listener",
                "routeState": "degraded",
                "status": "ready",
                "subsystem": "tunnel-forward",
                "tunnelId": summary.tunnel_id,
            }),
        );
        Ok(WorkerLinkTunnelForwardPreparation {
            bridge: WorkerLinkTunnelBridge {
                token: bridge_token,
                url: format!("ws://127.0.0.1:{bridge_port}/worker-link-tunnel"),
            },
            forward: summary,
        })
    }

    pub fn update_worker_link_route(
        state: &State<'_, TunnelForwards>,
        tunnel_id: &str,
        attachment_id: &str,
        route: &str,
    ) -> Result<bool, String> {
        let route_state = match route {
            "local" => 1,
            "relay" => 2,
            _ => return Err("The WorkerLink tunnel route is invalid.".into()),
        };
        let forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        let Some(forward) = forwards.get(tunnel_id) else {
            return Ok(false);
        };
        if forward.code_pool_generation.is_some()
            || forward.summary.attachment_id != attachment_id
            || forward.summary.direct_capability_id.is_some()
            || forward.summary.relay_fallback_available
        {
            return Ok(false);
        }
        forward
            .counters
            .route_state
            .store(route_state, Ordering::Relaxed);
        Ok(true)
    }

    pub fn refresh_worker_link_forward(
        state: &State<'_, TunnelForwards>,
        tunnel_id: &str,
        attachment_id: &str,
        expires_at: &str,
    ) -> Result<bool, String> {
        if expires_at.len() > 64 || chrono::DateTime::parse_from_rfc3339(expires_at).is_err() {
            return Err("The WorkerLink tunnel expiration is invalid.".into());
        }
        let mut forwards = state
            .forwards
            .lock()
            .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
        let Some(forward) = forwards.get_mut(tunnel_id) else {
            return Ok(false);
        };
        if forward.code_pool_generation.is_some()
            || forward.summary.attachment_id != attachment_id
            || forward.summary.direct_capability_id.is_some()
            || forward.summary.relay_fallback_available
        {
            return Ok(false);
        }
        forward.summary.expires_at = expires_at.to_string();
        Ok(true)
    }

    pub async fn force_relay(
        app: &AppHandle,
        state: &State<'_, TunnelForwards>,
        tunnel_id: &str,
        direct_capability_id: &str,
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
                if !matches_direct_capability(&summary, direct_capability_id) {
                    return Err("The desktop tunnel changed before relay fallback.".into());
                }
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
            .try_send(RouteControl::ForceRelay {
                completed,
                deadline: transition_deadline,
            })
            .is_err()
        {
            counters.cancel_route_fallback();
            return Err("The desktop tunnel relay fallback could not be queued.".into());
        }
        let remaining = transition_deadline.saturating_duration_since(Instant::now());
        let completion = match timeout(remaining, completion).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The desktop tunnel stopped during relay fallback.".into()),
            Err(_) => Err("The desktop tunnel relay fallback timed out.".into()),
        };
        if let Err(error) = completion {
            counters.cancel_route_fallback();
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
                if !matches_direct_capability(&forward.summary, direct_capability_id) {
                    return Err("The desktop tunnel changed during relay fallback.".into());
                }
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

    fn matches_direct_capability(
        summary: &TunnelForwardSummary,
        direct_capability_id: &str,
    ) -> bool {
        summary.direct_capability_id.as_deref() == Some(direct_capability_id)
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
        expected_attachment_id: Option<&str>,
        expected_diagnostic_trace_id: Option<&str>,
        expected_direct_capability_id: Option<&str>,
        expected_code_pool_generation: Option<&str>,
        reason: &'static str,
    ) -> Result<Option<TunnelForwardTerminalSnapshot>, String> {
        let forward = {
            let mut forwards = state
                .forwards
                .lock()
                .map_err(|_| "The local tunnel manager is unavailable.".to_string())?;
            take_forward_for_stop(
                &mut forwards,
                tunnel_id,
                expected_attachment_id,
                expected_diagnostic_trace_id,
                expected_direct_capability_id,
                expected_code_pool_generation,
            )
        };
        let Some(mut forward) = forward else {
            return Ok(None);
        };
        let code_pool_generation = forward.code_pool_generation.clone();
        abort_forward(&mut forward);
        log_forward_stopping(app, &forward, reason);
        let _ = (&mut forward.task).await;
        forward.counters.wait_for_connections_drained().await;
        let snapshot = forward.counters.terminal_snapshot(&forward.summary);
        log_forward_snapshot(app, &forward, &snapshot, reason);
        log_forward_stopped(app, &forward, reason);
        if let Some(generation) = code_pool_generation.as_deref() {
            code_transport_forward_terminated(state, tunnel_id, generation, None);
        }
        if matches!(reason, "attachment-invalidated" | "replaced") {
            emit_forward_terminal(
                app,
                &TunnelForwardTerminalEvent {
                    attachment_id: forward.summary.attachment_id.clone(),
                    diagnostic_trace_id: forward.summary.diagnostic_trace_id.clone(),
                    reason_code: reason,
                    tunnel_id: forward.summary.tunnel_id.clone(),
                },
            );
        }
        Ok(Some(snapshot))
    }

    fn emit_forward_terminal(app: &AppHandle, event: &TunnelForwardTerminalEvent) {
        let _ = app.emit(TUNNEL_FORWARD_TERMINAL_EVENT, event);
    }

    fn take_forward_for_stop(
        forwards: &mut HashMap<String, ForwardHandle>,
        tunnel_id: &str,
        expected_attachment_id: Option<&str>,
        expected_diagnostic_trace_id: Option<&str>,
        expected_direct_capability_id: Option<&str>,
        expected_code_pool_generation: Option<&str>,
    ) -> Option<ForwardHandle> {
        let candidate = forwards.get(tunnel_id)?;
        if candidate.code_pool_generation.as_deref() != expected_code_pool_generation {
            return None;
        }
        if !stop_fence_matches(
            &candidate.summary,
            expected_attachment_id,
            expected_diagnostic_trace_id,
            expected_direct_capability_id,
        ) {
            return None;
        }
        forwards.remove(tunnel_id)
    }

    fn stop_fence_matches(
        summary: &TunnelForwardSummary,
        expected_attachment_id: Option<&str>,
        expected_diagnostic_trace_id: Option<&str>,
        expected_direct_capability_id: Option<&str>,
    ) -> bool {
        let Some(expected_attachment_id) = expected_attachment_id else {
            return true;
        };
        if expected_attachment_id != summary.attachment_id {
            return false;
        }
        if expected_diagnostic_trace_id
            .is_some_and(|expected| summary.diagnostic_trace_id.as_deref() != Some(expected))
        {
            return false;
        }
        match summary.direct_capability_id.as_deref() {
            Some(current) => expected_direct_capability_id == Some(current),
            None => true,
        }
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
        let finished = forwards
            .iter()
            .filter(|(_, forward)| forward.task.inner().is_finished())
            .map(|(tunnel_id, forward)| {
                (
                    tunnel_id.clone(),
                    forward.code_pool_generation.clone(),
                    forward.counters.terminal_snapshot(&forward.summary),
                )
            })
            .collect::<Vec<_>>();
        for (tunnel_id, _, _) in &finished {
            forwards.remove(tunnel_id);
        }
        let mut summaries = forwards
            .values()
            .map(|forward| {
                let mut summary = forward.summary.clone();
                forward.counters.apply(&mut summary);
                summary
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| left.tunnel_id.cmp(&right.tunnel_id));
        drop(forwards);
        for (tunnel_id, generation, cleanup) in finished {
            if let Some(generation) = generation {
                code_transport_forward_terminated(state, &tunnel_id, &generation, Some(cleanup));
            }
        }
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

    fn validate_worker_link_forward_identifiers(
        request: &PrepareWorkerLinkTunnelForwardRequest,
    ) -> Result<(), String> {
        for (label, value) in [
            ("tunnel", request.tunnel_id.as_str()),
            ("attachment", request.attachment_id.as_str()),
        ] {
            if !valid_tunnel_identity(value) {
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
        Ok(())
    }

    fn valid_tunnel_identity(value: &str) -> bool {
        !value.is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
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

    #[allow(clippy::too_many_arguments)]
    async fn run_worker_link_forward(
        app: Option<AppHandle>,
        listener: TcpListener,
        bridge_listener: TcpListener,
        bridge_token: Zeroizing<String>,
        attachment_id: String,
        tunnel_id: String,
        diagnostic_trace_id: Option<String>,
        protection: Option<Arc<DataProtection>>,
        counters: Arc<ForwardCounters>,
        mut stop: oneshot::Receiver<()>,
    ) {
        let mut invalid_attempts = 0_usize;
        loop {
            let accepted = tokio::select! {
                _ = &mut stop => return,
                accepted = bridge_listener.accept() => accepted,
            };
            let Ok((stream, peer)) = accepted else {
                return;
            };
            if !peer.ip().is_loopback() {
                if throttle_invalid_bridge_attempts(&mut invalid_attempts, &mut stop).await {
                    return;
                }
                continue;
            }
            let connected = tokio::select! {
                _ = &mut stop => return,
                connected = accept_worker_link_bridge(
                    stream,
                    bridge_token.as_str(),
                    &tunnel_id,
                    &attachment_id,
                ) => connected,
            };
            let (web_socket, identity, route) = match connected {
                Ok(connected) => connected,
                Err(_) => {
                    if throttle_invalid_bridge_attempts(&mut invalid_attempts, &mut stop).await {
                        return;
                    }
                    continue;
                }
            };
            invalid_attempts = 0;
            counters
                .route_state
                .store(if route == "local" { 1 } else { 2 }, Ordering::Relaxed);
            if counters.record_route_selection() {
                diagnostic_event(
                    app.as_ref(),
                    "info",
                    "Desktop tunnel WorkerLink route selected",
                    json!({
                        "attachmentId": attachment_id,
                        "diagnosticTraceId": diagnostic_trace_id,
                        "event": "desktop.tunnel.route.selected",
                        "operation": "select-route",
                        "routeState": if route == "local" { "local-direct" } else { "relayed" },
                        "status": "completed",
                        "subsystem": "tunnel-forward",
                        "tunnelId": tunnel_id,
                    }),
                );
            }
            let (_route_control_sender, mut route_controls) = mpsc::channel(1);
            let result = run_session_with_timing(
                app.as_ref(),
                diagnostic_trace_id.as_deref(),
                &listener,
                web_socket,
                identity,
                protection.clone(),
                counters.clone(),
                &mut stop,
                &mut route_controls,
                SessionTiming::production(),
            )
            .await;
            if matches!(result, Ok(SessionOutcome::Stopped)) {
                return;
            }
            counters.route_state.store(3, Ordering::Relaxed);
            if counters.record_route_disconnect() {
                diagnostic_event(
                    app.as_ref(),
                    "warn",
                    "Desktop tunnel WorkerLink route disconnected",
                    json!({
                        "attachmentId": attachment_id,
                        "diagnosticTraceId": diagnostic_trace_id,
                        "event": "desktop.tunnel.route.disconnected",
                        "operation": "forward-route",
                        "reasonCode": if result.is_err() { "route-error" } else { "remote-closed" },
                        "status": "degraded",
                        "subsystem": "tunnel-forward",
                        "tunnelId": tunnel_id,
                    }),
                );
            }
        }
    }

    async fn throttle_invalid_bridge_attempts(
        invalid_attempts: &mut usize,
        stop: &mut oneshot::Receiver<()>,
    ) -> bool {
        *invalid_attempts = invalid_attempts.saturating_add(1);
        if *invalid_attempts < WORKER_LINK_BRIDGE_MAX_INVALID_ATTEMPTS {
            return false;
        }
        *invalid_attempts = 0;
        tokio::select! {
            _ = &mut *stop => true,
            _ = sleep(WORKER_LINK_BRIDGE_INVALID_BACKOFF) => false,
        }
    }

    async fn accept_worker_link_bridge(
        stream: TcpStream,
        expected_token: &str,
        tunnel_id: &str,
        attachment_id: &str,
    ) -> Result<
        (
            tokio_tungstenite::WebSocketStream<TcpStream>,
            RouteIdentity,
            String,
        ),
        String,
    > {
        let max_wire_frame_bytes = MAX_HEADER_BYTES + MAX_PAYLOAD_BYTES + 8;
        let config = WebSocketConfig::default()
            .read_buffer_size(16 * 1024)
            .write_buffer_size(16 * 1024)
            .max_write_buffer_size(2 * max_wire_frame_bytes)
            .max_message_size(Some(max_wire_frame_bytes))
            .max_frame_size(Some(max_wire_frame_bytes));
        let mut web_socket = timeout(
            WORKER_LINK_BRIDGE_HANDSHAKE_TIMEOUT,
            accept_async_with_config(stream, Some(config)),
        )
        .await
        .map_err(|_| "The native tunnel bridge WebSocket handshake timed out.".to_string())?
        .map_err(|_| "The native tunnel bridge WebSocket handshake failed.".to_string())?;
        let message = timeout(WORKER_LINK_BRIDGE_HANDSHAKE_TIMEOUT, web_socket.next())
            .await
            .map_err(|_| "The native tunnel bridge authorization timed out.".to_string())?
            .ok_or_else(|| "The native tunnel bridge closed during authorization.".to_string())?
            .map_err(|_| "The native tunnel bridge authorization failed.".to_string())?;
        let Message::Text(text) = message else {
            return Err("The native tunnel bridge authorization was invalid.".into());
        };
        if text.len() > MAX_HEADER_BYTES {
            return Err("The native tunnel bridge authorization was too large.".into());
        }
        let mut initialize: WorkerLinkBridgeInitialize = serde_json::from_str(&text)
            .map_err(|_| "The native tunnel bridge authorization was invalid.".to_string())?;
        let supplied_token = Zeroizing::new(std::mem::take(&mut initialize.token));
        if initialize.r#type != "initialize"
            || !constant_time_secret_match(expected_token, supplied_token.as_str())
            || !matches!(initialize.route.as_str(), "local" | "relay")
            || initialize.identity.tunnel_id != tunnel_id
            || initialize.identity.attachment_id != attachment_id
            || !valid_tunnel_identity(&initialize.identity.source_endpoint_id)
            || !valid_tunnel_identity(&initialize.identity.destination_endpoint_id)
            || !initialize
                .identity
                .source_endpoint_id
                .starts_with("worker-link-client:")
            || !initialize
                .identity
                .destination_endpoint_id
                .starts_with("worker-link-worker:")
        {
            return Err("The native tunnel bridge authorization was invalid.".into());
        }
        let identity = RouteIdentity {
            attachment_id: initialize.identity.attachment_id,
            destination_endpoint_id: initialize.identity.destination_endpoint_id,
            source_endpoint_id: initialize.identity.source_endpoint_id,
            tunnel_id: initialize.identity.tunnel_id,
        };
        let ready = serde_json::to_string(&WorkerLinkBridgeReady {
            r#type: "ready",
            attachment_id: &identity.attachment_id,
            tunnel_id: &identity.tunnel_id,
        })
        .map_err(|_| "Could not encode the native tunnel bridge handshake.".to_string())?;
        wait_for_web_socket_send(
            web_socket.send(Message::Text(ready.into())),
            SESSION_SEND_TIMEOUT,
        )
        .await?;
        Ok((web_socket, identity, initialize.route))
    }

    fn constant_time_secret_match(expected: &str, supplied: &str) -> bool {
        if expected.len() != supplied.len() {
            return false;
        }
        expected
            .as_bytes()
            .iter()
            .zip(supplied.as_bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
    }

    async fn run_forward(
        app: Option<AppHandle>,
        listener: TcpListener,
        mut request: StartTunnelForwardRequest,
        counters: Arc<ForwardCounters>,
        retirement_fence: Arc<ForwardRetirementFence>,
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
            if retirement_fence.is_retiring() {
                return;
            }
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
            if retirement_fence.is_retiring() {
                return;
            }
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
            let result = match retirement_fenced_session_outcome(result, &retirement_fence) {
                ForwardSessionResolution::Outcome(result) => result,
                ForwardSessionResolution::RetirementFenced => {
                    // The pool already owns the terminal transition. Wait for
                    // its exact stop so this task cannot win the authoritative
                    // forward-map cleanup race or emit a false terminal event.
                    let _ = (&mut stop).await;
                    return;
                }
            };
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

    fn retirement_fenced_session_outcome(
        outcome: Result<SessionOutcome, String>,
        retirement_fence: &ForwardRetirementFence,
    ) -> ForwardSessionResolution {
        if matches!(outcome, Ok(SessionOutcome::Stopped)) {
            ForwardSessionResolution::Outcome(outcome)
        } else if retirement_fence.is_retiring() {
            ForwardSessionResolution::RetirementFenced
        } else {
            ForwardSessionResolution::Outcome(outcome)
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
        wait_for_web_socket_send(
            web_socket.send(Message::Text(initialize.to_string().into())),
            SESSION_SEND_TIMEOUT,
        )
        .await
        .map_err(|error| {
            if error == "The tunnel WebSocket send timed out." {
                error
            } else {
                "Could not initialize the tunnel attachment.".to_string()
            }
        })?;
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

    async fn wait_for_web_socket_send<F, E>(send: F, send_timeout: Duration) -> Result<(), String>
    where
        F: std::future::Future<Output = Result<(), E>>,
    {
        timeout(send_timeout, send)
            .await
            .map_err(|_| "The tunnel WebSocket send timed out.".to_string())?
            .map_err(|_| "The tunnel WebSocket disconnected.".to_string())
    }

    fn matches_pending_pong(pending: Option<&[u8]>, payload: &[u8]) -> bool {
        pending == Some(payload)
    }

    fn active_route_control(control: RouteControl) -> Option<SessionOutcome> {
        match control {
            RouteControl::ForceRelay {
                completed,
                deadline,
            } if Instant::now() < deadline => Some(SessionOutcome::ForceRelay(completed)),
            RouteControl::ForceRelay { .. } => None,
        }
    }

    async fn wait_for_session_send<F, E>(
        send: F,
        send_timeout: Duration,
        stop: &mut oneshot::Receiver<()>,
        route_controls: &mut mpsc::Receiver<RouteControl>,
        mut pong_deadline: Option<Pin<&mut Sleep>>,
    ) -> Result<Option<SessionOutcome>, String>
    where
        F: Future<Output = Result<(), E>>,
    {
        let send = wait_for_web_socket_send(send, send_timeout);
        tokio::pin!(send);
        loop {
            if let Some(deadline) = pong_deadline.as_mut() {
                tokio::select! {
                    _ = &mut *stop => return Ok(Some(SessionOutcome::Stopped)),
                    control = route_controls.recv() => {
                        let Some(control) = control else {
                            return Ok(Some(SessionOutcome::Stopped));
                        };
                        if let Some(outcome) = active_route_control(control) {
                            return Ok(Some(outcome));
                        }
                    }
                    _ = deadline.as_mut() => {
                        return Err("The tunnel WebSocket heartbeat timed out.".to_string());
                    }
                    result = &mut send => return result.map(|()| None),
                }
            } else {
                tokio::select! {
                    _ = &mut *stop => return Ok(Some(SessionOutcome::Stopped)),
                    control = route_controls.recv() => {
                        let Some(control) = control else {
                            return Ok(Some(SessionOutcome::Stopped));
                        };
                        if let Some(outcome) = active_route_control(control) {
                            return Ok(Some(outcome));
                        }
                    }
                    result = &mut send => return result.map(|()| None),
                }
            }
        }
    }

    fn deliver_inbound_frame(
        connections: &mut ConnectionTasks,
        connection_id: &str,
        frame: InboundFrame,
    ) -> InboundDelivery {
        let Some(connection) = connections.get_mut(connection_id) else {
            return InboundDelivery::Missing;
        };
        if connection.cancellation_requested {
            return InboundDelivery::Missing;
        }
        let delivery = connection.inbound.try_send(frame);
        let reason = match delivery {
            Ok(()) => return InboundDelivery::Delivered,
            Err(mpsc::error::TrySendError::Full(_)) => "inbound-queue-full",
            Err(mpsc::error::TrySendError::Closed(_)) => "inbound-queue-closed",
        };
        connection.cancellation.send_replace(Some(reason));
        connection.cancellation_requested = true;
        InboundDelivery::CancellationRequested { reason }
    }

    async fn run_session(
        app: Option<&AppHandle>,
        diagnostic_trace_id: Option<&str>,
        listener: &TcpListener,
        web_socket: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<TcpStream>,
        >,
        identity: RouteIdentity,
        protection: Option<Arc<DataProtection>>,
        counters: Arc<ForwardCounters>,
        stop: &mut oneshot::Receiver<()>,
        route_controls: &mut mpsc::Receiver<RouteControl>,
    ) -> Result<SessionOutcome, String> {
        run_session_with_timing(
            app,
            diagnostic_trace_id,
            listener,
            web_socket,
            identity,
            protection,
            counters,
            stop,
            route_controls,
            SessionTiming::production(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_session_with_timing<S>(
        app: Option<&AppHandle>,
        diagnostic_trace_id: Option<&str>,
        listener: &TcpListener,
        mut web_socket: tokio_tungstenite::WebSocketStream<S>,
        identity: RouteIdentity,
        protection: Option<Arc<DataProtection>>,
        counters: Arc<ForwardCounters>,
        stop: &mut oneshot::Receiver<()>,
        route_controls: &mut mpsc::Receiver<RouteControl>,
        timing: SessionTiming,
    ) -> Result<SessionOutcome, String>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let (outbound_sender, mut outbound_receiver) =
            mpsc::channel::<OutboundFrame>(OUTBOUND_QUEUE);
        let (completed_sender, mut completed_receiver) = mpsc::channel::<String>(256);
        let mut connections = ConnectionTasks::new();
        let mut heartbeat = interval_at(
            Instant::now() + timing.heartbeat_interval,
            timing.heartbeat_interval,
        );
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let pong_deadline = sleep(timing.pong_timeout);
        tokio::pin!(pong_deadline);
        let mut heartbeat_sequence = 0_u64;
        let mut pending_pong: Option<Vec<u8>> = None;
        let result = async {
            loop {
                tokio::select! {
                _ = &mut *stop => break Ok(SessionOutcome::Stopped),
                control = route_controls.recv() => {
                    match control {
                        Some(control) => {
                            if let Some(outcome) = active_route_control(control) {
                                break Ok(outcome);
                            }
                        },
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
                    let (cancellation, cancellation_receiver) = watch::channel(None);
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
                                cancellation_receiver,
                                task_completed_sender,
                                open_connection,
                            )
                            .await;
                        }
                    });
                    counters.track_connection_task(&connection_id, task.abort_handle());
                    connections.insert(connection_id, ConnectionTask {
                        cancellation,
                        cancellation_requested: false,
                        inbound: sender,
                        task,
                    });
                    let _ = start_sender.send(());
                }
                outbound = outbound_receiver.recv() => {
                    let Some((header, payload)) = outbound else { break Ok(SessionOutcome::Disconnected) };
                    let open_connection_id = match &header {
                        FrameHeader::Open { base, .. } => Some(base.connection_id.clone()),
                        _ => None,
                    };
                    let frame = encode_frame(&header, &payload)?;
                    let pong_timer = if pending_pong.is_some() {
                        Some(pong_deadline.as_mut())
                    } else {
                        None
                    };
                    if let Some(outcome) = wait_for_session_send(
                        web_socket.send(Message::Binary(frame.into())),
                        timing.send_timeout,
                        stop,
                        route_controls,
                        pong_timer,
                    ).await? {
                        break Ok(outcome);
                    }
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
                            if let InboundDelivery::CancellationRequested { reason } = deliver_inbound_frame(
                                &mut connections,
                                &connection_id,
                                (header, payload),
                            ) {
                                if counters.is_first_diagnostic_connection(&connection_id) {
                                    diagnostic_event(
                                        app,
                                        "warn",
                                        "Desktop tunnel retired an unavailable local connection",
                                        json!({
                                            "attachmentId": identity.attachment_id,
                                            "connectionId": connection_id,
                                            "diagnosticTraceId": diagnostic_trace_id,
                                            "event": "desktop.tunnel.local-connection.retired",
                                            "operation": "deliver-inbound-frame",
                                            "reasonCode": reason,
                                            "status": "failed",
                                            "subsystem": "tunnel-forward",
                                            "tunnelId": identity.tunnel_id,
                                        }),
                                    );
                                }
                            }
                        }
                        Message::Ping(payload) => {
                            let pong_timer = if pending_pong.is_some() {
                                Some(pong_deadline.as_mut())
                            } else {
                                None
                            };
                            if let Some(outcome) = wait_for_session_send(
                                web_socket.send(Message::Pong(payload)),
                                timing.send_timeout,
                                stop,
                                route_controls,
                                pong_timer,
                            ).await? {
                                break Ok(outcome);
                            }
                        }
                        Message::Close(_) => break Ok(SessionOutcome::Disconnected),
                        Message::Pong(payload) => {
                            if matches_pending_pong(pending_pong.as_deref(), payload.as_ref()) {
                                pending_pong = None;
                                heartbeat.reset();
                            }
                        }
                        Message::Text(_) | Message::Frame(_) => {}
                    }
                }
                completed = completed_receiver.recv() => {
                    if let Some(connection_id) = completed {
                        connections.remove(&connection_id);
                        counters.untrack_connection_task(&connection_id);
                    }
                }
                _ = heartbeat.tick(), if pending_pong.is_none() => {
                    heartbeat_sequence = heartbeat_sequence.wrapping_add(1);
                    let payload = heartbeat_sequence.to_be_bytes().to_vec();
                    if let Some(outcome) = wait_for_session_send(
                        web_socket.send(Message::Ping(payload.clone().into())),
                        timing.send_timeout,
                        stop,
                        route_controls,
                        None,
                    ).await? {
                        break Ok(outcome);
                    }
                    pending_pong = Some(payload);
                    pong_deadline.as_mut().reset(Instant::now() + timing.pong_timeout);
                }
                _ = &mut pong_deadline, if pending_pong.is_some() => {
                    break Err("The tunnel WebSocket heartbeat timed out.".to_string());
                }
                }
            }
        }
        .await;
        completed_receiver.close();
        abort_session_connections(&mut connections, &counters).await;
        result
    }

    async fn abort_session_connections(
        connections: &mut ConnectionTasks,
        counters: &ForwardCounters,
    ) {
        let tasks = connections
            .drain()
            .map(|(connection_id, connection)| {
                counters.untrack_connection_task(&connection_id);
                connection.task.abort();
                connection.task
            })
            .collect::<Vec<_>>();
        for task in tasks {
            let _ = task.await;
        }
    }

    enum ConnectionEvent {
        Cancelled(&'static str),
        Local(std::io::Result<usize>),
        Remote(Option<InboundFrame>),
    }

    async fn connection_cancellation(
        cancellation: &mut watch::Receiver<Option<&'static str>>,
    ) -> &'static str {
        loop {
            if let Some(reason) = *cancellation.borrow_and_update() {
                return reason;
            }
            if cancellation.changed().await.is_err() {
                return std::future::pending::<&'static str>().await;
            }
        }
    }

    async fn run_connection(
        stream: TcpStream,
        identity: RouteIdentity,
        connection_id: String,
        protection: Option<Arc<DataProtection>>,
        outbound: mpsc::Sender<OutboundFrame>,
        mut inbound: mpsc::Receiver<InboundFrame>,
        mut cancellation: watch::Receiver<Option<&'static str>>,
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
            let _ = completed.send(connection_id).await;
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
                    reason = connection_cancellation(&mut cancellation) => ConnectionEvent::Cancelled(reason),
                    read = reader.read(&mut buffer[..read_size]) => ConnectionEvent::Local(read),
                    remote = inbound.recv() => ConnectionEvent::Remote(remote),
                }
            } else {
                tokio::select! {
                    reason = connection_cancellation(&mut cancellation) => ConnectionEvent::Cancelled(reason),
                    remote = inbound.recv() => ConnectionEvent::Remote(remote),
                }
            };
            match event {
                ConnectionEvent::Cancelled(reason) => {
                    open_connection.set_close_reason(reason);
                    break;
                }
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
                ConnectionEvent::Local(Err(error)) => {
                    open_connection.set_close_reason(match error.kind() {
                        std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::NotConnected
                        | std::io::ErrorKind::UnexpectedEof => "local-reset",
                        _ => "local-read-failed",
                    });
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
                            let write = writer.write_all(&plaintext);
                            tokio::pin!(write);
                            let write_result = tokio::select! {
                                reason = connection_cancellation(&mut cancellation) => {
                                    open_connection.set_close_reason(reason);
                                    break;
                                }
                                result = &mut write => result,
                            };
                            if write_result.is_err() {
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
                            let shutdown = writer.shutdown();
                            tokio::pin!(shutdown);
                            tokio::select! {
                                reason = connection_cancellation(&mut cancellation) => {
                                    open_connection.set_close_reason(reason);
                                    break;
                                }
                                _ = &mut shutdown => {}
                            }
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
        let _ = timeout(
            CONNECTION_CANCEL_TIMEOUT,
            outbound.send((
                FrameHeader::Close {
                    base: identity.base(&connection_id, source_sequence),
                    code: "normal".into(),
                },
                Vec::new(),
            )),
        )
        .await;
        let _ = completed.send(connection_id).await;
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

        fn test_code_pool_identity() -> CodeTransportPoolIdentity {
            CodeTransportPoolIdentity {
                account_id: Some("account-one".into()),
                client_identity_generation: 1,
                client_identity_incarnation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                connection_id: Some("connection-one".into()),
                protected_key_revision: 1,
                security_scope_id: "11111111-1111-4111-8111-111111111111".into(),
                server_control_plane_generation: "22222222-2222-4222-8222-222222222222".into(),
                server_id: "server-one".into(),
                server_url: "https://server.example.test".into(),
                transport_id: "33333333-3333-4333-8333-333333333333".into(),
                user_id: "user-one".into(),
                worker_id: "worker-one".into(),
                worker_process_generation: "44444444-4444-4444-8444-444444444444".into(),
            }
        }

        fn test_code_pool_forward() -> TunnelForwardSummary {
            TunnelForwardSummary {
                attachment_id: "physical-attachment-one".into(),
                diagnostic_trace_id: Some("55555555-5555-4555-8555-555555555555".into()),
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                local_host: "127.0.0.1",
                local_port: 43_123,
                route_state: "local-direct",
                relay_fallback_available: true,
                relay_credential_expires_at_epoch_ms: Some(u64::MAX),
                direct_capability_id: Some("capability-one".into()),
                direct_fallback_reason: None,
                last_destination_rejection_code: None,
                tunnel_id: "33333333-3333-4333-8333-333333333333".into(),
                bytes_from_local: 0,
                bytes_to_local: 0,
                connections_closed: 0,
                connections_opened: 0,
                destination_rejected_count: 0,
                code_pool_generation: Some("77777777-7777-4777-8777-777777777777".into()),
            }
        }

        fn test_active_code_pool_entry(
            identity: CodeTransportPoolIdentity,
            forward: TunnelForwardSummary,
            generation: &str,
        ) -> CodeTransportPoolEntry {
            let (changes, _) = watch::channel(0_u64);
            CodeTransportPoolEntry::Active(ActiveCodeTransport {
                changes,
                forward,
                generation: generation.into(),
                identity,
                leases: HashMap::new(),
                maintenance: None,
                publication_acquisition_id: "99999999-9999-4999-8999-999999999999".into(),
                publication_reservation_id: "88888888-8888-4888-8888-888888888888".into(),
                retirement_fence: Arc::new(ForwardRetirementFence::default()),
            })
        }

        #[test]
        fn worker_link_bridge_secrets_require_an_exact_constant_time_match() {
            let token = "a".repeat(43);
            assert!(constant_time_secret_match(&token, &token));
            assert!(!constant_time_secret_match(&token, &"b".repeat(43)));
            assert!(!constant_time_secret_match(&token, &"a".repeat(42)));
        }

        #[tokio::test]
        async fn worker_link_bridge_accepts_only_the_bound_route_identity() {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let token = "a".repeat(43);
            let expected_token = token.clone();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                accept_worker_link_bridge(stream, &expected_token, "tunnel-one", "attachment-one")
                    .await
            });
            let (mut client, _) = connect_async(format!("ws://{address}/worker-link-tunnel"))
                .await
                .unwrap();
            client
                .send(Message::Text(
                    json!({
                        "type": "initialize",
                        "token": token,
                        "route": "relay",
                        "identity": {
                            "attachmentId": "attachment-one",
                            "destinationEndpointId": "worker-link-worker:worker-one",
                            "sourceEndpointId": "worker-link-client:grant-one",
                            "tunnelId": "tunnel-one",
                        },
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            let ready = client.next().await.unwrap().unwrap();
            let Message::Text(ready) = ready else {
                panic!("bridge did not return a text handshake");
            };
            assert_eq!(
                serde_json::from_str::<Value>(&ready).unwrap(),
                json!({
                    "type": "ready",
                    "attachmentId": "attachment-one",
                    "tunnelId": "tunnel-one",
                })
            );
            let (_, identity, route) = server.await.unwrap().unwrap();
            assert_eq!(identity.tunnel_id, "tunnel-one");
            assert_eq!(identity.attachment_id, "attachment-one");
            assert_eq!(route, "relay");
        }

        #[test]
        fn shared_code_pool_identity_fences_client_auth_incarnations() {
            let identity = test_code_pool_identity();
            assert!(validate_code_transport_pool_identity(
                &identity,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "66666666-6666-4666-8666-666666666666"
            )
            .is_ok());

            let mut replacement = identity.clone();
            replacement.client_identity_generation += 1;
            assert_ne!(replacement, identity);
            assert!(same_code_transport_security_identity(
                &replacement,
                &identity
            ));

            replacement.client_identity_incarnation_id =
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into();
            assert!(!same_code_transport_security_identity(
                &replacement,
                &identity
            ));

            let mut invalid = identity;
            invalid.client_identity_generation = 0;
            assert_eq!(
                validate_code_transport_pool_identity(
                    &invalid,
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "66666666-6666-4666-8666-666666666666"
                )
                .unwrap_err(),
                "The shared Code client identity generation is invalid."
            );
        }

        #[test]
        fn delayed_identity_invalidation_preserves_same_incarnation_on_another_origin() {
            let state = TunnelForwards::default();
            let old_identity = test_code_pool_identity();
            let old_client_identity = code_transport_client_identity(&old_identity);
            let old_transport = old_identity.transport_id.clone();
            let mut fresh_identity = old_identity.clone();
            fresh_identity.connection_id = Some("connection-two".into());
            fresh_identity.server_url = "https://other.example.test".into();
            fresh_identity.transport_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into();
            let fresh_transport = fresh_identity.transport_id.clone();
            let mut fresh_forward = test_code_pool_forward();
            fresh_forward.tunnel_id = fresh_transport.clone();
            fresh_forward.code_pool_generation =
                Some("dddddddd-dddd-4ddd-8ddd-dddddddddddd".into());
            state.code_pool.lock().unwrap().entries.extend([
                (
                    old_transport.clone(),
                    test_active_code_pool_entry(
                        old_identity,
                        test_code_pool_forward(),
                        "77777777-7777-4777-8777-777777777777",
                    ),
                ),
                (
                    fresh_transport.clone(),
                    test_active_code_pool_entry(
                        fresh_identity.clone(),
                        fresh_forward,
                        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    ),
                ),
            ]);

            let stops =
                tombstone_and_invalidate_code_transport_incarnation(&state, &old_client_identity)
                    .unwrap();
            assert_eq!(stops.len(), 1);
            assert_eq!(stops[0].0, old_transport);
            assert!(state
                .code_pool
                .lock()
                .unwrap()
                .entries
                .contains_key(&fresh_transport));
            assert!(code_transport_pool_for_acquire(&state, &old_client_identity).is_err());
            assert!(code_transport_pool_for_acquire(
                &state,
                &code_transport_client_identity(&fresh_identity)
            )
            .is_ok());
        }

        #[test]
        fn identity_invalidation_serializes_after_an_in_flight_acquire_commit() {
            use std::sync::mpsc;
            use std::thread;

            let state = Arc::new(TunnelForwards::default());
            let identity = test_code_pool_identity();
            let client_identity = code_transport_client_identity(&identity);
            let transport_id = identity.transport_id.clone();
            let (acquire_locked_tx, acquire_locked_rx) = mpsc::channel();
            let (commit_tx, commit_rx) = mpsc::channel();
            let acquisition_state = Arc::clone(&state);
            let acquisition = thread::spawn(move || {
                let (_identity_fence, mut pool) =
                    code_transport_pool_for_acquire(&acquisition_state, &client_identity).unwrap();
                acquire_locked_tx.send(()).unwrap();
                commit_rx.recv().unwrap();
                pool.entries.insert(
                    transport_id,
                    test_active_code_pool_entry(
                        identity,
                        test_code_pool_forward(),
                        "77777777-7777-4777-8777-777777777777",
                    ),
                );
            });
            acquire_locked_rx.recv().unwrap();

            let invalidation_state = Arc::clone(&state);
            let old_client_identity = code_transport_client_identity(&test_code_pool_identity());
            let (invalidation_started_tx, invalidation_started_rx) = mpsc::channel();
            let invalidation = thread::spawn(move || {
                invalidation_started_tx.send(()).unwrap();
                tombstone_and_invalidate_code_transport_incarnation(
                    &invalidation_state,
                    &old_client_identity,
                )
                .unwrap()
            });
            invalidation_started_rx.recv().unwrap();
            commit_tx.send(()).unwrap();
            acquisition.join().unwrap();
            let stops = invalidation.join().unwrap();

            assert_eq!(stops.len(), 1);
            assert!(state.code_pool.lock().unwrap().entries.is_empty());
            assert!(state
                .invalidated_code_client_identities
                .lock()
                .unwrap()
                .contains(&code_transport_client_identity(&test_code_pool_identity())));
        }

        #[test]
        fn shared_code_pool_releases_only_the_exact_generation_and_lease() {
            let transport_id = "33333333-3333-4333-8333-333333333333";
            let generation = "77777777-7777-4777-8777-777777777777";
            let first_lease = "88888888-8888-4888-8888-888888888888";
            let second_lease = "99999999-9999-4999-8999-999999999999";
            let (changes, _) = watch::channel(0_u64);
            let retirement_fence = Arc::new(ForwardRetirementFence::default());
            let mut pool = CodeTransportPool {
                entries: HashMap::from([(
                    transport_id.into(),
                    CodeTransportPoolEntry::Active(ActiveCodeTransport {
                        changes,
                        forward: test_code_pool_forward(),
                        generation: generation.into(),
                        identity: test_code_pool_identity(),
                        leases: HashMap::from([
                            (
                                first_lease.into(),
                                CodeTransportLease {
                                    acquisition_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                                    consumer_id: "consumer-one".into(),
                                    window_label: "main".into(),
                                    window_instance_id: "11111111-1111-4111-8111-111111111111"
                                        .into(),
                                },
                            ),
                            (
                                second_lease.into(),
                                CodeTransportLease {
                                    acquisition_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                                    consumer_id: "consumer-two".into(),
                                    window_label: "popout".into(),
                                    window_instance_id: "22222222-2222-4222-8222-222222222222"
                                        .into(),
                                },
                            ),
                        ]),
                        maintenance: None,
                        publication_acquisition_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                        publication_reservation_id: "33333333-3333-4333-8333-333333333333".into(),
                        retirement_fence: retirement_fence.clone(),
                    }),
                )]),
                ..CodeTransportPool::default()
            };

            let CodeTransportReleasePlan::Completed(stale_generation) =
                release_code_transport_pool_lease(
                    &mut pool,
                    transport_id,
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    first_lease,
                )
            else {
                panic!("a stale generation must not stop the active transport")
            };
            assert!(!stale_generation.released);
            assert_eq!(stale_generation.remaining_leases, 2);
            assert!(!retirement_fence.is_retiring());

            let CodeTransportReleasePlan::Completed(first) =
                release_code_transport_pool_lease(&mut pool, transport_id, generation, first_lease)
            else {
                panic!("the first of two leases must retain the transport")
            };
            assert!(first.released);
            assert_eq!(first.remaining_leases, 1);
            assert!(!retirement_fence.is_retiring());
            assert!(matches!(
                pool.entries.get(transport_id),
                Some(CodeTransportPoolEntry::Active(active))
                    if active.leases.contains_key(second_lease)
                        && !active.leases.contains_key(first_lease)
            ));

            let CodeTransportReleasePlan::Stop(stopped) = release_code_transport_pool_lease(
                &mut pool,
                transport_id,
                generation,
                second_lease,
            ) else {
                panic!("the exact last lease must stop the transport")
            };
            assert_eq!(stopped.tunnel_id, transport_id);
            assert!(retirement_fence.is_retiring());
            assert!(matches!(
                pool.entries.get(transport_id),
                Some(CodeTransportPoolEntry::Stopping(entry))
                    if entry.generation == generation
            ));
        }

        #[test]
        fn retirement_fence_before_remote_close_resolves_session_as_stopped() {
            let retirement_fence = ForwardRetirementFence::default();
            retirement_fence.retire();

            assert!(matches!(
                retirement_fenced_session_outcome(
                    Ok(SessionOutcome::Disconnected),
                    &retirement_fence,
                ),
                ForwardSessionResolution::RetirementFenced
            ));
        }

        #[test]
        fn remote_close_before_stop_delivery_observes_synchronous_last_lease_fence() {
            let transport_id = "33333333-3333-4333-8333-333333333333";
            let generation = "77777777-7777-4777-8777-777777777777";
            let lease_id = "88888888-8888-4888-8888-888888888888";
            let retirement_fence = Arc::new(ForwardRetirementFence::default());
            let remote_close = Ok(SessionOutcome::Disconnected);
            let mut entry = match test_active_code_pool_entry(
                test_code_pool_identity(),
                test_code_pool_forward(),
                generation,
            ) {
                CodeTransportPoolEntry::Active(entry) => entry,
                _ => unreachable!(),
            };
            entry.retirement_fence = retirement_fence.clone();
            entry.leases.insert(
                lease_id.into(),
                CodeTransportLease {
                    acquisition_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                    consumer_id: "consumer-one".into(),
                    window_label: "main".into(),
                    window_instance_id: "11111111-1111-4111-8111-111111111111".into(),
                },
            );
            let mut pool = CodeTransportPool {
                entries: HashMap::from([(
                    transport_id.into(),
                    CodeTransportPoolEntry::Active(entry),
                )]),
                ..CodeTransportPool::default()
            };

            assert!(matches!(
                release_code_transport_pool_lease(&mut pool, transport_id, generation, lease_id,),
                CodeTransportReleasePlan::Stop(_)
            ));
            assert!(retirement_fence.is_retiring());
            assert!(matches!(
                retirement_fenced_session_outcome(remote_close, &retirement_fence),
                ForwardSessionResolution::RetirementFenced
            ));
        }

        #[test]
        fn unexpected_remote_close_without_retirement_still_recovers() {
            let retirement_fence = ForwardRetirementFence::default();

            assert!(matches!(
                retirement_fenced_session_outcome(
                    Ok(SessionOutcome::Disconnected),
                    &retirement_fence,
                ),
                ForwardSessionResolution::Outcome(Ok(SessionOutcome::Disconnected))
            ));
        }

        #[test]
        fn unexpected_code_terminal_preserves_one_exact_cleanup_claim() {
            let transport_id = "33333333-3333-4333-8333-333333333333";
            let generation = "77777777-7777-4777-8777-777777777777";
            let first_lease = "88888888-8888-4888-8888-888888888888";
            let second_lease = "99999999-9999-4999-8999-999999999999";
            let state = TunnelForwards::default();
            let (changes, _) = watch::channel(0_u64);
            state.code_pool.lock().unwrap().entries.insert(
                transport_id.into(),
                CodeTransportPoolEntry::Active(ActiveCodeTransport {
                    changes,
                    forward: test_code_pool_forward(),
                    generation: generation.into(),
                    identity: test_code_pool_identity(),
                    leases: HashMap::from([
                        (
                            first_lease.into(),
                            CodeTransportLease {
                                acquisition_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                                consumer_id: "consumer-one".into(),
                                window_label: "main".into(),
                                window_instance_id: "11111111-1111-4111-8111-111111111111".into(),
                            },
                        ),
                        (
                            second_lease.into(),
                            CodeTransportLease {
                                acquisition_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                                consumer_id: "consumer-two".into(),
                                window_label: "popout".into(),
                                window_instance_id: "22222222-2222-4222-8222-222222222222".into(),
                            },
                        ),
                    ]),
                    maintenance: None,
                    publication_acquisition_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                    publication_reservation_id: "33333333-3333-4333-8333-333333333333".into(),
                    retirement_fence: Arc::new(ForwardRetirementFence::default()),
                }),
            );
            let cleanup = ForwardCounters::default().terminal_snapshot(&test_code_pool_forward());

            code_transport_forward_terminated(&state, transport_id, generation, Some(cleanup));

            let mut pool = state.code_pool.lock().unwrap();
            assert!(!pool.entries.contains_key(transport_id));
            // A new generation is not blocked by the old cleanup record and
            // fences its shared server attachment from old cleanup.
            let (changes, _) = watch::channel(0_u64);
            pool.entries.insert(
                transport_id.into(),
                CodeTransportPoolEntry::Stopping(StoppingCodeTransport {
                    changes,
                    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                    identity: test_code_pool_identity(),
                }),
            );
            let first = release_terminated_code_transport_lease(
                &mut pool,
                transport_id,
                generation,
                first_lease,
            )
            .unwrap();
            assert!(first.released);
            assert!(first.stopped.is_none());
            let second = release_terminated_code_transport_lease(
                &mut pool,
                transport_id,
                generation,
                second_lease,
            )
            .unwrap();
            assert!(second.released);
            assert!(second.stopped.is_none());
            assert!(matches!(
                pool.entries.get(transport_id),
                Some(CodeTransportPoolEntry::Stopping(entry))
                    if entry.generation == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            ));
        }

        #[test]
        fn destroyed_code_window_instances_cannot_reacquire_after_label_reuse() {
            let state = TunnelForwards::default();
            let first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
            register_code_transport_window_instance(&state, "main", first).unwrap();
            validate_code_transport_window_instance(&state, "main", first).unwrap();
            retire_code_transport_window_instance(&state, "main");
            assert!(validate_code_transport_window_instance(&state, "main", first).is_err());
            assert!(register_code_transport_window_instance(&state, "main", first).is_err());
            register_code_transport_window_instance(&state, "main", second).unwrap();
            validate_code_transport_window_instance(&state, "main", second).unwrap();
            assert!(validate_code_transport_window_instance(&state, "main", first).is_err());
        }

        #[test]
        fn renderer_reload_rotates_window_token_and_returns_old_ownership_for_cleanup() {
            let state = TunnelForwards::default();
            let first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
            let transport_id = "33333333-3333-4333-8333-333333333333";
            let generation = "77777777-7777-4777-8777-777777777777";
            let reservation_id = "88888888-8888-4888-8888-888888888888";
            register_code_transport_window_instance(&state, "main", first).unwrap();
            let (changes, _) = watch::channel(0_u64);
            state.code_pool.lock().unwrap().entries.insert(
                transport_id.into(),
                CodeTransportPoolEntry::Starting(StartingCodeTransport {
                    changes,
                    completing: false,
                    created_at: Instant::now(),
                    forward: None,
                    generation: generation.into(),
                    identity: test_code_pool_identity(),
                    leader_acquisition_id: "99999999-9999-4999-8999-999999999999".into(),
                    leader_consumer_id: "66666666-6666-4666-8666-666666666666".into(),
                    leader_window_instance_id: first.into(),
                    leader_window_label: "main".into(),
                    retirement_fence: Arc::new(ForwardRetirementFence::default()),
                    reservation_id: reservation_id.into(),
                }),
            );

            assert_eq!(
                register_code_transport_window_instance(&state, "main", second)
                    .unwrap()
                    .as_deref(),
                Some(first)
            );

            let pool = state.code_pool.lock().unwrap();
            assert_eq!(
                code_transport_window_actions(&pool, "main", first),
                vec![(
                    transport_id.into(),
                    generation.into(),
                    None,
                    Some(reservation_id.into()),
                )]
            );
            assert!(code_transport_window_actions(&pool, "main", second).is_empty());
            drop(pool);
            assert!(validate_code_transport_window_instance(&state, "main", first).is_err());
            validate_code_transport_window_instance(&state, "main", second).unwrap();

            take_failed_code_transport_forward(
                &state,
                "main",
                transport_id,
                generation,
                reservation_id,
                Some(first),
            )
            .unwrap();
            assert!(state.code_pool.lock().unwrap().entries.is_empty());
            validate_code_transport_window_instance(&state, "main", second).unwrap();
        }

        #[test]
        fn destroyed_window_cleanup_does_not_match_same_label_replacement() {
            let state = TunnelForwards::default();
            let first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
            let transport_id = "33333333-3333-4333-8333-333333333333";
            register_code_transport_window_instance(&state, "main", first).unwrap();
            assert_eq!(
                retire_code_transport_window_instance(&state, "main").as_deref(),
                Some(first)
            );
            register_code_transport_window_instance(&state, "main", second).unwrap();
            let (changes, _) = watch::channel(0_u64);
            state.code_pool.lock().unwrap().entries.insert(
                transport_id.into(),
                CodeTransportPoolEntry::Starting(StartingCodeTransport {
                    changes,
                    completing: false,
                    created_at: Instant::now(),
                    forward: None,
                    generation: "77777777-7777-4777-8777-777777777777".into(),
                    identity: test_code_pool_identity(),
                    leader_acquisition_id: "99999999-9999-4999-8999-999999999999".into(),
                    leader_consumer_id: "66666666-6666-4666-8666-666666666666".into(),
                    leader_window_instance_id: second.into(),
                    leader_window_label: "main".into(),
                    retirement_fence: Arc::new(ForwardRetirementFence::default()),
                    reservation_id: "88888888-8888-4888-8888-888888888888".into(),
                }),
            );

            let pool = state.code_pool.lock().unwrap();
            assert!(code_transport_window_actions(&pool, "main", first).is_empty());
            assert_eq!(
                code_transport_window_actions(&pool, "main", second).len(),
                1
            );
        }

        #[test]
        fn destroyed_window_exact_cleanup_removes_its_starting_reservation() {
            let state = TunnelForwards::default();
            let window_instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let transport_id = "33333333-3333-4333-8333-333333333333";
            let generation = "77777777-7777-4777-8777-777777777777";
            let reservation_id = "88888888-8888-4888-8888-888888888888";
            register_code_transport_window_instance(&state, "main", window_instance).unwrap();
            let (changes, _) = watch::channel(0_u64);
            state.code_pool.lock().unwrap().entries.insert(
                transport_id.into(),
                CodeTransportPoolEntry::Starting(StartingCodeTransport {
                    changes,
                    completing: false,
                    created_at: Instant::now(),
                    forward: None,
                    generation: generation.into(),
                    identity: test_code_pool_identity(),
                    leader_acquisition_id: "99999999-9999-4999-8999-999999999999".into(),
                    leader_consumer_id: "66666666-6666-4666-8666-666666666666".into(),
                    leader_window_instance_id: window_instance.into(),
                    leader_window_label: "main".into(),
                    retirement_fence: Arc::new(ForwardRetirementFence::default()),
                    reservation_id: reservation_id.into(),
                }),
            );

            assert_eq!(
                retire_code_transport_window_instance(&state, "main").as_deref(),
                Some(window_instance)
            );
            assert!(
                validate_code_transport_window_instance(&state, "main", window_instance).is_err()
            );
            take_failed_code_transport_forward(
                &state,
                "main",
                transport_id,
                generation,
                reservation_id,
                Some(window_instance),
            )
            .unwrap();
            assert!(state.code_pool.lock().unwrap().entries.is_empty());
        }

        #[test]
        fn forward_start_reservation_excludes_generic_and_pooled_interleavings() {
            let state = TunnelForwards::default();
            let transport_id = "33333333-3333-4333-8333-333333333333";
            let generation = "77777777-7777-4777-8777-777777777777";
            let generic = reserve_forward_start(&state, transport_id, None).unwrap();
            assert!(reserve_forward_start(&state, transport_id, None).is_err());
            assert!(reserve_forward_start(&state, transport_id, Some(generation)).is_err());
            drop(generic);
            let pooled = reserve_forward_start(&state, transport_id, Some(generation)).unwrap();
            assert!(reserve_forward_start(&state, transport_id, None).is_err());
            drop(pooled);
            assert!(reserve_forward_start(&state, transport_id, None).is_ok());
        }

        #[test]
        fn publication_is_idempotent_after_native_commit() {
            let state = TunnelForwards::default();
            let window_instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let transport_id = "33333333-3333-4333-8333-333333333333";
            let generation = "77777777-7777-4777-8777-777777777777";
            let reservation_id = "88888888-8888-4888-8888-888888888888";
            register_code_transport_window_instance(&state, "main", window_instance).unwrap();
            let (changes, _) = watch::channel(0_u64);
            state.code_pool.lock().unwrap().entries.insert(
                transport_id.into(),
                CodeTransportPoolEntry::Starting(StartingCodeTransport {
                    changes,
                    completing: false,
                    created_at: Instant::now(),
                    forward: Some(test_code_pool_forward()),
                    generation: generation.into(),
                    identity: test_code_pool_identity(),
                    leader_acquisition_id: "99999999-9999-4999-8999-999999999999".into(),
                    leader_consumer_id: "66666666-6666-4666-8666-666666666666".into(),
                    leader_window_instance_id: window_instance.into(),
                    leader_window_label: "main".into(),
                    retirement_fence: Arc::new(ForwardRetirementFence::default()),
                    reservation_id: reservation_id.into(),
                }),
            );

            let first = publish_code_transport_forward(
                &state,
                "main",
                transport_id,
                generation,
                reservation_id,
                window_instance,
            )
            .unwrap();
            let second = publish_code_transport_forward(
                &state,
                "main",
                transport_id,
                generation,
                reservation_id,
                window_instance,
            )
            .unwrap();
            let reconciled = reconcile_code_transport_forward(
                &state,
                "main",
                "99999999-9999-4999-8999-999999999999",
                "66666666-6666-4666-8666-666666666666",
                transport_id,
                generation,
                reservation_id,
                window_instance,
            )
            .unwrap();
            let (
                CodeTransportForwardAcquisition::Ready {
                    lease_id: first_lease,
                    ..
                },
                CodeTransportForwardAcquisition::Ready {
                    lease_id: second_lease,
                    ..
                },
            ) = (first, second)
            else {
                panic!("publication must return the exact ready lease")
            };
            assert_eq!(first_lease, second_lease);
            assert!(matches!(
                reconciled,
                Some(CodeTransportForwardAcquisition::Ready { lease_id, .. })
                    if lease_id == first_lease
            ));
            assert!(matches!(
                state.code_pool.lock().unwrap().entries.get(transport_id),
                Some(CodeTransportPoolEntry::Active(active)) if active.leases.len() == 1
            ));
        }

        #[test]
        fn publication_reconciliation_never_elects_a_replacement_leader() {
            let state = TunnelForwards::default();
            let window_instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            register_code_transport_window_instance(&state, "main", window_instance).unwrap();

            let reconciled = reconcile_code_transport_forward(
                &state,
                "main",
                "99999999-9999-4999-8999-999999999999",
                "66666666-6666-4666-8666-666666666666",
                "33333333-3333-4333-8333-333333333333",
                "77777777-7777-4777-8777-777777777777",
                "88888888-8888-4888-8888-888888888888",
                window_instance,
            )
            .unwrap();

            assert!(reconciled.is_none());
            assert!(state.code_pool.lock().unwrap().entries.is_empty());
        }

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
                    deadline: Instant::now() + RELAY_FALLBACK_TIMEOUT,
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
                code_pool_generation: None,
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
                code_pool_generation: None,
            };
            let forward_counters = counters.clone();
            let forward = tokio::spawn(run_forward(
                None,
                listener,
                request,
                forward_counters,
                Arc::new(ForwardRetirementFence::default()),
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
                web_socket
                    .send(Message::Binary(
                        encode_frame(
                            &FrameHeader::Close {
                                base: FrameBase {
                                    sequence: 3,
                                    ..base
                                },
                                code: "normal".into(),
                            },
                            &[],
                        )
                        .unwrap()
                        .into(),
                    ))
                    .await
                    .unwrap();
                while let Some(Ok(message)) = web_socket.next().await {
                    let Message::Binary(frame) = message else {
                        continue;
                    };
                    let (header, _) = decode_frame(&frame).unwrap();
                    if matches!(header, FrameHeader::Close { .. }) {
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
                code_pool_generation: None,
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
                code_pool_generation: None,
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
                    deadline: Instant::now() + RELAY_FALLBACK_TIMEOUT,
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
        fn terminal_forward_event_carries_only_exact_route_identity() {
            let payload = serde_json::to_value(TunnelForwardTerminalEvent {
                attachment_id: "attachment-one".into(),
                diagnostic_trace_id: Some("trace-one".into()),
                reason_code: "route-terminated",
                tunnel_id: "tunnel-one".into(),
            })
            .unwrap();

            assert_eq!(
                payload,
                json!({
                    "attachmentId": "attachment-one",
                    "diagnosticTraceId": "trace-one",
                    "reasonCode": "route-terminated",
                    "tunnelId": "tunnel-one",
                })
            );
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
                code_pool_generation: None,
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
                code_pool_generation: None,
            };

            assert!(!confirm_direct_retired_summary(
                &mut summary,
                "stale-capability"
            ));
            assert_eq!(
                summary.direct_capability_id.as_deref(),
                Some("replacement-capability")
            );
            assert!(!matches_direct_capability(&summary, "stale-capability"));
            assert!(matches_direct_capability(
                &summary,
                "replacement-capability"
            ));
            assert!(confirm_direct_retired_summary(
                &mut summary,
                "replacement-capability"
            ));
            assert!(summary.direct_capability_id.is_none());
        }

        #[test]
        fn stale_stop_fence_cannot_match_a_replacement_forward() {
            let mut summary = TunnelForwardSummary {
                attachment_id: "current-attachment".into(),
                diagnostic_trace_id: None,
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                local_host: "127.0.0.1",
                local_port: 43_123,
                route_state: "local-direct",
                relay_fallback_available: true,
                relay_credential_expires_at_epoch_ms: Some(u64::MAX),
                direct_capability_id: Some("current-capability".into()),
                direct_fallback_reason: None,
                last_destination_rejection_code: None,
                tunnel_id: "tunnel".into(),
                bytes_from_local: 0,
                bytes_to_local: 0,
                connections_closed: 0,
                connections_opened: 0,
                destination_rejected_count: 0,
                code_pool_generation: None,
            };

            assert!(stop_fence_matches(
                &summary,
                Some("current-attachment"),
                None,
                Some("current-capability")
            ));
            assert!(!stop_fence_matches(
                &summary,
                Some("stale-attachment"),
                None,
                Some("current-capability")
            ));
            assert!(!stop_fence_matches(
                &summary,
                Some("current-attachment"),
                None,
                Some("stale-capability")
            ));
            assert!(!stop_fence_matches(
                &summary,
                Some("current-attachment"),
                None,
                None
            ));

            summary.route_state = "relayed";
            summary.direct_capability_id = None;
            summary.diagnostic_trace_id = Some("replacement-trace".into());
            assert!(!stop_fence_matches(
                &summary,
                Some("current-attachment"),
                Some("stale-trace"),
                None
            ));
            assert!(stop_fence_matches(
                &summary,
                Some("current-attachment"),
                Some("replacement-trace"),
                Some("stale-capability")
            ));
            assert!(stop_fence_matches(&summary, None, None, None));
        }

        #[tokio::test]
        async fn stale_stop_leaves_the_replacement_forward_installed() {
            let summary = TunnelForwardSummary {
                attachment_id: "replacement-attachment".into(),
                diagnostic_trace_id: Some("replacement-trace".into()),
                expires_at: "2099-01-01T00:00:00.000Z".into(),
                local_host: "127.0.0.1",
                local_port: 43_123,
                route_state: "local-direct",
                relay_fallback_available: true,
                relay_credential_expires_at_epoch_ms: Some(u64::MAX),
                direct_capability_id: Some("replacement-capability".into()),
                direct_fallback_reason: None,
                last_destination_rejection_code: None,
                tunnel_id: "tunnel".into(),
                bytes_from_local: 0,
                bytes_to_local: 0,
                connections_closed: 0,
                connections_opened: 0,
                destination_rejected_count: 0,
                code_pool_generation: None,
            };
            let (relay_refresh, _relay_refresh_receiver) =
                watch::channel::<Option<Arc<RelayRoute>>>(None);
            let (route_control, _route_control_receiver) = mpsc::channel::<RouteControl>(1);
            let (stop, _stop_receiver) = oneshot::channel();
            let task = tauri::async_runtime::spawn(std::future::pending::<()>());
            let mut forwards = HashMap::from([(
                "tunnel".to_string(),
                ForwardHandle {
                    code_pool_generation: None,
                    counters: Arc::new(ForwardCounters::default()),
                    relay_refresh,
                    route_control,
                    stop: Some(stop),
                    summary,
                    task,
                },
            )]);

            assert!(take_forward_for_stop(
                &mut forwards,
                "tunnel",
                Some("stale-attachment"),
                Some("replacement-trace"),
                Some("replacement-capability"),
                None,
            )
            .is_none());
            assert_eq!(
                forwards
                    .get("tunnel")
                    .map(|forward| forward.summary.attachment_id.as_str()),
                Some("replacement-attachment")
            );

            assert!(take_forward_for_stop(
                &mut forwards,
                "tunnel",
                Some("replacement-attachment"),
                Some("stale-trace"),
                Some("replacement-capability"),
                None,
            )
            .is_none());
            assert!(forwards.contains_key("tunnel"));

            assert!(take_forward_for_stop(
                &mut forwards,
                "tunnel",
                Some("replacement-attachment"),
                Some("replacement-trace"),
                Some("stale-capability"),
                None,
            )
            .is_none());
            assert!(forwards.contains_key("tunnel"));

            let mut removed = take_forward_for_stop(
                &mut forwards,
                "tunnel",
                Some("replacement-attachment"),
                Some("replacement-trace"),
                Some("replacement-capability"),
                None,
            )
            .expect("the exact replacement identity should remove the forward");
            assert!(forwards.is_empty());
            abort_forward(&mut removed);
            let _ = removed.task.await;
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

        #[tokio::test]
        async fn session_teardown_immediately_aborts_many_stalled_connections() {
            const CONNECTION_COUNT: usize = 256;
            let counters = Arc::new(ForwardCounters::default());
            let mut connections = HashMap::new();
            for index in 0..CONNECTION_COUNT {
                let connection_id = format!("connection-{index}");
                let (inbound, _inbound_receiver) = mpsc::channel(1);
                let (cancellation, _cancellation_receiver) = watch::channel(None);
                let task = tokio::spawn(std::future::pending::<()>());
                counters.track_connection_task(&connection_id, task.abort_handle());
                connections.insert(
                    connection_id,
                    ConnectionTask {
                        cancellation,
                        cancellation_requested: false,
                        inbound,
                        task,
                    },
                );
            }

            timeout(
                Duration::from_millis(100),
                abort_session_connections(&mut connections, &counters),
            )
            .await
            .expect("session teardown should abort all connections under one bounded deadline");

            assert!(connections.is_empty());
            assert!(counters
                .connection_tasks
                .lock()
                .expect("connection task registry")
                .is_empty());
        }

        #[tokio::test]
        async fn congested_inbound_connection_is_cancelled_without_affecting_its_sibling() {
            let identity = RouteIdentity {
                attachment_id: "attachment".into(),
                destination_endpoint_id: "destination".into(),
                source_endpoint_id: "source".into(),
                tunnel_id: "tunnel".into(),
            };
            let congested_frame = || {
                (
                    FrameHeader::Close {
                        base: identity.base("congested", 1),
                        code: "test".into(),
                    },
                    Vec::new(),
                )
            };
            let sibling_frame = (
                FrameHeader::Close {
                    base: identity.base("sibling", 1),
                    code: "test".into(),
                },
                Vec::new(),
            );
            let (congested_sender, congested_receiver) = mpsc::channel(1);
            congested_sender.try_send(congested_frame()).unwrap();
            let (congested_cancellation, mut congested_cancellation_receiver) =
                watch::channel(None);
            let (cancellation_observed, cancellation_observation) = oneshot::channel();
            let congested_task = tokio::spawn(async move {
                let _receiver = congested_receiver;
                let reason = connection_cancellation(&mut congested_cancellation_receiver).await;
                let _ = cancellation_observed.send(reason);
                std::future::pending::<()>().await;
            });
            let (sibling_sender, mut sibling_receiver) = mpsc::channel(1);
            let (sibling_cancellation, _sibling_cancellation_receiver) = watch::channel(None);
            let sibling_task = tokio::spawn(std::future::pending::<()>());
            let mut connections = HashMap::from([
                (
                    "congested".into(),
                    ConnectionTask {
                        cancellation: congested_cancellation,
                        cancellation_requested: false,
                        inbound: congested_sender,
                        task: congested_task,
                    },
                ),
                (
                    "sibling".into(),
                    ConnectionTask {
                        cancellation: sibling_cancellation,
                        cancellation_requested: false,
                        inbound: sibling_sender,
                        task: sibling_task,
                    },
                ),
            ]);

            let InboundDelivery::CancellationRequested { reason } =
                deliver_inbound_frame(&mut connections, "congested", congested_frame())
            else {
                panic!("the congested connection should be cancelled")
            };
            assert_eq!(reason, "inbound-queue-full");
            assert!(connections.contains_key("congested"));
            assert!(connections.contains_key("sibling"));
            assert_eq!(cancellation_observation.await.unwrap(), reason);

            assert!(matches!(
                deliver_inbound_frame(&mut connections, "sibling", sibling_frame),
                InboundDelivery::Delivered
            ));
            assert!(sibling_receiver.recv().await.is_some());

            for (_, connection) in connections {
                connection.task.abort();
                let _ = connection.task.await;
            }
        }

        #[tokio::test]
        async fn connection_cancellation_emits_one_ordered_close() {
            let listener = bind_listener(None).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let client = tokio::spawn(async move {
                TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                    .await
                    .unwrap()
            });
            let (stream, _) = listener.accept().await.unwrap();
            let mut client = client.await.unwrap();
            let identity = RouteIdentity {
                attachment_id: "attachment".into(),
                destination_endpoint_id: "destination".into(),
                source_endpoint_id: "source".into(),
                tunnel_id: "tunnel".into(),
            };
            let counters = Arc::new(ForwardCounters::default());
            assert!(counters.register_connection("cancelled"));
            let open_connection = OpenConnection::new(
                None,
                "attachment".into(),
                "cancelled".into(),
                counters,
                None,
                false,
                "tunnel".into(),
            );
            let (outbound, mut outbound_receiver) = mpsc::channel(4);
            let (_inbound, inbound_receiver) = mpsc::channel(1);
            let (cancellation, cancellation_receiver) = watch::channel(None);
            let (completed, mut completed_receiver) = mpsc::channel(1);
            let task = tokio::spawn(run_connection(
                stream,
                identity,
                "cancelled".into(),
                None,
                outbound,
                inbound_receiver,
                cancellation_receiver,
                completed,
                open_connection,
            ));

            let (open, open_payload) = outbound_receiver.recv().await.unwrap();
            assert!(matches!(open, FrameHeader::Open { .. }));
            assert!(open_payload.is_empty());
            cancellation.send_replace(Some("inbound-queue-full"));
            let (close, close_payload) = outbound_receiver.recv().await.unwrap();
            let FrameHeader::Close { base, .. } = close else {
                panic!("connection cancellation should enqueue a Close")
            };
            assert_eq!(base.sequence, 1);
            assert!(close_payload.is_empty());
            assert_eq!(
                completed_receiver.recv().await.as_deref(),
                Some("cancelled")
            );
            task.await.unwrap();
            assert!(timeout(Duration::from_millis(20), outbound_receiver.recv())
                .await
                .unwrap()
                .is_none());
            let mut remaining = Vec::new();
            client.read_to_end(&mut remaining).await.unwrap();
            assert!(remaining.is_empty());
        }

        #[tokio::test]
        async fn web_socket_send_wait_is_bounded() {
            let result = wait_for_web_socket_send(
                std::future::pending::<Result<(), ()>>(),
                Duration::from_millis(10),
            )
            .await;

            assert_eq!(result.unwrap_err(), "The tunnel WebSocket send timed out.");
        }

        #[tokio::test]
        async fn stalled_web_socket_send_does_not_block_route_control() {
            let (_stop_sender, mut stop_receiver) = oneshot::channel();
            let (route_control_sender, mut route_controls) = mpsc::channel(1);
            let (completed, mut completion) = oneshot::channel();
            route_control_sender
                .send(RouteControl::ForceRelay {
                    completed,
                    deadline: Instant::now() + Duration::from_secs(1),
                })
                .await
                .unwrap();

            let result = timeout(
                Duration::from_millis(50),
                wait_for_session_send(
                    std::future::pending::<Result<(), ()>>(),
                    Duration::from_secs(10),
                    &mut stop_receiver,
                    &mut route_controls,
                    None,
                ),
            )
            .await
            .expect("route control should preempt a stalled WebSocket send")
            .unwrap();

            let Some(SessionOutcome::ForceRelay(completed)) = result else {
                panic!("expected relay fallback control")
            };
            assert!(completion.try_recv().is_err());
            completed.send(Ok(())).unwrap();
            assert_eq!(completion.await.unwrap(), Ok(()));
        }

        #[tokio::test]
        async fn stalled_web_socket_send_does_not_block_pong_deadline() {
            let (_stop_sender, mut stop_receiver) = oneshot::channel();
            let (_route_control_sender, mut route_controls) = mpsc::channel(1);
            let pong_deadline = sleep(Duration::from_millis(10));
            tokio::pin!(pong_deadline);

            let result = timeout(
                Duration::from_millis(50),
                wait_for_session_send(
                    std::future::pending::<Result<(), ()>>(),
                    Duration::from_secs(10),
                    &mut stop_receiver,
                    &mut route_controls,
                    Some(pong_deadline.as_mut()),
                ),
            )
            .await
            .expect("Pong deadline should preempt a stalled WebSocket send");

            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("the stalled send should not mask the Pong deadline"),
            };
            assert_eq!(error, "The tunnel WebSocket heartbeat timed out.");
        }

        #[test]
        fn expired_route_control_cannot_execute_late() {
            let (completed, mut completion) = oneshot::channel();
            let outcome = active_route_control(RouteControl::ForceRelay {
                completed,
                deadline: Instant::now() - Duration::from_millis(1),
            });

            assert!(outcome.is_none());
            assert!(matches!(
                completion.try_recv(),
                Err(oneshot::error::TryRecvError::Closed)
            ));
        }

        #[test]
        fn only_the_pending_heartbeat_pong_satisfies_liveness() {
            assert!(matches_pending_pong(Some(b"heartbeat-7"), b"heartbeat-7"));
            assert!(!matches_pending_pong(Some(b"heartbeat-7"), b"heartbeat-6"));
            assert!(!matches_pending_pong(None, b"heartbeat-7"));
        }

        #[tokio::test]
        async fn session_exits_when_the_matching_heartbeat_pong_is_not_received() {
            let server_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let server_port = server_listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (stream, _) = server_listener.accept().await.unwrap();
                let _web_socket = accept_hdr_async(
                    stream,
                    |_request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                     response| { Ok(response) },
                )
                .await
                .unwrap();
                sleep(Duration::from_secs(1)).await;
            });
            let (web_socket, _) =
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{server_port}"))
                    .await
                    .unwrap();
            let listener = bind_listener(None).await.unwrap();
            let (_stop_sender, mut stop_receiver) = oneshot::channel();
            let (_route_control_sender, mut route_controls) = mpsc::channel(1);
            let result = timeout(
                Duration::from_millis(250),
                run_session_with_timing(
                    None,
                    None,
                    &listener,
                    web_socket,
                    RouteIdentity {
                        attachment_id: "attachment".into(),
                        destination_endpoint_id: "destination".into(),
                        source_endpoint_id: "source".into(),
                        tunnel_id: "tunnel".into(),
                    },
                    None,
                    Arc::new(ForwardCounters::default()),
                    &mut stop_receiver,
                    &mut route_controls,
                    SessionTiming {
                        heartbeat_interval: Duration::from_millis(10),
                        pong_timeout: Duration::from_millis(20),
                        send_timeout: Duration::from_millis(20),
                    },
                ),
            )
            .await
            .expect("the missing Pong deadline should remain bounded");

            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("the session should fail its missing Pong deadline"),
            };
            assert_eq!(error, "The tunnel WebSocket heartbeat timed out.");
            server.abort();
            let _ = server.await;
        }
    }
}
