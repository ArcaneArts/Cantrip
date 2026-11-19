use super::{Ensurer, JsString, LoadedThread, Runtime};
use crate::{
    codex::task_pause::{Applied, Latch, Root},
    http::checked,
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{Value, value::json};
use std::{sync::Arc, time::Duration};

pub(in crate::codex) struct PauseTarget {
    pub runtime: Runtime,
    pub thread: LoadedThread,
    root: Root,
}

impl PauseTarget {
    pub(in crate::codex) fn runner(&self) -> &JsString {
        &self.root.runner
    }

    pub(in crate::codex) async fn apply(&self, intent: &Value, wait: bool) -> Result<()> {
        let timeout = if wait || intent["paused"] == false {
            Duration::from_secs(24 * 60 * 60)
        } else {
            Duration::from_secs(120)
        };
        let reply = self
            .runtime
            .request(
                "thread/managedExecution/taskPause".into(),
                Some(json!({
                    "threadId":self.thread.id(), "runnerGeneration":self.root.runner,
                    "revision":intent["scope"]["revision"], "paused":intent["paused"], "waitBoundary":wait,
                })),
                Some(timeout),
                None,
            )
            .await?
            .context("Codex did not acknowledge the Task pause.")?;
        if reply["revision"] != intent["scope"]["revision"] || reply["paused"] != intent["paused"] {
            bail!("Codex acknowledged a different Task pause intent.");
        }
        Ok(())
    }

    pub(in crate::codex) fn same(&self, other: &Self) -> bool {
        self.thread == other.thread
            && self.root.runner == other.root.runner
            && self.root.binding == other.root.binding
    }
}

pub(in crate::codex) type Key = (JsString, JsString, JsString);

impl Ensurer {
    pub(in crate::codex) fn task_restore_allowed(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
    ) -> Result<()> {
        self.assert_bound(bound)?;
        if self.task_latch(bound, chat)?.current().blocked {
            bail!("The Task was paused during restoration.");
        }
        Ok(())
    }

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
    ) -> Result<Value> {
        let latch = self.record_task_pause(bound, chat, raw)?;
        self.sync_task_pause(bound, chat, &latch).await?;
        latch
            .current()
            .intent
            .context("The Task pause was not retained.")
    }

    pub(in crate::codex) fn record_task_pause(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        raw: &Value,
    ) -> Result<Arc<Latch>> {
        let intent = checked("taskPauseIntentSchema", raw)?;
        self.assert_bound(bound)?;
        if intent["scope"]["workerId"].as_js_string() != Some(&self.0.worker) {
            bail!("The Task pause belongs to another worker.");
        }
        let latch = self.task_latch(bound, chat)?;
        latch.record(intent)?;
        Ok(latch)
    }

    pub(in crate::codex) fn assert_task_intent(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        intent: &Value,
    ) -> Result<()> {
        self.assert_bound(bound)?;
        if self.task_latch(bound, chat)?.current().intent.as_ref() != Some(intent) {
            bail!("The current Task control was superseded.");
        }
        Ok(())
    }

    pub(in crate::codex) fn assert_task_pause_target(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        intent: &Value,
        target: &PauseTarget,
    ) -> Result<()> {
        self.assert_task_intent(bound, chat, intent)?;
        if !self
            .task_pause_target(bound, chat, &intent["scope"])
            .is_some_and(|current| current.same(target))
        {
            bail!("The private Task root or pause intent changed during delivery.");
        }
        Ok(())
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
            let Some(target) = target else {
                *applied = None;
                // A task can pause before its private gate attaches.
                if latch.applied(&intent) {
                    return Ok(());
                }
                continue;
            };
            let PauseTarget {
                runtime,
                thread,
                root,
            } = &target;
            if applied.as_ref().is_some_and(|last| {
                last.intent == intent
                    && last.thread == *thread
                    && last.runner == root.runner
                    && last.binding == root.binding
            }) {
                if latch.applied(&intent) {
                    return Ok(());
                }
                continue;
            }

            let current_root = || self.assert_task_pause_target(bound, chat, &intent, &target);
            let paused = intent["paused"] == true;
            let adapter = runtime.admission();
            if paused {
                adapter.set_chat_paused(chat, true)?;
            }
            let reply = target.apply(&intent, false).await;
            self.assert_bound(bound)?;
            if latch.current().intent.as_ref() != Some(&intent) {
                continue;
            }
            current_root()?;
            reply?;
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
                thread: thread.clone(),
                runner: root.runner.clone(),
                binding: root.binding.clone(),
            });
            if latch.applied(&intent) {
                return Ok(());
            }
        }
    }

    pub(in crate::codex) fn task_pause_target(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        scope: &Value,
    ) -> Option<PauseTarget> {
        self.private_task_target(bound, chat, |root| root.matches(scope))
    }

    pub(in crate::codex) fn task_interrupt_target(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        scope: &Value,
    ) -> Option<PauseTarget> {
        self.private_task_target(bound, chat, |root| root.matches_placement(scope))
    }

    fn private_task_target(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        matches: impl FnOnce(&Root) -> bool,
    ) -> Option<PauseTarget> {
        let owners = self.0.live_threads.lock().unwrap();
        let owner = owners.get(chat)?;
        let root = owner.task.as_ref()?;
        if &owner.bound != bound || !matches(root) {
            return None;
        }
        let runtime = owner.runtime.upgrade()?;
        owner.thread.assert_current(&runtime).ok()?;
        Some(PauseTarget {
            runtime,
            thread: owner.thread.clone(),
            root: root.clone(),
        })
    }
}
