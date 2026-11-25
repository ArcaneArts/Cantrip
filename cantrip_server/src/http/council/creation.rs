use super::super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    chats::Repository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use cantrip_protocol::external_mcp::orchestration::resource_id;
use std::sync::Arc;
use uuid::Uuid;

fn identity(value: &Value) -> Result<&str> {
    value.as_str().context("Council project creation identity")
}

async fn reserve(
    service: &AuthService,
    owner: &str,
    source: &str,
    project: &str,
    operation: &str,
    target: &str,
    kind: &str,
    request: &Value,
) -> Result<Value> {
    let request = request.stringify();
    let rows = service.repository.database.query(
        r#"INSERT INTO council_project_creations AS creation
           (source_chat_id,operation_id,project_id,target_chat_id,kind,protected_request)
           SELECT a.chat_id,$4::text::uuid,p.id,$5,$6,$7::text::jsonb
           FROM council_agents a JOIN projects p ON p.owner_id=a.owner_id
           WHERE a.owner_id=$1 AND a.chat_id=$2 AND p.id=$3
           ON CONFLICT (source_chat_id,operation_id) DO UPDATE SET operation_id=creation.operation_id
           RETURNING project_id,target_chat_id,kind,protected_request::text"#,
        &[&owner,&source,&project,&operation,&target,&kind,&request],
    ).await?;
    let row = rows.first().ok_or_else(|| {
        OperationError::new(404, "not-found", "Council agent or project is unavailable.")
    })?;
    if row.get::<&str>(0)? != project
        || row.get::<&str>(1)? != target
        || row.get::<&str>(2)? != kind
    {
        return Err(OperationError::new(
            409,
            "conflict",
            "This creation operation ID already belongs to another project or resource.",
        )
        .into());
    }
    Ok(serde_json::from_str(row.get::<&str>(3)?)?)
}

pub(super) async fn chat(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("councilProjectChatCreateWireSchema", arguments)?;
    let source = identity(&context["chatId"])?;
    let project = identity(&input["projectId"])?;
    let operation = identity(&input["operationId"])?;
    let id = resource_id(
        owner,
        source,
        Uuid::parse_str(operation)?,
        "council-project-chat",
    )
    .to_string();
    if input["chatId"] != id || input["titleProtection"]["classification"]["recordKind"] != "chat" {
        return Err(
            OperationError::new(403, "invalid", "Invalid Council project chat creation.").into(),
        );
    }
    let create = parse(
        "encryptedChatCreateSchema",
        &json!({
            "id":id,"titleProtection":input["titleProtection"],"worktreeMode":"agent-managed",
            "attachToTabLayout":false,"autoTitle":false,
        }),
    )?;
    let create = reserve(
        service, owner, source, project, operation, &id, "chat", &create,
    )
    .await?;
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    let chat = Repository::new(service.repository.database.clone())
        .create_project_chat(owner, project, &create, Some(&connected))
        .await?
        .ok_or_else(|| OperationError::new(404, "not-found", "Project source not found."))?;
    service.managed_preparation.request(owner, &id).await?;
    service
        .chat_mutations
        .publish_summary(owner, &json!(id), &input["projectId"]);
    Ok(json!({
        "summary":"Created a project Agent chat.",
        "mutated":true,"target":Value::Null,"worktreeId":chat["activeWorktreeId"],
        "continuationScheduled":false,
        "data":json!({"projectId":project,"operationId":operation,"chatId":id,"workerId":chat["activeWorkerId"]}),
    }))
}

pub(super) async fn task(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("councilProjectTaskCreateWireSchema", arguments)?;
    let source = identity(&context["chatId"])?;
    let project = identity(&input["projectId"])?;
    let operation = identity(&input["operationId"])?;
    let id = resource_id(
        owner,
        source,
        Uuid::parse_str(operation)?,
        "council-project-task",
    )
    .to_string();
    if input["taskId"] != id {
        return Err(
            OperationError::new(403, "invalid", "Invalid Council project Task identity.").into(),
        );
    }
    let create = parse(
        "encryptedTaskCreateSchema",
        &json!({
            "chatId":id,"titleProtection":input["titleProtection"],"worktreeMode":"agent-managed",
            "planGoalEnabled":false,"autoTitle":false,"priority":0,"task":input["task"],
        }),
    )?;
    let request = reserve(
        service,
        owner,
        source,
        project,
        operation,
        &id,
        "task",
        &json!({
            "start":input["start"],"create":create,
        }),
    )
    .await?;
    let repository = crate::tasks::Repository::new(service.repository.database.clone());
    let mut task = repository.get(owner, &id).await?;
    if task.is_none() {
        let connected = |worker: &str| service.workers.bridge.is_connected(worker);
        let created = Repository::new(service.repository.database.clone())
            .create_task(owner, project, &request["create"], Some(&connected))
            .await;
        task = match created {
            Ok(Some(created)) => Some(created["task"].clone()),
            Ok(None) => {
                return Err(
                    OperationError::new(404, "not-found", "Project source not found.").into(),
                );
            }
            Err(error) => Some(repository.get(owner, &id).await?.ok_or(error)?),
        };
    }
    let task = task.context("Created Task")?;
    let project_chats =
        super::super::agent_operations::project_chats(service, owner, project).await?;
    let chat = project_chats
        .iter()
        .find(|chat| chat["id"] == id && chat["experience"] == "task")
        .ok_or_else(|| {
            OperationError::new(
                409,
                "conflict",
                "The Task no longer belongs to this project.",
            )
        })?;
    let started = request["start"] == true;
    if started && task["state"] == "draft" && task["dispatch"].is_null() {
        crate::task_dispatch::Repository::new(service.repository.database.clone())
            .enqueue(owner, &id, operation, "direct", &task["rowVersion"])
            .await?;
    }
    service
        .chat_mutations
        .publish_summary(owner, &json!(id), &input["projectId"]);
    service
        .chat_mutations
        .publish_invalidation(owner, &id, "task", None);
    if started {
        service.execution.scheduler.queue_tick();
    }
    Ok(json!({
        "summary":if started {"Created a project Task and queued it for execution."} else {"Created a project Task draft."},
        "mutated":true,"target":Value::Null,"worktreeId":chat["activeWorktreeId"],
        "continuationScheduled":false,
        "data":json!({"projectId":project,"operationId":operation,"taskId":id,"workerId":chat["activeWorkerId"],"started":started}),
    }))
}
