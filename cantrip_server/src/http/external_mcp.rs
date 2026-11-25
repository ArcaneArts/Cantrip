//! Discovery control endpoints and account management for external MCP.
use super::{json_response, middleware::Context as RequestContext, wire_json_response};
use crate::{
    auth::{
        external_mcp::{IntegrationActor, IntegrationPrincipal, lease_account},
        service::AuthService,
    },
    config::{AuthMode, DeploymentMode},
    projects::{
        repository::ProjectRepository, targets::TargetRepository, workspaces::WorkspaceRepository,
    },
    wire::{Value, value::json},
    workers::repository::WorkerRepository,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path as RoutePath, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_protocol::external_mcp::{
    DiscoveryRequest, DiscoveryTool, HOSTED_CAPABILITIES_PATH, HOSTED_DISCOVERY_PATH,
    IntegrationCreate, IntegrationPermissions, IntegrationRotate, MAX_REQUEST_BYTES, PATH,
    ProjectAccess, WORKER_CONTEXT_TOOL, loopback_authority, orchestration::Tool, proxy_header,
};
use std::{collections::HashSet, sync::Arc};

mod oauth;
mod orchestration;
mod receipts;
mod relay;

pub(super) fn hosted_routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(HOSTED_DISCOVERY_PATH, post(hosted_discovery))
        .route(HOSTED_CAPABILITIES_PATH, get(hosted_capabilities))
        .merge(relay::routes())
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .merge(orchestration::routes())
        .merge(oauth::routes())
}

async fn authenticate(
    service: &AuthService,
    headers: &HeaderMap,
) -> Result<Option<IntegrationPrincipal>> {
    if service.config.auth_mode == AuthMode::None {
        return Ok(None);
    }
    let mut auth = headers.get_all(header::AUTHORIZATION).iter();
    let Some((scheme, credential)) = auth
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
    else {
        return Ok(None);
    };
    if auth.next().is_some() || !scheme.eq_ignore_ascii_case("Bearer") {
        return Ok(None);
    }
    if credential.starts_with("ctmb_") {
        oauth::authenticate_bridge(service, credential).await
    } else {
        service
            .repository
            .authenticate_mcp_integration(credential)
            .await
    }
}

fn credential_required() -> Response {
    let mut response = failure(
        StatusCode::UNAUTHORIZED,
        "A valid MCP integration credential is required.",
    );
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        header::HeaderValue::from_static("Bearer"),
    );
    response
}

async fn hosted_capabilities(
    State(service): State<Arc<AuthService>>,
    headers: HeaderMap,
) -> Response {
    match authenticate(&service, &headers).await {
        Ok(Some(principal)) => {
            let mut tools: Vec<_> = DiscoveryTool::ALL
                .into_iter()
                .filter(|tool| principal.integration.permissions.permits_tool(*tool))
                .map(|tool| serde_json::json!(tool))
                .collect();
            if principal
                .integration
                .permissions
                .permits_tool(DiscoveryTool::PlacementList)
            {
                tools.push(serde_json::json!(WORKER_CONTEXT_TOOL));
            }
            tools.extend(
                Tool::ALL
                    .into_iter()
                    .filter(|tool| {
                        principal
                            .integration
                            .permissions
                            .permits_scope(tool.scope())
                    })
                    .map(|tool| serde_json::json!(tool)),
            );
            integration_response(StatusCode::OK, serde_json::json!({"tools":tools}))
        }
        Ok(None) => credential_required(),
        Err(_) => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "MCP authentication is unavailable.",
        ),
    }
}

