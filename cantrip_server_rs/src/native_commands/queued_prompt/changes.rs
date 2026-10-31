use super::{PromptRepository, assert_standalone, encrypted, parse, raw_one, reads, text};
use crate::{
    database::Executor,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;

// All columns come from the callers below. Bind values separately; this builder
// never accepts field names supplied by a request.
pub(super) async fn update(
    ex: Executor<'_, '_>,
    id: &str,
    owner: Option<&str>,
    fields: Vec<(&'static str, Value)>,
) -> Result<Option<Value>> {
    let mut values = Vec::<Option<String>>::new();
    let mut sets = Vec::new();
    for (column, value) in fields {
        let cast = match column {
            "opaque_content" | "attachments" => "jsonb",
            "frozen" | "custom_subagent_model" => "boolean",
            "updated_at" => "timestamptz",
            _ => "text",
        };
        values.push(if value.is_null() {
            None
        } else if matches!(cast, "jsonb" | "boolean") {
            Some(value.stringify())
        } else {
            Some(text(&value)?)
        });
        sets.push(format!("{column}=${}::text::{cast}", values.len()));
    }
    values.push(Some(id.to_owned()));
    let index = values.len();
    let scope = if let Some(owner) = owner {
        values.push(Some(owner.to_owned()));
        format!(
            " AND EXISTS(SELECT 1 FROM chats WHERE chats.id=queued_prompts.chat_id AND chats.owner_id=${})",
            values.len()
        )
    } else {
        String::new()
    };
    let refs = values
        .iter()
        .map(|v| v as &(dyn postgres_types::ToSql + Sync))
        .collect::<Vec<_>>();
    raw_one(ex,&format!("UPDATE queued_prompts SET {} WHERE id=${index}{scope} RETURNING to_jsonb(queued_prompts)::text",sets.join(",")),&refs).await
}
pub(crate) async fn replace_with(
    ex: Executor<'_, '_>,
    owner: &str,
    id: &Value,
    input: &Value,
    attachments: &Value,
) -> Result<Option<Value>> {
    let prompt = parse("queuedPromptOpaqueContentSchema", input)?;
    if prompt.get("id") != Some(id) {
        return Ok(None);
    }
    let id = text(id)?;
    let context=raw_one(ex,"SELECT to_jsonb(c)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id WHERE q.id=$1 AND c.owner_id=$2 LIMIT 1",&[&id,&owner]).await?;
    let Some(context) = context else {
        return Ok(None);
    };
    assert_standalone(&context, &prompt)?;
    let mut fields = vec![
        ("opaque_content", prompt.clone()),
        ("mode", prompt["classification"]["mode"].clone()),
        ("attachments", attachments.clone()),
    ];
    for (column, field) in [
        ("reasoning_effort", "reasoningEffort"),
        ("custom_subagent_model", "customSubagentModel"),
        ("subagent_model_id", "subagentModelId"),
        ("subagent_reasoning_effort", "subagentReasoningEffort"),
        ("worktree_id", "worktreeId"),
        ("frozen", "frozen"),
    ] {
        fields.push((column, prompt[field].clone()));
    }
    fields.push(("updated_at", json!(crate::auth::iso(crate::auth::now()))));
    update(ex, &id, Some(owner), fields)
        .await?
        .map(|row| encrypted(&row))
        .transpose()
}
impl PromptRepository {
    pub async fn replace_encrypted(
        &self,
        owner: &str,
        id: &Value,
        input: &Value,
        attachments: &Value,
    ) -> Result<Option<Value>> {
        replace_with(
            Executor::Database(&self.database),
            owner,
            id,
            input,
            attachments,
        )
        .await
    }
    pub async fn delete(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let owned=raw_one(Executor::Database(&self.database),"SELECT to_jsonb(q)::text FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id WHERE q.id=$1 AND c.owner_id=$2 LIMIT 1",&[&id,&owner]).await?;
        let Some(owned) = owned else {
            return Ok(None);
        };
        self.database
            .query("DELETE FROM queued_prompts WHERE id=$1", &[&id])
            .await?;
        // Mapping occurs after the committed delete, exactly as the source does.
        if truthy(owned.get("opaque_content")) {
            encrypted(&owned).map(Some)
        } else {
            reads::visible(&owned).map(Some)
        }
    }
    pub async fn reorder(&self, owner: &str, chat: &str, input: &Value) -> Result<bool> {
        let prompts=self.database.query("SELECT q.id FROM queued_prompts q INNER JOIN chats c ON c.id=q.chat_id WHERE q.chat_id=$1 AND c.owner_id=$2",&[&chat,&owner]).await?;
        let ids = input["ids"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Queued prompt order"))?;
        if prompts.len() != ids.len() {
            return Ok(false);
        }
        for row in prompts {
            let saved = json!(row.get::<String>(0)?);
            if !ids.iter().any(|id| id == &saved) {
                return Ok(false);
            }
        }
        let ids = ids.clone();
        self.database.transaction(|tx|Box::pin(async move{
   for (position,id)in ids.iter().enumerate(){tx.query("UPDATE queued_prompts SET position=$1::text::integer,updated_at=$2 WHERE id=$3",&[&position.to_string(),&crate::auth::now(),&text(id)?]).await?;}
   Ok(())
  })).await?;
        Ok(true)
    }
}
