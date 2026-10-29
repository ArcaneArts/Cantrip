//! Local command correlation and reconnect continuity. Domain event consumers
//! attach async handlers; responses complete only after preceding events.
#[path = "link_frames.rs"]
mod link_frames;
#[path = "tunnel_frames.rs"]
mod tunnel_frames;
pub type TunnelFrameHandler = super::frames::Handler<crate::tunnels::frame::Frame>;
pub type TunnelFrameSubscription = super::frames::Subscription<crate::tunnels::frame::Frame>;
use super::notifications::Notifications;
pub use super::notifications::{
    NotificationHandler, NotificationSubscription, OwnedNotificationHandler,
};
use super::offline::OfflineListeners;
pub use super::offline::{OfflineHandler, OfflineSubscription};
use super::{frames::Frames, output::Buffered};
pub use super::{
    frames::{FrameHandler, FrameSubscription},
    output::Queued,
};
use crate::wire::{self, JsString, Value};
use std::{
    collections::HashMap,
    fmt,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::AbortHandle;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Continuity {
    pub owner: String,
    pub credential: String,
    pub process_generation: String,
}
#[derive(Clone, Debug)]
pub struct CommandError {
    pub message: JsString,
    pub code: Option<String>,
    pub unavailable: bool,
    /// Preserve schema failures separately from worker/callback failures for
    /// the HTTP/domain layer. Application HTTP errors redact internal details.
    pub encoding_error: Option<Arc<wire::ValidationError>>,
}
impl CommandError {
    fn unavailable(message: String) -> Self {
        Self {
            message: message.into(),
            code: None,
            unavailable: true,
            encoding_error: None,
        }
    }
    fn command(message: String, code: &str) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
            unavailable: false,
            encoding_error: None,
        }
    }
}
impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for CommandError {}
pub enum Outgoing {
    Text(Queued<String>),
    Binary(Queued<crate::worker_links::frame::Frame>),
    Tunnel(Queued<crate::tunnels::frame::Frame>),
    Close(u16, String),
}
pub struct Peer {
    pub id: Uuid,
    pub identity: Continuity,
    pub open: AtomicBool,
    pub output: mpsc::UnboundedSender<Outgoing>,
    pub closing: watch::Sender<Option<(u16, String)>>,
    buffered: Buffered,
}
impl Peer {
    pub fn new(identity: Continuity) -> (Arc<Self>, mpsc::UnboundedReceiver<Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                id: Uuid::new_v4(),
                identity,
                open: AtomicBool::new(true),
                output: tx,
                closing: watch::channel(None).0,
                buffered: Buffered::default(),
            }),
            rx,
        )
    }
    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire) && !self.output.is_closed()
    }
    pub fn buffered_amount(&self) -> usize {
        self.buffered.bytes()
    }
    fn send_text(&self, text: String) -> bool {
        let bytes = super::output::framed_size(text.len());
        self.output
            .send(Outgoing::Text(self.buffered.reserve(text, bytes)))
            .is_ok()
    }
    fn send_frame(&self, frame: crate::worker_links::frame::Frame) -> bool {
        if !self.is_open() {
            return false;
        }
        let bytes = super::output::framed_size(frame.bytes().len());
        let Some(queued) = self.buffered.bounded(frame, bytes, 8 * 1024 * 1024) else {
            return false;
        };
        self.output.send(Outgoing::Binary(queued)).is_ok()
    }
    pub fn close(&self, code: u16, reason: &str) {
        if self.open.swap(false, Ordering::AcqRel) {
            self.closing.send_replace(Some((code, reason.into())));
            let _ = self.output.send(Outgoing::Close(code, reason.into()));
        }
    }
}
pub type EventHandler = Arc<
    dyn Fn(Value) -> Pin<Box<dyn Future<Output = Result<(), CommandError>> + Send>> + Send + Sync,
