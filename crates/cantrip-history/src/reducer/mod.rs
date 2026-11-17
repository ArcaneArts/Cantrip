//! Pure reduction of authenticated source pages. No input, provider, network,
//! publication, pruning or committed cursor ownership lives in this module.
mod items;
mod snapshots;
mod turns;
use crate::checked;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, coercion, value::json};

fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::object(fields)
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn id(value: &Value) -> Option<JsString> {
    value.as_js_string().filter(|v| !v.is_empty()).cloned()
}
fn time(value: &Value) -> Value {
    if value.as_f64().is_some_and(f64::is_finite) {
        value.clone()
    } else {
        Value::Null
    }
}
fn string(value: &Value) -> Result<JsString> {
    coercion::string(value).map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))
}
fn terminal(value: &Value) -> Result<bool> {
    Ok(matches!(
        string(value)?.as_str(),
        Some("completed" | "failed" | "interrupted")
    ))
}
fn remove(value: &mut Value, key: &str) {
    if let Value::Object(map) = value {
        map.shift_remove(key);
    }
}
fn spread(left: &Value, right: &Value) -> Value {
    let mut result = left.as_object().cloned().unwrap_or_default();
    if let Some(other) = right.as_object() {
        for (key, value) in other {
            result.insert(key.clone(), value.clone());
        }
    }
    Value::Object(result)
}
/// Node isDeepStrictEqual on JSON values: object keys are unordered; signed
/// zero remains distinct. Use a stack, retaining the shared UTF-16 key semantics.
fn equal(left: &Value, right: &Value) -> bool {
    let mut pending = vec![(left, right)];
    while let Some((a, b)) = pending.pop() {
        match (a, b) {
            (Value::Null, Value::Null) => {}
            (Value::Bool(a), Value::Bool(b)) if a == b => {}
            (Value::String(a), Value::String(b)) if a == b => {}
            (Value::Number(a), Value::Number(b))
                if (a == b && (*a != 0.0 || a.is_sign_negative() == b.is_sign_negative()))
                    || (a.is_nan() && b.is_nan()) => {}
            (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                pending.extend(a.iter().zip(b))
            }
            (Value::Object(a), Value::Object(b)) if a.len() == b.len() => {
                for (key, value) in a {
                    let Some(other) = b.get(key) else {
                        return false;
                    };
                    pending.push((value, other));
                }
            }
            _ => return false,
        }
    }
    true
}
fn strict(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(_) | Value::Array(_), _) => std::ptr::eq(a, b),
        _ => a == b,
    }
}
fn concurrent(previous: &Value, next: &Value) -> bool {
    next["kind"] == "snapshot"
        && previous["generation"] == next["generation"]
        && previous["sequence"].as_f64() > next["sequence"].as_f64()
}
#[derive(Clone)]
struct Candidate {
    body: Value,
    lifecycle: Value,
    complete: bool,
    started: Value,
    completed: Value,
    origin: Value,
}
impl Candidate {
    fn from(value: &Value) -> Self {
        Self {
            body: value["body"].clone(),
            lifecycle: value["lifecycle"].clone(),
            complete: value["completeBody"] == true,
            started: value["startedAtMs"].clone(),
            completed: value["completedAtMs"].clone(),
            origin: value["origin"].clone(),
        }
    }
    fn value(&self) -> Value {
        object([
            ("body", self.body.clone()),
            ("lifecycle", self.lifecycle.clone()),
            ("completeBody", json!(self.complete)),
            ("startedAtMs", self.started.clone()),
            ("completedAtMs", self.completed.clone()),
            ("origin", self.origin.clone()),
        ])
    }
}
struct Item {
    id: JsString,
    kind: Value,
    revision: f64,
    ordinal: usize,
    candidate: Candidate,
    conflicts: Vec<Candidate>,
}
impl Item {
    fn from(value: &Value) -> Self {
        Self {
            id: value["id"].as_js_string().unwrap().clone(),
            kind: value["identityKind"].clone(),
            revision: value["revision"].as_f64().unwrap(),
            ordinal: value["ordinal"].as_u64().unwrap() as usize,
            candidate: Candidate::from(value),
            conflicts: array(&value["conflicts"])
                .iter()
                .map(Candidate::from)
                .collect(),
        }
    }
    fn value(&self) -> Value {
        let mut v = self.candidate.value();
        v["id"] = json!(self.id);
        v["identityKind"] = self.kind.clone();
        v["revision"] = json!(self.revision);
        v["ordinal"] = json!(self.ordinal);
        v["conflicts"] = Value::Array(self.conflicts.iter().map(Candidate::value).collect());
        v
    }
    fn material(&self) -> Value {
        let mut v = self.value();
        remove(&mut v, "origin");
        remove(&mut v, "revision");
        v
    }
    fn key(&self) -> JsString {
        let mut units = self.kind.as_js_string().unwrap().units().to_vec();
        units.push(58);
        units.extend_from_slice(self.id.units());
        JsString::new(units)
    }
}
struct Turn {
    id: JsString,
    ordinal: usize,
    revision: f64,
    body: Value,
    metadata: Value,
    terminal: Option<Value>,
    origin: Value,
    items: Vec<Item>,
    conflicts: Vec<Value>,
}
impl Turn {
    fn from(v: &Value) -> Self {
        Self {
            id: v["id"].as_js_string().unwrap().clone(),
            ordinal: v["ordinal"].as_u64().unwrap() as usize,
            revision: v["revision"].as_f64().unwrap(),
            body: v["body"].clone(),
            metadata: v["metadata"].clone(),
            terminal: v.get("terminalNotification").cloned(),
            origin: v["origin"].clone(),
            items: array(&v["items"]).iter().map(Item::from).collect(),
            conflicts: array(&v["conflicts"]).to_vec(),
        }
    }
    fn value(&self) -> Value {
        let mut v = object([
            ("id", json!(self.id)),
            ("ordinal", json!(self.ordinal)),
            ("revision", json!(self.revision)),
            ("body", self.body.clone()),
            ("metadata", self.metadata.clone()),
            ("origin", self.origin.clone()),
            (
                "items",
                Value::Array(self.items.iter().map(Item::value).collect()),
            ),
            ("conflicts", Value::Array(self.conflicts.clone())),
        ]);
        if let Some(terminal) = &self.terminal {
            v["terminalNotification"] = terminal.clone();
        }
        v
    }
    fn body_material(&self) -> Value {
        let mut v = object([
            ("body", self.body.clone()),
            ("conflicts", Value::Array(self.conflicts.clone())),
        ]);
        if let Some(terminal) = &self.terminal {
            v["terminalNotification"] = terminal.clone();
        }
        v
    }
}
struct State {
    thread: JsString,
    turns: Vec<Turn>,
    evidence: Vec<Value>,
    notifications: Vec<Value>,
}
impl State {
    fn from(v: &Value) -> Self {
        Self {
            thread: v["threadId"].as_js_string().unwrap().clone(),
            turns: array(&v["turns"]).iter().map(Turn::from).collect(),
            evidence: array(&v["evidence"]).to_vec(),
            notifications: array(&v["notifications"]).to_vec(),
        }
    }
    fn value(&self) -> Value {
        object([
            ("version", json!(1)),
            ("threadId", json!(self.thread)),
            (
                "turns",
                Value::Array(self.turns.iter().map(Turn::value).collect()),
            ),
            ("evidence", Value::Array(self.evidence.clone())),
            ("notifications", Value::Array(self.notifications.clone())),
        ])
    }
    fn ensure_turn(&mut self, id: &JsString, origin: &Value) -> &mut Turn {
        let index = if let Some(index) = self.turns.iter().position(|t| &t.id == id) {
            index
        } else {
            let index = self.turns.len();
            self.turns.push(Turn {
                id: id.clone(),
                ordinal: index,
                revision: 1.0,
                body: json!({"id":id}),
                metadata: Value::Null,
                terminal: None,
                origin: origin.clone(),
                items: Vec::new(),
                conflicts: Vec::new(),
            });
            index
        };
        &mut self.turns[index]
    }
}
/// Records are the verified SourceJournal page: {sequence,recordId,frame}.
/// Clone/parse previous state; never mutate caller data or replay uncertain input.
pub fn reduce(previous: Option<&Value>, records: &[Value], thread: &JsString) -> Result<Value> {
    let initial = object([
        ("version", json!(1)),
        ("threadId", json!(thread)),
        ("turns", Value::Array(Vec::new())),
        ("evidence", Value::Array(Vec::new())),
        ("notifications", Value::Array(Vec::new())),
    ]);
    let mut state = State::from(&checked(
        "nativeHistoryStateSchema",
        previous.filter(|v| !v.is_null()).unwrap_or(&initial),
    )?);
    if &state.thread != thread {
        bail!("Native history state belongs to another thread.");
    }
    for record in records {
        let frame = &record["frame"];
        if frame["threadId"].as_js_string() != Some(thread) {
            bail!("Native history source belongs to another thread.");
        }
        if frame["kind"] == "snapshot" {
            if state
                .evidence
                .iter()
                .any(|v| v["recordId"] == record["recordId"])
            {
                continue;
            }
            let origin = object([
                ("kind", json!("snapshot")),
                ("generation", frame["generation"].clone()),
                ("sequence", frame["readBarrierSequence"].clone()),
            ]);
            snapshots::apply(&mut state, &frame["snapshot"], &origin)?;
            let snapshot = &frame["snapshot"];
            let history = &snapshot["history"];
            let mut extra = snapshot.clone();
            remove(&mut extra, "thread");
            remove(&mut extra, "history");
            let mut header = snapshot["thread"].clone();
            remove(&mut header, "turns");
            extra["thread"] = header;
            let mut history_header = spread(&Value::Null, history);
            remove(&mut history_header, "turns");
            remove(&mut history_header, "live");
            if !history["live"].is_null() {
                history_header["live"] = object([
                    ("epoch", history["live"]["epoch"].clone()),
                    (
                        "throughSequence",
                        history["live"]["throughSequence"].clone(),
                    ),
                ]);
            }
            extra["history"] = if history.is_null() {
                Value::Null
            } else {
                history_header
            };
            state.evidence.push(object([
                ("recordId", record["recordId"].clone()),
                ("method", json!("thread/read")),
                ("params", extra),
            ]));
            continue;
        }
        let boundary = state
            .notifications
            .iter()
            .position(|v| v["generation"] == frame["generation"]);
        if boundary.is_some_and(|i| {
            frame["sequence"].as_f64() <= state.notifications[i]["sequence"].as_f64()
        }) {
            continue;
        }
        let boundary = boundary.unwrap_or_else(|| {
            let i = state.notifications.len();
            state.notifications.push(object([
                ("generation", frame["generation"].clone()),
                ("sequence", json!(0)),
            ]));
            i
        });
        state.notifications[boundary]["sequence"] = frame["sequence"].clone();
        let mut origin = object([
            ("kind", json!("notification")),
            ("generation", frame["generation"].clone()),
            ("sequence", frame["sequence"].clone()),
        ]);
        if let Some(cursor) = frame.get("nativeCursor") {
            origin["nativeCursor"] = cursor.clone();
        }
        let params = &frame["params"];
        let raw_turn = &params["turn"];
        let turn_id = id(&params["turnId"])
            .or_else(|| raw_turn.is_object().then(|| id(&raw_turn["id"])).flatten());
        if let Some(turn_id) = turn_id {
            let turn = state.ensure_turn(&turn_id, &origin);
            if raw_turn.is_object()
                && matches!(
                    frame["method"].as_str(),
                    Some("turn/started" | "turn/completed")
                )
            {
                turns::apply(turn, raw_turn, &origin, frame["method"] == "turn/completed")?;
                if frame["method"] == "turn/started" {
                    turns::retain_settings(turn, &params["initialSettings"]);
                    if let Ok(attribution) = checked(
                        "nativeTurnModelAttributionSchema",
                        &params["cantripModelAttribution"],
                    ) && attribution["threadId"].as_js_string() == Some(thread)
                        && attribution["turnId"].as_js_string() == Some(&turn.id)
                    {
                        let prior = &turn.metadata["cantripModelAttribution"];
                        if !coercion::truthy(Some(prior)) {
                            turn.metadata = spread(
                                &turn.metadata,
                                &object([("cantripModelAttribution", attribution)]),
                            );
                            turn.revision += 1.0;
                        } else if !equal(prior, &attribution) {
                            let conflict = object([("cantripModelAttribution", attribution)]);
                            if !turn.conflicts.iter().any(|v| equal(v, &conflict)) {
                                turn.conflicts.push(conflict);
                                turn.revision += 1.0;
                            }
                        }
                    }
                }
                for raw in array(&raw_turn["items"]) {
                    if raw.is_object()
                        && let (Some(id), Some(_)) = (id(&raw["id"]), id(&raw["type"]))
                    {
                        items::apply(
                            turn,
                            &id,
                            "canonical",
                            Candidate {
                                body: raw.clone(),
                                lifecycle: json!("unknown"),
                                complete: raw_turn["itemsView"] != "summary"
                                    && raw_turn["itemsView"] != "notLoaded",
                                started: Value::Null,
                                completed: Value::Null,
                                origin: origin.clone(),
                            },
                            false,
                        );
                    }
                }
                continue;
            }
            let raw = &params["item"];
            if raw.is_object()
                && matches!(
                    frame["method"].as_str(),
                    Some("item/started" | "item/completed")
                )
                && let (Some(id), Some(_)) = (id(&raw["id"]), id(&raw["type"]))
            {
                items::apply(
                    turn,
                    &id,
                    "canonical",
                    Candidate {
                        body: raw.clone(),
                        lifecycle: json!(if frame["method"] == "item/completed" {
                            "completed"
                        } else {
                            "started"
                        }),
                        complete: true,
                        started: time(&params["startedAtMs"]),
                        completed: time(&params["completedAtMs"]),
                        origin: origin.clone(),
                    },
                    frame["method"] == "item/started",
                );
                continue;
            }
            if items::delta(turn, params, &frame["method"], &origin)? {
                continue;
            }
        }
        state.evidence.push(object([
            ("recordId", record["recordId"].clone()),
            ("method", frame["method"].clone()),
            ("params", params.clone()),
        ]));
    }
    for (ordinal, turn) in state.turns.iter_mut().enumerate() {
        if turn.ordinal != ordinal {
            turn.ordinal = ordinal;
            turn.revision += 1.0;
        }
        for (ordinal, item) in turn.items.iter_mut().enumerate() {
            if item.ordinal != ordinal {
                item.ordinal = ordinal;
                item.revision += 1.0;
            }
        }
    }
    checked("nativeHistoryStateSchema", &state.value())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_deep_equality_preserves_signed_zero_and_ignores_key_order() {
        let left = crate::parse(r#"{"a":[-0],"b":"\ud800"}"#).unwrap();
        let same = crate::parse(r#"{"b":"\ud800","a":[-0]}"#).unwrap();
        let positive = crate::parse(r#"{"a":[0],"b":"\ud800"}"#).unwrap();
        assert!(equal(&left, &same));
        assert!(!equal(&left, &positive));
    }
    #[test]
    fn signed_zero_item_changes_are_real_revisions_before_wire_serialization() -> Result<()> {
        let records = crate::parse(
            r#"[
            {"sequence":1,"recordId":"00000000-0000-4000-8000-000000000001","frame":{"kind":"notification","generation":"runtime","sequence":1,"threadId":"thread","method":"item/completed","params":{"turnId":"turn","item":{"id":"answer","type":"agentMessage","value":-0}}}},
            {"sequence":2,"recordId":"00000000-0000-4000-8000-000000000002","frame":{"kind":"notification","generation":"runtime","sequence":2,"threadId":"thread","method":"item/completed","params":{"turnId":"turn","item":{"id":"answer","type":"agentMessage","value":0}}}}
        ]"#,
        )?;
        let state = reduce(None, records.as_array().unwrap(), &"thread".into())?;
        assert_eq!(
            state["turns"].as_array().unwrap()[0]["items"]
                .as_array()
                .unwrap()[0]["revision"],
            2
        );
        Ok(())
    }
}
