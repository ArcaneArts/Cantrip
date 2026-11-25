use super::{Repository, messages};
use crate::{
    native_commands::transaction::TransactionRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

pub(crate) enum Post {
    Created(Value),
    Replay,
    Conflict,
    Inactive,
}

impl Repository {
    pub(crate) async fn post_council_message(
        &self,
        owner: &str,
        context: &Value,
        input: Value,
    ) -> Result<Post> {
        let owner = owner.to_owned();
        let chat = context["chatId"]
            .as_str()
            .context("Council agent identity")?
            .to_owned();
        let lane = context["executionLaneId"].clone();
        let root = context["scratchRootId"].clone();
        self.database.transaction(move |tx| Box::pin(async move {
            tx.query("SELECT id FROM chats WHERE owner_id=$1 AND id=$2 FOR UPDATE", &[&owner,&chat]).await?;
            let repository = TransactionRepository::new(tx);
            let current = repository.execution_context(&owner, &chat).await?;
            if !current.is_some_and(|context| context.get("councilAgent").is_some()
                && context["executionLaneId"] == lane && lane.is_string()
                && context["scratchRootId"] == root && root.is_string()
                && matches!(context["status"].as_str(), Some("running" | "waiting-for-approval")))
            {
                return Ok(Post::Inactive);
            }
            let operation = input["operationId"].as_str().context("Council message operation")?;
            let id = input["message"]["id"].as_str().context("Council message identity")?;
            let notify = input["notify"] == true;
            let previous = tx.query(
                "SELECT message_id,notify FROM council_posted_messages WHERE chat_id=$1 AND operation_id=$2::text::uuid",
                &[&chat,&operation],
            ).await?;
            if let Some(previous) = previous.first() {
                return Ok(if previous.get::<&str>(0)? == id && previous.get::<bool>(1)? == notify {
                    Post::Replay
                } else {
                    Post::Conflict
                });
            }
            let attribution = json!({
                "contextKind":"standalone","executionLaneId":lane,"scratchRootId":root,"worktreeId":Value::Null,
            });
            let message = super::message_writes::write_in_transaction(
                tx, &owner, &chat, &input["message"], Some(&attribution), false,
            ).await?.context("Council message could not be retained.")?;
            tx.query(
                "INSERT INTO council_posted_messages(chat_id,operation_id,message_id,notify) VALUES($1,$2::text::uuid,$3,$4)",
                &[&chat,&operation,&id,&notify],
            ).await?;
            Ok(Post::Created(message))
        })).await
    }

    pub(crate) async fn council_pending_notifications(&self, owner: &str) -> Result<Value> {
        let rows = self
            .database
            .query(
                "SELECT to_jsonb(m)::text FROM council_posted_messages p
             JOIN council_agents a ON a.chat_id=p.chat_id
             JOIN chat_messages m ON m.chat_id=p.chat_id AND m.id=p.message_id
             WHERE a.owner_id=$1 AND p.notify AND p.delivered_at IS NULL
             ORDER BY m.created_at,m.id LIMIT 10",
                &[&owner],
            )
            .await?;
        let pending = rows
            .iter()
            .map(|row| messages::opaque(&serde_json::from_str(row.get::<&str>(0)?)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(Value::Array(pending))
    }

    pub(crate) async fn claim_council_notification(&self, owner: &str, id: &str) -> Result<bool> {
        Ok(!self
            .database
            .query(
                "UPDATE council_posted_messages p SET delivered_at=$3
             FROM council_agents a JOIN chat_messages m ON m.chat_id=a.chat_id
             WHERE a.owner_id=$1 AND m.id=$2 AND p.chat_id=a.chat_id AND p.message_id=m.id
             AND p.notify AND p.delivered_at IS NULL RETURNING p.message_id",
                &[&owner, &id, &crate::auth::now()],
            )
            .await?
            .is_empty())
    }
}
