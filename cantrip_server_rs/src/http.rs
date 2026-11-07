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
mod pane_layouts;
mod policies;
mod project_alerts;
mod project_automations;
mod project_exports;
mod project_goal_observations;
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
    let database_ready = database.query("SELECT 1", &[]).await.is_ok();
    let coordination_ready = match &service.coordination {
        Some(coordinator) if database_ready => coordinator.health().await.unwrap_or(false),
        Some(_) => false,
        None => true,
    };
    let success = database_ready && coordination_ready;
    json_response(
        if success {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        json!({
            "status": if success { "ready" } else { "not-ready" },
            "service":"cantrip_server",
            "database": {"engine":database.engine(), "status":if database_ready { "ready" } else { "unavailable" }, "latencyMs":started.elapsed().as_secs_f64()*1000.0},
            "coordination": {"shared":service.coordination.is_some(), "status":if coordination_ready { "ready" } else { "unavailable" }},
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
        .merge(removed_repository::routes())
        .merge(folders::routes())
        .merge(chat_catalogs::routes())
        .merge(chat_attachments::routes())
        .merge(chat_configuration::routes())
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
        .with_state(service)
}
