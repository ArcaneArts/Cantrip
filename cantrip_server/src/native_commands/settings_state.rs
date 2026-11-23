//! Pure native settings transitions; callers hold the owning Chat lock and source authority.
use crate::wire::{Value, coercion::truthy, value::json};
use anyhow::{Context, Result, bail};
use num_bigint::BigInt;

fn parse(schema: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(schema, Some(value))
}
fn integer(value: &Value) -> Result<BigInt> {
    Ok(value
        .as_str()
        .context("Native settings revision")?
        .parse()?)
}
fn advance(mut state: Value) -> Result<Value> {
    state["revision"] = json!((integer(&state["revision"])? + BigInt::from(1)).to_string());
    Ok(state)
}
pub fn empty(chat: &str) -> Result<Value> {
    parse(
        "nativeSettingsStateSchema",
        &json!({"chatId":chat,"revision":"0","desiredRevision":"0","desired":Value::Null,"desiredStatus":Value::Null,"pending":Value::Array(vec![]),"binding":Value::Null,"effective":Value::Null}),
    )
}
fn matches_source(binding: &Value, source: &Value) -> bool {
    ["workerId", "threadId", "runtimeGeneration"]
        .iter()
        .all(|field| binding.get(field) == source.get(field))
}
fn in_binding(binding: &Value, snapshot: &Value) -> bool {
    let source = &snapshot["context"];
    ["chatId", "workerId", "threadId", "runtimeGeneration"]
        .iter()
        .all(|field| source.get(field) == binding.get(field))
        && source["settingsVersion"].get("epoch") == binding.get("nativeEpoch")
}
fn retain_model(previous: &Value, next: &Value) -> Result<Value> {
    let prior = previous.get("modelAttribution");
    let incoming = next.get("modelAttribution");
    let mut result = next.clone();
    if prior.is_some_and(|v| v["selection"]["status"] == "resolved") {
        if incoming.is_some_and(|v| v["selection"]["status"] == "resolved")
            && prior.map(|v| &v["selection"]) != incoming.map(|v| &v["selection"])
        {
            bail!("Native settings version has conflicting model attribution.");
        }
        result["modelAttribution"] = prior.unwrap().clone();
    } else if !truthy(incoming)
        && let Some(prior) = prior.filter(|v| truthy(Some(v)))
    {
        result["modelAttribution"] = prior.clone();
    }
    Ok(result)
}

pub fn request(value: &Value, input: &Value) -> Result<Value> {
    let mut state = parse("nativeSettingsStateSchema", value)?;
    let intent = parse("nativeSettingsIntentSchema", input)?;
    let pending = state["pending"]
        .as_array()
        .context("Settings pending entries")?;
    let existing = pending
        .iter()
        .find(|entry| entry["intent"]["operationId"] == intent["operationId"])
        .map(|entry| &entry["intent"])
        .or_else(|| {
            (state["desired"]["operationId"] == intent["operationId"]).then_some(&state["desired"])
        });
    if let Some(existing) = existing {
        if [
            "operationGeneration",
            "origin",
            "payloadDigest",
            "permissionTransition",
            "source",
        ]
        .iter()
        .any(|field| existing.get(field) != intent.get(field))
        {
            bail!("Settings operation identity was reused with another intent.");
        }
        return Ok(state);
    }
    let revision = json!((integer(&state["desiredRevision"])? + BigInt::from(1)).to_string());
    let binding =
        if truthy(state.get("binding")) && matches_source(&state["binding"], &intent["source"]) {
            state["binding"]["bindingId"].clone()
        } else {
            Value::Null
        };
    let mut pending = pending.clone();
    pending.push(
        json!({"intent":intent,"desiredRevision":revision,"bindingId":binding,"status":"accepted"}),
    );
    state["desiredRevision"] = revision;
    state["desired"] = intent;
    state["desiredStatus"] = json!("accepted");
    state["pending"] = Value::Array(pending);
    advance(state)
}

