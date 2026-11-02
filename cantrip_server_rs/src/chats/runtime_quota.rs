//! Turn quota observations share the account writers and the worker command bus.
//! Timers are canceled on close; admitted requests retain ownership through commit.
use crate::{
    database::Database,
    operations::logging::{self, LogCall, Logger},
    settings::{quota::QuotaContext, repository::SettingsRepository},
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use futures::{FutureExt, future::BoxFuture};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot};

/// Credit updates must remain visible to account failover using the same route.
pub type Runtime = Arc<Mutex<Value>>;
pub type Publish = Arc<dyn Fn(Value) + Send + Sync>;
pub type Sleep = Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>;
pub struct Timing {
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub sleep: Sleep,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            now: Arc::new(|| crate::auth::now().timestamp_millis()),
            sleep: Arc::new(|delay| tokio::time::sleep(delay).boxed()),
        }
    }
}
#[derive(Clone)]
pub struct Execution {
    pub owner: String,
    pub worker: String,
    pub chat: Option<String>,
    pub attempt: String,
    pub turn: Option<String>,
}
struct Timer {
    _cancel: oneshot::Sender<()>,
    reset_key: Option<JsString>,
}
#[derive(Default)]
struct State {
    closing: bool,
    tasks: usize,
    requests: usize,
    timers: HashMap<uuid::Uuid, Timer>,
    reset_keys: HashSet<JsString>,
}
pub struct Service {
    repository: SettingsRepository,
    commands: Arc<LimitedCommandBus>,
    publish: Publish,
    logger: Logger,
    timing: Timing,
    state: Mutex<State>,
    changed: Notify,
}
struct Task {
    service: Arc<Service>,
    request: bool,
}
impl Drop for Task {
    fn drop(&mut self) {
        let mut state = self.service.state.lock().unwrap();
        state.tasks -= 1;
        if self.request {
            state.requests -= 1;
        }
        self.service.changed.notify_waiters();
    }
}
pub fn update_account_credits(runtime: &mut Value, credits: Option<&Value>) -> bool {
    let Some(credits) = credits.filter(|value| truthy(Some(value))) else {
        return false;
    };
    if runtime["provider"]["kind"] != "chatgpt" {
        return false;
    }
    let changed = ["balance", "hasCredits", "unlimited"]
        .into_iter()
        .any(|key| runtime["provider"]["credits"].get(key) != credits.get(key));
    runtime["provider"]["credits"] = credits.clone();
    changed
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        publish: Publish,
        logger: Logger,
    ) -> Arc<Self> {
        Self::with_timing(database, commands, publish, logger, Timing::default())
    }
    pub fn with_timing(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        publish: Publish,
        logger: Logger,
        timing: Timing,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: SettingsRepository::new(database),
            commands,
            publish,
            logger,
            timing,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        })
    }
    fn admit(self: &Arc<Self>) -> Option<Task> {
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return None;
        }
        state.tasks += 1;
        state.requests += 1;
        Some(Task {
            service: self.clone(),
            request: true,
        })
    }
    pub async fn record_activity(
        self: &Arc<Self>,
        runtime: Runtime,
        execution: Execution,
        activity: Value,
    ) {
        let provider = runtime.lock().unwrap()["provider"].clone();
        if !truthy(provider.get("accountId")) {
            return;
        }
        let Some(task) = self.admit() else {
            return;
        };
        let credits_changed = activity
            .get("limitId")
            .is_some_and(|value| value.is_null() || *value == "codex")
            && update_account_credits(&mut runtime.lock().unwrap(), activity.get("credits"));
        let (send, receive) = oneshot::channel();
        let service = self.clone();
        tokio::spawn(async move {
            let _task = task;
            let context = context(&execution, &provider, "live-rate-limit-update", &activity);
            let result = service
                .repository
                .persist_rate_limit_activity_at(&context, &activity, (service.timing.now)())
                .await;
            match result {
                Ok(_) if credits_changed => {
                    (service.publish)(json!({"ownerId":execution.owner,"resource":"settings"}));
                }
                Ok(_) => {}
                Err(error) => (service.logger)(LogCall::event(
                    "warn",
                    "Unable to persist provider quota observation",
                    json!({"accountId":provider["accountId"],"providerId":provider["id"],"err":logging::error_details(&error)}),
                )),
            }
            let _ = send.send(());
        });
        let _ = receive.await;
    }
    pub fn capture(self: &Arc<Self>, runtime: Runtime, execution: Execution, trigger: &str) {
        let provider = runtime.lock().unwrap()["provider"].clone();
        if !truthy(provider.get("accountId"))
            || !truthy(provider.get("credentialHomeKey"))
            || !matches!(provider["kind"].as_str(), Some("chatgpt" | "grok"))
        {
            return;
        }
        let Some(task) = self.admit() else {
            return;
        };
        let (service, trigger) = (self.clone(), trigger.to_owned());
        tokio::spawn(async move {
            let _task = task;
            let no_activity = Value::Null;
            let context = context(&execution, &provider, &trigger, &no_activity);
            match service
                .repository
                .read_and_persist_quota_snapshot(&context, &service.commands, &provider)
                .await
            {
                Ok((_, snapshot)) => {
                    if update_account_credits(&mut runtime.lock().unwrap(), snapshot.get("credits"))
                    {
                        (service.publish)(json!({"ownerId":execution.owner,"resource":"settings"}));
                    }
                    service.schedule_resets(runtime, execution, &snapshot);
                }
                Err(error) => (service.logger)(LogCall::event(
                    "debug",
                    "Provider quota sample unavailable",
                    json!({"err":logging::error_details(&error),"providerId":provider["id"],"providerAccountId":provider["accountId"],"trigger":trigger,"workerId":execution.worker}),
                )),
            }
        });
    }
    fn schedule_resets(self: &Arc<Self>, runtime: Runtime, execution: Execution, snapshot: &Value) {
        let account = runtime.lock().unwrap()["provider"]["accountId"].clone();
        if !truthy(Some(&account)) {
            return;
        }
        let now = (self.timing.now)() as f64;
        for window in snapshot["windows"]
            .as_array()
            .expect("validated quota windows")
        {
            let Some(reset) = window["resetsAt"].as_f64() else {
                continue;
            };
            for (phase, offset) in [("before", -5000.0), ("after", 2000.0)] {
                let delay = reset * 1000.0 + offset - now;
                if delay <= 0.0 || delay > 2_147_000_000.0 {
                    continue;
                }
                let key = logging::key(
                    "",
                    &[
                        &account,
                        window
                            .get("limitId")
                            .filter(|v| !v.is_null())
                            .unwrap_or(&json!("unknown")),
                        &window["windowKind"],
                        &window["resetsAt"],
                        &json!(phase),
                    ],
                );
                self.timer(
                    runtime.clone(),
                    execution.clone(),
                    &format!("reset-window-{phase}"),
                    delay,
                    Some(key),
                );
            }
        }
    }
    pub fn schedule_completed(self: &Arc<Self>, runtime: Runtime, execution: Execution) {
        self.capture(runtime.clone(), execution.clone(), "turn-completed");
        for delay in [5000, 15000, 45000] {
            self.timer(
                runtime.clone(),
                execution.clone(),
                &format!("turn-completed-plus-{}s", delay / 1000),
                delay as f64,
                None,
            );
        }
    }
    fn timer(
        self: &Arc<Self>,
        runtime: Runtime,
        execution: Execution,
        trigger: &str,
        delay: f64,
        reset_key: Option<JsString>,
    ) {
        let mut state = self.state.lock().unwrap();
        if state.closing
            || reset_key
                .as_ref()
                .is_some_and(|key| state.reset_keys.contains(key))
        {
            return;
        }
        if let Some(key) = &reset_key {
            state.reset_keys.insert(key.clone());
        }
        let (cancel, mut canceled) = oneshot::channel();
        let id = uuid::Uuid::new_v4();
        state.timers.insert(
            id,
            Timer {
                _cancel: cancel,
                reset_key,
            },
        );
        state.tasks += 1;
        let task = Task {
            service: self.clone(),
            request: false,
        };
        let sleep = (self.timing.sleep)(Duration::from_millis(delay.floor().max(1.0) as u64));
        drop(state);
        let (service, trigger) = (self.clone(), trigger.to_owned());
        tokio::spawn(async move {
            let _task = task;
            tokio::select! {
                _ = &mut canceled => {},
                _ = sleep => {
                    {
                        let mut state = service.state.lock().unwrap();
                        if let Some(timer) = state.timers.remove(&id)
                            && let Some(key) = timer.reset_key {
                                state.reset_keys.remove(&key);
                            }
                    }
                    service.capture(runtime, execution, &trigger);
                }
            }
        });
    }
    pub async fn drain_requests(&self) {
        self.drain(false).await;
    }
    async fn drain(&self, timers: bool) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.state.lock().unwrap();
                if (if timers { state.tasks } else { state.requests }) == 0 {
                    return;
                }
            }
            changed.await;
        }
    }
    pub async fn close(&self) {
        let timers = {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            state.reset_keys.clear();
            std::mem::take(&mut state.timers)
        };
        drop(timers);
        self.drain(true).await;
    }
}
fn context<'a>(
    execution: &'a Execution,
    provider: &'a Value,
    trigger: &'a str,
    activity: &'a Value,
) -> QuotaContext<'a> {
    QuotaContext {
        owner: &execution.owner,
        provider: provider["id"].as_str().unwrap_or(""),
        account: provider["accountId"].as_str().unwrap_or(""),
        worker: &execution.worker,
        account_plan_type: activity["planType"].as_str(),
        trigger,
        chat: execution.chat.as_deref(),
        turn: if trigger == "live-rate-limit-update" {
            activity["correlation"]["turnId"].as_str()
        } else {
            execution.turn.as_deref()
        },
        execution_attempt: Some(&execution.attempt),
    }
}
