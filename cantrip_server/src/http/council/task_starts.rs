use super::super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    task_dispatch::{self, CouncilOrigin},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use cantrip_protocol::external_mcp::orchestration::resource_id;
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn start(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("councilProjectTaskStartInputSchema", arguments)?;
    let task_id = input["taskId"].as_str().context("Council Task ID")?;
    let project = input["projectId"]
        .as_str()
        .context("Council Task project")?;
    let agent = context["chatId"].as_str().context("Council agent ID")?;
    let operation = Uuid::parse_str(
        input["operationId"]
            .as_str()
            .context("Council operation ID")?,
    )?;
    let task = crate::tasks::Repository::new(service.repository.database.clone())
        .get(owner, task_id)
        .await?
        .ok_or(task_dispatch::NotFound)
        .map_err(task_error)?;
    let kind = if task["planGoalEnabled"] == true {
        "initial-plan"
    } else {
        "direct"
    };
    let dispatch_operation = resource_id(owner, agent, operation, "council-task-start").to_string();
    let dispatch = queue(
        service,
        owner,
        &task,
        kind,
        &dispatch_operation,
        CouncilOrigin {
            agent_id: agent.to_owned(),
            project_id: project.to_owned(),
            operation_id: operation,
        },
    )
    .await?;
    Ok(json!({
        "summary":"Queued the project Task through its scheduler.","mutated":true,
        "target":Value::Null,"worktreeId":Value::Null,"continuationScheduled":false,
        "data":json!({"projectId":project,"taskId":task_id,"operationId":operation.to_string(),
            "dispatchId":dispatch["id"],"kind":dispatch["operationKind"]}),
    }))
}

pub(super) async fn queue(
    service: &AuthService,
    owner: &str,
    task: &Value,
    kind: &str,
    dispatch_operation: &str,
    origin: CouncilOrigin,
) -> Result<Value> {
    let task_id = task["chatId"].as_str().context("Council Task ID")?;
    let input = json!({"operationId":dispatch_operation,"rowVersion":task["rowVersion"]});
    service
        .execution
        .queue
        .queue_council(owner, task_id, &input, kind, origin)
        .await
        .map_err(|error| match error.downcast::<task_dispatch::NotFound>() {
            Ok(error) => task_error(error).into(),
            Err(error) => {
                if let Some(conflict) = error.downcast_ref::<task_dispatch::Conflict>() {
                    OperationError::new(409, "conflict", conflict.message.clone()).into()
                } else {
                    error
                }
            }
        })
}

fn task_error(error: task_dispatch::NotFound) -> OperationError {
    OperationError::new(404, "not-found", error.to_string())
}
