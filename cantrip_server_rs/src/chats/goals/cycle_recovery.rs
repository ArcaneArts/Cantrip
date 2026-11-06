use super::*;
impl Service {
    pub fn recover_task_goal_cycle(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        recovery: &Value,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, chat, recovery) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            recovery.clone(),
        );
        self.operations.run(async move {
            this.recover_task_goal_cycle_one(&owner, &chat, &recovery)
                .await
        })
    }
    async fn recover_task_goal_cycle_one(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        recovery: &Value,
    ) -> Result<()> {
        let Some(context) = self.chats.execution_context(owner, chat).await? else {
            return Ok(());
        };
        let Some(task) = self.tasks.get(owner, chat).await? else {
            return Ok(());
        };
        let Some(current) = self.tasks.pending_goal_cycle_recovery(owner, chat).await? else {
            return Ok(());
        };
        if context["experience"] != "task"
            || task["dispatch"].is_null()
            || context.get("threadId") != recovery.get("threadId")
            || current.get("sourceKey") != recovery.get("sourceKey")
        {
            return Ok(());
        }
        let observed = self
            .read_one(
                owner,
                &context,
                &task,
                Observation {
                    observe_execution: true,
                    observation_only: true,
                    ..Observation::default()
                },
            )
            .await?;
        let observation = observed
            .get("observationFence")
            .filter(|o| !o.is_null())
            .context("Task Goal recovery requires its native observation scope.")?;
        let lease = self
            .dispatch
            .recover_started_goal(
                owner,
                &task["dispatch"],
                &self.continuation_owner,
                &json!({"allowSettled":true,"goalObservation":observation}),
            )
            .await?;
        self.retain_one(&lease).await?;
        let runtime = self
            .dependencies
            .routing
            .runtime_for_context(owner, &context)
            .await?
            .context("Selected Task Goal recovery model was not found.")?;
        let prepared = self
            .dependencies
            .console
            .prepare_launch(owner, &context, &runtime)
            .await?;
        anyhow::ensure!(
            prepared["model"].get("routeId") == recovery["cycle"].get("modelRouteId")
                && prepared["provider"].get("id") == recovery.get("providerId")
                && selected(prepared["provider"].get("accountId"), &Value::Null)
                    == recovery["cycle"]["providerAccountId"],
            "The Task Goal recovery route changed."
        );
        let mut command = json!({
            "type":"task.goal.recover","chatId":chat,"projectId":context["projectId"],
            "cwd":context["cwd"],"threadId":recovery["threadId"],"recovery":current,
            "worktreeId":context["worktreeId"],"rootKind":context["rootKind"],
            "computerUseEnabled":context["computerUseEnabled"]==true,
            "model":prepared["model"],"provider":prepared["provider"],
            "subagentDefaults":selected(prepared.get("subagentDefaults"),&Value::Null),
            "mcpServers":selected(prepared.get("mcpServers"),&Value::Array(Vec::new())),
            "planMode":selected(prepared.get("planMode"),&json!("default")),
            "permissionProfileId":managed_console::permission_profile(&context)["effectiveId"]
        });
        if let Some(os) = context.get("osExecution") {
            command["osExecution"] = os.clone();
        }
        let worker = text(&context["workerId"])?;
        let result = self
            .dependencies
            .commands
            .request_with_timeout(
                &worker,
                command.clone(),
                RequestTimeout::After(std::time::Duration::from_secs(10)),
                None,
            )
            .await?;
        let receipt =
            crate::settings::parse_response("taskGoalCycleRecoveryReceiptSchema", result.as_ref())?;
        anyhow::ensure!(
            receipt.get("sourceKey") == current.get("sourceKey")
                && self
                    .dependencies
                    .commands
                    .connection_identity(&worker)
                    .is_some_and(|i| i.owner == owner
                        && Some(i.process_generation.as_str())
                            == receipt["workerGeneration"].as_str()),
            "Task Goal recovery belongs to a replaced worker connection."
        );
        if self
            .tasks
            .confirm_goal_cycle_recovery(owner, chat, &current, &receipt)
            .await?
            .is_some()
        {
            self.publish(owner, chat, "task", None);
            if let (Some(context), Some(task)) = (
                self.chats.execution_context(owner, chat).await?,
                self.tasks.get(owner, chat).await?,
            ) && context["experience"] == "task"
                && context.get("threadId") == current.get("threadId")
            {
                let projected = self
                    .read_one(
                        owner,
                        &context,
                        &task,
                        Observation {
                            observe_execution: true,
                            ..Observation::default()
                        },
                    )
                    .await?;
                self.reconcile_one(owner, &projected["task"], &projected["task"]["state"])
                    .await?;
            }
            (self.dependencies.queue_tick)();
        }
        Ok(())
    }
}
