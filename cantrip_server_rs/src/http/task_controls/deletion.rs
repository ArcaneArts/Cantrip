//! Interruption is best effort; durable deletion still runs after worker errors.
use super::*;
use crate::{
    chats,
    operations::logging::{self, LogCall},
    workers::command_bus::RequestTimeout,
};

fn log(level: &'static str, message: &'static str, context: Value) {
    logging::server_logger()(LogCall::event(level, message, context));
}
async fn interrupt_attempt(
    service: &AuthService,
    owner: &str,
    chat: &str,
    context: &mut Option<Value>,
) -> Result<()> {
    let chats = chats::Repository::new(service.repository.database.clone());
    let tasks = tasks::Repository::new(service.repository.database.clone());
    let (resolved, task) =
        tokio::try_join!(chats.execution_context(owner, chat), tasks.get(owner, chat))?;
    *context = resolved;
    let (Some(context), Some(task)) = (context.as_ref(), task) else {
        return Ok(());
    };
    let running = matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    ) || matches!(task["state"].as_str(), Some("planning" | "implementing"))
        || matches!(
            task["dispatch"]["state"].as_str(),
            Some("claimed" | "running")
        );
    if !running {
        return Ok(());
    }
    let worker = context["workerId"]
        .as_str()
        .context("Task deletion worker ID")?;
    let mut fields = json!({"event":"task.deletion-interrupt.skipped","subsystem":"task-execution","operation":"interrupt-before-delete","status":"skipped","chatId":chat,"projectId":context["projectId"],"workerId":context["workerId"]});
    if !service.workers.bridge.is_connected(worker) {
        fields["reasonCode"] = json!("worker-offline");
        log(
            "warn",
            "Task worker is offline; deletion will continue",
            fields,
        );
        return Ok(());
    }
    let Some(runtime) = service
        .model_routing
        .runtime_for_context(owner, context)
        .await?
    else {
        fields["reasonCode"] = json!("runtime-unavailable");
        log(
            "warn",
            "Task runtime is unavailable; deletion will continue",
            fields,
        );
        return Ok(());
    };
    let response = service.workers.commands.request_with_timeout(worker,
        json!({"type":"chat.interrupt","executionProfile":if context["contextKind"]=="standalone" {"standalone-chat"}else{"ide"},"chatId":chat,"threadId":context["threadId"],"model":runtime["model"],"provider":runtime["provider"]}),
        RequestTimeout::Default, None).await?;
    let result = crate::settings::parse_response("chatInterruptAcceptedSchema", response.as_ref())?;
    let interrupted = result["interrupted"] == true;
    fields["event"] = json!("task.deletion-interrupt.completed");
    fields["status"] = json!(if interrupted {
        "completed"
    } else {
        "not-active"
    });
    log(
        "info",
        if interrupted {
            "Running Task interrupted before deletion"
        } else {
            "Task had no active worker turn before deletion"
        },
        fields,
    );
    Ok(())
}
pub(super) async fn delete(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
) -> Result<Response> {
    let mut context = None;
    if let Err(cause) = interrupt_attempt(&service, &owner, &chat, &mut context).await {
        let context = context.unwrap_or(Value::Null);
        log(
            "warn",
            "Task interruption failed; deletion will continue",
            json!({"event":"task.deletion-interrupt.failed","subsystem":"task-execution","operation":"interrupt-before-delete","status":"failed","chatId":chat,"projectId":context["projectId"],"workerId":context["workerId"],"error":crate::settings::operation_error_message(&cause)}),
        );
    }
    match tasks::Repository::new(service.repository.database.clone())
        .delete_owned(&owner, &chat)
        .await
    {
        Ok(Some(deleted)) => {
            service
                .chat_mutations
                .publish_summary(&owner, &json!(chat), &deleted["projectId"]);
            service.chat_mutations.publish_invalidation(
                &owner,
                &chat,
                "task",
                Some(&json!({"experience":"task","projectId":deleted["projectId"]})),
            );
            let mut response = Response::new(axum::body::Body::empty());
            *response.status_mut() = StatusCode::NO_CONTENT;
            Ok(response)
        }
        Ok(None) => Ok(error(404, "Task not found.")),
        Err(cause) => mutation_error(cause),
    }
}
