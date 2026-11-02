//! Revision-ordered, bounded thread-change coalescing shared by live observers.
use super::Operations;
use crate::wire::{JsString, Value, value::json};
use anyhow::Result;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use std::sync::{Arc, Mutex};

pub type Reconcile = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type ErrorSink = Arc<dyn Fn(anyhow::Error, JsString) + Send + Sync>;
struct Pending {
    latest: i64,
    processed: i64,
    running: bool,
    changes: Vec<Value>,
}
pub struct Reconciler {
    entries: Mutex<IndexMap<String, Arc<Mutex<Pending>>>>,
    operations: Arc<Operations>,
    limit: usize,
    on_error: ErrorSink,
}
impl Reconciler {
    pub fn new(on_error: ErrorSink, limit: usize) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::default(),
            operations: Arc::default(),
            limit,
            on_error,
        })
    }
    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
    pub fn schedule(self: &Arc<Self>, key: JsString, note: Value, reconcile: Reconcile) -> bool {
        let encoded = Value::String(key.clone()).stringify();
        let revision = note["revision"]
            .as_i64()
            .expect("Validated thread observation revision");
        let entry = {
            let mut entries = self.entries.lock().unwrap();
            if let Some(entry) = entries.get(&encoded) {
                if revision <= entry.lock().unwrap().latest {
                    return false;
                }
            } else if entries.len() >= self.limit {
                let evict = entries
                    .iter()
                    .find(|(_, entry)| !entry.lock().unwrap().running)
                    .map(|(key, _)| key.clone());
                let Some(evict) = evict else {
                    return false;
                };
                entries.shift_remove(&evict);
            }
            let entry = entries.shift_remove(&encoded).unwrap_or_else(|| {
                Arc::new(Mutex::new(Pending {
                    latest: 0,
                    processed: 0,
                    running: false,
                    changes: Vec::new(),
                }))
            });
            let launch = {
                let mut pending = entry.lock().unwrap();
                pending.latest = revision;
                for change in note["changes"]
                    .as_array()
                    .expect("Validated thread changes")
                {
                    if !pending.changes.contains(change) {
                        pending.changes.push(change.clone());
                    }
                }
                let launch = !pending.running;
                pending.running = true;
                launch
            };
            entries.insert(encoded.clone(), entry.clone());
            if !launch {
                return true;
            }
            entry
        };
        let this = self.clone();
        drop(self.operations.spawn(async move {
            // Source queues the first drain as a microtask after the synchronous enqueue.
            tokio::task::yield_now().await;
            loop {
                let (revision, changes) = {
                    let entries = this.entries.lock().unwrap();
                    let mut pending = entry.lock().unwrap();
                    if entries
                        .get(&encoded)
                        .is_none_or(|current| !Arc::ptr_eq(current, &entry))
                        || pending.processed >= pending.latest
                    {
                        pending.running = false;
                        break;
                    }
                    (pending.latest, std::mem::take(&mut pending.changes))
                };
                let mut observation = note.clone();
                observation["revision"] = json!(revision);
                observation["changes"] = Value::Array(changes);
                if let Err(error) = reconcile(observation).await {
                    (this.on_error)(error, key.clone());
                }
                entry.lock().unwrap().processed = revision;
            }
            Ok(())
        }));
        true
    }
}
