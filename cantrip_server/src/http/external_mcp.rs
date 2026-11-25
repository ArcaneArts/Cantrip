//! Dedicated loopback control endpoint for external MCP discovery.
use super::wire_json_response;
use crate::{
    auth::service::AuthService,
    config::{AuthMode, DeploymentMode},
    projects::{
        repository::ProjectRepository, targets::TargetRepository, workspaces::WorkspaceRepository,
    },
    wire::{Value, value::json},
    workers::repository::WorkerRepository,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_protocol::external_mcp::{
    DiscoveryRequest, DiscoveryTool, MAX_REQUEST_BYTES, PATH, loopback_authority, proxy_header,
};
use std::sync::Arc;

pub fn router(service: Arc<AuthService>, port: u16) -> Result<Router> {
    ensure!(
        service.config.deployment_mode == DeploymentMode::Local
            && service.config.auth_mode == AuthMode::None,
        "Local external MCP requires a local Cantrip Server with authentication disabled."
    );
    Ok(Router::new()
        .route(PATH, post(handle))
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
        let owner = service
            .principal(None)
            .await?
            .user
            .context("Local Cantrip owner")?;
        let Some((rows, source_truncated)) = discovery(&service, &owner.id, &request).await? else {
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
        Ok(Some(page)) => wire_json_response(StatusCode::OK, &page),
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
) -> Result<Option<(Vec<Value>, bool)>> {
    let database = &service.repository.database;
    let project_id = request.arguments.project_id.as_deref().unwrap_or_default();
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
                .map(|row| {
                    let name =
                        (row["nameProtection"]["state"] == "system-default").then_some("Default");
                    json!({
                        "id": row["id"],
                        "name": name,
                        "labelProtected": row["nameProtection"]["state"] == "encrypted",
                        "storageKind": row["storage"]["kind"],
                        "workerId": row["storage"]["workerId"],
                        "projectCount": row["projectIds"].as_array().map_or(0, Vec::len),
                    })
                })
                .collect()
        }
        DiscoveryTool::ProjectList => {
            let projects = ProjectRepository::new(database.clone())?
                .list(owner)
                .await?;
            projects
                .iter()
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
            let workers = WorkerRepository::new(database.clone())
                .list_workers(owner)
                .await?;
            workers
                .into_iter()
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
