use super::MAX_SNAPSHOT_BYTES;
use crate::{
    http::checked,
    inference::admission::{Complete, Promise},
    metadata::{Guard, Signal},
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{Value, value::json};
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, Semaphore},
    time::Instant,
};

const TTL: Duration = Duration::from_secs(120);
const PAGE_ITEMS: usize = 200;
const PAGE_BYTES: usize = 2 * 1024 * 1024;
const PAGE_OVERHEAD: usize = 2048;
const LEGACY_BYTES: usize = 4 * 1024 * 1024;

struct Snapshot {
    key: String,
    value: Value,
    bytes: usize,
    expires_at: Instant,
    transfers: HashSet<String>,
}
struct Flight {
    result: Promise<String>,
    transfers: HashSet<String>,
}
#[derive(Default)]
struct State {
    pending: HashMap<String, Flight>,
    snapshots: IndexMap<String, Snapshot>,
    bytes: usize,
}
pub(super) struct Store {
    state: Mutex<State>,
    space: Notify,
    loads: Semaphore,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            space: Notify::new(),
            loads: Semaphore::new(4),
        }
    }
}

impl Store {
    pub(super) async fn read<F, Fut>(
        self: &Arc<Self>,
        key: String,
        request: Option<&Value>,
        signal: Signal,
        discover: F,
    ) -> Result<Value>
    where
        F: FnOnce(Signal) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value>> + Send + 'static,
    {
        let transfer = match request {
            Some(page) => page["transferId"]
                .as_str()
                .context("Model catalog transfer ID")?
                .to_owned(),
            None => uuid::Uuid::new_v4().to_string(),
        };
        let offset = request
            .and_then(|page| page["offset"].as_u64())
            .unwrap_or(0) as usize;
        if let Some(id) = request.and_then(|page| page["snapshotId"].as_str()) {
            return self.page(&key, id, &transfer, offset, false);
        }
        if offset != 0 {
            bail!("A model catalog offset requires its snapshot.");
        }
        let result = {
            let mut state = self.state.lock().unwrap();
            let flight = state.pending.entry(key.clone()).or_insert_with(|| {
                let (complete, result) = Promise::pair();
                tokio::spawn(self.clone().load(key.clone(), complete, signal, discover));
                Flight {
                    result,
                    transfers: HashSet::new(),
                }
            });
            if !flight.transfers.contains(&transfer) && flight.transfers.len() >= 256 {
                bail!("Model catalog has too many simultaneous readers.");
            }
            flight.transfers.insert(transfer.clone());
            flight.result.clone()
        };
        let id = result.work().await?;
        self.page(&key, &id, &transfer, offset, request.is_none())
    }

    async fn load<F, Fut>(
        self: Arc<Self>,
        key: String,
        complete: Complete<String>,
        signal: Signal,
        discover: F,
    ) where
        F: FnOnce(Signal) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value>> + Send + 'static,
    {
        let guard = Guard::metadata_timeout(Some(signal.clone()), None, TTL);
        let result = guard
            .run(async {
                let _permit = self.loads.acquire().await?;
                let mut value = discover(signal).await?;
                value["kind"] = json!("endpoint");
                let bytes = value.stringify().len();
                if bytes > MAX_SNAPSHOT_BYTES {
                    bail!("Model catalog snapshot exceeded 32 MiB.");
                }
                self.publish(&key, value, bytes).await
            })
            .await;
        if result.is_err() {
            self.state.lock().unwrap().pending.remove(&key);
        }
        complete.finish(result);
    }

    async fn publish(&self, key: &str, value: Value, bytes: usize) -> Result<String> {
        loop {
            let available = self.space.notified();
            tokio::pin!(available);
            available.as_mut().enable();
            let next_expiry = {
                let mut state = self.state.lock().unwrap();
                state.prune();
                while state.snapshots.len() >= 8 || state.bytes + bytes > MAX_SNAPSHOT_BYTES {
                    let Some(index) = state
                        .snapshots
                        .values()
                        .position(|entry| entry.transfers.is_empty())
                    else {
                        break;
                    };
                    state.bytes -= state.snapshots.shift_remove_index(index).unwrap().1.bytes;
                }
                if state.snapshots.len() < 8 && state.bytes + bytes <= MAX_SNAPSHOT_BYTES {
                    let id = uuid::Uuid::new_v4().to_string();
                    let transfers = state
                        .pending
                        .remove(key)
                        .context("Model catalog discovery no longer owned.")?
                        .transfers;
                    state.snapshots.insert(
                        id.clone(),
                        Snapshot {
                            key: key.to_owned(),
                            value,
                            bytes,
                            expires_at: Instant::now() + TTL,
                            transfers,
                        },
                    );
                    state.bytes += bytes;
                    return Ok(id);
                }
                state
                    .snapshots
                    .values()
                    .map(|snapshot| snapshot.expires_at)
                    .min()
                    .ok_or_else(|| anyhow!("Model catalog storage unavailable."))?
            };
            tokio::select! {
                _ = available => {},
                _ = tokio::time::sleep_until(next_expiry) => {},
            }
        }
    }

