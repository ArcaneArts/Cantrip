use anyhow::{Context, Result};
use cantrip_server::{database::Database, projects::replicas::ReplicaRepository, wire::Value};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let repo = ReplicaRepository::new(database);
    let text = |key| {
        request[key]
            .as_str()
            .with_context(|| format!("Replica fixture {key}"))
    };
    let number = |key| {
        request[key]
            .as_f64()
            .with_context(|| format!("Replica fixture {key}"))
    };
    Ok(match text("op")? {
        "replica-provision" => {
            repo.create_provision(text("owner")?, text("project")?, &request["input"])
                .await?
        }
        "replica-synchronize" => {
            repo.create_synchronize(
                text("owner")?,
                text("project")?,
                text("replica")?,
                &request["input"],
            )
            .await?
        }
        "replica-remove" => {
            repo.create_remove(
                text("owner")?,
                text("project")?,
                text("replica")?,
                &request["input"],
            )
            .await?
        }
        "replica-context" => repo
            .operation_context(text("job")?, text("command")?)
            .await?
            .unwrap_or(Value::Null),
        "replica-repair-context" => repo
            .link_repair_context(text("owner")?, text("project")?, text("replica")?)
            .await?
            .unwrap_or(Value::Null),
        "replica-removal-blocker" => repo
            .removal_blocker(text("replica")?, text("job")?)
            .await?
            .map_or(Value::Null, |s| Value::String(s.into())),
        "replica-removal-start" => Value::Bool(repo.mark_removal_started(text("replica")?).await?),
        "replica-removal-restore" => {
            repo.restore_removal_ready(text("replica")?).await?;
            Value::Null
        }
        "replica-complete-provision" => {
            repo.complete_provision(text("job")?, text("command")?, &request["result"])
                .await?
        }
        "replica-complete-synchronize" => {
            repo.complete_synchronize(text("job")?, text("command")?, &request["result"])
                .await?
        }
        "replica-complete-remove" => {
            repo.complete_remove(text("job")?, text("command")?, &request["result"])
                .await?
        }
        "replica-provision-race" => {
            let (first, second) = tokio::join!(
                repo.create_provision(text("owner")?, text("project")?, &request["input"]),
                repo.create_provision(text("owner")?, text("project")?, &request["input"])
            );
            Value::Array([first,second].into_iter().map(|r|match r {
                Ok(value)=>Value::object([("ok",value)]),
                Err(error)=>Value::object([("error",Value::String(error.to_string().into())),("kind",Value::String(if matches!(error.downcast_ref::<cantrip_server::projects::replicas::ReplicaError>(),Some(cantrip_server::projects::replicas::ReplicaError::Conflict(_))){"ProjectReplicaJobConflictError"}else{"UnexpectedError"}.into()))]),
            }).collect())
        }
        "replica-get" => repo
            .get(text("owner")?, text("job")?)
            .await?
            .unwrap_or(Value::Null),
        "replica-list" => repo
            .list(text("owner")?, text("project")?)
            .await?
            .unwrap_or(Value::Null),
        "replica-claim" => repo.claim_next().await?.unwrap_or(Value::Null),
        "replica-renew" => Value::Bool(
            repo.renew(text("job")?, text("command")?, number("attempt")?)
                .await?,
        ),
        "replica-progress" => repo
            .update_progress(
                text("job")?,
                text("command")?,
                number("attempt")?,
                &request["update"],
            )
            .await?
            .unwrap_or(Value::Null),
        "replica-block" => {
            repo.block(text("job")?, text("command")?, &request["error"])
                .await?
        }
        "replica-fail" => {
            repo.fail(text("job")?, text("command")?, &request["error"])
                .await?
        }
        "replica-retry" => repo
            .retry(text("owner")?, text("job")?, number("revision")?)
            .await?
            .unwrap_or(Value::Null),
        "replica-cancel" => repo
            .cancel(text("owner")?, text("job")?, number("revision")?)
            .await?
            .unwrap_or(Value::Null),
        "replica-recover" => Value::Number(
            repo.recover(
                request["force"].as_bool().context("force")?,
                text("now")?.parse()?,
            )
            .await? as f64,
        ),
        "replica-requeue" => Value::Number(repo.requeue_worker(text("worker")?).await? as f64),
        _ => anyhow::bail!("Unknown replica fixture operation"),
    })
}
