//! Owner-scoped admission around the worker transport. Admitted work owns its
//! lifetime, including when its HTTP caller stops awaiting the result.
use super::{
    bridge::{BridgeStats, CommandError, Continuity, EventHandler, WorkerBridge},
    limits::{ActiveLimit, SlidingWindow},
    repository::WorkerRepository,
};
use crate::{
    config::ServerConfig,
    database::Database,
    relay::{RelayLimitError, RelayQuotas},
    wire::{JsString, Value},
};
use futures::{FutureExt, future::BoxFuture};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

pub type InferenceTimingObserver = Arc<dyn Fn(Value) + Send + Sync>;

pub type CommandOutcome = Result<Option<Value>, CommandError>;
pub trait CommandDelegate: Send + Sync {
    fn stats(&self) -> BridgeStats;
    fn is_connected(&self, worker: &str) -> bool;
    fn connection_identity(&self, _worker: &str) -> Option<Continuity> {
        None
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome>;
}
impl CommandDelegate for WorkerBridge {
    fn connection_identity(&self, worker: &str) -> Option<Continuity> {
        WorkerBridge::connection_identity(self, worker)
    }
    fn is_connected(&self, worker: &str) -> bool {
        WorkerBridge::is_connected(self, worker)
    }
    fn stats(&self) -> BridgeStats {
        WorkerBridge::stats(self)
    }
    fn request(
        self: Arc<Self>,
        _owner: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        Box::pin(
            async move { WorkerBridge::request(&self, &worker, command, timeout, on_event).await },
        )
    }
}
pub type OwnerResolver =
    Arc<dyn Fn(Value) -> BoxFuture<'static, anyhow::Result<Option<String>>> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
#[derive(Clone, Copy)]
pub enum RequestTimeout {
    Default,
    Disabled,
    After(Duration),
}
impl RequestTimeout {
    fn duration(self) -> Option<Duration> {
        match self {
            Self::Default => Some(Duration::from_secs(600)),
            Self::Disabled => None,
            Self::After(duration) => Some(duration),
        }
    }
}
#[derive(Clone)]
pub struct CommandLimits {
    pub account_concurrency: usize,
    pub account_rate_per_minute: usize,
    pub worker_concurrency: usize,
    pub worker_rate_per_minute: usize,
}
#[derive(Debug)]
pub enum CommandFailure {
    Limit(RelayLimitError),
    Bridge(CommandError),
    Owner(anyhow::Error),
}
impl CommandFailure {
    pub fn message(&self) -> JsString {
        match self {
            Self::Limit(error) => error.message.into(),
            Self::Bridge(error) => error.message.clone(),
            Self::Owner(error) => error
                .downcast_ref::<WorkerOwnerError>()
                .map(|error| error.0.clone())
                .or_else(|| {
                    error
                        .downcast_ref::<crate::settings::SettingsQueryError>()
                        .map(|error| error.message.clone())
                })
                .unwrap_or_else(|| error.to_string().into()),
        }
    }
    pub fn status(&self, fallback: u16) -> u16 {
        match self {
            Self::Limit(_) => 429,
            Self::Bridge(error) if error.unavailable => 503,
            _ => fallback,
        }
    }
}
impl std::fmt::Display for CommandFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message().lossy())
    }
}
impl std::error::Error for CommandFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Limit(error) => error,
            Self::Bridge(error) => error,
            Self::Owner(error) => error.as_ref(),
        })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStats {
    pub active_requests: usize,
    pub connected_workers: usize,
    pub failed_requests: f64,
    pub routed_requests: f64,
    pub succeeded_requests: f64,
}
// Narrow transport headroom, not provider inference capacity. Keep this
// allowlist aligned with workers/limited-command-bus.ts; new input stays ordinary.
fn is_execution_control(command: &Value) -> bool {
    match command["type"].as_str() {
        Some("chat.runtime.handoff") => command["intent"] == "cancel",
        Some("chat.native-control") => matches!(
            command["control"]["kind"].as_str(),
            Some("interrupt" | "pause" | "reply")
        ),
        Some(
            "inference.status"
            | "inference.configure"
            | "inference.revoke"
            | "inference.task-revoke"
            | "worker.version"
            | "worker.restart"
            | "worker.credential.rotate"
            | "worker.encryption.refresh"
            | "chat.interrupt"
            | "chat.pause.set"
            | "chat.queue.changed"
            | "chat.settings.read"
            | "chat.queue.prepare"
            | "chat.automation.resume"
            | "chat.goal.recover"
            | "chat.goal.claim-recover"
            | "task.goal.recover"
            | "task.goal.source"
            | "agent.interaction.respond"
            | "agent.interaction.respond.protected"
            | "agent.interaction.cancel"
            | "chat.native-logical.cancel"
            | "chat.native-logical.complete"
            | "chat.goal.get"
            | "chat.goal.clear",
        ) => true,
        _ => false,
    }
}

