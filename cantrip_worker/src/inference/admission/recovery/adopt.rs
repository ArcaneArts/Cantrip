use super::*;
impl Manager {
    pub(in crate::inference::admission) fn adopt_restorations(
        &self,
        state: &mut State,
        effects: &mut Effects,
    ) {
        for waiter_id in state.restored.values().copied().collect::<IndexSet<_>>() {
            let waiter = &state.waiters[&waiter_id];
            if waiter.claimed.is_some() {
                continue;
            }
            let logical = identity::queue(
                &waiter.record["identity"]["chatId"],
                &waiter.record["identity"]["recovery"],
            );
            if logical.is_none() {
                continue;
            }
            if self.recovery_snapshot().iter().any(|record| {
                state
                    .recovery_pending
                    .contains_key(record["key"].as_str().unwrap())
                    && identity::queue(
                        &record["identity"]["chatId"],
                        &record["identity"]["recovery"],
                    ) == logical
            }) {
                continue;
            }
            let ticket_id = state
                .pools
                .values()
                .flat_map(|pool| &pool.queue)
                .copied()
                .find(|id| {
                    let ticket = &state.tickets[id];
                    ticket.phase == Phase::Waiting
                        && ticket.started_at.is_none()
                        && !ticket.recovery_pending
                        && identity::queue(
                            &types::nullish(&ticket.input.chat_id),
                            &types::nullish(&ticket.input.recovery),
                        ) == logical
                });
            let Some(id) = ticket_id.filter(|id| state.tickets[id].journal_key.is_some()) else {
                continue;
            };
            let waiter = state.waiters.get_mut(&waiter_id).unwrap();
            waiter.claimed = Some(id);
            let ticket = state.tickets.get_mut(&id).unwrap();
            ticket.task_goal_recovery = waiter.task_goal_recovery.clone().unwrap_or(Value::Null);
            ticket.recovery_pending = true;
            ticket.durable_queue_ready = false;
            let order = waiter
                .records
                .iter()
                .filter(|record| {
                    record["identity"]["providerId"]
                        == Value::String(ticket.input.provider_id.clone())
                })
                .map(|record| record["order"].as_f64().unwrap())
                .chain(ticket.restored_order)
                .reduce(f64::min);
            ticket.restored_order = order;
            let records = waiter.records.clone();
            let identity = ticket.input.identity(&ticket.generation);
            let options = AdoptOptions {
                retained_order: order,
                task_input_not_dispatched: waiter.task_input.clone(),
                goal_input_not_dispatched: waiter.goal_input.clone(),
                task_goal_cycle_not_dispatched: waiter.task_goal.clone(),
                ..Default::default()
            };
            drop(self.ticket_task(state, effects, id, move |manager| {
                Box::pin(async move {
                    let result = manager
                        .adopt_with_retry(id, identity, records.clone(), options)
                        .await;
                    match result {
                        Ok(()) => {
                            let requeue = manager.edit(|state, effects| {
                                for record in &records {
                                    manager
                                        .remove_restoration(state, record["key"].as_str().unwrap());
                                }
                                let remaining =
                                    if let Some(waiter) = state.waiters.get_mut(&waiter_id) {
                                        waiter.claimed = None;
                                        waiter.records.len()
                                    } else {
                                        0
                                    };
                                let ticket = state.tickets.get_mut(&id).unwrap();
                                ticket.recovery_pending = false;
                                let requeue = if ticket.phase == Phase::Waiting
                                    && ticket.queue_revision > 0
                                {
                                    ticket.restored_order = None;
                                    Some(ticket.queue_revision)
                                } else {
                                    if ticket.phase == Phase::Waiting {
                                        ticket.durable_queue_ready = remaining == 0;
                                    }
                                    None
                                };
                                if remaining == 0 {
                                    state.waiters.shift_remove(&waiter_id);
                                }
                                Ok(requeue.map(|revision| {
                                    manager.persist_requeue(state, id, revision, effects)
                                }))
                            })?;
                            if let Some(requeue) = requeue {
                                requeue.work().await?;
                            }
                            manager.edit(|state, effects| {
                                manager.adopt_restorations(state, effects);
                                for provider in state.pools.keys().cloned().collect::<Vec<_>>() {
                                    manager.drain(state, &provider, effects);
                                }
                                manager.changed(state, effects);
                                Ok(())
                            })
                        }
                        Err(error) => {
                            let failure = Failure::new(error);
                            let chat = manager.edit(|state, effects| {
                                if let Some(waiter) = state.waiters.get_mut(&waiter_id) {
                                    waiter.claimed = None;
                                }
                                let ticket = state.tickets.get_mut(&id).unwrap();
                                ticket.recovery_pending = false;
                                ticket.restored_order = None;
                                let chat = ticket
                                    .input
                                    .chat_id
                                    .as_ref()
                                    .and_then(Value::as_js_string)
                                    .cloned();
                                manager.cancel_locked(state, id, failure.error(), effects);
                                Ok(chat)
                            })?;
                            manager.journal_error(failure.error());
                            manager.wake_recovery(chat);
                            Err(failure.error())
                        }
                    }
                })
            }));
        }
    }
    async fn adopt_with_retry(
        &self,
        id: Id,
        identity: Value,
        records: Vec<Value>,
        mut options: AdoptOptions,
    ) -> Result<()> {
        let (key, signal) = {
            let state = self.0.state.lock().unwrap();
            let ticket = &state.tickets[&id];
            (
                ticket.journal_key.clone().unwrap(),
                Signal::any(vec![ticket.signal.clone(), self.0.recovery_signal.clone()]),
            )
        };
        let check = signal.clone();
        options.assert_current = Arc::new(move || check.check());
        let mut delay = 1000;
        loop {
            signal.check()?;
            self.edit(|state, _| {
                let ticket = &state.tickets[&id];
                if ticket.phase != Phase::Waiting
                    && !(ticket.parked_waiting && ticket.phase == Phase::Suspended)
                {
                    bail!("Recovered admission is no longer waiting.");
                }
                options.retained_order = ticket.restored_order;
                Ok(())
            })?;
            match self
                .0
                .journal
                .as_ref()
                .unwrap()
                .adopt(
                    key.clone(),
                    identity.clone(),
                    records.clone(),
                    options.clone(),
                )
                .await
            {
                Ok(_) => return Ok(()),
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
