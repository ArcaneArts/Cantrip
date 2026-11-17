use super::*;

pub(super) fn retain_settings(turn: &mut Turn, input: &Value) {
    let Ok(next) = checked("nativeHistoryInitialTurnSettingsSchema", input) else {
        return;
    };
    let previous = turn.metadata.get("initialSettings").cloned();
    let conflict = turn
        .conflicts
        .iter()
        .any(|v| v.get("initialSettings").is_some() || v["initialSettingsConflict"] == true);
    if conflict
        || previous
            .as_ref()
            .is_some_and(|v| coercion::truthy(Some(v)) && !equal(v, &next))
    {
        for value in previous.into_iter().chain(std::iter::once(next)) {
            if !coercion::truthy(Some(&value)) {
                continue;
            }
            let candidate = object([("initialSettings", value)]);
            if !turn.conflicts.iter().any(|v| equal(v, &candidate)) {
                turn.conflicts.push(candidate);
                turn.revision += 1.0;
            }
        }
        if turn.metadata.get("initialSettings").is_some() {
            remove(&mut turn.metadata, "initialSettings");
            turn.revision += 1.0;
        }
    } else if previous.as_ref().is_none_or(|v| !coercion::truthy(Some(v))) {
        turn.metadata = spread(&turn.metadata, &object([("initialSettings", next)]));
        turn.revision += 1.0;
    }
}
pub(super) fn apply(turn: &mut Turn, raw: &Value, origin: &Value, completion: bool) -> Result<()> {
    if concurrent(&turn.origin, origin) {
        return Ok(());
    }
    let mut body = raw.clone();
    remove(&mut body, "items");
    let before = turn.body_material();
    let confirmed = turn
        .terminal
        .as_ref()
        .is_some_and(|v| v == &turn.body["status"]);
    let actual = completion && terminal(&body["status"])?;
    let (mut replace, mut correction) = (true, false);
    if terminal(&turn.body["status"])?
        && terminal(&body["status"])?
        && !strict(&turn.body["status"], &body["status"])
    {
        replace = !confirmed
            && (actual
                || (!time(&body["completedAt"]).is_null()
                    && time(&turn.body["completedAt"]).is_null()));
        correction = replace;
        let conflict = if replace {
            turn.body.clone()
        } else {
            body.clone()
        };
        if !turn.conflicts.iter().any(|v| equal(v, &conflict)) {
            turn.conflicts.push(conflict);
        }
    }
    if replace {
        if terminal(&turn.body["status"])? && !terminal(&body["status"])? {
            remove(&mut body, "status");
        }
        if let Some(fields) = body.as_object() {
            for (key, value) in fields {
                if (!value.is_null()
                    || turn.body.as_object().is_none_or(|v| !v.contains_key(key))
                    || ((actual || correction)
                        && matches!(key.as_str(), Some("error" | "completedAt" | "durationMs"))))
                    && let Value::Object(map) = &mut turn.body
                {
                    map.insert(key.clone(), value.clone());
                }
            }
        }
        if actual {
            turn.terminal = body.get("status").cloned();
        }
        turn.origin = origin.clone();
    }
    if !equal(&before, &turn.body_material()) {
        turn.revision += 1.0;
    }
    Ok(())
}
