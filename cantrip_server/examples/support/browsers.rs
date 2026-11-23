use anyhow::{Context, Result};
use cantrip_server::{browsers::Repository, database::Database, wire::Value};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repo = Repository::new(database);
    let text = |key| {
        request[key]
            .as_js_string()
            .map(|s| s.lossy().into_owned())
            .with_context(|| format!("Browser fixture {key}"))
    };
    let owner = text("owner")?;
    Ok(match text("op")?.as_str() {
        "browser-list" => Value::Array(repo.list(&owner, &text("project")?).await?),
        "browser-owned" => Value::Bool(repo.owned(&owner, &text("browser")?).await?),
        "browser-update" => repo
            .update(&owner, &text("browser")?, &request["input"])
            .await?
            .unwrap_or(Value::Null),
        "browser-delete" => Value::Bool(repo.delete(&owner, &text("browser")?).await?),
        "browser-create" => {
            let connected = |worker: &str| {
                request["connected"]
                    .as_array()
                    .is_some_and(|workers| workers.iter().any(|w| w == worker))
            };
            repo.create(
                &owner,
                &text("project")?,
                &request["input"],
                request
                    .get("connected")
                    .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
            )
            .await?
            .unwrap_or(Value::Null)
        }
        _ => anyhow::bail!("Unsupported browser fixture operation"),
    })
}
