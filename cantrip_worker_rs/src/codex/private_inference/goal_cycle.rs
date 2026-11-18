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
        self.0
            .task_goals
            .lock()
            .unwrap()
            .get(&gate.key.thread_id)
            .filter(|input| input.runner == gate.key.runner_generation)
            .and_then(|input| input.cycle.clone())
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
                    "nativeRuntimeGeneration":generation, "providerId":provider,
                    "chatId":owner.parent["chatId"], "threadId":thread, "turnId":turn,
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
                    .dispatch(input, thread.clone(), turn.clone(), signal.clone(), async {
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
