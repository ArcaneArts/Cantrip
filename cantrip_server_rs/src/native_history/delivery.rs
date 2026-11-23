//! The committed outbox retries confirmed invalidations independently of native
//! input. Stopping before transport teardown retains unfinished publications.
use super::*;
use crate::{
    live::Hub,
    native_commands::runtime::logical_delivery::{Backend, DurableDelivery},
    wire::value::json,
};
use futures::{FutureExt, future::BoxFuture};
use std::time::Duration;
pub struct PublicationDelivery {
    inner: Arc<DurableDelivery>,
}
struct Native {
    repository: Repository,
    hub: Arc<Hub>,
}
impl PublicationDelivery {
    pub fn new(database: Arc<Database>, hub: Arc<Hub>) -> Arc<Self> {
        let inner = DurableDelivery::with_backend(
            Arc::new(Native {
                repository: Repository::new(database),
                hub,
            }),
            Arc::new(|_error, entry| {
                let mut event = json!({"level":"warn","event":"native-history.publication-pending","message":"Committed native history publication will retry."});
                if let Some(entry) = entry {
                    event["chatId"] = entry["chatId"].clone();
                    event["commitId"] = entry["commitId"].clone();
                }
                // Source suppresses diagnostic failures. A closed stderr must not
                // prevent the durable defer or consume already committed history.
                use std::io::Write;
                let _ = writeln!(std::io::stderr(), "{}", event.stringify());
            }),
            Arc::new(|| crate::auth::now().timestamp_millis()),
            Duration::from_secs(1),
        );
        Arc::new(Self { inner })
    }
    pub fn start(self: &Arc<Self>) {
        self.inner.start();
    }
    pub fn stop(&self) {
        self.inner.stop();
    }
    pub async fn drained(&self) {
        self.inner.drained().await;
    }
    pub fn run_once(self: &Arc<Self>) -> impl std::future::Future<Output = ()> + Send + 'static {
        self.inner.run_once()
    }
}
impl Backend for Native {
    fn pending(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        self.repository.pending_publications(64).boxed()
    }
    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        async move{
        self.hub.publish_confirmed(json!({"ownerId":entry["ownerId"],"scope":json!({"kind":"chat","chatId":entry["chatId"]}),"resource":"chat-message","action":"invalidated","entityId":entry["commitId"],"revision":Value::Null,"payload":Value::Null})).await?;Ok(())
    }.boxed()
    }
    fn acknowledge(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        async move {
            self.repository.acknowledge_publication(&entry).await?;
            Ok(())
        }
        .boxed()
    }
    fn defer(&self, entry: Value, at: i64) -> BoxFuture<'_, Result<()>> {
        async move {
            let due = chrono::DateTime::from_timestamp_millis(at)
                .context("Native history publication retry date")?;
            self.repository.defer_publication(&entry, due).await?;
            Ok(())
        }
        .boxed()
    }
}
