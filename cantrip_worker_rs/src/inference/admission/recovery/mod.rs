use super::*;
mod adopt;
mod eligibility;
mod preparations;
mod pump;
pub use preparations::GoalPreparationHandle;
impl Manager {
    pub(super) fn prepare_recovery(&self) -> Promise<()> {
        self.edit(|state, effects| {
            if state.closing {
                return Ok(Promise::ready(Err(anyhow!(
                    "Inference ownership is retiring."
                ))));
            }
            if let Some((_, pending)) = &state.recovery_startup {
                return Ok(pending.clone());
            }
            let id = state.id();
            let (complete, pending) = Promise::pair();
            state.recovery_startup = Some((id, pending.clone()));
            effects.push(Box::new(move |manager| {
                let manager = manager.clone();
                tokio::spawn(async move {
                    let result = async {
                        if let Some(journal) = &manager.0.journal {
                            journal.initialize().await?;
                        }
                        manager.edit(|state, effects| {
                            if state.closing {
                                bail!("Inference ownership retired during recovery.");
                            }
                            if state.recovery_initialized {
                                return Ok(());
                            }
                            if manager.0.options.reconcile.is_some() {
                                for record in manager.recovery_snapshot() {
                                    if manager.recoverable(&record) {
                                        state.recovery_pending.insert(
                                            record["key"].as_str().unwrap().into(),
                                            record["identity"]["providerId"]
                                                .as_js_string()
                                                .unwrap()
                                                .clone(),
                                        );
                                    }
                                }
                            }
                            state.recovery_initialized = true;
                            effects.push(Box::new(|manager| manager.wake_recovery(None)));
                            Ok(())
                        })
                    }
                    .await;
                    if let Err(error) = &result {
                        let _ = manager.edit(|state, effects| {
                            if state
                                .recovery_startup
                                .as_ref()
                                .is_some_and(|(current, _)| *current == id)
                            {
                                state.recovery_startup = None;
                            }
                            if !state.closing {
                                manager.schedule_recovery_retry(state, effects);
                            }
                            Ok(())
                        });
                        if !manager.0.state.lock().unwrap().closing {
                            manager.journal_error(anyhow!("{error}"));
                        }
                    }
                    complete.finish(result);
                });
            }));
            Ok(pending)
        })
        .unwrap()
    }
    pub fn wake_recovery(&self, chat: Option<JsString>) {
        let _ = self.edit(|state, effects| {
            if self.0.journal.is_none() || self.0.options.reconcile.is_none() || state.closing {
                return Ok(());
            }
            if !state.recovery_initialized {
                effects.push(Box::new(|manager| {
                    drop(manager.prepare_recovery());
                }));
                return Ok(());
            }
            for record in self.recovery_snapshot() {
                let identity = &record["identity"];
                if self.recoverable(&record)
                    && (coercion::truthy(identity["recovery"].get("autonomousGoal"))
                        || coercion::truthy(identity["recovery"].get("taskGoalCycle")))
                    && chat
                        .as_ref()
                        .is_none_or(|chat| identity["chatId"] == Value::String(chat.clone()))
                {
                    state.recovery_pending.insert(
                        record["key"].as_str().unwrap().into(),
                        identity["providerId"].as_js_string().unwrap().clone(),
                    );
                }
            }
            if let Some(chat) = chat {
                state.recovery_chats.insert(chat);
            } else {
                state.recovery_all = true;
            }
            if state.recovery_work.is_some() {
                return Ok(());
            }
            let (complete, pending) = Promise::pair();
            state.recovery_work = Some(pending);
            effects.push(Box::new(move |manager| {
                let manager = manager.clone();
                tokio::spawn(async move {
                    let result = manager.refresh_recovery().await;
                    let _ = manager.edit(|state, effects| {
                        state.recovery_work = None;
                        if state.recovery_all || !state.recovery_chats.is_empty() {
                            effects.push(Box::new(|manager| manager.wake_recovery(None)));
                        }
                        Ok(())
                    });
                    if let Err(error) = &result {
                        manager.journal_error(anyhow!("{error}"));
                    }
                    complete.finish(result);
                });
            }));
            Ok(())
        });
    }
    pub(super) fn schedule_recovery_retry(&self, state: &mut State, effects: &mut Effects) {
        if state.closing || state.recovery_retry.is_some() {
            return;
        }
        let delay = state.recovery_retry_ms;
        state.recovery_retry_ms = (delay * 2).min(30_000);
        let weak = Arc::downgrade(&self.0);
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if let Some(owner) = weak.upgrade() {
                let manager = Manager(owner);
                manager.0.state.lock().unwrap().recovery_retry = None;
                manager.wake_recovery(None);
            }
        });
        state.recovery_retry = Some(task.abort_handle());
        let _ = effects;
    }
    pub(super) fn remove_restoration(&self, state: &mut State, key: &str) {
        let Some(id) = state.restored.shift_remove(key) else {
            return;
        };
        let waiter = state.waiters.get_mut(&id).unwrap();
        waiter.task_input.remove(&JsString::from(key));
        waiter.goal_input.remove(&JsString::from(key));
        waiter.task_goal.remove(&JsString::from(key));
        waiter
            .records
            .retain(|record| record["key"].as_str() != Some(key));
        if let Some(record) = waiter.records.iter().reduce(|a, b| {
            if a["order"].as_f64().unwrap() < b["order"].as_f64().unwrap() {
                a
            } else {
                b
            }
        }) {
            waiter.record = record.clone();
        }
        if waiter.records.is_empty() && waiter.claimed.is_none() {
            state.waiters.shift_remove(&id);
        }
        self.prune_goal_preparations(state);
    }
}