struct CommandLane {
    account_active: ActiveLimit,
    worker_active: ActiveLimit,
    account_rate: SlidingWindow,
    worker_rate: SlidingWindow,
}
impl CommandLane {
    fn new(limits: &CommandLimits, control: bool) -> Self {
        Self {
            account_active: ActiveLimit::new(if control {
                limits.account_concurrency.min(8)
            } else {
                limits.account_concurrency
            }),
            worker_active: ActiveLimit::new(if control {
                limits.worker_concurrency.min(8)
            } else {
                limits.worker_concurrency
            }),
            account_rate: SlidingWindow::new(limits.account_rate_per_minute),
            worker_rate: SlidingWindow::new(limits.worker_rate_per_minute),
        }
    }
}

struct State {
    owners: HashMap<String, String>,
    lanes: [CommandLane; 2],
    failed: f64,
    routed: f64,
    succeeded: f64,
    active_requests: usize,
}
pub struct LimitedCommandBus {
    dispatch: Arc<tokio::sync::Mutex<()>>,
    delegate: Arc<dyn CommandDelegate>,
    pub quotas: Arc<RelayQuotas>,
    resolver: OwnerResolver,
    clock: Clock,
    state: Mutex<State>,
    tasks: AtomicUsize,
    drained: Notify,
}
struct ActiveRequest {
    admission: Arc<AdmissionPermit>,
}
struct AdmissionPermit {
    bus: Arc<LimitedCommandBus>,
    owner: String,
    worker: String,
    lane: usize,
    released: AtomicBool,
}
impl AdmissionPermit {
    fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut state = self.bus.state.lock().unwrap();
        let lane = &mut state.lanes[self.lane];
        lane.worker_active.release(&self.worker);
        lane.account_active.release(&self.owner);
    }
}
impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.admission.release();
        self.admission.bus.state.lock().unwrap().active_requests -= 1;
    }
}
struct RequestTask(Arc<LimitedCommandBus>);
struct WorkerKey {
    identity: String,
    display: JsString,
    value: Value,
}
#[derive(Debug)]
struct WorkerOwnerError(JsString);
impl std::fmt::Display for WorkerOwnerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0.lossy())
    }
}
impl std::error::Error for WorkerOwnerError {}
impl WorkerKey {
    fn new(value: Value) -> Result<Self, CommandFailure> {
        let display = crate::wire::coercion::string(&value).map_err(|_| {
            CommandFailure::Owner(anyhow::anyhow!("Cannot convert object to primitive value"))
        })?;
        // JavaScript Maps retain primitive identity and object reference
        // identity. A parsed array must never alias an enrolled string key,
        // even if the database serializes both keys to the same text.
        let identity = match &value {
            Value::String(_) => value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("\0string:{}", value.stringify())),
            Value::Array(_) | Value::Object(_) => format!("\0reference:{}", uuid::Uuid::new_v4()),
            _ => format!("\0primitive:{}", value.stringify()),
        };
        Ok(Self {
            identity,
            display,
            value,
        })
    }
    fn message(&self, suffix: &str) -> JsString {
        let mut units = "Worker ".encode_utf16().collect::<Vec<_>>();
        units.extend_from_slice(self.display.units());
        units.extend(suffix.encode_utf16());
        JsString::new(units)
    }
}
impl Drop for RequestTask {
    fn drop(&mut self) {
        if self.0.tasks.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
impl LimitedCommandBus {
    pub fn new(
        database: Arc<Database>,
        bridge: Arc<dyn CommandDelegate>,
        quotas: Arc<RelayQuotas>,
        config: &ServerConfig,
    ) -> Arc<Self> {
        let resolver: OwnerResolver = Arc::new(move |worker| {
            let database = database.clone();
            Box::pin(async move { WorkerRepository::new(database).owner_input(&worker).await })
        });
        Self::with_parts(
            bridge,
            quotas,
            CommandLimits {
                account_concurrency: config.account_command_concurrency as usize,
                account_rate_per_minute: config.account_command_rate_per_minute as usize,
                worker_concurrency: config.worker_command_concurrency as usize,
                worker_rate_per_minute: config.worker_command_rate_per_minute as usize,
            },
            resolver,
            Arc::new(|| crate::auth::now().timestamp_millis()),
        )
    }
    pub fn with_parts(
        delegate: Arc<dyn CommandDelegate>,
        quotas: Arc<RelayQuotas>,
        limits: CommandLimits,
        resolver: OwnerResolver,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(Self {
            dispatch: Arc::new(tokio::sync::Mutex::new(())),
            delegate,
            quotas,
            resolver,
            clock,
            state: Mutex::new(State {
                owners: HashMap::new(),
                lanes: [
                    CommandLane::new(&limits, false),
                    CommandLane::new(&limits, true),
                ],
                failed: 0.0,
                routed: 0.0,
                succeeded: 0.0,
                active_requests: 0,
            }),
            tasks: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }
    pub fn stats(&self) -> CommandStats {
        let state = self.state.lock().unwrap();
        CommandStats {
            active_requests: state.active_requests,
            connected_workers: self.delegate.stats().connected_workers,
            failed_requests: state.failed,
            routed_requests: state.routed,
            succeeded_requests: state.succeeded,
        }
    }
    pub fn is_connected(&self, worker: &str) -> bool {
        self.delegate.is_connected(worker)
    }
    pub fn connection_identity(&self, worker: &str) -> Option<Continuity> {
        self.delegate.connection_identity(worker)
    }
    fn log_limit(&self, worker: &Value, command: &Value, reason: &str) {
        eprintln!(
            "{}",
            serde_json::json!({"event":"worker.command.rate-limited","subsystem":"worker-command","operation":command["type"].as_str(),"reasonCode":reason,"status":"rejected","workerId":worker})
        );
    }
    async fn owner(&self, worker: &WorkerKey) -> Result<String, CommandFailure> {
        let cached = self
            .state
            .lock()
            .unwrap()
            .owners
            .get(&worker.identity)
            .cloned();
        if let Some(owner) = cached.filter(|owner| !owner.is_empty()) {
            return Ok(owner);
        }
        let owner = (self.resolver)(worker.value.clone())
            .await
            .map_err(CommandFailure::Owner)?
            .filter(|owner| !owner.is_empty())
            .ok_or_else(|| {
                CommandFailure::Owner(WorkerOwnerError(worker.message(" is not enrolled.")).into())
            })?;
        self.state
            .lock()
            .unwrap()
            .owners
            .insert(worker.identity.clone(), owner.clone());
        Ok(owner)
    }
    fn admit(
        self: &Arc<Self>,
        owner: &str,
        worker: &WorkerKey,
        command: &Value,
    ) -> Result<ActiveRequest, CommandFailure> {
        let mut state = self.state.lock().unwrap();
        let lane_index = usize::from(is_execution_control(command));
        let lane = &mut state.lanes[lane_index];
        let rejected = if !self.quotas.consume_relay_at(
            owner,
            &worker.identity,
            command.stringify().len() as u64,
            (self.clock)(),
        ) {
            Some((
                "relay-bandwidth-quota",
                RelayLimitError::new("Relay bandwidth quota reached. Retry later.", 1),
            ))
        } else {
            let account = lane
                .account_rate
                .consume(owner, (self.clock)())
                .unwrap_or(0);
            let worker_retry = lane
                .worker_rate
                .consume(&worker.identity, (self.clock)())
                .unwrap_or(0);
            let retry = account.max(worker_retry);
            if retry > 0 {
                Some((
                    "command-rate-limit",
                    RelayLimitError::new(
                        "Worker command rate limit reached. Retry shortly.",
                        retry,
                    ),
                ))
            } else if !lane.account_active.acquire(owner) {
                Some((
                    "account-concurrency-limit",
                    RelayLimitError::new("Account worker-command concurrency limit reached.", 1),
                ))
            } else if !lane.worker_active.acquire(&worker.identity) {
                lane.account_active.release(owner);
                Some((
                    "worker-concurrency-limit",
                    RelayLimitError::new("Worker command concurrency limit reached.", 1),
                ))
            } else {
                None
            }
        };
        if let Some((reason, error)) = rejected {
            state.failed += 1.0;
            drop(state);
            self.log_limit(&worker.value, command, reason);
            return Err(CommandFailure::Limit(error.before_dispatch()));
        }
        state.routed += 1.0;
        state.active_requests += 1;
        Ok(ActiveRequest {
            admission: Arc::new(AdmissionPermit {
                bus: self.clone(),
                owner: owner.into(),
                worker: worker.identity.clone(),
                lane: lane_index,
                released: AtomicBool::new(false),
            }),
        })
    }
    async fn run(
        self: &Arc<Self>,
        worker: WorkerKey,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
        inference_observer: Option<InferenceTimingObserver>,
        mut dispatch: tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<Option<Value>, CommandFailure> {
        let mut resolving = Box::pin(self.owner(&worker));
        let owner = if let Some(owner) = resolving.as_mut().now_or_never() {
            owner?
        } else {
            // Independent owner lookups complete independently in the source.
            drop(dispatch);
            let owner = resolving.await?;
            dispatch = self.dispatch.clone().lock_owned().await;
            owner
        };
        let permit = self.admit(&owner, &worker, &command)?;
        let event_limit = Arc::new(Mutex::new(None));
        let on_event = Some({
            let handler = on_event;
            let admission = permit.admission.clone();
            let quotas = self.quotas.clone();
            let clock = self.clock.clone();
            let owner = owner.clone();
            let worker = worker.identity.clone();
            let event_limit = event_limit.clone();
            Arc::new(move |event: Value| {
                let (quotas, clock, owner, worker, handler, event_limit, admission) = (
                    quotas.clone(),
                    clock.clone(),
                    owner.clone(),
                    worker.clone(),
                    handler.clone(),
                    event_limit.clone(),
                    admission.clone(),
                );
                let inference_observer = inference_observer.clone();
                Box::pin(async move {
                    if event["type"] == "inference.command-state"
                        && event["admitted"].as_bool() == Some(true)
                    {
                        admission.release();
                    }
                    if !quotas.consume_relay_at(
                        &owner,
                        &worker,
                        event.stringify().len() as u64,
                        clock(),
                    ) {
                        let limit =
                            RelayLimitError::new("Relay bandwidth quota reached. Retry later.", 1);
                        *event_limit.lock().unwrap() = Some(limit.clone());
                        return Err(CommandError {
                            message: limit.message.into(),
                            code: None,
                            unavailable: false,
                            request_id: None,
                            encoding_error: None,
                            inference: None,
                        });
                    }
                    if event["type"] == "inference.command-state"
                        && let Some(observer) = inference_observer
                    {
                        observer(event.clone());
                    }
                    // Private admission/clock events never enter domain streams.
                    if event["type"] != "inference.command-state"
                        && let Some(handler) = handler
                    {
                        handler(event).await?;
                    }
                    Ok(())
                }) as BoxFuture<'static, Result<(), CommandError>>
            }) as EventHandler
        });
        let delegated = if let Some(connected_key) = worker.value.as_str() {
            let mut request = self.delegate.clone().request(
                owner.clone(),
                connected_key.to_owned(),
                command,
                timeout,
                on_event,
            );
            let immediate = request.as_mut().now_or_never();
            // Serialize dispatch, never acknowledgment or streamed execution.
            drop(dispatch);
            match immediate {
                Some(result) => result,
                None => request.await,
            }
        } else {
            // The bridge's Map has no peer for a non-string key. Admission
            // and byte/rate accounting have already happened, as in Node.
            Err(CommandError {
                message: worker.message(" is offline."),
                code: None,
                unavailable: true,
                request_id: None,
                encoding_error: None,
                inference: None,
            })
        };
        let result = match delegated {
            Ok(value) => {
                if self.quotas.consume_relay_at(
                    &owner,
                    &worker.identity,
                    value
                        .as_ref()
                        .map_or(0, |value| value.stringify().len() as u64),
                    (self.clock)(),
                ) {
                    Ok(value)
                } else {
                    Err(CommandFailure::Limit(RelayLimitError::new(
                        "Relay bandwidth quota reached. Retry later.",
                        1,
                    )))
                }
            }
            Err(error) => {
                if let Some(limit) = event_limit.lock().unwrap().take() {
                    Err(CommandFailure::Limit(limit))
                } else {
                    Err(CommandFailure::Bridge(error))
                }
            }
        };
        {
            let mut state = self.state.lock().unwrap();
            if result.is_ok() {
                state.succeeded += 1.0;
            } else {
                state.failed += 1.0;
            }
        }
        drop(permit);
        result
    }
    pub async fn request(
        self: &Arc<Self>,
        worker: &str,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
    ) -> Result<Option<Value>, CommandFailure> {
        self.request_with_timeout(
            worker,
            command,
            timeout.map_or(RequestTimeout::Default, RequestTimeout::After),
            on_event,
        )
        .await
    }
    pub async fn request_with_timeout(
        self: &Arc<Self>,
        worker: &str,
        command: Value,
        timeout: RequestTimeout,
        on_event: Option<EventHandler>,
    ) -> Result<Option<Value>, CommandFailure> {
        self.request_for_key(
            WorkerKey::new(Value::String(worker.into()))?,
            command,
            timeout,
            on_event,
            None,
        )
        .await
    }
    pub async fn request_observing_inference(
        self: &Arc<Self>,
        worker: &str,
        command: Value,
        timeout: RequestTimeout,
        on_event: Option<EventHandler>,
        inference_observer: InferenceTimingObserver,
    ) -> Result<Option<Value>, CommandFailure> {
        self.request_for_key(
            WorkerKey::new(Value::String(worker.into()))?,
            command,
            timeout,
            on_event,
            Some(inference_observer),
        )
        .await
    }
    pub async fn request_key(
        self: &Arc<Self>,
        worker: Value,
        command: Value,
    ) -> Result<Option<Value>, CommandFailure> {
        self.request_for_key(
            WorkerKey::new(worker)?,
            command,
            RequestTimeout::Default,
            None,
            None,
        )
        .await
    }
    async fn request_for_key(
        self: &Arc<Self>,
        worker: WorkerKey,
        command: Value,
        timeout: RequestTimeout,
        on_event: Option<EventHandler>,
        inference_observer: Option<InferenceTimingObserver>,
    ) -> Result<Option<Value>, CommandFailure> {
        self.tasks.fetch_add(1, Ordering::AcqRel);
        let task = RequestTask(self.clone());
        // Reserve FIFO order in the caller, but execute transport in an owned
        // task: offline callbacks can hold the bridge lifecycle lock.
        let mut reservation = Box::pin(self.dispatch.clone().lock_owned());
        let reserved = reservation.as_mut().now_or_never();
        tokio::spawn(async move {
            let _task = task;
            let dispatch = match reserved {
                Some(guard) => guard,
                None => reservation.await,
            };
            _task
                .0
                .run(
                    worker,
                    command,
                    timeout.duration(),
                    on_event,
                    inference_observer,
                    dispatch,
                )
                .await
        })
        .await
        .map_err(|error| {
            CommandFailure::Owner(anyhow::anyhow!("Worker command task failed: {error}"))
        })?
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            if self.tasks.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}
