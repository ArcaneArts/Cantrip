//! Build-time capture of the reference helpers' SQL. No JavaScript at runtime.
use crate::wire::Value;
use anyhow::Result;
use std::{collections::HashMap, sync::OnceLock};

#[derive(serde::Deserialize)]
struct Captured {
    queries: HashMap<String, String>,
    columns: HashMap<String, usize>,
}
fn captured() -> &'static Captured {
    static QUERIES: OnceLock<Captured> = OnceLock::new();
    QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("resource_layout_queries.json"))
            .expect("embedded resource layout queries")
    })
}
pub(crate) fn sql(key: &str) -> &'static str {
    &captured().queries[key]
}
pub(crate) fn column(key: &str) -> usize {
    captured().columns[key]
}
pub(crate) fn context<T>(key: &str, result: Result<T>, params: &[Value]) -> Result<T> {
    super::query_error::context(result, sql(key), params)
}
