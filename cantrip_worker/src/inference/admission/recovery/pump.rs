use super::*;
use futures::StreamExt;
use std::sync::atomic::{AtomicBool, Ordering};
impl Manager {
    pub(super) async fn refresh_recovery(&self) -> Result<()> {
        let failed = AtomicBool::new(false);
        loop {
            let records = self.edit(|state, _| {
                let all = state.recovery_all;
                let chats = std::mem::take(&mut state.recovery_chats);
                state.recovery_all = false;
                Ok(self
                    .recovery_snapshot()
                    .into_iter()
                    .filter(|record| {
                        self.recoverable(record)
                            && (all
                                || record["identity"]["chatId"]
                                    .as_js_string()
                                    .is_some_and(|chat| chats.contains(chat)))
                    })
                    .collect::<Vec<_>>())
            })?;
            futures::stream::iter(records)
                .for_each_concurrent(4, |record| async {
                    if self.0.state.lock().unwrap().closing {
                        return;
                    }
                    if let Err(error) = self.refresh_record(record).await
                        && !self.0.state.lock().unwrap().closing
                    {
                        failed.store(true, Ordering::Release);
                        self.journal_error(error);
                    }
                })
                .await;
            let again = self.edit(|state, effects| {
                for provider in state.pools.keys().cloned().collect::<Vec<_>>() {
                    self.drain(state, &provider, effects);
                }
                self.prune_goal_preparations(state);
                self.changed(state, effects);
                Ok(!state.closing && (state.recovery_all || !state.recovery_chats.is_empty()))
            })?;
            if !again {
                break;
            }
        }
        self.edit(|state, effects| {
            if failed.load(Ordering::Acquire) {
                self.schedule_recovery_retry(state, effects);
            } else {
                state.recovery_retry_ms = 1000;
            }
            Ok(())
        })
    }
    async fn refresh_record(&self, record: Value) -> Result<()> {
        let result = self.0.options.reconcile.as_ref().unwrap()(
            record.clone(),
            self.0.recovery_signal.clone(),
        )
        .await?;
        let key = record["key"].as_str().unwrap().to_owned();
        let current = self.edit(|state, _| {
            Ok(!state.closing
                && self
                    .recovery_snapshot()
                    .iter()
                    .any(|item| item["key"] == record["key"]))
        })?;
        if !current {
            return Ok(());
        }
        if result["key"] != record["key"] {
            bail!("Recovery returned another admission identity.");
        }
        if result["disposition"] == "retired" {
            let forget = self.edit(|state, _| {
                Ok(state
                    .restored
                    .get(&key)
                    .and_then(|id| state.waiters[id].claimed)
                    .and_then(|id| state.tickets.get(&id))
                    .is_none_or(|ticket| ticket.phase != Phase::Waiting))
            })?;
            if forget {
                self.0
                    .journal
                    .as_ref()
                    .unwrap()
                    .forget(record.clone())
                    .await?;
                self.edit(|state, effects| {
                    self.remove_restoration(state, &key);
                    self.diagnose_recovery(&record, "recovery-retired", effects);
                    Ok(())
                })?;
            }
        } else if result["disposition"] == "requeued" {
            self.validate_recovery_result(&record, &result)?;
            self.edit(|state, effects| {
                let provider = record["identity"]["providerId"].as_js_string().unwrap();
                if !state.pools.contains_key(provider)
                    && (state.catalog_revision.is_none() || state.catalog.contains_key(provider))
                {
                    self.configure_locked(state, &json!({"providerId":provider}), effects)?;
                }
                let id = if let Some(id) = state.restored.get(&key) {
                    *id
                } else {
                    let logical = identity::queue(
                        &record["identity"]["chatId"],
                        &record["identity"]["recovery"],
                    );
                    let previous = state
                        .restored
                        .values()
                        .copied()
                        .collect::<IndexSet<_>>()
                        .into_iter()
                        .find(|id| {
                            logical.is_some()
                                && identity::queue(
                                    &state.waiters[id].record["identity"]["chatId"],
                                    &state.waiters[id].record["identity"]["recovery"],
                                ) == logical
                        });
                    let id = previous.unwrap_or_else(|| {
                        let id = state.id();
                        state.waiters.insert(
                            id,
                            Restored {
                                record: record.clone(),
                                records: Vec::new(),
                                task_input: HashSet::new(),
                                goal_input: HashSet::new(),
                                task_goal: HashSet::new(),
                                enqueued_at: self.wall(),
                                claimed: None,
                                goal_recovery: None,
                                task_goal_recovery: None,
                            },
                        );
                        id
                    });
                    let waiter = state.waiters.get_mut(&id).unwrap();
                    waiter.records.push(record.clone());
                    for (flag, identity, set) in [
                        (
                            "taskInputNotDispatched",
                            "taskInput",
                            &mut waiter.task_input,
                        ),
                        (
                            "goalInputNotDispatched",
                            "autonomousGoal",
                            &mut waiter.goal_input,
                        ),
                        (
                            "taskGoalCycleNotDispatched",
                            "taskGoalCycle",
                            &mut waiter.task_goal,
                        ),
                    ] {
                        if result[flag] == true
                            && coercion::truthy(record["identity"]["recovery"].get(identity))
                        {
                            set.insert(key.clone().into());
                        }
                    }
                    if record["order"].as_f64().unwrap() < waiter.record["order"].as_f64().unwrap()
                    {
                        waiter.record = record.clone();
                    }
                    state.restored.insert(key.clone(), id);
                    self.diagnose_recovery(&record, "recovery-requeued", effects);
                    id
                };
                let waiter = state.waiters.get_mut(&id).unwrap();
                if coercion::truthy(result.get("goalRecovery")) {
                    waiter.goal_recovery = Some(result["goalRecovery"].clone());
                }
                if coercion::truthy(result.get("taskGoalRecovery")) {
                    waiter.task_goal_recovery = Some(result["taskGoalRecovery"].clone());
                }
                Ok(())
            })?;
        } else {
            self.edit(|state, effects| {
                self.remove_restoration(state, &key);
                if state.recovery_pending.contains_key(&key) {
                    self.diagnose_recovery(&record, "recovery-unresolved", effects);
                }
                Ok(())
            })?;
        }
        self.edit(|state, effects| {
            if result["disposition"] == "retired"
                || !(state.recovery_all
                    || record["identity"]["chatId"]
                        .as_js_string()
                        .is_some_and(|chat| state.recovery_chats.contains(chat)))
            {
                state.recovery_pending.shift_remove(&key);
            }
            self.adopt_restorations(state, effects);
            Ok(())
        })
    }
    fn validate_recovery_result(&self, record: &Value, result: &Value) -> Result<()> {
        let recovery = &record["identity"]["recovery"];
        let cycle = &recovery["taskGoalCycle"];
        let returned = &result["taskGoalRecovery"];
        if coercion::truthy(Some(cycle))
            && (result["taskGoalCycleNotDispatched"] != true
                || !coercion::truthy(Some(returned))
                || coercion::truthy(returned.get("settled"))
                || returned["workerId"] != Value::String(self.0.options.scope.worker_id.clone())
                || returned["providerId"] != record["identity"]["providerId"]
                || returned["threadId"] != recovery["threadId"]
                || ["cycleId", "goalEpoch", "orderEpoch"]
                    .iter()
                    .any(|field| returned["cycle"][*field] != cycle[*field])
                || coercion::truthy(returned.get("binding"))
                    && returned["binding"]["orderEpoch"] != cycle["orderEpoch"])
        {
            bail!("Recovery returned another unused Task Goal cycle.");
        }
        let goal = &recovery["autonomousGoal"];
        let returned = &result["goalRecovery"];
        let order = |value: &Value| {
            value
                .get("orderEpoch")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(0))
        };
        let provider = returned
            .get("providerId")
            .filter(|v| !v.is_null())
            .unwrap_or(&record["identity"]["providerId"]);
        if coercion::truthy(Some(returned))
            && (!coercion::truthy(Some(goal))
                || result["goalInputNotDispatched"] != true
                || returned["source"]["threadId"] != recovery["threadId"]
                || returned["source"]["goalEpoch"] != goal["goalEpoch"]
                || order(returned) != order(goal)
                || provider != &record["identity"]["providerId"])
        {
            bail!("Recovery returned another unused Goal cycle.");
        }
        Ok(())
    }
}
