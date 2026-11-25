//! Worker-side installation of Core-issued session and resource authority.
//! These leases are process-local. They never authorize a carrier by themselves.
mod carrier;
mod channels;
mod direct_broker;
mod external_mcp;
mod observation;
mod peer;
mod terminal;
mod tunnel;
pub(crate) use tunnel::guest::PREPARE as PREPARE_GUEST_TUNNEL;

use crate::{
    browser_surface, connection::Outbound, encryption::Service, http::checked, logging::Logs,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_framing::worker_link::Frame;
use cantrip_protocol::worker_link::identity_key;
use cantrip_wire::{JsString, Value, value::json};
use carrier::{Carrier, Local};
use channels::Channels;
use chrono::Utc;
pub(crate) use direct_broker::Broker as DirectBroker;
use indexmap::IndexMap;
use observation::Observation;
pub(crate) use peer::supports as supports_peer;
use peer::{PeerCarrier, Peers};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{Notify, Semaphore, watch},
    time::Instant,
};

const GRACE: Duration = Duration::from_secs(15);
const SWEEP: Duration = Duration::from_secs(5);
const MAX_SESSIONS: usize = 256;
const MAX_GRANTS: usize = 2_048;
const MAX_GRANTS_PER_SESSION: usize = 128;

pub(crate) struct Coordinator {
    worker: JsString,
    generation: String,
    encryption: Arc<Service>,
    outgoing: Arc<Outbound>,
    logs: Arc<Logs>,
    shares: Arc<crate::project_shares::Manager>,
    direct: Arc<DirectBroker>,
    state: Mutex<State>,
    wake: Arc<Notify>,
    surfaces: OnceLock<Arc<browser_surface::Manager>>,
    terminals: OnceLock<Arc<terminal::Adapter>>,
    external_mcp: OnceLock<external_mcp::Client>,
    tunnel_streams: Arc<Semaphore>,
    guest_streams: Mutex<Option<tokio::task::JoinSet<()>>>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<JsString, Session>,
    tombstones: IndexMap<JsString, u64>,
    channels: Channels,
    peers: Peers,
    legacy_tunnels: tunnel::Legacy,
    transport_ready: bool,
    disconnect: Option<Instant>,
}

struct Session {
    value: Value,
    identity: Vec<u16>,
    grants: HashMap<JsString, Grant>,
}

struct Grant {
    value: Value,
    surface: Option<Arc<browser_surface::Link>>,
    guest: tunnel::guest::Slot,
}

impl Drop for Grant {
    fn drop(&mut self) {
        if let Some(surface) = &self.surface {
            surface.revoke();
        }
    }
}

pub(crate) fn observation_scope(command: &Value) -> Value {
    Value::object(
        [
            "chatId",
            "clientMessageId",
            "executionLaneId",
            "contextKind",
            "worktreeId",
            "scratchRootId",
        ]
        .into_iter()
        .map(|key| (key, command[key].clone())),
    )
}

pub(crate) fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "worker-link.identity.resolve"
            | "worker-link.session.install"
            | "worker-link.session.renew"
            | "worker-link.session.route"
            | "worker-link.session.revoke"
            | "worker-link.grant.install"
            | "worker-link.grant.renew"
            | "worker-link.grant.revoke"
    )
}

impl Coordinator {
    pub(crate) fn new(
        worker: JsString,
        generation: String,
        encryption: Arc<Service>,
        outgoing: Arc<Outbound>,
        logs: Arc<Logs>,
        shares: Arc<crate::project_shares::Manager>,
        direct: Arc<DirectBroker>,
    ) -> Self {
        Self {
            worker,
            generation,
            encryption,
            outgoing,
            logs,
            shares,
            direct,
            state: Mutex::default(),
            wake: Arc::new(Notify::new()),
            surfaces: OnceLock::new(),
            terminals: OnceLock::new(),
            external_mcp: OnceLock::new(),
            tunnel_streams: Arc::new(Semaphore::new(tunnel::MAX_STREAMS)),
            guest_streams: Mutex::new(Some(tokio::task::JoinSet::new())),
        }
    }

    pub(crate) fn execute(&self, command: &Value) -> Result<Value> {
        // The command envelope has already validated the coordinator union.
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        let now = Utc::now().timestamp_millis();
        state.sweep(now, identity.as_ref().ok());
        let result = self.execute_authority(&mut state, command, now, identity);
        state.channels.flush(&self.outgoing);
        result
    }

