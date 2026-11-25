//! Restore canonical publication floors and selected evidence from a complete
//! authenticated plaintext recovery snapshot. No outbox identity is invented.
use super::*;
use indexmap::IndexSet;
fn terminal(value: &Value) -> Result<bool> {
    Ok(matches!(
        cantrip_wire::coercion::string(value)
            .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?
            .as_str(),
        Some("completed" | "failed" | "interrupted")
    ))
}
fn record_id(input: &str) -> Value {
    let h = Sha256::digest(input.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    s(format!(
        "{}-{}-4{}-8{}-{}",
        &h[..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    ))
}
fn identity_key(identity: &Value) -> String {
    Value::Array(
        ["threadId", "turnId", "itemId", "component", "identityKind"]
            .map(|k| identity[k].clone())
            .to_vec(),
    )
    .stringify()
}
fn consensus(values: &[Value], contexts: bool) -> Result<Value> {
    let mut result = obj([]);
    let mut keys = IndexSet::new();
    for value in values {
        if let Some(fields) = value.as_object() {
            for (key, _) in cantrip_wire::coercion::entries(fields) {
                keys.insert(key.clone());
            }
        }
    }
    for key in keys {
        let candidates: Vec<_> = values
            .iter()
            .filter_map(|v| v.as_object()?.get(&key))
            .collect();
        let present: Vec<_> = candidates.into_iter().filter(|v| !v.is_null()).collect();
        let chosen = if present.is_empty() {
            Some(Value::Null)
        } else if contexts && key == JsString::from("contexts") {
            let all = present
                .iter()
                .flat_map(|v| v.as_array().into_iter().flatten());
            let mut unique = Vec::new();
            for value in all {
                if !unique.iter().any(|v| reducer::equal(v, value)) {
                    unique.push(value.clone());
                }
            }
            Some(Value::Array(unique))
        } else {
            let terminal_values = if key == JsString::from("status") {
                present
                    .iter()
                    .filter_map(|v| match terminal(v) {
                        Ok(true) => Some(Ok(*v)),
                        Ok(false) => None,
                        Err(e) => Some(Err(e)),
                    })
                    .collect::<Result<Vec<_>>>()?
            } else {
                Vec::new()
            };
            let selected = if !terminal_values.is_empty() {
                &terminal_values
            } else {
                &present
            };
            selected
                .iter()
                .all(|v| reducer::equal(v, selected[0]))
                .then(|| selected[0].clone())
        };
        if let Some(value) = chosen
            && let Value::Object(fields) = &mut result
        {
            fields.insert(key, value);
        }
    }
    Ok(result)
}
fn ensure(
    turns: &mut IndexMap<JsString, Value>,
    id: &Value,
    ordinal: &Value,
    origin: &Value,
) -> Result<()> {
    let key = text(id)?.clone();
    turns.entry(key).or_insert_with(|| {
        obj([
            ("id", id.clone()),
            ("ordinal", ordinal.clone()),
            ("revision", Value::Number(1.)),
            ("body", obj([("id", id.clone())])),
            ("metadata", Value::Null),
            ("origin", origin.clone()),
            ("items", Value::Array(Vec::new())),
            ("conflicts", Value::Array(Vec::new())),
        ])
    });
    Ok(())
}
fn evidence(
    source: &mut Value,
    index: &mut IndexMap<JsString, Value>,
    record: &Value,
) -> Result<()> {
    let id = text(&record["recordId"])?.clone();
    if let Some(prior) = index.get(&id) {
        if !reducer::equal(prior, record) {
            bail!("Recovered native evidence has conflicting record identities.");
        }
    } else {
        index.insert(id, record.clone());
        if let Value::Array(values) = &mut source["evidence"] {
            values.push(record.clone());
        }
    }
    Ok(())
}
fn floor(floors: &mut IndexMap<String, f64>, key: String, revision: &Value) -> Result<()> {
    let revision = revision
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("Invalid recovered publication revision."))?;
    let old = floors.entry(key).or_insert(0.);
    *old = old.max(revision);
    Ok(())
}
/// Recovery must come from the authenticated archive reader. Revision floors
/// retain all accepted candidates, but counters never select a foreign body.
pub fn restore(recovery: &Value) -> Result<Value> {
    let thread = &recovery["binding"]["threadId"];
    let mut source = checked(
        "nativeHistoryStateSchema",
        &obj([
            ("version", Value::Number(1.)),
            ("threadId", thread.clone()),
            ("turns", Value::Array(Vec::new())),
            ("evidence", Value::Array(Vec::new())),
            ("notifications", Value::Array(Vec::new())),
        ]),
    )?;
    let origin = obj([
        ("kind", s("snapshot")),
        (
            "generation",
            s(crate::native_items::concat(&[
                "archive:".into(),
                text(&recovery["snapshotId"])?.clone(),
            ])),
        ),
        ("sequence", Value::Number(0.)),
    ]);
    let mut turns = IndexMap::new();
    let mut candidates: IndexMap<JsString, Vec<Value>> = IndexMap::new();
    let mut evidence_index = IndexMap::new();
    let mut item_floors = IndexMap::new();
    let mut turn_floors = IndexMap::new();
    for entry in array(&recovery["batches"])? {
        if let Some(items) = entry["batch"]["items"].as_array() {
            for item in items {
                floor(
                    &mut item_floors,
                    identity_key(&item["identity"]),
                    &item["revision"],
                )?;
            }
        }
        if entry["bindingId"] == recovery["binding"]["id"]
            && let Some(items) = entry["batch"]["turns"].as_array()
        {
            for turn in items {
                floor(
                    &mut turn_floors,
                    turn["turnId"].stringify(),
                    &turn["revision"],
                )?;
            }
        }
    }
    for entry in array(&recovery["turns"])? {
        let turn = &entry["turn"];
        if turn["threadId"] != *thread {
            bail!("Recovered native turn belongs to another thread.");
        }
        ensure(&mut turns, &turn["turnId"], &turn["ordinal"], &origin)?;
        if entry["bindingId"] == recovery["binding"]["id"] {
            floor(
                &mut turn_floors,
                turn["turnId"].stringify(),
                &turn["revision"],
            )?;
        }
        let raw = checked("historyProjectorObjectSchema", &entry["source"])?;
        let (body, metadata, conflicts, terminal) = if raw["version"] == Value::Number(2.) {
            let content = checked("nativeHistoryProjectorTurnContentSchema", &raw)?;
            if content["reducedTurn"]["id"] != turn["turnId"] {
                bail!("Recovered native turn content has a different identity.");
            }
            for record in array(&content["evidence"])? {
                evidence(&mut source, &mut evidence_index, record)?;
            }
            let reduced = &content["reducedTurn"];
            (
                reduced["body"].clone(),
                reduced["metadata"].clone(),
                reduced["conflicts"].clone(),
                reduced.get("terminalNotification").cloned(),
            )
        } else {
            let body = if raw["version"] == Value::Number(1.) {
                checked("historyProjectorObjectSchema", &raw["nativeTurn"])?
            } else {
                obj([
                    ("id", turn["turnId"].clone()),
                    ("status", turn["status"].clone()),
                    (
                        "startedAt",
                        turn["startedAtMs"]
                            .as_f64()
                            .map_or(Value::Null, |v| Value::Number(v / 1000.)),
                    ),
                    (
                        "completedAt",
                        turn["completedAtMs"]
                            .as_f64()
                            .map_or(Value::Null, |v| Value::Number(v / 1000.)),
                    ),
                ])
            };
            let metadata = if raw["version"] == Value::Number(1.) && !raw["history"].is_null() {
                checked("historyProjectorObjectSchema", &raw["history"])?
            } else {
                Value::Null
            };
            let record = obj([
                (
                    "recordId",
                    record_id(
                        &Value::Array(vec![
                            entry["bindingId"].clone(),
                            turn["turnId"].clone(),
                            turn["revision"].clone(),
                        ])
                        .stringify(),
                    ),
                ),
                ("method", s("cantrip/archive/turn-source")),
                (
                    "params",
                    obj([
                        ("turnId", turn["turnId"].clone()),
                        ("bindingId", entry["bindingId"].clone()),
                        ("workerId", entry["workerId"].clone()),
                        ("source", raw.clone()),
                    ]),
                ),
            ]);
            evidence(&mut source, &mut evidence_index, &record)?;
            (body, metadata, Value::Array(Vec::new()), None)
        };
        if body["id"] != turn["turnId"]
            || body.get("status").is_some_and(|v| *v != turn["status"])
            || metadata.get("turnId").is_some_and(|v| *v != turn["turnId"])
        {
            bail!("Recovered native turn fields disagree with their protected header.");
        }
        let mut candidate = obj([
            ("body", body),
            ("metadata", metadata),
            ("conflicts", conflicts),
        ]);
        if let Some(terminal) = terminal {
            candidate["terminalNotification"] = terminal;
        }
        candidates
            .entry(text(&turn["turnId"])?.clone())
            .or_default()
            .push(candidate);
    }
    for (id, list) in candidates {
        let turn = turns.get_mut(&id).unwrap();
        let bodies: Vec<_> = list.iter().map(|v| v["body"].clone()).collect();
        turn["body"] = consensus(&bodies, false)?;
        let completions: Vec<_> = list
            .iter()
            .filter(|v| {
                v.get("terminalNotification")
                    .is_some_and(|terminal| *terminal == v["body"]["status"])
            })
            .collect();
        if !completions.is_empty()
            && completions
                .iter()
                .all(|v| v["terminalNotification"] == completions[0]["terminalNotification"])
        {
            let completed = consensus(
                &completions
                    .iter()
                    .map(|v| v["body"].clone())
                    .collect::<Vec<_>>(),
                false,
            )?;
            for key in ["status", "completedAt", "durationMs", "error"] {
                if let Some(v) = completed.get(key) {
                    turn["body"][key] = v.clone();
                } else {
                    remove(&mut turn["body"], key);
                }
            }
            turn["terminalNotification"] = completions[0]["terminalNotification"].clone();
        }
        let metadata: Vec<_> = list
            .iter()
            .filter(|v| !v["metadata"].is_null())
            .map(|v| v["metadata"].clone())
            .collect();
        turn["metadata"] = if metadata.is_empty() {
            Value::Null
        } else {
            consensus(&metadata, true)?
        };
        let mut conflicts = Vec::new();
        for entry in &list {
            conflicts.extend_from_slice(array(&entry["conflicts"])?);
        }
        conflicts.extend(
            bodies
                .into_iter()
                .filter(|v| !reducer::equal(v, &turn["body"])),
        );
        conflicts.extend(
            metadata
                .into_iter()
                .filter(|v| !reducer::equal(v, &turn["metadata"]))
                .map(|v| obj([("cantripArchiveMetadata", v)])),
        );
        let mut unique = Vec::new();
        for value in conflicts {
            if !unique.iter().any(|v| reducer::equal(v, &value)) {
                unique.push(value);
            }
        }
        turn["conflicts"] = Value::Array(unique);
    }
    let mut publications = Vec::new();
    for entry in array(&recovery["items"])? {
        if entry["identity"]["threadId"] != *thread {
            bail!("Recovered native item belongs to another thread.");
        }
        let identity = &entry["identity"];
        ensure(
            &mut turns,
            &identity["turnId"],
            &entry["order"]["turn"],
            &origin,
        )?;
        let turn = turns.get_mut(text(&identity["turnId"])?).unwrap();
        turn["ordinal"] = entry["order"]["turn"].clone();
        let revision = entry["revision"]
            .as_f64()
            .ok_or_else(|| anyhow::anyhow!("Invalid recovered item revision."))?
            .max(*item_floors.get(&identity_key(identity)).unwrap_or(&0.));
        let mut publication = obj([
            ("identity", identity.clone()),
            ("revision", Value::Number(revision)),
            ("fingerprint", Value::Null),
            ("canonicalRevision", entry["revision"].clone()),
            ("canonicalState", entry["state"].clone()),
        ]);
        if !cantrip_wire::coercion::truthy(entry.get("source"))
            || !cantrip_wire::coercion::truthy(entry.get("sourceCurrent"))
        {
            let id = crate::native_items::concat(&[
                "missing:".into(),
                text(&entry["key"])?.clone(),
                ":".into(),
                cantrip_wire::coercion::string(&entry["revision"]).unwrap(),
            ]);
            let mut params = obj([
                ("turnId", identity["turnId"].clone()),
                ("identity", identity.clone()),
                ("revision", entry["revision"].clone()),
            ]);
            if let Some(value) = entry.get("sourceRevision") {
                params["sourceRevision"] = value.clone();
            }
            evidence(
                &mut source,
                &mut evidence_index,
                &obj([
                    ("recordId", record_id(&id.lossy())),
                    ("method", s("cantrip/archive/item-source-unavailable")),
                    ("params", params),
                ]),
            )?;
            publications.push(publication);
            continue;
        }
        let mut item = checked("nativeHistoryStateItemSchema", &entry["source"])?;
        if item["id"] != identity["itemId"] || item["identityKind"] != identity["identityKind"] {
            bail!("Recovered native item content has a different identity.");
        }
        item["ordinal"] = entry["order"]["item"].clone();
        let previous = array(&turn["items"])?
            .iter()
            .find(|p| p["id"] == item["id"] && p["identityKind"] == item["identityKind"]);
        if previous.is_some_and(|p| !reducer::equal(p, &item)) {
            bail!("Canonical components disagree on their recovered native source.");
        }
        if previous.is_none()
            && !render::turn_failure::is_item(&item)
            && let Value::Array(values) = &mut turn["items"]
        {
            values.push(item.clone());
        }
        publication["sourceFingerprint"] =
            source_fingerprint(&item, &turn["ordinal"], &item["ordinal"]);
        publications.push(publication);
    }
    fn sort(values: &mut [Value]) {
        values.sort_by(|a, b| {
            a["ordinal"]
                .as_f64()
                .unwrap()
                .partial_cmp(&b["ordinal"].as_f64().unwrap())
                .unwrap()
                .then_with(|| {
                    text(&a["id"])
                        .unwrap()
                        .lossy()
                        .as_bytes()
                        .cmp(text(&b["id"]).unwrap().lossy().as_bytes())
                })
        });
    }
    let mut turns: Vec<_> = turns.into_values().collect();
    sort(&mut turns);
    for turn in &mut turns {
        if let Value::Array(items) = &mut turn["items"] {
            sort(items);
        }
    }
    source["turns"] = Value::Array(turns);
    let turns = turn_floors
        .into_iter()
        .map(|(id, revision)| {
            Ok(obj([
                (
                    "turnId",
                    cantrip_wire::parse_json_text(&id)
                        .map_err(|_| anyhow::anyhow!("Invalid recovered turn identity."))?,
                ),
                ("revision", Value::Number(revision)),
                ("fingerprint", Value::Null),
            ]))
        })
        .collect::<Result<Vec<_>>>()?;
    checked(
        "nativeHistoryProjectorStateSchema",
        &obj([
            ("version", Value::Number(1.)),
            ("source", source),
            ("items", Value::Array(publications)),
            ("turns", Value::Array(turns)),
        ]),
    )
}
