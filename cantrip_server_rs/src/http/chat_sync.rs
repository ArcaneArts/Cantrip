use super::{
    body, json_response,
    middleware::{self, Context},
    settings::error,
};
use crate::{auth::service::AuthService, chats::Repository, wire::coercion::truthy};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;

async fn synchronize(service: Arc<AuthService>, owner: String, chat: String) -> Result<Response> {
    let Some(context) = Repository::new(service.repository.database.clone())
        .execution_context(&owner, &chat)
        .await?
    else {
        return Ok(error(404, "Chat source not found."));
    };
    if context["contextKind"] == "standalone" {
        return Ok(error(
            409,
            "This IDE-only Chat feature is unavailable in standalone Chat.",
        ));
    }
    if context["experience"] == "task" {
        return Ok(error(
            409,
            "Encrypted Task reconstruction uses worker relocation.",
        ));
    }
    let sync = if !truthy(context.get("threadId")) {
        service
            .execution
            .thread_sync
            .reconcile(&owner, &context, None)
            .await?
    } else {
        let worker = context["workerId"].as_str().expect("Chat sync worker");
        if !service.workers.bridge.is_connected(worker) {
            return Ok(error(503, "Project worker is offline."));
        }
        let Some(runtime) = service
            .model_routing
            .runtime_for_context(&owner, &context)
            .await?
        else {
            return Ok(error(400, "Selected model was not found."));
        };
        service
            .execution
            .thread_sync
            .reconcile(&owner, &context, Some(&runtime))
            .await?
    };
    Ok(json_response(StatusCode::OK, sync))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = body::parse_js(request, service.config.api_body_limit_bytes).await {
        return response;
    }
    let owner = context
        .principal
        .user
        .as_ref()
        .expect("Chat synchronization owner")
        .id
        .clone();
    match service
        .scratch_roots
        .owned(synchronize(service.clone(), owner, chat))
        .await
    {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/chats/{chatId}/sync", post(handle))
}
