//! Production Goal service against real routing/console/live/repositories, with
//! explicit controlled turn and recovery boundaries for differential tests.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository,
        goals::{self, GoalOptions, Observation, Service},
        live_mutations::Service as Live,
        managed_console::ManagedConsole,
        routing::ModelRouting,
    },
    database::Database,
    operations::logging::Logger,
    wire::Value,
    workers::command_bus::LimitedCommandBus,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
fn value<T: serde::Serialize>(v: T) -> Value {
    Value::from_serialize(&v)
}
pub struct Environment {
    pub live: Arc<Live>,
    pub commands: Arc<LimitedCommandBus>,
    pub routing: Arc<ModelRouting>,
    pub console: Arc<ManagedConsole>,
    pub logger: Logger,
    pub command_log: Arc<Mutex<Vec<Value>>>,
    pub gate: Arc<super::turn_execution::WorkerGate>,
    pub peer_trace: Arc<Mutex<Vec<Value>>>,
}
pub async fn run(
    database: Arc<Database>,
    input: &Value,
    environment: Environment,
) -> Result<Value> {
    let Environment {
        live,
        commands,
        routing,
        console,
        logger,
        command_log,
        gate,
        peer_trace,
    } = environment;
    let owner = input["owner"]
        .as_str()
        .context("Goal fixture owner")?
        .to_owned();
    let chat = input["chat"].as_str().context("Goal fixture chat")?;
    let trace = peer_trace;
    let request = Arc::new(input.clone());
    let service = Service::new(goals::Dependencies {
        database: database.clone(),
        commands: commands.clone(),
        routing: routing.clone(),
        console,
        live: live.clone(),
        logger: logger.clone(),
        begin: Arc::new({
            let (trace, request, database) = (trace.clone(), request.clone(), database.clone());
            move |owner, context, turn, options, hooks| {
                let (trace, request, database) = (trace.clone(), request.clone(), database.clone());
                async move {
                    trace.lock().unwrap().push(Value::object([
                        ("kind", value("begin")),
                        ("owner", value(owner)),
                        ("context", context),
                        ("input", turn),
                        ("options", options),
                        (
                            "hooks",
                            Value::object([
                                ("completed", value(hooks.after_completed.is_some())),
                                ("failed", value(hooks.after_failed.is_some())),
                            ]),
                        ),
                    ]));
                    if let Some(sql) = request["beginSql"].as_str() {
                        database.query(sql, &[]).await?;
                    }
                    anyhow::ensure!(
                        request["failBegin"] != true,
                        "Controlled queued turn failure"
                    );
                    Ok(request["beginResult"].clone())
                }
                .boxed()
            }
        }),
        pending: Arc::new({
            let (trace, request, database) = (trace.clone(), request.clone(), database.clone());
            move |owner, chat| {
                let (trace, request, database) = (trace.clone(), request.clone(), database.clone());
                async move {
                    trace.lock().unwrap().push(Value::object([
                        ("kind", value("pending")),
                        ("owner", value(owner)),
                        ("chat", value(chat)),
                    ]));
                    if let Some(sql) = request["pendingSql"].as_str() {
                        database.query(sql, &[]).await?;
                    }
                    Ok(request["pending"] == true)
                }
                .boxed()
            }
        }),
        queue: Arc::new({
            let trace = trace.clone();
            move |owner, chat| {
                let trace = trace.clone();
                async move {
                    trace.lock().unwrap().push(Value::object([
                        ("kind", value("queue")),
                        ("owner", value(owner)),
                        ("chat", value(chat)),
                    ]));
                    Ok(())
                }
                .boxed()
            }
        }),
        queue_tick: Arc::new({
            let trace = trace.clone();
            move || {
                trace
                    .lock()
                    .unwrap()
                    .push(Value::object([("kind", value("tick"))]))
            }
        }),
        clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
    });
    let recovery_clock = Arc::new(std::sync::atomic::AtomicI64::new(
        input["recoveryClock"].as_i64().unwrap_or(0),
    ));
    let recovery = cantrip_server::chats::task_recovery::Service::new(
        cantrip_server::chats::task_recovery::Dependencies {
            database: database.clone(),
            commands: commands.clone(),
            goals: service.clone(),
            lease_owner: input["recoveryLeaseOwner"]
                .as_str()
                .unwrap_or("recovery-server")
                .into(),
            clock: Arc::new({
                let (request, clock) = (request.clone(), recovery_clock.clone());
                move || {
                    if request["recoveryClock"].as_i64().is_some() {
                        clock.load(std::sync::atomic::Ordering::SeqCst)
                    } else {
                        chrono::Utc::now().timestamp_millis()
                    }
                }
            }),
            publish: Arc::new({
                let trace = trace.clone();
                move |owner, chat, project| {
                    trace.lock().unwrap().push(Value::object([
                        ("kind", value("recovery-publish")),
                        ("owner", value(owner)),
                        ("chat", value(chat)),
                        ("project", value(project)),
                    ]))
                }
            }),
            unpause: Arc::new({
                let (trace, database, request) = (trace.clone(), database.clone(), request.clone());
                move |owner, chat| {
                    let (trace, database, request) =
                        (trace.clone(), database.clone(), request.clone());
                    async move {
                        trace.lock().unwrap().push(Value::object([
                            ("kind", value("unpause")),
                            ("owner", value(&owner)),
                            ("chat", value(&chat)),
                        ]));
                        if let Some(sql) = request["unpauseSql"].as_str() {
                            database.query(sql, &[]).await?;
                        }
                        if request["leavePaused"] != true {
                            Repository::new(database)
                                .set_automation_paused(&owner, &chat, false)
                                .await?;
                        }
                        Ok(())
                    }
                    .boxed()
                }
            }),
            report: Arc::new({
                let trace = trace.clone();
                move |owner, chat, error| {
                    trace.lock().unwrap().push(Value::object([
                        ("kind", value("recovery-error")),
                        ("owner", value(owner)),
                        ("chat", value(chat)),
                        ("message", value(error.to_string())),
                    ]))
                }
            }),
        },
    );
    let result: Result<Value> = async {
        if input["action"] == "pause" {
            let pause = cantrip_server::chats::automation_pause::Service::new(
                database.clone(),
                commands.clone(),
                service.clone(),
                live.clone(),
                logger.clone(),
            );
            let result = super::automation_pause::run(pause, input, trace.clone(), gate).await?;
            if let Some(error) = result.get("error") {
                return Ok(Value::object([
                    ("pauseResult", result["result"].clone()),
                    ("pauseError", error.clone()),
                ]));
            }
            return Ok(result["result"].clone());
        }
        if input["action"] == "automatic" {
            return super::task_automatic::run(
                database.clone(),
                input,
                super::task_automatic::Environment {
                    live,
                    commands,
                    routing,
                    logger,
                    goals: service.clone(),
                    recovery: recovery.clone(),
                    trace: trace.clone(),
                    command_log,
                    gate,
                },
            )
            .await;
        }
        let chats = Repository::new(database.clone());
        let context = match input.get("context") {
            Some(v) => v.clone(),
            None => chats
                .execution_context(&owner, chat)
                .await?
                .unwrap_or(Value::Null),
        };
        let task = cantrip_server::tasks::Repository::new(database)
            .get(&owner, chat)
            .await?
            .unwrap_or(Value::Null);
        let options = &input["options"];
        Ok(
            match input["action"].as_str().context("Goal fixture action")? {
                "recover" => value(
                    recovery
                        .recover(
                            &owner,
                            chat,
                            input["resume"] == true,
                            input["automatic"] == true,
                        )
                        .await?,
                ),
                "recover-detached" => {
                    drop(recovery.recover(
                        &owner,
                        chat,
                        input["resume"] == true,
                        input["automatic"] == true,
                    ));
                    recovery.drained().await;
                    Value::Null
                }
                "recover-batch" => {
                    let requests = input["recoveries"]
                        .as_array()
                        .context("Recovery fixture calls")?;
                    let operations = requests
                        .iter()
                        .map(|r| {
                            recovery.recover(
                                &owner,
                                chat,
                                r["resume"] == true,
                                r["automatic"] == true,
                            )
                        })
                        .collect::<Vec<_>>();
                    Value::Array(
                        futures::future::join_all(operations)
                            .await
                            .into_iter()
                            .map(|r| match r {
                                Ok(v) => Value::object([("value", value(v))]),
                                Err(e) => Value::object([("error", value(e.to_string()))]),
                            })
                            .collect(),
                    )
                }
                "recover-reconcile" => {
                    if let Some(clocks) = input["reconcileClocks"].as_array() {
                        for at in clocks {
                            recovery_clock.store(
                                at.as_i64().context("Recovery fixture clock")?,
                                std::sync::atomic::Ordering::SeqCst,
                            );
                            recovery.reconcile(&owner).await?;
                        }
                    } else {
                        for _ in 0..input["count"].as_u64().unwrap_or(1) {
                            recovery.reconcile(&owner).await?;
                        }
                    }
                    Value::Null
                }
                "read" => {
                    service
                        .read(
                            &owner,
                            &context,
                            &task,
                            Observation {
                                message: input.get("message").cloned(),
                                observe_execution: input["observeExecution"] == true,
                                activate: input["activate"] == true,
                                runtime_failure: input.get("runtimeFailure").cloned(),
                                observation_only: input["observationOnly"] == true,
                            },
                        )
                        .await?
                }
                "start" => {
                    service
                        .start_goal(&owner, &context, &input["turn"], options)
                        .await?
                }
                "resume" => {
                    service
                        .resume(
                            &owner,
                            chat,
                            input["activate"] == true,
                            input["reconciled"] == true,
                        )
                        .await?;
                    Value::Null
                }
                "continue" => value(
                    service
                        .continue_worktree(&owner, &context, &input["turn"], input.get("lease"))
                        .await?,
                ),
                "launch" => {
                    service
                        .launch_prepared(
                            &owner,
                            chat,
                            input["operation"].as_str().context("Goal operation")?,
                            GoalOptions {
                                model_configuration: options.get("modelConfiguration").cloned(),
                                runtimes: options["runtimes"].as_array().cloned(),
                                dispatch_lease: options.get("taskDispatchLease").cloned(),
                                user_message: options.get("userMessage").cloned(),
                                worker_prompt: options.get("workerPrompt").cloned(),
                                purpose: options.get("purpose").cloned(),
                                message_role: options.get("messageRole").cloned(),
                                ..GoalOptions::default()
                            },
                        )
                        .await?
                }
                "reconcile" => {
                    service.reconcile(&owner, &task, &input["state"]).await?;
                    Value::Null
                }
                "retain" => {
                    service.retain(&input["lease"]).await?;
                    service.retain(&input["lease"]).await?;
                    Value::Null
                }
                _ => anyhow::bail!("Goal fixture action"),
            },
        )
    }
    .await;
    recovery.drained().await;
    service.close();
    service.drained().await;
    let mut output = Value::object([
        (
            "result",
            result.as_ref().ok().cloned().unwrap_or(Value::Null),
        ),
        ("trace", Value::Array(trace.lock().unwrap().clone())),
    ]);
    if let Err(error) = result {
        output["error"] = Value::object([("message", value(error.to_string()))]);
    }
    if input["action"] == "pause"
        && let Some(error) = output["result"].get("pauseError").cloned()
    {
        output["result"] = output["result"]["pauseResult"].clone();
        output["error"] = error;
    }
    Ok(output)
}
