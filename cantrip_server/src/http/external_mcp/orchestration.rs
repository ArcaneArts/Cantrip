//! The worker opens external requests and calls these canonical server services
//! with protected application records under the active WorkerLink grant.
use super::{integration_response, receipts, relay};
use crate::{
    auth::{LOCAL_USER_ID, service::AuthService},
    chats,
    config::{AuthMode, DeploymentMode},
    http::{agent_operations::OperationError, middleware},
    wire::{Value, value::json},
    workers::credentials,
};
use anyhow::{Context as _, Result};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
};
use cantrip_protocol::external_mcp::{
    LOCAL_LEASE_ACCOUNT,
    orchestration::{CORE_PATH, CoreCall, CoreOperation, Selector, Tool},
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;

mod execution;
mod writes;

struct Authority {
    owner: String,
    principal: String,
    label: String,
    project: String,
    worktree: Value,
    worker: String,
    chat: Option<String>,
    tool: Tool,
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            &format!("{CORE_PATH}/{{worker}}/{{session}}/{{grant}}"),
            post(handle),
        )
        .layer(DefaultBodyLimit::max(128 * 1024))
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Path((worker, session, grant)): Path<(String, Uuid, Uuid)>,
    headers: HeaderMap,
    Json(call): Json<CoreCall>,
) -> Response {
    let result = async {
        let authority = authorize(
            &service,
            &headers,
            worker,
            session,
            grant,
            &call.worker_generation,
        )
        .await?;
        execute(&service, &authority, call.operation).await
    }
    .await;
    match result {
        Ok(result) => integration_response(StatusCode::OK, result),
        Err(cause) => {
            if let Some(error) = cause.downcast_ref::<OperationError>() {
                error.response()
            } else if let Some(error) = cause.downcast_ref::<receipts::OperationConflict>() {
                OperationError::new(409, "operation-conflict", error.to_string()).response()
            } else {
                OperationError::new(
                    503,
                    "unavailable",
                    "Cantrip could not complete the operation. Retry with the same operation ID.",
                )
                .response()
            }
        }
    }
}

async fn authorize(
    service: &AuthService,
    headers: &HeaderMap,
    worker: String,
    session: Uuid,
    grant: Uuid,
    worker_generation: &str,
) -> Result<Authority> {
    let denied = || {
        OperationError::new(
            403,
            "grant-unavailable",
            "The external MCP WorkerLink grant expired or was revoked.",
        )
    };
    let authorization = middleware::value(headers, "authorization");
    let authentication = credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:agent-tools",
    )
    .await?
    .ok_or_else(|| {
        OperationError::new(
            401,
            "unauthorized-worker",
            "The worker credential was rejected.",
        )
    })?;
    let owner = authentication.credential.owner_id;
    let installed = service
        .worker_links
        .authority
        .external_mcp_grant(&session.to_string(), &grant.to_string())
        .await
        .map_err(|_| denied())?
        .ok_or_else(denied)?;
    let binding = &installed["binding"];
    let identity = &binding["identity"];
    if identity["ownerId"] != owner
        || identity["workerId"] != worker
        || identity["workerProcessGeneration"] != worker_generation
        || !service
            .workers
            .bridge
            .connection_identity(&worker)
            .is_some_and(|identity| {
                identity.owner == owner && identity.process_generation == worker_generation
            })
    {
        return Err(denied().into());
    }
    let mut selector = json!({"projectId":binding["resource"]["resourceId"],"tool":installed["externalMcp"]["tool"]});
    if let Some(chat) = installed["externalMcp"].get("chatId") {
        selector["chatId"] = chat.clone();
    }
    let mut selector: Selector =
        serde_json::from_str(&selector.stringify()).map_err(|_| denied())?;
    if selector.tool.is_some_and(Tool::uses_checkout) {
        selector.worktree_id = Some(
            binding["resource"]["attachmentId"]
                .as_str()
                .ok_or_else(denied)?
                .to_owned(),
        );
    }
    let tool = selector
        .tool
        .filter(|_| selector.is_valid())
        .ok_or_else(denied)?;
    let project = selector.project_id.to_string();
    let account = identity["accountSessionId"].as_str().ok_or_else(denied)?;
    let (principal, label) = if account == LOCAL_LEASE_ACCOUNT
        && owner == LOCAL_USER_ID
        && service.config.auth_mode == AuthMode::None
        && service.config.deployment_mode == DeploymentMode::Local
    {
        ("local".to_owned(), "Local MCP client".to_owned())
    } else {
        let integration = service
            .repository
            .mcp_integration_for_lease(&owner, account)
            .await?
            .filter(|integration| {
                integration.permissions.permits_project(&project)
                    && integration.permissions.permits_scope(tool.scope())
            })
            .ok_or_else(denied)?;
        (integration.id, integration.label)
    };
    let placement = relay::resolve_placement(service, &owner, &selector)
        .await
        .map_err(|_| {
            OperationError::new(
                409,
                "placement-changed",
                "The project or chat placement is unavailable. Open a new MCP request.",
            )
        })?;
    if placement["workerId"] != worker
        || placement["worktreeId"] != binding["resource"]["attachmentId"]
    {
        return Err(OperationError::new(
            409,
            "placement-changed",
            "The project or chat moved. Open a new MCP request.",
        )
        .into());
    }
    let worker_principal = installed["externalMcp"]["workerPrincipalId"]
        .as_str()
        .ok_or_else(denied)?;
    let encryption = crate::encryption::repository::EncryptionRepository::new(
        service.repository.database.clone(),
    );
    if !encryption
        .find_worker_principal(&owner, &worker, Some(worker_principal))
        .await?
        .is_some_and(|principal| principal["state"] == "approved")
    {
        return Err(denied().into());
    }
    Ok(Authority {
        owner,
        principal,
        label,
        project,
        worker,
        worktree: placement["worktreeId"].clone(),
        chat: selector.chat_id.map(|id| id.to_string()),
        tool,
    })
}

