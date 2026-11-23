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
    let mut value = json!({"id":text("id")?,"projectId":text("projectId")?,"workerId":text("workerId")?,
        "worktreeId":text("worktreeId")?,"stateProtection":row.get::<postgres_types::Json<Value>>(column("protectedState"))?.0,
        "createdAt":crate::auth::iso(row.get::<chrono::DateTime<chrono::Utc>>(column("createdAt"))?)});
    if let Some(binding) = row.get::<Option<String>>(column("cantripOsBindingId"))? {
        value["cantripOsBindingId"] = json!(binding);
        value["cantripOsRuntimeGeneration"] =
            json!(row.get::<String>(column("osRuntimeGeneration"))?);
    }
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
        let (owner, project) = (owner.to_owned(), project.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let os = if let Some(binding) = input["cantripOsBindingId"].as_str() {
                        Some(
                            crate::cantrip_os::files::capture(
                                crate::database::Executor::Transaction(tx),
                                &owner,
                                &project,
                                input["worktreeId"].as_str().unwrap(),
                                binding,
                                input["cantripOsRuntimeGeneration"].as_str().unwrap_or(""),
                            )
                            .await?,
                        )
                    } else {
                        None
                    };
                    if let Some(captured) = &os {
                        bindings["worker"] = Value::from_serialize(&captured["worker_id"]);
                    } else {
                        let targets = Query::new("target", &bindings)?.write(tx).await?;
                        let Some(target) = targets.first() else {
                            return Ok(None);
                        };
                        bindings["worker"] = json!(target.get::<String>(0)?);
                    }
                    let insert = Query::new("insert", &bindings)?;
                    let insert = if let Some(captured) = &os {
                        insert.with_os_capture(captured)?
                    } else {
                        insert
                    };
                    if let Some(row) = insert.write(tx).await?.first() {
                        return summary(row).map(Some);
                    }
                    let rows = Query::new("existing", &bindings)?.write(tx).await?;
                    let Some(row) = rows.first() else {
                        return Err(BindingConflict.into());
                    };
                    if json!(row.get::<Option<String>>(column("cantripOsBindingId"))?)
                        != input
                            .get("cantripOsBindingId")
                            .cloned()
                            .unwrap_or(Value::Null)
                        || json!(row.get::<Option<String>>(column("osRuntimeGeneration"))?)
                            != input
                                .get("cantripOsRuntimeGeneration")
                                .cloned()
                                .unwrap_or(Value::Null)
                        || row.get::<String>(column("workerId"))?
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
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let mut value = summary(row)?;
        let captured = serde_json::json!({
            "binding_id":row.get::<Option<String>>(column("cantripOsBindingId"))?,
            "binding_generation":row.get::<Option<String>>(column("osBindingGeneration"))?,
            "attachment_generation":row.get::<Option<String>>(column("osAttachmentGeneration"))?,
            "runtime_generation":row.get::<Option<String>>(column("osRuntimeGeneration"))?
        });
        value["root"] = crate::cantrip_os::files::root(
            crate::database::Executor::Database(&self.database),
            owner,
            value["projectId"].as_str().unwrap(),
            value["worktreeId"].as_str().unwrap(),
            value["workerId"].as_str().unwrap(),
            &captured,
        )
        .await?;
        Ok(Some(value))
    }
}
