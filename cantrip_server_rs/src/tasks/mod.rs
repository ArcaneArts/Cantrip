//! Server-owned Task metadata and opaque worker results. Plaintext stays with
//! the worker; the repository preserves the existing operation/Goal boundary.
pub mod dashboard;
mod dispatch_fence;
mod edits;
pub mod failure_kind;
mod finish;
mod goal_inference_inputs;
mod goal_input_history;
pub(crate) mod goal_observations;
mod inference_inputs;
mod operations;
pub mod policy;
mod query_error;
mod reads;
pub mod relay;
pub mod retries;
mod round_input_history;
mod round_outcomes;
mod rows;
use crate::{
    database::{Database, Executor, Parameters, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
pub use reads::find_operation_round;
use rows::*;
pub(crate) use rows::{summary as opaque_summary, task_columns as opaque_columns};
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
#[derive(Debug)]
pub struct Conflict {
    pub code: &'static str,
    pub message: &'static str,
}
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Conflict {}
fn conflict<T>(code: &'static str, message: &'static str) -> Result<T> {
    Err(Conflict { code, message }.into())
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Task identity")?
        .lossy()
        .into_owned())
}
fn parse(schema: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(schema, Some(value))
}
fn now() -> Value {
    json!(crate::auth::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn increment(value: &Value) -> Value {
    json!(value.as_i64().expect("Persisted Task revision") + 1)
}