pub fn bind(
    value: &Value,
    expected: &Value,
    input_binding: &Value,
    input_snapshot: &Value,
) -> Result<Value> {
    let mut state = parse("nativeSettingsStateSchema", value)?;
    let binding = parse("nativeSettingsBindingSchema", input_binding)?;
    let snapshot = parse("protectedNativeSettingsSnapshotSchema", input_snapshot)?;
    let prior_id = state["binding"]
        .get("bindingId")
        .cloned()
        .unwrap_or(Value::Null);
    if prior_id != *expected {
        bail!("Settings read binding was replaced before publication.");
    }
    if binding["chatId"] != state["chatId"] || !in_binding(&binding, &snapshot) {
        bail!("Settings read does not match its authorized binding.");
    }
    if prior_id == binding["bindingId"] {
        if state["binding"] != binding {
            bail!("Settings binding identity was reused.");
        }
        return observe(&state, &binding["bindingId"], &snapshot);
    }
    let same_native = !state["effective"].is_null() && in_binding(&binding, &state["effective"]);
    let mut effective = snapshot.clone();
    if same_native {
        let previous = &state["effective"];
        let prior = integer(&previous["context"]["settingsVersion"]["revision"])?;
        let next = integer(&snapshot["context"]["settingsVersion"]["revision"])?;
        if next < prior {
            effective = previous.clone();
        } else if next == prior
            && previous["protectedContent"]["keyRevision"]
                == snapshot["protectedContent"]["keyRevision"]
        {
            if previous["contentFingerprint"] != snapshot["contentFingerprint"] {
                bail!("Settings version has conflicting content.");
            }
            effective = retain_model(previous, &snapshot)?;
        }
    }
    let mut pending = state["pending"]
        .as_array()
        .context("Settings pending entries")?
        .clone();
    for entry in &mut pending {
        if !same_native
            && ((truthy(entry.get("bindingId")) && entry["bindingId"] != binding["bindingId"])
                || (!entry["intent"]["source"]["runtimeGeneration"].is_null()
                    && !matches_source(&binding, &entry["intent"]["source"])))
        {
            entry["status"] = json!("uncertain");
        }
    }
    if let Some(entry) = pending
        .iter()
        .find(|entry| entry["intent"].get("operationId") == state["desired"].get("operationId"))
    {
        state["desiredStatus"] = entry["status"].clone();
    }
    state["binding"] = binding;
    state["effective"] = effective;
    state["pending"] = Value::Array(pending);
    advance(state)
}

pub fn observe(value: &Value, binding: &Value, input: &Value) -> Result<Value> {
    let mut state = parse("nativeSettingsStateSchema", value)?;
    let snapshot = parse("protectedNativeSettingsSnapshotSchema", input)?;
    if !truthy(state.get("binding"))
        || state["binding"].get("bindingId") != Some(binding)
        || !in_binding(&state["binding"], &snapshot)
    {
        bail!("Settings observation belongs to a retired binding.");
    }
    if !state["effective"].is_null() {
        let previous = &state["effective"];
        let prior = integer(&previous["context"]["settingsVersion"]["revision"])?;
        let next = integer(&snapshot["context"]["settingsVersion"]["revision"])?;
        if next < prior {
            return Ok(state);
        }
        if next == prior {
            if previous["protectedContent"]["keyRevision"]
                != snapshot["protectedContent"]["keyRevision"]
            {
                bail!("Settings key rotation requires a fresh authorized read binding.");
            }
            if previous["contentFingerprint"] != snapshot["contentFingerprint"] {
                bail!("Settings version has conflicting content.");
            }
            let effective = retain_model(previous, &snapshot)?;
            if previous.get("modelAttribution") == effective.get("modelAttribution") {
                return Ok(state);
            }
            state["effective"] = effective;
            return advance(state);
        }
    }
    state["effective"] = snapshot;
    advance(state)
}

pub fn settle(value: &Value, operation: &Value, outcome: &str) -> Result<Value> {
    let mut state = parse("nativeSettingsStateSchema", value)?;
    let pending = state["pending"]
        .as_array()
        .context("Settings pending entries")?;
    let index = pending
        .iter()
        .position(|entry| entry["intent"].get("operationId") == operation.get("operationId"));
    let desired = state["desired"].get("operationId") == operation.get("operationId");
    let intent = index
        .map(|i| &pending[i]["intent"])
        .or_else(|| desired.then_some(&state["desired"]));
    let Some(intent) = intent else {
        return Ok(state);
    };
    if intent.get("operationGeneration") != operation.get("operationGeneration") {
        bail!("Settings result belongs to another command generation.");
    }
    let current = index
        .map(|i| &pending[i]["status"])
        .unwrap_or(&state["desiredStatus"]);
    if (outcome == "dispatched" && *current != "accepted")
        || *current == outcome
        || (index.is_none() && *current == "uncertain")
    {
        return Ok(state);
    }
    let status = if desired
        && ((state["desiredStatus"] == "applied" && outcome == "rejected")
            || (state["desiredStatus"] == "rejected" && outcome == "applied"))
    {
        json!("uncertain")
    } else if desired {
        json!(outcome)
    } else {
        state["desiredStatus"].clone()
    };
    let mut pending = pending.clone();
    if let Some(i) = index {
        if ["applied", "rejected"].contains(&outcome) {
            pending.remove(i);
        } else {
            pending[i]["status"] = json!(outcome);
        }
    }
    state["desiredStatus"] = status;
    state["pending"] = Value::Array(pending);
    advance(state)
}
