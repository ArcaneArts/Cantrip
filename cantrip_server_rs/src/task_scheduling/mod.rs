//! Durable Task Worker configuration and project scheduling policy.
pub mod automatic_retry;
pub mod claimed_execution;
mod continuity;
pub mod eligibility;
pub mod operation_queue;
mod pause;
pub mod project_pause;
pub mod resumed_execution;
pub mod scheduler;
mod workers;
use crate::task_dispatch::{model_configuration, worker_summary};
use crate::{
    database::{Database, Executor, Parameters},
    wire::{JsString, Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
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
        .context("Task scheduling text")?
        .lossy()
        .into_owned())
}
fn parse(name: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(name, Some(value))
}
fn now() -> Value {
    json!(crate::auth::iso(crate::auth::now()))
}
fn storage(mut fields: Value) -> Value {
    if let Value::Object(object) = &mut fields {
        for value in object.values_mut() {
            if let Some(s) = value.as_js_string() {
                *value = json!(s.lossy().into_owned());
            }
        }
    }
    fields
}
async fn all(ex: Executor<'_, '_>, sql: &str, params: Parameters<'_>) -> Result<Vec<Value>> {
    ex.query(sql, params)
        .await?
        .iter()
        .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
        .collect()
}
async fn one(ex: Executor<'_, '_>, sql: &str, params: Parameters<'_>) -> Result<Option<Value>> {
    Ok(all(ex, sql, params).await?.into_iter().next())
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
