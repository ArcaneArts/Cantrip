use super::*;
impl Manager {
    pub(super) fn request(&self, runtime_id: Id, request: Request) -> Result<Ticket> {
        self.edit(|state, effects| {
            let runtime = state
                .runtimes
                .get(&runtime_id)
                .filter(|runtime| !state.closing && !runtime.retired && runtime.retiring.is_none())
                .ok_or_else(|| anyhow!("The inference runtime has exited."))?;
            if !runtime.prepared {
                bail!("Native inference ownership is not prepared.");
            }
            let input = request.input;
            if input.operation_id.is_empty() || input.provider_id.is_empty() {
                bail!("Inference admission requires an operation and provider identity.");
            }
            let lifetime = request.lifetime;
            if lifetime.0.runtime != runtime_id
                || !Weak::ptr_eq(&lifetime.0.manager, &Arc::downgrade(&self.0))
                || lifetime.operation_id() != &input.operation_id
            {
                bail!("Inference operation lifetime belongs to another runtime or operation.");
            }
            let life = lifetime.0.state.lock().unwrap();
            if let Some(id) = life
                .ticket
                .or_else(|| runtime.records.get(&input.operation_id).map(|(id, _)| *id))
            {
                let previous = &state.tickets[&id];
                if !previous.lifetime.ptr_eq(&Arc::downgrade(&lifetime.0))
                    || previous
                        .input
                        .purpose
                        .as_ref()
                        .unwrap_or(&JsString::from("helper"))
                        != input.purpose.as_ref().unwrap_or(&JsString::from("helper"))
                    || previous.input.provider_id != input.provider_id
                    || previous.input.provider_creation_revision != input.provider_creation_revision
                    || previous.input.chat_id != input.chat_id
                    || previous.input.project_id != input.project_id
                    || types::nullish(&previous.input.recovery_key)
                        != types::nullish(&input.recovery_key)
                    || identity::recovery(&types::nullish(&previous.input.recovery))
                        != identity::recovery(&types::nullish(&input.recovery))
                {
                    bail!("An inference operation cannot change identity during redelivery.");
                }
                drop(life);
                return Ok(Ticket {
                    manager: self.clone(),
                    id,
                    _lifetime: lifetime,
                });
            }
            if life.closed {
                return Err(life.rejection.as_ref().map_or_else(
                    || anyhow!("The canonical inference operation has closed."),
                    Failure::error,
                ));
            }
            drop(life);
            if !state.pools.contains_key(&input.provider_id) {
                let mut configuration = json!({"providerId":input.provider_id});
                if let Some(revision) = input.provider_creation_revision {
                    configuration["inferenceCatalogCreatedRevision"] = json!(revision);
                }
                self.configure_locked(state, &configuration, effects)?;
            }
            let pool = state
                .pools
                .get(&input.provider_id)
                .filter(|pool| {
                    !pool.disabled
                        && input.provider_creation_revision.is_none_or(|revision| {
                            !pool.creation_known
                                || pool.configuration["inferenceCatalogCreatedRevision"].as_f64()
                                    == Some(revision)
                        })
                })
                .ok_or_else(unavailable)?;
            let _ = pool;
            let generation = state.runtimes[&runtime_id].generation.clone();
            let direct = state.runtimes[&runtime_id].direct_owner.is_some();
            let id = state.id();
            state.sequence += 1.;
            let (resolve, permission) = Promise::pair();
            let (resolve_queued, queued) = Promise::pair();
            let (resolve_settlement, settlement) = Promise::pair();
            let (abort, own_signal) = Abort::new();
            let signal = Signal::any(
                std::iter::once(own_signal)
                    .chain(input.signal.clone())
                    .collect(),
            );
            let phase = if input.initially_suspended {
                Phase::Suspended
            } else {
                Phase::Waiting
            };
            let key = if direct {
                None
            } else {
                self.0
                    .journal
                    .as_ref()
                    .map(|journal| journal.key(&generation, &input.operation_id))
            };
            let ticket = TicketData {
                work: 0,
                runtime: runtime_id,
                generation: generation.clone(),
                lease_id: uuid::Uuid::new_v4().to_string().into(),
                lifetime: Arc::downgrade(&lifetime.0),
                input: input.clone(),
                permission,
                resolve,
                queued,
                resolve_queued,
                permission_granted: false,
                parked_grant: false,
                pause_receipt: None,
                pause_receipt_revision: -1,
                task_goal_recovery: Value::Null,
                sequence: state.sequence,
                restored_order: None,
                recovery_pending: false,
                phase,
                state_since: self.now(),
                timing: [0.; 4],
                abort: Arc::new(abort),
                signal,
                enqueued_at: self.wall(),
                granted_at: None,
                started_at: None,
                resuming: None,
                parked_waiting: input.initially_suspended,
                queue_revision: 0,
                journal_enqueued: None,
                journal_requeue: None,
                journal_key: key.clone(),
                durable_queue_ready: direct || self.0.journal.is_none(),
                native_execution: None,
                native_binding: None,
                release_receipt: None,
                withdrawal: None,
                external_work: IndexMap::new(),
                pending_settlement: None,
                settlement,
                resolve_settlement,
                cancellation_listener: None,
            };
            state.tickets.insert(id, ticket);
            state
                .runtimes
                .get_mut(&runtime_id)
                .unwrap()
                .records
                .insert(input.operation_id.clone(), (id, lifetime.clone()));
            lifetime.0.state.lock().unwrap().ticket = Some(id);
            let pool = state.pools.get_mut(&input.provider_id).unwrap();
            if input.initially_suspended {
                pool.suspended.insert(id);
            } else {
                pool.queue.push(id);
            }
            if input
                .chat_id
                .as_ref()
                .is_some_and(|chat| coercion::truthy(Some(chat)))
                && input
                    .recovery
                    .as_ref()
                    .is_some_and(|recovery| coercion::truthy(Some(recovery)))
                && self.recovery_snapshot().iter().any(|record| {
                    self.recoverable(record)
                        && record["identity"]["chatId"] == types::nullish(&input.chat_id)
                        && (coercion::truthy(record["identity"]["recovery"].get("autonomousGoal"))
                            || coercion::truthy(
                                record["identity"]["recovery"].get("taskGoalCycle"),
                            ))
                })
            {
                let chat = input
                    .chat_id
                    .as_ref()
                    .and_then(Value::as_js_string)
                    .cloned();
                effects.push(Box::new(move |manager| manager.wake_recovery(chat)));
            }
            self.diagnose(state, id, "queued", None, effects);
            if let Some(key) = key {
                let journal = self.0.journal.clone().unwrap();
                let identity = input.identity(&generation);
                let pending = self.ticket_task(state, effects, id, move |manager| {
                    Box::pin(async move {
                        let result = journal.enqueue(key, identity).await;
                        match result {
                            Ok(record) => {
                                manager.edit(|state, effects| {
                                    let ticket = state.tickets.get_mut(&id).unwrap();
                                    // Recovery can adopt the durable record and grant capacity before
                                    // this task handles the enqueue reply.
                                    if !matches!(ticket.phase, Phase::Waiting | Phase::Granted)
                                        && !ticket.parked_waiting
                                    {
                                        return Ok(());
                                    }
                                    if let Some(admitted) = ticket.input.admitted.take() {
                                        effects.push(Box::new(move |manager| {
                                            if let Err(error) = admitted() {
                                                manager.observer_error(error);
                                            }
                                        }));
                                    }
                                    ticket.resolve_queued.finish(Ok(()));
                                    if ticket.phase == Phase::Waiting && ticket.queue_revision == 0
                                    {
                                        ticket.durable_queue_ready = !ticket.recovery_pending;
                                    }
                                    let provider = ticket.input.provider_id.clone();
                                    manager.drain(state, &provider, effects);
                                    manager.changed(state, effects);
                                    Ok(())
                                })?;
                                Ok(record)
                            }
                            Err(error) => {
                                let failure = Failure::new(error);
                                manager.cancel(id, failure.error());
                                manager.journal_error(failure.error());
                                Err(failure.error())
                            }
                        }
                    })
                });
                state.tickets.get_mut(&id).unwrap().journal_enqueued = Some(pending);
            } else {
                state.tickets[&id].resolve_queued.finish(Ok(()));
            }
            if let Some(signal) = &input.signal {
                if let Err(error) = signal.check() {
                    self.cancel_locked(state, id, error, effects);
                } else {
                    let signal = signal.clone();
                    let weak = Arc::downgrade(&self.0);
                    let task = tokio::spawn(async move {
                        let reason = signal.cancelled().await;
                        if let Some(owner) = weak.upgrade() {
                            Manager(owner).cancel(id, reason.into());
                        }
                    });
                    state.tickets.get_mut(&id).unwrap().cancellation_listener =
                        Some(task.abort_handle());
                }
            }
            self.adopt_restorations(state, effects);
            self.drain(state, &input.provider_id, effects);
            self.observe(state, id, effects);
            self.changed(state, effects);
            Ok(Ticket {
                manager: self.clone(),
                id,
                _lifetime: lifetime,
            })
        })
    }
    pub(super) fn drain(&self, state: &mut State, provider: &JsString, effects: &mut Effects) {
        if state.closing
            || self.0.journal.is_some()
                && self.0.options.reconcile.is_some()
                && !state.recovery_initialized
            || state.recovery_pending.values().any(|id| id == provider)
            || !self.native_available()
        {
            return;
        }
        loop {
            let Some(pool) = state.pools.get(provider).filter(|pool| !pool.disabled) else {
                return;
            };
            if pool.queue.is_empty()
                || pool.active.len() as f64
                    >= pool.configuration["maxConcurrentInference"]
                        .as_f64()
                        .unwrap()
            {
                return;
            }
            let Some(entry) = self.queue_entries(state, provider).first().cloned() else {
                return;
            };
            let Some(id) = entry.ticket else {
                return;
            };
            if !state.tickets[&id].durable_queue_ready {
                return;
            }
            state
                .pools
                .get_mut(provider)
                .unwrap()
                .queue
                .retain(|item| *item != id);
            let ticket = state.tickets.get_mut(&id).unwrap();
            if ticket.phase != Phase::Waiting {
                continue;
            }
            self.transition(ticket, Phase::Granted);
            ticket.granted_at = Some(self.wall());
            let revision = ticket.queue_revision;
            let key = ticket.journal_key.clone();
            state.pools.get_mut(provider).unwrap().active.insert(id);
            self.diagnose(state, id, "granted", None, effects);
            self.observe(state, id, effects);
            if let Some(key) = key {
                let journal = self.0.journal.clone().unwrap();
                drop(self.ticket_task(state, effects, id, move |manager| {
                    Box::pin(async move {
                        match journal.grant(key).await {
                            Ok(_) => manager.edit(|state, _| {
                                let ticket = state.tickets.get_mut(&id).unwrap();
                                if ticket.phase == Phase::Granted
                                    && ticket.queue_revision == revision
                                    && ticket.signal.check().is_ok()
                                    && state.runtimes.get(&ticket.runtime).is_some_and(|runtime| {
                                        !runtime.retired && runtime.retiring.is_none()
                                    })
                                {
                                    ticket.permission_granted = true;
                                    ticket.resolve.finish(Ok(()));
                                }
                                Ok(())
                            }),
                            Err(error) => {
                                let failure = Failure::new(error);
                                manager.cancel(id, failure.error());
                                manager.journal_error(failure.error());
                                Err(failure.error())
                            }
                        }
                    })
                }));
            } else {
                let ticket = state.tickets.get_mut(&id).unwrap();
                ticket.permission_granted = true;
                ticket.resolve.finish(Ok(()));
            }
        }
    }
}
