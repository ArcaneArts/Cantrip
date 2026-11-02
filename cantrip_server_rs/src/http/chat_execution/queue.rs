use super::*;
impl Execution {
    pub(super) async fn list(&self, chat: &str) -> Result<Response> {
        if let Some(context) = self.chats.execution_context(&self.owner, chat).await?
            && managed(&context)
        {
            let state = self.queue.snapshot(&self.owner, chat).await?;
            return Ok(json_response(
                StatusCode::OK,
                json!({"revision":state["revision"],"items":state["items"],"pendingImports":state["pendingImports"],"claims":state["claims"]}),
            ));
        }
        output(
            200,
            "encryptedQueuedPromptListSchema",
            &json!(self.prompts.list_encrypted(&self.owner, chat).await?),
        )
    }
    pub(super) async fn add(&self, chat: &str, body: Option<&Value>) -> Result<Response> {
        let input = match parse("queuedPromptOpaqueContentSchema", body)? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let Some(context) = self.chats.execution_context(&self.owner, chat).await? else {
            return Ok(error(404, "Chat not found."));
        };
        let selected: Result<(Value, Value)> = async {
            let model = self
                .service
                .model_routing
                .resolve_model_id(&self.owner, &context, input.get("modelId"))
                .await?;
            Ok((
                model,
                self.attachments(&context, &input["classification"]["attachmentIds"])
                    .await?,
            ))
        }
        .await;
        let (model, attachments) = match selected {
            Ok(v) => v,
            Err(cause) => return Ok(error(409, message(&cause))),
        };
        if model != input["modelId"] {
            return Ok(error(409, "Selected model was not found."));
        }
        let prompt = match self.prompt_create(&context, &input, &attachments).await {
            Ok(v) => v,
            Err(cause) => return Ok(error(409, message(&cause))),
        };
        let Some(prompt) = prompt else {
            return Ok(error(404, "Chat not found."));
        };
        self.log("Chat prompt queued",json!({"event":"chat.queue.enqueued","subsystem":"chat-queue","operation":"enqueue-prompt","status":if truthy(prompt.get("frozen")){"frozen"}else{"queued"},"chatId":context["chatId"],"requestId":prompt["id"],"counts":json!({"attachments":prompt["attachments"].as_array().context("Queued attachments")?.len()})}));
        if !truthy(prompt.get("frozen")) {
            self.dispatch(chat);
        }
        output(201, "encryptedQueuedPromptSchema", &prompt)
    }
    pub(super) async fn reorder(&self, chat: &str, body: Option<&Value>) -> Result<Response> {
        let input = match parse("queuedPromptOrderSchema", body)? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        if let Some(context) = self.chats.execution_context(&self.owner, chat).await?
            && managed(&context)
        {
            if input.get("expectedRevision").is_none() || !truthy(input.get("operationId")) {
                return Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({"code":"queue-revision-required"}),
                ));
            }
            return match self.gui.mutate(&self.owner,&context,&json!({"kind":"reorder","ids":input["ids"]}),&json!({"operationId":input["operationId"],"expectedRevision":input["expectedRevision"]})).await {
                Ok(_)=>Ok(empty()),Err(cause)=>Ok(error(409,message(&cause)))
            };
        }
        if self.prompts.reorder(&self.owner, chat, &input).await? {
            self.service
                .chat_mutations
                .publish_invalidation(&self.owner, chat, "chat-queue", None);
            Ok(empty())
        } else {
            Ok(error(400, "Queued prompt order is invalid."))
        }
    }
}
