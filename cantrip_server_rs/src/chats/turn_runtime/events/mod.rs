//! Serialized worker observations use the same durable writers as native events.
mod interactions;
mod messages;
mod telemetry;
use super::{bootstrap::PreparedTurn, stages::Clock};
use crate::{
    chats::{
        live_mutations::Service as Live,
        runtime_quota::{self, Runtime},
        runtime_telemetry::RuntimeTelemetry,
        turn_behavior::ModelBehaviorTracker,
    },
    database::Database,
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result, bail};
use indexmap::IndexSet;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Finals {
    pub turns: IndexSet<JsString>,
    pub texts: IndexSet<JsString>,
}
impl Finals {
    pub fn record(&mut self, turn: Option<&Value>, text: &Value) -> Result<()> {
        self.texts
            .insert(text.as_js_string().context("Streamed final text")?.trim());
        if let Some(turn) = turn.filter(|v| truthy(Some(v))) {
            self.turns
                .insert(turn.as_js_string().context("Streamed final turn")?.clone());
        }
        Ok(())
    }
    pub fn has(&self, turn: Option<&Value>, text: &Value) -> Result<bool> {
        if turn
            .filter(|v| truthy(Some(v)))
            .and_then(Value::as_js_string)
            .is_some_and(|v| self.turns.contains(v))
        {
            return Ok(true);
        }
        let text = text.as_js_string().context("Streamed final text")?.trim();
        Ok(if text.is_empty() {
            !self.texts.is_empty()
        } else {
            self.texts.contains(&text)
        })
    }
}
#[derive(Default)]
pub struct TurnState {
    pub any_activity: bool,
    pub observation_sequence: u64,
    pub changed_paths: IndexSet<JsString>,
}
#[derive(Default)]
pub struct AttemptState {
    pub quota_followups_scheduled: bool,
    pub tracker: ModelBehaviorTracker,
    pub finals: Finals,
    pub behavior_turn: Value,
    pub activity: bool,
    pub terminal_reason: Option<Value>,
}
#[derive(Clone)]
pub struct Dependencies {
    pub database: Arc<Database>,
    pub live: Arc<Live>,
    pub commands: Arc<LimitedCommandBus>,
    pub telemetry: Arc<RuntimeTelemetry>,
    pub quota: Arc<runtime_quota::Service>,
    pub clock: Clock,
}
pub struct EventSink {
    pub dependencies: Dependencies,
    pub turn: Arc<PreparedTurn>,
    pub runtime: Runtime,
    pub subagent: Option<Value>,
    pub attempt_id: Value,
    pub source: JsString,
    pub turn_state: Arc<Mutex<TurnState>>,
    pub state: tokio::sync::Mutex<AttemptState>,
}
pub(super) fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Worker stream identity")?
        .lossy()
        .into_owned())
}
pub(super) fn nullish<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    value.filter(|v| !v.is_null()).unwrap_or(fallback)
}
pub fn identifier(parts: &[&Value]) -> Value {
    Value::String(JsString::new(
        parts
            .iter()
            .flat_map(|p| {
                crate::wire::coercion::string(p)
                    .expect("Stream identity primitive")
                    .units()
                    .to_vec()
            })
            .collect(),
    ))
}
pub fn provisional(event: &Value) -> bool {
    match event["type"].as_str() {
        Some("agent.message") => {
            event["message"]["streaming"] == true || event["message"]["phase"] == "commentary"
        }
        Some("agent.protected-message" | "agent.protected-task-message") => {
            let t = &event["telemetry"];
            t["kind"] == "activity"
                || t["kind"] == "usage"
                || (t["kind"] == "message"
                    && (t["streaming"] == true || t["phase"] == "commentary"))
        }
        Some("agent.activity" | "agent.inference-progress") => true,
        _ => false,
    }
}
pub fn observation_identity(event: &Value, operation: &Value, sequence: &mut u64) -> Value {
    let (turn, message) = match event["type"].as_str() {
        Some("agent.activity") => (
            event["activity"]["correlation"]["turnId"].clone(),
            event["activity"]["id"].clone(),
        ),
        Some("agent.message") => (
            event["message"]["correlation"]["turnId"].clone(),
            event["message"]["id"].clone(),
        ),
        Some("agent.protected-message" | "agent.protected-task-message") => (
            event["telemetry"]["turnId"].clone(),
            event["message"]["id"].clone(),
        ),
        Some("agent.inference-progress") => (Value::Null, event["progress"]["requestId"].clone()),
        _ => (Value::Null, Value::Null),
    };
    let at = if event["type"] == "agent.inference-progress" {
        event["progress"]["sequence"].clone()
    } else {
        json!(*sequence)
    };
    if event["type"] != "agent.inference-progress" && provisional(event) {
        *sequence += 1;
    }
    json!({"operationId":operation,"turnId":turn,"messageId":message,"sequence":at})
}
impl EventSink {
    pub fn new(
        dependencies: Dependencies,
        turn: Arc<PreparedTurn>,
        runtime: Runtime,
        index: usize,
        turn_state: Arc<Mutex<TurnState>>,
    ) -> Arc<Self> {
        let route = runtime.lock().unwrap()["routeId"].clone();
        let attempt_id = identifier(&[
            &turn.user_message["id"],
            &json!(":"),
            &route,
            &json!(":"),
            &json!(index),
        ]);
        let source = identifier(&[&json!("chat-attempt:"), &attempt_id])
            .as_js_string()
            .unwrap()
            .clone();
        let subagent = turn.route_pairs[index]["subagent"]
            .get("runtime")
            .filter(|v| !v.is_null())
            .cloned();
        Arc::new(Self {
            dependencies,
            turn,
            runtime,
            subagent,
            attempt_id,
            source,
            turn_state,
            state: tokio::sync::Mutex::new(AttemptState::default()),
        })
    }
    pub async fn on_event(self: &Arc<Self>, event: &Value) -> Result<()> {
        let mut state = self.state.lock().await;
        if self.computer_use(event).await? {
            return Ok(());
        }
        let at = (self.dependencies.clock)();
        state.tracker.observe_native_event(event)?;
        let identity = {
            let mut turn = self.turn_state.lock().unwrap();
            observation_identity(
                event,
                &self.turn.user_message["id"],
                &mut turn.observation_sequence,
            )
        };
        let activity = if event["type"] == "agent.activity" {
            Some(&event["activity"])
        } else if matches!(
            event["type"].as_str(),
            Some("agent.protected-message" | "agent.protected-task-message")
        ) && event["telemetry"]["kind"] == "activity"
        {
            Some(&event["telemetry"])
        } else {
            None
        };
        if let Some(activity) = activity.filter(|v| truthy(v.get("reasonCode")))
            && (event["type"] != "agent.activity" || activity["type"] == "notice")
        {
            state.terminal_reason = Some(activity["reasonCode"].clone());
        }
        state.tracker.mark_activity(at);
        state.activity = true;
        self.turn_state.lock().unwrap().any_activity = true;
        if self.turn.execution["contextKind"] == "standalone" {
            let child = activity.and_then(|v| {
                if event["type"] == "agent.activity" {
                    v.get("agentScope")
                } else {
                    v.get("agentRuntime")
                }
            });
            if child.is_some_and(|v| truthy(Some(v)) && v["isRoot"] != true) {
                bail!("Standalone Chat runtime emitted child-agent lifecycle activity.");
            }
        }
        if event["type"] == "agent.inference-progress" {
            if event["progress"]["requestId"] == self.turn.user_message["id"] {
                self.dependencies.live.publish_progress(
                    &self.turn.owner,
                    &text(&self.turn.execution["chatId"])?,
                    &event["progress"],
                );
            }
            return Ok(());
        }
        if self.interaction(event, &mut state, at).await? {
            return Ok(());
        }
        self.message(event, &identity, &mut state, at).await
    }
}
