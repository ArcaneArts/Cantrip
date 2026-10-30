use super::{ModelError, Result, parse, tree::remove_leaf, values};
use crate::wire::{Value, coercion::truthy, value::json};

pub(super) fn component(input: &Value) -> Result<String> {
    let text = input
        .as_js_string()
        .and_then(|v| v.as_str())
        .ok_or_else(|| ModelError::plain("URIError", "URI malformed"))?;
    let mut result = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(char::from(byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(result)
}
fn resource(member: &Value) -> Value {
    if member["tabKind"] == "builtin" {
        return json!({"kind":"builtin","definitionId":member["builtInState"]["definitionId"]});
    }
    let definition = match member["tabKind"].as_str() {
        Some("chat") => "project.agent",
        Some("terminal") => "project.terminal",
        Some("explorer") => "project.explorer",
        Some("browser") => "project.browser",
        Some("code") => "project.code",
        Some("history") => "project.git-history",
        Some("graph") => "project.git-graph",
        Some("issues") => "project.github-issues",
        Some("prs") => "project.github-pull-requests",
        Some("actions") => "project.github-actions",
        Some("remote-desktop") => "project.remote-desktop",
        _ => unreachable!("validated legacy tab kind"),
    };
    json!({"kind":"entity","definitionId":definition,"resourceId":member["tabId"]})
}

pub fn seed(input: &Value) -> Result<Value> {
    if truthy(input.get("existing")) {
        let existing = parse("workspaceOwnershipSchema", &input["existing"])?;
        if existing["id"] != input["workspaceId"]
            || existing["projectId"] != input["legacy"]["projectId"]
            || existing["mainWindowId"] != input["mainWindowId"]
        {
            return Err(ModelError::plain(
                "Error",
                "Cannot seed a different workspace, project, or main window over existing ownership.",
            ));
        }
        return Ok(existing);
    }
    let legacy = parse("projectTabLayoutWireSummarySchema", &input["legacy"])?;
    let tab_id = |key: &Value| -> Result<Value> {
        Ok(json!(format!(
            "tab:{}:{}",
            component(&input["workspaceId"])?,
            component(key)?
        )))
    };
    let mut panes = Vec::new();
    for pane in values(&legacy, "panes") {
        let preferred = input["activeTabByPane"]
            .as_object()
            .and_then(|v| pane["id"].as_js_string().and_then(|id| v.get(id)));
        let mut tabs = Vec::new();
        for member in values(pane, "members") {
            tabs.push(json!({"id":tab_id(&member["tabKey"] )?,"resource":resource(member),"preview":false,"titleProtection":member["titleProtection"],"builtInState":member["builtInState"],"dockPresentation":member["dockPresentation"]}));
        }
        let active = preferred
            .filter(|id| values(pane, "members").iter().any(|m| m["tabKey"] == **id))
            .unwrap_or(&pane["anchorTabKey"]);
        panes.push(json!({"id":pane["id"],"region":pane["region"],"titleProtection":pane["titleProtection"],"tabs":tabs,"activeTabId":tab_id(active)?}));
    }
    let focused = if panes.iter().any(|p| p["id"] == input["focusedPaneId"]) {
        input["focusedPaneId"].clone()
    } else {
        Value::Null
    };
    let mut claimed_panes = Vec::new();
    let mut claimed_windows = vec![input["mainWindowId"].clone()];
    let mut root = legacy["centerRoot"].clone();
    let mut detached = Vec::new();
    for claim in values(input, "detachedPanes") {
        let pane = panes.iter().find(|p| p["id"] == claim["paneId"]);
        if pane.is_none()
            || claimed_panes.contains(&claim["paneId"])
            || !truthy(claim.get("windowId"))
            || claimed_windows.contains(&claim["windowId"])
        {
            return Err(ModelError::command(
                "invalid",
                "Invalid or duplicate legacy detached pane ownership.",
            ));
        }
        let pane = pane.unwrap();
        claimed_panes.push(claim["paneId"].clone());
        claimed_windows.push(claim["windowId"].clone());
        root = remove_leaf(&root, &claim["paneId"]);
        detached.push(json!({"id":claim["windowId"],"attachmentGeneration":0,"panes":vec![pane],"centerRoot":if pane["region"]=="center" {json!({"kind":"pane","paneId":pane["id"]})} else {Value::Null},"focusedPaneId":pane["id"],"recentPaneIds":vec![pane["id"].clone()]}));
    }
    let main_focus = if !focused.is_null() && !claimed_panes.contains(&focused) {
        focused
    } else {
        Value::Null
    };
    let mut windows = vec![
        json!({"id":input["mainWindowId"],"attachmentGeneration":0,"panes":panes.into_iter().filter(|p|!claimed_panes.contains(&p["id"])).collect::<Vec<_>>(),"centerRoot":root,"focusedPaneId":main_focus,"recentPaneIds":if truthy(Some(&main_focus)) {vec![main_focus.clone()]} else {vec![]}}),
    ];
    windows.extend(detached);
    parse(
        "workspaceOwnershipSchema",
        &json!({"version":1,"id":input["workspaceId"],"projectId":legacy["projectId"],"revision":0,"mainWindowId":input["mainWindowId"],"windows":windows}),
    )
}
