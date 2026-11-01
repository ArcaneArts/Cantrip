use super::*;
use crate::chats::live_mutations::MessageOptions;

fn native_user(prompt: &Value) -> Value {
    prompt
        .get("nativeClientUserMessageId")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| {
            json!(format!(
                "cantrip:{}",
                prompt["pendingMessage"]["id"]
                    .as_str()
                    .expect("Queued message identity")
            ))
        })
}
fn claim_key(operation: &Value) -> Result<Value> {
    let suffix = crate::wire::coercion::string(operation)
        .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?;
    let mut units = "steer:".encode_utf16().collect::<Vec<_>>();
    units.extend_from_slice(suffix.units());
    Ok(Value::String(crate::wire::JsString::new(units)))
}
impl Execution {
    async fn append(
        &self,
        chat: &str,
        prompt: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        self.service
            .chat_mutations
            .write_message(
                &self.owner,
                chat,
                prompt,
                MessageOptions {
                    attribution,
                    kind: MessageKind::Encrypted,
                    upsert: false,
                    routing: None,
                },
            )
            .await
    }
    pub(super) async fn steer(&self, id: &str, body: Option<&Value>) -> Result<Response> {
        let Some(queued) = self.prompts.get_encrypted(&self.owner, id).await? else {
            return Ok(error(404, "Queued prompt not found."));
        };
        let chat = text(&queued["chatId"])?;
        let control = self.native.control_context(&self.owner, &chat).await?;
        let Some(mut context) = control.get("context").filter(|v| !v.is_null()).cloned() else {
            return Ok(error(404, "Chat not found."));
        };
        if context["experience"] == "task" {
            return Ok(error(
                409,
                "Queued prompts are unavailable for encrypted Tasks.",
            ));
        }
        let is_managed = managed(&context);
        let default = object();
        let body = body.unwrap_or(&default);
        let claim = if is_managed {
            let revision = body["expectedItemRevision"].as_f64().unwrap_or(f64::NAN);
            if !revision.is_finite()
                || revision.fract() != 0.0
                || !(0.0..=9_007_199_254_740_991.0).contains(&revision)
                || !truthy(body.get("operationId"))
            {
                return Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({"code":"queue-revision-required"}),
                ));
            }
            let claimed: Result<Value> = async {
                self.queue
                    .claim_item(
                        &self.owner,
                        &chat,
                        &queued["id"],
                        &json!(revision),
                        &claim_key(&body["operationId"])?,
                    )
                    .await
            }
            .await;
            match claimed {
                Ok(v) => Some(v),
                Err(cause) => return Ok(error(409, message(&cause))),
            }
        } else {
            None
        };
        if claim.as_ref().is_some_and(|c| c["status"] == "consumed") {
            let existing = self
                .chats
                .message_by_idempotency_key(
                    &self.owner,
                    &chat,
                    &text(&queued["pendingMessage"]["idempotencyKey"])?,
                    MessageKind::Encrypted,
                )
                .await?;
            let saved = if existing.is_some() {
                existing
            } else {
                self.append(&chat, &queued["pendingMessage"], None).await?
            };
            return match saved {
                Some(saved) => output(
                    200,
                    "encryptedChatPromptSteerResultSchema",
                    &json!({"steered":true,"message":saved}),
                ),
                None => Ok(error(404, "Chat not found.")),
            };
        }
        let result:Result<Value>=async {
            let saved=if executing(&context) {
                anyhow::ensure!(queued["classification"]["mode"]=="default","Plan and Goal mode prompts cannot steer an active turn. Leave this prompt queued for the next turn.");
                anyhow::ensure!(!truthy(queued.get("worktreeId")) || queued["worktreeId"]==context["worktreeId"],"This prompt is pinned to another worktree and cannot steer the active turn.");
                let worker=text(&context["workerId"])?;
                anyhow::ensure!(self.service.workers.commands.is_connected(&worker),"The active Codex thread is unavailable.");
                let native=truthy(control.get("activationGeneration"));
                let runtime=if native {None} else {self.service.model_routing.runtime_for_context(&self.owner,&context).await?};
                anyhow::ensure!(native || runtime.is_some(),"Selected model was not found.");
                let attachments=self.attachments(&context,&queued["classification"]["attachmentIds"]).await?;
                let applied=if let Some(claim)=claim.as_ref().filter(|c|truthy(c.get("operationId")) && truthy(c.get("operationGeneration"))) {
                    self.native.get(&self.owner,&worker,&text(&claim["operationId"])?,&text(&claim["operationGeneration"])?).await?["status"]=="applied"
                } else {false};
                if !applied {
                    let mut command=if native {
                        json!({"type":"chat.native-control","chatId":context["chatId"],"threadId":context["threadId"],"nativeActivationGeneration":control["activationGeneration"],"nativeRuntimeGeneration":control["runtimeGeneration"],"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"control":json!({"kind":"steer","protectedPrompt":queued["pendingMessage"],"attachments":attachments})})
                    } else {
                        let runtime=runtime.as_ref().context("Steering runtime")?;
                        json!({"type":"chat.steer","executionProfile":if context["contextKind"]=="standalone"{"standalone-chat"}else{"ide"},"chatId":context["chatId"],"threadId":context["threadId"],"protectedPrompt":queued["pendingMessage"],"attachments":attachments,"model":runtime["model"],"provider":runtime["provider"]})
                    };
                    if let Some(claim)=&claim {
                        command["operationId"]=body["operationId"].clone();
                        command["queueClaim"]=json!({"id":claim["id"],"promptRevision":claim["promptRevision"]});
                        command["nativeClientUserMessageId"]=native_user(&queued);
                        if native {
                            copy(&mut command,&queued,&["protectedNativeInput"]);
                            command["queuedPromptId"]=queued["id"].clone();
                        }
                    }
                    self.service.workers.commands.request(&worker,command,None,None).await?;
                }
                let attribution=truthy(context.get("executionLaneId")).then(|| {
                    let standalone=context["contextKind"]=="standalone";
                    json!({"contextKind":if standalone {"standalone"}else{"project"},"executionLaneId":context["executionLaneId"],"worktreeId":if standalone {Value::Null}else{context["worktreeId"].clone()},"scratchRootId":if standalone {context["scratchRootId"].clone()}else{Value::Null}})
                });
                self.append(&chat,&queued["pendingMessage"],attribution.as_ref()).await?.context("Chat not found.")?
            } else if claim.is_some() {
                self.service.execution.recovery.dispatch(&self.owner,&chat).await?;
                self.chats.message_by_idempotency_key(&self.owner,&chat,&text(&queued["pendingMessage"]["idempotencyKey"])?,MessageKind::Encrypted).await?.context("The queued action is still pending; its durable claim was retained.")?
            } else {
                if truthy(queued.get("worktreeId")) && queued["worktreeId"]!=context["worktreeId"] {
                    anyhow::ensure!(context["contextKind"]=="project","Standalone Chat prompts cannot target project worktrees.");
                    self.chats.update_worktree(&self.owner,&chat,&json!({"worktreeId":queued["worktreeId"],"mode":context["worktreeMode"]}),None).await?;
                    context=self.chats.execution_context(&self.owner,&chat).await?.context("Worktree could not be selected.")?;
                }
                let mut turn=json!({"text":"Encrypted queued prompt.","attachmentIds":queued["classification"]["attachmentIds"],"mode":queued["classification"]["mode"],"idempotencyKey":queued["pendingMessage"]["idempotencyKey"]});
                copy(&mut turn,&queued,&["modelId","reasoningEffort","customSubagentModel","subagentModelId","subagentReasoningEffort"]);
                self.begin(&context,&turn,&start_options(&queued["pendingMessage"])).await?;
                self.chats.message_by_idempotency_key(&self.owner,&chat,&text(&queued["pendingMessage"]["idempotencyKey"])?,MessageKind::Encrypted).await?.context("Encrypted chat message was not saved.")?
            };
            if !is_managed {self.service.chat_mutations.delete_queued_prompt(&self.owner,&text(&queued["id"])?).await?;}
            self.log("Queued prompt steered into chat",json!({"event":"chat.queue.steered","subsystem":"chat-queue","operation":"steer","status":"completed","chatId":context["chatId"],"projectId":context["projectId"],"workerId":context["workerId"],"requestId":queued["id"]}));
            Ok(saved)
        }.await;
        match result {
            Ok(saved) => output(
                200,
                "encryptedChatPromptSteerResultSchema",
                &json!({"steered":true,"message":saved}),
            ),
            Err(cause) => {
                if let Some(claim) = claim {
                    self.queue
                        .release_unadmitted(&self.owner, &chat, &text(&claim["id"])?)
                        .await?;
                }
                Ok(configuration_failure(&cause)?.unwrap_or_else(|| error(409, message(&cause))))
            }
        }
    }
}
