use super::{Emit, Signal, id};
use crate::{http::checked, native_items::concat};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedReceiver;

type Events = UnboundedReceiver<Value>;
const STREAM_INTERVAL: Duration = Duration::from_millis(80);

pub(super) fn observes(method: &Value) -> bool {
    matches!(
        method.as_str(),
        Some(
            "turn/started"
                | "turn/completed"
                | "turn/plan/updated"
                | "item/agentMessage/delta"
                | "item/completed"
                | "thread/tokenUsage/updated"
        )
    )
}

async fn next(events: &mut Events, signal: &Signal) -> Result<Value> {
    tokio::select! {
        result = events.recv() => result.context("Native turn observation ended."),
        error = signal.cancelled() => Err(error.into()),
    }
}

pub(super) async fn started(events: &mut Events, signal: &Signal) -> Result<JsString> {
    loop {
        let frame = next(events, signal).await?;
        if frame["method"] == "turn/started" {
            return id(&frame["params"]["turn"]["id"], "native turn identity");
        }
    }
}

struct Pending {
    id: JsString,
    text: JsString,
    updated: Option<Instant>,
    changed: bool,
}

pub(super) async fn collect(
    events: &mut Events,
    signal: &Signal,
    thread: &JsString,
    turn: &JsString,
    emit: &Emit,
) -> Result<Value> {
    let mut message = None::<Pending>;
    let mut final_text = None;
    let mut staged = None::<(JsString, JsString, Value)>;
    let mut delta = JsString::from("");
    let mut usage = Value::Null;
    let mut publisher = Publisher {
        thread,
        turn,
        emit,
        error: None,
    };
    loop {
        let frame = next(events, signal).await?;
        let params = &frame["params"];
        let method = frame["method"].as_str().unwrap_or_default();
        let native_turn = if matches!(method, "turn/started" | "turn/completed") {
            &params["turn"]["id"]
        } else {
            &params["turnId"]
        };
        if native_turn.as_js_string() != Some(turn) {
            continue;
        }
        match method {
            "item/agentMessage/delta" => {
                let (Some(id), Some(part)) = (
                    params["itemId"].as_js_string(),
                    params["delta"].as_js_string(),
                ) else {
                    continue;
                };
                delta = concat(&[delta, part.clone()]);
                if let Some(last) = message
                    .as_ref()
                    .filter(|last| &last.id != id && last.changed)
                {
                    publisher.message(
                        &last.id,
                        &last.text.trim(),
                        &json!("commentary"),
                        true,
                        method,
                    );
                }
                let current = message.take().filter(|last| &last.id == id);
                let mut pending = current.unwrap_or_else(|| Pending {
                    id: id.clone(),
                    text: "".into(),
                    updated: None,
                    changed: false,
                });
                pending.text = concat(&[pending.text, part.clone()]);
                pending.changed = true;
                if pending
                    .updated
                    .is_none_or(|updated| updated.elapsed() >= STREAM_INTERVAL)
                {
                    publisher.message(id, &pending.text.trim(), &json!("commentary"), true, method);
                    pending.updated = Some(Instant::now());
                    pending.changed = false;
                }
                message = Some(pending);
            }
            "item/completed" => {
                let item = &params["item"];
                if matches!(item["type"].as_str(), Some("plan" | "agentMessage"))
                    && item["phase"] != "commentary"
                {
                    final_text = item["text"].as_js_string().cloned();
                }
                if let Some((id, text, _)) = staged.take() {
                    publisher.message(&id, &text, &json!("commentary"), false, method);
                }
                if item["type"] != "agentMessage" {
                    continue;
                }
                if let (Some(id), Some(text)) =
                    (item["id"].as_js_string(), item["text"].as_js_string())
                {
                    message = message.filter(|last| &last.id != id);
                    let text = text.trim();
                    if item["phase"] == "commentary" {
                        publisher.message(id, &text, &item["phase"], false, method);
                    } else if !text.is_empty() {
                        staged = Some((id.clone(), text, item["phase"].clone()));
                    }
                }
            }
            "turn/plan/updated" => publisher.send(json!({
                "type": "agent.plan.updated", "turnId": turn,
                "explanation": params["explanation"], "steps": params["plan"],
            })),
            "thread/tokenUsage/updated" => {
                let mut total = params["tokenUsage"]["total"].clone();
                if total.is_object() && total.get("cacheWriteInputTokens").is_none() {
                    total["cacheWriteInputTokens"] = json!(0);
                }
                if let Ok(total) = cantrip_protocol::parse_property(
                    "agentTurnResultSchema",
                    "measuredUsage",
                    &total,
                ) {
                    usage = total;
                }
            }
            "turn/completed" => {
                let status = params["turn"]["status"].as_str();
                if !matches!(status, Some("completed" | "failed" | "interrupted")) {
                    continue;
                }
                if let Some((id, text, phase)) = staged.take() {
                    let phase = if status == Some("completed") {
                        phase
                    } else {
                        json!("commentary")
                    };
                    publisher.message(&id, &text, &phase, false, "item/completed");
                }
                if let Some(last) = message.take().filter(|last| last.changed) {
                    publisher.message(
                        &last.id,
                        &last.text.trim(),
                        &json!("commentary"),
                        true,
                        "item/agentMessage/delta",
                    );
                }
                match status {
                    Some("completed") => {
                        if let Some(error) = publisher.error {
                            return Err(error);
                        }
                        return checked(
                            "agentTurnResultSchema",
                            &json!({
                                "threadId": thread, "turnId": turn, "text": final_text.unwrap_or(delta),
                                "measuredUsage": usage, "status": "completed",
                            }),
                        );
                    }
                    Some("interrupted") => bail!("The Codex turn was interrupted."),
                    Some("failed") => bail!("The Codex turn failed."),
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

struct Publisher<'a> {
    thread: &'a JsString,
    turn: &'a JsString,
    emit: &'a Emit,
    error: Option<anyhow::Error>,
}
impl Publisher<'_> {
    fn send(&mut self, event: Value) {
        if let Err(error) = (self.emit)(event) {
            self.error.get_or_insert(error);
        }
    }
    fn message(
        &mut self,
        id: &JsString,
        text: &JsString,
        phase: &Value,
        streaming: bool,
        method: &str,
    ) {
        if text.trim().is_empty() {
            return;
        }
        self.send(json!({
            "type": "agent.message",
            "message": json!({
                "id": id, "text": text, "phase": phase,
                "streaming": streaming,
                "correlation": json!({
                    "sourceMethod": method, "diagnosticId": Value::Null,
                    "threadId": self.thread, "turnId": self.turn, "itemId": id,
                }),
            }),
        }));
    }
}