    pub(crate) async fn execute_peer(self: &Arc<Self>, command: &Value) -> Result<Value> {
        let settlement = {
            let mut state = self.state.lock().unwrap();
            let identity = self.encryption.bound_identity();
            let now = Utc::now().timestamp_millis();
            state.sweep(now, identity.as_ref().ok());
            ensure!(
                state.transport_ready || state.disconnect.is_some(),
                "WorkerLink command transport is disconnected."
            );
            let State {
                sessions, peers, ..
            } = &mut *state;
            match command["type"].as_str() {
                Some("worker-link.peer.install") => {
                    let session = &command["peerSession"];
                    peer::authorized(sessions, session, now)?;
                    peers.install(session, &command["configuration"], self)?;
                    None
                }
                Some("worker-link.peer.renew") => {
                    peers.renew(sessions, command, now)?;
                    None
                }
                Some("worker-link.peer.revoke") => {
                    peers.revoke(command);
                    None
                }
                Some("worker-link.peer.signal") => Some(peers.signal(&command["envelope"])?),
                _ => bail!("Unknown WorkerLink peer command."),
            }
        };
        if let Some(settlement) = settlement {
            settlement
                .await
                .context("WorkerLink peer signaling stopped.")??;
        }
        Ok(json!({"accepted":true}))
    }

    fn execute_authority(
        &self,
        state: &mut State,
        command: &Value,
        now: i64,
        identity: Result<(JsString, Value), crate::encryption::ServiceError>,
    ) -> Result<Value> {
        ensure!(
            state.transport_ready || state.disconnect.is_some(),
            "WorkerLink command transport is disconnected."
        );
        if command["type"] == "worker-link.identity.resolve" {
            let (owner, server) = identity?;
            return checked(
                "workerLinkIdentityResolveResultSchema",
                &json!({"serverId":server,"ownerId":owner,"workerId":self.worker,"workerProcessGeneration":self.generation}),
            );
        }
        if command["type"] == "worker-link.session.install" {
            let value = &command["session"];
            let incoming = &value["identity"];
            ensure!(
                identity
                    .as_ref()
                    .is_ok_and(|(_, server)| server == &incoming["serverId"]),
                "WorkerLink session belongs to another server."
            );
            ensure!(
                identity
                    .as_ref()
                    .is_ok_and(|(owner, _)| incoming["ownerId"].as_js_string() == Some(owner)),
                "WorkerLink session belongs to another account."
            );
            ensure!(
                incoming["workerId"].as_js_string() == Some(&self.worker),
                "WorkerLink session belongs to another worker."
            );
            ensure!(
                incoming["workerProcessGeneration"] == self.generation,
                "WorkerLink session targets another worker process."
            );
            state.install_session(value, now)?;
            return Ok(json!({"accepted":true}));
        }
        let session = id(command, "sessionId");
        let revoked = match command["type"].as_str().unwrap_or_default() {
            "worker-link.session.renew" => {
                let current = state.session_mut(session)?;
                let next = &command["lease"];
                validate_renewal(&current.value["lease"], next, now)?;
                current.value["lease"] = next.clone();
                None
            }
            "worker-link.session.route" => {
                let current = state.session_mut(session)?;
                let route = &command["preferredRoute"];
                let generation = &command["routeGeneration"];
                if generation != &current.value["routeGeneration"]
                    || route != &current.value["preferredRoute"]
                {
                    ensure!(
                        generation.as_u64()
                            == current.value["routeGeneration"]
                                .as_u64()
                                .and_then(|n| n.checked_add(1))
                            && route_enabled(&current.value, route),
                        "WorkerLink route replacement generation is invalid."
                    );
                    current.value["routeGeneration"] = generation.clone();
                    current.value["preferredRoute"] = route.clone();
                    state.peers.revoke_session(session, "route-replaced");
                    state.channels.close_session(session, "route-replaced");
                }
                None
            }
            "worker-link.session.revoke" => Some(state.revoke_session(session, "revoked")),
            "worker-link.grant.install" => {
                state.install_grant(
                    session,
                    &command["grant"],
                    now,
                    self.surfaces
                        .get()
                        .map(|surfaces| (surfaces.as_ref(), &self.wake)),
                )?;
                None
            }
            "worker-link.grant.renew" => {
                let current = state
                    .sessions
                    .get_mut(session)
                    .context("WorkerLink grant is not installed at this generation.")?;
                let grant = current
                    .grants
                    .get_mut(id(command, "grantId"))
                    .filter(|grant| {
                        grant.value["binding"]["grantGeneration"] == command["grantGeneration"]
                    })
                    .context("WorkerLink grant is not installed at this generation.")?;
                let next = &command["lease"];
                validate_renewal(&grant.value["binding"]["lease"], next, now)?;
                let expiry = expiration(next)?;
                ensure!(
                    expiry <= expiration(&current.value["lease"])?,
                    "WorkerLink grant renewal exceeds its session lease."
                );
                grant.value["binding"]["lease"] = next.clone();
                if let Some(surface) = &grant.surface {
                    surface.renew(expiry);
                }
                None
            }
            "worker-link.grant.revoke" => Some(
                state.revoke_grant(
                    session,
                    id(command, "grantId"),
                    command["grantGeneration"]
                        .as_u64()
                        .expect("validated grant generation"),
                    "revoked",
                ),
            ),
            _ => bail!("Unknown WorkerLink coordinator command."),
        };
        Ok(revoked.map_or_else(
            || json!({"accepted":true}),
            |revoked| json!({"accepted":true,"revoked":revoked}),
        ))
    }

