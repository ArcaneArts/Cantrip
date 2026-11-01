use super::*;
impl Execution {
    pub(super) async fn submit(&self, chat: &str, body: Option<&Value>) -> Result<Response> {
        let input = match parse("encryptedChatTurnCreateSchema", body)? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let Some(context) = self.chats.execution_context(&self.owner, chat).await? else {
            return Ok(error(404, "Chat source not found"));
        };
        let task = context["experience"] == "task";
        let kind = if task {
            MessageKind::Task
        } else {
            MessageKind::Encrypted
        };
        if let Some(existing) = self
            .chats
            .message_by_idempotency_key(
                &self.owner,
                chat,
                &text(&input["message"]["idempotencyKey"])?,
                kind,
            )
            .await?
        {
            return started(200, &existing, task);
        }
        if context["contextKind"] == "standalone" {
            if !self
                .service
                .workers
                .commands
                .is_connected(&text(&context["workerId"])?)
            {
                return Ok(json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"code":"standalone-worker-offline","error":"This Chat's worker is offline. History remains available."}),
                ));
            }
            if context["scratchRootStatus"] != "ready" {
                let detail = match context["scratchRootStatus"].as_str() {
                    Some("failed") => {
                        "This Chat's scratch folder could not be prepared. Retry provisioning before sending."
                    }
                    Some("provisioning") => "This Chat's scratch folder is still being prepared.",
                    _ => "This Chat's scratch folder is unavailable.",
                };
                return Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({"code":"standalone-scratch-unavailable","error":detail}),
                ));
            }
        }
        if truthy(context.get("automationPaused")) || executing(&context) {
            let result: Result<Option<Value>> = async {
                self.service
                    .model_routing
                    .resolve_model_id(&self.owner, &context, input.get("modelId"))
                    .await?;
                let attachments = self
                    .attachments(
                        &context,
                        &input["queuedPrompt"]["classification"]["attachmentIds"],
                    )
                    .await?;
                self.prompt_create(&context, &input["queuedPrompt"], &attachments)
                    .await
            }
            .await;
            return match result {
                Err(cause) => Ok(error(409, message(&cause))),
                Ok(None) => Ok(error(404, "Chat not found.")),
                Ok(Some(prompt)) => {
                    self.log("Chat prompt queued behind active work",json!({"event":"chat.queue.enqueued","subsystem":"chat-queue","operation":"enqueue-prompt","status":"queued","chatId":context["chatId"],"projectId":context["projectId"],"workerId":context["workerId"],"requestId":prompt["id"],"counts":json!({"attachments":prompt["attachments"].as_array().context("Queued attachments")?.len()}),"reasonCode":if truthy(context.get("automationPaused")){"automation-paused"}else{"turn-active"}}));
                    if managed(&context) {
                        self.dispatch(chat);
                    }
                    output(
                        202,
                        "encryptedChatPromptSubmitResultSchema",
                        &json!({"status":"queued","prompt":prompt}),
                    )
                }
            };
        }
        let result: Result<Value> = async {
            let mut configuration = input["queuedPrompt"].clone();
            if let Value::Object(fields) = &mut configuration {
                fields.shift_remove("modelId");
            }
            copy(&mut configuration, &input, &["modelId"]);
            self.begin(
                &context,
                &start_fields(&input["message"], &configuration, "Encrypted prompt."),
                &start_options(&input["message"]),
            )
            .await?;
            self.chats
                .message_by_idempotency_key(
                    &self.owner,
                    chat,
                    &text(&input["message"]["idempotencyKey"])?,
                    kind,
                )
                .await?
                .context("Encrypted chat message was not saved.")
        }
        .await;
        match result {
            Ok(saved) => started(202, &saved, task),
            Err(cause) => turn_failure(&cause, false),
        }
    }
}
fn started(status: u16, message: &Value, task: bool) -> Result<Response> {
    let mut value = json!({"status":"started","message":message});
    if task {
        value["kind"] = json!("task-encrypted");
    }
    output(
        status,
        "encryptedConversationPromptSubmitResultSchema",
        &value,
    )
}
