use super::*;
const CLOSING: &str = "The server is shutting down; Task recovery will continue after restart.";
pub fn dispatch_cycle_lease(dispatch: &Value) -> Result<Option<Value>> {
    if dispatch.is_null()
        || !matches!(dispatch["state"].as_str(), Some("claimed" | "running"))
        || !truthy(dispatch.get("leaseOwner"))
        || !truthy(dispatch.get("leaseExpiresAt"))
    {
        return Ok(None);
    }
    parse("taskDispatchWorkerLeaseSchema",&json!({"cycleId":dispatch["id"],"operationId":dispatch["operationId"],"leaseOwner":dispatch["leaseOwner"],"leaseExpiresAt":dispatch["leaseExpiresAt"],"fencingToken":dispatch["fencingToken"]})).map(Some)
}
pub fn goal_dispatch_lease(task: &Value) -> Result<Option<Value>> {
    if task["dispatch"]["operationKind"] == "finalize" {
        dispatch_cycle_lease(&task["dispatch"])
    } else {
        Ok(None)
    }
}
impl Service {
    pub fn close(&self) {
        let mut state = self.leases.lock().unwrap();
        state.closing = true;
        for (_, entry) in state.retained.drain() {
            entry.timer.abort();
        }
    }
    pub fn release(&self, cycle: &Value) {
        if let Some(cycle) = cycle.as_js_string()
            && let Some(entry) = self.leases.lock().unwrap().retained.remove(cycle)
        {
            entry.timer.abort();
        }
    }
    pub fn retain(self: &Arc<Self>, lease: &Value) -> BoxFuture<'static, Result<()>> {
        let (this, lease) = (self.clone(), lease.clone());
        self.operations
            .run(async move { this.retain_one(&lease).await })
    }
    pub(super) async fn retain_one(self: &Arc<Self>, lease: &Value) -> Result<()> {
        let cycle = lease["cycleId"]
            .as_js_string()
            .context("Task Goal lease cycle")?
            .clone();
        {
            let mut state = self.leases.lock().unwrap();
            anyhow::ensure!(!state.closing, "{CLOSING}");
            if state.retained.get(&cycle).is_some_and(|r| {
                r.lease["fencingToken"] == lease["fencingToken"]
                    && r.lease["leaseOwner"] == lease["leaseOwner"]
            }) {
                return Ok(());
            }
            if let Some(prior) = state.retained.remove(&cycle) {
                prior.timer.abort();
            }
        }
        self.dispatch.heartbeat(lease, &Value::Null).await?;
        let mut state = self.leases.lock().unwrap();
        anyhow::ensure!(!state.closing, "{CLOSING}");
        let service = Arc::downgrade(self);
        let timer_lease = lease.clone();
        let timer = tokio::spawn(async move {
            let period = std::time::Duration::from_millis((task_dispatch::LEASE_MS / 3) as u64);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let Some(service) = service.upgrade() else {
                    return;
                };
                let lease = timer_lease.clone();
                drop(service.operations.clone().run(async move {
                    if let Err(error)=service.dispatch.heartbeat(&lease,&Value::Null).await {
                        service.release(&lease["cycleId"]);
                        if !error.is::<task_dispatch::Conflict>(){service.log("warn","Could not retain the Task Goal dispatch lease",json!({"cycleId":lease["cycleId"],"err":logging::error_details(&error)}));}
                    }Ok(())
                }));
            }
        });
        if let Some(prior) = state.retained.insert(
            cycle,
            Retained {
                lease: lease.clone(),
                timer,
            },
        ) {
            prior.timer.abort();
        }
        Ok(())
    }
    pub fn reconcile(
        self: &Arc<Self>,
        owner: &str,
        source: &Value,
        state: &Value,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, source, state) = (
            self.clone(),
            owner.to_owned(),
            source.clone(),
            state.clone(),
        );
        self.operations
            .run(async move { this.reconcile_one(&owner, &source, &state).await })
    }
    pub(super) async fn reconcile_one(
        self: &Arc<Self>,
        owner: &str,
        source: &Value,
        state: &Value,
    ) -> Result<()> {
        let Some(lease) = goal_dispatch_lease(source)? else {
            return Ok(());
        };
        if state == "implementing" || state == "paused" {
            return self.retain_one(&lease).await;
        }
        if !matches!(state.as_str(), Some("blocked" | "complete" | "failed")) {
            return Ok(());
        }
        if state != "complete"
            && self
                .lanes
                .pending_transition(owner, &text(&source["chatId"])?)
                .await?
                .is_some()
        {
            return self.retain_one(&lease).await;
        }
        self.release(&lease["cycleId"]);
        let settled: Result<()> = async {
            self.dispatch.heartbeat(&lease, &Value::Null).await?;
            self.dispatch
                .settle(
                    &lease,
                    if state == "failed" {
                        "failed"
                    } else {
                        "succeeded"
                    },
                    &Value::Null,
                )
                .await?;
            Ok(())
        }
        .await;
        if let Err(error) = settled
            && !error.is::<task_dispatch::Conflict>()
        {
            return Err(error);
        }
        self.publish(owner, &text(&source["chatId"])?, "task", None);
        (self.dependencies.queue_tick)();
        Ok(())
    }
}
