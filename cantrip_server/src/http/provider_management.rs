use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{auth::service::AuthService, settings::authentication::ReconnectRequired, wire::Value};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::post,
};
use std::{collections::HashMap, sync::Arc};

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
        .context("authenticated provider owner")?
        .id;
    let method = request.method().clone();
    let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if method == Method::DELETE {
        return Ok(
            match service
                .provider_accounts
                .delete_provider(owner, &params["providerId"])
                .await
            {
                Ok(true) => {
                    let mut response = Response::new(Body::empty());
                    *response.status_mut() = StatusCode::NO_CONTENT;
                    response
                }
                Ok(false) => error(404, "Provider not found."),
                Err(cause) => error(
                    409,
                    if cause.is::<ReconnectRequired>() {
                        cause.to_string()
                    } else {
                        "Delete the provider's models before deleting the provider.".into()
                    },
                ),
            },
        );
    }
    let create = method == Method::POST;
    let input = match parse(
        if create {
            "encryptedModelProviderCreateSchema"
        } else {
            "encryptedModelProviderUpdateSchema"
        },
        raw.as_ref(),
    )? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let result: Result<Response> = async {
        let provider = if create {
            Some(
                service
                    .provider_accounts
                    .create_provider(owner, input)
                    .await?,
            )
        } else {
            service
                .provider_accounts
                .update_provider(owner, &params["providerId"], input)
                .await?
        };
        match provider {
            Some(provider) => output(
                if create { 201 } else { 200 },
                "modelProviderWireSummarySchema",
                &Value::from_serialize(&provider),
            ),
            None => Ok(error(404, "Provider not found.")),
        }
    }
    .await;
    Ok(result.unwrap_or_else(|cause| error(409, crate::settings::operation_error_message(&cause))))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    execute(&service, &ctx, &params, request)
        .await
        .unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}
pub fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/settings/providers", post(handle))
        .route(
            "/api/settings/providers/{providerId}",
            axum::routing::patch(handle).delete(handle),
        )
}
