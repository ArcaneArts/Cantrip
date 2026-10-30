//! Source-selected statements, bindings and diagnostics for document authority.
use crate::{
    database::{Database, Row, Transaction, query_error},
    wire::Value,
};
use anyhow::{Context, Result};
use std::{collections::HashMap, sync::OnceLock};
#[derive(serde::Deserialize)]
struct Manifest {
    columns: Vec<String>,
    queries: HashMap<String, Recorded>,
}
#[derive(serde::Deserialize)]
struct Recorded {
    source: String,
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
        serde_json::from_str(include_str!("queries.json")).expect("document query manifest")
    })
}
pub(super) fn column(key: &str) -> usize {
    manifest()
        .columns
        .iter()
        .position(|k| k == key)
        .expect("document column")
}
pub(super) fn width() -> usize {
    manifest().columns.len()
}
pub(super) struct Query {
    key: &'static str,
    sql: String,
    values: Vec<String>,
    diagnostic: Vec<Value>,
}
impl Query {
    pub fn new(key: &'static str, fields: &Value) -> Result<Self> {
        let recorded = &manifest().queries[key];
        let mut sql = recorded.source.clone();
        let mut values = Vec::new();
        let mut diagnostic = Vec::new();
        for (i, binding) in recorded.bindings.iter().enumerate().rev() {
            sql = sql.replace(
                &format!("${}", i + 1),
                &format!("${}::text::{}", i + 1, binding.kind),
            );
        }
        for binding in &recorded.bindings {
            let value = match &binding.key {
                Some(key) => fields.get(key).context("document query binding")?.clone(),
                None => binding.constant.clone().unwrap_or(Value::Null),
            };
            let value = if binding.kind == "jsonb" {
                Value::String(value.stringify().into())
            } else {
                value
            };
            values.push(
                value
                    .as_js_string()
                    .map_or_else(|| value.stringify(), |s| s.lossy().into_owned()),
            );
            diagnostic.push(value);
        }
        Ok(Self {
            key,
            sql,
            values,
            diagnostic,
        })
    }
    fn params(&self) -> Vec<&(dyn postgres_types::ToSql + Sync)> {
        self.values
            .iter()
            .map(|s| s as &(dyn postgres_types::ToSql + Sync))
            .collect()
    }
    pub async fn read(&self, db: &Database) -> Result<Vec<Row>> {
        query_error::context(
            db.query(&self.sql, &self.params()).await,
            &manifest().queries[self.key].source,
            &self.diagnostic,
        )
    }
    pub async fn write(&self, tx: &Transaction<'_>) -> Result<Vec<Row>> {
        query_error::context(
            tx.query(&self.sql, &self.params()).await,
            &manifest().queries[self.key].source,
            &self.diagnostic,
        )
    }
}
