use super::*;

pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repository = cantrip_server::projects::git_operations::Repository::new(database);
    let text = |key: &str| -> Result<&str> { request[key].as_str().context("Git fixture field") };
    let value = match text("op")? {
        "git-operation-create" => Some(
            repository
                .create(
                    text("owner")?,
                    text("project")?,
                    text("worktree")?,
                    text("worker")?,
                    &request["context"],
                )
                .await?,
        ),
        "git-operation-active" => {
            repository
                .active(text("owner")?, text("project")?, text("worktree")?)
                .await?
        }
        "git-operation-latest" => {
            repository
                .latest(text("owner")?, text("project")?, text("worktree")?)
                .await?
        }
        "git-operation-get" => {
            repository
                .get(
                    text("owner")?,
                    text("project")?,
                    text("worktree")?,
                    text("operationId")?,
                )
                .await?
        }
        "git-operation-running" => repository.mark_running(text("operationId")?).await?,
        "git-operation-update" => {
            repository
                .update(
                    text("owner")?,
                    text("project")?,
                    text("worktree")?,
                    text("operationId")?,
                    &request["state"],
                )
                .await?
        }
        "git-operation-fail" => {
            repository
                .fail(
                    text("owner")?,
                    text("project")?,
                    text("worktree")?,
                    text("operationId")?,
                    request["error"]
                        .as_js_string()
                        .context("Git fixture error")?,
                )
                .await?
        }
        _ => anyhow::bail!("Unknown Git fixture operation"),
    };
    Ok(value.unwrap_or(Value::Null))
}
