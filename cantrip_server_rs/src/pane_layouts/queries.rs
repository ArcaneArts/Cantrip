//! Statements captured from the actual TypeScript repository, used natively.
use crate::{
    database::{Executor, Row, query_error},
    wire::Value,
};
use anyhow::{Result, ensure};
use std::{collections::HashMap, sync::OnceLock};

#[derive(serde::Deserialize)]
pub(super) struct Manifest {
    pub columns: HashMap<String, Vec<String>>,
    pub definitions: Vec<Value>,
    queries: HashMap<String, Query>,
}
#[derive(serde::Deserialize)]
struct Query {
    source: String,
    types: Vec<String>,
}
pub(super) fn manifest() -> &'static Manifest {
    static DATA: OnceLock<Manifest> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("queries.json")).expect("pane query manifest")
    })
}
pub(super) fn column(table: &str, field: &str) -> usize {
    manifest().columns[table]
        .iter()
        .position(|k| k == field)
        .expect("pane query column")
}
pub(super) async fn run(
    executor: Executor<'_, '_>,
    key: &str,
    values: &[Value],
) -> Result<Vec<Row>> {
    let query = &manifest().queries[key];
    ensure!(
        query.types.len() == values.len(),
        "Pane query binding count: {key}"
    );
    static PARAMETER: OnceLock<regex::Regex> = OnceLock::new();
    let sql = PARAMETER
        .get_or_init(|| regex::Regex::new(r"\$(\d+)").unwrap())
        .replace_all(&query.source, |c: &regex::Captures<'_>| {
            let index = c[1].parse::<usize>().expect("Source binding index") - 1;
            format!("${}::text::{}", index + 1, query.types[index])
        });
    let diagnostic = values
        .iter()
        .zip(&query.types)
        .map(|(value, kind)| {
            if kind == "jsonb" && !value.is_null() {
                Value::String(value.stringify().into())
            } else {
                value.clone()
            }
        })
        .collect::<Vec<_>>();
    let parameters = diagnostic
        .iter()
        .map(|value| {
            (!value.is_null()).then(|| {
                value
                    .as_js_string()
                    .map_or_else(|| value.stringify(), |s| s.lossy().into_owned())
            })
        })
        .collect::<Vec<_>>();
    let bindings = parameters
        .iter()
        .map(|p| p as &(dyn postgres_types::ToSql + Sync))
        .collect::<Vec<_>>();
    query_error::context(
        executor.query(&sql, &bindings).await,
        &query.source,
        &diagnostic,
    )
}
