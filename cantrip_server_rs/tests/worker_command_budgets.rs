use anyhow::{Context, Result};
use cantrip_server::{
    relay::RelayQuotas,
    wire::{JsString, Value},
    workers::{
        bridge::{
            BridgeStats, CommandError, Continuity, EventHandler, Outgoing, Peer, WorkerBridge,
        },
        command_bus::{
            CommandDelegate, CommandFailure, CommandLimits, CommandOutcome, LimitedCommandBus,
            OwnerResolver, RequestTimeout,
        },
    },
};
use futures::future::BoxFuture;
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, oneshot};

fn value(input: serde_json::Value) -> Value {
    Value::from_serialize(&input)
}
fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key].as_str().context("oracle text field")
}
fn unavailable(message: String) -> CommandError {
    CommandError {
        message: message.into(),
        code: None,
        unavailable: true,
        request_id: None,
        encoding_error: None,
    }
}
fn failure(error: CommandFailure) -> Value {
    let kind = match &error {
        CommandFailure::Limit(_) => "limit",
        CommandFailure::Bridge(error) if error.unavailable => "unavailable",
        _ => "error",
    };
    let mut fields = vec![
        ("kind", Value::String(kind.into())),
        ("message", Value::String(error.message())),
    ];
    if let CommandFailure::Limit(error) = error {
        fields.push((
            "retryAfterSeconds",
            Value::from_serialize(&error.retry_after_seconds),
        ));
    }
    Value::object(fields)
}
struct Pending {
    result: oneshot::Sender<CommandOutcome>,
    handler: Option<EventHandler>,
}
#[derive(Default)]
struct Transport {
    closed: bool,
    calls: Vec<Value>,
    pending: HashMap<String, Pending>,
}
struct ControlledDelegate {
    state: Mutex<Transport>,
    changed: Arc<Notify>,
}
impl CommandDelegate for ControlledDelegate {
    fn is_connected(&self, worker: &str) -> bool {
        !self.state.lock().unwrap().closed && ["w0", "w1", "w2"].contains(&worker)
    }
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            connected_workers: if self.state.lock().unwrap().closed {
                0
            } else {
                3
            },
            active_requests: 0,
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn request(
        self: Arc<Self>,
        owner: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        on_event: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        Box::pin(async move {
            let receive = {
                let mut state = self.state.lock().unwrap();
                let id = command["fixtureRequestId"].as_str().unwrap().to_owned();
                state.calls.push(Value::object([
                    ("worker", Value::String(worker.clone().into())),
                    ("owner", Value::String(owner.into())),
                    ("command", command),
                    (
                        "deadlineMs",
                        Value::from_serialize(&timeout.map(|time| time.as_millis() as u64)),
                    ),
                ]));
                if state.closed {
                    return Err(unavailable(format!("Worker {worker} is offline.")));
                }
                let (result, receive) = oneshot::channel();
                assert!(
                    state
                        .pending
                        .insert(
                            id,
                            Pending {
                                result,
                                handler: on_event
                            }
                        )
                        .is_none()
                );
                receive
            };
            self.changed.notify_one();
            receive
                .await
                .expect("controlled request must be explicitly settled")
        })
    }
}
type Observed = Arc<Mutex<IndexMap<String, Value>>>;
struct Fixture {
    bus: Arc<LimitedCommandBus>,
    delegate: Arc<ControlledDelegate>,
    clock: Arc<AtomicI64>,
    owners: Arc<Mutex<HashMap<String, String>>>,
    lookups: Arc<Mutex<Vec<String>>>,
    events: Arc<Mutex<Vec<Value>>>,
    observed: Observed,
    callers: HashMap<String, tokio::task::JoinHandle<()>>,
    changed: Arc<Notify>,
}
impl Fixture {
    fn new(input: &Value) -> Result<Self> {
        let changed = Arc::new(Notify::new());
        let delegate = Arc::new(ControlledDelegate {
            state: Mutex::new(Transport::default()),
            changed: changed.clone(),
        });
        let clock = Arc::new(AtomicI64::new(0));
        let owners = Arc::new(Mutex::new(HashMap::from([
            ("w0".into(), "owner".into()),
            ("w1".into(), "owner".into()),
            ("w2".into(), "other".into()),
            ("lookup".into(), "!error".into()),
        ])));
        let lookups = Arc::new(Mutex::new(Vec::new()));
        let resolver: OwnerResolver = {
            let owners = owners.clone();
            let lookups = lookups.clone();
            Arc::new(move |worker| {
                // This controlled resolver models database text binding for
                // the oracle's enrolled strings and arrays of strings.
                let worker = worker.as_str().map(str::to_owned).unwrap_or_else(|| {
                    worker
                        .as_array()
                        .expect("fixture worker array")
                        .iter()
                        .map(|part| part.as_str().expect("fixture worker text"))
                        .collect::<Vec<_>>()
                        .join(",")
                });
                lookups.lock().unwrap().push(worker.clone());
                let owner = owners.lock().unwrap().get(&worker).cloned();
                Box::pin(async move {
                    anyhow::ensure!(
                        owner.as_deref() != Some("!error"),
                        "Controlled owner lookup failure."
                    );
                    Ok(owner)
                })
            })
        };
        let q = input["quotaLimits"]
            .as_array()
            .context("oracle quota limits")?;
        let number = |i: usize| q[i].as_u64().unwrap();
        let quotas = RelayQuotas::with_limits(
            number(0),
            number(1),
            number(2),
            number(3),
            number(4) as usize,
            number(5) as usize,
        );
        let limits = &input["limits"];
        let limit = |key: &str| limits[key].as_u64().unwrap() as usize;
        let bus = LimitedCommandBus::with_parts(
            delegate.clone(),
            quotas,
            CommandLimits {
                account_concurrency: limit("accountConcurrency"),
                account_rate_per_minute: limit("accountRatePerMinute"),
                worker_concurrency: limit("workerConcurrency"),
                worker_rate_per_minute: limit("workerRatePerMinute"),
            },
            resolver,
            {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::SeqCst))
            },
        );
        Ok(Self {
            bus,
            delegate,
            clock,
            owners,
            lookups,
            changed,
            events: Arc::new(Mutex::new(Vec::new())),
            observed: Arc::new(Mutex::new(IndexMap::new())),
            callers: HashMap::new(),
        })
    }
    async fn wait_for_admission(&self, id: &str) {
        loop {
            let changed = self.changed.notified();
            if self.delegate.state.lock().unwrap().pending.contains_key(id)
                || self
                    .observed
                    .lock()
                    .unwrap()
                    .get(id)
                    .is_some_and(|outcome| outcome.get("pending").is_none())
            {
                return;
            }
            changed.await;
        }
    }
    async fn settled(&mut self, id: &str) {
        if let Some(caller) = self.callers.remove(id) {
            caller.await.unwrap();
        } else {
            // This fixture drops the only caller before its reply. Await the
            // actual owned task, rather than inferring release from a delay.
            assert!(self.delegate.state.lock().unwrap().pending.is_empty());
            self.bus.drained().await;
        }
    }
    async fn step(&mut self, step: &Value) -> Result<Value> {
        let mut action = value(serde_json::json!({"ok":true}));
        match text(step, "op")? {
            "clock" => self.clock.store(
                step["now"].as_i64().context("oracle clock")?,
                Ordering::SeqCst,
            ),
            "owners" => {
                for (worker, owner) in step["owners"].as_object().context("oracle owners")? {
                    self.owners.lock().unwrap().insert(
                        worker.as_str().unwrap().into(),
                        owner.as_str().unwrap().into(),
                    );
                }
            }
            "start" => {
                let id = text(step, "id")?.to_owned();
                self.observed
                    .lock()
                    .unwrap()
                    .insert(id.clone(), value(serde_json::json!({"pending":true})));
                let mut command = step
                    .get("command")
                    .cloned()
                    .unwrap_or_else(|| value(serde_json::json!({"type":"worker.version"})))
                    .as_object()
                    .unwrap()
                    .clone();
                command.insert("fixtureRequestId".into(), Value::String(id.clone().into()));
                let timeout = match step.get("timeout") {
                    None => RequestTimeout::Default,
                    Some(Value::Null) => RequestTimeout::Disabled,
                    Some(milliseconds) => RequestTimeout::After(Duration::from_millis(
                        milliseconds.as_u64().context("oracle timeout")?,
                    )),
                };
                let handler = step.get("events").map(|mode| {
                    let reject = mode == "reject";
                    let events = self.events.clone();
                    let id = id.clone();
                    Arc::new(move |event: Value| {
                        let events = events.clone();
                        let id = id.clone();
                        Box::pin(async move {
                            events.lock().unwrap().push(Value::object([
                                ("id", Value::String(id.into())),
                                ("event", event),
                            ]));
                            if reject {
                                let mut message: Vec<u16> =
                                    "Controlled callback failure 🦀".encode_utf16().collect();
                                message.push(0xd800);
                                return Err(CommandError {
                                    message: JsString::new(message),
                                    code: None,
                                    unavailable: false,
                                    request_id: None,
                                    encoding_error: None,
                                });
                            }
                            Ok(())
                        }) as BoxFuture<'static, Result<(), CommandError>>
                    }) as EventHandler
                });
                let worker = step["worker"].clone();
                let step_has_custom_timeout = step.get("timeout").is_some();
                let bus = self.bus.clone();
                let observed = self.observed.clone();
                let changed = self.changed.clone();
                let request_id = id.clone();
                self.callers.insert(
                    id.clone(),
                    tokio::spawn(async move {
                        let result = if let Some(worker) = worker.as_str() {
                            bus.request_with_timeout(
                                worker,
                                Value::Object(command),
                                timeout,
                                handler,
                            )
                            .await
                        } else {
                            assert!(handler.is_none());
                            assert!(!step_has_custom_timeout);
                            bus.request_key(worker, Value::Object(command)).await
                        };
                        let outcome = match result {
                            Ok(result) => {
                                let mut fields = vec![("ok", Value::Bool(true))];
                                if let Some(value) = result {
                                    fields.push(("value", value));
                                }
                                Value::object(fields)
                            }
                            Err(error) => Value::object([("error", failure(error))]),
                        };
                        observed.lock().unwrap().insert(request_id, outcome);
                        changed.notify_one();
                    }),
                );
                self.wait_for_admission(&id).await;
            }
            "drop" => {
                let id = text(step, "id")?;
                let caller = self.callers.remove(id).context("caller to abandon")?;
                caller.abort();
                assert!(caller.await.unwrap_err().is_cancelled());
                self.observed
                    .lock()
                    .unwrap()
                    .insert(id.into(), value(serde_json::json!({"unobserved":true})));
            }
            "reply" => {
                let id = text(step, "id")?;
                let pending = self.delegate.state.lock().unwrap().pending.remove(id);
                action = value(serde_json::json!({"delivered":pending.is_some()}));
                if let Some(pending) = pending {
                    pending.result.send(Ok(step.get("value").cloned())).unwrap();
                    self.settled(id).await;
                }
            }
            "event" => {
                let id = text(step, "id")?;
                let (exists, handler) = {
                    let state = self.delegate.state.lock().unwrap();
                    let pending = state.pending.get(id);
                    (
                        pending.is_some(),
                        pending.and_then(|request| request.handler.clone()),
                    )
                };
                action = value(serde_json::json!({"delivered":exists}));
                if let Some(handler) = handler
                    && let Err(error) = handler(step["value"].clone()).await
                {
                    self.delegate
                        .state
                        .lock()
                        .unwrap()
                        .pending
                        .remove(id)
                        .unwrap()
                        .result
                        .send(Err(error))
                        .unwrap();
                    self.settled(id).await;
                }
            }
            "close" => {
                let pending = {
                    let mut state = self.delegate.state.lock().unwrap();
                    state.closed = true;
                    std::mem::take(&mut state.pending)
                };
                for (_, pending) in pending {
                    pending
                        .result
                        .send(Err(unavailable("Server is shutting down.".into())))
                        .unwrap();
                }
                self.bus.drained().await;
                for (_, caller) in self.callers.drain() {
                    caller.await.unwrap();
                }
            }
            operation => anyhow::bail!("unknown command oracle step {operation}"),
        }
        let calls = self.delegate.state.lock().unwrap().calls.clone();
        Ok(Value::object([
            ("action", action),
            (
                "outcomes",
                Value::object(
                    self.observed
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(id, outcome)| (id.clone(), outcome.clone())),
                ),
            ),
            ("calls", Value::Array(calls)),
            (
                "lookups",
                Value::from_serialize(&*self.lookups.lock().unwrap()),
            ),
            ("events", Value::Array(self.events.lock().unwrap().clone())),
            ("stats", Value::from_serialize(&self.bus.stats())),
            ("quotas", Value::from_serialize(&self.bus.quotas.stats())),
        ]))
    }
}
#[tokio::test]
async fn admission_and_completion_match_actual_node() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/worker-command-budget-oracle.mjs",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Node command oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout)?;
    let record = stdout
        .lines()
        .find_map(|line| line.strip_prefix("ORACLE_RESULT "))
        .context("Node command oracle receipt")?;
    let oracle: Value = serde_json::from_str(record)?;
    let scenarios = oracle["scenarios"].as_array().context("oracle scenarios")?;
    assert_eq!(oracle["done"].as_u64(), Some(scenarios.len() as u64));
    assert!(scenarios.len() >= 10);
    let mut comparisons = 0;
    for scenario in scenarios {
        let input = &scenario["input"];
        let mut fixture = Fixture::new(input)?;
        let mut steps = input["steps"].as_array().context("oracle steps")?.clone();
        steps.push(value(serde_json::json!({"op":"close"})));
        let expected = scenario["expected"]
            .as_array()
            .context("oracle expected timeline")?;
        assert_eq!(steps.len(), expected.len());
        for (index, (step, expected)) in steps.iter().zip(expected).enumerate() {
            let actual = tokio::time::timeout(Duration::from_secs(10), fixture.step(step))
                .await
                .with_context(|| format!("{} step {index} {step}", input["name"]))??;
            assert_eq!(&actual, expected, "{} step {index} {step}", input["name"]);
            comparisons += 1;
        }
    }
    println!(
        "{} actual Node command admission timelines and {comparisons} complete snapshots matched",
        scenarios.len()
    );
    Ok(())
}

