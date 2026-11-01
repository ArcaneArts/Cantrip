use super::*;
use std::collections::HashSet;

pub(super) fn same_resource(a: &Value, b: &Value) -> bool {
    a["resource"]["kind"] == b["resource"]["kind"]
        && a["resource"]["definitionId"] == b["resource"]["definitionId"]
        && (a["resource"]["kind"] == "builtin"
            || (b["resource"]["kind"] == "entity"
                && a["resource"]["resourceId"] == b["resource"]["resourceId"]))
}
fn exact_ids(ids: &[Value], members: &[Value]) -> bool {
    let available = members
        .iter()
        .map(|m| m["id"].as_js_string().unwrap())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    ids.len() == available.len()
        && ids.iter().all(|id| {
            let id = id.as_js_string().unwrap();
            available.contains(id) && seen.insert(id)
        })
}
pub(super) fn focus_next(window: &mut Value, was_focused: bool) {
    if was_focused
        && let Some(next) = values(window, "panes")
            .iter()
            .find(|p| p["id"] == window["focusedPaneId"])
            .cloned()
    {
        focus(window, &next["id"], &selected_view_id(&next));
    }
}
pub(super) fn apply(state: &mut Command, action: &Value) -> Result<()> {
    match action["type"].as_str().unwrap() {
        "home" => state.window["focusedPaneId"] = Value::Null,
        "select" => {
            let (pane, tab) = tab_by_id(&state.window, &action["tabId"])?;
            navigate(&state.layout, &mut state.window, &pane["id"], &tab["id"])?;
        }
        "close-tab" => {
            let (pane, tab) = tab_by_id(&state.window, &action["tabId"])?;
            if pane["conversationView"]["id"] == tab["id"] {
                return Err(invalid("Use close-conversation for a direct view."));
            }
            let focused =
                state.window["focusedPaneId"] == pane["id"] && selected_view_id(&pane) == tab["id"];
            let mut current = pane.clone();
            if pane["selection"]["kind"] == "tab" {
                retire_conversation(&state.layout, &mut current, &selected_view_id(&pane))?;
            }
            take_tab(&mut state.window, &current, &tab);
            focus_next(&mut state.window, focused);
        }
        "close-pane" => {
            let pane = pane_by_id(&state.window, &action["paneId"])?;
            let focused = state.window["focusedPaneId"] == pane["id"];
            remove_pane(&mut state.window, &pane);
            focus_next(&mut state.window, focused);
        }
        "pin" | "file-mode" | "dock-presentation" => {
            let (mut pane, mut tab) = tab_by_id(&state.window, &action["tabId"])?;
            match action["type"].as_str().unwrap() {
                "pin" => tab["preview"] = json!(false),
                "file-mode" => {
                    if tab["resource"]["definitionId"] != "project.file" {
                        return Err(invalid("File mode requires a file view."));
                    }
                    tab["fileMode"] = action["mode"].clone();
                }
                _ => {
                    if pane["region"] != "right" && pane["region"] != "bottom" {
                        return Err(invalid(
                            "Dock presentation requires a right or bottom pane.",
                        ));
                    }
                    tab["dockPresentation"] = action["presentation"].clone();
                }
            }
            if pane["conversationView"]["id"] == tab["id"] {
                pane["conversationView"] = tab;
            } else {
                let existing = tabs(&mut pane)
                    .iter_mut()
                    .find(|t| t["id"] == tab["id"])
                    .unwrap();
                *existing = tab;
            }
            store_pane(&mut state.window, pane);
        }
        "rename-pane" => {
            let mut pane = pane_by_id(&state.window, &action["paneId"])?;
            pane["titleProtection"] = action["titleProtection"].clone();
            store_pane(&mut state.window, pane);
        }
        "reorder-panes" => {
            let region = values(&state.window, "panes")
                .iter()
                .filter(|p| p["region"] == action["region"])
                .cloned()
                .collect::<Vec<_>>();
            let ids = values(action, "paneIds");
            if !exact_ids(ids, &region) {
                return Err(invalid(
                    "Pane order must contain every local region member exactly once.",
                ));
            }
            let mut at = 0;
            for pane in panes(&mut state.window) {
                if pane["region"] == action["region"] {
                    *pane = region.iter().find(|p| p["id"] == ids[at]).unwrap().clone();
                    at += 1;
                }
            }
            if action["region"] == "center" && !state.window["centerRoot"].is_null() {
                tree::reorder(&mut state.window["centerRoot"], ids, &mut 0);
            }
        }
        "reorder" => {
            let mut pane = pane_by_id(&state.window, &action["paneId"])?;
            let ids = values(action, "tabIds");
            let previous = values(&pane, "tabs");
            if !exact_ids(ids, previous) {
                return Err(invalid(
                    "Tab order must contain each pane member exactly once.",
                ));
            }
            pane["tabs"] = Value::Array(
                ids.iter()
                    .map(|id| previous.iter().find(|t| t["id"] == *id).unwrap().clone())
                    .collect(),
            );
            store_pane(&mut state.window, pane);
        }
        "move" => {
            let (pane, tab) = tab_by_id(&state.window, &action["tabId"])?;
            let mut target = pane_by_id(&state.window, &action["targetPaneId"])?;
            let same = target["id"] == pane["id"];
            let direct = pane["conversationView"]["id"] == tab["id"];
            let maximum = values(&target, "tabs").len() - usize::from(same && !direct);
            let position = action["position"].as_u64().unwrap() as usize;
            if position > maximum {
                return Err(invalid("Target tab position is outside the pane."));
            }
            if same {
                if direct {
                    target["conversationView"] = Value::Null;
                } else {
                    tabs(&mut target).retain(|t| t["id"] != tab["id"]);
                }
            } else {
                take_tab(&mut state.window, &pane, &tab);
            }
            tabs(&mut target).insert(position, tab.clone());
            let pane_id = target["id"].clone();
            store_pane(&mut state.window, target);
            navigate(&state.layout, &mut state.window, &pane_id, &tab["id"])?;
        }
        "move-new-pane" => {
            let (pane, tab) = tab_by_id(&state.window, &action["tabId"])?;
            let count = values(&state.window, "panes")
                .iter()
                .filter(|p| {
                    p["region"] == action["region"]
                        && !(p["id"] == pane["id"] && pane_views(&pane).len() == 1)
                })
                .count();
            let position = action["position"].as_u64().unwrap() as usize;
            if position > count {
                return Err(invalid("Target pane position is outside the region."));
            }
            take_tab(&mut state.window, &pane, &tab);
            let target = new_pane(&action["paneId"], &action["region"], &tab);
            let region = values(&state.window, "panes")
                .iter()
                .filter(|p| p["region"] == action["region"])
                .cloned()
                .collect::<Vec<_>>();
            let neighbor = region.get(position);
            let previous = position.checked_sub(1).and_then(|i| region.get(i));
            let insertion = if let Some(neighbor) = neighbor {
                values(&state.window, "panes")
                    .iter()
                    .position(|p| p["id"] == neighbor["id"])
                    .unwrap()
            } else if let Some(previous) = previous {
                values(&state.window, "panes")
                    .iter()
                    .position(|p| p["id"] == previous["id"])
                    .unwrap()
                    + 1
            } else {
                values(&state.window, "panes").len()
            };
            panes(&mut state.window).insert(insertion, target.clone());
            if target["region"] == "center" {
                state.window["centerRoot"] = if state.window["centerRoot"].is_null() {
                    leaf(&target["id"])
                } else {
                    let anchor = neighbor.or(previous).expect("surviving center region");
                    let target_leaf = leaf(&target["id"]);
                    let anchor_leaf = leaf(&anchor["id"]);
                    let replacement = if neighbor.is_some() {
                        split(
                            &action["splitId"],
                            "horizontal",
                            &json!(0.5),
                            &target_leaf,
                            &anchor_leaf,
                        )
                    } else {
                        split(
                            &action["splitId"],
                            "horizontal",
                            &json!(0.5),
                            &anchor_leaf,
                            &target_leaf,
                        )
                    };
                    tree::replace_leaf(&state.window["centerRoot"], &anchor["id"], &replacement)
                };
            }
            navigate(&state.layout, &mut state.window, &target["id"], &tab["id"])?;
        }
        "split" => {
            let (pane, tab) = tab_by_id(&state.window, &action["tabId"])?;
            let target = pane_by_id(&state.window, &action["targetPaneId"])?;
            if target["region"] != "center"
                || (pane["id"] == target["id"] && pane_views(&pane).len() == 1)
            {
                return Err(invalid("A split requires a surviving center target pane."));
            }
            take_tab(&mut state.window, &pane, &tab);
            let new = new_pane(&action["paneId"], &json!("center"), &tab);
            let new_first = action["edge"] == "left" || action["edge"] == "top";
            let first = leaf(if new_first { &new["id"] } else { &target["id"] });
            let second = leaf(if new_first { &target["id"] } else { &new["id"] });
            if state.window["centerRoot"].is_null() {
                return Err(missing("Center tree is missing."));
            }
            let direction = if action["edge"] == "left" || action["edge"] == "right" {
                "horizontal"
            } else {
                "vertical"
            };
            let replacement = split(
                &action["splitId"],
                direction,
                &action["fraction"],
                &first,
                &second,
            );
            state.window["centerRoot"] =
                tree::replace_leaf(&state.window["centerRoot"], &target["id"], &replacement);
            let position = values(&state.window, "panes")
                .iter()
                .position(|p| p["id"] == target["id"])
                .unwrap()
                + usize::from(!new_first);
            panes(&mut state.window).insert(position, new.clone());
            navigate(&state.layout, &mut state.window, &new["id"], &tab["id"])?;
        }
        "resize" => {
            if !tree::resize(
                &mut state.window["centerRoot"],
                &action["splitId"],
                &action["fraction"],
            ) {
                return Err(missing("Split does not belong to this window."));
            }
        }
        "open" => open(state, action)?,
        _ => unreachable!("validated view command"),
    }
    Ok(())
}

