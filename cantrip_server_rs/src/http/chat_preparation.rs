use super::{
    body, json_response,
    middleware::{self, Context},
    settings::error,
};
use crate::{auth::service::AuthService, wire::value::json};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::get,
};
use std::sync::Arc;

async fn execute(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
    method: Method,
) -> Result<Response> {
    let preparation = if matches!(method, Method::GET | Method::HEAD) {
        if crate::chats::Repository::new(service.repository.database.clone())
            .execution_context(&owner, &chat)
            .await?
            .is_none()
        {
            return Ok(error(404, "Chat not found."));
        }
        service
            .managed_preparation
            .repository
            .get(&owner, &chat)
            .await?
    } else {
        let Some(state) = service.managed_preparation.request(&owner, &chat).await? else {
            return Ok(error(
                404,
                "This chat does not support a managed CLI session.",
            ));
        };
        return Ok(json_response(
            StatusCode::ACCEPTED,
            json!({"preparation":state}),
        ));
    };
    Ok(json_response(
        StatusCode::OK,
        json!({"preparation":preparation}),
    ))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    if !matches!(method, Method::GET | Method::HEAD)
        && let Err(response) = body::parse_js(request, service.config.api_body_limit_bytes).await
    {
        return response;
    }
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated preparation owner")
        .id
        .clone();
    let result = service
        .scratch_roots
        .owned(execute(service.clone(), owner, chat, method))
        .await;
    match result {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/chats/{chatId}/preparation", get(handle).post(handle))
}
