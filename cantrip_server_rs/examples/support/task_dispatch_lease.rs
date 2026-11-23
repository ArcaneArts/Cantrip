use anyhow::{Context, Result};
use cantrip_server::{database::Database, task_dispatch::Repository, wire::Value};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let options = &input["options"];
    match input["action"].as_str().context("Task lease action")? {
        "running" => repository.mark_running(&input["fence"], options).await,
        "heartbeat" => repository.heartbeat(&input["fence"], options).await,
        "pause" => {
            repository
                .pause(&input["fence"], &input["affinity"], options, false)
                .await
        }
        "pause-unstarted" => {
            repository
                .pause(&input["fence"], &input["affinity"], options, true)
                .await
        }
        "settle" => {
            repository
                .settle(
                    &input["fence"],
                    input["state"].as_str().context("Task state")?,
                    options,
                )
                .await
        }
        _ => anyhow::bail!("Unknown Task lease fixture action"),
    }
}
