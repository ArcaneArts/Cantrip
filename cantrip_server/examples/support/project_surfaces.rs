//! Direct calls to the production repository; no simulated database behavior.
use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    project_surfaces::{Kind, Repository},
    wire::Value,
};
use std::sync::Arc;

pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let text = |key: &str| request[key].as_str().context("Surface fixture field");
    let owner = text("owner")?;
    let kind = match text("kind")? {
        "explorer" => Kind::Explorer,
        "code" => Kind::Code,
        "view" => Kind::View,
        _ => anyhow::bail!("Unknown surface fixture kind"),
    };
    let input = &request["input"];
    let result = match text("op")? {
        "project-surface-list" => Some(Value::Array(
            repository.list(kind, owner, text("project")?).await?,
        )),
        "project-surface-context" => repository.context(kind, owner, text("subject")?).await?,
        "project-surface-project" => repository
            .view_project(owner, text("subject")?)
            .await?
            .map(|v| Value::String(v.into())),
        "project-surface-update" => {
            repository
                .update(kind, owner, text("subject")?, input)
                .await?
        }
        "project-surface-worktree" => {
            repository
                .update_worktree(kind, owner, text("subject")?, input)
                .await?
        }
        "project-surface-state" => {
            repository
                .update_explorer_state(owner, text("subject")?, input)
                .await?
        }
        "project-surface-pin" => {
            repository
                .pin_explorer(owner, text("subject")?, input)
                .await?
        }
        "project-surface-create" => {
            repository
                .create(kind, owner, text("project")?, input, None)
                .await?
        }
        "project-surface-delete" => {
            let result = repository.delete(kind, owner, text("subject")?).await?;
            if kind == Kind::Code {
                result
            } else {
                Some(Value::Bool(result.is_some()))
            }
        }
        _ => anyhow::bail!("Unknown surface fixture operation"),
    };
    Ok(result.unwrap_or(Value::Null))
}
