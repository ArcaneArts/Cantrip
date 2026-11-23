//! Successful immutable lookups share one lifetime. Only the failing attempt
//! removes its slot; abandoning a response does not cancel accepted metadata IO.
use super::{Failure, response};
use cantrip_history::projection::Work;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;
type Reply<T> = std::result::Result<T, Failure>;
struct Slot<T> {
    id: u64,
    future: Shared<BoxFuture<'static, Reply<T>>>,
}
struct State<T> {
    next: u64,
    slots: HashMap<String, Slot<T>>,
}
pub struct Cache<T>(Arc<Mutex<State<T>>>);
impl<T> Clone for Cache<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<T> Default for Cache<T> {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(State {
            next: 0,
            slots: HashMap::new(),
        })))
    }
}
impl<T: Clone + Send + Sync + 'static> Cache<T> {
    pub fn clear(&self) {
        self.0.lock().unwrap().slots.clear();
    }
    pub fn get(&self, key: String, operation: impl FnOnce() -> Work<T>) -> Work<T> {
        let mut state = self.0.lock().unwrap();
        if let Some(slot) = state.slots.get(&key) {
            let future = slot.future.clone();
            drop(state);
            return cantrip_transport::lifecycle::owned(async move {
                future.await.map_err(|e| e.error())
            });
        }
        let (send, receive) = oneshot::channel();
        let future = async move {
            receive.await.unwrap_or_else(|_| {
                Err(Failure::new(anyhow::anyhow!(
                    "Native history lookup stopped."
                )))
            })
        }
        .boxed()
        .shared();
        state.next += 1;
        let id = state.next;
        state.slots.insert(
            key.clone(),
            Slot {
                id,
                future: future.clone(),
            },
        );
        drop(state);
        let this = self.clone();
        let running = operation();
        let task = cantrip_transport::lifecycle::owned(async move {
            let result = running.await.map_err(Failure::new);
            if result.is_err() {
                let mut state = this.0.lock().unwrap();
                if state.slots.get(&key).is_some_and(|slot| slot.id == id) {
                    state.slots.remove(&key);
                }
            }
            let _ = send.send(result);
            Ok(())
        });
        drop(task);
        let (send, receive) = oneshot::channel();
        drop(cantrip_transport::lifecycle::owned(async move {
            let _ = send.send(future.await);
            Ok(())
        }));
        response(receive)
    }
}
