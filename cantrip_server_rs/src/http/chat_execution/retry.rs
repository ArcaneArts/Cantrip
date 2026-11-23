use super::*;
impl Execution {
    pub(super) async fn retry(
        &self,
        chat: &str,
        message_id: &str,
        body: Option<&Value>,
    ) -> Result<Response> {
        let input = match parse("encryptedChatTurnCreateSchema", body)? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let Some(context) = self.chats.execution_context(&self.owner, chat).await? else {
            return Ok(error(404, "Chat source not found."));
        };
        if context["experience"] == "task" {
            return Ok(error(
                409,
                "Task messages cannot be edited from the agent transcript.",
            ));
        }
        if let Some(existing) = self
            .chats
            .message_by_idempotency_key(
                &self.owner,
                chat,
                &text(&input["message"]["idempotencyKey"])?,
                MessageKind::Encrypted,
            )
            .await?
        {
            return output(
                200,
                "encryptedChatPromptSubmitResultSchema",
                &json!({"status":"started","message":existing}),
            );
        }
        if truthy(context.get("automationPaused")) {
            return Ok(error(
                409,
                "Resume the chat before editing its latest message.",
            ));
        }
        if executing(&context) {
            return Ok(error(
                409,
                "Interrupt or finish the active turn before editing it.",
            ));
        }
        if !truthy(context.get("threadId")) {
            return Ok(error(409, "This chat does not have a Codex turn to edit."));
        }
        let (latest, queued) = tokio::try_join!(
            self.chats.latest_encrypted_user_message(&self.owner, chat),
            self.prompts.list_encrypted(&self.owner, chat)
        )?;
        let Some(latest) = latest.filter(|v| v["id"] == message_id) else {
            return Ok(error(
                409,
                "Only the latest user message can be edited and sent again.",
            ));
        };
        if !queued.is_empty() {
            return Ok(error(
                409,
                "Remove queued prompts before editing the latest message.",
            ));
        }
        let replacement = &input["message"];
        if replacement["classification"]["role"] != "user"
            || replacement["classification"]["mode"] != latest["mode"]
            || replacement.get("reasoningEffort") != latest.get("reasoningEffort")
            || replacement["classification"]["attachmentIds"].stringify()
                != latest["attachmentIds"].stringify()
            || input.get("modelId") != latest.get("modelId")
        {
            return Ok(error(
                409,
                "An edited message must keep its original mode, model, reasoning, and attachments.",
            ));
        }
        if !self
            .service
            .workers
            .commands
            .is_connected(&text(&context["workerId"])?)
        {
            return Ok(error(503, "Project worker is offline."));
        }
        let runtime = match self
            .service
            .model_routing
            .runtime_for_context(&self.owner, &context)
            .await
        {
            Ok(runtime) => runtime,
            Err(cause) => return Ok(error(409, message(&cause))),
        };
        let Some(runtime) = runtime.filter(|v| {
            v["model"]["id"] == latest["modelId"] && v["routeId"] == latest["modelRouteId"]
        }) else {
            return Ok(error(
                409,
                "The original model route is unavailable for this message.",
            ));
        };
        let result: Result<Value> = async {
            let mut configuration = input["queuedPrompt"].clone();
            if let Value::Object(fields) = &mut configuration {
                fields.shift_remove("modelId");
            }
            copy(&mut configuration, &input, &["modelId"]);
            let mut options = start_options(replacement);
            options["retryMessageId"] = latest["id"].clone();
            options["runtimes"] = json!([runtime]);
            self.begin(
                &context,
                &start_fields(replacement, &configuration, "Edited encrypted prompt."),
                &options,
            )
            .await?;
            self.chats
                .message_by_idempotency_key(
                    &self.owner,
                    chat,
                    &text(&replacement["idempotencyKey"])?,
                    MessageKind::Encrypted,
                )
                .await?
                .context("Encrypted chat message was not saved.")
        }
        .await;
        match result {
            Ok(saved) => output(
                202,
                "encryptedChatPromptSubmitResultSchema",
                &json!({"status":"started","message":saved}),
            ),
            Err(cause) => turn_failure(&cause, true),
        }
    }
}
