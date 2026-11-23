use anyhow::{Context, Result};
use cantrip_server::{database::Database, pane_layouts::Repository, wire::Value};
use std::sync::Arc;

pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let text = |key: &str| -> Result<String> {
        Ok(request[key]
            .as_js_string()
            .context("Pane fixture identity")?
            .lossy()
            .into_owned())
    };
    let owner = text("owner")?;
    let project = text("project")?;
    let input = &request["input"];
    let value = match request["op"].as_str().context("Pane fixture operation")? {
        "layout-get" => repository.get(&owner, &project).await?,
        "layout-launchers" => repository.launchers(&owner, &project).await?,
        "layout-pin" => repository.pin(&owner, &project, input).await?,
        "layout-open" => repository.open(&owner, &project, input).await?,
        "layout-close" => repository.close(&owner, &project, input).await?,
        "layout-builtin-worktree" => {
            repository
                .builtin_worktree(&owner, &project, &request["subject"], &input["worktreeId"])
                .await?
        }
        op => {
            repository
                .mutate(
                    &owner,
                    &project,
                    &op["layout-".len()..],
                    &request["subject"],
                    input,
                )
                .await?
        }
    };
    Ok(value.unwrap_or(Value::Null))
}
