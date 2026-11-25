//! The standard one-use WorkerLink loopback broker admission and identity check.
use super::{Host, relay::Socket};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::{checked, decode, encode, random_bytes};
use cantrip_wire::{Value, parse_json_text, value::json};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub(super) async fn connect(host: &Host, path: &str, session: &Value) -> Result<Socket> {
    let ticket = host.carrier(path, "local-open", Value::Null).await?;
    let ticket = checked("directAttachmentTicketSchema", &ticket)?;
    let broker = &ticket["broker"];
    let binding = &ticket["binding"];
    let identity = &session["identity"];
    let capability = binding["capabilityId"]
        .as_str()
        .context("Direct capability ID")?;
    ensure!(
        broker["loopbackHost"] == "127.0.0.1"
            && binding["workerId"] == identity["workerId"]
            && binding["ownerId"] == identity["ownerId"]
            && binding["authSessionId"] == identity["accountSessionId"]
            && binding["attachmentId"] == session["sessionId"]
            && binding["resourceId"] == session["sessionId"]
            && binding["resourceKind"] == "worker-link",
        "WorkerLink returned another direct attachment."
    );
    let endpoint = format!(
        "ws://127.0.0.1:{}/direct/v1",
        broker["loopbackPort"]
            .as_u64()
            .context("Direct broker port")?,
    );
    let challenge = encode(&random_bytes(32)?);
    let (mut socket, _) = connect_async(endpoint).await?;
    let init = json!({"type":"initialize","binding":binding,"secret":ticket["secret"],"challenge":challenge});
    socket.send(Message::Text(init.stringify().into())).await?;
    let message = socket
        .next()
        .await
        .context("Direct identity proof unavailable.")??;
    let ready = parse_json_text(message.to_text()?)
        .map_err(|_| anyhow!("Invalid direct broker identity proof."))?;
    ensure!(
        ready["type"] == "ready"
            && ready["brokerInstanceId"] == broker["instanceId"]
            && ready["fingerprint"] == broker["fingerprint"]
            && ready["challenge"] == challenge,
        "WorkerLink direct broker identity changed."
    );
    let key: [u8; 32] = decode(broker["publicKey"].as_str().context("Direct broker key")?)?
        .try_into()
        .map_err(|_| anyhow!("Invalid direct broker key."))?;
    let fingerprint = Sha256::digest(key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    ensure!(
        broker["fingerprint"] == fingerprint,
        "WorkerLink direct broker fingerprint changed."
    );
    let signature = Signature::from_slice(&decode(
        ready["signature"]
            .as_str()
            .context("Direct broker signature")?,
    )?)?;
    VerifyingKey::from_bytes(&key)?.verify(
        format!("cantrip-direct-v1\0{capability}\0{challenge}").as_bytes(),
        &signature,
    )?;
    host.carrier(path, "local-activate", json!({"capabilityId":capability}))
        .await?;
    Ok(socket)
}
