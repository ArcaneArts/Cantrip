//! One shared admission owner per worker/server/owner, across native and HTTP
//! execution. Observations and cancellation never imply physical settlement.
mod configuration;
mod direct;
mod flight;
mod handles;
mod parking;
mod preparation;
mod recovery;
mod runtime;
mod state;
mod status;
#[cfg(test)]
mod tests;
mod tickets;
mod transitions;
mod types;
mod withdrawal;
use super::{
    identity,
    journal::{AdoptOptions, Journal},
};
use crate::metadata::{Abort, Signal};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, coercion, value::json};
pub use direct::{DirectRequest, Source};
use flight::Complete;
pub use flight::{Failure, Promise};
use handles::LifetimeInner;
pub use handles::{Lease, Lifetime, Runtime, Ticket};
use indexmap::{IndexMap, IndexSet};
pub use preparation::{PreparationContext, PreparationOwner};
pub use recovery::GoalPreparationHandle;
use state::*;
pub use status::Subscription;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
pub use types::*;
struct Inner {
    state: Mutex<State>,
    options: Options,
    journal: Option<Journal>,
    recovery_abort: Abort,
    recovery_signal: Signal,
}
#[derive(Clone)]
pub struct Manager(Arc<Inner>);
impl Manager {
    pub fn new(options: Options) -> Self {
        let journal = options.ownership.as_ref().map(|owner| {
            let owner = owner.clone();
            Journal::new(
                options.scope.worker_generation.clone(),
                Arc::new(move |command| owner.journal(command)),
            )
        });
        let (recovery_abort, recovery_signal) = Abort::new();
        let this = Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            options,
            journal,
            recovery_abort,
            recovery_signal,
        }));
        if let Some(owner) = &this.0.options.ownership {
            let weak = Arc::downgrade(&this.0);
            owner.on_lost(Arc::new(move || {
                if let Some(owner) = weak.upgrade() {
                    let manager = Manager(owner);
                    let runtimes = manager
                        .0
                        .state
                        .lock()
                        .unwrap()
                        .runtimes
                        .keys()
                        .copied()
                        .collect::<Vec<_>>();
                    for runtime in runtimes {
                        drop(manager.retire(runtime));
                    }
                }
                Ok(())
            }));
        }
        this
    }
    fn edit<T>(&self, action: impl FnOnce(&mut State, &mut Effects) -> Result<T>) -> Result<T> {
        let (result, dispatch) = {
            let mut state = self.0.state.lock().unwrap();
            state.prune();
            let mut effects = Vec::new();
            let result = action(&mut state, &mut effects);
            state.prune();
            state.effects.extend(effects);
            let dispatch = !state.dispatching;
            state.dispatching = true;
            (result, dispatch)
        };
        if dispatch {
            loop {
                let effect = {
                    let mut state = self.0.state.lock().unwrap();
                    match state.effects.pop_front() {
                        Some(effect) => effect,
                        None => {
                            state.dispatching = false;
                            break;
                        }
                    }
                };
                effect(self);
            }
        }
        result
    }
    fn observer_error(&self, error: anyhow::Error) {
        let _ = (self.0.options.observer_error)(Failure::new(error));
    }
    fn journal_error(&self, error: anyhow::Error) {
        let _ = (self.0.options.journal_error)(Failure::new(error));
    }
    fn native_available(&self) -> bool {
        self.0
            .options
            .ownership
            .as_ref()
            .is_none_or(|owner| owner.available())
    }
    fn wall(&self) -> f64 {
        (self.0.options.clock.wall)()
    }
    fn now(&self) -> f64 {
        (self.0.options.clock.monotonic)()
    }
    fn ticket_task<T: Clone + Send + Sync + 'static>(
        &self,
        state: &mut State,
        effects: &mut Effects,
        id: Id,
        operation: impl FnOnce(Manager) -> Work<T> + Send + 'static,
    ) -> Promise<T> {
        state.tickets.get_mut(&id).unwrap().work += 1;
        let (complete, pending) = Promise::pair();
        effects.push(Box::new(move |manager| {
            let manager = manager.clone();
            // Start accepted IO in state-transition order, outside the mutex.
            // Scheduling each prefix independently could reorder durable FIFO.
            let operation = cantrip_transport::lifecycle::owned(operation(manager.clone()));
            tokio::spawn(async move {
                let result = operation.await;
                complete.finish(result);
                let mut state = manager.0.state.lock().unwrap();
                if let Some(ticket) = state.tickets.get_mut(&id) {
                    ticket.work -= 1;
                }
                state.prune();
            });
        }));
        pending
    }
    pub fn recovery_snapshot(&self) -> Vec<Value> {
        self.0
            .journal
            .as_ref()
            .map_or_else(Vec::new, Journal::recovery_snapshot)
    }
    pub fn when_lease_settled(&self, lease: &Lease) -> Work<()> {
        if !Arc::ptr_eq(&self.0, &lease.0.manager.0) {
            return Promise::ready(Err(anyhow!(
                "The lease belongs to another admission service."
            )))
            .work();
        }
        lease.settled()
    }
    pub fn confirm_native_ownership(&self) -> Work<()> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let journal = this
                .0
                .journal
                .as_ref()
                .ok_or_else(|| anyhow!("Native inference ownership is unavailable."))?;
            this.prepare_recovery().work().await?;
            journal.snapshot().await?;
            Ok(())
        })
    }
}
