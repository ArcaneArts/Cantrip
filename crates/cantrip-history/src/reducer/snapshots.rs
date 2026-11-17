use super::*;
use std::collections::HashSet;

fn item_key(kind: &str, id: &JsString) -> JsString {
    let mut units = kind.encode_utf16().collect::<Vec<_>>();
    units.push(58);
    units.extend_from_slice(id.units());
    JsString::new(units)
}
fn order<T>(mut remaining: Vec<T>, observed: &[JsString], key: impl Fn(&T) -> JsString) -> Vec<T> {
    let mut result = Vec::with_capacity(remaining.len());
    for id in observed {
        if let Some(index) = remaining.iter().position(|v| key(v) == *id) {
            result.extend(remaining.drain(..=index));
        }
    }
    result.extend(remaining);
    result
}
/// Insert historical prefixes/gaps without deleting live-only entries or
/// interpreting an older contradictory snapshot as an unrequested rollback.
fn insert_order<T>(
    entries: Vec<T>,
    old: &HashSet<JsString>,
    observed: &[JsString],
    key: impl Fn(&T) -> JsString,
) -> Vec<T> {
    let (mut inserted, mut retained): (Vec<T>, Vec<T>) =
        entries.into_iter().partition(|v| !old.contains(&key(v)));
    for entry in inserted.drain(..) {
        let position = observed
            .iter()
            .position(|v| *v == key(&entry))
            .map_or(0, |v| v + 1);
        let next = observed[position..]
            .iter()
            .find(|id| retained.iter().any(|v| key(v) == **id));
        let anchor = next
            .and_then(|id| retained.iter().position(|v| key(v) == *id))
            .unwrap_or(retained.len());
        retained.insert(anchor, entry);
    }
    order(retained, observed, key)
}
pub(super) fn apply(state: &mut State, value: &Value, origin: &Value) -> Result<()> {
    let old: HashSet<_> = state.turns.iter().map(|t| t.id.clone()).collect();
    let history = &value["history"];
    for raw in array(&value["thread"]["turns"]) {
        let turn = state.ensure_turn(raw["id"].as_js_string().unwrap(), origin);
        let provisional = raw["status"] == "interrupted"
            && time(&raw["completedAt"]).is_null()
            && history["currentTurnState"] == "live"
            && history["currentTurnId"] == raw["id"];
        if provisional {
            let mut observed = raw.clone();
            remove(&mut observed, "items");
            let conflict = object([("inferredInterruption", observed)]);
            if !turn.conflicts.iter().any(|v| equal(v, &conflict)) {
                turn.conflicts.push(conflict);
                turn.revision += 1.0;
            }
        }
        let mut observed = raw.clone();
        if provisional {
            observed["status"] = json!("inProgress");
        }
        turns::apply(turn, &observed, origin, false)?;
        let metadata = array(&history["turns"])
            .iter()
            .find(|v| v["turnId"] == raw["id"]);
        if metadata.is_some_and(|v| v["initialSettingsConflict"] == true) {
            if !turn
                .conflicts
                .iter()
                .any(|v| v["initialSettingsConflict"] == true)
            {
                turn.conflicts.push(json!({"initialSettingsConflict":true}));
                turn.revision += 1.0;
            }
            if coercion::truthy(Some(&turn.metadata["initialSettings"])) {
                turn.conflicts.push(object([(
                    "initialSettings",
                    turn.metadata["initialSettings"].clone(),
                )]));
                remove(&mut turn.metadata, "initialSettings");
                turn.revision += 1.0;
            }
        }
        turns::retain_settings(
            turn,
            metadata
                .map(|v| &v["initialSettings"])
                .unwrap_or(&Value::Null),
        );
        if let Some(metadata) = metadata.filter(|_| !concurrent(&turn.origin, origin)) {
            let mut contexts = array(&turn.metadata["contexts"]).to_vec();
            for context in array(&metadata["contexts"]) {
                if !contexts.iter().any(|v| equal(v, context)) {
                    contexts.push(context.clone());
                }
            }
            let mut retained = metadata.clone();
            remove(&mut retained, "initialSettings");
            if coercion::truthy(Some(&turn.metadata["cantripModelAttribution"])) {
                retained["cantripModelAttribution"] =
                    turn.metadata["cantripModelAttribution"].clone();
            }
            if !contexts.is_empty() {
                retained["contexts"] = Value::Array(contexts);
            }
            if coercion::truthy(Some(&turn.metadata["initialSettings"])) {
                retained["initialSettings"] = turn.metadata["initialSettings"].clone();
            }
            if !equal(&turn.metadata, &retained) {
                turn.metadata = retained;
                turn.revision += 1.0;
            }
        }
        let kind = metadata
            .and_then(|v| v["source"].as_str())
            .unwrap_or("legacy");
        let old: HashSet<_> = turn.items.iter().map(Item::key).collect();
        for item in array(&raw["items"]) {
            let id = item["id"].as_js_string().unwrap();
            let live = array(&history["live"]["items"])
                .iter()
                .find(|v| v["turnId"] == raw["id"] && v["item"]["id"] == item["id"]);
            if let Some(live) = live {
                let mut origin = origin.clone();
                origin["nativeCursor"] = live["cursor"].clone();
                items::apply(
                    turn,
                    id,
                    "canonical",
                    Candidate {
                        body: live["item"].clone(),
                        lifecycle: live["state"].clone(),
                        complete: true,
                        started: live["startedAtMs"].clone(),
                        completed: live["completedAtMs"].clone(),
                        origin,
                    },
                    false,
                );
                continue;
            }
            let evidence = metadata.and_then(|v| {
                array(&v["items"])
                    .iter()
                    .find(|v| v["itemId"] == item["id"])
            });
            items::apply(
                turn,
                id,
                kind,
                Candidate {
                    body: item.clone(),
                    lifecycle: evidence
                        .map(|v| v["state"].clone())
                        .unwrap_or_else(|| json!("unknown")),
                    complete: raw["itemsView"] != "summary" && raw["itemsView"] != "notLoaded",
                    started: evidence
                        .map(|v| v["startedAtMs"].clone())
                        .unwrap_or(Value::Null),
                    completed: evidence
                        .map(|v| v["completedAtMs"].clone())
                        .unwrap_or(Value::Null),
                    origin: origin.clone(),
                },
                false,
            );
        }
        let observed: Vec<_> = array(&raw["items"])
            .iter()
            .map(|v| item_key(kind, v["id"].as_js_string().unwrap()))
            .collect();
        turn.items = insert_order(std::mem::take(&mut turn.items), &old, &observed, Item::key);
    }
    let observed: Vec<_> = array(&value["thread"]["turns"])
        .iter()
        .map(|v| v["id"].as_js_string().unwrap().clone())
        .collect();
    state.turns = insert_order(std::mem::take(&mut state.turns), &old, &observed, |t| {
        t.id.clone()
    });
    for live in array(&history["live"]["items"]) {
        if array(&value["thread"]["turns"]).iter().any(|t| {
            t["id"] == live["turnId"]
                && array(&t["items"])
                    .iter()
                    .any(|i| i["id"] == live["item"]["id"])
        }) {
            continue;
        }
        let turn = state.ensure_turn(live["turnId"].as_js_string().unwrap(), origin);
        let mut origin = origin.clone();
        origin["nativeCursor"] = live["cursor"].clone();
        items::apply(
            turn,
            live["item"]["id"].as_js_string().unwrap(),
            "canonical",
            Candidate {
                body: live["item"].clone(),
                lifecycle: live["state"].clone(),
                complete: true,
                started: live["startedAtMs"].clone(),
                completed: live["completedAtMs"].clone(),
                origin,
            },
            false,
        );
    }
    Ok(())
}
