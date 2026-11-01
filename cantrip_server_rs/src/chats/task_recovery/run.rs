use super::*;
impl Service {
    pub(super) async fn run(
        &self,
        owner: &str,
        chat: &str,
        resume: bool,
        automatic: bool,
    ) -> Result<bool> {
        let context = self.chats.execution_context(owner, chat).await?;
        let task = self.tasks.get(owner, chat).await?;
        let (Some(mut context), Some(task)) = (
            context.filter(|c| c["contextKind"] == "project" && c["experience"] == "task"),
            task.filter(|t| {
                truthy(t.get("planGoalEnabled")) && truthy(t.get("implementationStartedAt"))
            }),
        ) else {
            return Ok(false);
        };
        let goals = &self.dependencies.goals;
        if task["state"] == "complete" {
            goals.reconcile(owner, &task, &json!("complete")).await?;
            return Ok(true);
        }
        anyhow::ensure!(
            self.dependencies
                .commands
                .is_connected(&text(&context["workerId"])?),
            "The project worker is offline. Reconnect it, then retry recovery."
        );
        if truthy(context.get("automationPaused")) && (!resume || automatic) {
            return Ok(true);
        }
        let cycle = task["dispatch"].clone();
        if cycle.is_null()
            || cycle["operationKind"] != "finalize"
            || !truthy(cycle.get("codexThreadId"))
            || !truthy(cycle.get("worktreeId"))
            || !(matches!(
                cycle["state"].as_str(),
                Some("running" | "expired" | "failed")
            ) || (resume && cycle["state"] == "succeeded"))
        {
            return Ok(false);
        }
        if !resume
            && !matches!(context["status"].as_str(), Some("offline" | "failed"))
            && cycle["state"] == "running"
            && cycle["leaseOwner"] == self.dependencies.lease_owner
        {
            return Ok(false);
        }
        let affinity=self.targets.worktree_context(owner,&text(&context["projectId"])?,&text(&cycle["worktreeId"])?).await?.context("The retained Task worktree is unavailable. Send a follow-up in the current checkout to continue after cleanup.")?;
        anyhow::ensure!(
            affinity["workerId"] == context["workerId"]
                && cycle["physicalWorkerId"] == context["workerId"],
            "The retained Task session belongs to a different worker."
        );
        let mut current_observation = None;
        if resume && truthy(context.get("threadId")) {
            let observed = goals
                .read(
                    owner,
                    &context,
                    &task,
                    goals::Observation {
                        observe_execution: true,
                        ..goals::Observation::default()
                    },
                )
                .await?;
            if !truthy(observed.get("goal"))
                && observed["execution"].get("threadId") == context.get("threadId")
                && matches!(
                    observed["execution"]["status"].as_str(),
                    Some("idle" | "failed")
                )
            {
                let latest = self
                    .chats
                    .execution_context(owner, chat)
                    .await?
                    .filter(|latest| unchanged(latest, &context, false))
                    .context(CHANGED)?;
                drop(latest);
                if truthy(context.get("automationPaused")) && !automatic {
                    (self.dependencies.unpause)(owner.to_owned(), chat.to_owned()).await?;
                    context = self
                        .chats
                        .execution_context(owner, chat)
                        .await?
                        .filter(|latest| unpaused(latest, &context, false))
                        .context(CHANGED)?;
                }
                return goals.continue_worktree(owner,&context,&json!({"text":"Resume the saved approved Task implementation Goal in this checkout. Preserve already-completed work and validate the remaining acceptance criteria.","idempotencyKey":format!("task-goal-repair:{chat}:{}",(self.dependencies.clock)())}),None).await;
            }
            current_observation = Some(observed);
        }
        anyhow::ensure!(
            !truthy(context.get("threadId")) || context["threadId"] == cycle["codexThreadId"],
            "The Task already has a different session. Recovery did not replace it."
        );
        if truthy(context.get("automationPaused")) && resume && !automatic {
            (self.dependencies.unpause)(owner.to_owned(), chat.to_owned()).await?;
            context = self
                .chats
                .execution_context(owner, chat)
                .await?
                .filter(|latest| unpaused(latest, &context, true))
                .context(CHANGED)?;
        }
        let mut observed_context = context.clone();
        for (target, source) in [
            ("worktreeId", "worktreeId"),
            ("threadId", "codexThreadId"),
            ("modelRouteId", "modelRouteId"),
            ("providerAccountId", "providerAccountId"),
        ] {
            observed_context[target] = cycle[source].clone();
        }
        observed_context["cwd"] = affinity["worktree"]["path"].clone();
        let observed = if let Some(observed) =
            current_observation.filter(|_| context["worktreeId"] == cycle["worktreeId"])
        {
            observed
        } else {
            goals
                .read(
                    owner,
                    &observed_context,
                    &task,
                    goals::Observation {
                        observe_execution: true,
                        ..goals::Observation::default()
                    },
                )
                .await?
        };
        anyhow::ensure!(
            truthy(observed.get("execution"))
                && observed["execution"]["threadId"] == cycle["codexThreadId"]
                && truthy(observed.get("goal"))
                && observed["goal"]["threadId"] == cycle["codexThreadId"],
            "The worker could not observe the retained Task session. No new agent was started."
        );
        anyhow::ensure!(
            observed["execution"]["status"] != "failed" || resume,
            "The native Task session reports a runtime error. Its history was preserved."
        );
        if automatic
            && (observed["task"]["state"] == "blocked"
                || matches!(
                    observed["goal"]["status"].as_str(),
                    Some("paused" | "usageLimited" | "budgetLimited")
                ))
        {
            return Ok(true);
        }
        self.chats
            .execution_context(owner, chat)
            .await?
            .filter(|latest| unchanged(latest, &context, true))
            .context(CHANGED)?;
        if observed["goal"]["status"] == "complete" {
            goals.reconcile(owner, &task, &json!("complete")).await?;
            self.chats
                .set_status(chat, &text(&observed["execution"]["status"])?)
                .await?;
            (self.dependencies.publish)(owner, chat, &text(&context["projectId"])?);
            return Ok(true);
        }
        let should_resume = (observed["execution"]["status"] == "idle"
            || (resume && observed["execution"]["status"] == "failed"))
            && (resume || observed["goal"]["status"] == "active")
            && context["status"] != "running";
        let allow_settled =
            cycle["state"] == "succeeded" || (automatic && cycle["state"] != "running");
        let lease = self
            .dispatch
            .recover_started_goal(
                owner,
                &cycle,
                &self.dependencies.lease_owner,
                &if allow_settled {
                    json!({"allowSettled":true})
                } else {
                    Value::Null
                },
            )
            .await?;
        if context["worktreeId"] != cycle["worktreeId"] {
            self.chats
                .update_worktree(
                    owner,
                    chat,
                    &json!({"worktreeId":cycle["worktreeId"],"mode":context["worktreeMode"]}),
                    Some(&context["worktreeId"]),
                )
                .await?
                .context("The retained Task worktree is unavailable.")?;
            context = self
                .chats
                .execution_context(owner, chat)
                .await?
                .context(CHANGED)?;
        }
        if let Some(pending) = self.lanes.pending_transition(owner, chat).await? {
            self.lanes
                .cancel_transition(owner, chat, &text(&pending["lane"]["id"])?)
                .await?;
        }
        goals.retain(&lease).await?;
        let synchronized = self.tasks.get(owner, chat).await?.context(CHANGED)?;
        if !should_resume {
            goals
                .reconcile(owner, &synchronized, &synchronized["state"])
                .await?;
        }
        if observed["execution"]["status"] == "running"
            && !truthy(context.get("executionLaneId"))
            && context["status"] != "running"
        {
            self.lanes
                .start(owner, chat, "agent", "Recovered native Task Goal")
                .await?;
        } else if context["status"] != "running" {
            let status = if should_resume {
                "idle".to_owned()
            } else {
                text(&observed["execution"]["status"])?
            };
            self.chats.set_status(chat, &status).await?;
        }
        (self.dependencies.publish)(owner, chat, &text(&context["projectId"])?);
        if should_resume {
            goals.resume(owner, chat, resume, true).await?;
        }
        Ok(true)
    }
}
