use std::{sync::Arc, time::Instant};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{SecondsFormat, Utc};
use serde_json::json;

use crate::auth::service::AuthService;
mod account;
mod agent_alerts;
mod agent_chat_send;
mod agent_chats;
mod agent_interactions;
mod agent_metadata;
mod agent_operations;
mod agent_runs;
mod agent_surfaces;
mod agent_targets;
mod agent_tasks;
mod agent_worktrees;
mod audit;
mod body;
mod browser_discovery;
mod browsers;
mod cantrip_os;
mod cantrip_os_backups;
mod cantrip_os_desktop;
mod cantrip_os_packages;
mod cantrip_os_power;
mod cantrip_os_systems;
mod cantrip_os_workspace_operations;
mod chat_attachments;
mod chat_catalogs;
mod chat_configuration;
mod chat_console;
mod chat_control;
mod chat_customizations;
mod chat_execution;
mod chat_forks;
mod chat_goals;
mod chat_imports;
mod chat_lifecycle;
mod chat_messages;
mod chat_plan;
mod chat_preparation;
mod chat_relocations;
mod chat_sync;
mod cli;
mod cli_commands;
mod cli_runs;
mod computer_use;
mod computer_use_agent;
mod conversations;
mod direct_attachments;
mod encryption;
mod external_chat_history;
mod file_documents;
mod folders;
mod github_conversion;
mod github_import;
mod live_socket;
mod mcp_settings;
mod middleware;
mod model_operations;
mod native_admission;
mod native_coordination;
mod native_events;
mod native_handoffs;
mod native_history;
mod native_model_inventory;
mod native_queue;
mod native_settings;
mod on_response;
mod operational_status;
pub mod request_logs;
mod request_target;
mod route_table;
pub use operational_status::observe as observe_operations;
mod pane_layouts;
mod policies;
mod project_administration;
mod project_alerts;
mod project_automations;
mod project_exports;
mod project_goal_observations;
mod project_insights;
mod project_shares;
mod project_surfaces;
mod project_workspaces;
mod projects;
mod provider_accounts;
mod provider_catalogs;
mod provider_credentials;
mod provider_management;
mod provider_quota;
mod provider_telemetry;
mod remote_desktop_fleet;
mod remote_desktops;
mod remote_surface_socket;
mod remote_surfaces;
mod removed_repository;
mod replicas;
mod repository_operations;
mod run_configurations;
mod run_definitions;
mod run_secrets;
mod sessions;
mod settings;
mod settings_operations;
mod skill_settings;
mod task_controls;
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
mod worker_log_socket;
mod worker_logs;
mod worker_maintenance;
mod worker_management;
mod worker_operations;
mod worker_socket;
mod workers;
mod workspace_layouts;
mod worktrees;

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
    let database_ready = database.ping().await.is_ok();
    let coordination_ready = match &service.coordination {
        Some(coordinator) if database_ready => coordinator.health().await.unwrap_or(false),
        Some(_) => false,
        None => true,
    };
    let success = database_ready && coordination_ready;
    let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
    service
        .operational_metrics
        .database_probe(database_ready, latency_ms);
    json_response(
        if success {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        json!({
            "status": if success { "ready" } else { "not-ready" },
            "service":"cantrip_server",
            "database": {"engine":database.engine(), "status":if database_ready { "ready" } else { "unavailable" }, "latencyMs":latency_ms},
            "coordination": {"shared":service.coordination.is_some(), "status":if coordination_ready { "ready" } else { "unavailable" }},
            "timestamp":timestamp()
        }),
    )
}

