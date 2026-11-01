//! Production claimed launcher, turn engine, Goal service, Live and SQL. Worker,
//! catalog transport and continuation/scheduler wakeup are controlled peers.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        goals, live_mutations::Service as Live, managed_console::ManagedConsole,
        routing::ModelRouting, turn_runtime::engine::Runtime,
    },
    database::Database,
    operations::logging::Logger,
    task_scheduling::{claimed_execution, resumed_execution},
    wire::Value,
    workers::command_bus::LimitedCommandBus,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
pub struct Environment {
    pub runtime: Arc<Runtime>,
    pub goals_console: Arc<ManagedConsole>,
    pub routing: Arc<ModelRouting>,
    pub live: Arc<Live>,
    pub commands: Arc<LimitedCommandBus>,
    pub logger: Logger,
    pub trace: Arc<Mutex<Vec<Value>>>,
}
fn tick(trace: &Arc<Mutex<Vec<Value>>>) {
    trace
        .lock()
        .unwrap()
        .push(Value::object([("kind", Value::from_serialize(&"tick"))]));
}
pub async fn run(
    database: Arc<Database>,
    input: &Value,
    environment: Environment,
) -> Result<Value> {
    let Environment {
        runtime,
        goals_console,
        routing,
        live,
        commands,
        logger,
        trace,
    } = environment;
    let goals = goals::Service::new(goals::Dependencies {
        database: database.clone(),
        commands: commands.clone(),
        routing: routing.clone(),
        console: goals_console,
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
                trace.lock().unwrap().push(Value::object([
                    ("kind", Value::from_serialize(&"pending")),
                    ("chat", Value::from_serialize(&chat)),
                ]));
                async move { Ok(pending) }.boxed()
            }
        }),
        queue: Arc::new({
            let trace = trace.clone();
            move |_owner, chat| {
                trace.lock().unwrap().push(Value::object([
                    ("kind", Value::from_serialize(&"queue")),
                    ("chat", Value::from_serialize(&chat)),
                ]));
                async { Ok(()) }.boxed()
            }
        }),
        queue_tick: Arc::new({
            let trace = trace.clone();
            move || tick(&trace)
        }),
        clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
    });
    let launcher = claimed_execution::Service::new(claimed_execution::Dependencies {
        database: database.clone(),
        runtime,
        goals: goals.clone(),
        routing,
        commands: commands.clone(),
        live: live.clone(),
        logger: logger.clone(),
        clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        queue_tick: Arc::new(move || tick(&trace)),
        limits: claimed_execution::Limits {
            preflight_timeout_ms: input["launchTimeoutMs"].as_f64().unwrap_or(30000.0),
            ..Default::default()
        },
    });
    let pause = cantrip_server::chats::automation_pause::Service::new(
        database.clone(),
        commands.clone(),
        goals.clone(),
        live.clone(),
        logger,
    );
    let resumer = resumed_execution::Service::new(resumed_execution::Dependencies {
        database,
        pause,
        goals: goals.clone(),
        claimed: launcher.clone(),
        commands,
        live,
    });
    let owner = input["owner"].as_str().context("Claimed fixture owner")?;
    let result = if input["action"] == "resume" {
        let operation = resumer.run(owner, &input["claim"]);
        if input["detached"] == true {
            drop(operation);
            Ok(())
        } else {
            operation.await
        }
    } else if input["action"] == "finish" {
        launcher
            .finish_failure(
                owner,
                &input["claim"],
                input["failure"]
                    .as_str()
                    .map(|s| Arc::new(anyhow::anyhow!(s.to_owned()))),
            )
            .await
    } else {
        launcher
            .run(
                owner,
                &input["claim"],
                input.get("preparedRuntime").filter(|v| !v.is_null()),
            )
            .await
    };
    resumer.drained().await;
    launcher.drained().await;
    goals.close();
    goals.drained().await;
    Ok(Value::object([
        ("result", Value::Null),
        (
            "beginError",
            result
                .err()
                .map(|e| Value::from_serialize(&e.to_string()))
                .unwrap_or(Value::Null),
        ),
    ]))
}
