//! Model context belongs to one native turn and one authenticated MCP activation.
use super::{Active, Key, Phase, Turns, compact, id};
use crate::{chat_content::Scope, metadata::Signal};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::sync::{Arc, Mutex};

pub(crate) struct ContextTurn {
    thread: JsString,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    turn: Option<JsString>,
    usage: Option<Usage>,
    scheduled: bool,
    closed: bool,
    next: Option<Followup>,
}

struct Usage {
    used: Option<u64>,
    window: Option<u64>,
    updated_at: i64,
}

impl ContextTurn {
    pub(super) fn new(thread: JsString) -> Self {
        Self {
            thread,
            state: Mutex::default(),
        }
    }

    pub(super) fn bind(&self, turn: &JsString) {
        self.state.lock().unwrap().turn = Some(turn.clone());
    }

    pub(super) fn observe(&self, frame: &Value) {
        if !matches!(
            frame["method"].as_str(),
            Some("thread/tokenUsage/updated" | "turn/completed")
        ) {
            return;
        }
        let mut state = self.state.lock().unwrap();
        let params = &frame["params"];
        if state.closed
            || state.turn.is_none()
            || params["threadId"].as_js_string() != Some(&self.thread)
        {
            return;
        }
        if frame["method"] == "thread/tokenUsage/updated"
            && params["turnId"].as_js_string() == state.turn.as_ref()
        {
            let usage = &params["tokenUsage"];
            state.usage = Some(Usage {
                used: usage["last"]["totalTokens"].as_u64(),
                window: usage["modelContextWindow"]
                    .as_u64()
                    .filter(|window| *window > 0),
                updated_at: chrono::Utc::now().timestamp_millis(),
            });
        }
        if frame["method"] == "turn/completed"
            && params["turn"]["id"].as_js_string() == state.turn.as_ref()
        {
            state.closed = true;
        }
    }

    pub(crate) fn inspect(&self) -> Option<Value> {
        self.state.lock().unwrap().snapshot(&self.thread)
    }

    pub(crate) fn schedule(&self, current: impl FnOnce() -> bool) -> Option<Value> {
        let mut state = self.state.lock().unwrap();
        if state.closed || state.turn.is_none() || !current() {
            return None;
        }
        state.scheduled = true;
        state.snapshot(&self.thread)
    }

    pub(super) fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.scheduled = false;
        state.next = None;
    }

    pub(super) fn finish(&self, next: impl FnOnce() -> Followup) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        if state.scheduled {
            state.next = Some(next());
        }
    }

    fn scheduled(&self) -> bool {
        self.state.lock().unwrap().scheduled
    }
}

impl State {
    fn snapshot(&self, thread: &JsString) -> Option<Value> {
        let turn = self.turn.as_ref().filter(|_| !self.closed)?;
        let used = self.usage.as_ref().and_then(|usage| usage.used);
        let window = self.usage.as_ref().and_then(|usage| usage.window);
        let remaining = used
            .zip(window)
            .map(|(used, window)| window.saturating_sub(used));
        let percent = used
            .zip(window)
            .map(|(used, window)| ((used as f64 / window as f64).min(1.0) * 1000.0).round() / 10.0);
        Some(json!({
            "threadId":thread, "turnId":turn, "usedTokens":used,
            "contextWindowTokens":window, "remainingTokens":remaining, "usedPercent":percent,
            "remainingPercent":percent.map(|percent| ((100.0 - percent) * 10.0).round() / 10.0),
            "usageUpdatedAtMs":self.usage.as_ref().map(|usage| usage.updated_at),
            "compactionScheduled": self.scheduled,
        }))
    }
}

pub(super) struct Followup {
    pub key: Key,
    pub runtime_generation: String,
    pub thread_version: u64,
    pub signal: Signal,
    pub command: Value,
}

pub(crate) struct Completion(Arc<Active>);

impl Completion {
    pub(super) fn pending(active: Arc<Active>) -> Option<Self> {
        active.context.get().filter(|context| context.scheduled())?;
        Some(Self(active))
    }

    pub(crate) async fn compact(self, turns: &Turns) -> Result<()> {
        let active = self.0;
        let mut phases = active.changed.subscribe();
        loop {
            phases.borrow_and_update();
            if matches!(*active.phase.lock().unwrap(), Phase::Finished) {
                break;
            }
            phases.changed().await?;
        }
        let next = active
            .context
            .get()
            .and_then(|context| context.state.lock().unwrap().next.take());
        let Some(next) = next else {
            return Ok(());
        };
        next.signal.check()?;
        let thread = id(&next.command["threadId"], "scheduled compaction thread")?;
        let bound = (next.key.0.clone(), json!(next.key.1));
        ensure!(
            turns.key(&next.command)? == next.key
                && turns
                    .preparation
                    .selected_live_owner(&next.key.2, &bound)
                    .is_some_and(|(loaded, live)| loaded.id() == &thread
                        && loaded.version() == next.thread_version
                        && live.runtime.generation() == next.runtime_generation),
            "The scheduled compaction belongs to a replaced chat attachment."
        );
        turns
            .run_acknowledged_start(
                &next.command,
                Scope::new(turns.encryption.clone())?,
                compact::METHOD,
                json!({"threadId":thread}),
                |_| (),
            )
            .await?;
        Ok(())
    }
}
