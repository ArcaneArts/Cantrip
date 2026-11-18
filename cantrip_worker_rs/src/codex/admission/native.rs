use super::execution::changed;
use super::*;
use cantrip_wire::value::Object;

use cantrip_transport::lifecycle::owned;

impl Adapter {
    pub fn enter_native(&self, input: NativeRequest) -> Work<()> {
        let this = self.clone();
        owned(async move {
            let identity = key(&input.thread_id, &input.turn_id, Some(&input.scope_id));
            let (entry, complete) = {
                let mut state = this.0.state.lock().unwrap();
                if state.exited {
                    bail!("The native inference process has exited.");
                }
                if state.completed.contains(&identity) {
                    bail!("Native inference already settled.");
                }
                if let Some(entry) = state.native.get(&identity) {
                    if entry.gate != input.gate_attempt_id {
                        bail!("Native inference scope belongs to another gate request.");
                    }
                    if entry.runner_generation != input.runner_generation {
                        bail!("Native inference changed runner during redelivery.");
                    }
                    if entry.independent != input.independent {
                        bail!("Native inference changed admission kind during redelivery.");
                    }
                    if entry.expected_goal != input.goal_epoch {
                        bail!("Native inference changed Goal identity during redelivery.");
                    }
                    (entry.clone(), None)
                } else {
                    let (complete, result) = Promise::pair();
                    let entry = Arc::new(NativeEntry {
                        independent: input.independent,
                        gate: input.gate_attempt_id.clone(),
                        runner_generation: input.runner_generation.clone(),
                        expected_goal: input.goal_epoch.clone(),
                        result,
                        state: Mutex::new(NativeState {
                            confirmed: false,
                            goal: None,
                            lifetime: None,
                            operation: None,
                        }),
                    });
                    state.native.insert(identity, entry.clone());
                    (entry, Some(complete))
                }
            };
            if let Some(complete) = complete {
                complete.finish(this.admit_native(&input, &entry).await);
            }
            entry.result.work().await?;
            let operation = this
                .find_native(&input.thread_id, &input.turn_id, &input.scope_id)
                .ok_or_else(|| anyhow!("Native inference has no running grant."))?;
            let running = operation.ticket()?.status()["state"] == "running";
            let mut state = operation.state.lock().unwrap();
            if !state.lease || !running || state.settled {
                bail!("Native inference has no running grant.");
            }
            state.native_boundary = true;
            state.observed_start = true;
            Ok(())
        })
    }

    async fn confirm_native(&self, input: &NativeRequest, entry: &Arc<NativeEntry>) -> Result<()> {
        let identity = key(&input.thread_id, &input.turn_id, Some(&input.scope_id));
        let result = async {
            let claim = (input.confirm_ownership)().await?;
            let claimed = claim
                .as_bool()
                .or_else(|| claim["claimed"].as_bool())
                .ok_or_else(|| anyhow!("Native inference claim has no ownership receipt."))?;
            let goal = claim["goalEpoch"].as_js_string();
            if claimed && goal != input.goal_epoch.as_ref() {
                bail!("The pending native scope has another Goal identity.");
            }
            Ok((
                claimed,
                goal.filter(|epoch| !epoch.is_empty())
                    .map(|epoch| (epoch.clone(), claim["inferenceOnly"] == true)),
            ))
        }
        .await;
        let mut state = self.0.state.lock().unwrap();
        let mut captured = entry.state.lock().unwrap();
        let current = owns_entry(&state, input, entry);
        match result {
            Err(error) => {
                if current && captured.operation.is_none() && captured.lifetime.is_none() {
                    state.native.shift_remove(&identity);
                }
                Err(error)
            }
            Ok((false, _)) => {
                if current && captured.lifetime.is_none() {
                    state.native.shift_remove(&identity);
                }
                bail!("The actual native inference request is no longer pending.");
            }
            Ok((true, goal)) => {
                if !current {
                    bail!("The actual native inference request is no longer pending.");
                }
                captured.confirmed = true;
                captured.goal = goal;
                input.signal.check()?;
                if state.exited {
                    bail!("The native inference process has exited.");
                }
                Ok(())
            }
        }
    }