    pub(crate) fn configure_surfaces(&self, surfaces: Arc<browser_surface::Manager>) {
        assert!(self.surfaces.set(surfaces).is_ok());
    }

    pub(crate) fn configure_external_mcp(
        &self,
        config: Arc<Mutex<crate::config::Config>>,
    ) -> Result<()> {
        ensure!(
            self.external_mcp
                .set(external_mcp::Client::new(config)?)
                .is_ok(),
            "External MCP is already configured."
        );
        Ok(())
    }

    pub(crate) fn configure_terminals(
        &self,
        shells: Arc<crate::terminal_services::interactive::Shells>,
        runs: Arc<crate::run_runtime::Manager>,
    ) {
        let adapter = Arc::new(terminal::Adapter::new(
            shells,
            runs,
            self.encryption.clone(),
        ));
        assert!(self.terminals.set(adapter).is_ok());
    }

    pub(crate) fn handle_frame(self: &Arc<Self>, frame: &Frame) {
        self.handle_carrier_frame(&Carrier::Relay, frame);
    }

    fn handle_carrier_frame(self: &Arc<Self>, carrier: &Carrier, frame: &Frame) -> bool {
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        let now = Utc::now().timestamp_millis();
        state.sweep(now, identity.as_ref().ok());
        let header = frame.header();
        let admitted = match carrier {
            Carrier::Relay => state.transport_ready,
            Carrier::Local(local) => local.upgrade().is_some_and(|local| {
                local.active()
                    && header["effectiveRoute"] == "local"
                    && id(header, "sessionId") == &local.session
            }),
            Carrier::Peer(peer, _) => peer.upgrade().is_some_and(|peer| peer.permits(header)),
        };
        let accepted = if !admitted {
            false
        } else if header["kind"] == "open" {
            let session = id(header, "sessionId");
            let State {
                sessions,
                channels,
                tombstones,
                ..
            } = &mut *state;
            if channels.open(
                carrier,
                header,
                sessions.get(session),
                tombstones,
                now,
                self,
            ) {
                state.revoke_session(session, "protocol-error");
            }
            true
        } else {
            let allow_write = state
                .channels
                .grant_for(header)
                .and_then(|grant| {
                    state
                        .sessions
                        .get(id(header, "sessionId"))
                        .and_then(|session| session.grants.get(grant))
                })
                .is_some_and(|grant| {
                    grant.value["binding"]["operations"]
                        .as_array()
                        .is_some_and(|operations| operations.contains(&json!("stream:write")))
                });
            state.channels.receive(carrier, frame, allow_write, self)
        };
        state.channels.flush(&self.outgoing);
        accepted
    }

    fn handle_local_frame(self: &Arc<Self>, local: &Arc<Local>, frame: &Frame) -> bool {
        self.handle_carrier_frame(&Carrier::Local(Arc::downgrade(local)), frame)
    }

    fn disconnect_local(&self, local: &Arc<Local>) {
        self.update_channels(|channels| {
            channels.disconnect(&Carrier::Local(Arc::downgrade(local)))
        });
    }

