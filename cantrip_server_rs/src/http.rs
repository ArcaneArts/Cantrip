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
mod browser_discovery;
mod browsers;
mod direct_attachments;
mod encryption;
mod file_documents;
mod folders;
mod live_socket;
mod middleware;
mod on_response;
mod pane_layouts;
mod policies;
mod project_shares;
mod projects;
mod provider_accounts;
mod provider_catalogs;
mod provider_credentials;
mod provider_management;
mod provider_quota;
mod provider_telemetry;
mod repository_operations;
mod sessions;
mod settings;
mod terminal_direct;
mod terminal_socket;
mod terminals;
mod tunnel_attachments;
mod tunnel_cleanup;
mod tunnel_direct;
mod tunnel_socket;
mod tunnels;
mod usage;
mod usage_hooks;
mod websocket;
mod worker_link_observations;
mod worker_link_sessions;
mod worker_link_socket;
mod worker_link_surfaces;
mod worker_link_terminals;
mod worker_link_tunnels;
mod worker_links;
mod worker_maintenance;
mod worker_socket;
mod workers;
mod workspace_layouts;

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
        .merge(worker_links::routes())
        .merge(worker_link_sessions::routes())
        .merge(direct_attachments::routes())
        .merge(worker_link_socket::routes())
        .merge(encryption::routes())
        .merge(account::routes())
        .merge(usage::routes())
        .merge(policies::routes())
        .merge(projects::routes())
        .merge(folders::routes())
        .merge(file_documents::routes())
        .merge(pane_layouts::routes())
        .merge(workspace_layouts::routes())
        .merge(repository_operations::routes())
        .merge(settings::routes())
        .merge(terminals::routes())
        .merge(browsers::routes())
        .merge(browser_discovery::routes())
        .merge(project_shares::routes())
        .merge(tunnels::routes())
        .merge(tunnel_attachments::routes())
        .merge(tunnel_socket::routes())
        .merge(terminal_socket::routes())
        .merge(provider_accounts::routes())
        .merge(provider_catalogs::routes())
        .merge(provider_credentials::routes())
        .merge(provider_management::routes())
        .merge(provider_quota::routes())
        .merge(provider_telemetry::routes())
        .merge(workers::routes())
        .merge(worker_maintenance::routes())
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
