//! Durable queued inputs and pending worktree transitions. Task continuation
//! and native account preparation are required collaborators, never defaults.
pub mod outcomes;
mod queue;
pub mod scheduler;
pub mod task_services;
mod transitions;
use super::{
    Repository,
    execution_lanes::LaneRepository,
    live_mutations::Service as Live,
    managed_console::ManagedConsole,
    routing::ModelRouting,
    turn_runtime::{bootstrap::PreparedTurn, engine::Continuation, stages::Operations},
};
use crate::{
    database::Database,
    native_commands::{managed_queue::QueueRepository, queued_prompt::PromptRepository},
    operations::logging::{self, LogCall, Logger},
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

pub type Begin =
    Arc<dyn Fn(String, Value, Value, Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
pub type PrepareAccount =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
pub trait TaskTransitions: Send + Sync {
    fn recover(&self, owner: String, chat: String) -> BoxFuture<'static, Result<bool>>;
    fn continue_goal(
        &self,
        owner: String,
        context: Value,
        input: Value,
    ) -> BoxFuture<'static, Result<bool>>;
    fn reconcile(&self, owner: String) -> BoxFuture<'static, Result<()>>;
}
pub struct Dependencies {
    pub database: Arc<Database>,
    pub live: Arc<Live>,
    pub commands: Arc<LimitedCommandBus>,
    pub routing: Arc<ModelRouting>,
    pub console: Arc<ManagedConsole>,
    pub begin: Begin,
    pub prepare_account: PrepareAccount,
    pub tasks: Arc<dyn TaskTransitions>,
    pub outcomes: Arc<scheduler::Scheduler>,
    pub logger: Logger,
}
#[derive(Default)]
struct State {
    dispatching: HashSet<String>,
    pending: HashSet<String>,
    transitions: HashSet<String>,
}
#[derive(Clone)]
pub struct Service {
    dependencies: Arc<Dependencies>,
    chats: Repository,
    lanes: LaneRepository,
    prompts: PromptRepository,
    queue: QueueRepository,
    operations: Arc<Operations>,
    state: Arc<Mutex<State>>,
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Recovery identity")?
        .lossy()
        .into_owned())
}
fn executing(context: &Value) -> bool {
    matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    )
}
fn object() -> Value {
    Value::object([] as [(&str, Value); 0])
}
fn copy_fields(target: &mut Value, source: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = source.get(key) {
            target[*key] = value.clone();
        }
    }
}
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        Arc::new(Self::from_dependencies(dependencies))
    }
    pub fn new_cyclic(build: impl FnOnce(&std::sync::Weak<Self>) -> Dependencies) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self::from_dependencies(build(weak)))
    }
    fn from_dependencies(dependencies: Dependencies) -> Self {
        let database = dependencies.database.clone();
        Self {
            dependencies: Arc::new(dependencies),
            chats: Repository::new(database.clone()),
            lanes: LaneRepository::new(database.clone()),
            prompts: PromptRepository::new(database.clone()),
            queue: QueueRepository::new(database),
            operations: Arc::default(),
            state: Arc::default(),
        }
    }
    fn log(&self, level: &'static str, message: &'static str, context: Value) {
        (self.dependencies.logger)(LogCall::event(level, message, context));
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
}
impl Continuation for Service {
    fn cancel_outcome_recovery(&self, turn: &PreparedTurn) {
        self.dependencies.outcomes.settle(&scheduler::key(
            &turn.execution["workerId"],
            &turn.execution["chatId"],
            &turn.user_message["id"],
        ));
    }
    fn continue_worktree(&self, turn: Arc<PreparedTurn>) -> BoxFuture<'static, Result<bool>> {
        match text(&turn.execution["chatId"]) {
            Ok(chat) => self.continue_worktree_transition(&turn.owner, &chat),
            Err(error) => async move { Err(error) }.boxed(),
        }
    }
    fn dispatch_queue(&self, turn: Arc<PreparedTurn>) -> BoxFuture<'static, Result<()>> {
        match text(&turn.execution["chatId"]) {
            Ok(chat) => self.dispatch(&turn.owner, &chat),
            Err(error) => async move { Err(error) }.boxed(),
        }
    }
}
