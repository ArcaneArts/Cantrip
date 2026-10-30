//! Legacy project panes and launcher preferences, retaining their SQL boundaries.
mod center;
mod placement;
mod queries;
mod surfaces;
use crate::{
    database::{Database, Executor},
    wire::{JsString, Value, value::json},
};
use anyhow::{Context, Result};
use queries::run;
use std::{collections::HashSet, fmt, sync::Arc};
pub(crate) use surfaces::attach_entity;

pub use crate::workspace_layouts::LegacyInvariant;
#[derive(Debug)]
pub struct Conflict;
impl fmt::Display for Conflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("The project tab layout changed. Refresh it and try again.")
    }
}
impl std::error::Error for Conflict {}
fn invariant(message: &str) -> anyhow::Error {
    LegacyInvariant(message.into()).into()
}
fn now() -> Value {
    json!(crate::auth::iso(crate::auth::now()))
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    value[key]
        .as_array()
        .map(Vec::as_slice)
        .context("Pane order array")
}
fn order_matches(expected: &HashSet<JsString>, input: &[Value]) -> bool {
    expected.len() == input.len()
        && input
            .iter()
            .all(|id| id.as_js_string().is_some_and(|s| expected.contains(s)))
}
async fn group_positions(executor: Executor<'_, '_>, ids: &[Value]) -> Result<()> {
    for (position, id) in ids.iter().enumerate() {
        run(
            executor,
            "pane_position",
            &[json!(position), now(), id.clone()],
        )
        .await?;
    }
    Ok(())
}
async fn member_positions(executor: Executor<'_, '_>, pane: &Value, keys: &[Value]) -> Result<()> {
    for (position, key) in keys.iter().enumerate() {
        run(
            executor,
            "member_position",
            &[pane.clone(), json!(position), now(), key.clone()],
        )
        .await?;
    }
    Ok(())
}
pub struct Repository {
    database: Arc<Database>,
}
pub fn legacy(layout: &Value) -> Value {
    let groups = layout["panes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pane| {
            let mut pane = pane.clone();
            let Value::Object(fields) = &mut pane else {
                unreachable!()
            };
            fields.shift_remove("region");
            let mut members = fields.shift_remove("members").unwrap();
            let Value::Array(values) = &mut members else {
                unreachable!()
            };
            for member in values {
                let Value::Object(fields) = member else {
                    unreachable!()
                };
                let id = fields.shift_remove("paneId").unwrap();
                fields.insert("groupId".into(), id);
            }
            fields.insert("members".into(), members);
            pane
        })
        .collect::<Vec<_>>();
    json!({"projectId":layout["projectId"],"revision":layout["revision"],"groups":groups})
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        crate::workspace_layouts::legacy_layout(&self.database, owner, project).await
    }
    pub async fn mutate(
        &self,
        owner: &str,
        project: &str,
        action: &str,
        subject: &Value,
        input: &Value,
    ) -> Result<Option<Value>> {
        if self.get(owner, project).await?.is_none() {
            return Ok(None);
        }
        let (owner_id, project_id, action, subject, input) = (
            owner.to_owned(),
            project.to_owned(),
            action.to_owned(),
            subject.clone(),
            input.clone(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            let (owner, project, action, subject, input) = (owner_id.as_str(), project_id.as_str(), action.as_str(), &subject, &input);
            let executor = Executor::Transaction(tx);
            if run(executor, "claim", &[now(), json!(project), json!(owner), input["revision"].clone()]).await?.is_empty() {
                return Err(Conflict.into());
            }
            match action {
                "move" => placement::move_member(executor, project, input).await?,
                "split" => placement::split_member(executor, project, input).await?,
                "title" | "member-order" => {
                    if run(executor, "pane", &[subject.clone(), json!(project), json!(1)]).await?.is_empty() {
                        return Err(invariant("The pane does not belong to this project."));
                    }
                    if action == "title" {
                        if run(executor, "title_members", &[subject.clone(), json!(2)]).await?.len() < 2 {
                            return Err(invariant("A single-tab group shares its title with its tab."));
                        }
                        run(executor, "pane_title", &[input["titleProtection"].clone(), now(), subject.clone()]).await?;
                    } else {
                        let members = run(executor, "member_order", std::slice::from_ref(subject)).await?;
                        let keys = members.iter().map(|r| r.get::<String>(0).map(JsString::from)).collect::<Result<HashSet<_>>>()?;
                        let order = array(input, "tabKeys")?;
                        if !order_matches(&keys, order) { return Err(invariant("The member order did not match this pane.")); }
                        member_positions(executor, subject, order).await?;
                    }
                }
                "pane-order" => {
                    let region = &input["region"];
                    let groups = run(executor, "center_panes", &[json!(project), region.clone()]).await?;
                    let ids = groups.iter().map(|r| r.get::<String>(0).map(JsString::from)).collect::<Result<HashSet<_>>>()?;
                    let order = array(input, "paneIds")?;
                    if !order_matches(&ids, order) { return Err(invariant("The pane order did not match this project's region.")); }
                    if region == "center" { Self::center_order(executor, project, order).await?; }
                    else { group_positions(executor, order).await?; }
                }
                "legacy-order" => {
                    let panes = run(executor, "all_panes", &[json!(project)]).await?;
                    let mut regions = std::collections::HashMap::new();
                    for row in panes { regions.insert(JsString::from(row.get::<String>(0)?), row.get::<String>(1)?); }
                    let order = array(input, "paneIds")?;
                    if !order_matches(&regions.keys().cloned().collect(), order) { return Err(invariant("The pane order did not match this project.")); }
                    for region in ["center", "right", "bottom", "left"] {
                        let ids = order.iter().filter(|id| id.as_js_string().and_then(|s| regions.get(s)).is_some_and(|r| r == region)).cloned().collect::<Vec<_>>();
                        if region == "center" && !ids.is_empty() { Self::center_order(executor, project, &ids).await?; }
                        else { group_positions(executor, &ids).await?; }
                    }
                }
                "dock" => {
                    let placements = run(executor, "dock_region", &[json!(project), input["tabKey"].clone(), json!(1)]).await?;
                    let region = placements.first().map(|r| r.get::<String>(0)).transpose()?;
                    let region = region.filter(|r| r == "right" || r == "bottom").ok_or_else(|| invariant("Dock presentation can only be updated for a right or bottom placement."))?;
                    let at = now();
                    run(executor, "dock_write", &[json!(project), input["tabKey"].clone(), json!(region), input["preferredMode"].clone(), input["splitFraction"].clone(), input["restoreFraction"].clone(), at.clone(), at.clone(), input["preferredMode"].clone(), input["splitFraction"].clone(), input["restoreFraction"].clone(), at]).await?;
                }
                "resize" => {
                    let root = center::read(executor, project).await?;
                    if root.is_null() { return Err(invariant("The center layout root is missing.")); }
                    center::exact(executor, project, &root).await?;
                    let (next, resized) = center::resize(&root, subject, &input["fraction"]);
                    if !resized { return Err(invariant("The center split does not belong to this project.")); }
                    center::persist(executor, project, &next).await?;
                }
                _ => anyhow::bail!("Unknown pane mutation"),
            }
            Ok(())
        })).await?;
        self.get(owner, project).await
    }
    async fn center_order(
        executor: Executor<'_, '_>,
        project: &str,
        order: &[Value],
    ) -> Result<()> {
        let root = center::read(executor, project).await?;
        if root.is_null() {
            return Err(invariant("The center layout root is missing."));
        }
        center::exact(executor, project, &root).await?;
        center::persist(executor, project, &center::reorder(&root, order)?).await
    }
    pub async fn launchers(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        let executor = Executor::Database(&self.database);
        if run(executor, "owned", &[json!(project), json!(owner), json!(1)])
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let rows = run(executor, "launcher_preferences", &[json!(project)]).await?;
        let mut preferences = std::collections::HashMap::new();
        for row in rows {
            let table = "projectSurfaceLauncherPreferences";
            preferences.insert(
                (
                    row.get::<String>(queries::column(table, "location"))?,
                    row.get::<String>(queries::column(table, "definitionId"))?,
                ),
                row.get::<bool>(queries::column(table, "pinned"))?,
            );
        }
        let encoded_project = super::workspace_layouts::component(&json!(project))?;
        let mut result = Vec::new();
        for definition in &queries::manifest().definitions {
            let id = definition["id"].as_str().context("Surface definition id")?;
            for location in array(definition, "launcherLocations")? {
                let location = location.as_str().context("Launcher location")?;
                let pinned = preferences
                    .get(&(location.to_owned(), id.to_owned()))
                    .copied()
                    .unwrap_or(definition["launcherPinnedByDefault"].as_bool().unwrap());
                result.push(json!({"id":format!("launcher:{encoded_project}:{location}:{id}"),"projectId":project,"location":location,"target":json!({"kind":"definition","definitionId":id}),"pinned":pinned}));
            }
        }
        Ok(Some(Value::Array(result)))
    }
    pub async fn pin(&self, owner: &str, project: &str, input: &Value) -> Result<Option<Value>> {
        let Some(launchers) = self.launchers(owner, project).await? else {
            return Ok(None);
        };
        let mut launcher = launchers
            .as_array()
            .unwrap()
            .iter()
            .find(|l| {
                l["location"] == input["location"]
                    && l["target"]["definitionId"] == input["definitionId"]
            })
            .cloned()
            .ok_or_else(|| {
                invariant("This surface does not support the requested launcher location.")
            })?;
        run(
            Executor::Database(&self.database),
            "launcher_pin",
            &[
                json!(project),
                input["location"].clone(),
                input["definitionId"].clone(),
                input["pinned"].clone(),
                input["pinned"].clone(),
                now(),
            ],
        )
        .await?;
        launcher["pinned"] = input["pinned"].clone();
        Ok(Some(launcher))
    }
    pub async fn builtin_worktree(
        &self,
        owner: &str,
        project: &str,
        definition: &Value,
        worktree: &Value,
    ) -> Result<Option<Value>> {
        if definition == "project.overview" || definition == "project.tasks" {
            return Err(invariant("This built-in surface does not use a worktree."));
        }
        let executor = Executor::Database(&self.database);
        if run(
            executor,
            "builtin_worktree",
            &[
                json!(owner),
                json!(project),
                worktree.clone(),
                json!("ready"),
                json!(1),
            ],
        )
        .await?
        .is_empty()
        {
            return Ok(None);
        }
        run(
            executor,
            "builtin_write",
            &[
                json!(project),
                definition.clone(),
                worktree.clone(),
                worktree.clone(),
                now(),
            ],
        )
        .await?;
        self.get(owner, project).await
    }
}
