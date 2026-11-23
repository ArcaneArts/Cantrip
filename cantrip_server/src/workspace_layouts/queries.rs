//! Actual Source statements, positional bindings and diagnostic identities.
use crate::{
    database::{Executor, Row, Transaction, query_error},
    wire::Value,
};
use anyhow::{Context, Result};
use std::{collections::HashMap, sync::OnceLock};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    columns: HashMap<String, Vec<String>>,
    queries: HashMap<String, Recorded>,
    surface_definitions: Vec<Definition>,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Definition {
    pub id: String,
    pub supported_placements: Vec<String>,
    pub tab_kind: Option<String>,
}
#[derive(Clone, serde::Deserialize)]
struct Recorded {
    source: String,
    bindings: Vec<Binding>,
}
#[derive(Clone, serde::Deserialize)]
struct Binding {
    key: Option<String>,
    constant: Option<Value>,
    document: Option<usize>,
    kind: String,
}
fn manifest() -> &'static Manifest {
    static DATA: OnceLock<Manifest> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("queries.json")).expect("workspace query manifest")
    })
}
pub(super) fn definition(id: &Value) -> Option<&'static Definition> {
    manifest()
        .surface_definitions
        .iter()
        .find(|d| id == d.id.as_str())
}
pub(super) fn column(table: &str, key: &str) -> usize {
    manifest().columns[table]
        .iter()
        .position(|k| k == key)
        .expect("workspace query column")
}
pub(super) struct Query {
    source: String,
    sql: String,
    parameters: Vec<Option<String>>,
    diagnostic: Vec<Value>,
}
impl Query {
    pub fn new(key: &str, fields: &Value) -> Result<Self> {
        Self::recorded(manifest().queries[key].clone(), fields)
    }
    pub fn documents(fields: &Value) -> Result<Self> {
        let ids = fields["documents"]
            .as_array()
            .context("Migration document bindings")?;
        let mut recorded = manifest().queries["migration_documents_1"].clone();
        let first = recorded
            .bindings
            .iter()
            .position(|b| b.document.is_some())
            .expect("Source document binding");
        let positions = (first + 1..first + 1 + ids.len())
            .map(|n| format!("${n}"))
            .collect::<Vec<_>>()
            .join(", ");
        recorded.source = recorded.source.replace(
            &format!("in (${})", first + 1),
            &format!("in ({positions})"),
        );
        let binding = recorded.bindings[first].clone();
        recorded.bindings.truncate(first);
        recorded
            .bindings
            .extend((0..ids.len()).map(|index| Binding {
                document: Some(index),
                ..binding.clone()
            }));
        Self::recorded(recorded, fields)
    }
    fn recorded(recorded: Recorded, fields: &Value) -> Result<Self> {
        static PARAMETER: OnceLock<regex::Regex> = OnceLock::new();
        let sql = PARAMETER
            .get_or_init(|| regex::Regex::new(r"\$(\d+)").unwrap())
            .replace_all(&recorded.source, |c: &regex::Captures<'_>| {
                let at = c[1].parse::<usize>().expect("Source parameter index");
                format!("${at}::text::{}", recorded.bindings[at - 1].kind)
            })
            .into_owned();
        let mut parameters = Vec::new();
        let mut diagnostic = Vec::new();
        for binding in recorded.bindings {
            let value = if let Some(key) = binding.key {
                fields.get(&key).context("Workspace query binding")?.clone()
            } else if let Some(index) = binding.document {
                fields["documents"]
                    .as_array()
                    .and_then(|v| v.get(index))
                    .context("Workspace document binding")?
                    .clone()
            } else {
                binding.constant.unwrap_or(Value::Null)
            };
            let value = if binding.kind == "jsonb" {
                Value::String(value.stringify().into())
            } else {
                value
            };
            parameters.push(if value.is_null() {
                None
            } else {
                Some(
                    value
                        .as_js_string()
                        .map_or_else(|| value.stringify(), |s| s.lossy().into_owned()),
                )
            });
            diagnostic.push(value);
        }
        Ok(Self {
            source: recorded.source,
            sql,
            parameters,
            diagnostic,
        })
    }
    pub async fn run(&self, tx: &Transaction<'_>) -> Result<Vec<Row>> {
        self.run_on(Executor::Transaction(tx)).await
    }
    pub async fn run_on(&self, executor: Executor<'_, '_>) -> Result<Vec<Row>> {
        let parameters = self
            .parameters
            .iter()
            .map(|v| v as &(dyn postgres_types::ToSql + Sync))
            .collect::<Vec<_>>();
        query_error::context(
            executor.query(&self.sql, &parameters).await,
            &self.source,
            &self.diagnostic,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::value::json;
    #[test]
    fn variable_document_bindings_match_actual_source_including_two_digit_positions() -> Result<()>
    {
        for count in [1, 2, 3, 11] {
            let documents = (0..count)
                .map(|i| json!(format!("document-{i}")))
                .collect::<Vec<_>>();
            let fields = json!({"owner":"owner","project":"project","documents":documents});
            let query = Query::documents(&fields)?;
            let actual = &manifest().queries[&format!("migration_documents_{count}")];
            assert_eq!(query.source, actual.source);
            assert_eq!(query.diagnostic.len(), actual.bindings.len());
            for i in 1..=query.parameters.len() {
                assert!(query.sql.contains(&format!("${i}::text::text")));
            }
        }
        Ok(())
    }
}
