//! Notices accelerate durable reads; polling covers missed and remote notices.
use super::super::managed_queue::QueueRepository;
use crate::wire::{JsString, Value};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::watch;

type Channel = watch::Sender<()>;
type Listeners = Arc<Mutex<HashMap<JsString, Weak<Channel>>>>;
pub type AbortSignal = watch::Receiver<Option<Arc<str>>>;

#[derive(Debug)]
pub struct ReceiptAborted(pub Arc<str>);
impl std::fmt::Display for ReceiptAborted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ReceiptAborted {}

#[derive(Clone, Default)]
pub struct ReceiptNotifications {
    listeners: Listeners,
}
struct Subscription {
    listeners: Listeners,
    chat: JsString,
    channel: Arc<Channel>,
    changed: watch::Receiver<()>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        let mut listeners = self.listeners.lock().unwrap();
        if Arc::strong_count(&self.channel) == 1
            && listeners
                .get(&self.chat)
                .is_some_and(|entry| entry.as_ptr() == Arc::as_ptr(&self.channel))
        {
            listeners.remove(&self.chat);
        }
    }
}
fn check_abort(signal: &AbortSignal) -> Result<()> {
    match signal.borrow().as_ref() {
        Some(reason) => Err(ReceiptAborted(reason.clone()).into()),
        None => Ok(()),
    }
}
async fn aborted(signal: &mut AbortSignal) {
    loop {
        if signal.borrow().is_some() {
            return;
        }
        if signal.changed().await.is_err() {
            // Dropping an abort controller does not itself abort the operation.
            std::future::pending::<()>().await;
        }
    }
}
impl ReceiptNotifications {
    fn subscribe(&self, chat: &JsString) -> Subscription {
        let mut listeners = self.listeners.lock().unwrap();
        let channel = listeners
            .get(chat)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let channel = Arc::new(watch::channel(()).0);
                listeners.insert(chat.clone(), Arc::downgrade(&channel));
                channel
            });
        Subscription {
            changed: channel.subscribe(),
            channel,
            listeners: self.listeners.clone(),
            chat: chat.clone(),
        }
    }
    pub fn notify(&self, chat: &JsString) {
        let listeners = self.listeners.lock().unwrap();
        if let Some(channel) = listeners.get(chat).and_then(Weak::upgrade) {
            channel.send_modify(|_| {});
        }
    }
    pub async fn wait_for_receipt(
        &self,
        repository: &QueueRepository,
        owner: &str,
        worker: &Value,
        session: &Value,
        claim: &str,
        signal: AbortSignal,
    ) -> Result<Value> {
        let chat = session["chatId"]
            .as_js_string()
            .context("Queue receipt Chat identity")?;
        self.wait(chat, signal, || {
            repository.start_receipt(owner, worker, session, claim)
        })
        .await
    }
    pub(crate) async fn wait<F, Fut>(
        &self,
        chat: &JsString,
        mut signal: AbortSignal,
        mut read: F,
    ) -> Result<Value>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Option<Value>>>,
    {
        check_abort(&signal)?;
        let mut subscription = self.subscribe(chat);
        loop {
            check_abort(&signal)?;
            subscription.changed.borrow_and_update();
            if let Some(value) = read().await? {
                // Source returns a completed read even if abort arrived during it.
                return Ok(value);
            }
            check_abort(&signal)?;
            if subscription.changed.has_changed()? {
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(750)) => {}
                changed = subscription.changed.changed() => { changed?; }
                _ = aborted(&mut signal) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests;
