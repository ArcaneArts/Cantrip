use super::{ModelError, Result, parse, values};
use crate::wire::{Value, value::json};
use std::collections::HashSet;

pub fn import_legacy_files(initial: &Value, input: &Value, titles: &Value) -> Result<Value> {
    let mut layout = parse("workspaceOwnershipSchema", initial)?;
    let request = parse("workspaceLegacyFileImportSchema", input)?;
    if let Some(previous) = values(&layout, "legacyFileImports")
        .iter()
        .find(|v| v["windowId"] == request["windowId"])
    {
        if previous.stringify() != request.stringify() {
            return Err(ModelError::command(
                "invalid",
                "Legacy window import identity was already used for different views.",
            ));
        }
        return Ok(json!({"layout":layout,"replayed":true}));
    }
    if values(&layout, "windows")
        .iter()
        .any(|v| v["id"] == request["windowId"])
    {
        return Err(ModelError::command(
            "attachment",
            "Legacy window already belongs to this workspace.",
        ));
    }
    let mut documents = HashSet::new();
    for view in values(&request, "views") {
        if titles
            .as_object()
            .and_then(|v| view["documentId"].as_js_string().and_then(|id| v.get(id)))
            .is_none()
        {
            return Err(ModelError::command(
                "missing",
                "An imported document is unavailable in this project.",
            ));
        }
        if !documents.insert(view["documentId"].as_js_string().unwrap().clone()) {
            return Err(ModelError::command(
                "invalid",
                "Legacy import repeats a document.",
            ));
        }
    }
    for window in values(&layout, "windows") {
        for pane in values(window, "panes") {
            for tab in values(pane, "tabs") {
                if tab["resource"]["kind"] == "entity"
                    && tab["resource"]["definitionId"] == "project.file"
                    && documents.contains(tab["resource"]["resourceId"].as_js_string().unwrap())
                {
                    return Err(ModelError::command(
                        "attachment",
                        "An imported document already has an owned view; retain both drafts for reconciliation.",
                    ));
                }
            }
        }
    }
    let tabs=values(&request,"views").iter().map(|view|json!({"id":view["tabId"],"resource":json!({"kind":"entity","definitionId":"project.file","resourceId":view["documentId"]}),"preview":false,"fileMode":view["mode"],"titleProtection":titles.as_object().unwrap().get(view["documentId"].as_js_string().unwrap()).unwrap(),"builtInState":Value::Null,"dockPresentation":Value::Null})).collect::<Vec<_>>();
    let active = tabs[0]["id"].clone();
    let mut windows = values(&layout, "windows").to_vec();
    let pane = json!({"id":request["paneId"],"region":"center","titleProtection":Value::Null,"tabs":tabs,"activeTabId":active});
    let center = json!({"kind":"pane","paneId":request["paneId"]});
    windows.push(json!({"id":request["windowId"],"attachmentGeneration":0,"panes":vec![pane],"centerRoot":center,"focusedPaneId":request["paneId"],"recentPaneIds":vec![request["paneId"].clone()],"recentTabIds":vec![active]}));
    layout["windows"] = Value::Array(windows);
    let mut imports = values(&layout, "legacyFileImports").to_vec();
    imports.push(request);
    layout["legacyFileImports"] = Value::Array(imports);
    layout["revision"] = json!(layout["revision"].as_f64().unwrap() + 1.0);
    Ok(json!({"layout":parse("workspaceOwnershipSchema",&layout)?,"replayed":false}))
}
