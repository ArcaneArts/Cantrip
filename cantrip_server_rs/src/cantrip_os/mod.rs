//! Optional guest execution remains an arm of the owning worker.
pub mod chats;
mod control;
pub mod coordinator;
pub mod files;
mod sources;
use crate::database::{Database, Parameters, Row};
use anyhow::{Context, Result};
use serde_json::Value;
use std::sync::Arc;

pub struct Repository {
    pub database: Arc<Database>,
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("Invalid CantripOS identity")
}
pub(super) fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub(super) fn decode(rows: Vec<Row>) -> Result<Vec<Value>> {
    rows.into_iter()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .collect()
}
pub(super) fn checked(schema: &str, value: Value) -> Result<Value> {
    let wire =
        crate::settings::parse_response(schema, Some(&crate::wire::Value::from_serialize(&value)))?;
    Ok(serde_json::from_str(&wire.stringify())?)
}
fn camel(key: &str) -> String {
    let mut words = key.split('_');
    let mut result = words.next().unwrap_or_default().to_owned();
    for word in words {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            result.extend(first.to_uppercase());
            result.extend(chars);
        }
    }
    result
}
pub(super) fn summary(raw: &Value, kind: &str, parent: Option<&str>) -> Result<Value> {
    let fields: &[&str] = match kind {
        "instance" => &[
            "id",
            "owner_id",
            "worker_id",
            "guest_instance_id",
            "attachment_generation",
            "name",
            "status",
            "runtime_generation",
            "last_error",
            "last_observed_at",
            "created_at",
            "updated_at",
        ],
        "workspace" => &[
            "id",
            "instance_id",
            "guest_workspace_id",
            "uid",
            "gid",
            "home_guest_path",
            "created_at",
            "updated_at",
        ],
        "binding" => &[
            "id",
            "owner_id",
            "project_id",
            "worker_id",
            "project_source_id",
            "worktree_id",
            "workspace_id",
            "mode",
            "linked_worker_path",
            "guest_path",
            "binding_generation",
            "provisioned_attachment_generation",
            "provisioned_runtime_generation",
            "state",
            "last_error",
            "dependency_overlays",
            "created_at",
            "updated_at",
        ],
        _ => anyhow::bail!("Unknown CantripOS summary"),
    };
    let mut result = serde_json::Map::new();
    for key in fields {
        let mut value = raw[*key].clone();
        if key.ends_with("_at")
            && let Some(date) = value.as_str()
        {
            value = Value::String(
                chrono::DateTime::parse_from_rfc3339(date)?
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            );
        }
        result.insert(camel(key), value);
    }
    if let Some(parent) = parent {
        result.insert(
            if kind == "workspace" {
                "workerId"
            } else {
                "instanceId"
            }
            .into(),
            Value::String(parent.into()),
        );
    }
    checked(
        match kind {
            "instance" => "cantripOsInstanceSummarySchema",
            "workspace" => "cantripOsWorkspaceSummarySchema",
            _ => "cantripOsSourceBindingSummarySchema",
        },
        Value::Object(result),
    )
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn rows(&self, sql: &str, parameters: Parameters<'_>) -> Result<Vec<Value>> {
        decode(self.database.query(sql, parameters).await?)
    }
    pub async fn owned_worker(&self, owner: &str, worker: &str) -> Result<()> {
        anyhow::ensure!(
            !self
                .database
                .query(
                    "SELECT id FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL",
                    &[&worker, &owner]
                )
                .await?
                .is_empty(),
            "Owning worker not found."
        );
        Ok(())
    }
    pub async fn list(&self, owner: &str) -> Result<Vec<Value>> {
        self.rows("SELECT to_jsonb(i)::text FROM cantrip_os_instances i WHERE owner_id=$1 ORDER BY created_at,id", &[&owner]).await?.iter().map(|v|summary(v,"instance",None)).collect()
    }
    pub async fn attachment(&self, owner: &str, id: &str) -> Result<Value> {
        let rows=self.rows("SELECT to_jsonb(i)::text FROM cantrip_os_instances i JOIN workers w ON w.id=i.worker_id AND w.owner_id=$1 AND w.unlinked_at IS NULL WHERE i.owner_id=$1 AND i.id=$2", &[&owner,&id]).await?;
        let row = rows.first().context("OS attachment not found.")?;
        Ok(
            serde_json::json!({"instance":summary(row,"instance",None)?,"transport":row["transport"]}),
        )
    }
    pub async fn workspaces(&self, owner: &str, id: &str) -> Result<Vec<Value>> {
        let rows=self.rows("SELECT jsonb_build_object('workspace',to_jsonb(w),'worker',i.worker_id)::text FROM cantrip_os_workspaces w JOIN cantrip_os_instances i ON i.id=w.instance_id WHERE i.owner_id=$1 AND i.id=$2 ORDER BY w.created_at,w.id", &[&owner,&id]).await?;
        rows.iter()
            .map(|v| summary(&v["workspace"], "workspace", Some(text(v, "worker")?)))
            .collect()
    }
    pub async fn bindings(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        let rows=self.rows("SELECT jsonb_build_object('binding',to_jsonb(b),'instance',w.instance_id)::text FROM cantrip_os_source_bindings b JOIN cantrip_os_workspaces w ON w.id=b.workspace_id WHERE b.owner_id=$1 AND b.project_id=$2 AND b.retired_at IS NULL ORDER BY b.created_at,b.id", &[&owner,&project]).await?;
        rows.iter()
            .map(|v| summary(&v["binding"], "binding", Some(text(v, "instance")?)))
            .collect()
    }
    pub async fn context(&self, owner: &str, project: &str, id: &str) -> Result<Value> {
        Self::context_with(
            crate::database::Executor::Database(&self.database),
            owner,
            project,
            id,
        )
        .await
    }
    pub(crate) async fn context_with(
        ex: crate::database::Executor<'_, '_>,
        owner: &str,
        project: &str,
        id: &str,
    ) -> Result<Value> {
        let rows=decode(ex.query("SELECT jsonb_build_object('binding',to_jsonb(b),'instance',to_jsonb(i),'workspace',to_jsonb(w),'sourceKind',COALESCE(s.source_kind,l.source_kind),'local',to_jsonb(s),'linux',to_jsonb(l),'worktree',to_jsonb(t))::text FROM cantrip_os_source_bindings b JOIN cantrip_os_workspaces w ON w.id=b.workspace_id JOIN cantrip_os_instances i ON i.id=w.instance_id JOIN workers a ON a.id=b.worker_id AND a.owner_id=$1 AND a.unlinked_at IS NULL JOIN project_worktrees t ON t.id=b.worktree_id LEFT JOIN project_sources s ON s.id=b.project_source_id LEFT JOIN cantrip_os_project_sources l ON l.id=b.project_source_id WHERE b.id=$2 AND b.owner_id=$1 AND b.project_id=$3 AND b.retired_at IS NULL", &[&owner,&id,&project]).await?)?;
        let row = rows.first().context("Source binding not found.")?;
        let b = &row["binding"];
        let i = &row["instance"];
        let t = &row["worktree"];
        anyhow::ensure!(
            t["project_source_id"] == b["project_source_id"] && t["worker_id"] == b["worker_id"],
            "Source placement changed."
        );
        let details = if b["mode"] == "linked" {
            &row["local"]
        } else {
            &row["linux"]
        };
        anyhow::ensure!(
            !details.is_null() && details["removed_at"].is_null(),
            "Source details are unavailable."
        );
        anyhow::ensure!(
            if b["mode"] == "linked" {
                b["linked_worker_path"] == t["absolute_path"] && i["transport"]["kind"] == "docker"
            } else {
                b["guest_path"] == t["guest_path"]
            },
            "Source location changed."
        );
        Ok(
            serde_json::json!({"binding":summary(b,"binding",Some(text(i,"id")?))?,"instance":summary(i,"instance",None)?,"workspace":summary(&row["workspace"],"workspace",Some(text(i,"worker_id")?))?,"transport":i["transport"],"sourceKind":row["sourceKind"]}),
        )
    }
}
