use super::*;
use cantrip_wire::JsString;
use std::cmp::Ordering;

fn material(
    service: &dyn Encryption,
    binding: &Value,
    header: &Value,
    revision: Option<u64>,
) -> Result<(Value, Zeroizing<Vec<u8>>)> {
    if binding["threadId"] != header["threadId"] {
        bail!("Native turn metadata belongs to a different history binding.");
    }
    let mut row = vec![
        binding["workerId"].clone(),
        binding["chatId"].clone(),
        binding["id"].clone(),
        header["threadId"].clone(),
        header["turnId"].clone(),
        header["revision"].clone(),
        header["ordinal"].clone(),
        header["status"].clone(),
        header["startedAtMs"].clone(),
        header["completedAtMs"].clone(),
    ];
    if let Some(usage) = header.get("usage") {
        row.push(usage.clone());
    }
    if let Some(capture) = header.get("modelAttribution") {
        row.push(json!({"modelAttribution":capture}));
    }
    field_material(
        service,
        Value::Array(row),
        "native-history-turns",
        "metadata",
        revision,
    )
}
pub fn protect_turn(
    service: &dyn Encryption,
    binding: &Value,
    raw_header: &Value,
    raw_content: &Value,
) -> Result<Value> {
    let mut header = checked("nativeHistoryTurnHeaderSchema", raw_header)?;
    let content = json_content(raw_content)?;
    let (aad, key) = material(service, binding, &header, None)?;
    header["metadata"] = seal_json(&key, &aad, &content)?;
    checked("nativeHistoryTurnSchema", &header)
}
pub fn open_turn(service: &dyn Encryption, binding: &Value, raw: &Value) -> Result<Value> {
    let turn = checked("nativeHistoryTurnSchema", raw)?;
    let (aad, key) = material(
        service,
        binding,
        &turn,
        turn["metadata"]["keyRevision"].as_u64(),
    )?;
    json_content(&open_json(&key, &aad, &turn["metadata"])?)
}
pub fn model_attribution(thread: &Value, turn: &Value, metadata: &Value) -> Option<Value> {
    checked(
        "nativeTurnModelAttributionSchema",
        &metadata["cantripModelAttribution"],
    )
    .ok()
    .filter(|capture| capture["threadId"] == *thread && capture["turnId"] == *turn)
}
pub fn usage_for_turn(
    thread: &Value,
    turn: &Value,
    metadata: &Value,
    compare: impl Fn(&JsString, &JsString) -> Ordering,
) -> Result<Option<Value>> {
    let Ok(source) = checked("nativeHistoryUsageSourceSchema", metadata) else {
        return Ok(None);
    };
    if source["usage"].is_null() && source["retention"] != "complete" {
        return Ok(None);
    }
    let retained = source["usage"]["responses"].as_array();
    let responses = retained
        .into_iter()
        .flatten()
        .filter(|response| response["threadId"] == *thread)
        .map(|response| json!({"responseId":response["responseId"],"usage":response["usage"]}))
        .collect::<Vec<_>>();
    if retained.is_some_and(|values| !values.is_empty()) && responses.is_empty() {
        return Ok(None);
    }
    let conflicts = source["usage"]["conflictingResponseIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|id| responses.iter().any(|r| r["responseId"] == **id))
        .cloned()
        .collect::<Vec<_>>();
    let mut incoming = json!({"version":1,"responses":responses,"complete":source["retention"]=="complete","conflictingResponseIds":conflicts});
    if let Some(capture) = model_attribution(thread, turn, &source) {
        incoming["modelAttribution"] = capture;
    }
    let (merged, _) = cantrip_protocol::history::reconcile_usage(None, &incoming, compare)?;
    let mut fields = vec![("version", json!(1))];
    if let Some(capture) = merged.get("modelAttribution") {
        fields.push(("modelAttribution", capture.clone()));
    }
    fields.extend([
        ("responses", merged["responses"].clone()),
        (
            "conflictingResponseIds",
            merged["conflictingResponseIds"].clone(),
        ),
        ("complete", merged["complete"].clone()),
    ]);
    Ok(Some(Value::object(fields)))
}
pub fn prepare_turn(
    service: &dyn Encryption,
    binding: &Value,
    snapshot: &Value,
    turn_id: &Value,
    revision: &Value,
    compare: impl Fn(&JsString, &JsString) -> Ordering,
) -> Result<Value> {
    if snapshot["thread"]["id"] != binding["threadId"] {
        bail!("Native history belongs to a different binding.");
    }
    let found = snapshot["thread"]["turns"].as_array().and_then(|turns| {
        turns
            .iter()
            .enumerate()
            .find(|(_, turn)| turn["id"] == *turn_id)
    });
    let Some((ordinal, source)) = found else {
        bail!("Native history does not contain the requested turn.");
    };
    let evidence = snapshot["history"]["turns"]
        .as_array()
        .and_then(|values| values.iter().find(|v| v["turnId"] == *turn_id))
        .cloned()
        .unwrap_or(Value::Null);
    let mut native_turn = source.clone();
    if let Value::Object(fields) = &mut native_turn {
        fields.shift_remove("items");
    }
    let content = json_content(&Value::object([
        ("version", json!(1)),
        ("nativeTurn", native_turn),
        (
            "parentThreadId",
            snapshot["thread"]["parentThreadId"].clone(),
        ),
        ("forkedFromId", snapshot["thread"]["forkedFromId"].clone()),
        ("history", evidence.clone()),
    ]))?;
    let milliseconds = |key: &str| -> Result<Value> {
        let value = &source[key];
        if value.is_null() {
            Ok(Value::Null)
        } else {
            Ok(Value::Number(
                cantrip_wire::coercion::number(Some(value))
                    .map_err(|_| anyhow!("Cannot convert a Symbol value to a number"))?
                    * 1000.0,
            ))
        }
    };
    // Validate computed numbers before JSON serialization can normalize infinity.
    let mut header = Value::object([
        ("threadId", binding["threadId"].clone()),
        ("turnId", turn_id.clone()),
        ("revision", revision.clone()),
        ("ordinal", json!(ordinal)),
        ("status", source["status"].clone()),
        ("startedAtMs", milliseconds("startedAt")?),
        ("completedAtMs", milliseconds("completedAt")?),
    ]);
    if let Some(capture) = model_attribution(&binding["threadId"], turn_id, &evidence) {
        header["modelAttribution"] = capture;
    }
    if let Some(usage) = usage_for_turn(&binding["threadId"], turn_id, &evidence, compare)? {
        header["usage"] = usage;
    }
    protect_turn(service, binding, &header, &content)
}
