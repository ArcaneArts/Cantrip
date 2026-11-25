//! Apply the current project workspace policy and dispatch the approved CLI vocabulary.
use super::{AuthService, Authority, OperationError, Result, Tool, Value, json};
use crate::{
    http::{agent_operations::audit_resource, cli_commands::execute_resolved},
    projects::workspaces::WorkspaceRepository,
};
use cantrip_protocol::external_mcp::{
    execution::{CliCommand, CliInvocation, ExecutionPolicy, RunAction},
    orchestration::resource_id,
};
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn policy(
    service: &AuthService,
    authority: &Authority,
) -> Result<ExecutionPolicy> {
    WorkspaceRepository::new(service.repository.database.clone())
        .effective_external_execution(&authority.owner, &authority.project)
        .await
}

pub(super) fn denied() -> anyhow::Error {
    OperationError::new(
        403,
        "execution-disabled",
        "The project's workspace does not allow this external MCP execution. Check its execution policy.",
    )
    .into()
}

pub(super) async fn cli(
    service: &Arc<AuthService>,
    authority: &Authority,
    operation_id: Option<Uuid>,
    invocation: CliInvocation,
) -> Result<Value> {
    let (command, arguments, write) = match (authority.tool, operation_id, invocation) {
        (Tool::CantripCli, None, CliInvocation::Read { command }) => {
            let (command, arguments) = read(command, &authority.worktree)?;
            (command, arguments, None)
        }
        (
            Tool::CantripCliRun,
            Some(operation),
            CliInvocation::Run {
                action,
                configuration_id,
            },
        ) => {
            if !matches!(action, RunAction::Stop)
                && policy(service, authority).await? != ExecutionPolicy::WorkspaceWrite
            {
                return Err(denied());
            }
            let operation =
                resource_id(&authority.owner, &authority.principal, operation, "cli-run");
            (
                action.command(),
                json!({"configurationId":configuration_id,"worktreeId":authority.worktree}),
                Some(operation),
            )
        }
        _ => return Err(OperationError::validation().into()),
    };
    let worktree = authority
        .worktree
        .as_str()
        .ok_or_else(OperationError::validation)?;
    let catalog =
        crate::projects::targets::TargetRepository::new(service.repository.database.clone());
    let selected = catalog
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
    let request_id = write.unwrap_or_else(Uuid::new_v4);
    let request = crate::settings::parse_response(
        "workerCliCommandCallSchema",
        Some(&json!({
            "workerId":authority.worker,"requestId":request_id,"command":command,
            "context":json!({}),"arguments":arguments,
        })),
    )?;
    let context = json!({
        "projectId":authority.project,"worktreeId":authority.worktree,"workerId":authority.worker,
        "rootKind":selected["worktree"]["rootKind"],"chatId":Value::Null,"terminalId":Value::Null,
        "executionLaneId":Value::Null,"worktreeMode":Value::Null,
        "permissionProfileId":if write.is_some() { ":workspace" } else { ":read-only" },
    });
    // The CLI dispatcher also handles the larger managed operations. Keep its
    // future off the external MCP Core request's Tokio worker stack.
    let result = Box::pin(execute_resolved(
        service,
        &authority.owner,
        Some(context),
        &request,
    ))
    .await;
    if write.is_some() {
        audit_resource(
            service,
            &authority.owner,
            &request_id.to_string(),
            "external-mcp.cli-run",
            if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            },
            "run-configuration",
            arguments["configurationId"].as_str(),
        )
        .await;
    }
    result.map_err(|error| {
        if let Some(error) = error.downcast_ref::<crate::cli::Error>() {
            OperationError::new(error.status, "cli-failed", error.message.clone()).into()
        } else if let Some(error) = error.downcast_ref::<OperationError>() {
            OperationError::new(error.status, error.code, error.message.clone()).into()
        } else {
            OperationError::new(
                409,
                "cli-unavailable",
                "The Cantrip CLI could not complete this operation for the selected checkout.",
            )
            .into()
        }
    })
}

fn read(command: CliCommand, worktree: &Value) -> Result<(&'static str, Value)> {
    let empty = || json!({});
    Ok(match command {
        CliCommand::Context => ("status", empty()),
        CliCommand::TargetList => ("target.list", empty()),
        CliCommand::TargetShow => ("target.show", empty()),
        CliCommand::WorktreeList => ("worktree.list", empty()),
        CliCommand::WorktreeStatus => ("worktree.status", json!({"worktree":worktree})),
        CliCommand::RunList => ("run.list", empty()),
        CliCommand::RunShow { configuration_id } => {
            ("run.show", json!({"configurationId":configuration_id}))
        }
        CliCommand::RunStatus { configuration_id } => (
            "run.status",
            json!({"configurationId":configuration_id,"worktreeId":worktree}),
        ),
        CliCommand::RunLogs {
            configuration_id,
            tail,
        } => {
            let tail = tail.unwrap_or(20);
            if !(1..=100).contains(&tail) {
                return Err(OperationError::validation().into());
            }
            (
                "run.logs",
                json!({"configurationId":configuration_id,"worktreeId":worktree,"tail":tail}),
            )
        }
    })
}
