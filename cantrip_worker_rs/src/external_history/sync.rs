use crate::{
    http::checked,
    native_items::{bounded, concat, join, normalize, slice},
};
use anyhow::{Context, Result};
use cantrip_crypto::content::attachment_digest;
use cantrip_wire::{JsString, Value, value::json};
use std::collections::HashMap;

pub(super) fn sync(thread: &Value, cwd: &Value, attachments: &[Value]) -> Result<Value> {
    let mut by_item: HashMap<_, Vec<Value>> = HashMap::new();
    for attachment in attachments {
        by_item
            .entry(
                attachment["itemId"]
                    .as_js_string()
                    .context("Missing external attachment item.")?,
            )
            .or_default()
            .push(attachment["id"].clone());
    }
    let turns = thread["turns"]
        .as_array()
        .context("Codex returned an invalid thread/read response.")?;
    let status = if thread["status"]["type"] == "active" {
        "running"
    } else if thread["status"]["type"] == "systemError"
        || turns.last().is_some_and(|turn| turn["status"] == "failed")
    {
        "failed"
    } else {
        "idle"
    };
    let rendered = turns
        .iter()
        .map(|turn| normalize_turn(&thread["id"], turn, cwd, &by_item))
        .collect::<Result<Vec<_>>>()?;
    checked(
        "agentThreadSyncSchema",
        &json!({"threadId":thread["id"],"status":status,"statusSource":"native-thread","turns":rendered}),
    )
}

fn normalize_turn(
    thread: &Value,
    turn: &Value,
    cwd: &Value,
    attachments: &HashMap<&JsString, Vec<Value>>,
) -> Result<Value> {
    let items = turn["items"]
        .as_array()
        .context("Missing external Codex turn items.")?;
    let active = turn["status"] == "inProgress";
    let success = turn["status"] == "completed";
    let settled = if success { "completed" } else { "failed" };
    let last_final = success
        .then(|| {
            items.iter().rposition(|item| {
                item["type"] == "agentMessage"
                    && item["phase"] != "commentary"
                    && item["text"]
                        .as_js_string()
                        .is_some_and(|text| !text.trim().is_empty())
            })
        })
        .flatten();
    let correlation = |item: &Value| {
        json!({
            "sourceMethod":"thread/read","diagnosticId":Value::Null,
            "threadId":thread,"turnId":turn["id"],"itemId":item,
        })
    };
    let mut output = Vec::new();
    for (index, item) in items.iter().enumerate() {
        match item["type"].as_str() {
            Some("userMessage") => {
                let text = join(
                    item["content"]
                        .as_array()
                        .context("Missing external user message content.")?
                        .iter()
                        .filter(|part| part["type"] == "text")
                        .filter_map(|part| part["text"].as_js_string())
                        .filter(|text| !text.is_empty())
                        .cloned(),
                    "\n\n",
                )
                .trim();
                let ids = item["id"].as_js_string().and_then(|id| attachments.get(id));
                if !text.is_empty() || ids.is_some_and(|ids| !ids.is_empty()) {
                    output.push(json!({"type":"userMessage","id":item["id"],"text":text,
                        "externalAttachmentIds":ids.cloned().unwrap_or_default()}));
                }
            }
            Some("agentMessage") => {
                if let Some(text) = item["text"]
                    .as_js_string()
                    .map(JsString::trim)
                    .filter(|text| !text.is_empty())
                {
                    let phase = if Some(index) == last_final {
                        item["phase"].clone()
                    } else {
                        json!("commentary")
                    };
                    output.push(json!({"type":"agentMessage","id":item["id"],"text":text,
                        "phase":phase,"correlation":correlation(&item["id"])}));
                }
            }
            _ => {
                let id = if item["id"].is_string() {
                    &item["id"]
                } else {
                    &Value::Null
                };
                let correlation = correlation(id);
                let lifecycle = if active { "started" } else { "completed" };
                let activity = match normalize(item, cwd, lifecycle, &correlation, &Value::Null)? {
                    Some(mut activity) => {
                        if !active && activity["status"] == "running" {
                            activity["status"] = json!(settled);
                            if let Some(seconds) = turn["completedAt"].as_f64() {
                                let ms = seconds * 1_000.0;
                                activity["completedAtMs"] = json!(ms);
                                activity["updatedAtMs"] =
                                    json!(activity["updatedAtMs"].as_f64().unwrap_or(0.0).max(ms));
                            }
                        }
                        activity
                    }
                    None => {
                        let kind = item["type"]
                            .as_js_string()
                            .map(|kind| slice(kind, 0, 200))
                            .unwrap_or_else(|| "unknown".into());
                        notice(
                            &correlation,
                            "warning",
                            &"An unsupported Codex history item could not be rendered.".into(),
                            &json!(concat(&["Item type: ".into(), kind])),
                            Value::Null,
                        )?
                    }
                };
                output.push(json!({"type":"activity","activity":activity}));
            }
        }
    }
    let error = &turn["error"];
    if let Some(message) = error["message"]
        .as_js_string()
        .filter(|message| !message.is_empty())
    {
        let reason = &error["codexErrorInfo"];
        let reason = if let Some(value) = reason.as_js_string() {
            let text = value.trim();
            if text.is_empty() {
                Value::Null
            } else {
                json!(text)
            }
        } else {
            json!(
                reason
                    .as_object()
                    .filter(|value| value.len() == 1)
                    .and_then(|fields| fields.keys().next())
            )
        };
        output.push(json!({"type":"activity","activity":notice(
            &correlation(&Value::Null), "error", message, &error["additionalDetails"], reason,
        )?}));
    }
    let summary = json!({
        "type":"turnSummary","id":format!("turn:{}:summary", turn["id"].as_js_string().context("Missing turn identity.")?),
        "status":if active {"running"} else {settled},"durationMs":turn["durationMs"],
        "startedAt":turn["startedAt"],"completedAt":turn["completedAt"],"correlation":correlation(&Value::Null),
    });
    output.push(json!({"type":"activity","activity":summary}));
    Ok(
        json!({"id":turn["id"],"status":turn["status"],"startedAt":turn["startedAt"],
        "completedAt":turn["completedAt"],"durationMs":turn["durationMs"],"items":output}),
    )
}

fn notice(
    correlation: &Value,
    level: &str,
    message: &JsString,
    details: &Value,
    reason: Value,
) -> Result<Value> {
    let turn = correlation["turnId"]
        .as_js_string()
        .context("Missing turn identity.")?;
    let digest = attachment_digest(format!("{turn}\0thread/read\0{message}").as_bytes());
    let message = bounded(Some(&json!(message)), 20_000)?
        .as_js_string()
        .unwrap()
        .trim();
    Ok(json!({
        "type":"notice","id":format!("{level}:{}", &digest[..20]),
        "status":if level == "error" {"failed"} else {"completed"},"level":level,
        "message":if message.is_empty() { level.into() } else { message },
        "details":bounded(Some(details), 20_000)?,"willRetry":if level == "error" {json!(false)} else {Value::Null},
        "reasonCode":reason,"retry":Value::Null,"correlation":correlation,
    }))
}
