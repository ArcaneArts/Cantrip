use super::*;
use crate::chats::{
    live_mutations::{MessageOptions, RouteSelection},
    managed_console,
    message_queries::MessageKind,
    turn_storage,
};
use anyhow::bail;

impl Bootstrap {
    pub(super) async fn persist(self: &Arc<Self>, turn: &mut PreparedTurn) -> Result<()> {
        let execution = &turn.execution;
        let chat = text(execution, "chatId")?;
        if let Some(retry) = turn
            .options
            .get("retryMessageId")
            .filter(|v| truthy(Some(v)))
        {
            let runtime = &turn.route_pairs.first().context("Turn model route")?["root"]["runtime"];
            if !truthy(execution.get("threadId"))
                || !crate::chats::runtime_telemetry::RuntimeTelemetry::can_resume(
                    execution, runtime,
                )
            {
                bail!("The original Codex runtime is unavailable for this message.");
            }
            let launch = if managed_console::session_context(execution).is_some() {
                Some(
                    self.console
                        .prepare_launch(&turn.owner, execution, runtime)
                        .await?,
                )
            } else {
                None
            };
            let mut command = json!({"type":"chat.turn.rollback","executionProfile":if execution["contextKind"]=="standalone" {"standalone-chat"}else{"ide"},"chatId":chat,"clientMessageId":retry,"cwd":execution["cwd"],"threadId":execution["threadId"],"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":managed_console::permission_profile(execution)["effectiveId"]});
            if let Some(launch) = launch {
                for field in ["session", "subagentDefaults", "mcpServers", "planMode"] {
                    if let Some(value) = launch.get(field) {
                        command[field] = value.clone();
                    }
                }
            }
            if let Some(receipt) = &turn.native_receipt {
                command["nativeCommandReceipt"] = receipt.clone();
            }
            let result = self
                .commands
                .request_with_timeout(
                    text(execution, "workerId")?,
                    command,
                    RequestTimeout::Default,
                    None,
                )
                .await?;
            let rollback =
                crate::settings::parse_response("chatTurnRollbackAcceptedSchema", result.as_ref())?;
            if rollback["rolledBack"] != true {
                bail!("The previous Codex turn could not be rolled back.");
            }
            if !self
                .chats
                .trim_latest_encrypted_turn(
                    &turn.owner,
                    chat,
                    retry.as_str().context("Retry message")?,
                )
                .await?
            {
                bail!("Only the latest user message can be edited and sent again.");
            }
        }
        let (live, owner, chat_id, mode) = (
            self.live.clone(),
            turn.owner.clone(),
            chat.to_owned(),
            turn.turn_plan_mode.clone(),
        );
        turn.observer
            .run("persist-turn-mode", async move {
                live.update_plan_mode(&owner, &chat_id, mode.as_str().context("Plan mode")?)
                    .await
            })
            .await?;
        let (chats, owner, chat_id) = (self.chats.clone(), turn.owner.clone(), chat.to_owned());
        let headers = turn
            .observer
            .run("load-message-headers", async move {
                chats.message_headers(&owner, &chat_id).await
            })
            .await?;
        if let Some(last) = headers.iter().rev().find(|v| v["role"] == "assistant") {
            turn.immediate_corrective_followup = last["createdAt"]
                .as_js_string()
                .and_then(crate::wire::date_milliseconds)
                .is_some_and(|at| (0..=120_000).contains(&(turn.started_at - at)));
        }
        let (message, kind) = if let Some(encrypted) = &turn.encrypted_chat {
            turn.protected_history = self
                .chats
                .list_messages(&turn.owner, chat, MessageKind::Encrypted)
                .await?;
            turn.protected_plan = self.chats.encrypted_plan(&turn.owner, chat).await?;
            (&encrypted["userMessage"], MessageKind::Encrypted)
        } else if let Some(encrypted) = &turn.encrypted_task {
            (&encrypted["userMessage"], MessageKind::Task)
        } else {
            bail!("Chat turn content was not encrypted.");
        };
        let (live, owner, chat_id, message, attribution, routing) = (
            self.live.clone(),
            turn.owner.clone(),
            chat.to_owned(),
            message.clone(),
            turn.attribution.clone(),
            execution.clone(),
        );
        let append = async move {
            live.write_message(
                &owner,
                &chat_id,
                &message,
                MessageOptions {
                    attribution: Some(&attribution),
                    kind,
                    upsert: false,
                    routing: Some(&routing),
                },
            )
            .await
        };
        let appended = if turn.encrypted_chat.is_some() {
            append.await?
        } else {
            turn.observer.run("append-task-message", append).await?
        }
        .context(if turn.encrypted_chat.is_some() {
            "Encrypted Chat not found."
        } else {
            "Encrypted Task Chat not found."
        })?;
        turn.user_message = turn_storage::message_stub(&appended);
        let (live, owner, id, model, runtime, reasoning, routing) = (
            self.live.clone(),
            turn.owner.clone(),
            text(&turn.user_message, "id")?.to_owned(),
            turn.model_id.clone(),
            turn.route_pairs[0]["root"]["runtime"].clone(),
            json!({"appliedReasoningEffort":turn.route_pairs[0]["root"]["appliedReasoningEffort"],"reasoningAdjusted":turn.route_pairs[0]["root"]["adjusted"]}),
            execution.clone(),
        );
        let attribute = async move {
            live.set_route(
                &owner,
                &id,
                RouteSelection {
                    model: model.as_str().context("Model ID")?,
                    runtime: &runtime,
                    reasoning: Some(&reasoning),
                    kind,
                    routing: Some(&routing),
                },
            )
            .await
        };
        if turn.encrypted_chat.is_some() {
            attribute.await?;
        } else {
            turn.observer
                .run("attribute-task-message", attribute)
                .await?;
        }
        let runtime = &turn.route_pairs[0]["root"]["runtime"];
        (self.logger)(LogCall::event(
            "info",
            "Agent turn accepted",
            json!({"event":"chat.turn.accepted","subsystem":"chat-execution","operation":"turn","status":"accepted","chatId":chat,"clientMessageId":turn.user_message["id"],"executionLaneId":execution["executionLaneId"],"modelId":turn.model_id,"providerAccountId":runtime["provider"]["accountId"],"providerId":runtime["provider"]["id"],"serverVersion":crate::settings::quota::server_version(),"workerId":execution["workerId"],"projectId":execution["projectId"]}),
        ));
        Ok(())
    }
}
