//! Read server-owned legacy placement, including its original invariant checks.
use super::{
    parse,
    queries::{self, Query},
};
use crate::{
    database::{Executor, Row, Transaction},
    wire::{JsString, Value, value::json},
};
use anyhow::Result;
use std::{
    collections::{HashMap, HashSet},
    fmt,
};

#[derive(Debug)]
pub struct Invariant(pub String);
impl fmt::Display for Invariant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Invariant {}
fn failure(message: &str) -> anyhow::Error {
    Invariant(message.into()).into()
}
fn text(row: &Row, table: &str, key: &str) -> Result<String> {
    row.get(queries::column(table, key))
}
fn opaque(row: &Row, table: &str, key: &str) -> Result<Value> {
    Ok(row
        .get::<Option<postgres_types::Json<Value>>>(queries::column(table, key))?
        .map(|v| v.0)
        .unwrap_or(Value::Null))
}
fn at(row: &Row, table: &str, key: &str) -> Result<String> {
    Ok(crate::auth::iso(row.get::<chrono::DateTime<chrono::Utc>>(
        queries::column(table, key),
    )?))
}
async fn read(executor: Executor<'_, '_>, key: &str, fields: &Value) -> Result<Vec<Row>> {
    Query::new(key, fields)?.run_on(executor).await
}

