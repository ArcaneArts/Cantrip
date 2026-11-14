//! Test-only fault/await controls after an actual production Redis directory read.
use anyhow::Result;
use cantrip_server::{
    coordination::{Listener, RedisCoordinator, RelayCoordinator},
    wire::{JsString, Value},
};
use futures::future::BoxFuture;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
#[derive(Default)]
struct Plan {
    session: String,
    nth: usize,
    action: String,
    reads: usize,
    paused: bool,
    completed: usize,
    gate: Option<watch::Sender<bool>>,
}
pub struct Controlled {
    inner: Arc<RedisCoordinator>,
    plan: Mutex<Plan>,
}
impl Controlled {
    pub fn new(inner: Arc<RedisCoordinator>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            plan: Mutex::default(),
        })
    }
    pub fn configure(&self, session: String, nth: usize, action: String) {
        self.release();
        *self.plan.lock().unwrap() = Plan {
            session,
            nth,
            action,
            gate: Some(watch::channel(false).0),
            ..Plan::default()
        };
    }
    pub fn release(&self) {
        if let Some(gate) = self.plan.lock().unwrap().gate.as_ref() {
            gate.send_replace(true);
        }
    }
    pub fn snapshot(&self) -> serde_json::Value {
        let p = self.plan.lock().unwrap();
        serde_json::json!({"reads":p.reads,"paused":p.paused,"completed":p.completed})
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
    fn subscribe(&self, l: Listener) -> u64 {
        self.inner.subscribe(l)
    }
    fn unsubscribe(&self, id: u64) {
        self.inner.unsubscribe(id);
    }
    fn cached_worker(&self, w: &JsString) -> Option<Value> {
        self.inner.cached_worker(w)
    }
    fn start(self: Arc<Self>) -> BoxFuture<'static, Result<()>> {
        Box::pin(async move { RedisCoordinator::start(&self.inner).await })
    }
    refs! {close()->();health()->bool;find_worker(worker)->Option<Value>;lookup_worker_claim(worker)->Option<Value>;refresh_worker(worker,connection)->bool;release_worker(worker,connection)->bool;release_worker_link_session(session,authority)->bool;}
    fn publish(&self, v: Value, t: Option<f64>) -> BoxFuture<'_, Result<()>> {
        Box::pin(self.inner.publish(v, t))
    }
    fn claim_worker(&self, v: Value) -> BoxFuture<'_, Result<Option<Value>>> {
        Box::pin(self.inner.claim_worker(v))
    }
    fn claim_worker_link_session(&self, v: Value) -> BoxFuture<'_, Result<Option<Value>>> {
        Box::pin(self.inner.claim_worker_link_session(v))
    }
    fn refresh_worker_link_session(&self, v: Value) -> BoxFuture<'_, Result<bool>> {
        Box::pin(self.inner.refresh_worker_link_session(v))
    }
    fn find_worker_link_session<'a>(
        &'a self,
        session: &'a JsString,
    ) -> BoxFuture<'a, Result<Option<Value>>> {
        Box::pin(async move {
            let value = self.inner.find_worker_link_session(session).await?;
            let (action, receiver) = {
                let mut p = self.plan.lock().unwrap();
                if session.as_str() != Some(p.session.as_str()) {
                    return Ok(value);
                }
                p.reads += 1;
                if p.reads != p.nth {
                    p.completed += 1;
                    return Ok(value);
                }
                let action = p.action.clone();
                let receiver = if action == "hold" {
                    p.paused = true;
                    p.gate.as_ref().map(|g| g.subscribe())
                } else {
                    None
                };
                (action, receiver)
            };
            if let Some(mut receiver) = receiver {
                let _ = receiver.wait_for(|released| *released).await;
            }
            {
                let mut p = self.plan.lock().unwrap();
                p.paused = false;
                p.completed += 1;
            }
            anyhow::ensure!(action != "fail", "Controlled authority lookup failure.");
            Ok(value)
        })
    }
}
