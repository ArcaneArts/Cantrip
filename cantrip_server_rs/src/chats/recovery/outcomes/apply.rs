use super::*;
impl Service {
    pub(super) async fn apply(&self, input: Recovery<'_>) -> Result<()> {
        let Recovery {
            owner,
            n,
            context,
            operation,
            fence,
            ..
        } = input;
        let chat = text(&n["chatId"])?;
        let standalone = n["contextKind"] == "standalone";
        let attribution = json!({"contextKind":if standalone {"standalone"} else {"project"},"executionLaneId":n["executionLaneId"],"worktreeId":if standalone {Value::Null} else {n["worktreeId"].clone()},"scratchRootId":if standalone {n["scratchRootId"].clone()} else {Value::Null}});
        let reported_ok = n["outcome"]["ok"] == true;
        let result = &n["outcome"]["result"];
        let mut ok = reported_ok;
        let mut finalized = None;
        if let Some(operation) = operation {
            let operation_id = text(&operation["round"]["id"])?;
            if reported_ok {
                let completed: Result<()> = async {
                    let relay = tasks::relay::parse_result(
                        &operation["relayRequest"],
                        &result["structuredResult"],
                    )?;
                    self.tasks
                        .complete_operation(
                            owner,
                            chat,
                            operation_id,
                            &relay,
                            result["turnId"].as_str(),
                        )
                        .await?;
                    if operation["round"]["kind"] == "finalize" {
                        finalized = Some(operation_id);
                    }
                    let assistant = self
                        .dependencies
                        .live
                        .write_message(
                            owner,
                            chat,
                            &relay["assistantMessage"],
                            MessageOptions {
                                attribution: Some(&attribution),
                                kind: MessageKind::Task,
                                upsert: false,
                                routing: Some(&context["chat"]),
                            },
                        )
                        .await?
                        .context("Task Chat was not found.")?;
                    self.tasks
                        .attach_operation_assistant_message(
                            owner,
                            chat,
                            operation_id,
                            text(&assistant["id"])?,
                        )
                        .await?;
                    self.publish_task(owner, chat, &context["chat"]);
                    Ok(())
                }
                .await;
                if completed.is_err() {
                    ok = false;
                    self.tasks
                        .fail_operation(owner, chat, operation_id, None)
                        .await?;
                    self.publish_task(owner, chat, &context["chat"]);
                }
            } else {
                ok = false;
                self.tasks
                    .fail_operation(owner, chat, operation_id, None)
                    .await?;
                self.publish_task(owner, chat, &context["chat"]);
            }
        }
        if let Some(fence) = fence {
            if let Err(error) = self
                .dispatch
                .settle(fence, if ok { "succeeded" } else { "failed" }, &Value::Null)
                .await
                && downcast_ref::<task_dispatch::Conflict>(&error).is_none()
            {
                return Err(error);
            }
            (self.dependencies.queue_tick)();
        }
        let assistant_key = format!("assistant:{}", text(&n["clientMessageId"])?);
        let error_key = format!("error:{}", text(&n["clientMessageId"])?);
        let task_chat = !standalone && context["chat"]["experience"] == "task";
        let existing_assistant = if task_chat {
            None
        } else {
            self.chats
                .message_by_idempotency_key(owner, chat, &assistant_key, MessageKind::Encrypted)
                .await?
        };
        let existing_error = if task_chat {
            None
        } else {
            self.chats
                .message_by_idempotency_key(owner, chat, &error_key, MessageKind::Encrypted)
                .await?
        };
        if reported_ok {
            self.lanes
                .update_runtime(
                    chat,
                    text(&n["executionLaneId"])?,
                    result["threadId"].as_str(),
                    "ready",
                )
                .await?;
            if task_chat && operation.is_none() {
                let saved: Result<()> = async {
                    let encrypted = crate::settings::parse_response(
                        "taskMessageRelayResultSchema",
                        result.get("structuredResult"),
                    )?;
                    self.dependencies
                        .live
                        .write_message(
                            owner,
                            chat,
                            &encrypted["message"],
                            MessageOptions {
                                attribution: Some(&attribution),
                                kind: MessageKind::Task,
                                upsert: false,
                                routing: Some(&context["chat"]),
                            },
                        )
                        .await?;
                    Ok(())
                }
                .await;
                if saved.is_err() {
                    ok = false;
                }
            } else if standalone && existing_assistant.is_none() {
                let encrypted = crate::settings::parse_response(
                    "chatMessageRelayResultSchema",
                    result.get("structuredResult"),
                )?;
                anyhow::ensure!(
                    truthy(encrypted.get("message")),
                    "Standalone Chat outcome omitted protected content."
                );
                self.dependencies
                    .live
                    .write_message(
                        owner,
                        chat,
                        &encrypted["message"],
                        MessageOptions {
                            attribution: Some(&attribution),
                            kind: MessageKind::Encrypted,
                            upsert: false,
                            routing: None,
                        },
                    )
                    .await?;
            } else if operation.is_none() && existing_assistant.is_none() {
                let text = result
                    .get("text")
                    .filter(|v| truthy(Some(v)))
                    .cloned()
                    .unwrap_or_else(|| json!("The agent completed without a message."));
                self.write_visible(owner,chat,&json!({"role":"assistant","content":json!([json!({"type":"text","text":text,"phase":"final_answer"})]),"idempotencyKey":if existing_error.is_some(){&error_key}else{&assistant_key}}),&attribution).await?;
            }
        } else if !standalone && !task_chat && operation.is_none() && existing_assistant.is_none() {
            self.lanes
                .update_runtime(
                    chat,
                    text(&n["executionLaneId"])?,
                    context["lane"]["codexThreadId"].as_str(),
                    "ready",
                )
                .await?;
            self.write_visible(owner,chat,&json!({"role":"system","content":json!([json!({"type":"text","text":identifier(&[&json!("Agent failed: "),&n["outcome"]["error"]])})]),"idempotencyKey":error_key}),&attribution).await?;
        }
        self.finish(&input, ok, finalized).await
    }
    async fn write_visible(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: &Value,
    ) -> Result<()> {
        self.dependencies
            .live
            .write_message(
                owner,
                chat,
                input,
                MessageOptions {
                    attribution: Some(attribution),
                    kind: MessageKind::Plain,
                    upsert: true,
                    routing: None,
                },
            )
            .await?;
        Ok(())
    }
}
