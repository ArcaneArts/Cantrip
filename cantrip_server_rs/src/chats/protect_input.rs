//! Forward input to the existing worker protection contract; opaque content is
//! validated without opening it or introducing another server-side writer.
use crate::{
    wire::{Value, coercion::truthy, property, value::json},
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use anyhow::Result;
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;
pub type Request =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<Option<Value>>> + Send + Sync>;
pub struct InputProtection {
    request: Request,
}
impl InputProtection {
    pub fn new(commands: Arc<LimitedCommandBus>) -> Self {
        Self::with_request(Arc::new(move |worker, command| {
            let commands = commands.clone();
            async move {
                Ok(commands
                    .request_with_timeout(&worker, command, RequestTimeout::Default, None)
                    .await?)
            }
            .boxed()
        }))
    }
    pub fn with_request(request: Request) -> Self {
        Self { request }
    }
    pub async fn protect(
        &self,
        worker: &str,
        input: &Value,
        attachments: &[Value],
        reasoning: Option<&Value>,
        role: Option<&Value>,
    ) -> Result<Value> {
        let mut content = Vec::new();
        if let Some(text) = property(Some(input), "text")?.filter(|v| truthy(Some(v))) {
            content.push(json!({"type":"text","text":text}));
        }
        for attachment in attachments {
            let mut metadata = Value::object([] as [(&str, Value); 0]);
            for field in ["id", "chatId"] {
                if let Some(value) = property(Some(attachment), field)? {
                    metadata[field] = value.clone();
                }
            }
            metadata["fileName"] = json!("Protected attachment");
            metadata["mimeType"] = json!("application/octet-stream");
            if let Some(value) = property(Some(attachment), "sizeBytes")? {
                metadata["sizeBytes"] = value.clone();
            }
            metadata["kind"] = json!("file");
            metadata["source"] = json!("file");
            if let Some(value) = property(Some(attachment), "status")? {
                metadata["status"] = value.clone();
            }
            metadata["previewText"] = Value::Null;
            if let Some(value) = property(Some(attachment), "createdAt")? {
                metadata["createdAt"] = value.clone();
            }
            content.push(json!({"type":"attachment","attachment":metadata}));
        }
        let mode = property(Some(input), "mode")?
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!("default"));
        let mut message = json!({"id":uuid::Uuid::new_v4().to_string(),"role":role.cloned().unwrap_or_else(||json!("user")),"mode":mode});
        if let Some(reasoning) = reasoning {
            message["reasoningEffort"] = reasoning.clone();
        }
        message["content"] = Value::Array(content);
        if let Some(key) = property(Some(input), "idempotencyKey")? {
            message["idempotencyKey"] = key.clone();
        }
        let response = (self.request)(
            worker.to_owned(),
            json!({"type":"chat.message.protect","message":message,"attachments":attachments}),
        )
        .await?;
        crate::settings::parse_response("chatMessageOpaqueContentSchema", response.as_ref())
    }
}
