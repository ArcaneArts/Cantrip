use super::*;
use crate::{
    operations::logging::{self, LogCall},
    wire::coercion::truthy,
};
pub(super) async fn compact(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
) -> Result<Response> {
    let Some(context) = Repository::new(service.repository.database.clone())
        .execution_context(owner, chat)
        .await?
    else {
        return Ok(error(404, "Chat source not found."));
    };
    if matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    ) {
        return Ok(error(409, "Wait for the active turn to finish."));
    }
    if !truthy(context.get("threadId")) {
        return Ok(error(409, "Send a message before compacting this chat."));
    }
    let worker = context["workerId"].as_str().context("Compaction worker")?;
    if !service.workers.bridge.is_connected(worker) {
        return Ok(error(503, "Project worker is offline."));
    }
    let Some(runtime) = service
        .model_routing
        .runtime_for_context(owner, &context)
        .await?
    else {
        return Ok(error(400, "Selected model was not found."));
    };
    let started = crate::auth::now().timestamp_millis();
    logging::server_logger()(LogCall::event(
        "info",
        "Chat compaction started",
        json!({"event":"chat.compaction.started","subsystem":"chat-execution","operation":"compact","status":"running","chatId":context["chatId"],"projectId":context["projectId"],"workerId":context["workerId"]}),
    ));
    let mut command = json!({"type":"chat.compact","executionProfile":if context["contextKind"]=="standalone"{"standalone-chat"}else{"ide"},"chatId":context["chatId"],"cwd":context["cwd"],"threadId":context["threadId"],"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":crate::chats::managed_console::permission_profile(&context)["effectiveId"]});
    if crate::chats::managed_console::turn_session_context(&context).is_some() {
        let prepared = service
            .managed_console
            .prepare_turn(owner, &context, &runtime)
            .await?;
        for key in ["session", "subagentDefaults", "mcpServers", "planMode"] {
            if let Some(value) = prepared.get(key) {
                command[key] = value.clone()
            }
        }
    }
    let result = service
        .workers
        .commands
        .request(worker, command, None, None)
        .await?;
    logging::server_logger()(LogCall::event(
        "info",
        "Chat compaction completed",
        json!({"event":"chat.compaction.completed","subsystem":"chat-execution","operation":"compact","status":"completed","durationMs":crate::auth::now().timestamp_millis()-started,"chatId":context["chatId"],"projectId":context["projectId"],"workerId":context["workerId"]}),
    ));
    let result = crate::settings::parse_response("chatCompactAcceptedSchema", result.as_ref())?;
    output(200, "chatCompactAcceptedSchema", &result)
}
