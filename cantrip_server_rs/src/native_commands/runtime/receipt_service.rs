//! Receipt effects happen after the durable settlement. Queue dispatch is a
//! required collaborator and owns its lifetime after the HTTP caller leaves.
use super::receipts::ReceiptNotifications;
use crate::{
    chats,
    database::Database,
    native_commands::Repository,
    operations::logging::{LogCall, Logger},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

pub type Publish = Arc<dyn Fn(Value) + Send + Sync>;
pub type Dispatch = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub struct ReceiptService {
    commands: Repository,
    chats: chats::Repository,
    notices: ReceiptNotifications,
    publish: Publish,
    dispatch: Dispatch,
    logger: Logger,
    active: AtomicUsize,
    changed: Notify,
}
struct DispatchTask(Arc<ReceiptService>);
impl Drop for DispatchTask {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_waiters();
    }
}
impl ReceiptService {
    pub fn new(
        database: Arc<Database>,
        notices: ReceiptNotifications,
        publish: Publish,
        dispatch: Dispatch,
        logger: Logger,
    ) -> Arc<Self> {
        Arc::new(Self {
            commands: Repository::new(database.clone()),
            chats: chats::Repository::new(database),
            notices,
            publish,
            dispatch,
            logger,
            active: AtomicUsize::new(0),
            changed: Notify::new(),
        })
    }
    pub async fn settle(self: &Arc<Self>, owner: &str, input: &Value) -> Result<Value> {
        let receipt = self.commands.settle(owner, input).await?;
        let chat = receipt["chatId"]
            .as_js_string()
            .context("Native receipt chat")?;
        if receipt["method"] == "thread/settings/update" {
            (self.publish)(
                json!({"type":"invalidation","ownerId":owner,"chatId":receipt["chatId"],"resource":"chat"}),
            );
        }
        self.notices.notify(chat);
        let complete = truthy(input.get("executionComplete"));
        let wakes = (complete && !truthy(input.get("deferred")))
            || (receipt["status"] == "applied"
                && matches!(
                    receipt["method"].as_str(),
                    Some("thread/goal/clear" | "thread/goal/set")
                ));
        if wakes && let Some(context) = self.chats.execution_context(owner, &chat.lossy()).await? {
            if complete {
                (self.publish)(
                    json!({"type":"boundary","ownerId":owner,"chatId":context["chatId"],"projectId":context["projectId"],"context":context}),
                );
            }
            if context["status"] == "idle" {
                self.active.fetch_add(1, Ordering::AcqRel);
                let task = DispatchTask(self.clone());
                let (service, owner, chat, operation) = (
                    self.clone(),
                    owner.to_owned(),
                    chat.lossy().into_owned(),
                    receipt["operationId"].clone(),
                );
                tokio::spawn(async move {
                    let _task = task;
                    if (service.dispatch)(owner, chat.clone()).await.is_err() {
                        (service.logger)(LogCall::event(
                            "warn",
                            "Canonical queue dispatch failed after committed native receipt; durable recovery will retry eligible work",
                            json!({"chatId":chat,"operationId":operation}),
                        ));
                    }
                });
            }
        }
        Ok(json!({"receipt":receipt}))
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            changed.await;
        }
    }
}
