use anyhow::{Context, Result, bail};
use cantrip_server::{
    chats::relocations::{Advance, Repository},
    database::Database,
    wire::Value,
};
use std::sync::Arc;
macro_rules! json {
    ($($tokens:tt)*) => { Value::from_serialize(&serde_json::json!($($tokens)*)) };
}
pub async fn run(database: Arc<Database>, r: &Value) -> Result<Value> {
    if r["op"] == "relocation-hydrate" || r["op"] == "relocation-skills" {
        return super::chat_hydration::run(r).await;
    }
    let repo = Repository::new(database);
    let text = |k| {
        r[k].as_str()
            .with_context(|| format!("Relocation fixture {k}"))
    };
    let number = |k| {
        r[k].as_f64()
            .with_context(|| format!("Relocation fixture {k}"))
    };
    Ok(match text("op")? {
        "relocation-create" => {
            repo.create(text("owner")?, text("chat")?, &r["target"], text("key")?)
                .await?
        }
        "relocation-get" => repo
            .get(text("owner")?, text("job")?)
            .await?
            .unwrap_or(Value::Null),
        "relocation-list" => repo.list(text("owner")?, text("chat")?).await?,
        "relocation-snapshot" => repo
            .snapshot(text("owner")?, text("job")?)
            .await?
            .unwrap_or(Value::Null),
        "relocation-claim" => repo.claim_next().await?.unwrap_or(Value::Null),
        "relocation-renew" => json!(
            repo.renew(text("job")?, text("command")?, number("attempt")?)
                .await?
        ),
        "relocation-advance" => {
            repo.advance(
                text("job")?,
                text("command")?,
                number("attempt")?,
                Advance {
                    from: text("from")?,
                    to: text("to")?,
                    progress: &r["progress"],
                    options: &r["options"],
                },
            )
            .await?
        }
        "relocation-fail" => {
            repo.fail(
                text("job")?,
                text("command")?,
                number("attempt")?,
                &r["error"],
            )
            .await?
        }
        "relocation-commit" => {
            repo.commit(text("job")?, text("command")?, number("attempt")?)
                .await?
        }
        "relocation-cancel" => {
            repo.cancel(text("owner")?, text("job")?, number("revision")?)
                .await?
        }
        "relocation-retry" => {
            repo.retry(text("owner")?, text("job")?, number("revision")?)
                .await?
        }
        "relocation-recover" => json!(
            repo.recover(
                r["force"].as_bool().context("force")?,
                text("now")?.parse()?
            )
            .await?
        ),
        "relocation-requeue" => json!(repo.requeue_worker(text("worker")?).await?),
        "relocation-attachment" => json!(
            repo.is_attachment_available(text("attachment")?, text("worker")?)
                .await?
        ),
        "relocation-mark-attachment" => {
            repo.mark_attachment_available(text("attachment")?, text("worker")?)
                .await?;
            Value::Null
        }
        "relocation-encode" => {
            use base64::{Engine, engine::general_purpose::STANDARD};
            use sha2::{Digest, Sha256};
            let bytes = cantrip_server::chats::hydration::encode_canonical_payload(&r["payload"]);
            json!({"base64":STANDARD.encode(&bytes),"sha256":format!("{:x}",Sha256::digest(&bytes))})
        }
        _ => bail!("Unknown relocation fixture operation"),
    })
}
