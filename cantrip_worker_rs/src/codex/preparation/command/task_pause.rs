use super::{Ensurer, JsString, LoadedThread, Runtime};
use crate::{
    codex::task_pause::{Applied, Latch, Root},
    http::checked,
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{Value, value::json};
use std::{sync::Arc, time::Duration};

pub(in crate::codex) type Key = (JsString, JsString, JsString);

impl Ensurer {
    pub(super) fn task_latch(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
    ) -> Result<Arc<Latch>> {
        let server = bound
            .1
            .as_js_string()
            .context("Missing Task pause server.")?;
        Ok(self
            .0
            .task_pauses
            .lock()
            .unwrap()
            .entry((bound.0.clone(), server.clone(), chat.clone()))
            .or_default()
            .clone())
    }

    pub(in crate::codex) async fn task_pause(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        raw: &Value,
    ) -> Result<()> {
        let intent = checked("taskPauseIntentSchema", raw)?;
        self.assert_bound(bound)?;
        if intent["scope"]["workerId"].as_js_string() != Some(&self.0.worker) {
            bail!("The Task pause belongs to another worker.");
        }
        let latch = self.task_latch(bound, chat)?;
        latch.record(intent)?;
        self.sync_task_pause(bound, chat, &latch).await
    }

    pub(super) async fn sync_task_pause(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        latch: &Latch,
    ) -> Result<()> {
        let mut applied = latch.applied.lock().await;
        loop {
            self.assert_bound(bound)?;
            let Some(intent) = latch.current().intent else {
                return Ok(());
            };
            let target = self.task_pause_target(bound, chat, &intent["scope"]);
            let Some((runtime, thread, root)) = target else {
                *applied = None;
                // A task can pause before its private gate attaches.
                if latch.applied(&intent) {
                    return Ok(());
                }
                continue;
            };
            if applied.as_ref().is_some_and(|last| {
                last.intent == intent
                    && last.thread == thread
                    && last.runner == root.runner
                    && last.binding == root.binding
            }) {
                if latch.applied(&intent) {
                    return Ok(());
                }
                continue;
            }

            let current_root = || -> Result<()> {
                self.assert_bound(bound)?;
                let current = self.task_pause_target(bound, chat, &intent["scope"]);
                if !current.is_some_and(|(_, selected, current)| {
                    selected == thread
                        && current.runner == root.runner
                        && current.binding == root.binding
                }) {
                    bail!("The private Task root changed during pause delivery.");
                }
                Ok(())
            };
            let paused = intent["paused"] == true;
            let adapter = runtime.admission();
            if paused {
                adapter.set_chat_paused(chat, true)?;
            }
            let reply = runtime.request(
                "thread/managedExecution/taskPause".into(),
                Some(json!({
                    "threadId":thread.id(), "runnerGeneration":root.runner,
                    "revision":intent["scope"]["revision"], "paused":paused, "waitBoundary":false,
                })),
                Some(Duration::from_secs(120)),
                None,
            ).await;
            self.assert_bound(bound)?;
            if latch.current().intent.as_ref() != Some(&intent) {
                continue;
            }
            current_root()?;
            let reply = reply?.context("Codex did not acknowledge the Task pause.")?;
            if reply["revision"] != intent["scope"]["revision"]
                || reply["paused"] != intent["paused"]
            {
                bail!("Codex acknowledged a different Task pause intent.");
            }
            if paused {
                // A still-waiting native begin can be parked immediately
                // without waiting for the model or a checkpoint boundary.
                runtime
                    .inference_router()
                    .pause_pending_root(thread.id().clone())
                    .await?;
            } else if latch.current().intent.as_ref() == Some(&intent) {
                adapter.set_chat_paused(chat, false)?;
            }
            current_root()?;
            *applied = Some(Applied {
                intent: intent.clone(),
                thread,
                runner: root.runner,
                binding: root.binding,
            });
            if latch.applied(&intent) {
                return Ok(());
            }
        }
    }

    fn task_pause_target(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        scope: &Value,
    ) -> Option<(Runtime, LoadedThread, Root)> {
        let owners = self.0.live_threads.lock().unwrap();
        let owner = owners.get(chat)?;
        let root = owner.task.as_ref()?;
        if &owner.bound != bound || !root.matches(scope) {
            return None;
        }
        let runtime = owner.runtime.upgrade()?;
        owner.thread.assert_current(&runtime).ok()?;
        Some((runtime, owner.thread.clone(), root.clone()))
    }
}
