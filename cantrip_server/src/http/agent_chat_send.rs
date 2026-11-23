//! Validate opaque delivery identities before the durable three-part admission.
use super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    chats,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    source: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("agentChatSendWireSchema", arguments)?;
    if input["chatId"] == source["chatId"] {
        return Err(OperationError::new(
            409,
            "conflict",
            "Send to another chat, not the current chat.",
        )
        .into());
    }
    let target = input["chatId"].as_str().context("Receiving chat")?;
    let key = format!(
        "agent-chat:{}:{target}:{}",
        source["chatId"].as_str().context("Sending chat")?,
        input["operationId"]
            .as_str()
            .context("Delivery operation")?
    );
    let message = &input["turn"]["message"];
    let queued = &input["turn"]["queuedPrompt"];
    let sent = &input["sentMessage"];
    let received = &input["receivedMessage"];
    if message["classification"]["role"] != "user"
        || sent["classification"]["role"] != "assistant"
        || received["classification"]["role"] != "assistant"
        || received["idempotencyKey"] != format!("{key}:received")
        || received["classification"]["mode"] != "default"
        || !received["classification"]["attachmentIds"]
            .as_array()
            .context("Received attachments")?
            .is_empty()
        || message["idempotencyKey"] != format!("{key}:input")
        || queued["idempotencyKey"] != format!("{key}:input")
        || sent["idempotencyKey"] != format!("{key}:sent")
        || message["classification"]["mode"] != "default"
        || queued["classification"]["mode"] != "default"
        || !message["classification"]["attachmentIds"]
            .as_array()
            .context("Input attachments")?
            .is_empty()
        || !queued["classification"]["attachmentIds"]
            .as_array()
            .context("Queued attachments")?
            .is_empty()
        || !sent["classification"]["attachmentIds"]
            .as_array()
            .context("Sent attachments")?
            .is_empty()
        || queued.get("protectedNativeInput").is_some()
        || queued.get("nativeClientUserMessageId").is_some()
        || queued
            .get("executionMethod")
            .is_some_and(|method| method != "turn/start")
        || queued
            .get("nativeAction")
            .is_some_and(|action| action != "literal")
        || truthy(queued.get("frozen"))
        || !queued["worktreeId"].is_null()
    {
        return Err(OperationError::new(
            403,
            "invalid",
            "Invalid agent message delivery envelope.",
        )
        .into());
    }
    let repository = chats::Repository::new(service.repository.database.clone());
    chats::agent_delivery::receiver(
        repository.execution_context(owner, target).await?,
        &source["projectId"],
    )?;
    let (received, sent) = repository
        .deliver_agent_message(owner, source, target, &input)
        .await?;
    for message in [&received, &sent] {
        service
            .chat_mutations
            .publish_persisted_message(
                owner,
                message,
                chats::message_queries::MessageKind::Encrypted,
                None,
            )
            .await;
    }
    drop(service.execution.recovery.dispatch(owner, target));
    Ok(
        json!({"summary":"Agent message delivered to the receiving chat queue.","data":json!({"chatId":target,"sourceChatId":source["chatId"],"operationId":input["operationId"],"messageId":received["id"],"delivery":"queued"}),"mutated":true,"target":Value::Null,"worktreeId":source["worktreeId"],"continuationScheduled":false}),
    )
}
