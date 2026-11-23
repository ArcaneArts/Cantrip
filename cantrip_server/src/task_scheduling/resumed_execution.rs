//! Resume a fenced paused Task through the real worker boundary, retained Goal,
//! or claimed launcher. Failed resumes restore pause without hiding SQL errors.
use super::*;
use crate::{
    chats::{
        Repository as Chats, automation_pause, goals, live_mutations::Service as Live,
        turn_runtime::stages::Operations,
    },
    operations::shared_failure::downcast_ref,
    task_dispatch, tasks,
    workers::command_bus::LimitedCommandBus,
};
use futures::future::BoxFuture;

pub struct Dependencies {
    pub database: Arc<Database>,
    pub pause: Arc<automation_pause::Service>,
    pub goals: Arc<goals::Service>,
    pub claimed: Arc<super::claimed_execution::Service>,
    pub commands: Arc<LimitedCommandBus>,
    pub live: Arc<Live>,
}
pub struct Service {
    dependencies: Dependencies,
    chats: Chats,
    tasks: tasks::Repository,
    dispatch: task_dispatch::Repository,
    operations: Arc<Operations>,
}
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let db = dependencies.database.clone();
        Arc::new(Self {
            chats: Chats::new(db.clone()),
            tasks: tasks::Repository::new(db.clone()),
            dispatch: task_dispatch::Repository::new(db),
            dependencies,
            operations: Arc::default(),
        })
    }
    pub fn run(self: &Arc<Self>, owner: &str, claim: &Value) -> BoxFuture<'static, Result<()>> {
        let (this, owner, claim) = (self.clone(), owner.to_owned(), claim.clone());
        self.operations
            .run(async move { this.run_one(&owner, &claim).await })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.dependencies.pause.drained().await;
        self.dependencies.claimed.drained().await;
        self.dependencies.goals.drained().await;
        self.dependencies.live.drained().await;
    }
    fn publish(&self, owner: &str, chat: &str, context: Option<&Value>) {
        self.dependencies
            .live
            .publish_invalidation(owner, chat, "task", context);
    }
    async fn run_one(&self, owner: &str, claim: &Value) -> Result<()> {
        let cycle = &claim["cycle"];
        let chat = text(&cycle["chatId"])?;
        let mut context = None;
        let result: Result<()> = async {
            context = self.chats.execution_context(owner, &chat).await?;
            let current = context
                .as_ref()
                .context("The paused Task placement is no longer available.")?;
            anyhow::ensure!(
                current["experience"] == "task"
                    && current["projectId"] == claim["projectId"]
                    && current["workerId"] == cycle["physicalWorkerId"]
                    && current["worktreeId"] == cycle["worktreeId"],
                "The paused Task placement is no longer available."
            );
            let resumed = self
                .dependencies
                .pause
                .set(owner, &chat, false, false)
                .await?;
            anyhow::ensure!(
                !truthy(resumed.get("paused")),
                "The worker did not resume the paused Task."
            );
            if truthy(resumed.get("active")) {
                let active = &resumed["active"];
                anyhow::ensure!(
                    (!truthy(cycle.get("codexThreadId"))
                        || active["threadId"] == cycle["codexThreadId"])
                        && (!truthy(cycle.get("turnId")) || active["turnId"] == cycle["turnId"]),
                    "The paused Task runtime affinity changed."
                );
            } else {
                let task = self.tasks.get(owner, &chat).await?;
                if cycle["operationKind"] == "finalize"
                    && task.as_ref().is_some_and(|task| {
                        matches!(task["state"].as_str(), Some("implementing" | "paused"))
                    })
                {
                    self.dependencies.goals.retain(&claim["lease"]).await?;
                    self.dependencies
                        .goals
                        .resume(owner, &chat, false, false)
                        .await?;
                } else {
                    self.dependencies.claimed.run(owner, claim, None).await?;
                }
            }
            if cycle["operationKind"] == "finalize" {
                self.dependencies.goals.retain(&claim["lease"]).await?;
            }
            self.publish(owner, &chat, Some(current));
            Ok(())
        }
        .await;
        if let Err(error) = result {
            if let Some(context) = &context
                && self
                    .dependencies
                    .commands
                    .is_connected(&text(&context["workerId"])?)
            {
                let _ = self.dependencies.pause.set(owner, &chat, true, true).await;
            }
            if let Err(dispatch_error) = self
                .dispatch
                .pause(
                    &claim["lease"],
                    &json!({"threadId":cycle["codexThreadId"],"turnId":cycle["turnId"]}),
                    &Value::Null,
                    false,
                )
                .await
                && downcast_ref::<task_dispatch::Conflict>(&dispatch_error).is_none()
            {
                return Err(dispatch_error);
            }
            self.publish(owner, &chat, context.as_ref());
            return Err(error);
        }
        Ok(())
    }
}
