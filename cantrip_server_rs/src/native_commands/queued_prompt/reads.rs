use super::{PromptRepository, encrypted, raw_one, receipt};
use crate::{
    database::Executor,
    wire::{Value, value::json},
};
use anyhow::{Result, bail};
pub(super) fn visible(row: &Value) -> Result<Value> {
    if row["text"].is_null() {
        bail!("Encrypted queued prompts require the opaque mapper.");
    }
    let mut result = json!({"id":row["id"],"chatId":row["chat_id"],"text":row["text"],"mode":row["mode"],"attachments":Vec::<Value>::new()});
    for (field, column) in [
        ("modelId", "model_id"),
        ("reasoningEffort", "reasoning_effort"),
        ("customSubagentModel", "custom_subagent_model"),
        ("subagentModelId", "subagent_model_id"),
        ("subagentReasoningEffort", "subagent_reasoning_effort"),
        ("worktreeId", "worktree_id"),
        ("position", "position"),
        ("frozen", "frozen"),
    ] {
        result[field] = row[column].clone();
    }
    result["createdAt"] = receipt::iso(&row["created_at"])?;
    result["updatedAt"] = receipt::iso(&row["updated_at"])?;
    Ok(result)
}
pub(crate) async fn encrypted_list(
    ex: Executor<'_, '_>,
    owner: &str,
    chat: &str,
) -> Result<Vec<Value>> {
    ex.query("SELECT to_jsonb(q)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id WHERE q.chat_id=$1 AND q.state IN ('pending','claimed') AND c.owner_id=$2 ORDER BY q.position ASC,q.created_at ASC",&[&chat,&owner]).await?.iter().map(|r|encrypted(&serde_json::from_str(&r.get::<String>(0)?)?)).collect()
}
pub(crate) async fn encrypted_get(
    ex: Executor<'_, '_>,
    owner: &str,
    id: &str,
) -> Result<Option<Value>> {
    raw_one(ex,"SELECT to_jsonb(q)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id WHERE q.id=$1 AND c.owner_id=$2 LIMIT 1",&[&id,&owner]).await?.map(|row|encrypted(&row)).transpose()
}
impl PromptRepository {
    pub async fn list_encrypted(&self, owner: &str, chat: &str) -> Result<Vec<Value>> {
        encrypted_list(Executor::Database(&self.database), owner, chat).await
    }
    pub async fn get_encrypted(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        encrypted_get(Executor::Database(&self.database), owner, id).await
    }
    pub async fn list_visible(&self, owner: &str, chat: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(q)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE q.chat_id=$2 ORDER BY q.position ASC,q.created_at ASC",&[&owner,&chat]).await?.iter().map(|r|visible(&serde_json::from_str(&r.get::<String>(0)?)?)).collect()
    }
    pub async fn get_visible(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        raw_one(Executor::Database(&self.database),"SELECT to_jsonb(q)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE q.id=$2 LIMIT 1",&[&owner,&id]).await?.map(|row|visible(&row)).transpose()
    }
    pub async fn visible_by_key(
        &self,
        owner: &str,
        chat: &str,
        key: &str,
    ) -> Result<Option<Value>> {
        raw_one(Executor::Database(&self.database),"SELECT to_jsonb(q)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE q.chat_id=$2 AND q.idempotency_key=$3 LIMIT 1",&[&owner,&chat,&key]).await?.map(|row|visible(&row)).transpose()
    }
}
