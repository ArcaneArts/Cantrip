use super::acquire::check_signal;
use super::*;
use cantrip_transport::lifecycle::owned;

#[derive(Clone)]
pub struct PreparationScope {
    execution: Execution,
    sent: Arc<Mutex<bool>>,
    complete: Complete<()>,
}

impl PreparationScope {
    pub fn before_send(&self) -> Result<()> {
        let mut sent = self.sent.lock().unwrap();
        if *sent {
            bail!("Inference preparation was already sent or settled.");
        }
        self.execution.start(true)?;
        *sent = true;
        Ok(())
    }

    pub fn replied(&self) {
        self.complete.finish(Ok(()));
    }

    pub fn not_sent(&self) {
        self.complete.finish(Ok(()));
    }
}

impl super::super::rpc_requests::Settlement for PreparationScope {
    fn replied(&self) -> Result<()> {
        Self::replied(self);
        Ok(())
    }

    fn not_sent(&self) -> Result<()> {
        Self::not_sent(self);
        Ok(())
    }
}

impl Adapter {
    pub fn prepare_before_acquire<T: Send + 'static>(
        &self,
        input: Acquire,
        action: impl FnOnce(Signal) -> Work<T> + Send + 'static,
    ) -> Work<T> {
        let adapter = self.clone();
        owned(async move {
            let invalid =
                || anyhow!("The canonical source cannot enter pre-acquisition preparation.");
            let life = input.lifetime.clone().ok_or_else(invalid)?;
            if life.runtime_generation() != adapter.generation()
                || life.operation_id() != &input.operation_id
                || input
                    .native_scope_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty())
                || input
                    .expected_turn_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty())
            {
                return Err(invalid());
            }
            life.assert_current()?;
            check_signal(input.signal.as_ref())?;
            let (abort, signal) = Abort::new();
            let signal = Signal::any(input.signal.clone().into_iter().chain([signal]).collect());
            let (finish, finished) = Promise::pair();
            let preparation = {
                let mut state = adapter.0.state.lock().unwrap();
                state.prune();
                if state.exited
                    || state
                        .requests
                        .iter()
                        .any(|entry| entry.lifetime.matches(&life))
                    || state.before.iter().any(|entry| {
                        entry
                            .request
                            .lifetime
                            .as_ref()
                            .is_some_and(|held| held.same(&life))
                    })
                {
                    return Err(invalid());
                }
                let entry = Arc::new(BeforeAcquire {
                    id: state.id(),
                    request: input,
                    abort,
                    finished,
                    reason: Mutex::new(None),
                    withdrawal: Mutex::new(None),
                });
                state.before.push(entry.clone());
                entry
            };
            let result = action(signal).await;
            adapter
                .0
                .state
                .lock()
                .unwrap()
                .before
                .retain(|entry| entry.id != preparation.id);
            finish.finish(Ok(()));
            let reason = preparation.reason.lock().unwrap().clone();
            reason.map_or(result, |error| Err(error.error()))
        })
    }
}

impl Execution {
    pub fn prepare_model_operations<T: Clone + Send + Sync + 'static>(
        &self,
        action: impl FnOnce(PreparationContext) -> Work<T> + Send + 'static,
    ) -> Work<T> {
        let this = self.clone();
        owned(async move {
            let lease = this
                .permission("Model-operation preparation no longer owns its inference grant.")
                .await?;
            this.assert_model_preparation_current()?;
            {
                let mut state = this.operation.state.lock().unwrap();
                if state.preparing {
                    bail!("This native owner already has a preparation in progress.");
                }
                state.preparing = true;
            }
            let current = this.clone();
            let operation = this.operation.clone();
            let owner = PreparationOwner {
                assert_current: Arc::new(move || current.assert_model_preparation_current()),
                started: Arc::new(move || {
                    operation.state.lock().unwrap().lease_started = true;
                    Ok(())
                }),
            };
            let result = this
                .adapter
                .0
                .admission
                .with_preparation(lease, owner, action)
                .await;
            this.operation.state.lock().unwrap().preparing = false;
            result
        })
    }

    fn assert_model_preparation_current(&self) -> Result<()> {
        self.life.assert_current()?;
        let exited = self.adapter.0.state.lock().unwrap().exited;
        let state = self.operation.state.lock().unwrap();
        if exited
            || state.settled
            || state.dispatched
            || state.input_dispatching
            || state.native_boundary
            || state.transferring
            || state.starting
        {
            bail!("Native input is not blocked for model-operation preparation.");
        }
        Ok(())
    }

    pub fn prepare<T: Send + 'static>(
        &self,
        provider_id: JsString,
        action: impl FnOnce(PreparationScope) -> Work<T> + Send + 'static,
    ) -> Work<T> {
        let this = self.clone();
        owned(async move {
            let lease = this
                .permission("The native preparation no longer owns its inference grant.")
                .await?;
            let (complete, pending) = Promise::pair();
            {
                let mut state = this.operation.state.lock().unwrap();
                if provider_id != this.operation.input.provider_id()
                    || state.preparing
                    || state.dispatched
                    || state.settled
                    || state.transferring
                    || state.starting
                {
                    bail!("Inference preparation does not own this provider turn.");
                }
                state.preparing = true;
                state.preparation_ended = Some(complete.clone());
            }
            let scope = PreparationScope {
                execution: this.clone(),
                sent: Arc::new(Mutex::new(false)),
                complete,
            };
            let result = action(scope.clone()).await;
            let sent = *scope.sent.lock().unwrap();
            if sent {
                // An observation deadline never proves the native RPC settled.
                pending.work().await?;
            }
            let settled = {
                let mut state = this.operation.state.lock().unwrap();
                state.preparation_ended = None;
                state.preparing = false;
                state.settled
            };
            if settled || this.adapter.0.state.lock().unwrap().exited {
                bail!("The preparation's native inference process exited.");
            }
            lease.signal().check()?;
            result
        })
    }
}