async fn not_found(State(service): State<Arc<AuthService>>, request: Request) -> Response {
    let method = request.method().clone();
    let uri = request
        .extensions()
        .get::<axum::extract::OriginalUri>()
        .map_or_else(|| request.uri().clone(), |original| original.0.clone());
    // Fastify applies its registered payload parser before the 404 handler,
    // including an unsupported method at an otherwise registered path.
    if matches!(
        method.as_str(),
        "DELETE" | "OPTIONS" | "PATCH" | "PUT" | "POST" | "QUERY"
    ) {
        let binary_limit = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        if let Err(response) =
            body::parse_fallback(request, service.config.api_body_limit_bytes, binary_limit).await
        {
            return response;
        }
    }
    fallback_response(&method, &uri)
}
fn fallback_response(method: &axum::http::Method, uri: &axum::http::Uri) -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        json!({
            "message":format!("Route {method}:{uri} not found"), "error":"Not Found", "statusCode":404
        }),
    )
}

/// Foundation and session routes. Remaining domains are tracked in the ledger.
pub fn router(service: Arc<AuthService>) -> Router {
    let inner = Router::new()
        .route("/api", get(api))
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .merge(operational_status::routes())
        .merge(worker_logs::routes())
        .merge(sessions::routes())
        .merge(project_alerts::routes())
        .merge(project_automations::routes())
        .merge(project_goal_observations::routes())
        .merge(agent_alerts::routes())
        .merge(agent_interactions::routes())
        .merge(worker_links::routes())
        .merge(worker_link_sessions::routes())
        .merge(direct_attachments::routes())
        .merge(worker_link_socket::routes())
        .merge(encryption::routes())
        .merge(account::routes())
        .merge(usage::routes())
        .merge(policies::routes())
        .merge(projects::routes())
        .merge(project_administration::routes())
        .merge(project_insights::routes())
        .merge(remote_surfaces::routes())
        .merge(remote_desktops::routes())
        .merge(remote_desktop_fleet::routes())
        .merge(removed_repository::routes())
        .merge(folders::routes())
        .merge(chat_catalogs::routes())
        .merge(chat_attachments::routes())
        .merge(chat_configuration::routes())
        .merge(chat_control::routes())
        .merge(chat_customizations::routes())
        .merge(conversations::routes())
        .merge(chat_execution::routes())
        .merge(task_controls::routes())
        .merge(chat_console::routes())
        .merge(chat_goals::routes())
        .merge(chat_plan::routes())
        .merge(chat_lifecycle::routes())
        .merge(chat_forks::routes())
        .merge(chat_relocations::routes())
        .merge(chat_imports::routes())
        .merge(project_exports::routes())
        .merge(external_chat_history::routes())
        .merge(chat_messages::routes())
        .merge(chat_preparation::routes())
        .merge(chat_sync::routes())
        .merge(native_settings::routes())
        .merge(native_handoffs::routes())
        .merge(native_events::routes())
        .merge(native_admission::routes())
        .merge(computer_use_agent::routes())
        .merge(computer_use::routes())
        .merge(native_history::routes())
        .merge(native_model_inventory::routes())
        .merge(native_coordination::routes())
        .merge(native_queue::routes())
        .merge(github_import::routes())
        .merge(github_conversion::routes())
        .merge(project_workspaces::routes())
        .merge(replicas::routes())
        .merge(file_documents::routes())
        .merge(pane_layouts::routes())
        .merge(project_surfaces::routes())
        .merge(workspace_layouts::routes())
        .merge(repository_operations::routes())
        .merge(worktrees::routes())
        .merge(cantrip_os::routes())
        .merge(run_configurations::routes())
        .merge(run_definitions::routes())
        .merge(run_secrets::routes())
        .merge(settings::routes())
        .merge(settings_operations::routes())
        .merge(skill_settings::routes())
        .merge(model_operations::routes())
        .merge(mcp_settings::routes())
        .merge(cli::routes())
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
        .merge(worker_management::routes())
        .merge(worker_maintenance::routes())
        .merge(worker_operations::routes())
        .merge(worker_socket::routes())
        .merge(live_socket::routes())
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(axum::middleware::from_fn_with_state(
            service.clone(),
            middleware::guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            service.clone(),
            operational_status::observe,
        ))
        .layer(axum::middleware::from_fn(request_logs::observe))
        .with_state(service);
    request_target::wrap(inner)
}
