use crate::wire::{JsString, Value, value::json};
use anyhow::{Context, Result};

pub(super) fn key(prefix: &Value, turn: &Value, item: &Value) -> Result<Value> {
    let mut units = Vec::new();
    for (index, value) in [prefix, turn, item].into_iter().enumerate() {
        if index > 0 {
            units.push(u16::from(b':'));
        }
        units.extend(
            value
                .as_js_string()
                .context("Thread sync item identity")?
                .units(),
        );
    }
    Ok(Value::String(JsString::new(units)))
}

/// The existing console/import projection, preserving UTF-16 and omitted fields.
pub fn canonical_messages(
    sync: &Value,
    options: &Value,
    attachments: Option<&Value>,
) -> Result<Vec<Value>> {
    let mut messages = Vec::new();
    for turn in sync["turns"]
        .as_array()
        .context("Native synchronization turns")?
    {
        for item in turn["items"]
            .as_array()
            .context("Native synchronization items")?
        {
            let (role, content, activity, identity) = match item["type"].as_str() {
                Some("userMessage") => {
                    let mut content = Vec::new();
                    if !item["text"]
                        .as_js_string()
                        .context("Native user text")?
                        .trim()
                        .is_empty()
                    {
                        content.push(json!({"type":"text","text":item["text"]}));
                    }
                    for id in item["externalAttachmentIds"]
                        .as_array()
                        .context("Native external attachments")?
                    {
                        if let Some(attachment) = id
                            .as_str()
                            .and_then(|id| attachments.and_then(|a| a.get(id)))
                        {
                            content.push(json!({"type":"attachment","attachment":attachment}));
                        }
                    }
                    if content.is_empty() {
                        content.push(json!({"type":"text","text":"[Imported message content was unavailable.]"}));
                    }
                    (
                        "user",
                        Value::Array(content),
                        Value::Null,
                        item["id"].clone(),
                    )
                }
                Some("agentMessage") => {
                    let mut content =
                        json!({"type":"text","text":item["text"],"phase":item["phase"]});
                    if let Some(correlation) = item.get("correlation") {
                        content["correlation"] = correlation.clone();
                    }
                    (
                        "assistant",
                        Value::Array(vec![content]),
                        Value::Null,
                        item["id"].clone(),
                    )
                }
                _ => (
                    "assistant",
                    Value::Array(vec![json!({"type":"activity","activity":item["activity"]})]),
                    item["activity"].clone(),
                    item["activity"]["id"].clone(),
                ),
            };
            messages.push(json!({"turnId":turn["id"],"activity":activity,"message":json!({"role":role,"content":content,"idempotencyKey":key(&options["idempotencyPrefix"],&turn["id"],&identity)?})}));
        }
        if matches!(turn["status"].as_str(), Some("failed" | "interrupted")) {
            let text = &options[if turn["status"] == "interrupted" {
                "interruptedMessage"
            } else {
                "failedMessage"
            }];
            messages.push(json!({"turnId":turn["id"],"activity":Value::Null,"message":json!({"role":"system","content":Value::Array(vec![json!({"type":"text","text":text})]),"idempotencyKey":key(&options["idempotencyPrefix"],&turn["id"],&json!("status"))?})}));
        }
    }
    Ok(messages)
}
