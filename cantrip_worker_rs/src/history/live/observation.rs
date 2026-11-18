use super::Failure;
use crate::{
    metadata::{Abort, Signal},
    native_items::{checked, obj, s},
};
use anyhow::{Result, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub type Read = Arc<dyn Fn() -> Work<Value> + Send + Sync>;
pub type Retired = Arc<dyn Fn(Failure) + Send + Sync>;
#[derive(Clone)]
pub struct Observer {
    /// The synchronous prefix runs before dispatch continues. Accepted async
    /// consumers finish independently; their failures only reach diagnostics.
    pub capture: Arc<dyn Fn(Value) -> Result<Option<Work<()>>> + Send + Sync>,
    pub on_error: Arc<dyn Fn(Failure, Value) -> Result<()> + Send + Sync>,
}
struct Entry {
    id: u64,
    thread: JsString,
    observer: Observer,
    abort: Abort,
    signal: Signal,
    retirement: Mutex<(Option<Failure>, Vec<Retired>)>,
}
impl Entry {
    fn retire(&self, error: Failure) {
        let listeners = {
            let mut state = self.retirement.lock().unwrap();
            if state.0.is_some() {
                return;
            }
            state.0 = Some(error.clone());
            std::mem::take(&mut state.1)
        };
        self.abort.abort(error.error());
        for listener in listeners {
            listener(error.clone());
        }
    }
}
struct State {
    generation: Option<JsString>,
    sequence: f64,
    next: u64,
    subscribers: IndexMap<u64, Arc<Entry>>,
}
struct Inner {
    state: Mutex<State>,
    clock: Arc<dyn Fn() -> f64 + Send + Sync>,
}
#[derive(Clone)]
pub struct Hub(Arc<Inner>);
impl Default for Hub {
    fn default() -> Self {
        Self::new(Arc::new(|| chrono::Utc::now().timestamp_millis() as f64))
    }
}
impl Hub {
    pub fn generation(&self) -> Option<JsString> {
        self.0.state.lock().unwrap().generation.clone()
    }
    pub fn new(clock: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State {
                generation: None,
                sequence: 0.,
                next: 0,
                subscribers: IndexMap::new(),
            }),
            clock,
        }))
    }
    pub fn replace(&self, generation: Option<JsString>) {
        let retired = {
            let mut state = self.0.state.lock().unwrap();
            if state.generation == generation {
                return;
            }
            state.generation = generation;
            state.sequence = 0.;
            std::mem::take(&mut state.subscribers)
        };
        for entry in retired.values() {
            entry.retire(Failure::new(anyhow::anyhow!(
                "The native history transport was replaced or closed."
            )));
        }
    }
    pub fn subscribe(
        &self,
        thread: JsString,
        observer: Observer,
        read: Read,
    ) -> Result<Subscription> {
        let mut state = self.0.state.lock().unwrap();
        let generation = state
            .generation
            .clone()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!("Native history has no connected transport to observe.")
            })?;
        if thread.is_empty() {
            bail!("Native history requires a thread identity.");
        }
        let (abort, signal) = Abort::new();
        state.next += 1;
        let entry = Arc::new(Entry {
            id: state.next,
            thread,
            observer,
            abort,
            signal,
            retirement: Mutex::new((None, Vec::new())),
        });
        state.subscribers.insert(entry.id, entry.clone());
        Ok(Subscription {
            hub: self.clone(),
            entry,
            generation,
            read,
        })
    }
    pub fn notification(&self, method: JsString, params: &Value, cursor: Option<&Value>) {
        if !params.is_object() {
            return;
        }
        let thread = params["threadId"].as_js_string().cloned().or_else(|| {
            if method == JsString::from("thread/started") {
                params["thread"]["id"].as_js_string().cloned()
            } else {
                None
            }
        });
        let Some(thread) = thread.filter(|s| !s.is_empty()) else {
            return;
        };
        let (source, entries) = {
            let mut state = self.0.state.lock().unwrap();
            let Some(generation) = state.generation.clone().filter(|v| !v.is_empty()) else {
                return;
            };
            state.sequence += 1.;
            let mut source = obj([
                ("kind", s("notification")),
                ("generation", s(generation)),
                ("sequence", Value::Number(state.sequence)),
                ("threadId", s(thread.clone())),
                ("method", s(method)),
                ("receivedAtMs", Value::Number((self.0.clock)())),
            ]);
            if let Some(cursor) =
                cursor.and_then(|v| checked("codexNativeHistoryCursorSchema", v).ok())
            {
                source["nativeCursor"] = cursor;
            }
            (
                source,
                state.subscribers.values().cloned().collect::<Vec<_>>(),
            )
        };
        for entry in entries {
            if entry.thread != thread || entry.signal.check().is_err() {
                continue;
            }
            let mut frame = source.clone();
            frame["params"] = params.clone();
            let captured = (entry.observer.capture)(frame);
            let observer = entry.observer.clone();
            let detail = source.clone();
            let failed = move |error| {
                let _ = (observer.on_error)(Failure::new(error), detail.clone());
            };
            match captured {
                Ok(Some(pending)) => {
                    tokio::spawn(async move {
                        if let Err(error) = pending.await {
                            failed(error);
                        }
                    });
                }
                Err(error) => failed(error),
                Ok(None) => (),
            }
        }
    }
}
#[derive(Clone)]
pub struct Subscription {
    hub: Hub,
    entry: Arc<Entry>,
    generation: JsString,
    read: Read,
}
impl Subscription {
    fn boundary(&self) -> Result<f64> {
        let state = self.hub.0.state.lock().unwrap();
        self.entry.signal.check()?;
        // Replacement/close update the hub before notifying retirees. Take one
        // atomic view so another native thread cannot cross that short interval.
        if state.generation.as_ref() != Some(&self.generation) {
            bail!("The native history transport was replaced or closed.");
        }
        if !state.subscribers.contains_key(&self.entry.id) {
            bail!("The native history observation was closed.");
        }
        Ok(state.sequence)
    }
    pub fn generation(&self) -> JsString {
        self.generation.clone()
    }
    pub fn signal(&self) -> Signal {
        self.entry.signal.clone()
    }
    pub fn on_retired(&self, listener: Retired) {
        let reason = {
            let mut state = self.entry.retirement.lock().unwrap();
            if state.0.is_none() {
                state.1.push(listener.clone());
            }
            state.0.clone()
        };
        if let Some(reason) = reason {
            listener(reason);
        }
    }
    pub fn close(&self) {
        self.hub
            .0
            .state
            .lock()
            .unwrap()
            .subscribers
            .shift_remove(&self.entry.id);
        self.entry.retire(Failure::new(anyhow::anyhow!(
            "The native history observation was closed."
        )));
    }
    pub fn read_snapshot(&self) -> Work<Value> {
        let this = self.clone();
        owned(async move {
            let barrier = this.boundary()?;
            let snapshot = (this.read)().await?;
            let completed = this.boundary()?;
            if snapshot["thread"]["id"].as_js_string() != Some(&this.entry.thread) {
                bail!("Native history returned another thread's snapshot.");
            }
            Ok(obj([
                ("kind", s("snapshot")),
                ("id", s(Uuid::new_v4().to_string())),
                ("generation", s(this.generation.clone())),
                ("threadId", s(this.entry.thread.clone())),
                ("readBarrierSequence", Value::Number(barrier)),
                ("completedSequence", Value::Number(completed)),
                ("receivedAtMs", Value::Number((this.hub.0.clock)())),
                ("snapshot", snapshot),
            ]))
        })
    }
}
/// Concrete observation adapter around the native transport's snapshot RPC.
pub trait Runtime: Send + Sync {
    fn observe(&self, thread: JsString, observer: Observer) -> Result<Subscription>;
}
pub struct RuntimeHub {
    pub hub: Hub,
    pub read: Arc<dyn Fn(JsString) -> Work<Value> + Send + Sync>,
}
impl Runtime for RuntimeHub {
    fn observe(&self, thread: JsString, observer: Observer) -> Result<Subscription> {
        let read = self.read.clone();
        let selected = thread.clone();
        self.hub
            .subscribe(thread, observer, Arc::new(move || read(selected.clone())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn reentrant_replacement_never_delivers_an_old_frame_to_a_new_subscription() -> Result<()> {
        let hub = Hub::default();
        hub.replace(Some("old".into()));
        let next = Arc::new(Mutex::new(Vec::new()));
        let retired = Arc::new(AtomicUsize::new(0));
        let replacing = hub.clone();
        let new_events = next.clone();
        let read: Read = Arc::new(|| panic!("notification dispatch must not read snapshots"));
        let next_read = read.clone();
        hub.subscribe(
            "thread".into(),
            Observer {
                capture: Arc::new(move |_| {
                    replacing.replace(Some("new".into()));
                    let events = new_events.clone();
                    replacing.subscribe(
                        "thread".into(),
                        Observer {
                            capture: Arc::new(move |event| {
                                events.lock().unwrap().push(event);
                                Ok(None)
                            }),
                            on_error: Arc::new(|_, _| Ok(())),
                        },
                        next_read.clone(),
                    )?;
                    Ok(None)
                }),
                on_error: Arc::new(|_, _| Ok(())),
            },
            read.clone(),
        )?;
        let old = retired.clone();
        hub.subscribe(
            "thread".into(),
            Observer {
                capture: Arc::new(move |_| {
                    old.fetch_add(1, Ordering::SeqCst);
                    Ok(None)
                }),
                on_error: Arc::new(|_, _| Ok(())),
            },
            read,
        )?;
        hub.notification(
            "item/completed".into(),
            &obj([("threadId", s("thread"))]),
            None,
        );
        assert_eq!(retired.load(Ordering::SeqCst), 0);
        assert!(next.lock().unwrap().is_empty());
        hub.notification(
            "item/completed".into(),
            &obj([("threadId", s("thread"))]),
            None,
        );
        let events = next.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["generation"], "new");
        assert_eq!(events[0]["sequence"].as_u64(), Some(1));
        Ok(())
    }
}
