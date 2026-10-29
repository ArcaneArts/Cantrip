//! Desktop tunnel activation and socket lifetime, with owned database cleanup.
mod activation;
mod endpoint;
mod lifecycle;
pub use endpoint::channel;
mod timers;
use super::{
    Repository, StopFence, Time,
    broker::{self, Broker},
    frame,
};
use crate::{
    live,
    operations::logging::{LogCall, Logger},
    wire::{Value, coercion, value::json},
    workers::bridge::{OfflineSubscription, WorkerBridge},
};
use anyhow::{Context, Result, bail};
use indexmap::IndexMap;
use parking_lot::ReentrantMutex;
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, oneshot};
pub trait Socket: live::Socket {
    fn state(&self) -> u8 {
        if self.is_open() { 1 } else { 3 }
    }
    fn send_binary(&self, frame: frame::Frame) -> Result<()>;
    fn ping(&self, token: &[u8]) -> Result<()>;
}
pub type Record = Arc<dyn Fn(&str, &str, bool, usize) + Send + Sync>;
pub type Changed = Arc<dyn Fn(Value) + Send + Sync>;
pub struct Options {
    pub heartbeat_ms: f64,
    pub timeout_ms: f64,
    pub clock: super::Clock,
    pub logger: Logger,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            heartbeat_ms: 25000.0,
            timeout_ms: 10000.0,
            clock: Arc::new(crate::auth::now),
            logger: crate::operations::logging::server_logger(),
        }
    }
}
struct ActiveState {
    activated_at: Option<Time>,
    activated: bool,
    expiry: Option<tokio::task::AbortHandle>,
    heartbeat: Option<tokio::task::AbortHandle>,
    token: Option<Arc<[u8]>>,
    worker: Option<OfflineSubscription>,
}
struct Active {
    authorization: Value,
    diagnostic: Option<Value>,
    endpoint: Arc<endpoint::Endpoint>,
    route: broker::Handle,
    state: Mutex<ActiveState>,
    started: i64,
}
struct State {
    closed: bool,
    active: IndexMap<String, Arc<Active>>,
    gates: HashMap<String, Weak<tokio::sync::Mutex<()>>>,
    pending: usize,
    heartbeat: Option<tokio::task::AbortHandle>,
    sweep: Option<tokio::task::AbortHandle>,
}
pub struct Runtime {
    serial: ReentrantMutex<()>,
    state: Mutex<State>,
    repository: Repository,
    bridge: Arc<WorkerBridge>,
    broker: Arc<Broker>,
    changed: Changed,
    record: Option<Record>,
    options: Options,
    drain: Notify,
}
#[derive(Clone)]
pub struct Handle {
    runtime: Weak<Runtime>,
    active: Arc<Active>,
}
pub struct Attachment {
    pub handle: Handle,
    pub ready: oneshot::Receiver<Result<Value>>,
}
enum Event<'a> {
    Requested,
    Activated(i64),
    Closed(&'a str),
}
struct Pending(Arc<Runtime>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().pending -= 1;
        self.0.drain.notify_waiters();
    }
}
fn text(value: &Value, key: &str) -> Result<String> {
    super::text(value, key)
}
fn change(active: &Active) -> Value {
    let a = &active.authorization;
    json!({"attachmentId":a["attachmentId"],"ownerId":a["ownerId"],"projectId":a["projectId"],"tunnelId":a["tunnelId"]})
}
impl Runtime {
    pub fn new(
        repository: Repository,
        bridge: Arc<WorkerBridge>,
        broker: Arc<Broker>,
        changed: Changed,
        record: Option<Record>,
        options: Options,
    ) -> Result<Arc<Self>> {
        for value in [options.heartbeat_ms, options.timeout_ms] {
            if !value.is_finite()
                || value <= 0.0
                || value.fract() != 0.0
                || value > 9007199254740991.0
            {
                bail!("Tunnel heartbeat intervals must be positive integers.");
            }
        }
        let runtime = Arc::new(Self {
            serial: ReentrantMutex::new(()),
            state: Mutex::new(State {
                closed: false,
                active: IndexMap::new(),
                gates: HashMap::new(),
                pending: 0,
                heartbeat: None,
                sweep: None,
            }),
            repository,
            bridge,
            broker,
            changed,
            record,
            options,
            drain: Notify::new(),
        });
        runtime.start_timers();
        Ok(runtime)
    }
    pub fn begin(
        self: &Arc<Self>,
        socket: Arc<dyn Socket>,
        authorization: Value,
        initialize: &Value,
    ) -> Result<Attachment> {
        self.bridge
            .synchronized(|| self.begin_inner(socket, authorization, initialize))
    }
    fn begin_inner(
        self: &Arc<Self>,
        socket: Arc<dyn Socket>,
        authorization: Value,
        initialize: &Value,
    ) -> Result<Attachment> {
        let _serial = self.serial.lock();
        let started = (self.options.clock)().timestamp_millis();
        let diagnostic = initialize.get("diagnosticTraceId").cloned();
        self.log(Event::Requested, &authorization, diagnostic.as_ref());
        if self.state.lock().unwrap().closed {
            bail!("The tunnel runtime is shutting down.");
        }
        if initialize["clientId"] != authorization["clientId"] {
            bail!("Tunnel attachment client identity does not match.");
        }
        let worker = text(&authorization["destination"], "workerId")?;
        if !self.bridge.is_connected(&worker) {
            bail!("The destination worker is offline.");
        }
        let id = text(&authorization, "attachmentId")?;
        self.close_active(&id, "Attachment replaced", 1012);
        let endpoint = endpoint::Endpoint::new(socket, authorization.clone(), self.record.clone());
        let route = endpoint.register(&self.broker, &self.bridge, diagnostic.clone())?;
        let active = Arc::new(Active {
            authorization,
            diagnostic,
            endpoint,
            route,
            state: Mutex::new(ActiveState {
                activated_at: None,
                activated: false,
                expiry: None,
                heartbeat: None,
                token: None,
                worker: None,
            }),
            started,
        });
        self.install_expiry(&active)?;
        let (weak, entry) = (Arc::downgrade(self), Arc::downgrade(&active));
        let subscription = self.bridge.subscribe_worker_offline(
            &worker,
            Arc::new(move || {
                if let (Some(runtime), Some(active)) = (weak.upgrade(), entry.upgrade()) {
                    let _serial = runtime.serial.lock();
                    if runtime.current(&active) {
                        runtime.retire(&active, "Destination worker disconnected", 1012);
                    }
                }
            }),
        );
        active.state.lock().unwrap().worker = Some(subscription);
        self.state
            .lock()
            .unwrap()
            .active
            .insert(id.clone(), active.clone());
        let handle = Handle {
            runtime: Arc::downgrade(self),
            active: active.clone(),
        };
        let ticket = self.reserve(&id);
        let (send, ready) = oneshot::channel();
        let runtime = self.clone();
        self.spawn(async move {
            let result = runtime.activate(&active, ticket).await;
            let _ = send.send(result);
        });
        Ok(Attachment { handle, ready })
    }
    fn spawn(self: &Arc<Self>, work: impl Future<Output = ()> + Send + 'static) {
        self.state.lock().unwrap().pending += 1;
        let pending = Pending(self.clone());
        tokio::spawn(async move {
            let _pending = pending;
            work.await;
        });
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.drain.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().unwrap().pending == 0 {
                return;
            }
            changed.await;
        }
    }
    fn log(&self, event: Event<'_>, authorization: &Value, diagnostic: Option<&Value>) {
        let (level, message, event, operation, status, reason, duration) = match event {
            Event::Requested => (
                "debug",
                "Tunnel attachment requested",
                "tunnel.attachment.started",
                "attach",
                "started",
                None,
                None,
            ),
            Event::Activated(duration) => (
                "info",
                "Tunnel attachment active",
                "tunnel.attachment.active",
                "attach",
                "completed",
                None,
                Some(duration),
            ),
            Event::Closed(reason) => (
                "info",
                "Tunnel attachment closed",
                "tunnel.attachment.closed",
                "close",
                "completed",
                Some(timers::reason_code(reason)),
                None,
            ),
        };
        let mut context =
            json!({"event":event,"subsystem":"tunnel","operation":operation,"status":status});
        if let Some(reason) = reason {
            context["reasonCode"] = json!(reason);
        }
        for key in ["attachmentId", "projectId", "tunnelId"] {
            context[key] = authorization[key].clone();
        }
        context["workerId"] = authorization["destination"]["workerId"].clone();
        if let Some(diagnostic) = diagnostic.filter(|v| coercion::truthy(Some(v))) {
            context["diagnosticTraceId"] = diagnostic.clone();
        }
        if let Some(duration) = duration {
            context["durationMs"] = json!(duration);
        }
        (self.options.logger)(LogCall::event(level, message, context));
    }
}
impl Handle {
    pub fn receive(&self, bytes: &[u8], binary: bool) {
        self.active.endpoint.receive(bytes, binary);
    }
    pub fn disconnected(&self) {
        self.active.endpoint.disconnect();
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.retire(&self.active, "Attachment disconnected", 1012);
        }
    }
    pub fn pong(&self, bytes: &[u8]) {
        if let Some(runtime) = self.runtime.upgrade() {
            runtime.pong(&self.active, bytes);
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.close();
    }
}
