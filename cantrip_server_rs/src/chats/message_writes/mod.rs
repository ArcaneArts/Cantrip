//! Message writes retain the original transaction and publication boundaries.
mod canonical;
mod encrypted;
mod legacy;
use super::{Repository, catalog, message_queries::MessageKind, messages};
use crate::{
    database::{Executor, Row},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
pub use canonical::HistoryError;
pub(crate) use encrypted::write_in_transaction;
pub(crate) use legacy::upsert_task_with;

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Message text")?
        .lossy()
        .into_owned())
}
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
fn nullish<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    value.filter(|v| !v.is_null()).unwrap_or(fallback)
}
fn checked(result: Result<Vec<Row>>, parameters: &[Value]) -> Result<Vec<Row>> {
    result.map_err(|cause| {
        let values = parameters.iter().map(Value::stringify).collect::<Vec<_>>();
        catalog::statement_failure(
            cause,
            &values.iter().map(String::as_str).collect::<Vec<_>>(),
        )
    })
}
fn required(rows: &[Row], operation: &str) -> Result<Value> {
    catalog::raw(
        rows.first()
            .with_context(|| format!("Database returned no row while {operation}"))?,
    )
}
async fn touch(executor: Executor<'_, '_>, chat: &str) -> Result<()> {
    let now = crate::auth::now();
    checked(
        executor
            .query("UPDATE chats SET updated_at=$1 WHERE id=$2", &[&now, &chat])
            .await,
        &[json!(crate::auth::iso(now)), json!(chat)],
    )?;
    Ok(())
}
async fn raw_key(executor: Executor<'_, '_>, chat: &str, key: &str) -> Result<Option<Value>> {
    let rows=checked(executor.query("SELECT to_jsonb(m)::text FROM chat_messages m WHERE chat_id=$1 AND idempotency_key=$2 LIMIT 1",&[&chat,&key]).await,&[json!(chat),json!(key)])?;
    rows.first().map(catalog::raw).transpose()
}
async fn owned_key(
    executor: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    key: &str,
    kind: MessageKind,
) -> Result<Option<Value>> {
    let (join, predicate) = if matches!(kind, MessageKind::Encrypted) {
        ("", "c.owner_id=$1 AND c.experience='agent'")
    } else {
        (
            "INNER JOIN projects p ON p.id=c.project_id",
            if matches!(kind, MessageKind::Task) {
                "p.owner_id=$1 AND c.experience='task'"
            } else {
                "p.owner_id=$1 AND c.experience='agent'"
            },
        )
    };
    let rows=checked(executor.query(&format!("SELECT to_jsonb(m)::text FROM chat_messages m INNER JOIN chats c ON c.id=m.chat_id {join} WHERE {predicate} AND m.chat_id=$2 AND m.idempotency_key=$3 LIMIT 1"),&[&owner,&chat,&key]).await,&[json!(owner),json!(chat),json!(key)])?;
    rows.first()
        .map(|r| kind.map(&catalog::raw(r)?))
        .transpose()
}
async fn project_chat(
    executor: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    task: bool,
) -> Result<Option<Value>> {
    let rows=checked(executor.query("SELECT to_jsonb(c)::text FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 AND c.archived_at IS NULL LIMIT 1",&[&owner,&chat]).await,&[json!(owner),json!(chat)])?;
    let Some(row) = rows.first().map(catalog::raw).transpose()? else {
        return Ok(None);
    };
    if row["experience"] != if task { "task" } else { "agent" } {
        return Ok(None);
    }
    if !truthy(row.get("active_worktree_id")) {
        anyhow::bail!("Project Chat operation is missing its worktree.")
    }
    Ok(Some(row))
}
async fn lane(
    executor: Executor<'_, '_>,
    chat: &str,
    current: &Value,
    attribution: Option<&Value>,
) -> Result<Option<String>> {
    let (column, root) = if let Some(a) = attribution {
        if a["contextKind"] == "standalone" {
            ("scratch_root_id", &a["scratchRootId"])
        } else {
            ("worktree_id", &a["worktreeId"])
        }
    } else if truthy(current.get("active_worktree_id")) {
        ("worktree_id", &current["active_worktree_id"])
    } else {
        ("scratch_root_id", &current["active_scratch_root_id"])
    };
    let root = optional(root)?;
    let rows = if let Some(a) = attribution {
        let id = optional(&a["executionLaneId"])?;
        checked(executor.query(&format!("SELECT id FROM chat_execution_lanes WHERE id=$1 AND chat_id=$2 AND {column}=$3 LIMIT 1"),&[&id,&chat,&root]).await,&[json!(id),json!(chat),json!(root)])?
    } else {
        checked(executor.query(&format!("SELECT id FROM chat_execution_lanes WHERE chat_id=$1 AND {column}=$2 AND state='active' LIMIT 1"),&[&chat,&root]).await,&[json!(chat),json!(root)])?
    };
    rows.first().map(|r| r.get::<String>(0)).transpose()
}
type Fields = Vec<(&'static str, Value)>;
type Parameters = Vec<Box<dyn postgres_types::ToSql + Sync + Send>>;
fn parameters(fields: &Fields) -> Result<(Parameters, Vec<String>)> {
    let mut parameters: Parameters = Vec::new();
    let mut binds = Vec::new();
    for (column, value) in fields {
        let suffix = if matches!(
            *column,
            "content"
                | "protected_content"
                | "attachment_ids"
                | "task_protected_content"
                | "task_attachment_ids"
        ) {
            parameters.push(Box::new(if value.is_null() {
                None
            } else {
                Some(value.stringify())
            }));
            "::text::jsonb"
        } else if *column == "reasoning_adjusted" {
            parameters.push(Box::new(value.as_bool().context("Reasoning adjustment")?));
            ""
        } else {
            parameters.push(Box::new(optional(value)?));
            ""
        };
        binds.push(format!("${}{suffix}", parameters.len()));
    }
    Ok((parameters, binds))
}
async fn insert(executor: Executor<'_, '_>, fields: Fields) -> Result<Vec<Row>> {
    let (parameters, binds) = parameters(&fields)?;
    let refs = parameters
        .iter()
        .map(|p| p.as_ref() as &(dyn postgres_types::ToSql + Sync))
        .collect::<Vec<_>>();
    checked(executor.query(&format!("INSERT INTO chat_messages({}) VALUES({}) RETURNING to_jsonb(chat_messages)::text",fields.iter().map(|(k,_)|*k).collect::<Vec<_>>().join(","),binds.join(",")),&refs).await,&fields.into_iter().map(|(_,v)|v).collect::<Vec<_>>())
}
async fn update(executor: Executor<'_, '_>, id: &str, fields: Fields) -> Result<Vec<Row>> {
    let (mut parameters, binds) = parameters(&fields)?;
    let index = parameters.len() + 1;
    parameters.push(Box::new(id.to_owned()));
    let refs = parameters
        .iter()
        .map(|p| p.as_ref() as &(dyn postgres_types::ToSql + Sync))
        .collect::<Vec<_>>();
    checked(executor.query(&format!("UPDATE chat_messages SET {} WHERE id=${index} RETURNING to_jsonb(chat_messages)::text",fields.iter().zip(binds).map(|((k,_),v)|format!("{k}={v}")).collect::<Vec<_>>().join(",")),&refs).await,&fields.into_iter().map(|(_,v)|v).collect::<Vec<_>>())
}
fn protected_fields(input: &Value, task: bool) -> Fields {
    vec![
        ("role", input["classification"]["role"].clone()),
        ("mode", input["classification"]["mode"].clone()),
        (
            if task {
                "task_protected_content"
            } else {
                "protected_content"
            },
            input["protectedContent"].clone(),
        ),
        (
            if task {
                "task_attachment_ids"
            } else {
                "attachment_ids"
            },
            input["classification"]["attachmentIds"].clone(),
        ),
        ("reasoning_effort", input["reasoningEffort"].clone()),
    ]
}
impl Repository {
    pub async fn message_by_idempotency_key(
        &self,
        owner: &str,
        chat: &str,
        key: &str,
        kind: MessageKind,
    ) -> Result<Option<Value>> {
        owned_key(Executor::Database(&self.database), owner, chat, key, kind).await
    }
}
