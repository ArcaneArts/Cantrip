//! Shared durable ownership cleanup. Resource deletion owns the transaction.
use crate::{
    database::{
        Transaction,
        resource_layout_queries::{column, context as checked, sql},
    },
    wire::{self, Value, value::json},
};
use anyhow::{Context, Result, bail};

fn parsed(value: &Value) -> Result<Value> {
    wire::parse("workspaceOwnershipSchema", Some(value)).map_err(crate::settings::response_error)
}
fn values<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn front(id: Value, history: &[Value]) -> Value {
    Value::Array(
        std::iter::once(id.clone())
            .chain(history.iter().filter(|v| **v != id).cloned())
            .collect(),
    )
}
fn remove_leaf(node: &Value, pane: &Value) -> Value {
    if node.is_null() {
        return Value::Null;
    }
    if node["kind"] == "pane" {
        return if node["paneId"] == *pane {
            Value::Null
        } else {
            node.clone()
        };
    }
    let first = remove_leaf(&node["first"], pane);
    let second = remove_leaf(&node["second"], pane);
    if first.is_null() {
        return second;
    }
    if second.is_null() {
        return first;
    }
    let mut result = node.clone();
    result["first"] = first;
    result["second"] = second;
    result
}
fn close_tab(layout: &mut Value, project: &str, window_id: &Value, tab: &Value) -> Result<()> {
    // These commands are constructed by resource deletion from validated rows.
    // Keep the same scope check and reserved-destination rule as the shared command.
    if layout["projectId"] != project {
        bail!("Command belongs to a different workspace or project.")
    }
    let wi = values(layout, "windows")
        .iter()
        .position(|w| w["id"] == *window_id)
        .context("Command window no longer exists.")?;
    if values(layout, "pendingTransfers").iter().any(|t| {
        t["destinationWindowId"] == *window_id && !wire::coercion::truthy(t.get("returnSplitId"))
    }) {
        bail!("The destination is reserved for a pending transfer.");
    }
    let Value::Array(windows) = &mut layout["windows"] else {
        unreachable!("validated ownership windows")
    };
    let window = &mut windows[wi];
    let mut panes = values(window, "panes").to_vec();
    let pi = panes
        .iter()
        .position(|p| values(p, "tabs").iter().any(|t| t["id"] == *tab))
        .context("Tab does not belong to this window.")?;
    let pane_id = panes[pi]["id"].clone();
    let was_focused = window["focusedPaneId"] == pane_id && panes[pi]["activeTabId"] == *tab;
    let mut tabs = values(&panes[pi], "tabs").to_vec();
    let ti = tabs.iter().position(|t| t["id"] == *tab).unwrap();
    tabs.remove(ti);
    if tabs.is_empty() {
        panes.remove(pi);
        window["centerRoot"] = remove_leaf(&window["centerRoot"], &pane_id);
        window["recentPaneIds"] = Value::Array(
            values(window, "recentPaneIds")
                .iter()
                .filter(|v| **v != pane_id)
                .cloned()
                .collect(),
        );
        if window["focusedPaneId"] == pane_id {
            let focus = values(window, "recentPaneIds")
                .first()
                .cloned()
                .or_else(|| {
                    panes
                        .iter()
                        .find(|p| p["region"] == "center")
                        .map(|p| p["id"].clone())
                })
                .or_else(|| panes.first().map(|p| p["id"].clone()))
                .unwrap_or(Value::Null);
            if !focus.is_null() {
                window["recentPaneIds"] = front(focus.clone(), values(window, "recentPaneIds"));
            }
            window["focusedPaneId"] = focus;
        }
    } else {
        if panes[pi]["activeTabId"] == *tab {
            panes[pi]["activeTabId"] = tabs[ti.min(tabs.len() - 1)]["id"].clone();
        }
        panes[pi]["tabs"] = Value::Array(tabs);
    }
    if was_focused && let Some(next) = panes.iter().find(|p| p["id"] == window["focusedPaneId"]) {
        window["recentPaneIds"] = front(next["id"].clone(), values(window, "recentPaneIds"));
        window["recentTabIds"] = front(next["activeTabId"].clone(), values(window, "recentTabIds"));
    }
    window["panes"] = Value::Array(panes);
    if let Value::Array(windows) = &mut layout["windows"] {
        for window in windows {
            if window.get("recentTabIds").is_none() {
                continue;
            }
            let owned = values(window, "panes")
                .iter()
                .flat_map(|p| values(p, "tabs").iter().map(|t| t["id"].clone()))
                .collect::<Vec<_>>();
            window["recentTabIds"] = Value::Array(
                values(window, "recentTabIds")
                    .iter()
                    .filter(|id| owned.contains(id))
                    .cloned()
                    .collect(),
            );
        }
    }
    layout["revision"] = json!(layout["revision"].as_f64().unwrap() + 1.0);
    *layout = wire::parse("workspaceOwnershipSchema", Some(layout))
        .map_err(|_| anyhow::anyhow!("The command would create invalid workspace ownership."))?;
    Ok(())
}
pub fn remove_views(
    initial: &Value,
    project: &str,
    definition: &str,
    resource: &str,
) -> Result<Value> {
    let mut layout = parsed(initial)?;
    let removals = values(&layout, "windows")
        .iter()
        .flat_map(|w| {
            values(w, "panes").iter().flat_map(move |p| {
                values(p, "tabs")
                    .iter()
                    .filter(move |t| {
                        t["resource"]["kind"] == "entity"
                            && (t["resource"]["definitionId"] == definition
                                || (definition == "project.explorer"
                                    && t["resource"]["definitionId"] == "project.file"))
                            && t["resource"]["resourceId"] == resource
                    })
                    .map(move |t| (w["id"].clone(), t["id"].clone()))
            })
        })
        .collect::<Vec<_>>();
    for (window, tab) in removals {
        close_tab(&mut layout, project, &window, &tab)?;
    }
    Ok(layout)
}
pub async fn remove_resource(
    tx: &Transaction<'_>,
    owner: &str,
    project: &str,
    definition: &str,
    resource: &str,
) -> Result<()> {
    if checked(
        "workspace_project_lock",
        tx.query(sql("workspace_project_lock"), &[&project, &owner])
            .await,
        &[json!(project), json!(owner)],
    )?
    .is_empty()
    {
        return Ok(());
    }
    let rows = checked(
        "workspace_rows",
        tx.query(sql("workspace_rows"), &[&owner, &project]).await,
        &[json!(owner), json!(project)],
    )?;
    for row in rows {
        let workspace = row.get::<String>(column("workspace_id"))?;
        let initial = row
            .get::<postgres_types::Json<Value>>(column("workspace_layout"))?
            .0;
        let updated = remove_views(&initial, project, definition, resource)?;
        // The source validates untouched layouts too, but only writes a changed one.
        if updated["revision"] != initial["revision"] {
            let json = updated.stringify();
            checked("workspace_update",tx.query("UPDATE workspace_layouts SET layout=$1::text::jsonb WHERE owner_id=$2 AND project_id=$3 AND workspace_id=$4",&[&json,&owner,&project,&workspace]).await,&[Value::String(json.into()),json!(owner),json!(project),json!(workspace)])?;
        }
    }
    Ok(())
}
