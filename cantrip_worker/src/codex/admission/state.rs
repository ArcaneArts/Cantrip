use super::*;
pub(super) struct Operation {
    pub id: u64,
    pub input: Input,
    pub ticket: WeakTicket,
    pub state: Mutex<OperationState>,
    pub settlement: Promise<()>,
    pub finish: Complete<()>,
}
#[derive(Default)]
pub(super) struct OperationState {
    pub thread: Option<JsString>,
    pub turn: Option<JsString>,
    pub dispatched: bool,
    pub input_dispatching: bool,
    pub lease_started: bool,
    pub starting: bool,
    pub transferring: bool,
    pub preparing: bool,
    pub preparation_ended: Option<Complete<()>>,
    pub observed_start: bool,
    pub native_boundary: bool,
    pub initial_native_paused: bool,
    pub native_scope: Option<JsString>,
    pub task_goal_cycle: Option<Value>,
    pub task_input: Option<Value>,
    pub queued: bool,
    pub rejected_input: bool,
    pub native_failed_before_output: bool,
    pub settled: bool,
    pub revoked: bool,
    pub revocation_notified: bool,
    pub lease: bool,
    pub withdrawal: Option<Promise<Value>>,
    pub withdrawal_reason: Option<Withdrawal>,
}
impl Operation {
    pub fn ticket(&self) -> Result<Ticket> {
        self.ticket
            .upgrade()
            .ok_or_else(|| anyhow!("The native inference owner is no longer retained."))
    }
    pub fn lease(&self) -> Result<Lease> {
        if !self.state.lock().unwrap().lease {
            bail!("Native inference has no running grant.");
        }
        self.ticket
            .lease()
            .ok_or_else(|| anyhow!("The native inference owner is no longer retained."))
    }
}
pub(super) struct Active {
    pub operation: Arc<Operation>,
    pub _ticket: Ticket,
}
pub(super) struct Memo {
    pub lifetime: WeakLifetime,
    pub identity: String,
    pub result: Promise<()>,
    pub operation: Option<Arc<Operation>>,
}
pub(super) struct SourceLifetime {
    pub source: WeakSource,
    pub lifetime: Lifetime,
    pub watcher: tokio::task::AbortHandle,
}
impl Drop for SourceLifetime {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}
pub(super) struct BeforeAcquire {
    pub id: u64,
    pub request: Acquire,
    pub abort: Abort,
    pub finished: Promise<()>,
    pub reason: Mutex<Option<Failure>>,
    pub withdrawal: Mutex<Option<Promise<Value>>>,
}
pub(super) struct NativeEntry {
    pub independent: bool,
    pub gate: JsString,
    pub runner_generation: Option<JsString>,
    pub expected_goal: Option<JsString>,
    pub result: Promise<()>,
    pub state: Mutex<NativeState>,
}
pub(super) struct NativeState {
    pub confirmed: bool,
    pub goal: Option<(JsString, bool)>,
    pub lifetime: Option<Lifetime>,
    pub operation: Option<Arc<Operation>>,
}
#[derive(Default)]
pub(super) struct State {
    pub next: u64,
    pub paused: HashSet<JsString>,
    pub active: IndexMap<u64, Active>,
    pub completed: IndexSet<String>,
    pub native: IndexMap<String, Arc<NativeEntry>>,
    pub requests: Vec<Memo>,
    pub sources: Vec<SourceLifetime>,
    pub before: Vec<Arc<BeforeAcquire>>,
    pub exited: bool,
    pub retirement: Option<Promise<()>>,
}
impl State {
    pub fn id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }
    pub fn prune(&mut self) {
        self.requests.retain(|memo| memo.lifetime.alive());
        self.sources.retain(|entry| entry.source.alive());
    }
    pub fn operation_for(&self, life: &Lifetime) -> Option<Arc<Operation>> {
        self.requests
            .iter()
            .find(|memo| memo.lifetime.matches(life))
            .and_then(|memo| memo.operation.clone())
    }
}
