//! Recover retained native Task sessions through the actual Goal service and
//! durable placement/lease repositories. Recovery never creates a new objective.
mod flight;
mod run;
use super::{Repository, execution_lanes::LaneRepository, goals, turn_runtime::stages::Operations};
use crate::{
    database::Database,
    projects::targets::TargetRepository,
    task_dispatch, tasks,
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
pub type Unpause = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type Publish = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;
pub type Report = Arc<dyn Fn(String, String, Arc<anyhow::Error>) + Send + Sync>;
pub struct Dependencies {
    pub database: Arc<Database>,
    pub commands: Arc<LimitedCommandBus>,
    pub goals: Arc<goals::Service>,
    pub lease_owner: String,
    pub publish: Publish,
    pub unpause: Unpause,
    pub report: Report,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
type Key = (String, String);
type Outcome = std::result::Result<bool, Arc<anyhow::Error>>;
type Operation = Shared<BoxFuture<'static, Outcome>>;
#[derive(Clone)]
struct Flight {
    operation: Operation,
    resume: bool,
    automatic: bool,
}
#[derive(Default)]
struct State {
    recovering: HashMap<Key, Flight>,
    observed_at: HashMap<Key, i64>,
}
#[derive(Clone)]
pub struct Service {
    dependencies: Arc<Dependencies>,
    chats: Repository,
    tasks: tasks::Repository,
    dispatch: task_dispatch::Repository,
    lanes: LaneRepository,
    targets: Arc<TargetRepository>,
    state: Arc<Mutex<State>>,
    operations: Arc<Operations>,
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Task recovery identity")?
        .lossy()
        .into_owned())
}
fn same_placement(a: &Value, b: &Value) -> bool {
    ["threadId", "worktreeId", "workerId"]
        .iter()
        .all(|key| a.get(key) == b.get(key))
}
fn unchanged(a: &Value, b: &Value, project: bool) -> bool {
    (!project || a["contextKind"] == "project")
        && same_placement(a, b)
        && a.get("automationPaused") == b.get("automationPaused")
}
fn unpaused(a: &Value, b: &Value, project: bool) -> bool {
    (!project || a["contextKind"] == "project")
        && same_placement(a, b)
        && !truthy(a.get("automationPaused"))
}
const CHANGED: &str = "The Task changed during recovery. Please retry.";
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let db = dependencies.database.clone();
        Arc::new(Self {
            chats: Repository::new(db.clone()),
            tasks: tasks::Repository::new(db.clone()),
            dispatch: task_dispatch::Repository::new(db.clone()),
            lanes: LaneRepository::new(db.clone()),
            targets: Arc::new(TargetRepository::new(db)),
            dependencies: Arc::new(dependencies),
            state: Arc::default(),
            operations: Arc::default(),
        })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
    pub fn reconcile(&self, owner: &str) -> BoxFuture<'static, Result<()>> {
        let (this, owner) = (self.clone(), owner.to_owned());
        self.operations.run(async move {
            for cycle in this
                .dispatch
                .list(&owner)
                .await?
                .as_array()
                .context("Task dispatch cycles")?
            {
                if cycle["operationKind"] != "finalize"
                    || !matches!(
                        cycle["state"].as_str(),
                        Some("running" | "expired" | "failed")
                    )
                    || !truthy(cycle.get("codexThreadId"))
                {
                    continue;
                }
                let chat = text(&cycle["chatId"])?;
                let at = this
                    .state
                    .lock()
                    .unwrap()
                    .observed_at
                    .get(&(owner.clone(), chat.clone()))
                    .copied()
                    .unwrap_or(0);
                if (this.dependencies.clock)() - at < 30_000 {
                    continue;
                }
                if let Err(error) = this.recover(&owner, &chat, false, false).await {
                    (this.dependencies.report)(owner.clone(), chat, Arc::new(error));
                }
            }
            Ok(())
        })
    }
}
impl super::recovery::TaskTransitions for Service {
    fn recover(&self, owner: String, chat: String) -> BoxFuture<'static, Result<bool>> {
        Service::recover(self, &owner, &chat, false, false)
    }
    fn continue_goal(
        &self,
        owner: String,
        context: Value,
        input: Value,
    ) -> BoxFuture<'static, Result<bool>> {
        self.dependencies
            .goals
            .continue_worktree(&owner, &context, &input, None)
    }
    fn reconcile(&self, owner: String) -> BoxFuture<'static, Result<()>> {
        Service::reconcile(self, &owner)
    }
}
