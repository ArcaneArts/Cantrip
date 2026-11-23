//! Durable admission metadata through the existing native lifetime keeper.
mod adopt;
#[cfg(test)]
mod tests;
mod writes;
use super::{identity, ownership::Owner};
pub use adopt::AdoptOptions;
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, coercion, value::json};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::{Notify, oneshot};
pub type Request = Arc<dyn Fn(Value) -> Work<Option<Value>> + Send + Sync>;
type Initialization = Shared<BoxFuture<'static, std::result::Result<(), Arc<JsString>>>>;
struct Item {
    command: Value,
    bytes: usize,
    send: oneshot::Sender<Result<Value>>,
}
#[derive(Default)]
struct Queue {
    items: VecDeque<Item>,
    scheduled: bool,
    writes: usize,
}
struct Inner {
    generation: JsString,
    request: Request,
    recovered: Mutex<Vec<Value>>,
    initialization: Mutex<Option<(String, Initialization)>>,
    queue: Mutex<Queue>,
    changed: Notify,
}
#[derive(Clone)]
pub struct Journal(Arc<Inner>);
struct Completion(Journal);
impl Drop for Completion {
    fn drop(&mut self) {
        self.0.finished();
    }
}
pub fn checked(schema: &str, input: Option<&Value>) -> Result<Value> {
    cantrip_protocol::parse(schema, input).map_err(|error| match error {
        cantrip_protocol::ValidationError::Invalid(issues) => {
            crate::error::WireError(Value::Array(issues).stringify_pretty().into()).into()
        }
        cantrip_protocol::ValidationError::Operation => {
            anyhow!("Inference journal schema validation failed.")
        }
    })
}
fn records(snapshot: Option<&Value>) -> Result<Vec<Value>> {
    let result = checked("workerInferenceJournalSnapshotSchema", snapshot)?;
    Ok(coercion::entries(result["operations"].as_object().unwrap())
        .into_iter()
        .map(|(_, value)| value.clone())
        .collect())
}
fn sort(records: &mut [Value]) {
    records.sort_by(|a, b| {
        a["order"]
            .as_f64()
            .unwrap()
            .total_cmp(&b["order"].as_f64().unwrap())
    });
}
impl Journal {
    pub fn new(generation: JsString, request: Request) -> Self {
        Self(Arc::new(Inner {
            generation,
            request,
            recovered: Mutex::new(Vec::new()),
            initialization: Mutex::new(None),
            queue: Mutex::new(Queue::default()),
            changed: Notify::new(),
        }))
    }
    pub fn from_owner(generation: JsString, owner: Owner) -> Self {
        Self::new(generation, Arc::new(move |command| owner.journal(command)))
    }
    pub fn key(&self, runtime: &JsString, operation: &JsString) -> String {
        identity::key(&self.0.generation, runtime, operation)
    }
    pub fn recovery_snapshot(&self) -> Vec<Value> {
        self.0.recovered.lock().unwrap().clone()
    }
    pub fn initialize(&self) -> Work<()> {
        let (id, pending) = {
            let mut init = self.0.initialization.lock().unwrap();
            if let Some(existing) = &*init {
                existing.clone()
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                let this = self.clone();
                let work = cantrip_transport::lifecycle::owned(async move {
                    let snapshot = (this.0.request)(json!({"action":"snapshot"})).await?;
                    let mut recovered = records(snapshot.as_ref())?
                        .into_iter()
                        .filter(|record| {
                            record["workerGeneration"] != Value::String(this.0.generation.clone())
                        })
                        .collect::<Vec<_>>();
                    sort(&mut recovered);
                    *this.0.recovered.lock().unwrap() = recovered;
                    Ok(())
                });
                let pending = async move {
                    work.await
                        .map_err(|error| Arc::new(crate::error::message(&error)))
                }
                .boxed()
                .shared();
                *init = Some((id.clone(), pending.clone()));
                (id, pending)
            }
        };
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            if let Err(error) = pending.await {
                let mut init = this.0.initialization.lock().unwrap();
                if init.as_ref().is_some_and(|v| v.0 == id) {
                    *init = None;
                }
                return Err(crate::error::WireError((*error).clone()).into());
            }
            Ok(())
        })
    }
    pub fn snapshot(&self) -> Work<Vec<Value>> {
        let pending = (self.0.request)(json!({"action":"snapshot"}));
        cantrip_transport::lifecycle::owned(async move { records(pending.await?.as_ref()) })
    }
    pub fn enqueue(&self, key: String, identity: Value) -> Work<Value> {
        self.identified("enqueue", key, identity)
    }
    pub fn seal_unstarted(&self, key: String, identity: Value) -> Work<Value> {
        self.identified("sealUnstarted", key, identity)
    }
    fn identified(&self, action: &str, key: String, identity: Value) -> Work<Value> {
        match checked("workerInferenceJournalIdentitySchema", Some(&identity)) {
            Ok(identity) => self.write(json!({"action":action,"key":key,"identity":identity})),
            Err(error) => cantrip_transport::lifecycle::owned(async move { Err(error) }),
        }
    }
    pub fn grant(&self, key: String) -> Work<Value> {
        self.write(json!({"action":"grant","key":key}))
    }
    pub fn requeue(&self, key: String) -> Work<Value> {
        self.write(json!({"action":"requeue","key":key}))
    }
    pub fn bind_native(&self, key: String, execution: Value) -> Work<Value> {
        self.write(json!({"action":"bindNative","key":key,"execution":execution}))
    }
    pub fn release(&self, key: String, outcome: JsString) -> Work<Value> {
        let completion = self.track();
        let pending = self.write(json!({"action":"release","key":key,"outcome":outcome}));
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let _completion = completion;
            let record = pending.await?;
            let recovery = &record["identity"]["recovery"];
            let task = coercion::truthy(recovery.get("taskGoalCycle"));
            if (coercion::truthy(recovery.get("autonomousGoal")) || task)
                && (!coercion::truthy(record.get("nativeExecution"))
                    || task && record["outcome"] == "never-started")
                && record["state"] == "released"
                && matches!(
                    record["outcome"].as_str(),
                    Some("never-started" | "runtime-exited")
                )
            {
                let mut recovered = this.0.recovered.lock().unwrap();
                recovered.retain(|v| v["key"] != record["key"]);
                recovered.push(record.clone());
                sort(&mut recovered);
            }
            Ok(record)
        })
    }
    pub fn forget(&self, previous: Value) -> Work<()> {
        let completion = self.track();
        let pending = (self.0.request)(json!({"action":"forget","previous":reference(&previous)}));
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let _completion = completion;
            async {
                let result = pending.await?.unwrap_or(Value::Null);
                if !result.is_object()
                    || result["key"] != previous["key"]
                    || result["forgotten"] != true
                {
                    bail!("Inference recovery acknowledgement did not match its record.");
                }
                this.0
                    .recovered
                    .lock()
                    .unwrap()
                    .retain(|record| record["key"] != previous["key"]);
                Ok(())
            }
            .await
        })
    }
    fn finished(&self) {
        self.0.queue.lock().unwrap().writes -= 1;
        self.0.changed.notify_waiters();
    }
    fn track(&self) -> Completion {
        self.0.queue.lock().unwrap().writes += 1;
        Completion(self.clone())
    }
    pub fn flush(&self) -> Work<()> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            loop {
                let changed = this.0.changed.notified();
                if this.0.queue.lock().unwrap().writes == 0 {
                    return Ok(());
                }
                changed.await;
            }
        })
    }
}
fn reference(record: &Value) -> Value {
    json!({"key":record["key"],"workerGeneration":record["workerGeneration"],"revision":record["revision"]})
}
