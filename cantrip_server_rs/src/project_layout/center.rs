use crate::{
    database::{
        Transaction,
        resource_layout_queries::{context as checked, sql},
    },
    wire::{JsString, Value, value::json},
};
use anyhow::{Context, Result, ensure};
use std::collections::HashSet;

pub fn leaf_ids(root: &Value) -> Result<Vec<JsString>> {
    if root.is_null() {
        return Ok(vec![]);
    }
    let mut pending = vec![(root, 1)];
    let mut count = 0;
    let mut splits = HashSet::new();
    let mut panes = HashSet::new();
    let mut result = vec![];
    while let Some((node, depth)) = pending.pop() {
        count += 1;
        ensure!(
            depth <= 32 && count <= 255,
            "The center layout exceeds its supported topology bounds."
        );
        if node["kind"] == "pane" {
            let id = node["paneId"]
                .as_js_string()
                .context("Center pane identity")?
                .clone();
            ensure!(
                panes.insert(id.clone()),
                "Center pane {} appears more than once in the layout tree.",
                id.lossy()
            );
            result.push(id);
        } else {
            let id = node["id"]
                .as_js_string()
                .context("Center split identity")?
                .clone();
            ensure!(
                splits.insert(id.clone()),
                "Center split {} appears more than once in the layout tree.",
                id.lossy()
            );
            pending.push((&node["second"], depth + 1));
            pending.push((&node["first"], depth + 1));
        }
    }
    Ok(result)
}
pub async fn append(tx: &Transaction<'_>, project: &str, pane: &str) -> Result<()> {
    let rows = checked(
        "center_read",
        tx.query(sql("center_read"), &[&project, &1_i64]).await,
        &[json!(project), json!(1)],
    )?;
    let current = rows
        .first()
        .context("The project no longer exists.")?
        .get::<Option<postgres_types::Json<Value>>>(0)?
        .map(|v| v.0)
        .unwrap_or(Value::Null);
    let current = if current.is_null() {
        current
    } else {
        crate::wire::parse("projectCenterLayoutNodeSchema", Some(&current))
            .map_err(crate::settings::response_error)?
    };
    let leaf = Value::object([
        ("kind", Value::String("pane".into())),
        ("paneId", Value::String(pane.into())),
    ]);
    let next = if current.is_null() {
        leaf
    } else {
        Value::object([
            ("kind", Value::String("split".into())),
            ("id", Value::String(uuid::Uuid::new_v4().to_string().into())),
            ("direction", Value::String("horizontal".into())),
            ("fraction", Value::Number(0.5)),
            ("first", current),
            ("second", leaf),
        ])
    };
    persist(tx, project, &next).await
}
async fn persist(tx: &Transaction<'_>, project: &str, next: &Value) -> Result<()> {
    let ids = leaf_ids(next)?;
    let rows = checked(
        "center_panes",
        tx.query(sql("center_panes"), &[&project, &"center"]).await,
        &[json!(project), json!("center")],
    )?;
    let panes = rows
        .iter()
        .map(|r| r.get::<String>(0).map(JsString::from))
        .collect::<Result<HashSet<_>>>()?;
    ensure!(
        ids.len() == panes.len() && ids.iter().all(|id| panes.contains(id)),
        "The center layout tree does not exactly match its center panes."
    );
    let json = next.stringify();
    let root = (!next.is_null()).then_some(json.as_str());
    let at = crate::auth::now();
    checked(
        "center_update",
        tx.query(
            "UPDATE projects SET center_layout_root=$1::text::jsonb,updated_at=$2 WHERE id=$3",
            &[&root, &at, &project],
        )
        .await,
        &[
            if next.is_null() {
                Value::Null
            } else {
                Value::String(json.into())
            },
            json!(crate::auth::iso(at)),
            json!(project),
        ],
    )?;
    for (position, id) in ids.into_iter().enumerate() {
        let id = id.lossy().into_owned();
        let at = crate::auth::now();
        checked(
            "group_position",
            tx.query(
                "UPDATE tab_groups SET position=$1,updated_at=$2 WHERE id=$3",
                &[&(position as i32), &at, &id],
            )
            .await,
            &[json!(position), json!(crate::auth::iso(at)), json!(id)],
        )?;
    }
    Ok(())
}
fn remove_first(node: &Value, pane: &str) -> (Value, bool) {
    if node["kind"] == "pane" {
        return if node["paneId"] == pane {
            (Value::Null, true)
        } else {
            (node.clone(), false)
        };
    }
    let (first, removed) = remove_first(&node["first"], pane);
    if removed {
        if first.is_null() {
            return (node["second"].clone(), true);
        }
        let mut next = node.clone();
        next["first"] = first;
        return (next, true);
    }
    let (second, removed) = remove_first(&node["second"], pane);
    if removed {
        if second.is_null() {
            return (node["first"].clone(), true);
        }
        let mut next = node.clone();
        next["second"] = second;
        return (next, true);
    }
    (node.clone(), false)
}
pub async fn remove(tx: &Transaction<'_>, project: &str, pane: &str) -> Result<()> {
    let rows = checked(
        "center_read",
        tx.query(sql("center_read"), &[&project, &1_i64]).await,
        &[json!(project), json!(1)],
    )?;
    let root = rows
        .first()
        .context("The project no longer exists.")?
        .get::<Option<postgres_types::Json<Value>>>(0)?
        .map(|v| v.0)
        .unwrap_or(Value::Null);
    ensure!(!root.is_null(), "The center layout root is missing.");
    let root = crate::wire::parse("projectCenterLayoutNodeSchema", Some(&root))
        .map_err(crate::settings::response_error)?;
    let (next, removed) = remove_first(&root, pane);
    ensure!(
        removed,
        "Center pane {pane} is missing from the layout tree."
    );
    persist(tx, project, &next).await
}
