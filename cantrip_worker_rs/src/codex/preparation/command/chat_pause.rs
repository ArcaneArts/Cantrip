//! In-process admission holds for ordinary Chats. Core persists Pause and
//! owns all queue and Goal decisions across worker restarts.
use super::{Ensurer, task_pause::Key};
use crate::codex::managed::Runtime;
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(in crate::codex) struct Latch {
    pub control: tokio::sync::Mutex<()>,
    paused: AtomicBool,
}

impl Latch {
    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
}

fn key(bound: &(JsString, Value), chat: &JsString) -> Result<Key> {
    let server = bound
        .1
        .as_js_string()
        .context("Missing Chat pause server.")?;
    Ok((bound.0.clone(), server.clone(), chat.clone()))
}

impl Ensurer {
    pub(in crate::codex) fn chat_pause_latch(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
    ) -> Result<Arc<Latch>> {
        self.assert_bound(bound)?;
        Ok(self
            .0
            .chat_pauses
            .lock()
            .unwrap()
            .entry(key(bound, chat)?)
            .or_default()
            .clone())
    }

    pub(super) fn chat_paused(&self, bound: &(JsString, Value), chat: &JsString) -> bool {
        key(bound, chat).ok().is_some_and(|key| {
            self.0
                .chat_pauses
                .lock()
                .unwrap()
                .get(&key)
                .is_some_and(|latch| latch.paused())
        })
    }

    pub(in crate::codex) fn apply_chat_pause(
        &self,
        bound: &(JsString, Value),
        chat: &JsString,
        latch: &Latch,
        paused: bool,
    ) -> Result<Option<Runtime>> {
        self.assert_bound(bound)?;
        // Publish the intent and update the live adapter under the same lock
        // that installs a replacement preparation.
        let owners = self.0.live_threads.lock().unwrap();
        let owner = owners.get(chat).filter(|owner| owner.bound == *bound);
        ensure!(
            owner.is_none_or(|owner| owner.task.is_none()),
            "The current native owner requires its canonical Task pause scope."
        );
        latch.paused.store(paused, Ordering::Relaxed);
        let runtime = owner.and_then(|owner| {
            let runtime = owner.runtime.upgrade()?;
            owner.thread.assert_current(&runtime).ok()?;
            Some(runtime)
        });
        if let Some(runtime) = &runtime {
            runtime.admission().set_chat_paused(chat, paused)?;
        }
        Ok(runtime)
    }
}
