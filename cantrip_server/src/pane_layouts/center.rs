use super::{invariant, queries::run};
use crate::{
    database::Executor,
    wire::{JsString, Value, value::json},
};
use anyhow::Result;
use std::collections::HashSet;

pub(super) async fn read(executor: Executor<'_, '_>, project: &str) -> Result<Value> {
    let rows = run(executor, "center_read", &[json!(project), json!(1)]).await?;
    let row = rows
        .first()
        .ok_or_else(|| invariant("The project no longer exists."))?;
    let root = row
        .get::<Option<postgres_types::Json<Value>>>(0)?
        .map(|v| v.0)
        .unwrap_or(Value::Null);
    if root.is_null() {
        Ok(root)
    } else {
        crate::wire::parse("projectCenterLayoutNodeSchema", Some(&root))
            .map_err(crate::settings::response_error)
    }
}
pub(super) async fn exact(
    executor: Executor<'_, '_>,
    project: &str,
    root: &Value,
) -> Result<Vec<JsString>> {
    let leaves = crate::project_layout::leaf_ids(root).map_err(|e| invariant(&e.to_string()))?;
    let rows = run(executor, "center_panes", &[json!(project), json!("center")]).await?;
    let panes = rows
        .iter()
        .map(|r| r.get::<String>(0).map(JsString::from))
        .collect::<Result<HashSet<_>>>()?;
    if leaves.len() != panes.len() || leaves.iter().any(|id| !panes.contains(id)) {
        return Err(invariant(
            "The center layout tree does not exactly match its center panes.",
        ));
    }
    Ok(leaves)
}
pub(super) async fn persist(executor: Executor<'_, '_>, project: &str, root: &Value) -> Result<()> {
    let leaves = exact(executor, project, root).await?;
    run(
        executor,
        "center_write",
        &[root.clone(), super::now(), json!(project)],
    )
    .await?;
    super::group_positions(
        executor,
        &leaves.into_iter().map(Value::String).collect::<Vec<_>>(),
    )
    .await
}
pub(super) fn reorder(root: &Value, order: &[Value]) -> Result<Value> {
    fn visit(root: &Value, order: &mut std::slice::Iter<'_, Value>) -> Result<Value> {
        if root["kind"] == "pane" {
            let id = order
                .next()
                .filter(|id| id.as_js_string().is_some_and(|s| !s.units().is_empty()))
                .ok_or_else(|| invariant("The center pane order is incomplete."))?;
            return Ok(json!({"kind":"pane","paneId":id}));
        }
        let mut next = root.clone();
        next["first"] = visit(&root["first"], order)?;
        next["second"] = visit(&root["second"], order)?;
        Ok(next)
    }
    visit(root, &mut order.iter())
}
pub(super) fn resize(root: &Value, id: &Value, fraction: &Value) -> (Value, bool) {
    if root["kind"] == "pane" {
        return (root.clone(), false);
    }
    let mut next = root.clone();
    if &root["id"] == id {
        next["fraction"] = fraction.clone();
        return (next, true);
    }
    for field in ["first", "second"] {
        let (child, changed) = resize(&root[field], id, fraction);
        if changed {
            next[field] = child;
            return (next, true);
        }
    }
    (next, false)
}

pub(super) fn replace(root: &Value, pane: &Value, replacement: &Value) -> (Value, bool) {
    if root["kind"] == "pane" {
        return if root["paneId"] == *pane {
            (replacement.clone(), true)
        } else {
            (root.clone(), false)
        };
    }
    for (field, other) in [("first", "second"), ("second", "first")] {
        let (child, changed) = replace(&root[field], pane, replacement);
        if changed {
            if child.is_null() {
                return (root[other].clone(), true);
            }
            let mut next = root.clone();
            next[field] = child;
            return (next, true);
        }
    }
    (root.clone(), false)
}
pub(super) async fn remove(executor: Executor<'_, '_>, project: &str, pane: &Value) -> Result<()> {
    let root = read(executor, project).await?;
    if root.is_null() {
        return Err(invariant("The center layout root is missing."));
    }
    let (next, removed) = replace(&root, pane, &Value::Null);
    if !removed {
        return Err(invariant(&format!(
            "Center pane {} is missing from the layout tree.",
            pane.as_js_string().unwrap().lossy()
        )));
    }
    persist(executor, project, &next).await
}
pub(super) async fn append(executor: Executor<'_, '_>, project: &str, pane: &Value) -> Result<()> {
    let current = read(executor, project).await?;
    let leaf = json!({"kind":"pane","paneId":pane});
    let next = if current.is_null() {
        leaf
    } else {
        json!({"kind":"split","id":uuid::Uuid::new_v4().to_string(),"direction":"horizontal","fraction":0.5,"first":current,"second":leaf})
    };
    persist(executor, project, &next).await
}
