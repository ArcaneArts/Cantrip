//! Opaque browser state, revision-fenced writes and transactional resource views.
mod queries;
pub mod runtime;
use crate::{
    database::{Database, Row},
    projects::{
        placement::{Connected, PlacementRepository},
        targets::TargetRepository,
    },
    wire::{Value, coercion, value::json},
};
use anyhow::{Context, Result};
use queries::{Query, column};
use std::sync::Arc;

#[derive(Debug)]
pub struct StateConflict;
impl std::fmt::Display for StateConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Browser private state changed before this update.")
    }
}
impl std::error::Error for StateConflict {}

#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
fn summary(row: &Row, worker: Value) -> Result<Value> {
    let text = |name| {
        row.get::<String>(column(name))
            .map(|v| Value::String(v.into()))
    };
    let opaque = |name| {
        row.get::<postgres_types::Json<Value>>(column(name))
            .map(|v| v.0)
    };
    let date = |name| {
        row.get::<chrono::DateTime<chrono::Utc>>(column(name))
            .map(|v| Value::String(crate::auth::iso(v).into()))
    };
    Ok(
        json!({"id":text("id")?,"projectId":text("projectId")?,"titleProtection":opaque("protectedLabel")?,"position":row.get::<i32>(column("position"))?,"stateProtection":opaque("protectedState")?,"stateRevision":row.get::<i32>(column("stateRevision"))?,"workerId":worker,"createdAt":date("createdAt")?,"updatedAt":date("updatedAt")?}),
    )
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn list(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        Query::new("list")
            .bind(json!(owner), "text")
            .bind(json!(project), "text")
            .read(&self.database)
            .await?
            .iter()
            .map(|r| {
                summary(
                    r,
                    r.get::<Option<String>>(8)?
                        .map_or(Value::Null, |v| json!(v)),
                )
            })
            .collect()
    }
    pub async fn owned(&self, owner: &str, id: &str) -> Result<bool> {
        Ok(Query::new("owned")
            .bind(json!(owner), "text")
            .bind(json!(id), "text")
            .bind(json!(1), "bigint")
            .read(&self.database)
            .await?
            .len()
            == 1)
    }
    pub async fn create(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        let placement = PlacementRepository::new(self.database.clone())?
            .resolve(
                owner,
                project,
                "browser",
                input.get("target"),
                connected,
                false,
            )
            .await?;
        let worker = placement["placement"]["workerId"]
            .as_str()
            .context("Browser worker")?
            .to_owned();
        let position = crate::project_layout::next_position(&self.database, project).await?;
        let input = input.clone();
        let project = project.to_owned();
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let rows = Query::new("create")
                        .bind(input["id"].clone(), "text")
                        .bind(json!(project), "text")
                        .bind(input["titleProtection"].clone(), "jsonb")
                        .bind(input["stateProtection"].clone(), "jsonb")
                        .bind(json!(1), "integer")
                        .bind(json!(position), "integer")
                        .write(tx)
                        .await?;
                    let row = rows
                        .first()
                        .context("Database returned no row after creating a browser.")?;
                    let browser = summary(row, json!(worker))?;
                    Query::new("surface_create")
                        .bind(input["id"].clone(), "text")
                        .bind(json!(project), "text")
                        .bind(json!(worker), "text")
                        .bind(json!("browser"), "text")
                        .bind(json!("webrtc"), "text")
                        .bind(json!({"kind":"browser","profileId":Value::Null}), "jsonb")
                        .write(tx)
                        .await?;
                    crate::project_layout::attach_resource(
                        tx,
                        &project,
                        input["id"].as_str().context("Browser identity")?,
                        "browser",
                        &input,
                    )
                    .await?;
                    Ok(Some(browser))
                })
            })
            .await
    }
    pub async fn update(&self, owner: &str, id: &str, input: &Value) -> Result<Option<Value>> {
        if !self.owned(owner, id).await? {
            return Ok(None);
        }
        let context = TargetRepository::new(self.database.clone())
            .remote_execution_context(owner, &json!(id))
            .await?;
        let worker = context.map_or(Value::Null, |c| c["workerId"].clone());
        let title = coercion::truthy(input.get("titleProtection"));
        let state = coercion::truthy(input.get("stateProtection"));
        let expected = input.get("expectedStateRevision").cloned();
        let key = match (title, state, expected.is_some()) {
            (true, true, _) => "update_both",
            (false, true, _) => "update_state",
            (true, false, true) => "update_revision_title",
            (true, false, false) => "update_title",
            _ => "update_empty",
        };
        let mut query = Query::new(key);
        if title {
            query = query.bind(input["titleProtection"].clone(), "jsonb");
        }
        if state {
            query = query.bind(input["stateProtection"].clone(), "jsonb").bind(
                json!(
                    input["expectedStateRevision"]
                        .as_f64()
                        .context("Browser expected revision")?
                        + 1.0
                ),
                "integer",
            );
        }
        query = query
            .bind(json!(crate::auth::iso(crate::auth::now())), "timestamptz")
            .bind(json!(id), "text");
        if let Some(expected) = &expected {
            query = query.bind(expected.clone(), "integer");
        }
        let id = id.to_owned();
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let rows = query.write(tx).await?;
                    let Some(row) = rows.first() else {
                        return if expected.is_some() {
                            Err(StateConflict.into())
                        } else {
                            Ok(None)
                        };
                    };
                    let browser = summary(row, worker)?;
                    Query::new("surface_update")
                        .bind(json!(crate::auth::iso(crate::auth::now())), "timestamptz")
                        .bind(json!(id), "text")
                        .write(tx)
                        .await?;
                    Ok(Some(browser))
                })
            })
            .await
    }
    pub async fn delete(&self, owner: &str, id: &str) -> Result<bool> {
        let Some(context) = TargetRepository::new(self.database.clone())
            .remote_execution_context(owner, &json!(id))
            .await?
        else {
            return Ok(false);
        };
        if context["surface"]["kind"] != "browser" {
            return Ok(false);
        }
        let project = context["surface"]["projectId"]
            .as_str()
            .context("Browser project")?
            .to_owned();
        let owner = owner.to_owned();
        let id = id.to_owned();
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    crate::workspaces::remove_resource(
                        tx,
                        &owner,
                        &project,
                        "project.browser",
                        &id,
                    )
                    .await?;
                    crate::project_layout::detach_resource(tx, &project, "browser", &id).await?;
                    Query::new("surface_delete")
                        .bind(json!(id), "text")
                        .write(tx)
                        .await?;
                    Ok(Query::new("delete")
                        .bind(json!(id), "text")
                        .write(tx)
                        .await?
                        .len()
                        == 1)
                })
            })
            .await
    }
}
