use anyhow::{Context, Result};
use cantrip_server::{
    chats::roots::{Identity, Repository},
    database::Database,
    wire::Value,
};
use std::sync::Arc;

pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let catalog = cantrip_server::chats::Repository::new(database.clone());
    let repo = Repository::new(database);
    let text = |key| {
        request[key]
            .as_str()
            .with_context(|| format!("Scratch fixture {key}"))
    };
    let identity = || -> Result<Identity> {
        let input = &request["input"];
        let field = |key| {
            input[key]
                .as_str()
                .with_context(|| format!("Scratch identity {key}"))
                .map(str::to_owned)
        };
        Ok(Identity {
            id: field("id")?,
            owner_id: field("ownerId")?,
            root_id: field("rootId")?,
            chat_id: field("chatId")?,
            worker_id: field("workerId")?,
        })
    };
    Ok(match text("op")? {
        "scratch-chat-create" => {
            catalog
                .create_standalone(text("owner")?, &request["input"], |id| {
                    request["connected"]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|v| v == id))
                })
                .await?
        }
        "scratch-chat-list" => Value::Array(catalog.list_standalone(text("owner")?).await?),
        "scratch-chat-archive-agent" => {
            catalog.archive_agent(text("owner")?, text("chat")?).await?
        }
        "scratch-chat-delete" => catalog.delete_chat(text("owner")?, text("chat")?).await?,
        "scratch-chat-archive" => {
            catalog
                .archive_standalone(text("owner")?, text("chat")?)
                .await?
        }
        "scratch-chat-restore" => catalog
            .restore_standalone(text("owner")?, text("chat")?)
            .await?
            .unwrap_or(Value::Null),
        "scratch-chat-deletion-root" => catalog
            .standalone_deletion_root(text("owner")?, text("chat")?)
            .await?
            .unwrap_or(Value::Null),
        "scratch-chat-restore-project" => catalog
            .restore_archived(text("owner")?, text("chat")?, &request["input"])
            .await?
            .unwrap_or(Value::Null),
        "scratch-chat-permanent" => Value::Bool(
            catalog
                .permanently_delete_archived(text("owner")?, text("chat")?)
                .await?,
        ),
        "scratch-chat-purge-project" => Value::Number(
            catalog
                .purge_expired_project_chats(text("owner")?, text("now")?.parse()?)
                .await? as f64,
        ),
        "scratch-chat-update" => catalog
            .update_label(text("owner")?, text("chat")?, &request["input"])
            .await?
            .unwrap_or(Value::Null),
        "scratch-chat-draft-get" => catalog
            .composer_draft(text("owner")?, text("chat")?)
            .await?
            .unwrap_or(Value::Null),
        "scratch-chat-draft-put" => catalog
            .update_composer_draft(text("owner")?, text("chat")?, &request["state"])
            .await?
            .unwrap_or(Value::Null),
        "scratch-chat-ack" => catalog
            .acknowledge_completion(text("owner")?, text("chat")?)
            .await?
            .unwrap_or(Value::Null),
        "scratch-chat-archived" => {
            Value::Array(catalog.list_archived_standalone(text("owner")?).await?)
        }
        "scratch-enqueue-provision" => repo.enqueue_provision(&identity()?).await?,
        "scratch-enqueue-delete" => repo.enqueue_delete(&identity()?).await?,
        "scratch-purge" => {
            repo.tombstone_and_purge(
                &identity()?,
                request
                    .get("expiredBy")
                    .and_then(Value::as_str)
                    .map(str::parse)
                    .transpose()?,
            )
            .await?
        }
        "scratch-purge-expired" => Value::Array(
            repo.purge_expired(text("owner")?, text("now")?.parse()?)
                .await?,
        ),
        "scratch-purge-all" => Value::Array(repo.purge_all_expired(text("now")?.parse()?).await?),
        "scratch-get" => repo
            .get(text("owner")?, text("root")?, text("kind")?)
            .await?
            .unwrap_or(Value::Null),
        "scratch-claim" => repo.claim_next().await?.unwrap_or(Value::Null),
        "scratch-claims" => {
            let results = futures::future::join_all(
                (0..request["count"].as_u64().context("claim count")?).map(|_| repo.claim_next()),
            )
            .await;
            Value::Array(
                results
                    .into_iter()
                    .map(|r| r.map(|v| v.unwrap_or(Value::Null)))
                    .collect::<Result<_>>()?,
            )
        }
        "scratch-renew" => Value::Bool(
            repo.renew(
                text("job")?,
                text("command")?,
                request["attempt"].as_f64().context("attempt")?,
            )
            .await?,
        ),
        "scratch-block" | "scratch-fail" => {
            repo.settle(
                text("job")?,
                text("command")?,
                text("op")? == "scratch-fail",
                &request["error"],
            )
            .await?
        }
        "scratch-complete-provision" => {
            repo.complete_provision(text("job")?, text("command")?, &request["result"])
                .await?
        }
        "scratch-complete-delete" => {
            repo.complete_delete(text("job")?, text("command")?, &request["result"])
                .await?
        }
        "scratch-recover" => Value::Number(
            repo.recover(
                request["force"].as_bool().context("force")?,
                text("now")?.parse()?,
            )
            .await? as f64,
        ),
        "scratch-requeue" => Value::Number(repo.requeue_worker(text("worker")?).await? as f64),
        "scratch-targets" => Value::Array(repo.reconciliation_targets(text("worker")?).await?),
        "scratch-missing" => Value::Number(
            repo.mark_missing(
                text("worker")?,
                &request["roots"]
                    .as_array()
                    .context("missing roots")?
                    .iter()
                    .map(|v| v.as_str().context("root ID").map(str::to_owned))
                    .collect::<Result<Vec<_>>>()?,
            )
            .await? as f64,
        ),
        _ => anyhow::bail!("Unknown scratch fixture operation"),
    })
}
