//! Leased worker log transport: notifications may precede its start ACK.
use super::{
    account,
    middleware::{self, Context},
    websocket::{self, WebSocket},
};
use crate::{
    auth::service::AuthService,
    live::{self, Socket as _, TransportLifetime},
    wire::{Value, value::json},
    workers::{
        bridge::{NotificationSubscription, OfflineSubscription},
        output::{Buffered, Queued, framed_size},
    },
};
use anyhow::{Result, bail};
use axum::{
    Extension,
    extract::{Path, Request, State},
    response::Response,
};
use futures::{SinkExt, StreamExt};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::AbortHandle,
    time::MissedTickBehavior,
};
use tungstenite::{Message, protocol::CloseFrame};

const LEASE_MS: u64 = 120_000;
const RENEW_MS: u64 = 60_000;
const HEARTBEAT_MS: u64 = 25_000;
const MAX_BUFFERED: usize = 1024 * 1024;

enum Outgoing {
    Text(Queued<String>),
    Ping,
    Flush,
    Close(u16, String),
    Terminate,
}
struct Peer {
    open: AtomicBool,
    buffered: Buffered,
    queue: Mutex<mpsc::UnboundedSender<Outgoing>>,
    deadline: watch::Sender<Option<tokio::time::Instant>>,
    forced: Arc<AtomicBool>,
}
impl live::Socket for Peer {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.bytes()
    }
    fn send(&self, text: Arc<str>) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if !self.is_open() {
            bail!("Worker log socket is closed");
        }
        queue.send(Outgoing::Text(
            self.buffered
                .reserve(text.to_string(), framed_size(text.len())),
        ))?;
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        let queue = self.queue.lock().unwrap();
        if self.open.swap(false, Ordering::AcqRel) {
            self.deadline
                .send_replace(Some(tokio::time::Instant::now() + Duration::from_secs(30)));
            let _ = queue.send(Outgoing::Close(code, reason.into()));
        }
    }
}
impl Peer {
    fn terminate(&self) {
        self.open.store(false, Ordering::Release);
        self.forced.store(true, Ordering::Release);
        let _ = self.queue.lock().unwrap().send(Outgoing::Terminate);
    }
}
#[derive(Default)]
struct StateData {
    closed: bool,
    started: bool,
    heartbeat: Option<AbortHandle>,
    renew: Option<AbortHandle>,
    notifications: Option<NotificationSubscription>,
    disconnect: Option<OfflineSubscription>,
}
struct LogStream {
    service: Arc<AuthService>,
    peer: Arc<Peer>,
    owner: String,
    worker: String,
    subscription: String,
    query: Value,
    state: Mutex<StateData>,
}
impl LogStream {
    fn send(self: &Arc<Self>, message: Value) -> Result<bool> {
        if !self.peer.is_open() {
            return Ok(false);
        }
        if self.peer.buffered_amount() > MAX_BUFFERED {
            self.peer
                .close(1013, "Worker log stream consumer is too slow");
            self.cleanup();
            return Ok(false);
        }
        let encoded =
            crate::settings::parse_response("workerLogStreamServerMessageSchema", Some(&message))?
                .stringify();
        self.peer.send(Arc::from(encoded.as_str()))?;
        self.service.usage.record(
            &self.owner,
            "worker-log-stream",
            false,
            encoded.len(),
            1,
            true,
        );
        Ok(true)
    }
    fn stop_worker(self: &Arc<Self>) {
        let stream = self.clone();
        self.service.worker_maintenance.spawn_child(async move {
            let _ = stream.service.workers.commands.request(&stream.worker, json!({"type":"diagnostics.logs.stream.stop","subscriptionId":stream.subscription}), Some(Duration::from_secs(5)), None).await;
            Ok(())
        });
    }
    fn cleanup(self: &Arc<Self>) {
        let (heartbeat, renew, notifications, disconnect, started) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            let started = std::mem::replace(&mut state.started, false);
            (
                state.heartbeat.take(),
                state.renew.take(),
                state.notifications.take(),
                state.disconnect.take(),
                started,
            )
        };
        if let Some(timer) = heartbeat {
            timer.abort();
        }
        if let Some(timer) = renew {
            timer.abort();
        }
        drop(notifications);
        drop(disconnect);
        if started {
            self.stop_worker();
        }
    }
    fn fail_start(self: &Arc<Self>) {
        let _ = self.send(json!({"type":"error","code":"stream-unavailable","message":"Worker log stream could not start.","retryable":true}));
        self.peer.close(1013, "Worker log stream could not start");
        self.cleanup();
    }
    fn notify(self: &Arc<Self>, value: &Value) -> Result<()> {
        if value["type"] == "diagnostics.logs.observed"
            && value["subscriptionId"] == self.subscription
        {
            // The bridge has validated this notification. Reuse its values;
            // send still validates the complete outgoing stream message.
            self.send(Value::object([
                ("type", Value::String("batch".into())),
                ("records", value["records"].clone()),
                ("nextCursor", value["nextCursor"].clone()),
                ("oldestCursor", value["oldestCursor"].clone()),
                ("latestCursor", value["latestCursor"].clone()),
                ("truncated", value["truncated"].clone()),
            ]))?;
        }
        Ok(())
    }
    fn install(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let heartbeat = tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_millis(HEARTBEAT_MS),
                Duration::from_millis(HEARTBEAT_MS),
            );
            timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                let Some(stream) = weak.upgrade() else {
                    break;
                };
                if stream.peer.is_open() {
                    let _ = stream.peer.queue.lock().unwrap().send(Outgoing::Ping);
                }
            }
        });
        let weak = Arc::downgrade(self);
        let disconnect = self.service.workers.bridge.subscribe_worker_disconnect(&self.worker, Arc::new(move || {
            if let Some(stream) = weak.upgrade() {
                let _ = stream.send(json!({"type":"error","code":"worker-offline","message":"Worker disconnected.","retryable":true}));
                stream.peer.close(1013, "Worker disconnected");
                stream.cleanup();
            }
        }));
        let weak = Arc::downgrade(self);
        let notifications = self.service.workers.bridge.subscribe_notifications(
            &self.worker,
            Arc::new(move |value| {
                let stream = weak.upgrade();
                Box::pin(async move {
                    if let Some(stream) = stream {
                        stream.notify(&value)?;
                    }
                    Ok(())
                })
            }),
        );
        let mut state = self.state.lock().unwrap();
        if state.closed {
            heartbeat.abort();
        } else {
            state.heartbeat = Some(heartbeat.abort_handle());
            state.notifications = Some(notifications);
            state.disconnect = Some(disconnect);
        }
    }
    async fn start(self: Arc<Self>) -> Result<()> {
        let worker = match self
            .service
            .workers
            .repository
            .get_worker(&self.owner, &self.worker)
            .await
        {
            Ok(worker) => worker,
            Err(_) => {
                self.peer.terminate();
                self.cleanup();
                return Ok(());
            }
        };
        if worker.is_none() {
            self.peer.close(1008, "Worker log stream is not authorized");
            return Ok(());
        }
        if !self.service.workers.commands.is_connected(&self.worker) {
            self.peer.close(1013, "Worker is offline");
            return Ok(());
        }
        if self.state.lock().unwrap().closed {
            return Ok(());
        }
        self.install();
        let ack: Result<()> = async {
            let value = self.service.workers.commands.request(&self.worker, json!({"type":"diagnostics.logs.stream.start","subscriptionId":self.subscription,"afterCursor":self.query["afterCursor"],"minimumLevel":self.query["minimumLevel"],"leaseMs":LEASE_MS}), Some(Duration::from_secs(5)), None).await?;
            crate::settings::parse_response("workerLogStreamStartResultSchema",value.as_ref())?;
            Ok(())
        }.await;
        if ack.is_err() {
            self.fail_start();
            return Ok(());
        }
        let closed = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                true
            } else {
                state.started = true;
                false
            }
        };
        if closed {
            self.stop_worker();
            return Ok(());
        }
        if self.send(json!({"type":"ready","subscriptionId":self.subscription,"nextCursor":self.query["afterCursor"]})).is_err() { self.fail_start(); return Ok(()); }
        let weak = Arc::downgrade(&self);
        let timer = tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_millis(RENEW_MS),
                Duration::from_millis(RENEW_MS),
            );
            timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                let Some(stream) = weak.upgrade() else {
                    break;
                };
                let result: Result<()> = async {
                    let value = stream.service.workers.commands.request(&stream.worker,json!({"type":"diagnostics.logs.stream.renew","subscriptionId":stream.subscription,"leaseMs":LEASE_MS}),Some(Duration::from_secs(5)),None).await?;
                    crate::settings::parse_response("workerLogStreamRenewResultSchema",value.as_ref())?;
                    Ok(())
                }.await;
                if result.is_err() {
                    if stream.peer.is_open() {
                        stream.peer.close(1013, "Worker log stream lease was lost");
                    }
                    stream.cleanup();
                    break;
                }
            }
        });
        let mut state = self.state.lock().unwrap();
        if state.closed {
            timer.abort();
        } else {
            state.renew = Some(timer.abort_handle());
        }
        Ok(())
    }
}
pub(super) async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(worker): Path<String>,
    request: Request,
) -> Response {
    let origin = middleware::value(request.headers(), "origin");
    let query = account::query(request.uri());
    let lifetime = service.live.transports.begin();
    websocket::upgrade(
        request,
        service.config.websocket_max_payload_bytes as usize,
        move |socket, _| run(socket, service, ctx, origin, query, worker, lifetime),
    )
}
async fn run(
    mut socket: WebSocket,
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    origin: Option<String>,
    raw_query: Value,
    worker: String,
    lifetime: TransportLifetime,
) {
    let (send, mut outgoing) = mpsc::unbounded_channel();
    let deadline = socket.close_deadline_signal();
    let mut closing = deadline.subscribe();
    let forced = socket.force_close_signal();
    let peer = Arc::new(Peer {
        open: AtomicBool::new(true),
        buffered: Buffered::default(),
        queue: Mutex::new(send),
        deadline,
        forced: forced.clone(),
    });
    lifetime.attach(peer.clone());
    let mut registration = None;
    let mut stream = None;
    if !origin.is_some_and(|value| service.config.app_origins.contains(&value)) {
        peer.close(1008, "Origin is not allowed");
    } else if let Some(user) = ctx.principal.user.as_ref() {
        registration = service.live.sessions.register(
            peer.clone(),
            &user.id,
            ctx.principal.session_id.as_deref(),
        );
        if registration.is_some() {
            let query = Value::object(
                ["afterCursor", "minimumLevel"]
                    .into_iter()
                    .filter_map(|key| raw_query.get(key).map(|value| (key, value.clone()))),
            );
            match crate::wire::parse("workerLogReadQuerySchema", Some(&query)) {
                Ok(query) => {
                    stream = Some(Arc::new(LogStream {
                        service: service.clone(),
                        peer: peer.clone(),
                        owner: user.id.clone(),
                        worker,
                        subscription: uuid::Uuid::new_v4().to_string(),
                        query,
                        state: Mutex::new(StateData::default()),
                    }));
                }
                Err(_) => peer.close(1008, "Invalid worker log stream request"),
            }
        }
    } else {
        peer.close(1008, "Authentication is required");
    }
    let retained = stream.clone();
    let retained_peer = peer.clone();
    socket.on_closed(move || {
        retained_peer.open.store(false, Ordering::Release);
        if let Some(stream) = retained {
            stream.cleanup();
        }
        drop(registration);
        drop(lifetime);
    });
    if let Some(stream) = stream {
        service.worker_maintenance.spawn_child(stream.start());
    }
    let (mut output, mut input) = socket.split();
    let reader = async {
        while let Some(message) = input.next().await {
            match message {
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(_)) => {
                    let _ = peer.queue.lock().unwrap().send(Outgoing::Flush);
                }
                Ok(_) => {}
                Err(cause) => {
                    let code = match cause {
                        tungstenite::Error::Utf8(..) => Some(1007),
                        tungstenite::Error::Capacity(..) => Some(1009),
                        tungstenite::Error::Protocol(..) => Some(1002),
                        _ => None,
                    };
                    if let Some(code) = code {
                        peer.close(code, "");
                        futures::future::pending::<()>().await;
                    }
                    break;
                }
            }
        }
    };
    let writer = async {
        while let Some(message) = outgoing.recv().await {
            let result = match message {
                Outgoing::Text(mut text) => output.send(Message::Text(text.take().into())).await,
                Outgoing::Ping => output.send(Message::Ping(Default::default())).await,
                Outgoing::Flush => output.flush().await,
                Outgoing::Terminate => break,
                Outgoing::Close(code, reason) => {
                    let _ = output
                        .send(Message::Close((code != 1005).then_some(CloseFrame {
                            code: code.into(),
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            };
            if result.is_err() {
                break;
            }
        }
    };
    let expiration = async {
        loop {
            let at = *closing.borrow_and_update();
            if let Some(at) = at {
                tokio::time::sleep_until(at).await;
                break;
            }
            if closing.changed().await.is_err() {
                break;
            }
        }
    };
    tokio::select! { _=reader=>{},_=writer=>{},_=expiration=>{forced.store(true,Ordering::Release);} }
    peer.open.store(false, Ordering::Release);
}
