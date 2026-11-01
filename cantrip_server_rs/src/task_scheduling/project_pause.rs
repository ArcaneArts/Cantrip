//! Project list controls share Chat's acknowledged automation state. Paused
//! dispatches resume only after the scheduler reacquires capacity and a lease.
use super::*;
use crate::{
    chats::{
        Repository as Chats, automation_pause, goals, live_mutations::Service as Live,
        turn_runtime::stages::Operations,
    },
    operations::shared_failure::downcast_ref,
    task_dispatch, tasks,
};
use futures::future::{BoxFuture, join_all};

#[derive(Debug)]
pub struct PauseFailures {
    pub message: JsString,
}
impl std::fmt::Display for PauseFailures {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for PauseFailures {}

pub struct Service {
    chats: Chats,
    tasks: tasks::Repository,
    dispatch: task_dispatch::Repository,
    pause: Arc<automation_pause::Service>,
    goals: Arc<goals::Service>,
    live: Arc<Live>,
    operations: Arc<Operations>,
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        pause: Arc<automation_pause::Service>,
        goals: Arc<goals::Service>,
        live: Arc<Live>,
    ) -> Arc<Self> {
        Arc::new(Self {
            chats: Chats::new(database.clone()),
            tasks: tasks::Repository::new(database.clone()),
            dispatch: task_dispatch::Repository::new(database),
            pause,
            goals,
            live,
            operations: Arc::default(),
        })
    }
    pub fn set(
        self: &Arc<Self>,
        owner: &str,
        project: &str,
        paused: bool,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, project) = (self.clone(), owner.to_owned(), project.to_owned());
        self.operations.run(async move {
            let tasks = this.tasks.list(&owner, &project).await?;
            let results = join_all(
                tasks
                    .iter()
                    .map(|task| this.set_task(&owner, &project, task, paused)),
            )
            .await;
            let failures = results
                .into_iter()
                .filter_map(Result::err)
                .collect::<Vec<_>>();
            if failures.is_empty() {
                return Ok(());
            }
            let mut message = format!(
                "{} Task{} could not {}: ",
                failures.len(),
                if failures.len() == 1 { "" } else { "s" },
                if paused { "pause" } else { "resume" },
            )
            .encode_utf16()
            .collect::<Vec<_>>();
            for (index, error) in failures.iter().enumerate() {
                if index > 0 {
                    message.extend("; ".encode_utf16());
                }
                let detail = downcast_ref::<automation_pause::PauseError>(error)
                    .map(|error| error.message.clone())
                    .unwrap_or_else(|| crate::settings::operation_error_message(error));
                message.extend_from_slice(detail.units());
            }
            Err(PauseFailures {
                message: JsString::new(message),
            }
            .into())
        })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.pause.drained().await;
        self.goals.drained().await;
        self.live.drained().await;
    }
    fn publish(&self, owner: &str, chat: &str, context: &Value) {
        self.live
            .publish_invalidation(owner, chat, "task", Some(context));
    }
    async fn set_task(&self, owner: &str, project: &str, task: &Value, paused: bool) -> Result<()> {
        if matches!(task["state"].as_str(), Some("complete" | "failed")) {
            return Ok(());
        }
        let chat = text(&task["chatId"])?;
        let Some(context) = self.chats.execution_context(owner, &chat).await? else {
            return Ok(());
        };
        if context["projectId"] != project || context["experience"] != "task" {
            return Ok(());
        }
        let cycle = &task["dispatch"];
        if !paused {
            if cycle["state"] == "paused" || !truthy(context.get("automationPaused")) {
                return Ok(());
            }
            self.pause.set(owner, &chat, false, true).await?;
            self.publish(owner, &chat, &context);
            return Ok(());
        }
        let lease = goals::dispatch_cycle_lease(cycle)?;
        let executing = matches!(
            context["status"].as_str(),
            Some("running" | "waiting-for-approval")
        );
        if cycle["state"] == "claimed"
            && let Some(lease) = &lease
            && !executing
        {
            self.chats.set_automation_paused(owner, &chat, true).await?;
            self.live
                .publish_summary(owner, &context["chatId"], &json!(project));
            self.goals.release(&cycle["id"]);
            if let Err(error) = self.dispatch.pause(
                lease,
                &json!({"threadId":cycle.get("codexThreadId").filter(|v|!v.is_null()).unwrap_or(&context["threadId"]),"turnId":cycle["turnId"]}),
                &Value::Null,
                true,
            ).await && downcast_ref::<task_dispatch::Conflict>(&error).is_none() {
                return Err(error);
            }
            self.publish(owner, &chat, &context);
            return Ok(());
        }
        if lease.is_none()
            && !executing
            && !matches!(task["state"].as_str(), Some("implementing" | "paused"))
        {
            return Ok(());
        }
        let receipt = self.pause.set(owner, &chat, true, true).await?;
        anyhow::ensure!(
            truthy(receipt.get("paused")),
            "The worker did not acknowledge the Task pause."
        );
        if let Some(lease) = &lease {
            self.goals.release(&cycle["id"]);
            let thread = receipt["active"]
                .get("threadId")
                .filter(|v| !v.is_null())
                .or_else(|| cycle.get("codexThreadId").filter(|v| !v.is_null()))
                .unwrap_or(&context["threadId"]);
            let turn = receipt["active"]
                .get("turnId")
                .filter(|v| !v.is_null())
                .unwrap_or(&cycle["turnId"]);
            if let Err(error) = self
                .dispatch
                .pause(
                    lease,
                    &json!({"threadId":thread,"turnId":turn}),
                    &Value::Null,
                    false,
                )
                .await
                && downcast_ref::<task_dispatch::Conflict>(&error).is_none()
            {
                return Err(error);
            }
        }
        self.publish(owner, &chat, &context);
        Ok(())
    }
}
