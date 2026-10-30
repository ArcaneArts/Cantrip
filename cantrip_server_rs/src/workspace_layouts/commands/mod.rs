mod conversations;
mod migrations;
mod transfers;
mod views;

use super::{ModelError, Result, parse, tree, values};
use crate::wire::{Value, coercion::truthy, value::json};

struct Command {
    layout: Value,
    window: Value,
    focus_window: Value,
    retired: Vec<Value>,
}
impl Command {
    fn windows(&self) -> Vec<Value> {
        values(&self.layout, "windows")
            .iter()
            .map(|w| {
                if w["id"] == self.window["id"] {
                    self.window.clone()
                } else {
                    w.clone()
                }
            })
            .collect()
    }
    fn other_window(&self, id: &Value, message: &str) -> Result<Value> {
        self.windows()
            .into_iter()
            .find(|w| w["id"] == *id)
            .ok_or_else(|| missing(message))
    }
    fn store_window(&mut self, window: Value) {
        if window["id"] == self.window["id"] {
            self.window = window;
        } else {
            let mut windows = values(&self.layout, "windows").to_vec();
            if let Some(existing) = windows.iter_mut().find(|w| w["id"] == window["id"]) {
                *existing = window;
            }
            self.layout["windows"] = Value::Array(windows);
        }
    }
    fn all_tabs(&self) -> Vec<Value> {
        self.windows()
            .iter()
            .flat_map(|w| values(w, "panes").iter().flat_map(pane_views))
            .collect()
    }
    fn reserved(&self, id: &Value) -> bool {
        values(&self.layout, "pendingTransfers")
            .iter()
            .any(|t| values(t, "tabIds").contains(id))
    }
}
fn invalid(message: &str) -> ModelError {
    ModelError::command("invalid", message)
}
fn missing(message: &str) -> ModelError {
    ModelError::command("missing", message)
}
fn panes(window: &mut Value) -> &mut Vec<Value> {
    let Value::Array(panes) = &mut window["panes"] else {
        unreachable!("validated window panes")
    };
    panes
}
fn tabs(pane: &mut Value) -> &mut Vec<Value> {
    let Value::Array(tabs) = &mut pane["tabs"] else {
        unreachable!("validated pane tabs")
    };
    tabs
}
fn pane_views(pane: &Value) -> Vec<Value> {
    let mut views = values(pane, "tabs").to_vec();
    if let Some(view) = pane.get("conversationView").filter(|v| !v.is_null()) {
        views.push(view.clone());
    }
    views
}
fn selected_view_id(pane: &Value) -> Value {
    match pane["selection"]["kind"].as_str() {
        Some("conversation") => pane["selection"]["viewId"].clone(),
        Some("tab") => pane["selection"]["tabId"].clone(),
        _ => pane["activeTabId"].clone(),
    }
}
fn normalize_pane(pane: &mut Value) {
    if pane.get("conversationView").is_none() {
        pane["conversationView"] = Value::Null;
    }
    if pane.get("selection").is_none() {
        pane["selection"] = json!({"kind":"tab","tabId":pane["activeTabId"]});
    }
}
fn pane_by_id(window: &Value, id: &Value) -> Result<Value> {
    values(window, "panes")
        .iter()
        .find(|p| p["id"] == *id)
        .cloned()
        .ok_or_else(|| missing("Pane does not belong to this window."))
}
fn tab_by_id(window: &Value, id: &Value) -> Result<(Value, Value)> {
    for pane in values(window, "panes") {
        if let Some(tab) = pane_views(pane).iter().find(|t| t["id"] == *id) {
            return Ok((pane.clone(), tab.clone()));
        }
    }
    Err(missing("Tab does not belong to this window."))
}
fn store_pane(window: &mut Value, pane: Value) {
    let existing = panes(window)
        .iter_mut()
        .find(|p| p["id"] == pane["id"])
        .expect("existing pane");
    *existing = pane;
}
fn front(id: &Value, previous: &[Value]) -> Value {
    Value::Array(
        std::iter::once(id.clone())
            .chain(previous.iter().filter(|v| **v != *id).cloned())
            .collect(),
    )
}
fn focus(window: &mut Value, pane_id: &Value, tab_id: &Value) {
    let pane = panes(window)
        .iter_mut()
        .find(|p| p["id"] == *pane_id)
        .expect("focus belongs to window");
    if pane["conversationView"]["id"] == *tab_id {
        pane["selection"] = json!({"kind":"conversation","viewId":tab_id});
    } else {
        pane["activeTabId"] = tab_id.clone();
        if pane.get("selection").is_some() {
            pane["selection"] = json!({"kind":"tab","tabId":tab_id});
        }
    }
    window["focusedPaneId"] = pane_id.clone();
    window["recentPaneIds"] = front(pane_id, values(window, "recentPaneIds"));
    window["recentTabIds"] = front(tab_id, values(window, "recentTabIds"));
}
fn remove_pane(window: &mut Value, pane: &Value) {
    panes(window).retain(|p| p["id"] != pane["id"]);
    window["centerRoot"] = tree::remove_leaf(&window["centerRoot"], &pane["id"]);
    window["recentPaneIds"] = Value::Array(
        values(window, "recentPaneIds")
            .iter()
            .filter(|id| **id != pane["id"])
            .cloned()
            .collect(),
    );
    if window["focusedPaneId"] == pane["id"] {
        let next = values(window, "recentPaneIds")
            .first()
            .cloned()
            .or_else(|| {
                values(window, "panes")
                    .iter()
                    .find(|p| p["region"] == "center")
                    .map(|p| p["id"].clone())
            })
            .or_else(|| values(window, "panes").first().map(|p| p["id"].clone()))
            .unwrap_or(Value::Null);
        window["focusedPaneId"] = next.clone();
        if truthy(Some(&next)) {
            window["recentPaneIds"] = front(&next, values(window, "recentPaneIds"));
        }
    }
}
fn take_tab(window: &mut Value, pane: &Value, tab: &Value) {
    let mut updated = pane.clone();
    let selected = selected_view_id(pane) == tab["id"];
    if pane["conversationView"]["id"] == tab["id"] {
        updated["conversationView"] = Value::Null;
        if values(&updated, "tabs").is_empty() {
            remove_pane(window, pane);
            return;
        }
        if selected {
            updated["selection"] = json!({"kind":"tab","tabId":updated["activeTabId"]});
        }
    } else {
        let index = values(pane, "tabs")
            .iter()
            .position(|t| t["id"] == tab["id"])
            .expect("owned tab");
        tabs(&mut updated).remove(index);
        if pane_views(&updated).is_empty() {
            remove_pane(window, pane);
            return;
        }
        if updated["activeTabId"] == tab["id"] {
            let remaining = values(&updated, "tabs");
            updated["activeTabId"] = remaining
                .get(index)
                .or_else(|| remaining.last())
                .map(|v| v["id"].clone())
                .unwrap_or(Value::Null);
        }
        if selected && updated.get("selection").is_some() {
            updated["selection"] = if updated["activeTabId"].is_null() {
                json!({"kind":"conversation","viewId":updated["conversationView"]["id"]})
            } else {
                json!({"kind":"tab","tabId":updated["activeTabId"]})
            };
        }
    }
    store_pane(window, updated);
}
fn leaf(id: &Value) -> Value {
    json!({"kind":"pane","paneId":id})
}
fn split(id: &Value, direction: &str, fraction: &Value, first: &Value, second: &Value) -> Value {
    json!({"kind":"split","id":id,"direction":direction,"fraction":fraction,"first":first,"second":second})
}
fn new_pane(id: &Value, region: &Value, tab: &Value) -> Value {
    json!({"id":id,"region":region,"titleProtection":Value::Null,"tabs":vec![tab.clone()],"activeTabId":tab["id"]})
}

