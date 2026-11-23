//! Correlates worker admission with exact native turns and private Core gates.
//! UI publication/transport loss never establishes native execution settlement.
mod acquire;
mod execution;
mod lifecycle;
mod native;
mod preparation;
mod state;
mod task;
#[cfg(test)]
mod tests;
mod types;
mod withdrawal;
use crate::{
    inference::{
        admission::{
            AdmissionError, Complete, Failure, Lease, Lifetime, Manager, Outcome,
            PreparationContext, PreparationOwner, Promise, Request as WorkerRequest, Runtime,
            Source, Ticket, WeakLifetime, WeakSource, WeakTicket,
        },
        identity,
        withdrawal::Withdrawal,
    },
    metadata::{Abort, Signal},
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, coercion, value::json};
pub use execution::Execution;
use indexmap::{IndexMap, IndexSet};
pub use native::NativePause;
use state::*;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
pub use types::*;

pub use preparation::PreparationScope;
struct Inner {
    admission: Manager,
    runtime: Runtime,
    on_revoked: OnRevoked,
    state: Mutex<State>,
}
#[derive(Clone)]
pub struct Adapter(Arc<Inner>);
impl Adapter {
    pub fn new(admission: Manager, on_revoked: Option<OnRevoked>) -> Result<Self> {
        let runtime = admission.create_runtime()?;
        Ok(Self(Arc::new(Inner {
            admission,
            runtime,
            on_revoked: on_revoked.unwrap_or_else(|| Arc::new(|_| Ok(()))),
            state: Mutex::new(State::default()),
        })))
    }
    pub fn generation(&self) -> &JsString {
        self.0.runtime.generation()
    }
    pub fn prepare_native_launch(&self) -> Work<HashMap<String, String>> {
        self.0.runtime.prepare_native_launch()
    }
    fn active(&self) -> Vec<Arc<Operation>> {
        self.0
            .state
            .lock()
            .unwrap()
            .active
            .values()
            .map(|entry| entry.operation.clone())
            .collect()
    }
    fn find_native(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: &JsString,
    ) -> Option<Arc<Operation>> {
        self.active().into_iter().find(|operation| {
            let state = operation.state.lock().unwrap();
            !state.settled
                && state.thread.as_ref() == Some(thread)
                && state.turn.as_ref() == Some(turn)
                && state.native_scope.as_ref() == Some(scope)
        })
    }
    fn notify_revocation(&self, operation: &Arc<Operation>) -> Result<()> {
        let revoked = {
            let mut state = operation.state.lock().unwrap();
            if !state.revoked
                || state.revocation_notified
                || state.settled
                || state.thread.is_none()
                || state.turn.is_none()
                || !state.dispatched
            {
                return Ok(());
            }
            state.revocation_notified = true;
            Revoked {
                thread_id: state.thread.clone().unwrap(),
                turn_id: state.turn.clone().unwrap(),
                settled: operation.settlement.clone(),
            }
        };
        (self.0.on_revoked)(revoked)
    }
    fn settle(&self, operation: &Arc<Operation>, outcome: Outcome) -> Result<()> {
        self.settle_if(operation, outcome, |_| true)
    }

    fn settle_if(
        &self,
        operation: &Arc<Operation>,
        outcome: Outcome,
        when: impl FnOnce(&OperationState) -> bool,
    ) -> Result<()> {
        let lease = {
            let mut state = operation.state.lock().unwrap();
            if state.settled || !when(&state) {
                return Ok(());
            }
            state.settled = true;
            state.lease
        };
        if lease {
            let lease = operation.lease()?;
            lease.settle(outcome)?;
            let finished = operation.finish.clone();
            let settlement = self.0.admission.when_lease_settled(&lease);
            tokio::spawn(async move {
                finished.finish(settlement.await);
            });
        } else {
            operation
                .ticket()?
                .cancel(Some(anyhow!("Native execution settled before admission.")));
            operation.finish.finish(Ok(()));
        }
        self.0
            .state
            .lock()
            .unwrap()
            .active
            .shift_remove(&operation.id);
        Ok(())
    }
}