    async fn admit_native(&self, input: &NativeRequest, entry: &Arc<NativeEntry>) -> Result<()> {
        let binding = json!({"threadId": input.thread_id, "turnId": input.turn_id, "scopeId": input.scope_id});
        if let Some(existing) = self.find_native(&input.thread_id, &input.turn_id, &input.scope_id)
        {
            if input.independent {
                bail!("Independent inference cannot reuse an existing native turn.");
            }
            entry.state.lock().unwrap().operation = Some(existing.clone());
            self.confirm_native(input, entry).await?;
            let exited = self.0.state.lock().unwrap().exited;
            if exited || existing.state.lock().unwrap().settled {
                bail!("Native inference settled during ownership confirmation.");
            }
            existing.lease()?.bind_native(binding)?.await?;
            return input.signal.check();
        }
        let roots = if input.independent {
            Vec::new()
        } else {
            self.active()
                .into_iter()
                .filter(|operation| is_unbound_root(operation, &input.thread_id, &input.turn_id))
                .collect()
        };
        if let [operation] = roots.as_slice() {
            entry.state.lock().unwrap().operation = Some(operation.clone());
            return self.bind_root(input, entry, operation, binding).await;
        }
        if roots.len() > 1 {
            bail!("Native inference has ambiguous dispatched owners.");
        }

        self.confirm_native(input, entry).await?;
        self.admit_new(input, entry, binding).await
    }

    async fn bind_root(
        &self,
        input: &NativeRequest,
        entry: &Arc<NativeEntry>,
        operation: &Arc<Operation>,
        binding: Value,
    ) -> Result<()> {
        self.confirm_native(input, entry).await?;
        let paused = root_binding_state(operation, &input.scope_id)?;
        if paused {
            operation.lease()?.resume().await?;
            input.signal.check()?;
        }
        {
            // Fence the mutation against an exact finish/cancel that may
            // arrive while ownership confirmation or resume is in flight.
            let adapter = self.0.state.lock().unwrap();
            if adapter.exited || !owns_entry(&adapter, input, entry) {
                bail!("The actual native inference request is no longer pending.");
            }
            let mut state = operation.state.lock().unwrap();
            if state.settled
                || changed(&state.turn, &input.turn_id)
                || state
                    .native_scope
                    .as_ref()
                    .is_some_and(|scope| scope != &input.scope_id)
            {
                bail!("Native inference owner changed during confirmation.");
            }
            state.initial_native_paused = false;
            state.observed_start = true;
            state.native_boundary = true;
            state.native_scope = Some(input.scope_id.clone());
            state.turn = Some(input.turn_id.clone());
        }
        let result = async {
            self.notify_revocation(operation)?;
            operation.lease()?.bind_native(binding)?.await?;
            input.signal.check()
        }
        .await;
        if result.is_err() {
            let reset = {
                let mut state = operation.state.lock().unwrap();
                if !state.settled && state.native_scope.as_ref() == Some(&input.scope_id) {
                    state.native_boundary = false;
                    state.native_scope = None;
                    true
                } else {
                    false
                }
            };
            if reset {
                self.reconcile(operation)?;
            }
        }
        result
    }

