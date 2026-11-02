use anyhow::{Context, Result};
use cantrip_server::{database::Database, tasks::retries::Repository, wire::Value};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let owner = input["owner"].as_str().context("Retry owner")?;
    let chat = input["chat"].as_str().unwrap_or("");
    let now = input.get("now").and_then(Value::as_f64);
    let value = match input["action"].as_str().context("Retry action")? {
        "list" => Value::Array(repository.list_candidates(now).await?),
        "note" => {
            repository
                .note_failure(
                    owner,
                    chat,
                    input["key"].as_str().context("Failure key")?,
                    input["kind"].as_str().context("Failure kind")?,
                    now,
                )
                .await?
        }
        "reset" => repository.reset(owner, chat).await?,
        "clear" => repository.clear_pending(owner, chat).await?,
        "claim" => repository.claim_due(owner, chat, now).await?,
        "finish" => {
            repository
                .finish(
                    owner,
                    chat,
                    input["claim"].as_str().context("Retry claim")?,
                    input.get("failure"),
                    now,
                )
                .await?
        }
        _ => anyhow::bail!("Retry fixture action"),
    };
    Ok(Value::object([("value", value)]))
}
