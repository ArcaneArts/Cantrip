use super::*;
impl Service {
    pub fn continue_worktree(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        input: &Value,
        retained: Option<&Value>,
    ) -> BoxFuture<'static, Result<bool>> {
        let (this, owner, context, input, retained) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            input.clone(),
            retained.cloned(),
        );
        self.operations.run(async move {
            this.continue_worktree_one(&owner, &context, &input, retained.as_ref())
                .await
        })
    }
    async fn continue_worktree_one(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        input: &Value,
        retained: Option<&Value>,
    ) -> Result<bool> {
        let chat = text(&context["chatId"])?;
        let Some(task) = self.tasks.get(owner, &chat).await?.filter(|t| {
            truthy(t.get("planGoalEnabled")) && truthy(t.get("implementationStartedAt"))
        }) else {
            return Ok(false);
        };
        if task["state"] == "complete" {
            return Ok(true);
        }
        anyhow::ensure!(
            !truthy(context.get("automationPaused")),
            "The Task is paused."
        );
        let dispatch = &task["dispatch"];
        anyhow::ensure!(
            truthy(Some(dispatch)),
            "The Task implementation dispatch is unavailable."
        );
        let operation = self
            .tasks
            .get_operation_context(
                owner,
                &chat,
                &json!({"operationId":dispatch["operationId"]}),
            )
            .await?
            .filter(|o| o["round"]["kind"] == "finalize" && truthy(o["relayResult"].get("goal")))
            .context("The saved approved Task Goal is unavailable.")?;
        let lease = if let Some(retained) = retained {
            retained.clone()
        } else if let Some(lease) = goal_dispatch_lease(&task)? {
            lease
        } else {
            self.dispatch
                .recover_started_goal(
                    owner,
                    dispatch,
                    &self.continuation_owner,
                    &json!({"allowSettled":true}),
                )
                .await?
        };
        self.retain_one(&lease).await?;
        let result: Result<bool> = async {
            let mut protected_input = input.clone();
            protected_input["mode"] = json!("goal");
            let protected = self
                .protection
                .protect(
                    &text(&context["workerId"])?,
                    &protected_input,
                    &[],
                    context.get("reasoningEffort"),
                    Some(&json!("system")),
                )
                .await?;
            let user = self
                .request(
                    &context["workerId"],
                    json!({"type":"task.message.protect","message":protected}),
                    "taskMessageOpaqueContentSchema",
                )
                .await?;
            let before: Before = Arc::new({
                let (this, owner, chat, dispatch) = (
                    self.clone(),
                    owner.to_owned(),
                    chat.clone(),
                    dispatch.clone(),
                );
                move |result| {
                    let (this, owner, chat, dispatch) =
                        (this.clone(), owner.clone(), chat.clone(), dispatch.clone());
                    async move {
                        let latest = this
                            .tasks
                            .get(&owner, &chat)
                            .await?
                            .filter(|t| {
                                t["dispatch"].get("id") == dispatch.get("id")
                                    && t["activeOperationKind"].is_null()
                                    && t["state"] != "complete"
                            })
                            .context("The Task changed during Goal continuation. Please retry.")?;
                        this.tasks
                            .sync_implementation_state(
                                &owner,
                                &chat,
                                &json!({"rowVersion":latest["rowVersion"],"task":result["task"]}),
                            )
                            .await?;
                        this.publish(&owner, &chat, "task", None);
                        Ok(())
                    }
                    .boxed()
                }
            });
            let mut idle = context.clone();
            idle["status"] = json!("idle");
            self.start_encrypted_one(
                owner,
                &idle,
                &operation["relayResult"]["goal"],
                &content_from_summary(&task),
                &input["idempotencyKey"],
                GoalOptions {
                    hooks: self.scheduled_hooks(owner, &lease),
                    dispatch_lease: Some(lease.clone()),
                    user_message: Some(user),
                    message_role: Some(json!("system")),
                    model_configuration: dispatch
                        .get("modelConfiguration")
                        .filter(|v| !v.is_null())
                        .cloned(),
                    purpose: Some(json!("Continue encrypted Task Goal in worktree")),
                    worker_prompt: Some(concat(&[
                        &input["text"],
                        &json!("\n\n"),
                        &json!(RESUME_PROMPT),
                    ])),
                    before: Some(before),
                    ..GoalOptions::default()
                },
            )
            .await?;
            Ok(true)
        }
        .await;
        if let Err(error) = result {
            self.release(&lease["cycleId"]);
            if let Some(failure) =
                crate::operations::shared_failure::downcast_ref::<LaunchError>(&error)
            {
                self.tasks
                    .sync_implementation_state(
                        owner,
                        &chat,
                        &json!({"rowVersion":task["rowVersion"],"task":failure.failure_task}),
                    )
                    .await?;
                self.publish(owner, &chat, "task", None);
            }
            if let Err(failure) = self.dispatch.settle(&lease, "failed", &Value::Null).await
                && !failure.is::<task_dispatch::Conflict>()
            {
                return Err(failure);
            }
            (self.dependencies.queue_tick)();
            return Err(error);
        }
        result
    }
}
