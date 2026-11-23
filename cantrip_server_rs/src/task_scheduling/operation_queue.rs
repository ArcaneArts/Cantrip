//! Durable Task admission, retry-ledger reset, opaque naming and scheduler wakeup.
use super::*;
use crate::{
    chats::{
        automatic_title::MessageTitles, live_mutations::Service as Live,
        turn_runtime::stages::Operations,
    },
    task_dispatch, tasks,
};
use futures::future::BoxFuture;
pub struct Service {
    dispatch: task_dispatch::Repository,
    tasks: tasks::Repository,
    retries: tasks::retries::Repository,
    live: Arc<Live>,
    titles: Arc<MessageTitles>,
    tick: Arc<dyn Fn() + Send + Sync>,
    operations: Arc<Operations>,
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        live: Arc<Live>,
        titles: Arc<MessageTitles>,
        tick: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            dispatch: task_dispatch::Repository::new(database.clone()),
            tasks: tasks::Repository::new(database.clone()),
            retries: tasks::retries::Repository::new(database),
            live,
            titles,
            tick,
            operations: Arc::default(),
        })
    }
    pub fn queue(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        input: &Value,
        kind: &str,
        automatic: bool,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let (this, owner, chat, input, kind) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            input.clone(),
            kind.to_owned(),
        );
        self.operations.run(async move {
            this.dispatch
                .enqueue(
                    &owner,
                    &chat,
                    &text(&input["operationId"])?,
                    &kind,
                    &input["rowVersion"],
                )
                .await?;
            if !automatic {
                this.retries.reset(&owner, &chat).await?;
            }
            this.live.publish_invalidation(&owner, &chat, "task", None);
            let task = this.tasks.get(&owner, &chat).await?;
            if let Some(task) = &task
                && matches!(kind.as_str(), "direct" | "initial-plan")
            {
                // Naming owns its admitted work; it never delays Task admission.
                drop(this.titles.generate_task(&owner, &chat, task));
            }
            (this.tick)();
            Ok(task)
        })
    }
    pub fn retry(
        self: &Arc<Self>,
        owner: &str,
        task: &Value,
        operation_id: Option<&Value>,
        automatic: bool,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let (this, owner, task, operation_id) = (
            self.clone(),
            owner.to_owned(),
            task.clone(),
            operation_id
                .cloned()
                .unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string())),
        );
        self.operations.run(async move {
            let kind = task["lastError"]
                .get("operationKind")
                .filter(|v| !v.is_null())
                .unwrap_or(&task["dispatch"]["operationKind"]);
            anyhow::ensure!(
                truthy(Some(kind)) && kind != "implementation" && kind != "goal-continuation",
                "Use the implementation Goal controls to recover this Task."
            );
            let chat = text(&task["chatId"])?;
            let mut operation = operation_id;
            if kind == "finalize" {
                let rounds = this.tasks.list_rounds(&owner, &chat).await?;
                if let Some(latest) = rounds
                    .iter()
                    .find(|round| round["ordinal"] == task["planningRound"])
                    && let Some(saved) = this
                        .tasks
                        .get_operation_context(&owner, &chat, &json!({"operationId":latest["id"]}))
                        .await?
                    && truthy(saved["relayResult"].get("goal"))
                {
                    operation = latest["id"].clone();
                }
            }
            this.queue(
                &owner,
                &chat,
                &json!({"operationId":operation,"rowVersion":task["rowVersion"]}),
                &text(kind)?,
                automatic,
            )
            .await
        })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.titles.drained().await;
        self.live.drained().await;
    }
}
