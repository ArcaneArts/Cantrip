use anyhow::{Context, Result};
use cantrip_server::{
    chats::runtime_quota::{Execution, Service, Timing},
    database::Database,
    relay::RelayQuotas,
    wire::Value,
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::{FutureExt, future::BoxFuture};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, oneshot};
struct Timer {
    at: i64,
    fire: oneshot::Sender<()>,
    fired: oneshot::Receiver<()>,
}
struct Control {
    now: AtomicI64,
    timers: Mutex<Vec<Timer>>,
    commands: Mutex<Vec<Value>>,
    response: Mutex<Value>,
    failure: bool,
    blocked: Mutex<Option<oneshot::Receiver<()>>>,
    started: Notify,
}
impl CommandDelegate for Control {
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            active_requests: 0,
            connected_workers: 1,
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn is_connected(&self, _: &str) -> bool {
        true
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        async move {
            self.commands.lock().unwrap().push(Value::object([
                ("ownerId", Value::from_serialize(&owner)),
                ("worker", Value::from_serialize(&worker)),
                ("command", command),
                (
                    "atMs",
                    Value::from_serialize(&self.now.load(Ordering::SeqCst)),
                ),
                (
                    "timeoutMs",
                    Value::from_serialize(&timeout.map(|d| d.as_millis() as u64)),
                ),
            ]));
            self.started.notify_waiters();
            let blocked = self.blocked.lock().unwrap().take();
            if let Some(blocked) = blocked {
                let _ = blocked.await;
            }
            if self.failure {
                return Err(CommandError {
                    message: "Controlled quota failure".into(),
                    code: None,
                    unavailable: false,
                    encoding_error: None,
                    request_id: None,
                });
            }
            Ok(Some(self.response.lock().unwrap().clone()))
        }
        .boxed()
    }
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let (release, blocked) = oneshot::channel();
    let control = Arc::new(Control {
        now: AtomicI64::new(input["now"].as_i64().context("Quota fixture time")?),
        timers: Mutex::new(Vec::new()),
        commands: Mutex::new(Vec::new()),
        response: Mutex::new(input["snapshot"].clone()),
        failure: input["requestFailure"] == true,
        blocked: Mutex::new((input["closeWhilePending"] == true).then_some(blocked)),
        started: Notify::new(),
    });
    let owner = input["owner"]
        .as_str()
        .context("Quota fixture owner")?
        .to_owned();
    let principal = owner.clone();
    let commands = LimitedCommandBus::with_parts(
        control.clone(),
        RelayQuotas::with_limits(64 << 20, 64 << 20, 64 << 20, 64 << 20, 100, 100),
        CommandLimits {
            account_concurrency: 100,
            account_rate_per_minute: 10000,
            worker_concurrency: 100,
            worker_rate_per_minute: 10000,
        },
        Arc::new(move |_| {
            let principal = principal.clone();
            async move { Ok(Some(principal)) }.boxed()
        }),
        Arc::new(|| 0),
    );
    let publications = Arc::new(Mutex::new(Vec::new()));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let service = Service::with_timing(
        database,
        commands.clone(),
        {
            let publications = publications.clone();
            Arc::new(move |value| publications.lock().unwrap().push(value))
        },
        {
            let logs = logs.clone();
            Arc::new(move |call| {
                let mut record = Value::object([
                    ("level", Value::from_serialize(&call.level)),
                    ("message", Value::from_serialize(&call.message)),
                    ("error", Value::Bool(!call.context["err"].is_null())),
                ]);
                for key in [
                    "accountId",
                    "providerId",
                    "providerAccountId",
                    "trigger",
                    "workerId",
                ] {
                    if let Some(value) = call.context.get(key) {
                        record[key] = value.clone();
                    }
                }
                logs.lock().unwrap().push(record);
            })
        },
        Timing {
            now: {
                let control = control.clone();
                Arc::new(move || control.now.load(Ordering::SeqCst))
            },
            sleep: {
                let control = control.clone();
                Arc::new(move |delay| {
                    let (fire, receive) = oneshot::channel();
                    let (ack, fired) = oneshot::channel();
                    control.timers.lock().unwrap().push(Timer {
                        at: control.now.load(Ordering::SeqCst) + delay.as_millis() as i64,
                        fire,
                        fired,
                    });
                    async move {
                        let _ = receive.await;
                        let _ = ack.send(());
                    }
                    .boxed()
                })
            },
        },
    );
    let runtime = Arc::new(Mutex::new(input["runtime"].clone()));
    let execution = Execution {
        owner,
        worker: input["execution"]["workerId"]
            .as_str()
            .context("Quota worker")?
            .into(),
        chat: input["execution"]["chatId"].as_str().map(str::to_owned),
        attempt: input["attempt"].as_str().context("Quota attempt")?.into(),
        turn: input["turnId"].as_str().map(str::to_owned),
    };
    if input["closeWhilePending"] == true {
        service.schedule_completed(runtime.clone(), execution.clone());
        loop {
            let started = control.started.notified();
            tokio::pin!(started);
            started.as_mut().enable();
            if !control.commands.lock().unwrap().is_empty() {
                break;
            }
            started.await;
        }
        let close = service.close();
        tokio::pin!(close);
        anyhow::ensure!(
            futures::poll!(close.as_mut()).is_pending(),
            "Closing dropped an admitted quota request"
        );
        release
            .send(())
            .map_err(|_| anyhow::anyhow!("Admitted quota request was canceled"))?;
        close.await;
    }
    for step in input["steps"].as_array().context("Quota steps")? {
        if let Some(snapshot) = step.get("snapshot") {
            *control.response.lock().unwrap() = snapshot.clone();
        }
        match step["op"].as_str() {
            Some("capture") => service.capture(
                runtime.clone(),
                execution.clone(),
                step["trigger"].as_str().unwrap_or("fixture-capture"),
            ),
            Some("completed") => service.schedule_completed(runtime.clone(), execution.clone()),
            Some("activity") => {
                service
                    .record_activity(runtime.clone(), execution.clone(), step["activity"].clone())
                    .await
            }
            Some("advance") => {
                let target = control.now.load(Ordering::SeqCst)
                    + step["byMs"].as_i64().context("Quota clock advance")?;
                loop {
                    let next = {
                        let mut timers = control.timers.lock().unwrap();
                        timers.retain(|t| !t.fire.is_closed());
                        let next = timers
                            .iter()
                            .enumerate()
                            .filter(|(_, t)| t.at <= target)
                            .min_by_key(|(_, t)| t.at)
                            .map(|(i, _)| i);
                        next.map(|i| timers.remove(i))
                    };
                    let Some(timer) = next else { break };
                    control.now.store(timer.at, Ordering::SeqCst);
                    timer
                        .fire
                        .send(())
                        .map_err(|_| anyhow::anyhow!("Quota timer unexpectedly canceled"))?;
                    timer.fired.await?;
                    service.drain_requests().await;
                }
                control.now.store(target, Ordering::SeqCst);
            }
            Some("close") => service.close().await,
            _ => anyhow::bail!("Unknown quota fixture step"),
        }
        service.drain_requests().await;
    }
    let mut remaining = control
        .timers
        .lock()
        .unwrap()
        .iter()
        .filter(|t| !t.fire.is_closed())
        .map(|t| t.at)
        .collect::<Vec<_>>();
    remaining.sort();
    let result = Value::object([
        ("runtime", runtime.lock().unwrap().clone()),
        (
            "publications",
            Value::Array(publications.lock().unwrap().clone()),
        ),
        ("logs", Value::Array(logs.lock().unwrap().clone())),
        (
            "commands",
            Value::Array(control.commands.lock().unwrap().clone()),
        ),
        ("remainingTimers", Value::from_serialize(&remaining)),
    ]);
    service.close().await;
    commands.drained().await;
    Ok(result)
}
