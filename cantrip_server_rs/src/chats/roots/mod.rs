//! Durable standalone scratch provisioning and deletion. Files stay on workers.
mod admission;
mod claims;
mod completion;
mod recovery;
pub mod service;
use crate::{
    database::{Database, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use std::sync::Arc;

#[derive(Clone)]
pub struct Repository {
    pub database: Arc<Database>,
}
#[derive(Clone)]
pub struct Identity {
    pub id: String,
    pub owner_id: String,
    pub root_id: String,
    pub chat_id: String,
    pub worker_id: String,
}
#[derive(Debug)]
pub enum RootJobError {
    Conflict(&'static str),
    Stale(&'static str),
}
impl std::fmt::Display for RootJobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Conflict(s) | Self::Stale(s) => s,
        })
    }
}
impl std::error::Error for RootJobError {}
#[derive(Debug)]
pub struct InvalidSummary(String);
impl std::fmt::Display for InvalidSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for InvalidSummary {}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get(&self, owner: &str, root: &str, kind: &str) -> Result<Option<Value>> {
        self.database.query(
            "SELECT to_jsonb(j)::text FROM standalone_chat_root_jobs j WHERE owner_id=$1 AND root_id=$2 AND kind=$3 LIMIT 1",
            &[&owner, &root, &kind],
        ).await?.first().map(|row| summary(&raw(row)?)).transpose()
    }
}
fn raw(row: &Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Scratch job SQL text")?
        .lossy()
        .into_owned())
}
fn date(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let millis = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid scratch job date")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(millis).context("Invalid scratch job date")?
    ))
}
pub(super) fn summary(row: &Value) -> Result<Value> {
    let mut result = json!({
        "id":row["id"],"rootId":row["root_id"],"chatId":row["chat_id"],
        "workerId":row["worker_id"],"kind":row["kind"],"state":row["state"],
        "stateRevision":row["state_revision"],"attempt":row["attempt"],
        "error":if crate::wire::coercion::truthy(row.get("last_error_code")) {
            json!({"code":row["last_error_code"],"retryable":row.get("error_retryable").filter(|v|!v.is_null()).cloned().unwrap_or(Value::Bool(false))})
        } else { Value::Null }
    });
    for (wire, stored) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("startedAt", "started_at"),
        ("completedAt", "completed_at"),
    ] {
        result[wire] = date(&row[stored])?;
    }
    crate::wire::parse("standaloneChatRootJobSummarySchema", Some(&result))
        .map_err(|error| InvalidSummary(crate::settings::response_error(error).to_string()).into())
}
fn same_identity(row: &Value, input: &Identity, kind: &str) -> bool {
    row["id"] == input.id
        && row["owner_id"] == input.owner_id
        && row["root_id"] == input.root_id
        && row["chat_id"] == input.chat_id
        && row["worker_id"] == input.worker_id
        && row["kind"] == kind
}
fn matches_root(job: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM standalone_chat_roots r WHERE r.id={job}.root_id AND r.chat_id={job}.chat_id AND r.owner_id={job}.owner_id AND r.worker_id={job}.worker_id AND r.status!='deleting')"
    )
}
