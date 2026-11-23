use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Clone)]
pub struct GoalPreparationHandle {
    manager: Weak<Inner>,
    key: String,
    id: Id,
    ended: Arc<AtomicBool>,
}
impl GoalPreparationHandle {
    pub fn succeeded(&self) {
        self.update(true);
    }
    pub fn failed(&self) {
        self.update(false);
    }
    pub fn unconfirmed(&self) {
        self.update(true);
    }
    fn update(&self, succeeded: bool) {
        if self.ended.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(owner) = self.manager.upgrade() else {
            return;
        };
        let manager = Manager(owner);
        let _ = manager.edit(|state, effects| {
            let Some(preparation) = state
                .goal_preparations
                .get_mut(&self.key)
                .filter(|preparation| preparation.id == self.id)
            else {
                return Ok(());
            };
            preparation.preparing = false;
            let changed = if succeeded {
                preparation.unavailable
            } else {
                !preparation.unavailable
            };
            if succeeded {
                state.goal_preparations.shift_remove(&self.key);
            } else {
                if !preparation.unavailable {
                    let records = state
                        .waiters
                        .values()
                        .filter(|waiter| {
                            manager
                                .goal_preparation_for(state, waiter)
                                .is_some_and(|p| p.id == self.id)
                        })
                        .map(|waiter| waiter.record.clone())
                        .collect::<Vec<_>>();
                    for record in records {
                        manager.diagnose_recovery(&record, "recovery-unavailable", effects);
                    }
                }
                state
                    .goal_preparations
                    .get_mut(&self.key)
                    .unwrap()
                    .unavailable = true;
                manager.prune_goal_preparations(state);
            }
            if changed {
                for provider in state.pools.keys().cloned().collect::<Vec<_>>() {
                    manager.drain(state, &provider, effects);
                }
                manager.changed(state, effects);
            }
            Ok(())
        });
    }
}
impl Manager {
    pub fn begin_goal_recovery_preparation(
        &self,
        chat: JsString,
        provider: JsString,
        recovery: Value,
    ) -> GoalPreparationHandle {
        self.edit(|state, _| {
            let key = key(&chat, &provider, &recovery);
            let id = state.id();
            let unavailable = state
                .goal_preparations
                .get(&key)
                .is_some_and(|previous| previous.unavailable);
            state.goal_preparations.insert(
                key.clone(),
                GoalPreparation {
                    id,
                    chat,
                    provider,
                    recovery,
                    preparing: true,
                    unavailable,
                },
            );
            Ok(GoalPreparationHandle {
                manager: Arc::downgrade(&self.0),
                key,
                id,
                ended: Arc::new(AtomicBool::new(false)),
            })
        })
        .unwrap()
    }
    pub(in crate::inference::admission) fn goal_preparation_for<'a>(
        &self,
        state: &'a State,
        waiter: &Restored,
    ) -> Option<&'a GoalPreparation> {
        let recovery = waiter
            .task_goal_recovery
            .as_ref()
            .or(waiter.goal_recovery.as_ref())?;
        let chat = waiter.record["identity"]["chatId"].as_js_string()?;
        let provider = waiter.record["identity"]["providerId"].as_js_string()?;
        if chat.is_empty() {
            return None;
        }
        state.goal_preparations.get(&key(chat, provider, recovery))
    }
    pub(in crate::inference::admission) fn prune_goal_preparations(&self, state: &mut State) {
        if state.goal_preparations.is_empty() {
            return;
        }
        let retained = state
            .waiters
            .values()
            .filter_map(|waiter| {
                let recovery = waiter
                    .task_goal_recovery
                    .as_ref()
                    .or(waiter.goal_recovery.as_ref())?;
                Some(key(
                    waiter.record["identity"]["chatId"].as_js_string()?,
                    waiter.record["identity"]["providerId"].as_js_string()?,
                    recovery,
                ))
            })
            .collect::<HashSet<_>>();
        let mut pending = HashSet::new();
        for record in self.recovery_snapshot() {
            let recovery = &record["identity"]["recovery"];
            let identity = &record["identity"];
            if state
                .recovery_pending
                .contains_key(record["key"].as_str().unwrap())
                && coercion::truthy(identity.get("chatId"))
                && coercion::truthy(recovery.get("threadId"))
                && (coercion::truthy(recovery.get("autonomousGoal"))
                    || coercion::truthy(recovery.get("taskGoalCycle")))
            {
                let goal = if coercion::truthy(recovery.get("taskGoalCycle")) {
                    &recovery["taskGoalCycle"]
                } else {
                    &recovery["autonomousGoal"]
                };
                pending.insert(episode(
                    &identity["chatId"],
                    &identity["providerId"],
                    &recovery["threadId"],
                    &goal["goalEpoch"],
                    goal.get("orderEpoch"),
                    recovery["taskGoalCycle"].get("cycleId"),
                ));
            }
        }
        state.goal_preparations.retain(|key, preparation| {
            if preparation.preparing || retained.contains(key) {
                return true;
            }
            let task = preparation.recovery.get("cycle").is_some();
            let recovery = &preparation.recovery;
            let source = if task {
                &recovery["cycle"]
            } else {
                &recovery["source"]
            };
            pending.contains(&episode(
                &Value::String(preparation.chat.clone()),
                &Value::String(preparation.provider.clone()),
                if task {
                    &recovery["threadId"]
                } else {
                    &source["threadId"]
                },
                &source["goalEpoch"],
                if task {
                    source.get("orderEpoch")
                } else {
                    recovery.get("orderEpoch")
                },
                if task { source.get("cycleId") } else { None },
            ))
        });
    }
}
fn key(chat: &JsString, provider: &JsString, recovery: &Value) -> String {
    if recovery.get("cycle").is_some() {
        return json!([
            json!("task-goal"),
            Value::String(chat.clone()),
            Value::String(provider.clone()),
            recovery["sourceKey"].clone(),
            recovery["cycle"]["cycleId"].clone(),
            recovery["threadId"].clone(),
            recovery["cycle"]["goalEpoch"].clone(),
            recovery["cycle"]["orderEpoch"].clone()
        ])
        .stringify();
    }
    let source = &recovery["source"];
    json!([
        Value::String(chat.clone()),
        Value::String(provider.clone()),
        source["operationId"].clone(),
        source["operationGeneration"].clone(),
        source["threadId"].clone(),
        source["goalEpoch"].clone(),
        recovery
            .get("orderEpoch")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(0))
    ])
    .stringify()
}
fn episode(
    chat: &Value,
    provider: &Value,
    thread: &Value,
    goal: &Value,
    order: Option<&Value>,
    task: Option<&Value>,
) -> String {
    let mut values = vec![
        chat.clone(),
        provider.clone(),
        thread.clone(),
        goal.clone(),
        order.filter(|v| !v.is_null()).cloned().unwrap_or(json!(0)),
    ];
    if let Some(task) = task.filter(|v| coercion::truthy(Some(v))) {
        values.extend([json!("task-goal"), task.clone()]);
    }
    Value::Array(values).stringify()
}
