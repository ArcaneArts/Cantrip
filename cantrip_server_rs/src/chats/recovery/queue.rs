use super::*;
use crate::{
    chats::{
        live_mutations::MessageOptions,
        managed_console::{permission_profile, session_context},
        message_queries::MessageKind,
    },
    workers::command_bus::RequestTimeout,
};
impl Service {
    /// Admission and coalescing happen before returning the owned future.
    pub fn dispatch(&self, owner: &str, chat: &str) -> BoxFuture<'static, Result<()>> {
        {
            let mut state = self.state.lock().unwrap();
            if !state.dispatching.insert(chat.to_owned()) {
                state.pending.insert(chat.to_owned());
                return async { Ok(()) }.boxed();
            }
        }
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        self.operations.run(async move {
            let result = this.dispatch_one(&owner, &chat).await;
            let repeat = {
                let mut state = this.state.lock().unwrap();
                state.dispatching.remove(&chat);
                state.pending.remove(&chat)
            };
            if repeat {
                drop(this.dispatch(&owner, &chat));
            }
            result
        })
    }
    async fn dispatch_one(&self, owner: &str, chat: &str) -> Result<()> {
        let mut claim = None;
        let result = self.execute_next(owner, chat, &mut claim).await;
        if let Err(error) = result {
            if let Some(claim) = claim {
                self.queue
                    .release_unadmitted(owner, chat, &text(&claim["id"])?)
                    .await?;
            }
            self.log("error","Queued prompt dispatch failed",json!({"event":"chat.queue.dispatch-failed","subsystem":"chat-queue","operation":"dispatch-prompt","reasonCode":"dispatch-failed","status":"failed","chatId":chat,"err":logging::error_details(&error)}));
        }
        Ok(())
    }
    async fn execute_next(&self, owner: &str, chat: &str, claim: &mut Option<Value>) -> Result<()> {
        let Some(mut context) = self
            .chats
            .execution_context(owner, chat)
            .await?
            .filter(|c| !truthy(c.get("automationPaused")) && !executing(c))
        else {
            return Ok(());
        };
        let managed = session_context(&context).is_some();
        if managed
            && self
                .prompts
                .list_encrypted(owner, chat)
                .await?
                .iter()
                .any(|p| !truthy(p.get("frozen")))
        {
            context = (self.dependencies.prepare_account)(owner.to_owned(), context).await?;
        }
        *claim = if managed {
            self.queue.claim_next(owner, chat).await?
        } else {
            None
        };
        if managed && claim.is_none() {
            return Ok(());
        }
        let prompt = if let Some(claim) = claim.as_ref() {
            self.prompts
                .get_encrypted(owner, &text(&claim["promptId"])?)
                .await?
        } else {
            self.prompts
                .list_encrypted(owner, chat)
                .await?
                .into_iter()
                .find(|p| !truthy(p.get("frozen")))
        };
        let Some(prompt) = prompt else { return Ok(()) };
        self.log("info","Queued prompt is being dispatched",json!({"event":"chat.queue.dispatching","subsystem":"chat-queue","operation":"dispatch-prompt","status":"dispatching","chatId":chat,"requestId":prompt["id"]}));
        if context["contextKind"] == "project"
            && truthy(prompt.get("worktreeId"))
            && prompt.get("worktreeId") != context.get("worktreeId")
        {
            self.chats
                .update_worktree(
                    owner,
                    chat,
                    &json!({"worktreeId":prompt["worktreeId"],"mode":context["worktreeMode"]}),
                    None,
                )
                .await?;
            let Some(next) = self.chats.execution_context(owner, chat).await? else {
                return Ok(());
            };
            context = next;
        }
        let method = prompt
            .get("executionMethod")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| {
                json!(if prompt["classification"]["mode"] == "goal" {
                    "thread/goal/set"
                } else {
                    "turn/start"
                })
            });
        if let Some(claim) = claim.as_ref().filter(|_| method != "turn/start") {
            return self
                .execute_native_action(owner, chat, &prompt, claim, &method)
                .await;
        }
        let mut input = json!({"text":"Encrypted queued prompt.","attachmentIds":prompt["classification"]["attachmentIds"],"mode":prompt["classification"]["mode"],"idempotencyKey":prompt["pendingMessage"]["idempotencyKey"]});
        copy_fields(
            &mut input,
            &prompt,
            &[
                "modelId",
                "reasoningEffort",
                "customSubagentModel",
                "subagentModelId",
                "subagentReasoningEffort",
            ],
        );
        let mut options = json!({"encryptedChatMessages":json!({"userMessage":prompt["pendingMessage"],"response":json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":super::super::turn_runtime::events::identifier(&[&json!("assistant:"),&prompt["pendingMessage"]["id"]])})})});
        if let Some(claim) = claim.as_ref() {
            options["managedQueueClaim"] =
                json!({"id":claim["id"],"promptRevision":claim["promptRevision"]});
            copy_fields(
                &mut options,
                &prompt,
                &["protectedNativeInput", "nativeClientUserMessageId"],
            );
            options["queuedPromptId"] = prompt["id"].clone();
        }
        (self.dependencies.begin)(owner.to_owned(), context, input, options).await?;
        if claim.is_none() {
            self.dependencies
                .live
                .delete_queued_prompt(owner, &text(&prompt["id"])?)
                .await?;
        }
        Ok(())
    }
    async fn execute_native_action(
        &self,
        owner: &str,
        chat: &str,
        prompt: &Value,
        claim: &Value,
        method: &Value,
    ) -> Result<()> {
        let mut configuration = object();
        copy_fields(
            &mut configuration,
            prompt,
            &[
                "modelId",
                "reasoningEffort",
                "customSubagentModel",
                "subagentModelId",
                "subagentReasoningEffort",
            ],
        );
        self.chats
            .set_model_configuration(owner, chat, &configuration)
            .await?;
        let context = self
            .chats
            .execution_context(owner, chat)
            .await?
            .context("The queued chat is no longer available.")?;
        let runtimes = self
            .dependencies
            .routing
            .available_runtimes(owner, &context, &text(&prompt["modelId"])?)
            .await?;
        let runtime = runtimes
            .first()
            .context("The queued action model is unavailable.")?;
        let launch = self
            .dependencies
            .console
            .prepare_launch(owner, &context, runtime)
            .await?;
        self.dependencies
            .live
            .write_message(
                owner,
                chat,
                &prompt["pendingMessage"],
                MessageOptions {
                    attribution: None,
                    kind: MessageKind::Encrypted,
                    upsert: false,
                    routing: None,
                },
            )
            .await?;
        let mut command = json!({"type":"chat.queue.execute","attachments":prompt["attachments"],"session":launch["session"],"subagentDefaults":launch["subagentDefaults"],"mcpServers":launch.get("mcpServers").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(Vec::<Value>::new())),"planMode":launch.get("planMode").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!("default")),"executionProfile":"ide","chatId":chat,"cwd":context["cwd"],"threadId":launch["threadId"],"model":launch["model"],"provider":launch["provider"],"permissionProfileId":permission_profile(&context)["effectiveId"],"queueClaim":json!({"id":claim["id"],"promptRevision":claim["promptRevision"]}),"queuedPromptId":prompt["id"],"protectedPrompt":prompt["pendingMessage"],"executionMethod":method});
        copy_fields(
            &mut command,
            prompt,
            &[
                "protectedNativeInput",
                "nativeClientUserMessageId",
                "nativeAction",
            ],
        );
        self.dependencies
            .commands
            .request_with_timeout(
                &text(&context["workerId"])?,
                command,
                RequestTimeout::Default,
                None,
            )
            .await?;
        Ok(())
    }
}
