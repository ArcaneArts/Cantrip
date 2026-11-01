use super::*;
impl Service {
    pub fn start_goal(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        input: &Value,
        options: &Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, context, input, options) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            input.clone(),
            options.clone(),
        );
        self.operations.run(async move {
            this.start_goal_one(&owner, &context, &input, &options)
                .await
        })
    }
    async fn start_goal_one(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        input: &Value,
        options: &Value,
    ) -> Result<Value> {
        anyhow::ensure!(
            truthy(input.get("text")),
            "Goal mode needs a text objective."
        );
        let attachments = self
            .chats
            .prompt_attachments(
                owner,
                context,
                input
                    .get("attachmentIds")
                    .unwrap_or(&Value::Array(Vec::new())),
            )
            .await?;
        let model_id = self
            .dependencies
            .routing
            .resolve_model_id(owner, context, input.get("modelId"))
            .await?;
        let reasoning = input
            .get("reasoningEffort")
            .unwrap_or(&context["reasoningEffort"]);
        let mut configuration = context["modelConfiguration"].clone();
        configuration["modelId"] = model_id.clone();
        configuration["reasoningEffort"] = reasoning.clone();
        let configuration = parse("modelConfigurationSchema", &configuration)?;
        let pairs = self
            .dependencies
            .routing
            .route_pairs(owner, context, &configuration, None)
            .await?;
        let runtime = &pairs
            .first()
            .context("No provider route is currently available.")?["root"]["runtime"];
        let key = selected(options.get("idempotencyKey"), &input["idempotencyKey"]);
        let permission = managed_console::permission_profile(context)["effectiveId"].clone();
        if managed_console::session_context(context).is_some() {
            let mut configured = context.clone();
            configured["reasoningEffort"] = reasoning.clone();
            configured["modelConfiguration"] = configuration;
            let managed = self
                .dependencies
                .console
                .prepare_launch(owner, &configured, runtime)
                .await?;
            let chat = text(&context["chatId"])?;
            let mut appended = self
                .chats
                .message_by_idempotency_key(owner, &chat, &text(&key)?, MessageKind::Encrypted)
                .await?;
            if appended.is_none() {
                let mut input = input.clone();
                input["mode"] = json!("goal");
                input["idempotencyKey"] = key;
                let attachments = attachments
                    .iter()
                    .map(super::super::turn_storage::attachment_summary)
                    .collect::<Vec<_>>();
                let protected = self
                    .protection
                    .protect(
                        &text(&context["workerId"])?,
                        &input,
                        &attachments,
                        Some(reasoning),
                        None,
                    )
                    .await?;
                appended = self
                    .dependencies
                    .live
                    .write_message(
                        owner,
                        &chat,
                        &protected,
                        MessageOptions {
                            kind: MessageKind::Encrypted,
                            attribution: None,
                            upsert: false,
                            routing: None,
                        },
                    )
                    .await?;
            }
            let appended = appended.context("Encrypted Chat not found.")?;
            let operation = format!("gui-goal:{}", text(&appended["id"])?);
            let previous =
                crate::native_commands::Repository::new(self.dependencies.database.clone())
                    .lookup(owner, &text(&context["workerId"])?, &operation)
                    .await?;
            if let Some(previous) = &previous {
                anyhow::ensure!(
                    previous["status"] == "applied",
                    "The native goal command is {}; its saved operation cannot be replayed.",
                    text(&previous["status"])?
                );
            }
            let command = if previous.is_some() {
                json!({"type":"chat.goal.get","chatId":context["chatId"],"cwd":context["cwd"],"threadId":managed["threadId"],"model":managed["model"],"provider":managed["provider"],"permissionProfileId":permission})
            } else {
                let mut command = managed;
                command["type"] = json!("chat.goal.create");
                command["operationId"] = json!(operation);
                command["chatId"] = context["chatId"].clone();
                command["cwd"] = context["cwd"].clone();
                command["permissionProfileId"] = permission;
                command["objective"] = input["text"].clone();
                command["tokenBudget"] = options["tokenBudget"].clone();
                command
            };
            let result = self
                .request(&context["workerId"], command, "chatGoalResponseSchema")
                .await?;
            anyhow::ensure!(truthy(result.get("goal")), "Codex did not create the goal.");
            self.publish(owner, &chat, "chat-goal", Some(context));
            return Ok(
                json!({"goal":result,"message":super::super::turn_storage::message_stub(&appended)}),
            );
        }
        let result=self.request(&context["workerId"],json!({"type":"chat.goal.create","chatId":context["chatId"],"cwd":context["cwd"],"threadId":if super::super::runtime_telemetry::RuntimeTelemetry::can_resume(context,runtime){context["threadId"].clone()}else{Value::Null},"objective":input["text"],"tokenBudget":options["tokenBudget"],"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":permission}),"chatGoalResponseSchema").await?;
        anyhow::ensure!(truthy(result.get("goal")), "Codex did not create the goal.");
        let chat = text(&context["chatId"])?;
        self.publish(owner, &chat, "chat-goal", Some(context));
        self.update_runtime(context, runtime, &result["goal"]["threadId"])
            .await?;
        let updated = self
            .chats
            .execution_context(owner, &chat)
            .await?
            .context("Chat source not found.")?;
        let mut input = input.clone();
        input["idempotencyKey"] = key;
        input["modelId"] = model_id;
        input["mode"] = json!("goal");
        let message=(self.dependencies.begin)(owner.to_owned(),updated,input,json!({"purpose":selected(options.get("purpose"),&json!("Codex goal")),"runtimes":vec![runtime.clone()]}),Hooks::default()).await?;
        Ok(json!({"goal":result,"message":message}))
    }
    pub fn begin_prompt(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        input: &Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, context, input) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            input.clone(),
        );
        self.operations.run(async move {
            if input["mode"] == "goal" {
                Ok(this
                    .start_goal_one(&owner, &context, &input, &object())
                    .await?["message"]
                    .clone())
            } else {
                (this.dependencies.begin)(owner, context, input, object(), Hooks::default()).await
            }
        })
    }
    pub fn resume(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        activate: bool,
        reconciled: bool,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        self.operations
            .run(async move { this.resume_one(&owner, &chat, activate, reconciled).await })
    }
    async fn resume_one(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        activate: bool,
        reconciled: bool,
    ) -> Result<()> {
        let Some(context) = self.chats.execution_context(owner, chat).await? else {
            return Ok(());
        };
        if truthy(context.get("automationPaused"))
            || executing(&context)
            || !self
                .dependencies
                .commands
                .is_connected(&text(&context["workerId"])?)
        {
            return Ok(());
        }
        if !reconciled && (self.dependencies.pending)(owner.into(), chat.into()).await? {
            return Ok(());
        }
        let Some(context) = self.chats.execution_context(owner, chat).await? else {
            return Ok(());
        };
        if truthy(context.get("automationPaused")) || executing(&context) {
            return Ok(());
        }
        if truthy(context.get("threadId")) {
            let runtime = self
                .dependencies
                .routing
                .runtime_for_context(owner, &context)
                .await?
                .context("Selected model was not found.")?;
            if managed_console::session_context(&context).is_some() {
                let mut managed = self
                    .dependencies
                    .console
                    .prepare_launch(owner, &context, &runtime)
                    .await?;
                managed["type"] = json!("chat.automation.resume");
                managed["chatId"] = context["chatId"].clone();
                managed["cwd"] = context["cwd"].clone();
                managed["subagentDefaults"] = managed["subagentDefaults"].clone();
                managed["mcpServers"] =
                    selected(managed.get("mcpServers"), &Value::Array(Vec::new()));
                managed["planMode"] = selected(managed.get("planMode"), &json!("default"));
                managed["permissionProfileId"] =
                    managed_console::permission_profile(&context)["effectiveId"].clone();
                let result = self
                    .dependencies
                    .commands
                    .request_with_timeout(
                        &text(&context["workerId"])?,
                        managed,
                        RequestTimeout::Default,
                        None,
                    )
                    .await?;
                let resumed = result
                    .as_ref()
                    .and_then(|v| v["resumed"].as_bool())
                    .context("The native automation resume receipt is invalid.")?;
                if !resumed {
                    (self.dependencies.queue)(owner.into(), chat.into()).await?;
                }
                return Ok(());
            }
            if context["experience"] == "task" {
                let Some(task) = self.tasks.get(owner, chat).await? else {
                    return Ok(());
                };
                let id = uuid::Uuid::new_v4().to_string();
                let key = format!("task-goal-resume:{id}");
                let result = self
                    .read_one(
                        owner,
                        &context,
                        &task,
                        Observation {
                            message: Some(json!({"id":id,"idempotencyKey":key,"kind":"resume"})),
                            activate,
                            ..Observation::default()
                        },
                    )
                    .await?;
                if result["goal"]["status"] == "active" && truthy(result.get("message")) {
                    let lease = goal_dispatch_lease(&task)?;
                    if let Some(lease) = &lease {
                        self.retain_one(lease).await?;
                    }
                    let configuration = &task["dispatch"]["modelConfiguration"];
                    let model = if let Some(model) =
                        configuration.get("modelId").filter(|v| !v.is_null())
                    {
                        model.clone()
                    } else {
                        self.dependencies
                            .routing
                            .resolve_model_id(owner, &context, None)
                            .await?
                    };
                    let mut input = json!({"text":"Resume the active encrypted Task Goal.","mode":"goal","modelId":model,"idempotencyKey":key});
                    for key in [
                        "reasoningEffort",
                        "customSubagentModel",
                        "subagentModelId",
                        "subagentReasoningEffort",
                    ] {
                        if let Some(v) = configuration.get(key) {
                            input[key] = v.clone();
                        }
                    }
                    let mut options = json!({"acquiringActor":"agent","encryptedTaskMessages":json!({"userMessage":result["message"],"response":json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:{}",text(&result["message"]["id"])?)})}),"purpose":"Resume encrypted Task Goal","runtimes":vec![runtime],"workerPrompt":RESUME_PROMPT});
                    let hooks = if let Some(lease) = lease {
                        options["taskDispatchLease"] = lease.clone();
                        self.scheduled_hooks(owner, &lease)
                    } else {
                        Hooks::default()
                    };
                    (self.dependencies.begin)(owner.into(), context, input, options, hooks).await?;
                }
                return Ok(());
            }
            let result=self.request(&context["workerId"],json!({"type":"chat.goal.get","chatId":context["chatId"],"cwd":context["cwd"],"threadId":context["threadId"],"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":managed_console::permission_profile(&context)["effectiveId"]}),"chatGoalResponseSchema").await?;
            if result["goal"]["status"] == "active" {
                let model = self
                    .dependencies
                    .routing
                    .resolve_model_id(owner, &context, None)
                    .await?;
                (self.dependencies.begin)(owner.into(),context,json!({"text":concat(&[&json!("Resume goal: "),&result["goal"]["objective"]]),"mode":"goal","modelId":model,"idempotencyKey":concat(&[&json!("chat-resume:"),&result["goal"]["updatedAt"],&json!(":"),&json!(uuid::Uuid::new_v4().to_string())])}),json!({"acquiringActor":"agent","purpose":"Resume paused Codex goal","runtimes":vec![runtime],"workerPrompt":RESUME_PROMPT}),Hooks::default()).await?;
                return Ok(());
            }
        }
        (self.dependencies.queue)(owner.into(), chat.into()).await
    }
}
