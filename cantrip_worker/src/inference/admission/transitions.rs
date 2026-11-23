use super::*;
impl Manager {
    pub(super) fn start(&self, id: Id) -> Result<()> {
        self.edit(|state, effects| {
            let ticket = &state.tickets[&id];
            if ticket.phase != Phase::Granted
                || ticket.signal.check().is_err()
                || state.closing
                || state
                    .runtimes
                    .get(&ticket.runtime)
                    .is_none_or(|runtime| runtime.retired || runtime.retiring.is_some())
                || !self.native_available()
            {
                bail!("The inference grant is no longer available.");
            }
            let ticket = state.tickets.get_mut(&id).unwrap();
            self.transition(ticket, Phase::Running);
            ticket.parked_grant = false;
            ticket.started_at = Some(self.wall());
            self.observe(state, id, effects);
            self.diagnose(state, id, "running", None, effects);
            self.changed(state, effects);
            Ok(())
        })
    }
    pub(super) fn bind_native(&self, id: Id, input: Value) -> Result<Promise<()>> {
        self.edit(|state, effects| {
            let ticket = &state.tickets[&id];
            if !ticket.external_work.is_empty() {
                bail!("Native inference cannot overlap its model-operation preparation.");
            }
            if state
                .runtimes
                .get(&ticket.runtime)
                .is_some_and(|runtime| runtime.direct_owner.is_some())
            {
                bail!("Direct HTTP inference cannot bind a native execution.");
            }
            let execution = super::super::journal::checked(
                "workerAdmissionNativeExecutionSchema",
                Some(&input),
            )?;
            self.binding_current(state, id)?;
            let ticket = state.tickets.get_mut(&id).unwrap();
            if ticket
                .native_execution
                .as_ref()
                .is_some_and(|previous| previous.stringify() != execution.stringify())
            {
                bail!("An inference grant cannot change its native execution.");
            }
            ticket.native_execution = Some(execution.clone());
            ticket.parked_grant = false;
            if let Some(pending) = &ticket.native_binding {
                return Ok(pending.clone());
            }
            let key = ticket.journal_key.clone();
            let task = types::nullish(&ticket.input.recovery)["taskInput"].clone();
            let generation = ticket.generation.clone();
            let signal = ticket.signal.clone();
            let pending = self.ticket_task(state, effects, id, move |manager| {
                Box::pin(async move {
                    if let Some(key) = key
                        && let Some(journal) = &manager.0.journal
                    {
                        let record = journal.bind_native(key, execution.clone()).await?;
                        if record["nativeExecution"].stringify() != execution.stringify() {
                            bail!("The keeper did not acknowledge this native binding.");
                        }
                    }
                    if coercion::truthy(Some(&task))
                        && let Some(bound) = &manager.0.options.task_bound
                    {
                        bound(task, execution, generation, signal).await?;
                    }
                    manager.edit(|state, _| manager.binding_current(state, id))
                })
            });
            state.tickets.get_mut(&id).unwrap().native_binding = Some(pending.clone());
            Ok(pending)
        })
    }
    fn binding_current(&self, state: &State, id: Id) -> Result<()> {
        let ticket = &state.tickets[&id];
        if !matches!(ticket.phase, Phase::Granted | Phase::Running)
            || ticket.signal.check().is_err()
            || state.closing
            || state
                .runtimes
                .get(&ticket.runtime)
                .is_none_or(|runtime| runtime.retired || runtime.retiring.is_some())
            || !self.native_available()
        {
            bail!("The native inference binding lost its owning grant.");
        }
        Ok(())
    }
    pub(super) fn cancel(&self, id: Id, reason: anyhow::Error) {
        let _ = self.edit(|state, effects| {
            if state.tickets.contains_key(&id) {
                self.cancel_locked(state, id, reason, effects);
            }
            Ok(())
        });
    }
    pub(super) fn cancel_locked(
        &self,
        state: &mut State,
        id: Id,
        reason: anyhow::Error,
        effects: &mut Effects,
    ) {
        let ticket = &state.tickets[&id];
        if matches!(ticket.phase, Phase::Released | Phase::Cancelling) {
            return;
        }
        self.diagnose(state, id, "cancel-requested", None, effects);
        let ticket = state.tickets.get_mut(&id).unwrap();
        let abort = ticket.abort.clone();
        let provider = ticket.input.provider_id.clone();
        if !ticket.external_work.is_empty() {
            ticket
                .pending_settlement
                .get_or_insert(if ticket.started_at.is_none() {
                    Outcome::NeverStarted
                } else {
                    Outcome::Interrupted
                });
            self.transition(ticket, Phase::Cancelling);
            let failure = Failure::new(reason);
            ticket.resolve.finish(Err(failure.error()));
            let pool = state.pools.get_mut(&provider).unwrap();
            pool.queue.retain(|entry| *entry != id);
            pool.suspended.shift_remove(&id);
            effects.push(Box::new(move |_| abort.abort(failure.error())));
            self.observe(state, id, effects);
            self.drain(state, &provider, effects);
            self.changed(state, effects);
            return;
        }
        if ticket.phase == Phase::Running {
            self.transition(ticket, Phase::Cancelling);
            self.observe(state, id, effects);
            self.changed(state, effects);
            effects.push(Box::new(move |_| abort.abort(reason)));
            return;
        }
        let outcome = if ticket.started_at.is_none() {
            Outcome::NeverStarted
        } else if state
            .runtimes
            .get(&ticket.runtime)
            .is_some_and(|runtime| runtime.retiring.is_some())
        {
            Outcome::RuntimeExited
        } else {
            Outcome::Interrupted
        };
        self.release_locked(state, id, outcome, effects);
        let failure = Failure::new(reason);
        state.tickets[&id].resolve.finish(Err(failure.error()));
        effects.push(Box::new(move |_| abort.abort(failure.error())));
    }
    pub(super) fn settle(&self, id: Id, outcome: Outcome) -> Result<()> {
        self.edit(|state, effects| self.settle_locked(state, id, outcome, effects))
    }
    pub(super) fn settle_locked(
        &self,
        state: &mut State,
        id: Id,
        outcome: Outcome,
        effects: &mut Effects,
    ) -> Result<()> {
        let ticket = state.tickets.get_mut(&id).unwrap();
        if ticket.phase == Phase::Released {
            return Ok(());
        }
        if outcome == Outcome::NeverStarted && ticket.started_at.is_some() {
            bail!("A started inference must be settled by its execution owner.");
        }
        if !ticket.external_work.is_empty() {
            ticket.pending_settlement.get_or_insert(outcome);
            self.cancel_locked(
                state,
                id,
                anyhow!("The native owner settled during model-operation preparation."),
                effects,
            );
            return Ok(());
        }
        let waiting = ticket.phase == Phase::Waiting;
        self.release_locked(state, id, outcome, effects);
        if waiting {
            state.tickets[&id].resolve.finish(Err(anyhow!(
                "Inference settled before admission: {}.",
                outcome.name()
            )));
        }
        Ok(())
    }
    fn release_locked(&self, state: &mut State, id: Id, outcome: Outcome, effects: &mut Effects) {
        let ticket = state.tickets.get_mut(&id).unwrap();
        ticket.resolve_queued.finish(Err(anyhow!(
            "Inference ended before its enqueue acknowledgement."
        )));
        self.transition(ticket, Phase::Released);
        let provider = ticket.input.provider_id.clone();
        let runtime = ticket.runtime;
        let operation = ticket.input.operation_id.clone();
        let key = ticket.journal_key.clone();
        let native = ticket.native_execution.is_some();
        let recovery = types::nullish(&ticket.input.recovery);
        let chat = types::nullish(&ticket.input.chat_id);
        let goal = (coercion::truthy(recovery.get("autonomousGoal"))
            || coercion::truthy(recovery.get("taskGoalCycle")))
            && (!native || outcome == Outcome::NeverStarted)
            && identity::queue(&chat, &recovery).is_some()
            && (coercion::truthy(recovery.get("taskGoalCycle"))
                || Value::String(operation.clone()) == recovery["commandGeneration"])
            && matches!(outcome, Outcome::NeverStarted | Outcome::RuntimeExited);
        self.diagnose(state, id, "released", Some(outcome), effects);
        if let Some(key) = key {
            if goal {
                state.recovery_pending.insert(key.clone(), provider.clone());
            }
            let journal = self.0.journal.clone().unwrap();
            let pending = self.ticket_task(state, effects, id, move |manager| {
                Box::pin(async move {
                    let result = if goal {
                        manager
                            .release_goal_with_retry(key, outcome, chat.as_js_string().cloned())
                            .await
                    } else {
                        journal.release(key, outcome.name().into()).await
                    };
                    if let Err(error) = &result {
                        manager.journal_error(Failure::new(anyhow!("{error}")).error());
                    }
                    result
                })
            });
            state.tickets.get_mut(&id).unwrap().release_receipt = Some(pending);
        }
        self.observe(state, id, effects);
        let ticket = state.tickets.get_mut(&id).unwrap();
        ticket.input.observe = None;
        ticket.input.admitted = None;
        if let Some(listener) = ticket.cancellation_listener.take() {
            listener.abort();
        }
        if let Some(pool) = state.pools.get_mut(&provider) {
            pool.suspended.shift_remove(&id);
            pool.active.shift_remove(&id);
            pool.queue.retain(|entry| *entry != id);
        }
        self.drain(state, &provider, effects);
        self.prune_pool(state, &provider);
        self.changed(state, effects);
        if let Some(runtime) = state.runtimes.get_mut(&runtime)
            && runtime
                .records
                .get(&operation)
                .is_some_and(|(ticket, _)| *ticket == id)
        {
            runtime.records.shift_remove(&operation);
        }
        state.tickets[&id].resolve_settlement.finish(Ok(()));
    }
    async fn release_goal_with_retry(
        &self,
        key: String,
        outcome: Outcome,
        chat: Option<JsString>,
    ) -> Result<Value> {
        let signal = &self.0.recovery_signal;
        let mut delay = 1000;
        loop {
            signal.check()?;
            match self
                .0
                .journal
                .as_ref()
                .unwrap()
                .release(key.clone(), outcome.name().into())
                .await
            {
                Ok(record) => {
                    self.wake_recovery(chat);
                    return Ok(record);
                }
                Err(error) => {
                    signal.check()?;
                    self.journal_error(error);
                    crate::metadata::Guard::request(Some(signal.clone()))
                        .delay(delay)
                        .await?;
                    delay = (delay * 2).min(30_000);
                }
            }
        }
    }
}
