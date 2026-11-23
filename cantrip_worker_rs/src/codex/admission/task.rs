use super::*;

impl Adapter {
    pub fn queued_task_goal_cycle(
        &self,
        thread: &JsString,
        cycle: &JsString,
        epoch: &JsString,
    ) -> Option<Value> {
        self.active().into_iter().find(|operation| {
            let state = operation.state.lock().unwrap();
            task_cycle_matches(&state, thread, cycle) && state.queued
                && state.task_goal_cycle.as_ref().and_then(|v| v["goalEpoch"].as_js_string()) == Some(epoch)
        }).map(|operation| json!({"operationId": operation.input.operation_id, "runtimeGeneration": self.generation()}))
    }

    pub fn has_task_goal_scope(
        &self,
        chat: &JsString,
        thread: &JsString,
        cycle: &JsString,
    ) -> bool {
        self.chat_operations(chat)
            .iter()
            .any(|operation| task_cycle_matches(&operation.state.lock().unwrap(), thread, cycle))
    }

    pub fn capture_task_goal_source(
        &self,
        chat: JsString,
        thread: JsString,
        cycle: JsString,
    ) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            let candidates = this
                .chat_operations(&chat)
                .into_iter()
                .filter(|operation| {
                    let state = operation.state.lock().unwrap();
                    state.queued && task_cycle_matches(&state, &thread, &cycle)
                })
                .collect::<Vec<_>>();
            let [operation] = candidates.as_slice() else {
                return Err(unused("The Task has no unique queued private Goal source."));
            };
            let record = operation.ticket()?.private_task_goal_source().await?;
            if !Arc::ptr_eq(operation, &this.unused_task_goal_operation(&record)?) {
                return Err(unused(
                    "The private Task Goal source changed during capture.",
                ));
            }
            Ok(record)
        })
    }

    pub fn has_task_goal_input_scope(
        &self,
        chat: &JsString,
        thread: &JsString,
        input: &Value,
    ) -> bool {
        let serialized = input.stringify();
        self.chat_operations(chat).iter().any(|operation| {
            let state = operation.state.lock().unwrap();
            !state.settled
                && state.thread.as_ref() == Some(thread)
                && task_input_matches(operation, &state, input, &serialized)
        })
    }

    fn unused_task_goal_input_operation(&self, input: &Value) -> Result<Arc<Operation>> {
        let serialized = input.stringify();
        let candidates = self
            .active()
            .into_iter()
            .filter(|operation| {
                let state = operation.state.lock().unwrap();
                task_input_matches(operation, &state, input, &serialized)
                    && state.queued
                    && !state.settled
                    && !state.dispatched
                    && !state.input_dispatching
                    && !state.lease_started
                    && !state.preparing
                    && !state.native_boundary
                    && !state.starting
                    && !state.transferring
                    && state.native_scope.is_none()
            })
            .collect::<Vec<_>>();
        let [operation] = candidates.as_slice() else {
            return Err(unused("The Task has no unique unused first Goal input."));
        };
        Ok(operation.clone())
    }

    pub fn capture_task_goal_input_source(&self, input: Value) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            let operation = this.unused_task_goal_input_operation(&input)?;
            let source = operation.ticket()?.unstarted_source().await?;
            if !Arc::ptr_eq(&operation, &this.unused_task_goal_input_operation(&input)?) {
                return Err(unused(
                    "The Task Goal input changed during its keeper read.",
                ));
            }
            Ok(source)
        })
    }

    pub fn withdraw_task_goal_input_source(
        &self,
        source: &Value,
        reason: Withdrawal,
        queue_revision: u64,
    ) -> Result<Work<Value>> {
        let claim = &source["identity"];
        let recovery = &claim["recovery"];
        let input = &recovery["taskInput"];
        if input["kind"] != "goal" || coercion::truthy(source.get("nativeExecution")) {
            return Err(unused(
                "The transfer has no unused Task Goal input receipt.",
            ));
        }
        let operation = self.unused_task_goal_input_operation(input)?;
        let owner = {
            let state = operation.state.lock().unwrap();
            claim["runtimeGeneration"].as_js_string() == Some(self.generation())
                && claim["chatId"] == nullish(operation.input.chat_id.as_ref())
                && recovery["threadId"].as_js_string() == state.thread.as_ref()
        };
        if !owner {
            return Err(unused("The Task Goal input changed its physical owner."));
        }
        self.withdraw_operation(
            &operation,
            Some(reason.clone().into()),
            Some(reason),
            Some(queue_revision),
            false,
        )
    }

    pub fn withdraw_task_goal_source(
        &self,
        record: &Value,
        reason: Withdrawal,
    ) -> Result<Work<Value>> {
        let operation = self.unused_task_goal_operation(record)?;
        self.withdraw_operation(
            &operation,
            Some(reason.clone().into()),
            Some(reason),
            None,
            true,
        )
    }

    fn unused_task_goal_operation(&self, record: &Value) -> Result<Arc<Operation>> {
        let claim = &record["identity"];
        let recovery = &claim["recovery"];
        let cycle = &recovery["taskGoalCycle"];
        let no_owner =
            || unused("The captured Task Goal source has no current private gate owner.");
        let thread = recovery["threadId"].as_js_string().ok_or_else(no_owner)?;
        let turn = recovery["turnId"].as_js_string().ok_or_else(no_owner)?;
        let scope = cycle["scopeId"].as_js_string().ok_or_else(no_owner)?;
        let entry = self
            .native_entry(thread, turn, scope)
            .ok_or_else(no_owner)?;
        let life = {
            let state = entry.state.lock().unwrap();
            if !state.confirmed
                || entry.independent
                || !state.goal.as_ref().is_some_and(|(epoch, only)| {
                    *only && cycle["goalEpoch"].as_js_string() == Some(epoch)
                })
                || cycle["gateAttemptId"].as_js_string() != Some(&entry.gate)
            {
                return Err(no_owner());
            }
            state.lifetime.clone().ok_or_else(no_owner)?
        };
        let operation = {
            let state = self.0.state.lock().unwrap();
            if state.exited || claim["runtimeGeneration"].as_js_string() != Some(self.generation())
            {
                return Err(no_owner());
            }
            state.operation_for(&life).ok_or_else(no_owner)?
        };
        let status = operation.ticket()?.status();
        {
            let state = operation.state.lock().unwrap();
            let actual = json!({"threadId":state.thread, "turnId":state.turn, "taskGoalCycle":state.task_goal_cycle});
            if claim["operationId"].as_js_string() != Some(&operation.input.operation_id)
                || claim["chatId"] != nullish(operation.input.chat_id.as_ref())
                || state.thread.as_ref() != Some(thread)
                || state.turn.as_ref() != Some(turn)
                || state.native_scope.as_ref() != Some(scope)
                || status["providerId"] != claim["providerId"]
                || identity::recovery(&actual) != identity::recovery(recovery)
            {
                return Err(no_owner());
            }
            if state.withdrawal.is_none()
                && (state.settled
                    || state.revoked
                    || state.dispatched
                    || state.input_dispatching
                    || state.lease_started
                    || state.observed_start
                    || state.preparing
                    || state.starting
                    || state.transferring
                    || !state.queued)
            {
                return Err(unused(
                    "The captured private Task Goal begin is no longer unused.",
                ));
            }
        }
        Ok(operation)
    }
}

fn task_cycle_matches(state: &OperationState, thread: &JsString, cycle: &JsString) -> bool {
    !state.settled
        && state.thread.as_ref() == Some(thread)
        && state
            .task_goal_cycle
            .as_ref()
            .and_then(|v| v["cycleId"].as_js_string())
            == Some(cycle)
}

fn task_input_matches(
    operation: &Operation,
    state: &OperationState,
    input: &Value,
    serialized: &str,
) -> bool {
    input["operationId"].as_js_string() == Some(&operation.input.operation_id)
        && state
            .task_input
            .as_ref()
            .is_some_and(|receipt| receipt["kind"] == "goal" && receipt.stringify() == serialized)
}