async fn hosted_discovery(
    State(service): State<Arc<AuthService>>,
    headers: HeaderMap,
    Json(request): Json<DiscoveryRequest>,
) -> Response {
    match authenticate(&service, &headers).await {
        Ok(Some(principal)) => {
            let permissions = &principal.integration.permissions;
            if !permissions.permits_tool(request.tool) {
                return failure(
                    StatusCode::FORBIDDEN,
                    "The integration does not have this MCP scope.",
                );
            }
            if request
                .arguments
                .project_id
                .as_deref()
                .is_some_and(|id| !permissions.permits_project(id))
            {
                return failure(StatusCode::NOT_FOUND, "Project not found.");
            }
            discovery_response(&service, &principal.owner_id, request, Some(permissions)).await
        }
        Ok(None) => credential_required(),
        Err(_) => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "MCP authentication is unavailable.",
        ),
    }
}

pub(super) fn integration_routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/account/external-mcp-integrations",
            get(list_integrations).post(create_integration),
        )
        .route(
            "/api/account/external-mcp-integrations/{id}",
            delete(revoke_integration),
        )
        .route(
            "/api/account/external-mcp-integrations/{id}/rotate",
            post(rotate_integration),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
}

fn integration_actor(context: &RequestContext) -> Option<IntegrationActor> {
    Some(IntegrationActor {
        owner: context.principal.user.as_ref()?.id.clone(),
        session: context.principal.session_id.clone()?,
        request_id: context.id.clone(),
    })
}

fn integration_response(status: StatusCode, value: impl serde::Serialize) -> Response {
    let mut response = json_response(status, value);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

async fn list_integrations(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<RequestContext>>,
) -> Response {
    let Some(actor) = integration_actor(&context) else {
        return failure(
            StatusCode::UNAUTHORIZED,
            "Sign in to manage MCP integrations.",
        );
    };
    match service.repository.list_mcp_integrations(&actor.owner).await {
        Ok(rows) => integration_response(StatusCode::OK, rows),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not list MCP integrations.",
        ),
    }
}

async fn create_integration(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<RequestContext>>,
    Json(input): Json<IntegrationCreate>,
) -> Response {
    let Some(actor) = integration_actor(&context) else {
        return failure(
            StatusCode::UNAUTHORIZED,
            "Sign in to manage MCP integrations.",
        );
    };
    if let Err(message) = input.validate() {
        return failure(StatusCode::BAD_REQUEST, message);
    }
    if let ProjectAccess::Selected { project_ids } = &input.permissions.projects {
        let count = service
            .repository
            .database
            .query(
                "SELECT count(*)::integer FROM projects WHERE owner_id=$1 AND id=ANY($2)",
                &[&actor.owner, project_ids],
            )
            .await
            .and_then(|rows| rows[0].get::<i32>(0));
        match count {
            Ok(count) if count as usize == project_ids.len() => {}
            Ok(_) => return failure(StatusCode::NOT_FOUND, "A selected project is unavailable."),
            Err(_) => {
                return failure(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not resolve selected projects.",
                );
            }
        }
    }
    match service
        .repository
        .create_mcp_integration(actor, input)
        .await
    {
        Ok(issued) => integration_response(StatusCode::CREATED, issued),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create the MCP integration.",
        ),
    }
}

async fn rotate_integration(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<RequestContext>>,
    RoutePath(id): RoutePath<String>,
    Json(input): Json<IntegrationRotate>,
) -> Response {
    let Some(actor) = integration_actor(&context) else {
        return failure(
            StatusCode::UNAUTHORIZED,
            "Sign in to manage MCP integrations.",
        );
    };
    if let Err(message) = input.validate() {
        return failure(StatusCode::BAD_REQUEST, message);
    }
    match service
        .repository
        .rotate_mcp_integration(actor, &id, input.expires_in_seconds)
        .await
    {
        Ok(Some(issued)) => {
            let account = lease_account(&issued.integration.id, issued.integration.generation - 1);
            if service.worker_links.revoke_account(&account).await.is_err() {
                return failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The credential rotated. Retry rotation to obtain a new credential.",
                );
            }
            integration_response(StatusCode::OK, issued)
        }
        Ok(None) => failure(StatusCode::NOT_FOUND, "MCP integration not found."),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not rotate the MCP integration.",
        ),
    }
}

