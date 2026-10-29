use crate::{
    database::{Database, Row, Transaction, query_error},
    wire::{Value, coercion},
};
use anyhow::Result;
use std::{collections::HashMap, sync::OnceLock};

#[derive(serde::Deserialize)]
struct Manifest {
    columns: Vec<String>,
    queries: HashMap<String, String>,
}
fn manifest() -> &'static Manifest {
    static DATA: OnceLock<Manifest> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("queries.json")).expect("embedded browser queries")
    })
}
pub(super) fn column(key: &str) -> usize {
    manifest()
        .columns
        .iter()
        .position(|v| v == key)
        .expect("browser column")
}
/// Text casts let PostgreSQL perform the actual integer/JSON conversion and
/// report its own failures, including overflow, rather than a client-side gate.
pub(super) struct Query {
    key: &'static str,
    values: Vec<String>,
    types: Vec<&'static str>,
    diagnostic: Vec<Value>,
}
impl Query {
    pub fn new(key: &'static str) -> Self {
        Self {
            key,
            values: vec![],
            types: vec![],
            diagnostic: vec![],
        }
    }
    pub fn bind(mut self, value: Value, kind: &'static str) -> Self {
        let parameter = if kind == "jsonb" {
            Value::String(value.stringify().into())
        } else {
            value
        };
        self.values.push(
            coercion::string(&parameter)
                .expect("scalar browser parameter")
                .lossy()
                .into_owned(),
        );
        self.types.push(kind);
        self.diagnostic.push(parameter);
        self
    }
    fn sql(&self) -> String {
        let mut sql = manifest().queries[self.key].clone();
        for (i, kind) in self.types.iter().enumerate().rev() {
            sql = sql.replace(&format!("${}", i + 1), &format!("${}::text::{kind}", i + 1));
        }
        sql
    }
    fn params(&self) -> Vec<&(dyn postgres_types::ToSql + Sync)> {
        self.values
            .iter()
            .map(|v| v as &(dyn postgres_types::ToSql + Sync))
            .collect()
    }
    pub async fn read(&self, database: &Database) -> Result<Vec<Row>> {
        query_error::context(
            database.query(&self.sql(), &self.params()).await,
            &manifest().queries[self.key],
            &self.diagnostic,
        )
    }
    pub async fn write(&self, tx: &Transaction<'_>) -> Result<Vec<Row>> {
        query_error::context(
            tx.query(&self.sql(), &self.params()).await,
            &manifest().queries[self.key],
            &self.diagnostic,
        )
    }
}