    async fn admit_new(
        &self,
        input: &NativeRequest,
        entry: &Arc<NativeEntry>,
        binding: Value,
    ) -> Result<()> {
        let native_identity = joined(&[&input.thread_id, &input.turn_id, &input.scope_id]);
        let operation_id = joined(&[
            &JsString::from("native-inference"),
            &native_identity,
            &input.gate_attempt_id,
        ]);
        let lifetime = self
            .0
            .runtime
            .create_operation_lifetime(operation_id.clone())?;
        let goal = {
            let state = self.0.state.lock().unwrap();
            if state.exited || !owns_entry(&state, input, entry) {
                bail!("The actual native inference request is no longer pending.");
            }
            let mut captured = entry.state.lock().unwrap();
            captured.lifetime = Some(lifetime.clone());
            captured.goal.clone()
        };
        let task_cycle = match (goal, &input.task_goal_cycle, &input.runner_generation) {
            (Some((epoch, true)), Some(cycle), Some(runner))
                if !input.independent
                    && input.root_thread_id.as_ref() == Some(&input.thread_id)
                    && !runner.is_empty() =>
            {
                let mut cycle = cycle.clone();
                if let Value::Object(fields) = &mut cycle {
                    fields.extend(Object::from_iter([
                        ("goalEpoch".into(), json!(epoch)),
                        ("scopeId".into(), json!(input.scope_id)),
                        ("gateAttemptId".into(), json!(input.gate_attempt_id)),
                        ("runnerGeneration".into(), json!(runner)),
                    ]));
                }
                Some(cycle)
            }
            (Some((_, true)), _, _)
                if !input.independent
                    && input.root_thread_id.as_ref() == Some(&input.thread_id) =>
            {
                bail!("The native Task Goal has no canonical cycle association.");
            }
            _ => None,
        };
        let root = input.root_thread_id.as_ref().and_then(|root| {
            self.active()
                .into_iter()
                .find(|operation| operation.state.lock().unwrap().thread.as_ref() == Some(root))
        });
        let root_status = root
            .map(|root| root.ticket().map(|ticket| ticket.status()))
            .transpose()?;
        let inherited = |field: &str, fallback: &Option<Value>| {
            root_status
                .as_ref()
                .and_then(|v| v.get(field))
                .filter(|v| !v.is_null())
                .cloned()
                .or_else(|| fallback.clone())
        };
        let mut acquisition = Acquire::new(lifetime.clone(), input.provider.clone());
        acquisition.purpose = Some(
            if input.independent {
                "helper"
            } else if changed(&input.root_thread_id, &input.thread_id) {
                "child"
            } else {
                "turn"
            }
            .into(),
        );
        acquisition.chat_id = inherited("chatId", &input.chat_id);
        acquisition.project_id = inherited("projectId", &input.project_id);
        acquisition.thread_id = Some(input.thread_id.clone());
        acquisition.expected_turn_id = Some(input.turn_id.clone());
        acquisition.native_scope_id = Some(input.scope_id.clone());
        acquisition.recovery_key = Some(json!(joined(&[
            &JsString::from("native-turn"),
            &native_identity
        ])));
        let mut recovery = json!({"threadId":input.thread_id,"turnId":input.turn_id});
        if let (Value::Object(fields), Some(cycle)) = (&mut recovery, &task_cycle) {
            fields.insert("taskGoalCycle".into(), cycle.clone());
        }
        acquisition.recovery = Some(recovery);
        if let (Some(cycle), Some(call)) = (task_cycle.clone(), input.on_task_goal_queued.clone()) {
            let operation_id = operation_id.clone();
            let generation = self.generation().clone();
            acquisition.on_queued = Some(Arc::new(move || {
                call(cycle.clone(), operation_id.clone(), generation.clone())
            }));
        }
        acquisition.signal = Some(input.signal.clone());
        acquisition.initially_suspended = input.is_paused.as_ref().is_some_and(|paused| paused());
        let execution = self.acquire(acquisition).await?;
        let result = async {
            let operation = self
                .find_native(&input.thread_id, &input.turn_id, &input.scope_id)
                .ok_or_else(|| anyhow!("Native inference lost its binding owner."))?;
            let lease = operation.lease()?;
            entry.state.lock().unwrap().operation = Some(operation.clone());
            lease.bind_native(binding)?.await?;
            input.signal.check()?;
            if let Some(cycle) = task_cycle {
                let dispatch = input.on_task_goal_dispatch.as_ref().ok_or_else(|| {
                    anyhow!("Task Goal inference has no canonical dispatch check.")
                })?;
                let recovery = lease.task_goal_recovery();
                let source = if recovery.is_null() {
                    operation.ticket()?.private_task_goal_source().await?
                } else {
                    Value::Null
                };
                dispatch(
                    cycle,
                    operation_id,
                    recovery,
                    source,
                    self.generation().clone(),
                )
                .await?;
                input.signal.check()?;
            }
            execution.dispatched()
        }
        .await;
        if let Err(error) = result {
            execution.not_dispatched()?;
            let reason = execution
                .operation
                .state
                .lock()
                .unwrap()
                .withdrawal_reason
                .clone();
            return Err(reason.map_or(error, anyhow::Error::new));
        }
        Ok(())
    }

    pub fn pause_native_wait(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: &JsString,
    ) -> Result<NativePause> {
        let entry = self.native_entry(thread, turn, scope);
        let independent = entry.as_ref().is_some_and(|e| e.independent);
        let operation = self.find_native(thread, turn, scope).or_else(|| {
            let operation = entry?.state.lock().unwrap().operation.clone()?;
            let usable = {
                let state = operation.state.lock().unwrap();
                !state.settled && state.native_scope.is_none()
            };
            usable.then_some(operation)
        });
        let parked = if let Some(operation) = operation {
            let ticket = operation.ticket()?;
            let owns_lease = operation.state.lock().unwrap().lease;
            ticket.pause_waiting(false) || (owns_lease && ticket.status()["state"] == "suspended")
        } else {
            !self.active().iter().any(|operation| {
                let state = operation.state.lock().unwrap();
                state.thread.as_ref() == Some(thread)
                    && !changed(&state.turn, turn)
                    && state.dispatched
                    && !state.settled
            })
        };
        Ok(NativePause {
            parked,
            independent,
        })
    }

    pub fn pause_initial_native_boundary(
        &self,
        thread: &JsString,
        turn: &JsString,
    ) -> Result<bool> {
        let candidates = self
            .active()
            .into_iter()
            .filter(|operation| {
                if !is_unbound_root(operation, thread, turn) {
                    return false;
                }
                let state = operation.state.lock().unwrap();
                !state.preparing && !state.input_dispatching && state.lease
            })
            .collect::<Vec<_>>();
        let [operation] = candidates.as_slice() else {
            return Ok(false);
        };
        let status = operation.ticket()?.status();
        if status["state"] == "suspended" && operation.state.lock().unwrap().initial_native_paused {
            return Ok(true);
        }
        if status["state"] != "running" && status["state"] != "cancelling" {
            return Ok(false);
        }
        operation.lease()?.suspend()?;
        operation.state.lock().unwrap().initial_native_paused = true;
        Ok(true)
    }

