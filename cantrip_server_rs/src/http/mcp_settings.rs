//! Global/project encrypted MCP settings and worker-owned discovery.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    operations::shared_failure::downcast_ref,
    projects::repository::ProjectRepository,
    settings::{self, repository::SettingsRepository},
    wire::{Value, value::json},
    workers::command_bus::{CommandFailure, RequestTimeout},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use std::{collections::HashMap, sync::Arc, time::Duration};

fn worker_failure(cause: &anyhow::Error) -> Response {
    let status = match downcast_ref::<CommandFailure>(cause) {
        Some(CommandFailure::Limit(_)) => 429,
        Some(CommandFailure::Bridge(error)) if error.unavailable => 503,
        _ => 502,
    };
    error(status, settings::operation_error_message(cause))
}
async fn discovery(
    service: &AuthService,
    owner: &str,
    project: Option<&str>,
    worker: &str,
) -> Result<Response> {
    let projects = ProjectRepository::new(service.repository.database.clone())?;
    if let Some(project) = project
        && projects.get(owner, project).await?.is_none()
    {
        return Ok(error(404, "Project not found."));
    }
    let Some(selected) = service.workers.repository.get_worker(owner, worker).await? else {
        return Ok(error(404, "Worker not found."));
    };
    let root = if let Some(project) = project {
        let replicas = projects.replicas(owner, project).await?.unwrap_or_default();
        let Some(replica) = replicas
            .into_iter()
            .find(|r| r["workerId"] == worker && r["ready"] == true)
        else {
            return Ok(error(
                409,
                "This project does not have a ready replica on that worker.",
            ));
        };
        replica["path"].clone()
    } else {
        Value::Null
    };
    if selected["online"] != true || !service.workers.commands.is_connected(worker) {
        return Ok(error(503, "Worker is offline."));
    }
    let attempt: Result<Response> = async {
        let result = service
            .workers
            .commands
            .request_with_timeout(
                worker,
                json!({"type":"mcp.configurations.discover","projectRoot":root}),
                RequestTimeout::After(Duration::from_secs(20)),
                None,
            )
            .await?;
        let parsed = settings::parse_response("mcpServerDiscoveryResultSchema", result.as_ref())?;
        output(200, "mcpServerDiscoveryResultSchema", &parsed)
    }
    .await;
    Ok(match attempt {
        Ok(r) => r,
        Err(cause) => worker_failure(&cause),
    })
}
async fn execute(
    service: &AuthService,
    owner: &str,
    params: &HashMap<String, String>,
    method: &Method,
    input: Option<&Value>,
) -> Result<Response> {
    let project = params.get("projectId").map(String::as_str);
    if let Some(worker) = params.get("workerId") {
        return discovery(service, owner, project, worker).await;
    }
    let repository = SettingsRepository::new(service.repository.database.clone());
    if method == Method::GET || method == Method::HEAD {
        let servers = repository.list_mcp_servers(owner, project).await?;
        return if let Some(servers) = servers {
            output(200, "mcpServerWireListSchema", &servers)
        } else {
            Ok(error(404, "Project not found."))
        };
    }
    let parsed = if method == Method::POST || method == Method::PUT {
        match parse(
            if method == Method::POST {
                "encryptedMcpServerCreateSchema"
            } else {
                "encryptedMcpServerUpdateSchema"
            },
            input,
        )? {
            Ok(v) => Some(v),
            Err(r) => return Ok(r),
        }
    } else {
        None
    };
    let attempt: Result<Response> = async {
        if method == Method::POST {
            return match repository
                .create_mcp_server(owner, project, parsed.as_ref().unwrap())
                .await?
            {
                Some(server) => output(201, "mcpServerWireSummarySchema", &server),
                None => Ok(error(404, "Project not found.")),
            };
        }
        let id = &params["serverId"];
        if method == Method::PUT {
            return match repository
                .update_mcp_server(owner, project, id, parsed.as_ref().unwrap())
                .await?
            {
                Some(server) => output(200, "mcpServerWireSummarySchema", &server),
                None => Ok(error(404, "MCP server not found.")),
            };
        }
        Ok(if repository.delete_mcp_server(owner, project, id).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            error(404, "MCP server not found.")
        })
    }
    .await;
    Ok(match attempt {
        Ok(r) => r,
        Err(cause) => error(409, settings::operation_error_message(&cause)),
    })
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let input = if method != Method::GET && method != Method::HEAD {
        let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary).await {
            Ok(v) => v,
            Err(r) => return r,
        }
    } else {
        None
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let work = {
        let service = service.clone();
        async move { execute(&service, &owner, &params, &method, input.as_ref()).await }
    };
    match service.scratch_roots.owned(work).await {
        Ok(r) => r,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/settings/mcp-servers", get(handle).post(handle))
        .route(
            "/api/settings/mcp-servers/{serverId}",
            put(handle).delete(handle),
        )
        .route("/api/settings/mcp-discovery/{workerId}", get(handle))
        .route(
            "/api/projects/{projectId}/mcp-servers",
            get(handle).post(handle),
        )
        .route(
            "/api/projects/{projectId}/mcp-servers/{serverId}",
            put(handle).delete(handle),
        )
        .route(
            "/api/projects/{projectId}/mcp-discovery/{workerId}",
            get(handle),
        )
}