async fn revoke_integration(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<RequestContext>>,
    RoutePath(id): RoutePath<String>,
) -> Response {
    let Some(actor) = integration_actor(&context) else {
        return failure(
            StatusCode::UNAUTHORIZED,
            "Sign in to manage MCP integrations.",
        );
    };
    match service.repository.revoke_mcp_integration(actor, &id).await {
        Ok(Some(integration)) => {
            if service
                .worker_links
                .revoke_account(&integration.lease_account())
                .await
                .is_err()
            {
                return failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The credential is revoked. Could not close all live routes.",
                );
            }
            integration_response(StatusCode::OK, integration)
        }
        Ok(None) => failure(StatusCode::NOT_FOUND, "MCP integration not found."),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not revoke the MCP integration.",
        ),
    }
}

pub fn router(service: Arc<AuthService>, port: u16) -> Result<Router> {
    ensure!(
        service.config.deployment_mode == DeploymentMode::Local
            && service.config.auth_mode == AuthMode::None,
        "Local external MCP requires a local Cantrip Server with authentication disabled."
    );
    Ok(Router::new()
        .route(PATH, post(handle))
        .merge(relay::local_routes())
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(middleware::from_fn_with_state(port, require_loopback))
        .with_state(service))
}

async fn require_loopback(State(port): State<u16>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let origin = headers
        .get("origin")
        .map(|value| value.to_str().unwrap_or("invalid"));
    if headers.get_all("host").iter().count() != 1
        || headers.get_all("origin").iter().count() > 1
        || headers.keys().any(|name| proxy_header(name.as_str()))
        || !headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|host| loopback_authority(host, origin, port))
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Local MCP requires a direct loopback request.",
        );
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

fn failure(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({"error":message}))).into_response()
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Json(request): Json<DiscoveryRequest>,
) -> Response {
    let owner = service
        .principal(None)
        .await
        .ok()
        .and_then(|principal| principal.user);
    let Some(owner) = owner else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "The local Cantrip owner is unavailable.",
        );
    };
    discovery_response(&service, &owner.id, request, None).await
}

async fn discovery_response(
    service: &AuthService,
    owner: &str,
    request: DiscoveryRequest,
    permissions: Option<&IntegrationPermissions>,
) -> Response {
    if let Err(message) = request.validate() {
        return failure(StatusCode::BAD_REQUEST, message);
    }
    let after = match decode_cursor(&request) {
        Ok(after) => after,
        Err(_) => {
            return failure(
                StatusCode::BAD_REQUEST,
                "Invalid cursor for this discovery request.",
            );
        }
    };
    let result = async {
        let Some((rows, source_truncated)) =
            discovery(service, owner, &request, permissions).await?
        else {
            return Ok(None);
        };
        Ok::<_, anyhow::Error>(Some(page(
            &request,
            rows,
            source_truncated,
            after.as_deref(),
        )))
    }
    .await;
    match result {
        Ok(Some(page)) => {
            let mut response = wire_json_response(StatusCode::OK, &page);
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-store"),
            );
            response
        }
        Ok(None) => failure(StatusCode::NOT_FOUND, "Project not found."),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not read Cantrip discovery data.",
        ),
    }
}

fn select(row: &Value, fields: &[&str]) -> Value {
    Value::object(fields.iter().map(|key| (*key, row[*key].clone())))
}

