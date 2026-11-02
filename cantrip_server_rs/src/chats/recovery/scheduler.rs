//! Outcome delay/settlement retention use the same key as the live turn path.
use crate::{
    chats::turn_runtime::{events::identifier, stages::Operations},
    wire::{JsString, Value, value::json},
};
use futures::future::BoxFuture;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::AbortHandle;
#[derive(Default)]
struct State {
    recoveries: HashMap<JsString, (uuid::Uuid, AbortHandle)>,
    settlements: HashMap<JsString, (uuid::Uuid, AbortHandle)>,
    settled: HashSet<JsString>,
}
pub struct Scheduler {
    delay: Duration,
    retention: Duration,
    state: Arc<Mutex<State>>,
    operations: Arc<Operations>,
}
pub fn key(worker: &Value, chat: &Value, message: &Value) -> JsString {
    identifier(&[worker, &json!(":"), chat, &json!(":"), message])
        .as_js_string()
        .unwrap()
        .clone()
}
impl Scheduler {
    pub fn new() -> Arc<Self> {
        Self::with_delays(Duration::from_secs(1), Duration::from_secs(60))
    }
    pub fn with_delays(delay: Duration, retention: Duration) -> Arc<Self> {
        Arc::new(Self {
            delay,
            retention,
            state: Arc::default(),
            operations: Arc::default(),
        })
    }
    pub fn schedule(
        &self,
        key: JsString,
        recover: impl FnOnce() -> BoxFuture<'static, ()> + Send + 'static,
    ) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.settled.contains(&key) {
            return false;
        }
        if let Some((_, timer)) = state.recoveries.remove(&key) {
            timer.abort();
        }
        let (id, shared, delay, operations) = (
            uuid::Uuid::new_v4(),
            self.state.clone(),
            self.delay,
            self.operations.clone(),
        );
        let copied = key.clone();
        let deadline = tokio::time::Instant::now() + delay;
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let admitted = {
                let mut state = shared.lock().unwrap();
                if state
                    .recoveries
                    .get(&copied)
                    .is_some_and(|(active, _)| *active == id)
                {
                    state.recoveries.remove(&copied);
                    true
                } else {
                    false
                }
            };
            if admitted {
                drop(operations.spawn(async move {
                    recover().await;
                    Ok(())
                }));
            }
        });
        state.recoveries.insert(key, (id, task.abort_handle()));
        true
    }
    pub fn settle(&self, key: &JsString) {
        let mut state = self.state.lock().unwrap();
        if let Some((_, timer)) = state.recoveries.remove(key) {
            timer.abort();
        }
        if let Some((_, timer)) = state.settlements.remove(key) {
            timer.abort();
        }
        state.settled.insert(key.clone());
        let (id, shared, retention, copied) = (
            uuid::Uuid::new_v4(),
            self.state.clone(),
            self.retention,
            key.clone(),
        );
        let deadline = tokio::time::Instant::now() + retention;
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let mut state = shared.lock().unwrap();
            if state
                .settlements
                .get(&copied)
                .is_some_and(|(active, _)| *active == id)
            {
                state.settlements.remove(&copied);
                state.settled.remove(&copied);
            }
        });
        state
            .settlements
            .insert(key.clone(), (id, task.abort_handle()));
    }
    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap();
        for (_, (_, timer)) in state.recoveries.drain() {
            timer.abort();
        }
        for (_, (_, timer)) in state.settlements.drain() {
            timer.abort();
        }
        state.settled.clear();
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
}
