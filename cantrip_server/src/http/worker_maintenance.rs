//! Endpoint encryption refresh and its persisted terminal-service hook.
use super::{
    body,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService, projects::targets::TargetRepository, wire::Value,
    workers::command_bus::CommandFailure,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::post,
};
use std::sync::Arc;

async fn refresh(
    service: Arc<AuthService>,
    owner: String,
    worker: String,
    input: Value,
) -> Result<Response> {
    let Some(before) = TargetRepository::new(service.repository.database.clone())
        .worker(&owner, &Value::String(worker.clone().into()))
        .await?
    else {
        return Ok(error(404, "Worker not found."));
    };
    if !service.workers.bridge.is_connected(&worker) {
        return Ok(error(503, "Worker is offline."));
    }
    match service
        .worker_maintenance
        .refresh(&owner, &worker, &before["encryption"], &input)
        .await
    {
        Ok(result) => output(200, "workerEncryptionRefreshResultSchema", &result),
        Err(failure) => Ok(error(
            failure
                .downcast_ref::<CommandFailure>()
                .map_or(502, |failure| failure.status(502)),
            crate::settings::operation_error_message(&failure),
        )),
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: &str,
    worker: &str,
    request: Request,
) -> Result<Response> {
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let input = match parse("workerEncryptionRefreshRequestSchema", body.as_ref())? {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    let response = service
        .worker_maintenance
        .owned(refresh(
            service.clone(),
            owner.to_owned(),
            worker.to_owned(),
            input,
        ))
        .await?;
    if !response.status().is_success() {
        return Ok(response);
    }
    let live = service.live.clone();
    let owner = owner.to_owned();
    let worker = worker.to_owned();
    Ok(on_response::completed(response, move || {
        live.invalidate(&owner, "worker", &worker)
    }))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(worker): Path<String>,
    request: Request,
) -> Response {
    let owner = &ctx.principal.user.as_ref().unwrap().id;
    match execute(service.clone(), owner, &worker, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/workers/{workerId}/encryption/refresh", post(handle))
}
