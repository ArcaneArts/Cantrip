use anyhow::{Context, Result};
use cantrip_server::{database::Database, wire::Value, workspace_layouts::Repository};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let text = |key| {
        request[key]
            .as_js_string()
            .map(|s| s.lossy().into_owned())
            .with_context(|| format!("Workspace fixture {key}"))
    };
    let owner = text("owner")?;
    let raw = request
        .get("inputRaw")
        .map(|v| -> Result<Value> {
            Ok(serde_json::from_str(
                v.as_str().context("Raw workspace input")?,
            )?)
        })
        .transpose()?;
    let input = raw.as_ref().unwrap_or(&request["input"]);
    Ok(match text("op")?.as_str() {
        "workspace-get" => {
            repository
                .get(&owner, &text("project")?, &text("workspace")?)
                .await?
        }
        "workspace-execute" => repository.execute(&owner, input).await?,
        "workspace-seed" => {
            repository
                .seed(&owner, &text("project")?, &text("workspace")?, input)
                .await?
        }
        "workspace-import" => {
            repository
                .import_legacy_files(&owner, &text("project")?, &text("workspace")?, input)
                .await?
        }
        _ => anyhow::bail!("Unknown workspace fixture operation"),
    }
    .unwrap_or(Value::Null))
}
