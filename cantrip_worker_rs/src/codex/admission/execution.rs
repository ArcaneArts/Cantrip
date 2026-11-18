use super::*;

#[derive(Clone)]
pub struct Execution {
    pub(super) adapter: Adapter,
    pub(super) operation: Arc<Operation>,
    pub(super) ticket: Ticket,
    pub(super) life: Lifetime,
}

impl Execution {
    pub fn settled(&self) -> Work<()> {
        self.operation.settlement.work()
    }

    pub fn failure_evidence(&self) -> Value {
        let aborted = self
            .operation
            .lease()
            .is_ok_and(|lease| lease.signal().check().is_err());
        let state = self.operation.state.lock().unwrap();
        let input = &self.operation.input;
        let message = input.recovery.as_ref().and_then(|v| v.get("messageId"));
        if !state.settled
            || state.preparing
            || aborted
            || !coercion::truthy(input.chat_id.as_ref())
            || !coercion::truthy(message)
        {
            return Value::Null;
        }
        let (disposition, scope) =
            if !state.dispatched || (state.rejected_input && !state.native_boundary) {
                ("input-not-dispatched", None)
            } else if state.native_boundary
                && state.native_failed_before_output
                && state.thread.is_some()
                && state.turn.is_some()
                && state.native_scope.is_some()
            {
                ("model-failed-before-output", state.native_scope.clone())
            } else {
                return Value::Null;
            };
        json!({
            "operationId": input.operation_id, "providerId": input.provider_id(),
            "runtimeGeneration": self.adapter.generation(), "chatId": nullish(input.chat_id.as_ref()),
            "messageId": nullish(message), "disposition": disposition,
            "threadId": state.thread, "turnId": state.turn, "nativeScopeId": scope
        })
    }

    pub fn bind_thread(&self, thread: JsString) -> Result<()> {
        {
            let mut state = self.operation.state.lock().unwrap();
            if changed(&state.thread, &thread) {
                bail!("Inference admission cannot change its native thread.");
            }
            state.thread = Some(thread);
        }
        self.adapter.notify_revocation(&self.operation)?;
        self.adapter.reconcile(&self.operation)
    }

    pub fn bind_turn(&self, turn: JsString) -> Result<()> {
        self.adapter.bind_turn(&self.operation, turn)
    }

    pub fn dispatched(&self) -> Result<()> {
        self.start(false)?;
        self.adapter.notify_revocation(&self.operation)?;
        let completed = {
            let state = self.operation.state.lock().unwrap();
            state
                .thread
                .as_ref()
                .zip(state.turn.as_ref())
                .map(|(thread, turn)| key(thread, turn, None))
        };
        if let Some(completed) = completed {
            self.adapter
                .0
                .state
                .lock()
                .unwrap()
                .completed
                .shift_remove(&completed);
        }
        Ok(())
    }

    pub(super) fn start(&self, preparing: bool) -> Result<()> {
        let lease = self.operation.lease()?;
        lease.signal().check()?;
        let already_started = {
            let mut state = self.operation.state.lock().unwrap();
            if state.dispatched
                || state.settled
                || state.preparing != preparing
                || state.starting
                || state.transferring
            {
                bail!("The inference operation was already dispatched or settled.");
            }
            state.starting = true;
            state.lease_started
        };
        let result = if already_started {
            Ok(())
        } else {
            lease.start()
        };
        let mut state = self.operation.state.lock().unwrap();
        state.starting = false;
        result?;
        state.lease_started = true;
        if !preparing {
            state.dispatched = true;
        }
        Ok(())
    }

    pub(super) async fn permission(&self, message: &str) -> Result<Lease> {
        loop {
            let (epoch, permission) = self.ticket.ready_with_epoch();
            let lease = permission.await?;
            lease.signal().check()?;
            if !self.ticket.is_current_permission(&epoch) {
                continue;
            }
            let status = self.ticket.status();
            let mut state = self.operation.state.lock().unwrap();
            if status["state"] != "granted"
                && !(status["state"] == "running" && state.lease_started)
            {
                bail!("{message}");
            }
            state.lease = true;
            return Ok(lease);
        }
    }

    pub fn seal_input_dispatch(&self) -> Work<()> {
        let this = self.clone();
        Box::pin(async move {
            this.permission("The native input no longer owns its inference grant.")
                .await?;
            let mut state = this.operation.state.lock().unwrap();
            if state.input_dispatching
                || state.settled
                || state.dispatched
                || state.preparing
                || state.transferring
                || state.starting
            {
                bail!("The inference input cannot begin dispatch.");
            }
            state.input_dispatching = true;
            Ok(())
        })
    }

    pub fn rejected(&self) -> Result<()> {
        {
            let mut state = self.operation.state.lock().unwrap();
            if state.observed_start || state.native_boundary {
                return Ok(());
            }
            state.rejected_input = true;
        }
        self.adapter.settle(&self.operation, Outcome::Failed)
    }

    pub fn not_dispatched(&self) -> Result<()> {
        let outcome = {
            let state = self.operation.state.lock().unwrap();
            if state.dispatched || state.preparing || state.starting {
                return Ok(());
            }
            undispatched_outcome(&state)
        };
        self.adapter.settle(&self.operation, outcome)
    }
}

pub(super) fn changed(previous: &Option<JsString>, next: &JsString) -> bool {
    previous
        .as_ref()
        .is_some_and(|previous| !previous.is_empty() && previous != next)
}

pub(super) fn undispatched_outcome(state: &OperationState) -> Outcome {
    if state.lease_started {
        Outcome::Completed
    } else {
        Outcome::NeverStarted
    }
}
