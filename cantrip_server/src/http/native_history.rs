//! Authenticated worker history imports and pinned recovery. Ingestion owns its
//! real canonical writer; confirmed publication is independently durable.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_history::{BatchRejection, HistoryError, Repository},
    wire::{self, Value, value::json},
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
fn contract(phase: &str) -> (&'static str, &'static str) {
    match phase {
        "open" => (
            "nativeHistoryBindingOpenSchema",
            "invalid-native-history-binding",
        ),
        "resolve" => (
            "nativeHistoryResolveSchema",
            "invalid-native-history-resolution",
        ),
        "archive" => (
            "nativeHistoryArchiveReadSchema",
            "invalid-native-history-archive",
        ),
        "archive-turns" => (
            "nativeHistoryTurnArchiveReadSchema",
            "invalid-native-history-turn-archive",
        ),
        "archive-batches" => (
            "nativeHistoryBatchArchiveReadSchema",
            "invalid-native-history-batch-archive",
        ),
        _ => ("nativeHistoryIngestSchema", "invalid-native-history-batch"),
    }
}
async fn apply(
    database: Arc<crate::database::Database>,
    owner: String,
    input: Value,
    phase: String,
) -> anyhow::Result<Value> {
    let repository = Repository::new(database);
    match phase.as_str() {
        "open" => Ok(json!({"binding":repository.open_binding(&owner,&input).await?})),
        "resolve" => Ok(json!({"items":repository.resolve_items(&owner,&input).await?})),
        "archive" => repository.archive_items(&owner, &input).await,
        "archive-turns" => repository.archive_turns(&owner, &input).await,
        "archive-batches" => repository.archive_batches(&owner, &input).await,
        _ => repository.ingest(&owner, &input).await,
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let phase = request.uri().path().rsplit('/').next().unwrap().to_owned();
    let authorization = middleware::value(request.headers(), "authorization");
    let limit = if phase == "ingest" {
        64 * 1024 * 1024
    } else {
        service.config.api_body_limit_bytes
    };
    let body = match body::parse_js(request, limit).await {
        Ok(v) => v,
        Err(response) => return response,
    };
    let (schema, invalid) = contract(&phase);
    let input = match wire::parse(schema, body.as_ref()) {
        Ok(v) => v,
        Err(_) => return code(400, invalid),
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
        Ok(Some(value)) => value,
        Ok(None) => return code(401, "unauthorized"),
        Err(error) => return middleware::failure(&service, &ctx.id, &error),
    };
    let result = service
        .scratch_roots
        .owned(apply(
            service.repository.database.clone(),
            authentication.credential.owner_id,
            input,
            phase,
        ))
        .await;
    match result {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(error) => {
            if let Some(e) = error.downcast_ref::<BatchRejection>() {
                return json_response(
                    StatusCode::CONFLICT,
                    json!({"code":e.rejection["code"],"rejection":e.rejection}),
                );
            }
            if let Some(e) = error.downcast_ref::<HistoryError>() {
                return code(e.status_code, e.code);
            }
            middleware::failure(&service, &ctx.id, &error)
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/internal/native-history/open", post(handle))
        .route("/api/internal/native-history/resolve", post(handle))
        .route("/api/internal/native-history/archive", post(handle))
        .route("/api/internal/native-history/archive-turns", post(handle))
        .route("/api/internal/native-history/archive-batches", post(handle))
        .route("/api/internal/native-history/ingest", post(handle))
}
