//! Immutable document locations. File content and paths remain endpoint-protected.
mod queries;
use crate::{
    database::{Database, Row},
    wire::{Value, value::json},
};
use anyhow::Result;
use queries::{Query, column};
use std::sync::Arc;

#[derive(Debug)]
pub struct BindingConflict;
impl std::fmt::Display for BindingConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("File document identity already exists with a different binding.")
    }
}
impl std::error::Error for BindingConflict {}
pub struct Repository {
    database: Arc<Database>,
}
fn summary(row: &Row) -> Result<Value> {
    let text = |key| row.get::<String>(column(key));
    let value = json!({"id":text("id")?,"projectId":text("projectId")?,"workerId":text("workerId")?,
        "worktreeId":text("worktreeId")?,"stateProtection":row.get::<postgres_types::Json<Value>>(column("protectedState"))?.0,
        "createdAt":crate::auth::iso(row.get::<chrono::DateTime<chrono::Utc>>(column("createdAt"))?)});
    crate::settings::parse_response("fileDocumentWireSummarySchema", Some(&value))
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn list(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        Query::new("list", &json!({"owner":owner,"project":project}))?
            .read(&self.database)
            .await?
            .iter()
            .map(summary)
            .collect()
    }
    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        Query::new("get", &json!({"owner":owner,"id":id}))?
            .read(&self.database)
            .await?
            .first()
            .map(summary)
            .transpose()
    }
    pub async fn create(&self, owner: &str, project: &str, input: &Value) -> Result<Option<Value>> {
        let input = crate::settings::parse_response("fileDocumentCreateSchema", Some(input))?;
        let mut bindings = json!({"owner":owner,"project":project,"id":input["id"],
            "worktree":input["worktreeId"],"state":input["stateProtection"]});
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let targets = Query::new("target", &bindings)?.write(tx).await?;
                    let Some(target) = targets.first() else {
                        return Ok(None);
                    };
                    bindings["worker"] = json!(target.get::<String>(0)?);
                    if let Some(row) = Query::new("insert", &bindings)?.write(tx).await?.first() {
                        return summary(row).map(Some);
                    }
                    let rows = Query::new("existing", &bindings)?.write(tx).await?;
                    let Some(row) = rows.first() else {
                        return Err(BindingConflict.into());
                    };
                    if row.get::<String>(column("workerId"))?
                        != bindings["worker"].as_str().unwrap()
                        || json!(row.get::<String>(column("worktreeId"))?) != input["worktreeId"]
                        || row
                            .get::<postgres_types::Json<Value>>(column("protectedState"))?
                            .0
                            != input["stateProtection"]
                    {
                        return Err(BindingConflict.into());
                    }
                    summary(row).map(Some)
                })
            })
            .await
    }
    pub async fn execution_context(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows = Query::new("context", &json!({"owner":owner,"id":id}))?
            .read(&self.database)
            .await?;
        rows.first()
            .map(|row| {
                let mut value = summary(row)?;
                value["root"] = json!(row.get::<String>(queries::width())?);
                Ok(value)
            })
            .transpose()
    }
}
