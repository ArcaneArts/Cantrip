use crate::{
    filesystem::paths,
    metadata::Signal,
    native_items::{array, checked, obj, s, text},
};
use anyhow::{Result, bail};
use cantrip_history::{files::Queue, projection::Work, reducer::equal, source::Journal};
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use std::sync::{Arc, Mutex};

pub trait Source: Send + Sync {
    fn scope(&self) -> Value;
    fn head(&self) -> Work<Value>;
    fn read(&self, after: u64, limit: u64) -> Work<Vec<Value>>;
}
impl Source for Journal {
    fn scope(&self) -> Value {
        Journal::scope(self)
    }
    fn head(&self) -> Work<Value> {
        Box::pin(Journal::head(self))
    }
    fn read(&self, after: u64, limit: u64) -> Work<Vec<Value>> {
        Box::pin(Journal::read(self, after, limit))
    }
}
#[derive(Default)]
struct State {
    through: u64,
    children: IndexMap<String, Value>,
    contexts: IndexMap<JsString, Vec<Value>>,
}
struct Inner {
    source: Arc<dyn Source>,
    signal: Option<Signal>,
    state: Mutex<State>,
    queue: Arc<Queue>,
}
#[derive(Clone)]
pub struct Index(Arc<Inner>);
impl Index {
    pub fn new(source: Arc<dyn Source>, signal: Option<Signal>) -> Self {
        // Independent of the journal FIFO: refresh itself reads that journal.
        Self(Arc::new(Inner {
            source,
            signal,
            state: Mutex::new(State::default()),
            queue: Arc::new(Queue::default()),
        }))
    }
    fn active(&self) -> Result<()> {
        if let Some(signal) = &self.0.signal {
            signal.check()?;
        }
        Ok(())
    }
    pub fn refresh(&self) -> Work<()> {
        let this = self.clone();
        Box::pin(self.0.queue.run_async(async move {
            this.active()?;
            let head = this.0.source.head().await?;
            let end = head["sequence"].as_u64().unwrap();
            loop {
                let through = this.0.state.lock().unwrap().through;
                if through >= end {
                    return Ok(());
                }
                this.active()?;
                let records = this.0.source.read(through, 512.min(end - through)).await?;
                if records.is_empty() {
                    bail!("Native history context boundary is missing records.");
                }
                for record in records {
                    this.active()?;
                    let mut state = this.0.state.lock().unwrap();
                    let sequence = record["sequence"].as_u64().unwrap();
                    if sequence != state.through + 1 {
                        bail!("Native history context evidence has a sequence gap.");
                    }
                    if sequence == end && record["recordId"] != head["recordId"] {
                        bail!("Native history context boundary changed identity.");
                    }
                    let frame = &record["frame"];
                    if frame["threadId"] != this.0.source.scope()["threadId"] {
                        bail!("Native history context belongs to another thread.");
                    }
                    if frame["kind"] == "snapshot" {
                        if let Some(child) = super::lineage::child(&frame["snapshot"]["thread"]) {
                            let key = child.stringify();
                            state.children.shift_remove(&key);
                            state.children.insert(key, child);
                        }
                        if let Some(turns) = frame["snapshot"]["history"]["turns"].as_array() {
                            for turn in turns {
                                if let Some(contexts) =
                                    turn["contexts"].as_array().filter(|v| !v.is_empty())
                                {
                                    let retained = state
                                        .contexts
                                        .entry(text(&turn["turnId"])?.clone())
                                        .or_default();
                                    merge(retained, contexts);
                                }
                            }
                        }
                    }
                    state.through = sequence;
                }
            }
        }))
    }
    pub fn read(&self, turn: &Value) -> Result<Vec<Value>> {
        let metadata = &turn["metadata"];
        if cantrip_wire::coercion::truthy(metadata.get("turnId"))
            && metadata["turnId"] != turn["id"]
        {
            bail!("Native history metadata belongs to another turn.");
        }
        self.active()?;
        let retained = match metadata.get("contexts") {
            None => Value::Array(Vec::new()),
            Some(value) => checked("nativeHistoryRetainedContextsSchema", value)?,
        };
        let mut contexts = self
            .0
            .state
            .lock()
            .unwrap()
            .contexts
            .get(text(&turn["id"])?)
            .cloned()
            .unwrap_or_default();
        merge(&mut contexts, array(&retained)?);
        Ok(contexts)
    }
    pub fn child_metadata(&self, parent: &Value) -> Result<Value> {
        let state = self.0.state.lock().unwrap();
        if state.children.is_empty()
            || state.children.values().any(|v| {
                &v["parentThreadId"] != parent || v["threadId"] != self.0.source.scope()["threadId"]
            })
        {
            bail!("Retained native child metadata does not match its bound parent.");
        }
        Ok(state.children.last().unwrap().1.clone())
    }
}
fn merge(target: &mut Vec<Value>, source: &[Value]) {
    for value in source {
        if !target.iter().any(|v| equal(v, value)) {
            target.push(value.clone());
        }
    }
}
#[derive(Debug)]
pub struct Pending;
impl std::fmt::Display for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Original native turn context is not yet retained.")
    }
}
impl std::error::Error for Pending {}
/// Missing evidence defers projection only. Never use this as input admission.
pub fn resolve(contexts: &[Value]) -> Result<Value> {
    let Some(first) = contexts.first() else {
        return Err(Pending.into());
    };
    if contexts.iter().any(|v| {
        ["cwd", "collaborationMode", "rootTurnId"]
            .iter()
            .any(|key| v[*key] != first[*key])
    }) {
        bail!("Retained native turn contexts disagree on presentation scope.");
    }
    if !paths::absolute(&paths::native(text(&first["cwd"])?)) {
        bail!("Retained native working directory is not absolute.");
    }
    if !matches!(
        first["collaborationMode"].as_str(),
        Some("default" | "plan")
    ) {
        bail!("Retained native collaboration mode cannot be projected.");
    }
    Ok(obj([
        ("cwd", s(text(&first["cwd"])?.clone())),
        ("mode", first["collaborationMode"].clone()),
        ("rootTurnId", first["rootTurnId"].clone()),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::Abort;
    struct Unread;
    impl Source for Unread {
        fn scope(&self) -> Value {
            obj([("threadId", s("thread"))])
        }
        fn head(&self) -> Work<Value> {
            panic!("cancelled index must not start source I/O")
        }
        fn read(&self, _: u64, _: u64) -> Work<Vec<Value>> {
            panic!("cancelled index must not read source")
        }
    }
    #[tokio::test]
    async fn cancellation_preserves_foreign_metadata_precedence_and_never_reads_source() {
        let (abort, signal) = Abort::new();
        abort.abort(anyhow::anyhow!("cancelled context pass"));
        let index = Index::new(Arc::new(Unread), Some(signal));
        assert_eq!(
            index.refresh().await.unwrap_err().to_string(),
            "cancelled context pass"
        );
        let foreign = obj([
            ("id", s("turn")),
            ("metadata", obj([("turnId", s("other"))])),
        ]);
        assert_eq!(
            index.read(&foreign).unwrap_err().to_string(),
            "Native history metadata belongs to another turn."
        );
        assert_eq!(
            index
                .read(&obj([("id", s("turn"))]))
                .unwrap_err()
                .to_string(),
            "cancelled context pass"
        );
    }
    #[test]
    fn missing_context_is_a_typed_projection_deferral() {
        assert!(resolve(&[]).unwrap_err().is::<Pending>());
    }
}
