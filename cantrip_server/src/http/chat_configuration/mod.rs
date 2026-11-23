//! Public model/reasoning selection and native permission configuration.
mod models;
mod permissions;
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats, native_commands,
    operations::shared_failure::downcast_ref,
    settings::{reasoning, repository::SettingsRepository},
    wire::{self, JsString, Value, coercion::truthy, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, patch},
};
use std::sync::Arc;
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Chat configuration identity")?
        .lossy()
        .into_owned())
}
fn message(cause: &anyhow::Error) -> JsString {
    crate::settings::operation_error_message(cause)
}
fn native_failure(cause: &anyhow::Error) -> Option<Response> {
    downcast_ref::<native_commands::CommandError>(cause).map(|e| {
        super::json_response(
            axum::http::StatusCode::from_u16(e.status).unwrap(),
            json!({"code":e.code,"error":e.message}),
        )
    })
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let query = super::account::query(request.uri());
    let input = if method == Method::PATCH {
        let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        None
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let path = matched.as_str().to_owned();
    let work = {
        let service = service.clone();
        async move {
            if path.contains("/permission-profile") {
                permissions::execute(&service, &owner, &chat, method == Method::PATCH, input).await
            } else {
                models::execute(
                    &service,
                    &owner,
                    &chat,
                    path.ends_with("/model"),
                    method == Method::PATCH,
                    &query,
                    input,
                )
                .await
            }
        }
    };
    match service.scratch_roots.owned(work).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}/model", patch(handle))
        .route("/api/chats/{chatId}/reasoning", get(handle).patch(handle))
        .route("/api/chats/{chatId}/permission-profiles", get(handle))
        .route("/api/chats/{chatId}/permission-profile", patch(handle))
}
