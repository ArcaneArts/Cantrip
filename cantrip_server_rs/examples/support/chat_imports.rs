use anyhow::{Context, Result, bail};
use cantrip_server::{
    chats::imports::{Repository, attachment_id},
    database::Database,
    wire::Value,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
// Preserve raw UTF-16 values without routing fixture replies through serde_json::Value.
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?}) => {
        Value::object([$(($key,Value::from_serialize(&$value))),*])
    };
    ($value:expr) => {Value::from_serialize(&$value)};
}
pub async fn run(database: Arc<Database>, r: &Value) -> Result<Value> {
    let repo = if let Some(size) = r.get("batchSize").and_then(Value::as_f64) {
        Repository::with_insert_batch_size(database, size as usize)?
    } else {
        Repository::new(database)
    };
    let text = |key| {
        r[key]
            .as_str()
            .with_context(|| format!("Chat import fixture {key}"))
    };
    let number = |key| {
        r[key]
            .as_f64()
            .with_context(|| format!("Chat import fixture {key}"))
    };
    Ok(match text("op")? {
        "chat-import-create" => {
            repo.create(text("owner")?, text("project")?, &r["input"])
                .await?
        }
        "chat-import-get" => repo
            .get(text("owner")?, text("job")?)
            .await?
            .unwrap_or(Value::Null),
        "chat-import-list" => repo
            .list(text("owner")?, text("project")?)
            .await?
            .unwrap_or(Value::Null),
        "chat-import-references" => {
            repo.source_references(
                text("owner")?,
                &r["workers"]
                    .as_array()
                    .context("workers")?
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned).context("worker"))
                    .collect::<Result<Vec<_>>>()?,
            )
            .await?
        }
        "chat-import-claim" => repo.claim_next().await?.unwrap_or(Value::Null),
        "chat-import-renew" => json!(
            repo.renew(text("job")?, text("command")?, number("attempt")?)
                .await?
        ),
        "chat-import-mark" => {
            repo.mark_importing(text("job")?, text("command")?, number("attempt")?)
                .await?
        }
        "chat-import-read" => repo
            .read_context(text("job")?, text("command")?)
            .await?
            .unwrap_or(Value::Null),
        "chat-import-hydration" => repo
            .hydration_context(text("job")?, text("command")?)
            .await?
            .unwrap_or(Value::Null),
        "chat-import-complete" => {
            repo.complete_hydration(
                text("job")?,
                text("command")?,
                number("attempt")?,
                &r["input"],
            )
            .await?
        }
        "chat-import-without" => {
            repo.complete_without_hydration(text("job")?, text("command")?, number("attempt")?)
                .await?
        }
        "chat-import-unsupported" => json!(repo.complete_unsupported().await?),
        "chat-import-settle" => {
            repo.settle(text("job")?, text("command")?, text("state")?, &r["error"])
                .await?
        }
        "chat-import-retry" => repo
            .retry(text("owner")?, text("job")?, number("revision")?)
            .await?
            .unwrap_or(Value::Null),
        "chat-import-requeue" => json!(repo.requeue_worker(text("worker")?).await?),
        "chat-import-recover" => json!(
            repo.recover(
                r["force"].as_bool().context("force")?,
                text("now")?.parse()?
            )
            .await?
        ),
        "chat-import-attachment-id" => json!(attachment_id(text("job")?, text("external")?)),
        "chat-import-canonical" => {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let captured = calls.clone();
            let behavior = r["protection"].clone();
            let job=repo.complete_canonical(text("job")?,text("command")?,number("attempt")?,&r["transcript"],r["attachments"].as_array().context("attachments")?,Arc::new(move |messages,attachments| {
                let (calls,behavior)=(captured.clone(),behavior.clone());
                async move {
                    calls.lock().unwrap().push(json!({"messages":messages,"attachments":attachments}));
                    if behavior=="throw" {bail!("Controlled import protection failure");}
                    let mut protected=Vec::new();
                    for m in messages {
                        let ids=m["content"].as_array().context("content")?.iter().filter(|i|i["type"]=="attachment").map(|i|i["attachment"]["id"].clone()).collect::<Vec<_>>();
                        protected.push(json!({"id":m["id"],"classification":json!({"role":m["role"],"mode":m.get("mode").filter(|v|!v.is_null()).cloned().unwrap_or(json!("default")),"attachmentIds":ids}),"protectedContent":json!({"formatVersion":1,"keyRevision":1,"envelope":json!({"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"})}),"reasoningEffort":m.get("reasoningEffort").cloned().unwrap_or(Value::Null),"idempotencyKey":m["idempotencyKey"]}));
                    }
                    if behavior=="truncate" {protected.pop();}
                    if behavior=="duplicate-after-first-batch" {
                        let id=protected[0]["id"].clone();protected[600]["id"]=id;
                    }
                    if behavior=="bad-key" && let Some(first)=protected.first_mut() {first["idempotencyKey"]=json!("wrong");}
                    Ok(Value::Array(protected))
                }.boxed()
            })).await?;
            json!({"job":job,"protectionCalls":calls.lock().unwrap().clone()})
        }
        _ => bail!("Unknown Chat import fixture operation"),
    })
}
