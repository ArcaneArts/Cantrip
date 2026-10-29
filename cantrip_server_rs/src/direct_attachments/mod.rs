//! Native one-use direct capabilities and resource lifecycle fencing.
mod events;
mod lifecycle;
mod native;
pub use lifecycle::Scope;
mod prepare;
mod renewal;
mod telemetry;

use crate::{
    wire::{self, JsString, Value, value::json},
    workers::bridge::{OfflineSubscription, WorkerBridge},
};
use futures::{FutureExt, future::BoxFuture};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Notify;
use uuid::Uuid;

pub type WorkerRequest = crate::worker_links::WorkerRequest;
pub type Clock = crate::worker_links::Clock;
pub type Connected = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
pub type Logger = crate::operations::logging::Logger;
pub type Observer =
    Arc<dyn Fn(&'static str, Value) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>;
type Key = Vec<u16>;

#[derive(Debug)]
pub struct Unavailable(pub &'static str);
impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Unavailable {}
#[derive(Debug)]
pub struct ContractFailure(pub String);
impl std::fmt::Display for ContractFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ContractFailure {}
fn unavailable(message: &'static str) -> anyhow::Error {
    Unavailable(message).into()
}
fn checked(schema: &str, value: Value) -> anyhow::Result<Value> {
    wire::parse(schema, Some(&value)).map_err(|error| match error {
        wire::ValidationError::Invalid(issues) => {
            ContractFailure(Value::Array(issues).stringify_pretty()).into()
        }
        wire::ValidationError::Operation => {
            anyhow::anyhow!("Direct attachment schema validation failed.")
        }
    })
}
fn iso(ms: i64) -> anyhow::Result<Value> {
    wire::date_iso_milliseconds(ms)
        .map(|s| Value::String(s.into()))
        .ok_or_else(|| anyhow::anyhow!("Invalid time value"))
}
fn text(v: &Value) -> &JsString {
    v.as_js_string().expect("Direct resource identity")
}
fn key(owner: &Value, kind: &Value, resource: Option<&Value>) -> Key {
    let (owner, kind) = (text(owner), text(kind));
    let mut key: Key = format!("{}:", owner.units().len()).encode_utf16().collect();
    key.extend_from_slice(owner.units());
    if resource.is_some() {
        key.extend(format!("{}:", kind.units().len()).encode_utf16());
    }
    key.extend_from_slice(kind.units());
    if let Some(resource) = resource {
        key.extend_from_slice(text(resource).units());
    }
    key
}
fn resource_key(v: &Value) -> Key {
    key(&v["ownerId"], &v["resourceKind"], Some(&v["resourceId"]))
}
fn kind_key(v: &Value) -> Key {
    key(&v["ownerId"], &v["resourceKind"], None)
}
fn number(v: &Value, field: &str) -> f64 {
    v[field].as_f64().expect("Direct numeric state")
}
fn increment(v: &mut Value, field: &str) {
    v[field] = json!(number(v, field) + 1.0);
}

pub struct Options {
    pub now: Clock,
    pub connected: Connected,
    pub logger: Logger,
    pub observer: Option<Observer>,
    pub automatic_expiry: bool,
    pub jitter: Arc<dyn Fn() -> anyhow::Result<u16> + Send + Sync>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            connected: Arc::new(|_| false),
            logger: crate::operations::logging::server_logger(),
            observer: None,
            automatic_expiry: true,
            jitter: Arc::new(|| {
                let mut bytes = [0u8; 2];
                getrandom::fill(&mut bytes)?;
                Ok(u16::from_be_bytes(bytes))
            }),
        }
    }
}
struct LeaseState {
    input: Value,
    resource: Value,
}
pub struct PreparationLease {
    id: Uuid,
    coordinator: Weak<Coordinator>,
}
impl Drop for PreparationLease {
    fn drop(&mut self) {
        if let Some(c) = self.coordinator.upgrade() {
            c.release_id(self.id);
        }
    }
}
pub struct PrepareInput {
    pub lease: Arc<PreparationLease>,
    pub value: Value,
}
struct Lifecycle {
    id: Uuid,
    generation: Uuid,
    revoking: usize,
    queue: Arc<tokio::sync::Mutex<()>>,
}
struct Pending {
    input: Value,
    lifecycle: Uuid,
}
struct Grant {
    id: Uuid,
    record: Value,
    lifecycle: Uuid,
    generation: Uuid,
    renewal: Arc<tokio::sync::Mutex<()>>,
    timer: Option<tokio::task::AbortHandle>,
    offline: Option<OfflineSubscription>,
}
struct Finalized {
    record: Value,
    expires: i64,
    accepted: bool,
}
#[derive(Default)]
struct State {
    closed: bool,
    close_complete: bool,
    grants: IndexMap<String, Grant>,
    finalized: IndexMap<String, Finalized>,
    leases: IndexMap<Uuid, LeaseState>,
    preparations: IndexMap<Uuid, Pending>,
    lifecycles: HashMap<Key, Lifecycle>,
    owners: HashMap<JsString, usize>,
    sessions: HashMap<JsString, usize>,
    attachments: HashMap<JsString, usize>,
    kinds: HashMap<Key, usize>,
    writes: usize,
    background: usize,
}
pub struct Coordinator {
    workers: WorkerRequest,
    options: Options,
    bridge: Option<Arc<WorkerBridge>>,
    state: Mutex<State>,
    changed: Notify,
}
impl Coordinator {
    pub fn new(workers: WorkerRequest, options: Options) -> Arc<Self> {
        Self::construct(workers, options, None)
    }
    pub fn construct(
        workers: WorkerRequest,
        options: Options,
        bridge: Option<Arc<WorkerBridge>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            workers,
            options,
            bridge,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        })
    }
    fn now(&self) -> i64 {
        (self.options.now)()
    }
    fn fenced(state: &State, input: &Value, resource: &Value) -> bool {
        state.closed
            || state.owners.contains_key(text(&input["ownerId"]))
            || state.sessions.contains_key(text(&input["authSessionId"]))
            || input.get("attachmentId").is_some_and(|v| {
                wire::coercion::truthy(Some(v)) && state.attachments.contains_key(text(v))
            })
            || (resource.is_null() && state.kinds.contains_key(&kind_key(input)))
            || (!resource.is_null()
                && state
                    .lifecycles
                    .get(&key(
                        &input["ownerId"],
                        &input["resourceKind"],
                        Some(resource),
                    ))
                    .is_some_and(|l| l.revoking > 0))
    }
    fn lease_matches(state: &State, input: &PrepareInput) -> bool {
        state.leases.get(&input.lease.id).is_some_and(|lease| {
            let l = &lease.input;
            let i = &input.value;
            l["ownerId"] == i["ownerId"]
                && l["authSessionId"] == i["authSessionId"]
                && l["resourceKind"] == i["resourceKind"]
                && l.get("attachmentId")
                    .is_none_or(|a| Some(a) == i.get("attachmentId"))
                && lease.resource == i["resourceId"]
                && !Self::fenced(state, l, &lease.resource)
        })
    }
    pub fn acquire_preparation(self: &Arc<Self>, input: Value) -> Option<Arc<PreparationLease>> {
        let mut state = self.state.lock().unwrap();
        if Self::fenced(&state, &input, &input["resourceId"]) {
            return None;
        }
        let id = Uuid::new_v4();
        state.leases.insert(
            id,
            LeaseState {
                resource: input["resourceId"].clone(),
                input,
            },
        );
        Some(Arc::new(PreparationLease {
            id,
            coordinator: Arc::downgrade(self),
        }))
    }
    pub fn bind_preparation(&self, lease: &PreparationLease, kind: Value, resource: Value) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(l) = state.leases.get(&lease.id) else {
            return false;
        };
        if !std::ptr::eq(lease.coordinator.as_ptr(), self)
            || l.input["resourceKind"] != kind
            || (!l.resource.is_null() && l.resource != resource)
            || state.kinds.contains_key(&kind_key(&l.input))
            || Self::fenced(&state, &l.input, &resource)
        {
            return false;
        }
        state.leases.get_mut(&lease.id).unwrap().resource = resource;
        true
    }
    pub fn preparation_active(&self, lease: &PreparationLease) -> bool {
        let state = self.state.lock().unwrap();
        std::ptr::eq(lease.coordinator.as_ptr(), self)
            && state
                .leases
                .get(&lease.id)
                .is_some_and(|l| !Self::fenced(&state, &l.input, &l.resource))
    }
    pub fn release_preparation(&self, lease: &PreparationLease) {
        if std::ptr::eq(lease.coordinator.as_ptr(), self) {
            self.release_id(lease.id);
        }
    }
    fn release_id(&self, id: Uuid) {
        self.state.lock().unwrap().leases.shift_remove(&id);
        self.changed.notify_waiters();
    }
    fn lifecycle(state: &mut State, key: Key) -> &mut Lifecycle {
        state.lifecycles.entry(key).or_insert_with(|| Lifecycle {
            id: Uuid::new_v4(),
            generation: Uuid::new_v4(),
            revoking: 0,
            queue: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
    fn remove_unused(state: &mut State, key: &Key, id: Uuid) {
        if state
            .lifecycles
            .get(key)
            .is_some_and(|l| l.id == id && l.revoking == 0)
            && !state.preparations.values().any(|p| p.lifecycle == id)
            && !state
                .grants
                .values()
                .any(|g| resource_key(&g.record) == *key)
        {
            state.lifecycles.remove(key);
        }
    }
    async fn wait(&self, complete: impl Fn(&State) -> bool) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if complete(&self.state.lock().unwrap()) {
                return;
            }
            changed.await;
        }
    }
    pub async fn drained(&self) {
        self.wait(|state| state.background == 0 && state.writes == 0)
            .await;
    }
    fn current(state: &State, capability: &str, id: Uuid) -> bool {
        let Some(grant) = state.grants.get(capability).filter(|g| g.id == id) else {
            return false;
        };
        let record = &grant.record;
        !Self::fenced(state, record, &record["resourceId"])
            && !state.kinds.contains_key(&kind_key(record))
            && state
                .lifecycles
                .get(&resource_key(record))
                .is_some_and(|l| {
                    l.id == grant.lifecycle && l.generation == grant.generation && l.revoking == 0
                })
    }
    pub fn matches(&self, capability: &str, authorization: &Value) -> bool {
        self.state
            .lock()
            .unwrap()
            .grants
            .get(capability)
            .is_some_and(|g| Self::authorized(&g.record, authorization, true))
    }
    fn authorized(record: &Value, authorization: &Value, attachment: bool) -> bool {
        record["ownerId"] == authorization["ownerId"]
            && record["authSessionId"] == authorization["authSessionId"]
            && (!attachment || record["attachmentId"] == authorization["attachmentId"])
    }
    pub fn tunnel_lease(&self, capability: &str, authorization: &Value) -> Option<Value> {
        let state = self.state.lock().unwrap();
        let g = state.grants.get(capability)?;
        (Self::authorized(&g.record, authorization, true)
            && g.record["mode"] == "direct-tunnel"
            && g.record["resourceKind"] == "tunnel")
            .then(|| Self::lease_event(capability, &g.record))
    }
}
