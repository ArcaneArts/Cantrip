//! Immutable protected relocation snapshots and fenced durable job transitions.
mod admission;
mod attachments;
mod commit;
mod execute;
mod lifecycle;
mod mapping;
mod preparation;
mod runtime_binding;
pub mod service;
mod snapshots;
use crate::{
    database::{Database, Executor, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use std::sync::Arc;

pub(super) const ACTIVE: &str = "('queued','waiting-for-idle','validating','preparing-replica','transferring-attachments','hydrating-runtime','ready-to-commit','blocked')";
pub(super) const RUNNING: &str = "('validating','preparing-replica','transferring-attachments','hydrating-runtime','ready-to-commit')";
#[derive(Debug)]
pub enum Error {
    Conflict(String),
    NotFound(String),
    Stale,
}
impl Error {
    pub fn class_name(&self) -> &'static str {
        match self {
            Self::Conflict(_) => "ChatRelocationJobConflictError",
            Self::NotFound(_) => "ChatRelocationJobNotFoundError",
            Self::Stale => "ChatRelocationJobStaleAttemptError",
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Conflict(s) | Self::NotFound(s) => s,
            Self::Stale => "",
        })
    }
}
impl std::error::Error for Error {}
fn conflict(message: &str) -> anyhow::Error {
    Error::Conflict(message.to_owned()).into()
}
fn text(v: &Value) -> Result<String> {
    Ok(v.as_js_string()
        .context("Relocation SQL text")?
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
fn raw(r: &Row) -> Result<Value> {
    crate::wire::parse_json_text(&r.get::<String>(0)?)
        .map_err(|_| anyhow::anyhow!("Relocation SQL JSON"))
}
fn first(rows: &[Row]) -> Result<Value> {
    raw(rows.first().ok_or(Error::Stale)?)
}
fn date(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    };
    Ok(json!(
        v.as_js_string()
            .and_then(crate::wire::date_milliseconds)
            .and_then(crate::wire::date_iso_milliseconds)
            .context("Invalid time value")?
    ))
}
fn progress(stage: &str, percent: Value, at: DateTime<Utc>) -> Value {
    json!({"stage":stage,"percent":percent,"updatedAt":crate::auth::iso(at)})
}
fn unique(e: &anyhow::Error) -> bool {
    e.chain().any(|cause| {
        cause.downcast_ref::<tokio_postgres::Error>().and_then(|e|e.code()).is_some_and(|c|c.code()=="23505")
        || matches!(cause.downcast_ref::<pglite::Error>(),Some(pglite::Error::Database{sqlstate,..}) if sqlstate.as_str()=="23505")
        || {let s=cause.to_string().to_lowercase();s.contains("duplicate key")||s.contains("unique constraint")}
    })
}
#[derive(Clone)]
pub struct Repository {
    pub database: Arc<Database>,
}
pub struct Advance<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub progress: &'a Value,
    pub options: &'a Value,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.database.query("SELECT to_jsonb(j)::text FROM chat_relocation_jobs j WHERE owner_id=$1 AND id=$2 LIMIT 1",&[&owner,&id]).await?.first().map(|r|mapping::job(&raw(r)?)).transpose()
    }
    pub async fn list(&self, owner: &str, chat: &str) -> Result<Value> {
        let rows=self.database.query("SELECT to_jsonb(j)::text FROM chat_relocation_jobs j INNER JOIN projects p ON p.id=j.project_id AND p.owner_id=$1 WHERE j.chat_id=$2 ORDER BY j.created_at DESC,j.id DESC LIMIT 1000",&[&owner,&chat]).await?;
        let values = rows
            .iter()
            .rev()
            .map(|r| mapping::job(&raw(r)?))
            .collect::<Result<Vec<_>>>()?;
        crate::settings::parse_response("chatRelocationJobListSchema", Some(&Value::Array(values)))
    }
    pub async fn snapshot(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        snapshots::get(Executor::Database(&self.database), owner, id).await
    }
    pub async fn is_attachment_available(&self, attachment: &str, worker: &str) -> Result<bool> {
        Ok(!self.database.query("SELECT attachment_id FROM chat_attachment_replicas WHERE attachment_id=$1 AND worker_id=$2 AND status='ready' LIMIT 1",&[&attachment,&worker]).await?.is_empty())
    }
    pub async fn mark_attachment_available(&self, attachment: &str, worker: &str) -> Result<()> {
        let verified = crate::auth::now();
        let updated = crate::auth::now();
        self.database.query("INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status) VALUES($1,$2,'ready') ON CONFLICT(attachment_id,worker_id) DO UPDATE SET status='ready',verified_at=$3,updated_at=$4",&[&attachment,&worker,&verified,&updated]).await?;
        Ok(())
    }
}
