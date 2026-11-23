//! Durable external history import; protected canonical history remains authoritative.
mod admission;
mod attachment_relay;
mod canonical;
mod execute;
mod failures;
mod hydration;
mod lifecycle;
mod mapping;
mod runtime_binding;
pub mod service;
use crate::{
    database::{Database, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
pub use canonical::ProtectMessages;
use chrono::{DateTime, Utc};
pub(crate) use failures::unavailable as worker_unavailable;
use std::sync::Arc;

const RUNNING: &str = "('reading','importing','hydrating')";
pub const INSERT_BATCH_SIZE: usize = 500;
#[derive(Debug)]
pub enum Error {
    Conflict(String),
    NotFound(String),
    Stale,
}
impl Error {
    pub fn class_name(&self) -> &'static str {
        match self {
            Self::Conflict(_) => "ChatImportJobConflictError",
            Self::NotFound(_) => "ChatImportJobNotFoundError",
            Self::Stale => "ChatImportJobStaleAttemptError",
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Conflict(s) | Self::NotFound(s) => s,
            Self::Stale => "Import attempt is stale.",
        })
    }
}
impl std::error::Error for Error {}
fn conflict(message: &str) -> anyhow::Error {
    Error::Conflict(message.to_owned()).into()
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Import SQL text")?
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
    crate::wire::parse_json_text(&row.get::<String>(0)?)
        .map_err(|_| anyhow::anyhow!("Import SQL JSON"))
}
fn first(rows: &[Row]) -> Result<Value> {
    raw(rows.first().ok_or(Error::Stale)?)
}
fn date(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    Ok(json!(
        value
            .as_js_string()
            .and_then(crate::wire::date_milliseconds)
            .and_then(crate::wire::date_iso_milliseconds)
            .context("Invalid time value")?
    ))
}
fn progress(stage: &str, percent: u8, at: DateTime<Utc>) -> Value {
    json!({"stage":stage,"percent":percent,"updatedAt":crate::auth::iso(at)})
}
fn unique(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<tokio_postgres::Error>().and_then(|e|e.code()).is_some_and(|c|c.code()=="23505")
        || matches!(cause.downcast_ref::<pglite::Error>(),Some(pglite::Error::Database{sqlstate,..}) if sqlstate.as_str()=="23505")
        || {let s=cause.to_string().to_lowercase();s.contains("duplicate key")||s.contains("unique constraint")}
    })
}
pub fn attachment_id(job: &str, external: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut bytes = Sha256::digest(format!("{job}\0{external}").as_bytes())[..16].to_vec();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_slice(&bytes).unwrap().to_string()
}
#[derive(Clone)]
pub struct Repository {
    pub database: Arc<Database>,
    insert_batch_size: usize,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self {
            database,
            insert_batch_size: INSERT_BATCH_SIZE,
        }
    }
    pub fn with_insert_batch_size(database: Arc<Database>, size: usize) -> Result<Self> {
        anyhow::ensure!(size > 0, "Chat import insert batch size must be positive.");
        Ok(Self {
            database,
            insert_batch_size: size,
        })
    }
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.database.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE owner_id=$1 AND id=$2 LIMIT 1",&[&owner,&id]).await?.first().map(|r|mapping::job(&raw(r)?)).transpose()
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
        let rows = self.database.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1000",&[&project]).await?;
        let jobs = rows
            .iter()
            .rev()
            .map(|r| mapping::job(&raw(r)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(crate::settings::parse_response(
            "chatImportJobListSchema",
            Some(&Value::Array(jobs)),
        )?))
    }
    pub async fn source_references(&self, owner: &str, workers: &[String]) -> Result<Value> {
        if workers.is_empty() {
            return Ok(Value::Array(vec![]));
        }
        let rows = self.database.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j INNER JOIN projects p ON p.id=j.project_id AND p.owner_id=$1 WHERE j.owner_id=$1 AND j.source_worker_id=ANY($2)",&[&owner,&workers]).await?;
        Ok(Value::Array(rows.iter().map(|r| {
            let row=raw(r)?;
            let reference=crate::settings::parse_response("externalChatImportReferenceSchema",Some(&json!({"jobId":row["id"],"projectId":row["project_id"],"chatId":row["chat_id"],"state":row["state"]})))?;
            Ok(json!({"sourceKind":row["source_kind"],"sourceWorkerId":row["source_worker_id"],"sourceId":row["source_id"],"sourceThreadId":row["source_thread_id"],"reference":reference}))
        }).collect::<Result<Vec<_>>>()?))
    }
}
