//! Direct Agent ownership: retain a center slot independently of its rail tabs.
use super::*;

pub(super) fn apply(state: &mut Command, action: &Value) -> Result<()> {
    if action["type"] == "close-conversation" {
        let (pane, tab) = tab_by_id(&state.window, &action["viewId"])?;
        if pane["conversationView"]["id"] != tab["id"] {
            return Err(invalid("View is not a direct conversation."));
        }
        let selected = selected_view_id(&pane) == tab["id"];
        take_tab(&mut state.window, &pane, &tab);
        views::focus_next(&mut state.window, selected);
        return Ok(());
    }
    for mut owner in state.windows() {
        for pane in values(&owner, "panes").to_vec() {
            if let Some(view) = pane_views(&pane)
                .iter()
                .find(|view| views::same_resource(view, &action["view"]))
            {
                focus(&mut owner, &pane["id"], &view["id"]);
                if owner["id"] != state.window["id"] {
                    state.focus_window = owner["id"].clone();
                }
                state.store_window(owner);
                return Ok(());
            }
        }
    }
    let target = if action.get("paneId").is_some() {
        Some(pane_by_id(&state.window, &action["paneId"])?)
    } else {
        values(&state.window, "recentPaneIds")
            .iter()
            .find_map(|id| {
                values(&state.window, "panes")
                    .iter()
                    .find(|p| p["id"] == *id && p["region"] == "center")
                    .cloned()
            })
            .or_else(|| {
                values(&state.window, "panes")
                    .iter()
                    .find(|p| p["region"] == "center")
                    .cloned()
            })
    };
    let mut pane = if let Some(pane) = target {
        if pane["region"] != "center" {
            return Err(invalid("Direct conversations require a center pane."));
        }
        pane
    } else {
        let pane = json!({"id":action["newPaneId"],"region":"center",
            "titleProtection":Value::Null,"tabs":Vec::<Value>::new(),
            "activeTabId":Value::Null,"conversationView":Value::Null});
        panes(&mut state.window).push(pane.clone());
        state.window["centerRoot"] = if state.window["centerRoot"].is_null() {
            leaf(&pane["id"])
        } else {
            split(
                &action["splitId"],
                "horizontal",
                &json!(0.5),
                &state.window["centerRoot"],
                &leaf(&pane["id"]),
            )
        };
        pane
    };
    if !pane["conversationView"].is_null() && state.reserved(&pane["conversationView"]["id"]) {
        return Err(invalid("Conversation is reserved for a pending transfer."));
    }
    if let Some(expected) = action.get("expectedConversationViewId") {
        let actual = pane["conversationView"]
            .get("id")
            .cloned()
            .unwrap_or(Value::Null);
        if *expected != actual {
            return Err(invalid(
                "Conversation selection changed during draft preparation.",
            ));
        }
    }
    pane["conversationView"] = action["view"].clone();
    let pane_id = pane["id"].clone();
    store_pane(&mut state.window, pane);
    focus(&mut state.window, &pane_id, &action["view"]["id"]);
    Ok(())
}
