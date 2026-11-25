use super::super::{
    agent_operations::{OperationError, parse},
    middleware::{self, Context},
    settings::output,
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, council_notifications::Post, message_queries::MessageKind},
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, State},
    response::Response,
    routing::{get, post},
};
use cantrip_protocol::external_mcp::orchestration::resource_id;
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn post_message(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("councilMessagePostWireSchema", arguments)?;
    let operation = input["operationId"]
        .as_str()
        .context("Council message operation")?;
    let chat = context["chatId"]
        .as_str()
        .context("Council chat identity")?;
    let message_id =
        resource_id(owner, chat, Uuid::parse_str(operation)?, "council-message").to_string();
    let notify = input["notify"] == true;
    if input["message"]["id"] != message_id
        || input["message"]["classification"]["role"] != "assistant"
        || input["message"]["idempotencyKey"] != format!("council-message:{operation}")
    {
        return Err(OperationError::new(
            400,
            "invalid",
            "The message identity does not match this operation.",
        )
        .into());
    }
    let repository = Repository::new(service.repository.database.clone());
    match repository
        .post_council_message(owner, context, input.clone())
        .await?
    {
        Post::Created(message) => {
            service
                .chat_mutations
                .publish_persisted_message(owner, &message, MessageKind::Encrypted, None)
                .await;
            if notify {
                let _ = service.live.publish_event(json!({
                    "ownerId":owner,"scope":json!({"kind":"current-user"}),
                    "resource":"council-notification","action":"invalidated",
                    "entityId":message_id,"revision":Value::Null,"payload":Value::Null,
                }));
            }
        }
        Post::Replay => {}
        Post::Conflict => {
            return Err(OperationError::new(
                409,
                "conflict",
                "This operation ID already belongs to another message.",
            )
            .into());
        }
        Post::Inactive => {
            return Err(OperationError::new(
                409,
                "stale-binding",
                "The Council turn is no longer active.",
            )
            .into());
        }
    }
    Ok(json!({
        "summary":"Posted the Council message.","mutated":true,
        "data":json!({"operationId":operation,"messageId":message_id,"notify":notify}),
    }))
}

async fn pending(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
) -> Response {
    let owner = &context
        .principal
        .user
        .as_ref()
        .expect("Council notification owner")
        .id;
    let repository = Repository::new(service.repository.database.clone());
    let result = async {
        output(
            200,
            "councilPendingNotificationsSchema",
            &repository.council_pending_notifications(owner).await?,
        )
    }
    .await;
    result.unwrap_or_else(|error| middleware::failure(&service, &context.id, &error))
}

async fn claim(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(message_id): Path<String>,
) -> Response {
    let owner = &context
        .principal
        .user
        .as_ref()
        .expect("Council notification owner")
        .id;
    let repository = Repository::new(service.repository.database.clone());
    let result = async {
        let claimed = repository
            .claim_council_notification(owner, &message_id)
            .await?;
        output(
            200,
            "councilNotificationClaimSchema",
            &json!({"claimed":claimed}),
        )
    }
    .await;
    result.unwrap_or_else(|error| middleware::failure(&service, &context.id, &error))
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/council/notifications", get(pending))
        .route("/api/council/notifications/{messageId}/claim", post(claim))
}
