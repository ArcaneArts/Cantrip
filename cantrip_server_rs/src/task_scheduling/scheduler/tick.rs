use super::*;
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Task scheduler identity")?
        .lossy()
        .into_owned())
}
impl Service {
    pub(super) async fn tick(self: &Arc<Self>) -> Result<()> {
        self.dependencies.retries.tick().await?;
        for owner in self.dispatch.list_scheduler_owners().await? {
            let owner_id = text(&owner["ownerId"])?;
            let plan = task_dispatch::scheduler_plan(&owner);
            if plan["reconcileStartedLeases"] == true {
                self.dependencies.recovery.reconcile(&owner_id).await?;
            }
            let requeued = if plan["reconcileUnstartedClaims"] == true {
                self.dispatch
                    .requeue_expired_leases(&owner_id, &Value::Null)
                    .await?
            } else {
                Value::Array(Vec::new())
            };
            let count = requeued.as_array().context("Requeued Task claims")?.len();
            if count > 0 {
                self.log("warn", "Requeued expired Task claims that had not started", json!({"event":"task.scheduler.unstarted-leases-requeued","subsystem":"task-scheduler","operation":"reconcile-leases","status":"requeued","counts":json!({"requeued":count})}));
            }
            let expired = if plan["reconcileStartedLeases"] == true {
                self.dispatch
                    .expire_started_leases(&owner_id, &Value::Null)
                    .await?
            } else {
                Value::Array(Vec::new())
            };
            let expired = expired.as_array().context("Expired Task claims")?;
            for cycle in expired {
                if let Err(error) = self
                    .tasks
                    .fail_operation(
                        &owner_id,
                        &text(&cycle["chatId"])?,
                        &text(&cycle["operationId"])?,
                        None,
                    )
                    .await
                {
                    self.log("error", "Could not reconcile an expired started Task lease", json!({"chatId":cycle["chatId"],"cycleId":cycle["id"],"err":logging::error_details(&error),"event":"task.scheduler.started-lease-reconcile-failed","subsystem":"task-scheduler","operation":"reconcile-leases","status":"failed"}));
                }
                self.dependencies.live.publish_invalidation(
                    &owner_id,
                    &text(&cycle["chatId"])?,
                    "task",
                    None,
                );
            }
            if !expired.is_empty() {
                self.log("warn", "Expired started Task leases require user attention", json!({"event":"task.scheduler.started-leases-expired","subsystem":"task-scheduler","operation":"reconcile-leases","status":"attention-required","counts":json!({"expired":expired.len()})}));
            }
            let lease_owner = format!(
                "{}:{}",
                self.dependencies.server_id, self.dependencies.instance_id
            );
            if plan["resumePaused"] == true {
                let resolve = self
                    .dependencies
                    .eligibility
                    .prepare_resume(owner_id.clone())
                    .await?;
                while let Some(claim) = self
                    .dispatch
                    .resume_next_paused(&owner_id, &lease_owner, resolve.clone(), &Value::Null)
                    .await?
                {
                    let (this, owner) = (self.clone(), owner_id.clone());
                    // Calling run admits owned execution immediately, matching
                    // the nonblocking Source invocation before its next claim.
                    let resumed = self.dependencies.resumed.run(&owner, &claim);
                    drop(self.operations.spawn(async move {
                        if let Err(error) = resumed.await {
                            this.log("error", "Paused Task resume failed", json!({"chatId":claim["cycle"]["chatId"],"cycleId":claim["cycle"]["id"],"err":logging::error_details(&error)}));
                        }
                        Ok(())
                    }));
                }
            }
            if plan["claimQueued"] == true || count > 0 {
                let prepared = self
                    .dependencies
                    .eligibility
                    .prepare_dispatch(owner_id.clone())
                    .await?;
                while let Some(claim) = self
                    .dispatch
                    .claim_next(&owner_id, &lease_owner, prepared.resolver(), &Value::Null)
                    .await?
                {
                    self.log("info", "Queued Task claimed for execution", json!({"event":"task.scheduler.claimed","subsystem":"task-scheduler","operation":"claim-task","status":"completed","chatId":claim["cycle"]["chatId"],"cycleId":claim["cycle"]["id"],"taskWorkerId":claim["cycle"]["selectedTaskWorkerId"],"workerId":claim["cycle"]["physicalWorkerId"],"modelRouteId":claim["cycle"]["modelRouteId"],"providerAccountId":claim["cycle"]["providerAccountId"],"serverVersion":crate::settings::quota::server_version(),"attempt":claim["cycle"]["attemptCount"]}));
                    let runtime = prepared.runtime_for_claim(&claim);
                    let launched =
                        self.dependencies
                            .claimed
                            .run(&owner_id, &claim, runtime.as_ref());
                    let this = self.clone();
                    drop(self.operations.spawn(async move {
                        if let Err(error) = launched.await {
                            this.log("error", "Scheduled Task execution failed", json!({"event":"task.scheduler.execution-failed","subsystem":"task-scheduler","operation":"launch-task","status":"failed","chatId":claim["cycle"]["chatId"],"cycleId":claim["cycle"]["id"],"serverVersion":crate::settings::quota::server_version(),"err":logging::error_details(&error)}));
                        }
                        Ok(())
                    }));
                }
            }
        }
        Ok(())
    }
}
