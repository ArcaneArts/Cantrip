//! Source transition diagnostics are attached only after the real write fails.
use crate::{database::query_error, wire::Value};
use anyhow::Result;
use std::sync::OnceLock;

pub(super) fn context<T>(result: Result<T>, name: &str, fields: &Value) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    static QUERIES: OnceLock<Value> = OnceLock::new();
    let queries = QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/mcp-worktree-queries.json"))
            .expect("generated MCP worktree transition queries")
    });
    let query = &queries[name];
    let params = query["parameters"]
        .as_array()
        .expect("generated query parameters")
        .iter()
        .map(|column| {
            fields
                .get(column.as_str().expect("query column"))
                .expect("transition diagnostic field")
                .clone()
        })
        .collect::<Vec<_>>();
    query_error::context(
        result,
        query["sql"].as_str().expect("generated query SQL"),
        &params,
    )
}
