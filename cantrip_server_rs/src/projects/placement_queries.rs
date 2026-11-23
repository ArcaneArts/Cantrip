//! Preserve Source diagnostics only after the corresponding native query fails.
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
pub(super) fn context<T>(result: Result<T>, key: &str, owner: &str, project: &str) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    static QUERIES: OnceLock<HashMap<String, Query>> = OnceLock::new();
    let query = &QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../contracts/project-placement-queries.json"
        ))
        .expect("captured project placement statements")
    })[key];
    let params = query
        .params
        .iter()
        .map(|value| {
            if value == "fixture-owner" {
                json!(owner)
            } else if value == "fixture-project" {
                json!(project)
            } else {
                value.clone()
            }
        })
        .collect::<Vec<_>>();
    query_error::context(result, &query.sql, &params)
}
