//! Worker-side installation of Core-issued session and resource authority.
//! These leases are process-local. They never authorize a carrier by themselves.
use crate::{encryption::Service, http::checked};
use anyhow::{Context, Result, bail, ensure};
use cantrip_protocol::worker_link::identity_key;
use cantrip_wire::{JsString, Value, value::json};
use chrono::Utc;
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, watch},
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
    state: Mutex<State>,
    wake: Notify,
}

#[derive(Default)]
struct State {
    sessions: HashMap<JsString, Session>,
    tombstones: IndexMap<JsString, u64>,
    transport_ready: bool,
    disconnect: Option<Instant>,
}

struct Session {
    value: Value,
    identity: Vec<u16>,
    grants: HashMap<JsString, Value>,
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
    pub(crate) fn new(worker: JsString, generation: String, encryption: Arc<Service>) -> Self {
        Self {
            worker,
            generation,
            encryption,
            state: Mutex::default(),
            wake: Notify::new(),
        }
    }

    pub(crate) fn execute(&self, command: &Value) -> Result<Value> {
        // The command envelope has already validated the coordinator union.
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        let now = Utc::now().timestamp_millis();
        state.sweep(now, identity.as_ref().ok());
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
                }
                None
            }
            "worker-link.session.revoke" => Some(state.revoke_session(session)),
            "worker-link.grant.install" => {
                state.install_grant(session, &command["grant"], now)?;
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
                        grant["binding"]["grantGeneration"] == command["grantGeneration"]
                    })
                    .context("WorkerLink grant is not installed at this generation.")?;
                let next = &command["lease"];
                validate_renewal(&grant["binding"]["lease"], next, now)?;
                ensure!(
                    expiration(next)? <= expiration(&current.value["lease"])?,
                    "WorkerLink grant renewal exceeds its session lease."
                );
                grant["binding"]["lease"] = next.clone();
                None
            }
            "worker-link.grant.revoke" => Some(
                state.revoke_grant(
                    session,
                    id(command, "grantId"),
                    command["grantGeneration"]
                        .as_u64()
                        .expect("validated grant generation"),
                ),
            ),
            _ => bail!("Unknown WorkerLink coordinator command."),
        };
        Ok(revoked.map_or_else(
            || json!({"accepted":true}),
            |revoked| json!({"accepted":true,"revoked":revoked}),
        ))
    }

    pub(crate) fn reconcile(&self) {
        let mut state = self.state.lock().unwrap();
        let identity = self.encryption.bound_identity();
        state.sweep(Utc::now().timestamp_millis(), identity.as_ref().ok());
    }

    pub(crate) fn connected(&self) {
        let mut state = self.state.lock().unwrap();
        state.expire_disconnect();
        state.disconnect = None;
        state.transport_ready = true;
    }

    pub(crate) fn disconnected(&self) {
        let mut state = self.state.lock().unwrap();
        if state.transport_ready {
            state.transport_ready = false;
            state.disconnect = Some(Instant::now() + GRACE);
            self.wake.notify_one();
        }
    }

    pub(crate) fn revoke_all(&self) {
        self.state.lock().unwrap().revoke_all();
    }

    pub(crate) async fn run(&self, mut stop: watch::Receiver<bool>) {
        let mut tick = tokio::time::interval(SWEEP);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        while !*stop.borrow() {
            let deadline = self.state.lock().unwrap().disconnect;
            tokio::select! {
                _ = stop.changed() => break,
                _ = tick.tick() => self.reconcile(),
                _ = self.wake.notified() => {},
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
            self.revoke_session(&replaced);
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

    fn install_grant(&mut self, session: &JsString, grant: &Value, now: i64) -> Result<()> {
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
                installed == grant,
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
        self.session_mut(session)?
            .grants
            .insert(grant_id.clone(), grant.clone());
        Ok(())
    }

    fn revoke_session(&mut self, session: &JsString) -> bool {
        let Some(session) = self.sessions.remove(session) else {
            return false;
        };
        for (id, grant) in session.grants {
            self.remember(
                id,
                grant["binding"]["grantGeneration"]
                    .as_u64()
                    .expect("validated grant generation"),
            );
        }
        true
    }

    fn revoke_grant(&mut self, session: &JsString, id: &JsString, generation: u64) -> bool {
        self.remember(id.clone(), generation);
        let Some(current) = self.sessions.get_mut(session) else {
            return false;
        };
        if current
            .grants
            .get(id)
            .is_some_and(|grant| grant["binding"]["grantGeneration"].as_u64() == Some(generation))
        {
            current.grants.remove(id);
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
        for id in self.sessions.keys().cloned().collect::<Vec<_>>() {
            self.revoke_session(&id);
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
        let expired = |lease: &Value| expiration(lease).is_ok_and(|expiry| expiry <= now);
        let mut removed_sessions = Vec::new();
        let mut removed_grants = Vec::new();
        for (id, session) in &self.sessions {
            let bound = &session.value["identity"];
            if expired(&session.value["lease"])
                || !identity.is_some_and(|(owner, server)| {
                    bound["ownerId"].as_js_string() == Some(owner) && &bound["serverId"] == server
                })
            {
                removed_sessions.push(id.clone());
                continue;
            }
            for (grant_id, grant) in &session.grants {
                let binding = &grant["binding"];
                if expired(&binding["lease"]) {
                    let generation = binding["grantGeneration"]
                        .as_u64()
                        .expect("validated grant generation");
                    removed_grants.push((id.clone(), grant_id.clone(), generation));
                }
            }
        }
        for id in removed_sessions {
            self.revoke_session(&id);
        }
        for (session, grant, generation) in removed_grants {
            self.revoke_grant(&session, &grant, generation);
        }
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
