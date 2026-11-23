use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

/// The canonical first input holds a real root producer lease before marking
/// dispatch. A private begin parked for this input never mints another ticket.
#[derive(Clone, Default)]
pub struct FirstInput(Arc<AtomicBool>);
impl FirstInput {
    pub fn set_dispatching(&self, value: bool) {
        self.0.store(value, Ordering::Release);
    }

    pub(super) fn dispatching(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Debug)]
pub(super) struct FirstInputDispatch;
impl std::fmt::Display for FirstInputDispatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The first Task Goal input owns native dispatch.")
    }
}
impl std::error::Error for FirstInputDispatch {}

#[derive(Clone)]
pub struct Pending(Arc<Entry>);
struct Entry {
    gate: Gate,
    abort: Abort,
    signal: Signal,
    denied: Promise<()>,
    confirm_denial: Complete<()>,
    first_input: Option<FirstInput>,
}
impl Pending {
    pub(super) fn new(gate: Gate, first_input: Option<FirstInput>) -> Self {
        let (abort, signal) = Abort::new();
        let (confirm_denial, denied) = Promise::pair();
        Self(Arc::new(Entry {
            gate,
            abort,
            signal,
            denied,
            confirm_denial,
            first_input,
        }))
    }
    pub fn gate(&self) -> &Gate {
        &self.0.gate
    }
    pub fn first_input(&self) -> Option<&FirstInput> {
        self.0.first_input.as_ref()
    }
    pub fn signal(&self) -> Signal {
        self.0.signal.clone()
    }
    pub fn denied(&self) -> Work<()> {
        self.0.denied.work()
    }
    pub(super) fn deny(&self, result: Result<()>) {
        self.0.confirm_denial.finish(result);
    }
    pub(super) fn abort(&self, error: anyhow::Error) {
        self.0.abort.abort(error);
    }
    pub(super) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub(super) fn matches(&self, key: &Key, scope: &JsString) -> bool {
        let gate = self.gate();
        gate.key.thread_id == key.thread_id
            && gate.key.turn_id == key.turn_id
            && gate.key.runner_generation == key.runner_generation
            && &gate.scope_id == scope
    }
}
