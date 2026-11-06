//! Development-only pauses around real Redis operations. Every released call
//! invokes the production coordinator; this does not fabricate Redis results.
use super::{Control, Events, record};
use anyhow::Result;
use cantrip_server::{
    coordination::{Listener, RedisCoordinator, RelayCoordinator},
    wire::{JsString, Value},
};
use futures::future::BoxFuture;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::watch;
pub(super) struct Gate {
    signal: watch::Sender<bool>,
    after: bool,
    once: bool,
    used: AtomicBool,
}
pub fn gate(control: &Control, key: String, after: bool, once: bool) {
    control.coordination.lock().unwrap().insert(
        key,
        Arc::new(Gate {
            signal: watch::channel(false).0,
            after,
            once,
            used: AtomicBool::new(false),
        }),
    );
}
pub fn release(control: &Control, key: &str) {
    if let Some(g) = control.coordination.lock().unwrap().remove(key) {
        g.signal.send_replace(true);
    }
}
pub struct Controlled {
    inner: Arc<RedisCoordinator>,
    events: Events,
    control: Arc<Control>,
}
impl Controlled {
    pub fn new(inner: Arc<RedisCoordinator>, events: Events, control: Arc<Control>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            events,
            control,
        })
    }
    fn take(&self, op: &str, worker: &str) -> Option<Arc<Gate>> {
        self.control
            .coordination
            .lock()
            .unwrap()
            .get(&format!("{op}:{worker}"))
            .cloned()
            .filter(|g| !g.once || !g.used.swap(true, Ordering::AcqRel))
    }
    async fn pause(&self, gate: Option<&Arc<Gate>>, after: bool, op: &str, worker: &str) {
        let Some(g) = gate.filter(|g| g.after == after) else {
            return;
        };
        let mut receiver = g.signal.subscribe();
        record(
            &self.events,
            j!({"kind":"coordination-paused","operation":op,"workerId":worker}),
        );
        let _ = receiver.wait_for(|done| *done).await;
    }
}
macro_rules! refs {
    ($($method:ident($($arg:ident),*)->$output:ty;)*)=>{$(
        fn $method<'a>(&'a self,$($arg:&'a JsString),*)->BoxFuture<'a,Result<$output>>{Box::pin(RedisCoordinator::$method(&self.inner,$($arg),*))}
    )*};
}
impl RelayCoordinator for Controlled {
    fn instance_id(&self) -> &str {
        self.inner.instance_id()
    }
    fn presence_ttl_ms(&self) -> u64 {
        self.inner.presence_ttl_ms()
    }
    fn stats(&self) -> Value {
        self.inner.stats()
    }
    fn subscribe(&self, listener: Listener) -> u64 {
        self.inner.subscribe(listener)
    }
    fn unsubscribe(&self, id: u64) {
        self.inner.unsubscribe(id);
    }
    fn cached_worker(&self, worker: &JsString) -> Option<Value> {
        self.inner.cached_worker(worker)
    }
    fn start(self: Arc<Self>) -> BoxFuture<'static, Result<()>> {
        Box::pin(async move { RedisCoordinator::start(&self.inner).await })
    }
    refs! {close()->();health()->bool;find_worker(worker)->Option<Value>;release_worker(worker,connection)->bool;find_worker_link_session(session)->Option<Value>;release_worker_link_session(session,authority)->bool;}
    fn publish(&self, payload: Value, ttl: Option<f64>) -> BoxFuture<'_, Result<()>> {
        let gate = self.take("publish", "");
        Box::pin(async move {
            self.pause(gate.as_ref(), false, "publish", "").await;
            self.inner.publish(payload, ttl).await?;
            self.pause(gate.as_ref(), true, "publish", "").await;
            Ok(())
        })
    }
    fn claim_worker(&self, input: Value) -> BoxFuture<'_, Result<Option<Value>>> {
        let worker = input["workerId"].as_str().unwrap_or("").to_owned();
        let gate = self.take("claimWorker", &worker);
        Box::pin(async move {
            self.pause(gate.as_ref(), false, "claimWorker", &worker)
                .await;
            let result = self.inner.claim_worker(input).await?;
            self.pause(gate.as_ref(), true, "claimWorker", &worker)
                .await;
            Ok(result)
        })
    }
    fn refresh_worker<'a>(
        &'a self,
        worker: &'a JsString,
        connection: &'a JsString,
    ) -> BoxFuture<'a, Result<bool>> {
        let gate = self.take("refreshWorker", worker.as_str().unwrap_or(""));
        Box::pin(async move {
            self.pause(
                gate.as_ref(),
                false,
                "refreshWorker",
                worker.as_str().unwrap_or(""),
            )
            .await;
            let result = self.inner.refresh_worker(worker, connection).await?;
            self.pause(
                gate.as_ref(),
                true,
                "refreshWorker",
                worker.as_str().unwrap_or(""),
            )
            .await;
            Ok(result)
        })
    }
    fn claim_worker_link_session(&self, claim: Value) -> BoxFuture<'_, Result<Option<Value>>> {
        Box::pin(self.inner.claim_worker_link_session(claim))
    }
    fn refresh_worker_link_session(&self, claim: Value) -> BoxFuture<'_, Result<bool>> {
        Box::pin(self.inner.refresh_worker_link_session(claim))
    }
}
