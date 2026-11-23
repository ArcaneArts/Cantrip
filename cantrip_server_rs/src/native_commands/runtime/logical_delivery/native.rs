use super::*;
use crate::{
    database::Database,
    native_commands::{Repository, admit::text},
    wire::value::json,
    workers::command_bus::LimitedCommandBus,
};

struct Native {
    repository: Repository,
    commands: Arc<LimitedCommandBus>,
}
#[cfg(debug_assertions)]
fn observe(action: &str, entry: &Value, changed: bool, due: Option<i64>) {
    if std::env::var("CANTRIP_TEST_COMPLETION_OBSERVATIONS").as_deref() != Ok("true") {
        return;
    }
    let identity = json!([
        entry["ownerId"].clone(),
        entry["workerId"].clone(),
        entry["chatId"].clone(),
        entry["rootOperationId"].clone(),
        entry["rootOperationGeneration"].clone()
    ]);
    let mut event = json!({"event":"fixture.logical-completion.persisted","action":action,"identity":identity,"changed":changed});
    if let Some(at) = due {
        event["dueMs"] = json!(at);
    }
    eprintln!("{}", event.stringify());
}
#[cfg(not(debug_assertions))]
fn observe(_action: &str, _entry: &Value, _changed: bool, _due: Option<i64>) {}
/// Releases one exact completed root through the production command authority.
pub async fn deliver(commands: &Arc<LimitedCommandBus>, entry: &Value) -> Result<()> {
    let worker = text(&entry["workerId"])?;
    let command = json!({"type":"chat.native-logical.complete","chatId":entry["chatId"],"rootOperationId":entry["rootOperationId"],"rootOperationGeneration":entry["rootOperationGeneration"]});
    commands
        .request(&worker, command, Some(Duration::from_secs(10)), None)
        .await?;
    Ok(())
}
impl LogicalDelivery {
    pub fn new(database: Arc<Database>, commands: Arc<LimitedCommandBus>) -> Arc<Self> {
        Self::with_backend(
            Arc::new(Native {
                repository: Repository::new(database),
                commands,
            }),
            Arc::new(|_error, entry| {
                let mut event = json!({"level":"warn","event":"native-command.logical-completion-delivery-failed","message":"Logical native completion remains pending for redelivery."});
                if let Some(entry) = entry {
                    event["chatId"] = entry["chatId"].clone();
                    event["operationId"] = entry["rootOperationId"].clone();
                }
                // Match Source's metadata-only warning; worker/SQL errors can be private.
                eprintln!("{}", event.stringify());
            }),
            Arc::new(|| crate::auth::now().timestamp_millis()),
            Duration::from_secs(1),
        )
    }
}
impl Backend for Native {
    fn pending(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        self.repository
            .list_pending_logical_completions(Some(64.0))
            .boxed()
    }
    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        async move { deliver(&self.commands, &entry).await }.boxed()
    }
    fn acknowledge(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        async move {
            let changed = self
                .repository
                .acknowledge_logical_completion(
                    &text(&entry["ownerId"])?,
                    &text(&entry["workerId"])?,
                    &text(&entry["chatId"])?,
                    &text(&entry["rootOperationId"])?,
                    &text(&entry["rootOperationGeneration"])?,
                )
                .await?;
            observe("ack", &entry, changed, None);
            Ok(())
        }
        .boxed()
    }
    fn defer(&self, entry: Value, at: i64) -> BoxFuture<'_, Result<()>> {
        async move {
            let due = chrono::DateTime::from_timestamp_millis(at)
                .context("Logical completion retry date")?;
            let changed = self
                .repository
                .defer_logical_completion(
                    &text(&entry["ownerId"])?,
                    &text(&entry["workerId"])?,
                    &text(&entry["chatId"])?,
                    &text(&entry["rootOperationId"])?,
                    &text(&entry["rootOperationGeneration"])?,
                    &json!(crate::auth::iso(due)),
                )
                .await?;
            observe("defer", &entry, changed, Some(at));
            Ok(())
        }
        .boxed()
    }
}
