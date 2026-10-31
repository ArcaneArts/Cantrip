//! Worker event publication happens only after the fenced transaction commits.
mod publication;
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_commands::{CommandError, Repository},
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
fn code(status: u16, key: &str) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), json!({"code":key}))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let authorization = middleware::value(request.headers(), "authorization");
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let input = match wire::parse("nativeCommandEventSchema", body.as_ref()) {
        Ok(v) => v,
        Err(_) => return code(400, "invalid-native-event"),
    };
    let worker = input["workerId"]
        .as_js_string()
        .unwrap()
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
        Ok(Some(a)) => a,
        Ok(None) => return code(401, "unauthorized"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = authentication.credential.owner_id;
    let apply_service = service.clone();
    match service
        .scratch_roots
        .owned(async move {
            let publication = Repository::new(apply_service.repository.database.clone())
                .apply_event(&owner, &input)
                .await?;
            publication::publish(&apply_service, &owner, publication);
            Ok::<_, anyhow::Error>(())
        })
        .await
    {
        Ok(()) => json_response(StatusCode::OK, json!({"applied":true})),
        Err(cause) => {
            if let Some(e) = cause.downcast_ref::<CommandError>() {
                code(e.status, &e.code)
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/internal/native-commands/events", post(handle))
}