async fn discovery(
    service: &AuthService,
    owner: &str,
    request: &DiscoveryRequest,
    permissions: Option<&IntegrationPermissions>,
) -> Result<Option<(Vec<Value>, bool)>> {
    let database = &service.repository.database;
    let project_id = request.arguments.project_id.as_deref().unwrap_or_default();
    let project_allowed = |id: &Value| {
        permissions.is_none_or(|permissions| {
            id.as_str()
                .is_some_and(|id| permissions.permits_project(id))
        })
    };
    if request.tool.project_scoped()
        && ProjectRepository::new(database.clone())?
            .get(owner, project_id)
            .await?
            .is_none()
    {
        return Ok(None);
    }
    let rows = match request.tool {
        DiscoveryTool::WorkspaceList => {
            let catalog = WorkspaceRepository::new(database.clone())
                .list(owner)
                .await?;
            catalog["workspaces"]
                .as_array()
                .context("Workspace list")?
                .iter()
                .filter_map(|row| {
                    let project_count = row["projectIds"]
                        .as_array()?
                        .iter()
                        .filter(|id| project_allowed(id))
                        .count();
                    if permissions.is_some_and(|permissions| {
                        matches!(permissions.projects, ProjectAccess::Selected { .. })
                    }) && project_count == 0
                    {
                        return None;
                    }
                    let name =
                        (row["nameProtection"]["state"] == "system-default").then_some("Default");
                    Some(json!({
                        "id": row["id"],
                        "name": name,
                        "labelProtected": row["nameProtection"]["state"] == "encrypted",
                        "storageKind": row["storage"]["kind"],
                        "workerId": row["storage"]["workerId"],
                        "projectCount": project_count,
                    }))
                })
                .collect()
        }
        DiscoveryTool::ProjectList => {
            let projects = ProjectRepository::new(database.clone())?
                .list(owner)
                .await?;
            projects
                .iter()
                .filter(|row| project_allowed(&row["id"]))
                .map(|row| {
                    let mut result = select(
                        row,
                        &[
                            "id",
                            "originKind",
                            "preferredWorkerId",
                            "setupStatus",
                            "capabilities",
                        ],
                    );
                    result["repository"] = row["github"]["nameWithOwner"].clone();
                    result["sourceWorkerId"] = row["source"]["workerId"].clone();
                    result["labelProtected"] = json!(!row["nameProtection"].is_null());
                    result
                })
                .collect()
        }
        DiscoveryTool::ChatList | DiscoveryTool::AgentList => {
            let chats = crate::chats::Repository::new(database.clone())
                .list_project(owner, project_id)
                .await?;
            chats
                .iter()
                .filter(|row| {
                    request.tool == DiscoveryTool::ChatList || row["experience"] == "agent"
                })
                .map(|row| {
                    let mut result = select(
                        row,
                        &[
                            "id",
                            "projectId",
                            "experience",
                            "status",
                            "activeWorkerId",
                            "activeWorktreeId",
                            "modelId",
                            "automationPaused",
                            "planMode",
                        ],
                    );
                    result["labelProtected"] = json!(!row["titleProtection"].is_null());
                    result
                })
                .collect()
        }
        DiscoveryTool::TaskList => {
            let tasks = crate::tasks::Repository::new(database.clone())
                .list(owner, project_id)
                .await?;
            tasks
                .iter()
                .map(|row| {
                    json!({
                        "id": row["chatId"],
                        "projectId": project_id,
                        "state": row["state"],
                        "dispatchState": row["dispatch"]["state"],
                        "eligibilityCode": row["dispatch"]["eligibilityCode"],
                        "automaticRetryStatus": row["automaticRetry"]["status"],
                        "updatedAt": row["updatedAt"],
                    })
                })
                .collect()
        }
        DiscoveryTool::WorkerList => {
            let permitted_workers = visible_worker_ids(service, owner, permissions, None).await?;
            let workers = WorkerRepository::new(database.clone())
                .list_workers(owner)
                .await?;
            workers
                .into_iter()
                .filter(|row| {
                    permitted_workers.as_ref().is_none_or(|worker_ids| {
                        row["workerId"]
                            .as_str()
                            .is_some_and(|id| worker_ids.contains(id))
                    })
                })
                .map(|row| {
                    let row = Value::from_serialize(&row);
                    let mut result = select(
                        &row,
                        &[
                            "name",
                            "platform",
                            "architecture",
                            "codexVersion",
                            "lastSeenAt",
                        ],
                    );
                    result["id"] = row["workerId"].clone();
                    let online = row["online"] == true
                        && row["workerId"]
                            .as_str()
                            .is_some_and(|id| service.workers.bridge.is_connected(id));
                    result["online"] = json!(online);
                    result["unavailableReason"] = json!((!online).then_some("Worker is offline."));
                    result
                })
                .collect()
        }
        DiscoveryTool::PlacementList => {
            let permitted_workers =
                visible_worker_ids(service, owner, permissions, Some(project_id)).await?;
            let connected = |worker: &str| service.workers.bridge.is_connected(worker);
            let Some(catalog) = TargetRepository::new(database.clone())
                .catalog(owner, project_id, Some(&connected))
                .await?
            else {
                return Ok(None);
            };
            let placements = catalog["targets"]
                .as_array()
                .context("Placement targets")?
                .iter()
                .filter(|row| {
                    permitted_workers.as_ref().is_none_or(|worker_ids| {
                        row["placement"]["workerId"]
                            .as_str()
                            .is_some_and(|id| worker_ids.contains(id))
                    })
                })
                .filter_map(|row| {
                    let kind = row["resourceKind"].as_str()?;
                    let key = match kind {
                        "worker" => "workerId",
                        "replica" => "projectReplicaId",
                        "worktree" => "worktreeId",
                        _ => return None,
                    };
                    let id = row["target"][key].as_str()?;
                    let mut result = select(
                        row,
                        &[
                            "target",
                            "placement",
                            "availability",
                            "unavailableReason",
                            "status",
                        ],
                    );
                    result["id"] = json!(format!("{kind}:{id}"));
                    Some(result)
                })
                .collect();
            return Ok(Some((placements, catalog["truncated"] == true)));
        }
    };
    Ok(Some((rows, false)))
}

