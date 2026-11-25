use crate::encryption::Service;
use anyhow::{Context, Result};
use cantrip_history::canonical::open_message;
use cantrip_wire::{Value, value::json};
use indexmap::IndexMap;

const TEXT_BUDGET_BYTES: usize = 12 * 1024;
const MAX_SUBAGENTS: usize = 16;

pub(super) fn project(service: &Service, result: &mut Value) -> Result<()> {
    let mut remaining = TEXT_BUDGET_BYTES;
    let mut subagents = IndexMap::new();
    let mut messages = Vec::new();
    let raw = result["messages"]
        .as_array()
        .context("Cantrip transcript")?;
    for message in raw {
        let revision = message["protectedContent"]["keyRevision"]
            .as_u64()
            .context("Chat content key revision")?;
        let material = service.bound_component("chat-content", Some(revision))?;
        let items = open_message(&material.component.key, &json!(material.owner_id), message)?;
        let mut text = String::new();
        let mut turn = Value::Null;
        for item in items.as_array().context("Chat transcript item list")? {
            if item["type"] == "text" {
                if let Some(content) = item["text"].as_str() {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(content);
                }
            } else if item["type"] == "activity" {
                let activity = &item["activity"];
                observe_subagents(&mut subagents, activity, &result["agent"]["chatId"]);
                if let Some(id) = activity.get("turnId") {
                    turn = id.clone();
                }
            }
        }
        if !text.is_empty() {
            messages.push((message, text, turn));
        }
    }
    let mut rows = Vec::new();
    for (message, mut text, turn) in messages.into_iter().rev() {
        if remaining == 0 {
            break;
        }
        let bound = text.floor_char_boundary(remaining.min(text.len()));
        let truncated = bound != text.len();
        text.truncate(bound);
        // JSON control-character escapes can expand the wire bytes.
        let encoded = json!(text);
        let wire_bytes = encoded.stringify().len().saturating_sub(2);
        if wire_bytes > remaining {
            break;
        }
        remaining -= wire_bytes;
        rows.push(json!({
            "id":message["id"],"sequence":message["sequence"],"role":message["role"],
            "createdAt":message["createdAt"],"turnId":turn,"text":encoded,"truncated":truncated,
        }));
    }
    rows.reverse();
    if let Some(first) = rows.first()
        && raw
            .first()
            .is_some_and(|raw| raw["sequence"] != first["sequence"])
    {
        result["page"]["hasMore"] = json!(true);
        result["page"]["nextBeforeSequence"] = first["sequence"].clone();
    }
    result["messages"] = json!(rows);
    result["subagents"] = json!(subagents.into_values().collect::<Vec<_>>());
    Ok(())
}

fn observe_subagents(subagents: &mut IndexMap<String, Value>, activity: &Value, chat: &Value) {
    if activity["type"] == "collabToolCall" {
        if let Some(receivers) = activity["receiverThreadIds"].as_array() {
            for receiver in receivers.iter().filter_map(Value::as_str) {
                let state = activity["agentStates"]
                    .as_array()
                    .and_then(|states| states.iter().find(|state| state["threadId"] == receiver));
                record(
                    subagents,
                    receiver,
                    chat,
                    &activity["senderThreadId"],
                    state.map_or(&Value::Null, |state| &state["status"]),
                );
            }
        }
    } else if activity["type"] == "subAgent"
        && let Some(thread) = activity["agentThreadId"].as_str()
    {
        record(subagents, thread, chat, &Value::Null, &activity["kind"]);
    }
}

fn record(
    subagents: &mut IndexMap<String, Value>,
    thread: &str,
    chat: &Value,
    parent: &Value,
    status: &Value,
) {
    if let Some(agent) = subagents.get_mut(thread) {
        if !parent.is_null() {
            agent["parentThreadId"] = parent.clone();
        }
        if !status.is_null() {
            agent["status"] = status.clone();
        }
    } else if subagents.len() < MAX_SUBAGENTS {
        subagents.insert(
            thread.to_owned(),
            json!({
                "kind":"native-subagent","id":thread,"threadId":thread,
                "parentChatId":chat,"parentThreadId":parent,"status":status,
            }),
        );
    }
}
