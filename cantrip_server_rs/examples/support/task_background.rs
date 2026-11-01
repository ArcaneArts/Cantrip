//! Concrete scheduler graph over the real Task services and databases. Worker,
//! catalog and worktree/queued-turn continuation are controlled fixture peers.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        automatic_title::MessageTitles, automation_pause, goals, live_mutations::Service as Live,
        managed_console::ManagedConsole, routing::ModelRouting, task_recovery,
        turn_runtime::engine::Runtime,
    },
    database::Database,
    operations::logging::{self, LogCall, Logger},
    task_scheduling::{
        automatic_retry, claimed_execution, eligibility, operation_queue, project_pause,
        resumed_execution, scheduler,
    },
    wire::Value,
    workers::command_bus::LimitedCommandBus,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
pub struct Environment {
    pub runtime: Arc<Runtime>,
    pub console: Arc<ManagedConsole>,
    pub routing: Arc<ModelRouting>,
    pub live: Arc<Live>,
    pub commands: Arc<LimitedCommandBus>,
    pub logger: Logger,
    pub titles: Arc<MessageTitles>,
    pub trace: Arc<Mutex<Vec<Value>>>,
    pub command_log: Arc<Mutex<Vec<Value>>>,
    pub gate: Arc<super::turn_execution::WorkerGate>,
}
struct Graph {
    goals: Arc<goals::Service>,
    queue: Arc<operation_queue::Service>,
    project_pause: Arc<project_pause::Service>,
}
async fn query(database: &Database, sql: &str) -> Result<Value> {
    let rows = database
        .query(
            &format!(
                "SELECT result::text FROM ({}) observation",
                sql.trim_end_matches(';')
            ),
            &[],
        )
        .await?;
    rows.first()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .unwrap_or(Ok(Value::Null))
}
pub async fn run(
    database: Arc<Database>,
    input: &Value,
    environment: Environment,
) -> Result<Value> {
    let Environment {
        runtime,
        console,
        routing,
        live,
        commands,
        logger,
        titles,
        trace,
        command_log,
        gate,
    } = environment;
    let mut graph = None;
    let service = scheduler::Service::new_cyclic(|wakeup| {
        let tick: scheduler::Wakeup = {
            let trace = trace.clone();
            Arc::new(move || {
                trace.lock().unwrap().push(json!({"kind":"tick"}));
                wakeup();
            })
        };
        let goals = goals::Service::new(goals::Dependencies {
            database: database.clone(),
            commands: commands.clone(),
            routing: routing.clone(),
            console,
            live: live.clone(),
            logger: logger.clone(),
            begin: Arc::new({
                let runtime = runtime.clone();
                move |owner, context, input, options, hooks| {
                    runtime.begin(&owner, &context, &input, &options, hooks)
                }
            }),
            pending: Arc::new({
                let trace = trace.clone();
                let pending = input["pendingTransition"] == true;
                move |_owner, chat| {
                    trace
                        .lock()
                        .unwrap()
                        .push(json!({"kind":"pending","chat":chat}));
                    async move { Ok(pending) }.boxed()
                }
            }),
            queue: Arc::new({
                let trace = trace.clone();
                move |_owner, chat| {
                    trace
                        .lock()
                        .unwrap()
                        .push(json!({"kind":"queue","chat":chat}));
                    async { Ok(()) }.boxed()
                }
            }),
            queue_tick: tick.clone(),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        });
        let pause = automation_pause::Service::new(
            database.clone(),
            commands.clone(),
            goals.clone(),
            live.clone(),
            logger.clone(),
        );
        let recovery = task_recovery::Service::new(task_recovery::Dependencies {
            database: database.clone(),
            commands: commands.clone(),
            goals: goals.clone(),
            lease_owner: "background-server:instance".into(),
            publish: Arc::new({
                let live = live.clone();
                move |owner, chat, project| {
                    live.publish_summary(owner, &json!(chat), &json!(project));
                    live.publish_invalidation(
                        owner,
                        chat,
                        "task",
                        Some(&json!({"experience":"task","projectId":project})),
                    );
                }
            }),
            unpause: Arc::new({
                let pause = pause.clone();
                move |owner, chat| {
                    pause
                        .set(&owner, &chat, false, false)
                        .map(|r| r.map(|_| ()))
                        .boxed()
                }
            }),
            report: Arc::new({
                let logger = logger.clone();
                move |_owner, chat, error| {
                    logger(LogCall::event(
                        "warn",
                        "Could not observe a retained Task session for recovery",
                        json!({"chatId":chat,"err":logging::error_details(&error)}),
                    ))
                }
            }),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        });
        let claimed = claimed_execution::Service::new(claimed_execution::Dependencies {
            database: database.clone(),
            runtime,
            goals: goals.clone(),
            routing: routing.clone(),
            commands: commands.clone(),
            live: live.clone(),
            logger: logger.clone(),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            queue_tick: tick.clone(),
            limits: claimed_execution::Limits {
                preflight_timeout_ms: input["launchTimeoutMs"].as_f64().unwrap_or(30000.0),
                ..Default::default()
            },
        });
        let resumed = resumed_execution::Service::new(resumed_execution::Dependencies {
            database: database.clone(),
            pause: pause.clone(),
            goals: goals.clone(),
            claimed: claimed.clone(),
            commands: commands.clone(),
            live: live.clone(),
        });
        let queue = operation_queue::Service::new(database.clone(), live.clone(), titles, tick);
        let retries = automatic_retry::Service::new(automatic_retry::Dependencies {
            database: database.clone(),
            recovery: recovery.clone(),
            goals: goals.clone(),
            queue: queue.clone(),
            live: live.clone(),
            logger: logger.clone(),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
        });
        let eligibility = eligibility::Service::with_dependencies(
            database.clone(),
            routing,
            Arc::new(move |worker| commands.is_connected(worker)),
            logger.clone(),
            input["eligibilityTimeoutMs"].as_f64().unwrap_or(30000.0),
        );
        let project_pause =
            project_pause::Service::new(database.clone(), pause, goals.clone(), live.clone());
        graph = Some(Graph {
            goals,
            queue,
            project_pause,
        });
        scheduler::Dependencies {
            database: database.clone(),
            retries,
            recovery,
            eligibility,
            claimed,
            resumed,
            live,
            logger,
            server_id: "background-server".into(),
            instance_id: "instance".into(),
        }
    });
    let graph = graph.context("Composed scheduler graph")?;
    let steps = input["steps"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!({"kind":"tick"}), json!({"kind":"drain"})]);
    let result: Result<Value> = async {
        let mut snapshots = Vec::new();
        for step in steps {
            match step["kind"].as_str().context("Scheduler fixture step")? {
                "tick" => service.queue_tick(),
                "ticks" => {
                    for _ in 0..step["count"].as_u64().context("Tick count")? {
                        service.queue_tick();
                    }
                }
                "wait" => service.wait_active().await,
                "start" => service.start(),
                "stop" => {
                    service.stop_timer();
                    service.stop_automatic_retries();
                }
                "close-goals" => graph.goals.close(),
                "project-pause" => {
                    let operation = graph.project_pause.set(
                        step["owner"]
                            .as_str()
                            .unwrap_or(input["owner"].as_str().context("Project pause owner")?),
                        step["project"].as_str().unwrap_or("github"),
                        step["paused"] == true,
                    );
                    if step["detached"] == true {
                        drop(operation);
                    } else {
                        let error = operation
                            .await
                            .err()
                            .map(|error| {
                                cantrip_server::operations::shared_failure::downcast_ref::<
                                    project_pause::PauseFailures,
                                >(&error)
                                .map(|error| Value::String(error.message.clone()))
                                .unwrap_or_else(|| json!(error.to_string()))
                            })
                            .unwrap_or(Value::Null);
                        snapshots.push(json!({"projectPauseError":error}));
                    }
                }
                "release" => gate.release(),
                "drain" => {
                    service.wait_active().await;
                    service.drained().await;
                    graph.queue.drained().await;
                    graph.project_pause.drained().await;
                }
                "sql" => {
                    database
                        .query(step["sql"].as_str().context("Scheduler SQL")?, &[])
                        .await?;
                }
                "snapshot" => snapshots.push(
                    query(
                        &database,
                        step["sql"].as_str().context("Scheduler snapshot SQL")?,
                    )
                    .await?,
                ),
                kind @ ("wait-commands" | "wait-sql") => {
                    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
                    loop {
                        let observed = if kind == "wait-commands" {
                            command_log
                                .lock()
                                .unwrap()
                                .iter()
                                .filter(|c| {
                                    c["command"]["type"].as_str()
                                        == Some(step["command"].as_str().unwrap_or("chat.turn"))
                                        && (step["chat"].is_null()
                                            || c["command"]["chatId"] == step["chat"])
                                })
                                .count()
                                >= step["count"].as_u64().context("Command count")? as usize
                        } else {
                            query(&database, step["sql"].as_str().context("Wait SQL")?).await?
                                == step["value"]
                        };
                        if observed {
                            break;
                        }
                        anyhow::ensure!(
                            tokio::time::Instant::now() < deadline,
                            "Background scheduler fixture observation timed out"
                        );
                        tokio::task::yield_now().await;
                    }
                }
                _ => anyhow::bail!("Background scheduler fixture step"),
            }
        }
        Ok(json!({"snapshots":snapshots}))
    }
    .await;
    service.stop_timer();
    service.stop_automatic_retries();
    gate.release();
    service.wait_active().await;
    service.drained().await;
    graph.queue.drained().await;
    graph.project_pause.drained().await;
    graph.goals.close();
    graph.goals.drained().await;
    Ok(Value::object([
        (
            "result",
            result.as_ref().ok().cloned().unwrap_or(Value::Null),
        ),
        (
            "beginError",
            result
                .err()
                .map(|e| json!(e.to_string()))
                .unwrap_or(Value::Null),
        ),
    ]))
}