fn open(state: &mut Command, action: &Value) -> Result<()> {
    for mut owner in state.windows() {
        for mut pane in values(&owner, "panes").to_vec() {
            if let Some(mut tab) = pane_views(&pane)
                .iter()
                .find(|tab| same_resource(tab, &action["tab"]))
                .cloned()
            {
                if action["tab"]["preview"] == false {
                    tab["preview"] = json!(false);
                }
                if pane["conversationView"]["id"] == tab["id"] {
                    pane["conversationView"] = tab.clone();
                } else {
                    let old = tabs(&mut pane)
                        .iter_mut()
                        .find(|t| t["id"] == tab["id"])
                        .unwrap();
                    *old = tab.clone();
                }
                store_pane(&mut owner, pane.clone());
                navigate(&state.layout, &mut owner, &pane["id"], &tab["id"])?;
                if owner["id"] != state.window["id"] {
                    state.focus_window = owner["id"].clone();
                }
                state.store_window(owner);
                return Ok(());
            }
        }
    }
    if action["target"]["kind"] == "pane" {
        let mut target = pane_by_id(&state.window, &action["target"]["paneId"])?;
        let replacing = if truthy(action.get("replacePreviewTabId")) {
            Some(tab_by_id(&state.window, &action["replacePreviewTabId"])?)
        } else {
            None
        };
        if let Some((pane, tab)) = &replacing
            && (pane["id"] != target["id"]
                || tab["resource"]["definitionId"] != "project.file"
                || action["tab"]["resource"]["definitionId"] != "project.file"
                || action["tab"]["preview"] != true)
        {
            return Err(invalid(
                "Preview replacement requires file views in the same pane.",
            ));
        }
        if let Some((_, tab)) = replacing.filter(|(_, tab)| tab["preview"] == true) {
            if state.reserved(&tab["id"]) {
                return Err(invalid("Preview is reserved for a pending transfer."));
            }
            let old = tabs(&mut target)
                .iter_mut()
                .find(|t| t["id"] == tab["id"])
                .unwrap();
            *old = action["tab"].clone();
        } else {
            tabs(&mut target).push(action["tab"].clone());
        }
        let id = target["id"].clone();
        store_pane(&mut state.window, target);
        navigate(&state.layout, &mut state.window, &id, &action["tab"]["id"])?;
    } else {
        if truthy(action.get("replacePreviewTabId")) {
            return Err(invalid("Preview replacement requires an existing pane."));
        }
        let target = new_pane(
            &action["target"]["paneId"],
            &action["target"]["region"],
            &action["tab"],
        );
        panes(&mut state.window).push(target.clone());
        if target["region"] == "center" {
            state.window["centerRoot"] = if state.window["centerRoot"].is_null() {
                leaf(&target["id"])
            } else {
                split(
                    &action["target"]["splitId"],
                    "horizontal",
                    &json!(0.5),
                    &state.window["centerRoot"],
                    &leaf(&target["id"]),
                )
            };
        }
        navigate(
            &state.layout,
            &mut state.window,
            &target["id"],
            &action["tab"]["id"],
        )?;
    }
    Ok(())
}
