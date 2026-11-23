//! Attach Source ORM diagnostics only after the real native read fails.
use crate::wire::{Value, value::json};
use anyhow::Result;
use std::{collections::HashMap, sync::OnceLock};

pub(super) fn read<T>(result: Result<T>, name: &str, owner: &str, identity: &str) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    static QUERIES: OnceLock<HashMap<String, String>> = OnceLock::new();
    let queries = QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/task-read-queries.json"))
            .expect("generated Task read queries")
    });
    let mut parameters = vec![json!(owner), json!(identity)];
    if name == "get" {
        parameters.push(Value::Number(1.0));
    }
    crate::database::query_error::context(result, &queries[name], &parameters)
}
