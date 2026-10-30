mod movements;
mod splits;
pub(super) use movements::move_member;
pub(super) use splits::split_member;

use super::{
    center, group_positions, invariant, member_positions, now,
    queries::{self, run},
};
use crate::{
    database::{Executor, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

pub(super) struct Pane {
    pub id: Value,
    pub region: String,
    pub position: i32,
    pub anchor: Value,
}
impl Pane {
    fn read(row: &Row, offset: usize) -> Result<Self> {
        let text = |key| row.get::<String>(offset + queries::column("tabGroups", key));
        Ok(Self {
            id: json!(text("id")?),
            region: text("region")?,
            position: row.get(offset + queries::column("tabGroups", "position"))?,
            anchor: json!(text("anchorTabKey")?),
        })
    }
}
struct Member {
    key: Value,
    project: Value,
    kind: String,
    id: Value,
    created: Value,
}
impl Member {
    fn read(row: &Row) -> Result<Self> {
        let text = |key| row.get::<String>(queries::column("tabGroupMembers", key));
        Ok(Self {
            key: json!(text("tabKey")?),
            project: json!(text("projectId")?),
            kind: text("tabKind")?,
            id: json!(text("tabId")?),
            created: json!(crate::auth::iso(row.get::<chrono::DateTime<chrono::Utc>>(
                queries::column("tabGroupMembers", "createdAt")
            )?)),
        })
    }
    async fn copy_to(
        &self,
        executor: Executor<'_, '_>,
        pane: &Value,
        position: &Value,
    ) -> Result<()> {
        run(
            executor,
            "insert_member_copy",
            &[
                self.key.clone(),
                pane.clone(),
                self.project.clone(),
                json!(self.kind),
                self.id.clone(),
                position.clone(),
                self.created.clone(),
                now(),
            ],
        )
        .await?;
        Ok(())
    }
}
async fn selected(
    executor: Executor<'_, '_>,
    project: &str,
    key: &Value,
    missing: &str,
) -> Result<(Member, Pane)> {
    let rows = run(
        executor,
        "selected_member",
        &[json!(project), key.clone(), json!(1)],
    )
    .await?;
    let row = rows.first().ok_or_else(|| invariant(missing))?;
    Ok((
        Member::read(row)?,
        Pane::read(row, queries::manifest().columns["tabGroupMembers"].len())?,
    ))
}
pub(super) async fn region_panes(
    executor: Executor<'_, '_>,
    project: &str,
    region: &str,
) -> Result<Vec<Pane>> {
    run(executor, "region_panes", &[json!(project), json!(region)])
        .await?
        .iter()
        .map(|r| Pane::read(r, 0))
        .collect()
}
async fn members(executor: Executor<'_, '_>, pane: &Value) -> Result<Vec<Member>> {
    run(executor, "source_members", std::slice::from_ref(pane))
        .await?
        .iter()
        .map(Member::read)
        .collect()
}
async fn target(executor: Executor<'_, '_>, project: &str, pane: &Value) -> Result<Option<Pane>> {
    run(
        executor,
        "target_pane",
        &[pane.clone(), json!(project), json!(1)],
    )
    .await?
    .first()
    .map(|r| Pane::read(r, 0))
    .transpose()
}
fn dock(region: &str) -> bool {
    region == "right" || region == "bottom"
}
pub(super) fn assert_dock(panes: &[Pane], region: &str) -> Result<()> {
    if dock(region) && panes.len() > 1 {
        return Err(invariant(&format!(
            "The {region} dock contains more than one pane."
        )));
    }
    Ok(())
}
pub(super) fn supports(
    kind: &str,
    id: &Value,
    region: &str,
    explicit: Option<&Value>,
) -> Result<()> {
    let definition = match explicit {
        Some(v) => v.clone(),
        None if kind == "builtin" => {
            crate::wire::parse("projectBuiltinSurfaceDefinitionIdSchema", Some(id))
                .map_err(crate::settings::response_error)?
        }
        None => json!(match kind {
            "chat" => "project.agent",
            "terminal" => "project.terminal",
            "explorer" => "project.explorer",
            "browser" => "project.browser",
            "code" => "project.code",
            "history" => "project.git-history",
            "graph" => "project.git-graph",
            "issues" => "project.github-issues",
            "prs" => "project.github-pull-requests",
            "actions" => "project.github-actions",
            "remote-desktop" => "project.remote-desktop",
            _ => "undefined",
        }),
    };
    if !queries::manifest().definitions.iter().any(|d| {
        d["id"] == definition
            && d["supportedPlacements"]
                .as_array()
                .is_some_and(|r| r.iter().any(|r| r == region))
    }) {
        return Err(invariant(&format!(
            "{} does not support the {region} region.",
            definition
                .as_js_string()
                .context("Surface definition identity")?
                .lossy()
        )));
    }
    Ok(())
}
fn ids(panes: &[Pane]) -> Vec<Value> {
    panes.iter().map(|p| p.id.clone()).collect()
}
fn keys(members: &[Member]) -> Vec<Value> {
    members.iter().map(|m| m.key.clone()).collect()
}
fn position(value: &Value, length: usize) -> usize {
    value.as_f64().unwrap_or(0.0).max(0.0).min(length as f64) as usize
}
fn inserted(mut items: Vec<Value>, item: Value, at: &Value) -> Vec<Value> {
    items.insert(position(at, items.len()), item);
    items
}
fn moved(mut items: Vec<Value>, item: &Value, at: &Value) -> Vec<Value> {
    if let Some(from) = items.iter().position(|v| v == item) {
        let item = items.remove(from);
        items.insert(position(at, items.len()), item);
    }
    items
}
async fn repair_source(
    executor: Executor<'_, '_>,
    source: &Pane,
    remaining: &[Member],
    moved: &Value,
    touch: bool,
) -> Result<()> {
    member_positions(executor, &source.id, &keys(remaining)).await?;
    let anchor = source.anchor == *moved;
    match (anchor, remaining.len() == 1) {
        (true, true) => {
            run(
                executor,
                "group_anchor_label",
                &[
                    Value::Null,
                    remaining[0].key.clone(),
                    now(),
                    source.id.clone(),
                ],
            )
            .await?;
        }
        (true, false) => {
            run(
                executor,
                "group_anchor",
                &[remaining[0].key.clone(), now(), source.id.clone()],
            )
            .await?;
        }
        (false, true) => {
            run(
                executor,
                "group_label",
                &[Value::Null, now(), source.id.clone()],
            )
            .await?;
        }
        (false, false) if touch => {
            run(executor, "group_touch", &[now(), source.id.clone()]).await?;
        }
        _ => {}
    }
    Ok(())
}
pub(super) async fn detach(executor: Executor<'_, '_>, project: &str, key: &Value) -> Result<bool> {
    let rows = run(
        executor,
        "selected_member",
        &[json!(project), key.clone(), json!(1)],
    )
    .await?;
    let Some(row) = rows.first() else {
        return Ok(false);
    };
    let pane = Pane::read(row, queries::manifest().columns["tabGroupMembers"].len())?;
    run(executor, "delete_member", std::slice::from_ref(key)).await?;
    let remaining = run(
        executor,
        "remaining_member_keys",
        std::slice::from_ref(&pane.id),
    )
    .await?
    .iter()
    .map(|r| r.get::<String>(0).map(|s| json!(s)))
    .collect::<Result<Vec<_>>>()?;
    if remaining.is_empty() {
        run(executor, "delete_pane", std::slice::from_ref(&pane.id)).await?;
        if pane.region == "center" {
            center::remove(executor, project, &pane.id).await?;
        }
        let groups = run(
            executor,
            "groups_remaining",
            &[json!(project), json!(pane.region)],
        )
        .await?
        .iter()
        .map(|r| r.get::<String>(0).map(|s| json!(s)))
        .collect::<Result<Vec<_>>>()?;
        group_positions(executor, &groups).await?;
    } else {
        match (pane.anchor == *key, remaining.len() == 1) {
            (true, true) => {
                run(
                    executor,
                    "group_anchor_label",
                    &[Value::Null, remaining[0].clone(), now(), pane.id.clone()],
                )
                .await?;
            }
            (true, false) => {
                run(
                    executor,
                    "group_anchor",
                    &[remaining[0].clone(), now(), pane.id.clone()],
                )
                .await?;
            }
            (false, true) => {
                run(
                    executor,
                    "group_label",
                    &[Value::Null, now(), pane.id.clone()],
                )
                .await?;
            }
            _ => {}
        }
    }
    if !remaining.is_empty() {
        member_positions(executor, &pane.id, &remaining).await?;
    }
    Ok(true)
}
