use super::*;
impl Service {
    pub fn read(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        task: &Value,
        options: Observation,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, context, task) = (
            self.clone(),
            owner.to_owned(),
            context.clone(),
            task.clone(),
        );
        self.operations
            .run(async move { this.read_one(&owner, &context, &task, options).await })
    }
    pub(super) async fn read_one(
        self: &Arc<Self>,
        owner: &str,
        context: &Value,
        task: &Value,
        mut options: Observation,
    ) -> Result<Value> {
        options.message = options.message.filter(|v| truthy(Some(v)));
        options.runtime_failure = options.runtime_failure.filter(|v| truthy(Some(v)));
        if !truthy(context.get("threadId")) {
            return Ok(json!({"goal":Value::Null,"message":Value::Null,"task":task}));
        }
        let runtime = self
            .dependencies
            .routing
            .runtime_for_context(owner, context)
            .await?
            .context("Selected model was not found.")?;
        let observation =
            if options.dispatch_guard.is_none() && !options.activate && options.message.is_none() {
                Some(
                    self.tasks
                        .capture_goal_observation(owner, context, task)
                        .await?,
                )
            } else {
                None
            };
        let mut command = if options.activate {
            json!({"type":"chat.goal.update","status":"active"})
        } else {
            json!({"type":"chat.goal.get","observeExecution":options.observe_execution})
        };
        for key in ["chatId", "cwd", "threadId"] {
            command[key] = context[key].clone();
        }
        if !options.activate
            && let Some(os) = context.get("osExecution")
        {
            command["osExecution"] = os.clone();
        }
        command["model"] = runtime["model"].clone();
        command["provider"] = runtime["provider"].clone();
        command["permissionProfileId"] =
            managed_console::permission_profile(context)["effectiveId"].clone();
        let mut task_context = json!({"task":content_from_summary(task),"automationPaused":context["automationPaused"],"chatStatus":context["status"],"message":options.message.as_ref().unwrap_or(&Value::Null)});
        if let Some(failure) = &options.runtime_failure {
            task_context["runtimeFailure"] = failure.clone();
        }
        command["taskContext"] = task_context;
        let mut result = self
            .request(&context["workerId"], command, "taskGoalWorkerResultSchema")
            .await?;
        if (truthy(result.get("goal"))
            && (result["goal"]["chatId"] != context["chatId"]
                || result["goal"]["threadId"] != context["threadId"]))
            || (truthy(result.get("execution"))
                && result["execution"]["threadId"] != context["threadId"])
            || (truthy(result.get("goal"))
                && options.message.as_ref().is_some_and(|message| {
                    result["message"].get("id") != message.get("id")
                        || result["message"].get("idempotencyKey") != message.get("idempotencyKey")
                }))
        {
            anyhow::bail!("Encrypted Goal metadata is invalid.");
        }
        if options.observe_execution
            && options
                .dispatch_guard
                .as_ref()
                .is_some_and(|g| g["kind"] == "outcome")
            && !truthy(result.get("execution"))
        {
            anyhow::bail!("Task Goal execution observation was not returned.");
        }
        if (!truthy(result.get("goal")) && options.runtime_failure.is_none())
            || options.observation_only
        {
            if let Some(observation) = &observation {
                self.tasks
                    .validate_goal_observation(owner, &text(&context["chatId"])?, observation)
                    .await?;
            }
            result["observationFence"] = observation.clone().unwrap_or(Value::Null);
            result["task"] = task.clone();
            return Ok(result);
        }
        // Discard the whole native observation after a stale ownership/CAS
        // result. Fresh Task state cannot make an older native result current.
        let synchronized = self
            .tasks
            .sync_implementation_state_observed(
                owner,
                &text(&context["chatId"])?,
                &json!({"rowVersion":task["rowVersion"],"task":result["task"]}),
                options.dispatch_guard.as_ref(),
                observation.as_ref(),
            )
            .await?;
        if synchronized
            .as_ref()
            .is_some_and(|next| next["rowVersion"] != task["rowVersion"])
        {
            self.publish(owner, &text(&context["chatId"])?, "task", Some(context));
        }
        let mut next = synchronized.unwrap_or_else(|| task.clone());
        next["dispatch"] = task["dispatch"].clone();
        if !options.observe_execution {
            self.reconcile_one(owner, task, &next["state"]).await?;
        }
        result["observationFence"] = observation
            .as_ref()
            .map(|f| tasks::goal_observations::after_projection(f, &next["rowVersion"]))
            .unwrap_or(Value::Null);
        result["task"] = next;
        Ok(result)
    }
}
