//! Local command correlation and reconnect continuity. Domain event consumers
//! attach async handlers; responses complete only after preceding events.
#[path = "bridge_logs.rs"]
mod logs;
use logs::{ConnectionLog, FinishLog};
#[path = "link_frames.rs"]
mod link_frames;
#[path = "surface_frames.rs"]
mod surface_frames;
#[path = "tunnel_frames.rs"]
mod tunnel_frames;
pub type SurfaceFrameHandler = super::frames::Handler<crate::remote_surfaces::frame::Frame>;
pub type SurfaceFrameSubscription =
    super::frames::Subscription<crate::remote_surfaces::frame::Frame>;
pub type TunnelFrameHandler = super::frames::Handler<crate::tunnels::frame::Frame>;
pub type TunnelFrameSubscription = super::frames::Subscription<crate::tunnels::frame::Frame>;
use super::command_deadline::CommandDeadline;
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
use indexmap::{IndexMap, IndexSet};
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
    /// Source worker-command failures carry the dispatched correlation ID.
    pub request_id: Option<String>,
    /// Preserve schema failures separately from worker/callback failures for
    /// the HTTP/domain layer. Application HTTP errors redact internal details.
    pub encoding_error: Option<Arc<wire::ValidationError>>,
    pub inference: Option<Box<Value>>,
}
impl CommandError {
    pub(super) fn not_sent(message: String) -> Self {
        let mut error = Self::unavailable(message);
        error.code = Some("worker-command-not-sent".into());
        error
    }
    pub(super) fn unavailable(message: String) -> Self {
        Self {
            message: message.into(),
            code: None,
            unavailable: true,
            request_id: None,
            encoding_error: None,
            inference: None,
        }
    }
    pub(super) fn command(message: String, code: &str, request: &str) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
            unavailable: false,
            request_id: Some(request.to_owned()),
            encoding_error: None,
            inference: None,
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
    Surface(Queued<crate::remote_surfaces::frame::Frame>),
    Close(u16, String),
}
pub struct Peer {
    pub id: Uuid,
    pub identity: Continuity,
    pub continuity: Option<Continuity>,
    pub open: AtomicBool,
    pub output: mpsc::UnboundedSender<Outgoing>,
    pub closing: watch::Sender<Option<(u16, String)>>,
    output_order: Mutex<()>,
    close_started: Mutex<Option<tokio::time::Instant>>,
    buffered: Buffered,
}
impl Peer {
    pub fn new(identity: Continuity) -> (Arc<Self>, mpsc::UnboundedReceiver<Outgoing>) {
        Self::with_continuity(identity, true)
    }
    pub fn legacy(identity: Continuity) -> (Arc<Self>, mpsc::UnboundedReceiver<Outgoing>) {
        Self::with_continuity(identity, false)
    }
    fn with_continuity(
        identity: Continuity,
        asserted: bool,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                id: Uuid::new_v4(),
                continuity: asserted.then(|| identity.clone()),
                identity,
                open: AtomicBool::new(true),
                output: tx,
                closing: watch::channel(None).0,
                output_order: Mutex::new(()),
                close_started: Mutex::new(None),
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
        let _order = self.output_order.lock().unwrap();
        if !self.is_open() {
            return false;
        }
        let bytes = super::output::framed_size(text.len());
        self.output
            .send(Outgoing::Text(self.buffered.reserve(text, bytes)))
            .is_ok()
    }
    fn send_frame(&self, frame: crate::worker_links::frame::Frame) -> bool {
        let _order = self.output_order.lock().unwrap();
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
        let _order = self.output_order.lock().unwrap();
        if self.open.swap(false, Ordering::AcqRel) {
            *self.close_started.lock().unwrap() = Some(tokio::time::Instant::now());
            self.closing.send_replace(Some((code, reason.into())));
            let _ = self.output.send(Outgoing::Close(code, reason.into()));
        }
    }
    /// 1005 represents an absent status locally; it must never be put on wire.
    pub fn close_empty(&self) {
        self.close(1005, "");
    }
    pub fn close_deadline(&self) -> Option<tokio::time::Instant> {
        self.close_started
            .lock()
            .unwrap()
            .map(|at| at + Duration::from_secs(30))
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
    request_id: String,
    started_at: f64,
    response_duration: Mutex<Option<f64>>,
    worker: String,
    command: String,
    delivery: mpsc::UnboundedSender<Delivery>,
    completion: Mutex<Option<oneshot::Sender<Outcome>>>,
    timer: Mutex<Option<AbortHandle>>,
    deadline: Mutex<CommandDeadline>,
    deadline_changed: watch::Sender<()>,
}
#[derive(Clone, Debug)]
pub enum BridgeNotice {
    Interrupted(String),
    Offline(String),
}
#[derive(Default)]
struct State {
    peers: IndexMap<String, Arc<Peer>>,
    identities: IndexMap<String, Continuity>,
    continuities: HashMap<String, Option<Continuity>>,
    interruptions: IndexMap<String, Uuid>,
    interrupted_at: HashMap<String, f64>,
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
    inference_sequence: Mutex<num_bigint::BigUint>,
    notifications: Arc<Notifications>,
    frames: Arc<Frames>,
    tunnel_frames: Arc<Frames<crate::tunnels::frame::Frame>>,
    surface_frames: Arc<Frames<crate::remote_surfaces::frame::Frame>>,
    disconnected: Arc<OfflineListeners>,
    offline: Arc<OfflineListeners>,
    record_usage: Option<crate::live::UsageRecorder>,
    logger: crate::operations::logging::Logger,
    clock: crate::operations::logging::Clock,
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
        Self::with_usage_logger_and_clock(
            grace,
            record_usage,
            logger,
            Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
        )
    }
    pub fn with_usage_logger_and_clock(
        grace: Duration,
        record_usage: Option<crate::live::UsageRecorder>,
        logger: crate::operations::logging::Logger,
        clock: crate::operations::logging::Clock,
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
            inference_sequence: Mutex::new(num_bigint::BigUint::default()),
            notifications: Arc::new(Notifications::default()),
            frames: Arc::new(Frames::default()),
            tunnel_frames: Arc::new(Frames::default()),
            surface_frames: Arc::default(),
            disconnected: Arc::default(),
            offline: Arc::new(OfflineListeners::default()),
            record_usage,
            logger,
            clock,
        })
    }
    fn finish(&self, pending: &Pending, result: Outcome) {
        self.finish_as(pending, result, None)
    }
    fn finish_as(&self, pending: &Pending, result: Outcome, log: Option<FinishLog>) {
        if let Some(tx) = pending.completion.lock().unwrap().take() {
            if let Some(timer) = pending.timer.lock().unwrap().take() {
                timer.abort();
            }
            if result.is_ok() {
                self.succeeded.fetch_add(1, Ordering::Relaxed);
            } else {
                self.failed.fetch_add(1, Ordering::Relaxed);
            }
            if let Some(log) = log {
                self.command_finished(pending, &result, log);
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
    ) -> (Option<Arc<Peer>>, bool, usize) {
        let socket = state.peers.shift_remove(worker);
        let had = socket.is_some()
            | state.identities.contains_key(worker)
            | state.interruptions.contains_key(worker);
        if let Some(timer) = state.timers.remove(worker) {
            timer.abort();
        }
        state.identities.shift_remove(worker);
        state.continuities.remove(worker);
        state.interruptions.shift_remove(worker);
        state.interrupted_at.remove(worker);
        let ids = state
            .pending
            .iter()
            .filter(|(_, p)| p.worker == worker)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let rejected = ids.len();
        for id in ids {
            if let Some(pending) = state.pending.remove(&id) {
                if let Some(timer) = pending.timer.lock().unwrap().take() {
                    timer.abort();
                }
                self.finish(&pending, Err(error.clone()));
            }
        }
        (socket, had, rejected)
    }
    fn finish_termination(
        &self,
        worker: &str,
        (socket, had, rejected): (Option<Arc<Peer>>, bool, usize),
        close: Option<(u16, &str)>,
    ) {
        self.commands_abandoned(worker, rejected);
        // Source calls disconnect listeners after removing the connection but
        // before closing its socket. Run callbacks outside the state lock so
        // reentrant attachment and subscription changes remain possible.
        if let Some(socket) = socket {
            let _ = self.notices.send(BridgeNotice::Interrupted(worker.into()));
            self.disconnected.deliver(worker);
            if let Some((code, reason)) = close {
                socket.close(code, reason);
            }
        }
        if had {
            let _ = self.notices.send(BridgeNotice::Offline(worker.into()));
            self.offline.deliver(worker);
        }
    }
    /// Readiness is queued on the same channel as commands before registration.
    pub fn attach(&self, worker: &str, peer: Arc<Peer>, ready: Option<String>) -> bool {
        let _lifecycle = self.lifecycle.lock();
        if self.closed.load(Ordering::Acquire) || !peer.is_open() {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        let had = state.peers.contains_key(worker) || state.interruptions.contains_key(worker);
        if had && state.continuities.get(worker).cloned().flatten() != peer.continuity {
            self.connection_log(worker, ConnectionLog::IdentityChanged);
            let ended = self.terminate(
                &mut state,
                worker,
                CommandError::unavailable(format!("Worker {worker} continuity identity changed.")),
            );
            drop(state);
            self.finish_termination(
                worker,
                ended,
                Some((1008, "Worker continuity identity changed")),
            );
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
        state
            .continuities
            .insert(worker.into(), peer.continuity.clone());
        state.interruptions.shift_remove(worker);
        let disconnected_at = state.interrupted_at.remove(worker).filter(|at| *at != 0.0);
        if let Some(timer) = state.timers.remove(worker) {
            timer.abort();
        }
        if let Some(previous) = previous
            && previous.id != peer.id
        {
            self.connection_log(worker, ConnectionLog::Replaced);
            previous.close(1012, "Worker reconnected");
        }
        self.connection_log(
            worker,
            disconnected_at.map_or(ConnectionLog::Connected, |at| {
                ConnectionLog::Recovered(((self.clock)() - at).max(0.0))
            }),
        );
        true
    }
    pub fn connection_identity(&self, worker: &str) -> Option<Continuity> {
        self.state
            .lock()
            .unwrap()
            .continuities
            .get(worker)
            .cloned()
            .flatten()
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
        self.connection_log(worker, ConnectionLog::Revoked(code));
        let ended = self.terminate(
            &mut self.state.lock().unwrap(),
            worker,
            CommandError::unavailable(format!("Worker {worker} disconnected.")),
        );
        self.finish_termination(worker, ended, Some((code, reason)));
    }
    pub fn subscribe_worker_offline(
        &self,
        worker: &str,
        handler: OfflineHandler,
    ) -> OfflineSubscription {
        self.offline.subscribe(worker, handler)
    }
    pub fn subscribe_worker_disconnect(
        &self,
        worker: &str,
        handler: OfflineHandler,
    ) -> OfflineSubscription {
        self.disconnected.subscribe(worker, handler)
    }
    pub fn interrupted(self: &Arc<Self>, worker: &str, peer: &Peer) {
        let _lifecycle = self.lifecycle.lock();
        let mut state = self.state.lock().unwrap();
        if state.peers.get(worker).is_none_or(|p| p.id != peer.id) {
            return;
        }
        state.peers.shift_remove(worker);
        state.interrupted_at.insert(worker.into(), (self.clock)());
        let generation = Uuid::new_v4();
        state.interruptions.insert(worker.into(), generation);
        if let Some(timer) = state.timers.remove(worker) {
            timer.abort();
        }
        let _ = self.notices.send(BridgeNotice::Interrupted(worker.into()));
        self.connection_log(worker, ConnectionLog::Interrupted);
        if self.grace.is_zero() {
            let ended = self.terminate(
                &mut state,
                worker,
                CommandError::unavailable(format!("Worker {worker} disconnected.")),
            );
            drop(state);
            self.finish_termination(worker, ended, None);
            self.disconnected.deliver(worker);
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
                    bridge.connection_log(
                        &worker,
                        ConnectionLog::Offline(grace.as_secs_f64() * 1000.0),
                    );
                    let ended = bridge.terminate(
                        &mut state,
                        &worker,
                        CommandError::unavailable(format!("Worker {worker} disconnected.")),
                    );
                    drop(state);
                    bridge.finish_termination(&worker, ended, None);
                }
            }
        });
        state.timers.insert(key.clone(), task.abort_handle());
        drop(state);
        self.disconnected.deliver(&key);
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
        *pending.response_duration.lock().unwrap() =
            Some(((self.clock)() - pending.started_at).max(0.0));
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
                request_id: Some(id.to_owned()),
                encoding_error: None,
                inference: if pending.command == "chat.turn" {
                    response["error"].get("inference").cloned().map(Box::new)
                } else {
                    None
                },
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
            self.invalid_control(worker);
            return;
        };
        let Ok(envelope) = wire::parse("workerServerEnvelopeSchema", Some(&input)) else {
            self.invalid_control(worker);
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
            if event["type"] == "inference.command-state"
                && let (Some(sequence), Some(phase)) =
                    (event["sequence"].as_u64(), event["state"].as_str())
                && pending.deadline.lock().unwrap().observe(sequence, phase)
            {
                pending.deadline_changed.send_replace(());
            }
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
                self.command_offline(worker, &command);
                return Err(CommandError::not_sent(format!(
                    "Worker {worker} is offline."
                )));
            }
            let id = Uuid::new_v4().to_string();
            let kind = command["type"].as_str().unwrap_or("").to_owned();
            let envelope = Value::object([
                ("kind", Value::String("request".into())),
                ("requestId", Value::String(id.clone().into())),
                ("command", command),
                ("inferenceAdmissionAck", Value::Bool(true)),
                ("modelOperationUsage", Value::Bool(true)),
            ]);
            let envelope =
                wire::parse("workerRequestEnvelopeSchema", Some(&envelope)).map_err(|error| {
                    CommandError {
                        message: "Worker request encoding failed.".into(),
                        code: None,
                        unavailable: false,
                        request_id: None,
                        encoding_error: Some(Arc::new(error)),
                        inference: None,
                    }
                })?;
            let mut encoded = envelope.stringify();
            let (tx, rx) = oneshot::channel();
            let (events, delivery) = mpsc::unbounded_channel();
            let pending = Arc::new(Pending {
                request_id: id.clone(),
                started_at: (self.clock)(),
                response_duration: Mutex::new(None),
                worker: worker.into(),
                command: kind.clone(),
                delivery: events,
                completion: Mutex::new(Some(tx)),
                timer: Mutex::new(None),
                deadline: Mutex::new(CommandDeadline::new(timeout)),
                deadline_changed: watch::channel(()).0,
            });
            {
                let mut state = self.state.lock().unwrap();
                let Some(peer) = state.peers.get(worker).filter(|p| p.is_open()).cloned() else {
                    return Err(CommandError::not_sent(format!(
                        "Worker {worker} is offline."
                    )));
                };
                if timeout.is_some() {
                    let bridge = Arc::downgrade(self);
                    let key = id.clone();
                    let target = pending.clone();
                    let mut changed = pending.deadline_changed.subscribe();
                    let task = tokio::spawn(async move {
                        loop {
                            changed.borrow_and_update();
                            let remaining = target.deadline.lock().unwrap().remaining();
                            match remaining {
                                None => {
                                    if changed.changed().await.is_err() {
                                        return;
                                    }
                                }
                                Some(remaining) => {
                                    tokio::select! {
                                        biased;
                                        update = changed.changed() => { if update.is_err() { return; } }
                                        _ = tokio::time::sleep(remaining) => {
                                            let Some(bridge) = bridge.upgrade() else { return; };
                                            let mut state = bridge.state.lock().unwrap();
                                            // Recheck the actual clock under the same state lock
                                            // used by incoming phase updates. A stale timer cannot
                                            // expire work that has entered a queue in the meantime.
                                            if !target.deadline.lock().unwrap().remaining().is_some_and(|left| left.is_zero()) { continue; }
                                            if state.pending.get(&key).is_some_and(|p| Arc::ptr_eq(p, &target)) {
                                                state.pending.remove(&key);
                                                bridge.finish_as(&target, Err(CommandError::command(
                                                    format!("Worker command {} timed out.", target.command),
                                                    "worker-command-timeout", &key)),Some(FinishLog::Timeout));
                                            }
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                    });
                    *pending.timer.lock().unwrap() = Some(task.abort_handle());
                }
                self.routed.fetch_add(1, Ordering::Relaxed);
                self.command_dispatched(&pending);
                state.pending.insert(id.clone(), pending.clone());
                // Match the reference's private BigInt allocation in actual
                // send order. Encoding failures never consume an identity;
                // failed send attempts do. Append only the decimal field.
                let sequence = {
                    let mut sequence = self.inference_sequence.lock().unwrap();
                    *sequence += 1_u8;
                    sequence.to_str_radix(10)
                };
                encoded.truncate(encoded.len() - 1);
                encoded.push_str(&format!(",\"inferenceSequence\":\"{sequence}\"}}"));
                let bytes = encoded.len();
                if !peer.send_text(encoded) {
                    state.pending.remove(&id);
                    self.finish_as(
                        &pending,
                        Err(CommandError::command(
                            format!("Worker command {kind} could not be dispatched."),
                            "worker-command-dispatch-failed",
                            &id,
                        )),
                        Some(FinishLog::Dispatch),
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
                            bridge.finish_as(&target, Err(error), Some(FinishLog::EventHandler));
                            break;
                        }
                    }
                    Delivery::Response(result) => {
                        bridge.finish_as(&target, result, Some(FinishLog::Response));
                        break;
                    }
                }
            }
        });
        rx.await
            .unwrap_or_else(|_| Err(CommandError::unavailable("Server is shutting down.".into())))
    }
    /// Fastify's preClose queues empty CLOSE frames without terminating bridge
    /// state. Responses already in flight remain valid until the peer closes.
    pub fn pre_close(&self) {
        let _lifecycle = self.lifecycle.lock();
        for peer in self.state.lock().unwrap().peers.values() {
            peer.close_empty();
        }
    }
    pub fn close(&self) {
        let _lifecycle = self.lifecycle.lock();
        let counts = {
            let state = self.state.lock().unwrap();
            (state.peers.len(), state.pending.len())
        };
        self.shutdown_log(Some(counts));
        self.closed.store(true, Ordering::Release);
        let workers = {
            let state = self.state.lock().unwrap();
            state
                .peers
                .keys()
                .chain(state.interruptions.keys())
                .chain(state.identities.keys())
                .cloned()
                .collect::<IndexSet<_>>()
        };
        for worker in workers {
            let ended = self.terminate(
                &mut self.state.lock().unwrap(),
                &worker,
                CommandError::unavailable("Server is shutting down.".into()),
            );
            self.finish_termination(&worker, ended, Some((1001, "Server shutting down")));
        }
        self.notifications.clear();
        self.frames.clear();
        self.tunnel_frames.clear();
        self.surface_frames.clear();
        self.disconnected.clear();
        self.offline.clear();
        self.shutdown_log(None);
    }
}