async fn execute(
    service: &Arc<AuthService>,
    authority: &Authority,
    operation: CoreOperation,
) -> Result<Value> {
    match (authority.tool, operation) {
        (tool, CoreOperation::Checkout) if tool.uses_checkout() => {
            checkout(service, authority).await
        }
        (
            Tool::CantripCli | Tool::CantripCliRun,
            CoreOperation::Cli {
                operation_id,
                invocation,
            },
        ) => execution::cli(service, authority, operation_id, invocation).await,
        (
            Tool::AgentRead | Tool::ChatRead | Tool::ChatWait,
            CoreOperation::Chat {
                limit,
                before_sequence,
            },
        ) if (1..=25).contains(&limit) => {
            read_chat(service, authority, limit, before_sequence).await
        }
        (Tool::TaskStatus | Tool::TaskWait, CoreOperation::Tasks { task_ids })
            if (1..=10).contains(&task_ids.len()) =>
        {
            read_tasks(service, authority, &task_ids).await
        }
        (
            Tool::AgentCreate | Tool::ChatSend | Tool::TaskCreate | Tool::TaskStart,
            request @ (CoreOperation::Prepare { .. } | CoreOperation::Commit { .. }),
        ) => writes::execute(service, authority, request).await,
        _ => Err(OperationError::validation().into()),
    }
}

async fn checkout(service: &AuthService, authority: &Authority) -> Result<Value> {
    let worktree = authority.worktree.as_str().context("Checkout identity")?;
    let selected =
        crate::projects::targets::TargetRepository::new(service.repository.database.clone())
            .worktree_context(&authority.owner, &authority.project, worktree)
            .await?
            .filter(|selected| selected["workerId"] == authority.worker)
            .ok_or_else(|| {
                OperationError::new(
                    409,
                    "placement-changed",
                    "The selected checkout is unavailable.",
                )
            })?;
    let mut checkout = json!({
        "projectId":authority.project,"worktreeId":authority.worktree,"workerId":authority.worker,
        "rootKind":selected["worktree"]["rootKind"],"worktreePath":selected["worktree"]["path"],
        "sourcePath":selected["sourcePath"],
    });
    if authority.tool.is_execution() {
        let policy = execution::policy(service, authority).await?;
        if authority.tool == Tool::CommandStart && policy.sandbox_access().is_none() {
            return Err(execution::denied());
        }
        checkout["externalExecutionPolicy"] = json!(policy);
        checkout["principalId"] = json!(authority.principal);
    }
    Ok(checkout)
}

fn copy_fields(value: &Value, keys: &[&str]) -> Value {
    Value::object(keys.iter().map(|key| (*key, value[*key].clone())))
}

