use anyhow::{Context, Result};
use cantrip_server::{
    database::Database, projects::github_conversion::ConversionRepository, wire::Value,
};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repo = ConversionRepository::new(database);
    let text = |key| {
        request[key]
            .as_str()
            .with_context(|| format!("Conversion fixture {key}"))
    };
    Ok(match text("op")? {
        "conversion-create" => {
            repo.create(
                text("owner")?,
                text("project")?,
                text("worker")?,
                text("source")?,
                &request["input"],
            )
            .await?
        }
        "conversion-get" => repo
            .get(text("owner")?, text("project")?)
            .await?
            .unwrap_or(Value::Null),
        "conversion-active" => Value::Bool(repo.has_active(text("project")?).await?),
        "conversion-source" => repo
            .converted_source(text("owner")?, text("project")?)
            .await?
            .unwrap_or(Value::Null),
        "conversion-is-source" => Value::Bool(
            repo.is_converted_source(text("owner")?, text("project")?, text("source")?)
                .await?,
        ),
        "conversion-claim" => repo.claim_next().await?.unwrap_or(Value::Null),
        "conversion-renew" => Value::Bool(
            repo.renew(
                text("job")?,
                text("command")?,
                request["attempt"].as_f64().context("attempt")?,
            )
            .await?,
        ),
        "conversion-block" => {
            repo.block(text("job")?, text("command")?, &request["error"])
                .await?
        }
        "conversion-fail" => {
            repo.fail(text("job")?, text("command")?, &request["error"])
                .await?
        }
        "conversion-complete" => {
            repo.complete(text("job")?, text("command")?, &request["result"])
                .await?
        }
        "conversion-retry" => repo
            .retry(
                text("owner")?,
                text("project")?,
                request["revision"].as_f64().context("revision")?,
            )
            .await?
            .unwrap_or(Value::Null),
        "conversion-recover" => Value::Number(
            repo.recover(
                request["force"].as_bool().context("force")?,
                text("now")?.parse()?,
            )
            .await? as f64,
        ),
        "conversion-requeue" => Value::Number(repo.requeue_worker(text("worker")?).await? as f64),
        _ => anyhow::bail!("Unknown conversion fixture operation"),
    })
}
