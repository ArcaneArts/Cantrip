//! Reconcile a selected Project Chat after out-of-band native changes.
use super::{Key, Phase, SessionsState, Turns};
use crate::{
    codex::{
        managed::WeakRuntime,
        preparation::{command::Prepared, native::LoadedThread},
    },
    connection::Outbound,
    encryption::Service,
    history::live::observation::{Observer, Runtime as _, Subscription},
    http::checked,
};
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

const DEBOUNCE: Duration = Duration::from_millis(75);

pub(super) struct Publisher {
    outgoing: Arc<Outbound>,
    revision: Mutex<i64>,
}

impl Publisher {
    pub(super) fn new(outgoing: Arc<Outbound>) -> Self {
        Self {
            outgoing,
            revision: Mutex::new(0),
        }
    }

    fn changed(&self, thread: &JsString, changes: Vec<&'static str>) -> Result<()> {
        let mut revision = self.revision.lock().unwrap();
        *revision = (*revision + 1).max(chrono::Utc::now().timestamp_millis() * 1_000);
        self.outgoing.notification(json!({
            "type":"chat.thread.changed", "threadId":thread,
            "revision":*revision, "changes":changes,
        }))?;
        Ok(())
    }
}

pub(in crate::codex) struct Observation {
    subscription: Subscription,
    watch: Arc<Watch>,
}

impl Drop for Observation {
    fn drop(&mut self) {
        self.watch.state.lock().unwrap().closed = true;
        self.subscription.close();
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    pending: Option<Vec<&'static str>>,
}

struct Watch {
    runtime: WeakRuntime,
    thread: LoadedThread,
    key: Key,
    encryption: Arc<Service>,
    active: Weak<Mutex<SessionsState>>,
    publisher: Arc<Publisher>,
    state: Mutex<State>,
}

impl Turns {
    pub(super) fn watch_external_changes(
        &self,
        chat: &JsString,
        prepared: &Prepared,
    ) -> Result<()> {
        self.preparation.watch_external_changes(chat, prepared, || {
            let watch = Arc::new(Watch {
                runtime: prepared.runtime.downgrade(),
                thread: prepared.thread.clone(),
                key: (
                    prepared.bound.0.clone(),
                    super::id(&prepared.bound.1, "logical server")?,
                    chat.clone(),
                ),
                encryption: self.encryption.clone(),
                active: Arc::downgrade(&self.active),
                publisher: self.thread_changes.clone(),
                state: Mutex::default(),
            });
            let weak = Arc::downgrade(&watch);
            let subscription = prepared.runtime.history().observe(
                prepared.thread.id().clone(),
                Observer {
                    capture: Arc::new(move |frame| {
                        let Some(change) = classify(&frame) else {
                            return Ok(None);
                        };
                        let Some(watch) = weak.upgrade() else {
                            return Ok(None);
                        };
                        if !watch.observe(change) {
                            return Ok(None);
                        }
                        let weak = weak.clone();
                        Ok(Some(Box::pin(async move {
                            tokio::time::sleep(DEBOUNCE).await;
                            if let Some(watch) = weak.upgrade() {
                                watch.flush()?;
                            }
                            Ok(())
                        })))
                    }),
                    on_error: Arc::new(|_, _| Ok(())),
                },
            )?;
            Ok(Observation {
                subscription,
                watch,
            })
        })
    }
}

impl Watch {
    fn observe(&self, change: &'static str) -> bool {
        if self.active.upgrade().is_none_or(|active| {
            active
                .lock()
                .unwrap()
                .active
                .get(&self.key)
                .is_some_and(|owned| !matches!(*owned.phase.lock().unwrap(), Phase::Finished))
        }) {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return false;
        }
        if let Some(pending) = &mut state.pending {
            if !pending.contains(&change) {
                pending.push(change);
            }
            return false;
        }
        state.pending = Some(vec![change]);
        true
    }

    fn flush(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if let Some(changes) = state.pending.take()
            && !state.closed
            && self
                .runtime
                .upgrade()
                .is_some_and(|runtime| self.thread.assert_current(&runtime).is_ok())
            && self
                .encryption
                .bound_identity()
                .is_ok_and(|(owner, server)| {
                    owner == self.key.0 && server.as_js_string() == Some(&self.key.1)
                })
        {
            self.publisher.changed(self.thread.id(), changes)?;
        }
        Ok(())
    }
}

fn classify(frame: &Value) -> Option<&'static str> {
    let params = &frame["params"];
    match frame["method"].as_str()? {
        "turn/started" | "turn/completed" if params["turn"]["id"].is_string() => Some("turn"),
        "turn/plan/updated" if params["turnId"].is_string() => Some("turn"),
        "thread/goal/updated" if params["goal"].is_object() => Some("goal"),
        "thread/goal/cleared" => Some("goal"),
        "thread/queue/changed" => Some("queue"),
        "thread/settings/updated"
            if checked("nativeThreadSettingsSchema", &params["threadSettings"]).is_ok() =>
        {
            Some("plan")
        }
        _ => None,
    }
}
