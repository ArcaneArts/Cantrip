//! Short-lived direct attachment authority and loopback listener.
mod socket;

use super::{
    Coordinator, GRACE,
    carrier::{Local, SocketFrames, SocketOutput},
    id,
    terminal::DirectTerminal,
    timestamp,
    tunnel::DirectTunnel,
};
use crate::{http::checked, logging::Logs};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_wire::{JsString, Value, value::json};
use chrono::{DateTime, SecondsFormat, Utc};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::Ipv4Addr,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::watch, task::JoinSet, time::Instant};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_PREPARED: usize = 128;
const MAX_SOCKETS: usize = 256;

pub(crate) struct Broker {
    worker: JsString,
    signing: SigningKey,
    advertisement: Value,
    logs: Arc<Logs>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    identity: Option<(JsString, Value)>,
    disconnected: Option<Instant>,
    prepared: HashMap<JsString, Prepared>,
    active: HashMap<JsString, Arc<Session>>,
}

struct Prepared {
    binding: Value,
    route: Value,
    trace: Option<Value>,
    secret: Zeroizing<[u8; 32]>,
    deadline: i64,
    lease: Lease,
}

struct Session {
    binding: Value,
    trace: Option<Value>,
    resource: Resource,
    control: watch::Sender<Control>,
}

enum Resource {
    Probe,
    Tunnel(Arc<DirectTunnel>),
    WorkerLink(Arc<Local>),
}

#[derive(Clone)]
struct Lease {
    at: i64,
    wire: Value,
}

#[derive(Clone)]
enum Control {
    Live(Lease),
    Retired(String),
}

struct Opened {
    key: JsString,
    session: Arc<Session>,
    outgoing: Option<SocketFrames>,
    ready: Value,
}

impl Broker {
    pub(crate) async fn bind(
        worker: JsString,
        logs: Arc<Logs>,
    ) -> Result<(Arc<Self>, TcpListener)> {
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::fill(seed.as_mut())?;
        let signing = SigningKey::from_bytes(&seed);
        let public = signing.verifying_key().to_bytes();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let advertisement = json!({
            "available":true, "leaseRenewal":true, "protocol":"ws-v1",
            "loopbackHost":"127.0.0.1", "loopbackPort":listener.local_addr()?.port(),
            "instanceId":Uuid::new_v4().to_string(), "publicKey":URL_SAFE_NO_PAD.encode(public),
            "fingerprint":super::hex_digest(&Sha256::digest(public)),
        });
        Ok((
            Arc::new(Self {
                worker,
                signing,
                advertisement,
                logs,
                state: Mutex::default(),
            }),
            listener,
        ))
    }

    pub(crate) fn advertisement(&self) -> &Value {
        &self.advertisement
    }

    pub(crate) fn supports(kind: &str) -> bool {
        matches!(
            kind,
            "direct.capability.prepare" | "direct.capability.renew" | "direct.capability.revoke"
        )
    }

    pub(crate) fn execute(&self, command: &Value, gateway: &Coordinator) -> Result<Value> {
        // Run state may publish observations. Check it outside the broker lock.
        if command["type"] == "direct.capability.prepare"
            && command["binding"]["resourceKind"] == "terminal"
        {
            gateway
                .terminals
                .get()
                .context("Direct terminal adapter is unavailable.")?
                .check_direct(&command["binding"]["resourceId"])?;
        }
        let mut state = self.state.lock().unwrap();
        state.sweep();
        match command["type"].as_str() {
            Some("direct.capability.prepare") => self.prepare(&mut state, command),
            Some("direct.capability.revoke") => {
                let revoked = state.revoke(
                    id(command, "capabilityId"),
                    command["reason"].as_str().unwrap(),
                );
                Ok(json!({"revoked":revoked}))
            }
            Some("direct.capability.renew") => {
                let renewed = state.renew(id(command, "capabilityId"), command)?;
                let result = renewed.map_or_else(
                    || json!({"renewed":false}),
                    |lease| json!({"renewed":true,"leaseExpiresAt":lease.wire}),
                );
                checked("directCapabilityRenewResultSchema", &result)
            }
            _ => bail!("Unknown direct capability command."),
        }
    }

