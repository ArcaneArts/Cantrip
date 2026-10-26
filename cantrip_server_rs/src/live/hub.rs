mod control;
mod protocol;
use crate::wire::{self, JsString, Value};
use anyhow::{Context as _, Result, bail};
use futures::future::{BoxFuture, join_all};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::oneshot, task::AbortHandle};
use uuid::Uuid;

pub trait Socket: Send + Sync {
    fn is_open(&self) -> bool;
    fn buffered_amount(&self) -> usize;
    fn send(&self, text: Arc<str>) -> Result<()>;
    fn close(&self, code: u16, reason: &str);
}
#[derive(Clone)]
pub struct ConnectionContext {
    pub owner: String,
    pub session: Option<String>,
    pub authorize: Arc<dyn Fn(Value) -> BoxFuture<'static, Result<bool>> + Send + Sync>,
    pub active: Option<Arc<dyn Fn() -> BoxFuture<'static, Result<bool>> + Send + Sync>>,
}
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}
impl Frame {
    fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Binary(bytes) => bytes.len(),
        }
    }
}
pub type ExternalPublisher = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type UsageRecorder = Arc<dyn Fn(&str, bool, usize, bool) + Send + Sync>;
pub struct Options {
    pub epoch: String,
    pub heartbeat_interval_ms: u64,
    pub max_buffered_bytes: usize,
    pub max_inbound_bytes: usize,
    pub max_replay_events: usize,
    pub max_replay_bytes: usize,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub publish_external: Option<ExternalPublisher>,
    pub record_usage: Option<UsageRecorder>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            epoch: Uuid::new_v4().to_string(),
            heartbeat_interval_ms: 30000,
            max_buffered_bytes: 1024 * 1024,
            max_inbound_bytes: 64 * 1024,
            max_replay_events: 2048,
            max_replay_bytes: 32 * 1024 * 1024,
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            publish_external: None,
            record_usage: None,
        }
    }
}
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    accepted_connection_count: u64,
    connection_count: usize,
    current_cursor: u64,
    delivered_event_count: u64,
    disconnected_connection_count: u64,
    heartbeat_pong_count: u64,
    heartbeat_timeout_count: u64,
    protocol_violation_count: u64,
    publication_count: u64,
    queue_pressure_count: u64,
    replay_event_count: usize,
    replay_session_count: u64,
    replayed_event_count: u64,
    resync_required_count: u64,
    resume_attempt_count: u64,
    server_epoch: String,
    slow_consumer_closure_count: u64,
}
#[derive(Clone)]
struct Encoded {
    text: Arc<str>,
    bytes: usize,
    notify: bool,
}
impl Encoded {
    fn new(text: String, notify: bool) -> Self {
        let bytes = text.len();
        Self {
            text: text.into(),
            bytes,
            notify,
        }
    }
}
struct Retained {
    cursor: u64,
    owner: String,
    scope: JsString,
    encoded: Encoded,
}
struct Resume {
    cursor: u64,
    reason: Option<&'static str>,
}
#[derive(Default)]
struct Local {
    initialized: bool,
    capabilities: HashSet<JsString>,
    violations: u64,
    history: IndexMap<JsString, Value>,
    resume: Option<Resume>,
    scopes: IndexMap<JsString, Value>,
}
struct Connection {
    id: Uuid,
    context: ConnectionContext,
    socket: Arc<dyn Socket>,
    closed: AtomicBool,
    last_seen: AtomicI64,
    local: Mutex<Local>,
}
struct Pending {
    connection: Arc<Connection>,
    expires: i64,
    completion: oneshot::Sender<Value>,
    timer: AbortHandle,
}
#[derive(Default)]
struct State {
    closed: bool,
    connections: IndexMap<Uuid, Arc<Connection>>,
    subscribers: HashMap<String, HashMap<JsString, IndexMap<Uuid, Arc<Connection>>>>,
    cursors: HashMap<String, u64>,
    replay: VecDeque<Retained>,
    replay_bytes: usize,
    controls: IndexMap<String, Pending>,
    stats: Stats,
}
pub struct Hub {
    options: Options,
    state: Mutex<State>,
    timer: Mutex<Option<AbortHandle>>,
    maintaining: AtomicBool,
}
fn obj(value: serde_json::Value) -> Value {
    Value::from_serialize(&value)
}
fn encoded(value: &Value) -> Result<Encoded> {
    let parsed = wire::parse("appLiveServerMessageSchema", Some(value))
        .map_err(|_| anyhow::anyhow!("Invalid application live server message"))?;
    Ok(Encoded::new(parsed.stringify(), true))
}
fn request_id(value: &Value) -> Value {
    value
        .get("requestId")
        .filter(|v| {
            v.as_js_string()
                .is_some_and(|s| !s.is_empty() && s.len() <= 200)
        })
        .cloned()
        .unwrap_or(Value::Null)
}
impl Hub {
    pub fn new(options: Options) -> Result<Arc<Self>> {
        if !(5000..=120000).contains(&options.heartbeat_interval_ms) {
            bail!("Live heartbeat interval must be between 5s and 120s.")
        }
        if !(1..=10000).contains(&options.max_replay_events) {
            bail!("Live replay capacity must be between 1 and 10,000.")
        }
        if options.max_buffered_bytes < 1
            || options.max_inbound_bytes < 1
            || options.max_replay_bytes < 1
        {
            bail!("Live frame limits must be positive.")
        }
        let interval = Duration::from_millis(options.heartbeat_interval_ms);
        let hub = Arc::new(Self {
            options,
            state: Mutex::new(State::default()),
            timer: Mutex::new(None),
            maintaining: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&hub);
        let task = tokio::spawn(async move {
            let mut timer =
                tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                let Some(hub) = weak.upgrade() else { break };
                tokio::spawn(async move {
                    hub.maintain().await;
                });
            }
        });
        *hub.timer.lock().unwrap() = Some(task.abort_handle());
        Ok(hub)
    }
    pub fn epoch(&self) -> &str {
        &self.options.epoch
    }
    pub fn attach(&self, socket: Arc<dyn Socket>, context: ConnectionContext) -> Option<Uuid> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            socket.close(1012, "Live service is shutting down");
            return None;
        }
        let id = Uuid::new_v4();
        let connection = Arc::new(Connection {
            id,
            context,
            socket,
            closed: AtomicBool::new(false),
            last_seen: AtomicI64::new((self.options.now)()),
            local: Mutex::new(Local::default()),
        });
        state.connections.insert(id, connection);
        state.stats.accepted_connection_count += 1;
        Some(id)
    }
    pub fn stats(&self) -> Stats {
        let state = self.state.lock().unwrap();
        let mut stats = state.stats.clone();
        stats.connection_count = state.connections.len();
        stats.replay_event_count = state.replay.len();
        stats.server_epoch = self.options.epoch.clone();
        stats
    }
    fn cursor(state: &State, owner: &str) -> u64 {
        state.cursors.get(owner).copied().unwrap_or(0)
    }
    fn remove_subscription(state: &mut State, connection: &Arc<Connection>, key: &JsString) {
        if connection
            .local
            .lock()
            .unwrap()
            .scopes
            .shift_remove(key)
            .is_none()
        {
            return;
        }
        if let Some(scopes) = state.subscribers.get_mut(&connection.context.owner) {
            if let Some(connections) = scopes.get_mut(key) {
                connections.shift_remove(&connection.id);
                if connections.is_empty() {
                    scopes.remove(key);
                }
            }
            if scopes.is_empty() {
                state.subscribers.remove(&connection.context.owner);
            }
        }
    }
    fn add_subscription(state: &mut State, connection: &Arc<Connection>, scope: Value) {
        if connection.closed.load(Ordering::Acquire) {
            return;
        }
        let key = wire::live::scope_key(&scope);
        if connection
            .local
            .lock()
            .unwrap()
            .scopes
            .insert(key.clone(), scope)
            .is_some()
        {
            return;
        }
        state
            .subscribers
            .entry(connection.context.owner.clone())
            .or_default()
            .entry(key)
            .or_default()
            .insert(connection.id, connection.clone());
    }
    fn replace_subscriptions(state: &mut State, connection: &Arc<Connection>, scopes: &[Value]) {
        if connection.closed.load(Ordering::Acquire) {
            return;
        }
        let keys = scopes
            .iter()
            .map(wire::live::scope_key)
            .collect::<HashSet<_>>();
        let old = connection
            .local
            .lock()
            .unwrap()
            .scopes
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for key in old {
            if !keys.contains(&key) {
                Self::remove_subscription(state, connection, &key);
            }
        }
        for scope in scopes {
            Self::add_subscription(state, connection, scope.clone());
        }
    }
    fn settle(state: &mut State, id: &str, status: &str) {
        if let Some(pending) = state.controls.shift_remove(id) {
            pending.timer.abort();
            let _ = pending
                .completion
                .send(obj(serde_json::json!({"correlationId":id,"status":status})));
        }
    }
    fn disconnect_connection(state: &mut State, connection: &Arc<Connection>) -> bool {
        if connection.closed.swap(true, Ordering::AcqRel) {
            return false;
        }
        state.connections.shift_remove(&connection.id);
        let scopes = connection
            .local
            .lock()
            .unwrap()
            .scopes
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for key in scopes {
            Self::remove_subscription(state, connection, &key);
        }
        state.stats.disconnected_connection_count += 1;
        let controls = state
            .controls
            .iter()
            .filter(|(_, p)| p.connection.id == connection.id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in controls {
            Self::settle(state, &id, "unavailable");
        }
        true
    }
    fn close_connection(state: &mut State, connection: &Arc<Connection>, code: u16, reason: &str) {
        if Self::disconnect_connection(state, connection) {
            connection.socket.close(code, reason);
        }
    }
    pub fn disconnect(&self, id: Uuid) {
        let mut state = self.state.lock().unwrap();
        if let Some(connection) = state.connections.get(&id).cloned() {
            Self::disconnect_connection(&mut state, &connection);
        }
    }
    fn send_encoded(
        &self,
        state: &mut State,
        connection: &Arc<Connection>,
        encoded: &Encoded,
    ) -> bool {
        if connection.closed.load(Ordering::Acquire) || !connection.socket.is_open() {
            Self::disconnect_connection(state, connection);
            return false;
        }
        if connection
            .socket
            .buffered_amount()
            .saturating_add(encoded.bytes)
            > self.options.max_buffered_bytes
        {
            state.stats.queue_pressure_count += 1;
            state.stats.slow_consumer_closure_count += 1;
            Self::close_connection(
                state,
                connection,
                1013,
                "Live queue overflow; reconnect and resync",
            );
            return false;
        }
        if connection.socket.send(encoded.text.clone()).is_err() {
            Self::close_connection(state, connection, 1011, "Live send failed");
            return false;
        }
        if let Some(record) = &self.options.record_usage {
            record(
                &connection.context.owner,
                false,
                encoded.bytes,
                encoded.notify,
            )
        }
        true
    }
    fn send(
        &self,
        state: &mut State,
        connection: &Arc<Connection>,
        message: Value,
    ) -> Result<bool> {
        Ok(self.send_encoded(state, connection, &encoded(&message)?))
    }
    fn error(
        &self,
        state: &mut State,
        connection: &Arc<Connection>,
        id: Value,
        code: &str,
        message: &str,
        retryable: bool,
    ) -> Result<bool> {
        self.send(
            state,
            connection,
            Value::object([
                ("type", obj(serde_json::json!("error"))),
                ("requestId", id),
                ("code", obj(serde_json::json!(code))),
                ("message", obj(serde_json::json!(message))),
                ("retryable", obj(serde_json::json!(retryable))),
            ]),
        )
    }
    fn violation(
        &self,
        state: &mut State,
        connection: &Arc<Connection>,
        id: Value,
        code: &str,
        message: &str,
    ) -> Result<()> {
        connection.local.lock().unwrap().violations += 1;
        state.stats.protocol_violation_count += 1;
        self.error(state, connection, id, code, message, false)?;
        if connection.local.lock().unwrap().violations >= 5 {
            Self::close_connection(state, connection, 1008, "Too many live protocol errors");
        }
        Ok(())
    }
    fn remember(connection: &Arc<Connection>, id: JsString, message: Value) {
        let mut local = connection.local.lock().unwrap();
        local.history.insert(id, message);
        if local.history.len() > 256 {
            local.history.shift_remove_index(0);
        }
    }
    fn remember_send(
        &self,
        state: &mut State,
        connection: &Arc<Connection>,
        message: Value,
    ) -> Result<bool> {
        if let Some(id) = message.get("requestId").and_then(Value::as_js_string) {
            Self::remember(connection, id.clone(), message.clone());
        }
        self.send(state, connection, message)
    }
    fn remember_error(
        &self,
        state: &mut State,
        connection: &Arc<Connection>,
        id: &Value,
        code: &str,
        message: &str,
    ) -> Result<()> {
        let value = Value::object([
            ("type", obj(serde_json::json!("error"))),
            ("requestId", id.clone()),
            ("code", obj(serde_json::json!(code))),
            ("message", obj(serde_json::json!(message))),
            ("retryable", Value::Bool(false)),
        ]);
        self.remember_send(state, connection, value)?;
        Ok(())
    }
    fn resume_reason(
        &self,
        state: &State,
        owner: &str,
        epoch: &str,
        cursor: u64,
    ) -> Option<&'static str> {
        if epoch != self.options.epoch {
            return Some("server-epoch-changed");
        }
        let current = Self::cursor(state, owner);
        let oldest = state
            .replay
            .iter()
            .find(|e| e.owner == owner)
            .map(|e| e.cursor);
        if cursor > current
            || oldest.is_some_and(|first| cursor < first.saturating_sub(1))
            || (oldest.is_none() && cursor != current)
        {
            Some("cursor-expired")
        } else {
            None
        }
    }
    fn resync(
        &self,
        state: &mut State,
        connection: &Arc<Connection>,
        message: Value,
    ) -> Result<bool> {
        state.stats.resync_required_count += 1;
        self.send(state, connection, message)
    }
    fn replay(&self, state: &mut State, connection: &Arc<Connection>, cursor: u64) -> Result<()> {
        connection.local.lock().unwrap().resume = None;
        state.stats.replay_session_count += 1;
        let scopes = connection
            .local
            .lock()
            .unwrap()
            .scopes
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        let events = state
            .replay
            .iter()
            .filter(|e| {
                e.owner == connection.context.owner
                    && e.cursor > cursor
                    && scopes.contains(&e.scope)
            })
            .map(|e| e.encoded.clone())
            .collect::<Vec<_>>();
        let mut count = 0;
        for event in events {
            if !self.send_encoded(state, connection, &event) {
                return Ok(());
            }
            count += 1;
            state.stats.replayed_event_count += 1;
            state.stats.delivered_event_count += 1;
        }
        self.send(state,connection,obj(serde_json::json!({"type":"caught-up","cursor":Self::cursor(state,&connection.context.owner),"replayedCount":count})))?;
        Ok(())
    }
    fn finish_resume(&self, state: &mut State, connection: &Arc<Connection>) -> Result<()> {
        let resume = connection
            .local
            .lock()
            .unwrap()
            .resume
            .as_ref()
            .map(|r| (r.cursor, r.reason));
        if let Some((cursor, reason)) = resume {
            if let Some(reason) = reason {
                let scopes = connection
                    .local
                    .lock()
                    .unwrap()
                    .scopes
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                self.resync(state,connection,obj(serde_json::json!({"type":"resync-required","cursor":Self::cursor(state,&connection.context.owner),"reason":reason,"scopes":scopes})))?;
            } else {
                self.replay(state, connection, cursor)?;
            }
        }
        Ok(())
    }
    fn publication(&self, publication: &Value) -> Result<Value> {
        let owner = publication["ownerId"]
            .as_str()
            .context("live publication owner")?;
        let mut event = publication.clone();
        let Value::Object(object) = &mut event else {
            bail!("Invalid live publication")
        };
        object.shift_remove("ownerId");
        let mut state = self.state.lock().unwrap();
        if state.closed {
            bail!("Cannot publish after the live hub has closed.")
        }
        let cursor = Self::cursor(&state, owner) + 1;
        event["type"] = obj(serde_json::json!("event"));
        event["cursor"] = obj(serde_json::json!(cursor));
        if event.get("occurredAt").is_none_or(Value::is_null) {
            event["occurredAt"] = obj(serde_json::json!(crate::auth::iso(
                chrono::DateTime::from_timestamp_millis((self.options.now)())
                    .context("live publication time")?
            )));
        }
        let event = wire::parse("appLiveServerMessageSchema", Some(&event))
            .map_err(|_| anyhow::anyhow!("Invalid live publication"))?;
        state.cursors.insert(owner.into(), cursor);
        state.stats.current_cursor += 1;
        state.stats.publication_count += 1;
        let encoded = Encoded::new(
            event.stringify(),
            event["resource"] != "account-resource-usage",
        );
        let scope = wire::live::scope_key(&event["scope"]);
        state.replay_bytes += encoded.bytes;
        state.replay.push_back(Retained {
            cursor,
            owner: owner.into(),
            scope: scope.clone(),
            encoded: encoded.clone(),
        });
        while state.replay.len() > self.options.max_replay_events
            || state.replay_bytes > self.options.max_replay_bytes
        {
            let Some(removed) = state.replay.pop_front() else {
                break;
            };
            state.replay_bytes -= removed.encoded.bytes;
        }
        let subscribers = state
            .subscribers
            .get(owner)
            .and_then(|s| s.get(&scope))
            .map(|s| s.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for connection in subscribers {
            let eligible = {
                let local = connection.local.lock().unwrap();
                local.initialized && local.resume.is_none()
            };
            if eligible && self.send_encoded(&mut state, &connection, &encoded) {
                state.stats.delivered_event_count += 1;
            }
        }
        Ok(event)
    }
    pub fn publish(&self, publication: Value) -> Result<Value> {
        let event = self.publication(&publication)?;
        if let Some(publish) = &self.options.publish_external {
            let result = publish(publication);
            tokio::spawn(async move {
                let _ = result.await;
            });
        }
        Ok(event)
    }
    pub async fn publish_confirmed(&self, publication: Value) -> Result<Value> {
        let event = self.publication(&publication)?;
        if let Some(publish) = &self.options.publish_external {
            publish(publication).await?;
        }
        Ok(event)
    }
    pub fn receive_external(&self, publication: &Value) -> Option<Value> {
        if !publication["ownerId"].is_string() {
            return None;
        }
        self.publication(publication).ok()
    }
    pub fn revoke_owner(&self, owner: &str) -> usize {
        self.revoke(
            |c| c.context.owner == owner,
            "Account sessions were revoked",
        )
    }
    pub fn revoke_session(&self, session: &str) -> usize {
        self.revoke(
            |c| c.context.session.as_deref() == Some(session),
            "Session was revoked",
        )
    }
    fn revoke(&self, matches: impl Fn(&Connection) -> bool, reason: &str) -> usize {
        let mut state = self.state.lock().unwrap();
        let connections = state
            .connections
            .values()
            .filter(|c| matches(c))
            .cloned()
            .collect::<Vec<_>>();
        let count = connections.len();
        for connection in connections {
            Self::close_connection(&mut state, &connection, 1008, reason);
        }
        count
    }
    async fn maintain(self: Arc<Self>) {
        if self.maintaining.swap(true, Ordering::AcqRel) {
            return;
        }
        let stale = (self.options.now)() - (self.options.heartbeat_interval_ms * 3) as i64;
        let connections = self
            .state
            .lock()
            .unwrap()
            .connections
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let hub = self.as_ref();
        join_all(connections.into_iter().map(|connection| async move {
            if connection.last_seen.load(Ordering::Acquire) < stale {
                let mut state = hub.state.lock().unwrap();
                state.stats.heartbeat_timeout_count += 1;
                Self::close_connection(&mut state, &connection, 1001, "Live heartbeat timed out");
            } else if !Self::active(&connection).await {
                Self::close_connection(
                    &mut hub.state.lock().unwrap(),
                    &connection,
                    1008,
                    "Session is no longer active",
                );
            }
        }))
        .await;
        self.maintaining.store(false, Ordering::Release);
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        state.closed = true;
        if let Some(timer) = self.timer.lock().unwrap().take() {
            timer.abort();
        }
        let controls = state.controls.keys().cloned().collect::<Vec<_>>();
        for id in controls {
            Self::settle(&mut state, &id, "unavailable");
        }
        let connections = state.connections.values().cloned().collect::<Vec<_>>();
        for connection in connections {
            Self::close_connection(
                &mut state,
                &connection,
                1001,
                "Live service is shutting down",
            );
        }
    }
}
