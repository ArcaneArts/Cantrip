//! Worker-authenticated current authority, independent of cached MCP policy.
use super::{
    body,
    middleware::{self, Context},
    settings::error,
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, computer_use_authority},
    wire,
    workers::credentials,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Request, State},
    response::Response,
    routing::post,
};
use std::sync::Arc;

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let authorization = middleware::value(request.headers(), "authorization");
    let body = match body::parse_js_buffer(
        request,
        32 * 1024,
        (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let input = match wire::parse("cuaAgentAuthorityRequestSchema", body.as_ref()) {
        Ok(value) => value,
        Err(_) => return error(400, "Invalid computer-use authority request."),
    };
    let binding = &input["binding"];
    // Preserve the original UTF16 claim for authorization; SQL uses UTF8
    // replacement just as the reference driver's text parameters do.
    let worker = binding["workerId"]
        .as_js_string()
        .expect("Validated binding worker")
        .lossy();
    let authentication = match credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:agent-tools",
    )
    .await
    {
        Ok(Some(value)) if binding["ownerId"] == value.credential.owner_id.as_str() => value,
        Ok(_) => return error(401, "Unauthorized"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = authentication.credential.owner_id;
    let result: Result<Response> = async {
        let context = Repository::new(service.repository.database.clone())
            .execution_context(
                &owner,
                &binding["chatId"]
                    .as_js_string()
                    .expect("Validated binding chat")
                    .lossy(),
            )
            .await?;
        if context
            .as_ref()
            .is_some_and(|context| context["computerUseEnabled"] != true)
        {
            return Ok(error(403, "Computer use is not enabled."));
        }
        let authority = match context {
            Some(context) => computer_use_authority::agent(
                &owner,
                &service.server_id,
                &context,
                binding,
                crate::auth::now().timestamp_millis(),
            )?,
            None => None,
        };
        let Some(authority) = authority else {
            return Ok(error(
                409,
                "Computer-use execution placement is no longer authorized.",
            ));
        };
        let mut response = super::json_response(axum::http::StatusCode::OK, authority);
        response.headers_mut().insert(
            "cache-control",
            axum::http::HeaderValue::from_static("no-store"),
        );
        Ok(response)
    }
    .await;
    result.unwrap_or_else(|_| error(503, "Computer-use authorization is unavailable."))
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/internal/computer-use/authority", post(handle))
}
