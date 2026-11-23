use crate::wire::{JsString, Value, value::json};
use anyhow::{Result, ensure};
use futures::future::BoxFuture;
use indexmap::IndexMap;
use std::{
    collections::BTreeMap,
    ops::Bound,
    sync::{Arc, Mutex},
};

pub const MAX_MESSAGE_BYTES: usize = ((16 * 1024 * 1024 + 16) * 4_usize).div_ceil(3) + 64 * 1024;
pub type Listener = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<()>> + Send + Sync>;

pub(super) fn now() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}
fn string(value: &Value, maximum: usize) -> bool {
    value
        .as_js_string()
        .is_some_and(|s| !s.is_empty() && s.len() <= maximum)
}
pub(super) fn presence(value: &Value) -> Option<Value> {
    if !value.is_object()
        || !["connectionId", "instanceId", "ownerId", "workerId"]
            .iter()
            .all(|k| string(&value[*k], 512))
        || !matches!(value["expiresAt"], Value::Number(_))
    {
        return None;
    }
    if let Some(c) = value.get("continuityIdentity")
        && (!c.is_object()
            || !string(&c["credentialId"], 512)
            || !string(&c["workerProcessGeneration"], 512)
            || c["ownerId"] != value["ownerId"])
    {
        return None;
    }
    Some(value.clone())
}
pub(super) fn session_claim(value: &Value) -> Option<Value> {
    if !value.is_object()
        || !string(&value["authorityInstanceId"], 512)
        || !matches!(value["expiresAt"], Value::Number(_))
    {
        return None;
    }
    let session = crate::wire::parse("workerLinkSessionSchema", value.get("session")).ok()?;
    let expires =
        crate::wire::date_milliseconds(session["lease"]["expiresAt"].as_js_string()?)? as f64;
    if value["expiresAt"].as_f64() != Some(expires) || expires <= now() {
        return None;
    }
    let mut claim = value.clone();
    claim["session"] = session;
    Some(claim)
}

#[derive(Default)]
struct State {
    workers: IndexMap<JsString, Value>,
    listeners: BTreeMap<u64, Listener>,
    next: u64,
    instance_count: u64,
    received: u64,
    rejected: u64,
    sent: u64,
}
pub(super) struct Core {
    pub instance: String,
    pub ttl: u64,
    maximum: u64,
    state: Mutex<State>,
}
impl Core {
    pub fn new(instance: String, ttl: u64, maximum: u64) -> Self {
        Self {
            instance,
            ttl,
            maximum,
            state: Mutex::new(State {
                instance_count: 1,
                ..State::default()
            }),
        }
    }
    pub fn subscribe(&self, listener: Listener) -> u64 {
        let mut s = self.state.lock().unwrap();
        if let Some((id, _)) = s.listeners.iter().find(|(_, v)| Arc::ptr_eq(v, &listener)) {
            return *id;
        }
        s.next += 1;
        let id = s.next;
        s.listeners.insert(id, listener);
        id
    }
    pub fn unsubscribe(&self, id: u64) {
        self.state.lock().unwrap().listeners.remove(&id);
    }
    pub fn cache(&self, presence: Value) {
        let id = presence["workerId"].as_js_string().unwrap().clone();
        self.state.lock().unwrap().workers.insert(id, presence);
    }
    pub fn remove(&self, worker: &JsString, connection: &Value) {
        let mut s = self.state.lock().unwrap();
        if s.workers
            .get(worker)
            .is_some_and(|p| p["connectionId"] == *connection)
        {
            s.workers.shift_remove(worker);
        }
    }
    pub fn cached(&self, worker: &JsString) -> Option<Value> {
        let mut s = self.state.lock().unwrap();
        if s.workers
            .get(worker)
            .is_some_and(|p| p["expiresAt"].as_f64().is_some_and(|at| at <= now()))
        {
            s.workers.shift_remove(worker);
        }
        s.workers.get(worker).cloned()
    }
    pub fn instance_count(&self, count: u64) {
        self.state.lock().unwrap().instance_count = count;
    }
    pub fn within_limit(&self) -> bool {
        self.state.lock().unwrap().instance_count <= self.maximum
    }
    pub fn stats(&self) -> Value {
        let mut s = self.state.lock().unwrap();
        s.workers
            .retain(|_, p| !p["expiresAt"].as_f64().is_some_and(|at| at <= now()));
        json!({"cachedWorkers":s.workers.len(),"instanceCount":s.instance_count,"maximumInstances":self.maximum,
            "receivedMessages":s.received,"rejectedMessages":s.rejected,"sentMessages":s.sent,"shared":true})
    }
    pub fn envelope(&self, mut payload: Value, ttl: f64) -> Result<Value> {
        ensure!(
            ttl.is_finite() && (1.0..=86_400_000.0).contains(&ttl),
            "Coordination message TTL is outside the supported range."
        );
        let mut message = match &mut payload {
            Value::Object(fields) => Value::Object(std::mem::take(fields)),
            Value::Array(items) => {
                Value::object(items.drain(..).enumerate().map(|(i, v)| (i.to_string(), v)))
            }
            Value::String(s) => Value::object(
                s.units()
                    .iter()
                    .enumerate()
                    .map(|(i, u)| (i.to_string(), Value::String(JsString::new(vec![*u])))),
            ),
            _ => Value::object([] as [(&str, Value); 0]),
        };
        let at = now();
        message["createdAt"] = json!(at);
        message["expiresAt"] = json!(at + ttl);
        message["messageId"] = json!(uuid::Uuid::new_v4().to_string());
        message["sourceInstanceId"] = json!(self.instance);
        ensure!(
            message.stringify().len() <= MAX_MESSAGE_BYTES,
            "Coordination message exceeds the relay size limit."
        );
        self.state.lock().unwrap().sent += 1;
        Ok(message)
    }
    pub async fn receive(&self, message: Value) {
        if !message.is_object()
            || !string(&message["kind"], 100)
            || !string(&message["messageId"], 200)
            || !string(&message["sourceInstanceId"], 512)
            || !matches!(message["createdAt"], Value::Number(_))
            || !matches!(message["expiresAt"], Value::Number(_))
            || message["expiresAt"].as_f64().is_some_and(|at| at <= now())
        {
            self.state.lock().unwrap().rejected += 1;
            return;
        }
        if message["sourceInstanceId"] == self.instance.as_str()
            || message.get("targetInstanceId").is_some_and(|target| {
                crate::wire::coercion::truthy(Some(target)) && *target != self.instance.as_str()
            })
        {
            return;
        }
        if message["kind"] == "worker-presence" {
            let Some(p) = presence(&message["presence"]) else {
                self.state.lock().unwrap().rejected += 1;
                return;
            };
            if message["action"] == "online" {
                self.cache(p);
            } else {
                self.remove(p["workerId"].as_js_string().unwrap(), &p["connectionId"]);
            }
        }
        self.state.lock().unwrap().received += 1;
        // JS Set iteration observes removal and additions while a listener is
        // awaiting. Keep that ordering rather than taking a listener snapshot.
        let mut cursor = 0;
        loop {
            let next = self
                .state
                .lock()
                .unwrap()
                .listeners
                .range((Bound::Excluded(cursor), Bound::Unbounded))
                .next()
                .map(|(id, l)| (*id, l.clone()));
            let Some((id, listener)) = next else {
                break;
            };
            cursor = id;
            if listener(message.clone()).await.is_err() {
                self.state.lock().unwrap().rejected += 1;
            }
        }
    }
}