pub(super) async fn get(tx: &Transaction<'_>, fields: &Value) -> Result<Option<Value>> {
    get_on(Executor::Transaction(tx), fields).await
}
pub(super) async fn get_on(executor: Executor<'_, '_>, fields: &Value) -> Result<Option<Value>> {
    loop {
        let projects = read(executor, "legacy_project", fields).await?;
        let Some(project) = projects.first() else {
            return Ok(None);
        };
        let root = project
            .get::<Option<postgres_types::Json<Value>>>(2)?
            .map(|v| v.0)
            .unwrap_or(Value::Null);
        let revision = project.get::<i32>(1)?;
        let (panes, members, chats, terminals, explorers, browsers, code, views, builtins, docks) =
            tokio::try_join!(
                read(executor, "legacy_tabGroups", fields),
                read(executor, "legacy_tabGroupMembers", fields),
                read(executor, "legacy_chats", fields),
                read(executor, "legacy_terminals", fields),
                read(executor, "legacy_explorers", fields),
                read(executor, "legacy_browsers", fields),
                read(executor, "legacy_codeTabs", fields),
                read(executor, "legacy_projectViews", fields),
                read(executor, "legacy_projectBuiltInSurfaceStates", fields),
                read(
                    executor,
                    "legacy_projectDockPresentationPreferences",
                    fields
                )
            )?;
        for region in ["right", "bottom"] {
            if panes
                .iter()
                .map(|p| text(p, "tabGroups", "region"))
                .collect::<Result<Vec<_>>>()?
                .iter()
                .filter(|r| r.as_str() == region)
                .count()
                > 1
            {
                return Err(failure(&format!(
                    "The {region} dock contains more than one pane."
                )));
            }
        }
        let root = if root.is_null() {
            root
        } else {
            parse("projectCenterLayoutNodeSchema", &root)?
        };
        let leaves = crate::project_layout::leaf_ids(&root).map_err(|e| failure(&e.to_string()))?;
        let selected = read(executor, "legacy_tabGroups_center", fields)
            .await?
            .iter()
            .map(|r| r.get::<String>(0).map(JsString::from))
            .collect::<Result<HashSet<_>>>()?;
        if leaves.len() != selected.len() || leaves.iter().any(|p| !selected.contains(p)) {
            return Err(failure(
                "The center layout tree does not exactly match its center panes.",
            ));
        }
        let mut positions = HashMap::new();
        let mut regions = HashMap::new();
        for pane in &panes {
            let id = text(pane, "tabGroups", "id")?;
            let region = text(pane, "tabGroups", "region")?;
            if region == "center" {
                positions.insert(
                    id.clone(),
                    pane.get::<i32>(queries::column("tabGroups", "position"))?,
                );
            }
            regions.insert(id, region);
        }
        if leaves
            .iter()
            .enumerate()
            .any(|(i, id)| positions.get(id.as_str().unwrap()).copied() != Some(i as i32))
        {
            return Err(failure(
                "Center pane positions must match center layout leaf order.",
            ));
        }
        let mut titles = HashMap::new();
        for (prefix, rows) in [
            ("chat", chats),
            ("terminal", terminals),
            ("explorer", explorers),
            ("browser", browsers),
            ("code", code),
            ("view", views),
        ] {
            for row in rows {
                let id = row.get::<String>(0)?;
                let label = row
                    .get::<Option<postgres_types::Json<Value>>>(1)?
                    .map(|v| v.0)
                    .unwrap_or(Value::Null);
                titles.insert(format!("{prefix}:{id}"), (Value::Null, label));
            }
        }
        let encoded_project = super::seed::component(&fields["project"])?;
        for row in builtins {
            let definition = text(&row, "projectBuiltInSurfaceStates", "definitionId")?;
            let tree = row.get::<Option<String>>(queries::column(
                "projectBuiltInSurfaceStates",
                "worktreeId",
            ))?;
            titles.insert(
                format!("builtin:{encoded_project}:{definition}"),
                (
                    json!({"definitionId":definition,"worktreeId":tree}),
                    Value::Null,
                ),
            );
        }
        let mut overview = Vec::new();
        for member in &members {
            if text(member, "tabGroupMembers", "tabKind")? == "builtin"
                && text(member, "tabGroupMembers", "tabId")? == "project.overview"
            {
                overview.push(text(member, "tabGroupMembers", "tabKey")?);
            }
        }
        if !overview.is_empty() {
            super::overview::retire_on(executor, fields["project"].as_str().unwrap(), &overview)
                .await?;
            continue;
        }
        let mut presentations = HashMap::new();
        for row in docks {
            let table = "projectDockPresentationPreferences";
            let value = json!({"preferredMode":text(&row,table,"preferredMode")?,"splitFraction":row.get::<f64>(queries::column(table,"splitFraction"))?,"restoreFraction":row.get::<f64>(queries::column(table,"restoreFraction"))?});
            presentations.insert(
                (text(&row, table, "region")?, text(&row, table, "tabKey")?),
                value,
            );
        }
        let mut summaries: HashMap<String, Vec<Value>> = HashMap::new();
        for row in members {
            let table = "tabGroupMembers";
            let key = text(&row, table, "tabKey")?;
            let group = text(&row, table, "groupId")?;
            let (state, label) = titles.get(&key).ok_or_else(|| {
                failure(&format!("Tab layout member {key} has no matching surface."))
            })?;
            let region = regions.get(&group);
            let dock = if region.is_some_and(|r| r == "right" || r == "bottom") {
                presentations.get(&(region.unwrap().clone(),key.clone())).cloned().unwrap_or_else(||json!({"preferredMode":"split","splitFraction":0.32,"restoreFraction":0.32}))
            } else {
                Value::Null
            };
            let member = json!({"tabKey":key,"paneId":group,"projectId":text(&row,table,"projectId")?,"tabKind":text(&row,table,"tabKind")?,"tabId":text(&row,table,"tabId")?,"builtInState":state,"titleProtection":label,"dockPresentation":dock,"position":row.get::<i32>(queries::column(table,"position"))?,"createdAt":at(&row,table,"createdAt")?,"updatedAt":at(&row,table,"updatedAt")?});
            summaries.entry(group).or_default().push(member);
        }
        let mut result = Vec::new();
        for row in panes {
            let table = "tabGroups";
            let id = text(&row, table, "id")?;
            let anchor = text(&row, table, "anchorTabKey")?;
            let members = summaries.remove(&id).unwrap_or_default();
            if members.is_empty() || !members.iter().any(|m| m["tabKey"] == anchor.as_str()) {
                return Err(failure(&format!(
                    "Tab group {id} has an invalid anchor or no members."
                )));
            }
            result.push(json!({"id":id,"projectId":text(&row,table,"projectId")?,"region":text(&row,table,"region")?,"titleProtection":opaque(&row,table,"protectedLabel")?,"position":row.get::<i32>(queries::column(table,"position"))?,"anchorTabKey":anchor,"members":members,"createdAt":at(&row,table,"createdAt")?,"updatedAt":at(&row,table,"updatedAt")?}));
        }
        return Ok(Some(
            json!({"projectId":fields["project"],"revision":revision,"centerRoot":root,"panes":result}),
        ));
    }
}
