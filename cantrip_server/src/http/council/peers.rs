use super::super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    chats::{
        Repository, agent_delivery::DeliveryError, council::peer_target,
        message_queries::MessageKind,
    },
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use axum::{
    Extension,
    extract::{Path, State},
    http::Uri,
    response::Response,
};
use cantrip_protocol::external_mcp::orchestration::resource_id;
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn send(
    service: &Arc<AuthService>,
    owner: &str,
    source: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("councilPeerSendExchangeSchema", arguments)?;
    let sender = source["chatId"].as_str().context("Council sender ID")?;
    let resolving = input["kind"] == "resolve";
    let recipient = (if resolving {
        &input["recipientAgentId"]
    } else {
        &input["source"]["recipientAgentId"]
    })
    .as_str()
    .context("Council recipient ID")?;
    if sender == recipient {
        return Err(OperationError::new(409, "conflict", "Send to another Council agent.").into());
    }
    let repository = Repository::new(service.repository.database.clone());
    if resolving {
        let current = peer_target(repository.execution_context(owner, recipient).await?)?;
        let (sender_title, recipient_title) = repository
            .council_peer_titles(owner, sender, recipient)
            .await?
            .ok_or(DeliveryError::ReceiverUnavailable)?;
        let data = parse(
            "councilPeerTargetWireSchema",
            &json!({"senderAgentId":sender,"recipientAgentId":recipient,"senderTitle":sender_title,
                "recipientTitle":recipient_title,"configuration":current["modelConfiguration"]}),
        )?;
        return Ok(json!({"summary":"Resolved the Council pair.","data":data}));
    }

    let operation = Uuid::parse_str(
        input["source"]["operationId"]
            .as_str()
            .context("Council handoff operation ID")?,
    )?;
    let input_id = resource_id(owner, sender, operation, "council-peer-input").to_string();
    let message_id = resource_id(owner, sender, operation, "council-peer-message").to_string();
    let prompt_id = resource_id(owner, sender, operation, "council-peer-prompt").to_string();
    let message = &input["turn"]["message"];
    let queued = &input["turn"]["queuedPrompt"];
    let sent = &input["sentMessage"];
    let key = format!("council-peer:{sender}:{operation}");
    let simple = |packet: &Value| {
        packet["classification"]["mode"] == "default"
            && packet["classification"]["attachmentIds"]
                .as_array()
                .is_some_and(|ids| ids.is_empty())
    };
    if input["source"]["senderAgentId"] != sender
        || message["id"] != input_id
        || queued["id"] != prompt_id
        || sent["id"] != message_id
        || message["classification"]["role"] != "user"
        || sent["classification"]["role"] != "assistant"
        || !simple(message)
        || !simple(queued)
        || !simple(sent)
        || message["idempotencyKey"] != format!("{key}:input")
        || queued["idempotencyKey"] != format!("{key}:input")
        || sent["idempotencyKey"] != format!("{key}:sent")
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
        return Err(
            OperationError::new(403, "invalid", "Invalid Council handoff envelope.").into(),
        );
    }
    if let Some(sent) = repository
        .deliver_council_peer(owner, source, recipient, &input)
        .await?
    {
        service
            .chat_mutations
            .publish_persisted_message(owner, &sent, MessageKind::Encrypted, None)
            .await;
    }
    drop(service.execution.recovery.dispatch(owner, recipient));
    let mut data = input["source"].clone();
    data["inputMessageId"] = json!(input_id);
    data["messageId"] = json!(message_id);
    data["delivery"] = json!("queued");
    Ok(
        json!({"summary":"Delivered the handoff to the Council agent's queue.","mutated":true,"data":data,
        "target":Value::Null,"worktreeId":Value::Null,"continuationScheduled":false}),
    )
}

pub(super) async fn history(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<super::Context>>,
    Path((agent, peer)): Path<(String, String)>,
    uri: Uri,
) -> Response {
    let result = async {
        let input = super::super::account::query(&uri);
        let input = match super::parse("councilPeerPageQuerySchema", Some(&input))? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let owner = &context.principal.user.as_ref().expect("Council owner").id;
        let repository = Repository::new(service.repository.database.clone());
        match repository
            .council_peer_page(owner, &agent, &peer, input["before"].as_str())
            .await?
        {
            Some(page) => super::output(200, "councilPeerPageSchema", &page),
            None => Ok(super::error(
                404,
                "Council pair or history cursor not found.",
            )),
        }
    }
    .await;
    result.unwrap_or_else(|cause| super::middleware::failure(&service, &context.id, &cause))
}
