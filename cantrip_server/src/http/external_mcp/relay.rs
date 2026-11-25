//! Server authority for external MCP grants. The relay carries opaque records.
use super::{authenticate, credential_required, failure, integration_response};
use crate::{
    auth::{LOCAL_USER_ID, external_mcp::IntegrationPrincipal, service::AuthService},
    encryption::repository::EncryptionRepository,
    http::{
        middleware::Context as RequestContext,
        worker_link_socket::{RelayClient, upgrade_relay},
    },
    projects::{
        placement::{PlacementRepository, Unavailable},
        targets::TargetRepository,
    },
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
use cantrip_protocol::external_mcp::{
    HOSTED_RELAY_PATH, LOCAL_LEASE_ACCOUNT, LOCAL_RELAY_PATH, RELAY_READY,
    orchestration::{Selector, Tool},
};
use std::sync::Arc;
use uuid::Uuid;

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(HOSTED_RELAY_PATH, post(open)).route(
        &format!("{HOSTED_RELAY_PATH}/{{session}}"),
        get(connect).delete(release),
    )
}

pub(super) fn local_routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(LOCAL_RELAY_PATH, post(open_local))
        .route(
            &format!("{LOCAL_RELAY_PATH}/{{session}}"),
            get(connect_local).delete(release_local),
        )
}

enum Principal {
    Loopback,
    Integration(IntegrationPrincipal),
}

impl Principal {
    fn owner(&self) -> &str {
        match self {
            Self::Loopback => LOCAL_USER_ID,
            Self::Integration(principal) => &principal.owner_id,
        }
    }
    fn lease_account(&self) -> String {
        match self {
            Self::Loopback => LOCAL_LEASE_ACCOUNT.to_owned(),
            Self::Integration(principal) => principal.integration.lease_account(),
        }
    }
    fn expires_at(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        match self {
            Self::Loopback => None,
            Self::Integration(principal) => Some(principal.integration.expires_at),
        }
    }
    async fn current(&self, service: &AuthService) -> Result<bool> {
        match self {
            Self::Loopback => Ok(true),
            Self::Integration(principal) => {
                service.repository.mcp_integration_current(principal).await
            }
        }
    }
}

async fn authenticate_hosted(
    service: &AuthService,
    headers: &HeaderMap,
) -> Result<Principal, Response> {
    match authenticate(service, headers).await {
        Ok(Some(principal)) => Ok(Principal::Integration(principal)),
        Ok(None) => Err(credential_required()),
        Err(_) => Err(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "MCP authentication is unavailable.",
        )),
    }
}

