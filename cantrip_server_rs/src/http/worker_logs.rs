//! Owned worker log reads retain the existing cursor and failure contracts.
use super::{
    account, json_response,
    middleware::{self, Context},
    settings::{error, parse},
};
use crate::{
    auth::service::AuthService,
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::get,
};
use std::{sync::Arc, time::Duration};

async fn execute(
    service: Arc<AuthService>,
    owner: String,
    worker: String,
    request: Request,
) -> Result<Response> {
    let query = account::query(request.uri());
    // Fastify ignores GET/HEAD bodies, including malformed or oversized JSON.
    drop(request);
    let query = match parse("workerLogReadQuerySchema", Some(&query))? {
        Ok(query) => query,
        Err(response) => return Ok(response),
    };
    if service
        .workers
        .repository
        .get_worker(&owner, &worker)
        .await?
        .is_none()
    {
        return Ok(error(404, "Worker not found."));
    }
    if !service.workers.commands.is_connected(&worker) {
        return Ok(error(503, "Worker is offline."));
    }
    let response: Result<Response> = async {
        let mut command = json!({"type":"diagnostics.logs.read"});
        if let (Value::Object(out), Value::Object(query)) = (&mut command, &query) {
            out.extend(query.clone());
        }
        let response = service
            .workers
            .commands
            .request(&worker, command, Some(Duration::from_secs(5)), None)
            .await?;
        let response =
            crate::settings::parse_response("serviceLogReadResultSchema", response.as_ref())?;
        Ok(json_response(StatusCode::OK, response))
    }
    .await;
    Ok(match response {
        Ok(response) => response,
        Err(cause) => super::worker_links::request_failure(&cause),
    })
}
async fn read(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(worker): Path<String>,
    request: Request,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Admitted worker log read")
        .id
        .clone();
    match service
        .worker_maintenance
        .owned(execute(service.clone(), owner, worker, request))
        .await
    {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn unregistered_method(method: &Method, route: &str) -> bool {
    matches!(
        route,
        "/api/workers/:workerId/logs" | "/api/workers/:workerId/logs/stream"
    ) && *method != Method::GET
        && *method != Method::HEAD
}
async fn stream_head(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    _request: Request,
) -> Response {
    // Fastify's automatic HEAD invokes this websocket-only handler as an HTTP
    // handler. Preserve its observed redacted failure and response length.
    middleware::failure(
        &service,
        &ctx.id,
        &anyhow::anyhow!("socket.close is not a function"),
    )
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/workers/{workerId}/logs", get(read))
        .route(
            "/api/workers/{workerId}/logs/stream",
            get(super::worker_log_socket::connect).head(stream_head),
        )
}
