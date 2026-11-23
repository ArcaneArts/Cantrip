//! Legacy visible rows are read as stored. No protected queue input is opened.
use super::{PromptRepository, changes, optional, raw_one, reads, text};
use crate::{
    database::Executor,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
impl PromptRepository {
    pub async fn create_visible(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        model: &str,
        attachments: &Value,
    ) -> Result<Option<Value>> {
        let ex = Executor::Database(&self.database);
        let owned=raw_one(ex,"SELECT to_jsonb(c)::text FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 LIMIT 1",&[&owner,&chat]).await?;
        let Some(owned) = owned.filter(|c| c["experience"] == "agent") else {
            return Ok(None);
        };
        let project = text(&owned["project_id"])?;
        if project.is_empty() {
            anyhow::bail!("Project Chat operation received a standalone Chat.");
        }
        if truthy(input.get("worktreeId"))&&ex.query("SELECT w.id FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$1 WHERE w.id=$2 AND w.lifecycle_state='ready' AND s.removed_at IS NULL LIMIT 1",&[&project,&text(&input["worktreeId"])?]).await?.is_empty(){return Ok(None);}
        let key = text(&input["idempotencyKey"])?;
        if let Some(row)=raw_one(ex,"SELECT to_jsonb(q)::text FROM queued_prompts q WHERE chat_id=$1 AND idempotency_key=$2 LIMIT 1",&[&chat,&key]).await?{return reads::visible(&row).map(Some);}
        let last=ex.query("SELECT position FROM queued_prompts WHERE chat_id=$1 ORDER BY position DESC LIMIT 1",&[&chat]).await?;
        let position = (last
            .first()
            .map(|r| r.get::<i32>(0))
            .transpose()?
            .map(i64::from)
            .unwrap_or(-1)
            + 1)
        .to_string();
        let row=raw_one(ex,"INSERT INTO queued_prompts(id,chat_id,text,mode,attachments,model_id,reasoning_effort,worktree_id,position,frozen,idempotency_key) VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8,$9::text::integer,$10,$11) RETURNING to_jsonb(queued_prompts)::text",&[&uuid::Uuid::new_v4().to_string(),&chat,&text(&input["text"])?,&text(&input["mode"])?,&attachments.stringify(),&model,&optional(&input["reasoningEffort"])?,&optional(&input["worktreeId"])?,&position,&input["frozen"].as_bool().context("Queued frozen state")?,&key]).await?.context("Database returned no row after queueing a prompt.")?;
        reads::visible(&row).map(Some)
    }
    pub async fn update_visible(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
        attachments: Option<&Value>,
    ) -> Result<Option<Value>> {
        let ex = Executor::Database(&self.database);
        let owned=raw_one(ex,"SELECT to_jsonb(c)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE q.id=$2 LIMIT 1",&[&owner,&id]).await?;
        if !owned.is_some_and(|c| c["experience"] == "agent") {
            return Ok(None);
        }
        let mut fields = Vec::new();
        for (field, column) in [
            ("text", "text"),
            ("mode", "mode"),
            ("reasoningEffort", "reasoning_effort"),
            ("frozen", "frozen"),
        ] {
            if let Some(value) = input.get(field) {
                fields.push((column, value.clone()));
            }
        }
        if let Some(attachments) = attachments {
            fields.push(("attachments", attachments.clone()));
        }
        fields.push(("updated_at", json!(crate::auth::iso(crate::auth::now()))));
        changes::update(ex, id, None, fields)
            .await?
            .map(|row| reads::visible(&row))
            .transpose()
    }
}
