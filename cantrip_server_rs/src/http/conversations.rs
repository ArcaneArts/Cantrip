use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{
        Repository,
        conversations::{CursorError, UsageConflict},
    },
    operations::shared_failure::downcast_ref,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::{get, post},
};
use std::sync::Arc;

async fn list(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(project): Path<String>,
    request: Request,
) -> Response {
    let query = super::account::query(request.uri());
    let result: Result<Response> = async {
        let input = match parse("conversationCatalogQuerySchema", Some(&query))? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let owner = &context
            .principal
            .user
            .as_ref()
            .expect("Authenticated conversation owner")
            .id;
        match Repository::new(service.repository.database.clone())
            .list_conversations(owner, &project, &input)
            .await
        {
            Ok(Some(page)) => output(200, "conversationCatalogWirePageSchema", &page),
            Ok(None) => Ok(error(404, "Project not found.")),
            Err(cause) => {
                if let Some(cursor) = downcast_ref::<CursorError>(&cause) {
                    Ok(error(400, cursor.to_string()))
                } else {
                    Err(cause)
                }
            }
        }
    }
    .await;
    match result {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
async fn usage(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let result: Result<Response> = async {
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let input = match parse("conversationUsageSchema", body.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let owner = context
            .principal
            .user
            .as_ref()
            .expect("Authenticated conversation owner")
            .id
            .clone();
        let repository = Repository::new(service.repository.database.clone());
        match service
            .scratch_roots
            .owned(async move {
                repository
                    .record_conversation_usage(&owner, &chat, &input)
                    .await
            })
            .await
        {
            Ok(Some(usage)) => output(200, "conversationUsageResultSchema", &usage),
            Ok(None) => Ok(error(404, "Agent conversation not found.")),
            Err(cause) => {
                if let Some(conflict) = downcast_ref::<UsageConflict>(&cause) {
                    Ok(error(409, conflict.to_string()))
                } else {
                    Err(cause)
                }
            }
        }
    }
    .await;
    match result {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/conversations", get(list))
        .route("/api/chats/{chatId}/usage", post(usage))
}
