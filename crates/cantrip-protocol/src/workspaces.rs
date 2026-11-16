//! Ownership invariants from the shared protocol, including UTF-16 identities.
use super::{JsString, Parsed, ValidationError, Value, coercion, value::json};
use std::collections::HashSet;
fn identity(v: &Value) -> JsString {
    v.as_js_string()
        .expect("validated ownership identity")
        .clone()
}
fn array<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn field(v: &Value, key: &str) -> JsString {
    identity(&v[key])
}
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if ![
        "workspace-ownership",
        "workspace-tab",
        "workspace-resource",
        "workspace-conversation-view",
    ]
    .contains(&tag)
    {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut issue = |suffix: Vec<Value>, message: String| {
        let mut at = path.to_vec();
        at.extend(suffix);
        result.issue(json!({"code":"custom"}), &at, message, false);
    };
    if tag == "workspace-conversation-view" {
        if value["resource"]["kind"] != "entity"
            || value["resource"]["definitionId"] != "project.agent"
            || value["preview"] != false
        {
            issue(
                vec![],
                "A conversation view must be a permanent Agent view.".into(),
            );
        }
        return Ok(true);
    }
    if tag == "workspace-resource" {
        if value["kind"] == "entity"
            && ![
                "project.agent",
                "project.terminal",
                "project.explorer",
                "project.file",
                "project.browser",
                "project.code",
                "project.remote-desktop",
                "project.git-history",
                "project.git-graph",
                "project.github-issues",
                "project.github-pull-requests",
                "project.github-actions",
            ]
            .iter()
            .any(|id| value["definitionId"] == *id)
        {
            issue(
                vec![json!("definitionId")],
                format!(
                    "{} is not currently entity-backed.",
                    field(&value, "definitionId")
                ),
            );
        }
        return Ok(true);
    }
    if tag == "workspace-tab" {
        if value.get("fileMode").is_some() && value["resource"]["definitionId"] != "project.file" {
            issue(
                vec![json!("fileMode")],
                "File mode requires a file view.".into(),
            );
        }
        if value.get("fileViewer").is_some() && value["resource"]["definitionId"] != "project.file"
        {
            issue(
                vec![json!("fileViewer")],
                "File viewer requires a file view.".into(),
            );
        }
        if value["resource"]["kind"] == "builtin" {
            if value["builtInState"].get("definitionId") != value["resource"].get("definitionId") {
                issue(
                    vec![json!("builtInState")],
                    "Built-in view state must match its resource.".into(),
                );
            }
        } else if !value["builtInState"].is_null() {
            issue(
                vec![json!("builtInState")],
                "Entity views cannot carry built-in state.".into(),
            );
        }
        return Ok(true);
    }
    let mut window_ids = HashSet::new();
    let mut pane_ids = HashSet::new();
    let mut tab_ids = HashSet::new();
    let mut split_ids = HashSet::new();
    let mut code_imports = HashSet::new();
    for (index, entry) in array(&value, "legacyCodeImports").iter().enumerate() {
        if !code_imports.insert(field(entry, "tabId")) {
            issue(
                vec![json!("legacyCodeImports"), json!(index)],
                "Code conversion receipts must be unique.".into(),
            );
        }
        let views = array(entry, "views");
        if views
            .iter()
            .map(|v| field(v, "tabId"))
            .collect::<HashSet<_>>()
            .len()
            != views.len()
            || views
                .iter()
                .map(|v| field(v, "documentId"))
                .collect::<HashSet<_>>()
                .len()
                != views.len()
            || views.iter().any(|v| v["tabId"] == entry["tabId"])
        {
            issue(
                vec![json!("legacyCodeImports"), json!(index)],
                "Code conversion views must have distinct identities.".into(),
            );
        }
    }
    for (wi, window) in array(&value, "windows").iter().enumerate() {
        let wp = vec![json!("windows"), json!(wi)];
        let at = |suffix: Vec<Value>| {
            let mut p = wp.clone();
            p.extend(suffix);
            p
        };
        if !window_ids.insert(field(window, "id")) {
            issue(
                at(vec![json!("id")]),
                "Window identities must be unique.".into(),
            );
        }
        let panes = array(window, "panes");
        let local_panes = panes.iter().map(|p| field(p, "id")).collect::<HashSet<_>>();
        if !window["focusedPaneId"].is_null()
            && !local_panes.contains(&field(window, "focusedPaneId"))
        {
            issue(
                at(vec![json!("focusedPaneId")]),
                "Focus must belong to this window.".into(),
            );
        }
        let local_tabs = panes
            .iter()
            .flat_map(|p| {
                array(p, "tabs")
                    .iter()
                    .chain(p.get("conversationView").filter(|v| !v.is_null()))
                    .map(|t| field(t, "id"))
            })
            .collect::<HashSet<_>>();
        let mut recent_tabs = HashSet::new();
        for (ri, id) in array(window, "recentTabIds").iter().enumerate() {
            let id = identity(id);
            let duplicate = !recent_tabs.insert(id.clone());
            if !local_tabs.contains(&id) || duplicate {
                issue(
                    at(vec![json!("recentTabIds"), json!(ri)]),
                    "Recent tabs must be unique and belong to this window.".into(),
                );
            }
        }
        let mut recent_panes = HashSet::new();
        for (ri, id) in array(window, "recentPaneIds").iter().enumerate() {
            let id = identity(id);
            let duplicate = !recent_panes.insert(id.clone());
            if !local_panes.contains(&id) || duplicate {
                issue(
                    at(vec![json!("recentPaneIds"), json!(ri)]),
                    "Recent panes must be unique and belong to this window.".into(),
                );
            }
        }
        for (pi, pane) in panes.iter().enumerate() {
            let pp = vec![json!("panes"), json!(pi)];
            let at_pane = |suffix: Vec<Value>| {
                let mut p = pp.clone();
                p.extend(suffix);
                at(p)
            };
            if !pane_ids.insert(field(pane, "id")) {
                issue(
                    at_pane(vec![json!("id")]),
                    "A pane must have exactly one window owner.".into(),
                );
            }
            if value["version"] == json!(1)
                && (pane.get("conversationView").is_some() || pane.get("selection").is_some())
            {
                issue(
                    at_pane(vec![]),
                    "Conversation content requires workspace version 2.".into(),
                );
            }
            if value["version"] == json!(2)
                && (pane.get("conversationView").is_none() || pane.get("selection").is_none())
            {
                issue(
                    at_pane(vec![]),
                    "Version 2 panes require conversation content and selection.".into(),
                );
            }
            let direct = pane.get("conversationView").filter(|v| !v.is_null());
            let tabs = array(pane, "tabs");
            let active_owned = tabs.iter().any(|t| t["id"] == pane["activeTabId"]);
            if tabs.is_empty() && direct.is_none() {
                issue(
                    at_pane(vec![json!("tabs")]),
                    "A pane must own at least one view.".into(),
                );
            }
            if if pane["activeTabId"].is_null() {
                !tabs.is_empty()
            } else {
                !active_owned
            } {
                issue(
                    at_pane(vec![json!("activeTabId")]),
                    "The active tab must belong to this pane.".into(),
                );
            }
            if direct.is_some() && pane["region"] != "center" {
                issue(
                    at_pane(vec![json!("conversationView")]),
                    "Direct conversations require a center pane.".into(),
                );
            }
            if pane["selection"]["kind"] == "tab"
                && (pane["selection"]["tabId"] != pane["activeTabId"] || !active_owned)
            {
                issue(
                    at_pane(vec![json!("selection")]),
                    "Selected tab must belong to this pane.".into(),
                );
            }
            if pane["selection"]["kind"] == "conversation"
                && direct.is_none_or(|v| v["id"] != pane["selection"]["viewId"])
            {
                issue(
                    at_pane(vec![json!("selection")]),
                    "Selected conversation must belong to this pane.".into(),
                );
            }
            if let Some(view) = direct
                && !tab_ids.insert(field(view, "id"))
            {
                issue(
                    at_pane(vec![json!("conversationView"), json!("id")]),
                    "A view must have exactly one pane owner.".into(),
                );
            }
            for (ti, tab) in array(pane, "tabs").iter().enumerate() {
                if !tab_ids.insert(field(tab, "id")) {
                    issue(
                        at_pane(vec![json!("tabs"), json!(ti), json!("id")]),
                        "A tab must have exactly one pane owner.".into(),
                    );
                }
            }
        }
        let centers = panes
            .iter()
            .filter(|p| p["region"] == "center")
            .map(|p| field(p, "id"))
            .collect::<HashSet<_>>();
        let mut leaves = HashSet::new();
        let mut pending = Vec::new();
        if !window["centerRoot"].is_null() {
            pending.push((&window["centerRoot"], 0));
        }
        let mut nodes = 0;
        while let Some((node, depth)) = pending.pop() {
            nodes += 1;
            if nodes > 255 || depth > 32 {
                issue(
                    at(vec![json!("centerRoot")]),
                    "Window topology exceeds supported bounds.".into(),
                );
                break;
            }
            if node["kind"] == "pane" {
                let id = field(node, "paneId");
                let duplicate = !leaves.insert(id.clone());
                if !centers.contains(&id) || duplicate {
                    issue(
                        at(vec![json!("centerRoot")]),
                        "Tree leaves must reference each local center pane exactly once.".into(),
                    );
                }
            } else {
                if !split_ids.insert(field(node, "id")) {
                    issue(
                        at(vec![json!("centerRoot")]),
                        "Split identities must be unique.".into(),
                    );
                }
                pending.push((&node["first"], depth + 1));
                pending.push((&node["second"], depth + 1));
            }
        }
        if centers.iter().any(|id| !leaves.contains(id)) {
            issue(
                at(vec![json!("centerRoot")]),
                "Every center pane must appear in its owning window's tree.".into(),
            );
        }
    }
    if !window_ids.contains(&field(&value, "mainWindowId")) {
        issue(
            vec![json!("mainWindowId")],
            "The main window must exist in this workspace.".into(),
        );
    }
    let windows = array(&value, "windows");
    let mut transfers = HashSet::new();
    let mut destinations = HashSet::new();
    let mut reserved_tabs = HashSet::new();
    let mut reserved_panes = HashSet::new();
    for (index, transfer) in array(&value, "pendingTransfers").iter().enumerate() {
        let at = vec![json!("pendingTransfers"), json!(index)];
        let source = windows
            .iter()
            .position(|w| w["id"] == transfer["sourceWindowId"]);
        let destination = windows
            .iter()
            .position(|w| w["id"] == transfer["destinationWindowId"]);
        let returning = coercion::truthy(transfer.get("returnSplitId"));
        if transfers.contains(&field(transfer, "id"))
            || (!returning && destinations.contains(&field(transfer, "destinationWindowId")))
        {
            issue(
                at.clone(),
                "Transfer and destination identities must be unique.".into(),
            );
        }
        transfers.insert(field(transfer, "id"));
        if !returning {
            destinations.insert(field(transfer, "destinationWindowId"));
        }
        let pane = field(transfer, "destinationPaneId");
        if reserved_panes.contains(&pane)
            || if transfer["wholePane"] == true {
                transfer["destinationPaneId"] != transfer["sourcePaneId"]
            } else {
                pane_ids.contains(&pane)
            }
        {
            issue(
                at.clone(),
                "Destination pane identities must be uniquely reserved.".into(),
            );
        }
        reserved_panes.insert(pane);
        let invalid = match (source, destination) {
            (Some(s), Some(t)) => {
                s == t
                    || if returning {
                        windows[t]["id"] != value["mainWindowId"]
                    } else {
                        windows[t]["id"] == value["mainWindowId"]
                            || !array(&windows[t], "panes").is_empty()
                    }
            }
            _ => true,
        };
        if invalid {
            issue(
                at.clone(),
                "A pending transfer requires a distinct empty destination window.".into(),
            );
        }
        if source.is_none_or(|i| windows[i]["attachmentGeneration"] != transfer["sourceGeneration"])
            || destination.is_none_or(|i| {
                windows[i]["attachmentGeneration"] != transfer["destinationGeneration"]
            })
        {
            issue(
                at.clone(),
                "Transfer generations must match their window attachments.".into(),
            );
        }
        for tab in array(transfer, "tabIds") {
            if !reserved_tabs.insert(identity(tab)) {
                issue(
                    at.clone(),
                    "A tab cannot participate in overlapping transfers.".into(),
                );
            }
        }
    }
    Ok(true)
}
