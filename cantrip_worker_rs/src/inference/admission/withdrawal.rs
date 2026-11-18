use super::*;
impl Manager {
    pub(super) fn withdraw_before_request(
        &self,
        runtime_id: Id,
        request: Request,
        reason: anyhow::Error,
        settled: Promise<()>,
    ) -> Result<Promise<Value>> {
        self.edit(|state, effects| {
            let generation = state
                .runtimes
                .get(&runtime_id)
                .map(|runtime| runtime.generation.clone())
                .unwrap_or_else(|| request.lifetime.runtime_generation().clone());
            let identity = request.input.identity(&generation);
            let signature = json!([
                identity["operationId"].clone(),
                identity["providerId"].clone(),
                identity["runtimeGeneration"].clone(),
                identity["recoveryKey"].clone(),
                json!(identity::recovery(&identity["recovery"])),
                identity["chatId"].clone(),
                identity["projectId"].clone()
            ])
            .stringify();
            let valid_lifetime = request.lifetime.0.runtime == runtime_id
                && Weak::ptr_eq(&request.lifetime.0.manager, &Arc::downgrade(&self.0));
            let mut life = request.lifetime.0.state.lock().unwrap();
            if valid_lifetime && let Some(withdrawal) = &life.withdrawal {
                if life.withdrawal_identity.as_deref() != Some(&signature) {
                    bail!("The unrequested withdrawal changed its canonical identity.");
                }
                return Ok(withdrawal.clone());
            }
            if self.0.journal.is_none()
                || state.closing
                || state.runtimes.get(&runtime_id).is_none_or(|runtime| {
                    runtime.retiring.is_some()
                        || runtime.retired
                        || !runtime.prepared
                        || runtime.records.contains_key(&request.operation_id)
                })
                || !valid_lifetime
                || request.lifetime.operation_id() != &request.operation_id
                || life.closed
                || life.ticket.is_some()
            {
                return Err(unused(
                    "The source is no longer an unrequested live operation.",
                ));
            }
            if let Some(signal) = &request.signal {
                signal.check()?;
            }
            life.closed = true;
            life.rejection = Some(Failure::new(reason));
            life.withdrawal_identity = Some(signature);
            let journal = self.0.journal.clone().unwrap();
            let key = journal.key(&generation, &request.operation_id);
            state
                .unrequested_settlements
                .insert(key.clone(), settled.clone());
            let weak = Arc::downgrade(&self.0);
            let observed = settled.clone();
            let observed_key = key.clone();
            effects.push(Box::new(move |_| {
                tokio::spawn(async move {
                    let result = observed.work().await;
                    if let Some(owner) = weak.upgrade() {
                        let manager = Manager(owner);
                        match result {
                            Ok(()) => {
                                let mut state = manager.0.state.lock().unwrap();
                                if state
                                    .unrequested_settlements
                                    .get(&observed_key)
                                    .is_some_and(|current| current.same(&observed))
                                {
                                    state.unrequested_settlements.remove(&observed_key);
                                }
                            }
                            Err(error) => manager.journal_error(error),
                        }
                    }
                });
            }));
            let (complete, pending) = Promise::pair();
            life.withdrawal = Some(pending.clone());
            effects.push(Box::new(move |_| {
                let write = journal.seal_unstarted(key, identity);
                tokio::spawn(async move {
                    complete.finish(
                        async {
                            let record = write.await?;
                            settled.work().await?;
                            Ok(record)
                        }
                        .await,
                    );
                });
            }));
            Ok(pending)
        })
    }
    pub fn withdrawal_record(&self, expected: Value) -> Work<Option<Value>> {
        let manager = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let Some(journal) = &manager.0.journal else {
                return Ok(None);
            };
            let records = journal
                .snapshot()
                .await?
                .into_iter()
                .filter(|record| {
                    record["identity"]["operationId"] == expected["operationGeneration"]
                        && record["identity"]["chatId"] == expected["chatId"]
                        && record["identity"]["recovery"]["commandId"] == expected["operationId"]
                        && record["identity"]["recovery"]["commandGeneration"]
                            == expected["operationGeneration"]
                })
                .collect::<Vec<_>>();
            if records.is_empty()
                || records.iter().any(|record| {
                    record["state"] != "released"
                        || record["outcome"] != "never-started"
                        || coercion::truthy(record.get("nativeExecution"))
                })
            {
                return Ok(None);
            }
            let dependencies = {
                let state = manager.0.state.lock().unwrap();
                records
                    .iter()
                    .filter_map(|record| {
                        state
                            .unrequested_settlements
                            .get(record["key"].as_str().unwrap())
                            .cloned()
                    })
                    .collect::<Vec<_>>()
            };
            futures::future::try_join_all(dependencies.iter().map(Promise::work)).await?;
            Ok(records.into_iter().reduce(|latest, record| {
                if record["revision"].as_f64().unwrap() > latest["revision"].as_f64().unwrap() {
                    record
                } else {
                    latest
                }
            }))
        })
    }
    pub fn task_goal_withdrawal_record(&self, source: Value) -> Work<Option<Value>> {
        let manager = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let recovery = &source["identity"]["recovery"];
            let cycle = &recovery["taskGoalCycle"];
            let task = &recovery["taskInput"];
            let Some(journal) = &manager.0.journal else {
                return Ok(None);
            };
            if !coercion::truthy(Some(cycle)) && task["kind"] != "goal"
                || identity::queue(&source["identity"]["chatId"], recovery).is_none()
                || source["identity"]["operationId"]
                    != if coercion::truthy(Some(cycle)) {
                        native_operation(recovery)
                    } else {
                        task["operationId"].clone()
                    }
            {
                return Ok(None);
            }
            let record = journal
                .snapshot()
                .await?
                .into_iter()
                .find(|record| record["key"] == source["key"]);
            Ok(record.filter(|record| {
                record["workerGeneration"] == source["workerGeneration"]
                    && [
                        "runtimeGeneration",
                        "operationId",
                        "providerId",
                        "chatId",
                        "projectId",
                        "recoveryKey",
                    ]
                    .iter()
                    .all(|field| record["identity"][*field] == source["identity"][*field])
                    && identity::recovery(&record["identity"]["recovery"])
                        == identity::recovery(recovery)
                    && record["state"] == "released"
                    && record["outcome"] == "never-started"
                    && (!coercion::truthy(record.get("nativeExecution"))
                        || coercion::truthy(Some(cycle))
                            && binding_matches(&record["nativeExecution"], recovery))
            }))
        })
    }
    pub fn retire_withdrawal(&self, record: Value) -> Work<()> {
        let manager = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let journal = manager
                .0
                .journal
                .as_ref()
                .filter(|_| {
                    record["state"] == "released"
                        && record["outcome"] == "never-started"
                        && !coercion::truthy(record.get("nativeExecution"))
                })
                .ok_or_else(|| {
                    anyhow!("Withdrawal retirement requires exact no-start evidence.")
                })?;
            let settled = manager
                .0
                .state
                .lock()
                .unwrap()
                .unrequested_settlements
                .get(record["key"].as_str().unwrap())
                .cloned();
            if let Some(settled) = settled {
                settled.work().await?;
            }
            journal.forget(record).await
        })
    }
    fn unused_task_goal_binding(&self, state: &State, id: Id) -> Result<Value> {
        let ticket = &state.tickets[&id];
        let recovery = types::nullish(&ticket.input.recovery);
        let cycle = &recovery["taskGoalCycle"];
        if !coercion::truthy(Some(cycle))
            || !coercion::truthy(recovery.get("threadId"))
            || !coercion::truthy(recovery.get("turnId"))
            || self.0.journal.is_none()
            || ticket.journal_key.is_none()
            || !ticket.durable_queue_ready
            || !matches!(ticket.phase, Phase::Waiting | Phase::Granted)
            || ticket.started_at.is_some()
            || !ticket.external_work.is_empty()
            || ticket.signal.check().is_err()
            || state.closing
            || state
                .runtimes
                .get(&ticket.runtime)
                .is_none_or(|runtime| runtime.retired || runtime.retiring.is_some())
            || ticket.recovery_pending
            || identity::queue(&types::nullish(&ticket.input.chat_id), &recovery).is_none()
            || Value::String(ticket.input.operation_id.clone()) != native_operation(&recovery)
        {
            return Err(unused(
                "The private Task Goal begin no longer owns an unused reservation.",
            ));
        }
        let binding = json!({"threadId":recovery["threadId"],"turnId":recovery["turnId"],"scopeId":cycle["scopeId"]});
        if ticket.native_execution.as_ref().is_some_and(|native| {
            !["threadId", "turnId", "scopeId"]
                .iter()
                .all(|field| native[*field] == binding[*field])
        }) {
            return Err(unused(
                "The private Task Goal reservation has another native scope.",
            ));
        }
        Ok(binding)
    }
    fn unused_source(&self, state: &State, id: Id, revision: u64) -> Result<()> {
        let ticket = &state.tickets[&id];
        if self.0.journal.is_none()
            || ticket.journal_key.is_none()
            || !ticket.durable_queue_ready
            || !matches!(ticket.phase, Phase::Waiting | Phase::Granted)
            || ticket.started_at.is_some()
            || !ticket.external_work.is_empty()
            || ticket.native_execution.is_some()
            || ticket.signal.check().is_err()
            || state.closing
            || state
                .runtimes
                .get(&ticket.runtime)
                .is_none_or(|runtime| runtime.retired || runtime.retiring.is_some())
            || ticket.recovery_pending
            || ticket.queue_revision != revision
        {
            return Err(unused(
                "The input no longer owns an unused unbound reservation.",
            ));
        }
        Ok(())
    }
    pub(super) fn unstarted_source(&self, id: Id) -> Work<Value> {
        self.read_unused(id, false).work()
    }
    pub(super) fn private_task_goal_source(&self, id: Id) -> Work<Value> {
        self.read_unused(id, true).work()
    }
    fn read_unused(&self, id: Id, task: bool) -> Promise<Value> {
        match self.edit(|state, effects| {
            let revision = state.tickets[&id].queue_revision;
            if task {
                self.unused_task_goal_binding(state, id)?;
            } else {
                self.unused_source(state, id, revision)?;
            }
            Ok(self.ticket_task(state, effects, id, move |manager| {
                Box::pin(async move {
                    let records = manager.0.journal.as_ref().unwrap().snapshot().await?;
                    manager.edit(|state, _| {
                        if task {
                            manager.unused_task_goal_binding(state, id)?;
                        } else {
                            manager.unused_source(state, id, revision)?;
                        }
                        let ticket = &state.tickets[&id];
                        let record = records
                            .into_iter()
                            .find(|record| record["key"].as_str() == ticket.journal_key.as_deref());
                        let identity = ticket.input.identity(&ticket.generation);
                        let record = record
                            .filter(|record| {
                                record["workerGeneration"]
                                    == Value::String(
                                        manager.0.options.scope.worker_generation.clone(),
                                    )
                                    && [
                                        "runtimeGeneration",
                                        "operationId",
                                        "providerId",
                                        "chatId",
                                        "projectId",
                                        "recoveryKey",
                                    ]
                                    .iter()
                                    .all(|field| record["identity"][*field] == identity[*field])
                                    && identity::recovery(&record["identity"]["recovery"])
                                        == identity::recovery(&identity["recovery"])
                                    && matches!(
                                        record["state"].as_str(),
                                        Some("waiting" | "granted")
                                    )
                                    && record["outcome"].is_null()
                                    && (!coercion::truthy(record.get("nativeExecution"))
                                        || task
                                            && binding_matches(
                                                &record["nativeExecution"],
                                                &identity["recovery"],
                                            ))
                            })
                            .ok_or_else(|| {
                                unused(if task {
                                    "The keeper no longer observes this private Task Goal source."
                                } else {
                                    "The keeper no longer observes this unused input source."
                                })
                            })?;
                        Ok(if task {
                            record
                        } else {
                            json!({"record":record,"queueRevision":revision})
                        })
                    })
                })
            }))
        }) {
            Ok(pending) => pending,
            Err(error) => Promise::ready(Err(error)),
        }
    }
    pub(super) fn withdraw_task_goal_before_allow(
        &self,
        id: Id,
        reason: anyhow::Error,
    ) -> Result<Promise<Value>> {
        self.edit(|state, effects| {
            let ticket = &state.tickets[&id];
            if let Some(existing) = &ticket.withdrawal {
                return Ok(existing.clone());
            }
            self.unused_task_goal_binding(state, id)?;
            self.withdraw_unstarted_locked(state, effects, id, reason, true, None)
        })
    }
    pub(super) fn withdraw_unstarted(
        &self,
        id: Id,
        reason: anyhow::Error,
        task: bool,
        expected_revision: Option<u64>,
    ) -> Result<Promise<Value>> {
        self.edit(|state, effects| {
            self.withdraw_unstarted_locked(state, effects, id, reason, task, expected_revision)
        })
    }
    fn withdraw_unstarted_locked(
        &self,
        state: &mut State,
        effects: &mut Effects,
        id: Id,
        reason: anyhow::Error,
        task: bool,
        expected_revision: Option<u64>,
    ) -> Result<Promise<Value>> {
        let ticket = &state.tickets[&id];
        if let Some(withdrawal) = &ticket.withdrawal {
            return Ok(withdrawal.clone());
        }
        if self.0.journal.is_none()
            || ticket.journal_key.is_none()
            || !matches!(ticket.phase, Phase::Waiting | Phase::Granted)
            || ticket.started_at.is_some()
            || !ticket.external_work.is_empty()
            || ticket.native_execution.is_some() && !task
            || ticket.recovery_pending
            || expected_revision.is_some_and(|revision| revision != ticket.queue_revision)
        {
            return Err(unused(
                "Only an unused, durably owned inference reservation can be withdrawn.",
            ));
        }
        self.cancel_locked(state, id, reason, effects);
        let receipt = state.tickets[&id].release_receipt.clone().unwrap();
        let pending = self.ticket_task(state, effects, id, move |manager| Box::pin(async move {
                let record = receipt.work().await?;
                manager.edit(|state, _| {
                    let ticket = &state.tickets[&id]; let identity = ticket.input.identity(&ticket.generation);
                    if record["key"].as_str() != ticket.journal_key.as_deref() || record["workerGeneration"] != Value::String(manager.0.options.scope.worker_generation.clone()) || ["runtimeGeneration","operationId","providerId","recoveryKey","chatId","projectId"].iter().any(|field| record["identity"][*field] != identity[*field]) || identity::recovery(&record["identity"]["recovery"]) != identity::recovery(&identity["recovery"]) || record["state"] != "released" || record["outcome"] != "never-started" || coercion::truthy(record.get("nativeExecution")) && (!task || !binding_matches(&record["nativeExecution"], &identity["recovery"])) { bail!("Inference withdrawal did not receive its exact durable no-start receipt."); } Ok(())
                })?; Ok(record)
            }));
        state.tickets.get_mut(&id).unwrap().withdrawal = Some(pending.clone());
        Ok(pending)
    }
}
pub(super) fn binding_matches(binding: &Value, recovery: &Value) -> bool {
    binding["threadId"] == recovery["threadId"]
        && binding["turnId"] == recovery["turnId"]
        && binding["scopeId"] == recovery["taskGoalCycle"]["scopeId"]
}
pub(super) fn native_operation(recovery: &Value) -> Value {
    let mut units = JsString::from("native-inference:").units().to_vec();
    for (index, value) in [
        &recovery["threadId"],
        &recovery["turnId"],
        &recovery["taskGoalCycle"]["scopeId"],
        &recovery["taskGoalCycle"]["gateAttemptId"],
    ]
    .into_iter()
    .enumerate()
    {
        if index > 0 {
            units.push(58);
        }
        units.extend(
            coercion::string(value)
                .unwrap_or_else(|_| value.stringify().into())
                .units(),
        );
    }
    Value::String(JsString::new(units))
}
