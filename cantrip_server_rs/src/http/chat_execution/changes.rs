use super::*;
use sha2::{Digest, Sha256};
impl Execution {
    pub(super) async fn update(&self, id: &str, body: Option<&Value>) -> Result<Response> {
        let input = match parse("encryptedQueuedPromptUpdateSchema", body)? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let Some(current) = self.prompts.get_encrypted(&self.owner, id).await? else {
            return Ok(error(404, "Queued prompt not found."));
        };
        let chat = text(&current["chatId"])?;
        let Some(context) = self.chats.execution_context(&self.owner, &chat).await? else {
            return Ok(error(404, "Chat not found."));
        };
        let attachments = match self
            .attachments(
                &context,
                &input["prompt"]["classification"]["attachmentIds"],
            )
            .await
        {
            Ok(v) => v,
            Err(cause) => return Ok(error(409, message(&cause))),
        };
        if managed(&context) {
            if input.get("expectedItemRevision").is_none() || !truthy(input.get("operationId")) {
                return Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({"code":"queue-revision-required"}),
                ));
            }
            let result:Result<Value>=async {
                let original=json!({"kind":"update","id":id,"expectedItemRevision":input["expectedItemRevision"],"prompt":input["prompt"],"attachments":attachments});
                let options=json!({"operationId":input["operationId"]});
                if let Some(prior)=self.gui.lookup(&self.owner,&context,&original,&options).await? {return Ok(prior["acceptedItem"].clone());}
                let normalized=if truthy(input["prompt"].get("protectedNativeInput")) {
                    let response=self.service.workers.commands.request(&text(&context["workerId"])?,json!({"type":"chat.queue.prepare","chatId":context["chatId"],"prompt":input["prompt"],"attachments":attachments}),None,None).await?;
                    crate::settings::parse_response("queuedPromptOpaqueContentSchema",response.as_ref())?
                } else {input["prompt"].clone()};
                let mut mutation=original.clone();mutation["prompt"]=normalized;
                let result=self.gui.mutate(&self.owner,&context,&mutation,&json!({"operationId":input["operationId"],"payloadDigest":format!("{:x}",Sha256::digest(original.stringify().as_bytes()))})).await?;
                let prompt=&result["acceptedItem"];
                if truthy(Some(prompt)) && !truthy(prompt.get("frozen")) {self.dispatch(&text(&prompt["chatId"])?);}
                Ok(prompt.clone())
            }.await;
            return match result {
                Ok(v) => Ok(json_response(StatusCode::OK, v)),
                Err(cause) => Ok(error(409, message(&cause))),
            };
        }
        let prompt = self
            .prompts
            .replace_encrypted(&self.owner, &json!(id), &input["prompt"], &attachments)
            .await?;
        let Some(prompt) = prompt else {
            return Ok(error(404, "Queued prompt not found."));
        };
        if !truthy(prompt.get("frozen")) {
            self.dispatch(&text(&prompt["chatId"])?);
        }
        output(200, "encryptedQueuedPromptSchema", &prompt)
    }
    pub(super) async fn delete(&self, id: &str, query: &Value) -> Result<Response> {
        let current = self.prompts.get_encrypted(&self.owner, id).await?;
        let context = if let Some(current) = current {
            self.chats
                .execution_context(&self.owner, &text(&current["chatId"])?)
                .await?
        } else {
            None
        };
        if let Some(context) = context
            && managed(&context)
        {
            let revision = crate::wire::coercion::number(query.get("expectedItemRevision"))
                .unwrap_or(f64::NAN);
            if query.get("expectedItemRevision").is_none()
                || !revision.is_finite()
                || revision.fract() != 0.0
                || !(0.0..=9_007_199_254_740_991.0).contains(&revision)
                || !truthy(query.get("operationId"))
            {
                return Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({"code":"queue-revision-required"}),
                ));
            }
            return match self
                .gui
                .mutate(
                    &self.owner,
                    &context,
                    &json!({"kind":"delete","id":id,"expectedItemRevision":revision}),
                    &json!({"operationId":query["operationId"]}),
                )
                .await
            {
                Ok(_) => Ok(empty()),
                Err(cause) => Ok(error(409, message(&cause))),
            };
        }
        Ok(
            if self
                .service
                .chat_mutations
                .delete_queued_prompt(&self.owner, id)
                .await?
                .is_some()
            {
                empty()
            } else {
                error(404, "Queued prompt not found.")
            },
        )
    }
}
