use anyhow::{Context, Result};
use cantrip_server::{database::Database, file_documents::Repository, wire::Value};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let text = |key| {
        request[key]
            .as_js_string()
            .map(|s| s.lossy().into_owned())
            .with_context(|| format!("Document fixture {key}"))
    };
    let owner = text("owner")?;
    Ok(match text("op")?.as_str() {
        "document-list" => Value::Array(repository.list(&owner, &text("project")?).await?),
        "document-get" => repository
            .get(&owner, &text("document")?)
            .await?
            .unwrap_or(Value::Null),
        "document-context" => repository
            .execution_context(&owner, &text("document")?)
            .await?
            .unwrap_or(Value::Null),
        "document-create" => repository
            .create(&owner, &text("project")?, &request["input"])
            .await?
            .unwrap_or(Value::Null),
        _ => anyhow::bail!("Unsupported document fixture operation"),
    })
}
