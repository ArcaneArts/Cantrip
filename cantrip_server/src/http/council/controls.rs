use super::super::{
    agent_operations::{OperationError, parse},
    chat_execution,
};
use crate::{
    auth::service::AuthService,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

fn identity(value: &Value) -> Result<&str> {
    value.as_str().context("Council project control identity")
}

fn failure(status: u16) -> OperationError {
    match status {
        404 => OperationError::new(
            status,
            "not-found",
            "The project chat or Task is unavailable.",
        ),
        409 => OperationError::new(
            status,
            "conflict",
            "The project chat or Task could not be interrupted in its current state.",
        ),
        _ => OperationError::new(
            status,
            "operation-failed",
            "The project worker did not accept the interruption.",
        ),
    }
}

pub(super) async fn interrupt(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    arguments: &Value,
) -> Result<Value> {
    let input = parse("councilProjectInterruptInputSchema", arguments)?;
    let source = identity(&context["chatId"])?;
    let project = identity(&input["projectId"])?;
    let target = identity(&input["chatId"])?;
    let kind = identity(&input["targetKind"])?;
    let operation = identity(&input["operationId"])?;
    let database = &service.repository.database;
    let admitted = database
        .query(
            r#"INSERT INTO council_project_interrupts
           (source_chat_id,operation_id,project_id,target_chat_id,target_kind)
           SELECT a.chat_id,$6::text::uuid,p.id,c.id,c.experience
           FROM council_agents a JOIN projects p ON p.owner_id=a.owner_id
           JOIN chats c ON c.project_id=p.id AND c.owner_id=p.owner_id
           WHERE a.owner_id=$1 AND a.chat_id=$2 AND p.id=$3 AND c.id=$4 AND c.experience=$5
             AND c.archived_at IS NULL
           ON CONFLICT (source_chat_id,operation_id) DO NOTHING RETURNING operation_id"#,
            &[&owner, &source, &project, &target, &kind, &operation],
        )
        .await?;
    let interrupted = if admitted.is_empty() {
        let receipts = database
            .query(
                r#"SELECT r.project_id,r.target_chat_id,r.target_kind,r.interrupted,r.failure_status
               FROM council_project_interrupts r JOIN council_agents a ON a.chat_id=r.source_chat_id
               WHERE a.owner_id=$1 AND r.source_chat_id=$2 AND r.operation_id=$3::text::uuid"#,
                &[&owner, &source, &operation],
            )
            .await?;
        let receipt = receipts.first().ok_or_else(|| failure(404))?;
        if receipt.get::<&str>(0)? != project
            || receipt.get::<&str>(1)? != target
            || receipt.get::<&str>(2)? != kind
        {
            return Err(OperationError::new(
                409,
                "conflict",
                "This operation ID already belongs to another interruption.",
            )
            .into());
        }
        if let Some(status) = receipt.get::<Option<i32>>(4)? {
            return Err(failure(u16::try_from(status)?).into());
        }
        receipt.get::<Option<bool>>(3)?
    } else {
        // Claim before calling the normal control. If transport is lost, an
        // unknown receipt prevents a retry from interrupting a later turn.
        let response = chat_execution::interrupt_external(service.clone(), owner, target).await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            if response.status().is_server_error() {
                return Err(OperationError::new(
                    status,
                    "unavailable",
                    "The project worker could not confirm the interruption. Check the target status.",
                )
                .into());
            }
            database.query(
                "UPDATE council_project_interrupts SET failure_status=$3 WHERE source_chat_id=$1 AND operation_id=$2::text::uuid",
                &[&source,&operation,&i32::from(status)],
            ).await?;
            return Err(failure(status).into());
        }
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024).await?;
        let result = parse(
            "chatInterruptAcceptedSchema",
            &serde_json::from_slice(&body)?,
        )?;
        let interrupted = result["interrupted"]
            .as_bool()
            .context("Interruption receipt")?;
        database.query(
            "UPDATE council_project_interrupts SET interrupted=$3 WHERE source_chat_id=$1 AND operation_id=$2::text::uuid",
            &[&source,&operation,&interrupted],
        ).await?;
        Some(interrupted)
    };
    let (status, summary) = match interrupted {
        Some(true) => ("interrupted", "The project interruption was accepted."),
        Some(false) => ("not-active", "The selected project chat or Task was idle."),
        None => (
            "pending",
            "The prior interruption has no confirmed result. Check the target status before requesting another interruption.",
        ),
    };
    let mut data = input;
    data["status"] = json!(status);
    Ok(
        json!({"summary":summary,"mutated":interrupted==Some(true),"target":Value::Null,
        "worktreeId":Value::Null,"continuationScheduled":false,"data":data}),
    )
}
