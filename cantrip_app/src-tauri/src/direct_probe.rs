use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectBrokerAdvertisement {
    pub(crate) loopback_host: String,
    pub(crate) loopback_port: u16,
    pub(crate) instance_id: String,
    pub(crate) public_key: String,
    pub(crate) fingerprint: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectCapabilityBinding {
    pub(crate) capability_id: String,
    pub(crate) owner_id: String,
    pub(crate) auth_session_id: String,
    pub(crate) worker_id: String,
    pub(crate) resource_kind: String,
    pub(crate) resource_id: String,
    pub(crate) attachment_id: String,
    pub(crate) channels: Vec<String>,
    pub(crate) expires_at: String,
    pub(crate) lease_expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProbeRequest {
    pub(crate) broker: DirectBrokerAdvertisement,
    pub(crate) binding: DirectCapabilityBinding,
    pub(crate) secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMessage {
    #[serde(rename = "type")]
    kind: String,
    broker_instance_id: String,
    fingerprint: String,
    challenge: String,
    signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProbeResult {
    state: &'static str,
    reason: Option<String>,
    latency_ms: Option<f64>,
    worker_id: String,
    broker_instance_id: Option<String>,
}

fn relayed(worker_id: String, reason: impl Into<String>) -> DirectProbeResult {
    DirectProbeResult {
        state: "relayed",
        reason: Some(reason.into()),
        latency_ms: None,
        worker_id,
        broker_instance_id: None,
    }
}

pub(crate) struct VerifiedDirectConnection {
    pub(crate) broker_instance_id: String,
    pub(crate) latency_ms: f64,
    pub(crate) socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pub(crate) worker_id: String,
}

pub(crate) async fn connect_verified(
    mut request: DirectProbeRequest,
) -> Result<VerifiedDirectConnection, String> {
    if request.broker.loopback_host != "127.0.0.1" {
        return Err("Direct broker endpoint is not loopback-only.".into());
    }
    let worker_id = request.binding.worker_id.clone();
    let capability_id = request.binding.capability_id.clone();
    let secret = Zeroizing::new(std::mem::take(&mut request.secret));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(Uuid::new_v4().as_bytes()));
    let url = format!("ws://127.0.0.1:{}/direct/v1", request.broker.loopback_port);
    let started = Instant::now();
    let (mut socket, _) = timeout(Duration::from_secs(3), connect_async(url))
        .await
        .map_err(|_| "Local direct broker probe timed out.".to_string())?
        .map_err(|error| format!("Local direct broker is unavailable: {error}"))?;
    let initialize = serde_json::json!({
        "type": "initialize",
        "binding": request.binding,
        "secret": secret.as_str(),
        "challenge": challenge,
    });
    socket
        .send(Message::Text(initialize.to_string().into()))
        .await
        .map_err(|error| format!("Could not initialize local direct broker: {error}"))?;
    let message = timeout(Duration::from_secs(3), socket.next())
        .await
        .map_err(|_| "Local direct broker identity proof timed out.".to_string())?
        .ok_or_else(|| "Local direct broker closed before identity proof.".to_string())?
        .map_err(|error| format!("Local direct broker proof failed: {error}"))?;
    let text = message
        .into_text()
        .map_err(|_| "Local direct broker proof was not JSON.".to_string())?;
    let ready: ReadyMessage = serde_json::from_str(&text)
        .map_err(|_| "Local direct broker proof was invalid.".to_string())?;
    if ready.kind != "ready"
        || ready.broker_instance_id != request.broker.instance_id
        || ready.fingerprint != request.broker.fingerprint
        || ready.challenge != challenge
    {
        return Err("Local direct broker identity did not match the server advertisement.".into());
    }
    let public_key_bytes = URL_SAFE_NO_PAD
        .decode(&request.broker.public_key)
        .map_err(|_| "Local direct broker public key was invalid.".to_string())?;
    let public_key: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| "Local direct broker public key had an invalid length.".to_string())?;
    let expected_fingerprint = format!("{:x}", Sha256::digest(public_key));
    if expected_fingerprint != request.broker.fingerprint {
        return Err("Local direct broker public key fingerprint did not match.".into());
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&ready.signature)
        .map_err(|_| "Local direct broker signature was invalid.".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Local direct broker signature had an invalid length.".to_string())?;
    let payload = format!("cantrip-direct-v1\0{}\0{}", capability_id, challenge);
    VerifyingKey::from_bytes(&public_key)
        .map_err(|_| "Local direct broker public key was invalid.".to_string())?
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| "Local direct broker identity signature was rejected.".to_string())?;
    Ok(VerifiedDirectConnection {
        broker_instance_id: ready.broker_instance_id,
        latency_ms: started.elapsed().as_secs_f64() * 1_000.0,
        socket,
        worker_id,
    })
}

#[tauri::command]
pub async fn probe_direct_worker(request: DirectProbeRequest) -> DirectProbeResult {
    let worker_id = request.binding.worker_id.clone();
    match connect_verified(request).await {
        Ok(mut connection) => {
            let _ = connection.socket.close(None).await;
            DirectProbeResult {
                state: "local-direct",
                reason: None,
                latency_ms: Some(connection.latency_ms),
                worker_id: connection.worker_id,
                broker_instance_id: Some(connection.broker_instance_id),
            }
        }
        Err(reason) => relayed(worker_id, reason),
    }
}
