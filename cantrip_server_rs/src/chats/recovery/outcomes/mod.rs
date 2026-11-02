//! Durable worker outcomes use the same lane, Task and protected history
//! boundaries as the live turn. An admitted recovery outlives its caller.
mod apply;
mod finish;
use crate::{
    chats::{
        Repository,
        execution_lanes::LaneRepository,
        goals,
        live_mutations::{MessageOptions, Service as Live},
        message_queries::MessageKind,
        turn_runtime::{events::identifier, stages::Operations},
    },
    database::Database,
    native_commands,
    operations::{
        logging::{self, LogCall, Logger},
        shared_failure::downcast_ref,
    },
    task_dispatch, tasks,
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use std::sync::Arc;

pub struct Dependencies {
    pub database: Arc<Database>,
    pub live: Arc<Live>,
    pub commands: Arc<LimitedCommandBus>,
    pub goals: Arc<goals::Service>,
    pub continuation: Arc<super::Service>,
    pub queue_tick: crate::task_scheduling::scheduler::Wakeup,
    pub logger: Logger,
}
pub struct Service {
    dependencies: Dependencies,
    chats: Repository,
    lanes: LaneRepository,
    native: native_commands::Repository,
    tasks: tasks::Repository,
    dispatch: task_dispatch::Repository,
    operations: Arc<Operations>,
}
#[derive(Clone, Copy)]
struct Recovery<'a> {
    owner: &'a str,
    worker: &'a str,
    n: &'a Value,
    context: &'a Value,
    logical: Option<&'a Value>,
    operation: Option<&'a Value>,
    fence: Option<&'a Value>,
}
fn text(value: &Value) -> Result<&str> {
    value.as_str().context("Recovered outcome identity")
}
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let database = dependencies.database.clone();
        Arc::new(Self {
            chats: Repository::new(database.clone()),
            lanes: LaneRepository::new(database.clone()),
            native: native_commands::Repository::new(database.clone()),
            tasks: tasks::Repository::new(database.clone()),
            dispatch: task_dispatch::Repository::new(database),
            dependencies,
            operations: Arc::default(),
        })
    }
    pub fn recover(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        notification: &Value,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, worker, notification) = (
            self.clone(),
            owner.to_owned(),
            worker.to_owned(),
            notification.clone(),
        );
        self.operations
            .run(async move { this.run(&owner, &worker, &notification).await })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.dependencies.goals.drained().await;
        self.dependencies.continuation.drained().await;
        self.dependencies.live.drained().await;
    }
    fn log(&self, level: &'static str, message: &'static str, context: Value) {
        (self.dependencies.logger)(LogCall::event(level, message, context));
    }
    fn publish_task(&self, owner: &str, chat: &str, context: &Value) {
        self.dependencies
            .live
            .publish_invalidation(owner, chat, "task", Some(context));
    }
    async fn run(&self, owner: &str, worker: &str, n: &Value) -> Result<()> {
        let (chat, lane) = (text(&n["chatId"])?, text(&n["executionLaneId"])?);
        let context = self.lanes.recovery_context(owner, chat, lane).await?;
        let logical = if truthy(n.get("nativeLogicalRoot")) && n["contextKind"] == "project" {
            let mut input = json!({"chatId":n["chatId"],"executionLaneId":n["executionLaneId"],"clientMessageId":n["clientMessageId"],"worktreeId":n["worktreeId"],"nativeLogicalRoot":n["nativeLogicalRoot"]});
            if n["outcome"]["ok"] == true {
                for key in ["threadId", "turnId"] {
                    if let Some(value) = n["outcome"]["result"].get(key) {
                        input[key] = value.clone();
                    }
                }
            }
            self.native
                .logical_gui_outcome_root(owner, worker, &input)
                .await?
        } else {
            None
        };
        if context.is_none()
            || (truthy(n.get("nativeLogicalRoot")) && logical.is_none())
            || (logical.is_none()
                && !context.as_ref().is_some_and(|c| {
                    let l = &c["lane"];
                    l["state"] == "active"
                        && l["workerId"] == worker
                        && l.get("worktreeId") == n.get("worktreeId")
                        && Some(&l["scratchRootId"]) == n.get("scratchRootId")
                }))
        {
            self.log("warn","Ignored an agent turn outcome outside its execution lane",json!({"chatId":n["chatId"],"clientMessageId":n["clientMessageId"],"executionLaneId":n["executionLaneId"],"workerId":worker}));
            return Ok(());
        }
        let context = context.expect("Recovered lane context");
        let messages = self.chats.message_headers(owner, chat).await?;
        if messages
            .iter()
            .rev()
            .find(|m| m["role"] == "user" && m["executionLaneId"] == n["executionLaneId"])
            .is_some_and(|message| message["id"] != n["clientMessageId"])
        {
            self.log("warn","Ignored a stale agent turn outcome after the execution lane advanced",json!({"chatId":n["chatId"],"clientMessageId":n["clientMessageId"],"executionLaneId":n["executionLaneId"],"workerId":worker}));
            return Ok(());
        }
        let task_operation = if n["contextKind"] == "project" {
            self.tasks.get_operation_context(owner,chat,&json!({"executionLaneId":n["executionLaneId"],"userMessageId":n["clientMessageId"]})).await?
        } else {
            None
        };
        let fence = n.get("taskDispatchFence").filter(|v| truthy(Some(v)));
        if let Some(fence) = fence {
            if !task_operation
                .as_ref()
                .is_some_and(|task| task["round"]["id"] == fence["operationId"])
            {
                self.log("warn","Ignored a Task outcome without its claimed operation",json!({"chatId":n["chatId"],"cycleId":fence["cycleId"],"operationId":fence["operationId"]}));
                return Ok(());
            }
            if let Err(error) = self.dispatch.heartbeat(fence, &Value::Null).await {
                if downcast_ref::<task_dispatch::Conflict>(&error).is_some() {
                    self.log("warn","Ignored a stale fenced Task outcome",json!({"chatId":n["chatId"],"cycleId":fence["cycleId"],"operationId":fence["operationId"]}));
                    return Ok(());
                }
                return Err(error);
            }
        }
        self.apply(Recovery {
            owner,
            worker,
            n,
            context: &context,
            logical: logical.as_ref(),
            operation: task_operation.as_ref(),
            fence,
        })
        .await
    }
}
