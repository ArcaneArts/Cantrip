use super::*;
pub(super) struct LifetimeData {
    pub closed: bool,
    pub ticket: Option<Id>,
    pub rejection: Option<Failure>,
    pub withdrawal: Option<Promise<Value>>,
    pub withdrawal_identity: Option<String>,
}
pub(super) struct LifetimeInner {
    pub manager: Weak<Inner>,
    pub runtime: Id,
    pub generation: JsString,
    pub operation: JsString,
    pub state: Mutex<LifetimeData>,
}
#[derive(Clone)]
pub struct Lifetime(pub(super) Arc<LifetimeInner>);
#[derive(Clone)]
pub(crate) struct WeakLifetime(Weak<LifetimeInner>);
impl WeakLifetime {
    pub(crate) fn alive(&self) -> bool {
        self.0.strong_count() > 0
    }
    pub(crate) fn matches(&self, lifetime: &Lifetime) -> bool {
        self.0.ptr_eq(&Arc::downgrade(&lifetime.0))
    }
    pub(crate) fn upgrade(&self) -> Option<Lifetime> {
        self.0.upgrade().map(Lifetime)
    }
}
impl Lifetime {
    pub(crate) fn downgrade(&self) -> WeakLifetime {
        WeakLifetime(Arc::downgrade(&self.0))
    }
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub fn operation_id(&self) -> &JsString {
        &self.0.operation
    }
    pub fn runtime_generation(&self) -> &JsString {
        &self.0.generation
    }
    pub fn assert_current(&self) -> Result<()> {
        let manager = Manager(
            self.0
                .manager
                .upgrade()
                .ok_or_else(|| anyhow!("The inference runtime is not live."))?,
        );
        manager.edit(|state, _| {
            let lifetime = self.0.state.lock().unwrap();
            if lifetime.closed {
                return Err(lifetime.rejection.as_ref().map_or_else(
                    || anyhow!("The canonical inference operation has closed."),
                    Failure::error,
                ));
            }
            if state.closing
                || state.runtimes.get(&self.0.runtime).is_none_or(|runtime| {
                    runtime.retired || runtime.retiring.is_some() || !runtime.prepared
                })
            {
                bail!("The inference runtime is not live.");
            }
            Ok(())
        })
    }
    pub fn close(&self) {
        let Some(inner) = self.0.manager.upgrade() else {
            return;
        };
        let manager = Manager(inner);
        let _ = manager.edit(|state, effects| {
            let ticket = {
                let mut lifetime = self.0.state.lock().unwrap();
                if lifetime.closed {
                    return Ok(());
                }
                lifetime.closed = true;
                lifetime.ticket
            };
            if let Some(id) = ticket
                && let Some(ticket) = state.tickets.get(&id)
                && (!ticket.external_work.is_empty()
                    || ticket.started_at.is_none()
                        && matches!(ticket.phase, Phase::Waiting | Phase::Granted))
            {
                manager.cancel_locked(
                    state,
                    id,
                    anyhow!("Canonical inference ownership has ended."),
                    effects,
                );
            }
            Ok(())
        });
    }
}
#[derive(Clone)]
pub struct Runtime {
    pub(super) manager: Manager,
    pub(super) id: Id,
    pub(super) generation: JsString,
}
impl Runtime {
    pub fn generation(&self) -> &JsString {
        &self.generation
    }
    pub fn prepare_native_launch(&self) -> Work<HashMap<String, String>> {
        self.manager
            .prepare_native_launch(self.id, self.generation.clone())
    }
    pub fn create_operation_lifetime(&self, operation: JsString) -> Result<Lifetime> {
        self.manager.edit(|state, _| {
            if state.closing
                || state.runtimes.get(&self.id).is_none_or(|runtime| {
                    runtime.retiring.is_some() || runtime.retired || !runtime.prepared
                })
            {
                bail!("The inference runtime is not live.");
            }
            Ok(Lifetime(Arc::new(LifetimeInner {
                manager: Arc::downgrade(&self.manager.0),
                runtime: self.id,
                generation: self.generation.clone(),
                operation,
                state: Mutex::new(LifetimeData {
                    closed: false,
                    ticket: None,
                    rejection: None,
                    withdrawal: None,
                    withdrawal_identity: None,
                }),
            })))
        })
    }
    pub fn request(&self, input: Request) -> Result<Ticket> {
        self.manager.request(self.id, input)
    }
    pub fn withdraw_before_request(
        &self,
        input: Request,
        reason: anyhow::Error,
        settled: Promise<()>,
    ) -> Result<Work<Value>> {
        self.manager
            .withdraw_before_request(self.id, input, reason, settled)
            .map(|pending| pending.work())
    }
    pub fn exited(&self) -> Work<()> {
        self.manager.retire(self.id).work()
    }
}
#[derive(Clone)]
pub struct Ticket {
    pub(super) manager: Manager,
    pub(super) id: Id,
    // Retains exact redelivery metadata after runtime.records releases it.
    pub(super) _lifetime: Lifetime,
}
#[derive(Clone)]
pub(crate) struct WeakTicket {
    manager: Weak<Inner>,
    id: Id,
    lifetime: WeakLifetime,
}
impl WeakTicket {
    pub(crate) fn lease(&self) -> Option<Lease> {
        self.upgrade().map(Lease)
    }
    pub(crate) fn upgrade(&self) -> Option<Ticket> {
        let lifetime = self.lifetime.upgrade()?;
        let manager = Manager(self.manager.upgrade()?);
        let exists = manager
            .0
            .state
            .lock()
            .unwrap()
            .tickets
            .contains_key(&self.id);
        exists.then_some(Ticket {
            manager,
            id: self.id,
            _lifetime: lifetime,
        })
    }
}
#[derive(Clone)]
pub(crate) struct PermissionEpoch(Promise<()>);
impl Ticket {
    pub(crate) fn downgrade(&self) -> WeakTicket {
        WeakTicket {
            manager: Arc::downgrade(&self.manager.0),
            id: self.id,
            lifetime: self._lifetime.downgrade(),
        }
    }
    pub(crate) fn ready_with_epoch(&self) -> (PermissionEpoch, Work<Lease>) {
        let pending = self.manager.0.state.lock().unwrap().tickets[&self.id]
            .permission
            .clone();
        let epoch = PermissionEpoch(pending.clone());
        let lease = Lease(self.clone());
        (
            epoch,
            Box::pin(async move {
                pending.work().await?;
                Ok(lease)
            }),
        )
    }
    pub(crate) fn is_current_permission(&self, epoch: &PermissionEpoch) -> bool {
        self.manager.0.state.lock().unwrap().tickets[&self.id]
            .permission
            .same(&epoch.0)
    }
    pub fn ready(&self) -> Work<Lease> {
        let pending = self.manager.0.state.lock().unwrap().tickets[&self.id]
            .permission
            .clone();
        let lease = Lease(self.clone());
        Box::pin(async move {
            pending.work().await?;
            Ok(lease)
        })
    }
    pub fn queued(&self) -> Work<()> {
        self.manager.0.state.lock().unwrap().tickets[&self.id]
            .queued
            .work()
    }
    pub fn status(&self) -> Value {
        self.manager.status(self.id)
    }
    pub fn cancel(&self, reason: Option<anyhow::Error>) {
        self.manager.cancel(
            self.id,
            reason.unwrap_or_else(|| anyhow!("Inference operation cancelled.")),
        );
    }
    pub fn pause_waiting(&self, unforwarded_grant: bool) -> bool {
        self.manager.pause_waiting(self.id, unforwarded_grant)
    }
    pub fn confirm_pause(&self) -> Work<()> {
        self.manager.confirm_pause(self.id)
    }
    pub fn resume_waiting(&self) -> Result<()> {
        self.manager.resume_waiting(self.id)
    }
    pub fn withdraw_unstarted(
        &self,
        reason: Option<anyhow::Error>,
        expected_revision: Option<u64>,
    ) -> Result<Work<Value>> {
        self.manager
            .withdraw_unstarted(
                self.id,
                reason.unwrap_or_else(|| anyhow!("Unstarted inference reservation withdrawn.")),
                false,
                expected_revision,
            )
            .map(|pending| pending.work())
    }
    pub fn unstarted_source(&self) -> Work<Value> {
        self.manager.unstarted_source(self.id)
    }
    pub fn private_task_goal_source(&self) -> Work<Value> {
        self.manager.private_task_goal_source(self.id)
    }
    pub fn withdraw_task_goal_before_allow(&self, reason: anyhow::Error) -> Result<Work<Value>> {
        self.manager
            .withdraw_task_goal_before_allow(self.id, reason)
            .map(|pending| pending.work())
    }
}
#[derive(Clone)]
pub struct Lease(pub(super) Ticket);
impl Lease {
    pub fn id(&self) -> JsString {
        self.0.manager.0.state.lock().unwrap().tickets[&self.0.id]
            .lease_id
            .clone()
    }
    pub fn signal(&self) -> Signal {
        self.0.manager.0.state.lock().unwrap().tickets[&self.0.id]
            .signal
            .clone()
    }
    pub fn task_goal_recovery(&self) -> Value {
        self.0.manager.0.state.lock().unwrap().tickets[&self.0.id]
            .task_goal_recovery
            .clone()
    }
    pub fn start(&self) -> Result<()> {
        self.0.manager.start(self.0.id)
    }
    pub fn bind_native(&self, execution: Value) -> Result<Work<()>> {
        self.0
            .manager
            .bind_native(self.0.id, execution)
            .map(|pending| pending.work())
    }
    pub fn suspend(&self) -> Result<()> {
        self.0.manager.suspend(self.0.id, false)
    }
    pub fn resume(&self) -> Work<()> {
        self.0.manager.resume(self.0.id).work()
    }
    pub fn settle(&self, outcome: Outcome) -> Result<()> {
        self.0.manager.settle(self.0.id, outcome)
    }
    pub fn settled(&self) -> Work<()> {
        self.0.manager.0.state.lock().unwrap().tickets[&self.0.id]
            .settlement
            .work()
    }
}
