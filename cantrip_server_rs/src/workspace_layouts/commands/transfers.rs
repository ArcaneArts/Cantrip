use super::*;

fn pending(state: &Command) -> Vec<Value> {
    values(&state.layout, "pendingTransfers").to_vec()
}
fn retire(state: &mut Command, id: &Value) {
    state.layout["windows"] = Value::Array(
        values(&state.layout, "windows")
            .iter()
            .filter(|w| w["id"] != *id)
            .cloned()
            .collect(),
    );
    state.retired.push(id.clone());
}
fn placement(state: &Command, pane: &Value, tab_position: usize) -> Value {
    let position = values(&state.window, "panes")
        .iter()
        .position(|p| p["id"] == pane["id"])
        .unwrap();
    json!({"panePosition":position,"tabPosition":tab_position,"region":pane["region"],"centerRoot":state.window["centerRoot"]})
}
pub(super) fn apply(state: &mut Command, action: &Value) -> Result<()> {
    match action["type"].as_str().unwrap() {
        "replace-attachment" => {
            if state.window.get("rendererId") == action.get("rendererId") {
                return Ok(());
            }
            let previous = pending(state);
            let staged = previous.iter().any(|t| {
                t["destinationWindowId"] == state.window["id"] && !truthy(t.get("returnSplitId"))
            });
            if staged && state.window.get("rendererId").is_none() {
                state.window["rendererId"] = action["rendererId"].clone();
                return Ok(());
            }
            let generation = state.window["attachmentGeneration"].as_f64().unwrap() + 1.0;
            if generation > 9_007_199_254_740_991.0 {
                return Err(ModelError::command(
                    "attachment",
                    "Workspace attachment generation is exhausted.",
                ));
            }
            for transfer in previous
                .iter()
                .filter(|t| {
                    t["sourceWindowId"] == state.window["id"]
                        || t["destinationWindowId"] == state.window["id"]
                })
                .cloned()
                .collect::<Vec<_>>()
            {
                if !truthy(transfer.get("returnSplitId")) {
                    retire(state, &transfer["destinationWindowId"]);
                }
            }
            state.layout["pendingTransfers"] = Value::Array(
                previous
                    .into_iter()
                    .filter(|t| {
                        t["sourceWindowId"] != state.window["id"]
                            && t["destinationWindowId"] != state.window["id"]
                    })
                    .collect(),
            );
            state.window["attachmentGeneration"] = json!(generation);
            state.window["rendererId"] = action["rendererId"].clone();
        }
        "prepare-return" => {
            if state.window["id"] == state.layout["mainWindowId"] {
                return Err(invalid("The main window cannot return to itself."));
            }
            let pane = pane_by_id(&state.window, &action["paneId"])?;
            let destination =
                state.other_window(&state.layout["mainWindowId"], "Main window is unavailable.")?;
            let mut transfers = pending(state);
            if transfers.iter().any(|t| {
                t["id"] == action["transferId"]
                    || values(t, "tabIds")
                        .iter()
                        .any(|id| values(&pane, "tabs").iter().any(|tab| tab["id"] == *id))
            }) {
                return Err(invalid("Transfer identity or views are already in use."));
            }
            let ids = values(&pane, "tabs")
                .iter()
                .map(|t| t["id"].clone())
                .collect::<Vec<_>>();
            transfers.push(json!({"id":action["transferId"],"sourceWindowId":state.window["id"],"sourceGeneration":state.window["attachmentGeneration"],"sourcePaneId":pane["id"],"sourcePlacement":placement(state,&pane,0),"tabIds":ids,"wholePane":true,"destinationWindowId":destination["id"],"destinationGeneration":destination["attachmentGeneration"],"destinationPaneId":pane["id"],"returnSplitId":action["splitId"],"phase":"preparing"}));
            state.layout["pendingTransfers"] = Value::Array(transfers);
        }
        "prepare-detach" => {
            let pane = pane_by_id(&state.window, &action["paneId"])?;
            let single = truthy(action.get("tabId"));
            let selected = if single {
                vec![
                    values(&pane, "tabs")
                        .iter()
                        .find(|t| t["id"] == action["tabId"])
                        .cloned()
                        .ok_or_else(|| missing("Tab does not belong to the source pane."))?,
                ]
            } else {
                values(&pane, "tabs").to_vec()
            };
            let mut transfers = pending(state);
            if state
                .windows()
                .iter()
                .any(|w| w["id"] == action["destinationWindowId"])
                || transfers.iter().any(|t| {
                    t["id"] == action["transferId"]
                        || values(t, "tabIds")
                            .iter()
                            .any(|id| selected.iter().any(|tab| tab["id"] == *id))
                })
            {
                return Err(invalid(
                    "Transfer identity, destination, or views are already in use.",
                ));
            }
            if if single {
                state.windows().iter().any(|w| {
                    values(w, "panes")
                        .iter()
                        .any(|p| p["id"] == action["destinationPaneId"])
                })
            } else {
                action["destinationPaneId"] != pane["id"]
            } {
                return Err(invalid(
                    "A pane transfer preserves its identity; a tab transfer requires a new pane identity.",
                ));
            }
            let mut windows = values(&state.layout, "windows").to_vec();
            windows.push(json!({"id":action["destinationWindowId"],"attachmentGeneration":0,"panes":Vec::<Value>::new(),"centerRoot":Value::Null,"focusedPaneId":Value::Null,"recentPaneIds":Vec::<Value>::new()}));
            state.layout["windows"] = Value::Array(windows);
            let tab_position = values(&pane, "tabs")
                .iter()
                .position(|t| t["id"] == selected[0]["id"])
                .unwrap();
            let ids = selected.iter().map(|t| t["id"].clone()).collect::<Vec<_>>();
            transfers.push(json!({"id":action["transferId"],"sourceWindowId":state.window["id"],"sourceGeneration":state.window["attachmentGeneration"],"sourcePaneId":pane["id"],"sourcePlacement":placement(state,&pane,tab_position),"tabIds":ids,"wholePane":!single,"destinationWindowId":action["destinationWindowId"],"destinationGeneration":0,"destinationPaneId":action["destinationPaneId"],"phase":"preparing"}));
            state.layout["pendingTransfers"] = Value::Array(transfers);
        }
        "transfer-ready" | "transfer-state-ready" => {
            let mut transfers = pending(state);
            let transfer = transfers
                .iter_mut()
                .find(|t| t["id"] == action["transferId"])
                .ok_or_else(|| missing("Transfer no longer exists."))?;
            if transfer["destinationWindowId"] != state.window["id"] {
                return Err(ModelError::command(
                    "scope",
                    if action["type"] == "transfer-ready" {
                        "Only the destination can acknowledge readiness."
                    } else {
                        "Only the destination can acknowledge restored state."
                    },
                ));
            }
            if action["type"] == "transfer-ready" {
                if transfer["phase"] == "preparing" {
                    transfer["phase"] = json!("destination-ready");
                }
            } else {
                if transfer["phase"] == "preparing" {
                    return Err(invalid(
                        "Destination application readiness has not been acknowledged.",
                    ));
                }
                transfer["phase"] = json!("state-ready");
            }
            state.layout["pendingTransfers"] = Value::Array(transfers);
        }
        "commit-transfer" => commit(state, action)?,
        "cancel-transfer" => {
            let transfers = pending(state);
            let transfer = transfers
                .iter()
                .find(|t| t["id"] == action["transferId"])
                .ok_or_else(|| missing("Transfer no longer exists."))?;
            if transfer["sourceWindowId"] != state.window["id"] {
                return Err(ModelError::command(
                    "scope",
                    "Only the source can cancel this transfer.",
                ));
            }
            if !truthy(transfer.get("returnSplitId")) {
                retire(state, &transfer["destinationWindowId"]);
            }
            state.layout["pendingTransfers"] = Value::Array(
                transfers
                    .into_iter()
                    .filter(|t| t["id"] != action["transferId"])
                    .collect(),
            );
        }
        _ => unreachable!("validated transfer action"),
    }
    Ok(())
}

