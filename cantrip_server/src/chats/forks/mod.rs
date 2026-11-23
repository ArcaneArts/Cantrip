//! Protected message copying preserves each context's original commit model.
mod project;
mod standalone;
#[cfg(test)]
mod tests;
use crate::{
    database::{Executor, Row},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

#[derive(Debug)]
pub struct Conflict(pub &'static str);
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Conflict {}

pub(super) fn checked(result: Result<Vec<Row>>, params: &[Value]) -> Result<Vec<Row>> {
    result.map_err(|error| {
        let rendered = params.iter().map(Value::stringify).collect::<Vec<_>>();
        super::catalog::statement_failure(
            error,
            &rendered.iter().map(String::as_str).collect::<Vec<_>>(),
        )
    })
}
pub(super) fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Chat fork text")?
        .lossy()
        .into_owned())
}
pub(super) fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
pub(super) fn copies_match(sources: &[Value], copies: &[Value]) -> bool {
    copies.len() == sources.len()
        && copies.iter().zip(sources).all(|(copy, source)| {
            copy["classification"]["role"] == source["role"]
                && copy["classification"]["mode"] == source["mode"]
                && copy["classification"]["attachmentIds"].stringify()
                    == source["attachment_ids"].stringify()
        })
}
pub(super) async fn read_messages(
    executor: Executor<'_, '_>,
    chat: &str,
    input: &Value,
) -> Result<Option<Vec<Value>>> {
    let boundary = if truthy(input.get("messageId")) {
        let message = text(&input["messageId"])?;
        let rows = checked(
            executor
                .query(
                    "SELECT sequence FROM chat_messages WHERE id=$1 AND chat_id=$2 LIMIT 1",
                    &[&message, &chat],
                )
                .await,
            &[json!(message), json!(chat)],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        Some(row.get::<i64>(0)?)
    } else {
        None
    };
    let rows = if let Some(sequence) = boundary {
        checked(executor.query("SELECT to_jsonb(m)::text FROM chat_messages m WHERE chat_id=$1 AND sequence<=$2 ORDER BY sequence ASC",&[&chat,&sequence]).await,&[json!(chat),json!(sequence)])?
    } else {
        checked(executor.query("SELECT to_jsonb(m)::text FROM chat_messages m WHERE chat_id=$1 ORDER BY sequence ASC",&[&chat]).await,&[json!(chat)])?
    };
    let messages = rows
        .iter()
        .map(super::catalog::raw)
        .collect::<Result<Vec<_>>>()?;
    if messages.iter().any(|m| {
        !truthy(m.get("protected_content"))
            || !m["content"].is_null()
            || !m["task_protected_content"].is_null()
    }) {
        return Ok(None);
    }
    Ok(Some(messages))
}
pub(super) fn protected_messages(messages: &[Value]) -> Result<Vec<Value>> {
    messages.iter().map(super::messages::opaque).collect()
}

pub(super) async fn insert_messages(
    executor: Executor<'_, '_>,
    chat: &str,
    worktree: Option<&str>,
    scratch: Option<&str>,
    sources: &[Value],
    copies: &[Value],
) -> Result<()> {
    if sources.is_empty() {
        return Ok(());
    }
    // Preserve one parameterized bulk INSERT, including SQL NULL versus JSON
    // null and the real driver's parameter-count failure behavior.
    let columns = [
        "id",
        "chat_id",
        "worktree_id",
        "scratch_root_id",
        "execution_lane_id",
        "role",
        "mode",
        "content",
        "protected_content",
        "attachment_ids",
        "model_id",
        "model_route_id",
        "provider_id",
        "provider_name",
        "provider_model_name",
        "reasoning_effort",
        "applied_reasoning_effort",
        "reasoning_adjusted",
        "idempotency_key",
        "created_at",
    ];
    let mut parameters: Vec<Box<dyn postgres_types::ToSql + Sync + Send>> = Vec::new();
    let mut rendered = Vec::new();
    let mut records = Vec::new();
    for (source, copy) in sources.iter().zip(copies) {
        let fields = [
            copy["id"].clone(),
            json!(chat),
            json!(worktree),
            json!(scratch),
            Value::Null,
            copy["classification"]["role"].clone(),
            copy["classification"]["mode"].clone(),
            Value::Null,
            copy["protectedContent"].clone(),
            copy["classification"]["attachmentIds"].clone(),
            source["model_id"].clone(),
            source["model_route_id"].clone(),
            source["provider_id"].clone(),
            source["provider_name"].clone(),
            source["provider_model_name"].clone(),
            copy.get("reasoningEffort").cloned().unwrap_or(Value::Null),
            source["applied_reasoning_effort"].clone(),
            source["reasoning_adjusted"].clone(),
            copy["idempotencyKey"].clone(),
            super::catalog::iso(&source["created_at"])?,
        ];
        let mut values = Vec::new();
        for (index, value) in fields.into_iter().enumerate() {
            if index == 3 && scratch.is_none() {
                values.push("DEFAULT".to_owned());
                continue;
            }
            let suffix = if [7, 8, 9].contains(&index) {
                parameters.push(Box::new(if value.is_null() {
                    None
                } else {
                    Some(value.stringify())
                }));
                "::text::jsonb"
            } else if index == 17 {
                parameters.push(Box::new(
                    value
                        .as_bool()
                        .context("Fork message reasoning adjustment")?,
                ));
                ""
            } else if index == 19 {
                parameters.push(Box::new(
                    text(&value)?.parse::<chrono::DateTime<chrono::Utc>>()?,
                ));
                ""
            } else {
                parameters.push(Box::new(optional(&value)?));
                ""
            };
            rendered.push(value);
            values.push(format!("${}{suffix}", parameters.len()));
        }
        records.push(format!("({})", values.join(",")));
    }
    let sql = format!(
        "INSERT INTO chat_messages({}) VALUES {}",
        columns.join(","),
        records.join(",")
    );
    let parameters = parameters
        .iter()
        .map(|p| p.as_ref() as &(dyn postgres_types::ToSql + Sync))
        .collect::<Vec<_>>();
    checked(executor.query(&sql, &parameters).await, &rendered)?;
    Ok(())
}

// Drizzle materializes timestamp columns as JS Dates. DeepStrictEqual compares
// their millisecond instants; JSONB metadata keeps its original value semantics.
fn dates(mut row: Value) -> Result<Value> {
    let fields = row
        .as_object()
        .context("Fork source row")?
        .keys()
        .filter_map(|k| k.as_str().filter(|k| k.ends_with("_at")).map(str::to_owned))
        .collect::<Vec<_>>();
    for field in fields {
        if !row[&field].is_null() {
            row[&field] = row[&field]
                .as_js_string()
                .and_then(crate::wire::date_milliseconds)
                .and_then(crate::wire::date_iso_milliseconds)
                .map(|iso| json!(iso))
                // Node 24.22's deep comparison considers invalid Dates equal.
                // A private marker retains that identity without conflating it
                // with SQL NULL or exposing it in a message or wire response.
                .unwrap_or_else(|| json!({"invalidDate":true}));
        }
    }
    Ok(row)
}
