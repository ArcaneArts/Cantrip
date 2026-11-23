//! Existing public CUA endpoints forward only bounded opaque worker content.
mod operation;
mod preview;
use super::{
    body,
    middleware::{self, Context},
    settings::error,
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, computer_use_authority},
    computer_use::text,
    wire::{self, Value, value::json},
    workers::{bridge::EventHandler, command_bus::CommandFailure},
};
use anyhow::{Result, ensure};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::post,
};
use futures::FutureExt;
use std::{sync::Arc, time::Duration};

fn unavailable(cause: &anyhow::Error) -> bool {
    matches!(crate::operations::shared_failure::downcast_ref::<CommandFailure>(cause), Some(CommandFailure::Bridge(error)) if error.unavailable)
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    path: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Admitted computer-use request")
        .id
        .clone();
    let operation = path.as_str().ends_with("/operation");
    let stop = path.as_str().ends_with("/stop");
    let limit = if operation {
        ((16 * 1024 * 1024 + 16) * 4u64).div_ceil(3) + 1024
    } else {
        service.config.api_body_limit_bytes
    };
    let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
    let input = match if !operation && !stop {
        body::parse_js_own_buffer(request, limit, binary).await
    } else {
        body::parse_js_buffer(request, limit, binary).await
    } {
        Ok(value) => value,
        Err(response) if operation => {
            let mut rejected = error(
                if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    413
                } else {
                    400
                },
                "Invalid computer-use request.",
            );
            if let Some(value) = response.headers().get("connection") {
                rejected.headers_mut().insert("connection", value.clone());
            }
            return rejected;
        }
        Err(response) => return response,
    };
    let retained = service.clone();
    let result = service
        .worker_maintenance
        .owned(async move {
            if operation {
                operation::run(&retained, &owner, &chat, input).await
            } else if stop {
                preview::stop(&retained, &owner, &chat, input).await
            } else {
                preview::open(&retained, &owner, &chat, input).await
            }
        })
        .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}
pub(super) fn unregistered_method(method: &Method, route: &str) -> bool {
    matches!(
        route,
        "/api/chats/:chatId/computer-use/operation"
            | "/api/chats/:chatId/computer-use/preview"
            | "/api/chats/:chatId/computer-use/preview/stop"
            | "/api/internal/computer-use/authority"
    ) && *method != Method::POST
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}/computer-use/operation", post(handle))
        .route("/api/chats/{chatId}/computer-use/preview", post(handle))
        .route(
            "/api/chats/{chatId}/computer-use/preview/stop",
            post(handle),
        )
}
