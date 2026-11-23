//! Exact Source diagnostics for actual MCP effective-policy query failures.
use crate::{database::query_error, wire::value::json};
use anyhow::Result;
use std::{collections::HashMap, sync::OnceLock};

fn sql(name: &str) -> &'static str {
    static QUERIES: OnceLock<HashMap<String, String>> = OnceLock::new();
    &QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/mcp-policy-queries.json"))
            .expect("generated MCP policy queries")
    })[name]
}
pub(super) fn context<T>(result: Result<T>, name: &str, owner: &str, project: &str) -> Result<T> {
    let params = match name {
        "project" => vec![json!(project), json!(owner), json!(1)],
        "eligible" => vec![json!(owner), json!(true), json!("ide"), json!("both")],
        "direct" => vec![json!(project)],
        "workspace" => vec![json!(owner), json!(project)],
        _ => unreachable!("MCP policy query name"),
    };
    query_error::context(result, sql(name), &params)
}
