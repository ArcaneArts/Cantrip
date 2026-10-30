//! Opaque project views and legacy editor resources. Workers retain file access.
mod create;
mod mutations;
mod pin;
mod queries;
use crate::{
    database::{Database, Executor, Row},
    wire::{Value, value::json},
};
use anyhow::Result;
use queries::run;
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Explorer,
    Code,
    View,
}
impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Explorer => "explorer",
            Self::Code => "code",
            Self::View => "view",
        }
    }
    fn table(self) -> &'static str {
        match self {
            Self::Explorer => "explorers",
            Self::Code => "codeTabs",
            Self::View => "projectViews",
        }
    }
    fn key(self, operation: &str) -> String {
        format!("{}_{}", self.prefix(), operation)
    }
}
fn now() -> Value {
    json!(crate::auth::iso(crate::auth::now()))
}
fn summary(row: &Row, kind: Kind) -> Result<Value> {
    let column = |field| queries::column(kind.table(), field);
    let text = |field| row.get::<Option<String>>(column(field)).map(|v| json!(v));
    let mut out = json!({"id":text("id")?,"projectId":text("projectId")?,
        "titleProtection":row.get::<Option<postgres_types::Json<Value>>>(column("protectedLabel"))?.map(|v|v.0),
        "position":row.get::<i32>(column("position"))?,"worktreeId":text("worktreeId")?});
    for field in ["createdAt", "updatedAt"] {
        out[field] = json!(crate::auth::iso(
            row.get::<chrono::DateTime<chrono::Utc>>(column(field))?
        ));
    }
    if kind == Kind::View {
        out["kind"] = text("kind")?;
    } else {
        out["activeWorkerId"] = text("activeWorkerId")?;
    }
    if kind == Kind::Explorer {
        out["stateProtection"] = row
            .get::<Option<postgres_types::Json<Value>>>(column("protectedState"))?
            .map_or(Value::Null, |v| v.0);
        out["fileMode"] = text("fileMode")?;
    }
    Ok(out)
}
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    fn executor(&self) -> Executor<'_, '_> {
        Executor::Database(&self.database)
    }
    pub async fn list(&self, kind: Kind, owner: &str, project: &str) -> Result<Vec<Value>> {
        run(
            self.executor(),
            &kind.key("list"),
            &[json!(owner), json!(project)],
        )
        .await?
        .iter()
        .map(|row| summary(row, kind))
        .collect()
    }
    pub async fn context(&self, kind: Kind, owner: &str, id: &str) -> Result<Option<Value>> {
        if kind == Kind::View {
            return self.selected(kind, owner, id).await;
        }
        let rows = run(
            self.executor(),
            &kind.key("context"),
            &[json!(owner), json!(id), json!(1)],
        )
        .await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let resource = if kind == Kind::Explorer {
            let text = |field| row.get::<String>(queries::column(kind.table(), field));
            json!({"id":text("id")?,"projectId":text("projectId")?,"activeWorkerId":text("activeWorkerId")?})
        } else {
            summary(row, kind)?
        };
        let offset = queries::manifest().columns[kind.table()].len();
        let tree = |field| row.get::<String>(offset + queries::column("projectWorktrees", field));
        Ok(Some(if kind == Kind::Explorer {
            json!({"explorerId":resource["id"],"projectId":resource["projectId"],"root":tree("absolutePath")?,"workerId":resource["activeWorkerId"],"worktreeId":tree("id")?})
        } else {
            json!({"codeTab":resource,"cwd":tree("absolutePath")?,"workerId":resource["activeWorkerId"],"worktreeId":tree("id")?,"worktreeName":tree("name")?})
        }))
    }
    async fn selected(&self, kind: Kind, owner: &str, id: &str) -> Result<Option<Value>> {
        run(
            self.executor(),
            &kind.key("selected"),
            &[json!(owner), json!(id), json!(1)],
        )
        .await?
        .first()
        .map(|row| {
            let text = |field| row.get::<Option<String>>(queries::column(kind.table(), field));
            let mut value = json!({"id":text("id")?,"projectId":text("projectId")?,"worktreeId":text("worktreeId")?});
            if kind == Kind::View {
                value["kind"] = json!(text("kind")?);
            }
            Ok(value)
        })
        .transpose()
    }
    pub async fn view_project(&self, owner: &str, id: &str) -> Result<Option<String>> {
        run(
            self.executor(),
            "view_project",
            &[json!(owner), json!(id), json!(1)],
        )
        .await?
        .first()
        .map(|row| row.get(0))
        .transpose()
    }
}

fn view_definition(kind: &str) -> Result<&'static str> {
    Ok(match kind {
        "history" => "project.git-history",
        "graph" => "project.git-graph",
        "issues" => "project.github-issues",
        "prs" => "project.github-pull-requests",
        "actions" => "project.github-actions",
        "remote-desktop" => "project.remote-desktop",
        _ => anyhow::bail!("Unsupported project view kind"),
    })
}