async fn read_chat(
    service: &AuthService,
    authority: &Authority,
    limit: u16,
    before_sequence: Option<u64>,
) -> Result<Value> {
    let chat = authority.chat.as_deref().context("Active Agent identity")?;
    let repository = chats::Repository::new(service.repository.database.clone());
    let context = repository
        .execution_context(&authority.owner, chat)
        .await?
        .filter(|context| {
            context["projectId"] == authority.project
                && context["experience"] == "agent"
                && context["workerId"] == authority.worker
                && context["worktreeId"] == authority.worktree
        })
        .ok_or_else(|| {
            OperationError::new(
                409,
                "placement-changed",
                "The chat moved. Open a new MCP request.",
            )
        })?;
    let mut agent = copy_fields(
        &context,
        &[
            "chatId",
            "projectId",
            "threadId",
            "workerId",
            "worktreeId",
            "status",
            "automationPaused",
        ],
    );
    agent["kind"] = json!("agent");
    if authority.tool == Tool::AgentRead {
        let goal = crate::http::chat_goals::read(service, &authority.owner, &context, true).await?;
        if goal.status().is_success() {
            let body = axum::body::to_bytes(goal.into_body(), 128 * 1024).await?;
            let response = crate::wire::parse_json_text(std::str::from_utf8(&body)?)
                .map_err(|_| anyhow::anyhow!("Invalid Agent goal status"))?;
            agent["goal"] = if response["goal"].is_null() {
                Value::Null
            } else {
                copy_fields(&response["goal"], &["status", "updatedAt"])
            };
        } else {
            agent["goalUnavailable"] = json!(true);
        }
    }
    let query = match before_sequence {
        Some(before_sequence) => json!({"limit":limit,"beforeSequence":before_sequence}),
        None => json!({"limit":limit}),
    };
    let page = repository
        .opaque_message_page_for_mcp(&authority.owner, chat, &query)
        .await?;
    let latest = if before_sequence.is_some() || limit != 10 {
        repository
            .opaque_message_page_for_mcp(&authority.owner, chat, &json!({"limit":10}))
            .await?
    } else {
        page.clone()
    };
    let cursor = format!(
        "{:x}",
        Sha256::digest(
            json!({"agent":agent,"messages":latest["messages"]})
                .stringify()
                .as_bytes()
        )
    );
    let mut messages = Vec::new();
    let mut bytes = 0;
    for message in page["messages"]
        .as_array()
        .context("Chat transcript")?
        .iter()
        .rev()
    {
        bytes += message.stringify().len();
        if bytes > 1024 * 1024 {
            break;
        }
        messages.push(message.clone());
    }
    messages.reverse();
    Ok(json!({"agent":agent,"messages":messages,"page":page["page"],"cursor":cursor}))
}

async fn read_tasks(service: &AuthService, authority: &Authority, ids: &[Uuid]) -> Result<Value> {
    let database = &service.repository.database;
    let tasks = crate::tasks::Repository::new(database.clone());
    let chats = chats::Repository::new(database.clone());
    let mut status = Vec::new();
    let mut missing = Vec::new();
    for id in ids {
        let id = id.to_string();
        if !chats
            .live_routing(&authority.owner, &id)
            .await?
            .is_some_and(|chat| {
                chat["projectId"] == authority.project && chat["experience"] == "task"
            })
        {
            missing.push(id);
            continue;
        }
        let Some(task) = tasks.get(&authority.owner, &id).await? else {
            missing.push(id);
            continue;
        };
        status.push(task_status(&task));
    }
    let cursor = format!(
        "{:x}",
        Sha256::digest(
            json!({"projectId":authority.project,"tasks":status,"missingTaskIds":missing})
                .stringify()
                .as_bytes()
        )
    );
    Ok(json!({"tasks":status,"missingTaskIds":missing,"cursor":cursor}))
}

fn task_status(task: &Value) -> Value {
    let retrying = matches!(
        task["automaticRetry"]["status"].as_str(),
        Some("scheduled" | "retrying")
    );
    let active = matches!(
        task["dispatch"]["state"].as_str(),
        Some("queued" | "claimed" | "running" | "paused")
    );
    json!({
        "taskId":task["chatId"],"state":task["state"],"dispatchState":task["dispatch"]["state"],
        "eligibilityCode":task["dispatch"]["eligibilityCode"],"retrying":retrying,
        "terminal":!active && (task["state"] == "complete" || (task["state"] == "failed" && !retrying)),
        "completedAt":task["completedAt"],"updatedAt":task["updatedAt"],"rowVersion":task["rowVersion"],
    })
}