fn commit(state: &mut Command, action: &Value) -> Result<()> {
    let transfer = pending(state)
        .into_iter()
        .find(|t| t["id"] == action["transferId"])
        .ok_or_else(|| missing("Transfer no longer exists."))?;
    if transfer["sourceWindowId"] != state.window["id"] {
        return Err(ModelError::command(
            "scope",
            "Only the source can commit transfer ownership after retiring its renderers.",
        ));
    }
    if transfer["phase"] != "state-ready" {
        return Err(invalid(
            "Destination state restoration has not been acknowledged.",
        ));
    }
    let source = pane_by_id(&state.window, &transfer["sourcePaneId"])?;
    let mut destination = state.other_window(
        &transfer["destinationWindowId"],
        "Destination window no longer exists.",
    )?;
    let selected = values(&transfer, "tabIds")
        .iter()
        .map(|id| {
            values(&source, "tabs")
                .iter()
                .find(|tab| tab["id"] == *id)
                .cloned()
                .ok_or_else(|| {
                    missing("Transferred tab no longer belongs to the prepared source pane.")
                })
        })
        .collect::<Result<Vec<_>>>()?;
    if transfer["wholePane"] == true
        && (values(&source, "tabs").len() != selected.len()
            || values(&source, "tabs")
                .iter()
                .zip(values(&transfer, "tabIds"))
                .any(|(tab, id)| tab["id"] != *id))
    {
        return Err(invalid(
            "Source pane membership changed during transfer preparation.",
        ));
    }
    let mut moved = if transfer["wholePane"] == true {
        remove_pane(&mut state.window, &source);
        let mut moved = source.clone();
        moved["region"] = json!("center");
        moved
    } else {
        if selected.len() != 1 {
            return Err(invalid("Single-tab transfer contains multiple tabs."));
        }
        take_tab(&mut state.window, &source, &selected[0]);
        json!({"id":transfer["destinationPaneId"],"region":"center","titleProtection":source["titleProtection"],"tabs":selected,"activeTabId":selected[0]["id"]})
    };
    if truthy(transfer.get("returnSplitId")) {
        let previous = &state.window["returnPlacement"];
        let original = if previous["sourceWindowId"] == destination["id"]
            && (previous["detachedPaneId"] == moved["id"]
                || (previous["wholePane"] == true && previous["sourcePaneId"] == moved["id"]))
        {
            Some(previous.clone())
        } else {
            None
        };
        let original_pane = original
            .as_ref()
            .filter(|o| o["wholePane"] != true)
            .and_then(|o| {
                values(&destination, "panes")
                    .iter()
                    .find(|p| p["id"] == o["sourcePaneId"])
                    .cloned()
            });
        if let Some(mut pane) = original_pane {
            let at = (original.as_ref().unwrap()["sourcePlacement"]["tabPosition"]
                .as_u64()
                .unwrap() as usize)
                .min(values(&pane, "tabs").len());
            tabs(&mut pane).splice(at..at, values(&moved, "tabs").to_vec());
            let id = pane["id"].clone();
            store_pane(&mut destination, pane);
            focus(&mut destination, &id, &moved["activeTabId"]);
        } else {
            moved["region"] = original
                .as_ref()
                .map(|o| o["sourcePlacement"]["region"].clone())
                .unwrap_or_else(|| json!("center"));
            let length = values(&destination, "panes").len();
            let at = original
                .as_ref()
                .map(|o| o["sourcePlacement"]["panePosition"].as_u64().unwrap() as usize)
                .unwrap_or(length)
                .min(length);
            panes(&mut destination).insert(at, moved.clone());
            if moved["region"] == "center" {
                let original_tree = original
                    .as_ref()
                    .filter(|o| o["wholePane"] == true)
                    .map(|o| o["sourcePlacement"]["centerRoot"].clone())
                    .unwrap_or(Value::Null);
                let can_restore = !original_tree.is_null()
                    && tree::remove_leaf(&original_tree, &moved["id"]).stringify()
                        == destination["centerRoot"].stringify();
                destination["centerRoot"] = if can_restore {
                    original_tree
                } else if !destination["centerRoot"].is_null() {
                    split(
                        &transfer["returnSplitId"],
                        "horizontal",
                        &json!(0.5),
                        &destination["centerRoot"],
                        &leaf(&moved["id"]),
                    )
                } else {
                    leaf(&moved["id"])
                };
            }
            focus(&mut destination, &moved["id"], &moved["activeTabId"]);
        }
    } else {
        destination["panes"] = Value::Array(vec![moved.clone()]);
        destination["centerRoot"] = leaf(&moved["id"]);
        destination["returnPlacement"] = json!({"detachedPaneId":moved["id"],"sourceWindowId":transfer["sourceWindowId"],"sourcePaneId":transfer["sourcePaneId"],"sourcePlacement":transfer["sourcePlacement"],"wholePane":transfer["wholePane"]});
        focus(&mut destination, &moved["id"], &moved["activeTabId"]);
    }
    state.focus_window = destination["id"].clone();
    state.store_window(destination);
    state.layout["pendingTransfers"] = Value::Array(
        pending(state)
            .into_iter()
            .filter(|t| t["id"] != transfer["id"])
            .collect(),
    );
    Ok(())
}
