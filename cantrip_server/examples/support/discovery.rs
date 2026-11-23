use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    projects::{workspace_discovery::DiscoveryRepository, workspaces::WorkspaceRepository},
    wire::Value,
};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, r: &Value) -> Result<Value> {
    let repo = DiscoveryRepository::new(database);
    let catalog = WorkspaceRepository::new(repo.database.clone());
    let text = |key| {
        r[key]
            .as_str()
            .with_context(|| format!("Discovery fixture {key}"))
    };
    Ok(match text("op")? {
        "discovery-workspace-list" => catalog.list(text("owner")?).await?,
        "discovery-workspace-create" => catalog.create(text("owner")?, &r["input"], false).await?,
        "discovery-workspace-attach" => catalog.create(text("owner")?, &r["input"], true).await?,
        "discovery-workspace-update" => catalog
            .update(text("owner")?, text("workspace")?, &r["input"])
            .await?
            .unwrap_or(Value::Null),
        "discovery-workspace-delete-plan" => catalog
            .deletion_plan(text("owner")?, text("workspace")?)
            .await?
            .unwrap_or(Value::Null),
        "discovery-workspace-delete" => {
            Value::Bool(catalog.delete(text("owner")?, text("workspace")?).await?)
        }
        "discovery-project-removal-context" => catalog
            .project_removal_context(text("owner")?, text("project")?)
            .await?
            .unwrap_or(Value::Null),
        "discovery-project-delete" => Value::Bool(
            catalog
                .delete_project(text("owner")?, text("project")?)
                .await?,
        ),
        "discovery-snapshot" => repo
            .snapshot(text("owner")?, text("workspace")?)
            .await?
            .unwrap_or(Value::Null),
        "discovery-queue" => repo
            .queue_scan(
                text("owner")?,
                text("workspace")?,
                r.get("input").unwrap_or(&Value::Null),
            )
            .await?
            .unwrap_or(Value::Null),
        "discovery-claim" => repo.claim_scan().await?.unwrap_or(Value::Null),
        "discovery-renew" => Value::Bool(
            repo.renew_scan(
                text("job")?,
                text("command")?,
                r["attempt"].as_f64().context("attempt")?,
            )
            .await?,
        ),
        "discovery-block" => {
            repo.block_scan(text("job")?, text("command")?, &r["error"])
                .await?
        }
        "discovery-fail" => {
            repo.fail_scan(text("job")?, text("command")?, &r["error"])
                .await?
        }
        "discovery-complete" => {
            repo.complete_scan(text("job")?, text("command")?, &r["input"])
                .await?
        }
        "discovery-recover" => Value::Number(
            repo.recover_scans(
                r["force"].as_bool().context("force")?,
                text("now")?.parse()?,
            )
            .await? as f64,
        ),
        "discovery-requeue" => {
            Value::Number(repo.requeue_worker_scans(text("worker")?).await? as f64)
        }
        "discovery-import-queue" => repo
            .queue_imports(text("owner")?, text("workspace")?, &r["input"])
            .await?
            .unwrap_or(Value::Null),
        "discovery-import-claim" => repo.claim_import().await?.unwrap_or(Value::Null),
        "discovery-import-renew" => Value::Bool(repo.renew_import(&r["claimed"]).await?),
        "discovery-import-block" => repo.block_import(&r["claimed"], &r["error"]).await?,
        "discovery-import-fail" => repo.fail_import(&r["claimed"], &r["error"]).await?,
        "discovery-import-complete" => repo.complete_import(&r["claimed"], &r["result"]).await?,
        "discovery-import-recover" => Value::Number(
            repo.recover_imports(
                r["force"].as_bool().context("force")?,
                text("now")?.parse()?,
            )
            .await? as f64,
        ),
        "discovery-import-requeue" => {
            Value::Number(repo.requeue_worker_imports(text("worker")?).await? as f64)
        }
        _ => anyhow::bail!("Unknown discovery fixture operation"),
    })
}
