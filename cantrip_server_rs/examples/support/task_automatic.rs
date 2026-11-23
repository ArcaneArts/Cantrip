//! Actual automatic retry composition. Only worker replies, clock and the
//! scheduler wakeup/turn boundary are controlled by this fixture.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        automatic_title::MessageTitles, goals, live_mutations::Service as Live,
        routing::ModelRouting, task_recovery,
    },
    database::Database,
    operations::logging::Logger,
    task_scheduling::{automatic_retry, operation_queue},
    wire::Value,
    workers::command_bus::LimitedCommandBus,
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};
pub struct Environment {
    pub live: Arc<Live>,
    pub commands: Arc<LimitedCommandBus>,
    pub routing: Arc<ModelRouting>,
    pub logger: Logger,
    pub goals: Arc<goals::Service>,
    pub recovery: Arc<task_recovery::Service>,
    pub trace: Arc<Mutex<Vec<Value>>>,
    pub command_log: Arc<Mutex<Vec<Value>>>,
    pub gate: Arc<super::turn_execution::WorkerGate>,
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
    let Some(row) = rows.first() else {
        return Ok(Value::Null);
    };
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
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
        logger,
        goals,
        recovery,
        trace,
        command_log,
        gate,
    } = environment;
    let titles = MessageTitles::new(
        database.clone(),
        routing,
        commands,
        live.clone(),
        logger.clone(),
    );
    let queue = operation_queue::Service::new(
        database.clone(),
        live.clone(),
        titles,
        Arc::new(move || {
            trace
                .lock()
                .unwrap()
                .push(Value::object([("kind", Value::from_serialize(&"tick"))]))
        }),
    );
    let clock = Arc::new(AtomicI64::new(
        input["retryClock"].as_i64().unwrap_or(60000),
    ));
    let actor = automatic_retry::Service::new(automatic_retry::Dependencies {
        database: database.clone(),
        recovery,
        goals,
        queue: queue.clone(),
        live,
        logger,
        clock: Arc::new({
            let clock = clock.clone();
            move || clock.load(Ordering::SeqCst) as f64
        }),
    });
    let steps = input["steps"].as_array().cloned().unwrap_or_else(|| {
        vec![
            Value::object([("kind", Value::from_serialize(&"tick"))]),
            Value::object([("kind", Value::from_serialize(&"drain"))]),
        ]
    });
    let result: Result<Value> = async {
        let mut snapshots = Vec::new();
        for step in steps {
            match step["kind"]
                .as_str()
                .context("Automatic retry fixture step")?
            {
                "tick" => actor.tick().await?,
                "ticks" => {
                    for r in futures::future::join_all(
                        (0..step["count"].as_u64().context("Tick count")?).map(|_| actor.tick()),
                    )
                    .await
                    {
                        r?;
                    }
                }
                "stop" => actor.stop(),
                "release" => gate.release(),
                "drain" => actor.drained().await,
                "clock" => clock.store(
                    step["now"].as_i64().context("Retry clock")?,
                    Ordering::SeqCst,
                ),
                "sql" => {
                    database
                        .query(step["sql"].as_str().context("Retry SQL")?, &[])
                        .await?;
                }
                "snapshot" => snapshots
                    .push(query(&database, step["sql"].as_str().context("Snapshot SQL")?).await?),
                kind @ ("wait-commands" | "wait-sql") => {
                    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
                    loop {
                        let observed = if kind == "wait-commands" {
                            command_log
                                .lock()
                                .unwrap()
                                .iter()
                                .filter(|c| c["command"]["type"] == "chat.goal.get")
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
                            "Automatic retry fixture observation timed out"
                        );
                        tokio::task::yield_now().await;
                    }
                }
                _ => anyhow::bail!("Automatic retry fixture step"),
            }
        }
        Ok(Value::object([("snapshots", Value::Array(snapshots))]))
    }
    .await;
    actor.stop();
    gate.release();
    actor.drained().await;
    queue.drained().await;
    result
}
