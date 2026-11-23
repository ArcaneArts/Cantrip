//! SQL and parameter order captured from the actual Source repository. Native
//! execution adds typed text bindings and row JSON projection; errors retain
//! the original ORM query and original parameter representations.
use crate::{
    database::{Executor, query_error},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::{collections::HashMap, sync::OnceLock};

#[derive(serde::Deserialize)]
struct Manifest {
    queries: HashMap<String, Query>,
}
#[derive(serde::Deserialize)]
struct Query {
    sql: String,
    bindings: Vec<Binding>,
}
#[derive(serde::Deserialize)]
struct Binding {
    key: Option<String>,
    constant: Option<Value>,
    kind: String,
}
fn manifest() -> &'static Manifest {
    static DATA: OnceLock<Manifest> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("queries.json")).expect("Source automation SQL")
    })
}
pub(super) async fn run(ex: Executor<'_, '_>, name: &str, values: &Value) -> Result<Vec<Value>> {
    let q = manifest()
        .queries
        .get(name)
        .context("Automation SQL operation")?;
    let parameters = q
        .bindings
        .iter()
        .map(|binding| {
            let value = match &binding.key {
                Some(key) => values
                    .get(key)
                    .with_context(|| format!("Automation SQL parameter {name}.{key}"))?
                    .clone(),
                None => binding.constant.clone().unwrap_or(Value::Null),
            };
            Ok(if binding.kind == "jsonb" {
                json!(value.stringify())
            } else {
                value
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let strings = parameters
        .iter()
        .map(|value| {
            if value.is_null() {
                None
            } else {
                Some(
                    value
                        .as_js_string()
                        .map_or_else(|| value.stringify(), |s| s.lossy().into_owned()),
                )
            }
        })
        .collect::<Vec<_>>();
    let bindings = strings
        .iter()
        .map(|s| s as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect::<Vec<_>>();
    let mut sql = String::new();
    let mut at = 0;
    while let Some(start) = q.sql[at..].find('$') {
        let start = at + start;
        sql.push_str(&q.sql[at..start]);
        let end = start
            + 1
            + q.sql[start + 1..]
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
        let index: usize = q.sql[start + 1..end].parse()?;
        sql.push_str(&format!("${index}::text::{}", q.bindings[index - 1].kind));
        at = end;
    }
    sql.push_str(&q.sql[at..]);
    if sql.starts_with("select ") {
        sql = format!(
            "SELECT to_jsonb(automation_source_row)::text FROM ({sql}) automation_source_row"
        );
    } else if sql.contains(" returning ") {
        sql = format!(
            "WITH automation_source_row AS ({sql}) SELECT to_jsonb(automation_source_row)::text FROM automation_source_row"
        );
    }
    query_error::context(ex.query(&sql, &bindings).await, &q.sql, &parameters)?
        .iter()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .collect()
}
pub(super) async fn one(ex: Executor<'_, '_>, name: &str, values: &Value) -> Result<Option<Value>> {
    Ok(run(ex, name, values).await?.into_iter().next())
}