    fn handle_peer_frame(self: &Arc<Self>, peer: &Arc<PeerCarrier>, frame: &Frame) {
        self.handle_carrier_frame(&Carrier::peer(peer), frame);
    }

    fn disconnect_peer(&self, peer: &Arc<PeerCarrier>) {
        self.update_channels(|channels| channels.disconnect(&Carrier::peer(peer)));
    }

    fn local_writable(&self) {
        self.update_channels(|_| {});
    }

    pub(crate) fn handle_tunnel_frame(self: &Arc<Self>, frame: cantrip_framing::tunnel::Frame) {
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        state.sweep(Utc::now().timestamp_millis(), identity.as_ref().ok());
        if state.transport_ready {
            state.legacy_tunnels.receive(self, frame);
        }
    }

    fn update_channels<T>(&self, update: impl FnOnce(&mut Channels) -> T) -> T {
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        state.sweep(Utc::now().timestamp_millis(), identity.as_ref().ok());
        let result = update(&mut state.channels);
        state.channels.flush(&self.outgoing);
        result
    }

    fn terminal_ready(&self, id: &JsString, token: uuid::Uuid) {
        self.update_channels(|channels| channels.terminal_ready(id, token));
    }

    fn terminal_output(
        &self,
        id: &JsString,
        token: uuid::Uuid,
        bytes: &[u8],
        last: bool,
    ) -> carrier::Output {
        self.update_channels(|channels| channels.terminal_output(id, token, bytes, last))
    }

    fn terminal_credit(&self, id: &JsString, token: uuid::Uuid, bytes: usize) {
        self.update_channels(|channels| channels.terminal_credit(id, token, bytes));
    }

    fn terminal_error(&self, id: &JsString, token: uuid::Uuid, error: &str, close: &str) {
        self.update_channels(|channels| channels.terminal_error(id, token, error, close));
    }

    pub(crate) fn publish_notification(&self, notification: &Value) {
        if let Some(candidate) = Observation::from_notification(notification) {
            self.publish(candidate);
        }
    }

    pub(crate) fn publish_event(&self, command: &Value, event: &Value) {
        if let Some(candidate) = Observation::from_event(command, event) {
            self.publish(candidate);
        }
    }

    fn publish(&self, candidate: Observation) {
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        state.sweep(Utc::now().timestamp_millis(), identity.as_ref().ok());
        state.channels.publish(candidate);
        state.channels.flush(&self.outgoing);
    }

    pub(crate) fn reconcile(&self) {
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        self.direct.reconcile(identity.as_ref().ok());
        state.sweep(Utc::now().timestamp_millis(), identity.as_ref().ok());
        state.channels.flush(&self.outgoing);
        state.legacy_tunnels.flush(&self.outgoing);
    }

    pub(crate) fn connected(&self) {
        self.direct.connected();
        let mut state = self.state.lock().unwrap();
        state.expire_disconnect();
        state.disconnect = None;
        state.transport_ready = true;
        state.channels.flush(&self.outgoing);
        state.legacy_tunnels.flush(&self.outgoing);
        state.legacy_tunnels.writable();
    }

    pub(crate) fn disconnected(&self) {
        self.direct.disconnected();
        let mut state = self.state.lock().unwrap();
        if state.transport_ready {
            state.transport_ready = false;
            state.disconnect = Some(Instant::now() + GRACE);
            state.legacy_tunnels.disconnected();
            state.retire_guest_tunnels(None, "route-replaced");
            state.channels.disconnect_surface_relay();
            self.wake.notify_one();
        }
    }

    pub(crate) fn revoke_all(&self) {
        self.state.lock().unwrap().revoke_all();
        self.direct.revoke_all("Server control connection closed");
    }

