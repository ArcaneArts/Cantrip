use crate::{
    database::Transaction,
    wire::{JsString, Value},
};
use anyhow::{Context, Result, ensure};
use std::collections::HashSet;

fn shape(root: &Value) -> Result<()> {
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        let fields = node
            .as_object()
            .context("Invalid stored center layout root")?;
        if node["kind"] == "pane" {
            ensure!(
                fields.len() == 2
                    && node["paneId"]
                        .as_js_string()
                        .is_some_and(|v| !v.units().is_empty()),
                "Invalid stored center pane"
            );
        } else {
            ensure!(
                node["kind"] == "split"
                    && fields.len() == 6
                    && node["id"]
                        .as_js_string()
                        .is_some_and(|v| !v.units().is_empty())
                    && ["horizontal", "vertical"]
                        .iter()
                        .any(|v| node["direction"] == *v)
                    && node["fraction"]
                        .as_f64()
                        .is_some_and(|v| (0.1..=0.9).contains(&v)),
                "Invalid stored center split"
            );
            pending.push(&node["second"]);
            pending.push(&node["first"]);
        }
    }
    Ok(())
}
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
    let rows = tx
        .query(
            "SELECT center_layout_root::text FROM projects WHERE id=$1 LIMIT 1",
            &[&project],
        )
        .await?;
    let raw = rows
        .first()
        .context("The project no longer exists.")?
        .get::<Option<String>>(0)?;
    let current = raw
        .map(|v| serde_json::from_str::<Value>(&v))
        .transpose()?
        .unwrap_or(Value::Null);
    if !current.is_null() {
        shape(&current)?;
    }
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
    let ids = leaf_ids(&next)?;
    let rows = tx
        .query(
            "SELECT id FROM tab_groups WHERE project_id=$1 AND region='center'",
            &[&project],
        )
        .await?;
    let panes = rows
        .iter()
        .map(|r| r.get::<String>(0).map(JsString::from))
        .collect::<Result<HashSet<_>>>()?;
    ensure!(
        ids.len() == panes.len() && ids.iter().all(|id| panes.contains(id)),
        "The center layout tree does not exactly match its center panes."
    );
    let json = next.stringify();
    let at = crate::auth::now();
    tx.query(
        "UPDATE projects SET center_layout_root=$1::text::jsonb,updated_at=$2 WHERE id=$3",
        &[&json, &at, &project],
    )
    .await?;
    for (position, id) in ids.into_iter().enumerate() {
        let id = id.lossy().into_owned();
        let at = crate::auth::now();
        tx.query(
            "UPDATE tab_groups SET position=$1,updated_at=$2 WHERE id=$3",
            &[&(position as i32), &at, &id],
        )
        .await?;
    }
    Ok(())
}
