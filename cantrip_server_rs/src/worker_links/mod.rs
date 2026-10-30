//! WorkerLink authority. Worker processes own transports and resources; the
//! server installs short-lived, generation-bound capabilities and fences revocation.
pub mod frame;
mod grants;
mod lifecycle;
mod native;
mod peers;
pub mod relay;
pub mod service;
mod sessions;
pub use lifecycle::{ResourceScope, RevocationScope};

use crate::wire::{self, JsString, Value, value::json};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub type WorkerRequest = Arc<
    dyn Fn(Value, Value, Option<Value>) -> BoxFuture<'static, anyhow::Result<Value>> + Send + Sync,
>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub enum Error {
    Unavailable(String),
    Failure(Arc<anyhow::Error>),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(v) => f.write_str(v),
            Self::Failure(v) => v.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
impl From<anyhow::Error> for Error {
    fn from(value: anyhow::Error) -> Self {
        Self::Failure(Arc::new(value))
    }
}
fn unavailable(message: &str) -> Error {
    Error::Unavailable(message.into())
}
fn checked(schema: &str, value: Value) -> Result<Value> {
    wire::parse(schema, Some(&value)).map_err(|e| crate::settings::response_error(e).into())
}
fn date(value: &Value) -> f64 {
    value
        .as_str()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map_or(f64::NAN, |v| v.timestamp_millis() as f64)
}
fn iso(at: f64) -> Result<Value> {
    if !at.is_finite() || at.abs() > 8_640_000_000_000_000.0 {
        return Err(anyhow::anyhow!("Invalid time value").into());
    }
    let at = chrono::DateTime::from_timestamp_millis(at as i64)
        .ok_or_else(|| anyhow::anyhow!("Invalid time value"))?;
    Ok(Value::String(crate::auth::iso(at).into()))
}
fn lease(current: &Value, duration: f64, now: i64, parent: f64) -> Result<Value> {
    let expiry = date(&current["absoluteExpiresAt"])
        .min(parent)
        .min(now as f64 + duration.max(1.0));
    if expiry <= now as f64 {
        return Err(unavailable("The WorkerLink lease has expired."));
    }
    checked(
        "workerLinkLeaseSchema",
        json!({"issuedAt":current["issuedAt"],"expiresAt":iso(expiry)?,"absoluteExpiresAt":current["absoluteExpiresAt"]}),
    )
}
fn revocation(reason: &str, now: i64) -> Value {
    json!({"reason":reason,"revokedAt":crate::auth::iso(chrono::DateTime::from_timestamp_millis(now).unwrap())})
}
fn id(value: &Value, field: &str) -> String {
    value[field].as_str().unwrap().to_owned()
}
fn key(parts: &[&Value]) -> Vec<u16> {
    let mut out = Vec::new();
    for part in parts {
        let part = part.as_js_string().expect("validated WorkerLink identity");
        out.extend(format!("{}:", part.len()).encode_utf16());
        out.extend_from_slice(part.units());
    }
    out
}
fn identity_key(identity: &Value) -> Vec<u16> {
    key(&[
        &identity["serverId"],
        &identity["serverGeneration"],
        &identity["ownerId"],
        &identity["accountSessionId"],
        &identity["clientInstanceId"],
        &identity["workerId"],
        &identity["workerProcessGeneration"],
    ])
}
fn resource_key(owner: &Value, kind: &Value, resource: &Value) -> Vec<u16> {
    key(&[owner, kind, resource])
}
fn identity_authorized(state: &State, identity: &Value) -> bool {
    !state
        .owner_fences
        .contains_key(identity["ownerId"].as_js_string().unwrap())
        && !state
            .account_fences
            .contains_key(identity["accountSessionId"].as_js_string().unwrap())
}
fn ready_state(state: &State, session: &str) -> Result<Session> {
    let current = state
        .sessions
        .get(session)
        .cloned()
        .ok_or_else(|| unavailable("The WorkerLink session is unavailable."))?;
    {
        let current = current.lock().unwrap();
        if !current.ready {
            return Err(unavailable("The WorkerLink session is unavailable."));
        }
        if !identity_authorized(state, &current.session["identity"]) {
            return Err(unavailable(
                "The WorkerLink account session is no longer authorized.",
            ));
        }
    }
    Ok(current)
}

pub struct Options {
    pub server_id: Value,
    pub server_generation: Value,
    pub peer_configuration: Option<Value>,
    pub session_lease_ms: f64,
    pub session_lifetime_ms: f64,
    pub max_active_sessions: usize,
    pub now: Clock,
    pub logger: crate::operations::logging::Logger,
}
impl Options {
    pub fn new(server_id: String, server_generation: String) -> Self {
        Self {
            server_id: Value::String(server_id.into()),
            server_generation: Value::String(server_generation.into()),
            peer_configuration: None,
            session_lease_ms: 120_000.0,
            session_lifetime_ms: 43_200_000.0,
            max_active_sessions: 1024,
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            logger: crate::operations::logging::server_logger(),
        }
    }
}
type Session = Arc<Mutex<SessionState>>;
type Grant = Arc<Mutex<Value>>;
type Peer = Arc<Mutex<PeerState>>;
struct SessionState {
    ready: bool,
    session: Value,
    grants: IndexMap<String, Grant>,
    peers: IndexMap<String, Peer>,
}
struct PeerState {
    ready: bool,
    peer: Value,
    signals: Vec<Value>,
    advertisements: Vec<Value>,
    last_client: f64,
    last_worker: f64,
    last_advertisement: f64,
    signal_queue: Arc<tokio::sync::Mutex<()>>,
}
type Pending = Shared<BoxFuture<'static, Result<Value>>>;
#[derive(Default)]
struct State {
    closed: bool,
    stopping: bool,
    active: usize,
    sweeper: Option<tokio::task::AbortHandle>,
    native_workers: HashMap<String, native::Subscriptions>,
    sessions: IndexMap<String, Session>,
    identities: HashMap<Vec<u16>, String>,
    opening: HashMap<Vec<u16>, (uuid::Uuid, Pending)>,
    opening_peers: HashMap<String, (uuid::Uuid, Pending)>,
    owner_fences: HashMap<JsString, usize>,
    account_fences: HashMap<JsString, usize>,
    resource_fences: HashMap<Vec<u16>, usize>,
}
pub struct Coordinator {
    workers: WorkerRequest,
    options: Options,
    state: Mutex<State>,
    bridge: Option<Arc<crate::workers::bridge::WorkerBridge>>,
    changed: tokio::sync::Notify,
}
impl Coordinator {
    pub fn new(workers: WorkerRequest, options: Options) -> Arc<Self> {
        Self::construct(workers, options, None)
    }
    fn construct(
        workers: WorkerRequest,
        options: Options,
        bridge: Option<Arc<crate::workers::bridge::WorkerBridge>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            workers,
            options,
            state: Mutex::new(State::default()),
            bridge,
            changed: tokio::sync::Notify::new(),
        })
    }
    fn now(&self) -> i64 {
        (self.options.now)()
    }
    fn assert_open(&self) -> Result<()> {
        if self.state.lock().unwrap().closed {
            Err(unavailable("The WorkerLink coordinator is shutting down."))
        } else {
            Ok(())
        }
    }
    fn authorized(&self, identity: &Value) -> Result<()> {
        let state = self.state.lock().unwrap();
        if !identity_authorized(&state, identity) {
            return Err(unavailable(
                "The WorkerLink account session is no longer authorized.",
            ));
        }
        Ok(())
    }
    fn ready(&self, session: &str) -> Result<Session> {
        ready_state(&self.state.lock().unwrap(), session)
    }
    fn current(&self, session: &str, expected: &Session) -> bool {
        self.state
            .lock()
            .unwrap()
            .sessions
            .get(session)
            .is_some_and(|v| Arc::ptr_eq(v, expected))
    }
    // Match a reference synchronous continuation: revocation cannot interleave
    // between checking the current object and committing its acknowledged state.
    fn with_current<T>(
        &self,
        session: &str,
        expected: &Session,
        operation: impl FnOnce(&State, &mut SessionState) -> T,
    ) -> Option<T> {
        let state = self.state.lock().unwrap();
        if !state
            .sessions
            .get(session)
            .is_some_and(|s| Arc::ptr_eq(s, expected))
        {
            return None;
        }
        let mut current = expected.lock().unwrap();
        Some(operation(&state, &mut current))
    }
    async fn request(&self, worker: Value, command: Value, owner: Option<Value>) -> Result<()> {
        let owner = owner.or_else(|| {
            if let Some(session) = command.get("session") {
                return Some(session["identity"]["ownerId"].clone());
            }
            if let Some(peer) = command.get("peerSession") {
                return Some(peer["identity"]["ownerId"].clone());
            }
            let session = command
                .get("sessionId")
                .unwrap_or(&command["envelope"]["sessionId"])
                .as_str()?;
            self.state
                .lock()
                .unwrap()
                .sessions
                .get(session)
                .map(|s| s.lock().unwrap().session["identity"]["ownerId"].clone())
        });
        let kind = command["type"].as_str().unwrap().to_owned();
        let result = (self.workers)(worker, command, owner)
            .await
            .map_err(Error::from)?;
        if !matches!(&result, Value::Object(_)) || result["accepted"] != true {
            return Err(Error::Unavailable(format!(
                "Worker did not acknowledge {kind}."
            )));
        }
        Ok(())
    }
    async fn best_effort(&self, worker: Value, command: Value, owner: Value) {
        let operation = command["type"].clone();
        if let Err(error) = self.request(worker.clone(), command, Some(owner)).await {
            let error = match error {
                Error::Unavailable(message) => crate::operations::log_sanitize::error(Some(
                    &json!({"name":"Error","message":message}),
                )),
                Error::Failure(cause) => crate::operations::logging::error_details(&cause),
            };
            (self.options.logger)(crate::operations::logging::LogCall::event(
                "warn",
                "WorkerLink revocation was not acknowledged",
                json!({"event":"worker-link.revocation.unacknowledged","subsystem":"worker-link","operation":operation,"reasonCode":"worker-unavailable","status":"degraded","workerId":worker,"error":error}),
            ));
        }
    }
    pub fn stats(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({"grants":state.sessions.values().map(|s|s.lock().unwrap().grants.len()).sum::<usize>(),"sessions":state.sessions.len()})
    }
    pub fn peer_configuration(&self) -> Result<Value> {
        self.options
            .peer_configuration
            .clone()
            .ok_or_else(|| unavailable("WorkerLink peer routing is not configured."))
    }
    pub fn session_for_authorization(
        &self,
        session: &str,
        owner: &Value,
        account: &Value,
    ) -> Option<Value> {
        let state = self.state.lock().unwrap();
        let state = state.sessions.get(session)?.lock().unwrap();
        (state.ready
            && state.session["identity"]["ownerId"] == *owner
            && state.session["identity"]["accountSessionId"] == *account
            && date(&state.session["lease"]["expiresAt"]) > self.now() as f64)
            .then(|| state.session.clone())
    }
}