    fn page(
        &self,
        key: &str,
        id: &str,
        transfer: &str,
        offset: usize,
        legacy: bool,
    ) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        state.prune();
        let index = state
            .snapshots
            .get_index_of(id)
            .filter(|index| state.snapshots[*index].key == key)
            .context("Model catalog snapshot expired or belongs to another connection.")?;
        let snapshot = &mut state.snapshots[index];
        if !snapshot.transfers.contains(transfer) {
            bail!("Model catalog transfer is no longer active.");
        }
        snapshot.expires_at = Instant::now() + TTL;
        let result = snapshot.render(id, transfer, offset, legacy);
        if result
            .as_ref()
            .map_or(true, |page| legacy || page["nextOffset"].is_null())
        {
            snapshot.transfers.remove(transfer);
            self.space.notify_waiters();
        }
        let last = state.snapshots.len() - 1;
        state.snapshots.move_index(index, last);
        result
    }
}

impl State {
    fn prune(&mut self) {
        let now = Instant::now();
        self.snapshots.retain(|_, snapshot| {
            if snapshot.expires_at <= now {
                self.bytes -= snapshot.bytes;
                false
            } else {
                true
            }
        });
    }
}

impl Snapshot {
    fn render(&self, id: &str, transfer: &str, offset: usize, legacy: bool) -> Result<Value> {
        if legacy {
            if self.bytes > LEGACY_BYTES {
                bail!("Model catalog requires a server supporting paged discovery.");
            }
            return checked("endpointModelInventorySchema", &self.value);
        }
        let entries = self.value["models"]
            .as_array()
            .context("Model catalog entries")?;
        let mut bytes = PAGE_OVERHEAD;
        let mut models = Vec::new();
        for model in entries
            .get(offset..)
            .context("Model catalog offset is outside its snapshot.")?
            .iter()
            .take(PAGE_ITEMS)
        {
            let size = model.stringify().len() + 1;
            if size + PAGE_OVERHEAD > PAGE_BYTES {
                bail!("A model catalog entry exceeded the page byte limit.");
            }
            if bytes + size > PAGE_BYTES {
                break;
            }
            models.push(model);
            bytes += size;
        }
        let next = offset + models.len();
        let mut page = json!({
            "kind":"endpoint","transferId":transfer,"snapshotId":id,
            "observedAt":self.value["observedAt"],"models":models,
            "offset":offset,"nextOffset":(next < entries.len()).then_some(next),"total":entries.len(),
        });
        if self.value["metadataIncomplete"] == true {
            page["metadataIncomplete"] = json!(true);
        }
        checked("modelCatalogPageSchema", &page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::Abort;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_reads_share_discovery_and_keep_their_own_cursor() -> Result<()> {
        let store = Arc::new(Store::default());
        let (_abort, signal) = Abort::new();
        let first = "11111111-1111-4111-8111-111111111111";
        let second = "22222222-2222-4222-8222-222222222222";
        let first_page = json!({"transferId":first,"offset":0});
        let second_page = json!({"transferId":second,"offset":0});
        let count = Arc::new(AtomicUsize::new(0));
        let load = |count: Arc<AtomicUsize>| {
            move |_| async move {
                count.fetch_add(1, Ordering::SeqCst);
                let observed = "2026-01-01T00:00:00.000Z";
                let items = (0..201)
                    .map(|id| {
                        super::super::normalize::model(
                            &json!({"id":format!("model-{id}")}),
                            "openai-compatible",
                            false,
                            observed,
                        )
                        .unwrap()
                    })
                    .collect::<Vec<_>>();
                Ok(json!({"observedAt":observed,"models":items}))
            }
        };
        let (a, b) = tokio::join!(
            store.read(
                "scope".into(),
                Some(&first_page),
                signal.clone(),
                load(count.clone())
            ),
            store.read(
                "scope".into(),
                Some(&second_page),
                signal,
                load(count.clone())
            )
        );
        let (a, b) = (a?, b?);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(a["snapshotId"], b["snapshotId"]);
        assert_eq!(a["nextOffset"], json!(200));
        let id = a["snapshotId"].as_str().unwrap();
        assert!(
            store
                .page("different scope", id, first, 200, false)
                .is_err()
        );
        assert!(
            store
                .page("scope", id, "different transfer", 200, false)
                .is_err()
        );
        let last = store.page("scope", id, first, 200, false)?;
        assert_eq!(
            last["models"].as_array().unwrap()[0]["nativeModelId"],
            "model-200"
        );
        assert!(last["nextOffset"].is_null());
        assert!(store.page("scope", id, first, 200, false).is_err());
        assert_eq!(
            last["models"],
            store.page("scope", id, second, 200, false)?["models"]
        );
        Ok(())
    }
}
