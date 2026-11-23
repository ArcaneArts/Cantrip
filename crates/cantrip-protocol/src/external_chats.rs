//! Existing external-history attachment identity and transcript refinements.
use super::{Parsed, ValidationError, Value, value::json};
use indexmap::{IndexMap, IndexSet};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(tag, "external-chat-attachment" | "external-chat-transcript") {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut issue = |suffix: Vec<Value>, message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix);
        result.issue(json!({"code":"custom"}), &at, message.into(), false);
    };
    if tag == "external-chat-attachment" {
        if value["status"] == "available" && value["sizeBytes"] == json!(0) {
            issue(
                vec![json!("sizeBytes")],
                "Available external attachments cannot be empty.",
            );
        }
        return Ok(true);
    }
    if value["titleProtection"]["classification"]["recordKind"] != "chat" {
        issue(
            vec![
                json!("titleProtection"),
                json!("classification"),
                json!("recordKind"),
            ],
            "Imported title classification must be chat.",
        );
    }
    let attachments = value["attachments"]
        .as_array()
        .ok_or(ValidationError::Operation)?;
    let ids = attachments
        .iter()
        .map(|a| a["id"].clone().stringify())
        .collect::<IndexSet<_>>();
    if ids.len() != attachments.len() {
        issue(
            vec![json!("attachments")],
            "External attachment ids must be unique.",
        );
    }
    let mut references = IndexMap::new();
    for (turn_index, turn) in value["sync"]["turns"]
        .as_array()
        .ok_or(ValidationError::Operation)?
        .iter()
        .enumerate()
    {
        for (item_index, item) in turn["items"]
            .as_array()
            .ok_or(ValidationError::Operation)?
            .iter()
            .enumerate()
        {
            if item["type"] != "userMessage" {
                continue;
            }
            for id in item["externalAttachmentIds"]
                .as_array()
                .ok_or(ValidationError::Operation)?
            {
                let key = id.clone().stringify();
                if references.contains_key(&key) {
                    issue(
                        vec![
                            json!("sync"),
                            json!("turns"),
                            json!(turn_index),
                            json!("items"),
                            json!(item_index),
                            json!("externalAttachmentIds"),
                        ],
                        "An external attachment may be referenced only once.",
                    );
                }
                references.insert(key, (id.clone(), item["id"].clone()));
            }
        }
    }
    for (index, attachment) in attachments.iter().enumerate() {
        if references
            .get(&attachment["id"].clone().stringify())
            .is_none_or(|(_, item)| item != &attachment["itemId"])
        {
            issue(
                vec![json!("attachments"), json!(index), json!("itemId")],
                "Every external attachment must reference its originating user message.",
            );
        }
    }
    for (key, _) in references {
        if !ids.contains(&key) {
            issue(
                vec![json!("sync")],
                "External attachment references require a descriptor.",
            );
        }
    }
    Ok(true)
}
