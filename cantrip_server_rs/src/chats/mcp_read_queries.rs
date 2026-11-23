//! Source ORM diagnostics for MCP reads, attached after an actual query failure.
use crate::{database::query_error, wire::value::json};
use anyhow::Result;
use std::{collections::HashMap, sync::OnceLock};

pub(crate) fn sql(name: &str) -> &'static str {
    static QUERIES: OnceLock<HashMap<String, String>> = OnceLock::new();
    &QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/mcp-read-queries.json"))
            .expect("generated MCP read queries")
    })[name]
}
pub(crate) fn headers<T>(
    result: Result<T>,
    owner: &str,
    chat: &str,
    before: Option<i64>,
) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    let mut params = vec![json!("agent"), json!(owner), json!(chat)];
    if let Some(before) = before {
        params.push(json!(before));
    }
    params.push(json!(501));
    query_error::context(
        result,
        sql(if before.is_some() {
            "headersBefore"
        } else {
            "headers"
        }),
        &params,
    )
}
pub(crate) fn rows<T>(result: Result<T>, owner: &str, chat: &str, sequences: &[i64]) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    let placeholders = (0..sequences.len())
        .map(|index| format!("${}", index + 4))
        .collect::<Vec<_>>()
        .join(", ");
    let query = sql("rows").replace("__mcp_sequence_parameters__", &placeholders);
    let mut params = vec![json!("agent"), json!(owner), json!(chat)];
    params.extend(sequences.iter().map(|sequence| json!(sequence)));
    query_error::context(result, &query, &params)
}
