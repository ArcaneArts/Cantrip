//! Turn mutations publish only their real persisted result. Task project fanout
//! follows the synchronous chat/summary group and owns its asynchronous lookup.
mod interactions;
mod messages;
mod routing;
use super::Repository;
use crate::{
    database::Database,
    operations::logging::{self, LogCall, Logger},
    wire::{Value, value::json},
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use anyhow::Result;
use futures::{FutureExt, future::BoxFuture};
pub use messages::{MessageOptions, RouteSelection, WorkerUnavailable};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
pub type Publish = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;
pub type Invalidate = Arc<dyn Fn(Value) + Send + Sync>;
pub type Request =
    Arc<dyn Fn(String, String, Value) -> BoxFuture<'static, Result<Option<Value>>> + Send + Sync>;
pub struct Dependencies {
    pub publish: Publish,
    pub invalidate: Invalidate,
    pub connected: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub request: Request,
    pub logger: Logger,
}
pub struct Service {
    repository: Repository,
    database: Arc<Database>,
    dependencies: Dependencies,
    state: Mutex<routing::State>,
    changed: Notify,
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        publish: Publish,
        invalidate: Invalidate,
        enabled: Arc<dyn Fn() -> bool + Send + Sync>,
        logger: Logger,
    ) -> Arc<Self> {
        let connected = commands.clone();
        Self::with_dependencies(
            database,
            Dependencies {
                publish,
                invalidate,
                enabled,
                logger,
                connected: Arc::new(move |worker| connected.is_connected(worker)),
                request: Arc::new(move |_owner, worker, command| {
                    let commands = commands.clone();
                    async move {
                        Ok(commands
                            .request_with_timeout(&worker, command, RequestTimeout::Default, None)
                            .await?)
                    }
                    .boxed()
                }),
            },
        )
    }
    pub fn with_dependencies(database: Arc<Database>, dependencies: Dependencies) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database.clone()),
            database,
            dependencies,
            state: Mutex::new(routing::State::default()),
            changed: Notify::new(),
        })
    }
    fn report(
        &self,
        level: &'static str,
        message: &'static str,
        error: anyhow::Error,
        context: Value,
    ) {
        let mut context = context;
        context["err"] = logging::error_details(&error);
        (self.dependencies.logger)(LogCall::event(level, message, context));
    }
    pub fn publish_summary(&self, owner: &str, chat: &Value, project: &Value) {
        (self.dependencies.invalidate)(
            json!({"ownerId":owner,"scope":super::turn_storage::project_scope(project),"resource":"chat","action":"invalidated","entityId":chat,"revision":Value::Null,"payload":Value::Null}),
        );
    }
    pub fn publish_invalidation(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        resource: &'static str,
        routing: Option<&Value>,
    ) {
        let pending = self.invalidate_chat(owner, chat, resource, &Value::Null, routing);
        self.fanout(pending.into_iter().collect());
    }
    fn invalidate_chat(
        &self,
        owner: &str,
        chat: &str,
        resource: &'static str,
        entity: &Value,
        routing: Option<&Value>,
    ) -> Option<routing::Pending> {
        if !(self.dependencies.enabled)() {
            return None;
        }
        if let Err(error) = (self.dependencies.publish)(
            json!({"ownerId":owner,"scope":json!({"kind":"chat","chatId":chat}),"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}),
        ) {
            self.report(
                "error",
                "Could not publish chat live invalidation",
                error,
                json!({"chatId":chat,"resource":resource}),
            );
        }
        matches!(
            resource,
            "agent-interaction" | "chat-goal" | "chat-message" | "chat-plan" | "task"
        )
        .then(|| routing::Pending {
            owner: owner.into(),
            chat: chat.into(),
            resource,
            entity: entity.clone(),
            routing: routing.cloned(),
        })
    }
    pub fn publish_boundary(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        project: &Value,
        routing: Option<&Value>,
    ) {
        self.publish_summary(owner, &json!(chat), project);
        let mut pending = Vec::new();
        for resource in ["chat", "chat-goal", "chat-plan"] {
            pending.extend(self.invalidate_chat(owner, chat, resource, &Value::Null, routing));
        }
        self.fanout(pending);
    }
    pub fn publish_progress(&self, owner: &str, chat: &str, progress: &Value) {
        // Inference observations remain ephemeral; they never mutate messages.
        if !(self.dependencies.enabled)() {
            return;
        }
        let result = (|| {
            let payload = if progress["kind"] == "clear" {
                Value::Null
            } else {
                crate::settings::parse_response("appLiveEventPayloadSchema", Some(progress))?
            };
            (self.dependencies.publish)(
                json!({"ownerId":owner,"scope":json!({"kind":"chat","chatId":chat}),"resource":"inference-progress","action":if progress["kind"]=="clear" {"deleted"}else{"updated"},"entityId":progress["requestId"],"revision":progress["sequence"],"payload":payload}),
            )
        })();
        if let Err(error) = result {
            self.report(
                "error",
                "Could not publish inference progress",
                error,
                json!({"chatId":chat,"requestId":progress["requestId"]}),
            );
        }
    }
    pub async fn update_plan_mode(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        mode: &str,
    ) -> Result<Option<Value>> {
        let result = self.repository.update_plan_mode(owner, chat, mode).await?;
        if result.is_some() {
            let pending = self.invalidate_chat(owner, chat, "chat-plan", &Value::Null, None);
            self.fanout(pending.into_iter().collect());
        }
        Ok(result)
    }
    pub async fn update_plan(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        plan: &Value,
    ) -> Result<()> {
        self.repository.update_encrypted_plan(chat, plan).await?;
        let pending = self.invalidate_chat(owner, chat, "chat-plan", &Value::Null, None);
        self.fanout(pending.into_iter().collect());
        Ok(())
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().unwrap().jobs == 0 {
                return;
            }
            changed.await;
        }
    }
    pub async fn delete_queued_prompt(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
    ) -> Result<Option<Value>> {
        let prompt =
            crate::native_commands::queued_prompt::PromptRepository::new(self.database.clone())
                .delete(owner, id)
                .await?;
        if let Some(prompt) = &prompt {
            self.invalidate_chat(
                owner,
                prompt["chatId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Queued prompt chat identity"))?,
                "chat-queue",
                &prompt["id"],
                None,
            );
        }
        Ok(prompt)
    }
    pub async fn publish_committed_invalidation(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        resource: &'static str,
        project: &Value,
        routing: &Value,
    ) {
        let pending = self.invalidate_chat(owner, chat, resource, &Value::Null, Some(routing));
        self.publish_summary(owner, &json!(chat), project);
        self.fanout_message(pending.into_iter().collect()).await;
    }
}