    fn prepare(&self, state: &mut State, command: &Value) -> Result<Value> {
        let binding = &command["binding"];
        let route = &command["tunnelRoute"];
        ensure!(
            binding["workerId"].as_js_string() == Some(&self.worker),
            "Direct capability targets another worker."
        );
        ensure!(
            state
                .identity
                .as_ref()
                .is_none_or(|(owner, _)| binding["ownerId"].as_js_string() == Some(owner)),
            "Direct capability targets another account."
        );
        let deadline = timestamp(binding, "expiresAt")?;
        let lease = Lease::new(binding)?;
        ensure!(
            deadline > now() && lease.at > now(),
            "Direct capability has already expired."
        );
        let channels = binding["channels"]
            .as_array()
            .context("Direct capability channels")?;
        let tunnel_bound = channels.contains(&json!("tunnel-data"))
            && route["attachmentId"] == binding["attachmentId"]
            && route["destinationEndpointId"] == format!("worker:{}", self.worker).as_str();
        match binding["resourceKind"].as_str() {
            Some("probe") if route.is_null() && channels.contains(&json!("probe")) => {}
            Some("worker-link")
                if route.is_null()
                    && channels.contains(&json!("worker-link"))
                    && binding["resourceId"] == binding["attachmentId"] => {}
            Some("tunnel" | "project-share")
                if tunnel_bound
                    && route["tunnelId"] == binding["resourceId"]
                    && route["target"]["kind"] == "protected-tunnel"
                    && route["target"]["recordId"] == binding["resourceId"] => {}
            Some("terminal")
                if tunnel_bound
                    && route["tunnelId"]
                        == format!("terminal:{}", id(binding, "resourceId")).as_str()
                    && route["target"]["kind"] == "adapter"
                    && route["target"]["adapter"] == "terminal"
                    && route["target"]["resourceId"] == binding["resourceId"] => {}
            _ => bail!("Direct route does not match a supported capability."),
        }
        ensure!(
            state.prepared.len() < MAX_PREPARED,
            "Direct capability queue is full."
        );
        let key = id(binding, "capabilityId");
        state.revoke(key, "Capability rotated");
        state.prepared.insert(
            key.clone(),
            Prepared {
                binding: binding.clone(),
                route: route.clone(),
                trace: command.get("diagnosticTraceId").cloned(),
                secret: secret(command),
                deadline,
                lease,
            },
        );
        checked(
            "directCapabilityPrepareResultSchema",
            &json!({"accepted":true,"capabilityId":key}),
        )
    }

    fn initialize(&self, request: &Value) -> Result<Opened> {
        let key = id(&request["binding"], "capabilityId");
        let mut state = self.state.lock().unwrap();
        state.sweep();
        let prepared = state
            .prepared
            .get(key)
            .context("Unknown direct capability")?;
        ensure!(
            prepared.binding == request["binding"]
                && bool::from(prepared.secret.ct_eq(&secret(request)[..])),
            "Invalid direct capability",
        );
        let prepared = state
            .prepared
            .remove(key)
            .expect("matching direct capability");
        let challenge = id(request, "challenge");
        let signature = self
            .signing
            .sign(format!("cantrip-direct-v1\0{key}\0{challenge}").as_bytes());
        let ready = checked(
            "directBrokerReadySchema",
            &json!({
                "type":"ready", "directSessionId":Uuid::new_v4().to_string(),
                "brokerInstanceId":self.advertisement["instanceId"], "fingerprint":self.advertisement["fingerprint"],
                "challenge":challenge, "signature":URL_SAFE_NO_PAD.encode(signature.to_bytes()),
                "leaseExpiresAt":prepared.lease.wire,
            }),
        )?;
        let (resource, outgoing) = match prepared.binding["resourceKind"].as_str() {
            Some("probe") => (Resource::Probe, None),
            Some("worker-link") => {
                let (output, frames) = SocketOutput::channel();
                let local = Local::new(id(&prepared.binding, "resourceId").clone(), output);
                (Resource::WorkerLink(local), Some(frames))
            }
            _ => {
                let (output, frames) = SocketOutput::channel();
                let terminal = (prepared.binding["resourceKind"] == "terminal").then(|| {
                    Arc::new(DirectTerminal::new(
                        &prepared.route["target"],
                        prepared.binding["ownerId"].clone(),
                    ))
                });
                let tunnel =
                    DirectTunnel::new(prepared.route, prepared.trace.clone(), output, terminal);
                (Resource::Tunnel(tunnel), Some(frames))
            }
        };
        let session = Arc::new(Session {
            binding: prepared.binding,
            trace: prepared.trace,
            resource,
            control: watch::channel(Control::Live(prepared.lease)).0,
        });
        state.active.insert(key.clone(), session.clone());
        Ok(Opened {
            key: key.clone(),
            session,
            outgoing,
            ready,
        })
    }

    pub(crate) fn reconcile(&self, identity: Option<&(JsString, Value)>) {
        let mut state = self.state.lock().unwrap();
        state.sweep();
        if state.identity.as_ref() != identity {
            state.revoke_all("Account authority changed");
            state.identity = identity.cloned();
        }
    }

    pub(crate) fn connected(&self) {
        let mut state = self.state.lock().unwrap();
        state.sweep();
        state.disconnected = None;
    }

    pub(crate) fn disconnected(&self) {
        self.state
            .lock()
            .unwrap()
            .disconnected
            .get_or_insert(Instant::now() + GRACE);
    }

    pub(crate) fn revoke_all(&self, reason: &str) {
        self.state.lock().unwrap().revoke_all(reason);
    }