async fn visible_worker_ids(
    service: &AuthService,
    owner: &str,
    permissions: Option<&IntegrationPermissions>,
    selected_project: Option<&str>,
) -> Result<Option<HashSet<String>>> {
    let Some(ProjectAccess::Selected { project_ids }) =
        permissions.map(|permissions| &permissions.projects)
    else {
        return Ok(None);
    };
    let projects = ProjectRepository::new(service.repository.database.clone())?
        .list(owner)
        .await?;
    let mut workers = HashSet::new();
    for project in &projects {
        if !project["id"].as_str().is_some_and(|id| {
            selected_project.is_none_or(|selected| selected == id)
                && project_ids.iter().any(|allowed| allowed == id)
        }) {
            continue;
        }
        workers.extend(
            [
                &project["preferredWorkerId"],
                &project["source"]["workerId"],
            ]
            .into_iter()
            .chain(
                project["replicas"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|replica| &replica["workerId"]),
            )
            .filter_map(|id| id.as_str().map(str::to_owned)),
        );
    }
    Ok(Some(workers))
}

fn decode_cursor(request: &DiscoveryRequest) -> Result<Option<String>> {
    let Some(cursor) = &request.arguments.cursor else {
        return Ok(None);
    };
    let (tool, project, last): (DiscoveryTool, Option<String>, String) =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(cursor)?)?;
    ensure!(
        tool == request.tool && project == request.arguments.project_id && !last.is_empty(),
        "Cursor is for another discovery request."
    );
    Ok(Some(last))
}

fn page(
    request: &DiscoveryRequest,
    mut rows: Vec<Value>,
    source_truncated: bool,
    after: Option<&str>,
) -> Value {
    rows.sort_unstable_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    if let Some(after) = after {
        rows.retain(|row| row["id"].as_str().is_some_and(|id| id > after));
    }
    let limit = usize::from(request.arguments.limit);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next = has_more.then(|| {
        let last = rows.last().expect("nonempty page")["id"]
            .as_str()
            .expect("discovery row ID");
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&(request.tool, &request.arguments.project_id, last))
                .expect("discovery cursor"),
        )
    });
    json!({
        "summary":format!("Returned {} {} entries.",rows.len(),request.tool.name()),
        "entries":rows,"nextCursor":next,"sourceTruncated":source_truncated,
    })
}