    pub(crate) async fn run(&self, mut stop: watch::Receiver<bool>) {
        let mut tick = tokio::time::interval(SWEEP);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        while !*stop.borrow() {
            let deadline = self.state.lock().unwrap().disconnect;
            tokio::select! {
                _ = stop.changed() => break,
                _ = tick.tick() => self.reconcile(),
                _ = self.wake.notified() => self.reconcile(),
                _ = self.outgoing.binary_writable() => {
                    let mut state = self.state.lock().unwrap();
                    state.channels.flush(&self.outgoing);
                    state.legacy_tunnels.flush(&self.outgoing);
                    state.legacy_tunnels.writable();
                },
                _ = async {
                    if let Some(deadline) = deadline {
                        tokio::time::sleep_until(deadline).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => self.reconcile(),
            }
        }
        self.revoke_all();
        let mut peers = self.state.lock().unwrap().peers.take_tasks();
        while peers.join_next().await.is_some() {}
        let guest_streams = self.guest_streams.lock().unwrap().take();
        if let Some(mut jobs) = guest_streams {
            while jobs.join_next().await.is_some() {}
        }
        if let Some(terminals) = self.terminals.get() {
            terminals.close().await;
        }
    }
}

impl State {
    fn install_session(&mut self, value: &Value, now: i64) -> Result<()> {
        ensure!(
            expiration(&value["lease"])? > now,
            "WorkerLink session is already expired."
        );
        ensure!(
            route_enabled(value, &value["preferredRoute"]),
            "WorkerLink preferred route is not enabled."
        );
        let session_id = id(value, "sessionId");
        if let Some(existing) = self.sessions.get(session_id) {
            ensure!(
                &existing.value == value,
                "WorkerLink session installation conflicts with existing state."
            );
            return Ok(());
        }
        ensure!(
            self.sessions.len() < MAX_SESSIONS,
            "WorkerLink session capacity is exhausted."
        );
        let key = identity_key(&value["identity"]);
        let replaced = self
            .sessions
            .iter()
            .find(|(_, other)| other.identity == key)
            .map(|(id, _)| id.clone());
        if let Some(replaced) = replaced {
            self.revoke_session(&replaced, "route-replaced");
        }
        self.sessions.insert(
            session_id.clone(),
            Session {
                value: value.clone(),
                identity: key,
                grants: HashMap::new(),
            },
        );
        Ok(())
    }

    fn session_mut(&mut self, id: &JsString) -> Result<&mut Session> {
        self.sessions
            .get_mut(id)
            .context("WorkerLink session is not installed.")
    }

    fn install_grant(
        &mut self,
        session: &JsString,
        grant: &Value,
        now: i64,
        surfaces: Option<(&browser_surface::Manager, &Arc<Notify>)>,
    ) -> Result<()> {
        let binding = &grant["binding"];
        let grant_id = id(binding, "grantId");
        let current = self
            .sessions
            .get(session)
            .context("WorkerLink session is not installed.")?;
        ensure!(
            binding["sessionId"].as_js_string() == Some(session)
                && binding["identity"] == current.value["identity"],
            "WorkerLink grant escaped its exact session identity."
        );
        let lease = &binding["lease"];
        let current_lease = &current.value["lease"];
        let expiry = expiration(lease)?;
        ensure!(
            expiry > now
                && expiry <= expiration(current_lease)?
                && timestamp(lease, "absoluteExpiresAt")?
                    <= timestamp(current_lease, "absoluteExpiresAt")?,
            "WorkerLink grant lease is outside its session lease."
        );
        let generation = binding["grantGeneration"]
            .as_u64()
            .expect("validated grant generation");
        ensure!(
            self.tombstones
                .get(grant_id)
                .is_none_or(|seen| generation > *seen),
            "WorkerLink grant generation was already revoked."
        );
        if let Some(installed) = current.grants.get(grant_id) {
            ensure!(
                &installed.value == grant,
                "WorkerLink grant installation conflicts with existing state."
            );
            return Ok(());
        }
        ensure!(
            current.grants.len() < MAX_GRANTS_PER_SESSION,
            "WorkerLink per-session grant capacity is exhausted."
        );
        ensure!(
            self.sessions
                .values()
                .map(|session| session.grants.len())
                .sum::<usize>()
                < MAX_GRANTS,
            "WorkerLink grant capacity is exhausted."
        );
        let surface = if matches!(
            binding["resource"]["kind"].as_str(),
            Some("browser" | "remote-desktop")
        ) {
            let (surfaces, wake) = surfaces.context("Remote Surfaces are unavailable.")?;
            Some(surfaces.bind(binding, wake.clone(), expiry)?)
        } else {
            None
        };
        self.session_mut(session)?.grants.insert(
            grant_id.clone(),
            Grant {
                value: grant.clone(),
                surface,
                guest: tunnel::guest::Slot::default(),
            },
        );
        Ok(())
    }

    fn revoke_session(&mut self, session: &JsString, code: &str) -> bool {
        self.peers.revoke_session(session, code);
        self.channels.close_session(session, code);
        let Some(session) = self.sessions.remove(session) else {
            return false;
        };
        for (id, grant) in session.grants {
            self.remember(
                id,
                grant.value["binding"]["grantGeneration"]
                    .as_u64()
                    .expect("validated grant generation"),
            );
        }
        true
    }

    fn revoke_grant(
        &mut self,
        session: &JsString,
        id: &JsString,
        generation: u64,
        code: &str,
    ) -> bool {
        self.remember(id.clone(), generation);
        let Some(current) = self.sessions.get_mut(session) else {
            return false;
        };
        if current.grants.get(id).is_some_and(|grant| {
            grant.value["binding"]["grantGeneration"].as_u64() == Some(generation)
        }) {
            current.grants.remove(id);
            self.channels.close_grant(session, id, code);
            true
        } else {
            false
        }
    }

    fn remember(&mut self, grant: JsString, generation: u64) {
        let value = self.tombstones.entry(grant).or_insert(0);
        *value = (*value).max(generation);
        if self.tombstones.len() > MAX_GRANTS * 2 {
            self.tombstones.shift_remove_index(0);
        }
    }

    fn revoke_all(&mut self) {
        self.transport_ready = false;
        self.disconnect = None;
        self.channels.clear();
        self.legacy_tunnels = tunnel::Legacy::default();
        for id in self.sessions.keys().cloned().collect::<Vec<_>>() {
            self.revoke_session(&id, "endpoint-disconnected");
        }
    }

    fn expire_disconnect(&mut self) {
        if self
            .disconnect
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            self.revoke_all();
        }
    }

    fn sweep(&mut self, now: i64, identity: Option<&(JsString, Value)>) {
        self.expire_disconnect();
        self.legacy_tunnels.rebind(identity);
        let expired = |lease: &Value| expiration(lease).is_ok_and(|expiry| expiry <= now);
        let mut removed_sessions = Vec::new();
        let mut removed_grants = Vec::new();
        for (id, session) in &self.sessions {
            let bound = &session.value["identity"];
            if expired(&session.value["lease"]) {
                removed_sessions.push((id.clone(), "lifetime-expired"));
                continue;
            }
            if !identity.is_some_and(|(owner, server)| {
                bound["ownerId"].as_js_string() == Some(owner) && &bound["serverId"] == server
            }) {
                removed_sessions.push((id.clone(), "revoked"));
                continue;
            }
            for (grant_id, grant) in &session.grants {
                let binding = &grant.value["binding"];
                if expired(&binding["lease"]) {
                    let generation = binding["grantGeneration"]
                        .as_u64()
                        .expect("validated grant generation");
                    removed_grants.push((id.clone(), grant_id.clone(), generation));
                }
            }
        }
        for (id, code) in removed_sessions {
            self.revoke_session(&id, code);
        }
        for (session, grant, generation) in removed_grants {
            self.revoke_grant(&session, &grant, generation, "lifetime-expired");
        }
        self.peers.reconcile(&self.sessions, now);
        self.channels.sweep(now);
    }
}

fn id<'a>(value: &'a Value, field: &str) -> &'a JsString {
    value[field]
        .as_js_string()
        .expect("validated WorkerLink identity")
}

fn route_enabled(session: &Value, route: &Value) -> bool {
    session["routePolicy"]["enabled"]
        .as_array()
        .is_some_and(|enabled| enabled.contains(route))
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn timestamp(lease: &Value, field: &str) -> Result<i64> {
    lease[field]
        .as_js_string()
        .and_then(cantrip_wire::date::parse)
        .context("Invalid WorkerLink lease timestamp")
}

fn expiration(lease: &Value) -> Result<i64> {
    timestamp(lease, "expiresAt")
}

fn validate_renewal(current: &Value, next: &Value, now: i64) -> Result<()> {
    let expiry = expiration(next)?;
    ensure!(
        next["issuedAt"] == current["issuedAt"]
            && next["absoluteExpiresAt"] == current["absoluteExpiresAt"]
            && expiry > now
            && expiry <= timestamp(next, "absoluteExpiresAt")?,
        "WorkerLink lease renewal is invalid."
    );
    Ok(())
}

#[cfg(test)]
mod tests;