fn connected_bus() -> (
    Arc<LimitedCommandBus>,
    Arc<WorkerBridge>,
    Arc<Peer>,
    tokio::sync::mpsc::UnboundedReceiver<Outgoing>,
) {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let (peer, output) = Peer::new(Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: "process".into(),
    });
    assert!(bridge.attach("worker", peer.clone(), None));
    let bus = LimitedCommandBus::with_parts(
        bridge.clone(),
        RelayQuotas::with_limits(1_000_000, 1_000_000, 1_000_000, 1_000_000, 10, 10),
        CommandLimits {
            account_concurrency: 1,
            account_rate_per_minute: 100,
            worker_concurrency: 1,
            worker_rate_per_minute: 100,
        },
        Arc::new(|_| Box::pin(async { Ok(Some("owner".into())) })),
        Arc::new(|| 0),
    );
    (bus, bridge, peer, output)
}
fn control_command() -> Value {
    value(
        serde_json::json!({"type":"worker.credential.rotate","credential":format!("ctwk_{}", "A".repeat(43))}),
    )
}
async fn receive_request(output: &mut tokio::sync::mpsc::UnboundedReceiver<Outgoing>) -> Value {
    let Outgoing::Text(text) = output.recv().await.unwrap() else {
        panic!("Expected worker request");
    };
    let frame: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(frame["kind"], "request");
    // Let the real bridge's just-created timer register at this paused instant.
    tokio::task::yield_now().await;
    frame
}
#[tokio::test(start_paused = true)]
async fn real_bridge_observes_default_and_explicit_command_deadlines() {
    let (bus, bridge, _peer, mut output) = connected_bus();
    for (timeout, seconds) in [(None, 600), (Some(Duration::from_secs(7)), 7)] {
        let commands = bus.clone();
        let request = tokio::spawn(async move {
            commands
                .request("worker", control_command(), timeout, None)
                .await
        });
        receive_request(&mut output).await;
        tokio::time::advance(Duration::from_secs(seconds - 1)).await;
        tokio::task::yield_now().await;
        assert_eq!(bus.stats().active_requests, 1);
        assert!(!request.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        let error = request.await.unwrap().unwrap_err();
        let CommandFailure::Bridge(error) = error else {
            panic!("Expected real bridge timeout");
        };
        assert_eq!(error.code.as_deref(), Some("worker-command-timeout"));
        assert_eq!(
            error.message.as_str(),
            Some("Worker command worker.credential.rotate timed out.")
        );
        bus.drained().await;
        assert_eq!(bus.stats().active_requests, 0);
        assert_eq!(bridge.stats().active_requests, 0);
    }
    assert_eq!(bus.stats().failed_requests, 2.0);
    bridge.close();
}
#[tokio::test(start_paused = true)]
async fn abandoned_disabled_deadline_request_holds_claim_and_shutdown_drain_until_response() {
    let (bus, bridge, peer, mut output) = connected_bus();
    let commands = bus.clone();
    let caller = tokio::spawn(async move {
        commands
            .request_with_timeout("worker", control_command(), RequestTimeout::Disabled, None)
            .await
    });
    let frame = receive_request(&mut output).await;
    tokio::time::advance(Duration::from_secs(3600)).await;
    tokio::task::yield_now().await;
    assert!(!caller.is_finished());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let commands = bus.clone();
    let drained = tokio::spawn(async move { commands.drained().await });
    tokio::task::yield_now().await;
    assert!(!drained.is_finished());
    assert_eq!(bus.stats().active_requests, 1);
    let failure = bus
        .request("worker", control_command(), None, None)
        .await
        .unwrap_err();
    assert_eq!(failure.status(502), 429);
    assert_eq!(
        failure.message().as_str(),
        Some("Account worker-command concurrency limit reached.")
    );
    assert!(output.try_recv().is_err());
    bridge.response(
        "worker",
        &peer,
        &Value::object([
            ("kind", Value::String("response".into())),
            ("requestId", frame["requestId"].clone()),
            ("ok", Value::Bool(true)),
            ("result", Value::Null),
        ]),
    );
    drained.await.unwrap();
    assert_eq!(bus.stats().active_requests, 0);
    assert_eq!(bus.stats().succeeded_requests, 1.0);
    let commands = bus.clone();
    let next = tokio::spawn(async move {
        commands
            .request("worker", control_command(), None, None)
            .await
    });
    let frame = receive_request(&mut output).await;
    bridge.response(
        "worker",
        &peer,
        &Value::object([
            ("kind", Value::String("response".into())),
            ("requestId", frame["requestId"].clone()),
            ("ok", Value::Bool(true)),
            ("result", value(serde_json::json!({"accepted":true}))),
        ]),
    );
    assert_eq!(
        next.await.unwrap().unwrap(),
        Some(value(serde_json::json!({"accepted":true})))
    );
    assert_eq!(bus.stats().succeeded_requests, 2.0);
    assert_eq!(bus.stats().failed_requests, 1.0);
    assert_eq!(bus.stats().active_requests, 0);
    bridge.close();
    bus.drained().await;
}
