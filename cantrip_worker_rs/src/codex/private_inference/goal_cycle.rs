use super::*;
use cantrip_wire::value::json;

impl Router {
    pub(super) fn task_goal_cycle(&self, gate: &Gate) -> Option<Arc<GoalCycle>> {
        if gate.phase != Phase::Begin
            || gate.goal_epoch.is_none()
            || gate.root_thread_id.as_ref() != Some(&gate.key.thread_id)
        {
            return None;
        }
        self.active_task_goal_cycle(&gate.key.thread_id, &gate.key.runner_generation)
    }

    pub(in crate::codex) fn active_task_goal_cycle(
        &self,
        thread: &JsString,
        runner: &JsString,
    ) -> Option<Arc<GoalCycle>> {
        self.assert_transport().ok()?;
        self.0
            .task_goals
            .lock()
            .unwrap()
            .get(thread)
            .filter(|input| &input.runner == runner)
            .and_then(|input| input.cycle.clone())
    }

    pub(in crate::codex) fn restore_task_goal(
        &self,
        thread: &JsString,
        runner: &JsString,
        parent: &JsString,
        cycle: Arc<GoalCycle>,
    ) -> Result<()> {
        self.assert_transport()?;
        self.0.task_goals.lock().unwrap().insert(
            thread.clone(),
            TaskGoalRoot {
                runner: runner.clone(),
                message: Some(parent.clone()),
                input: FirstInput::default(),
                cycle: Some(cycle),
            },
        );
        Ok(())
    }

    pub(super) fn goal_enqueue(
        &self,
        owner: Arc<GoalCycle>,
    ) -> crate::codex::admission::TaskQueued {
        Arc::new(move |cycle, operation, generation| {
            let owner = owner.clone();
            Box::pin(async move {
                owner.enqueued.send_replace(Some(json!({
                    "cycle":cycle,"admission":json!({"operationId":operation,"runtimeGeneration":generation}),
                })));
                Ok(())
            })
        })
    }

    pub(in crate::codex) fn attach_task_goal_recovery(
        &self,
        thread: &JsString,
        runner: &JsString,
        candidate: Arc<GoalCycle>,
    ) -> Result<Arc<GoalCycle>> {
        self.assert_transport()?;
        let mut roots = self.0.task_goals.lock().unwrap();
        if let Some(root) = roots.get(thread).filter(|root| &root.runner == runner) {
            if let Some(owner) = &root.cycle
                && owner.placement == candidate.placement
                && owner.key == candidate.key
            {
                return Ok(owner.clone());
            }
            if root.cycle.is_none() {
                bail!("The Task Goal still has a canonical first input.");
            }
        }
        roots.insert(
            thread.clone(),
            TaskGoalRoot {
                runner: runner.clone(),
                message: None,
                input: FirstInput::default(),
                cycle: Some(candidate.clone()),
            },
        );
        Ok(candidate)
    }

    pub(super) fn goal_dispatch(
        &self,
        owner: Arc<GoalCycle>,
        pending: Pending,
        signal: Signal,
        provider: Value,
    ) -> TaskDispatch {
        let router = self.clone();
        Arc::new(move |cycle, operation, recovery, source, generation| {
            let (router, owner, pending, signal, provider) = (
                router.clone(),
                owner.clone(),
                pending.clone(),
                signal.clone(),
                provider.clone(),
            );
            Box::pin(async move {
                let gate = pending.gate();
                let thread = &gate.key.thread_id;
                let turn = &gate.key.turn_id;
                let mut input = json!({
                    "sourceKey": if recovery.is_null() { &source["key"] } else { &recovery["sourceKey"] },
                    "nativeRuntimeGeneration":generation, "providerId":provider["id"],
                    "chatId":owner.key.2, "threadId":thread, "turnId":turn,
                    "operationId":operation, "cycle":cycle,
                });
                if recovery.is_null() {
                    input["freshRuntimeGeneration"] =
                        source["identity"]["runtimeGeneration"].clone();
                }

                let current = || -> Result<()> {
                    signal.check()?;
                    if !router.is_current(&pending)
                        || !router
                            .task_goal_cycle(gate)
                            .is_some_and(|current| Arc::ptr_eq(&current, &owner))
                    {
                        bail!("The pending native Goal lost its canonical association.");
                    }
                    Ok(())
                };
                owner
                    .dispatch(input, &provider, thread.clone(), turn.clone(), signal.clone(), async {
                        current()?;
                        let epoch = router.goal_settings_epoch(thread).await?;
                        let goal = router
                            .request("thread/goal/get", json!({"threadId":thread}))
                            .await?;
                        if router.goal_settings_epoch(thread).await? != epoch
                            || goal["goalEpoch"].as_js_string() != gate.goal_epoch.as_ref()
                            || goal["goal"]["threadId"].as_js_string() != Some(thread)
                            || goal["goal"]["status"] != "active"
                        {
                            bail!(
                                "The queued native Task Goal is no longer active on this thread."
                            );
                        }
                        current()
                    })
                    .await?;
                current()
            })
        })
    }

    async fn goal_settings_epoch(&self, thread: &JsString) -> Result<JsString> {
        let observed = self
            .request("thread/settings/read", json!({"threadId":thread}))
            .await?;
        if observed["threadId"].as_js_string() != Some(thread) {
            bail!("Native Goal settings returned another thread.");
        }
        observed["threadSettings"]["settingsVersion"]["epoch"]
            .as_js_string()
            .filter(|epoch| !epoch.is_empty())
            .cloned()
            .ok_or_else(|| anyhow!("Native Goal settings returned no epoch."))
    }
}
