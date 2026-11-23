use super::{
    account, body, json_response,
    middleware::{self, Context},
    provider_accounts::auth_failure,
    settings::{error, output, parse},
};
use crate::{auth::service::AuthService, wire::Value};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

fn failure(cause: anyhow::Error) -> Response {
    let message = crate::settings::operation_error_message(&cause);
    if message == crate::settings::account_service::REAUTH_MESSAGE.into() {
        return json_response(
            StatusCode::CONFLICT,
            Value::object([
                ("code", Value::String("provider-reauth-required".into())),
                ("error", Value::String(message)),
            ]),
        );
    }
    if message.lossy().ends_with("not found.") {
        return auth_failure(cause);
    }
    if message.lossy().contains("only available for ChatGPT")
        || message.lossy().contains("not signed in")
    {
        return error(409, message);
    }
    auth_failure(cause)
}
async fn execute(
    service: &AuthService,
    ctx: &Context,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("authenticated quota owner")?
        .id;
    let read = request.method() == Method::GET || request.method() == Method::HEAD;
    let (worker, consume) = if read {
        let query = account::query(request.uri());
        let Some(worker) = query
            .get("workerId")
            .filter(|worker| crate::wire::coercion::truthy(Some(worker)))
        else {
            return Ok(error(400, "workerId is required"));
        };
        (worker.clone(), None)
    } else {
        let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let input = match parse("providerRateLimitResetConsumeRequestSchema", raw.as_ref())? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        (input["workerId"].clone(), Some(input))
    };
    match service
        .provider_accounts
        .quota_request(
            owner,
            &params["providerId"],
            &params["accountId"],
            worker,
            consume,
        )
        .await
    {
        Ok(value) => output(
            200,
            if read {
                "providerQuotaSnapshotSchema"
            } else {
                "providerRateLimitResetConsumeResultSchema"
            },
            &value,
        ),
        Err(cause)
            if cause.is::<crate::settings::account_service::QuotaAuthenticationUpdateError>() =>
        {
            Err(cause)
        }
        Err(cause) => Ok(failure(cause)),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    match execute(&service, &ctx, &params, request).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/settings/providers/{providerId}/accounts/{accountId}/rate-limit-resets",
            get(handle),
        )
        .route(
            "/api/settings/providers/{providerId}/accounts/{accountId}/rate-limit-resets/consume",
            post(handle),
        )
}
