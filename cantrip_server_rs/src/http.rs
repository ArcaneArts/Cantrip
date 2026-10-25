use std::{sync::Arc, time::Instant};

use axum::{
    Json, Router,
    extract::State,
    http::{Method, StatusCode, Uri, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};

use crate::database::Database;

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [(CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(value),
    )
        .into_response()
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

async fn ready(State(database): State<Arc<Database>>) -> Response {
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

/// Foundation routes only. Other domains remain explicitly unported in the ledger.
pub fn router(database: Arc<Database>) -> Router {
    Router::new()
        .route("/api", get(api))
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(database)
}
