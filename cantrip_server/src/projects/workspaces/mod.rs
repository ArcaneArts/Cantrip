//! Encrypted workspace catalog and immutable workspace membership lifecycle.
mod listing;
mod mutations;
pub mod project_cleanup;
mod queries;
mod removal;
use crate::{
    database::{Database, Executor, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

#[derive(Clone)]
pub struct WorkspaceRepository {
    pub database: Arc<Database>,
}
#[derive(Debug)]
pub struct WorkspaceInvariant(pub String);
impl std::fmt::Display for WorkspaceInvariant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for WorkspaceInvariant {}
fn invariant(message: impl Into<String>) -> WorkspaceInvariant {
    WorkspaceInvariant(message.into())
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Workspace SQL text")?
        .lossy()
        .into_owned())
}
fn raw(row: &Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}
fn date(value: &Value) -> Result<Value> {
    let ms = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid workspace date")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(ms).context("Invalid workspace date")?
    ))
}
fn summary(workspace: &Value, storage: &Value, projects: Vec<Value>) -> Result<Value> {
    if workspace["name_envelope"].is_null() {
        anyhow::ensure!(
            workspace["id"]
                == json!(format!(
                    "workspace:default:{}",
                    text(&workspace["owner_id"])?
                ))
                && [
                    "name_format_version",
                    "name_key_revision",
                    "name_blind_index"
                ]
                .iter()
                .all(|key| workspace[key].is_null()),
            invariant("Only the deterministic system-default workspace may omit name ciphertext.")
        );
    } else {
        anyhow::ensure!(
            workspace["name_format_version"] == 1
                && !workspace["name_key_revision"].is_null()
                && !workspace["name_blind_index"].is_null()
                && workspace["name_envelope"]["keyRevision"] == workspace["name_key_revision"],
            invariant("Encrypted workspace name metadata is incomplete.")
        );
    }
    let name = if workspace["name_envelope"].is_null() {
        json!({"state":"system-default"})
    } else {
        json!({"state":"encrypted","formatVersion":1,"keyRevision":workspace["name_key_revision"],"blindIndex":workspace["name_blind_index"],"envelope":workspace["name_envelope"]})
    };
    let storage = if storage["kind"] == "attached" {
        json!({"kind":"attached","workerId":storage["worker_id"],"rootPathHandle":storage["protected_root_path_handle"],"displayHandle":storage["protected_display_handle"]})
    } else {
        json!({"kind":storage["kind"]})
    };
    Ok(
        json!({"id":workspace["id"],"nameProtection":name,"storage":storage,"position":workspace["position"],"isDefault":workspace["is_default"],"projectIds":projects,"revision":workspace["revision"],"createdAt":date(&workspace["created_at"])?,"updatedAt":date(&workspace["updated_at"])?}),
    )
}
impl WorkspaceRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
