//! Open authenticated history pages without choosing winners or advancing cursors.
use crate::{canonical, checked, content::Encryption, outbox::baseline::payload_digest};
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};
pub type Check<'a> = Option<&'a (dyn Fn() -> Result<()> + Send + Sync)>;
fn active(check: Check<'_>) -> Result<()> {
    if let Some(check) = check {
        check()?;
    }
    Ok(())
}
fn binding(page: &Value, id: &Value, worker: &Value) -> Value {
    json!({"id":id,"workerId":worker,"chatId":page["binding"]["chatId"],"threadId":page["binding"]["threadId"]})
}
pub fn validate_batches(raw: &Value) -> Result<Value> {
    let page = checked("nativeHistoryBatchArchivePageSchema", raw)?;
    for entry in page["batches"].as_array().unwrap() {
        let batch = &entry["batch"];
        if batch.is_null() {
            continue;
        }
        if entry["payloadDigest"] != payload_digest(batch, &entry["previousDigest"])
            || batch["items"].as_array().unwrap().iter().any(|item| {
                item["identity"]["threadId"] != page["binding"]["threadId"]
                    || item["attachments"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|a| a["chatId"] != page["binding"]["chatId"])
                    || (!item["evidence"].is_null()
                        && (item["evidence"]["bindingId"] != entry["bindingId"]
                            || item["evidence"]["workerId"] != entry["workerId"]))
            })
            || batch["turns"]
                .as_array()
                .unwrap()
                .iter()
                .any(|turn| turn["threadId"] != page["binding"]["threadId"])
        {
            bail!("Native history returned an unrelated or inconsistent batch archive page.");
        }
    }
    Ok(page)
}
pub fn open_items(service: &dyn Encryption, raw: &Value, check: Check<'_>) -> Result<Value> {
    active(check)?;
    let mut page = checked("nativeHistoryArchivePageSchema", raw)?;
    let mut items = Vec::new();
    for item in page["items"].as_array().unwrap() {
        active(check)?;
        if item["identity"]["threadId"] != page["binding"]["threadId"] {
            bail!("Archived item belongs to another native thread.");
        }
        let mut item = item.clone();
        let evidence = &item["evidence"];
        let source = if evidence.is_null() {
            Value::Null
        } else {
            canonical::open_item(
                service,
                &binding(&page, &evidence["bindingId"], &evidence["workerId"]),
                &item["identity"],
                evidence,
            )?
        };
        let revision = if evidence.is_null() {
            Value::Null
        } else {
            evidence["revision"].clone()
        };
        let current = !evidence.is_null() && evidence["revision"] == item["revision"];
        item["sourceRevision"] = revision;
        item["sourceCurrent"] = json!(current);
        item["source"] = source;
        items.push(item);
    }
    active(check)?;
    page["items"] = Value::Array(items);
    Ok(page)
}
pub fn open_turns(service: &dyn Encryption, raw: &Value, check: Check<'_>) -> Result<Value> {
    active(check)?;
    let mut page = checked("nativeHistoryTurnArchivePageSchema", raw)?;
    let mut turns = Vec::new();
    for entry in page["turns"].as_array().unwrap() {
        active(check)?;
        if entry["turn"]["threadId"] != page["binding"]["threadId"] {
            bail!("Archived turn belongs to another native thread.");
        }
        let source = canonical::open_turn(
            service,
            &binding(&page, &entry["bindingId"], &entry["workerId"]),
            &entry["turn"],
        )?;
        let mut entry = entry.clone();
        entry["source"] = source;
        turns.push(entry);
    }
    active(check)?;
    page["turns"] = Value::Array(turns);
    Ok(page)
}
pub fn open_batches(service: &dyn Encryption, raw: &Value, check: Check<'_>) -> Result<Value> {
    active(check)?;
    let mut page = validate_batches(raw)?;
    let mut batches = Vec::new();
    for entry in page["batches"].as_array().unwrap() {
        active(check)?;
        let bound = binding(&page, &entry["bindingId"], &entry["workerId"]);
        let batch = &entry["batch"];
        let mut items = Vec::new();
        let mut turns = Vec::new();
        if !batch.is_null() {
            for item in batch["items"].as_array().unwrap() {
                active(check)?;
                let source = if item["evidence"].is_null() {
                    Value::Null
                } else {
                    canonical::open_item(service, &bound, &item["identity"], &item["evidence"])?
                };
                let mut item = item.clone();
                item["source"] = source;
                items.push(item);
            }
            for turn in batch["turns"].as_array().unwrap() {
                active(check)?;
                let source = canonical::open_turn(service, &bound, turn)?;
                let mut turn = turn.clone();
                turn["source"] = source;
                turns.push(turn);
            }
        }
        let source = if batch.is_null() {
            Value::Null
        } else {
            json!({"items":items,"turns":turns})
        };
        let mut entry = entry.clone();
        entry["source"] = source;
        batches.push(entry);
    }
    active(check)?;
    page["batches"] = Value::Array(batches);
    Ok(page)
}
