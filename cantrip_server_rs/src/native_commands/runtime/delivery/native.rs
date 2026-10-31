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
}
impl QueueDelivery {
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        publish: Publish,
        dispatch: Option<Dispatch>,
        on_error: ErrorSink,
    ) -> Arc<Self> {
        Self::with_backend(
            Arc::new(Native {
                repository: QueueRepository::new(database),
                commands,
                publish,
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
            self.commands
                .request(
                    &text(&entry["workerId"])?,
                    command,
                    Some(Duration::from_secs(10)),
                    None,
                )
                .await?;
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
