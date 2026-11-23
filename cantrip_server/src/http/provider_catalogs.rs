use super::{
    account, body,
    middleware::Context,
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    settings::{SettingsQueryError, catalog_runtime::CatalogRequest},
    wire::JsString,
    workers::command_bus::CommandFailure,
};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

fn failure(message: JsString) -> Response {
    let text = message.lossy();
    let status = if text == "Worker not found." {
        404
    } else if [
        "not an OpenRouter",
        "not an Ollama",
        "not a ChatGPT",
        "not a Grok",
        "not a Z.ai",
    ]
    .iter()
    .any(|part| text.contains(part))
    {
        409
    } else if [
        "worker is available",
        "offline",
        "signed-in ChatGPT",
        "signed-in Grok",
    ]
    .iter()
    .any(|part| text.contains(part))
    {
        503
    } else {
        502
    };
    error(status, message)
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let force = request.method() == Method::POST;
    let query = account::query(request.uri());
    // The reference framework parses POST bodies even though this handler
    // ignores their fields. Preserve parser failures before starting a refresh.
    if force
        && let Err(response) = body::parse_js(request, service.config.api_body_limit_bytes).await
    {
        return response;
    }
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .expect("authenticated catalog owner")
        .id;
    let result = async {
        let catalog = service
            .provider_catalogs
            .load(CatalogRequest {
                owner: owner.clone(),
                provider: params["providerId"].clone(),
                worker: query.get("workerId").cloned(),
                force,
                account: None,
                quota_trigger: force.then(|| "manual-refresh".into()),
            })
            .await?;
        match catalog {
            Some(catalog) => output(
                200,
                "providerModelCatalogResultSchema",
                &crate::wire::Value::from_serialize(&catalog),
            ),
            None => Ok(error(404, "Provider not found.")),
        }
    }
    .await;
    result.unwrap_or_else(|cause: anyhow::Error| {
        let message = cause
            .downcast_ref::<CommandFailure>()
            .map(CommandFailure::message)
            .or_else(|| {
                cause
                    .downcast_ref::<SettingsQueryError>()
                    .map(|error| error.message.clone())
            })
            .unwrap_or_else(|| cause.to_string().into());
        failure(message)
    })
}
pub fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/settings/providers/{providerId}/catalog", get(handle))
        .route(
            "/api/settings/providers/{providerId}/catalog/refresh",
            post(handle),
        )
}
