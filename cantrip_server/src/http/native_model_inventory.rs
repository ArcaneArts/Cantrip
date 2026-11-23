//! Worker-scoped public model metadata, using the enrolled credential's owner.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    settings::repository::SettingsRepository,
    wire::{self, value::json},
    workers::credentials,
};
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;

fn code(status: StatusCode, key: &str) -> Response {
    json_response(status, json!({"code":key}))
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let authorization = middleware::value(request.headers(), "authorization");
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let input = match wire::parse("nativeModelInventoryRequestSchema", body.as_ref()) {
        Ok(input) => input,
        Err(_) => return code(StatusCode::BAD_REQUEST, "invalid-native-model-inventory"),
    };
    let worker = input["workerId"]
        .as_js_string()
        .expect("Validated inventory worker")
        .lossy()
        .into_owned();
    let authentication = match credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:agent-tools",
    )
    .await
    {
        Ok(Some(authentication)) => authentication,
        Ok(None) => return code(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(cause) => return middleware::failure(&service, &context.id, &cause),
    };
    let owner = authentication.credential.owner_id;
    match service.workers.repository.get_worker(&owner, &worker).await {
        Ok(Some(_)) => {}
        Ok(None) => return code(StatusCode::NOT_FOUND, "worker-not-found"),
        Err(cause) => return middleware::failure(&service, &context.id, &cause),
    }
    match SettingsRepository::new(service.repository.database.clone())
        .read_native_model_inventory(&owner, &input)
        .await
    {
        Ok(Some(inventory)) => json_response(StatusCode::OK, inventory),
        Ok(None) => code(
            StatusCode::NOT_FOUND,
            "native-model-inventory-scope-not-found",
        ),
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/internal/native-model-inventory", post(handle))
}
