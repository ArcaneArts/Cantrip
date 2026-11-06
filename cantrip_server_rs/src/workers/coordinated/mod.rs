//! The shared bridge owns remote routing, while the local bridge continues to
//! own socket correlation, ordered worker events and reconnect grace.
mod attachment;
mod data;
mod receive;
mod requests;
use super::{
    bridge::{self, BridgeStats, CommandError, Continuity, EventHandler, Peer, WorkerBridge},
    command_deadline::CommandDeadline,
    frames::Frames,
    notifications::Notifications,
    offline::OfflineListeners,
};
use crate::{
    coordination::RelayCoordinator,
    operations::logging::{LogCall, Logger},
    wire::{self, Value, value::json},
};
use anyhow::Result;
use futures::{FutureExt, future::BoxFuture};
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::AbortHandle,
};
use uuid::Uuid;
pub type OwnerResolver =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Option<String>>> + Send + Sync>;
pub type InferenceObserver = Arc<dyn Fn(Value) + Send + Sync>;
pub struct Options {
    pub coordinator: Arc<dyn RelayCoordinator>,
    pub resolve_owner: OwnerResolver,
    pub reconnect_grace: Duration,
    pub logger: Logger,
    pub usage: Option<crate::live::UsageRecorder>,
}
impl Options {
    pub fn new(coordinator: Arc<dyn RelayCoordinator>, resolve_owner: OwnerResolver) -> Self {
        Self {
            coordinator,
            resolve_owner,
            reconnect_grace: Duration::from_secs(15),
            logger: crate::operations::logging::server_logger(),
            usage: None,
        }
    }
}
#[derive(Clone)]
pub struct RequestOptions {
    pub owner: Option<String>,
    pub timeout: Option<Duration>,
    pub on_event: Option<EventHandler>,
    pub on_inference: Option<InferenceObserver>,
    pub forward_inference: bool,
}
impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            owner: None,
            timeout: Some(Duration::from_secs(600)),
            on_event: None,
            on_inference: None,
            forward_inference: false,
        }
    }
}
struct Subscriptions {
    _disconnect: bridge::OfflineSubscription,
    _offline: bridge::OfflineSubscription,
    _notification: bridge::NotificationSubscription,
    _link: bridge::FrameSubscription,
    _tunnel: bridge::TunnelFrameSubscription,
    _surface: bridge::SurfaceFrameSubscription,
}
struct Connection {
    id: String,
    owner: String,
    continuity: Option<Continuity>,
    subscriptions: Mutex<Option<Subscriptions>>,
}
struct FrameRoute<'a> {
    owner: &'a str,
    worker: &'a str,
}
enum Delivery {
    Event(Value),
    Response(Value),
    Finished,
}
type Outcome = std::result::Result<Option<Value>, CommandError>;
struct Pending {
    instance: String,
    worker: String,
    command: String,
    started: f64,
    delivery: mpsc::UnboundedSender<Delivery>,
    completion: Mutex<Option<oneshot::Sender<Outcome>>>,
    timer: Mutex<Option<AbortHandle>>,
    deadline: Mutex<CommandDeadline>,
    changed: watch::Sender<()>,
    options: RequestOptions,
}
impl Pending {
    fn stop_timer(&self) {
        if let Some(timer) = self.timer.lock().unwrap().take() {
            timer.abort();
        }
    }
}
#[derive(Default)]
struct State {
    closed: bool,
    connections: IndexMap<String, Arc<Connection>>,
    attachments: HashMap<String, Uuid>,
    known: IndexMap<String, String>,
    pending: IndexMap<String, Arc<Pending>>,
    failed: u64,
    routed: u64,
    succeeded: u64,
    incoming: usize,
    outbound: usize,
}
pub struct CoordinatedBridge {
    coordinator: Arc<dyn RelayCoordinator>,
    pub local: Arc<WorkerBridge>,
    resolve_owner: OwnerResolver,
    logger: Logger,
    state: Mutex<State>,
    coordination_listener: Mutex<Option<u64>>,
    timer: Mutex<Option<AbortHandle>>,
    disconnected: Arc<OfflineListeners>,
    offline: Arc<OfflineListeners>,
    notifications: Arc<Notifications>,
    link: Arc<Frames>,
    tunnel: Arc<Frames<crate::tunnels::frame::Frame>>,
    surface: Arc<Frames<crate::remote_surfaces::frame::Frame>>,
}
fn now() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}
fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
fn run(future: impl std::future::Future<Output = ()> + Send + 'static) {
    let mut f = Box::pin(future);
    if f.as_mut().now_or_never().is_none() {
        tokio::spawn(f);
    }
}
fn own<F>(future: F) -> BoxFuture<'static, Outcome>
where
    F: std::future::Future<Output = Outcome> + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    let mut future = Box::pin(async move {
        let _ = tx.send(future.await);
    });
    if future.as_mut().now_or_never().is_none() {
        tokio::spawn(future);
    }
    Box::pin(async move {
        rx.await
            .unwrap_or_else(|_| Err(CommandError::unavailable("Server is shutting down.".into())))
    })
}
impl CoordinatedBridge {
    pub fn new(options: Options) -> Arc<Self> {
        let local = WorkerBridge::with_usage_and_logger(
            options.reconnect_grace,
            options.usage,
            options.logger.clone(),
        );
        let bridge = Arc::new(Self {
            coordinator: options.coordinator,
            local,
            resolve_owner: options.resolve_owner,
            logger: options.logger,
            state: Mutex::default(),
            coordination_listener: Mutex::new(None),
            timer: Mutex::new(None),
            disconnected: Arc::default(),
            offline: Arc::default(),
            notifications: Arc::default(),
            link: Arc::default(),
            tunnel: Arc::default(),
            surface: Arc::default(),
        });
        let weak = Arc::downgrade(&bridge);
        let id = bridge.coordinator.subscribe(Arc::new(move |message| {
            let weak = weak.clone();
            Box::pin(async move {
                if let Some(bridge) = weak.upgrade() {
                    bridge.receive(message).await?;
                }
                Ok(())
            })
        }));
        *bridge.coordination_listener.lock().unwrap() = Some(id);
        let weak = Arc::downgrade(&bridge);
        let interval = Duration::from_millis((bridge.coordinator.presence_ttl_ms() / 3).max(1000));
        let timer = tokio::spawn(async move {
            let mut timer =
                tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                let Some(bridge) = weak.upgrade() else {
                    return;
                };
                run(async move {
                    bridge.refresh_presence().await;
                });
            }
        });
        *bridge.timer.lock().unwrap() = Some(timer.abort_handle());
        bridge
    }
    fn log(
        &self,
        level: &'static str,
        message: &'static str,
        event: &str,
        operation: &str,
        status: &str,
        extra: Value,
    ) {
        let mut context = json!({"event":event,"subsystem":"relay-coordination","operation":operation,"status":status});
        if let (Value::Object(out), Value::Object(extra)) = (&mut context, &extra) {
            out.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
        (self.logger)(LogCall::event(level, message, context));
    }
    fn repeat(&self, key: String, level: &'static str, message: &'static str, context: Value) {
        (self.logger)(LogCall::repeated(key.into(), level, message, context, None));
    }
    pub fn stats(&self) -> BridgeStats {
        let state = self.state.lock().unwrap();
        BridgeStats {
            active_requests: state.pending.len() + self.local.stats().active_requests,
            connected_workers: self.coordinator.stats()["cachedWorkers"]
                .as_u64()
                .unwrap_or(0) as usize,
            failed_requests: state.failed,
            routed_requests: state.routed,
            succeeded_requests: state.succeeded,
        }
    }
    pub fn is_connected(&self, worker: &str) -> bool {
        if self.state.lock().unwrap().connections.contains_key(worker) {
            return self.local.is_connected(worker);
        }
        let Some(p) = self.coordinator.cached_worker(&worker.into()) else {
            return false;
        };
        if let Some(id) = text(&p["connectionId"]) {
            self.state.lock().unwrap().known.insert(worker.into(), id);
        }
        true
    }
    pub fn connection_identity(&self, worker: &str) -> Option<Continuity> {
        if self.state.lock().unwrap().connections.contains_key(worker) {
            return self.local.connection_identity(worker);
        }
        let p = self.coordinator.cached_worker(&worker.into())?;
        let c = &p["continuityIdentity"];
        Some(Continuity {
            owner: text(&c["ownerId"])?,
            credential: text(&c["credentialId"])?,
            process_generation: text(&c["workerProcessGeneration"])?,
        })
    }
    pub fn subscribe_worker_disconnect(
        &self,
        worker: &str,
        listener: bridge::OfflineHandler,
    ) -> bridge::OfflineSubscription {
        self.disconnected.subscribe(worker, listener)
    }
    pub fn subscribe_worker_offline(
        &self,
        worker: &str,
        listener: bridge::OfflineHandler,
    ) -> bridge::OfflineSubscription {
        self.offline.subscribe(worker, listener)
    }
    pub fn subscribe_notifications(
        &self,
        worker: &str,
        listener: bridge::NotificationHandler,
    ) -> bridge::NotificationSubscription {
        self.notifications.subscribe(worker, listener)
    }
    pub fn subscribe_owned_notifications(
        &self,
        worker: &str,
        listener: bridge::OwnedNotificationHandler,
    ) -> bridge::NotificationSubscription {
        self.notifications.subscribe_owned(worker, listener)
    }
    pub fn subscribe_worker_link_frames(
        &self,
        worker: &str,
        listener: bridge::FrameHandler,
    ) -> bridge::FrameSubscription {
        self.link.subscribe(worker, listener)
    }
    pub fn subscribe_tunnel_frames(
        &self,
        worker: &str,
        listener: bridge::TunnelFrameHandler,
    ) -> bridge::TunnelFrameSubscription {
        self.tunnel.subscribe(worker, listener)
    }
    pub fn subscribe_surface_frames(
        &self,
        worker: &str,
        listener: bridge::SurfaceFrameHandler,
    ) -> bridge::SurfaceFrameSubscription {
        self.surface.subscribe(worker, listener)
    }
    fn current(&self, worker: &str, generation: Uuid) -> bool {
        let state = self.state.lock().unwrap();
        !state.closed && state.attachments.get(worker) == Some(&generation)
    }
    fn same_connection(&self, worker: &str, connection: &Arc<Connection>) -> bool {
        self.state
            .lock()
            .unwrap()
            .connections
            .get(worker)
            .is_some_and(|c| Arc::ptr_eq(c, connection))
    }
    fn dispatch_offline(&self, worker: &str) {
        self.reject_remote(worker, None);
        self.offline.deliver(worker);
    }
    fn reject_remote(&self, worker: &str, retained: Option<&str>) {
        let pending = {
            let mut state = self.state.lock().unwrap();
            let ids = state
                .pending
                .iter()
                .filter(|(_, p)| p.worker == worker && Some(p.instance.as_str()) != retained)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| state.pending.shift_remove(&id))
                .collect::<Vec<_>>()
        };
        for p in pending {
            p.stop_timer();
            self.complete(
                &p,
                Err(CommandError::unavailable(format!(
                    "Worker {worker} is unavailable."
                ))),
            );
        }
    }
    fn complete(&self, pending: &Pending, result: Outcome) {
        let Some(tx) = pending.completion.lock().unwrap().take() else {
            return;
        };
        let mut state = self.state.lock().unwrap();
        if result.is_ok() {
            state.succeeded += 1;
        } else {
            state.failed += 1;
        }
        drop(state);
        let _ = tx.send(result);
        let _ = pending.delivery.send(Delivery::Finished);
    }
    fn publish_bounded(self: &Arc<Self>, payload: Value) -> bool {
        {
            let mut state = self.state.lock().unwrap();
            if state.outbound >= 512 {
                return false;
            }
            state.outbound += 1;
        }
        let this = self.clone();
        let mut future = Box::pin(async move {
            let _ = this.coordinator.publish(payload, None).await;
            this.state.lock().unwrap().outbound -= 1;
        });
        if future.as_mut().now_or_never().is_none() {
            tokio::spawn(future);
        }
        true
    }
    pub async fn close(&self) {
        let (connections, counts) = {
            let mut s = self.state.lock().unwrap();
            if s.closed {
                return;
            }
            s.closed = true;
            let counts =
                json!({"localWorkers":s.connections.len(),"pendingRequests":s.pending.len()});
            s.attachments.clear();
            s.known.clear();
            (std::mem::take(&mut s.connections), counts)
        };
        self.log(
            "info",
            "Coordinated worker bridge shutdown began",
            "coordination.bridge.shutdown-started",
            "close",
            "stopping",
            json!({"counts":counts}),
        );
        let started = now();
        if let Some(timer) = self.timer.lock().unwrap().take() {
            timer.abort();
        }
        if let Some(id) = self.coordination_listener.lock().unwrap().take() {
            self.coordinator.unsubscribe(id);
        }
        for c in connections.values() {
            c.subscriptions.lock().unwrap().take();
        }
        self.local.close();
        let pending = std::mem::take(&mut self.state.lock().unwrap().pending);
        // Source shutdown rejects without changing command success/failure counters.
        for p in pending.values() {
            p.stop_timer();
            if let Some(tx) = p.completion.lock().unwrap().take() {
                let _ = tx.send(Err(CommandError::unavailable(
                    "Server is shutting down.".into(),
                )));
            }
            let _ = p.delivery.send(Delivery::Finished);
        }
        self.disconnected.clear();
        self.offline.clear();
        self.notifications.clear();
        self.link.clear();
        self.tunnel.clear();
        self.surface.clear();
        futures::future::join_all(connections.iter().map(|(w, c)| async move {
            self.coordinator
                .release_worker(&w.clone().into(), &c.id.clone().into())
                .await
        }))
        .await;
        self.log(
            "info",
            "Coordinated worker bridge stopped",
            "coordination.bridge.shutdown-completed",
            "close",
            "stopped",
            json!({"durationMs":now()-started}),
        );
    }
}
impl Drop for CoordinatedBridge {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.get_mut().unwrap().take() {
            timer.abort();
        }
        if let Some(id) = self.coordination_listener.get_mut().unwrap().take() {
            self.coordinator.unsubscribe(id);
        }
    }
}
impl super::command_bus::CommandDelegate for CoordinatedBridge {
    fn stats(&self) -> BridgeStats {
        CoordinatedBridge::stats(self)
    }
    fn is_connected(&self, worker: &str) -> bool {
        CoordinatedBridge::is_connected(self, worker)
    }
    fn connection_identity(&self, worker: &str) -> Option<Continuity> {
        CoordinatedBridge::connection_identity(self, worker)
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
    ) -> BoxFuture<'static, Outcome> {
        CoordinatedBridge::request(
            &self,
            &worker,
            command,
            RequestOptions {
                owner: Some(owner),
                timeout,
                on_event,
                forward_inference: true,
                ..Default::default()
            },
        )
    }
}
