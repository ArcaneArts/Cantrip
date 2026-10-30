//! Durable replica jobs. Filesystem and Git operations remain worker-owned.
mod admission;
mod completion;
mod context;
mod execute;
pub mod github_import;
mod lifecycle;
pub mod service;
use crate::{
    database::{Database, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;
#[derive(Clone)]
pub struct ReplicaRepository {
    pub database: Arc<Database>,
}
impl ReplicaRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
#[derive(Debug)]
pub enum ReplicaError {
    Conflict(&'static str),
    NotFound(&'static str),
    Stale(&'static str),
}
impl std::fmt::Display for ReplicaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Conflict(s) | Self::NotFound(s) | Self::Stale(s) => s,
        })
    }
}
impl std::error::Error for ReplicaError {}
fn copy(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Replica SQL text")?
        .lossy()
        .into_owned())
}
fn raw(row: &Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}
fn date(value: &Value) -> Result<Value> {
    let millis = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid replica job date")?;
    Ok(Value::String(
        crate::wire::date_iso_milliseconds(millis)
            .context("Invalid replica job date")?
            .into(),
    ))
}
fn summary(row: &Value) -> Result<Value> {
    let mut result = Value::object([
        ("id", copy(row, "id")),
        ("projectId", copy(row, "project_id")),
        ("projectReplicaId", copy(row, "project_replica_id")),
        ("workerId", copy(row, "worker_id")),
        ("kind", copy(row, "kind")),
        ("state", copy(row, "state")),
        ("stateRevision", copy(row, "state_revision")),
        ("idempotencyKey", copy(row, "idempotency_key")),
        ("repository", copy(row, "repository")),
        ("placementMode", copy(row, "placement_mode")),
        ("placementPath", copy(row, "placement_path")),
        (
            "resolvedMaterialization",
            copy(row, "resolved_materialization"),
        ),
        ("resolvedOwnership", copy(row, "resolved_ownership")),
        ("expectedRevision", copy(row, "expected_revision")),
        ("resolvedRevision", copy(row, "resolved_revision")),
        ("synchronizationPolicy", copy(row, "synchronization_policy")),
        ("deleteLocalFiles", copy(row, "delete_local_files")),
        ("attempt", copy(row, "attempt")),
        ("progress", copy(row, "progress")),
    ]);
    result["error"] = if crate::wire::coercion::truthy(row.get("last_error_code")) {
        json!({"code":copy(row,"last_error_code"),"retryable":row.get("error_retryable").filter(|v|!v.is_null()).cloned().unwrap_or(Value::Bool(false))})
    } else {
        Value::Null
    };
    for (key, stored) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("startedAt", "started_at"),
        ("completedAt", "completed_at"),
        ("cancellationUnsafeAt", "cancellation_unsafe_at"),
    ] {
        result[key] = if row[stored].is_null() {
            Value::Null
        } else {
            date(&row[stored])?
        };
    }
    crate::settings::parse_response("projectReplicaJobSummarySchema", Some(&result))
}
fn progress(stage: &str, percent: u32, at: chrono::DateTime<chrono::Utc>) -> String {
    json!({"stage":stage,"percent":percent,"updatedAt":crate::auth::iso(at)}).stringify()
}
impl ReplicaRepository {
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.database.query("SELECT to_jsonb(j)::text FROM project_replica_jobs j WHERE owner_id=$1 AND id=$2 LIMIT 1",&[&owner,&id]).await?.first().map(|r|summary(&raw(r)?)).transpose()
    }
    pub async fn list(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        if self
            .database
            .query(
                "SELECT id FROM projects WHERE owner_id=$1 AND id=$2 LIMIT 1",
                &[&owner, &project],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let rows=self.database.query("SELECT to_jsonb(j)::text FROM project_replica_jobs j WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1000",&[&project]).await?;
        let values = rows
            .iter()
            .rev()
            .map(|r| summary(&raw(r)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(crate::settings::parse_response(
            "projectReplicaJobListSchema",
            Some(&Value::Array(values)),
        )?))
    }
}
