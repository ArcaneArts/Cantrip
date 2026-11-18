use super::*;
pub(super) type Id = u64;
pub(super) type Effect = Box<dyn FnOnce(&Manager) + Send>;
pub(super) type Effects = Vec<Effect>;
pub(super) struct State {
    pub effects: std::collections::VecDeque<Effect>,
    pub dispatching: bool,
    pub pools: IndexMap<JsString, Pool>,
    pub runtimes: IndexMap<Id, RuntimeData>,
    pub tickets: HashMap<Id, TicketData>,
    pub listeners: IndexMap<Id, Observer>,
    pub next: Id,
    pub sequence: f64,
    pub revision: f64,
    pub catalog_revision: Option<f64>,
    pub catalog: IndexMap<JsString, f64>,
    pub notifying: bool,
    pub closing: bool,
    pub closure: Option<Promise<()>>,
    pub recovery_startup: Option<(Id, Promise<()>)>,
    pub recovery_initialized: bool,
    pub recovery_pending: IndexMap<String, JsString>,
    pub restored: IndexMap<String, Id>,
    pub waiters: IndexMap<Id, Restored>,
    pub goal_preparations: IndexMap<String, GoalPreparation>,
    pub recovery_work: Option<Promise<()>>,
    pub recovery_all: bool,
    pub recovery_chats: HashSet<JsString>,
    pub recovery_retry: Option<tokio::task::AbortHandle>,
    pub recovery_retry_ms: u64,
    pub unrequested_settlements: HashMap<String, Promise<()>>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            effects: std::collections::VecDeque::new(),
            dispatching: false,
            pools: IndexMap::new(),
            runtimes: IndexMap::new(),
            tickets: HashMap::new(),
            listeners: IndexMap::new(),
            next: 0,
            sequence: 0.,
            revision: 0.,
            catalog_revision: None,
            catalog: IndexMap::new(),
            notifying: false,
            closing: false,
            closure: None,
            recovery_startup: None,
            recovery_initialized: false,
            recovery_pending: IndexMap::new(),
            restored: IndexMap::new(),
            waiters: IndexMap::new(),
            goal_preparations: IndexMap::new(),
            recovery_work: None,
            recovery_all: false,
            recovery_chats: HashSet::new(),
            recovery_retry: None,
            recovery_retry_ms: 1000,
            unrequested_settlements: HashMap::new(),
        }
    }
}
impl State {
    pub fn id(&mut self) -> Id {
        self.next += 1;
        self.next
    }
    pub fn prune(&mut self) {
        self.tickets.retain(|_, ticket| {
            ticket.phase != Phase::Released
                || ticket.lifetime.strong_count() > 0
                || ticket.work != 0
        });
    }
}
pub(super) struct Pool {
    pub configuration: Value,
    pub disabled: bool,
    pub creation_known: bool,
    pub configuration_known: bool,
    pub replacing: bool,
    pub active: IndexSet<Id>,
    pub suspended: IndexSet<Id>,
    pub queue: Vec<Id>,
}
pub(super) struct RuntimeData {
    pub generation: JsString,
    pub records: IndexMap<JsString, (Id, Lifetime)>,
    pub retired: bool,
    pub prepared: bool,
    pub direct_owner: Option<DirectOwner>,
    pub retiring: Option<Promise<()>>,
}
#[derive(Clone)]
pub(super) struct DirectOwner {
    pub cancel: Arc<dyn Fn(anyhow::Error) + Send + Sync>,
    pub settled: Promise<()>,
}
pub(super) struct TicketData {
    pub work: usize,
    pub runtime: Id,
    pub generation: JsString,
    pub lease_id: JsString,
    pub lifetime: Weak<LifetimeInner>,
    pub input: Input,
    pub permission: Promise<()>,
    pub resolve: Complete<()>,
    pub queued: Promise<()>,
    pub resolve_queued: Complete<()>,
    pub permission_granted: bool,
    pub parked_grant: bool,
    pub pause_receipt: Option<Promise<Value>>,
    pub pause_receipt_revision: i64,
    pub task_goal_recovery: Value,
    pub sequence: f64,
    pub restored_order: Option<f64>,
    pub recovery_pending: bool,
    pub phase: Phase,
    pub state_since: f64,
    pub timing: [f64; 4],
    pub abort: Arc<Abort>,
    pub signal: Signal,
    pub enqueued_at: f64,
    pub granted_at: Option<f64>,
    pub started_at: Option<f64>,
    pub resuming: Option<Promise<()>>,
    pub parked_waiting: bool,
    pub queue_revision: u64,
    pub journal_enqueued: Option<Promise<Value>>,
    pub journal_requeue: Option<Promise<bool>>,
    pub journal_key: Option<String>,
    pub durable_queue_ready: bool,
    pub native_execution: Option<Value>,
    pub native_binding: Option<Promise<()>>,
    pub release_receipt: Option<Promise<Value>>,
    pub withdrawal: Option<Promise<Value>>,
    pub external_work: IndexMap<Id, Promise<()>>,
    pub pending_settlement: Option<Outcome>,
    pub settlement: Promise<()>,
    pub resolve_settlement: Complete<()>,
    pub cancellation_listener: Option<tokio::task::AbortHandle>,
}
pub(super) struct Restored {
    pub record: Value,
    pub records: Vec<Value>,
    pub task_input: HashSet<JsString>,
    pub goal_input: HashSet<JsString>,
    pub task_goal: HashSet<JsString>,
    pub enqueued_at: f64,
    pub claimed: Option<Id>,
    pub goal_recovery: Option<Value>,
    pub task_goal_recovery: Option<Value>,
}
pub(super) struct GoalPreparation {
    pub id: Id,
    pub chat: JsString,
    pub provider: JsString,
    pub recovery: Value,
    pub preparing: bool,
    pub unavailable: bool,
}
#[derive(Clone)]
pub(super) struct QueueEntry {
    pub ticket: Option<Id>,
    pub waiter: Option<Id>,
    pub order: f64,
    pub sequence: f64,
}
