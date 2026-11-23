//! Durable workspace scans and validated user-owned repository imports.
mod execution;
mod import_admission;
mod import_completion;
mod import_lifecycle;
mod scan_admission;
mod scan_completion;
mod scan_lifecycle;
pub mod service;
mod snapshot;
use crate::{
    database::{Database, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

#[derive(Clone)]
pub struct DiscoveryRepository {
    pub database: Arc<Database>,
}
#[derive(Debug)]
pub enum DiscoveryError {
    Invariant(&'static str),
    Stale(&'static str),
    ImportStale(&'static str),
}
impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Invariant(s) | Self::Stale(s) | Self::ImportStale(s) => s,
        })
    }
}
impl std::error::Error for DiscoveryError {}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Discovery SQL text")?
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
    if value.is_null() {
        return Ok(Value::Null);
    }
    let ms = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid discovery date")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(ms).context("Invalid discovery date")?
    ))
}
const COUNTS: [(&str, &str); 7] = [
    ("candidates", "candidate_count"),
    ("collapsedRepositories", "collapsed_repository_count"),
    ("rejectedRepositories", "rejected_repository_count"),
    ("scannedDirectories", "scanned_directory_count"),
    ("scannedEntries", "scanned_entry_count"),
    ("skippedSymlinks", "skipped_symlink_count"),
    ("unreadableDirectories", "unreadable_directory_count"),
];
fn job(row: &Value) -> Result<Value> {
    let counts = if row["candidate_count"].is_null() {
        Value::Null
    } else {
        let mut counts = Value::Object(Default::default());
        for (field, sql) in COUNTS {
            counts[field] = row[sql].clone();
        }
        crate::settings::parse_response("workspaceRepositoryDiscoveryCountsSchema", Some(&counts))?
    };
    let mut value = json!({"id":row["id"],"workspaceId":row["workspace_id"],"workerId":row["worker_id"],"state":row["state"],"stateRevision":row["state_revision"],"attempt":row["attempt"],"depth":row["depth"],"truncated":row["truncated"],"diagnosticCode":if row["truncated"]==true {json!("scan-truncated")}else{Value::Null},"counts":counts,"error":if crate::wire::coercion::truthy(row.get("last_error_code")){json!({"code":row["last_error_code"],"retryable":row.get("error_retryable").filter(|v|!v.is_null()).cloned().unwrap_or(json!(false))})}else{Value::Null}});
    for (field, sql) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("startedAt", "started_at"),
        ("completedAt", "completed_at"),
    ] {
        value[field] = date(&row[sql])?;
    }
    crate::settings::parse_response("workspaceRepositoryDiscoveryJobSummarySchema", Some(&value))
}
fn candidate(row: &Value, conflict: Value) -> Result<Value> {
    let github = if [
        "protected_github_repository_id_handle",
        "protected_github_name_with_owner_handle",
        "protected_github_url_handle",
    ]
    .iter()
    .all(|key| crate::wire::coercion::truthy(row.get(key)))
    {
        json!({"repositoryId":row["protected_github_repository_id_handle"],"nameWithOwner":row["protected_github_name_with_owner_handle"],"url":row["protected_github_url_handle"]})
    } else {
        Value::Null
    };
    let value = json!({"id":row["id"],"jobId":row["job_id"],"workspaceId":row["workspace_id"],"workerId":row["worker_id"],"pathHandle":row["protected_path_handle"],"displayHandle":row["protected_display_handle"],"originUrlHandle":row["protected_origin_url_handle"],"github":github,"repositoryFingerprint":row["repository_fingerprint"],"classification":row["classification"],"importState":row["import_state"],"importAttempt":row["import_attempt"],"importError":if crate::wire::coercion::truthy(row.get("import_error_code")){json!({"code":row["import_error_code"],"retryable":row.get("import_error_retryable").filter(|v|!v.is_null()).cloned().unwrap_or(json!(false))})}else{Value::Null},"projectId":row["import_project_id"],"conflict":conflict,"diagnosticCode":row["diagnostic_code"],"createdAt":date(&row["created_at"])?,"updatedAt":date(&row["updated_at"])?});
    crate::settings::parse_response("workspaceRepositoryCandidateSummarySchema", Some(&value))
}
impl DiscoveryRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
