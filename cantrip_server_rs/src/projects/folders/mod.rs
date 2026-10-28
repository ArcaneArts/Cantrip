//! Durable managed-folder creation and worker materialization.
mod bootstrap;
mod jobs;
mod lifecycle;
pub mod service;

use crate::{
    database::{Database, Row},
    wire::Value,
};
use anyhow::{Context, Result};
use std::sync::Arc;

#[derive(Clone)]
pub struct FolderRepository {
    pub database: Arc<Database>,
}
impl FolderRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
#[derive(Debug)]
pub enum FolderError {
    Workspace(&'static str),
    Stale(&'static str),
    Conflict(&'static str),
}
impl std::fmt::Display for FolderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Workspace(s) | Self::Stale(s) | Self::Conflict(s) => s,
        })
    }
}
impl std::error::Error for FolderError {}
fn copy(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Folder SQL text")?
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
fn raw(row: &Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}
fn date(value: &Value) -> Result<Value> {
    let millis = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid folder job date")?;
    Ok(Value::String(
        crate::wire::date_iso_milliseconds(millis)
            .context("Invalid folder job date")?
            .into(),
    ))
}
fn summary(row: &Value) -> Result<Value> {
    let mut result = Value::object([
        ("id", copy(row, "id")),
        ("projectId", copy(row, "project_id")),
        ("workerId", copy(row, "worker_id")),
        ("state", copy(row, "state")),
        ("stateRevision", copy(row, "state_revision")),
        ("attempt", copy(row, "attempt")),
        (
            "error",
            if crate::wire::coercion::truthy(row.get("last_error_code")) {
                Value::object([
                    ("code", copy(row, "last_error_code")),
                    (
                        "retryable",
                        row.get("error_retryable")
                            .filter(|v| !v.is_null())
                            .cloned()
                            .unwrap_or(Value::Bool(false)),
                    ),
                ])
            } else {
                Value::Null
            },
        ),
        ("createdAt", date(&row["created_at"])?),
        ("updatedAt", date(&row["updated_at"])?),
    ]);
    for (key, stored) in [("startedAt", "started_at"), ("completedAt", "completed_at")] {
        result[key] = if row[stored].is_null() {
            Value::Null
        } else {
            date(&row[stored])?
        };
    }
    crate::wire::parse("projectFolderSetupJobSummarySchema", Some(&result))
        .map_err(|_| anyhow::anyhow!("Invalid stored folder setup job"))
}
