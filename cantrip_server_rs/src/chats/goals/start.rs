use super::*;
impl Service {
    pub fn start_encrypted(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        objective: &Value,
        task: &Value,
        key: &Value,
        options: GoalOptions,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, context, objective, task, key) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            objective.clone(),
            task.clone(),
            key.clone(),
        );
        self.operations.run(async move {
            this.start_encrypted_one(&owner, &context, &objective, &task, &key, options)
                .await
        })
    }
    pub(super) async fn start_encrypted_one(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        objective: &Value,
        task: &Value,
        key: &Value,
        options: GoalOptions,
    ) -> Result<()> {
        let model_id = self
            .dependencies
            .routing
            .resolve_model_id(
                owner,
                context,
                options
                    .model_configuration
                    .as_ref()
                    .and_then(|v| v.get("modelId"))
                    .filter(|v| !v.is_null()),
            )
            .await?;
        let mut configuration = options
            .model_configuration
            .clone()
            .filter(|value| !value.is_null())
            .unwrap_or_else(|| context["modelConfiguration"].clone());
        configuration["modelId"] = model_id.clone();
        let configuration = parse("modelConfigurationSchema", &configuration)?;
        let pairs = self
            .dependencies
            .routing
            .route_pairs(owner, context, &configuration, options.runtimes.as_deref())
            .await?;
        let runtime = &pairs
            .first()
            .context("No provider route is currently available.")?["root"]["runtime"];
        let result=self.request(&context["workerId"],json!({"type":"chat.goal.create","chatId":context["chatId"],"cwd":context["cwd"],"threadId":if super::super::runtime_telemetry::RuntimeTelemetry::can_resume(context,runtime){context["threadId"].clone()}else{Value::Null},"objective":objective,"tokenBudget":Value::Null,"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":managed_console::permission_profile(context)["effectiveId"],"taskContext":json!({"task":task,"automationPaused":context["automationPaused"],"chatStatus":context["status"],"message":options.control_message.clone().unwrap_or(Value::Null)})}),"taskGoalWorkerResultSchema").await?;
        let failure = result["task"]["classification"]["lastError"]["code"]
            .as_str()
            .unwrap_or("");
        let initial_failure = failure
            .strip_prefix("task-goal-start-")
            .is_some_and(|kind| {
                matches!(
                    kind,
                    "failed"
                        | "timeout"
                        | "capacity"
                        | "rate-limit"
                        | "connection"
                        | "needs-input"
                        | "configuration"
                        | "usage-limit"
                        | "budget-limit"
                )
            });
        let continuation_failure = options
            .control_message
            .as_ref()
            .is_some_and(|message| message["kind"] == "resume")
            && failure
                .strip_prefix("implementation-")
                .and_then(|kind| kind.strip_suffix("-failed"))
                .is_some_and(|kind| {
                    matches!(
                        kind,
                        "runtime"
                            | "timeout"
                            | "capacity"
                            | "rate-limit"
                            | "connection"
                            | "needs-input"
                            | "configuration"
                            | "usage-limit"
                            | "budget-limit"
                    )
                });
        if !truthy(result.get("goal")) && (initial_failure || continuation_failure) {
            return Err(LaunchError {
                failure_task: result["task"].clone(),
            }
            .into());
        }
        if result["goal"].get("chatId") != context.get("chatId") {
            anyhow::bail!("The encrypted Goal belongs to another Task.");
        }
        anyhow::ensure!(
            truthy(result.get("goal")),
            "Codex did not create the Task Goal."
        );
        self.update_runtime(context, runtime, &result["goal"]["threadId"])
            .await?;
        let updated = self
            .chats
            .execution_context(owner, &text(&context["chatId"])?)
            .await?
            .context("Task Chat source not found.")?;
        if let Some(before) = options.before {
            before(result).await?;
        }
        let mut input = json!({"text":"Begin the active encrypted Task Goal.","mode":"goal","modelId":model_id,"idempotencyKey":key});
        for key in [
            "reasoningEffort",
            "customSubagentModel",
            "subagentModelId",
            "subagentReasoningEffort",
        ] {
            input[key] = configuration[key].clone();
        }
        let user = options
            .user_message
            .as_ref()
            .filter(|value| !value.is_null())
            .unwrap_or(&objective["startMessage"]);
        let mut turn_options = json!({"purpose":options.purpose.filter(|value|!value.is_null()).unwrap_or_else(||json!("Task implementation Goal")),"encryptedTaskMessages":json!({"userMessage":user,"response":json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:{}",text(&user["id"])?)})}),"workerPrompt":options.worker_prompt.filter(|value|!value.is_null()).unwrap_or_else(||json!("Begin the active Task Goal and follow its encrypted objective.")),"runtimes":vec![runtime.clone()]});
        if let Some(role) = options.message_role {
            turn_options["messageRole"] = role;
        }
        if let Some(lease) = options.dispatch_lease {
            turn_options["taskDispatchLease"] = lease;
        }
        (self.dependencies.begin)(
            owner.to_owned(),
            updated,
            input,
            turn_options,
            options.hooks,
        )
        .await?;
        Ok(())
    }
    pub(super) async fn resume_pending_goal_input(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        lease: &Value,
        options: &mut GoalOptions,
    ) -> Result<bool> {
        let chat = text(&context["chatId"])?;
        let pending = self
            .tasks
            .pending_goal_inference_input(owner, &chat, Some(&text(&lease["cycleId"])?))
            .await?;
        let Some(pending) = pending.filter(|p| p["deferred"] == true) else {
            return Ok(false);
        };
        let configuration = options
            .model_configuration
            .as_ref()
            .filter(|v| !v.is_null())
            .unwrap_or(&context["modelConfiguration"]);
        let model = self
            .dependencies
            .routing
            .resolve_model_id(
                owner,
                context,
                configuration.get("modelId").filter(|v| !v.is_null()),
            )
            .await?;
        self.retain(lease).await?;
        let task = self
            .tasks
            .get(owner, &chat)
            .await?
            .context("Task Chat source not found.")?;
        // Status activation preserves the objective and suppresses an automatic
        // competing kickoff; this owner submits the saved encrypted input.
        self.read_one(
            owner,
            context,
            &task,
            Observation {
                activate: true,
                dispatch_guard: Some(json!({"kind":"leased","lease":lease})),
                ..Observation::default()
            },
        )
        .await?;
        let message = &pending["message"];
        let mut input = json!({"text":"Resume the accepted Task Goal input.","mode":"goal","modelId":model,"idempotencyKey":message["idempotencyKey"]});
        for key in [
            "reasoningEffort",
            "customSubagentModel",
            "subagentModelId",
            "subagentReasoningEffort",
        ] {
            input[key] = configuration[key].clone();
        }
        let mut turn_options = json!({"taskDispatchLease":lease,"acquiringActor":"agent","purpose":"Resume queued Task Goal input","messageRole":if message["classification"]["role"]=="system"{"system"}else{"user"},"encryptedTaskMessages":json!({"userMessage":message,"response":json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:{}",text(&message["id"])?)})}),"workerPrompt":RESUME_PROMPT});
        if let Some(runtimes) = options.runtimes.take() {
            turn_options["runtimes"] = Value::Array(runtimes);
        }
        let hooks = if options.hooks.structured.is_none()
            && options.hooks.after_completed.is_none()
            && options.hooks.after_failed.is_none()
        {
            self.scheduled_hooks(owner, lease)
        } else {
            std::mem::take(&mut options.hooks)
        };
        (self.dependencies.begin)(
            owner.to_owned(),
            context.clone(),
            input,
            turn_options,
            hooks,
        )
        .await?;
        Ok(true)
    }

    pub fn launch_prepared(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        operation: &str,
        mut options: GoalOptions,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, chat, operation) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            operation.to_owned(),
        );
        self.operations.run(async move {
            let context = this
                .tasks
                .get_operation_context(&owner, &chat, &json!({"operationId":operation}))
                .await?
                .filter(|c| {
                    c["round"]["kind"] == "finalize" && truthy(c["relayResult"].get("goal"))
                })
                .context("The finalized Task objective is not available.")?;
            if let Some(lease) = options.dispatch_lease.clone() {
                if let Some(execution) = this.chats.execution_context(&owner, &chat).await? {
                    if this
                        .resume_pending_goal_input(&owner, &execution, &lease, &mut options)
                        .await?
                    {
                        return this
                            .tasks
                            .get(&owner, &chat)
                            .await?
                            .context("Task Chat source not found.");
                    }
                }
            }
            let key = format!("task-goal:{operation}");
            let existing = this
                .chats
                .message_by_idempotency_key(&owner, &chat, &key, MessageKind::Task)
                .await?;
            let completed = Arc::new(Mutex::new(None));
            let complete: Before = Arc::new({
                let (this, owner, chat, operation, completed) = (
                    this.clone(),
                    owner.clone(),
                    chat.clone(),
                    operation.clone(),
                    completed.clone(),
                );
                move |_| {
                    let (this, owner, chat, operation, completed) = (
                        this.clone(),
                        owner.clone(),
                        chat.clone(),
                        operation.clone(),
                        completed.clone(),
                    );
                    async move {
                        let value = this
                            .tasks
                            .complete_finalization_operation(&owner, &chat, &operation)
                            .await?
                            .context("Task finalization was not found.")?;
                        *completed.lock().unwrap() = Some(value);
                        this.publish(&owner, &chat, "task", None);
                        Ok(())
                    }
                    .boxed()
                }
            });
            if existing.is_none() {
                let execution = this
                    .chats
                    .execution_context(&owner, &chat)
                    .await?
                    .filter(|c| c["experience"] == "task")
                    .context("Task Chat source not found.")?;
                options.before = Some(complete);
                this.start_encrypted_one(
                    &owner,
                    &execution,
                    &context["relayResult"]["goal"],
                    &context["relayResult"]["task"],
                    &json!(key),
                    options,
                )
                .await?;
            } else {
                complete(Value::Null).await?;
            }
            let completed = completed.lock().unwrap().clone();
            let value = if let Some(value) = completed {
                value
            } else {
                this.tasks
                    .get_operation_context(&owner, &chat, &json!({"operationId":operation}))
                    .await?
                    .context("Task finalization was not found.")?
            };
            Ok(value["task"].clone())
        })
    }
    pub fn fail_launch(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        operation: &str,
        error: Arc<anyhow::Error>,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, chat, operation) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            operation.to_owned(),
        );
        self.operations.run(async move{
            this.tasks.fail_operation(&owner,&chat,&operation,crate::operations::shared_failure::downcast_ref::<LaunchError>(&error).map(|e|&e.failure_task)).await?;
            this.log("warn","Task Goal startup failed; the finalized plan is retained for retry",json!({"event":"task.goal.start-failed","subsystem":"task-scheduler","operation":"start-goal","status":"failed","reasonCode":"task-goal-start-failed","chatId":chat,"operationId":operation}));this.publish(&owner,&chat,"task",None);Ok(())
        })
    }
}
