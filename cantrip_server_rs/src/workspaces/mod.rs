//! Shared durable ownership cleanup. Resource deletion owns the transaction.
use crate::{
    database::{
        Transaction,
        resource_layout_queries::{column, context as checked, sql},
    },
    wire::{self, JsString, Value, value::json},
};
use anyhow::Result;

fn values<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub fn remove_views(
    initial: &Value,
    project: &str,
    definition: &str,
    resource: &str,
) -> Result<Value> {
    let mut layout = wire::parse("workspaceOwnershipSchema", Some(initial))
        .map_err(crate::settings::response_error)?;
    let removals = values(&layout, "windows")
        .iter()
        .flat_map(|window| {
            values(window, "panes").iter().flat_map(move |pane| {
                values(pane, "tabs")
                    .iter()
                    .filter(move |tab| {
                        tab["resource"]["kind"] == "entity"
                            && (tab["resource"]["definitionId"] == definition
                                || (definition == "project.explorer"
                                    && tab["resource"]["definitionId"] == "project.file"))
                            && tab["resource"]["resourceId"] == resource
                    })
                    .map(move |tab| {
                        (
                            window["id"].clone(),
                            window["attachmentGeneration"].clone(),
                            tab["id"].clone(),
                        )
                    })
            })
        })
        .collect::<Vec<_>>();
    for (window, generation, tab) in removals {
        let operation = JsString::new(
            format!("resource-removal:{resource}:")
                .encode_utf16()
                .chain(tab.as_js_string().unwrap().units().iter().copied())
                .collect(),
        );
        let command = json!({"operationId":operation,"projectId":project,"workspaceId":layout["id"],
            "windowId":window,"attachmentGeneration":generation,"expectedRevision":layout["revision"],
            "action":json!({"type":"close-tab","tabId":tab})});
        layout = crate::workspace_layouts::apply(&layout, &command)?["layout"].clone();
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
