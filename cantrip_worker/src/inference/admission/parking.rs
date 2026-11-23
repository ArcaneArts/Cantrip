use super::*;
impl Manager {
    pub(super) fn pause_waiting(&self, id: Id, unforwarded_grant: bool) -> bool {
        self.edit(|state, effects| {
            let ticket = &state.tickets[&id];
            if !ticket.external_work.is_empty() {
                return Ok(false);
            }
            if ticket.parked_waiting && ticket.phase == Phase::Suspended {
                if ticket.parked_grant {
                    self.persist_parked_grant(state, id, effects);
                }
                return Ok(true);
            }
            let granted = unforwarded_grant
                && ticket.phase == Phase::Granted
                && ticket.started_at.is_none()
                && ticket.native_execution.is_none();
            if ticket.phase != Phase::Waiting && !granted || ticket.signal.check().is_err() {
                return Ok(false);
            }
            let ticket = state.tickets.get_mut(&id).unwrap();
            if granted && ticket.permission_granted {
                let (complete, pending) = Promise::pair();
                ticket.resolve = complete;
                ticket.permission = pending;
            }
            ticket.permission_granted = false;
            ticket.parked_grant |= granted;
            ticket.parked_waiting = true;
            ticket.queue_revision += 1;
            self.transition(ticket, Phase::Suspended);
            let provider = ticket.input.provider_id.clone();
            let parked = ticket.parked_grant;
            let pool = state.pools.get_mut(&provider).unwrap();
            pool.queue.retain(|entry| *entry != id);
            pool.active.shift_remove(&id);
            pool.suspended.insert(id);
            if parked {
                self.persist_parked_grant(state, id, effects);
            }
            self.diagnose(state, id, "suspended", None, effects);
            self.observe(state, id, effects);
            self.drain(state, &provider, effects);
            self.changed(state, effects);
            Ok(true)
        })
        .unwrap()
    }
    fn persist_parked_grant(&self, state: &mut State, id: Id, effects: &mut Effects) {
        let ticket = &state.tickets[&id];
        if ticket.pause_receipt.is_some()
            && ticket.pause_receipt_revision == ticket.queue_revision as i64
            || self.0.journal.is_none()
            || ticket.journal_key.is_none()
        {
            return;
        }
        let revision = ticket.queue_revision;
        let enqueued = ticket.journal_enqueued.clone();
        let prior = ticket.journal_requeue.clone();
        let key = ticket.journal_key.clone().unwrap();
        let pending = self.ticket_task(state, effects, id, move |manager| {
            Box::pin(async move {
                let result = async {
                    if let Some(enqueued) = enqueued {
                        enqueued.work().await?;
                    }
                    if let Some(prior) = prior {
                        let _ = prior.work().await;
                    }
                    let record = manager
                        .0
                        .journal
                        .as_ref()
                        .unwrap()
                        .release(key, "never-started".into())
                        .await?;
                    if coercion::truthy(record.get("nativeExecution"))
                        || record["outcome"] != "never-started"
                    {
                        bail!(
                            "The parked input did not receive its durable no-start acknowledgement."
                        );
                    }
                    Ok(record)
                }
                .await;
                if let Err(error) = &result {
                    let _ = manager.edit(|state, _| {
                        let ticket = state.tickets.get_mut(&id).unwrap();
                        if ticket.pause_receipt_revision == revision as i64 {
                            ticket.pause_receipt = None;
                        }
                        Ok(())
                    });
                    manager.journal_error(Failure::new(anyhow!("{error}")).error());
                }
                result
            })
        });
        let ticket = state.tickets.get_mut(&id).unwrap();
        ticket.pause_receipt = Some(pending);
        ticket.pause_receipt_revision = revision as i64;
    }
    pub(super) fn confirm_pause(&self, id: Id) -> Work<()> {
        let (enqueued, receipt) = {
            let state = self.0.state.lock().unwrap();
            let ticket = &state.tickets[&id];
            (
                ticket.journal_enqueued.clone(),
                ticket.pause_receipt.clone(),
            )
        };
        cantrip_transport::lifecycle::owned(async move {
            if let Some(enqueued) = enqueued {
                enqueued.work().await?;
            }
            if let Some(receipt) = receipt {
                receipt.work().await?;
            }
            Ok(())
        })
    }
    pub(super) fn resume_waiting(&self, id: Id) -> Result<()> {
        self.edit(|state, effects| {
            let ticket = &state.tickets[&id];
            if !ticket.parked_waiting {
                return Ok(());
            }
            if ticket.phase != Phase::Suspended || ticket.signal.check().is_err() {
                bail!("The parked native inference is no longer available.");
            }
            state.tickets.get_mut(&id).unwrap().parked_waiting = false;
            self.requeue_suspended(state, id, effects);
            Ok(())
        })
    }
    fn requeue_suspended(&self, state: &mut State, id: Id, effects: &mut Effects) {
        state.sequence += 1.;
        let ticket = state.tickets.get_mut(&id).unwrap();
        self.transition(ticket, Phase::Waiting);
        ticket.sequence = state.sequence;
        ticket.restored_order = None;
        ticket.enqueued_at = self.wall();
        ticket.queue_revision += 1;
        let revision = ticket.queue_revision;
        ticket.durable_queue_ready = ticket.journal_key.is_none();
        let persist = ticket.journal_key.is_some() && !ticket.recovery_pending;
        let provider = ticket.input.provider_id.clone();
        let pool = state.pools.get_mut(&provider).unwrap();
        pool.suspended.shift_remove(&id);
        pool.queue.push(id);
        self.diagnose(state, id, "resumed", None, effects);
        if persist {
            drop(self.persist_requeue(state, id, revision, effects));
        }
        self.observe(state, id, effects);
        self.adopt_restorations(state, effects);
        self.drain(state, &provider, effects);
        self.changed(state, effects);
    }
    pub(super) fn persist_requeue(
        &self,
        state: &mut State,
        id: Id,
        revision: u64,
        effects: &mut Effects,
    ) -> Promise<bool> {
        let ticket = &state.tickets[&id];
        let preceding = ticket.journal_requeue.clone();
        let pause = ticket.pause_receipt.clone();
        let pause_revision = ticket.pause_receipt_revision;
        let enqueued = ticket.journal_enqueued.clone();
        let key = ticket.journal_key.clone().unwrap();
        let pending = self.ticket_task(state, effects, id, move |manager| {
            Box::pin(async move {
                let result = async {
                    if let Some(enqueued) = enqueued {
                        enqueued.work().await?;
                    }
                    if let Some(pause) = pause {
                        let _ = pause.work().await;
                    }
                    if let Some(preceding) = preceding {
                        preceding.work().await?;
                    }
                    let current = manager.edit(|state, _| {
                        let ticket = &state.tickets[&id];
                        Ok(ticket.phase == Phase::Waiting
                            && ticket.queue_revision == revision
                            && !ticket.recovery_pending)
                    })?;
                    if !current {
                        return Ok(false);
                    }
                    manager.0.journal.as_ref().unwrap().requeue(key).await?;
                    manager.edit(|state, effects| {
                        let ticket = state.tickets.get_mut(&id).unwrap();
                        if ticket.pause_receipt_revision == pause_revision {
                            ticket.pause_receipt = None;
                        }
                        if ticket.phase != Phase::Waiting || ticket.queue_revision != revision {
                            return Ok(());
                        }
                        ticket.durable_queue_ready = !ticket.recovery_pending;
                        let provider = ticket.input.provider_id.clone();
                        manager.drain(state, &provider, effects);
                        manager.changed(state, effects);
                        Ok(())
                    })?;
                    Ok(true)
                }
                .await;
                if let Err(error) = result {
                    let failure = Failure::new(error);
                    manager.cancel(id, failure.error());
                    manager.journal_error(failure.error());
                    return Err(failure.error());
                }
                result
            })
        });
        state.tickets.get_mut(&id).unwrap().journal_requeue = Some(pending.clone());
        pending
    }
    pub(super) fn suspend(&self, id: Id, unused_preparation: bool) -> Result<()> {
        self.edit(|state, effects| self.suspend_locked(state, id, unused_preparation, effects))
    }
    pub(super) fn suspend_locked(
        &self,
        state: &mut State,
        id: Id,
        unused_preparation: bool,
        effects: &mut Effects,
    ) -> Result<()> {
        let ticket = &state.tickets[&id];
        if !ticket.external_work.is_empty() && !unused_preparation {
            bail!("Native suspension cannot release a model-operation preparation's capacity.");
        }
        if ticket.phase == Phase::Suspended {
            return Ok(());
        }
        if !(matches!(ticket.phase, Phase::Running | Phase::Cancelling)
            || unused_preparation
                && !ticket.external_work.is_empty()
                && ticket.native_execution.is_none()
                && ticket.phase == Phase::Granted)
        {
            bail!("Only a running inference can enter a native suspension boundary.");
        }
        let ticket = state.tickets.get_mut(&id).unwrap();
        self.transition(ticket, Phase::Suspended);
        let provider = ticket.input.provider_id.clone();
        state.pools.get_mut(&provider).unwrap().suspended.insert(id);
        self.diagnose(state, id, "suspended", None, effects);
        self.observe(state, id, effects);
        state
            .pools
            .get_mut(&provider)
            .unwrap()
            .active
            .shift_remove(&id);
        self.drain(state, &provider, effects);
        if state.pools.get(&provider).is_some_and(|pool| pool.disabled) {
            self.cancel_locked(state, id, unavailable(), effects);
        }
        self.changed(state, effects);
        Ok(())
    }
    pub(super) fn resume(&self, id: Id) -> Promise<()> {
        self.edit(|state, effects| {
            let ticket = &state.tickets[&id];
            if let Some(resuming) = &ticket.resuming {
                return Ok(resuming.clone());
            }
            if ticket.phase == Phase::Running {
                return Ok(Promise::ready(Ok(())));
            }
            if ticket.phase != Phase::Suspended || ticket.signal.check().is_err() {
                return Ok(Promise::ready(Err(anyhow!(
                    "The suspended inference is no longer available."
                ))));
            }
            let (complete, ready) = Promise::pair();
            let ticket = state.tickets.get_mut(&id).unwrap();
            ticket.permission = ready.clone();
            ticket.resolve = complete;
            ticket.permission_granted = false;
            let resuming = self.ticket_task(state, effects, id, move |manager| {
                Box::pin(async move {
                    let result = async {
                        ready.work().await?;
                        manager.start(id)
                    }
                    .await;
                    let _ = manager.edit(|state, _| {
                        state.tickets.get_mut(&id).unwrap().resuming = None;
                        Ok(())
                    });
                    result
                })
            });
            state.tickets.get_mut(&id).unwrap().resuming = Some(resuming.clone());
            self.requeue_suspended(state, id, effects);
            Ok(resuming)
        })
        .unwrap()
    }
}
