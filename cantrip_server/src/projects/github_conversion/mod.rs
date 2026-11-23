//! Protected folder/local-Git conversion; workers own repository side effects.
mod admission;
mod completion;
mod execute;
mod lifecycle;
pub mod service;
use crate::{
    database::{Database, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

#[derive(Clone)]
pub struct ConversionRepository {
    pub database: Arc<Database>,
}
#[derive(Debug)]
pub enum ConversionError {
    NotFound,
    Conflict(&'static str),
    Stale(&'static str),
}
impl std::fmt::Display for ConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotFound => "",
            Self::Conflict(s) | Self::Stale(s) => s,
        })
    }
}
impl std::error::Error for ConversionError {}
fn text(v: &Value) -> Result<String> {
    Ok(v.as_js_string()
        .context("Conversion SQL text")?
        .lossy()
        .into_owned())
}
fn optional(v: &Value) -> Result<Option<String>> {
    if v.is_null() {
        Ok(None)
    } else {
        text(v).map(Some)
    }
}
fn raw(row: &Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}
fn date(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let millis = v
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid conversion date")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(millis).context("Invalid conversion date")?
    ))
}
fn summary(row: &Value) -> Result<Value> {
    let mut value = json!({
        "id":row["id"],"projectId":row["project_id"],"workerId":row["worker_id"],
        "repository":json!({"repositoryId":row["repository_id"],"nameWithOwner":row["repository_full_name"],"url":row["repository_url"]}),
        "state":row["state"],"stateRevision":row["state_revision"],"attempt":row["attempt"],
        "initialCommitRequested":!row["initial_commit_message"].is_null(),
        "error":if crate::wire::coercion::truthy(row.get("last_error_code")) {
            json!({"code":row["last_error_code"],"retryable":row.get("error_retryable").filter(|v|!v.is_null()).cloned().unwrap_or(Value::Bool(false))})
        }else{Value::Null}
    });
    for (wire, sql) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("startedAt", "started_at"),
        ("completedAt", "completed_at"),
    ] {
        value[wire] = date(&row[sql])?;
    }
    crate::settings::parse_response("projectGithubConversionJobSummarySchema", Some(&value))
}
fn eligible(project: &Value, source: &Value) -> bool {
    (project["folder_management"] == "managed"
        && source["source_kind"] == "folder"
        && source["ownership_kind"] == "cantrip")
        || (project["folder_management"] == "external"
            && project["git_capability"] == true
            && source["source_kind"] == "git"
            && source["ownership_kind"] == "user")
}
impl ConversionRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        self.database.query("SELECT to_jsonb(j)::text FROM project_github_conversion_jobs j WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 1", &[&owner,&project]).await?.first().map(|r|summary(&raw(r)?)).transpose()
    }
    pub async fn has_active(&self, project: &str) -> Result<bool> {
        Ok(!self.database.query("SELECT id FROM project_github_conversion_jobs WHERE project_id=$1 AND state IN ('queued','running','blocked') LIMIT 1", &[&project]).await?.is_empty())
    }
    pub async fn converted_source(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        self.database.query("SELECT jsonb_build_object('localFilesDeleted',j.local_files_deleted_at IS NOT NULL,'projectSourceId',j.project_source_id,'workerId',j.worker_id)::text FROM project_github_conversion_jobs j INNER JOIN project_sources s ON s.id=j.project_source_id WHERE j.owner_id=$1 AND j.project_id=$2 AND j.state='succeeded' AND s.ownership_kind='cantrip' AND s.removed_at IS NULL ORDER BY j.completed_at DESC LIMIT 1", &[&owner,&project]).await?.first().map(raw).transpose()
    }
    pub async fn is_converted_source(
        &self,
        owner: &str,
        project: &str,
        source: &str,
    ) -> Result<bool> {
        Ok(self
            .converted_source(owner, project)
            .await?
            .is_some_and(|v| v["projectSourceId"] == source))
    }
}
