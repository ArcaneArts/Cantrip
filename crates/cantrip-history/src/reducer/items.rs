use super::*;
fn native_order(previous: &Value, next: &Value) -> Option<std::cmp::Ordering> {
    let (a, b) = (previous.get("nativeCursor")?, next.get("nativeCursor")?);
    if a["epoch"] != b["epoch"] {
        return None;
    }
    Some(
        b["sequence"]
            .as_str()?
            .parse::<u64>()
            .ok()?
            .cmp(&a["sequence"].as_str()?.parse::<u64>().ok()?),
    )
}
fn covers(a: &Value, b: &Value) -> bool {
    b.as_object().is_some_and(|fields| {
        fields.iter().all(|(key, value)| {
            a.as_object()
                .and_then(|m| m.get(key))
                .is_some_and(|other| equal(value, other))
        })
    })
}
pub(super) fn apply(
    turn: &mut Turn,
    id: &JsString,
    kind: &str,
    mut next: Candidate,
    initial: bool,
) {
    let Some(index) = turn
        .items
        .iter()
        .position(|v| &v.id == id && v.kind == kind)
    else {
        turn.items.push(Item {
            id: id.clone(),
            kind: json!(kind),
            revision: 1.0,
            ordinal: turn.items.len(),
            candidate: next,
            conflicts: Vec::new(),
        });
        return;
    };
    let item = &mut turn.items[index];
    let before = item.material();
    let p = &mut item.candidate;
    let ordering = native_order(&p.origin, &next.origin);
    let stale = ordering.map_or_else(|| concurrent(&p.origin, &next.origin), |o| o.is_lt());
    let downgrade = (p.lifecycle == "completed" && next.lifecycle != "completed")
        || (p.complete && !next.complete);
    if next.origin["kind"] == "snapshot"
        && next.origin.get("nativeCursor").is_none()
        && next.lifecycle == "started"
        && p.lifecycle == "started"
        && p.origin["kind"] == "notification"
        && p.origin["generation"] == next.origin["generation"]
    {
        next.body = spread(&next.body, &p.body);
        next.origin = p.origin.clone();
    }
    if initial && p.lifecycle == "started" {
        if p.origin["kind"] == "snapshot" && !equal(&p.body, &next.body) {
            next.origin = p.origin.clone();
        }
        next.body = spread(&next.body, &p.body);
    }
    if !stale && !downgrade {
        let mut replace = true;
        if p.lifecycle == "completed"
            && next.lifecycle == "completed"
            && !equal(&p.body, &next.body)
        {
            if let Some(o) = ordering.filter(|o| !o.is_eq()) {
                replace = o.is_gt();
            } else if covers(&p.body, &next.body) {
                replace = false;
            } else if covers(&next.body, &p.body) {
                replace = true;
            } else if !p.completed.is_null()
                && !next.completed.is_null()
                && p.completed != next.completed
            {
                replace = next.completed.as_f64() > p.completed.as_f64();
            } else if next.origin["kind"] == "notification"
                && p.origin["generation"] == next.origin["generation"]
                && next.origin["sequence"].as_f64() > p.origin["sequence"].as_f64()
            {
                replace = true;
            } else {
                replace = false;
                if !item
                    .conflicts
                    .iter()
                    .any(|v| equal(&v.body, &next.body) && v.lifecycle == next.lifecycle)
                {
                    item.conflicts.push(next.clone());
                }
            }
        }
        if replace {
            p.body = next.body;
            p.lifecycle = if next.lifecycle == "unknown" {
                p.lifecycle.clone()
            } else {
                next.lifecycle
            };
            p.complete = next.complete;
            if !next.completed.is_null() {
                p.completed = if p.completed.is_null() {
                    next.completed.clone()
                } else {
                    Value::Number({
                        let (a, b) = (
                            p.completed.as_f64().unwrap(),
                            next.completed.as_f64().unwrap(),
                        );
                        if a == 0.0 && b == 0.0 {
                            if a.is_sign_positive() || b.is_sign_positive() {
                                0.0
                            } else {
                                -0.0
                            }
                        } else {
                            a.max(b)
                        }
                    })
                };
            }
            p.origin = next.origin;
        }
    }
    if p.started.is_null() {
        p.started = next.started;
    }
    if p.completed.is_null() && p.lifecycle == "completed" {
        p.completed = next.completed;
    }
    if !equal(&before, &item.material()) {
        item.revision += 1.0;
    }
}
pub(super) fn delta(
    turn: &mut Turn,
    params: &Value,
    method: &Value,
    origin: &Value,
) -> Result<bool> {
    let Some(id) = id(&params["itemId"]) else {
        return Ok(false);
    };
    let Some(method) = method.as_str() else {
        return Ok(false);
    };
    let kind = match method {
        "item/agentMessage/delta" => "agentMessage",
        "item/commandExecution/outputDelta" => "commandExecution",
        "item/fileChange/patchUpdated" => "fileChange",
        v if v.starts_with("item/reasoning/summary") => "reasoning",
        _ => return Ok(false),
    };
    let item = turn
        .items
        .iter()
        .find(|v| v.id == id && v.kind == "canonical");
    if item.is_some_and(|v| v.candidate.lifecycle == "completed") {
        return Ok(true);
    }
    let cursor = origin.get("nativeCursor");
    let previous = item.and_then(|v| v.candidate.origin.get("nativeCursor"));
    if let Some((cursor, previous)) = cursor
        .zip(previous)
        .filter(|(a, b)| a["epoch"] == b["epoch"])
    {
        let next = cursor["sequence"].as_str().unwrap().parse::<u64>().unwrap();
        let prior = previous["sequence"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        if next <= prior {
            return Ok(true);
        }
        if cursor["previousSequence"] != previous["sequence"] {
            return Ok(false);
        }
    } else if cursor.is_some() || previous.is_some() {
        return Ok(false);
    }
    if let Some(item) = item
        && previous.is_none()
        && (item.candidate.origin["generation"] != origin["generation"]
            || item.candidate.origin["kind"] == "snapshot")
    {
        return Ok(false);
    }
    let mut body = item
        .map(|v| v.candidate.body.clone())
        .unwrap_or_else(|| json!({"id":id,"type":kind}));
    if method == "item/fileChange/patchUpdated" {
        if !params["changes"].is_array() {
            return Ok(false);
        }
        body["changes"] = params["changes"].clone();
    } else if kind == "reasoning" {
        let Some(index) = params["summaryIndex"].as_f64().filter(|v| {
            v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v <= 9_007_199_254_740_991.0
        }) else {
            return Ok(false);
        };
        let mut parts = if body["summaryParts"].is_object() {
            body["summaryParts"].clone()
        } else {
            Value::object(
                array(&body["summary"])
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| v.is_string())
                    .map(|(i, v)| (i.to_string(), v.clone())),
            )
        };
        let index = json!(index).stringify();
        if method == "item/reasoning/summaryTextDelta" {
            let Some(delta) = params["delta"].as_js_string() else {
                return Ok(false);
            };
            let base = parts
                .get(&index)
                .filter(|v| !v.is_null())
                .map(string)
                .transpose()?
                .unwrap_or_else(|| "".into());
            let mut units = base.units().to_vec();
            units.extend_from_slice(delta.units());
            parts[&index] = Value::String(JsString::new(units));
        } else if method == "item/reasoning/summaryPartAdded" {
            if parts[&index].is_null() {
                parts[&index] = json!("");
            }
        } else {
            return Ok(false);
        }
        body["summaryParts"] = parts;
    } else {
        let Some(delta) = params["delta"].as_js_string() else {
            return Ok(false);
        };
        let field = if kind == "agentMessage" {
            "text"
        } else {
            "aggregatedOutput"
        };
        let mut units = body[field]
            .as_js_string()
            .map(|s| s.units().to_vec())
            .unwrap_or_default();
        units.extend_from_slice(delta.units());
        body[field] = Value::String(JsString::new(units));
    }
    let complete = item.is_some_and(|v| v.candidate.complete);
    let started = item
        .map(|v| v.candidate.started.clone())
        .unwrap_or(Value::Null);
    apply(
        turn,
        &id,
        "canonical",
        Candidate {
            body,
            lifecycle: json!("started"),
            complete,
            started,
            completed: Value::Null,
            origin: origin.clone(),
        },
        false,
    );
    Ok(true)
}
