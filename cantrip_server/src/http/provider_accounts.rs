use super::{
    account, body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    settings::{authentication::ReconnectRequired, repository::SettingsRepository},
    wire::Value,
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
};
use std::{collections::HashMap, sync::Arc};

fn no_content() -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    response
}
pub(super) fn auth_failure(failure: anyhow::Error) -> Response {
    let command = failure.downcast_ref::<CommandFailure>();
    let message = crate::settings::operation_error_message(&failure);
    let status = if message.lossy().ends_with("not found.") {
        404
    } else if failure.is::<ReconnectRequired>() {
        409
    } else {
        command.map_or(502, |failure| failure.status(502))
    };
    error(status, message)
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
        .context("authenticated provider account owner")?
        .id;
    let repository = SettingsRepository::new(service.repository.database.clone());
    let method = request.method().clone();
    let logout = request.uri().path() == "/api/codex/auth/logout";
    let device_login = request.uri().path() == "/api/codex/auth/device-login";
    if request.uri().path() == "/api/codex/auth/status" {
        let query = account::query(request.uri());
        if !crate::wire::coercion::truthy(query.get("providerId")) {
            return Ok(error(400, "providerId is required"));
        }
        return Ok(
            match service.provider_accounts.auth_status(owner, query).await {
                Ok(status) => output(200, "codexAuthStatusSchema", &status)?,
                Err(cause) => auth_failure(cause),
            },
        );
    }
    let reorder = request.uri().path().ends_with("/accounts/order");
    if method == Method::GET || method == Method::HEAD {
        return match repository
            .list_provider_accounts(owner, &params["providerId"])
            .await?
        {
            Some(accounts) => output(
                200,
                "modelProviderAccountWireListSchema",
                &Value::from_serialize(&accounts),
            ),
            None => Ok(error(404, "Account provider not found.")),
        };
    }
    let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if device_login {
        let provider = raw.as_ref().and_then(|value| value.get("providerId"));
        let worker = raw.as_ref().and_then(|value| value.get("workerId"));
        if !crate::wire::coercion::truthy(provider) || !crate::wire::coercion::truthy(worker) {
            return Ok(error(400, "workerId and providerId are required"));
        }
        return Ok(
            match service
                .provider_accounts
                .device_login(
                    owner,
                    provider.context("required provider")?.clone(),
                    raw.as_ref()
                        .and_then(|value| value.get("accountId"))
                        .cloned(),
                    worker.context("required worker")?.clone(),
                )
                .await
            {
                Ok(login) => output(200, "codexDeviceLoginSchema", &login)?,
                Err(cause) => auth_failure(cause),
            },
        );
    }
    if logout {
        let Some(provider) = raw
            .as_ref()
            .and_then(|value| value.get("providerId"))
            .filter(|provider| crate::wire::coercion::truthy(Some(provider)))
        else {
            return Ok(error(400, "providerId is required"));
        };
        return Ok(
            match service
                .provider_accounts
                .sign_out(
                    owner,
                    provider.clone(),
                    raw.as_ref()
                        .and_then(|value| value.get("accountId"))
                        .cloned(),
                    raw.as_ref()
                        .and_then(|value| value.get("workerId"))
                        .cloned(),
                )
                .await
            {
                Ok(()) => no_content(),
                Err(failure) => auth_failure(failure),
            },
        );
    }
    if method == Method::DELETE {
        return Ok(
            match service
                .provider_accounts
                .delete_account(owner, &params["providerId"], &params["accountId"])
                .await
            {
                Ok(true) => no_content(),
                Ok(false) => error(404, "Provider account not found."),
                Err(failure) => auth_failure(failure),
            },
        );
    }
    let schema = if reorder {
        "orderedIdsSchema"
    } else if method == Method::POST {
        "encryptedModelProviderAccountCreateSchema"
    } else {
        "encryptedModelProviderAccountUpdateSchema"
    };
    let input = match parse(schema, raw.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if reorder {
        let ids = input["ids"]
            .as_array()
            .context("validated account IDs")?
            .iter()
            .map(|id| id.as_js_string().context("validated account ID").cloned())
            .collect::<Result<Vec<_>>>()?;
        return Ok(
            if service
                .provider_accounts
                .reorder_accounts(owner, &params["providerId"], ids)
                .await?
            {
                no_content()
            } else {
                error(400, "Provider account order did not match.")
            },
        );
    }
    let account = if method == Method::POST {
        service
            .provider_accounts
            .create_account(owner, &params["providerId"], input)
            .await?
    } else {
        service
            .provider_accounts
            .update_account(owner, &params["providerId"], &params["accountId"], input)
            .await?
    };
    match account {
        Some(account) => output(
            if method == Method::POST { 201 } else { 200 },
            "modelProviderAccountWireSummarySchema",
            &Value::from_serialize(&account),
        ),
        None => Ok(error(
            404,
            if method == Method::POST {
                "Account provider not found."
            } else {
                "Provider account not found."
            },
        )),
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
        Err(failure) => middleware::failure(&service, &ctx.id, &failure),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/settings/providers/{providerId}/accounts",
            get(handle).post(handle),
        )
        .route(
            "/api/settings/providers/{providerId}/accounts/order",
            patch(handle),
        )
        .route(
            "/api/settings/providers/{providerId}/accounts/{accountId}",
            patch(handle).delete(handle),
        )
        .route("/api/codex/auth/logout", post(handle))
        .route("/api/codex/auth/status", get(handle))
        .route("/api/codex/auth/device-login", post(handle))
}
