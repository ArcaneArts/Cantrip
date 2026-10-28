use std::{sync::Arc, time::Instant};

use axum::{
    Json, Router,
    extract::State,
    http::{Method, StatusCode, Uri, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{SecondsFormat, Utc};
use serde_json::json;

use crate::auth::service::AuthService;
mod account;
mod audit;
mod body;
mod encryption;
mod live_socket;
mod middleware;
mod on_response;
mod policies;
mod provider_accounts;
mod provider_catalogs;
mod provider_credentials;
mod provider_management;
mod provider_quota;
mod provider_telemetry;
mod sessions;
mod settings;
mod usage;
mod usage_hooks;
mod websocket;
mod worker_socket;
mod workers;

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn json_response<T: serde::Serialize>(status: StatusCode, value: T) -> Response {
    let mut response = (
        status,
        [(CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(value),
    )
        .into_response();
    use axum::body::HttpBody;
    if let Some(bytes) = response.body().size_hint().exact() {
        response
            .extensions_mut()
            .insert(usage_hooks::EncodedPayload(bytes as usize));
    }
    response
}

async fn api() -> Response {
    json_response(
        StatusCode::OK,
        json!({"name":"cantrip_server", "version":"0.0.0"}),
    )
}

async fn health() -> Response {
    json_response(
        StatusCode::OK,
        json!({"status":"alive", "service":"cantrip_server", "timestamp":timestamp()}),
    )
}

async fn ready(State(service): State<Arc<AuthService>>) -> Response {
    let database = &service.repository.database;
    let started = Instant::now();
    let success = database.query("SELECT 1", &[]).await.is_ok();
    json_response(
        if success {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        json!({
            "status": if success { "ready" } else { "not-ready" },
            "service":"cantrip_server",
            "database": {"engine":database.engine(), "status":if success { "ready" } else { "unavailable" }, "latencyMs":started.elapsed().as_secs_f64()*1000.0},
            "coordination": {"shared":false, "status":"ready"},
            "timestamp":timestamp()
        }),
    )
}

async fn not_found(method: Method, uri: Uri) -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        json!({
            "message":format!("Route {method}:{uri} not found"), "error":"Not Found", "statusCode":404
        }),
    )
}

/// Foundation and session routes. Remaining domains are tracked in the ledger.
pub fn router(service: Arc<AuthService>) -> Router {
    Router::new()
        .route("/api", get(api))
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .merge(sessions::routes())
        .merge(encryption::routes())
        .merge(account::routes())
        .merge(usage::routes())
        .merge(policies::routes())
        .merge(settings::routes())
        .merge(provider_accounts::routes())
        .merge(provider_catalogs::routes())
        .merge(provider_credentials::routes())
        .merge(provider_management::routes())
        .merge(provider_quota::routes())
        .merge(provider_telemetry::routes())
        .merge(workers::routes())
        .merge(worker_socket::routes())
        .merge(live_socket::routes())
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(axum::middleware::from_fn_with_state(
            service.clone(),
            middleware::guard,
        ))
        .with_state(service)
}
