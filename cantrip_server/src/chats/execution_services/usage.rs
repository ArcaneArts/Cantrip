//! Source coalesces project token usage for ten seconds and publishes completed
//! attempts immediately. Timer capacity evicts the oldest pending publication.
use super::*;
use indexmap::IndexMap;
use std::time::Duration;
use tokio::task::AbortHandle;

type Key = (String, String);
type Publish = Arc<dyn Fn(&Value) + Send + Sync>;
struct Pending {
    value: Value,
    timer: AbortHandle,
    id: uuid::Uuid,
}
pub(super) struct Invalidations {
    publish: Publish,
    pending: Mutex<IndexMap<Key, Pending>>,
}
impl Invalidations {
    pub fn new(live: Arc<LiveService>) -> Arc<Self> {
        Self::with_publish(Arc::new(move |value| {
            let _ = live.publish_event(json!({"ownerId":value["ownerId"],"scope":json!({"kind":"project","projectId":value["projectId"]}),"resource":"project-token-usage","action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null}));
        }))
    }
    fn with_publish(publish: Publish) -> Arc<Self> {
        Arc::new(Self {
            publish,
            pending: Mutex::default(),
        })
    }
    fn publish(&self, value: &Value) {
        (self.publish)(value);
    }
    pub fn schedule(self: &Arc<Self>, value: Value) {
        let (Some(owner), Some(project)) = (value["ownerId"].as_str(), value["projectId"].as_str())
        else {
            return;
        };
        let key = (owner.to_owned(), project.to_owned());
        let mut pending = self.pending.lock().unwrap();
        if value["completed"] == true {
            if let Some(entry) = pending.shift_remove(&key) {
                entry.timer.abort();
            }
            drop(pending);
            self.publish(&value);
            return;
        }
        if let Some(entry) = pending.get_mut(&key) {
            entry.value = value;
            return;
        }
        let oldest = if pending.len() >= 4_096 {
            pending.shift_remove_index(0).map(|(_, entry)| {
                entry.timer.abort();
                entry.value
            })
        } else {
            None
        };
        let (weak, timer_key, id) = (Arc::downgrade(self), key.clone(), uuid::Uuid::new_v4());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(service) = weak.upgrade() {
                let entry = {
                    let mut pending = service.pending.lock().unwrap();
                    if pending.get(&timer_key).is_some_and(|entry| entry.id == id) {
                        pending.shift_remove(&timer_key)
                    } else {
                        None
                    }
                };
                if let Some(entry) = entry {
                    service.publish(&entry.value);
                }
            }
        });
        pending.insert(
            key,
            Pending {
                value,
                timer: timer.abort_handle(),
                id,
            },
        );
        drop(pending);
        if let Some(value) = oldest {
            self.publish(&value);
        }
    }
    pub fn close(&self) {
        for (_, entry) in self.pending.lock().unwrap().drain(..) {
            entry.timer.abort();
        }
    }
}
impl Drop for Invalidations {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;
    fn fixture() -> (Arc<Invalidations>, mpsc::UnboundedReceiver<Value>) {
        let (send, receive) = mpsc::unbounded_channel();
        (
            Invalidations::with_publish(Arc::new(move |v| {
                send.send(v.clone()).unwrap();
            })),
            receive,
        )
    }
    fn event(project: &str, completed: bool, revision: i32) -> Value {
        json!({"ownerId":"owner","projectId":project,"completed":completed,"revision":revision})
    }
    #[tokio::test(start_paused = true)]
    async fn updates_keep_the_first_deadline_and_publish_the_latest_value() {
        let (service, mut receive) = fixture();
        service.schedule(event("project", false, 1));
        tokio::time::advance(Duration::from_secs(9)).await;
        service.schedule(event("project", false, 2));
        assert!(receive.try_recv().is_err());
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(receive.recv().await.unwrap()["revision"], json!(2));
        assert!(receive.try_recv().is_err());
    }
    #[tokio::test(start_paused = true)]
    async fn completion_publishes_immediately_and_cancels_the_old_timer() {
        let (service, mut receive) = fixture();
        service.schedule(event("project", false, 1));
        service.schedule(event("project", true, 2));
        assert_eq!(receive.try_recv().unwrap()["revision"], json!(2));
        service.schedule(event("project", false, 3));
        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(receive.recv().await.unwrap()["revision"], json!(3));
        assert!(receive.try_recv().is_err());
    }
    #[tokio::test(start_paused = true)]
    async fn timer_capacity_flushes_oldest_and_close_cancels_pending_publications() {
        let (service, mut receive) = fixture();
        for i in 0..4_097 {
            service.schedule(event(&i.to_string(), false, i));
        }
        assert_eq!(receive.try_recv().unwrap()["projectId"], json!("0"));
        assert!(receive.try_recv().is_err());
        service.close();
        tokio::time::advance(Duration::from_secs(11)).await;
        assert!(receive.try_recv().is_err());
        assert!(service.pending.lock().unwrap().is_empty());
    }
}
