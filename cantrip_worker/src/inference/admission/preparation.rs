use super::*;
#[derive(Clone)]
pub struct PreparationOwner {
    pub assert_current: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    pub started: Arc<dyn Fn() -> Result<()> + Send + Sync>,
}
struct PreparationState {
    jobs: IndexMap<Id, Promise<()>>,
    next: Id,
    borrowing: Option<Promise<()>>,
    handed_off: bool,
    handoff: Option<Promise<()>>,
    yielded: bool,
    closing: bool,
}
struct PreparationInner {
    id: JsString,
    manager: Weak<Inner>,
    parent: Id,
    provider: JsString,
    created: Option<f64>,
    parent_signal: Signal,
    cancel: Abort,
    signal: Signal,
    owner: PreparationOwner,
    state: Mutex<PreparationState>,
}
/// Opaque context minted only for an actual unused native reservation.
#[derive(Clone)]
pub struct PreparationContext(Arc<PreparationInner>);
impl PreparationContext {
    pub fn id(&self) -> &JsString {
        &self.0.id
    }
    pub fn signal(&self) -> Signal {
        self.0.signal.clone()
    }
    pub(super) fn belongs_to(&self, manager: &Manager) -> bool {
        Weak::ptr_eq(&self.0.manager, &Arc::downgrade(&manager.0))
    }
    fn manager(&self) -> Result<Manager> {
        self.0.manager.upgrade().map(Manager).ok_or_else(|| {
            anyhow!("Model-operation preparation no longer owns its native reservation.")
        })
    }
    fn current(&self) -> Result<()> {
        self.manager()?
            .preparation_current(self.0.parent, &self.0.owner, &self.0.parent_signal)
    }
    pub(super) fn run<T: Clone + Send + Sync + 'static>(
        &self,
        mut input: DirectRequest,
        execute: impl FnOnce(Signal) -> Work<T> + Send + 'static,
    ) -> Work<T> {
        let (finish, settled) = Promise::pair();
        let id = {
            let mut state = self.0.state.lock().unwrap();
            if state.closing {
                return Promise::ready(Err(anyhow!("Model-operation preparation has closed.")))
                    .work();
            }
            state.next += 1;
            let id = state.next;
            state.jobs.insert(id, settled);
            id
        };
        input.input.signal = Some(Signal::any(
            std::iter::once(self.0.parent_signal.clone())
                .chain(std::iter::once(self.0.signal.clone()))
                .chain(input.input.signal.clone())
                .collect(),
        ));
        let context = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let result = context.execute(input, execute).await;
            finish.finish(Ok(()));
            context.0.state.lock().unwrap().jobs.shift_remove(&id);
            result
        })
    }
    async fn execute<T: Clone + Send + Sync + 'static>(
        &self,
        input: DirectRequest,
        execute: impl FnOnce(Signal) -> Work<T> + Send + 'static,
    ) -> Result<T> {
        self.current()?;
        input.input.signal.as_ref().unwrap().check()?;
        let same = input.input.provider_id == self.0.provider
            && (input.input.provider_creation_revision.is_none()
                || self.0.created.is_none()
                || input.input.provider_creation_revision == self.0.created);
        let borrowing = {
            let mut state = self.0.state.lock().unwrap();
            if !state.handed_off && state.borrowing.is_none() && same {
                let (finish, borrowed) = Promise::pair();
                state.borrowing = Some(borrowed);
                Some(finish)
            } else {
                None
            }
        };
        if let Some(finish) = borrowing {
            let yield_after = input.yield_after;
            let result = self
                .manager()?
                .execute_borrowed(self.0.parent, input, execute, self.0.owner.started.clone())
                .await;
            let handoff = {
                let mut state = self.0.state.lock().unwrap();
                state.borrowing = None;
                finish.finish(Ok(()));
                yield_after || state.handed_off
            };
            if handoff {
                self.yield_parent().work().await?;
            }
            return result;
        }
        let borrowed = self.0.state.lock().unwrap().borrowing.is_some();
        let handoff = self.yield_parent();
        if !borrowed {
            handoff.work().await?;
        }
        self.current()?;
        input.input.signal.as_ref().unwrap().check()?;
        self.manager()?.execute_direct(input, execute).await
    }
    fn yield_parent(&self) -> Promise<()> {
        let (complete, pending, borrowing) = {
            let mut state = self.0.state.lock().unwrap();
            if let Some(handoff) = &state.handoff {
                return handoff.clone();
            }
            state.handed_off = true;
            let (complete, pending) = Promise::pair();
            state.handoff = Some(pending.clone());
            (complete, pending, state.borrowing.clone())
        };
        let context = self.clone();
        let operation = cantrip_transport::lifecycle::owned(async move {
            if let Some(borrowing) = borrowing {
                borrowing.work().await?;
            }
            context.current()?;
            context.manager()?.suspend(context.0.parent, true)?;
            context.0.state.lock().unwrap().yielded = true;
            Ok(())
        });
        tokio::spawn(async move {
            complete.finish(operation.await);
        });
        pending
    }
    async fn close(&self, succeeded: bool) -> Result<()> {
        let jobs = {
            let mut state = self.0.state.lock().unwrap();
            state.closing = true;
            state.jobs.values().cloned().collect::<Vec<_>>()
        };
        if !succeeded {
            self.0
                .cancel
                .abort(anyhow!("Model-operation preparation failed."));
        }
        futures::future::try_join_all(jobs.iter().map(Promise::work)).await?;
        let (handoff, yielded) = {
            let state = self.0.state.lock().unwrap();
            (state.handoff.clone(), state.yielded)
        };
        if let Some(handoff) = handoff {
            handoff.work().await?;
        }
        if yielded && self.0.parent_signal.check().is_ok() {
            self.current()?;
            self.manager()?.resume(self.0.parent).work().await?;
            (self.0.owner.started)()?;
        }
        Ok(())
    }
}
impl Manager {
    fn preparation_current(&self, id: Id, owner: &PreparationOwner, signal: &Signal) -> Result<()> {
        (owner.assert_current)()?;
        signal.check()?;
        self.edit(|state, _| {
            let ticket = &state.tickets[&id];
            if ticket.pending_settlement.is_some()
                || state.closing
                || matches!(ticket.phase, Phase::Released | Phase::Cancelling)
                || state
                    .runtimes
                    .get(&ticket.runtime)
                    .is_none_or(|runtime| runtime.retiring.is_some() || runtime.retired)
            {
                bail!("Model-operation preparation no longer owns its native reservation.");
            }
            Ok(())
        })
    }
    pub fn with_preparation<T: Clone + Send + Sync + 'static>(
        &self,
        lease: Lease,
        owner: PreparationOwner,
        action: impl FnOnce(PreparationContext) -> Work<T> + Send + 'static,
    ) -> Work<T> {
        if !Arc::ptr_eq(&self.0, &lease.0.manager.0) {
            return Promise::ready(Err(anyhow!(
                "Model-operation preparation requires its actual unused native grant."
            )))
            .work();
        }
        let id = lease.0.id;
        let initial = self
            .edit(|state, _| {
                let ticket = &state.tickets[&id];
                if state
                    .runtimes
                    .get(&ticket.runtime)
                    .is_none_or(|runtime| runtime.direct_owner.is_some())
                    || !ticket.external_work.is_empty()
                    || ticket.native_execution.is_some()
                    || !matches!(ticket.phase, Phase::Granted | Phase::Running)
                    || !ticket.permission_granted
                {
                    bail!("Model-operation preparation requires its actual unused native grant.");
                }
                Ok(ticket.signal.clone())
            })
            .and_then(|signal| {
                self.preparation_current(id, &owner, &signal)?;
                Ok(signal)
            });
        let signal = match initial {
            Ok(signal) => signal,
            Err(error) => return Promise::ready(Err(error)).work(),
        };
        let result = self.edit(|state, effects| {
            // Repeat the actual reservation check when installing the producer
            // hold: another native thread can have bound/retired it meanwhile.
            let ticket = &state.tickets[&id];
            if !ticket.external_work.is_empty()
                || ticket.native_execution.is_some()
                || !matches!(ticket.phase, Phase::Granted | Phase::Running)
                || !ticket.permission_granted
                || ticket.pending_settlement.is_some()
                || signal.check().is_err()
                || state.closing
                || state.runtimes.get(&ticket.runtime).is_none_or(|runtime| {
                    runtime.direct_owner.is_some() || runtime.retiring.is_some() || runtime.retired
                })
            {
                bail!("Model-operation preparation requires its actual unused native grant.");
            }
            let dependency_id = state.id();
            let (finish, dependency) = Promise::pair();
            let ticket = state.tickets.get_mut(&id).unwrap();
            ticket.external_work.insert(dependency_id, dependency);
            let provider = ticket.input.provider_id.clone();
            let created = ticket.input.provider_creation_revision;
            let (cancel, own_signal) = Abort::new();
            let preparation = PreparationContext(Arc::new(PreparationInner {
                id: uuid::Uuid::new_v4().to_string().into(),
                manager: Arc::downgrade(&self.0),
                parent: id,
                provider,
                created,
                parent_signal: signal.clone(),
                cancel,
                signal: Signal::any(vec![signal, own_signal]),
                owner,
                state: Mutex::new(PreparationState {
                    jobs: IndexMap::new(),
                    next: 0,
                    borrowing: None,
                    handed_off: false,
                    handoff: None,
                    yielded: false,
                    closing: false,
                }),
            }));
            Ok(self.ticket_task(state, effects, id, move |manager| {
                Box::pin(async move {
                    let value = action(preparation.clone()).await;
                    let succeeded = value.is_ok();
                    let closed = preparation
                        .close(succeeded)
                        .await
                        .and_then(|()| preparation.current());
                    let cleanup = manager.edit(|state, effects| {
                        let ticket = state.tickets.get_mut(&id).unwrap();
                        ticket.external_work.shift_remove(&dependency_id);
                        let settle = if ticket.external_work.is_empty() {
                            ticket.pending_settlement
                        } else {
                            None
                        };
                        finish.finish(Ok(()));
                        if let Some(settle) = settle {
                            manager.settle_locked(state, id, settle, effects)?;
                        }
                        Ok(())
                    });
                    closed?;
                    cleanup?;
                    value
                })
            }))
        });
        result
            .unwrap_or_else(|error| Promise::ready(Err(error)))
            .work()
    }
}
