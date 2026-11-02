//! Interactive and scheduled Goal execution. Task bodies remain opaque; the
//! existing worker observes, activates and protects their actual objectives.
mod automation;
mod continuation;
mod leases;
mod observe;
mod start;
mod synchronize;
use super::{
    Repository, RuntimeUpdate,
    execution_lanes::LaneRepository,
    live_mutations::{MessageOptions, Service as Live},
    managed_console::{self, ManagedConsole},
    message_queries::MessageKind,
    protect_input::InputProtection,
    routing::ModelRouting,
    turn_runtime::{engine::Hooks, stages::Operations},
};
use crate::{
    database::Database,
    operations::logging::{self, LogCall, Logger},
    task_dispatch,
    tasks::{self, retries::Repository as Retries},
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
pub use leases::{dispatch_cycle_lease, goal_dispatch_lease};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
pub const RESUME_PROMPT: &str = "Continue working toward the active goal. Reassess progress, make the next useful scoped change, validate it, and update the goal status when it is complete or genuinely blocked.";
pub type Begin = Arc<
    dyn Fn(String, Value, Value, Value, Hooks) -> BoxFuture<'static, Result<Value>> + Send + Sync,
>;
pub type Pending = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<bool>> + Send + Sync>;
pub type Queue = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type Before = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub struct Dependencies {
    pub database: Arc<Database>,
    pub commands: Arc<LimitedCommandBus>,
    pub routing: Arc<ModelRouting>,
    pub console: Arc<ManagedConsole>,
    pub live: Arc<Live>,
    pub begin: Begin,
    pub pending: Pending,
    pub queue: Queue,
    pub queue_tick: Arc<dyn Fn() + Send + Sync>,
    pub logger: Logger,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
#[derive(Default)]
pub struct GoalOptions {
    pub hooks: Hooks,
    pub before: Option<Before>,
    pub model_configuration: Option<Value>,
    pub runtimes: Option<Vec<Value>>,
    pub dispatch_lease: Option<Value>,
    pub user_message: Option<Value>,
    pub worker_prompt: Option<Value>,
    pub purpose: Option<Value>,
    pub message_role: Option<Value>,
}
#[derive(Default, Clone)]
pub struct Observation {
    pub message: Option<Value>,
    pub observe_execution: bool,
    pub activate: bool,
    pub runtime_failure: Option<Value>,
    pub observation_only: bool,
}
#[derive(Debug)]
pub struct LaunchError {
    pub failure_task: Value,
}
impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            &self.failure_task["classification"]["lastError"]
                .get("code")
                .and_then(Value::as_js_string)
                .map(|s| s.lossy())
                .unwrap_or_else(|| "Task Goal startup failed.".into()),
        )
    }
}
impl std::error::Error for LaunchError {}
struct Retained {
    lease: Value,
    timer: tokio::task::JoinHandle<()>,
}
#[derive(Default)]
struct LeaseState {
    closing: bool,
    retained: HashMap<JsString, Retained>,
}
pub struct Service {
    dependencies: Dependencies,
    chats: Repository,
    tasks: tasks::Repository,
    dispatch: task_dispatch::Repository,
    retries: Retries,
    lanes: LaneRepository,
    protection: InputProtection,
    operations: Arc<Operations>,
    leases: Mutex<LeaseState>,
    continuation_owner: String,
}
pub(super) fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Goal identity")?
        .lossy()
        .into_owned())
}
pub(super) fn parse(name: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(name, Some(value))
}
pub(super) fn object() -> Value {
    Value::object([] as [(&str, Value); 0])
}
pub(super) fn selected(value: Option<&Value>, fallback: &Value) -> Value {
    value.filter(|v| !v.is_null()).unwrap_or(fallback).clone()
}
pub(super) fn executing(context: &Value) -> bool {
    matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    )
}
fn concat(parts: &[&Value]) -> Value {
    let mut units = Vec::new();
    for part in parts {
        units.extend_from_slice(
            crate::wire::coercion::string(part)
                .expect("Goal string interpolation")
                .units(),
        );
    }
    Value::String(JsString::new(units))
}
pub fn content_from_summary(task: &Value) -> Value {
    let mut classification = object();
    for key in [
        "state",
        "stableStateBeforeFailure",
        "activeOperationKind",
        "planAuthorship",
        "planningRound",
        "hasPlan",
        "hasQuestions",
        "hasFinalPlan",
        "hasGoalPrompt",
        "lastError",
    ] {
        classification[key] = task[key].clone();
    }
    json!({"classification":classification,"protectedContent":task["protectedContent"]})
}
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let database = dependencies.database.clone();
        let commands = dependencies.commands.clone();
        Arc::new(Self {
            chats: Repository::new(database.clone()),
            tasks: tasks::Repository::new(database.clone()),
            dispatch: task_dispatch::Repository::new(database.clone()),
            retries: Retries::new(database.clone()),
            lanes: LaneRepository::new(database),
            protection: InputProtection::new(commands),
            dependencies,
            operations: Arc::default(),
            leases: Mutex::default(),
            continuation_owner: format!("task-goal-continuation:{}", uuid::Uuid::new_v4()),
        })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
    fn log(&self, level: &'static str, message: &'static str, fields: Value) {
        (self.dependencies.logger)(LogCall::event(level, message, fields));
    }
    fn publish(&self, owner: &str, chat: &str, resource: &'static str, context: Option<&Value>) {
        self.dependencies
            .live
            .publish_invalidation(owner, chat, resource, context);
    }
    async fn request(&self, worker: &Value, command: Value, schema: &str) -> Result<Value> {
        let response = self
            .dependencies
            .commands
            .request_with_timeout(&text(worker)?, command, RequestTimeout::Default, None)
            .await?;
        crate::settings::parse_response(schema, response.as_ref())
    }
    async fn update_runtime(&self, context: &Value, runtime: &Value, thread: &Value) -> Result<()> {
        self.chats
            .update_runtime(RuntimeUpdate {
                chat: text(&context["chatId"])?,
                worker: text(&context["workerId"])?,
                worktree: context["worktreeId"]
                    .as_js_string()
                    .map(|s| s.lossy().into_owned()),
                thread: thread.as_js_string().map(|s| s.lossy().into_owned()),
                route: text(&runtime["routeId"])?,
                status: "ready".into(),
                provider_account: Some(
                    runtime["provider"]["accountId"]
                        .as_js_string()
                        .map(|s| s.lossy().into_owned()),
                ),
                scratch_root: context["scratchRootId"]
                    .as_js_string()
                    .map(|s| s.lossy().into_owned()),
            })
            .await
    }
}
