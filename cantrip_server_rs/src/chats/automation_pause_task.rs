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
            let lock = {
                let mut controls = this.stop_controls.lock().unwrap();
                controls.retain(|_, lock|lock.strong_count() > 0);
                let entry = controls.entry((owner.clone(), chat.clone())).or_default();
                entry.upgrade().unwrap_or_else(|| {let lock = Arc::new(tokio::sync::Mutex::new(())); *entry = Arc::downgrade(&lock); lock})
            };
            let _stop = lock.lock().await;
            let mut stopping = this.native.prepare_task_stop(&owner, &chat).await?;
            if stopping.as_ref().is_some_and(|state|state["stop"].is_null()) {return Ok(json!({"interrupted":true}));}
            let original = this.chats.request_task_pause(&owner,&chat,true,None).await?
                .ok_or_else(||failure(404,"Task source not found."))?;
            let result = async {
                crate::native_handoffs::service::settle_task_control(&this.handoffs,&this.commands,&owner,&chat).await?;
                let current = this.chats.fence_task_interrupt(&owner,&chat,
                    original["scope"]["revision"].as_i64().context("Task interrupt revision")? as i32).await?;
                let Some(current) = current.filter(|v|v["paused"]==true && v["scope"]["revision"]==original["scope"]["revision"]) else {
                    return Ok(json!({"interrupted":false}));
                };
                stopping = this.native.prepare_task_stop(&owner, &chat).await?;
                if let Some(prepared) = &stopping {
                    if prepared["stop"].is_null() {return Ok(json!({"interrupted":true}));}
                    let handler = this.task_stop.lock().unwrap().clone().context("Task Stop service unavailable")?;
                    return handler(owner.clone(), chat.clone(), prepared["state"].clone(), current).await;
                }
                let result = this.commands.request_with_timeout(&text(&current["scope"]["workerId"])?,
                    json!({"type":"chat.interrupt","chatId":chat,"threadId":current["scope"]["threadId"],"task":current["scope"]}),RequestTimeout::Disabled,None).await?;
                crate::settings::parse_response("chatInterruptAcceptedSchema",result.as_ref())
            }.await;
            if result.is_err() && let Some(stopping) = stopping {
                let _ = this.native.fail_suspension_control(&owner, &chat, &stopping["state"],
                    &json!({"code":"stop-failed","protectedDetails":Value::Null})).await;
            }
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
        crate::settings::parse_response("taskPauseRuntimeStateSchema", response.as_ref())
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
        let mut suspension: Option<Value> = None;
        let mut restored = None;
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
                suspension = None;
                if !intent["scope"]["taskRound"].is_null() {
                    let previous = self.chats.native_suspension(owner, chat).await?;
                    if intent["paused"] == false
                        && previous
                            .as_ref()
                            .is_some_and(|state| state["phase"] == "running")
                    {
                        suspension = previous;
                    } else if intent["paused"] == true
                        || previous
                            .as_ref()
                            .is_some_and(|state| !state["checkpoint"].is_null())
                    {
                        suspension = Some(
                            self.native
                                .request_task_suspension(owner, chat, &intent)
                                .await?,
                        );
                        self.publish_task_pause(owner, chat, &intent);
                    }
                }
                if intent["paused"] == false
                    && suspension
                        .as_ref()
                        .is_some_and(|state| !state["checkpoint"].is_null())
                {
                    let handler = self.task_resume.lock().unwrap().clone();
                    if let Some(handler) = handler {
                        let result = handler(
                            owner.to_owned(),
                            chat.to_owned(),
                            suspension.as_ref().unwrap().clone(),
                            intent.clone(),
                        )
                        .await?;
                        restored = Some(result.clone());
                        return Ok((result, intent.clone()));
                    }
                }
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
                    if error
                        .downcast_ref::<crate::native_commands::CommandError>()
                        .is_some_and(|error| error.code == "suspension-control-stale")
                    {
                        if let Some(latest) = self.chats.task_pause_intent(owner, chat).await? {
                            if latest != intent {
                                intent = latest;
                                continue;
                            }
                        }
                    }
                    if let Some(state) = suspension.as_ref().filter(|state| {
                        matches!(state["phase"].as_str(), Some("pausing" | "resuming"))
                    }) {
                        let _ = self.native.fail_suspension_control(owner, chat, state,
                            &json!({"code":if intent["paused"]==true {"pause-failed"} else {"restore-failed"},"protectedDetails":Value::Null})).await;
                    }
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
            if let Some(restored) = restored {
                return Ok(restored);
            }
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
            if let Some(state) = &suspension {
                match self
                    .native
                    .acknowledge_task_suspension(owner, chat, &intent, state, &receipt)
                    .await
                {
                    Ok(state) => suspension = Some(state),
                    Err(error) => {
                        let _ = self.native.fail_suspension_control(owner, chat, state,
                            &json!({"code":if intent["paused"]==true {"pause-failed"} else {"restore-failed"},"protectedDetails":Value::Null})).await;
                        self.rollback_task_resume(owner, chat, &intent, &original_revision)
                            .await?;
                        return Err(wrapped(
                            502,
                            "The worker could not confirm this Task control: ",
                            &error,
                        ));
                    }
                }
            }
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
        let mut result =
            json!({"paused":latest.as_ref().unwrap_or(&intent)["paused"],"active":active});
        if let Some(state) = suspension {
            result["nativeSuspension"] = crate::chats::native_suspensions::stored_summary(&state);
        }
        Ok(result)
    }
}
