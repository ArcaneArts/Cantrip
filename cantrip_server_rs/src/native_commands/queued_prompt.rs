//! The encrypted queue mapper and insertion share the caller's existing transaction.
use super::{
    admit::{optional, text},
    receipt,
    settings_persistence::parse,
};
use crate::{
    chats::execution_lanes::LaneError,
    database::{Database, Executor, Parameters, Transaction},
    wire::{Value, coercion::truthy},
};
use anyhow::{Context, Result, bail};
use std::sync::Arc;
mod changes;
pub(crate) use changes::replace_with;
pub(crate) use reads::{encrypted_get, encrypted_list};
mod reads;
mod visible;

#[derive(Clone)]
pub struct PromptRepository {
    database: Arc<Database>,
}
impl PromptRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}

async fn raw_one(ex: Executor<'_, '_>, sql: &str, params: Parameters<'_>) -> Result<Option<Value>> {
    ex.query(sql, params)
        .await?
        .first()
        .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
        .transpose()
}

fn assert_standalone(context: &Value, prompt: &Value) -> Result<()> {
    if context["context_kind"] == "standalone"
        && (prompt["classification"]["mode"] != "default"
            || !prompt["worktreeId"].is_null()
            || truthy(prompt.get("customSubagentModel"))
            || !prompt["subagentModelId"].is_null()
            || !prompt["subagentReasoningEffort"].is_null())
    {
        return Err(LaneError::Conflict("Standalone Chat queued prompts must use default mode without worktree or subagent settings.".into()).into());
    }
    Ok(())
}

pub(crate) fn encrypted(row: &Value) -> Result<Value> {
    if !truthy(row.get("opaque_content")) || row["text"] != Value::Null {
        bail!("Visible queued prompts require the plaintext mapper.");
    }
    let mut value = match &row["opaque_content"] {
        Value::Object(_) => row["opaque_content"].clone(),
        Value::Array(items) => Value::object(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone())),
        ),
        Value::String(s) => Value::object(s.units().iter().enumerate().map(|(i, u)| {
            (
                i.to_string(),
                Value::String(crate::wire::JsString::new(vec![*u])),
            )
        })),
        _ => Value::object([] as [(&str, Value); 0]),
    };
    for (target, column) in [
        ("revision", "revision"),
        ("state", "state"),
        ("chatId", "chat_id"),
        ("attachments", "attachments"),
        ("position", "position"),
    ] {
        value[target] = row[column].clone();
    }
    value["createdAt"] = receipt::iso(&row["created_at"])?;
    value["updatedAt"] = receipt::iso(&row["updated_at"])?;
    parse("encryptedQueuedPromptSchema", &value)
}
pub(crate) async fn create(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attachments: &Value,
) -> Result<Option<Value>> {
    create_with(Executor::Transaction(tx), owner, chat, input, attachments).await
}
pub(crate) async fn create_with(
    ex: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attachments: &Value,
) -> Result<Option<Value>> {
    let prompt = parse("queuedPromptOpaqueContentSchema", input)?;
    let owned = raw_one(
        ex,
        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2 LIMIT 1",
        &[&chat, &owner],
    )
    .await?;
    let Some(owned) = owned else {
        return Ok(None);
    };
    assert_standalone(&owned, &prompt)?;
    let key = text(&prompt["idempotencyKey"])?;
    if let Some(existing)=raw_one(ex,"SELECT to_jsonb(q)::text FROM queued_prompts q WHERE chat_id=$1 AND idempotency_key=$2 LIMIT 1",&[&chat,&key]).await? {return encrypted(&existing).map(Some);}
    let rows = ex
        .query(
            "SELECT position FROM queued_prompts WHERE chat_id=$1 ORDER BY position DESC LIMIT 1",
            &[&chat],
        )
        .await?;
    let position = (rows
        .first()
        .map(|row| row.get::<i32>(0))
        .transpose()?
        .map(i64::from)
        .unwrap_or(-1)
        + 1)
    .to_string();
    let id = text(&prompt["id"])?;
    let content = prompt.stringify();
    let mode = text(&prompt["classification"]["mode"])?;
    let attachments = attachments.stringify();
    let model = text(&prompt["modelId"])?;
    let effort = optional(&prompt["reasoningEffort"])?;
    let custom = prompt["customSubagentModel"]
        .as_bool()
        .context("Queued subagent selection")?;
    let submodel = optional(&prompt["subagentModelId"])?;
    let subeffort = optional(&prompt["subagentReasoningEffort"])?;
    let tree = optional(&prompt["worktreeId"])?;
    let frozen = prompt["frozen"].as_bool().context("Queued frozen state")?;
    let inserted=raw_one(ex,"INSERT INTO queued_prompts(id,chat_id,text,opaque_content,mode,attachments,model_id,reasoning_effort,custom_subagent_model,subagent_model_id,subagent_reasoning_effort,worktree_id,position,frozen,idempotency_key) VALUES($1,$2,NULL,$3::text::jsonb,$4,$5::text::jsonb,$6,$7,$8,$9,$10,$11,$12::text::integer,$13,$14) RETURNING to_jsonb(queued_prompts)::text",&[&id,&chat,&content,&mode,&attachments,&model,&effort,&custom,&submodel,&subeffort,&tree,&position,&frozen,&key]).await?.context("Database returned no row after queueing a prompt.")?;
    encrypted(&inserted).map(Some)
}

impl PromptRepository {
    pub async fn create_encrypted(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attachments: &Value,
    ) -> Result<Option<Value>> {
        create_with(
            Executor::Database(&self.database),
            owner,
            chat,
            input,
            attachments,
        )
        .await
    }
}
