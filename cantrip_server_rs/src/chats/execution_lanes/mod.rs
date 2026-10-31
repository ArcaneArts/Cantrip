//! Authoritative execution-lane transitions, including nested command savepoints.
mod branch_leases;
mod mutations;
mod reads;
mod release;
mod restart;
mod start;
mod transitions;
use crate::{
    database::{Database, Executor, Parameters, Row, Transaction, TransactionFuture},
    wire::{self, Value},
};
use anyhow::{Context, Result};
pub use mutations::{finish_in_transaction, update_runtime_in_transaction};
pub use start::start_in_transaction;
use std::sync::Arc;

#[derive(Debug)]
pub enum LaneError {
    Conflict(String),
    Busy(String),
}
impl LaneError {
    pub fn class_name(&self) -> &'static str {
        match self {
            Self::Conflict(_) => "ExecutionLaneConflictError",
            Self::Busy(_) => "ExecutionLaneBusyError",
        }
    }
}
impl std::fmt::Display for LaneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Conflict(s) | Self::Busy(s) => s,
        })
    }
}
impl std::error::Error for LaneError {}
pub(super) fn conflict(message: &str) -> anyhow::Error {
    LaneError::Conflict(message.to_owned()).into()
}
pub(super) fn raw(row: &Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}
pub(super) fn required(rows: &[Row], operation: &str) -> Result<Value> {
    raw(rows
        .first()
        .with_context(|| format!("Database returned no row after {operation}."))?)
}
pub(super) fn text(value: &Value) -> Result<String> {
    value
        .as_js_string()
        .map(|s| s.lossy().into_owned())
        .context("Execution lane identity")
}
pub(super) fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
pub(super) async fn query(
    executor: Executor<'_, '_>,
    sql: &str,
    parameters: Parameters<'_>,
    rendered: &[Value],
) -> Result<Vec<Row>> {
    crate::database::query_error::context(executor.query(sql, parameters).await, sql, rendered)
}
pub(super) fn iso(value: &Value) -> Result<Value> {
    let at = value
        .as_js_string()
        .and_then(wire::date_milliseconds)
        .context("Invalid time value")?;
    Ok(Value::String(
        wire::date_iso_milliseconds(at)
            .context("Invalid time value")?
            .into(),
    ))
}
/// Like the source driver's nested transaction: rollback retains the outer transaction.
pub async fn savepoint<T, F>(tx: &Transaction<'_>, f: F) -> Result<T>
where
    T: Send,
    F: for<'a> FnOnce(&'a Transaction<'_>) -> TransactionFuture<'a, T>,
{
    let name = format!("cantrip_lane_{}", uuid::Uuid::new_v4().simple());
    tx.execute(&format!("SAVEPOINT {name}")).await?;
    match f(tx).await {
        Ok(value) => {
            tx.execute(&format!("RELEASE SAVEPOINT {name}")).await?;
            Ok(value)
        }
        Err(error) => {
            tx.execute(&format!("ROLLBACK TO SAVEPOINT {name}")).await?;
            Err(error)
        }
    }
}
#[derive(Clone)]
pub struct LaneRepository {
    database: Arc<Database>,
}
impl LaneRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
