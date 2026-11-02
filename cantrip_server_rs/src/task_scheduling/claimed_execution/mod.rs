//! Execute fenced Task claims through the actual turn runtime and durable
//! encrypted-operation writers. Scheduler wakeup is an explicit collaborator.
mod completion;
mod lease;
mod run;
mod stage;
use super::*;
use crate::{
    chats::{
        Repository as Chats,
        execution_lanes::LaneError,
        goals::{self, GoalOptions},
        live_mutations::{MessageOptions, Service as Live},
        message_queries::MessageKind,
        routing::ModelRouting,
        turn_runtime::{
            engine::{Completion, Hooks, Runtime, Structured},
            stages::{Clock, Operations, TaskLaunchStageTimeout},
        },
    },
    operations::{
        logging::{self, LogCall, Logger},
        shared_failure::downcast_ref,
    },
    task_dispatch, tasks,
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use futures::{FutureExt, future::BoxFuture};
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Clone)]
pub struct Limits {
    pub preflight_timeout_ms: f64,
    pub slow_warning_ms: Option<f64>,
    pub heartbeat_interval_ms: f64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            preflight_timeout_ms: 30_000.0,
            slow_warning_ms: Some(5_000.0),
            heartbeat_interval_ms: (task_dispatch::LEASE_MS / 3) as f64,
        }
    }
}
pub struct Dependencies {
    pub database: Arc<Database>,
    pub runtime: Arc<Runtime>,
    pub goals: Arc<goals::Service>,
    pub routing: Arc<ModelRouting>,
    pub commands: Arc<LimitedCommandBus>,
    pub live: Arc<Live>,
    pub logger: Logger,
    pub clock: Clock,
    pub queue_tick: Arc<dyn Fn() + Send + Sync>,
    pub limits: Limits,
}
pub struct Service {
    dependencies: Dependencies,
    chats: Chats,
    tasks: tasks::Repository,
    retries: tasks::retries::Repository,
    dispatch: task_dispatch::Repository,
    operations: Arc<Operations>,
}
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let db = dependencies.database.clone();
        Arc::new(Self {
            chats: Chats::new(db.clone()),
            tasks: tasks::Repository::new(db.clone()),
            retries: tasks::retries::Repository::new(db.clone()),
            dispatch: task_dispatch::Repository::new(db),
            dependencies,
            operations: Arc::default(),
        })
    }
    pub fn run(
        self: &Arc<Self>,
        owner: &str,
        claim: &Value,
        prepared_runtime: Option<&Value>,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, claim, runtime) = (
            self.clone(),
            owner.to_owned(),
            claim.clone(),
            prepared_runtime.cloned(),
        );
        self.operations
            .run(async move { this.run_one(&owner, &claim, runtime).await })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.dependencies.runtime.drained().await;
        // Runtime hooks may have admitted settlement after an earlier launcher
        // timeout. Keep that work owned until it reaches its durable boundary.
        self.operations.drained().await;
        self.dependencies.live.drained().await;
    }
    fn tick(&self) {
        (self.dependencies.queue_tick)();
    }
    fn publish(&self, owner: &str, chat: &str, context: Option<&Value>) {
        self.dependencies
            .live
            .publish_invalidation(owner, chat, "task", context);
    }
    fn log(&self, level: &'static str, message: &'static str, context: Value) {
        (self.dependencies.logger)(LogCall::event(level, message, context));
    }
    pub fn finish_failure(
        self: &Arc<Self>,
        owner: &str,
        claim: &Value,
        failure: Option<Arc<anyhow::Error>>,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, claim) = (self.clone(), owner.to_owned(), claim.clone());
        self.operations.run(async move {
            this.finish_failure_one(&owner, &claim, failure.as_deref())
                .await
        })
    }
    async fn finish_failure_one(
        &self,
        owner: &str,
        claim: &Value,
        failure: Option<&anyhow::Error>,
    ) -> Result<()> {
        let (chat, operation) = (
            text(&claim["cycle"]["chatId"])?,
            text(&claim["cycle"]["operationId"])?,
        );
        let mut cleanup_error = None;
        let result:Result<()>=async {
            self.dispatch.heartbeat(&claim["lease"],&Value::Null).await?;
            let mut completed=false;
            let persist:Result<()>=async {
                let operation_context=self.tasks.get_operation_context(owner,&chat,&json!({"operationId":operation})).await?;
                completed=operation_context.as_ref().is_some_and(|v|truthy(v.get("relayResult")));
                if operation_context.is_some() && !completed { self.tasks.fail_operation(owner,&chat,&operation,None).await?; }
                Ok(())
            }.await;
            if let Err(error)=persist {
                self.log("error","Could not persist the failed Task operation",json!({"event":"task.operation.failure-persistence-failed","subsystem":"task-scheduler","operation":"settle-failed-operation","status":"failed","chatId":chat,"cycleId":claim["cycle"]["id"],"err":stage::error_details(&error)}));
                cleanup_error=Some(error);
            }
            self.dispatch.settle(&claim["lease"],if completed {"succeeded"}else{"failed"},&Value::Null).await?;
            if !completed {
                self.retries.note_failure(owner,&chat,&format!("dispatch:{}:{}",text(&claim["cycle"]["id"])?,claim["lease"]["fencingToken"].stringify()),failure.map_or("runtime",tasks::failure_kind::for_error),None).await?;
            }
            self.publish(owner,&chat,Some(&json!({"experience":"task","projectId":claim["projectId"]})));
            Ok(())
        }.await;
        if let Err(error) = result
            && downcast_ref::<task_dispatch::Conflict>(&error).is_none()
            && cleanup_error.is_none()
        {
            cleanup_error = Some(error);
        }
        self.tick();
        match cleanup_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
