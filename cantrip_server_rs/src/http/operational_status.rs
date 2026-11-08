//! Health and Prometheus expose the same existing runtime collectors as Source.
use super::{
    json_response,
    middleware::{self, Context},
    on_response,
    settings::output,
};
use crate::{
    auth::{UserRole, crypto, service::AuthService},
    operations::logging::{self, LogCall},
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Request, State},
    http::{Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
};
use std::{sync::Arc, time::Instant};

fn usage_collectors(service: &AuthService) -> Value {
    json!({
        "bandwidthMeter":Value::from_serialize(&service.usage.meter.stats()),
        "historyMaintenance":Value::from_serialize(&service.usage.history.stats()),
        "storageReconciliation":Value::from_serialize(&service.usage.storage.stats())
    })
}
fn collectors(service: &AuthService, captured_usage: Option<Value>) -> Value {
    let workers = service.workers.commands.stats();
    let coordination = service.coordination.as_ref().map_or_else(|| json!({"cachedWorkers":service.workers.bridge.stats().connected_workers,"instanceCount":1,"maximumInstances":1,"receivedMessages":0,"rejectedMessages":0,"sentMessages":0,"shared":false}), |c| c.stats());
    json!({
        "coordination":coordination,
        "workers":Value::from_serialize(&workers),
        "live":Value::from_serialize(&service.live.hub.stats()),
        "quotas":Value::from_serialize(&service.workers.relay_quotas.stats()),
        "tunnels":service.tunnel_runtime.stats(),
        "accountUsage":captured_usage.unwrap_or_else(|| usage_collectors(service))
    })
}
async fn health_value(service: &AuthService, owner: &str) -> Result<Response> {
    let started = Instant::now();
    service.repository.database.ping().await?;
    service
        .operational_metrics
        .database_probe(true, started.elapsed().as_secs_f64() * 1000.0);
    // Source captures usage before the owned worker query, then samples the
    // live runtime collectors after that query. A database wait must not freeze
    // the earlier Live/worker/coordination view into the eventual response.
    let usage = usage_collectors(service);
    let connected = service
        .workers
        .repository
        .list_workers(owner)
        .await?
        .into_iter()
        .filter(|w| w["online"] == true)
        .count();
    let collected = collectors(service, Some(usage));
    let mut operations = service.operational_metrics.snapshot();
    operations["instanceId"] = json!(
        service
            .config
            .server_instance_id
            .as_deref()
            .unwrap_or("local-single-instance")
    );
    for (target, source) in [
        ("coordination", "coordination"),
        ("quotas", "quotas"),
        ("tunnels", "tunnels"),
        ("workerCommands", "workers"),
        ("accountUsage", "accountUsage"),
    ] {
        operations[target] = collected[source].clone();
    }
    operations["workerLinkRelay"] = service.worker_links.relay.stats();
    output(
        200,
        "systemHealthSchema",
        &json!({"status":"ok","service":"cantrip_server","database":json!({"engine":service.repository.database.engine(),"ready":true}),"workers":json!({"connected":connected}),"live":collected["live"],"operations":operations,"timestamp":super::timestamp()}),
    )
}
async fn health(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
) -> Response {
    match health_value(&service, &context.principal.user.as_ref().unwrap().id).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &context.id, &error),
    }
}
async fn metrics(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    // Node exposes header octets as Latin-1. to_str() rejects obs-text, which
    // would reject an otherwise valid configured non-ASCII metrics token.
    let authorization = request.headers().get(header::AUTHORIZATION).map(|v| {
        v.as_bytes()
            .iter()
            .copied()
            .map(char::from)
            .collect::<String>()
    });
    let bearer = authorization
        .as_deref()
        .and_then(|v| v.strip_prefix("Bearer "));
    let token_authorized = service
        .config
        .metrics_token
        .as_deref()
        .zip(bearer)
        .is_some_and(|(expected, candidate)| {
            !candidate.is_empty() && crypto::safe_secret_match(candidate, expected)
        });
    let account_authorized = context
        .principal
        .user
        .as_ref()
        .is_some_and(|u| matches!(u.role, UserRole::Owner | UserRole::Admin));
    if !token_authorized && !account_authorized {
        let mut response = json_response(
            StatusCode::UNAUTHORIZED,
            json!({"error":"Metrics authorization required."}),
        );
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("Bearer realm=\"Cantrip metrics\""),
        );
        return response;
    }
    let body = service
        .operational_metrics
        .render_prometheus(&collectors(&service, None), &service.transport_metrics);
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response()
}
pub(super) fn unregistered_method(method: &Method, route: &str) -> bool {
    matches!(route, "/api/health" | "/metrics") && *method != Method::GET && *method != Method::HEAD
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/health", get(health))
        .route("/metrics", get(metrics))
}
fn legacy_endpoint(method: &Method, route: &str) -> Option<&'static str> {
    match (method.as_str(), route) {
        ("GET", "/api/remote-surfaces/:surfaceId/connect") => Some("remote-surface-transport"),
        ("POST", "/api/terminals/:terminalId/direct") => Some("terminal-direct"),
        ("GET", "/api/terminals/:terminalId/connect") => Some("terminal-relay"),
        ("POST", "/api/tunnel-attachments/:attachmentId/direct") => Some("tunnel-direct"),
        ("POST", "/api/tunnel-attachments/:attachmentId/direct-activate") => {
            Some("tunnel-direct-activate")
        }
        ("GET", "/api/tunnel-attachments/:attachmentId/connect") => Some("tunnel-relay"),
        _ => {
            // This declared Source route is still being ported. Observing its
            // deprecated transport does not replace the missing handler.
            let parts: Vec<_> = route.split('/').collect();
            (method == Method::GET
                && parts.len() == 5
                && parts[1] == "api"
                && parts[2] == "remote-surfaces"
                && !parts[3].is_empty()
                && parts[4] == "connect")
                .then_some("remote-surface-transport")
        }
    }
}
pub async fn observe(
    State(service): State<Arc<AuthService>>,
    request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let path = request.extensions().get::<MatchedPath>().map_or_else(
        || request.uri().path().to_owned(),
        |p| {
            p.as_str()
                .split('/')
                .map(|s| {
                    s.strip_prefix('{')
                        .and_then(|s| s.strip_suffix('}'))
                        .map_or_else(|| s.to_owned(), |s| format!(":{s}"))
                })
                .collect::<Vec<_>>()
                .join("/")
        },
    );
    let legacy = legacy_endpoint(&method, &path);
    service.operational_metrics.begin_http();
    if let Some(endpoint) = legacy {
        service.operational_metrics.legacy_request(endpoint);
        logging::server_logger()(LogCall::repeated(
            format!("legacy-feature-transport:{endpoint}").into(),
            "warn",
            "Deprecated feature transport endpoint requested",
            json!({"endpoint":endpoint,"event":"network.compatibility-endpoint.requested","operation":"connect","reasonCode":"legacy-feature-transport","status":"deprecated","subsystem":"worker-link"}),
            None,
        ));
    }
    let mut response = next.run(request).await;
    // The Source plugin hijacks the raw upgrade and does not copy reply headers.
    // Count its request/legacy observation, without adding ordinary headers or
    // fabricating an onResponse callback for the handshake.
    if response
        .extensions()
        .get::<super::websocket::RawUpgradeResponse>()
        .is_some()
    {
        return response;
    }
    if let Some(_endpoint) = legacy {
        response.headers_mut().insert(
            "deprecation",
            header::HeaderValue::from_static("@1787788800"),
        );
        response.headers_mut().insert(header::LINK, header::HeaderValue::from_static("<https://github.com/ArcaneArts/Cantrip/blob/main/docs/NETWORK.md#legacy-feature-relay-compatibility>; rel=\"deprecation\"; type=\"text/markdown\""));
    }
    let metrics = service.operational_metrics.clone();
    let status = response.status().as_u16();
    let head = method == Method::HEAD;
    let complete = move || {
        metrics.finish_http(
            method.as_str(),
            status,
            started.elapsed().as_secs_f64() * 1000.0,
        )
    };
    if head {
        on_response::finished_head(response, complete)
    } else {
        on_response::finished(response, complete)
    }
}