>;
type Outcome = Result<Option<Value>, CommandError>;
enum Delivery {
    Event(Value),
    Response(Outcome),
    Finished,
}
struct Pending {
    worker: String,
    command: String,
    delivery: mpsc::UnboundedSender<Delivery>,
    completion: Mutex<Option<oneshot::Sender<Outcome>>>,
    timer: Mutex<Option<AbortHandle>>,
}
#[derive(Clone, Debug)]
pub enum BridgeNotice {
    Interrupted(String),
    Offline(String),
}
#[derive(Default)]
struct State {
    peers: HashMap<String, Arc<Peer>>,
    identities: HashMap<String, Continuity>,
    interruptions: HashMap<String, Uuid>,
    timers: HashMap<String, AbortHandle>,
    pending: HashMap<String, Arc<Pending>>,
}
pub struct WorkerBridge {
    closed: AtomicBool,
    state: Mutex<State>,
    lifecycle: parking_lot::ReentrantMutex<()>,
    grace: Duration,
    pub notices: broadcast::Sender<BridgeNotice>,
    routed: AtomicU64,
    succeeded: AtomicU64,
    failed: AtomicU64,
    notifications: Arc<Notifications>,
    frames: Arc<Frames>,
    tunnel_frames: Arc<Frames<crate::tunnels::frame::Frame>>,
    offline: Arc<OfflineListeners>,
    record_usage: Option<crate::live::UsageRecorder>,
    logger: crate::operations::logging::Logger,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStats {
    pub active_requests: usize,
    pub connected_workers: usize,
    pub failed_requests: u64,
    pub routed_requests: u64,
    pub succeeded_requests: u64,
}
impl WorkerBridge {
    /// Synchronous cross-component setup shares the Source lifecycle turn.
    pub fn synchronized<T>(&self, operation: impl FnOnce() -> T) -> T {
        let _lifecycle = self.lifecycle.lock();
        operation()
    }
    pub fn stats(&self) -> BridgeStats {
        let state = self.state.lock().unwrap();
        BridgeStats {
            active_requests: state.pending.len(),
            connected_workers: state.peers.len(),
            failed_requests: self.failed.load(Ordering::Relaxed),
            routed_requests: self.routed.load(Ordering::Relaxed),
            succeeded_requests: self.succeeded.load(Ordering::Relaxed),
        }
    }
    pub fn new(grace: Duration) -> Arc<Self> {
        Self::with_usage(grace, None)
    }
    pub fn with_usage(
        grace: Duration,
        record_usage: Option<crate::live::UsageRecorder>,
    ) -> Arc<Self> {
        Self::with_usage_and_logger(
            grace,
            record_usage,
            crate::operations::logging::server_logger(),
        )
    }
    pub fn with_usage_and_logger(
        grace: Duration,
        record_usage: Option<crate::live::UsageRecorder>,
        logger: crate::operations::logging::Logger,
    ) -> Arc<Self> {
        Arc::new(Self {
            closed: AtomicBool::new(false),
            state: Mutex::new(State::default()),
            lifecycle: parking_lot::ReentrantMutex::new(()),
            grace,
            notices: broadcast::channel(1024).0,
            routed: AtomicU64::new(0),
            succeeded: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            notifications: Arc::new(Notifications::default()),
            frames: Arc::new(Frames::default()),
            tunnel_frames: Arc::new(Frames::default()),
            offline: Arc::new(OfflineListeners::default()),
            record_usage,
            logger,
        })
    }
    fn finish(&self, pending: &Pending, result: Outcome) {
        if let Some(tx) = pending.completion.lock().unwrap().take() {
            if let Some(timer) = pending.timer.lock().unwrap().take() {
                timer.abort();
            }
            if result.is_ok() {
                self.succeeded.fetch_add(1, Ordering::Relaxed);
            } else {
                self.failed.fetch_add(1, Ordering::Relaxed);
            }
            let _ = tx.send(result);
            let _ = pending.delivery.send(Delivery::Finished);
        }
    }
    fn terminate(
        &self,
        state: &mut State,
        worker: &str,
        error: CommandError,
        close: Option<(u16, &str)>,
    ) -> bool {
        let socket = state.peers.remove(worker);
        let had = socket.is_some()
            | state.identities.contains_key(worker)
            | state.interruptions.contains_key(worker);
        if let Some(timer) = state.timers.remove(worker) {
            timer.abort();
        }
        state.identities.remove(worker);
        state.interruptions.remove(worker);
        let ids = state
            .pending
            .iter()
            .filter(|(_, p)| p.worker == worker)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(pending) = state.pending.remove(&id) {
                if let Some(timer) = pending.timer.lock().unwrap().take() {
                    timer.abort();
                }
                self.finish(&pending, Err(error.clone()));
            }
        }
        if let Some(socket) = socket {
            let _ = self.notices.send(BridgeNotice::Interrupted(worker.into()));
            if let Some((code, reason)) = close {
                socket.close(code, reason);
            }
        }
        if had {
            let _ = self.notices.send(BridgeNotice::Offline(worker.into()));
        }
        had
    }
    /// Readiness is queued on the same channel as commands before registration.
    pub fn attach(&self, worker: &str, peer: Arc<Peer>, ready: Option<String>) -> bool {
        let _lifecycle = self.lifecycle.lock();
        if self.closed.load(Ordering::Acquire) || !peer.is_open() {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        let had = state.peers.contains_key(worker) || state.interruptions.contains_key(worker);
        if had && state.identities.get(worker) != Some(&peer.identity) {
            let notify = self.terminate(
                &mut state,
                worker,
                CommandError::unavailable(format!("Worker {worker} continuity identity changed.")),
                Some((1008, "Worker continuity identity changed")),
            );
            drop(state);
            if notify {
                self.offline.deliver(worker);
            }
            state = self.state.lock().unwrap();
        }
        if !peer.is_open() {
            return false;
        }
        if let Some(ready) = ready
            && !peer.send_text(ready)
        {
            return false;
        }
        let previous = state.peers.insert(worker.into(), peer.clone());
        state
            .identities
            .insert(worker.into(), peer.identity.clone());
        state.interruptions.remove(worker);
        if let Some(timer) = state.timers.remove(worker) {
            timer.abort();
        }
        if let Some(previous) = previous
            && previous.id != peer.id
        {
            previous.close(1012, "Worker reconnected");
        }
        true
    }
    pub fn is_connected(&self, worker: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .peers
            .get(worker)
            .is_some_and(|p| p.is_open())
    }
    pub fn disconnect(&self, worker: &str, reason: &str, code: u16) {
        let _lifecycle = self.lifecycle.lock();
        let notify = self.terminate(
            &mut self.state.lock().unwrap(),
            worker,
            CommandError::unavailable(format!("Worker {worker} disconnected.")),
            Some((code, reason)),
        );
        if notify {
            self.offline.deliver(worker);
        }
    }
    pub fn subscribe_worker_offline(
        &self,
        worker: &str,
        handler: OfflineHandler,
    ) -> OfflineSubscription {
        self.offline.subscribe(worker, handler)
    }
    pub fn interrupted(self: &Arc<Self>, worker: &str, peer: &Peer) {
        let _lifecycle = self.lifecycle.lock();
        let mut state = self.state.lock().unwrap();
        if state.peers.get(worker).is_none_or(|p| p.id != peer.id) {
            return;
        }
        state.peers.remove(worker);
        let generation = Uuid::new_v4();
        state.interruptions.insert(worker.into(), generation);
        if let Some(timer) = state.timers.remove(worker) {
            timer.abort();
        }
        let _ = self.notices.send(BridgeNotice::Interrupted(worker.into()));
        if self.grace.is_zero() {
            let notify = self.terminate(
                &mut state,
                worker,
                CommandError::unavailable(format!("Worker {worker} disconnected.")),
                None,
            );
            drop(state);
            if notify {
                self.offline.deliver(worker);
            }
            return;
        }
        let bridge = Arc::downgrade(self);
        let worker = worker.to_owned();
        let key = worker.clone();
        let grace = self.grace;
        let task = tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            if let Some(bridge) = bridge.upgrade() {
                let _lifecycle = bridge.lifecycle.lock();
                let mut state = bridge.state.lock().unwrap();
                if !state.peers.contains_key(&worker)
                    && state.interruptions.get(&worker) == Some(&generation)
                {
                    let notify = bridge.terminate(
                        &mut state,
                        &worker,
                        CommandError::unavailable(format!("Worker {worker} disconnected.")),
                        None,
                    );
                    drop(state);
                    if notify {
                        bridge.offline.deliver(&worker);
                    }
                }
            }
        });
        state.timers.insert(key, task.abort_handle());
    }
    pub fn response(&self, worker: &str, peer: &Peer, input: &Value) {
        let Ok(response) = wire::parse("workerResponseEnvelopeSchema", Some(input)) else {
            return;
        };
        self.complete_response(worker, peer, &response);
    }
    fn complete_response(&self, worker: &str, peer: &Peer, response: &Value) {
        let Some(id) = response["requestId"].as_str() else {
            return;
        };
        let mut state = self.state.lock().unwrap();
        if state.peers.get(worker).is_none_or(|p| p.id != peer.id)
            || state.pending.get(id).is_none_or(|p| p.worker != worker)
        {
            return;
        }
        let pending = state.pending.remove(id).unwrap();
        if let Some(timer) = pending.timer.lock().unwrap().take() {
            timer.abort();
        }
        let result = if response["ok"] == true {
            Ok(response.get("result").cloned())
        } else {
            Err(CommandError {
                message: response["error"]["message"].as_js_string().unwrap().clone(),
                code: response["error"]
                    .get("code")
                    .and_then(Value::as_str)
                    .map(String::from),
                unavailable: false,
                encoding_error: None,
            })
        };
        let _ = pending.delivery.send(Delivery::Response(result));
    }
    /// Admission from the actual worker transport. Every accepted envelope is
    /// normalized by the authoritative generated contract before dispatch.
    pub fn receive(&self, worker: &str, peer: &Peer, text: &str) {
        if self
            .state
            .lock()
            .unwrap()
            .peers
            .get(worker)
            .is_none_or(|current| current.id != peer.id)
        {
            return;
        }
        let Ok(input) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let Ok(envelope) = wire::parse("workerServerEnvelopeSchema", Some(&input)) else {
            return;
        };
        match envelope["kind"].as_str() {
            Some("response") => self.complete_response(worker, peer, &envelope),
            Some("event") => {
                if let Some(id) = envelope["requestId"].as_str() {
                    self.event(worker, peer, id, envelope["event"].clone());
                }
            }
            Some("notification") => {
                let group = {
                    let state = self.state.lock().unwrap();
                    if state
                        .peers
                        .get(worker)
                        .is_none_or(|current| current.id != peer.id)
                    {
                        return;
                    }
                    self.notifications.group(worker)
                };
                if let Some(group) = group {
                    Notifications::deliver(
                        group,
                        &peer.identity.owner,
                        envelope["notification"].clone(),
                    );
                }
            }
            _ => {}
        }
    }
    pub fn subscribe_notifications(
        &self,
        worker: &str,
        handler: NotificationHandler,
    ) -> NotificationSubscription {
        self.notifications.subscribe(worker, handler)
    }
    pub fn subscribe_owned_notifications(
        &self,
        worker: &str,
        handler: OwnedNotificationHandler,
    ) -> NotificationSubscription {
        self.notifications.subscribe_owned(worker, handler)
    }
    // The caller validates each domain event before dispatching it here.
    pub fn event(&self, worker: &str, peer: &Peer, id: &str, event: Value) {
        let state = self.state.lock().unwrap();
        if state.peers.get(worker).is_none_or(|p| p.id != peer.id) {
            return;
        }
        if let Some(pending) = state.pending.get(id).filter(|p| p.worker == worker) {
            let _ = pending.delivery.send(Delivery::Event(event));
        }
    }
    pub async fn request(
        self: &Arc<Self>,
        worker: &str,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
    ) -> Outcome {
        let (id, rx, mut delivery, pending) = {
            let _lifecycle = self.lifecycle.lock();
            // The Node bridge rejects an offline worker before encoding, and
            // encoding failures do not admit a request, timer or routing metric.
            if !self.is_connected(worker) {
                return Err(CommandError::unavailable(format!(
                    "Worker {worker} is offline."
                )));
            }
            let id = Uuid::new_v4().to_string();
            let kind = command["type"].as_str().unwrap_or("").to_owned();
            let envelope = Value::object([
                ("kind", Value::String("request".into())),
                ("requestId", Value::String(id.clone().into())),
                ("command", command),
            ]);
            let envelope =
                wire::parse("workerRequestEnvelopeSchema", Some(&envelope)).map_err(|error| {
                    CommandError {
                        message: "Worker request encoding failed.".into(),
                        code: None,
                        unavailable: false,
                        encoding_error: Some(Arc::new(error)),
                    }
                })?;
            let encoded = envelope.stringify();
            let (tx, rx) = oneshot::channel();
            let (events, delivery) = mpsc::unbounded_channel();
            let pending = Arc::new(Pending {
                worker: worker.into(),
                command: kind.clone(),
                delivery: events,
                completion: Mutex::new(Some(tx)),
                timer: Mutex::new(None),
            });
            {
                let mut state = self.state.lock().unwrap();
                let Some(peer) = state.peers.get(worker).filter(|p| p.is_open()).cloned() else {
                    return Err(CommandError::unavailable(format!(
                        "Worker {worker} is offline."
                    )));
                };
                if let Some(timeout) = timeout {
                    let bridge = Arc::downgrade(self);
                    let key = id.clone();
                    let target = pending.clone();
                    let task = tokio::spawn(async move {
                        tokio::time::sleep(timeout).await;
                        if let Some(bridge) = bridge.upgrade() {
                            let mut state = bridge.state.lock().unwrap();
                            if state
                                .pending
                                .get(&key)
                                .is_some_and(|p| Arc::ptr_eq(p, &target))
                            {
                                state.pending.remove(&key);
                                bridge.finish(
                                    &target,
                                    Err(CommandError::command(
                                        format!("Worker command {} timed out.", target.command),
                                        "worker-command-timeout",
                                    )),
                                );
                            }
                        }
                    });
                    *pending.timer.lock().unwrap() = Some(task.abort_handle());
                }
                self.routed.fetch_add(1, Ordering::Relaxed);
                state.pending.insert(id.clone(), pending.clone());
                let bytes = encoded.len();
                if !peer.send_text(encoded) {
                    state.pending.remove(&id);
                    self.finish(
                        &pending,
                        Err(CommandError::command(
                            format!("Worker command {kind} could not be dispatched."),
                            "worker-command-dispatch-failed",
                        )),
                    );
                } else if let Some(record) = &self.record_usage {
                    record(&peer.identity.owner, false, bytes, true);
                }
            }
            (id, rx, delivery, pending)
        };
        let bridge = Arc::downgrade(self);
        let target = pending.clone();
        tokio::spawn(async move {
            while let Some(message) = delivery.recv().await {
                let Some(bridge) = bridge.upgrade() else {
                    break;
                };
                match message {
                    Delivery::Finished => break,
                    Delivery::Event(event) => {
                        if let Some(handler) = &on_event
                            && let Err(error) = handler(event).await
                        {
                            let mut state = bridge.state.lock().unwrap();
                            if state
                                .pending
                                .get(&id)
                                .is_some_and(|p| Arc::ptr_eq(p, &target))
                            {
                                state.pending.remove(&id);
                            }
                            if let Some(timer) = target.timer.lock().unwrap().take() {
                                timer.abort();
                            }
                            bridge.finish(&target, Err(error));
                            break;
                        }
                    }
                    Delivery::Response(result) => {
                        bridge.finish(&target, result);
                        break;
                    }
                }
            }
        });
        rx.await
            .unwrap_or_else(|_| Err(CommandError::unavailable("Server is shutting down.".into())))
    }
    pub fn close(&self) {
        let _lifecycle = self.lifecycle.lock();
        self.closed.store(true, Ordering::Release);
        let workers = {
            let state = self.state.lock().unwrap();
            state
                .peers
                .keys()
                .chain(state.identities.keys())
                .chain(state.interruptions.keys())
                .cloned()
                .collect::<std::collections::HashSet<_>>()
        };
        for worker in workers {
            let notify = self.terminate(
                &mut self.state.lock().unwrap(),
                &worker,
                CommandError::unavailable("Server is shutting down.".into()),
                Some((1001, "Server shutting down")),
            );
            if notify {
                self.offline.deliver(&worker);
            }
        }
        self.notifications.clear();
        self.frames.clear();
        self.tunnel_frames.clear();
        self.offline.clear();
    }
}