    pub fn resume_paused_native(&self, chat: &JsString) -> Result<()> {
        for operation in self.chat_operations(chat) {
            operation.ticket()?.resume_waiting()?;
        }
        Ok(())
    }

    pub fn suspend_native(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: &JsString,
    ) -> Result<()> {
        self.find_native(thread, turn, scope)
            .ok_or_else(|| anyhow!("Native suspension has no inference owner."))?
            .lease()?
            .suspend()
    }

    pub fn resume_native(&self, thread: &JsString, turn: &JsString, scope: &JsString) -> Work<()> {
        let lease = self
            .find_native(thread, turn, scope)
            .ok_or_else(|| anyhow!("Native resumption has no inference owner."))
            .and_then(|operation| operation.lease());
        match lease {
            Ok(lease) => lease.resume(),
            Err(error) => Box::pin(async { Err(error) }),
        }
    }

    pub(super) fn native_entry(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: &JsString,
    ) -> Option<Arc<NativeEntry>> {
        self.0
            .state
            .lock()
            .unwrap()
            .native
            .get(&key(thread, turn, Some(scope)))
            .cloned()
    }

    /// Only an exact Core cancellation or acknowledged negative begin can retire this gate.
    pub fn reject_native_begin(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: &JsString,
        gate: &JsString,
        runner_generation: Option<&JsString>,
    ) -> Result<()> {
        let Some(entry) = self.native_entry(thread, turn, scope).filter(|entry| {
            &entry.gate == gate && entry.runner_generation.as_ref() == runner_generation
        }) else {
            return Ok(());
        };
        let (confirmed, operation) = {
            let state = entry.state.lock().unwrap();
            (state.confirmed, state.operation.clone())
        };
        let operation = operation.or_else(|| self.find_native(thread, turn, scope));
        self.remember_completed(thread, turn, Some(scope));
        if let Some(operation) = operation.filter(|_| confirmed) {
            let matches = {
                let state = operation.state.lock().unwrap();
                !state.settled
                    && !state.preparing
                    && state.thread.as_ref() == Some(thread)
                    && state.turn.as_ref() == Some(turn)
                    && state.native_scope.as_ref().is_none_or(|held| held == scope)
            };
            if matches {
                self.settle(&operation, Outcome::Failed)?;
            }
        }
        Ok(())
    }

    pub fn finish_native(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: &JsString,
        model_failed_before_output: bool,
    ) -> Result<()> {
        self.remember_completed(thread, turn, Some(scope));
        if let Some(operation) = self.find_native(thread, turn, scope) {
            operation.state.lock().unwrap().native_failed_before_output =
                model_failed_before_output;
            self.settle(&operation, Outcome::Completed)?;
        }
        Ok(())
    }

    pub fn cancel_native_wait(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: &JsString,
    ) -> Result<()> {
        let Some(operation) = self.find_native(thread, turn, scope) else {
            return Ok(());
        };
        let ticket = operation.ticket()?;
        if !matches!(
            ticket.status()["state"].as_str(),
            Some("waiting" | "granted" | "suspended")
        ) {
            return Ok(());
        }
        ticket.cancel(None);
        operation.state.lock().unwrap().settled = true;
        self.0
            .state
            .lock()
            .unwrap()
            .active
            .shift_remove(&operation.id);
        operation.finish.finish(Ok(()));
        Ok(())
    }
}

pub struct NativePause {
    pub parked: bool,
    pub independent: bool,
}

fn is_unbound_root(operation: &Operation, thread: &JsString, turn: &JsString) -> bool {
    let state = operation.state.lock().unwrap();
    state.thread.as_ref() == Some(thread)
        && !changed(&state.turn, turn)
        && state.dispatched
        && state.native_scope.is_none()
        && !state.settled
}

fn root_binding_state(operation: &Operation, scope: &JsString) -> Result<bool> {
    let state = operation.state.lock().unwrap();
    if state.settled
        || state
            .native_scope
            .as_ref()
            .is_some_and(|held| held != scope)
    {
        bail!("Native inference owner changed during confirmation.");
    }
    Ok(state.initial_native_paused)
}

fn joined(parts: &[&JsString]) -> JsString {
    let mut units = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            units.push(u16::from(b':'));
        }
        units.extend_from_slice(part.units());
    }
    JsString::new(units)
}

fn owns_entry(state: &State, input: &NativeRequest, entry: &Arc<NativeEntry>) -> bool {
    state
        .native
        .get(&key(
            &input.thread_id,
            &input.turn_id,
            Some(&input.scope_id),
        ))
        .is_some_and(|current| Arc::ptr_eq(current, entry))
}
