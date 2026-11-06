//! Ordered Task controls use the current canonical source after every await.
use super::*;

impl Service {
    pub fn interrupt_task(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        self.operations.run(async move {
            let original = this.chats.request_task_pause(&owner,&chat,true,None).await?
                .ok_or_else(||failure(404,"Task source not found."))?;
            let result = async {
                crate::native_handoffs::service::settle_task_control(&this.handoffs,&this.commands,&owner,&chat).await?;
                let current = this.chats.fence_task_interrupt(&owner,&chat,
                    original["scope"]["revision"].as_i64().context("Task interrupt revision")? as i32).await?;
                let Some(current) = current.filter(|v|v["paused"]==true && v["scope"]["revision"]==original["scope"]["revision"]) else {
                    return Ok(json!({"interrupted":false}));
                };
                let result = this.commands.request_with_timeout(&text(&current["scope"]["workerId"])?,
                    json!({"type":"chat.interrupt","chatId":chat,"threadId":current["scope"]["threadId"],"task":current["scope"]}),RequestTimeout::Disabled,None).await?;
                crate::settings::parse_response("chatInterruptAcceptedSchema",result.as_ref())
            }.await;
            this.publish_task_pause(&owner,&chat,&original);
            result.map_err(|cause|wrapped(502,"The worker could not confirm this Task interruption: ",&cause))
        })
    }
    fn publish_task_pause(&self, owner: &str, chat: &str, intent: &Value) {
        self.live
            .publish_summary(owner, &json!(chat), &intent["scope"]["projectId"]);
    }
    async fn send_task_pause(&self, chat: &str, intent: &Value, wait: bool) -> Result<Value> {
        let response = self.commands.request_with_timeout(
            &text(&intent["scope"]["workerId"])?,
            json!({"type":"chat.pause.set","chatId":chat,"paused":intent["paused"],"task":intent["scope"],"waitForBoundary":wait}),
            RequestTimeout::Disabled, None,
        ).await?;
        crate::settings::parse_response("chatPauseRuntimeStateSchema", response.as_ref())
    }
    async fn rollback_task_resume(
        &self,
        owner: &str,
        chat: &str,
        intent: &Value,
        original_revision: &Value,
    ) -> Result<()> {
        if intent["paused"] != false || &intent["scope"]["revision"] != original_revision {
            return Ok(());
        }
        let revision = intent["scope"]["revision"]
            .as_f64()
            .context("Task pause revision")? as i32;
        if let Some(restored) = self
            .chats
            .request_task_pause(owner, chat, true, Some(revision))
            .await?
        {
            self.publish_task_pause(owner, chat, &restored);
            // Durable notice retries a lost application; this receipt is intent
            // acceptance, never proof that an active model has already stopped.
            let _ = self.send_task_pause(chat, &restored, false).await;
        }
        Ok(())
    }
    pub(super) async fn set_task_pause(
        &self,
        owner: &str,
        chat: &str,
        paused: bool,
        resume: bool,
    ) -> Result<Value> {
        let mut intent = self
            .chats
            .request_task_pause(owner, chat, paused, None)
            .await?
            .ok_or_else(|| failure(404, "Task source not found."))?;
        let original_revision = intent["scope"]["revision"].clone();
        let active;
        loop {
            let result: Result<(Value, Value)> = async {
                crate::native_handoffs::service::settle_task_control(
                    &self.handoffs,
                    &self.commands,
                    owner,
                    chat,
                )
                .await?;
                intent = self
                    .chats
                    .task_pause_intent(owner, chat)
                    .await?
                    .ok_or_else(|| failure(404, "Task source not found."))?;
                let receipt = self.send_task_pause(chat, &intent, true).await?;
                let latest = self
                    .chats
                    .task_pause_intent(owner, chat)
                    .await?
                    .ok_or_else(|| failure(404, "Task source not found."))?;
                Ok((receipt, latest))
            }
            .await;
            let (receipt, latest) = match result {
                Ok(value) => value,
                Err(error) => {
                    self.rollback_task_resume(owner, chat, &intent, &original_revision)
                        .await?;
                    self.publish_task_pause(owner, chat, &intent);
                    return Err(wrapped(
                        502,
                        "The worker could not confirm this Task control: ",
                        &error,
                    ));
                }
            };
            if intent != latest {
                intent = latest;
                continue;
            }
            if receipt["paused"] != intent["paused"] {
                self.rollback_task_resume(owner, chat, &intent, &original_revision)
                    .await?;
                return Err(failure(
                    502,
                    "The current native Task pause intent was not acknowledged.",
                ));
            }
            active = receipt["active"].clone();
            break;
        }
        self.publish_task_pause(owner, chat, &intent);
        if resume
            && intent["paused"] == false
            && active.is_null()
            && intent["scope"]["revision"] == original_revision
            && let Err(error) = self.goals.resume(owner, chat, false, false).await
        {
            self.rollback_task_resume(owner, chat, &intent, &original_revision)
                .await?;
            return Err(wrapped(409, "The Task could not continue: ", &error));
        }
        let latest = self.chats.task_pause_intent(owner, chat).await?;
        Ok(json!({"paused":latest.as_ref().unwrap_or(&intent)["paused"],"active":active}))
    }
}