    pub(crate) async fn run(
        self: Arc<Self>,
        listener: TcpListener,
        gateway: Weak<Coordinator>,
        mut stop: watch::Receiver<bool>,
    ) {
        self.logs.event("info", "Direct capability broker started", json!({
            "event":"direct.broker.started","subsystem":"direct-broker","operation":"start","status":"completed","protocol":"ws-v1",
        }));
        let mut connections = JoinSet::new();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        while !*stop.borrow() {
            tokio::select! {
                _ = stop.changed() => break,
                _ = connections.join_next(), if !connections.is_empty() => {}
                _ = tick.tick() => self.state.lock().unwrap().sweep(),
                accepted = listener.accept(), if connections.len() < MAX_SOCKETS => {
                    let Ok((stream, _)) = accepted else { break };
                    connections.spawn(socket::accept(self.clone(), gateway.clone(), stream));
                }
            }
        }
        drop(listener);
        self.revoke_all("Worker stopping");
        connections.shutdown().await;
        self.logs.event("info", "Direct capability broker stopped", json!({
            "event":"direct.broker.stopped","subsystem":"direct-broker","operation":"stop","status":"completed",
        }));
    }

    fn release(&self, key: &JsString, session: &Arc<Session>) {
        let mut state = self.state.lock().unwrap();
        if state
            .active
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            state.revoke(key, "Direct connection closed");
        }
    }
}

impl State {
    fn sweep(&mut self) {
        if self
            .disconnected
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            self.revoke_all("Server control connection closed");
            self.disconnected = None;
        }
        let now = now();
        self.prepared
            .retain(|_, prepared| prepared.deadline > now && prepared.lease.at > now);
    }

    fn renew(&mut self, key: &JsString, command: &Value) -> Result<Option<Lease>> {
        let Some(session) = self.active.get(key) else {
            return Ok(None);
        };
        let Control::Live(current) = session.control.borrow().clone() else {
            return Ok(None);
        };
        let requested = Lease::new(command)?;
        if current.at <= now() || requested.at <= now() {
            self.revoke(key, "Lease expired");
            return Ok(None);
        }
        if requested.at <= current.at {
            return Ok(Some(current));
        }
        let lease = Lease {
            at: requested.at,
            wire: json!(
                DateTime::<Utc>::from_timestamp_millis(requested.at)
                    .context("Direct lease timestamp")?
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            ),
        };
        session.control.send_replace(Control::Live(lease.clone()));
        Ok(Some(lease))
    }

    fn revoke(&mut self, key: &JsString, reason: &str) -> bool {
        let prepared = self.prepared.remove(key).is_some();
        let Some(session) = self.active.remove(key) else {
            return prepared;
        };
        session.retire(reason);
        true
    }

    fn revoke_all(&mut self, reason: &str) {
        self.prepared.clear();
        for (_, session) in self.active.drain() {
            session.retire(reason);
        }
    }
}

impl Session {
    fn retire(&self, reason: &str) {
        match &self.resource {
            Resource::Probe => {}
            Resource::Tunnel(tunnel) => tunnel.close(),
            Resource::WorkerLink(local) => local.close(),
        }
        self.control
            .send_replace(Control::Retired(reason.to_owned()));
    }
}

impl Lease {
    fn new(value: &Value) -> Result<Self> {
        Ok(Self {
            at: timestamp(value, "leaseExpiresAt")?,
            wire: value["leaseExpiresAt"].clone(),
        })
    }
}

fn now() -> i64 {
    Utc::now().timestamp_millis()
}

fn secret(value: &Value) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(
        Sha256::digest(value["secret"].as_str().expect("validated direct secret")).into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(at: i64) -> Value {
        json!({"leaseExpiresAt":DateTime::<Utc>::from_timestamp_millis(at).unwrap()
            .to_rfc3339_opts(SecondsFormat::Millis, true)})
    }

    #[test]
    fn renewal_extends_the_active_socket_and_cannot_revive_a_retired_ticket() -> Result<()> {
        let initial = now() + 60_000;
        let key: JsString = "socket".into();
        let session = Arc::new(Session {
            binding: Value::Null,
            trace: None,
            resource: Resource::Probe,
            control: watch::channel(Control::Live(Lease::new(&lease(initial))?)).0,
        });
        let mut state = State::default();
        state.active.insert(key.clone(), session.clone());
        let renewed = initial + 30_000;
        assert_eq!(state.renew(&key, &lease(renewed))?.unwrap().at, renewed);
        assert_eq!(state.renew(&key, &lease(initial))?.unwrap().at, renewed);
        assert!(matches!(&*session.control.borrow(), Control::Live(value) if value.at == renewed));
        assert!(state.revoke(&key, "retired"));
        assert!(
            matches!(&*session.control.borrow(), Control::Retired(reason) if reason == "retired")
        );
        assert!(state.renew(&key, &lease(renewed))?.is_none());
        Ok(())
    }
}
