use super::{Emit, Signal, id};
use crate::{
    history::live::observation::{Observer, Runtime as _, RuntimeHub, Subscription},
    http::checked,
    native_items::concat,
};
use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

pub(super) enum Event {
    Frame(Value),
    Checkpoint(Value, oneshot::Sender<Value>),
}
type Events = mpsc::UnboundedReceiver<Event>;
pub(super) type Capture = mpsc::UnboundedSender<Event>;
const STREAM_INTERVAL: Duration = Duration::from_millis(80);

pub(super) fn subscribe(
    observation: &RuntimeHub,
    thread: &JsString,
) -> Result<(Subscription, Events, Capture)> {
    let (observed, events) = mpsc::unbounded_channel();
    let capture = observed.clone();
    let subscription = observation.observe(
        thread.clone(),
        Observer {
            capture: Arc::new(move |frame| {
                if observes(&frame["method"]) {
                    let _ = observed.send(Event::Frame(frame));
                }
                Ok(None)
            }),
            on_error: Arc::new(|_, _| Ok(())),
        },
    )?;
    Ok((subscription, events, capture))
}

fn observes(method: &Value) -> bool {
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

async fn next(events: &mut Events, signal: &Signal) -> Result<Event> {
    tokio::select! {
        result = events.recv() => result.context("Native turn observation ended."),
        error = signal.cancelled() => Err(error.into()),
    }
}

pub(super) async fn started(events: &mut Events, signal: &Signal) -> Result<JsString> {
    loop {
        if let Event::Frame(frame) = next(events, signal).await?
            && frame["method"] == "turn/started"
        {
            return id(&frame["params"]["turn"]["id"], "native turn identity");
        }
    }
}

struct Pending {
    id: JsString,
    text: JsString,
    updated: Option<Instant>,
    last_published: JsString,
    changed: bool,
}

pub(super) struct Settled {
    pub status: &'static str,
    pub result: Result<Value>,
}

pub(super) async fn collect(
    events: &mut Events,
    signal: &Signal,
    thread: &JsString,
    turn: &JsString,
    emit: &Emit,
) -> Result<Settled> {
    collect_restored(events, signal, thread, turn, emit, &Value::Null).await
}

pub(super) async fn collect_restored(
    events: &mut Events,
    signal: &Signal,
    thread: &JsString,
    turn: &JsString,
    emit: &Emit,
    saved: &Value,
) -> Result<Settled> {
    let restored = &saved["streamingAgentMessage"];
    let mut message = restored["id"].as_js_string().map(|id| {
        let text = restored["text"]
            .as_js_string()
            .cloned()
            .unwrap_or_else(|| "".into());
        let last_published = restored["lastEmittedText"]
            .as_js_string()
            .cloned()
            .unwrap_or_else(|| "".into());
        Pending {
            id: id.clone(),
            changed: text.trim() != last_published,
            updated: (!last_published.is_empty()).then(Instant::now),
            last_published,
            text,
        }
    });
    let mut final_text = saved["finalText"].as_js_string().cloned();
    let pending = &saved["pendingAgentMessage"];
    let mut staged = pending["id"]
        .as_js_string()
        .zip(pending["text"].as_js_string())
        .map(|(id, text)| (id.clone(), text.clone(), pending["phase"].clone()));
    let mut delta = saved["delta"]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "".into());
    let mut usage = saved["latestUsage"].clone();
    let mut publisher = Publisher {
        thread,
        turn,
        emit,
        error: None,
    };
    loop {
        let frame = match next(events, signal).await? {
            Event::Frame(frame) => frame,
            Event::Checkpoint(mut snapshot, answer) => {
                snapshot["threadId"] = json!(thread);
                snapshot["turnId"] = json!(turn);
                snapshot["capturedAtMs"] = json!(
                    chrono::Utc::now()
                        .timestamp_millis()
                        .max(snapshot["startedAtMs"].as_i64().unwrap_or_default())
                );
                snapshot["delta"] = json!(delta);
                snapshot["finalText"] = json!(final_text);
                snapshot["latestUsage"] = usage.clone();
                snapshot["pendingAgentMessage"] =
                    staged.as_ref().map_or(Value::Null, |(id, text, phase)| {
                        publisher.agent_message(id, text, phase, false, "item/completed")
                    });
                snapshot["streamingAgentMessage"] = message.as_ref().map_or(Value::Null, |pending| json!({
                        "id":pending.id, "text":pending.text, "lastEmittedText":pending.last_published,
                        "phase":"commentary","correlation":publisher.correlation(&pending.id,"item/agentMessage/delta"),
                    }));
                let _ = answer.send(snapshot);
                continue;
            }
        };
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
                    last_published: "".into(),
                    changed: false,
                });
                pending.text = concat(&[pending.text, part.clone()]);
                pending.changed = true;
                if pending
                    .updated
                    .is_none_or(|updated| updated.elapsed() >= STREAM_INTERVAL)
                {
                    publisher.message(id, &pending.text.trim(), &json!("commentary"), true, method);
                    pending.last_published = pending.text.trim();
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
                let status = match params["turn"]["status"].as_str() {
                    Some("completed") => "completed",
                    Some("failed") => "failed",
                    Some("interrupted") => "interrupted",
                    _ => continue,
                };
                if let Some((id, text, phase)) = staged.take() {
                    let phase = if status == "completed" {
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
                let result = match status {
                    "completed" => match publisher.error {
                        Some(error) => Err(error),
                        None => checked(
                            "agentTurnResultSchema",
                            &json!({
                                "threadId": thread, "turnId": turn, "text": final_text.unwrap_or(delta),
                                "measuredUsage": usage, "status": "completed",
                            }),
                        ),
                    },
                    "interrupted" => Err(anyhow::anyhow!("The Codex turn was interrupted.")),
                    _ => Err(anyhow::anyhow!("The Codex turn failed.")),
                };
                return Ok(Settled { status, result });
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
            "message": self.agent_message(id, text, phase, streaming, method),
        }));
    }

    fn agent_message(
        &self,
        id: &JsString,
        text: &JsString,
        phase: &Value,
        streaming: bool,
        method: &str,
    ) -> Value {
        json!({
            "id":id,"text":text,"phase":phase,"streaming":streaming,
            "correlation":self.correlation(id, method),
        })
    }

    fn correlation(&self, id: &JsString, method: &str) -> Value {
        json!({
            "sourceMethod":method,"diagnosticId":Value::Null,
            "threadId":self.thread,"turnId":self.turn,"itemId":id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn restored_turn_can_finish_with_saved_text_and_no_new_output() -> Result<()> {
        let (send, mut events) = mpsc::unbounded_channel();
        send.send(Event::Frame(json!({
            "method":"turn/completed","params":json!({
                "threadId":"thread","turn":json!({"id":"turn","status":"completed"}),
            }),
        })))
        .map_err(|_| anyhow::anyhow!("Fixture event receiver closed"))?;
        let (_abort, signal) = crate::metadata::Abort::new();
        let emit: Emit = Arc::new(|_| panic!("Already-published text must not stream again"));
        let saved = json!({"delta":"text from before restart","finalText":Value::Null});
        let terminal = collect_restored(
            &mut events,
            &signal,
            &"thread".into(),
            &"turn".into(),
            &emit,
            &saved,
        )
        .await?;
        assert_eq!(terminal.result?["text"], "text from before restart");
        Ok(())
    }
}
