//! Exact source-selected columns, including mapper failures and SQL diagnostics.
use crate::{
    database::{Database, query_error},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    source_columns: Vec<String>,
    worktree_columns: Vec<String>,
    queries: HashMap<String, Query>,
}
#[derive(serde::Deserialize)]
struct Query {
    source: String,
    array: String,
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
        serde_json::from_str(include_str!("queries.json"))
            .expect("embedded project-share context queries")
    })
}
pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn read(
        &self,
        key: &str,
        project: &str,
        owner: &str,
        target: &Value,
    ) -> Result<Option<Value>> {
        let query = &manifest().queries[key];
        let diagnostic = query
            .bindings
            .iter()
            .map(|b| match b.key.as_deref() {
                Some("project") => json!(project),
                Some("owner") => json!(owner),
                Some("target") => target.clone(),
                _ => b.constant.clone().unwrap_or(Value::Null),
            })
            .collect::<Vec<_>>();
        let values = diagnostic
            .iter()
            .map(|v| {
                v.as_js_string()
                    .map_or_else(|| v.stringify(), |s| s.lossy().into_owned())
            })
            .collect::<Vec<_>>();
        let parameters = values
            .iter()
            .map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync))
            .collect::<Vec<_>>();
        let mut sql = query.array.clone();
        for (i, b) in query.bindings.iter().enumerate().rev() {
            sql = sql.replace(
                &format!("${}", i + 1),
                &format!("${}::text::{}", i + 1, b.kind),
            );
        }
        let rows = query_error::context(
            self.database.query(&sql, &parameters).await,
            &query.source,
            &diagnostic,
        )?;
        rows.first()
            .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
            .transpose()
    }
    pub async fn source(
        &self,
        owner: &str,
        project: &str,
        worker: &Value,
    ) -> Result<Option<Value>> {
        let Some(value) = self.read("source", project, owner, worker).await? else {
            return Ok(None);
        };
        let a = value.as_array().context("Share source columns")?;
        Ok(Some(
            json!({"projectReplicaId":a[0],"workerId":a[1],"cwd":a[2],"worktreeId":a[3]}),
        ))
    }
    pub async fn worktree(&self, owner: &str, project: &str, id: &Value) -> Result<Option<Value>> {
        let Some(value) = self.read("worktree", project, owner, id).await? else {
            return Ok(None);
        };
        let array = value.as_array().context("Share worktree columns")?;
        let columns = &manifest().source_columns;
        let trees = &manifest().worktree_columns;
        let source = Value::object(
            columns
                .iter()
                .enumerate()
                .map(|(i, k)| (k.as_str(), array[1 + i].clone())),
        );
        let tree = Value::object(
            trees
                .iter()
                .enumerate()
                .map(|(i, k)| (k.as_str(), array[1 + columns.len() + i].clone())),
        );
        let summary = crate::projects::targets::worktree_summary(&tree, project).map_err(|e| {
            if e.to_string() == "Invalid stored resource date" {
                anyhow::anyhow!("Invalid time value")
            } else {
                e
            }
        })?;
        Ok(Some(
            json!({"projectId":array[0],"projectSourceId":source["id"],"sourcePath":source["absolute_path"],"workerId":tree["worker_id"],"worktree":summary}),
        ))
    }
}
