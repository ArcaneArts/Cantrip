//! Canonical worker history ownership is independent of live execution authority.
mod archive;
mod attachments;
mod attribution;
mod bindings;
pub mod delivery;
mod digest;
mod ingest;
mod input_alias;
mod items;
mod messages;
mod output_alias;
mod publications;
mod queue_alias;
mod turns;
mod usage;
pub use ingest::BatchRejection;
pub use usage::reconcile as reconcile_usage;
mod references;
pub use crate::chats::message_writes::HistoryError;
use crate::{
    database::{Database, Parameters, Transaction},
    wire::Value,
};
use anyhow::{Context, Result};
pub use digest::payload_digest;
use std::sync::Arc;

#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
fn text(value: &Value) -> Result<String> {
    value
        .as_js_string()
        .map(|s| s.lossy().into_owned())
        .context("Native history identity")
}
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
fn reject<T>(code: &'static str, status: u16) -> Result<T> {
    Err(HistoryError::new(code, status).into())
}
async fn one(
    tx: &Transaction<'_>,
    query: &str,
    parameters: Parameters<'_>,
) -> Result<Option<Value>> {
    tx.query(query, parameters)
        .await?
        .first()
        .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
        .transpose()
}

async fn all(tx: &Transaction<'_>, query: &str, parameters: Parameters<'_>) -> Result<Vec<Value>> {
    tx.query(query, parameters)
        .await?
        .iter()
        .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
        .collect()
}
