//! Complete authenticated archive baselines; no synthetic batch ciphertext.
use super::*;

pub fn payload_digest(batch: &Value, previous: &Value) -> String {
    cantrip_wire::payload_digest(&object([
        ("batch", batch.clone()),
        ("previousDigest", previous.clone()),
    ]))
}
pub fn validate(raw: &Value, stream: &Value) -> Result<Vec<Value>> {
    let entries = checked("nativeHistoryOutboxBaselineSchema", raw)?;
    let entries = entries.as_array().unwrap();
    let (mut records, mut commits) = (HashSet::new(), HashSet::new());
    for (index, entry) in entries.iter().enumerate() {
        let receipt = &entry["receipt"];
        let previous = if index == 0 {
            Value::Null
        } else {
            entries[index - 1]["receipt"]["digest"].clone()
        };
        if receipt["streamId"] != *stream
            || sequence(receipt) != index as u64 + 1
            || entry["previousDigest"] != previous
            || !records.insert(identifier(receipt))
            || !commits.insert(receipt["commitId"].as_js_string().unwrap().clone())
        {
            bail!("Recovered native history receipts have a gap or conflicting identity.");
        }
    }
    Ok(entries.clone())
}
pub fn prepare(recovery: &Value, scope: &Value) -> Result<Option<Value>> {
    let binding = &recovery["binding"];
    if binding["id"] != scope["bindingId"]
        || binding["chatId"] != scope["chatId"]
        || binding["workerId"] != scope["workerId"]
    {
        bail!("Native history outbox recovery belongs to a different binding.");
    }
    let selected = recovery["batches"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Native history recovery has no batch archive."))?
        .iter()
        .filter(|v| v["bindingId"] == scope["bindingId"])
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    for (index, entry) in selected.iter().enumerate() {
        let previous = if index == 0 {
            Value::Null
        } else {
            selected[index - 1]["receipt"]["digest"].clone()
        };
        if entry["workerId"] != scope["workerId"]
            || (cantrip_wire::coercion::truthy(Some(&entry["batch"]))
                && (entry["previousDigest"] != previous
                    || entry["payloadDigest"]
                        != payload_digest(
                            &checked("nativeHistoryPreparedBatchSchema", &entry["batch"])?,
                            &previous,
                        )))
        {
            bail!("Recovered native history batch content does not match its receipt.");
        }
        entries.push(object([
            ("receipt", entry["receipt"].clone()),
            ("previousDigest", previous),
            ("payloadDigest", entry["payloadDigest"].clone()),
        ]));
    }
    let Some(stream) = entries
        .first()
        .map(|v| v["receipt"]["streamId"].clone())
        .filter(|v| cantrip_wire::coercion::truthy(Some(v)))
    else {
        return Ok(None);
    };
    Ok(Some(object([
        ("streamId", stream.clone()),
        (
            "entries",
            Value::Array(validate(&Value::Array(entries), &stream)?),
        ),
    ])))
}
fn parse_body(body: &JsString) -> Result<Value> {
    if let Some(text) = body.as_str() {
        return parse(text);
    }
    let mut text = String::new();
    for scalar in char::decode_utf16(body.units().iter().copied()) {
        match scalar {
            Ok(ch) => text.push(ch),
            Err(e) => text.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    parse(&text)
}
pub fn verify_body(entry: &Value, body: &JsString) -> Result<()> {
    let batch = checked("nativeHistoryPreparedBatchSchema", &parse_body(body)?)?;
    if entry["payloadDigest"] != payload_digest(&batch, &entry["previousDigest"]) {
        bail!("Recovered native history receipt belongs to different batch content.");
    }
    Ok(())
}
/// Only matched authenticated server responses may prove permanent rejection.
/// Transport errors and an ordinary HTTP 409 are not such proof.
pub fn verify_rejection(raw: &Value, request: &Value, code: &Value) -> Result<Value> {
    let rejection = checked("nativeHistoryBatchRejectionSchema", raw)?;
    let request = checked("nativeHistoryIngestSchema", request)?;
    if *code != rejection["code"]
        || request.as_object().unwrap().iter().any(|(key, value)| {
            key.as_str() != Some("batch") && rejection.as_object().unwrap().get(key) != Some(value)
        })
        || rejection["payloadDigest"]
            != payload_digest(&request["batch"], &request["previousDigest"])
    {
        bail!("Native history returned an unrelated batch rejection.");
    }
    Ok(rejection)
}
