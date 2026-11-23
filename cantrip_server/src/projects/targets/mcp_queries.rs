//! Source diagnostics attach only after the corresponding native read fails.
use crate::{
    database::query_error,
    wire::{Value, value::json},
};
use anyhow::Result;
use serde::Deserialize;
use std::{collections::HashMap, sync::OnceLock};

#[derive(Deserialize)]
struct Query {
    sql: String,
    params: Vec<Value>,
}
pub(crate) fn context<T>(result: Result<T>, key: &str, owner: &str, id: &Value) -> Result<T> {
    context_scope(result, key, owner, None, id)
}
pub(crate) fn context_in_project<T>(
    result: Result<T>,
    key: &str,
    owner: &str,
    project: &str,
    id: &Value,
) -> Result<T> {
    context_scope(result, key, owner, Some(project), id)
}
fn context_scope<T>(
    result: Result<T>,
    key: &str,
    owner: &str,
    project: Option<&str>,
    id: &Value,
) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    static QUERIES: OnceLock<HashMap<String, Query>> = OnceLock::new();
    let query = &QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/mcp-target-queries.json"))
            .expect("captured Source MCP target statements")
    })[key];
    let params = query
        .params
        .iter()
        .map(|value| {
            if value == "fixture-owner" {
                json!(owner)
            } else if value == "fixture-target" {
                id.clone()
            } else if value == "fixture-project" && project.is_some() {
                json!(project)
            } else {
                value.clone()
            }
        })
        .collect::<Vec<_>>();
    query_error::context(result, &query.sql, &params)
}
