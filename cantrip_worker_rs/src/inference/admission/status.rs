use super::*;
pub struct Subscription {
    manager: Weak<Inner>,
    id: Id,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(owner) = self.manager.upgrade() {
            owner.state.lock().unwrap().listeners.shift_remove(&self.id);
        }
    }
}
impl Manager {
    pub fn subscribe(&self, listener: Observer) -> Subscription {
        let id = self
            .edit(|state, _| {
                if let Some((id, _)) = state
                    .listeners
                    .iter()
                    .find(|(_, existing)| Arc::ptr_eq(existing, &listener))
                {
                    return Ok(*id);
                }
                let id = state.id();
                state.listeners.insert(id, listener);
                Ok(id)
            })
            .unwrap();
        Subscription {
            manager: Arc::downgrade(&self.0),
            id,
        }
    }
    pub fn snapshot(&self) -> Value {
        self.snapshot_locked(&self.0.state.lock().unwrap())
    }
    pub(super) fn snapshot_locked(&self, state: &State) -> Value {
        let mut pools = Vec::new();
        for (provider, pool) in &state.pools {
            let queued = self.queue_entries(state, provider);
            let mut operations = pool
                .active
                .iter()
                .map(|id| self.status_locked(state, *id, None))
                .collect::<Vec<_>>();
            for (index, entry) in queued.iter().enumerate() {
                operations.push(if let Some(id) = entry.ticket {
                    self.status_locked(state, id, Some(index + 1))
                } else {
                    self.restored_status(&state.waiters[&entry.waiter.unwrap()], Some(index + 1))
                });
            }
            for id in state.restored.values().copied().collect::<IndexSet<_>>() {
                let waiter = &state.waiters[&id];
                if !pool.disabled
                    && waiter.record["identity"]["providerId"] == Value::String(provider.clone())
                    && self
                        .goal_preparation_for(state, waiter)
                        .is_some_and(|p| p.unavailable)
                    && waiter.claimed.is_none_or(|id| {
                        state
                            .tickets
                            .get(&id)
                            .is_none_or(|ticket| ticket.phase == Phase::Released)
                    })
                {
                    operations.push(self.restored_status(waiter, None));
                }
            }
            operations.extend(
                pool.suspended
                    .iter()
                    .map(|id| self.status_locked(state, *id, None)),
            );
            let mut result = pool.configuration.clone();
            result["activeCount"] = json!(pool.active.len());
            result["queuedCount"] = json!(queued.len());
            result["operations"] = Value::Array(operations);
            pools.push(result);
        }
        let scope = &self.0.options.scope;
        let mut result = json!({"serverId":scope.server_id,"ownerId":scope.owner_id,"workerId":scope.worker_id,"workerGeneration":scope.worker_generation,"revision":state.revision,"pools":pools});
        if let Some(revision) = state.catalog_revision {
            result["providerCatalogRevision"] = json!(revision);
        }
        result
    }
    pub(super) fn status(&self, id: Id) -> Value {
        self.status_locked(&self.0.state.lock().unwrap(), id, None)
    }
    pub(super) fn status_locked(&self, state: &State, id: Id, position: Option<usize>) -> Value {
        let ticket = &state.tickets[&id];
        let position = if ticket.phase == Phase::Waiting {
            Some(position.unwrap_or_else(|| {
                self.queue_entries(state, &ticket.input.provider_id)
                    .iter()
                    .position(|entry| entry.ticket == Some(id))
                    .map_or(0, |index| index + 1)
            }))
        } else {
            None
        };
        json!({"purpose":ticket.input.purpose.clone().unwrap_or_else(|| "helper".into()),"operationId":ticket.input.operation_id,"runtimeGeneration":ticket.generation,"providerId":ticket.input.provider_id,"chatId":types::nullish(&ticket.input.chat_id),"projectId":types::nullish(&ticket.input.project_id),"state":ticket.phase.name(),"queuePosition":position,"enqueuedAt":ticket.enqueued_at,"grantedAt":ticket.granted_at,"startedAt":ticket.started_at,"timing":self.timing(ticket)})
    }
    fn restored_status(&self, waiter: &Restored, position: Option<usize>) -> Value {
        let identity = &waiter.record["identity"];
        json!({"purpose":"turn","operationId":identity["operationId"],"runtimeGeneration":identity["runtimeGeneration"],"providerId":identity["providerId"],"chatId":identity["chatId"],"projectId":identity["projectId"],"state":if position.is_some(){"waiting"}else{"recovering"},"queuePosition":position,"enqueuedAt":waiter.enqueued_at,"grantedAt":Value::Null,"startedAt":Value::Null})
    }
    pub(super) fn transition(&self, ticket: &mut TicketData, phase: Phase) {
        let now = self.now();
        if let Some(field) = ticket.phase.timing() {
            ticket.timing[field] += (now - ticket.state_since).max(0.);
        }
        ticket.state_since = now;
        ticket.phase = phase;
    }
    fn timing(&self, ticket: &TicketData) -> Value {
        let mut values = ticket.timing;
        if let Some(field) = ticket.phase.timing() {
            values[field] += (self.now() - ticket.state_since).max(0.);
        }
        Value::object(
            ["queueWaitMs", "reservedMs", "executionMs", "suspendedMs"]
                .into_iter()
                .zip(values)
                .map(|(key, value)| (key, json!(value.floor().min(9_007_199_254_740_991.)))),
        )
    }
    pub(super) fn diagnose(
        &self,
        state: &State,
        id: Id,
        action: &'static str,
        outcome: Option<Outcome>,
        effects: &mut Effects,
    ) {
        let ticket = &state.tickets[&id];
        let scope = &self.0.options.scope;
        let mut event = json!({"action":action,"workerId":scope.worker_id,"workerGeneration":scope.worker_generation,"runtimeGeneration":ticket.generation,"operationId":ticket.input.operation_id,"providerId":ticket.input.provider_id,"state":ticket.phase.name(),"timing":self.timing(ticket)});
        if let Some(outcome) = outcome {
            event["outcome"] = json!(outcome.name());
        }
        self.diagnostic(event, effects);
    }
    pub(super) fn diagnose_recovery(
        &self,
        record: &Value,
        action: &'static str,
        effects: &mut Effects,
    ) {
        let scope = &self.0.options.scope;
        self.diagnostic(json!({"action":action,"workerId":scope.worker_id,"workerGeneration":scope.worker_generation,"previousWorkerGeneration":record["workerGeneration"],"runtimeGeneration":record["identity"]["runtimeGeneration"],"operationId":record["identity"]["operationId"],"providerId":record["identity"]["providerId"],"state":record["state"]}), effects);
    }
    fn diagnostic(&self, event: Value, effects: &mut Effects) {
        effects.push(Box::new(move |manager| {
            let _ = (manager.0.options.diagnostic)(event);
        }));
    }
    pub(super) fn observe(&self, state: &State, id: Id, effects: &mut Effects) {
        let ticket = &state.tickets[&id];
        if let Some(observe) = ticket.input.observe.clone() {
            let phase = ticket.phase;
            effects.push(Box::new(move |manager| {
                if let Err(error) = observe(phase) {
                    manager.observer_error(error);
                }
            }));
        }
    }
    pub(super) fn changed(&self, state: &mut State, effects: &mut Effects) {
        state.revision += 1.;
        if state.notifying || state.listeners.is_empty() {
            return;
        }
        state.notifying = true;
        effects.push(Box::new(|manager| {
            let weak = Arc::downgrade(&manager.0);
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                let Some(owner) = weak.upgrade() else {
                    return;
                };
                let manager = Manager(owner);
                let snapshot = {
                    let mut state = manager.0.state.lock().unwrap();
                    state.notifying = false;
                    manager.snapshot_locked(&state)
                };
                let mut cursor = 0;
                loop {
                    let next = manager
                        .0
                        .state
                        .lock()
                        .unwrap()
                        .listeners
                        .iter()
                        .find(|(id, _)| **id > cursor)
                        .map(|(id, listener)| (*id, listener.clone()));
                    let Some((id, listener)) = next else {
                        break;
                    };
                    cursor = id;
                    if let Err(error) = listener(snapshot.clone()) {
                        manager.observer_error(error);
                    }
                }
            });
        }));
    }
    pub(super) fn queue_entries(&self, state: &State, provider: &JsString) -> Vec<QueueEntry> {
        let Some(pool) = state.pools.get(provider).filter(|pool| !pool.disabled) else {
            return Vec::new();
        };
        let mut entries = pool
            .queue
            .iter()
            .map(|id| {
                let ticket = &state.tickets[id];
                QueueEntry {
                    ticket: Some(*id),
                    waiter: None,
                    order: ticket.restored_order.unwrap_or(f64::INFINITY),
                    sequence: ticket.sequence,
                }
            })
            .collect::<Vec<_>>();
        for id in state.restored.values().copied().collect::<IndexSet<_>>() {
            let waiter = &state.waiters[&id];
            if waiter.record["identity"]["providerId"] != Value::String(provider.clone())
                || self
                    .goal_preparation_for(state, waiter)
                    .is_some_and(|p| p.unavailable)
                || waiter.claimed.is_some_and(|id| {
                    state
                        .tickets
                        .get(&id)
                        .is_some_and(|ticket| ticket.phase != Phase::Released)
                })
            {
                continue;
            }
            entries.push(QueueEntry {
                ticket: None,
                waiter: Some(id),
                order: waiter.record["order"].as_f64().unwrap(),
                sequence: 0.,
            });
        }
        entries.sort_by(|a, b| {
            a.order
                .total_cmp(&b.order)
                .then_with(|| a.sequence.total_cmp(&b.sequence))
        });
        entries
    }
}
