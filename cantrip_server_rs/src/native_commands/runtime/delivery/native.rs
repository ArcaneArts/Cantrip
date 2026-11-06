use super::*;
use crate::{
    database::Database,
    native_commands::{admit::text, managed_queue::QueueRepository},
    wire::value::json,
    workers::command_bus::LimitedCommandBus,
};
use anyhow::Context;
struct Native {
    repository: QueueRepository,
    commands: Arc<LimitedCommandBus>,
    publish: Publish,
    recover_goal: Option<GoalRecovery>,
}
impl QueueDelivery {
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        publish: Publish,
        dispatch: Option<Dispatch>,
        recover_goal: Option<GoalRecovery>,
        on_error: ErrorSink,
    ) -> Arc<Self> {
        Self::with_backend(
            Arc::new(Native {
                repository: QueueRepository::new(database),
                commands,
                publish,
                recover_goal,
            }),
            dispatch,
            on_error,
        )
    }
}
impl Backend for Native {
    fn pending_dispatches(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        self.repository.pending_dispatches().boxed()
    }
    fn pending_notifications(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        self.repository.pending_notifications(None).boxed()
    }
    fn publish(&self, entry: &Value) -> Result<()> {
        (self.publish)(text(&entry["ownerId"])?, text(&entry["chatId"])?)
    }
    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        async move {
            let command=json!({"type":"chat.queue.changed","chatId":entry["chatId"],"revision":entry["revision"]});
            let primary = text(&entry["workerId"])?;
            let mut workers = vec![primary.clone()];
            if let Some(Value::Array(additional)) = entry.get("additionalWorkerIds") {
                for worker in additional { workers.push(text(worker)?); }
            }
            let outcomes = futures::future::join_all(workers.into_iter().map(|worker| {
                let command = command.clone();
                let former = worker != primary || entry["recoveryOnly"] == true;
                async move { match self.commands.request(
                    &worker, command,
                    Some(Duration::from_secs(10)),
                    None,
                ).await {
                    Ok(_) => Ok(()),
                    Err(crate::workers::command_bus::CommandFailure::Bridge(error)) if former && error.unavailable => Ok(()),
                    Err(error) => Err(anyhow::Error::from(error)),
                } }
            })).await;
            for outcome in outcomes { outcome?; }
            if let Some(recovery) = entry.get("taskGoalRecovery")
                .filter(|v| !v.is_null()).or_else(|| entry.get("goalRecovery").filter(|v| !v.is_null()))
                .or_else(|| entry.get("goalClaimRecovery").filter(|v| !v.is_null())) {
                let recover = self.recover_goal.as_ref().context("Managed Goal recovery delivery is unavailable.")?;
                recover(text(&entry["ownerId"])?, text(&entry["chatId"])?, recovery.clone()).await?;
            }
            Ok(())
        }
        .boxed()
    }
    fn acknowledge(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        async move {
            self.repository
                .acknowledge_notification(
                    &text(&entry["chatId"])?,
                    entry["revision"]
                        .as_f64()
                        .context("Queue notification revision")?,
                )
                .await
        }
        .boxed()
    }
    fn defer(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        async move {
            self.repository
                .defer_notification(&text(&entry["chatId"])?)
                .await
        }
        .boxed()
    }
}