async fn open(
    State(service): State<Arc<AuthService>>,
    headers: HeaderMap,
    Json(input): Json<Selector>,
) -> Response {
    let principal = match authenticate_hosted(&service, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    open_for(&service, principal, input).await
}

async fn open_local(
    State(service): State<Arc<AuthService>>,
    Json(input): Json<Selector>,
) -> Response {
    open_for(&service, Principal::Loopback, input).await
}

async fn open_for(service: &AuthService, principal: Principal, input: Selector) -> Response {
    if !input.is_valid() {
        return failure(
            StatusCode::BAD_REQUEST,
            "Choose a valid project, chat, or worktree for this MCP tool.",
        );
    }
    if let Principal::Integration(integration) = &principal {
        let permissions = &integration.integration.permissions;
        if !permissions.permits_scope(input.scope()) {
            return failure(
                StatusCode::FORBIDDEN,
                "The integration does not have the scope required by this tool.",
            );
        }
        if !permissions.permits_project(&input.project_id.to_string()) {
            return failure(StatusCode::NOT_FOUND, "Project not found.");
        }
    }
    match authorize_placement(service, &principal, &input).await {
        Ok(grant) => integration_response(StatusCode::CREATED, grant),
        Err(cause) => {
            if let Some(error) = cause.downcast_ref::<Unavailable>() {
                failure(
                    if matches!(error.code, "project-not-found" | "target-not-found") {
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

pub(super) async fn resolve_placement(
    service: &AuthService,
    owner: &str,
    input: &Selector,
) -> Result<Value> {
    let project = input.project_id.to_string();
    let database = &service.repository.database;
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    let selected = if let Some(chat) = input.chat_id {
        let id = chat.to_string();
        let experience = if input.tool == Some(Tool::TaskStart) {
            "task"
        } else {
            "agent"
        };
        let chat = crate::chats::Repository::new(database.clone())
            .live_routing(owner, &id)
            .await?;
        if !chat
            .is_some_and(|chat| chat["projectId"] == project && chat["experience"] == experience)
        {
            return Err(Unavailable {
                code: "target-not-found",
                message: "Chat not found in the project.".to_owned(),
            }
            .into());
        }
        let target =
            json!({"kind":"surface","projectId":project,"surfaceKind":"chat","surfaceId":id});
        TargetRepository::new(database.clone())
            .resolve(owner, &project, &target, Some(&connected), false)
            .await?
    } else if let Some(worktree) = &input.worktree_id {
        let target = json!({"kind":"worktree","projectId":project,"worktreeId":worktree});
        TargetRepository::new(database.clone())
            .resolve(owner, &project, &target, Some(&connected), false)
            .await?
    } else {
        let surface = if input.tool.is_some_and(|tool| !tool.uses_checkout()) {
            "chat"
        } else {
            "explorer"
        };
        PlacementRepository::new(database.clone())?
            .resolve(owner, &project, surface, None, Some(&connected), false)
            .await?
    };
    Ok(selected["placement"].clone())
}

async fn authorize_placement(
    service: &AuthService,
    principal: &Principal,
    input: &Selector,
) -> Result<Value> {
    let owner = principal.owner();
    let project = input.project_id.to_string();
    let database = &service.repository.database;
    let placement = resolve_placement(service, owner, input).await?;
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
            "ownerId":owner,"accountSessionId":principal.lease_account(),
            "clientInstanceId":Uuid::new_v4().to_string(),"workerId":worker,
        }))
        .await?;
    let session_id = session["sessionId"]
        .as_str()
        .context("WorkerLink session ID")?;
    let issued = async {
        let mut mcp = json!({"workerPrincipalId":recipient["id"]});
        if let Some(tool) = input.tool {
            mcp["tool"] = json!(tool);
        }
        if let Some(chat) = input.chat_id {
            mcp["chatId"] = json!(chat);
        }
        let grant = authority.issue_grant(json!({
            "sessionId":session_id,"resourceKind":"external-mcp","resourceId":project,
            "attachmentId":placement["worktreeId"],
            "externalMcp":mcp,
            "lanes":vec!["stream"],"operations":vec!["stream:open","stream:read","stream:write"],
            "maxChannels":1,"absoluteExpiresAt":principal.expires_at().map(|at| at.to_rfc3339()),
        })).await?;
        anyhow::ensure!(
            principal.current(service).await?,
            "MCP integration changed while opening"
        );
        let current = resolve_placement(service, owner, input).await?;
        anyhow::ensure!(
            current == placement,
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
    principal: &Principal,
    session_id: &str,
) -> Result<Option<Value>> {
    if !principal.current(service).await? {
        return Ok(None);
    }
    Ok(service
        .worker_links
        .authority
        .session_for_authorization(
            session_id,
            json!(principal.owner()),
            json!(principal.lease_account()),
        )
        .await?)
}

async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<RequestContext>>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    let principal = match authenticate_hosted(&service, request.headers()).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    connect_for(service, principal, context.id.clone(), session_id, request).await
}

async fn connect_local(
    State(service): State<Arc<AuthService>>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    connect_for(
        service,
        Principal::Loopback,
        Uuid::new_v4().to_string(),
        session_id,
        request,
    )
    .await
}

async fn connect_for(
    service: Arc<AuthService>,
    principal: Principal,
    request_id: String,
    session_id: String,
    request: Request,
) -> Response {
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
    let deadline = session_expiry
        .into_iter()
        .chain(principal.expires_at())
        .min();
    let client = RelayClient {
        owner: principal.owner().to_owned(),
        account: Some(principal.lease_account()),
        request_id,
        expires_at: deadline.map(|deadline| {
            tokio::time::Instant::now()
                + (deadline - chrono::Utc::now()).to_std().unwrap_or_default()
        }),
        ready_message: Some(RELAY_READY),
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
    let principal = match authenticate_hosted(&service, &headers).await {
        Ok(principal) => principal,
        Err(response) => return response,
    };
    release_for(&service, principal, &session_id).await
}

async fn release_local(
    State(service): State<Arc<AuthService>>,
    Path(session_id): Path<String>,
) -> Response {
    release_for(&service, Principal::Loopback, &session_id).await
}

async fn release_for(service: &AuthService, principal: Principal, session_id: &str) -> Response {
    match session(service, &principal, session_id).await {
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Ok(Some(_))
            if service
                .worker_links
                .revoke_session(session_id, "released")
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
