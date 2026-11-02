//! Real outcome/queue/worktree/Task/Goal/turn services. Worker/catalog and
//! account preparation are explicit fixture boundaries; no public-route claim.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository, automation_pause, goals,
        recovery::{self, outcomes, task_services::TaskServices},
        task_recovery,
        turn_runtime::engine::{Dependencies, Hooks, Runtime},
    },
    operations::logging::{self, LogCall},
    wire::Value,
};
use futures::FutureExt;
use std::sync::Arc;
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
pub async fn run(
    database: Arc<cantrip_server::database::Database>,
    input: &Value,
    environment: super::task_background::Environment,
) -> Result<Value> {
    let template = environment.runtime;
    let command_log = environment.command_log;
    let (commands, live, routing, console, logger, trace, gate) = (
        environment.commands,
        environment.live,
        environment.routing,
        environment.console,
        environment.logger,
        environment.trace,
        environment.gate,
    );
    let timers = recovery::scheduler::Scheduler::new();
    let tick: cantrip_server::task_scheduling::scheduler::Wakeup = Arc::new({
        let trace = trace.clone();
        move || trace.lock().unwrap().push(json!({"kind":"tick"}))
    });
    let mut graph = None;
    let runtime = Runtime::new_cyclic(|weak_runtime| {
        let mut services = None;
        let continuation = recovery::Service::new_cyclic(|weak_recovery| {
            let begin: goals::Begin = Arc::new({
                let runtime = weak_runtime.clone();
                move |owner, context, input, options, hooks| {
                    let runtime = runtime.clone();
                    async move {
                        runtime
                            .upgrade()
                            .context("Outcome fixture turn runtime unavailable")?
                            .begin(&owner, &context, &input, &options, hooks)
                            .await
                    }
                    .boxed()
                }
            });
            let goals = goals::Service::new(goals::Dependencies {
                database: database.clone(),
                commands: commands.clone(),
                routing: routing.clone(),
                console: console.clone(),
                live: live.clone(),
                logger: logger.clone(),
                begin,
                pending: Arc::new({
                    let recovery = weak_recovery.clone();
                    move |owner, chat| {
                        let recovery = recovery.clone();
                        async move {
                            recovery
                                .upgrade()
                                .context("Outcome fixture recovery unavailable")?
                                .continue_worktree_transition(&owner, &chat)
                                .await
                        }
                        .boxed()
                    }
                }),
                queue: Arc::new({
                    let recovery = weak_recovery.clone();
                    move |owner, chat| {
                        let recovery = recovery.clone();
                        async move {
                            recovery
                                .upgrade()
                                .context("Outcome fixture recovery unavailable")?
                                .dispatch(&owner, &chat)
                                .await
                        }
                        .boxed()
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
            let task_recovery = task_recovery::Service::new(task_recovery::Dependencies {
                database: database.clone(),
                commands: commands.clone(),
                goals: goals.clone(),
                lease_owner: "outcome-server:instance".into(),
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
                unpause: Arc::new(move |owner, chat| {
                    pause
                        .set(&owner, &chat, false, false)
                        .map(|r| r.map(|_| ()))
                        .boxed()
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
            let tasks = TaskServices::new(goals.clone(), task_recovery.clone());
            services = Some((goals, task_recovery));
            recovery::Dependencies {
                database: database.clone(),
                live: live.clone(),
                commands: commands.clone(),
                routing: routing.clone(),
                console: console.clone(),
                tasks,
                outcomes: timers.clone(),
                logger: logger.clone(),
                begin: Arc::new({
                    let runtime = weak_runtime.clone();
                    move |owner, context, input, options| {
                        let runtime = runtime.clone();
                        async move {
                            runtime
                                .upgrade()
                                .context("Outcome fixture queued runtime unavailable")?
                                .begin(&owner, &context, &input, &options, Hooks::default())
                                .await
                        }
                        .boxed()
                    }
                }),
                prepare_account: Arc::new({
                    let trace = trace.clone();
                    let database = database.clone();
                    let input = input.clone();
                    move |owner, context| {
                        let (trace, database, input) =
                            (trace.clone(), database.clone(), input.clone());
                        async move {
                            trace.lock().unwrap().push(
                                json!({"kind":"prepare-account","owner":owner,"context":context}),
                            );
                            anyhow::ensure!(
                                input["failAccount"] != true,
                                "Controlled queued account failure"
                            );
                            if let Some(sql) = input["accountSql"].as_str() {
                                database.query(sql, &[]).await?;
                                return Repository::new(database)
                                    .execution_context(
                                        &owner,
                                        context["chatId"]
                                            .as_str()
                                            .context("Queued fixture chat")?,
                                    )
                                    .await?
                                    .context("Queued account chat disappeared");
                            }
                            Ok(context)
                        }
                        .boxed()
                    }
                }),
            }
        });
        let (goals, task_recovery) = services.expect("Outcome Task graph");
        graph = Some((continuation.clone(), goals, task_recovery));
        Dependencies {
            events: template.dependencies.events.clone(),
            bootstrap: template.dependencies.bootstrap.clone(),
            routing: routing.clone(),
            titles: template.dependencies.titles.clone(),
            continuation,
            logger: logger.clone(),
            server_id: template.dependencies.server_id.clone(),
        }
    });
    let (continuation, goals, task_recovery) = graph.context("Outcome fixture graph")?;
    let service = outcomes::Service::new(outcomes::Dependencies {
        database: database.clone(),
        live: live.clone(),
        commands: commands.clone(),
        goals: goals.clone(),
        continuation: continuation.clone(),
        queue_tick: tick,
        logger,
    });
    let result: Result<Value> = async {
        let mut snapshots = Vec::new();
        for step in input["steps"].as_array().context("Outcome fixture steps")? {
            match step["kind"].as_str().context("Outcome fixture step")? {
                "recover" | "batch" => {
                    let notes = step["notifications"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or_else(|| std::slice::from_ref(&step["notification"]));
                    let mut operations = Vec::new();
                    for note in notes {
                        let note = cantrip_server::wire::parse(
                            "workerServerEnvelopeSchema",
                            Some(&json!({"kind":"notification","notification":note})),
                        )
                        .map_err(|error| match error {
                            cantrip_server::wire::ValidationError::Invalid(issues) => {
                                anyhow::anyhow!(Value::Array(issues).stringify_pretty())
                            }
                            _ => anyhow::anyhow!("Outcome envelope validation failed"),
                        })?["notification"]
                            .clone();
                        let owner = step["owner"]
                            .as_str()
                            .unwrap_or(input["owner"].as_str().context("Outcome owner")?);
                        let worker = step["worker"].as_str().unwrap_or("alpha");
                        let operation = service.recover(owner, worker, &note);
                        if step["detached"] == true {
                            drop(operation);
                        } else {
                            operations.push(operation);
                        }
                    }
                    if step["detached"] != true {
                        let errors = futures::future::join_all(operations)
                            .await
                            .into_iter()
                            .map(|r| r.err().map(|e| json!(e.to_string())).unwrap_or(Value::Null))
                            .collect::<Vec<_>>();
                        snapshots.push(json!({"recoveryErrors":errors}));
                    }
                }
                "drain" => {
                    service.drained().await;
                    runtime.drained().await;
                    service.drained().await;
                    runtime.drained().await;
                }
                "release" => gate.release(),
                "wait-commands" => {
                    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
                    while command_log
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|c| {
                            c["command"]["type"].as_str()
                                == Some(step["command"].as_str().unwrap_or("chat.message.protect"))
                        })
                        .count()
                        < step["count"].as_u64().context("Outcome command count")? as usize
                    {
                        anyhow::ensure!(
                            tokio::time::Instant::now() < deadline,
                            "Outcome command observation timed out"
                        );
                        tokio::task::yield_now().await;
                    }
                }
                "sql" => {
                    database
                        .query(step["sql"].as_str().context("Outcome SQL")?, &[])
                        .await?;
                }
                "snapshot" => {
                    let statement = step["sql"].as_str().context("Outcome snapshot")?;
                    let rows = database
                        .query(
                            &format!(
                                "SELECT result::text FROM ({}) observation",
                                statement.trim_end_matches(';')
                            ),
                            &[],
                        )
                        .await?;
                    snapshots.push(
                        rows.first()
                            .map(|r| -> Result<Value> {
                                Ok(serde_json::from_str::<Value>(&r.get::<String>(0)?)?)
                            })
                            .transpose()?
                            .unwrap_or(Value::Null),
                    );
                }
                _ => anyhow::bail!("Outcome fixture step"),
            }
        }
        Ok(json!({"snapshots":snapshots}))
    }
    .await;
    gate.release();
    service.drained().await;
    runtime.drained().await;
    service.drained().await;
    runtime.drained().await;
    goals.close();
    goals.drained().await;
    task_recovery.drained().await;
    timers.clear();
    timers.drained().await;
    Ok(
        json!({"result":result.as_ref().ok().cloned().unwrap_or(Value::Null),"beginError":result.err().map(|e|json!(e.to_string())).unwrap_or(Value::Null)}),
    )
}
