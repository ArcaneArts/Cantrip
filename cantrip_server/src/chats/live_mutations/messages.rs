use super::*;
use crate::{chats::message_queries::MessageKind, wire::coercion::truthy};
use anyhow::{Context, bail};
#[derive(Debug)]
pub struct WorkerUnavailable;
impl std::fmt::Display for WorkerUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Project worker is offline.")
    }
}
impl std::error::Error for WorkerUnavailable {}
pub struct MessageOptions<'a> {
    pub attribution: Option<&'a Value>,
    pub kind: MessageKind,
    pub upsert: bool,
    pub routing: Option<&'a Value>,
}
pub struct RouteSelection<'a> {
    pub model: &'a str,
    pub runtime: &'a Value,
    pub reasoning: Option<&'a Value>,
    pub kind: MessageKind,
    pub routing: Option<&'a Value>,
}
impl Service {
    pub async fn publish_persisted_message(
        self: &Arc<Self>,
        owner: &str,
        message: &Value,
        kind: MessageKind,
        routing: Option<&Value>,
    ) {
        if !(self.dependencies.enabled)() {
            return;
        }
        let result = (|| {
            let value = match kind {
                MessageKind::Plain => {
                    crate::settings::parse_response("chatMessageSchema", Some(message))?
                }
                MessageKind::Task => crate::settings::parse_response(
                    "taskMessageOpaqueSummarySchema",
                    Some(message),
                )?,
                _ => message.clone(),
            };
            let payload =
                crate::settings::parse_response("appLiveEventPayloadSchema", Some(&value))?;
            (self.dependencies.publish)(
                json!({"ownerId":owner,"scope":json!({"kind":"chat","chatId":message["chatId"]}),"resource":"chat-message","action":"updated","entityId":message["id"],"revision":message["sequence"],"payload":payload}),
            )
        })();
        if let Err(error) = result {
            self.report(
                "error",
                match kind {
                    MessageKind::Plain => "Could not publish persisted chat message",
                    MessageKind::Task => "Could not publish encrypted Task message",
                    _ => "Could not publish encrypted chat message",
                },
                error,
                json!({"chatId":message["chatId"],"messageId":message["id"]}),
            );
        }
        if matches!(kind, MessageKind::Task)
            && let Some(chat) = message["chatId"].as_str()
        {
            let pending = self.invalidate_chat(owner, chat, "task", &message["id"], routing);
            self.fanout_message(pending.into_iter().collect()).await;
        }
    }
    pub async fn write_message(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        input: &Value,
        options: MessageOptions<'_>,
    ) -> Result<Option<Value>> {
        let MessageOptions {
            attribution,
            kind,
            upsert,
            routing,
        } = options;
        let attribution = attribution.filter(|v| truthy(Some(v)));
        let saved = match kind {
            MessageKind::Task => {
                if upsert {
                    self.repository
                        .upsert_task_message(owner, chat, input, attribution)
                        .await?
                } else {
                    self.repository
                        .append_task_message(owner, chat, input, attribution)
                        .await?
                }
            }
            MessageKind::Encrypted => {
                if upsert {
                    self.repository
                        .upsert_encrypted_message(owner, chat, input, attribution)
                        .await?
                } else {
                    self.repository
                        .append_encrypted_message(owner, chat, input, attribution)
                        .await?
                }
            }
            _ => {
                return self
                    .protect_visible(owner, chat, input, attribution, upsert)
                    .await;
            }
        };
        if let Some(saved) = &saved {
            self.publish_persisted_message(owner, saved, kind, routing)
                .await;
        }
        Ok(saved)
    }
    async fn protect_visible(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
        upsert: bool,
    ) -> Result<Option<Value>> {
        if !upsert && !truthy(input.get("idempotencyKey")) {
            bail!("Encrypted chat messages require an idempotency key.")
        }
        let key = input["idempotencyKey"]
            .as_js_string()
            .context("Message idempotency key")?
            .lossy();
        let existing = self
            .repository
            .message_by_idempotency_key(owner, chat, &key, MessageKind::Encrypted)
            .await?;
        if !upsert && existing.is_some() {
            return Ok(existing);
        }
        let Some(context) = self
            .repository
            .execution_context(owner, chat)
            .await?
            .filter(|c| c["experience"] == "agent")
        else {
            return Ok(None);
        };
        let worker = context["workerId"]
            .as_str()
            .context("Message protection worker")?;
        if !(self.dependencies.connected)(worker) {
            return Err(WorkerUnavailable.into());
        }
        let mut message = input.clone();
        message["id"] = existing
            .as_ref()
            .map(|m| m["id"].clone())
            .unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string()));
        let command = json!({"type":"chat.message.protect","message":message,"attachments":Vec::<Value>::new()});
        let protected = (self.dependencies.request)(owner.into(), worker.into(), command).await?;
        let protected =
            crate::settings::parse_response("chatMessageOpaqueContentSchema", protected.as_ref())?;
        let saved = if upsert {
            self.repository
                .upsert_encrypted_message(owner, chat, &protected, attribution)
                .await?
        } else {
            self.repository
                .append_encrypted_message(owner, chat, &protected, attribution)
                .await?
        };
        if let Some(saved) = &saved {
            self.publish_persisted_message(owner, saved, MessageKind::Encrypted, None)
                .await;
        }
        Ok(saved)
    }
    pub async fn set_route(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        selection: RouteSelection<'_>,
    ) -> Result<Option<Value>> {
        let RouteSelection {
            model,
            runtime,
            reasoning,
            kind,
            routing,
        } = selection;
        let saved = self
            .repository
            .set_message_model_route(owner, id, model, runtime, reasoning, kind)
            .await?;
        if let Some(saved) = &saved {
            self.publish_persisted_message(owner, saved, kind, routing)
                .await;
        }
        Ok(saved)
    }
}
