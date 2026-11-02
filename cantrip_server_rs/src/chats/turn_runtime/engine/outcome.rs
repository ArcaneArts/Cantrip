use super::*;
use crate::chats::{
    live_mutations::{MessageOptions, RouteSelection},
    message_queries::MessageKind,
};
impl Runtime {
    pub(super) async fn complete(
        self: &Arc<Self>,
        sink: &Arc<EventSink>,
        index: usize,
        began: i64,
        hooks: &Hooks,
        result: Value,
    ) -> Result<()> {
        let turn = &sink.turn;
        let e = &turn.execution;
        let runtime = sink.runtime.lock().unwrap().clone();
        let completed = (self.dependencies.events.clock)();
        {
            let mut state = sink.state.lock().await;
            if let Some(id) = result.get("turnId").filter(|v| !v.is_null()) {
                state.behavior_turn = id.clone();
            }
            state
                .tracker
                .observe_native_turn(result.get("turnId"), None)?;
            if !result["text"]
                .as_js_string()
                .context("Turn result text")?
                .trim()
                .is_empty()
            {
                state.tracker.mark_visible(true, completed);
            }
            let mut a = self.completed_analytics(sink, index, began, completed);
            a["turnId"] = result["turnId"].clone();
            let mut usage_attribution = a.clone();
            if let Value::Object(fields) = &mut usage_attribution {
                fields.shift_remove("startedAt");
            }
            self.dependencies
                .events
                .telemetry
                .record_usage(
                    &turn.owner,
                    &sink.source,
                    e,
                    &runtime,
                    result.get("measuredUsage").filter(|v| !v.is_null()),
                    &usage_attribution,
                )
                .await;
            a["turnId"] = state.behavior_turn.clone();
            self.dependencies
                .events
                .telemetry
                .record_behavior(&turn.owner, &sink.source, e, &runtime, &state.tracker, &a)
                .await;
            self.quota_completed(sink, &result["turnId"])?;
            state.quota_followups_scheduled = true;
        }
        self.dependencies.routing.set_cooldown(&runtime, None);
        self.update_runtime(turn, &runtime, &result["threadId"], "ready")
            .await?;
        let completion = Completion {
            turn: turn.clone(),
            result: result.clone(),
        };
        if truthy(turn.options.get("structuredResult")) {
            (hooks
                .structured
                .as_ref()
                .context("options.structuredResult.onCompleted is not a function")?
                .completed)(completion.clone())
            .await?;
        } else {
            let (encrypted, kind, schema) = if let Some(task) = turn
                .encrypted_task
                .as_ref()
                .filter(|v| truthy(v.get("response")))
            {
                (
                    Some(task),
                    MessageKind::Task,
                    "taskMessageRelayResultSchema",
                )
            } else if let Some(chat) = &turn.encrypted_chat {
                (
                    Some(chat),
                    MessageKind::Encrypted,
                    "chatMessageRelayResultSchema",
                )
            } else {
                (None, MessageKind::Plain, "")
            };
            let message = if let Some(encrypted) = encrypted {
                let parsed =
                    crate::settings::parse_response(schema, result.get("structuredResult"))?;
                let message = &parsed["message"];
                if message.is_null()
                    || message.get("id") != encrypted["response"].get("id")
                    || message.get("idempotencyKey") != encrypted["response"].get("idempotencyKey")
                    || (matches!(kind, MessageKind::Task)
                        && message["classification"]["mode"]
                            != encrypted["userMessage"]["classification"]["mode"])
                {
                    anyhow::bail!(if matches!(kind, MessageKind::Task) {
                        "The encrypted Task message result metadata is invalid."
                    } else {
                        "The encrypted chat message result metadata is invalid."
                    });
                }
                message.clone()
            } else {
                json!({"role":"assistant","content":Value::Array(vec![json!({"type":"text","text":if truthy(result.get("text")){result["text"].clone()}else{json!("The agent completed without a message.")},"phase":"final_answer"})]),"idempotencyKey":identifier(&[&json!("assistant:"),&turn.user_message["id"]])})
            };
            let final_seen = sink
                .state
                .lock()
                .await
                .finals
                .has(result.get("turnId"), &result["text"])?;
            if !final_seen {
                let live = &self.dependencies.events.live;
                let chat = events::text(&e["chatId"])?;
                let saved = live
                    .write_message(
                        &turn.owner,
                        &chat,
                        &message,
                        MessageOptions {
                            attribution: Some(&turn.attribution),
                            kind,
                            upsert: false,
                            routing: if matches!(kind, MessageKind::Task) {
                                Some(e)
                            } else {
                                None
                            },
                        },
                    )
                    .await?;
                if encrypted.is_some() {
                    let saved = saved.context(if matches!(kind, MessageKind::Task) {
                        "Encrypted Task Chat not found."
                    } else {
                        "Encrypted Chat not found."
                    })?;
                    live.set_route(
                        &turn.owner,
                        &events::text(&saved["id"])?,
                        RouteSelection {
                            model: &events::text(&turn.model_id)?,
                            runtime: &runtime,
                            reasoning: None,
                            kind,
                            routing: if matches!(kind, MessageKind::Task) {
                                Some(e)
                            } else {
                                None
                            },
                        },
                    )
                    .await?;
                }
            }
        }
        self.dependencies
            .events
            .live
            .interrupt_interactions(
                &turn.owner,
                &events::text(&e["chatId"])?,
                e["executionLaneId"].as_str(),
            )
            .await?;
        let finished = self
            .dependencies
            .bootstrap
            .finish(turn, "idle", false)
            .await?;
        self.dependencies.events.live.publish_boundary(
            &turn.owner,
            &events::text(&e["chatId"])?,
            &e["projectId"],
            Some(e),
        );
        if let Some(callback) = hooks
            .structured
            .as_ref()
            .and_then(|s| s.after_completed.as_ref())
            && let Err(error) = callback(completion.clone()).await
        {
            self.log("error","Task post-processing failed after its structured turn completed",json!({"chatId":e["chatId"],"err":if turn.encrypted_task.is_some(){json!({"name":"Error","message":"Encrypted Task post-processing failed."})}else{logging::error_details(&error)}}));
        }
        if let Some(callback) = &hooks.after_completed
            && let Err(error) = callback(completion).await
        {
            self.log(
                "error",
                "Task post-processing failed after its turn completed",
                json!({"chatId":e["chatId"],"err":logging::error_details(&error)}),
            );
        }
        if finished
            && (e["contextKind"] == "standalone"
                || !self
                    .dependencies
                    .continuation
                    .continue_worktree(turn.clone())
                    .await?)
        {
            let continuation = self.dependencies.continuation.clone();
            let turn = turn.clone();
            self.operations
                .spawn(async move { continuation.dispatch_queue(turn).await });
        }
        self.log("info","Agent turn completed",json!({"event":"chat.turn.completed","subsystem":"chat-execution","operation":"turn","status":"completed","chatId":e["chatId"],"projectId":e["projectId"],"workerId":e["workerId"],"requestId":turn.user_message["id"],"runId":e["executionLaneId"],"turnId":result["turnId"],"durationMs":(self.dependencies.events.clock)()-turn.started_at,"counts":json!({"changedPaths":sink.turn_state.lock().unwrap().changed_paths.len(),"responseCharacters":result["text"].as_js_string().unwrap().len()}),"providerId":runtime["provider"]["id"],"providerAccountId":runtime["provider"]["accountId"],"routeId":runtime["routeId"]}));
        Ok(())
    }
}
