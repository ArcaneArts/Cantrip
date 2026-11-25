//! Server authority for external MCP grants. The relay carries opaque records.
use super::{authenticate, credential_required, failure, integration_response};
use crate::{
    auth::{external_mcp::IntegrationPrincipal, service::AuthService},
    encryption::repository::EncryptionRepository,
    http::{
        middleware::Context as RequestContext,
        worker_link_socket::{RelayClient, upgrade_relay},
    },
    projects::placement::{PlacementRepository, Unavailable},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use axum::{
    Extension, Json, Router,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cantrip_protocol::external_mcp::{DiscoveryTool, HOSTED_RELAY_PATH, WorkerContextInput};
use std::sync::Arc;
use uuid::Uuid;

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(HOSTED_RELAY_PATH, post(open)).route(
        &format!("{HOSTED_RELAY_PATH}/{{session}}"),
        get(connect).delete(release),
    )
}

async fn open(
    State(service): State<Arc<AuthService>>,
    headers: HeaderMap,
    Json(input): Json<WorkerContextInput>,
) -> Response {
    let principal = match authenticate(&service, &headers).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return credential_required(),
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "MCP authentication is unavailable.",
            );
        }
    };
    if let Err(message) = input.validate() {
        return failure(StatusCode::BAD_REQUEST, message);
    }
    let permissions = &principal.integration.permissions;
    if !permissions.permits_tool(DiscoveryTool::PlacementList) {
        return failure(
            StatusCode::FORBIDDEN,
            "The integration does not have the placements-read scope.",
        );
    }
    if !permissions.permits_project(&input.project_id) {
        return failure(StatusCode::NOT_FOUND, "Project not found.");
    }
    match authorize_placement(&service, &principal, &input.project_id).await {
        Ok(grant) => integration_response(StatusCode::CREATED, grant),
        Err(cause) => {
            if let Some(error) = cause.downcast_ref::<Unavailable>() {
                failure(
                    if error.code == "project-not-found" {
                        StatusCode::NOT_FOUND
                    } else {
                        StatusCode::CONFLICT
                    },
                    &error.message,
                )
            } else {
                failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Could not open an encrypted WorkerLink channel. Check the assigned worker and approve its encryption identity.",
                )
            }
        }
    }
}

async fn authorize_placement(
    service: &AuthService,
    principal: &IntegrationPrincipal,
    project: &str,
) -> Result<Value> {
    let owner = &principal.owner_id;
    let database = &service.repository.database;
    let placements = PlacementRepository::new(database.clone())?;
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    let selection = placements
        .resolve(owner, project, "explorer", None, Some(&connected), false)
        .await?;
    let placement = &selection["placement"];
    let worker = placement["workerId"].as_str().context("Worker placement")?;
    let encryption = EncryptionRepository::new(database.clone());
    let recipient = encryption
        .find_worker_principal(owner, worker, None)
        .await?
        .filter(|principal| principal["state"] == "approved")
        .context("Worker encryption has not been approved")?;
    let authority = &service.worker_links.authority;
    let session = authority
        .open_session(json!({
            "ownerId":owner,"accountSessionId":principal.integration.lease_account(),
            "clientInstanceId":Uuid::new_v4().to_string(),"workerId":worker,
        }))
        .await?;
    let session_id = session["sessionId"]
        .as_str()
        .context("WorkerLink session ID")?;
    let issued = async {
        let grant = authority.issue_grant(json!({
            "sessionId":session_id,"resourceKind":"external-mcp","resourceId":project,
            "attachmentId":placement["worktreeId"],
            "externalMcp":json!({"workerPrincipalId":recipient["id"]}),
            "lanes":vec!["stream"],"operations":vec!["stream:open","stream:read","stream:write"],
            "maxChannels":1,"absoluteExpiresAt":principal.integration.expires_at.to_rfc3339(),
        })).await?;
        anyhow::ensure!(
            service
                .repository
                .mcp_integration_current(principal)
                .await?,
            "MCP integration changed while opening"
        );
        let current = placements
            .resolve(owner, project, "explorer", None, Some(&connected), false)
            .await?;
        anyhow::ensure!(
            current["placement"] == *placement,
            "Project placement changed while opening"
        );
        let current_key = encryption
            .find_worker_principal(owner, worker, recipient["id"].as_str())
            .await?;
        anyhow::ensure!(
            current_key
                .as_ref()
                .is_some_and(|current| current["state"] == "approved"
                    && current["revision"] == recipient["revision"]),
            "Worker encryption changed while opening"
        );
        Ok(json!({"session":session,"grant":grant,"workerPublicKey":recipient["publicKey"]}))
    }
    .await;
    if issued.is_err() {
        let _ = service
            .worker_links
            .revoke_session(session_id, "released")
            .await;
    }
    issued
}

async fn session(
    service: &AuthService,
    principal: &IntegrationPrincipal,
    session_id: &str,
) -> Result<Option<Value>> {
    if !service
        .repository
        .mcp_integration_current(principal)
        .await?
    {
        return Ok(None);
    }
    Ok(service
        .worker_links
        .authority
        .session_for_authorization(
            session_id,
            json!(principal.owner_id),
            json!(principal.integration.lease_account()),
        )
        .await?)
}

async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<RequestContext>>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    let principal = match authenticate(&service, request.headers()).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return credential_required(),
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "MCP authentication is unavailable.",
            );
        }
    };
    let current = match session(&service, &principal, &session_id).await {
        Ok(Some(current)) => current,
        Ok(None) => return failure(StatusCode::NOT_FOUND, "WorkerLink session is unavailable."),
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "WorkerLink authorization is unavailable.",
            );
        }
    };
    let session_expiry = chrono::DateTime::parse_from_rfc3339(
        current["lease"]["expiresAt"].as_str().unwrap_or_default(),
    )
    .ok()
    .map(|date| date.with_timezone(&chrono::Utc));
    let deadline = session_expiry.map_or(principal.integration.expires_at, |expiry| {
        expiry.min(principal.integration.expires_at)
    });
    let client = RelayClient {
        owner: principal.owner_id.clone(),
        account: Some(principal.integration.lease_account()),
        request_id: context.id.clone(),
        expires_at: Some(
            tokio::time::Instant::now()
                + (deadline - chrono::Utc::now()).to_std().unwrap_or_default(),
        ),
    };
    let auth_service = service.clone();
    upgrade_relay(request, service, client, async move {
        session(&auth_service, &principal, &session_id).await
    })
}

async fn release(
    State(service): State<Arc<AuthService>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let principal = match authenticate(&service, &headers).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return credential_required(),
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "MCP authentication is unavailable.",
            );
        }
    };
    match session(&service, &principal, &session_id).await {
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Ok(Some(_))
            if service
                .worker_links
                .revoke_session(&session_id, "released")
                .await
                .is_ok() =>
        {
            StatusCode::NO_CONTENT.into_response()
        }
        _ => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Could not close the WorkerLink session.",
        ),
    }
}
