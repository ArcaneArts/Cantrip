use anyhow::{Context, Result};
use cantrip_server::{
    agent_interactions::Repository,
    database::{Database, Executor},
    wire::Value,
};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repo = Repository::new(Executor::Database(&database));
    let text = |key| {
        request[key]
            .as_str()
            .with_context(|| format!("Interaction fixture {key}"))
    };
    let input = &request["input"];
    let optional = |value: Option<Value>| value.unwrap_or(Value::Null);
    Ok(match text("action")? {
        "record" => repo.record(input, false).await?,
        "record-protected" => repo.record(input, true).await?,
        "get" => optional(repo.get(text("owner")?, text("requestId")?).await?),
        "get-key" => optional(repo.get_by_key(text("owner")?, text("key")?).await?),
        "list" => Value::Array(repo.list(text("owner")?, input).await?),
        "resolve" | "resolve-protected" => optional(
            repo.resolve(
                text("owner")?,
                text("requestId")?,
                input,
                request["action"] == "resolve-protected",
                request["accepted"].as_bool().unwrap_or(false),
            )
            .await?,
        ),
        "validate" | "validate-protected" => optional(
            repo.validate_resolution(
                text("owner")?,
                text("requestId")?,
                input,
                request["action"] == "validate-protected",
            )
            .await?,
        ),
        "expire" => Value::Array(
            repo.expire(
                request
                    .get("now")
                    .map(|v| {
                        v.as_str()
                            .context("Expiry clock")?
                            .parse()
                            .map_err(anyhow::Error::from)
                    })
                    .transpose()?,
            )
            .await?,
        ),
        "interrupt" => Value::Array(
            repo.interrupt(
                text("chat")?,
                request
                    .get("lane")
                    .map(|v| v.as_str().context("Interaction lane"))
                    .transpose()?,
            )
            .await?,
        ),
        "terminalize" => optional(
            repo.terminalize(
                text("key")?,
                text("chat")?,
                text("worker")?,
                text("status")?,
                request.get("resolution"),
            )
            .await?,
        ),
        _ => anyhow::bail!("Unknown interaction fixture action"),
    })
}