pub fn apply(initial: &Value, input: &Value) -> Result<Value> {
    let command = parse("workspaceCommandSchema", input)?;
    let mut layout = parse("workspaceOwnershipSchema", initial)?;
    if command["action"]["type"] == "open-conversation" && layout["version"] == json!(1) {
        layout["version"] = json!(2);
        let mut windows = values(&layout, "windows").to_vec();
        for window in &mut windows {
            for pane in panes(window) {
                normalize_pane(pane);
            }
        }
        layout["windows"] = Value::Array(windows);
    }
    if command["workspaceId"] != layout["id"] || command["projectId"] != layout["projectId"] {
        return Err(ModelError::command(
            "scope",
            "Command belongs to a different workspace or project.",
        ));
    }
    if command["expectedRevision"] != layout["revision"] {
        return Err(ModelError::command(
            "revision",
            "Workspace revision changed; rebase the pending operation.",
        ));
    }
    let window = values(&layout, "windows")
        .iter()
        .find(|w| w["id"] == command["windowId"])
        .cloned()
        .ok_or_else(|| missing("Command window no longer exists."))?;
    let had_panes = !values(&window, "panes").is_empty();
    if command["attachmentGeneration"] != window["attachmentGeneration"] {
        return Err(ModelError::command(
            "attachment",
            "The command's renderer no longer owns this window.",
        ));
    }
    let action = &command["action"];
    let kind = action["type"].as_str().expect("validated command type");
    if values(&layout, "pendingTransfers")
        .iter()
        .any(|t| t["destinationWindowId"] == window["id"] && !truthy(t.get("returnSplitId")))
        && ![
            "transfer-ready",
            "transfer-state-ready",
            "replace-attachment",
        ]
        .contains(&kind)
    {
        return Err(invalid(
            "The destination is reserved for a pending transfer.",
        ));
    }
    let mut state = Command {
        layout,
        window,
        focus_window: Value::Null,
        retired: vec![],
    };
    match kind {
        "open-conversation" | "close-conversation" => conversations::apply(&mut state, action)?,
        "migrate-code-files" | "migrate-explorer-file" => migrations::apply(&mut state, action)?,
        "replace-attachment"
        | "prepare-return"
        | "prepare-detach"
        | "transfer-ready"
        | "transfer-state-ready"
        | "commit-transfer"
        | "cancel-transfer" => transfers::apply(&mut state, action)?,
        _ => views::apply(&mut state, action)?,
    }
    let mut windows = state.windows();
    for window in &mut windows {
        if state.layout["version"] == json!(2) {
            for pane in panes(window) {
                normalize_pane(pane);
            }
        }
        if window.get("recentTabIds").is_some() {
            let owned = values(window, "panes")
                .iter()
                .flat_map(pane_views)
                .map(|t| t["id"].clone())
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
    state.layout["windows"] = Value::Array(windows);
    state.layout["revision"] = json!(state.layout["revision"].as_f64().unwrap() + 1.0);
    let validated = parse("workspaceOwnershipSchema", &state.layout)
        .map_err(|_| invalid("The command would create invalid workspace ownership."))?;
    if had_panes
        && state.window["id"] != state.layout["mainWindowId"]
        && values(&state.window, "panes").is_empty()
    {
        state.retired.push(state.window["id"].clone());
    }
    Ok(
        json!({"layout":validated,"operationId":command["operationId"],"focusWindowId":state.focus_window,"emptyWindowIds":state.retired}),
    )
}
